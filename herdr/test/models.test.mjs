// Model detection (A12): the model a running agent uses, read from real foreground argv
// shapes seen on this host with `hc get <t> --json`, its configured default, the pin list
// and the flags Start passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { agModelsCacheText, agModelsPath, parseAgModelsOutput } from "../mods/am-sidebar/models.js";

import {
  AGENTS, AGY_MODE_DEFAULT, AGY_MODES, AGY_READ_ALLOW, AGY_SHELL_READ, AGY_WRITE_ALLOW, LEGACY_AGENTS,
  agentArgv, agentKeyOfArgv, agyModeArgs, agyModeOf, agyModeProblem, agySettingsDir, agySettingsPlan,
  configPaths, defaultModel, defaultModelFrom, detectModel, effortArgs, knownModels, knownModelsFrom,
  modelArgs, promptArgs, promptByMessage, resolveAgent, resumeArgs, shownModel, withOverrides,
} from "../mods/am-sidebar/models.js";
import { BRIEFINGS_DIR, briefingFileOf, briefingLaunch, briefingWay, ownPromptIn, resumedSessionOf, resumesConversation, tomlString,
  withBriefing, withoutBriefing } from "../mods/am-sidebar/models.js";
import { launchChange, paneCommand, paneLaunch, restartPlan } from "../mods/am-sidebar/restart.js";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";

const files = (map) => ({ home: "/h", read: (p) => map[p] ?? null });

test("claude: --model with a value, after other flags (t1bw's foreground argv)", () => {
  assert.equal(detectModel(["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5"], "claude"), "claude-opus-5-5");
  assert.equal(detectModel(["claude", "--model=claude-sonnet-5-5"], "claude"), "claude-sonnet-5-5");
  assert.equal(detectModel(["/Users/x/.local/bin/claude", "--model", "opus", "--effort", "high"], "claude"), "opus");
});

test("claude: no model flag, a resumed session, --fallback-model is not the model", () => {
  assert.equal(detectModel(["claude", "--resume", "de3aecdb-cb4b-4e5c-a320-38724f4a89a4", "--dangerously-skip-permissions"], "claude"), null);
  assert.equal(detectModel(["claude", "--fallback-model", "sonnet"], "claude"), null);
  assert.equal(detectModel(["claude", "--model"], "claude"), null);
});

test("codex: -m from the vendored binary path; -c model_* settings are not the model", () => {
  const argv = ["/n/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high"];
  assert.equal(detectModel(argv, "codex"), "gpt-6.1-sol");
  assert.equal(detectModel(["codex", "-c", "model_provider=proxy", "-c", "model_reasoning_effort=high"], "codex"), null);
  assert.equal(detectModel(["codex", "-c", 'model="o3"'], "codex"), "o3");
  assert.equal(detectModel(["codex", "--config", "model=gpt-6-astra"], "codex"), "gpt-6-astra");
  assert.equal(detectModel(["codex", "--model", "gpt-6-luna"], "codex"), "gpt-6-luna");
  assert.equal(detectModel(["codex", "-m", "a", "-m", "b"], "codex"), "b", "the last flag wins");
});

test("antigravity --model / --model= / Go's -model; omp under bun with --model; pi --model", () => {
  assert.equal(detectModel(["agy", "--model", "gemini-3.1-pro"], "antigravity"), "gemini-3.1-pro");
  assert.equal(detectModel(["agy", "--model=gemini-3.8-flash", "-i", "hi"], "antigravity"), "gemini-3.8-flash");
  assert.equal(detectModel(["/Users/x/.local/bin/agy", "-model", "claude-opus-5-5"]), "claude-opus-5-5", "found by argv");
  assert.equal(detectModel(["agy", "-m", "x"], "antigravity"), null, "agy has no -m");
  assert.equal(detectModel(["agy", "-i", "fix the build"], "antigravity"), null, "a first prompt is not a model");
  assert.equal(detectModel(["bun", "/Users/x/.bun/bin/omp", "--auto-approve", "--model", "zai/glm-5.3-flash"], "omp"), "zai/glm-5.3-flash");
  assert.equal(detectModel(["pi", "--model", "openai/gpt-4o"], "pi"), "openai/gpt-4o");
  assert.equal(detectModel(["omp", "--models", "a,b"], "omp"), null);
});

test("an agent with no known flags gives null; the argv's own agent is used when the key doesn't match", () => {
  assert.equal(detectModel(["amp", "--model", "x"], "amp"), null);
  assert.equal(detectModel(["codex", "-m", "gpt-6.1-sol"], "claude"), null, "claude has no -m");
  assert.equal(detectModel(["codex", "-m", "gpt-6.1-sol"], "amp"), "gpt-6.1-sol", "amp has no flags: the argv's agent decides");
  assert.equal(detectModel([], "claude"), null);
  assert.equal(detectModel(undefined, "claude"), null);
});

test("agentArgv skips interpreters and env assignments", () => {
  assert.deepEqual(agentArgv(["env", "FOO=1", "claude", "--x"]), { program: "claude", args: ["--x"] });
  assert.deepEqual(agentArgv(["node", "--no-warnings", "/a/codex.js", "-m", "m"]), { program: "codex", args: ["-m", "m"] });
  assert.equal(agentKeyOfArgv(["cursor-agent", "--model", "x"]), "cursor");
  assert.equal(agentKeyOfArgv(["zsh"]), null);
});

test("defaultModel reads Claude's settings.json, Codex's top-level config.toml model, Antigravity's settings", () => {
  const io = files({
    "/h/.claude/settings.json": JSON.stringify({ model: "sonnet" }),
    "/h/.codex/config.toml": 'approval = "never"\nmodel = "gpt-6.1-sol" # main\n[profiles.fast]\nmodel = "gpt-6-luna"\n',
    "/h/.gemini/antigravity-cli/settings.json": JSON.stringify({ model: "Gemini 3.1 Pro" }),
    "/h/.gemini/settings.json": JSON.stringify({ model: { name: "gemini-2.5-pro" } }),
  });
  assert.equal(defaultModel("claude", io), "sonnet");
  assert.equal(defaultModel("codex", io), "gpt-6.1-sol");
  assert.equal(defaultModel("antigravity", io), "Gemini 3.1 Pro");
  assert.equal(defaultModel("gemini", io), null, "gemini is retired: its settings are not read");
  assert.deepEqual(knownModels("antigravity", io), [], "a settings label is shown, never offered as a pin");
  // The pin list is the pack's cache of `agy models`, under the app home (#793): its ids,
  // never the settings label the CLI would reject.
  const table = readFileSync(new URL("./fixtures/agy/models-1.5.3.txt", import.meta.url), "utf8");
  const cache = agModelsCacheText(parseAgModelsOutput(table), "2026-11-09T12:00:00Z");
  const appIo = { home: "/h", appHome: "/app", read: (p) => ({ [agModelsPath("/app")]: cache }[p] ?? null) };
  const ids = knownModels("antigravity", appIo);
  assert.deepEqual(ids, parseAgModelsOutput(table).map((m) => m.id));
  assert.ok(ids.includes("gemini-4-argon-high") && ids.includes("claude-opus-5-5-high"), "Gemini and Claude ids");
  assert.ok(!ids.includes("Gemini 4 Argon (High)"), "the settings label is never a pin");
  assert.deepEqual(knownModels("antigravity", { ...appIo, appHome: "/none" }), [], "no cache: no list, no guess");
  assert.deepEqual(knownModelsFrom("antigravity", { antigravityModels: cache }), ids);
  assert.deepEqual(knownModelsFrom("antigravity", {}), []);
  assert.equal(defaultModel("amp", io), null);
  assert.equal(defaultModel("codex", files({ "/h/.codex/config.toml": '[profiles.fast]\nmodel = "gpt-6-luna"\n' })), null, "a profile's model is not the default");
  assert.equal(defaultModel("claude", files({ "/h/.claude/settings.json": "{not json" })), null);
  assert.equal(defaultModel("claude", files({})), null);
});

test("knownModels: Claude's list, Codex's model cache, plus the configured default; none for others", () => {
  const io = files({
    "/h/.codex/models_cache.json": JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }] }),
    "/h/.codex/config.toml": 'model = "gpt-6.1-terra"\n',
  });
  assert.ok(knownModels("claude", io).includes("claude-opus-5-5"));
  assert.ok(knownModels("claude", io).includes("opus"));
  assert.deepEqual(knownModels("codex", io), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"]);
  assert.deepEqual(knownModels("amp", io), []);
  assert.deepEqual(knownModels("codex", files({})), []);
});

test("modelArgs: each agent's own flag; nothing without a pin or a known flag", () => {
  assert.deepEqual(modelArgs("claude", "claude-opus-5-5"), ["--model", "claude-opus-5-5"]);
  assert.deepEqual(modelArgs("codex", "gpt-6.1-sol"), ["--model", "gpt-6.1-sol"]);
  assert.deepEqual(modelArgs("omp", "zai/glm-5.3-flash"), ["--model=zai/glm-5.3-flash"]);
  assert.deepEqual(modelArgs("amp", "x"), []);
  assert.deepEqual(modelArgs("claude", undefined), []);
  // What Start passes is what detection reads back.
  for (const [agent, model] of [["claude", "opus"], ["codex", "gpt-6-astra"], ["antigravity", "gemini-3.1-pro"], ["omp", "a/b"], ["pi", "c"]]) {
    assert.equal(detectModel([AGENTS[agent].run[0], ...modelArgs(agent, model)], agent), model);
  }
});

test("shownModel: a running bot shows what runs (detected, else the default, never a pin it wasn't started with); a stopped one its pin", () => {
  assert.deepEqual(shownModel({ argv: ["claude", "--model", "opus"], agentKey: "claude", pinned: "sonnet", fallback: "haiku" }), { model: "opus", source: "detected" });
  assert.deepEqual(shownModel({ argv: ["claude"], agentKey: "claude", pinned: "sonnet", fallback: "haiku" }), { model: "haiku", source: "default" });
  assert.deepEqual(shownModel({ argv: null, agentKey: "claude", pinned: "sonnet", fallback: "haiku" }), { model: "sonnet", source: "pinned" });
  assert.deepEqual(shownModel({ argv: null, agentKey: "claude", fallback: "haiku" }), { model: "haiku", source: "default" });
  assert.deepEqual(shownModel({ agentKey: "amp" }), { model: null, source: null });
});

test("withOverrides: programs.json overrides run and adds agents with a run", () => {
  const t = withOverrides(JSON.stringify({ programs: { claude: { run: ["my-claude"] }, omp: { name: "Oh My Pi", icon: "x" }, mine: { name: "Mine", run: ["mine", "--go"] }, nope: { icon: "y" } } }));
  assert.deepEqual(t.claude.run, ["my-claude"]);
  assert.deepEqual(t.omp.run, ["omp"]);
  assert.deepEqual(t.mine.run, ["mine", "--go"]);
  assert.equal(t.nope, undefined);
  assert.deepEqual(withOverrides("{bad").claude.run, ["claude"]);
  assert.deepEqual(AGENTS.claude.run, ["claude"], "the shipped table is untouched");
});

test("the *From variants take pre-read texts (the mod's async readTextFile), by configPaths' names", () => {
  const p = configPaths("/h");
  assert.equal(p.claudeSettings, "/h/.claude/settings.json");
  assert.equal(p.codexModels, "/h/.codex/models_cache.json");
  assert.equal(defaultModelFrom("claude", { claudeSettings: '{"model":"opus"}' }), "opus");
  assert.equal(defaultModelFrom("codex", { codexConfig: 'model = "gpt-6-luna"' }), "gpt-6-luna");
  assert.equal(defaultModelFrom("claude", {}), null);
  assert.deepEqual(knownModelsFrom("codex", { codexModels: '{"models":[{"slug":"a"}]}', codexConfig: 'model = "b"' }), ["a", "b"]);
  assert.ok(knownModelsFrom("claude").includes("claude-opus-5-5"));
  // A Promise where a text belongs (an un-awaited async read) is no text, never a throw.
  assert.equal(defaultModelFrom("claude", { claudeSettings: Promise.resolve("{}") }), null);
});

test("antigravity replaces gemini: agy argv is antigravity, gemini resolves to it, configPaths reads agy's settings", () => {
  assert.equal(AGENTS.gemini, undefined);
  assert.deepEqual(AGENTS.antigravity.run, ["agy"]);
  assert.equal(agentKeyOfArgv(["agy", "-i", "hello"]), "antigravity");
  assert.equal(agentKeyOfArgv(["/Users/x/.local/bin/agy", "--continue"]), "antigravity");
  assert.equal(agentKeyOfArgv(["gemini"]), null, "a gemini pane is no longer a known agent");
  assert.deepEqual(modelArgs("antigravity", "gemini-3.1-pro"), ["--model", "gemini-3.1-pro"]);
  assert.deepEqual(LEGACY_AGENTS, { gemini: "antigravity" });
  assert.equal(resolveAgent("gemini"), "antigravity");
  assert.equal(resolveAgent("agy"), "antigravity");
  assert.equal(resolveAgent("antigravity"), "antigravity");
  assert.equal(resolveAgent("gemini", withOverrides(JSON.stringify({ programs: { gemini: { run: ["gemini"] } } }))), "gemini",
    "a programs.json that adds gemini back keeps it");
  assert.equal(configPaths("/h").antigravitySettings, "/h/.gemini/antigravity-cli/settings.json");
  assert.equal(configPaths("/h").geminiSettings, undefined);
});

test("kimi 2.5.0 takes no first prompt on its command line (#1032): promptArgs gives it no word, every other agent's is as it was", () => {
  // kimi 2.5.0's --help: `Usage: kimi [options] [command]`. A bare word is a command name
  // (`unknown command '<word>'. See 'kimi --help'.`, exit 1), and `-p, --prompt <prompt>` is its
  // one-shot print mode, never an interactive start. The task is sent as its first message.
  assert.deepEqual(promptArgs("kimi", "You are a read-only reviewer of src/x.rs"), []);
  assert.deepEqual(promptArgs("kimi", "-p looks like an option"), [], "whatever the task says");
  assert.equal(promptByMessage("kimi"), true);
  // Every other agent Herdr knows still takes its task as a word: its own flag or the bare task.
  const own = { antigravity: ["-i", "fix the build"], "dsh-tui": ["--", "fix the build"] };
  for (const key of Object.keys(AGENTS).filter((k) => k !== "kimi")) {
    assert.deepEqual(promptArgs(key, "fix the build"), own[key] ?? ["fix the build"], key);
    assert.equal(promptByMessage(key), false, key);
  }
  assert.deepEqual(promptArgs(undefined, "fix the build"), ["fix the build"], "no agent named: the bare task");
  assert.equal(promptByMessage(undefined), false, "no agent named: a template or a plain command keeps its task word");
  assert.equal(promptByMessage(null), false);
});

test("agy 1.5.3's flags: --model/-model, --effort, --mode auto by default, -i/--prompt-interactive, -c/--continue, --conversation", () => {
  // What the fixture help (test/fixtures/agy/help-1.5.3.txt) says, and what Start, a worker
  // and Restart pass: the same words, no guessed one.
  assert.deepEqual(modelArgs("antigravity", "gemini-4-argon-high"), ["--model", "gemini-4-argon-high"]);
  assert.deepEqual(effortArgs("antigravity", "xhigh"), ["--effort", "xhigh"]);
  assert.deepEqual(promptArgs("antigravity", "fix the build"), ["-i", "fix the build"]);
  assert.deepEqual(resumeArgs("antigravity", "3f1c2d4e-0000-4000-8000-000000000001"), ["--conversation", "3f1c2d4e-0000-4000-8000-000000000001"]);
  assert.deepEqual(resumeArgs("antigravity"), ["--continue"]);
  // The execution mode is always named for Antigravity: auto unless the roster says otherwise.
  assert.deepEqual(agyModeArgs("antigravity"), ["--mode", AGY_MODE_DEFAULT]);
  assert.deepEqual(agyModeArgs("antigravity", null), ["--mode", "auto"]);
  for (const mode of AGY_MODES) {
    assert.equal(agyModeProblem(mode), null, mode);
    assert.deepEqual(agyModeArgs("antigravity", mode), ["--mode", mode], mode);
  }
  assert.equal(agyModeOf(""), "auto");
  assert.equal(agyModeOf(undefined), "auto");
  assert.equal(agyModeOf("plan"), "plan");
  assert.equal(agyModeProblem("yolo"), 'Antigravity mode "yolo" isn\'t one of accept-edits, auto, plan.');
  // Every other agent's launch line stays byte-identical: no mode words at all.
  for (const key of Object.keys(AGENTS).filter((k) => k !== "antigravity")) assert.deepEqual(agyModeArgs(key, "plan"), [], key);
  const words = [...agyModeArgs("antigravity", "accept-edits"), ...modelArgs("antigravity", "claude-sonnet-5-5-high"),
    ...effortArgs("antigravity", "max"), ...promptArgs("antigravity", "t")];
  assert.ok(words.includes("--mode"), words.join(" "));
  for (const flag of ["--dangerously-skip-permissions", "--sandbox"]) assert.ok(!words.includes(flag), flag);
});

// ---- the briefing at launch (each agent's own system-prompt mechanism) ----

const BRIEF = "<herdr-bot>\nYou are Genie.\n</herdr-bot>";
const FILE = `/app/${BRIEFINGS_DIR}/0123456789-b-aaaaaaaaaa.md`;

test("briefing at launch: each agent's verified way; the others get none, never a guessed flag", () => {
  assert.deepEqual(briefingLaunch("claude", { path: FILE, text: BRIEF }), { args: ["--append-system-prompt-file", FILE], env: {} });
  assert.equal(briefingLaunch("claude", { text: BRIEF }), null, "no file written: no flag (a missing file stops Claude Code)");
  assert.deepEqual(briefingLaunch("codex", { text: BRIEF }).args, ["-c", `developer_instructions=${JSON.stringify(BRIEF)}`]);
  assert.deepEqual(briefingLaunch("omp", { text: BRIEF }).args, [`--append-system-prompt=${BRIEF}`]);
  assert.deepEqual(briefingLaunch("pi", { text: BRIEF }).args, ["--append-system-prompt", BRIEF]);
  assert.deepEqual(briefingLaunch("grok", { text: BRIEF }).args, ["--rules", BRIEF]);
  assert.deepEqual(briefingLaunch("hermes", { text: BRIEF }), { args: [], env: { HERMES_EPHEMERAL_SYSTEM_PROMPT: BRIEF } });
  for (const key of ["antigravity", "cursor", "opencode", "kimi", "copilot", "amp", "kiro", "qoder", "crush"]) {
    assert.equal(briefingWay(key), null, key);
    assert.equal(briefingLaunch(key, { path: FILE, text: BRIEF }), null, key);
  }
});

test("withBriefing: right after the executable (codex's -c before resume), an old copy replaced, a person's own words kept", () => {
  const claude = briefingLaunch("claude", { path: FILE });
  assert.deepEqual(withBriefing("claude", ["claude", "--model", "m", "--resume", "s"], claude),
    ["claude", "--append-system-prompt-file", FILE, "--model", "m", "--resume", "s"]);
  const again = withBriefing("claude", withBriefing("claude", ["claude", `--append-system-prompt-file=${FILE}`], claude), claude);
  assert.deepEqual(again, ["claude", "--append-system-prompt-file", FILE], "never twice");
  assert.deepEqual(withBriefing("claude", ["claude", "--append-system-prompt-file", "/mine.md"], claude),
    ["claude", "--append-system-prompt-file", FILE, "--append-system-prompt-file", "/mine.md"], "a person's own file stays");
  const codex = briefingLaunch("codex", { text: BRIEF });
  const old = ["node", "/x/codex.js", "-c", `developer_instructions=${JSON.stringify("<herdr-bot>old")}`, "-c", "model=o3", "resume", "--last"];
  assert.deepEqual(withBriefing("codex", old, codex), ["node", "/x/codex.js", ...codex.args, "-c", "model=o3", "resume", "--last"]);
  assert.deepEqual(withBriefing("codex", ["codex", "-c", "developer_instructions=\"mine\""], codex),
    ["codex", ...codex.args, "-c", "developer_instructions=\"mine\""]);
  assert.deepEqual(withBriefing("grok", ["grok", "--rules", "<herdr-bot>old"], briefingLaunch("grok", { text: BRIEF })), ["grok", "--rules", BRIEF]);
  // Taken out when this start has none (a file that couldn't be written): never a stale path.
  assert.deepEqual(withBriefing("claude", ["claude", "--append-system-prompt-file", FILE, "-c"], null), ["claude", "-c"]);
  // A command that doesn't run the agent (a shell line) is left as it is.
  assert.deepEqual(withBriefing("claude", ["sh", "-c", "claude --x"], claude), ["sh", "-c", "claude --x"]);
  assert.deepEqual(withoutBriefing("claude", ["--", "--append-system-prompt-file", FILE]), ["--", "--append-system-prompt-file", FILE]);
});

test("briefingFileOf and resumesConversation: what the hook reads from a pane's command", () => {
  assert.equal(briefingFileOf(["claude", "--append-system-prompt-file", FILE, "--continue"]), FILE);
  assert.equal(briefingFileOf(["/usr/local/bin/claude", `--append-system-prompt-file=${FILE}`]), FILE);
  assert.equal(briefingFileOf(["claude", "--append-system-prompt-file", "/mine.md"]), null);
  assert.equal(briefingFileOf(["codex", "--append-system-prompt-file", FILE]), null);
  assert.equal(briefingFileOf(["claude"]), null);
  assert.equal(resumesConversation("claude", ["claude", "--append-system-prompt-file", FILE, "--resume", "s"]), true);
  assert.equal(resumesConversation("claude", ["claude", "-c"]), true);
  assert.equal(resumesConversation("claude", ["claude", "--append-system-prompt-file", FILE]), false);
});

test("restartPlan no longer reuses a pane's command: its briefing words don't change the source's launch (#597)", () => {
  const bot = { agent: "omp" };
  const launch = { argv: ["omp", "--thinking=high", `--append-system-prompt=${BRIEF}`] };
  const plan = restartPlan({ bot, run: ["omp"], runningAgent: "omp", session: null, launch });
  assert.deepEqual(plan.argv, ["omp", "--continue"]);
  // The pane's own flags are what launchChange names, its briefing words are no difference.
  assert.deepEqual(paneLaunch(launch, "omp"), ["omp", "--thinking=high"]);
  assert.match(launchChange({ name: "Dev", launch, agent: "omp", argv: plan.source }), /Dev: its pane's command differs from its source now \(drops --thinking=\*\*\*\)/);
});

test("tomlString: JSON's escapes, plus U+007F escaped and lone surrogates replaced (TOML rejects both)", () => {
  assert.equal(tomlString('a"b\\c\nd'), JSON.stringify('a"b\\c\nd'));
  assert.equal(tomlString("x\x7fy"), '"x\\u007fy"');
  assert.equal(tomlString("p\ud800q\udc00r"), '"p�q�r"');
  assert.equal(tomlString("ok 😀"), '"ok 😀"', "a real pair stays");
  assert.equal(briefingLaunch("codex", { text: "<herdr-bot>\x7f" }).args[1], 'developer_instructions="<herdr-bot>\\u007f"');
});

test("ownPromptIn: codex's developer_instructions, hermes' personality or agent.system_prompt; empty values don't count", () => {
  assert.equal(ownPromptIn("codex", 'model = "o3"\ndeveloper_instructions = "mine"\n'), true);
  assert.equal(ownPromptIn("codex", 'model = "o3"\n[profiles.x]\nmodel = "y"\n'), false);
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt: Be terse.\n"), true);
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt: |\n    Long one.\n"), true);
  assert.equal(ownPromptIn("hermes", "display:\n  personality: pirate\n"), true);
  assert.equal(ownPromptIn("hermes", 'display:\n  personality: ""\n  personalities:\n    pirate: Arr\nagent:\n  system_prompt: \'\'\n'), false);
  assert.equal(ownPromptIn("hermes", null), false);
  assert.equal(ownPromptIn("omp", "system_prompt: x"), false);
});

test("resumedSessionOf: the id a Claude command resumes, null for --continue, undefined for none", () => {
  assert.equal(resumedSessionOf("claude", ["claude", "--resume", "s-1"]), "s-1");
  assert.equal(resumedSessionOf("claude", ["claude", "-r", "s-1", "--model", "m"]), "s-1");
  assert.equal(resumedSessionOf("claude", ["claude", "--resume=s-1"]), "s-1");
  assert.equal(resumedSessionOf("claude", ["claude", "--continue"]), null);
  assert.equal(resumedSessionOf("claude", ["claude", "--resume", "--model", "m"]), null, "a bare --resume picks one");
  assert.equal(resumedSessionOf("claude", ["claude", "--model", "m"]), undefined);
});

test("restart of a hermes bot fed the whole command Start gave it (env PATH, briefing variable): the source's command, not --yolo (#597)", () => {
  const args = startArgs({ botId: "b-aaaaaaaaaa", cwd: "/p", parent: ["--no-parent"], argv: ["hermes", "--yolo"], path: "/bin",
    env: { HERMES_EPHEMERAL_SYSTEM_PROMPT: BRIEF } });
  const launch = paneCommand({ argv: args.slice(args.indexOf("--") + 1) });
  assert.deepEqual(launch, { argv: ["hermes", "--yolo"] }, "the whole env prefix dropped, the program found");
  const plan = restartPlan({ bot: { agent: "hermes" }, run: ["hermes"], runningAgent: "hermes", session: null, launch });
  assert.deepEqual(plan.argv, ["hermes", "--continue"]);
  assert.match(launchChange({ name: "Dev", launch, agent: "hermes", argv: plan.source }), /Dev: its pane's command differs from its source now \(drops --yolo\)/);
  // A person's own env line (not this pack's PATH prefix) is left as it is.
  assert.deepEqual(paneCommand({ argv: ["/usr/bin/env", "FOO=1", "hermes"] }), { argv: ["/usr/bin/env", "FOO=1", "hermes"] });
});

test("ownPromptIn, hermes: a value on the lines below the key counts; a key followed by a sibling doesn't", () => {
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt:\n    Be terse,\n    always.\n"), true);
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt: # mine\n    Be terse.\n"), true);
  assert.equal(ownPromptIn("hermes", "display:\n  personality: pirate # arr\n"), true);
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt:\n  model: x\n"), false, "empty: null in YAML");
  assert.equal(ownPromptIn("hermes", "agent:\n  system_prompt:\n"), false);
});

test("Antigravity #840: default read-only shell tools in writer and read-only --settings plans; no shell launchers", () => {
  const shellRead = [
    "ls", "cat", "head", "tail", "grep", "wc", "diff", "pwd", "echo", "cut", "tr", "jq", "printf",
    "basename", "dirname", "true", "which", "stat", "realpath", "readlink", "date", "nl", "comm",
    "column",
  ];
  const writerOnly = [
    "command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)",
  ];
  const forbidden = [
    "command(bash)", "command(sh)", "command(env)", "command(xargs)",
    "command(find)", "command(awk)", "command(tee)", "command(sed)",
  ];
  assert.deepEqual(AGY_SHELL_READ, shellRead);
  for (const bad of forbidden) {
    assert.equal(AGY_WRITE_ALLOW.includes(bad), false, `AGY_WRITE_ALLOW must not include ${bad}`);
    assert.equal(AGY_READ_ALLOW.includes(bad), false, `AGY_READ_ALLOW must not include ${bad}`);
  }
  const bot = { id: "b-aaaaaaaaaa", name: "Genie", agent: "antigravity" };
  const dir = agySettingsDir("/app");
  const writerSeat = JSON.parse(agySettingsPlan({ bot, scope: "seat", folder: "/work/proj", settingsDir: dir }).text).permissions;
  const reviewerSeat = JSON.parse(agySettingsPlan({
    bot: { ...bot, rank: "reviewer" }, scope: "seat", folder: "/work/proj", settingsDir: dir,
  }).text).permissions;
  const writerWorker = JSON.parse(agySettingsPlan({
    bot, scope: "worker", role: "dev", folder: "/work/wt", settingsDir: dir,
  }).text).permissions;
  const reviewWorker = JSON.parse(agySettingsPlan({
    bot, scope: "worker", role: "review", folder: "/work/wt", settingsDir: dir,
  }).text).permissions;
  for (const perms of [writerSeat, reviewerSeat, writerWorker, reviewWorker]) {
    for (const tool of shellRead) {
      assert.ok(perms.allow.includes(`command(${tool})`), `missing command(${tool})`);
    }
    for (const bad of forbidden) {
      assert.equal(perms.allow.includes(bad), false, `forbidden ${bad}`);
    }
  }
  for (const perms of [writerSeat, writerWorker]) {
    assert.ok(perms.allow.includes("command(hc)"));
    for (const rule of writerOnly) assert.ok(perms.allow.includes(rule), `writer includes ${rule}`);
  }
  for (const perms of [reviewerSeat, reviewWorker]) {
    for (const rule of ["command(hc ls)", "command(hc get)", "command(hc read)", "command(hc wait)", "command(hc send)"]) {
      assert.ok(perms.allow.includes(rule), `read-only includes ${rule}`);
    }
    for (const rule of ["command(hc)", "command(hc run)", "command(hc exec)", ...writerOnly]) {
      assert.equal(perms.allow.includes(rule), false, `read-only excludes ${rule}`);
    }
    assert.equal(perms.allow.some((r) => r.startsWith("write_file(")), false);
  }
});
