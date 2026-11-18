// `automagik-herdr worker` (bot workers): a bot starts one worker per task, an hc child of its
// pane, in the task's worktree. Run as a program against scratch git projects under $TMPDIR,
// with the fake `hc` first on PATH (test/fake-hc.mjs). The real hc is never run.
import net from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createHash } from "node:crypto";

import { applyBotEdit, checkBots, parseBots, swapProblem } from "../mods/am-sidebar/model.js";
import { AGENTS, AGY_FIXED_DENY, AGY_SHELL_READ, agySettingsDir, agySettingsFile, effortArgs, promptArgs } from "../mods/am-sidebar/models.js";
import { ENV, GUARD_DIR, WORKER_OF_LABEL, stableGuardDir, stableHelper, stableRunner, baseCandidates, hcProxyEnabled, branchNamesTask, branchSlug, parseWorktrees, readLedger, reapCandidates, runsTemplate, workLeft, sessionChange, startRow, swapArm, swapByte, templateAgent,
  KILL_GUARD_DIR, workerArgs, workerBranch, workerPlan, workerRole, workerTaskId, writesWorktree,
  PR_ASK_MAX_MS, PR_ASK_MIN_MS, PR_QUIET_EVERY_MS, PR_QUIET_FIRST_MS, PR_QUIET_WATCH_MS, PR_STATES, PR_WATCH_MS, endRow, finishedEnds, prAskDue, prBranchKey,
  prBranches, prChecksPath, prChecksText, prLikely, prRow, prRowsFor, prTime, prWatch, readPrChecks } from "../mods/am-sidebar/workers.js";
import { approveProject, recordFileOf } from "../mods/am-sidebar/approved.js";
import { stableRunnerText } from "../mods/am-sidebar/dshTui.mjs";
import { startProxy } from "../mods/am-sidebar/hcProxy.mjs";
import { startFakeCore } from "./fake-hc-core.mjs";
import { fixturePaneEdit } from "./fixture-pane-edit.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { assertScratchProject, scratchProject, scratchRoot, shortSocketDir }
  from "./scratch-project.mjs";
const createHashOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", stray: "b-zzzzzzzzzz" };

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
/**
 * The attach ledger a test writes by hand is the owner's alone, as attach writes it: set here, not
 * left to the umask, or a umask-002 host makes it 0664 and the worker refuses it (#578).
 */
const LEDGER_MODE = 0o600;
const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const team = (extra = {}) => ({
  version: 1,
  categories: [],
  bots: [
    bot(ID.main, "main", { name: "Genie" }),
    bot(ID.cap, "member", { name: "Captain", agent: "codex", worker: { model: "gpt-5.5", effort: "high" } }),
    bot(ID.dev, "member", { name: "Dev", worker: { agent: "codex", model: "gpt-5.5", effort: "medium" } }),
  ],
  ...extra,
});
const term = (address, { bot: b, cwd }) => ({ address, name: address, cwd, state: "live", parent: null, created_ms: 1,
  labels: b ? { bot: b } : {}, foreground: { argv: ["claude"], cwd, pid: 4000 }, status: { app: "claude-code", state: "idle" } });

/** A scratch world: a git project on main with its bots, a fake hc whose t1..t3 are panes in it. */
function scene(t, { file = team(), branch = "main", briefing = true, templates = TEMPLATES } = {}) {
  const root = scratchRoot(t, "hb-worker-");
  const project = scratchProject(root, "proj", { branch, commit: true, bots: file });
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  for (const a of ["claude", "codex", "agy"]) exe(join(bin, a), "#!/bin/sh\nexit 0\n");
  // A fake gh (#567's cleanup asks it for a branch's pull requests): gh.json is its answer, else it
  // fails. gh-hook.sh, when there, runs first (something landing between the cleanup's check and its remove).
  exe(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, "gh.log")}"\n`
    + `if [ -f "${join(root, "gh-hook.sh")}" ]; then sh "${join(root, "gh-hook.sh")}"; fi\n`
    + `if [ -f "${join(root, "gh.json")}" ]; then cat "${join(root, "gh.json")}"; exit 0; fi\necho "fake gh: no answer" >&2\nexit 1\n`);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config/herdr-app"), { recursive: true });
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  if (briefing) writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const statePath = join(root, "hc.json");
  const logPath = join(root, "hc.log");
  const terminals = [term("t1", { bot: ID.dev, cwd: project }), term("t2", { cwd: project }), term("t3", { bot: ID.stray, cwd: project }),
    term("t4", { bot: ID.cap, cwd: project })];
  writeFileSync(statePath, JSON.stringify({ terminals, next: 100, templates }));
  writeFileSync(logPath, "");
  // No Herdr window: a fake herdr-app first on PATH (start asks it), so the real one is never reached.
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify({ down: true }));
  writeFileSync(appLog, "");
  const env = { ...process.env, XDG_DATA_HOME: join(root, "data"), PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog, AUTOMAGIK_HERDR_TAB_WAIT_MS: "300", GIT_CEILING_DIRECTORIES: root };
  // Worker transport discovery must never inherit a host socket into a fixture scene.
  env.HC_SOCKET = join(root, "unproxied.sock");
  env.HC_TERMINAL_SOCKET = env.HC_SOCKET;
  delete env.HC_TERMINAL_ID;
  // Every CLI call, including worker/reap, stays in this scratch world (#1135).
  const preflight = (extra = {}, cwd = project) => {
    const effective = { ...env, ...extra };
    assertScratchProject(project, { ceiling: root, env: effective });
    assert.equal(effective.HERDR_APP_HOME, app);
    assert.equal(effective.HOME, home);
    assert.equal(effective.HC_FAKE_STATE, statePath);
    assert.ok(realpathSync(cwd).startsWith(`${root}/`) || realpathSync(cwd) === root);
    assert.ok(realpathSync(app).startsWith(`${root}/`));
    assert.equal(join(effective.HERDR_APP_HOME, "automagik-herdr/workers.jsonl"),
      join(app, "automagik-herdr/workers.jsonl"));
    const executable = (path) => {
      try { return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0; }
      catch { return false; }
    };
    const paths = effective.PATH.split(":");
    const firstHc = paths.map((dir) => join(dir, "hc")).find(executable);
    // Some existing guard tests intentionally prepend this checkout's guard, which
    // delegates through the remaining PATH. Its next hc must still be this fake.
    if (extra.PATH && firstHc === join(GUARD_DIR, "hc")) {
      assert.equal(paths.filter((dir) => dir !== GUARD_DIR)
        .map((dir) => join(dir, "hc")).find(executable), join(bin, "hc"));
    } else assert.equal(firstHc, join(bin, "hc"));
    assert.ok(readFileSync(join(bin, "hc"), "utf8").includes(FAKE_HC));
    assert.ok(CLI.endsWith("/herdr/mods/am-sidebar/bin/automagik-herdr.mjs"));
  };
  const cli = (args, { from = "t1", cwd = project, env: extra = {} } = {}) => {
    preflight(extra, cwd);
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra, ...(from ? { HC_TERMINAL_ID: from } : {}) }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const cliAsync = (args, { from = "t1", env: extra = {} } = {}) => new Promise((resolve) => {
    preflight(extra);
    execFile(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extra, HC_TERMINAL_ID: from }, encoding: "utf8" },
      (e, out, err) => resolve({ code: e ? e.code : 0, out, err }));
  });
  /** The CLI as a child process, its stderr readable as it comes. */
  const spawnCli = (args, { from = "t1", env: extra = {} } = {}) => {
    preflight(extra);
    return spawn(process.execPath, [CLI, ...args],
      { cwd: project, env: { ...env, ...extra, HC_TERMINAL_ID: from },
        stdio: ["ignore", "pipe", "pipe"] });
  };
  const calls = () => readJsonLines(logPath);
  const runs = () => calls().filter((c) => c[0] === "run");
  const setWindow = (w) => writeFileSync(appState, JSON.stringify(w));
  const windowNow = () => JSON.parse(readFileSync(appState, "utf8"));
  const appDos = () => readJsonLines(appLog).filter((c) => c[0] === "do")
    .map((c) => [c[1], JSON.parse(c[2])]);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const ledger = () => { const p = join(app, "automagik-herdr/workers.jsonl"); return existsSync(p) ? readLedger(readFileSync(p, "utf8")) : []; };
  const bots = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8"));
  /** Finishes a terminal `ago` ms ago (hc's finished_ms; #567's cleanup waits 15 min after it). */
  const finish = (address, ago = 16 * 60_000) => {
    const st = hcState();
    Object.assign(st.terminals.find((x) => x.address === address), { state: "finished", finished_ms: Date.now() - ago });
    writeFileSync(statePath, JSON.stringify(st));
  };
  const approve = () => approveProject({ project, env, approvedBy: "tester" });
  return { root, project, app, approve, env, path: env.PATH, cli, cliAsync, spawnCli, calls, runs, hcState, ledger, bots, finish, setWindow, windowNow, appDos };
}
/** hc's templates in the scenes: one Codex seat with its own provider, one hc can't place. */
const TEMPLATES = [
  { name: "dev-sol", command: 'env PATH="$HOME/.bun/bin:$PATH" codex -c model_provider=proxy -m gpt-6.1-sol -c model_reasoning_effort=high' },
  { name: "opus-rev", command: "claude --dangerously-skip-permissions --model claude-opus-5-5" },
  { name: "mystery", command: "./run-something.sh" },
];
/** What `hc run` runs after `--`, as raw words. */
const runArgv = (args) => args.slice(args.indexOf("--") + 1);
/** A template run: no `--`; the template and the task follow the last option (`--parent P`). */
const templateArgv = (args) => {
  assert.equal(args.includes("--"), false, `hc's template form has no --: ${JSON.stringify(args)}`);
  return args.slice(args.indexOf("--parent") + 2);
};
/**
 * The agent's argv: after `--`, past the `env PATH=…` every agent worker starts with, and a Claude
 * worker's `-u CLAUDE_CONFIG_DIR` before it (the default login, #453; any other agent has none).
 */
/**
 * A new Claude worker's words with the `--session-id <uuid>` RFC 0021 adds checked and taken out
 * (exactly one, a UUID, before the task); any other worker's as they are.
 */
const freshClaude = (words) => {
  const i = words.indexOf("--session-id");
  if (i < 0) return words;
  assert.match(words[i + 1] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(words.lastIndexOf("--session-id"), i, "one --session-id");
  return [...words.slice(0, i), ...words.slice(i + 2)];
};
const after = (args) => {
  const argv = runArgv(args);
  assert.equal(argv[0], "/usr/bin/env", `an agent worker runs under /usr/bin/env PATH=…: ${JSON.stringify(argv)}`);
  const at = argv[1] === "-u" ? 3 : 1;
  if (at === 3) assert.equal(argv[2], "CLAUDE_CONFIG_DIR");
  assert.match(argv[at], /^PATH=/);
  const rest = argv.slice(at + 1);
  assert.equal(at === 3, rest[0] === "claude", `only a Claude worker gets the login words: ${JSON.stringify(argv)}`);
  return rest;
};
const labelsOf = (args) => args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));

/** A window whose space sp-bot shows a shell (t2, tab tb-a), the bot's pane (t1, tab tb-bot) and t3 (tab tb-c). */
const botWindow = (extra = {}) => ({ spaces: [{ id: "sp-bot", name: "proj", folder: "/p", machine: null, active: true, tabs: [
  { id: "tb-a", name: "1", active: false, terminals: [{ terminal: "t2", pane: "p2" }] },
  { id: "tb-bot", name: "Dev", active: true, terminals: [{ terminal: "t1", pane: "p1" }] },
  { id: "tb-c", name: "3", active: false, terminals: [{ terminal: "t3", pane: "p3" }] }] }], ...extra });
const labelBot = (s, labels) => {
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t1").labels, labels);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
};

// ---- the worker's program: defaults, overrides, fallback ----

test("M4: switch off keeps the complete worker argv byte for byte against C1", (t) => {
  const file = team();
  Object.assign(file.bots[2], { agent: "dsh-tui", hcProxy: false });
  delete file.bots[2].worker;
  const s = scene(t, { file });
  exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  const r = s.cli(["worker", "do the task", "--branch", "feat/proxy-off", "--json"],
    { env: { PATH: `${s.root}/bin:/usr/bin:/bin`, AM_HC_PROXY: "1" } });
  assert.equal(r.code, 0, r.err);
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/dsh-proxy-off-argv.json",
    import.meta.url), "utf8")).worker;
  assert.deepEqual(s.runs()[0].map((word) => word.split(s.root).join("<root>")
    .split(GUARD_DIR).join("<guard>")), baseline);
});

test("M7: fixture pane edits cannot disable the approved switch at the next worker start",
  { skip: process.platform !== "linux" }, (t) => {
  for (const remove of [false, true]) {
    const file = team();
    Object.assign(file.bots[2], { agent: "dsh-tui", worker: { agent: "dsh-tui" }, hcProxy: true });
    const s = scene(t, { file });
    s.approve();
    exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
    fixturePaneEdit(s, remove, 2);
    const result = s.cli(["worker", "do the task", "--branch", "feat/approved", "--json"]);
    assert.equal(result.code, 0, result.err);
    assert.ok(s.runs().at(-1).some((word) => word.endsWith("/hcPane.mjs")));
  }
});

test("worker refuses unapproved working on and corrupt approval without a plain fallback",
  { skip: process.platform !== "linux" }, (t) => {
  for (const approval of ["missing", "off", "bot missing", "corrupt"]) {
    const file = team();
    Object.assign(file.bots[2], { agent: "dsh-tui", worker: { agent: "dsh-tui" } });
    const s = scene(t, { file });
    exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
    if (approval !== "missing") {
      if (approval === "bot missing") {
        const path = join(s.project, ".herdr/bots.json");
        writeFileSync(path, JSON.stringify({ ...file, bots: file.bots.slice(0, 2) }));
        s.approve();
        writeFileSync(path, JSON.stringify(file));
      } else s.approve();
      if (approval === "corrupt") writeFileSync(recordFileOf(s.project, s.env), "{broken");
    }
    assert.equal(s.cli(["edit", "Dev", "--hc-proxy", "on"]).code, 0);
    const result = s.cli(["worker", "do the task", "--branch", "feat/refused", "--json"]);
    assert.notEqual(result.code, 0, result.err);
    assert.match(result.err, /run am proxy approve first/);
    assert.equal(s.runs().length, 0);
  }
});

test("the same invalid record warns off to plain worker argv and refuses working on",
  { skip: process.platform !== "linux" }, (t) => {
  const file = team();
  Object.assign(file.bots[2], { agent: "dsh-tui", worker: { agent: "dsh-tui" } });
  const s = scene(t, { file });
  exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  const args = ["worker", "do the task", "--branch", "feat/invalid", "--json"];
  const initialState = readFileSync(join(s.root, "hc.json"));
  const baseline = s.cli(args);
  assert.equal(baseline.code, 0, baseline.err);
  const plain = s.runs().at(-1);
  // Reuse the fixture worktree; only the terminal and ledger state return to their start.
  writeFileSync(join(s.root, "hc.json"), initialState);
  rmSync(join(s.app, "automagik-herdr/workers.jsonl"), { force: true });
  rmSync(join(s.app, "automagik-herdr/attach.jsonl"), { force: true });
  assert.equal(s.cli(["edit", "Dev", "--hc-proxy", "on"]).code, 0);
  const { path, record } = s.approve();
  assert.equal(s.cli(["edit", "Dev", "--hc-proxy", "off"]).code, 0);
  const corrupt = JSON.stringify({ ...record, sha256: "invalid" });
  writeFileSync(path, corrupt);
  const off = s.cli(args);
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(s.runs().at(-1), plain, "invalid approval preserves the whole worker argv");
  assert.equal((off.err.match(/WARNING hc proxy:/g) ?? []).length, 1);
  assert.ok(off.err.includes(path));
  assert.match(off.err, /does not match its sha256.*starting plain.*am proxy approve/);
  assert.doesNotMatch(off.out, /^WARNING hc proxy:/m);
  writeFileSync(join(s.root, "hc.json"), initialState);
  const before = s.runs().length;
  assert.equal(s.cli(["edit", "Dev", "--hc-proxy", "on"]).code, 0);
  const on = s.cli(args);
  assert.notEqual(on.code, 0);
  assert.match(on.err, /does not match its sha256.*am proxy approve first/);
  assert.equal(s.runs().length, before);
  assert.equal(readFileSync(path, "utf8"), corrupt, "both sides used the same corrupt record");
});

test("a dsh-tui worker reads its bot's approved switch; other agents keep the ordinary launch",
  { skip: process.platform !== "linux" }, (t) => {
  const file = team();
  Object.assign(file.bots[2], { agent: "dsh-tui", worker: { agent: "dsh-tui" }, hcProxy: true });
  const s = scene(t, { file });
  exe(join(s.root, "bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  s.approve();
  const wrapped = s.cli(["worker", "do the task", "--branch", "feat/proxy", "--json"]);
  assert.equal(wrapped.code, 0, wrapped.err);
  const words = s.runs().at(-1);
  const helper = words.findIndex((word) => word.endsWith("/hcPane.mjs"));
  assert.ok(helper > 0, words.join(" "));
  assert.deepEqual(words.slice(helper + 1, helper + 7),
    ["--bot", ID.dev, "--project", s.project, "--worker", "--"]);
  const plain = s.cli(["worker", "do another task", "--branch", "feat/plain", "--agent", "codex",
    "--json"]);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(s.runs().at(-1).some((word) => word.endsWith("/hcPane.mjs")), false);
});

// #1125: Codex's launch mode, spelled out, and a Codex run's --add-dir grants taken apart from its
// other words (the tool-cache grants follow the runner's environment, so they are not compared).
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
// A Codex worker's first two grants: its worktree's own git dir, then the project's .git.
const workerGitDirs = (s, worktree) => [realpathSync(join(s.project, ".git", "worktrees", worktree)), realpathSync(join(s.project, ".git"))];

test("worker: the bot's worker defaults are used, and per-task --agent/--model/--effort win", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/login", "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual([out.agent, out.model, out.effort], ["codex", "gpt-5.5", "medium"]);
  const codex = grantsApart(after(s.runs()[0]));
  assert.deepEqual(codex.words, ["codex", ...CODEX_MODE, "--model", "gpt-5.5", "-c", "model_reasoning_effort=medium", "fix the login form"]);
  assert.deepEqual(codex.dirs.slice(0, 2), workerGitDirs(s, "feat-login"));
  const o = s.cli(["worker", "review it", "--branch", "feat/review", "--agent", "claude", "--model", "opus", "--effort", "max", "--json"]);
  assert.equal(o.code, 0, o.err);
  assert.deepEqual([o.json().agent, o.json().model, o.json().effort], ["claude", "opus", "max"]);
  assert.deepEqual(freshClaude(after(s.runs()[1])), ["claude", "--permission-mode", "auto", "--model", "opus", "--effort", "max", "review it"]);
});

test("worker #1125: a bot's codexAuto false no longer opts out (#946 retired): its Codex workers run the launch mode", (t) => {
  const file = team();
  file.bots[2].codexAuto = false;
  const s = scene(t, { file });
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/login", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(grantsApart(after(s.runs()[0])).words, ["codex", ...CODEX_MODE, "--model", "gpt-5.5", "-c", "model_reasoning_effort=medium", "fix the login form"]);
  const o = s.cli(["worker", "tune it", "--branch", "feat/tune", "--agent", "codex", "--json"]);
  assert.equal(o.code, 0, o.err);
  assert.deepEqual(grantsApart(after(s.runs()[1])).words.slice(0, 1 + CODEX_MODE.length), ["codex", ...CODEX_MODE], "a per-task --agent codex too");
  assert.equal(s.runs()[1].includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("worker kill (#955): a bot ends a worker it started and nothing else: a seat, another bot's worker, its own pane and a plain pane are refused", (t) => {
  const s = scene(t);
  const started = s.cli(["worker", "fix the login form", "--branch", "feat/login", "--json"]);
  assert.equal(started.code, 0, started.err);
  const mine = started.json().terminal;
  const kills = () => s.calls().filter((c) => c[0] === "kill");
  // Another bot (Captain, t4) may not end Dev's worker; neither a bot's seat, a plain pane nor the caller's own pane is ended.
  for (const [args, from, why] of [[["worker", "kill", mine], "t4", /is another bot's worker; worker kill ends only a worker you started\. Nothing was ended\./],
    [["worker", "kill", "t4"], "t1", /t4 is a bot's pane, not a worker/], [["worker", "kill", "t2"], "t1", /t2 isn't a worker/],
    [["worker", "kill", "t1"], "t1", /t1 is your own pane/], [["worker", "kill", "t999"], "t1", /t999 isn't a terminal hc knows/],
    [["worker", "kill", "vm/t9"], "t1", /on this computer only/]]) {
    const r = s.cli(args, { from });
    assert.equal(r.code, 1, `${args.join(" ")} from ${from}: ${r.err}`);
    assert.match(r.err, why);
  }
  assert.deepEqual(kills(), [], "no refused call reached hc kill");
  assert.equal(s.cli(["worker", "kill"]).code, 2, "it takes one terminal");
  assert.equal(s.cli(["worker", "kill", mine, "t4"]).code, 2);
  // A pane that isn't a bot's can't call it at all.
  assert.equal(s.cli(["worker", "kill", mine], { from: "t2" }).code, 1);
  assert.deepEqual(kills(), []);
  // Mid-turn, even its own bot doesn't end it; once the turn is over it does.
  const setStatus = (state) => {
    const st = s.hcState();
    st.terminals.find((x) => x.address === mine).status = { state };
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  };
  setStatus("working");
  const busy = s.cli(["worker", "kill", mine]);
  assert.equal(busy.code, 1);
  assert.match(busy.err, /is still working; worker kill ends a worker that has finished its turn/);
  assert.deepEqual(kills(), []);
  setStatus("idle");
  // Its own bot ends it: exactly one hc kill, of that terminal.
  const r = s.cli(["worker", "kill", mine, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().terminal, r.json().ended, r.json().branch], [mine, true, "feat/login"]);
  assert.deepEqual(kills().map((c) => c.slice(0, 2)), [["kill", mine]]);
  // Ended already: said, and no second kill.
  const again = s.cli(["worker", "kill", mine]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /has already ended/);
  assert.equal(kills().length, 1);
  // A task whose text starts with "kill" is still a task: it names --branch.
  const task = s.cli(["worker", "kill", "the", "flaky", "test", "--branch", "feat/kill-flaky", "--json"]);
  assert.equal(task.code, 0, task.err);
  assert.equal(kills().length, 1);
});

test("worker: a bot with no worker field runs its own agent, with that agent's default model and effort", (t) => {
  const file = team();
  delete file.bots[2].worker;
  const s = scene(t, { file });
  const r = s.cli(["worker", "write the parser", "--branch", "feat/parser", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().agent, r.json().model, r.json().effort], ["claude", null, null]);
  const run = s.runs()[0];
  assert.deepEqual(freshClaude(after(run)), ["claude", "--permission-mode", "auto", "write the parser"]);
  assert.equal(labelsOf(run).some((l) => l.startsWith("worker.model=") || l.startsWith("worker.effort=")), false);
});

test("worker: a codex captain starts a Claude reviewer with --agent claude-code; its codex model stays behind", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "review PR 12", "--branch", "review/pr-12", "--agent", "claude-code", "--json"], { from: "t4" });
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual([out.agent, out.model, out.effort], ["claude", null, "high"]);
  assert.deepEqual(freshClaude(after(s.runs()[0])), ["claude", "--permission-mode", "auto", "--effort", "high", "review PR 12"]);
  assert.match(r.err, /worker model gpt-5\.5 is for codex; claude runs its own default/);
  assert.ok(labelsOf(s.runs()[0]).includes(`worker.of=${ID.cap}`));
});

// ---- Claude logins (#453): claude-logins.json read at each worker launch ----

test("worker #453: a Claude worker gets login 2's folder by value; a codex worker never reads the record; a bad record: login A, warned", (t) => {
  const s = scene(t);
  const two = join(s.root, "home", ".claude-2");
  mkdirSync(two);
  const record = join(s.app, "claude-logins.json");
  writeFileSync(record, JSON.stringify({ use: "2", logins: [{ id: "2", dir: two }] }));
  const r = s.cli(["worker", "review PR 12", "--branch", "review/pr-12", "--agent", "claude-code", "--json"], { from: "t4" });
  assert.equal(r.code, 0, r.err);
  const words = runArgv(s.runs()[0]);
  assert.deepEqual([words[0], words[2], words[3]], ["/usr/bin/env", `CLAUDE_CONFIG_DIR=${two}`, "claude"], words.join(" "));
  assert.match(words[1], /^PATH=/);
  assert.doesNotMatch(r.err, /claude-logins/);

  // Unreadable (a folder in its place): a codex worker neither reads nor warns; a Claude one starts on login A, warned.
  rmSync(record);
  mkdirSync(record);
  const codex = s.cli(["worker", "fix it", "--branch", "feat/codex", "--json"]);
  assert.equal(codex.code, 0, codex.err);
  const cw = runArgv(s.runs()[1]);
  assert.match(cw[1], /^PATH=/);
  assert.equal(cw[2], "codex");
  assert.ok(!cw.includes("-u") && !cw.some((w) => w.startsWith("CLAUDE_CONFIG_DIR")), cw.join(" "));
  assert.doesNotMatch(codex.err, /claude-logins/, "a codex launch never reads or warns about the record");
  const bad = s.cli(["worker", "fix it too", "--branch", "feat/claude", "--agent", "claude-code", "--json"]);
  assert.equal(bad.code, 0, bad.err);
  assert.deepEqual(runArgv(s.runs()[2]).slice(0, 3), ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR"]);
  assert.match(bad.err, /claude-logins\.json: can't be read \(EISDIR\); started on the default login/);
});

test("worker #453: a Claude template runs its own command under the login words, its label kept; a codex template is unchanged", (t) => {
  const s = scene(t);
  const two = join(s.root, "home", ".claude-2");
  mkdirSync(two);
  writeFileSync(join(s.app, "claude-logins.json"), JSON.stringify({ use: "2", logins: [{ id: "2", dir: two }] }));
  const r = s.cli(["worker", "review it", "--branch", "feat/review", "--template", "opus-rev", "--role", "review", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  assert.ok(labelsOf(run).includes("worker.template=opus-rev"), "still a template worker");
  assert.deepEqual(runArgv(run), ["/usr/bin/env", `CLAUDE_CONFIG_DIR=${two}`, "sh", "-c",
    'claude --dangerously-skip-permissions --model claude-opus-5-5 "$@"', "sh", "review it"], "the task is an argument, never part of the shell line");
  assert.equal(r.json().template, "opus-rev");
  const codex = s.cli(["worker", "fix it", "--branch", "feat/login", "--template", "dev-sol", "--json"]);
  assert.equal(codex.code, 0, codex.err);
  assert.deepEqual(templateArgv(s.runs()[1]), ["dev-sol", "fix it"], "hc's own template form, no login words");
});

test("worker #453: a Claude template whose command can't take the task is refused before any worktree", (t) => {
  const s = scene(t, { templates: [...TEMPLATES, { name: "opus-x", command: "claude --model opus; echo done;" }] });
  const r = s.cli(["worker", "x", "--branch", "feat/x", "--template", "opus-x"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Template opus-x runs Claude, but its command ends in a separator or a comment/);
  assert.equal(s.runs().length, 0);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-x")), false);
});

// ---- the worktree ----

test("worker --branch creates the task worktree from the base; a second call reuses it; main's HEAD stays", (t) => {
  const s = scene(t);
  git(s.project, "branch", "dev");
  const first = s.cli(["worker", "one", "--branch", "feat/login", "--json"]);
  assert.equal(first.code, 0, first.err);
  const wt = join(s.project, ".claude/worktrees/feat-login");
  assert.equal(first.json().worktree, wt);
  assert.equal(first.json().created, true);
  assert.equal(first.json().base, "dev", "dev before main when there is no origin");
  assert.equal(git(wt, "symbolic-ref", "--short", "HEAD").trim(), "feat/login");
  assert.equal(git(s.project, "symbolic-ref", "--short", "HEAD").trim(), "main");
  // Another bot's reviewer on the same task shares the writer's worktree.
  const second = s.cli(["worker", "two", "--branch", "feat/login", "--role", "review", "--json"], { from: "t4" });
  assert.equal(second.code, 0, second.err);
  assert.equal(second.json().worktree, wt);
  assert.equal(second.json().created, false);
  assert.equal(parseWorktrees(git(s.project, "worktree", "list", "--porcelain")).filter((w) => w.branch === "feat/login").length, 1);
  // --base picks the start; the branch checked out in the main checkout is refused.
  const based = s.cli(["worker", "three", "--branch", "feat/b", "--base", "main", "--json"]);
  assert.equal(based.json().base, "main");
  const onMain = s.cli(["worker", "four", "--branch", "main"]);
  assert.equal(onMain.code, 1);
  assert.match(onMain.err, /checked out in the main checkout/);
});

test("worker --branch with an origin: fetched, and the new branch starts from origin/HEAD's branch", (t) => {
  const s = scene(t);
  git(s.project, "branch", "dev");
  const origin = join(s.root, "origin.git");
  git(s.root, "clone", "-q", "--bare", s.project, origin);
  git(s.project, "remote", "add", "origin", origin);
  git(s.project, "fetch", "-q", "origin");
  git(s.project, "remote", "set-head", "origin", "dev");
  // A commit only origin has: the fetch must bring it before the branch is cut.
  const other = join(s.root, "other-clone");
  git(s.root, "clone", "-q", "-b", "dev", origin, other);
  git(other, "commit", "-q", "--allow-empty", "-m", "upstream work");
  git(other, "push", "-q", "origin", "dev");
  const upstream = git(other, "rev-parse", "HEAD").trim();
  const r = s.cli(["worker", "x", "--branch", "feat/up", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().base, "origin/dev");
  assert.equal(git(r.json().worktree, "rev-parse", "HEAD").trim(), upstream);
  // A branch origin has already is continued, not started over from the base.
  git(other, "checkout", "-q", "-b", "feat/remote");
  git(other, "commit", "-q", "--allow-empty", "-m", "remote branch work");
  git(other, "push", "-q", "origin", "feat/remote");
  const remote = s.cli(["worker", "y", "--branch", "feat/remote", "--json"]);
  assert.equal(remote.json().base, "origin/feat/remote");
  assert.equal(git(remote.json().worktree, "log", "-1", "--format=%s").trim(), "remote branch work");
});

test("worker --branch --base origin/dev: the new branch has no upstream, so pull and push never hit dev", (t) => {
  const s = scene(t);
  git(s.project, "branch", "dev");
  const origin = join(s.root, "origin.git");
  git(s.root, "clone", "-q", "--bare", s.project, origin);
  git(s.project, "remote", "add", "origin", origin);
  git(s.project, "fetch", "-q", "origin");
  // The default (true) already tracks a remote-tracking start; "always" makes the test hold
  // whatever the machine's global git config says.
  git(s.project, "config", "branch.autoSetupMerge", "always");
  const r = s.cli(["worker", "x", "--branch", "docs/drafts", "--base", "origin/dev", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().base, "origin/dev");
  const up = spawnSync("git", ["rev-parse", "--abbrev-ref", "docs/drafts@{upstream}"], { cwd: r.json().worktree, encoding: "utf8" });
  assert.notEqual(up.status, 0, `docs/drafts has an upstream: ${up.stdout.trim()}`);
  const conf = spawnSync("git", ["config", "--get-regexp", "^branch\\.docs/drafts\\."], { cwd: s.project, encoding: "utf8" });
  assert.equal(conf.stdout, "", "no branch.docs/drafts.remote or .merge");
  // Continuing origin's own branch of that name keeps it as the upstream.
  git(origin, "branch", "feat/remote", "dev");
  git(s.project, "fetch", "-q", "origin");
  const remote = s.cli(["worker", "y", "--branch", "feat/remote", "--json"]);
  assert.equal(remote.code, 0, remote.err);
  assert.equal(git(remote.json().worktree, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}").trim(), "origin/feat/remote");
});

test("worker --worktree uses an existing worktree of the project, on its branch; the main checkout is refused", (t) => {
  const s = scene(t);
  const wt = join(s.root, "side");
  git(s.project, "worktree", "add", "-q", "-b", "fix/side", wt);
  const r = s.cli(["worker", "fix it", "--worktree", wt, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().worktree, r.json().branch, r.json().created], [wt, "fix/side", false]);
  const main = s.cli(["worker", "fix it", "--worktree", s.project]);
  assert.equal(main.code, 1);
  assert.match(main.err, /main checkout/);
});

// ---- the spawn: parent, labels, cwd, ledger ----

test("worker: hc run --bg as a child of the bot's pane, in the worktree, with the usage labels and no bot label", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/login"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const wt = join(s.project, ".claude/worktrees/feat-login");
  assert.deepEqual(run.slice(0, 3), ["run", "--bg", "--json"]);
  assert.equal(run[run.indexOf("--parent") + 1], "t1");
  assert.equal(run[run.indexOf("--cwd") + 1], wt);
  assert.equal(run[run.indexOf("--name") + 1], "feat-login");
  // No --task: the branch label, and no task label at all (no faked task id).
  assert.deepEqual(labelsOf(run), [`worker.of=${ID.dev}`, "branch=feat/login", "worker.role=dev", "worker.model=gpt-5.5",
    "worker.effort=medium"]);
  // The agent gets the calling pane's PATH (herdr-core's lacks ~/.bun/bin, where omp lives),
  // as argv words, never a shell string.
  assert.deepEqual(runArgv(run).slice(0, 3), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:${s.path}`, "codex"]);
  const made = s.hcState().terminals.find((x) => x.address === "t100");
  assert.equal(made.parent, "t1");
  assert.equal(made.cwd, wt);
  assert.equal(made.labels.bot, undefined);
  // Output: the terminal first, then worktree, branch, agent, model, effort.
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "t100");
  assert.match(r.out, new RegExp(`worktree  ${wt}`));
  assert.match(r.out, /branch    feat\/login \(new, from main\)/);
  assert.match(r.out, /model     gpt-5\.5\n  effort    medium/);
  // The ledger row usagemeter joins on, with the worker's foreground pid; no --task: task null.
  const [row] = s.ledger();
  assert.deepEqual({ ...row, at: undefined }, { event: "start", kind: "worker", terminal: "t100", pid: 5100, botId: ID.dev,
    task: null, worktree: wt, agent: "codex", model: "gpt-5.5", effort: "medium", template: null, role: "dev",
    branch: "feat/login", project: s.project, lead: ID.dev, base: git(s.project, "rev-parse", "main").trim(), created: true,
    swap: false, override: false, override_requested: null,
    core: "fakecore0000", created_ms: s.hcState().terminals.find((x) => x.address === "t100").created_ms, squad: ID.dev, session: null, at: undefined });
  assert.ok(!Number.isNaN(Date.parse(row.at)));
});

test("mode #821: an empty worker mode launches auto without a mode label", (t) => {
  const bot = { id: ID.dev, name: "A", agent: "antigravity", worker: { agyMode: "" } };
  const plan = workerPlan(bot);
  assert.equal(plan.error, undefined);
  assert.equal(plan.agyMode, "auto");
  assert.deepEqual(plan.argv.slice(-2), ["--mode", "auto"]);
  const args = workerArgs({ botId: ID.dev, branch: "feat/task", role: "dev", name: "worker",
    cwd: "/work/task", parent: "t1", ...plan, task: "Do the task", path: "/bin" });
  assert.equal(args.some((word) => word.startsWith("worker.agyMode=")), false);
});

test("worker Antigravity: --mode auto by default, the chosen worker.agyMode when set, one clear line for an unknown one", (t) => {
  const auto = team();
  auto.bots[2].worker = { agent: "antigravity" };
  const s = scene(t, { file: auto });
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/agy", "--json"]);
  assert.equal(r.code, 0, r.err);
  const cwdOf = (run) => run[run.indexOf("--cwd") + 1];
  assert.deepEqual(after(s.runs()[0]), ["agy", "--dangerously-skip-permissions", "--mode", "auto", "--settings",
    agySettingsFile(agySettingsDir(s.app), ID.dev, "worker", "dev", cwdOf(s.runs()[0])), "-i", "fix the login form"]);
  assert.equal(r.json().agyMode, "auto");
  assert.equal(labelsOf(s.runs()[0]).some((l) => l.startsWith("worker.agyMode=")), false, "the default isn't a label");

  const chosen = team();
  chosen.bots[2].worker = { agent: "antigravity", agyMode: "plan" };
  const s2 = scene(t, { file: chosen });
  const r2 = s2.cli(["worker", "fix the login form", "--branch", "feat/agy", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(after(s2.runs()[0]), ["agy", "--dangerously-skip-permissions", "--mode", "plan", "--settings",
    agySettingsFile(agySettingsDir(s2.app), ID.dev, "worker", "dev", cwdOf(s2.runs()[0])), "-i", "fix the login form"]);
  assert.equal(r2.json().agyMode, "plan");
  assert.ok(labelsOf(s2.runs()[0]).includes("worker.agyMode=plan"));

  const bad = team();
  bad.bots[2].worker = { agent: "antigravity", agyMode: "yolo" };
  const s3 = scene(t, { file: bad });
  const r3 = s3.cli(["worker", "fix the login form", "--branch", "feat/agy"]);
  assert.equal(r3.code, 2);
  assert.match(r3.err, /Dev's workers: Antigravity mode "yolo" isn't one of accept-edits, auto, plan\./);
  assert.match(r3.err, /--worker-agy-mode <accept-edits\|auto\|plan>/);
  assert.equal(s3.runs().length, 0, "nothing started");
});

test("worker #1032: a Kimi worker starts bare and gets its task as its first message, after hc says it is ready", (t) => {
  const TASK = "You are a read-only reviewer of the login form";
  const kimi = team();
  kimi.bots[2].worker = { agent: "kimi" };
  const s = scene(t, { file: kimi });
  exe(join(s.root, "bin", "kimi"), "#!/bin/sh\nexit 0\n");
  const r = s.cli(["worker", TASK, "--branch", "feat/kimi", "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  // kimi 2.5.0 reads a bare word as a command name and exits 1: its argv is the program alone.
  assert.deepEqual(after(s.runs()[0]), ["kimi"]);
  assert.equal(s.runs()[0].includes(TASK), false, "the task is no word of hc run");
  assert.equal(s.runs()[0].includes("-p"), false, "never kimi's one-shot print mode");
  assert.deepEqual(out.argv.slice(-1), ["kimi"]);
  // The task goes in once, as a message to the new pane; hc wait comes first (a send to a
  // booting agent can be dropped), both after hc run.
  assert.deepEqual(s.hcState().sent, [{ to: out.terminal, text: TASK }]);
  const order = s.calls().filter((c) => ["run", "wait", "send"].includes(c[0])).map((c) => c[0]);
  assert.deepEqual(order, ["run", "wait", "send"]);
  assert.deepEqual(s.calls().find((c) => c[0] === "wait").slice(0, 2), ["wait", out.terminal]);
  assert.deepEqual(s.calls().find((c) => c[0] === "send"), ["send", out.terminal, TASK]);
  assert.deepEqual(out.warnings, [], r.err);

  // A send hc refuses (the pane waits for a sign-in or a trust answer, or has ended): the worker
  // is kept and the call succeeds, with one plain line naming the pane and what to do.
  const s2 = scene(t, { file: kimi });
  exe(join(s2.root, "bin", "kimi"), "#!/bin/sh\nexit 0\n");
  const st = s2.hcState();
  writeFileSync(join(s2.root, "hc.json"), JSON.stringify({ ...st, failSend: ["t100"] }));
  const r2 = s2.cli(["worker", TASK, "--branch", "feat/kimi", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.json().terminal, "t100");
  assert.equal(s2.hcState().sent, undefined, "nothing went in");
  assert.equal(r2.json().warnings.length, 1, JSON.stringify(r2.json().warnings));
  assert.match(r2.json().warnings[0], /^t100 started without its task \(hc send: t100 is blocked\): .*hc read t100.*hc send t100 "<task>"\.$/);
  assert.match(r2.err, /t100 started without its task/, "on stderr too");
  assert.equal(s2.ledger().filter((row) => row.terminal === "t100").length, 1, "its start row is written all the same");
});

test("worker #1032: every other agent's task stays a word of hc run, and no message is sent", (t) => {
  for (const [agent, program, words] of [["codex", "codex", ["fix the login form"]], ["claude", "claude", ["fix the login form"]],
    ["antigravity", "agy", ["-i", "fix the login form"]]]) {
    const file = team();
    file.bots[2].worker = { agent };
    const s = scene(t, { file });
    const r = s.cli(["worker", "fix the login form", "--branch", "feat/other", "--json"]);
    assert.equal(r.code, 0, `${agent}: ${r.err}`);
    const argv = freshClaude(after(s.runs()[0]));
    assert.equal(argv[0], program, agent);
    assert.deepEqual(argv.slice(-words.length), words, agent);
    assert.equal(s.calls().some((c) => c[0] === "send" || c[0] === "wait"), false, `${agent}: no first message, no wait`);
    assert.equal(s.hcState().sent, undefined, agent);
  }
});

test("workerArgs #1032: kimi's hc run ends at its program, with no task word; the same call for another agent ends in the task", () => {
  const base = { botId: ID.dev, branch: "feat/a", name: "feat-a", cwd: "/p/wt", parent: "t1", task: "fix the build", path: "/x/bin" };
  const head = ["run", "--bg", "--json", "--name", "feat-a", "--cwd", "/p/wt", "--label", `worker.of=${ID.dev}`, "--label", "branch=feat/a",
    "--parent", "t1", "--", "/usr/bin/env", `PATH=${KILL_GUARD_DIR}:/x/bin`];
  const kimi = workerPlan({ name: "K", agent: "claude", worker: { agent: "kimi" } });
  assert.deepEqual(kimi.argv, ["kimi"]);
  assert.deepEqual(workerArgs({ ...base, agent: kimi.agent, argv: kimi.argv }), [...head, "kimi"]);
  assert.equal(workerArgs({ ...base, agent: kimi.agent, argv: kimi.argv }).includes("fix the build"), false);
  // Its own options stay where they were, and none of them is followed by the task.
  assert.deepEqual(runArgv(workerArgs({ ...base, agent: "kimi", argv: ["kimi", "--auto"] })).slice(2), ["kimi", "--auto"]);
  // Unchanged: every other agent Herdr knows ends in its task (agy behind -i, dsh-tui after --).
  const own = { antigravity: ["-i", "fix the build"], "dsh-tui": ["--", "fix the build"] };
  for (const key of Object.keys(AGENTS).filter((k) => k !== "kimi")) {
    const words = own[key] ?? ["fix the build"];
    assert.deepEqual(runArgv(workerArgs({ ...base, agent: key, argv: ["prog"] })).slice(-words.length - 1), ["prog", ...words], key);
  }
  assert.deepEqual(runArgv(workerArgs({ ...base, argv: ["omp"] })), ["/usr/bin/env", "PATH=/x/bin", "omp", "fix the build"], "no agent named");
});

test("worker #823: an Antigravity worker writes its 0600 permission file (its worktree, the roster's rules), a review worker a read-only one", (t) => {
  const f = team();
  f.bots[2].worker = { agent: "antigravity" };
  f.bots[2].agyPermissions = { allow: ["command(npm publish)"], deny: ["command(git stash)"] };
  const s = scene(t, { file: f });
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/agy", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const cwd = run[run.indexOf("--cwd") + 1];
  const path = agySettingsFile(agySettingsDir(s.app), ID.dev, "worker", "dev", cwd);
  assert.ok(after(run).includes(path), "the task argv carries the file");
  assert.equal(statSync(path).mode & 0o777, 0o600, "private");
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(data.permissions.allow.includes(`write_file(${cwd})`), "it writes in its worktree");
  assert.equal(data.permissions.allow.some((rule) => rule.startsWith("write_file(") && rule !== `write_file(${cwd})`), false);
  assert.ok(data.permissions.allow.includes("command(hc)"));
  for (const rule of ["command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)"]) {
    assert.ok(data.permissions.allow.includes(rule), `worker allow ${rule}`);
  }
  for (const tool of AGY_SHELL_READ) {
    assert.ok(data.permissions.allow.includes(`command(${tool})`), `worker allow command(${tool})`);
  }
  for (const bad of ["command(bash)", "command(sh)", "command(env)", "command(xargs)",
    "command(find)", "command(awk)", "command(tee)", "command(sed)"]) {
    assert.equal(data.permissions.allow.includes(bad), false, `worker never allows ${bad}`);
  }
  assert.ok(data.permissions.allow.includes("command(npm publish)"), "the bot's roster reaches its worker");
  assert.ok(data.permissions.deny.includes("command(git stash)"));
  for (const rule of AGY_FIXED_DENY) assert.ok(data.permissions.deny.includes(rule));
  // #879: the file trusts the worker's own worktree, exact, so agy asks no trust question.
  assert.deepEqual(data.trustedWorkspaces, [cwd], "the worker's settings trust its worktree");
  for (const wrong of [s.project, dirname(cwd), s.env.HOME, "/"]) {
    assert.equal(data.trustedWorkspaces.includes(wrong), false, `never ${wrong}`);
  }
  // A reviewer runs on another branch's worktree: no write_file and no writer shell of its own.
  const g = team();
  g.bots[2].worker = { agent: "antigravity" };
  const s2 = scene(t, { file: g });
  const r2 = s2.cli(["worker", "review the login form", "--branch", "feat/agy-review", "--role", "review", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  const run2 = s2.runs()[0];
  const cwd2 = run2[run2.indexOf("--cwd") + 1];
  const path2 = agySettingsFile(agySettingsDir(s2.app), ID.dev, "worker", "review", cwd2);
  assert.ok(after(run2).includes(path2));
  const review = JSON.parse(readFileSync(path2, "utf8"));
  assert.equal(review.permissions.allow.some((rule) => rule.startsWith("write_file(")), false, "a review worker writes nothing");
  assert.equal(review.permissions.allow.includes("command(git)"), false, "no writer shell at all");
  for (const rule of ["command(hc ls)", "command(hc get)", "command(hc read)", "command(hc wait)", "command(hc send)"]) {
    assert.ok(review.permissions.allow.includes(rule), `review worker allow ${rule}`);
  }
  for (const rule of ["command(hc)", "command(hc run)", "command(hc exec)",
    "command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)"]) {
    assert.equal(review.permissions.allow.includes(rule), false, `review worker excludes ${rule}`);
  }
  assert.ok(review.permissions.allow.includes("command(git diff)"));
  for (const tool of AGY_SHELL_READ) {
    assert.ok(review.permissions.allow.includes(`command(${tool})`), `review worker allow command(${tool})`);
  }
  for (const bad of ["command(bash)", "command(sh)", "command(env)", "command(xargs)",
    "command(find)", "command(awk)", "command(tee)", "command(sed)"]) {
    assert.equal(review.permissions.allow.includes(bad), false, `review worker never allows ${bad}`);
  }
  // #1046: a review worker is read-only in its allow list, but its own worktree is trusted like
  // any writer's, so an unattended --role review worker never stops at agy's trust question.
  assert.deepEqual(review.trustedWorkspaces, [cwd2], "the review worker's settings trust its own worktree");
  for (const wrong of [s2.project, dirname(cwd2), s2.env.HOME, "/"]) {
    assert.equal(review.trustedWorkspaces.includes(wrong), false, `never ${wrong}`);
  }
  assert.equal(readFileSync(path2, "utf8").includes("trustedWorkspaces"), true, "the key is written");
});

test("worker #879: a fake agy reads --settings and trusts only its session cwd, never a saved trust list", (t) => {
  const f = team();
  f.bots[2].worker = { agent: "antigravity" };
  const s = scene(t, { file: f });
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/agy", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const cwd = run[run.indexOf("--cwd") + 1];
  const words = after(run);
  assert.deepEqual(words.slice(0, 3), ["agy", "--dangerously-skip-permissions", "--mode"], JSON.stringify(words));
  const at = words.indexOf("--settings");
  assert.ok(at > 0, "the launch names its settings file");
  // A stand-in agy like the one a worker runs: it reads the file the launch names, from the
  // worker's own folder, and records whether it had to fall back to a saved trust list.
  const script = join(s.root, "fake-agy-trust.mjs");
  writeFileSync(script, [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    "const at = args.indexOf('--settings');",
    "const data = at < 0 ? null : JSON.parse(readFileSync(args[at + 1], 'utf8'));",
    "const gemini = existsSync(join(process.env.HOME, '.gemini'));",
    "const trusted = data?.trustedWorkspaces ?? [];",
    "writeFileSync(process.env.AGY_TRUST_OUT, JSON.stringify({ cwd: process.cwd(), trusted, gemini }));",
    "process.exit(trusted.length === 1 && trusted[0] === process.cwd() && !gemini ? 0 : 1);",
  ].join("\n"));
  const report = join(s.root, "fake-agy-trust.json");
  const res = spawnSync(process.execPath, [script, ...words], {
    cwd, env: { ...s.env, HOME: s.env.HOME, AGY_TRUST_OUT: report }, encoding: "utf8" });
  assert.equal(res.status, 0, `fake agy refused the launch: ${res.stderr}`);
  const seen = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(seen.trusted, [cwd], "agy trusts the session's cwd, exact");
  assert.equal(seen.gemini, false, "the fake agy read no saved trust list");
  assert.equal(existsSync(join(s.env.HOME, ".gemini")), false, "the pack never writes agy's saved settings");
});

test("worker #823: a template that runs agy is rebuilt with --settings and its task, or says it can't take the list", (t) => {
  const f = team();
  f.bots[2].worker = { template: "agy-work" };
  const s = scene(t, { file: f, templates: [...TEMPLATES, { name: "agy-work", command: "agy --mode auto" },
    { name: "agy-stuck", command: "agy --mode auto; # no words" }] });
  const r = s.cli(["worker", "do the task", "--branch", "feat/agy", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const cwd = run[run.indexOf("--cwd") + 1];
  const path = agySettingsFile(agySettingsDir(s.app), ID.dev, "worker", "dev", cwd);
  assert.deepEqual(runArgv(run), ["/usr/bin/env", "sh", "-c", 'agy --mode auto "$@"', "sh", "--settings", path, "do the task"]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(path, "utf8")).permissions.allow.includes(`write_file(${cwd})`));
  // One that can't take words runs through hc's template form without a list, with a plain warning.
  const g = team();
  g.bots[2].worker = { template: "agy-stuck" };
  const s2 = scene(t, { file: g, templates: [...TEMPLATES, { name: "agy-stuck", command: "agy --mode auto; # no words" }] });
  const r2 = s2.cli(["worker", "do the task", "--branch", "feat/agy", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(templateArgv(s2.runs()[0]), ["agy-stuck", "do the task"], "hc's template form, no words");
  assert.match(r2.json().warnings.join("\n"), /template agy-stuck ends in a separator or a comment, so its Antigravity permission list can't be added/);
});

test("worker: a bot's space label the window no longer has is left out; a moved bot pane's space is used", (t) => {
  // The bot's pane is labelled sp-gone, a space the window doesn't have, and isn't shown: no space label.
  const s = scene(t);
  labelBot(s, { "herdr.space": "sp-gone", "herdr.tab": "tb-gone" });
  s.setWindow({ spaces: [{ id: "sp-other", name: "x", folder: "/x", machine: null, active: true, tabs: [{ id: "tb-x", name: "1", active: true, terminals: [] }] }] });
  const r = s.cli(["worker", "fix it", "--branch", "feat/gone"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(labelsOf(s.runs()[0]).some((l) => l.startsWith("herdr.")), false, labelsOf(s.runs()[0]).join(" "));
  assert.equal(s.appDos().length, 0, "no space label: no tab to set up");
  // Its pane moved into sp-bot while its label still says sp-old: the worker goes where the window shows the bot.
  const m = scene(t);
  labelBot(m, { "herdr.space": "sp-old", "herdr.tab": "tb-old" });
  m.setWindow(botWindow());
  assert.equal(m.cli(["worker", "fix it", "--branch", "feat/moved"]).code, 0);
  assert.ok(labelsOf(m.runs()[0]).includes("herdr.space=sp-bot"), labelsOf(m.runs()[0]).join(" "));
});

test("worker: once Herdr shows its pane, its tab is moved right after its bot's and named after it; never focused", (t) => {
  const s = scene(t);
  labelBot(s, { "herdr.space": "sp-bot", "herdr.tab": "tb-bot" });
  s.setWindow(botWindow({ place: true, probe: join(s.app, "automagik-herdr/workers.jsonl") }));
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/login", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().terminal, "t100");
  assert.deepEqual(r.json().warnings, []);
  // Herdr put t100 in a tab of its own at the end (tb-t100, position 4): moved to 3, after tb-bot.
  assert.deepEqual(s.appDos(), [["tab.move", { id: "tb-t100", index: 3 }], ["tab.rename", { id: "tb-t100", name: "feat/login" }]]);
  assert.deepEqual(s.windowNow().spaces[0].tabs.map((x) => [x.id, x.name]), [["tb-a", "1"], ["tb-bot", "Dev"], ["tb-t100", "feat/login"], ["tb-c", "3"]]);
  // The workers.jsonl row was written before the tab setup, as launchSeat writes its rows first.
  assert.deepEqual(s.windowNow().probed, [["tab.move", true], ["tab.rename", true]]);
  assert.deepEqual(s.ledger().map((row) => [row.kind, row.terminal]), [["worker", "t100"]]);
  // No window to ask (worker.test's default): no tab setup, as before.
  const d = scene(t);
  labelBot(d, { "herdr.space": "sp-bot" });
  assert.equal(d.cli(["worker", "fix it", "--branch", "feat/down"]).code, 0);
  assert.deepEqual(d.appDos(), []);
  // Herdr never shows the pane (within the wait): the worker runs, its tab untouched, and says so.
  const n = scene(t);
  labelBot(n, { "herdr.space": "sp-bot" });
  n.setWindow(botWindow());
  const late = n.cli(["worker", "fix it", "--branch", "feat/late", "--json"]);
  assert.equal(late.code, 0, late.err);
  assert.match(late.json().warnings.join("\n"), /Herdr hadn't shown t100 after 0\.3s, so its tab isn't named or moved beside its bot's/);
  assert.deepEqual(n.appDos(), []);
  // AUTOMAGIK_HERDR_TAB_WAIT_MS=0 turns the tab setup off: the space label stays, no wait, no tab command, no warning.
  const off = scene(t);
  labelBot(off, { "herdr.space": "sp-bot", "herdr.tab": "tb-bot" });
  off.setWindow(botWindow({ place: true }));
  const quiet = off.cli(["worker", "fix it", "--branch", "feat/off", "--json"], { env: { AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" } });
  assert.equal(quiet.code, 0, quiet.err);
  assert.ok(labelsOf(off.runs()[0]).includes("herdr.space=sp-bot"));
  assert.deepEqual([off.appDos(), quiet.json().warnings], [[], []]);
});

test("worker opens in a tab of its own in its bot's space: herdr.space at hc run, never herdr.tab; no space, no label", (t) => {
  const s = scene(t);
  // The bot's pane (t1) is in tab tb-bot of space sp-bot.
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t1").labels, { "herdr.space": "sp-bot", "herdr.tab": "tb-bot" });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["worker", "fix the login form", "--branch", "feat/login"]).code, 0);
  assert.equal(s.cli(["worker", "review it", "--branch", "feat/review", "--template", "dev-sol", "--role", "review"]).code, 0);
  for (const run of s.runs()) {
    const labels = labelsOf(run);
    assert.ok(labels.includes("herdr.space=sp-bot"), labels.join(" "));
    assert.equal(labels.some((l) => l.startsWith("herdr.tab=")), false, labels.join(" "));
  }
  // Set by hc run itself, so the worker never shows in the bot's tab first: no hc label after.
  assert.equal(s.calls().some((c) => c[0] === "label"), false);
  assert.equal(s.hcState().terminals.find((x) => x.address === "t100").labels["herdr.space"], "sp-bot");
  // A bot whose pane has no space label: the worker gets no placement label, as before.
  const bare = scene(t);
  assert.equal(bare.cli(["worker", "fix it", "--branch", "feat/bare"]).code, 0);
  assert.equal(labelsOf(bare.runs()[0]).some((l) => l.startsWith("herdr.")), false, labelsOf(bare.runs()[0]).join(" "));
});

test("start and attach append a seat row to the ledger", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["start", "Genie"], { from: null }).code, 0);
  const seat = s.ledger().find((r) => r.kind === "seat");
  assert.deepEqual([seat.terminal, seat.botId, seat.task, seat.worktree, seat.agent, seat.pid], ["t100", ID.main, null, s.project, "claude", 5100]);
  assert.equal(seat.project, s.project, "a seat row names its project (usagemeter: task null, project the key)");
  // Captain's label on t4 was imported into the attach ledger: the move is explicit.
  assert.equal(s.cli(["attach", "Captain", "t2", "--move"], { from: null }).code, 0);
  const attached = s.ledger().filter((r) => r.kind === "seat")[1];
  assert.deepEqual([attached.terminal, attached.botId, attached.agent, attached.pid], ["t2", ID.cap, "claude", 4000]);
  assert.deepEqual([attached.task, attached.project], [null, s.project]);
  assert.equal(seat.template, null, "a seat runs no template");
});

// ---- hc templates ----

test("worker --template: hc's template form, a child of the bot's pane in the worktree, labelled; ledger names it", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "fix the login form", "--branch", "feat/login", "--template", "dev-sol", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const wt = join(s.project, ".claude/worktrees/feat-login");
  assert.deepEqual(run.slice(0, 3), ["run", "--bg", "--json"]);
  assert.equal(run[run.indexOf("--parent") + 1], "t1");
  assert.equal(run[run.indexOf("--cwd") + 1], wt);
  assert.equal(run[run.indexOf("--name") + 1], "feat-login");
  assert.deepEqual(labelsOf(run), [`worker.of=${ID.dev}`, "branch=feat/login", "worker.role=dev", "worker.template=dev-sol"]);
  assert.deepEqual(templateArgv(run), ["dev-sol", "fix the login form"], "the template sets its own command: no env, no agent argv");
  const out = r.json();
  assert.deepEqual([out.template, out.agent, out.model, out.effort, out.argv], ["dev-sol", null, null, null, null]);
  assert.doesNotMatch(r.err, /ignored/, "a per-task template sets the bot's defaults aside without a word");
  const [row] = s.ledger();
  assert.deepEqual({ ...row, at: undefined }, { event: "start", kind: "worker", terminal: "t100", pid: 5100, botId: ID.dev,
    task: null, worktree: wt, agent: null, model: null, effort: null, template: "dev-sol", role: "dev",
    branch: "feat/login", project: s.project, lead: ID.dev, base: git(s.project, "rev-parse", "main").trim(), created: true,
    swap: false, override: true, override_requested: null,
    core: "fakecore0000", created_ms: s.hcState().terminals.find((x) => x.address === "t100").created_ms, squad: ID.dev, session: null, at: undefined });
  // A codex template: no Claude hook in the worktree, and no warning about one.
  assert.equal(existsSync(join(wt, ".claude/settings.local.json")), false);
  assert.doesNotMatch(r.err, /session hook/);
  // Text output names the template and the agent it runs.
  const text = s.cli(["worker", "review it", "--branch", "feat/review", "--template", "opus-rev"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /template  opus-rev \(runs claude\)/);
  assert.ok(existsSync(join(s.project, ".claude/worktrees/feat-review/.claude/settings.local.json")), "a Claude template gets the hook");
});

test("worker --template with --agent, --model or --effort is refused; an unknown template too, before any worktree", (t) => {
  const s = scene(t);
  for (const extra of [["--model", "gpt-6.1-sol"], ["--agent", "codex"], ["--effort", "high"]]) {
    const r = s.cli(["worker", "x", "--branch", "feat/x", "--template", "dev-sol", ...extra]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.match(r.err, /A template owns its command: --template goes alone/);
  }
  const unknown = s.cli(["worker", "x", "--branch", "feat/x", "--template", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /hc has no template nope\. Its templates: dev-sol, opus-rev, mystery/);
  assert.equal(s.cli(["worker", "x", "--branch", "feat/x", "--template", "-x"]).code, 2, "not a template name");
  const empty = s.cli(["worker", "x", "--branch", "feat/x", "--template="]);
  assert.equal(empty.code, 2, "an empty --template is refused, never the default template");
  assert.match(empty.err, /--template needs a name/);
  assert.equal(s.runs().length, 0);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-x")), false);
});

test("worker: a bots.json template default is used; a per-task --agent sets it aside", (t) => {
  const file = team();
  file.bots[1].worker = { template: "dev-sol" };
  file.bots[2].worker = { ...file.bots[2].worker, template: "dev-sol" };
  const s = scene(t, { file });
  const r = s.cli(["worker", "build it", "--branch", "feat/build", "--json"], { from: "t4" });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(templateArgv(s.runs()[0]), ["dev-sol", "build it"]);
  assert.equal(r.json().template, "dev-sol");
  assert.doesNotMatch(r.err, /ignored/, "no agent, model or effort default to set aside");
  // The captain picks Claude for a reviewer: the template default steps aside.
  const o = s.cli(["worker", "review it", "--branch", "review/x", "--agent", "claude", "--json"], { from: "t4" });
  assert.equal(o.code, 0, o.err);
  assert.deepEqual(freshClaude(after(s.runs()[1])), ["claude", "--permission-mode", "auto", "review it"]);
  assert.deepEqual([o.json().template, o.json().agent], [null, "claude"]);
  assert.equal(labelsOf(s.runs()[1]).some((l) => l.startsWith("worker.template=")), false);
  assert.deepEqual(s.ledger().map((row) => row.template), ["dev-sol", null]);
  // Template and agent, model and effort all as defaults: the template wins, with a warning.
  const both = s.cli(["worker", "dev it", "--branch", "feat/dev", "--json"]);
  assert.equal(both.code, 0, both.err);
  assert.deepEqual(templateArgv(s.runs()[2]), ["dev-sol", "dev it"]);
  assert.match(both.err, /Dev's worker template dev-sol owns its command; its worker agent, model, effort defaults are ignored/);
  // --model alone is a per-task pick too: the default template steps aside for the default agent.
  const m = s.cli(["worker", "tune it", "--branch", "feat/tune", "--model", "gpt-6", "--json"]);
  assert.equal(m.code, 0, m.err);
  const tuned = grantsApart(after(s.runs()[3]));
  assert.deepEqual(tuned.words, ["codex", ...CODEX_MODE, "--model", "gpt-6", "-c", "model_reasoning_effort=medium", "tune it"]);
  assert.deepEqual(tuned.dirs.slice(0, 2), workerGitDirs(s, "feat-tune"));
});

test("worker --template: an agent the command doesn't name skips the hook with a warning; no template list refuses", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "x", "--branch", "feat/x", "--template", "mystery"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Can't tell which agent template mystery runs, so no session hook was written/);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-x/.claude/settings.local.json")), false);
  const old = scene(t, { templates: null });
  // No list: an unlisted name would run as a program (`--template rm`), so nothing starts.
  const o = old.cli(["worker", "x", "--branch", "feat/x", "--template", "rm"]);
  assert.equal(o.code, 1, o.err);
  assert.match(o.err, /hc templates gave no list .*rm can't be checked as a template.*Not started/);
  assert.equal(old.runs().length, 0);
  assert.equal(existsSync(join(old.project, ".claude/worktrees/feat-x")), false);
});

// ---- refusals ----

test("worker refuses outside a bot's pane: no HC_TERMINAL_ID, a pane with no bot label, a bot of no project here", (t) => {
  const s = scene(t);
  const none = s.cli(["worker", "x", "--branch", "feat/x"], { from: null });
  assert.equal(none.code, 1);
  assert.match(none.err, /Only a bot starts workers.*HC_TERMINAL_ID isn't set/);
  const plain = s.cli(["worker", "x", "--branch", "feat/x"], { from: "t2" });
  assert.equal(plain.code, 1);
  assert.match(plain.err, /t2 isn't a bot's pane/);
  // t3's bot= label names a bot no project defines, so the import leaves it out; a ledger row
  // tying t3 to that bot (written by hand here) is refused as a bot of no project here.
  assert.match(s.cli(["worker", "x", "--branch", "feat/x"], { from: "t3" }).err, /t3 isn't a bot's pane \(the attach ledger ties no bot to it\)/);
  const row = { v: 1, event: "attach", bot: ID.stray, project: s.project, terminal: "t3", core: "fakecore0000", created_ms: 1,
    machine: null, at: new Date().toISOString(), by: "attach" };
  appendFileSync(join(s.app, "automagik-herdr/attach.jsonl"), `${JSON.stringify(row)}\n`, { mode: LEDGER_MODE });
  const stray = s.cli(["worker", "x", "--branch", "feat/x"], { from: "t3" });
  assert.equal(stray.code, 1);
  assert.match(stray.err, /plays bot b-zzzzzzzzzz, which no project here defines \(looked in .*proj\)/);
  assert.equal(s.runs().length, 0);
  assert.equal(existsSync(join(s.project, ".claude/worktrees")), false, "no worktree made");
  for (const args of [["worker", "--branch", "a"], ["worker", "x"], ["worker", "x", "--branch", "a", "--worktree", "b"], ["worker", "x", "--worktree", "b", "--base", "main"]]) {
    assert.equal(s.cli(args).code, 2, args.join(" "));
  }
});

test("worker refuses a worktree of a project the bot doesn't belong to", (t) => {
  const s = scene(t);
  const other = join(s.root, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  git(other, "commit", "-q", "--allow-empty", "-m", "start");
  const wt = join(s.root, "other-wt");
  git(other, "worktree", "add", "-q", "-b", "feat/y", wt);
  const r = s.cli(["worker", "y", "--worktree", wt]);
  assert.equal(r.code, 1);
  assert.match(r.err, /is a worktree of .*other, not of Dev's project/);
  assert.equal(s.runs().length, 0);
});

// ---- the bots.json field ----

test("bots.json worker: kept through parse, a form save and checkBots; an invalid one is dropped with a warning", () => {
  const text = JSON.stringify(team());
  const { file, raw, warnings } = parseBots(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(file.bots[2].worker, { agent: "codex", model: "gpt-5.5", effort: "medium" });
  // The form's entry names no worker field: a save keeps the stored one.
  const formEntry = { id: ID.dev, name: "Dev", kind: "member", role: "builds", instructions: "", look: { character: "star", colour: "blue" }, agent: "claude", lead: ID.main };
  const saved = applyBotEdit(raw, formEntry);
  assert.deepEqual(checkBots(saved, raw), []);
  assert.deepEqual(parseBots(JSON.stringify(saved)).file.bots[2].worker, { agent: "codex", model: "gpt-5.5", effort: "medium" });
  // A template default survives the same round-trip.
  const withTemplate = team();
  withTemplate.bots[1].worker = { template: "dev-sol", effort: "high" };
  const tp = parseBots(JSON.stringify(withTemplate));
  assert.deepEqual(tp.warnings, []);
  const resaved = applyBotEdit(tp.raw, { ...formEntry, id: ID.cap, name: "Captain", agent: "codex" });
  assert.deepEqual(checkBots(resaved, tp.raw), []);
  assert.deepEqual(parseBots(JSON.stringify(resaved)).file.bots[1].worker, { template: "dev-sol", effort: "high" });
  withTemplate.bots[1].worker = { template: "--x" };
  assert.match(parseBots(JSON.stringify(withTemplate)).warnings.join("\n"), /worker template starts with a dash/);
  withTemplate.bots[1].worker = { template: "dev sol; rm" };
  const odd = parseBots(JSON.stringify(withTemplate));
  assert.equal(odd.file.bots[1].worker, undefined, "not an hc template name: dropped");
  assert.match(odd.warnings.join("\n"), /b-bbbbbbbbbb: worker template "dev sol; rm" isn't an hc template name.*; ignored/);
  // An entry naming it empty removes it.
  assert.equal(applyBotEdit(raw, { ...formEntry, worker: {} }).bots[2].worker, undefined);
  const bad = team();
  bad.bots[1].worker = { model: 5 };
  const parsed = parseBots(JSON.stringify(bad));
  assert.equal(parsed.file.bots[1].worker, undefined);
  assert.ok(parsed.warnings.some((w) => /b-bbbbbbbbbb: worker model not text; ignored/.test(w)));
  assert.deepEqual(checkBots(bad), [], "like a bad model: ignored on reading, never a block on writing");
  bad.bots[1].worker = "codex";
  assert.ok(parseBots(JSON.stringify(bad)).warnings.some((w) => /worker is not an object/.test(w)));
});

test("create and edit --worker-agent/--worker-model/--worker-effort write the field; an empty value clears one", (t) => {
  const s = scene(t);
  const r = s.cli(["edit", "Genie", "--worker-agent", "claude-code", "--worker-model", "opus", "--worker-effort", "high"], { from: null });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.bots().bots[0].worker, { agent: "claude", model: "opus", effort: "high" });
  assert.equal(s.cli(["edit", "Genie", "--worker-model", "not-a-model"], { from: null }).code, 1, "a model off the agent's list");
  assert.equal(s.cli(["edit", "Genie", "--worker-effort", "Very High"], { from: null }).code, 2);
  assert.equal(s.cli(["edit", "Genie", "--worker-model="], { from: null }).code, 0);
  assert.deepEqual(s.bots().bots[0].worker, { agent: "claude", effort: "high" });
  s.cli(["edit", "Genie", "--worker-agent=", "--worker-effort="], { from: null });
  assert.equal(s.bots().bots[0].worker, undefined, "nothing left: removed");
  const c = s.cli(["create", "--name", "Tester", "--agent", "claude", "--worker-agent", "codex", "--worker-model", "gpt-5.5", "--json"], { from: null });
  assert.equal(c.code, 0, c.err);
  assert.deepEqual(c.json().bot.worker, { agent: "codex", model: "gpt-5.5" }, "codex lists no models here: any model is taken");
  assert.equal(s.cli(["edit", "Tester", "--worker-template", "dev-sol"], { from: null }).code, 0);
  assert.deepEqual(s.bots().bots.find((b) => b.name === "Tester").worker, { agent: "codex", model: "gpt-5.5", template: "dev-sol" });
  assert.equal(s.cli(["edit", "Tester", "--worker-template", "-x"], { from: null }).code, 2);
  assert.equal(s.cli(["edit", "Tester", "--worker-template="], { from: null }).code, 0);
  assert.deepEqual(s.bots().bots.find((b) => b.name === "Tester").worker, { agent: "codex", model: "gpt-5.5" });
  // --worker-agy-mode: a chosen Antigravity mode is stored; auto, the default, clears it.
  assert.equal(s.cli(["edit", "Tester", "--worker-agy-mode", "plan"], { from: null }).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Tester").worker.agyMode, "plan");
  const badMode = s.cli(["edit", "Tester", "--worker-agy-mode", "yolo"], { from: null });
  assert.equal(badMode.code, 2);
  assert.match(badMode.err, /--worker-agy-mode: Antigravity mode "yolo" isn't one of accept-edits, auto, plan\./);
  assert.equal(s.cli(["edit", "Tester", "--worker-agy-mode", "auto"], { from: null }).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Tester").worker.agyMode, undefined);
});

// ---- the pure parts ----

test("effortArgs: claude/antigravity --effort, codex -c model_reasoning_effort, pi/omp --thinking; others none", () => {
  assert.deepEqual(effortArgs("claude", "high"), ["--effort", "high"]);
  assert.deepEqual(effortArgs("codex", "low"), ["-c", "model_reasoning_effort=low"]);
  assert.deepEqual(effortArgs("pi", "max"), ["--thinking", "max"]);
  assert.deepEqual(effortArgs("omp", "xhigh"), ["--thinking=xhigh"]);
  assert.deepEqual(effortArgs("antigravity", "xhigh"), ["--effort", "xhigh"]);
  assert.deepEqual(effortArgs("grok", "high"), []);
  assert.deepEqual(effortArgs("gemini", "high"), [], "gemini is retired");
  assert.deepEqual(effortArgs("claude", null), []);
  const plan = workerPlan({ name: "G", agent: "grok", worker: { effort: "high" } });
  assert.equal(plan.effort, null);
  assert.deepEqual(plan.argv, ["grok"]);
  assert.match(plan.warnings[0], /Grok has no effort flag; effort high left out/);
  const agy = workerPlan({ name: "A", agent: "antigravity", worker: { model: "gemini-4-argon-high", effort: "max" } });
  assert.deepEqual(agy.argv, ["agy", "--dangerously-skip-permissions", "--mode", "auto", "--model", "gemini-4-argon-high", "--effort", "max"]);
  assert.equal(agy.agyMode, "auto", "the default mode is always passed");
  assert.deepEqual(agy.warnings, []);
  const chosen = workerPlan({ id: ID.dev, name: "A", agent: "antigravity", worker: { agyMode: "plan" } });
  assert.deepEqual([chosen.agyMode, chosen.argv], ["plan", ["agy", "--dangerously-skip-permissions", "--mode", "plan"]]);
  const unknown = workerPlan({ id: ID.dev, name: "A", agent: "antigravity", worker: { agyMode: "yolo" } });
  assert.equal(unknown.error, 'A\'s workers: Antigravity mode "yolo" isn\'t one of accept-edits, auto, plan. '
    + `Fix it with am edit ${ID.dev} --worker-agy-mode <accept-edits|auto|plan>.`);
  assert.equal(unknown.error.includes("\n"), false, "one clear line");
  // Another agent's worker defaults never add mode words: its argv stays as it was.
  const claude = workerPlan({ id: ID.dev, name: "A", agent: "claude", worker: { agyMode: "plan" } });
  assert.deepEqual([claude.agyMode, claude.argv], [null, ["claude", "--permission-mode", "auto"]]);
  const legacy = workerPlan({ name: "L", agent: "claude" }, { agent: "gemini", effort: "low" });
  assert.equal(legacy.agent, "antigravity", "a typed gemini runs antigravity");
  assert.deepEqual(legacy.argv, ["agy", "--dangerously-skip-permissions", "--mode", "auto", "--effort", "low"]);
  assert.match(workerPlan({ name: "G", agent: "claude" }, { agent: "nope" }).error, /isn't a coding agent/);
  assert.match(workerPlan({ name: "G", agent: "claude" }, { effort: "$(x)" }).error, /isn't an effort level/);
});

test("the per-bot proxy switch defaults off and enables only boolean true on Linux", () => {
  for (const bot of [undefined, {}, { hcProxy: false }, { hcProxy: "true" },
    { hcProxy: 1 }, { AM_HC_PROXY: "1" }]) {
    assert.equal(hcProxyEnabled(bot, "linux"), false);
  }
  assert.equal(hcProxyEnabled({ hcProxy: true }, "linux"), true);
  for (const platform of ["darwin", "win32"]) {
    assert.equal(hcProxyEnabled({ hcProxy: true }, platform), false);
  }
});

test("worker args: the default dsh-tui worker keeps the old argv; only sandbox:true wraps it", () => {
  const args = workerArgs({ botId: ID.dev, branch: "feat/a", cwd: "/p/wt", parent: "t1", agent: "dsh-tui", argv: ["dsh-tui"],
    task: "fix it", path: "/bin" });
  const tail = args.slice(args.indexOf("--") + 1);
  assert.deepEqual(tail, [ENV, `PATH=${GUARD_DIR}:/bin`, "dsh-tui", "--", "fix it"]);
});

test("worker args: a sandboxed dsh-tui worker runs through the per-pane helper", () => {
  const args = workerArgs({ botId: ID.dev, branch: "feat/a", cwd: "/p/wt", parent: "t1", agent: "dsh-tui", argv: ["dsh-tui"],
    task: "fix it", path: "/bin", project: "/p", sandbox: true, stableRoot: "/stable" });
  const tail = args.slice(args.indexOf("--") + 1);
  assert.deepEqual(tail, ["/usr/bin/env", `PATH=${stableGuardDir("/stable")}:/bin`, "/bin/sh", stableRunner("/stable"),
    stableHelper("/stable"), "--bot", ID.dev, "--project", "/p", "--worker", "--", "dsh-tui", "--", "fix it"]);
});

test("workers.js: hc run arguments, slugs, worktree list, base order, ledger rows, session changes", () => {
  assert.deepEqual(workerArgs({ botId: ID.dev, branch: "feat/a", name: "feat-a", cwd: "/p/wt", parent: "t1", model: "opus", effort: null, argv: ["claude", "--model", "opus"], task: "do; rm -rf /" }),
    ["run", "--bg", "--json", "--name", "feat-a", "--cwd", "/p/wt", "--label", `worker.of=${ID.dev}`, "--label", "branch=feat/a",
      "--label", "worker.model=opus", "--parent", "t1", "--", "claude", "--model", "opus", "do; rm -rf /"]);
  assert.equal(branchSlug("Feat/Login Form"), "feat-login-form");
  assert.deepEqual(parseWorktrees("worktree /p\nHEAD 1\nbranch refs/heads/main\n\nworktree /p/w\nHEAD 2\ndetached\n"),
    [{ path: "/p", branch: "main", detached: false, bare: false }, { path: "/p/w", branch: null, detached: true, bare: false }]);
  assert.deepEqual(baseCandidates(null, "origin/dev"), ["origin/dev", "dev", "origin/main", "main", "origin/master", "master"]);
  assert.deepEqual(baseCandidates("v1", "origin/dev"), ["v1"]);
  assert.equal(startRow({ kind: "seat", terminal: "t1", botId: ID.main, at: 0 }).at, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(readLedger('{"a":1}\n{torn\n\n[1]\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  const get = { labels: { "agent.session": "s1" } };
  assert.equal(sessionChange(get, JSON.stringify({ session_id: "s1" })), null, "same session: nothing");
  const s2 = JSON.stringify({ session_id: "s2", transcript_path: "/x.jsonl" });
  assert.deepEqual(sessionChange(get, s2),
    { session: "s2", transcript: "/x.jsonl", fresh: true, label: null }, "no folder rule: no path");
  assert.equal(sessionChange(get, "not json"), null);
  // The transcript label (RFC 0015 delivery 2): set beside a new session, set alone for a known
  // session that lacks it or holds another, never for a path the rule refuses.
  const yes = (path) => path;
  const no = () => null;
  const at = (session, transcript_path) => JSON.stringify({ session_id: session, transcript_path });
  assert.deepEqual(sessionChange({ labels: {} }, at("s1", "/x.jsonl"), yes),
    { session: "s1", transcript: "/x.jsonl", fresh: true, label: "/x.jsonl" });
  assert.deepEqual(sessionChange(get, at("s1", "/x.jsonl"), yes),
    { session: "s1", transcript: "/x.jsonl", fresh: false, label: "/x.jsonl" }, "labelled before");
  const both = { labels: { "agent.session": "s1", "agent.transcript": "/x.jsonl" } };
  assert.equal(sessionChange(both, at("s1", "/x.jsonl"), yes), null, "both labels hold: nothing");
  assert.deepEqual(sessionChange(both, at("s1", "/y.jsonl"), yes).label, "/y.jsonl", "stale");
  assert.equal(sessionChange(get, at("s1", "/x.jsonl"), no), null, "refused, same session");
  assert.deepEqual(sessionChange(get, at("s1", "/l.jsonl"), () => "/real.jsonl").label, "/l.jsonl",
    "the path as given (the textual check on another machine passes it), not the real one");
  assert.equal(sessionChange(get, at("s1", "/x.jsonl"), () => true), null, "only a path accepts");
  assert.deepEqual(sessionChange(both, at("s2", "/z.jsonl"), no),
    { session: "s2", transcript: "/z.jsonl", fresh: true, label: "" }, "a new session drops it");
  assert.deepEqual(sessionChange(get, at("s2", "/z.jsonl"), no).label, null, "none to drop");
  assert.equal(sessionChange(both, JSON.stringify({ session_id: "s2" }), yes).label, "", "no path");
  // The template form: `<template> <task>` after the options, no `--`, the template label, no env and no model labels.
  assert.deepEqual(workerArgs({ botId: ID.dev, branch: "feat/a", name: null, cwd: "/p/wt", parent: "t1", model: null, effort: null,
    argv: null, task: "do it", template: "dev-sol", path: "/x/bin" }),
  ["run", "--bg", "--json", "--cwd", "/p/wt", "--label", `worker.of=${ID.dev}`, "--label", "branch=feat/a",
    "--label", "worker.template=dev-sol", "--parent", "t1", "dev-sol", "do it"]);
  assert.deepEqual(runArgv(workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", argv: ["omp"], task: "t", path: "/a:/b" })),
    ["/usr/bin/env", "PATH=/a:/b", "omp", "t"]);
  // agy takes its first prompt only through -i; a bare trailing task is an error to it. With no permission
  // file named, the launch carries no skip-permissions flag (#955).
  const agyPlan = workerPlan({ name: "A", agent: "antigravity", worker: { model: "gemini-4-argon-high", effort: "high" } });
  assert.deepEqual(workerArgs({ botId: ID.dev, branch: "feat/a", name: "feat-a", cwd: "/p/wt", parent: "t1", agent: agyPlan.agent,
    model: agyPlan.model, effort: agyPlan.effort, agyMode: agyPlan.agyMode, argv: agyPlan.argv, task: "fix the build", path: "/x/bin" }),
  ["run", "--bg", "--json", "--name", "feat-a", "--cwd", "/p/wt", "--label", `worker.of=${ID.dev}`, "--label", "branch=feat/a",
    "--label", "worker.model=gemini-4-argon-high", "--label", "worker.effort=high", "--parent", "t1", "--",
    "/usr/bin/env", `PATH=${KILL_GUARD_DIR}:/x/bin`, "agy", "--mode", "auto", "--model", "gemini-4-argon-high", "--effort", "high", "-i", "fix the build"]);
  // A chosen mode is kept in the label, so Restart --tree runs the worker with the same --mode.
  const plan = workerPlan({ name: "A", agent: "antigravity", worker: { agyMode: "plan" } });
  assert.ok(labelsOf(workerArgs({ botId: ID.dev, branch: "feat/a", cwd: "/p/wt", parent: "t1", agent: plan.agent,
    agyMode: plan.agyMode, argv: plan.argv, task: "t", path: "/x/bin" })).includes("worker.agyMode=plan"));
  assert.ok(!labelsOf(workerArgs({ botId: ID.dev, branch: "feat/a", cwd: "/p/wt", parent: "t1", agent: "antigravity",
    agyMode: "auto", argv: ["agy", "--mode", "auto"], task: "t", path: "/x/bin" })).some((l) => l.startsWith("worker.agyMode=")),
  "the default isn't a label");
  assert.deepEqual(promptArgs("antigravity", "t"), ["-i", "t"]);
  assert.deepEqual(promptArgs("claude", "t"), ["t"]);
  assert.deepEqual(promptArgs(undefined, "t"), ["t"], "no agent named: the bare task, as before");
  assert.deepEqual(TEMPLATES.map((x) => templateAgent(x.command)), ["codex", "claude", null]);
  assert.equal(templateAgent("claude-wrapper --model x"), null, "a word of its own, not a prefix");
  // A template command may be a quoted shell wrapper: look inside sh -c / bash -c (F2).
  assert.equal(templateAgent('sh -c "omp --auto-approve"'), "omp");
  assert.equal(templateAgent("bash -c 'claude --model x'"), "claude");
  assert.equal(templateAgent('/usr/bin/env PATH=/x /bin/sh -c "omp --auto-approve"'), "omp");
  assert.equal(templateAgent('sh -c "claude --model omp-turbo"'), "claude", "the quoted command's own agent");
  // The agent is each simple command's PROGRAM, never a bare agent word in an argument (F2).
  assert.equal(templateAgent('sh -c "claude; omp"'), null, "two programs with two agents: fail closed");
  assert.equal(templateAgent('sh -c "echo omp"'), null, "omp is an argument, not a program");
  assert.equal(templateAgent('sh -c "cd x && omp --auto-approve"'), "omp");
  assert.equal(templateAgent('env A=1 sh -c "exec omp"'), "omp");
  assert.equal(templateAgent("omp | tee log"), "omp");
  assert.equal(startRow({ kind: "worker", terminal: "t9", botId: ID.dev, template: "dev-sol" }).template, "dev-sol");
  assert.match(workerPlan({ name: "G", agent: "claude" }, { template: "x", model: "m" }).error, /--template goes alone, without --model/);
  assert.equal(sessionChange(null, JSON.stringify({ session_id: "s2" })), null);
});

test("the bot briefing says a bot doesn't code: one worker per task, checked, ended with worker kill once merged", async () => {
  const { briefingText, WORKER_LINE, BRIEFING_LIMIT } = await import("../mods/am-sidebar/briefingText.mjs");
  const file = parseBots(JSON.stringify(team())).file;
  const text = briefingText({ self: { ...file.bots[2], instructions: "x".repeat(4000) }, file });
  assert.ok(text.includes(WORKER_LINE));
  assert.match(WORKER_LINE, /am worker/);
  assert.match(WORKER_LINE, /end it with `am worker kill <terminal>` once the task merges/);
  assert.doesNotMatch(WORKER_LINE, /hc kill/, "hc kill is the main bot's only (#955)");
  assert.ok(text.length <= BRIEFING_LIMIT);
});

// ---- review fixes ----

// ---- roles and one writer per worktree ----

/** Puts terminals into the fake hc's state (panes of ranked bots, workers started elsewhere). */
const addTerminals = (s, ...terms) => {
  const st = s.hcState();
  st.terminals.push(...terms);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
};
const worker = (address, cwd, labels) => ({ ...term(address, { cwd }), labels });

test("worker --role: defaults from each rank; a bad --role exits 2; the worker.role label and the ledger role", (t) => {
  const R = { tester: "b-dddddddddd", reviewer: "b-eeeeeeeeee", fixer: "b-ffffffffff", captain: "b-gggggggggg", dev: "b-hhhhhhhhhh" };
  const file = team();
  for (const [rank, id] of Object.entries(R)) file.bots.push(bot(id, "member", { name: `R ${rank}`, rank }));
  const s = scene(t, { file });
  addTerminals(s, ...Object.entries(R).map(([rank, id]) => term(`p-${rank}`, { bot: id, cwd: s.project })));
  const want = { tester: "test", reviewer: "review", fixer: "fix", captain: "dev", dev: "dev" };
  for (const [rank, role] of Object.entries(want)) {
    const r = s.cli(["worker", "go", "--branch", `feat/${rank}`, "--json"], { from: `p-${rank}` });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().role, role, `a ${rank} bot's worker defaults to ${role}`);
    assert.ok(labelsOf(s.runs().at(-1)).includes(`worker.role=${role}`));
    assert.equal(s.ledger().at(-1).role, role);
  }
  const plain = s.cli(["worker", "go", "--branch", "feat/plain"]);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /^t\d+\n {2}role {6}dev\n/, "no rank: dev, shown in the text output");
  // A captain passes --role explicitly.
  const asked = s.cli(["worker", "go", "--branch", "feat/asked", "--role", "test", "--json"], { from: "p-captain" });
  assert.equal(asked.json().role, "test");
  assert.equal(s.hcState().terminals.find((x) => x.address === asked.json().terminal).labels["worker.role"], "test");
  const runs = s.runs().length;
  for (const bad of [["--role", "boss"], ["--role="], ["--role", "reviewer"]]) {
    const r = s.cli(["worker", "go", "--branch", "feat/bad", ...bad]);
    assert.equal(r.code, 2, `${bad.join(" ")}: ${r.err}`);
    assert.match(r.err, /--role is one of dev, test, review, fix/);
  }
  assert.equal(s.runs().length, runs, "nothing started");
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-bad")), false, "refused before any worktree is made");
  // Without --task the branch is in the branch label, and a seat row's role is null.
  assert.ok(labelsOf(s.runs().at(-1)).includes("branch=feat/asked"));
  assert.equal(startRow({ kind: "seat", terminal: "t1", botId: ID.main }).role, null);
});

test("worker: one writer per worktree across bots; reviewers alongside; one bot's reviewers one per branch", async (t) => {
  const s = scene(t);
  assert.equal(s.cli(["worker", "one", "--branch", "feat/login"]).code, 0);
  for (const [from, role] of [["t1", "dev"], ["t4", "dev"], ["t4", "test"], ["t4", "fix"]]) {
    const r = s.cli(["worker", "again", "--branch", "feat/login", "--role", role], { from });
    assert.equal(r.code, 1, `${from} ${role}`);
    assert.match(r.err, /feat-login already has a live writer: t100 \(Dev's dev\)\. One writer per worktree\. /);
    assert.match(r.err, /Check it \(hc read t100\) or end it \(hc kill t100\) before starting another\./);
  }
  assert.equal(s.runs().length, 1);
  // Reviewers start alongside the writer, one per bot per branch.
  const review = s.cli(["worker", "review", "--branch", "feat/login", "--role", "review"], { from: "t4" });
  assert.equal(review.code, 0, review.err);
  const twice = s.cli(["worker", "review", "--branch", "feat/login", "--role", "review"], { from: "t4" });
  assert.equal(twice.code, 1);
  assert.match(twice.err, /Captain already has a live review worker on feat\/login: t101\. Check it \(hc read t101\) or end it \(hc kill t101\)/);
  assert.equal(s.cli(["worker", "review", "--branch", "feat/login", "--role", "review"]).code, 0, "another bot's reviewer");
  assert.equal(s.cli(["worker", "review", "--branch", "feat/other", "--role", "review"], { from: "t4" }).code, 0,
    "the same bot reviews another branch in parallel");
  // The writer ends: reviewers hold nothing, so another bot's writer may start.
  s.finish("t100");
  assert.equal(s.cli(["worker", "fix it", "--branch", "feat/login", "--role", "fix"], { from: "t4" }).code, 0);
  // Two bots' writers at once on one worktree: one starts, the other is refused.
  const wt = join(s.project, ".claude/worktrees/feat-conc");
  git(s.project, "worktree", "add", "-q", "-b", "feat/conc", wt);
  const both = await Promise.all([s.cliAsync(["worker", "c", "--worktree", wt]), s.cliAsync(["worker", "c", "--worktree", wt], { from: "t4" })]);
  assert.deepEqual(both.map((r) => r.code).sort(), [0, 1]);
  assert.equal(s.runs().filter((r) => r[r.indexOf("--cwd") + 1] === wt).length, 1);
});

test("worker: a live worker with no worker.role label holds its worktree as a writer; cwd compared as a real path", (t) => {
  const s = scene(t);
  const wt = join(s.project, ".claude/worktrees/feat-old");
  git(s.project, "worktree", "add", "-q", "-b", "feat/old", wt);
  const link = join(s.root, "old-link");
  symlinkSync(wt, link);
  addTerminals(s,
    worker("t50", link, { "worker.of": ID.cap, task: "feat/old" }), // started before roles, its cwd through a symlink
    worker("t51", wt, {}), // a plain terminal in the worktree: no worker
    worker("far/t9", wt, { "worker.of": ID.cap, task: "feat/old", "worker.role": "dev" })); // another machine: not seen
  const r = s.cli(["worker", "go", "--worktree", wt]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already has a live writer: t50 \(Captain's worker, no role label\)\. One writer per worktree\. Check it \(hc read t50\)/);
  assert.equal(s.cli(["worker", "look", "--worktree", wt, "--role", "review"]).code, 0, "a reviewer may start beside it");
  s.finish("t50");
  const now = s.cli(["worker", "go", "--worktree", wt, "--json"]);
  assert.equal(now.code, 0, now.err);
  assert.equal(now.json().role, "dev");
});

test("worker: the check and the start run under one lock per worktree, named by its real path's hash", async (t) => {
  const { worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  const [a, b] = [join(s.root, "wa"), join(s.root, "wb")];
  mkdirSync(a);
  mkdirSync(b);
  symlinkSync(a, join(s.root, "wa-link"));
  assert.match(worktreeLock("/L", a), /^\/L\/worktree-[0-9a-f]{16}\.lock$/);
  assert.notEqual(worktreeLock("/L", a), worktreeLock("/L", b), "two worktrees, two locks");
  assert.equal(worktreeLock("/L", join(s.root, "wa-link")), worktreeLock("/L", a), "one folder, one lock, by its real path");
  // Held while hc runs: the fake hc wrapper lists the lock folder on every call.
  const lockDir = join(s.app, "automagik-herdr");
  const seen = join(s.root, "locks.txt");
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nls "${lockDir}" >> "${seen}" 2>/dev/null\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  assert.equal(s.cli(["worker", "go", "--branch", "feat/lock"]).code, 0);
  const wt = join(s.project, ".claude/worktrees/feat-lock");
  const listed = readFileSync(seen, "utf8");
  assert.ok(listed.includes(worktreeLock(lockDir, wt).slice(lockDir.length + 1)), listed);
  assert.doesNotMatch(listed, /worker-b-/, "no per-bot lock any more");
});

test("workers.js: workerRole from the rank or --role, writesWorktree, the role label in both hc run forms", () => {
  assert.deepEqual(["tester", "reviewer", "fixer", "captain", "dev", undefined].map((rank) => workerRole({ rank }).role),
    ["test", "review", "fix", "dev", "dev", "dev"]);
  assert.deepEqual(workerRole({ rank: "reviewer" }, "dev"), { role: "dev" });
  assert.match(workerRole({}, "boss").error, /--role is one of dev, test, review, fix, not "boss"/);
  assert.deepEqual([{ "worker.role": "dev" }, { "worker.role": "test" }, { "worker.role": "fix" }, {}, { "worker.role": "review" }]
    .map(writesWorktree), [true, true, true, true, false]);
  assert.deepEqual(labelsOf(workerArgs({ botId: ID.dev, branch: "b", role: "review", cwd: "/w", parent: "t1", argv: ["claude"], task: "t" })),
    [`worker.of=${ID.dev}`, "branch=b", "worker.role=review"]);
  assert.deepEqual(labelsOf(workerArgs({ botId: ID.dev, branch: "b", role: "fix", cwd: "/w", parent: "t1", task: "t", template: "dev-sol" })),
    [`worker.of=${ID.dev}`, "branch=b", "worker.role=fix", "worker.template=dev-sol"]);
  assert.equal(startRow({ kind: "worker", terminal: "t9", botId: ID.dev, role: "test" }).role, "test");
});
test("worker: a model starting with a dash is refused, from --model, --worker-model or bots.json", (t) => {
  const file = team();
  file.bots[2].worker = { agent: "claude", model: "--dangerously-skip-permissions" };
  const s = scene(t, { file });
  const flag = s.cli(["worker", "x", "--branch", "feat/x", "--model=--dangerously-skip-permissions"]);
  assert.equal(flag.code, 2);
  assert.match(flag.err, /starts with a dash/);
  assert.equal(s.cli(["edit", "Genie", "--worker-model=-x"], { from: null }).code, 2);
  // The stored one is invalid: dropped on reading, so the worker runs its agent's default.
  assert.match(parseBots(JSON.stringify(file)).warnings.join("\n"), /worker model starts with a dash/);
  const r = s.cli(["worker", "x", "--branch", "feat/x", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(freshClaude(after(s.runs()[0])), ["claude", "--permission-mode", "auto", "x"]);
});

test("worker: task worktrees are excluded from the main checkout; master is the last base; colliding folders are named", (t) => {
  const s = scene(t, { branch: "master" });
  const r = s.cli(["worker", "x", "--branch", "feat/a", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().base, "master");
  assert.ok(readFileSync(join(s.project, ".git/info/exclude"), "utf8").split("\n").includes("/.claude/worktrees/"));
  const status = git(s.project, "status", "--porcelain", "--untracked-files=all");
  assert.equal(status.split("\n").some((l) => l.includes(".claude/")), false, status);
  const clash = s.cli(["worker", "y", "--branch", "Feat-A"]);
  assert.equal(clash.code, 1);
  assert.match(clash.err, /Branch Feat-A uses the same folder as branch feat\/a/);
});

test("worker: --project must define the calling pane's bot; a missing hook script names the usage link", (t) => {
  const s = scene(t, { briefing: false });
  const other = join(s.root, "plain");
  mkdirSync(other);
  const r = s.cli(["worker", "x", "--branch", "feat/x", "--project", other]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--project .*plain doesn't define bot b-cccccccccc, which t1 plays .*it's defined in .*proj\./);
  assert.equal(s.cli(["worker", "x", "--branch", "feat/x", "--project", s.project, "--agent", "claude"]).code, 0);
  const w = s.cli(["worker", "y", "--branch", "feat/y", "--agent", "claude"]);
  assert.match(w.err, /The feat\/y worker's Claude session won't be linked to usage/);
  assert.doesNotMatch(w.err, /gets no/);
});

// ---- the task contract (Genie R1-17): --task, --lead, <id>-<role>, labels, ledger, planned swaps ----

const R = { reviewer: "b-eeeeeeeeee", fixer: "b-ffffffffff" };
const LEAD = "session-0f1e2d3c-4b5a-4968-8776-655443322110";
/** A scene with a reviewer and a fixer bot, whose panes are p-reviewer and p-fixer. */
function rankedScene(t, file = team()) {
  for (const [rank, id] of Object.entries(R)) file.bots.push(bot(id, "member", { name: `R ${rank}`, rank }));
  const s = scene(t, { file });
  addTerminals(s, ...Object.entries(R).map(([rank, id]) => term(`p-${rank}`, { bot: id, cwd: s.project })));
  return s;
}
/** A worktree on `branch` made the way Genie makes one (`git worktree add -b`), from main. */
const genieWorktree = (s, branch) => {
  const wt = join(s.project, ".claude/worktrees", branch.replace(/\//g, "-"));
  git(s.project, "worktree", "add", "-q", "-b", branch, wt);
  return wt;
};

test("worker --task: Genie's short id only; t_ ids get the exact message; bad shapes exit 2; nothing starts", (t) => {
  const s = scene(t);
  const tid = s.cli(["worker", "go", "--branch", "fix/t_9-x", "--task", "t_9f3a"]);
  assert.equal(tid.code, 2);
  assert.equal(tid.err, "am: internal Genie id; pass the short id gn-N, gh-N or gl-N\n");
  for (const bad of ["GL-231", "-gl-1", "gl_231", "gl.231", "", `g${"1".repeat(41)}`, "gl 231"]) {
    const r = s.cli(["worker", "go", "--branch", `fix/x-${bad}`, `--task=${bad}`]);
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.err}`);
    assert.match(r.err, /--task/);
  }
  assert.equal(s.cli(["worker", "go", "--branch", `fix/${"a".repeat(25)}`, "--task", "a".repeat(25), "--json"]).code, 0,
    "a 25-character id fits hc's names as <id>-dev");
  assert.equal(s.runs().length, 1);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/fix-t_9-x")), false, "refused before any worktree is made");
});

test("worker --task --branch: the branch must contain the id; --worktree is Genie's flow, with no branch check", (t) => {
  const s = scene(t);
  const off = s.cli(["worker", "go", "--branch", "feat/login", "--task", "gl-231"]);
  assert.equal(off.code, 2);
  assert.match(off.err, /--branch feat\/login doesn't contain the task id gl-231/);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-login")), false);
  // The id as a whole token: gl-23 is not in fix/gl-231-login, nor gl-231 in xgl-231.
  for (const [branch, id] of [["fix/gl-231-login", "gl-23"], ["fix/xgl-231", "gl-231"], ["fix/gl-231a", "gl-231"]]) {
    const r = s.cli(["worker", "go", "--branch", branch, "--task", id]);
    assert.equal(r.code, 2, `${branch} ${id}: ${r.err}`);
    assert.match(r.err, /doesn't contain the task id/);
  }
  assert.deepEqual(["gl-231", "fix/gl-231", "gl-231/x", "a_gl-231_b", "fix/gl-231-login", "x-gl-231"].map((b) => branchNamesTask(b, "gl-231")),
    [true, true, true, true, true, true]);
  assert.deepEqual(["fix/gl-2310", "fix/agl-231", "fix/gl-231.x", "fix/gl-23"].map((b) => branchNamesTask(b, "gl-231")),
    [false, false, false, false]);
  const on = s.cli(["worker", "go", "--branch", "fix/gl-231-login", "--task", "gl-231", "--json"]);
  assert.equal(on.code, 0, on.err);
  assert.equal(on.json().branch, "fix/gl-231-login");
  const wt = genieWorktree(s, "feat/anything");
  const genie = s.cli(["worker", "go", "--worktree", wt, "--task", "gh-1415", "--json"]);
  assert.equal(genie.code, 0, genie.err);
  assert.equal(genie.json().task, "gh-1415");
});

test("worker --lead: defaults to the calling bot; a bot id or a Genie session; reviewers and fixers must pass it", (t) => {
  const s = rankedScene(t);
  const own = s.cli(["worker", "go", "--branch", "fix/gl-1-a", "--task", "gl-1", "--json"]);
  assert.equal(own.code, 0, own.err);
  assert.equal(own.json().lead, ID.dev);
  assert.ok(labelsOf(s.runs().at(-1)).includes(`task.lead=${ID.dev}`));
  assert.equal(s.ledger().at(-1).lead, ID.dev);
  const session = s.cli(["worker", "go", "--branch", "fix/gl-2-a", "--task", "gl-2", "--lead", LEAD]);
  assert.equal(session.code, 0, session.err);
  assert.ok(labelsOf(s.runs().at(-1)).includes(`task.lead=${LEAD}`));
  const runs = s.runs().length;
  for (const bad of ["Dev", "b-AAAAAAAAAA", "b-abc", "session-xyz", "t_1"]) {
    const r = s.cli(["worker", "go", "--branch", "fix/gl-3-a", "--task", "gl-3", "--lead", bad]);
    assert.equal(r.code, 2, `${bad}: ${r.err}`);
    assert.match(r.err, /--lead: .* isn't a bot id \(b- plus 10 base32 characters\) or a Genie session \(session-<uuid>\)/);
  }
  for (const rank of ["reviewer", "fixer"]) {
    const r = s.cli(["worker", "go", "--branch", `fix/gl-4-${rank}`, "--task", "gl-4"], { from: `p-${rank}` });
    assert.equal(r.code, 2, `${rank}: ${r.err}`);
    assert.equal(r.err, "am: pass --lead <the task's lead bot>\n");
  }
  assert.equal(s.runs().length, runs, "nothing started");
  const review = s.cli(["worker", "go", "--branch", "fix/gl-4-a", "--task", "gl-4", "--lead", ID.cap, "--json"], { from: "p-reviewer" });
  assert.equal(review.code, 0, review.err);
  assert.equal(review.json().lead, ID.cap);
  assert.equal(review.json().role, "review");
  assert.equal(s.cli(["worker", "go", "--branch", "feat/no-task"], { from: "p-fixer" }).code, 0, "no --task: no lead needed");
});

test("worker --task: named exactly <id>-<role>; a live holder of the name is refused and named, never suffixed", (t) => {
  const s = rankedScene(t);
  const dev = s.cli(["worker", "go", "--branch", "fix/gl-231-login", "--task", "gl-231"]);
  assert.equal(dev.code, 0, dev.err);
  assert.equal(s.runs().at(-1)[s.runs().at(-1).indexOf("--name") + 1], "gl-231-dev");
  assert.match(dev.out, /^t100\n {2}role {6}dev\n {2}task {6}gl-231 \(lead b-cccccccccc\)\n/);
  const review = s.cli(["worker", "look", "--branch", "fix/gl-231-login", "--task", "gl-231", "--lead", ID.dev], { from: "p-reviewer" });
  assert.equal(review.code, 0, review.err);
  assert.equal(s.runs().at(-1)[s.runs().at(-1).indexOf("--name") + 1], "gl-231-review");
  // The same task and role in another worktree: the name is taken by a live terminal.
  const twin = s.cli(["worker", "go", "--branch", "fix/gl-231-again", "--task", "gl-231"], { from: "t4" });
  assert.equal(twin.code, 1);
  assert.match(twin.err, /gl-231-dev is taken by a live terminal: t100\. A task's worker is named exactly <id>-<role>, never suffixed\./);
  assert.equal(s.runs().length, 2);
  assert.equal(s.runs().some((r) => /^gl-231-dev-/.test(r[r.indexOf("--name") + 1])), false);
  s.finish("t100");
  // Another machine's gl-231-dev is its own core's name: it doesn't block one here.
  addTerminals(s, worker("box/t7", "/srv/proj", { "worker.of": ID.cap, task: "gl-231", "worker.role": "dev" }));
  const st = s.hcState();
  st.terminals.find((x) => x.address === "box/t7").name = "gl-231-dev";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const again = s.cli(["worker", "go", "--branch", "fix/gl-231-again", "--task", "gl-231"], { from: "t4" });
  assert.equal(again.code, 0, again.err);
  assert.equal(s.runs().at(-1)[s.runs().at(-1).indexOf("--name") + 1], "gl-231-dev", "a finished holder frees the name");
  assert.doesNotMatch(again.err, /box\/t7/, "a remote terminal is never named as the holder");
  const named = s.cli(["worker", "go", "--branch", "fix/gl-5-a", "--task", "gl-5", "--name", "mine"]);
  assert.equal(named.code, 2);
  assert.match(named.err, /--name goes without --task: a task's worker is named gl-5-<role>/);
  const long = s.cli(["worker", "go", "--branch", `fix/${"a".repeat(26)}`, "--task", "a".repeat(26), "--role", "review"]);
  assert.equal(long.code, 2);
  assert.match(long.err, /is longer than hc's 32-character terminal names/);
  // Without --task the name is the branch slug, as before.
  assert.equal(s.cli(["worker", "go", "--branch", "feat/plain"]).code, 0);
  assert.equal(s.runs().at(-1)[s.runs().at(-1).indexOf("--name") + 1], "feat-plain");
});

test("worker --task: task, task.project, task.lead and branch labels beside worker.of, role, model and effort", (t) => {
  const s = scene(t);
  const r = s.cli(["worker", "go", "--branch", "fix/gl-231-login", "--task", "gl-231"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(labelsOf(s.runs().at(-1)), [`worker.of=${ID.dev}`, "task=gl-231", `task.project=${s.project}`,
    `task.lead=${ID.dev}`, "branch=fix/gl-231-login", "worker.role=dev", "worker.model=gpt-5.5", "worker.effort=medium"]);
  const tpl = s.cli(["worker", "go", "--branch", "fix/gl-232-x", "--task", "gl-232", "--template", "dev-sol"]);
  assert.equal(tpl.code, 0, tpl.err);
  assert.deepEqual(labelsOf(s.runs().at(-1)), [`worker.of=${ID.dev}`, "task=gl-232", `task.project=${s.project}`,
    `task.lead=${ID.dev}`, "branch=fix/gl-232-x", "worker.role=dev", "worker.template=dev-sol"]);
  assert.deepEqual(labelsOf(workerArgs({ botId: ID.dev, branch: "b", role: "dev", cwd: "/w", parent: "t1", argv: ["claude"], task: "t" })),
    [`worker.of=${ID.dev}`, "branch=b", "worker.role=dev"], "no task id: no task, task.project or task.lead label");
});

test("worker: a worker started before the task contract (task=<branch>, no branch label) is read by its task label", (t) => {
  const s = scene(t);
  const wt = genieWorktree(s, "feat/old");
  addTerminals(s, worker("t60", wt, { "worker.of": ID.cap, task: "feat/old", "worker.role": "review" }));
  const twice = s.cli(["worker", "look", "--worktree", wt, "--role", "review"], { from: "t4" });
  assert.equal(twice.code, 1, "the old reviewer's task label is its branch");
  assert.match(twice.err, /Captain already has a live review worker on feat\/old: t60/);
  const wt2 = genieWorktree(s, "fix/gl-9-x");
  addTerminals(s, worker("t61", wt2, { "worker.of": ID.cap, task: "gl-9", branch: "fix/gl-9-x", "worker.role": "review" }));
  const now = s.cli(["worker", "look", "--worktree", wt2, "--role", "review"], { from: "t4" });
  assert.equal(now.code, 1, "a new reviewer's branch label");
  assert.match(now.err, /on fix\/gl-9-x: t61/);
  assert.deepEqual([workerBranch({ task: "feat/old" }), workerTaskId({ task: "feat/old" })], ["feat/old", null]);
  assert.deepEqual([workerBranch({ task: "gl-9", branch: "fix/gl-9-x" }), workerTaskId({ task: "gl-9", branch: "fix/gl-9-x" })],
    ["fix/gl-9-x", "gl-9"]);
  assert.deepEqual([workerBranch({ branch: "feat/x" }), workerTaskId({ branch: "feat/x" }), workerBranch({})], ["feat/x", null, null]);
});

test("worker --task: the ledger row's task, project, lead, worktree, base, created, swap and override", (t) => {
  const s = scene(t);
  const wt = genieWorktree(s, "fix/gl-231-login");
  const base = git(s.project, "rev-parse", "main").trim();
  git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  const link = join(s.root, "wt-link");
  symlinkSync(wt, link);
  const r = s.cli(["worker", "go", "--worktree", link, "--task", "gl-231", "--lead", ID.cap]);
  assert.equal(r.code, 0, r.err);
  const row = s.ledger().at(-1);
  assert.deepEqual({ ...row, at: undefined, pid: undefined }, { event: "start", kind: "worker", terminal: "t100", pid: undefined,
    botId: ID.dev, task: "gl-231", worktree: realpathSync(wt), agent: "codex", model: "gpt-5.5", effort: "medium", template: null,
    role: "dev", branch: "fix/gl-231-login", project: s.project, lead: ID.cap, base, created: false, swap: false, override: false,
    override_requested: null, core: "fakecore0000", created_ms: s.hcState().terminals.find((x) => x.address === "t100").created_ms, squad: ID.dev, session: null, at: undefined });
  assert.notEqual(row.base, git(wt, "rev-parse", "HEAD").trim(), "the base the worktree started from, not its head");
  // --branch making the worktree: created, and the base ref as a SHA; a per-task model is an override.
  git(s.project, "commit", "-q", "--allow-empty", "-m", "later");
  const made = s.cli(["worker", "go", "--branch", "fix/gl-232-x", "--task", "gl-232", "--model", "gpt-5.4"]);
  assert.equal(made.code, 0, made.err);
  const mrow = s.ledger().at(-1);
  assert.deepEqual([mrow.task, mrow.created, mrow.base, mrow.override, mrow.swap, mrow.model],
    ["gl-232", true, git(s.project, "rev-parse", "main").trim(), true, false, "gpt-5.4"]);
  // A seat row: task null, its project key kept, the worker fields empty.
  const seat = startRow({ kind: "seat", terminal: "t1", botId: ID.main, worktree: "/p", project: "/p" });
  assert.deepEqual([seat.task, seat.branch, seat.project, seat.lead, seat.base, seat.created, seat.swap, seat.override,
    seat.override_requested], [null, null, "/p", null, null, false, false, false, null]);
});

test("planned swaps: the rule is sha256(bot:project:task)[0] % 3, deterministic, about one task in three", async () => {
  const { swapTask } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const { createHash } = await import("node:crypto");
  const ids = Array.from({ length: 300 }, (_, i) => `gn-${i + 1}`);
  const swapped = ids.filter((id) => swapTask(ID.dev, "/p", id)).length;
  assert.ok(swapped >= 80 && swapped <= 120, `about 1/3 of 300 (86/256 of bytes): ${swapped}`);
  for (const id of ids.slice(0, 20)) {
    assert.equal(swapTask(ID.dev, "/p", id), swapTask(ID.dev, "/p", id), "the same answer every time");
    assert.equal(swapTask(ID.dev, "/p", id), createHash("sha256").update(`${ID.dev}:/p:${id}`).digest()[0] % 3 === 0);
  }
  assert.ok(ids.some((id) => swapTask(ID.dev, "/p", id) !== swapTask(ID.cap, "/p", id)), "per bot");
  assert.ok(ids.some((id) => swapTask(ID.dev, "/p", id) !== swapTask(ID.dev, "/q", id)), "per project");
  assert.deepEqual([0, 3, 255, 1, 2, 254].map(swapByte), [true, true, true, false, false, false]);
  assert.deepEqual(swapArm({ worker: { model: "m", swap: { effort: "low", model: "", template: "x" } } }), { effort: "low" });
  assert.equal(swapArm({ worker: { model: "m" } }), null);
  assert.equal(runsTemplate({ worker: { template: "dev-sol" } }, {}), true);
  assert.equal(runsTemplate({ worker: { template: "dev-sol" } }, { model: "m" }), false);
  assert.equal(runsTemplate({ worker: {} }, { template: "x" }), true);
});

test("planned swaps: a swap task runs worker.swap; the bot's own --model/--effort are recorded, not used", async (t) => {
  const { swapTask } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const file = team();
  file.bots[2].worker.swap = { effort: "xhigh", model: "gpt-5.4" };
  const s = scene(t, { file });
  const ids = Array.from({ length: 60 }, (_, i) => `gl-${i + 1}`);
  const on = ids.find((id) => swapTask(ID.dev, s.project, id));
  const off = ids.find((id) => !swapTask(ID.dev, s.project, id));
  const swapRun = s.cli(["worker", "go", "--branch", `fix/${on}-a`, "--task", on, "--json"]);
  assert.equal(swapRun.code, 0, swapRun.err);
  assert.deepEqual([swapRun.json().model, swapRun.json().effort, swapRun.json().swap], ["gpt-5.4", "xhigh", true]);
  assert.ok(labelsOf(s.runs().at(-1)).includes("worker.effort=xhigh"));
  assert.deepEqual([s.ledger().at(-1).swap, s.ledger().at(-1).override, s.ledger().at(-1).override_requested], [true, false, null]);
  // The same bot and task again (another role): the same arm.
  const again = s.cli(["worker", "look", "--branch", `fix/${on}-a`, "--task", on, "--role", "review", "--model", "gpt-5.5",
    "--effort", "low", "--json"]);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual([again.json().model, again.json().effort, again.json().swap], ["gpt-5.4", "xhigh", true], "the rule wins");
  assert.deepEqual(s.ledger().at(-1).override_requested, { model: "gpt-5.5", effort: "low" });
  assert.equal(s.ledger().at(-1).override, false);
  const warned = again.err.split("\n").filter((l) => /planned swap tasks/.test(l));
  assert.equal(warned.length, 1, again.err);
  assert.match(warned[0], new RegExp(`${on} is one of Dev's planned swap tasks, so it runs model gpt-5.4 · effort xhigh; `
    + "--model gpt-5.5, --effort low recorded, not used\\."));
  // Off a swap task: the bot's defaults, and a per-task pick is an override.
  const plain = s.cli(["worker", "go", "--branch", `fix/${off}-a`, "--task", off, "--effort", "low", "--json"]);
  assert.equal(plain.code, 0, plain.err);
  assert.deepEqual([plain.json().model, plain.json().effort, plain.json().swap, plain.json().override], ["gpt-5.5", "low", false, true]);
  assert.equal(s.ledger().at(-1).override_requested, null);
  // No --task: never a swap.
  const none = s.cli(["worker", "go", "--branch", "feat/none", "--json"]);
  assert.deepEqual([none.json().effort, none.json().swap, none.json().override], ["medium", false, false]);
  assert.match(s.cli(["show", "Dev"]).out, /worker {7}agent codex · model gpt-5\.5 · effort medium\n {2}swap {9}model gpt-5\.4 · effort xhigh/);
  assert.deepEqual(s.cli(["show", "Dev", "--json"]).json().worker.swap, { effort: "xhigh", model: "gpt-5.4" });
});

test("planned swaps: an unknown swap agent is named only on a swap task, and the rest of the arm runs", async (t) => {
  const { swapTask } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const file = team();
  file.bots[2].worker.swap = { agent: "nosuch", effort: "xhigh" };
  const s = scene(t, { file });
  const ids = Array.from({ length: 60 }, (_, i) => `gl-${i + 1}`);
  const on = ids.find((id) => swapTask(ID.dev, s.project, id));
  const off = ids.find((id) => !swapTask(ID.dev, s.project, id));
  const plain = s.cli(["worker", "go", "--branch", `fix/${off}-a`, "--task", off, "--json"]);
  assert.equal(plain.code, 0, plain.err);
  assert.doesNotMatch(plain.err, /swap agent/, "off a swap task: no word about the swap");
  const swapped = s.cli(["worker", "go", "--branch", `fix/${on}-a`, "--task", on, "--json"]);
  assert.equal(swapped.code, 0, swapped.err);
  assert.match(swapped.err, /Dev's worker swap agent "nosuch" isn't one Herdr knows; this swap task runs without it\./);
  assert.deepEqual([swapped.json().agent, swapped.json().effort, swapped.json().swap], ["codex", "xhigh", true]);
});

test("planned swaps: a template worker never swaps, from a bots.json template or a per-task --template", async (t) => {
  const { swapTask } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const file = team();
  file.bots[2].worker = { template: "dev-sol", swap: { effort: "low" } };
  const s = scene(t, { file });
  const on = Array.from({ length: 60 }, (_, i) => `gl-${i + 1}`).find((id) => swapTask(ID.dev, s.project, id));
  const tpl = s.cli(["worker", "go", "--branch", `fix/${on}-a`, "--task", on, "--json"]);
  assert.equal(tpl.code, 0, tpl.err);
  assert.deepEqual([tpl.json().template, tpl.json().swap], ["dev-sol", false]);
  assert.equal(s.ledger().at(-1).swap, false);
  const given = s.cli(["worker", "go", "--branch", `fix/${on}-b`, "--task", on, "--role", "test", "--template", "opus-rev", "--json"]);
  assert.equal(given.code, 0, given.err);
  assert.deepEqual([given.json().template, given.json().swap, given.json().override], ["opus-rev", false, true]);
});

test("bots.json worker.swap: validated like the worker's agent, model and effort; a bad one drops the worker field", () => {
  const ok = team();
  ok.bots[2].worker.swap = { agent: "claude", model: "claude-opus-5-5", effort: "high" };
  const good = parseBots(JSON.stringify(ok));
  assert.deepEqual(good.warnings, []);
  assert.deepEqual(good.file.bots[2].worker.swap, { agent: "claude", model: "claude-opus-5-5", effort: "high" });
  const cases = [
    [[], /worker swap is not an object/],
    [{}, /worker swap names no agent, model or effort/],
    [{ model: 5 }, /worker swap model not text/],
    [{ agent: " " }, /worker swap agent not text/],
    [{ model: "--yolo" }, /worker swap model starts with a dash/],
    [{ effort: "Very High" }, /worker swap effort "Very High" isn't an effort level/],
    [{ template: "dev-sol" }, /worker swap takes only agent, model and effort, not template/],
  ];
  for (const [swap, why] of cases) {
    const f = team();
    f.bots[2].worker.swap = swap;
    assert.equal(swapProblem(swap) === null, false, JSON.stringify(swap));
    const parsed = parseBots(JSON.stringify(f));
    assert.equal(parsed.file.bots[2].worker, undefined, JSON.stringify(swap));
    assert.match(parsed.warnings.join("\n"), why);
  }
  assert.equal(swapProblem(undefined), null);
});

test("worker lock: named by realpathSync.native, so a folder's case can't split it", async (t) => {
  const { worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const root = scratchRoot(t, "hb-case-");
  mkdirSync(join(root, "Task-Tree"));
  const lock = (p) => worktreeLock("/L", p);
  assert.equal(lock(join(root, "Task-Tree")), `/L/worktree-${createHashOf(realpathSync.native(join(root, "Task-Tree")))}.lock`);
  if (!existsSync(join(root, "task-tree"))) return t.skip("a case-sensitive file system: one spelling, one folder");
  assert.equal(lock(join(root, "task-tree")), lock(join(root, "Task-Tree")), "two spellings of one folder, one lock");
  assert.equal(lock(join(root, "TASK-TREE")), lock(join(root, "Task-Tree")));
});

// ---- the calling bot's project: the one whose bots file defines it ----

/** A second git project beside the scene's, with its own bots file. */
function otherProject(s, name, file) {
  return scratchProject(s.root, name, { branch: "main", commit: true, bots: file });
}
/** Moves a scene terminal: its foreground now works in `cwd` (its launch cwd stays). */
function moveForeground(s, address, cwd, labels = {}) {
  const st = s.hcState();
  const t = st.terminals.find((x) => x.address === address);
  t.foreground.cwd = cwd;
  Object.assign(t.labels, labels);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
}
/** Ties a scene terminal to a bot in the attach ledger, as attach writes it (#57's row shape). */
function bindIn(s, terminal, botId, project) {
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const row = { v: 1, event: "attach", bot: botId, project, terminal, core: "fakecore0000", created_ms: 1,
    machine: null, at: new Date().toISOString(), by: "attach" };
  appendFileSync(join(s.app, "automagik-herdr/attach.jsonl"), `${JSON.stringify(row)}\n`, { mode: LEDGER_MODE });
}
const withoutDev = () => team({ bots: team().bots.filter((b) => b.id !== ID.dev) });
const devOnly = () => team({ bots: team().bots.filter((b) => b.id === ID.dev) });

test("worker: a pane launched in A that works in B, whose bots file alone defines it, starts in B; --project A is refused", (t) => {
  const s = scene(t, { file: withoutDev() }); // A: s.project, launch cwd of t1, no Dev
  const b = otherProject(s, "b", devOnly());
  moveForeground(s, "t1", b);
  const r = s.cli(["worker", "fix it", "--branch", "feat/x", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().worktree, join(b, ".claude/worktrees/feat-x"));
  const cwd = s.runs()[0][s.runs()[0].indexOf("--cwd") + 1];
  assert.equal(cwd, join(b, ".claude/worktrees/feat-x"), "hc run starts the worker in B's worktree");
  assert.equal(existsSync(join(s.project, ".claude/worktrees")), false, "nothing made in A");
  const named = s.cli(["worker", "y", "--branch", "feat/y", "--project", b]);
  assert.equal(named.code, 0, named.err);
  const wrong = s.cli(["worker", "z", "--branch", "feat/z", "--project", s.project]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, new RegExp(`--project ${s.project} doesn't define bot ${ID.dev}, which t1 plays .*it's defined in ${b}\\.`));
  assert.equal(s.runs().length, 2, "the refused call ran nothing");
});

test("worker: the pane's Herdr space names its project when the agent's folder doesn't", (t) => {
  const s = scene(t, { file: withoutDev() });
  const b = otherProject(s, "b", devOnly());
  // t1 works outside any project; t2, in its space, works in B.
  moveForeground(s, "t1", s.root, { "herdr.space": "w9" });
  bindIn(s, "t1", ID.dev, s.project); // bound in A, which no longer defines Dev
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t2"), { cwd: b, labels: { "herdr.space": "w9" } });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["worker", "fix it", "--branch", "feat/x", "--json"], { cwd: s.root });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().worktree, join(b, ".claude/worktrees/feat-x"));
});

test("worker: two fallback projects defining the calling bot are refused with both listed; --project picks one", (t) => {
  const s = scene(t); // A defines Dev
  const b = otherProject(s, "b", devOnly()); // so does B
  moveForeground(s, "t1", b);
  bindIn(s, "t1", ID.dev, join(s.root, "old")); // bound in a project that no longer defines Dev
  const r = s.cli(["worker", "fix it", "--branch", "feat/x"]);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`t1 plays bot ${ID.dev}, which 2 projects define: ${b}, ${s.project}\\. Pick its project with --project`));
  assert.equal(s.runs().length, 0);
  assert.equal(existsSync(join(s.project, ".claude/worktrees")) || existsSync(join(b, ".claude/worktrees")), false, "no worktree made");
  const picked = s.cli(["worker", "fix it", "--branch", "feat/x", "--project", s.project, "--json"]);
  assert.equal(picked.code, 0, picked.err);
  assert.equal(picked.json().worktree, join(s.project, ".claude/worktrees/feat-x"));
});

test("worker: the attach binding's project wins when it defines the bot, even with another project defining it", (t) => {
  const s = scene(t); // A defines Dev
  const b = otherProject(s, "b", devOnly()); // so does B, where t1 now works
  moveForeground(s, "t1", b);
  bindIn(s, "t1", ID.dev, s.project);
  const r = s.cli(["worker", "fix it", "--branch", "feat/x", "--json"], { cwd: b });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().worktree, join(s.project, ".claude/worktrees/feat-x"));
  const named = s.cli(["worker", "y", "--branch", "feat/y", "--project", b, "--json"], { cwd: b });
  assert.equal(named.code, 0, named.err);
  assert.equal(named.json().worktree, join(b, ".claude/worktrees/feat-y"), "--project wins when it defines the bot");
});

test("worker: a pre-ledger pane (bot= label only) working outside its project is told to attach; then it starts", (t) => {
  const s = scene(t);
  // t1: Dev's label, launched and working outside the project, a codex pane; no attach.jsonl yet.
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t1"), { cwd: s.root, foreground: { argv: ["codex"], cwd: s.root, pid: 4000 },
    status: { app: "codex", state: "idle" } });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["worker", "fix it", "--branch", "feat/x"], { cwd: s.root });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`t1 isn't a bot's pane \\(the attach ledger ties no bot to it\\)\\. Its bot=${ID.dev} label is from before `
    + `the ledger.*Tie it: am attach ${ID.dev} t1 --project <its project>\\..*am start ${ID.dev} --project`));
  assert.equal(s.runs().length, 0);
  // The one-time import ran (and found nothing); the advice works.
  assert.equal(s.cli(["attach", ID.dev, "t1", "--project", s.project], { from: null, cwd: s.root }).code, 0);
  const w = s.cli(["worker", "fix it", "--branch", "feat/x", "--json"], { cwd: s.root });
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json().worktree, join(s.project, ".claude/worktrees/feat-x"));
});

test("worker: a pre-ledger pane's first run with --project imports its label there; a Claude pane outside is refused attach", (t) => {
  const s = scene(t);
  moveForeground(s, "t1", s.root);
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t1").cwd = s.root;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  // No attach.jsonl yet: the one-time import looks in --project too, so the label is tied there.
  const w = s.cli(["worker", "fix it", "--branch", "feat/x", "--project", s.project, "--json"], { cwd: s.root });
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json().worktree, join(s.project, ".claude/worktrees/feat-x"));
  const rows = readFileSync(join(s.app, "automagik-herdr/attach.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.filter((r) => r.terminal === "t1").map((r) => [r.bot, r.project, r.by]), [[ID.dev, s.project, "import"]]);
  // A Claude session outside the project can't be attached (attachRefusal): start is the way.
  const attach = s.cli(["attach", ID.dev, "t1", "--project", s.project], { from: null, cwd: s.root });
  assert.equal(attach.code, 1);
  assert.match(attach.err, /Not attached: this Claude session runs in/);
});

// ---- #225: the bots file's warnings, the lock kept fresh, the check before the worktree ----

test("worker #225: the calling bot's bots.json warnings go to stderr at once, refused or not; other bots' stay out", (t) => {
  const file = team();
  file.bots[2].worker = { agent: "codex", model: "-x" }; // Dev, the bot t1 plays: its worker field is dropped
  file.bots[1].rank = "boss"; // Captain: another bot's warning
  const s = scene(t, { file });
  const said = "b-cccccccccc: worker model starts with a dash (an agent would read it as an option); ignored";
  const mine = new RegExp(`am: ${said.replace(/[()]/g, "\\$&")}\n`);
  const r = s.cli(["worker", "x", "--branch", "feat/x", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, mine);
  assert.doesNotMatch(r.err, /b-bbbbbbbbbb/, "only the calling bot's warnings");
  assert.ok(r.json().warnings.includes(said), r.out);
  assert.deepEqual(freshClaude(after(s.runs()[0])), ["claude", "--permission-mode", "auto", "x"], "the defaults are dropped, as before");
  // Printed once, and before a refusal too.
  assert.equal(r.err.split("worker model starts with a dash").length, 2);
  // Refused once the bot is known (the main checkout is no task worktree): the warning comes first.
  const refused = s.cli(["worker", "y", "--worktree", s.project]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`^${mine.source}am: ${s.project}.* is the project's main checkout`));
  // Captain (t4) is told about its own rank, not Dev's worker field.
  const cap = s.cli(["worker", "z", "--branch", "feat/z", "--role", "review"], { from: "t4" });
  assert.equal(cap.code, 0, cap.err);
  assert.match(cap.err, /b-bbbbbbbbbb: unknown rank "boss"; ignored/);
  assert.doesNotMatch(cap.err, /b-cccccccccc/);
});

test("worker #225: hc ls failing refuses (fail closed) before any worktree, hook or hc run", (t) => {
  const s = scene(t);
  // The first call writes the attach ledger, so only the worker's own check reads hc ls after it.
  assert.equal(s.cli(["worker", "one", "--branch", "feat/one"]).code, 0);
  const wt = join(s.project, ".claude/worktrees/feat-two");
  git(s.project, "worktree", "add", "-q", "-b", "feat/two", wt);
  const st = s.hcState();
  st.fail = ["ls"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const before = s.runs().length;
  const fresh = s.cli(["worker", "new", "--branch", "feat/new"]);
  assert.equal(fresh.code, 1);
  assert.match(fresh.err, /hc ls failed: hc: can't reach the server \(ls\)/);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/feat-new")), false, "no worktree made");
  assert.equal(git(s.project, "branch", "--list", "feat/new"), "", "no branch made");
  const given = s.cli(["worker", "go", "--worktree", wt]);
  assert.equal(given.code, 1);
  assert.match(given.err, /hc ls failed/);
  assert.equal(existsSync(join(wt, ".claude/settings.local.json")), false, "no hook written");
  assert.equal(s.runs().length, before, "nothing started");
});

test("worker #225: a refused task name leaves no new worktree or hook behind", (t) => {
  const s = scene(t);
  addTerminals(s, worker("t60", s.root, {}));
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t60").name = "gl-231-dev";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["worker", "go", "--task", "gl-231", "--branch", "fix/gl-231-login"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /gl-231-dev is taken by a live terminal: t60/);
  assert.equal(existsSync(join(s.project, ".claude/worktrees/fix-gl-231-login")), false);
  assert.equal(git(s.project, "branch", "--list", "fix/gl-231-login"), "");
  assert.equal(s.runs().length, 0);
});

test("worker #225: the worktree lock stays fresh while held across slow hc calls: one writer starts, never two", async (t) => {
  const s = scene(t);
  assert.equal(s.cli(["worker", "warm", "--branch", "feat/warm"]).code, 0, "the attach ledger written first");
  const wt = join(s.project, ".claude/worktrees/feat-slow");
  git(s.project, "worktree", "add", "-q", "-b", "feat/slow", wt);
  // hc run answers (and its worker shows in hc ls) after 1 s, past a 400 ms stale limit: a lock
  // not kept fresh is taken over by the waiting call, whose check finds no writer yet.
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nif [ "$1" = run ]; then sleep 1; fi\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const env = { AUTOMAGIK_HERDR_LOCK_STALE_MS: "400" };
  const both = await Promise.all([s.cliAsync(["worker", "a", "--worktree", wt], { env }), s.cliAsync(["worker", "b", "--worktree", wt], { from: "t4", env })]);
  assert.equal(s.runs().filter((r) => r[r.indexOf("--cwd") + 1] === wt).length, 1, both.map((r) => r.err).join("\n"));
  assert.deepEqual(both.map((r) => r.code).sort(), [0, 1]);
  // The second call waited for the lock, then was refused by the check, not by the lock.
  assert.match(both.find((r) => r.code === 1).err, /already has a live writer/);
});

const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("worker #536: a wait for the worktree lock past 3 s is said once on stderr, with the lock and its holder", async (t) => {
  const { worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  const wt = join(s.project, ".claude/worktrees/feat-wait");
  git(s.project, "worktree", "add", "-q", "-b", "feat/wait", wt);
  const lockDir = join(s.app, "automagik-herdr");
  mkdirSync(lockDir, { recursive: true });
  // Held by this test's process (fresh: under the 10 s stale limit), let go after 4.5 s.
  const lock = worktreeLock(lockDir, wt);
  writeFileSync(lock, `${process.pid} held-by-the-test`);
  const call = s.cliAsync(["worker", "go", "--worktree", wt]);
  const free = setTimeout(() => rmSync(lock, { force: true }), 4500);
  t.after(() => clearTimeout(free));
  const r = await call;
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`^am: waiting for the worker lock on ${reEsc(wt)} \\(${reEsc(lock)}\\), `
    + `held by pid ${process.pid}; up to 75 s in all\\.\\n`, "m"));
  assert.equal(r.err.split("waiting for").length, 2, "said once");
  assert.equal(s.runs().length, 1);
});

test("worker #536: two calls on one new branch at once, a writer and a reviewer: one makes the worktree, the other finds it", async (t) => {
  const s = scene(t);
  assert.equal(s.cli(["worker", "warm", "--branch", "feat/warm"]).code, 0, "the attach ledger written first");
  // The worker check's hc ls answers after 1.5 s: both calls look for the branch's worktree
  // (none yet) before the first, holding the lock, makes it.
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nif [ "$1" = ls ] && [ "$2" = --json ]; then sleep 1.5; fi\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const both = await Promise.all([s.cliAsync(["worker", "w", "--branch", "feat/new", "--json"]),
    s.cliAsync(["worker", "r", "--branch", "feat/new", "--role", "review", "--json"], { from: "t4" })]);
  for (const r of both) assert.equal(r.code, 0, r.err);
  const out = both.map((r) => JSON.parse(r.out));
  const wt = join(s.project, ".claude/worktrees/feat-new");
  assert.deepEqual(out.map((o) => o.worktree), [wt, wt]);
  assert.deepEqual(out.map((o) => o.created).sort(), [false, true], "made once");
  assert.equal(s.runs().filter((r) => r[r.indexOf("--cwd") + 1] === wt).length, 2);
});

test("worker #536: an hc get that fails for a live terminal in the worktree refuses (fails closed), before any hook or run", (t) => {
  const s = scene(t);
  const wt = join(s.project, ".claude/worktrees/feat-get");
  git(s.project, "worktree", "add", "-q", "-b", "feat/get", wt);
  addTerminals(s, worker("t70", wt, { "worker.of": ID.cap, "worker.role": "dev" }));
  const st = s.hcState();
  st.failGet = ["t70"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["worker", "go", "--worktree", wt]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t70 is live in .*feat-get, but whether it's a worker can't be told: hc get t70 failed: hc: server error reading t70\. Not started\. Try again, or check it with hc get t70\.\n$/);
  assert.equal(s.runs().length, 0);
  assert.equal(existsSync(join(wt, ".claude/settings.local.json")), false, "no hook written");
});

test("worker #538: one --task on two branches at once: one starts; the other waits, is refused by name and makes nothing", async (t) => {
  const { taskLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  assert.equal(s.cli(["worker", "warm", "--branch", "feat/warm"]).code, 0, "the attach ledger written first");
  const before = s.runs().length;
  // hc run answers (and its worker shows in hc ls) after 1 s: both calls' hc ls would answer
  // before either run, so only the task's name lock keeps the second from passing the check.
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nif [ "$1" = run ]; then sleep 1; fi\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const branches = ["fix/gl-231-a", "fix/gl-231-b"];
  const both = await Promise.all([s.cliAsync(["worker", "go", "--task", "gl-231", "--branch", branches[0]]),
    s.cliAsync(["worker", "go", "--task", "gl-231", "--branch", branches[1]], { from: "t4" })]);
  const why = both.map((r) => r.err).join("\n");
  assert.deepEqual(both.map((r) => r.code).sort(), [0, 1], why);
  const runs = s.runs().slice(before);
  assert.equal(runs.length, 1, why);
  assert.equal(runs[0][runs[0].indexOf("--name") + 1], "gl-231-dev");
  const won = both.findIndex((r) => r.code === 0);
  const lost = 1 - won;
  const address = both[won].out.split("\n")[0];
  assert.match(both[lost].err, new RegExp(`gl-231-dev is taken by a live terminal: ${reEsc(address)}\\. A task's worker is named exactly <id>-<role>`));
  const folder = (b) => join(s.project, ".claude/worktrees", b.replace(/\//g, "-"));
  assert.equal(existsSync(folder(branches[won])), true);
  assert.equal(existsSync(folder(branches[lost])), false, "no worktree made");
  assert.equal(existsSync(join(folder(branches[lost]), ".claude/settings.local.json")), false, "no hook written");
  assert.equal(git(s.project, "branch", "--list", branches[lost]), "", "no branch made");
  // One lock per name, in the worktree locks' folder; let go once the start is done.
  const lockDir = join(s.app, "automagik-herdr");
  assert.match(taskLock(lockDir, "gl-231-dev"), new RegExp(`^${reEsc(lockDir)}/task-[0-9a-f]{16}\\.lock$`));
  assert.notEqual(taskLock(lockDir, "gl-231-dev"), taskLock(lockDir, "gl-231-review"));
  assert.equal(existsSync(taskLock(lockDir, "gl-231-dev")), false, "dropped after the start");
});

test("worker #552: a task's name lock stays fresh while its call waits for the worktree lock; a second call can't take it", async (t) => {
  const { worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  assert.equal(s.cli(["worker", "warm", "--branch", "feat/warm"]).code, 0, "the attach ledger written first");
  const before = s.runs().length;
  // A 1 s stale limit; hc run answers after 3 s. A's worktree lock is held (kept fresh) by the
  // test for 4 s, so A waits for it holding its task's name lock. A wait that held the event
  // loop would leave that lock untouched: C, started at +2 s, would take it over as stale and
  // start a second gl-231-dev.
  exe(join(s.root, "bin/hc"), `#!/bin/sh\nif [ "$1" = run ]; then sleep 3; fi\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const env = { AUTOMAGIK_HERDR_LOCK_STALE_MS: "1000" };
  const lockDir = join(s.app, "automagik-herdr");
  mkdirSync(lockDir, { recursive: true });
  const held = worktreeLock(lockDir, join(s.project, ".claude/worktrees/fix-gl-231-a"));
  writeFileSync(held, `${process.pid} held-by-the-test`);
  const fresh = setInterval(() => { try { const now = new Date(); utimesSync(held, now, now); } catch { /* let go */ } }, 200);
  const free = setTimeout(() => { clearInterval(fresh); rmSync(held, { force: true }); }, 4000);
  t.after(() => { clearInterval(fresh); clearTimeout(free); });
  const a = s.cliAsync(["worker", "go", "--task", "gl-231", "--branch", "fix/gl-231-a"], { env });
  const c = new Promise((resolve) => setTimeout(resolve, 2000))
    .then(() => s.cliAsync(["worker", "go", "--task", "gl-231", "--branch", "fix/gl-231-b"], { from: "t4", env }));
  const [ra, rc] = await Promise.all([a, c]);
  const why = `A: ${ra.err}\nC: ${rc.err}`;
  const runs = s.runs().slice(before);
  assert.equal(runs.length, 1, why);
  assert.equal(ra.code, 0, why);
  assert.equal(rc.code, 1, why);
  const address = ra.out.split("\n")[0];
  assert.match(rc.err, new RegExp(`gl-231-dev is taken by a live terminal: ${reEsc(address)}\\.`));
  assert.equal(existsSync(join(s.project, ".claude/worktrees/fix-gl-231-b")), false, "no worktree made");
  assert.equal(git(s.project, "branch", "--list", "fix/gl-231-b"), "", "no branch made");
});

test("worker #552: the name lock's wait and the worktree lock's share one deadline; a refusal names what it waited for", async (t) => {
  const { taskLock, worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  assert.equal(s.cli(["worker", "warm", "--branch", "feat/warm"]).code, 0, "the attach ledger written first");
  const lockDir = join(s.app, "automagik-herdr");
  mkdirSync(lockDir, { recursive: true });
  // Both locks held by the test (fresh under the 10 s stale limit); the wait is 5.5 s in all.
  const name = taskLock(lockDir, "gl-231-dev");
  const wt = worktreeLock(lockDir, join(s.project, ".claude/worktrees/fix-gl-231-a"));
  writeFileSync(name, `${process.pid} held-by-the-test`);
  writeFileSync(wt, `${process.pid} held-by-the-test`);
  t.after(() => { rmSync(name, { force: true }); rmSync(wt, { force: true }); });
  const child = s.spawnCli(["worker", "go", "--task", "gl-231", "--branch", "fix/gl-231-a"], { env: { AUTOMAGIK_HERDR_WORKER_WAIT_MS: "5500" } });
  let err = "";
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  // The name lock is let go once the call says it waits for it (3 s in): about 2.5 s are left
  // for the worktree lock, under the 3 s after which a wait is said. A wait of its own 5.5 s
  // would say so and end "after 6 s".
  child.stderr.on("data", (d) => { err += d; if (/waiting for the task name/.test(err)) rmSync(name, { force: true }); });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1, err + out);
  assert.match(err, new RegExp(`am: waiting for the task name gl-231-dev \\(${reEsc(name)}\\), held by pid ${process.pid}; up to 6 s in all\\.`));
  assert.doesNotMatch(err, /waiting for the worker lock/, "the worktree lock's wait is what the deadline leaves");
  assert.match(err, new RegExp(`the worker lock on \\S*fix-gl-231-a \\(${reEsc(wt)}\\) is held by another am \\(pid ${process.pid}\\)\\n`));
  assert.equal(existsSync(join(s.project, ".claude/worktrees/fix-gl-231-a")), false, "nothing made");
  assert.equal(s.runs().length, 1, "only the warm-up ran");
});

test("workerWait #552: AUTOMAGIK_HERDR_WORKER_WAIT_MS clamped to 100 ms..75 s; unset or not a number is 75 s", async () => {
  const { workerWait } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  assert.deepEqual([undefined, "", " ", "x", "NaN", "Infinity"].map(workerWait), Array(6).fill(75_000));
  assert.deepEqual(["1", "0", "-5", "100", "5500", "75000", "75001", "1e10"].map(workerWait), [100, 100, 100, 100, 5500, 75_000, 75_000, 75_000]);
});

test("staleLimit #536: AUTOMAGIK_HERDR_LOCK_STALE_MS clamped to 100 ms..60 s; unset or not a number is 10 s", async () => {
  const { staleLimit } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  assert.deepEqual([undefined, "", " ", "x", "NaN", "Infinity"].map(staleLimit), [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.deepEqual(["1", "0", "-5", "100", "400", "60000", "60001", "1e10"].map(staleLimit), [100, 100, 100, 100, 400, 60_000, 60_000, 60_000]);
});

// ---- #567: a finished worker's created worktree is removed ----

/** The scene's project with a bare origin (a scratch folder) that has main, so a clean new worktree has nothing unpushed. */
function withOrigin(s) {
  const origin = join(s.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(s.project, "remote", "add", "origin", origin);
  git(s.project, "push", "-q", "origin", "main");
  git(s.project, "fetch", "-q", "origin");
  return origin;
}
/** The fake hc, run as the CLI runs it (no HC_TERMINAL_ID: killing the caller isn't wanted here). */
const fakeHc = (s, ...args) => execFileSync(join(s.root, "bin/hc"), args,
  { env: { ...process.env, PATH: s.path, HC_FAKE_STATE: join(s.root, "hc.json"), HC_FAKE_LOG: join(s.root, "hc.log"), HC_TERMINAL_ID: "" }, encoding: "utf8" });
const reapFile = (s) => { const p = join(s.app, "automagik-herdr/worker-reap.jsonl"); return existsSync(p) ? readLedger(readFileSync(p, "utf8")) : []; };
const worktreesOf = (s) => parseWorktrees(git(s.project, "worktree", "list", "--porcelain")).map((w) => w.path);

// #1135: every destructive git call is observed, including a prune that removes no file.
function watchReapGit(s, { count = null } = {}) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const log = join(s.root, "destructive-git.log");
  const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
  writeFileSync(log, "");
  exe(join(s.root, "bin/git"), "#!/bin/sh\n"
    + 'if [ "$1" = worktree ] && { [ "$2" = remove ] || [ "$2" = prune ]; }; then\n'
    + `  printf '%s\\t%s\\n' "$PWD" "$2" >> ${quote(log)}\nfi\n`
    + (count === null ? "" : 'if [ "$1" = rev-list ] && [ "$2" = --count ]; then\n'
      + `  printf '%s' ${quote(count)}\n  exit 0\nfi\n`)
    + `exec ${quote(realGit)} "$@"\n`);
  return () => readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function foreignReapProject(s) {
  const project = scratchProject(s.root, "foreign", { branch: "main", commit: true });
  const root = join(s.root, "foreign-origin");
  mkdirSync(root);
  withOrigin({ root, project });
  return project;
}

function seedReapTree(s, { project = s.project, owner = project, name = "candidate" } = {}) {
  const worktree = join(s.root, name), branch = `fix/${name}`;
  git(project, "worktree", "add", "-q", "-b", branch, worktree, "origin/main");
  const row = startRow({ kind: "worker", terminal: `ended-${name}`, botId: ID.dev,
    project: owner, worktree, branch, created: true });
  const file = join(s.app, "automagik-herdr/workers.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: LEDGER_MODE });
  return { worktree, branch, row, file };
}

test("worker #1135: launch never removes or prunes another repository's ended worktree", (t) => {
  const s = scene(t);
  withOrigin(s);
  const foreign = foreignReapProject(s);
  const w = seedReapTree(s, { project: foreign });
  const calls = watchReapGit(s);
  const before = git(foreign, "worktree", "list", "--porcelain");
  const r = s.cli(["worker", "one", "--branch", "fix/one", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(w.worktree), true);
  assert.equal(git(foreign, "worktree", "list", "--porcelain"), before);
  assert.deepEqual(calls(), [], "no foreign remove or prune was even attempted");
  assert.deepEqual(reapFile(s), [], "foreign candidates never enter cleanup outcomes");
});

test("worker #1135: ownership backup rejects a foreign launcher at its own boundary", (t) => {
  const s = scene(t);
  withOrigin(s);
  const foreign = foreignReapProject(s);
  const w = seedReapTree(s, { project: foreign });
  const calls = watchReapGit(s);
  // Exercise the scene's isolation preflight before importing the helper in this same env.
  const ready = s.cli(["--help"]);
  assert.equal(ready.code, 0, ready.err);
  assertScratchProject(foreign, { ceiling: s.root, env: s.env });
  const target = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).href;
  const hook = join(s.root, "ownership-hook.mjs");
  const child = join(s.root, "ownership-child.mjs");
  // Add only a test-process export to the real module; its main guard remains off.
  writeFileSync(hook, 'import { registerHooks } from "node:module";\n'
    + `const target = ${JSON.stringify(target)};\n`
    + 'registerHooks({ load(url, context, nextLoad) {\n'
    + '  const loaded = nextLoad(url, context);\n'
    + '  return url === target\n'
    + '    ? { ...loaded, source: String(loaded.source) + "\\nexport { reapOwnership };\\n" }\n'
    + '    : loaded;\n'
    + '} });\n');
  writeFileSync(child, `const { reapOwnership } = await import(${JSON.stringify(target)});\n`
    + `const candidate = ${JSON.stringify(w.row)};\n`
    + `const own = await reapOwnership(candidate, ${JSON.stringify(foreign)});\n`
    + `const other = await reapOwnership(candidate, ${JSON.stringify(s.project)});\n`
    + 'console.log(JSON.stringify({ own, other }));\n');
  const result = spawnSync(process.execPath,
    ["--max-old-space-size=2048", "--import", hook, child], {
      cwd: s.project, env: { ...s.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      encoding: "utf8",
    });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.own, null, "the same candidate is valid in its recorded repository");
  assert.equal(proof.other, "worktree belongs to another launching repository");
  assert.deepEqual(calls(), [], "the helper only observes repository ownership");
});

test("worker #1135: a gone foreign checkout is not pruned by another project's launch", (t) => {
  const s = scene(t);
  withOrigin(s);
  const foreign = foreignReapProject(s);
  const w = seedReapTree(s, { project: foreign });
  rmSync(w.worktree, { recursive: true });
  const before = git(foreign, "worktree", "list", "--porcelain");
  const calls = watchReapGit(s);
  const r = s.cli(["worker", "one", "--branch", "fix/one", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(foreign, "worktree", "list", "--porcelain"), before);
  assert.deepEqual(calls(), []);
});

for (const ownership of ["missing", "mismatched", "conflicting", "gone"]) {
  test(`worker #1135: ${ownership} ownership retains without remove or prune`, (t) => {
    const s = scene(t);
    withOrigin(s);
    const other = foreignReapProject(s);
    const w = seedReapTree(s, {
      project: ownership === "mismatched" ? other : s.project,
      owner: ownership === "missing" ? null : s.project,
    });
    if (ownership === "conflicting") appendFileSync(w.file, `${JSON.stringify({
      ...w.row, created: false, terminal: "later-ended", project: other,
    })}\n`);
    if (ownership === "gone") rmSync(w.worktree, { recursive: true });
    const calls = watchReapGit(s);
    const r = s.cli(["worker", "one", "--branch", "fix/one", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls(), []);
    if (ownership !== "gone") assert.equal(existsSync(w.worktree), true);
  });
}

test("worker #1135: canonical owner aliases allow pushed same-project work", (t) => {
  const s = scene(t);
  withOrigin(s);
  const alias = join(s.root, "alias");
  symlinkSync(s.project, alias, "dir");
  const w = seedReapTree(s, { owner: alias });
  appendFileSync(w.file, `${JSON.stringify({ ...w.row, created: false,
    terminal: "later-ended", project: s.project })}\n`);
  const calls = watchReapGit(s);
  const r = s.cli(["worker", "one", "--branch", "fix/one", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(w.worktree), false, r.out);
  assert.ok(calls().some((line) => line.endsWith("\tremove")));
});

for (const ownership of ["foreign", "unknown"]) {
  test(`worker #1135: global completion records ${ownership} owner without cleanup`, (t) => {
    const s = scene(t);
    withOrigin(s);
    const project = ownership === "foreign" ? foreignReapProject(s) : s.project;
    const w = seedReapTree(s, { project, owner: ownership === "foreign" ? project : null });
    const row = { ...w.row, terminal: "t90", core: "fakecore0000", created_ms: 90 };
    writeFileSync(w.file, `${JSON.stringify(row)}\n`, { mode: LEDGER_MODE });
    const ended = Date.now() - 16 * 60_000;
    const state = s.hcState();
    state.terminals.push({ ...term("t90", { cwd: w.worktree }), created_ms: 90,
      state: "finished", finished_ms: ended, reason: "exited", exit_code: 0 });
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const calls = watchReapGit(s);
    for (const branch of ["fix/one", "fix/two"]) {
      const r = s.cli(["worker", "one", "--branch", branch, "--json"]);
      assert.equal(r.code, 0, r.err);
      assert.equal(existsSync(w.worktree), true);
      assert.deepEqual(calls(), []);
      assert.deepEqual(s.ledger().filter((r) => r.event === "end" && r.terminal === "t90"), [{
        event: "end", kind: "worker", terminal: "t90", core: "fakecore0000", created_ms: 90,
        reason: "finished", hc_reason: "exited", exit_code: 0, at: new Date(ended).toISOString(),
      }], "completion is recorded exactly once, independently of cleanup eligibility");
    }
  });
}

for (const proof of ["closed", "older merge", "unknown", "missing head"]) {
  test(`worker #1135: ${proof} PR proof retains unpushed current HEAD`, (t) => {
    const s = scene(t);
    withOrigin(s);
    const w = seedReapTree(s);
    const older = git(w.worktree, "rev-parse", "HEAD").trim();
    git(w.worktree, "commit", "-q", "--allow-empty", "-m", "new work");
    const head = git(w.worktree, "rev-parse", "HEAD").trim();
    const pr = { number: 1, state: proof === "closed" ? "CLOSED" :
      proof === "unknown" ? "UNKNOWN" : "MERGED", headRefOid: head };
    if (proof === "older merge") pr.headRefOid = older;
    if (proof === "missing head") delete pr.headRefOid;
    writeFileSync(join(s.root, "gh.json"), JSON.stringify([pr]));
    const calls = watchReapGit(s);
    const r = s.cli(["reap", "--json"], { from: null });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(w.worktree), true, r.out);
    assert.deepEqual(calls(), []);
    assert.equal(r.json().kept.length, 1);
  });
}

for (const count of ["", " ", "invalid", "-1", "9007199254740992"]) {
  test(`worker #1135: malformed remote count ${JSON.stringify(count)} retains`, (t) => {
    const s = scene(t);
    withOrigin(s);
    const w = seedReapTree(s);
    const calls = watchReapGit(s, { count });
    const r = s.cli(["reap", "--json"], { from: null });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(w.worktree), true);
    assert.deepEqual(calls(), []);
    assert.equal(r.json().kept.length, 1);
    assert.match(r.json().kept[0].why, /git rev-list failed/);
  });
}

test("worker #1135: exact merged HEAD permits squash-merged same-project cleanup", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = seedReapTree(s);
  writeFileSync(join(w.worktree, "work.txt"), "complete\n");
  git(w.worktree, "add", "work.txt");
  git(w.worktree, "commit", "-q", "-m", "work");
  const head = git(w.worktree, "rev-parse", "HEAD").trim();
  git(s.project, "merge", "--squash", w.branch);
  git(s.project, "commit", "-q", "-m", "squash");
  git(s.project, "push", "-q", "origin", "main");
  assert.equal(git(w.worktree, "rev-list", "--count", "HEAD", "--not", "--remotes").trim(), "1");
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([
    { number: 1, state: "MERGED", headRefOid: head },
  ]));
  const r = s.cli(["reap", "--json"], { from: null });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().removed, [w.worktree]);
  assert.equal(existsSync(w.worktree), false);
});

for (const change of ["head", "branch", "owner", "repository"]) {
  test(`worker #1135: ${change} changing during proof retains the checkout`, (t) => {
    const s = scene(t);
    withOrigin(s);
    const w = seedReapTree(s);
    git(w.worktree, "commit", "-q", "--allow-empty", "-m", "work");
    const head = git(w.worktree, "rev-parse", "HEAD").trim();
    writeFileSync(join(s.root, "gh.json"), JSON.stringify([
      { number: 1, state: "MERGED", headRefOid: head },
    ]));
    const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
    let hook = change === "head"
      ? `git -C ${quote(w.worktree)} -c user.name=t -c user.email=t@t `
        + "commit -q --allow-empty -m late\n"
      : change === "branch" ? `git -C ${quote(w.worktree)} checkout -q -b changed\n`
        : `printf '%s\\n' ${quote(JSON.stringify({ ...w.row, created: false,
          terminal: "late-owner", project: null }))} >> ${quote(w.file)}\n`;
    if (change === "repository") {
      const other = foreignReapProject(s);
      git(other, "fetch", "-q", s.project, w.branch);
      git(other, "checkout", "-q", "-b", w.branch, "FETCH_HEAD");
      assert.equal(git(other, "rev-parse", "HEAD").trim(), head);
      hook = `printf '%s\\n' ${quote(`gitdir: ${join(other, ".git")}`)} `
        + `> ${quote(join(w.worktree, ".git"))}\n`;
    }
    writeFileSync(join(s.root, "gh-hook.sh"), hook);
    const calls = watchReapGit(s);
    const r = s.cli(["reap", "--json"], { from: null });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(w.worktree), true, r.out);
    assert.deepEqual(calls(), []);
  });
}

test("worker #567 (fail-before): an ended worker's created worktree is gone at the next worker call; the new one is kept", (t) => {
  const s = scene(t);
  withOrigin(s);
  const first = s.cli(["worker", "one", "--branch", "fix/one", "--json"]);
  assert.equal(first.code, 0, first.err);
  const one = first.json();
  assert.equal(one.created, true);
  assert.equal(existsSync(one.worktree), true);
  s.finish(one.terminal);
  const second = s.cli(["worker", "two", "--branch", "fix/two", "--json"]);
  assert.equal(second.code, 0, second.err);
  const two = second.json();
  assert.equal(existsSync(one.worktree), false, "the ended worker's worktree is removed");
  assert.equal(worktreesOf(s).includes(one.worktree), false, "and pruned from git's list");
  assert.equal(existsSync(two.worktree), true, "the worker just started keeps its own");
  assert.ok(two.warnings.includes(`removed ${one.worktree}: its workers ended`), JSON.stringify(two.warnings));
  assert.match(second.err, new RegExp(`am: removed ${reEsc(one.worktree)}: its workers ended`));
  assert.deepEqual(reapFile(s).map((r) => [r.worktree, r.result, r.why]), [[one.worktree, "removed", null]]);
  // The ledger gets no cleanup rows; the sweep found the first worker finished: its end row (RFC 0021 (f) 4), once.
  const firstRow = s.ledger().find((r) => r.event === "start" && r.terminal === one.terminal);
  assert.deepEqual(s.ledger().filter((r) => r.event !== "start").map((r) => [r.event, r.kind, r.terminal, r.core, r.created_ms, r.reason]),
    [["end", "worker", one.terminal, "fakecore0000", firstRow.created_ms, "finished"]]);
  const again = s.cli(["reap"], { from: null });
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out.trim(), "No finished worker's worktree to remove.", "a removed worktree is done with");
});

test("worker #567: a killed worker's created worktree is removed by reap 15 min after it ended; a live one is left alone", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  const live = s.cli(["reap", "--json"], { from: null });
  assert.equal(live.code, 0, live.err);
  assert.deepEqual(live.json(), { removed: [], kept: [], failed: [], waiting: 1, more: 0 }, "a live worker's worktree waits");
  assert.equal(existsSync(w.worktree), true);
  fakeHc(s, "kill", w.terminal);
  // Within 15 min of its end (restart --tree runs its workers again there, without the lock): waits.
  assert.equal(s.cli(["reap", "--json"], { from: null }).json().waiting, 1, "just ended: not yet");
  assert.equal(existsSync(w.worktree), true);
  s.finish(w.terminal, 14 * 60_000);
  assert.equal(s.cli(["reap", "--json"], { from: null }).json().waiting, 1, "14 min: not yet");
  s.finish(w.terminal, 15 * 60_000 + 1000);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `removed ${w.worktree}: its workers ended`);
  assert.equal(existsSync(w.worktree), false);
});

test("worker #567: unpushed commits keep the worktree with one line; a later worker call doesn't repeat it", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  git(w.worktree, "commit", "-q", "--allow-empty", "-m", "work");
  s.finish(w.terminal);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.code, 0, r.err);
  const line = `kept ${w.worktree}: 1 commit on no remote; `
    + "gh couldn't prove fix/one's current HEAD is merged";
  assert.equal(r.out.trim(), line, "a gh error keeps it (fails closed)");
  assert.equal(existsSync(w.worktree), true);
  assert.ok(readFileSync(join(s.root, "gh.log"), "utf8").includes(
    "--json number,state,createdAt,mergedAt,closedAt,baseRefName,headRefOid --limit 20"));
  const next = s.cli(["worker", "two", "--branch", "fix/two", "--json"]);
  assert.equal(next.code, 0, next.err);
  assert.equal(next.json().warnings.some((x) => x.includes(w.worktree)), false, "the same reason isn't said again");
  assert.equal(s.cli(["reap"], { from: null }).out.trim(), line, "reap by hand says it every time");
  assert.deepEqual(reapFile(s).map((x) => x.result), ["kept"], "one row while the reason stays");
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([{ number: 7, state: "OPEN" }]));
  assert.equal(s.cli(["reap"], { from: null }).out.trim(), `kept ${w.worktree}: `
    + "1 commit on no remote; no merged pull request proves fix/one's current HEAD is preserved");
});

test("worker #567: unpushed commits with the exact current HEAD merged: removed", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  git(w.worktree, "commit", "-q", "--allow-empty", "-m", "squashed upstream");
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([
    { number: 5, state: "MERGED", headRefOid: git(w.worktree, "rev-parse", "HEAD").trim() },
    { number: 3, state: "CLOSED" },
  ]));
  s.finish(w.terminal);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.out.trim(), `removed ${w.worktree}: its workers ended`, r.err);
  assert.equal(existsSync(w.worktree), false);
});

test("worker #567: uncommitted changes keep it whatever gh says", (t) => {
  const s = scene(t);
  withOrigin(s);
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([{ number: 5, state: "MERGED" }]));
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  writeFileSync(join(w.worktree, "notes.txt"), "half done\n");
  s.finish(w.terminal);
  assert.equal(s.cli(["reap"], { from: null }).out.trim(), `kept ${w.worktree}: uncommitted changes`);
  assert.equal(existsSync(join(w.worktree, "notes.txt")), true);
});

test("worker #567: a worktree only given to a worker (--worktree, a branch's existing one) is never removed", (t) => {
  const s = scene(t);
  withOrigin(s);
  const pre = join(s.root, "pre");
  git(s.project, "worktree", "add", "-q", "-b", "fix/pre", pre, "origin/main");
  const a = s.cli(["worker", "one", "--worktree", pre, "--json"]);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.json().created, false);
  s.finish(a.json().terminal);
  const b = s.cli(["worker", "two", "--branch", "fix/pre", "--json"]);
  assert.equal(b.code, 0, b.err);
  assert.equal(b.json().created, false, "--branch found the existing worktree");
  s.finish(b.json().terminal);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.out.trim(), "No finished worker's worktree to remove.", r.err);
  assert.equal(existsSync(pre), true, "clean, pushed and ended, but not made by a worker call");
  assert.deepEqual(reapFile(s), []);
});

test("worker #567: a live terminal working in it, or a restart's live pane on it, keeps it; hc failing skips the sweep", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  s.finish(w.terminal);
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t2").cwd = join(w.worktree, "sub");
  mkdirSync(join(w.worktree, "sub"));
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.deepEqual(s.cli(["reap", "--json"], { from: null }).json().waiting, 1);
  assert.equal(existsSync(w.worktree), true, "a shell in it");
  st.terminals.find((x) => x.address === "t2").cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  // A restart's row: the same worktree, created false, a live terminal.
  appendFileSync(join(s.app, "automagik-herdr/workers.jsonl"), `${JSON.stringify(startRow({ kind: "worker", terminal: "t3", botId: ID.dev,
    project: s.project, worktree: w.worktree, created: false }))}\n`);
  assert.equal(s.cli(["reap", "--json"], { from: null }).json().waiting, 1);
  assert.equal(existsSync(w.worktree), true, "its restarted worker runs");
  s.finish("t3");
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ ...s.hcState(), fail: ["ls"] }));
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.out.trim(), "worktree cleanup skipped: hc ls --all failed");
  assert.equal(existsSync(w.worktree), true);
});

test("reapCandidates/workLeft #567: created rows only, newest first, every later terminal, the newest outcome; what keeps a tree", () => {
  const start = (terminal, worktree, created, at, kind = "worker") => ({ event: "start", kind, terminal, worktree, created, at, project: "/p", branch: "b" });
  const old = { event: "start", kind: "worker", terminal: "t7", worktree: "/w/old", created: true, at: "0", task: "fix/old" };
  const rows = [old, start("t1", "/w/given", false, "1"), start("t2", "/w/a", true, "2"), start("t3", "/w/a", false, "3"), { event: "session", terminal: "t2" },
    start("t4", "/w/b", true, "4"), start("t5", "/w/c", true, "5"), start("t6", "/w/c", true, "7")];
  const reaps = [{ worktree: "/w/b", result: "removed", at: "6" }, { worktree: "/w/c", result: "kept", why: "x", at: "6" },
    { worktree: "/w/a", result: "kept", why: "y", at: "8" }];
  assert.deepEqual(reapCandidates(rows, reaps), [
    { worktree: "/w/c", project: "/p", branch: "b", terminals: ["t6"], last: null },
    { worktree: "/w/a", project: "/p", branch: "b", terminals: ["t2", "t3"], last: { result: "kept", why: "y", at: "8" } },
    { worktree: "/w/old", project: null, branch: "fix/old", terminals: ["t7"], last: null },
  ], "/w/given never; /w/b done; /w/c made again after its kept row, so newest; a row before the task contract keeps its branch in task");
  const ok = { changes: 0, unpushed: 0, branch: "b", expected: "b", head: "a".repeat(40) };
  assert.equal(workLeft(ok), null);
  assert.equal(workLeft({ ...ok, changes: 2, prs: [{ state: "MERGED" }] }), "uncommitted changes");
  assert.equal(workLeft({ ...ok, unpushed: 2, prs: [
    { state: "MERGED", headRefOid: ok.head }, { state: "CLOSED" },
  ] }), null);
  assert.equal(workLeft({ ...ok, unpushed: 2, prs: [{ state: "MERGED" }, { state: "OPEN" }] }),
    "2 commits on no remote; no merged pull request proves b's current HEAD is preserved");
  assert.equal(workLeft({ ...ok, unpushed: 1, prs: [] }), "1 commit on no remote; b has no pull request");
  assert.equal(workLeft({ ...ok, unpushed: 1, prs: null }),
    "1 commit on no remote; gh couldn't prove b's current HEAD is merged");
  assert.equal(workLeft({ ...ok, branch: "other", prs: [{ state: "MERGED" }] }), "on other, not the worker's branch b");
  assert.equal(workLeft({ ...ok, expected: null }), "on b, and the workers ledger names no branch for it");
  assert.equal(workLeft({ ...ok, branch: null }), "HEAD is detached, not on the worker's branch b");
  assert.equal(workLeft({ ...ok, branch: null, unpushed: 3, prs: [{ state: "MERGED" }] }), "HEAD is detached with 3 commits on no remote");
});

test("worker #567 F1: a worktree removed while a call waits for its lock: --worktree is refused, --branch makes it again", async (t) => {
  const { worktreeLock } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  s.finish(w.terminal);
  const lock = worktreeLock(join(s.app, "automagik-herdr"), w.worktree);
  t.after(() => rmSync(lock, { force: true }));
  /** One call while the test holds W's lock: once it says it waits, W is removed (as a sweep would) and the lock let go. */
  const whileRemoved = async (args) => {
    writeFileSync(lock, `${process.pid} held-by-the-test`);
    const child = s.spawnCli(args);
    let err = "";
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => {
      err += d;
      if (/waiting for the worker lock/.test(err) && existsSync(lock)) { git(s.project, "worktree", "remove", w.worktree); rmSync(lock, { force: true }); }
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, err, out };
  };
  const given = await whileRemoved(["worker", "two", "--worktree", w.worktree]);
  assert.equal(given.code, 1, given.err + given.out);
  assert.match(given.err, new RegExp(`${reEsc(w.worktree)} is no longer a worktree of ${reEsc(s.project)}: it was removed while this call waited for its lock\\. `
    + "Not started; pass --branch fix/one to make it again\\."));
  assert.equal(existsSync(w.worktree), false, "never made again as a plain folder");
  assert.equal(s.runs().length, 1, "not started");
  git(s.project, "worktree", "add", "-q", w.worktree, "fix/one");
  const branch = await whileRemoved(["worker", "three", "--branch", "fix/one", "--json"]);
  assert.equal(branch.code, 0, branch.err);
  const out = JSON.parse(branch.out);
  assert.equal(out.created, true, "made again by the normal path");
  assert.equal(worktreesOf(s).includes(w.worktree), true, "a real worktree, listed by git");
  assert.equal(s.runs().length, 2);
});

test("worker #567 F2: a change landing between the check and the remove keeps the tree (no --force); a pane started there waits", (t) => {
  const s = scene(t);
  withOrigin(s);
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([{ number: 5, state: "MERGED" }]));
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  git(w.worktree, "commit", "-q", "--allow-empty", "-m", "squashed upstream");
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([
    { number: 5, state: "MERGED", headRefOid: git(w.worktree, "rev-parse", "HEAD").trim() },
  ]));
  s.finish(w.terminal);
  // gh is asked after git status: a file written then is in the tree when the remove runs.
  writeFileSync(join(s.root, "gh-hook.sh"), `echo late > "${join(w.worktree, "late.txt")}"\n`);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `kept ${w.worktree}: uncommitted changes`);
  assert.equal(readFileSync(join(w.worktree, "late.txt"), "utf8"), "late\n", "the late file is still there");
  rmSync(join(w.worktree, "late.txt"));
  // Now a pane starts in it (no worktree lock) between the check and the remove.
  writeFileSync(join(s.root, "gh-hook.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
const p = ${JSON.stringify(join(s.root, "hc.json"))};
const st = JSON.parse(readFileSync(p, "utf8"));
st.terminals.find((x) => x.address === "t2").cwd = ${JSON.stringify(w.worktree)};
writeFileSync(p, JSON.stringify(st));
`);
  writeFileSync(join(s.root, "gh-hook.sh"), `"${process.execPath}" "${join(s.root, "gh-hook.mjs")}"\n`);
  const live = s.cli(["reap", "--json"], { from: null });
  assert.equal(live.code, 0, live.err);
  assert.deepEqual(live.json(), { removed: [], kept: [], failed: [], waiting: 1, more: 0 });
  assert.equal(existsSync(w.worktree), true);
});

test("worker #567 F6/F7: a worktree on another branch, or a detached HEAD with commits on no remote, is kept", (t) => {
  const s = scene(t);
  withOrigin(s);
  writeFileSync(join(s.root, "gh.json"), JSON.stringify([{ number: 5, state: "MERGED" }]));
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  s.finish(w.terminal);
  git(w.worktree, "checkout", "-q", "-b", "other");
  assert.equal(s.cli(["reap"], { from: null }).out.trim(), `kept ${w.worktree}: on other, not the worker's branch fix/one`);
  git(w.worktree, "checkout", "-q", "--detach");
  git(w.worktree, "commit", "-q", "--allow-empty", "-m", "on no branch");
  assert.equal(s.cli(["reap"], { from: null }).out.trim(), `kept ${w.worktree}: HEAD is detached with 1 commit on no remote`, "whatever gh says");
  assert.equal(existsSync(w.worktree), true);
});

test("worker #567 F4: a worker call's sweep skips a kept worktree whose reason is a day old; reap still checks it", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  git(w.worktree, "commit", "-q", "--allow-empty", "-m", "work");
  s.finish(w.terminal);
  assert.match(s.cli(["reap"], { from: null }).out, /^kept /);
  const file = join(s.app, "automagik-herdr/worker-reap.jsonl");
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  writeFileSync(file, `${JSON.stringify({ ...row, at: new Date(Date.now() - 25 * 3600_000).toISOString() })}\n`);
  // Its created row ages with it: a kept row counts only from the worktree's newest created row on.
  const ledgerFile = join(s.app, "automagik-herdr/workers.jsonl");
  writeFileSync(ledgerFile, readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean)
    .map((l) => { const r = JSON.parse(l); return JSON.stringify(r.terminal === w.terminal ? { ...r, at: new Date(Date.now() - 26 * 3600_000).toISOString() } : r); })
    .join("\n") + "\n");
  const asked = () => readFileSync(join(s.root, "gh.log"), "utf8").split("\n").filter(Boolean).length;
  // Its pull requests were asked for a moment ago (#899): what is counted here is the cleanup's own look.
  writeFileSync(prChecksPath(s.app), prChecksText(new Map([[prBranchKey({ project: s.project, branch: "fix/one" }), Date.now()]]), [{ project: s.project, branch: "fix/one" }]));
  const before = asked();
  const next = s.cli(["worker", "two", "--branch", "fix/two", "--json"]);
  assert.equal(next.code, 0, next.err);
  assert.equal(asked(), before, "not looked at by the worker call");
  assert.match(s.cli(["reap"], { from: null }).out.trim(), new RegExp(`^kept ${reEsc(w.worktree)}: 1 commit on no remote`));
  assert.equal(asked(), before + 1, "reap looks at it");
});

// ---- #899: how a terminal ended on its end row, and the pull requests' `pr` rows ----

/** usagemeter's end_word (hc.rs): the only `hc_reason` and signal names it reads. */
const METER_END_WORD = /^[A-Za-z0-9_-]{1,32}$/;
const T0 = "1970-01-01T00:00:00.000Z";

test("endRow #899: hc's reason, exit code and signal are copied; a row hc said nothing for keeps its shape", () => {
  const key = { kind: "worker", terminal: "t5", core: "core-1", createdMs: 9, reason: "finished", at: 0 };
  const legacy = { event: "end", kind: "worker", terminal: "t5", core: "core-1", created_ms: 9, reason: "finished", at: T0 };
  assert.deepEqual(endRow(key), legacy);
  assert.deepEqual(Object.keys(endRow(key)), ["event", "kind", "terminal", "core", "created_ms", "reason", "at"], "no new key, and none as null");
  assert.deepEqual(endRow({ ...key, hcReason: null, exitCode: null, signal: null }), legacy, "hc's nulls are left out");
  assert.deepEqual(endRow({ ...key, hcReason: "exited", exitCode: 3, signal: null }), { ...legacy, hc_reason: "exited", exit_code: 3, at: T0 });
  assert.deepEqual(Object.keys(endRow({ ...key, hcReason: "exited", exitCode: 0, signal: 15 })),
    ["event", "kind", "terminal", "core", "created_ms", "reason", "hc_reason", "exit_code", "signal", "at"]);
  assert.deepEqual(endRow({ ...key, hcReason: "exited", exitCode: 0 }).exit_code, 0, "a clean exit is said too");
  assert.deepEqual(endRow({ ...key, hcReason: "killed", signal: 9 }), { ...legacy, hc_reason: "killed", signal: 9, at: T0 });
  assert.deepEqual(endRow({ ...key, hcReason: "killed", signal: "SIGKILL" }).signal, "SIGKILL");
  assert.deepEqual(endRow({ ...key, hcReason: "stopped_by_restart" }), { ...legacy, hc_reason: "stopped_by_restart", at: T0 });
  // What usagemeter can't read is left out, never cut: a status that isn't an integer, a signal that isn't a number or a word.
  for (const exitCode of [1.5, "1", NaN, 2 ** 60, {}]) assert.equal("exit_code" in endRow({ ...key, hcReason: "exited", exitCode }), false, String(exitCode));
  for (const signal of ["", "two words", "x".repeat(33), 1.5, {}, true]) assert.equal("signal" in endRow({ ...key, hcReason: "exited", signal }), false, String(signal));
});

test("endRow #899 (PR 1027 F5): never an exit code or a signal without an hc_reason usagemeter reads", () => {
  // usagemeter counts an end row with a status or a signal and no reason as a failed run
  // (outcomes.rs end_of): a kill or a restart must never reach it that way.
  const key = { kind: "worker", terminal: "t5", core: "core-1", createdMs: 9, reason: "finished", at: 0 };
  const noReason = [undefined, null, "", 7, {}, ["exited"], "two words", "exited\n", "x".repeat(33), "saída"];
  for (const hcReason of noReason) {
    for (const how of [{ exitCode: 1 }, { signal: 9 }, { signal: "SIGTERM" }, { exitCode: 137, signal: 9 }]) {
      const row = endRow({ ...key, hcReason, ...how });
      assert.deepEqual(Object.keys(row), ["event", "kind", "terminal", "core", "created_ms", "reason", "at"], `${JSON.stringify(hcReason)} ${JSON.stringify(how)}`);
    }
  }
  // And every row that does hold one names a reason usagemeter reads.
  for (const hcReason of [...noReason, "exited", "killed", "stopped_by_restart", "a-b_c9"]) {
    const row = endRow({ ...key, hcReason, exitCode: 1, signal: 9 });
    if ("exit_code" in row || "signal" in row) assert.match(row.hc_reason, METER_END_WORD);
  }
  assert.deepEqual(endRow({ ...key, hcReason: "a-b_c9", exitCode: 1 }).hc_reason, "a-b_c9");
});

test("finishedEnds #899: the sweep's end row copies how hc says the terminal ended", () => {
  const start = (terminal, createdMs) => startRow({ kind: "worker", terminal, botId: ID.dev, worktree: `/w/${terminal}`, created: true, core: "core-1", createdMs, at: 1000 });
  const rows = [start("t1", 10), start("t2", 20), start("t3", 30), start("t4", 40)];
  const gets = new Map([
    ["t1", { created_ms: 10, finished_ms: 15, reason: "exited", exit_code: 2, signal: null }],
    ["t2", { created_ms: 20, finished_ms: 25, reason: "killed", exit_code: null, signal: 9 }],
    ["t3", { created_ms: 30, finished_ms: 35 }],
    // hc gave a status and no reason: the row says only that it ended.
    ["t4", { created_ms: 40, finished_ms: 45, exit_code: 1, signal: 15 }],
  ]);
  const base = (terminal, created_ms, at) => ({ event: "end", kind: "worker", terminal, core: "core-1", created_ms, reason: "finished", at });
  assert.deepEqual(finishedEnds(rows, gets, "core-1"), [
    { ...base("t1", 10), hc_reason: "exited", exit_code: 2, at: "1970-01-01T00:00:00.015Z" },
    { ...base("t2", 20), hc_reason: "killed", signal: 9, at: "1970-01-01T00:00:00.025Z" },
    base("t3", 30, "1970-01-01T00:00:00.035Z"),
    base("t4", 40, "1970-01-01T00:00:00.045Z"),
  ]);
});

const PR = { project: "/p", branch: "fix/one", pr: 7, state: "OPEN", at: 0 };

test("prRow #899: gh's state in lower case, its times as the ledger writes them, in usagemeter's key order", () => {
  const row = prRow({ ...PR, task: "gh-899", firstCommitAt: "2026-01-02T03:04:05+01:00", openedAt: "2026-01-02T04:00:00Z", mergedAt: null, closedAt: null, core: "core-1" });
  assert.deepEqual(row, { event: "pr", project: "/p", branch: "fix/one", task: "gh-899", pr: 7, state: "open", first_commit_at: "2026-01-02T02:04:05.000Z",
    opened_at: "2026-01-02T04:00:00.000Z", merged_at: null, closed_at: null, core: "core-1", at: T0 });
  assert.deepEqual(Object.keys(row), ["event", "project", "branch", "task", "pr", "state", "first_commit_at", "opened_at", "merged_at", "closed_at", "core", "at"]);
  assert.deepEqual(Object.keys(prRow(PR)), ["event", "project", "branch", "pr", "state", "first_commit_at", "opened_at", "merged_at", "closed_at", "at"], "no task, no core: left out");
  assert.deepEqual(PR_STATES, ["open", "merged", "closed"]);
  assert.deepEqual(["OPEN", "MERGED", "CLOSED", "open", "merged", "closed"].map((state) => prRow({ ...PR, state, mergedAt: "2026-01-03T00:00:00Z" })?.state),
    ["open", "merged", "closed", "open", "merged", "closed"]);
  // A merged row says when; a time that is missing or can't be read is null, never a guess.
  assert.equal(prRow({ ...PR, state: "MERGED" }), null);
  assert.equal(prRow({ ...PR, state: "MERGED", mergedAt: "soon" }), null);
  assert.equal(prRow({ ...PR, state: "MERGED", mergedAt: "2026-01-03T00:00:00Z" }).merged_at, "2026-01-03T00:00:00.000Z");
  assert.deepEqual([undefined, null, "", "soon", {}, NaN, "1999-12-31T23:59:59Z", "2100-01-01T00:00:00Z"].map(prTime), Array(8).fill(null));
  assert.deepEqual([prTime("2000-01-01T00:00:00Z"), prTime(Date.UTC(2026, 0, 2)), prTime(new Date(Date.UTC(2026, 0, 2)))],
    ["2000-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
  assert.equal(prRow({ ...PR, openedAt: "soon", closedAt: "1999-01-01T00:00:00Z" }).opened_at, null);
});

test("prRow #899: a row usagemeter would refuse is not written; a task it wouldn't keep is left out", () => {
  for (const bad of [{ project: "" }, { project: null }, { project: "/p\n" }, { project: `/${"p".repeat(1024)}` }, { branch: "" }, { branch: 7 }, { branch: "a\u0085b" },
    { branch: "b".repeat(256) }, { branch: "é".repeat(128) }, { pr: 0 }, { pr: -1 }, { pr: 1.5 }, { pr: "7" }, { pr: null }, { state: "DRAFT" }, { state: "" }, { state: null }]) {
    assert.equal(prRow({ ...PR, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(prRow({ ...PR, project: `/${"p".repeat(1023)}`, branch: "é".repeat(127) }).branch.length, 127, "its bounds are in bytes");
  for (const task of ["gh-899", "fix/x", "t".repeat(64)]) assert.equal(prRow({ ...PR, task }).task, task);
  for (const task of [undefined, null, "", 7, "t".repeat(65), "a:b", "a;b", "a\nb", "\u{1F600}".repeat(25)]) assert.equal("task" in prRow({ ...PR, task }), false, String(task));
});

test("prRow and prRowsFor #899: nothing of a pull request but its number, state and times is kept", () => {
  const secret = { title: "TITLE-MARK", author: { login: "AUTHOR-MARK" }, body: "BODY-MARK", url: "https://example.invalid/URL-MARK", headRefOid: "SHA-MARK", headRefName: "HEAD-MARK",
    baseRefName: "BASE-MARK" };
  const keys = ["event", "project", "branch", "pr", "state", "first_commit_at", "opened_at", "merged_at", "closed_at", "at"];
  assert.deepEqual(Object.keys(prRow({ ...PR, ...secret })), keys);
  const [row] = prRowsFor({ project: "/p", branch: "fix/one", list: [{ number: 7, state: "OPEN", createdAt: "2026-01-02T04:00:00Z", ...secret }], rows: [], at: 0 });
  assert.deepEqual(Object.keys(row), keys);
  assert.doesNotMatch(JSON.stringify(row), /MARK/);
});

test("prRowsFor #899: a row for a pull request that is new or changed, none when nothing did", () => {
  const open = { number: 7, state: "OPEN", createdAt: "2026-01-02T04:00:00Z", mergedAt: null, closedAt: null, firstCommitAt: "2026-01-02T03:00:00Z" };
  const ask = (list, rows, extra = {}) => prRowsFor({ project: "/p", branch: "fix/one", task: "gh-899", list, rows, core: "core-1", at: 0, ...extra });
  const first = ask([open], []);
  assert.deepEqual(first, [{ event: "pr", project: "/p", branch: "fix/one", task: "gh-899", pr: 7, state: "open", first_commit_at: "2026-01-02T03:00:00.000Z",
    opened_at: "2026-01-02T04:00:00.000Z", merged_at: null, closed_at: null, core: "core-1", at: T0 }]);
  assert.deepEqual(ask([open], first), [], "seen again as it was");
  assert.deepEqual(ask([open, open], []).length, 1, "listed twice: one row");
  // The same number on another branch or in another project is another pull request.
  assert.equal(ask([open], [{ ...first[0], branch: "fix/two" }, { ...first[0], project: "/q" }]).length, 1);
  const merged = { ...open, state: "MERGED", mergedAt: "2026-01-03T00:00:00Z", closedAt: "2026-01-03T00:00:00Z" };
  const second = ask([merged], first);
  assert.deepEqual(second.map((r) => [r.pr, r.state, r.merged_at, r.closed_at]), [[7, "merged", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]]);
  assert.deepEqual(ask([merged], [...first, ...second]), [], "the newest row is the one compared");
  assert.equal(ask([open], [...first, ...second]).length, 1, "reopened: a change again");
  // A time alone changing is a change; the same time written another way is not.
  assert.equal(ask([{ ...open, createdAt: "2026-01-02T04:00:01Z" }], first).length, 1);
  assert.deepEqual(ask([open], [{ ...first[0], opened_at: "2026-01-02T05:00:00+01:00" }]), []);
  // A merged pull request gh gives no merge time for is not written, and is asked for again later.
  assert.deepEqual(ask([{ ...merged, mergedAt: null }], first), []);
  assert.deepEqual(ask([null, 7, { number: "7", state: "OPEN" }, { number: 8, state: "DRAFT" }], []), []);
  assert.deepEqual(ask(null, []), []);
  // Several pull requests of one branch: each its own row.
  assert.deepEqual(ask([open, { ...merged, number: 3 }], first).map((r) => r.pr), [3]);
});

test("prRowsFor #899: the first commit is git's while git can tell, then the one a row recorded", () => {
  const open = { number: 7, state: "OPEN", createdAt: "2026-01-02T04:00:00Z" };
  const ask = (list, rows) => prRowsFor({ project: "/p", branch: "fix/one", list, rows, at: 0 });
  const seen = ask([{ ...open, firstCommitAt: "2026-01-02T03:00:00Z" }], []);
  assert.equal(seen[0].first_commit_at, "2026-01-02T03:00:00.000Z");
  // The branch is gone (git says nothing): no change, so no row; and a later change keeps the recorded time.
  assert.deepEqual(ask([{ ...open, firstCommitAt: null }], seen), []);
  const merged = ask([{ ...open, state: "MERGED", mergedAt: "2026-01-03T00:00:00Z", firstCommitAt: null }], seen);
  assert.deepEqual(merged.map((r) => [r.state, r.first_commit_at]), [["merged", "2026-01-02T03:00:00.000Z"]]);
  // Never recorded and git can't tell: null, which usagemeter counts as no first commit.
  assert.equal(ask([open], [])[0].first_commit_at, null);
  // git's reading wins over a recorded one (an amended first commit), as a change.
  assert.deepEqual(ask([{ ...open, firstCommitAt: "2026-01-02T02:00:00Z" }], seen).map((r) => r.first_commit_at), ["2026-01-02T02:00:00.000Z"]);
  // A first commit after the pull request opened is another pull request's (the branch name used again): not this one's.
  assert.equal(ask([{ ...open, firstCommitAt: "2026-01-02T04:00:01Z" }], [])[0].first_commit_at, null);
  assert.deepEqual(ask([{ ...open, firstCommitAt: "2026-01-02T04:00:01Z" }], seen), [], "the recorded one stays");
  assert.equal(ask([{ ...open, firstCommitAt: "2026-01-02T04:00:00Z" }], [])[0].first_commit_at, "2026-01-02T04:00:00.000Z", "the same second is fine");
  assert.equal(ask([{ number: 7, state: "OPEN", firstCommitAt: "2026-01-02T03:00:00Z" }], [])[0].first_commit_at, "2026-01-02T03:00:00.000Z", "no opening time to hold it against");
});

test("prBranches #899: which worker branches a sweep still asks gh about", () => {
  const now = Date.UTC(2026, 5, 1);
  const iso = (ago) => new Date(now - ago).toISOString();
  const HOUR = 3600_000, DAY = 24 * HOUR;
  const start = (branch, ago, extra = {}) => startRow({ kind: "worker", terminal: "t9", botId: ID.dev, project: "/p", branch, worktree: `/w/${branch}`, at: now - ago, ...extra });
  const pr = (branch, n, state, ago) => ({ event: "pr", project: "/p", branch, pr: n, state, at: iso(ago) });
  const rows = [
    start("no-pr", 2 * HOUR, { task: "gh-1", base: "aaaaaaa", created: true }),
    start("no-pr", HOUR, { task: "gh-2", base: "bbbbbbb" }), // a restart's row: the newest task, not its base
    start("open", 5 * DAY), pr("open", 7, "open", 4 * DAY),
    start("done", 5 * DAY), pr("done", 8, "open", 4 * DAY), pr("done", 8, "merged", 3 * DAY),
    start("again", 5 * DAY), pr("again", 9, "closed", 3 * DAY), start("again", 2 * DAY),
    start("two", 5 * DAY), pr("two", 10, "merged", 3 * DAY), pr("two", 11, "open", 3 * DAY),
    start("old", 31 * DAY),
    start("old-open", 40 * DAY), pr("old-open", 12, "open", 31 * DAY),
    startRow({ kind: "seat", terminal: "t1", botId: ID.cap, project: "/p", branch: "seat", at: now }),
    startRow({ kind: "worker", terminal: "t2", botId: ID.dev, branch: "no-project", at: now }),
    { event: "start", kind: "worker", terminal: "t3", project: "/p", task: "fix/before-contract", base: "ccccccc", at: iso(HOUR) },
    pr("stray", 13, "open", 0), // a pr row no worker start names
  ];
  const all = prBranches(rows, now);
  const by = Object.fromEntries(all.map((w) => [w.branch, w]));
  assert.deepEqual(Object.keys(by).sort(), ["again", "done", "fix/before-contract", "no-pr", "old", "old-open", "open", "two"]);
  assert.deepEqual(Object.fromEntries(all.map((w) => [w.branch, w.followed])),
    { "no-pr": true, "fix/before-contract": true, again: true, open: true, two: true, done: false, old: false, "old-open": false });
  assert.deepEqual(by["no-pr"], { project: "/p", branch: "no-pr", task: "gh-2", base: "aaaaaaa", started: now - HOUR, last: now - HOUR, open: false, recorded: false, followed: true });
  assert.deepEqual([by.open.open, by.open.recorded, by.open.last], [true, true, now - 4 * DAY]);
  assert.deepEqual([by.done.open, by.done.recorded], [false, true], "its newest row is the one read");
  assert.deepEqual([by.again.open, by.again.recorded, by.again.last], [false, true, now - 2 * DAY], "a worker started on it after its pull request closed");
  assert.deepEqual([by.two.open, by.two.recorded], [true, true]);
  assert.deepEqual([by["fix/before-contract"].task, by["fix/before-contract"].base], [null, "ccccccc"], "a row from before the task contract holds its branch in task");
  assert.deepEqual(all.map((w) => w.last), [...all.map((w) => w.last)].sort((a, b) => b - a), "most recently active first");
  assert.deepEqual(prWatch(rows, now).map((w) => w.branch).sort(), ["again", "fix/before-contract", "no-pr", "open", "two"]);
  assert.equal(PR_WATCH_MS, 30 * DAY);
});

test("prAskDue #899: likely news is asked for often while fresh, a branch never pushed rarely and not for long", () => {
  const now = Date.UTC(2026, 5, 1);
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const w = (ago, extra = {}) => ({ project: "/p", branch: "b", started: now - ago, last: now - ago, open: false, recorded: false, ...extra });
  assert.deepEqual([PR_ASK_MIN_MS, PR_ASK_MAX_MS, PR_QUIET_FIRST_MS, PR_QUIET_EVERY_MS, PR_QUIET_WATCH_MS], [10 * MIN, 6 * HOUR, HOUR, DAY, 3 * DAY]);
  // Likely: an open pull request, or a pushed branch with none recorded yet.
  assert.equal(prLikely(w(0, { open: true, recorded: true }), false), true);
  assert.equal(prLikely(w(0), true), true);
  assert.equal(prLikely(w(0), false), false);
  assert.equal(prLikely(w(0, { recorded: true }), true), false, "its pull requests all ended: pushed says nothing new");
  const due = (x, opts) => prAskDue(x, { now, ...opts }) - now;
  // Just pushed: first asked 10 min after its last activity, then a quarter of its idle time after each ask.
  assert.equal(due(w(0), { pushed: true }), 10 * MIN);
  assert.equal(due(w(20 * MIN), { pushed: true }), -10 * MIN, "due since");
  assert.equal(due(w(20 * MIN), { pushed: true, checked: now - MIN }), 9 * MIN);
  assert.equal(due(w(4 * HOUR), { pushed: true, checked: now - MIN }), HOUR - MIN);
  assert.equal(due(w(10 * DAY, { open: true, recorded: true }), { checked: now - MIN }), 6 * HOUR - MIN, "at most 6 h apart");
  assert.equal(due(w(10 * MIN, { open: true, recorded: true }), { checked: now - HOUR }), 0, "activity since the last ask: counted from the activity");
  assert.equal(due(w(HOUR), { pushed: true, checked: now + DAY }), 15 * MIN, "a time ahead of the clock counts as now");
  // Not pushed: an hour after its last worker start, then daily, for three days.
  assert.equal(due(w(0)), HOUR);
  assert.equal(due(w(2 * HOUR)), -HOUR);
  assert.equal(due(w(2 * HOUR), { checked: now - MIN }), DAY - MIN);
  assert.equal(due(w(2 * HOUR), { checked: now - 3 * HOUR }), -HOUR, "asked before its last worker start: as never");
  assert.equal(prAskDue(w(3 * DAY + 1), { now }), Infinity);
  assert.equal(prAskDue(w(3 * DAY + 1), { now, pushed: true }) < Infinity, true, "a pushed one is followed on");
  // A worker started again after its pull requests ended: the rare schedule, whatever git shows.
  assert.equal(due(w(2 * HOUR, { recorded: true }), { pushed: true }), -HOUR);
});

test("readPrChecks and prChecksText #899: when each followed branch was asked, and nothing of a branch no longer followed", () => {
  const a = { project: "/p", branch: "fix/a" }, b = { project: "/p", branch: "fix/b" }, c = { project: "/q", branch: "fix/a" };
  const checked = new Map([[prBranchKey(a), 5], [prBranchKey(b), 6], [prBranchKey(c), 7]]);
  const text = prChecksText(checked, [a, c, { project: "/p", branch: "never-asked" }]);
  assert.deepEqual(JSON.parse(text), { v: 1, checked: [{ project: "/p", branch: "fix/a", at: 5 }, { project: "/q", branch: "fix/a", at: 7 }] });
  assert.deepEqual([...readPrChecks(text)], [[prBranchKey(a), 5], [prBranchKey(c), 7]]);
  for (const bad of [null, "", "{", "[]", '{"v":2,"checked":[]}', '{"v":1,"checked":{}}', '{"v":1,"checked":[null,{"project":"/p"},{"project":"/p","branch":"b","at":"5"}]}']) {
    assert.deepEqual([...readPrChecks(bad)], [], String(bad));
  }
});

/** The scene's ledger rows of one event. */
const rowsOf = (s, event) => s.ledger().filter((r) => r.event === event);
const ghAsked = (s) => (existsSync(join(s.root, "gh.log")) ? readFileSync(join(s.root, "gh.log"), "utf8").split("\n").filter(Boolean) : []);
const ghAnswer = (s, list) => writeFileSync(join(s.root, "gh.json"), JSON.stringify(list));
/** What gh says of a pull request, with the fields no row may keep. */
const ghPr = (number, state, extra = {}) => ({ number, state, createdAt: "2026-01-02T04:00:00Z", mergedAt: null, closedAt: null, baseRefName: "main",
  title: "TITLE-MARK", author: { login: "AUTHOR-MARK" }, url: "https://example.invalid/URL-MARK", ...extra });
/** A commit in `cwd` whose author date is `date`. */
const commitAt = (cwd, date, message = "work") => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message],
  { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

test("worker #899: the sweep's end row says how hc saw the terminal end; a status with no reason is left out", (t) => {
  const s = scene(t);
  withOrigin(s);
  const one = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  const two = s.cli(["worker", "two", "--branch", "fix/two", "--json"]).json();
  const st = s.hcState();
  const ended = Date.now() - 16 * 60_000;
  Object.assign(st.terminals.find((x) => x.address === one.terminal), { state: "finished", finished_ms: ended, reason: "exited", exit_code: 3, signal: null });
  Object.assign(st.terminals.find((x) => x.address === two.terminal), { state: "finished", finished_ms: ended, exit_code: 1, signal: 9 });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.code, 0, r.err);
  const ends = Object.fromEntries(rowsOf(s, "end").map((row) => [row.terminal, row]));
  const key = (w) => ({ event: "end", kind: "worker", terminal: w.terminal, core: "fakecore0000", created_ms: s.ledger().find((x) => x.event === "start" && x.terminal === w.terminal).created_ms,
    reason: "finished" });
  assert.deepEqual(ends[one.terminal], { ...key(one), hc_reason: "exited", exit_code: 3, at: new Date(ended).toISOString() });
  assert.deepEqual(ends[two.terminal], { ...key(two), at: new Date(ended).toISOString() }, "no reason from hc: neither its status nor its signal");
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(rowsOf(s, "end").length, 2, "once each");
});

test("worker #899: a pushed worker branch's pull request gets a pr row; only a change adds another; an ended one is asked for no more", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--task", "gh-899", "--branch", "fix/gh-899-one", "--json"]);
  assert.equal(w.code, 0, w.err);
  const { worktree, terminal } = w.json();
  commitAt(worktree, "2026-01-02T03:04:05Z");
  commitAt(worktree, "2026-01-02T03:30:00Z", "more");
  assert.deepEqual(ghAsked(s), [], "a worker call asks nothing of the branch it just started");
  git(worktree, "push", "-q", "origin", "fix/gh-899-one");
  // Pushed, no pull request yet: reap asks, and gh lists none.
  ghAnswer(s, []);
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.deepEqual(ghAsked(s), ["pr list --head fix/gh-899-one --state all --json number,state,createdAt,mergedAt,closedAt,baseRefName --limit 20"]);
  assert.deepEqual(rowsOf(s, "pr"), []);
  ghAnswer(s, [ghPr(7, "OPEN")]);
  const opened = s.cli(["reap"], { from: null });
  assert.equal(opened.code, 0, opened.err);
  assert.equal(opened.out.trim(), "No finished worker's worktree to remove.", "the pull request rows are said nowhere");
  assert.equal(opened.err, "");
  const [row, ...more] = rowsOf(s, "pr");
  assert.deepEqual(more, []);
  assert.match(row.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(row, { event: "pr", project: s.project, branch: "fix/gh-899-one", task: "gh-899", pr: 7, state: "open", first_commit_at: "2026-01-02T03:04:05.000Z",
    opened_at: "2026-01-02T04:00:00.000Z", merged_at: null, closed_at: null, core: "fakecore0000", at: row.at });
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(ghAsked(s).length, 3, "an open pull request is asked for again");
  assert.equal(rowsOf(s, "pr").length, 1, "and nothing changed: no row");
  // It merges; its worker ends, and its worktree goes. Then the branch is deleted: git can no longer tell its first commit.
  s.finish(terminal);
  assert.match(s.cli(["reap"], { from: null }).out, /^removed /);
  git(s.project, "branch", "-q", "-D", "fix/gh-899-one");
  ghAnswer(s, [ghPr(7, "MERGED", { mergedAt: "2026-01-03T05:00:00Z", closedAt: "2026-01-03T05:00:00Z" })]);
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.deepEqual(rowsOf(s, "pr").map((x) => [x.pr, x.state, x.first_commit_at, x.opened_at, x.merged_at, x.closed_at]), [
    [7, "open", "2026-01-02T03:04:05.000Z", "2026-01-02T04:00:00.000Z", null, null],
    [7, "merged", "2026-01-02T03:04:05.000Z", "2026-01-02T04:00:00.000Z", "2026-01-03T05:00:00.000Z", "2026-01-03T05:00:00.000Z"],
  ]);
  const asked = ghAsked(s).length;
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(ghAsked(s).length, asked, "merged, and no worker on it since: done with");
  // Nothing of the pull request but its number, state and times, in the ledger or in what was printed.
  assert.doesNotMatch(readFileSync(join(s.app, "automagik-herdr/workers.jsonl"), "utf8"), /MARK/);
  // When each branch was last asked: the owner's file.
  const checks = prChecksPath(s.app);
  assert.equal(statSync(checks).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(checks, "utf8"));
  assert.deepEqual([file.v, file.checked.map((c) => [c.project, c.branch, Number.isSafeInteger(c.at)])], [1, [[s.project, "fix/gh-899-one", true]]]);
});

test("worker #899: the first commit is the worker's own after a rebase on the branch its pull request targets", (t) => {
  const s = scene(t);
  withOrigin(s);
  const { worktree } = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  commitAt(worktree, "2026-01-02T03:04:05Z");
  // main moves on (an older commit, landed after the worktree was made), and the worker rebases on it.
  commitAt(s.project, "2026-01-01T00:00:00Z", "someone else's");
  git(s.project, "push", "-q", "origin", "main");
  git(worktree, "rebase", "-q", "origin/main");
  git(worktree, "push", "-q", "origin", "fix/one");
  ghAnswer(s, [ghPr(7, "OPEN")]);
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.deepEqual(rowsOf(s, "pr").map((x) => x.first_commit_at), ["2026-01-02T03:04:05.000Z"], "not the commit main gained");
});

test("worker #899: what gh told the cleanup is used for the pr rows, with no second call", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  commitAt(w.worktree, "2026-01-02T03:04:05Z", "squashed upstream");
  ghAnswer(s, [ghPr(5, "MERGED", { mergedAt: "2026-01-03T05:00:00Z",
    closedAt: "2026-01-03T05:00:00Z", headRefOid: git(w.worktree, "rev-parse", "HEAD").trim() }),
  ghPr(3, "CLOSED", { createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-01-01T01:00:00Z" })]);
  s.finish(w.terminal);
  const r = s.cli(["reap"], { from: null });
  assert.equal(r.out.trim(), `removed ${w.worktree}: its workers ended`, r.err);
  assert.equal(ghAsked(s).length, 1, "asked once, by the cleanup's check of the commits on no remote");
  // Pull request 3 opened before the branch's first commit here: that commit isn't its own.
  assert.deepEqual(rowsOf(s, "pr").map((x) => [x.pr, x.state, x.first_commit_at, x.merged_at, x.closed_at]), [
    [5, "merged", "2026-01-02T03:04:05.000Z", "2026-01-03T05:00:00.000Z", "2026-01-03T05:00:00.000Z"],
    [3, "closed", null, null, "2026-01-01T01:00:00.000Z"],
  ]);
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(ghAsked(s).length, 1, "both ended: not asked again");
  assert.equal(rowsOf(s, "pr").length, 2);
});

test("worker #899: a worker call asks gh for three branches at most, the next call for the next ones, and none before it is due", (t) => {
  const s = scene(t);
  withOrigin(s);
  // Five worker branches pushed two hours ago, none with a pull request; and one never pushed, started just now.
  const names = [1, 2, 3, 4, 5].map((n) => `fix/b${n}`);
  for (const name of names) git(s.project, "push", "-q", "origin", `main:refs/heads/${name}`);
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(join(s.app, "automagik-herdr/workers.jsonl"), names.map((branch, i) => `${JSON.stringify(startRow({ kind: "worker", terminal: `t${50 + i}`, botId: ID.dev,
    project: s.project, branch, worktree: join(s.root, "gone", String(i)), at: Date.now() - 2 * 3600_000 - i * 1000 }))}\n`).join(""), { mode: 0o600 });
  ghAnswer(s, []);
  const heads = () => ghAsked(s).map((l) => l.split(" ")[3]);
  assert.equal(s.cli(["worker", "one", "--branch", "fix/one", "--json"]).code, 0);
  assert.deepEqual(heads(), ["fix/b5", "fix/b4", "fix/b3"], "the cap, the longest due first");
  assert.equal(s.cli(["worker", "two", "--branch", "fix/two", "--json"]).code, 0);
  assert.deepEqual(heads().slice(3), ["fix/b2", "fix/b1"], "the rest; the first three were asked a moment ago");
  assert.equal(s.cli(["worker", "three", "--branch", "fix/three", "--json"]).code, 0);
  assert.equal(heads().length, 5, "none is due, and a branch never pushed isn't asked about in its first hour");
  assert.deepEqual(JSON.parse(readFileSync(prChecksPath(s.app), "utf8")).checked.map((c) => c.branch).sort(), names);
  // reap asks for every pushed branch now, due or not; still not for the ones never pushed.
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.deepEqual(heads().slice(5).sort(), names);
  assert.deepEqual(rowsOf(s, "pr"), []);
});

test("worker #899: a branch never pushed is asked about an hour after its worker started; gh failing writes nothing and isn't run again at once", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.deepEqual(ghAsked(s), [], "not pushed, started just now");
  const ledgerFile = join(s.app, "automagik-herdr/workers.jsonl");
  const aged = (ms) => writeFileSync(ledgerFile, s.ledger().map((r) => `${JSON.stringify(r.terminal === w.terminal ? { ...r, at: new Date(Date.now() - ms).toISOString() } : r)}\n`).join(""));
  aged(61 * 60_000);
  // No gh.json: the fake gh fails.
  const failed = s.cli(["reap"], { from: null });
  assert.equal(failed.code, 0, failed.err);
  assert.equal(failed.err, "");
  assert.equal(ghAsked(s).length, 1);
  assert.deepEqual(rowsOf(s, "pr"), []);
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(ghAsked(s).length, 1, "asked a moment ago: next in a day");
  aged(4 * 24 * 3600_000);
  rmSync(prChecksPath(s.app));
  assert.equal(s.cli(["reap"], { from: null }).code, 0);
  assert.equal(ghAsked(s).length, 1, "three days on with no push: no longer asked about");
});

test("worker #899: a pr row that can't be written is said as what it is", (t) => {
  const s = scene(t);
  withOrigin(s);
  const w = s.cli(["worker", "one", "--branch", "fix/one", "--json"]).json();
  git(w.worktree, "push", "-q", "origin", "fix/one");
  ghAnswer(s, [ghPr(7, "OPEN")]);
  const ledgerFile = join(s.app, "automagik-herdr/workers.jsonl");
  // The ledger can be read and not appended to (a file given away): the row is lost, and the line says which.
  chmodSync(ledgerFile, 0o400);
  let r;
  try { r = s.cli(["reap"], { from: null }); } finally { chmodSync(ledgerFile, 0o600); }
  assert.equal(r.code, 0, r.err);
  if (process.getuid?.() === 0) return; // root appends anyway
  assert.match(r.out, /^fix\/one's pull request 7 isn't in automagik-herdr\/workers\.jsonl, so usagemeter won't see it: /m);
  assert.doesNotMatch(r.out, /undefined/);
});

// Refs #631: the real PATH guard plus a fake hc that forwards only run to the fixture proxy.
async function proxyWorkerCli(t, { file } = {}) {
  const s = scene(t, file ? { file } : {});
  const shortDir = shortSocketDir(t, "hw-");
  const runtime = join(shortDir, "r"), paneTmp = join(s.root, "pane-tmp");
  const stableRoot = join(s.env.XDG_DATA_HOME, "automagik-herdr", "dsh-sandbox");
  for (const dir of [runtime, paneTmp, join(stableRoot, "guard"), join(stableRoot, "bin"),
    join(s.env.HOME, ".local", "bin")]) mkdirSync(dir, { recursive: true });
  chmodSync(runtime, 0o700);
  exe(join(stableRoot, "bin", "run.sh"), stableRunnerText(process.execPath));
  writeFileSync(join(stableRoot, "hcPane.mjs"), "// fixture helper\n");
  const env = { ...s.env, PATH: `${GUARD_DIR}:${s.env.PATH}`, XDG_RUNTIME_DIR: runtime,
    TMPDIR: paneTmp, HC_FAKE_PROXY_RUN: "1", TERM: "xterm-256color", COLORTERM: "truecolor",
    TERM_PROGRAM: "fixture", TERM_PROGRAM_VERSION: "1.0", AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" };
  let fake = null;
  let proxy = null;
  const openSockets = new Set();
  const closeAll = async () => {
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    try { await proxy?.close(); } catch { /* already closed */ }
    proxy = null;
    try { await fake?.close(); } catch { /* already closed */ }
    fake = null;
  };
  t.after(closeAll);
  try {
    fake = await startFakeCore({ socket: join(shortDir, "f.sock"), terminals: [
      { address: "t1", labels: { bot: ID.dev }, cwd: s.project, state: "live" },
    ] });
    s.approve();
    proxy = await startProxy({ terminal: "t1", upstream: fake.socket, appHome: s.app, env,
      caller: { bot: ID.dev, project: s.project }, bound: true,
      forbiddenRoots: [["project", s.project], ["app home", s.app], ["temp", paneTmp], ["runtime", runtime]] });
    proxy.server.unref?.();
    const transportRequests = [];
    proxy.server.on("connection", (socket) => {
      socket.unref?.();
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
      socket.on("error", () => { openSockets.delete(socket); socket.destroy(); });
      socket.on("data", (data) => {
        for (const line of data.toString().trim().split("\n")) {
          if (JSON.parse(line).method === "proxy.workerTransport") transportRequests.push(line);
        }
      });
    });
    // A proxied start must obtain core identity from that same reply, without server.status.
    const state = s.hcState(); state.fail = ["server"];
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    return { s, env, fake, proxy, transportRequests, closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

async function runProxiedWorkerSuccess(t) {
  const { s, env, fake, proxy, transportRequests, closeAll } = await proxyWorkerCli(t);
  try {
    const r = await s.cliAsync(["worker", "do the task", "--branch", "feat/proxied", "--json"],
      { env: { ...env, HC_SOCKET: proxy.socket } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fake.calls("terminal.run").length, 1, "spawn reached the proxy then fake core");
    assert.equal(transportRequests.length, 1, "one reply supplies core id and route identity");
    assert.equal(s.calls().filter((args) => args[0] === "server").length, 0);
    const params = fake.calls("terminal.run")[0].params;
    assert.equal(params.caller, "t1");
    assert.equal(params.parent, "t1");
    assert.equal(params.labels[WORKER_OF_LABEL], ID.dev);
    assert.deepEqual(params.env, { TERM: "xterm-256color", COLORTERM: "truecolor",
      TERM_PROGRAM: "fixture", TERM_PROGRAM_VERSION: "1.0" });
  } finally {
    await closeAll();
  }
}

async function runProxiedWorkerUnapprovedRefusal(t) {
  const { s, env, fake, proxy, closeAll } = await proxyWorkerCli(t);
  try {
    const r = await s.cliAsync(["worker", "do the task", "--branch", "feat/unapproved",
      "--agent", "claude", "--json"], { env: { ...env, HC_SOCKET: proxy.socket } });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /hc-proxy: terminal.run: approved worker/);
    assert.equal(fake.calls("terminal.run").length, 0);
  } finally {
    await closeAll();
  }
}

test("proxied worker CLI skips the guard only for the actual proxy transport", async (t) => {
  await runProxiedWorkerSuccess(t);
});

test("proxied worker CLI #1032: an approved Kimi worker starts bare through the proxy, and its task is sent past the pane's guard", async (t) => {
  const TASK = "review the login form";
  const file = team();
  file.bots[2].worker = { agent: "kimi" };
  const { s, env, fake, proxy, closeAll } = await proxyWorkerCli(t, { file });
  try {
    exe(join(s.root, "bin", "kimi"), "#!/bin/sh\nexit 0\n");
    // The fixture core names the new pane t200; the file-backed hc knows it as a plain live
    // pane with no labels, which the pane's guard would refuse a send to.
    const state = s.hcState();
    state.terminals.push({ address: "t200", name: "t200", cwd: s.project, state: "live", parent: "t1", labels: {} });
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
    const r = await s.cliAsync(["worker", TASK, "--branch", "feat/proxied-kimi", "--json"], { env: { ...env, HC_SOCKET: proxy.socket } });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.terminal, "t200");
    const argv = fake.calls("terminal.run")[0].params.argv;
    assert.equal(argv.at(-1), "kimi", `the proxy approved an argv with no task word: ${JSON.stringify(argv)}`);
    assert.equal(argv.includes(TASK), false);
    assert.deepEqual(s.hcState().sent, [{ to: "t200", text: TASK }], r.err);
    assert.deepEqual(s.calls().filter((c) => ["wait", "send"].includes(c[0])).map((c) => c.slice(0, 2)), [["wait", "t200"], ["send", "t200"]]);
    assert.deepEqual(out.warnings, [], r.err);
  } finally {
    await closeAll();
  }
});

test("proxied worker CLI gets an unapproved agent refusal from the proxy", async (t) => {
  await runProxiedWorkerUnapprovedRefusal(t);
});

test("#858: proxied worker CLI rows pass and exit cleanly when TMPDIR is over 80 characters", async (t) => {
  const base = scratchRoot(t, "hb-long-");
  const longTmp = join(base, "long-tmpdir-segment-".repeat(5));
  mkdirSync(longTmp, { recursive: true });
  assert.ok(longTmp.length > 80, `expected longTmp > 80 chars, got ${longTmp.length}`);
  const prevTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = longTmp;
    await runProxiedWorkerSuccess(t);
    await runProxiedWorkerUnapprovedRefusal(t);
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }
});

test("unproxied worker CLI keeps the guard refusal with switch off and forged env markers", async (t) => {
  const s = scene(t);
  const r = await s.cliAsync(["worker", "do the task", "--branch", "feat/plain", "--json"],
    { env: { PATH: `${GUARD_DIR}:${s.env.PATH}`, HC_SOCKET: "",
      AM_HC_PROXY: "1", AM_HC_PROXY_SOCKET: join(s.root, "missing.sock"), DSH_SANDBOX_MASK: "1" } });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /hc guard: refused run:/);
  assert.equal(s.runs().length, 0, "no unguarded spawn with the switch off");
  assert.equal(s.calls().filter((args) => args[0] === "server").length, 1,
    "an unproxied pane retains server.status for core id");
});

async function startOneShotTransportServer(t, socketPath, result) {
  let probes = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    socket.unref();
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { sockets.delete(socket); socket.destroy(); });
    socket.on("data", () => {
      probes++;
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }) + "\n");
    });
  });
  server.unref();
  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await new Promise((done) => server.close(() => done()));
  };
  t.after(closeServer);
  await new Promise((resolve, reject) => {
    const onError = (err) => { closeServer().finally(() => reject(err)); };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return { probes: () => probes, closeServer };
}

test("worker transport rejects a mismatched terminal for core id and routing", async (t) => {
  const s = scene(t);
  const socketPath = join(shortSocketDir(t, "hw-"), "wrong-terminal.sock");
  const srv = await startOneShotTransportServer(t, socketPath, { v: 1, terminal: "t999", core: { id: "wrong-core" } });
  try {
    const r = await s.cliAsync(["worker", "do the task", "--branch", "feat/wrong-terminal", "--json"],
      { env: { PATH: `${GUARD_DIR}:${s.env.PATH}`, HC_SOCKET: socketPath } });
    assert.equal(s.calls().filter((args) => args[0] === "server").length, 1,
      "a failed terminal check must ignore the reply's core id");
    assert.equal(srv.probes(), 1);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /hc guard: refused run:/);
    assert.equal(s.runs().length, 0);
  } finally {
    await srv.closeServer();
  }
});

test("unset caller terminal keeps server.status and the guard route", async (t) => {
  const s = scene(t);
  const socketPath = join(shortSocketDir(t, "hw-"), "missing-terminal.sock");
  const srv = await startOneShotTransportServer(t, socketPath, { v: 1, core: { id: "wrong-core" } });
  try {
    const env = { ...s.env, PATH: `${GUARD_DIR}:${s.env.PATH}`, HC_SOCKET: socketPath };
    delete env.HC_TERMINAL_ID;
    const result = await new Promise((done) => execFile(process.execPath,
      [CLI, "whois", "t1", "--json"], { cwd: s.project, env, encoding: "utf8" },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr })));
    assert.equal(s.calls().filter((args) => args[0] === "server").length, 1,
      "an unset caller terminal must keep the server.status core-id lookup");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /hc guard: refused a command without HC_TERMINAL_ID/);
    assert.equal(s.runs().length, 0, "no unguarded worker route is selected");
    assert.equal(srv.probes(), 0, "an unset expected terminal is refused before connecting");
  } finally {
    await srv.closeServer();
  }
});

// RFC 0021 (f) 2: a new Claude worker runs on a session id Herdr chose; its row names it, output never.
test("worker: a new Claude worker's --session-id is its label and its start row's session; --json and text show ***", (t) => {
  const file = team();
  delete file.bots[2].worker;
  const s = scene(t, { file });
  const r = s.cli(["worker", "write the parser", "--branch", "feat/parser", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.runs()[0];
  const words = after(run);
  const sid = words[words.indexOf("--session-id") + 1];
  assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(labelsOf(run).includes(`agent.session=${sid}`));
  const row = s.ledger().find((x) => x.event === "start" && x.terminal === r.json().terminal);
  assert.equal(row.session, sid);
  assert.deepEqual(r.json().argv, ["claude", "--permission-mode", "auto", "--session-id", "***"]);
  assert.equal(`${r.out}${r.err}`.includes(sid), false, "never printed");
  // A codex worker: no session id, none in its row.
  const text = s.cli(["worker", "review it", "--branch", "feat/other", "--agent", "codex"]);
  assert.equal(text.code, 0, text.err);
  assert.equal(after(s.runs()[1]).includes("--session-id"), false);
  assert.equal(s.ledger().filter((x) => x.event === "start").at(-1).session, null);
  for (const id of s.ledger().map((x) => x.session).filter(Boolean)) assert.equal(`${text.out}${text.err}`.includes(id), false);
});
