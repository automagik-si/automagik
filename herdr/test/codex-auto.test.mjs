// Codex auto mode (#946, #1045, #1125): every Codex launch the pack makes passes Codex's
// `--approve-for-me` and `--disable hooks`, so an approval request goes to Codex's own reviewer
// instead of stopping for a person, and TUI startup never stops at the "Hooks need review"
// dialog for one: a bot's Start, its Restart, and `automagik-herdr worker` with a Codex agent.
// Since #1125 the mode also carries --no-daemon and the sandbox's network access, a bot's
// `codexAuto: false` no longer opts out (it is warned about), a restart rebuilds the flags from
// the definition (never the old pane's command), and an hc template that owns a worker's command
// gets no flag. codex-mode.test.mjs has the rest of #1125. Scratch projects and a fake hc
// (test/fake-hc.mjs) only: the real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { AGENTS, CODEX_MODE_ARGS, autoModeArgs, withoutBriefing } from "../mods/am-sidebar/models.js";
import { helperPlan, restartPlan } from "../mods/am-sidebar/restart.js";
import { workerArgs, workerPlan } from "../mods/am-sidebar/workers.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const ID = "b-codexaaaaa";
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const MAIN = { id: ID, name: "Genie", kind: "main", agent: "codex", look: { character: "star", colour: "blue" }, role: "r", instructions: "i" };

/** A fresh scratch world: a git project, a fake hc and herdr-app, a home and an app home. */
function scene(t, bots = [MAIN]) {
  const root = scratchRoot(t, "hb-codex-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, home, join(home, ".config/herdr-app"), join(app, "mods/am-sidebar")]) mkdirSync(d, { recursive: true });
  // No template: a runner's own init.templateDir can't change the exclude file a start writes.
  const project = scratchProject(root, "proj", { template: "" });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots }, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100 }));
  writeFileSync(logPath, "");
  // A pinned PATH, so the pane's PATH is the same on every runner.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    LANG: "C", GIT_CEILING_DIRECTORIES: root, AUTOMAGIK_HERDR_RESTART_STABLE_MS: "1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const idle = () => {
    const now = state();
    for (const x of now.terminals) if (x.labels?.bot === ID && x.state === "live") x.status = { ...(x.status ?? {}), state: "idle" };
    writeFileSync(statePath, JSON.stringify(now));
  };
  return { project, statePath, cli, calls: () => readJsonLines(logPath), state, idle };
}

const MODE = [...CODEX_MODE_ARGS];
/** The grant a scratch project's seat gets: its own .git, the only one of codexGrants' folders there. */
const gitGrant = (project) => ["--add-dir", realpathSync(join(project, ".git"))];

/** What an `hc run` call launches, past `/usr/bin/env PATH=…` and the agents' briefings. */
function launched(call) {
  const words = call.slice(call.indexOf("--") + 1);
  let i = 0;
  if (words[0] === "/usr/bin/env") {
    i = 1;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  }
  return withoutBriefing("claude", withoutBriefing("codex", words.slice(i)));
}
const runs = (calls) => calls.filter((c) => c[0] === "run");

test("start and restart of a Codex bot pass --approve-for-me from its definition, never the old pane's command (#946)", (t) => {
  const s = scene(t);
  const started = s.cli(["start", "Genie"]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(launched(runs(s.calls())[0]), ["codex", ...MODE, ...gitGrant(s.project)]);
  // The old pane's command is not the definition: the restart replaces it with the source's words.
  s.idle();
  const now = s.state();
  const old = now.terminals.find((x) => x.labels?.bot === ID);
  old.argv = ["codex", "--yolo"];
  old.foreground.argv = ["codex", "--yolo"];
  writeFileSync(s.statePath, JSON.stringify(now));
  const restarted = s.cli(["restart", "Genie"]);
  assert.equal(restarted.code, 0, restarted.err);
  const plan = launched(runs(s.calls()).at(-1));
  assert.deepEqual(plan, ["codex", ...MODE, ...gitGrant(s.project), "resume", "--last"]);
  assert.equal(plan.includes("--yolo"), false, "the old pane's command is never reused");
});

test("#1125: codexAuto false no longer opts out: the seat and its restart run the launch mode, and the field is warned about", (t) => {
  const s = scene(t, [{ ...MAIN, codexAuto: false }]);
  const started = s.cli(["start", "Genie"]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(launched(runs(s.calls())[0]), ["codex", ...MODE, ...gitGrant(s.project)]);
  s.idle();
  assert.equal(s.cli(["restart", "Genie"]).code, 0);
  assert.deepEqual(launched(runs(s.calls()).at(-1)), ["codex", ...MODE, ...gitGrant(s.project), "resume", "--last"]);
  const parsed = parseBots(JSON.stringify({ version: 1, categories: [], bots: [{ ...MAIN, codexAuto: false }] }));
  assert.match(parsed.warnings.join("\n"), /codexAuto false no longer opts out/);
});

test("a Codex worker passes the launch mode from the bot's definition, codexAuto false or not (#946, #1125)", () => {
  const bot = { id: ID, name: "Genie", agent: "claude" };
  const on = workerPlan(bot, { agent: "codex" });
  assert.equal(on.error, undefined);
  assert.deepEqual(on.argv, ["codex", ...MODE]);
  assert.deepEqual(workerArgs({ botId: ID, branch: "fix/946", cwd: "/w", parent: "t1", agent: "codex", argv: on.argv, task: "do it" })
    .slice(-(MODE.length + 2)), ["codex", ...MODE, "do it"]);
  assert.deepEqual(workerPlan({ ...bot, codexAuto: false }, { agent: "codex" }).argv, ["codex", ...MODE]);
  const other = workerPlan({ ...bot, codexAuto: false }, { agent: "claude" });
  assert.deepEqual(other.argv, ["claude", "--permission-mode", "auto"]);
});

test("Restart --tree's Codex worker helper keeps the auto mode from the bot's definition; a template keeps its own command (#946, #1125)", () => {
  const get = { address: "t7", cwd: "/w", state: "live", argv: ["codex"], foreground: { argv: ["codex"], cwd: "/w" } };
  const worker = { agent: "codex", worktree: "/w" };
  const on = helperPlan({ get, worker, agents: AGENTS, bot: { codexAuto: true } });
  assert.deepEqual(on.argv, ["codex", ...MODE, "resume", "--last"]);
  const off = helperPlan({ get: { ...get, argv: ["codex", "--approve-for-me"], foreground: { argv: ["codex", "--approve-for-me"], cwd: "/w" } },
    worker, agents: AGENTS, bot: { codexAuto: false } });
  assert.deepEqual(off.argv, ["codex", ...MODE, "resume", "--last"]);
  // A seat's Codex template is read, never rewritten: the mode words it lacks go after it through "$@".
  const tpl = restartPlan({ bot: { agent: "codex" }, run: ["codex", "--approve-for-me"], runningAgent: "codex", session: null,
    template: { name: "rev", command: "codex --model g" } });
  assert.deepEqual(tpl.argv, ["sh", "-c", 'codex --model g "$@"', "sh", ...MODE, "resume", "--last"]);
  const viaTpl = workerPlan({ id: ID, name: "Genie", agent: "codex" }, { template: "rev" });
  assert.deepEqual([viaTpl.template, viaTpl.argv], ["rev", null]);
  assert.deepEqual(workerArgs({ botId: ID, branch: "b", cwd: "/w", parent: "t1", template: "rev", task: "do it" }).slice(-2), ["rev", "do it"]);
});

test("#1045: --disable hooks rides a Codex start, restart, worker and tree helper; codexAuto false changes nothing (#1125)", (t) => {
  const hooksOff = (words) => {
    const at = words.indexOf("--disable");
    return at > 0 && words[at + 1] === "hooks";
  };
  const s = scene(t);
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  assert.equal(hooksOff(launched(runs(s.calls())[0])), true, "start");
  s.idle();
  assert.equal(s.cli(["restart", "Genie"]).code, 0);
  assert.equal(hooksOff(launched(runs(s.calls()).at(-1))), true, "restart");
  assert.equal(hooksOff(workerPlan(MAIN, { agent: "codex" }).argv), true, "worker");
  const get = { address: "t7", cwd: "/w", state: "live", argv: ["codex"], foreground: { argv: ["codex"], cwd: "/w" } };
  const worker = { agent: "codex", worktree: "/w" };
  assert.equal(hooksOff(helperPlan({ get, worker, agents: AGENTS, bot: MAIN }).argv), true, "helperPlan");
  // The retired opt-out changes nothing: both flags, on every launch.
  for (const words of [autoModeArgs("codex", { codexAuto: false }, ["codex"]),
    workerPlan({ ...MAIN, codexAuto: false }, { agent: "codex" }).argv,
    helperPlan({ get, worker, agents: AGENTS, bot: { codexAuto: false } }).argv]) {
    assert.equal(hooksOff(words), true, "codexAuto false");
    assert.equal(words.includes("--approve-for-me"), true, "codexAuto false keeps auto mode");
  }
});

test("codexAuto is validated: parseBots drops an invalid value with a warning, checkBots refuses it (#946)", () => {
  const text = (value) => JSON.stringify({ version: 1, categories: [], bots: [{ ...MAIN, codexAuto: value }] });
  const parsed = parseBots(text("false"));
  assert.match(parsed.warnings.join("\n"), /codexAuto is not a boolean; ignored/);
  assert.equal("codexAuto" in parsed.file.bots[0], false);
  assert.deepEqual(parseBots(text(false)).file.bots[0].codexAuto, false, "the explicit opt-out is kept");
  assert.deepEqual(parseBots(text(true)).file.bots[0].codexAuto, true);
  assert.deepEqual(checkBots(parseBots(text(false)).file), []);
  const bad = { version: 1, categories: [], bots: [{ ...MAIN, codexAuto: "no" }] };
  assert.deepEqual(checkBots(bad), [`${ID}: codexAuto is not a boolean`]);
});
