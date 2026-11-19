// #1491: what a Claude bot's stored pin starts with, through the CLI and the fake hc: the
// `hc run` argv carries `--model` and the exact id, for a pin made before the accepted-versus-
// offered split (claude-fable-5-1, claude-opus-5-5) and for the current ones (claude-fable-5-2
// and its 1M-context form, whose brackets are glob characters). Uses only what the base already
// had, so this file runs byte-identical on the base and on the change (the PR names both runs).
// Near-miss words are refused by create and edit, with nothing written. Fake hc, a scratch home;
// the real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJsonLines } from "./log-lines.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const MAIN = "b-pinsaaaaaa";
const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PINS = ["claude-fable-5-1", "claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-2[1m]"];
const NEAR = ["claude-fable-5", "claude-fable-5-2[1", "claude-fable-5-2-x", "claude-fable-5-2[1m]x", "claude-fable-5-2[2m]",
  "Claude-Fable-5-2", "CLAUDE-FABLE-5-2[1M]", " claude-fable-5-2"];
const look = { character: "star", colour: "blue" };
const mainBot = (extra = {}) => ({ id: MAIN, name: "Primary", kind: "main", look, role: "r", instructions: "i", agent: "claude", ...extra });

/**
 * A scratch world on this computer: fake hc (with `terminals`), stand-in claude, a Claude
 * settings default (`def`, null: no settings file), the project's bots (`bots`, null: none).
 */
function scene(t, { bots = null, def = "sonnet", terminals = [] } = {}) {
  const root = scratchRoot(t, "hb-pins-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, join(home, ".claude"), join(app, "mods/am-sidebar")]) mkdirSync(d, { recursive: true });
  const project = scratchProject(root, "proj", { template: "" });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  if (def !== null) writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: def }));
  const botsPath = join(project, ".herdr/bots.json");
  if (bots) {
    mkdirSync(join(project, ".herdr"), { recursive: true });
    writeFileSync(botsPath, `${JSON.stringify({ version: 1, categories: [], bots }, null, 2)}\n`);
  }
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: terminals.map((x) => ({ cwd: project, ...x })), next: 100 }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    GIT_CEILING_DIRECTORIES: root, AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "4000",
    AUTOMAGIK_HERDR_TAB_WAIT_MS: "300" };
  // #1497: the core-id lookup reads a fake core's socket, never hc's default one (the runner's own).
  Object.assign(env, startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root }).env);
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const runs = () => readJsonLines(logPath).filter((c) => c[0] === "run");
  const stored = () => (existsSync(botsPath) ? JSON.parse(readFileSync(botsPath, "utf8")) : null);
  const botsText = () => (existsSync(botsPath) ? readFileSync(botsPath, "utf8") : null);
  return { root, project, cli, runs, stored, botsText, botsPath };
}

/** The words after hc run's `--` that follow `--model`, and how many `--model` words there are. */
const modelOf = (run) => {
  const words = run.slice(run.indexOf("--") + 1);
  return { count: words.filter((w) => w === "--model").length, id: words[words.indexOf("--model") + 1] };
};

for (const pin of PINS) {
  test(`#1491 a stored ${pin} pin starts with --model and that exact id`, (t) => {
    const s = scene(t, { bots: [mainBot({ model: pin })] });
    const r = s.cli(["start", "Primary"]);
    assert.equal(r.code, 0, r.err);
    const [run] = s.runs();
    assert.deepEqual(modelOf(run), { count: 1, id: pin }, run.join(" "));
  });
}

test("#1491 restart of a bot pinned to the 1M id: the new pane's argv carries the exact id", (t) => {
  const old = { address: "t5", name: "t5", state: "live", parent: null, created_ms: 1,
    labels: { bot: MAIN, role: "main", "agent.session": SID }, foreground: { argv: ["claude"] }, status: { app: "claude-code", state: "idle" } };
  const s = scene(t, { bots: [mainBot({ model: "claude-fable-5-2[1m]" })], terminals: [old] });
  const r = s.cli(["restart", "Primary"]);
  assert.equal(r.code, 0, r.err);
  const [run] = s.runs();
  assert.deepEqual(modelOf(run), { count: 1, id: "claude-fable-5-2[1m]" }, run.join(" "));
});

test("#1491 edit keeps accepting the older Fable id, and create the plain current one", (t) => {
  const s = scene(t, { bots: [mainBot()] });
  const edited = s.cli(["edit", MAIN, "--model", "claude-fable-5-1"]);
  assert.equal(edited.code, 0, edited.err);
  assert.equal(s.stored().bots[0].model, "claude-fable-5-1");
  const fresh = scene(t);
  const made = fresh.cli(["create", "--name", "Primary", "--agent", "claude", "--model", "claude-fable-5-2"]);
  assert.equal(made.code, 0, made.err);
  assert.equal(fresh.stored().bots[0].model, "claude-fable-5-2");
});

for (const def of [null, "claude-opus-5-5"]) {
  test(`#1491 near-miss words are refused by create and edit, nothing written (default ${def ?? "absent"})`, (t) => {
    for (const word of NEAR) {
      const fresh = scene(t, { def });
      const made = fresh.cli(["create", "--name", "Primary", "--agent", "claude", `--model=${word}`]);
      assert.equal(made.code, 1, `create ${JSON.stringify(word)}: ${made.err}`);
      assert.match(made.err, /isn't a known claude model/);
      assert.equal(existsSync(fresh.botsPath), false, "nothing written");
      const s = scene(t, { def, bots: [mainBot({ model: "claude-fable-5-1" })] });
      const before = s.botsText();
      const edited = s.cli(["edit", MAIN, `--model=${word}`]);
      assert.equal(edited.code, 1, `edit ${JSON.stringify(word)}: ${edited.err}`);
      assert.match(edited.err, /isn't a known claude model/);
      assert.equal(s.botsText(), before, "nothing written");
    }
  });
}

test("#1491 a start on a linked machine of a bot pinned to the 1M id: hc run --on carries the exact id", (t) => {
  const root = scratchRoot(t, "hb-pins-remote-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vm, vmBin]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(vmBin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "uname"), "#!/bin/sh\necho Linux\n");
  exe(join(vmBin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  const project = scratchProject(vm, "pins", { bots: { version: 1, categories: [], bots: [mainBot({ model: "claude-fable-5-2[1m]" })] } });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ next: 100, terminals: [],
    machines: [{ name: "vm", id: "core-of-vm", state: "connected", uname: "Linux x86_64", home: vm, path: vmBin }] }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    // Ordinary non-orchestrated launch: no caller identity (#1635).
    XDG_DATA_HOME: "", GIT_CEILING_DIRECTORIES: root, AUTOMAGIK_HERDR_TAB_WAIT_MS: "300", HC_TERMINAL_ID: "" };
  // #1497: the core-id lookup reads a fake core's socket, never hc's default one (the runner's own).
  Object.assign(env, startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root }).env);
  const r = spawnSync(process.execPath, [CLI, "start", "Primary", "--machine", "vm", "--project", project], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const run = readJsonLines(logPath).find((c) => c[0] === "run");
  assert.deepEqual(run.slice(0, 3), ["run", "--on", "vm"]);
  assert.deepEqual(modelOf(run), { count: 1, id: "claude-fable-5-2[1m]" }, run.join(" "));
});
