// Shared by the pack and am CI jobs: the --agent-home flag (#1208), without a real hc. Pure
// rows run against the pack's own modules (am carries byte-equal copies, checked by
// scripts/am-copies.mjs); the CLI rows run the given CLI as a program, far enough to prove a
// refused launch never reaches a project or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AGENT_HOME_VARS, agentHomeFor, agentHomeProblem, agentHomeVar, agentHomeWords } from "../mods/am-sidebar/logins.js";
import { ENV, workerArgs } from "../mods/am-sidebar/workers.js";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { reviveRestartArgs } from "../mods/am-sidebar/revive.js";

const BOT = "b-aaaaaaaaaa";
const CLAUDE = "/bin/claude";
const CODEX = "/bin/codex";

/** A scratch world: a real folder, a file, and a missing path. */
function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-home-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), app = join(root, "app"), login = join(root, "login");
  const file = join(root, "not-a-folder");
  mkdirSync(home); mkdirSync(app); mkdirSync(login);
  writeFileSync(file, "x");
  return { root, home, app, login, file, missing: join(root, "missing") };
}

/** The env assignments `/usr/bin/env` carries in a launch array, before the program. */
function envOf(args) {
  const at = args.lastIndexOf(ENV);
  if (at < 0) return {};
  const env = {};
  for (let i = at + 1; i < args.length; i += 1) {
    const word = args[i];
    if (word === "-u") { i += 1; continue; }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return env;
}

/** The worker launch's env with and without one agent home, and the only key that may differ. */
function workerEnv(agent, argv) {
  const base = { botId: BOT, branch: "feat/x", role: "dev", name: "w", cwd: "/p/wt", parent: "t1", agent, argv };
  const plain = workerArgs(base);
  const home = join(tmpdir(), `agent-home-${agent}`);
  return { plain, withHome: workerArgs({ ...base, login: agentHomeWords(agent, home) }), home };
}

// Mutants these rows are written to kill, named before the run:
// 1. the flag is ignored: the with-home rows see no vendor assignment, or agentHomeFor drops it;
// 2. a relative path is accepted: agentHomeProblem/agentHomeFor and the CLI rows refuse it;
// 3. a file is accepted: agentHomeProblem/agentHomeFor and the CLI rows refuse it;
// 4. the refusal proceeds anyway: agentHomeFor returns words on an error, or the CLI keeps going;
// 5. only the first launch honours it: restart's env and revive's fresh retry keep the flag.
export function agentHomeTests(cli) {
  test("agentHomeVar maps only Claude and Codex to a vendor config variable", () => {
    assert.deepEqual(AGENT_HOME_VARS, { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" });
    assert.equal(agentHomeVar("claude"), "CLAUDE_CONFIG_DIR");
    assert.equal(agentHomeVar("codex"), "CODEX_HOME");
    assert.equal(agentHomeVar("dsh-tui"), null);
    assert.equal(agentHomeVar("antigravity"), null);
    assert.equal(agentHomeVar(undefined), null);
  });

  test("a relative path, a file, a missing folder and the root are refused", (t) => {
    const { root, login, file, missing } = world(t);
    assert.equal(agentHomeProblem(login, { isDir: () => true }), null, "a real folder passes");
    assert.match(agentHomeProblem("relative/login"), /is not an absolute path/);
    assert.match(agentHomeProblem(""), /has no folder/);
    assert.match(agentHomeProblem(file, { isDir: (p) => p === login }), /is not a folder/);
    assert.match(agentHomeProblem(missing, { isDir: (p) => p === login }), /is not a folder/);
    assert.match(agentHomeProblem("/", { isDir: () => true }), /is not a login home/);
    assert.match(agentHomeProblem("/tmp/a\nb", { isDir: () => true }), /has a control character/);
  });

  test("agentHomeFor refuses an agent with no vendor variable and returns exactly one assignment", (t) => {
    const { login } = world(t);
    assert.deepEqual(agentHomeFor("claude", login, { isDir: () => true }), { words: [`CLAUDE_CONFIG_DIR=${login}`] });
    assert.deepEqual(agentHomeFor("codex", login, { isDir: () => true }), { words: [`CODEX_HOME=${login}`] });
    assert.match(agentHomeFor("dsh-tui", login, { isDir: () => true }).error, /has no vendor config folder/);
    assert.match(agentHomeFor(undefined, login, { isDir: () => true }).error, /has no vendor config folder/);
    assert.match(agentHomeFor("claude", "relative", { isDir: () => true }).error, /not an absolute path/);
    assert.match(agentHomeFor("claude", login, { isDir: () => false }).error, /is not a folder/);
  });

  test("a worker launch without the flag is unchanged; with it only the agent's variable is added", () => {
    const claude = workerEnv("claude", [CLAUDE]);
    assert.deepEqual(envOf(claude.plain), {}, "no flag: the launch env is as it was");
    assert.deepEqual(envOf(claude.withHome), { CLAUDE_CONFIG_DIR: claude.home });
    assert.deepEqual(Object.keys(envOf(claude.withHome)).filter((key) => envOf(claude.plain)[key] !== envOf(claude.withHome)[key]), ["CLAUDE_CONFIG_DIR"]);
    assert.equal(claude.withHome.includes("-u"), false, "the home is set, never unset");

    const codex = workerEnv("codex", [CODEX]);
    assert.deepEqual(envOf(codex.plain), {});
    assert.deepEqual(envOf(codex.withHome), { CODEX_HOME: codex.home });
    assert.deepEqual(Object.keys(envOf(codex.withHome)).filter((key) => envOf(codex.plain)[key] !== envOf(codex.withHome)[key]), ["CODEX_HOME"]);
  });

  test("a restart's launch carries the same one-variable change", (t) => {
    const { login } = world(t);
    const args = (agent, argv, words = []) => startArgs({ botId: BOT, name: "bot", cwd: "/p", parent: ["--no-parent"], argv,
      agent, project: "/p", login: words });
    const claude = envOf(args("claude", [CLAUDE]));
    assert.deepEqual(claude, {});
    const claudeHome = envOf(args("claude", [CLAUDE], agentHomeWords("claude", login)));
    assert.deepEqual(claudeHome, { CLAUDE_CONFIG_DIR: login });
    assert.deepEqual(Object.keys(claudeHome).filter((key) => claude[key] !== claudeHome[key]), ["CLAUDE_CONFIG_DIR"]);

    const codex = envOf(args("codex", [CODEX]));
    const codexHome = envOf(args("codex", [CODEX], agentHomeWords("codex", login)));
    assert.deepEqual(codex, {});
    assert.deepEqual(codexHome, { CODEX_HOME: login });
    assert.deepEqual(Object.keys(codexHome).filter((key) => codex[key] !== codexHome[key]), ["CODEX_HOME"]);
  });

  test("revive passes --agent-home to the restart and to its fresh retry", (t) => {
    const { login } = world(t);
    assert.deepEqual(reviveRestartArgs({ botId: BOT, project: "/p" }), ["restart", BOT, "--project", "/p", "--tree", "--revive", "--json"]);
    assert.deepEqual(reviveRestartArgs({ botId: BOT, project: "/p", agentHome: login }),
      ["restart", BOT, "--project", "/p", "--tree", "--revive", "--agent-home", login, "--json"]);
    assert.deepEqual(reviveRestartArgs({ botId: BOT, project: "/p", agentHome: login, fresh: true }),
      ["restart", BOT, "--project", "/p", "--tree", "--revive", "--agent-home", login, "--fresh", "--json"]);
  });

  test("the CLI refuses a relative path, a file and a missing folder before any launch", (t) => {
    const { root, home, app, login, file, missing } = world(t);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app,
      AUTOMAGIK_HERDR_NO_UPDATE: "1", GIT_CEILING_DIRECTORIES: root };
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
    for (const bad of ["relative/login", file, missing]) {
      const worker = run(["worker", "--agent-home", bad, "task", "--branch", "feat/x"]);
      assert.equal(worker.status, 2, `${bad}: ${worker.stderr}`);
      assert.match(worker.stderr, /--agent-home/);
      assert.match(worker.stderr, /not an absolute path|is not a folder/, bad);
      const restart = run(["restart", BOT, "--agent-home", bad]);
      assert.equal(restart.status, 2, `${bad}: ${restart.stderr}`);
      assert.match(restart.stderr, /--agent-home/);
      const revive = run(["revive", "--agent-home", bad]);
      assert.equal(revive.status, 2, `${bad}: ${revive.stderr}`);
      assert.match(revive.stderr, /--agent-home/);
    }
    // A usable folder is not the refusal: the flag is only refused where it cannot be honoured.
    const other = run(["start", BOT, "--agent-home", login]);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /goes with worker, restart or revive/);
  });
}
