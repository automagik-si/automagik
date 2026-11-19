// #1558: a Claude Code bot seat turns off the features meant for a person at the keyboard: the
// suggested next prompt, the recap when a person returns and the progress summaries of running
// subagents. The two settings keys and the subagent variable ride on the launch's own
// `--settings` (inline JSON), never the host's settings file; a bot's `personFeatures: true`
// keeps them, and every other agent's launch is unchanged. Pure calls plus the CLI and a fake
// hc: the real hc, Claude Code and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_PERSON_SETTINGS, launchRun, withPersonFeatures } from "../mods/am-sidebar/models.js";
import { workerPlan } from "../mods/am-sidebar/workers.js";
import { restartPlan } from "../mods/am-sidebar/restart.js";
import { parseBots } from "../mods/am-sidebar/model.js";
import { readJsonLines } from "./log-lines.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const MAIN = "b-personaaaa";
const look = { character: "star", colour: "blue" };
const botOf = (agent = "claude", extra = {}) => ({ id: MAIN, name: "Primary", kind: "main", look, role: "r", instructions: "i", agent, ...extra });

function scene(t, { bots = [botOf()] } = {}) {
  const root = scratchRoot(t, "hb-person-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, join(home, ".claude"), join(app, "mods/am-sidebar")]) mkdirSync(d, { recursive: true });
  const project = scratchProject(root, "proj", { template: "" });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const botsPath = join(project, ".herdr/bots.json");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(botsPath, `${JSON.stringify({ version: 1, categories: [], bots }, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100 }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    GIT_CEILING_DIRECTORIES: root, AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "4000",
    AUTOMAGIK_HERDR_TAB_WAIT_MS: "300" };
  Object.assign(env, startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root }).env);
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const runs = () => readJsonLines(logPath).filter((c) => c[0] === "run");
  const stored = () => (existsSync(botsPath) ? JSON.parse(readFileSync(botsPath, "utf8")) : null);
  return { root, project, cli, runs, stored };
}

/** The settings object a launch's words carry, or null when it carries no --settings. */
function settingsOf(words) {
  const at = words.indexOf("--settings");
  return at < 0 ? null : JSON.parse(words[at + 1]);
}

test("#1558: a Claude bot's launch turns off prompt suggestions, away summaries and subagent progress summaries", () => {
  const words = launchRun("claude", ["claude"], botOf());
  const settings = settingsOf(words);
  assert.deepEqual(settings.promptSuggestionEnabled, false);
  assert.deepEqual(settings.awaySummaryEnabled, false);
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES, "1");
  assert.equal(settingsOf(["claude"]), null);
  assert.match(CLAUDE_PERSON_SETTINGS, /"promptSuggestionEnabled":false/);
});

test("#1558: the opt-out keeps them, and every other agent's launch is unchanged", () => {
  assert.deepEqual(launchRun("claude", ["claude"], botOf("claude", { personFeatures: true })),
    ["claude", "--permission-mode", "auto"]);
  const codex = launchRun("codex", ["codex"], botOf("codex"));
  assert.equal(codex.includes("--settings"), false);
  assert.ok(codex.includes("--approve-for-me"));
  assert.deepEqual(launchRun("dsh-tui", ["dsh-tui"], botOf("dsh-tui")), ["dsh-tui"]);
});

test("#1558: a run's own inline --settings is merged, never replaced; a settings file is left as it is", () => {
  const merged = withPersonFeatures("claude", ["claude", "--settings", '{"model":"opus","env":{"KEEP":"1"}}'], botOf());
  const settings = settingsOf(merged);
  assert.equal(settings.model, "opus", "the person's own key stays");
  assert.equal(settings.env.KEEP, "1");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES, "1");
  assert.deepEqual(withPersonFeatures("claude", ["claude", "--settings", "/home/u/.claude/settings.json"], botOf()),
    ["claude", "--settings", "/home/u/.claude/settings.json"], "a file is the person's own");
  assert.deepEqual(withPersonFeatures("claude", ["claude", "--", "hello"], botOf()),
    ["claude", "--settings", CLAUDE_PERSON_SETTINGS, "--", "hello"], "never after --");
});

test("#1558: a restart rebuilds the settings from the bot's current source, or leaves them off after the opt-out", () => {
  const bot = botOf();
  const fresh = restartPlan({ bot, run: launchRun("claude", ["claude"], bot), runningAgent: "claude", fresh: true });
  assert.equal(settingsOf(fresh.argv).promptSuggestionEnabled, false);
  const keptBot = botOf("claude", { personFeatures: true });
  const kept = restartPlan({ bot: keptBot, run: launchRun("claude", ["claude"], keptBot), runningAgent: "claude", fresh: true });
  assert.equal(kept.argv.includes("--settings"), false);
});

test("#1558: a Claude worker's launch takes the same settings", () => {
  const plan = workerPlan(botOf(), {});
  assert.deepEqual(settingsOf(plan.argv), JSON.parse(CLAUDE_PERSON_SETTINGS));
  const kept = workerPlan(botOf("claude", { personFeatures: true }), {});
  assert.equal(kept.argv.includes("--settings"), false);
});

test("#1558: personFeatures is a boolean in bots.json; a bad value is ignored", () => {
  const text = (personFeatures) => JSON.stringify({ version: 1, categories: [], bots: [
    { ...botOf(), look, personFeatures }] });
  assert.equal(parseBots(text(true)).file?.bots?.[0]?.personFeatures, true);
  const bad = parseBots(text("yes"));
  assert.equal(bad.file?.bots?.[0]?.personFeatures, undefined);
  assert.ok(bad.warnings.some((w) => /personFeatures is not a boolean/.test(w)));
});

test("#1558: am start records the settings on a Claude bot's launch", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Primary"]);
  assert.equal(r.code, 0, r.err);
  const [run] = s.runs();
  const words = run.slice(run.indexOf("--") + 1);
  const settings = settingsOf(words);
  assert.equal(settings.promptSuggestionEnabled, false, words.join(" "));
  assert.equal(settings.awaySummaryEnabled, false, words.join(" "));
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES, "1", words.join(" "));
});

test("#1558: am edit --person-features on keeps them, and off clears the field", (t) => {
  for (const [flag, keep] of [["on", true], ["off", false]]) {
    const s = scene(t);
    const r = s.cli(["edit", "Primary", "--person-features", flag]);
    assert.equal(r.code, 0, r.err);
    assert.equal(s.stored().bots[0].personFeatures, keep ? true : undefined, flag);
  }
  const s = scene(t);
  const bad = s.cli(["edit", "Primary", "--person-features", "maybe"]);
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.err, /--person-features is on or off/);
});

test("#1558: a bot that keeps them starts without the three switches", (t) => {
  const s = scene(t, { bots: [botOf("claude", { personFeatures: true })] });
  const r = s.cli(["start", "Primary"]);
  assert.equal(r.code, 0, r.err);
  const [run] = s.runs();
  const words = run.slice(run.indexOf("--") + 1);
  assert.equal(words.includes("--settings"), false, words.join(" "));
});
