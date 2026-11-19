// Codex's command shell and the pane's hc kill shim (#1133): a login shell runs the shell
// startup files, and one that prepends a directory puts its own `hc` (and `automagik-herdr`)
// ahead of the pane PATH, so a non-main bot's ordinary `hc kill` reaches an unguarded binary.
// The pack's Codex launch now tells Codex to run commands in a non-login shell
// (`-c allow_login_shell=false`), which keeps the guard first at command time. Hermetic: a
// scratch home with its own startup files, a stand-in `hc` in the prepended folder, the pack's
// real kill shim and a stub real hc; no live Herdr, no real Codex and no termination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { launchRun } from "../mods/am-sidebar/models.js";
import { restartPlan } from "../mods/am-sidebar/restart.js";
import { GUARD_DIR, KILL_GUARD_DIR, guardPathWith, workerArgs } from "../mods/am-sidebar/workers.js";

const ID = { main: "b-aaaaaaaaaa", dev: "b-cccccccccc" };

/** One scene: a member's pane, a main bot's, the shim, a stub real hc and a prepending startup. */
function scene(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-login-path-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), app = join(root, "app"), project = join(root, "project");
  const bin = join(root, "bin"), shadow = join(root, "stand in dir"), worktree = join(project, "worktrees", "wt");
  for (const dir of [home, app, bin, shadow, join(project, ".herdr"), worktree]) mkdirSync(dir, { recursive: true });
  // A login shell's startup that prepends a folder with its own hc and CLI, as the report saw.
  for (const file of [".profile", ".zprofile"]) {
    writeFileSync(join(home, file), `PATH='${shadow}':"$PATH"\nexport PATH\n`);
  }
  writeFileSync(join(project, ".herdr", "bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [
    { id: ID.main, name: "Main", kind: "main", agent: "codex" },
    { id: ID.dev, name: "Dev", kind: "member", lead: ID.main, agent: "codex" },
  ] }, null, 2)}\n`);
  const ledgerDir = join(app, "automagik-herdr");
  mkdirSync(ledgerDir, { recursive: true });
  const row = (bot, terminal) => `${JSON.stringify({ v: 1, event: "attach", bot, project, terminal, core: "core",
    created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" })}\n`;
  writeFileSync(join(ledgerDir, "attach.jsonl"), row(ID.dev, "t100") + row(ID.main, "t103"));
  chmodSync(join(ledgerDir, "attach.jsonl"), 0o600);

  const log = join(root, "hc.log"), shadowLog = join(root, "shadow.log");
  // The stub real hc: logs every call, answers hc ls/get as the CLI expects.
  writeFileSync(join(bin, "hc"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "get") process.stdout.write(JSON.stringify({ address: args[1] ?? "t9", name: "t9", state: "live", labels: {} }) + "\\n");
else if (args[0] === "ls") process.stdout.write(JSON.stringify({ terminals: [] }) + "\\n");
process.exit(0);
`);
  chmodSync(join(bin, "hc"), 0o755);
  // The prepended folder's hc: the unguarded binary a login startup puts first.
  writeFileSync(join(shadow, "hc"), `#!/bin/sh\nprintf 'shadow\\n' >>${JSON.stringify(shadowLog)}\nexit 0\n`);
  chmodSync(join(shadow, "hc"), 0o755);
  // The intended CLI build and the one the prepended folder would select.
  for (const [dir, word] of [[bin, "intended"], [shadow, "shadow"]]) {
    writeFileSync(join(dir, "automagik-herdr"), `#!/bin/sh\necho ${word}\n`);
    chmodSync(join(dir, "automagik-herdr"), 0o755);
  }
  // A stand-in Codex: it runs one command the way Codex's shell tool does, honouring the
  // pack's allow_login_shell config word (`-c allow_login_shell=false` means `-c`, not `-lc`).
  writeFileSync(join(bin, "codex"), `#!/bin/sh
mode=login
for a do
  case "$a" in allow_login_shell=false) mode=nonlogin ;; esac
done
if [ "$mode" = login ]; then exec "$FAKE_SHELL" -lc "$FAKE_CODEX_CMD"; fi
exec "$FAKE_SHELL" -c "$FAKE_CODEX_CMD"
`);
  chmodSync(join(bin, "codex"), 0o755);

  const path = `${KILL_GUARD_DIR}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const env = { HOME: home, HERDR_APP_HOME: app, HC_TERMINAL_ID: "t100", FAKE_SHELL: "/bin/sh",
    FAKE_CODEX_CMD: "true", PATH: path };
  return { root, home, app, project, bin, shadow, worktree, log, shadowLog, path, env };
}

/** The argv a start/worker/restart launch hands the pane and the environment it runs with. */
const startOf = (s) => startArgs({ botId: ID.dev, name: "dev", cwd: s.project, parent: ["--no-parent"], argv: launchRun("codex", ["codex"], { agent: "codex" }),
  labels: {}, path: s.path, agent: "codex", project: s.project });
const workerOf = (s) => workerArgs({ botId: ID.dev, branch: "feat/x", role: "dev", name: "w", cwd: s.worktree,
  parent: "t100", agent: "codex", model: null, effort: null, argv: launchRun("codex", ["codex"], { agent: "codex" }), task: "do it", path: s.path });
const restartOf = (s) => restartPlan({ bot: { agent: "codex" }, run: launchRun("codex", ["codex"], { agent: "codex" }),
  runningAgent: "codex", fresh: true }).argv;

/** Run a launch's program after its `--` (the `/usr/bin/env PATH=... codex` words). */
function runLaunch(s, args, cmd, { shell = "/bin/sh", terminal = "t100", env = {} } = {}) {
  const at = args.indexOf("--");
  assert.ok(at >= 0, "the launch has a -- before its program");
  const argv = args.slice(at + 1);
  return spawnSync(argv[0], argv.slice(1), { env: { ...s.env, FAKE_SHELL: shell, FAKE_CODEX_CMD: cmd, HC_TERMINAL_ID: terminal, ...env }, encoding: "utf8" });
}
/** The same command through a login shell, as Codex ran it before this fix (no pack word). */
function loginShell(t, cmd, { shell = "/bin/sh", terminal = "t100" } = {}) {
  const s = t;
  return spawnSync(shell, ["-lc", cmd], { env: { ...s.env, FAKE_SHELL: shell, HC_TERMINAL_ID: terminal }, encoding: "utf8" });
}
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

test("the bug: a login startup that prepends a stand-in folder shadows the kill shim (#1133)", (t) => {
  const s = scene(t);
  const before = read(s.shadowLog);
  const r = loginShell(s, "hc kill t9");
  assert.equal(r.status, 0, "the stand-in hc answers, so the call is not refused");
  assert.notEqual(read(s.shadowLog), before, "the prepended hc ran: today a login shell hides the shim");
  assert.equal(read(s.log), "", "the guarded path and the real hc never saw the kill");
});

function assertRefused(r) {
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^hc kill shim: refused kill: hc kill is for a project's main bot only/);
  assert.match(r.stderr, /#955/);
}

test("a start's Codex command runs in a non-login shell: the kill shim is first and refuses a member (#1133)", (t) => {
  const s = scene(t);
  const args = startOf(s);
  assert.ok(args.some((w, i) => args[i - 1] === "-c" && w === "allow_login_shell=false"), "the launch tells Codex not to use a login shell");
  writeFileSync(s.shadowLog, "");
  const r = runLaunch(s, args, "hc kill t9");
  assertRefused(r);
  assert.equal(read(s.shadowLog), "", "the prepended hc never runs");
  assert.equal(read(s.log), "", "a member's kill never reaches the real hc");
  // A permitted call still passes through to the real hc.
  writeFileSync(s.log, "");
  const ls = runLaunch(s, args, "hc ls");
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(read(s.log), /\["ls"\]/);
});

test("a worker's Codex command keeps the same guard-first PATH (#1133)", (t) => {
  const s = scene(t);
  const args = workerOf(s);
  assert.ok(args.some((w, i) => args[i - 1] === "-c" && w === "allow_login_shell=false"));
  writeFileSync(s.shadowLog, "");
  const r = runLaunch(s, args, "hc kill t9");
  assertRefused(r);
  assert.equal(read(s.shadowLog), "");
  assert.equal(read(s.log), "");
});

test("a restart's Codex command keeps the same guard-first PATH (#1133)", (t) => {
  const s = scene(t);
  const argv = restartOf(s);
  assert.ok(argv.some((w, i) => argv[i - 1] === "-c" && w === "allow_login_shell=false"));
  assert.equal(argv[0], "codex");
  const r = spawnSync(argv[0], argv.slice(1), { env: { ...s.env, FAKE_SHELL: "/bin/sh", FAKE_CODEX_CMD: "hc kill t9" }, encoding: "utf8" });
  assertRefused(r);
  assert.equal(read(s.shadowLog), "");
});

test("the intended CLI build is the one the Codex command resolves, not the prepended folder's (#1133)", (t) => {
  const s = scene(t);
  const fixed = runLaunch(s, startOf(s), "automagik-herdr --version");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fixed.stdout, "intended\n");
  const old = loginShell(s, "automagik-herdr --version");
  assert.equal(old.stdout, "shadow\n", "the bug: the login startup selects another CLI build");
});

test("a main bot's seat still passes its kill through the shim (#955 unchanged)", (t) => {
  const s = scene(t);
  writeFileSync(s.log, "");
  const r = runLaunch(s, startOf(s), "hc kill t9", { terminal: "t103" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(s.log), /\["kill","t9"\]/);
});

test("a POSIX and a zsh-style PATH value stay whole: a folder with a space, a trailing slash (#1133)", () => {
  // The pack joins PATH words with colons; a macOS home or a project folder may hold a space,
  // and a shell may spell a folder with a trailing slash. Neither is split, quoted or dropped.
  for (const dir of ["/opt/team tools/bin", "/opt/team tools/bin/", "/opt/tools/bin/"]) {
    const value = `${dir}:/usr/bin:/bin`;
    assert.equal(guardPathWith(value, KILL_GUARD_DIR), `${KILL_GUARD_DIR}:${value}`, dir);
    assert.equal(guardPathWith(`${KILL_GUARD_DIR}:${value}`, KILL_GUARD_DIR), `${KILL_GUARD_DIR}:${value}`, `${dir}: the guard once, first`);
  }
});

const ZSH = "/bin/zsh";
test("the same holds for a zsh-style login startup (#1133)", { skip: !existsSync(ZSH) }, (t) => {
  const s = scene(t);
  const before = read(s.shadowLog);
  const old = loginShell(s, "hc kill t9", { shell: ZSH });
  assert.equal(old.status, 0, old.stderr);
  assert.notEqual(read(s.shadowLog), before, "zsh's .zprofile prepends the stand-in too");
  writeFileSync(s.shadowLog, "");
  const fixed = runLaunch(s, startOf(s), "hc kill t9", { shell: ZSH });
  assertRefused(fixed);
  assert.equal(read(s.shadowLog), "");
});

test("a guarded launch refuses a shadowing first hc, whatever its folder is called (#1133)", async (t) => {
  const { launchGuardProblem } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const s = scene(t);
  const guarded = (...dirs) => launchGuardProblem(["--", "/usr/bin/env", `PATH=${dirs.join(":")}`, "codex"], "dev");
  // The reported shape: an ordinary-named folder first, a real guard folder later, and `hc`
  // resolving to the ordinary folder's copy. The basename gate at 6880d444 returned null.
  const shadowPath = `${s.shadow}:${KILL_GUARD_DIR}:${s.bin}:/usr/bin:/bin`;
  const why = guarded(s.shadow, KILL_GUARD_DIR, s.bin, "/usr/bin", "/bin");
  assert.match(why, /the first hc on the launch PATH resolves to .*stand in dir\/hc/);
  assert.match(why, /not the pack's hc kill shim at .*hc-kill\/hc/);
  assert.match(why, /remove that hc, or put .*hc-kill first on PATH/);
  // That PATH really does resolve hc to the ordinary folder, not the shim.
  const found = spawnSync("/bin/sh", ["-c", "command -v hc"], { env: { ...s.env, PATH: shadowPath }, encoding: "utf8" });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), join(s.shadow, "hc"));
  // The named shadow from the first review still refuses, now because its hc is first, not
  // because of its name.
  const namedShadow = join(s.shadow, "guard");
  mkdirSync(namedShadow, { recursive: true });
  writeFileSync(join(namedShadow, "hc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(namedShadow, "hc"), 0o755);
  const named = guarded(namedShadow, KILL_GUARD_DIR, s.bin, "/usr/bin", "/bin");
  assert.match(named, /the first hc on the launch PATH resolves to .*guard\/hc/);
  // A dsh-tui pane's full guard later on the PATH is the same shape.
  const full = guarded(s.shadow, GUARD_DIR, s.bin, "/usr/bin", "/bin");
  assert.match(full, /not the pack's hc kill shim at .*guard\/hc/);
  // No guard at all (an agentless helper): nothing to preserve, left as it was, whatever the
  // first word is called or whether it is relative.
  assert.equal(launchGuardProblem(["--", "/usr/bin/env", `PATH=${s.bin}:/usr/bin:/bin`, "sh"], "dev"), null);
  assert.equal(launchGuardProblem(["--", "/usr/bin/env", `PATH=${namedShadow}:${s.bin}:/usr/bin:/bin`, "sh"], "dev"), null);
  assert.equal(launchGuardProblem(["--", "/usr/bin/env", `PATH=relative/bin:${s.bin}:/usr/bin:/bin`, "sh"], "dev"), null);
  // The pack's own guard first is fine, the kill shim and the full guard alike.
  assert.equal(launchGuardProblem(["--", "/usr/bin/env", `PATH=${KILL_GUARD_DIR}:${s.bin}:/usr/bin:/bin`, "codex"], "dev"), null);
  assert.equal(launchGuardProblem(["--", "/usr/bin/env", `PATH=${GUARD_DIR}:${s.bin}:/usr/bin:/bin`, "dsh-tui"], "dev"), null);
  // `--on` after the command's -- is the command's word, not hc's: the launch is still checked.
  assert.match(launchGuardProblem(["--", "/usr/bin/env", `PATH=${shadowPath}`, "codex", "--on", "x"], "dev"),
    /the first hc on the launch PATH resolves to/);
  // Only an hc `--on` before the command's -- leaves a linked start to that machine.
  assert.equal(launchGuardProblem(["run", "--on", "m", "--bg", "--", "/usr/bin/env", `PATH=${shadowPath}`, "codex"], "dev"), null);
  // A relative or empty word before the guard cannot prove the first hc: refused on a guarded PATH.
  const relative = launchGuardProblem(["--", "/usr/bin/env", `PATH=relative/bin:${KILL_GUARD_DIR}:${s.bin}:/usr/bin:/bin`, "codex"], "dev");
  assert.match(relative, /the relative folder relative\/bin before the pack's hc kill shim/);
  assert.match(relative, /first hc cannot be resolved/);
  const empty = launchGuardProblem(["--", "/usr/bin/env", `PATH=:${KILL_GUARD_DIR}:${s.bin}:/usr/bin:/bin`, "codex"], "dev");
  assert.match(empty, /an empty entry before the pack's hc kill shim/);
  // The dsh-tui sandbox's stable copy with no shim: refused, never started unguarded.
  const data = join(s.root, "data"), stableGuard = join(data, "automagik-herdr", "dsh-sandbox", "guard");
  mkdirSync(stableGuard, { recursive: true });
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  try {
    const missing = launchGuardProblem(["--", "/usr/bin/env", `PATH=${stableGuard}:${s.bin}:/usr/bin:/bin`, "dsh-tui"], "dev");
    assert.match(missing, /hc kill shim is missing or not executable/);
    assert.match(missing, /dsh-tui install/);
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved;
  }
});
