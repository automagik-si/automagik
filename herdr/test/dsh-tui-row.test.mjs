// dsh-tui as an agent row (#598): Start, Restart and workers run it as the DSH lane fixed it
// (DSH 0.2.2-rc.1, dsh-tui 0.19.0). An interactive pane only, never a permission, add-dir or
// approval flag (the dsh-tui profile on that machine supplies the sandbox); the briefing, or a
// worker's task, is the first prompt after `--` and never starts with "-" (DSH drops a bare `--`
// and parses the next word: #591 review N4); `--resume <id>` when the session is known, `-c` only
// after a finished turn (the old pane's hc turn counter), nothing on --fresh; no --model and no
// --effort. Fake hc and scratch homes only: the real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A namespace, so each test fails on its own where a name is missing (the fail-before run on dev).
import * as models from "../mods/am-sidebar/models.js";
import { restartPlan } from "../mods/am-sidebar/restart.js";
import { GUARD_DIR, workerArgs, workerPlan } from "../mods/am-sidebar/workers.js";
import { approveProject, recordFileOf } from "../mods/am-sidebar/approved.js";
import { fixturePaneEdit } from "./fixture-pane-edit.mjs";
import { readJsonLines } from "./log-lines.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
const BRIEF = "<herdr-bot>\nYou are Genie.\n</herdr-bot>";
const ID = "b-genieaaaaa";
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const { AGENTS, BRIEFING_MARK, agentKeyOfArgv, briefingHook, briefingLaunch, briefingOwnConfig, briefingWay, canResume, promptArgs,
  resumeArgs, resumesById, withBriefing, withoutBriefing, withoutResume } = models;
const modelRefusal = (agent) => models.modelRefusal(agent);
const resumeAfterTurn = (agent) => models.resumeAfterTurn(agent);

// ---- the row (models.js) ----

test("dsh-tui is an agent Herdr starts as plain dsh-tui; no hook, no own-config prompt, no model or effort flag", () => {
  assert.deepEqual(AGENTS["dsh-tui"].run, ["dsh-tui"]);
  assert.equal(agentKeyOfArgv(["dsh-tui"]), "dsh-tui");
  assert.equal(agentKeyOfArgv(["/usr/bin/env", "PATH=/bin", "dsh-tui", "--resume", SID]), "dsh-tui");
  assert.equal(briefingWay("dsh-tui"), "prompt");
  assert.deepEqual([briefingHook("dsh-tui"), briefingOwnConfig("dsh-tui")], [false, false]);
  assert.match(modelRefusal("dsh-tui"), /^dsh-TUI takes no --model or --effort: its DSH profile on the machine it runs on sets both\.$/);
  assert.equal(modelRefusal("claude"), null);
  assert.equal(modelRefusal("omp"), null);
});

test("dsh-tui's briefing is the last words, after --, once; a reused command's old brief goes, its resume words stay before it", () => {
  const launch = briefingLaunch("dsh-tui", { text: BRIEF });
  assert.deepEqual(launch, { args: ["--", BRIEF], env: {} });
  assert.deepEqual(withBriefing("dsh-tui", ["dsh-tui"], launch), ["dsh-tui", "--", BRIEF]);
  assert.deepEqual(withBriefing("dsh-tui", ["dsh-tui", "--resume", SID], launch), ["dsh-tui", "--resume", SID, "--", BRIEF]);
  const old = `${BRIEFING_MARK}\nan older brief`;
  assert.deepEqual(withBriefing("dsh-tui", ["dsh-tui", "-c", "--", old], launch), ["dsh-tui", "-c", "--", BRIEF]);
  assert.deepEqual(withoutBriefing("dsh-tui", ["--resume", SID, "--", old]), ["--resume", SID]);
  // A person's own first prompt is theirs: only this pack's brief is taken out.
  assert.deepEqual(withoutBriefing("dsh-tui", ["--", "my own prompt"]), ["--", "my own prompt"]);
  // No launch (a file that couldn't be written, say): the old brief still goes, nothing in its place.
  assert.deepEqual(withBriefing("dsh-tui", ["dsh-tui", "--", old], null), ["dsh-tui"]);
  // Every other agent keeps its place: right after the executable.
  assert.deepEqual(withBriefing("omp", ["omp", "--continue"], briefingLaunch("omp", { text: BRIEF })), ["omp", `--append-system-prompt=${BRIEF}`, "--continue"]);
});

test("dsh-tui's first prompt never starts with \"-\": DSH would read it as a flag (#591 review N4)", () => {
  for (const text of ["--resume=x do this", "-c", "  -p hi", "-"]) {
    const [dashes, prompt] = briefingLaunch("dsh-tui", { text }).args;
    assert.equal(dashes, "--");
    assert.doesNotMatch(prompt, /^\s*-/, text);
    assert.ok(prompt.endsWith(text), "the text itself, whole, after a plain label");
    const [d2, task] = promptArgs("dsh-tui", text);
    assert.equal(d2, "--");
    assert.doesNotMatch(task, /^\s*-/, text);
    assert.ok(task.endsWith(text));
  }
  assert.deepEqual(promptArgs("dsh-tui", "fix the login bug"), ["--", "fix the login bug"], "a plain task is passed as it is");
  assert.deepEqual(promptArgs("omp", "-c"), ["-c"], "other agents unchanged");
});

test("dsh-tui resumes by id with --resume, else -c only after a finished turn; a reused command's resume words go", () => {
  assert.equal(canResume("dsh-tui"), true);
  assert.equal(resumesById("dsh-tui"), true);
  assert.deepEqual(resumeArgs("dsh-tui", SID), ["--resume", SID]);
  assert.deepEqual(resumeArgs("dsh-tui", null), ["-c"]);
  assert.equal(resumeAfterTurn("dsh-tui"), true);
  assert.equal(resumeAfterTurn("claude"), false);
  assert.deepEqual(withoutResume("dsh-tui", ["--resume", SID, "-c", "--continue", "--resume=x", "--", BRIEF]), ["--", BRIEF]);
  const bot = { agent: "dsh-tui" };
  assert.deepEqual(restartPlan({ bot, run: ["dsh-tui"], runningAgent: "dsh-tui", session: SID }).argv, ["dsh-tui", "--resume", SID]);
  assert.deepEqual(restartPlan({ bot, run: ["dsh-tui"], runningAgent: "dsh-tui", session: SID, fresh: true }).argv, ["dsh-tui"]);
});

test("a dsh-tui worker: its task is the prompt after --; --model or --effort is refused, not dropped", () => {
  const bot = { name: "Genie", agent: "dsh-tui" };
  const plan = workerPlan(bot, {});
  assert.deepEqual([plan.agent, plan.argv, plan.warnings], ["dsh-tui", ["dsh-tui"], []]);
  const args = workerArgs({ botId: ID, branch: "b", cwd: "/w", parent: "t1", agent: "dsh-tui", argv: plan.argv, task: "-c fix it" });
  const tail = args.slice(args.lastIndexOf("dsh-tui"));
  assert.equal(tail[1], "--");
  assert.doesNotMatch(tail[2], /^\s*-/);
  assert.equal(tail.length, 3);
  for (const pick of [{ model: "deepseek-v4" }, { effort: "high" }]) {
    assert.match(workerPlan(bot, pick).error, /^dsh-TUI takes no --model or --effort/, JSON.stringify(pick));
  }
  // A bot's worker defaults name a model or effort: refused for dsh-tui too, never silently dropped.
  assert.match(workerPlan({ ...bot, worker: { effort: "high" } }, {}).error, /^dsh-TUI takes no --model or --effort/);
  // Another agent's worker defaults never stop a dsh-tui worker (#600 review F4): a Claude captain
  // with a worker effort of "high" starts one with no error, and one warning line says the effort
  // was left out, as the model's does (#602 review); an effort it types is refused.
  const captain = { name: "Captain", agent: "claude", worker: { effort: "high", model: "opus" } };
  const fromClaude = workerPlan(captain, { agent: "dsh-tui" });
  assert.equal(fromClaude.error, undefined, fromClaude.error);
  assert.deepEqual([fromClaude.agent, fromClaude.effort, fromClaude.argv], ["dsh-tui", null, ["dsh-tui"]]);
  assert.deepEqual(fromClaude.warnings.filter((w) => /effort/.test(w)),
    ["Captain's worker effort high is for claude; dsh-tui runs its own default."], fromClaude.warnings.join());
  assert.match(workerPlan(captain, { agent: "dsh-tui", effort: "high" }).error, /^dsh-TUI takes no --model or --effort/);
  // Other agents keep warn-and-drop.
  const kimi = workerPlan({ name: "K", agent: "kimi" }, { effort: "high" });
  assert.equal(kimi.error, undefined);
  assert.match(kimi.warnings.join(), /has no effort flag/);
});

// ---- the CLI: start and restart a dsh-tui bot (fake hc) ----

function scene(t, { terminals = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-dshtui-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "proj"), bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [project, bin, home, join(app, "mods/am-sidebar")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", "--template=", project]);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(bin, "dsh-tui"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [
    { id: ID, name: "Genie", kind: "main", look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "dsh-tui" },
  ] }, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: terminals.map((x) => ({ cwd: project, ...x })), next: 100 }));
  writeFileSync(logPath, "");
  const env = { XDG_DATA_HOME: join(root, "data"), PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "4000", AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" };
  const cli = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const runs = () => readJsonLines(logPath).filter((c) => c[0] === "run");
  const approve = () => approveProject({ project, env, approvedBy: "tester" });
  return { root, project, app, cli, runs, approve, env };
}
/** The program words in an hc run call: after `--`, past `/usr/bin/env` and its VAR= words. */
const paneWords = (run) => {
  const w = run.slice(run.indexOf("--") + 1);
  if (w[0] !== "/usr/bin/env") return w;
  let i = 1;
  while (i < w.length && (/^[A-Z_]+=/.test(w[i]) || w[i] === "-u")) i += w[i] === "-u" ? 2 : 1;
  return w.slice(i);
};
/** The agent's own words, looking through the per-pane hc helper (#631 PR B). */
const agentWords = (run) => {
  const w = paneWords(run);
  const helper = w.findIndex((word) => /\/(?:hcPane\.mjs)$/.test(word));
  if (helper < 0) return w;
  const cut = w.indexOf("--", helper);
  return cut < 0 ? [] : w.slice(cut + 1);
};
/** Genie's live dsh-tui pane t5, idle, after `turn` turns; `session` its agent.session label. */
const pane = (s, { turn, session = null } = {}) => ({ address: "t5", name: "genie", state: "live", created_ms: 1700000000005, parent: null,
  labels: { bot: ID, role: "main", ...(session ? { "agent.session": session } : {}) }, ...(turn === undefined ? {} : { turn }),
  foreground: { argv: ["dsh-tui", "--", BRIEF], cwd: s.project, name: "dsh-tui" }, status: { app: "dsh-tui", state: "idle" } });
const withPane = (t, opts) => {
  const s = scene(t);
  const statePath = join(s.root, "hc.json");
  writeFileSync(statePath, JSON.stringify({ terminals: [{ cwd: s.project, ...pane(s, opts) }], next: 100 }));
  assert.equal(s.cli(["attach", "Genie", "t5"]).code, 0);
  return s;
};


test("M7: fixture pane edits cannot disable the approved switch at the next start or restart",
  { skip: process.platform !== "linux" }, (t) => {
  for (const remove of [false, true]) {
    const s = scene(t);
    assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
    s.approve();
    fixturePaneEdit(s, remove);
    const show = s.cli(["show", "Genie", "--json"]).json();
    assert.deepEqual(show.hcProxyState, { working: false, approved: true, error: null });
    assert.match(s.cli(["show", "Genie"]).out, /working off; approved on/);
    const doctor = s.cli(["dsh-tui", "doctor"]).out;
    assert.match(doctor, /hcProxy working off; approved on/);
    for (const verb of ["start", "restart"]) {
      const result = s.cli([verb, "Genie", "--force", "--json"]);
      assert.equal(result.code, 0, result.err);
      assert.match(paneWords(s.runs().at(-1))[2], /\/hcPane\.mjs$/);
    }
  }
});

test("working on requires approval before start or restart when approved off or missing",
  { skip: process.platform !== "linux" }, (t) => {
  for (const approval of ["missing", "off", "bot missing"]) {
    const s = scene(t);
    if (approval !== "missing") {
      if (approval === "bot missing") {
        const file = join(s.project, ".herdr/bots.json");
        const roster = JSON.parse(readFileSync(file));
        roster.bots[0].id = "b-otheraaaaa";
        writeFileSync(file, JSON.stringify(roster));
        s.approve();
        roster.bots[0].id = ID;
        writeFileSync(file, JSON.stringify(roster));
      } else s.approve();
    }
    assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
    for (const verb of ["start", "restart"]) {
      const result = s.cli([verb, "Genie", "--json"]);
      assert.notEqual(result.code, 0);
      assert.match(result.err, /run am proxy approve first/);
      assert.equal(result.err.trim().split("\n").length, 1);
    }
    assert.deepEqual(s.runs(), [], "no plain fallback");
  }
});

test("the same invalid record warns off to plain argv and refuses on for local starts and helpers",
  { skip: process.platform !== "linux" }, (t) => {
  for (const mode of ["start", "restart", "tree"]) {
    const s = mode === "start" ? scene(t) : withPane(t, { turn: 3, session: SID });
    const statePath = join(s.root, "hc.json");
    if (mode === "tree") {
      const worktree = join(s.project, ".claude/worktrees/task");
      mkdirSync(worktree, { recursive: true });
      const state = JSON.parse(readFileSync(statePath));
      state.terminals.push({ address: "t6", name: "helper", state: "live", created_ms: 6,
        cwd: worktree, parent: "t5", die_with_parent: true, labels: { "worker.of": ID },
        foreground: { argv: ["dsh-tui"], cwd: worktree, name: "dsh-tui" },
        status: { app: "dsh-tui", state: "idle" } });
      writeFileSync(statePath, JSON.stringify(state));
    }
    const attach = join(s.app, "automagik-herdr/attach.jsonl");
    const initialState = readFileSync(statePath);
    const initialAttach = existsSync(attach) ? readFileSync(attach) : null;
    const reset = () => {
      writeFileSync(statePath, initialState);
      if (initialAttach) writeFileSync(attach, initialAttach, { mode: 0o600 });
      else rmSync(attach, { force: true });
    };
    const args = mode === "start" ? ["start", "Genie", "--json"]
      : ["restart", "Genie", "--fresh", "--force", "--json",
        ...(mode === "tree" ? ["--tree"] : [])];
    const baseline = s.cli(args);
    assert.equal(baseline.code, 0, baseline.err);
    const count = mode === "tree" ? 2 : 1;
    const plain = s.runs().slice(-count);
    reset();
    assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
    const { path, record } = s.approve();
    assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "off"]).code, 0);
    const corrupt = JSON.stringify({ ...record, sha256: "invalid" });
    writeFileSync(path, corrupt);
    const off = s.cli(args);
    assert.equal(off.code, 0, off.err);
    assert.deepEqual(s.runs().slice(-count), plain, `${mode}: byte-equal plain argv`);
    assert.equal((off.err.match(/WARNING hc proxy:/g) ?? []).length, count);
    assert.ok(off.err.includes(path));
    assert.match(off.err, /does not match its sha256.*starting plain.*am proxy approve/);
    assert.doesNotMatch(off.out, /^WARNING hc proxy:/m, "warning goes to stderr");
    const doctor = s.cli(["dsh-tui", "doctor", "--json"]).json();
    const warning = doctor.checks.find((row) => row.check === "approved-roster");
    assert.equal(warning.warning, true);
    assert.ok(warning.detail.includes(recordFileOf(s.project, s.env)));
    assert.match(s.cli(["dsh-tui", "doctor"]).out, /WARN approved-roster:.*sha256/);
    reset();
    const before = s.runs().length;
    assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
    const on = s.cli(args);
    assert.notEqual(on.code, 0);
    assert.match(on.err, /does not match its sha256.*am proxy approve first/);
    assert.equal(s.runs().length, before, "working on starts no replacement pane");
    assert.equal(readFileSync(path, "utf8"), corrupt, "both sides used the same corrupt record");
  }
});

test("restart --tree keeps a dsh-tui helper proxied after its working switch is removed",
  { skip: process.platform !== "linux" }, (t) => {
  const s = withPane(t, { turn: 3, session: SID });
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
  s.approve();
  fixturePaneEdit(s, true);
  const worktree = join(s.project, ".claude/worktrees/task");
  mkdirSync(worktree, { recursive: true });
  const file = join(s.root, "hc.json");
  const state = JSON.parse(readFileSync(file));
  state.terminals.push({ address: "t6", name: "helper", state: "live", created_ms: 6,
    cwd: worktree, parent: "t5", die_with_parent: true, labels: { "worker.of": ID },
    foreground: { argv: ["dsh-tui"], cwd: worktree, name: "dsh-tui" },
    status: { app: "dsh-tui", state: "idle" } });
  writeFileSync(file, JSON.stringify(state));
  const result = s.cli(["restart", "Genie", "--tree", "--json"]);
  assert.equal(result.code, 0, result.err);
  const helper = paneWords(s.runs().at(-1));
  assert.match(helper[2], /\/hcPane\.mjs$/);
  assert.ok(helper.includes("--worker"));
  assert.ok(helper.includes(s.project), "main project approval, not the helper worktree");
});

test("L3: malformed roster keeps install checks and adds one failed roster row", (t) => {
  const s = scene(t);
  writeFileSync(join(s.project, ".herdr/bots.json"), "{broken");
  const result = s.cli(["dsh-tui", "doctor", "--json"]);
  assert.equal(result.code, 1);
  const report = result.json();
  assert.ok(report.checks.some((row) => row.check === "dsh-hc-proxy"));
  assert.equal(report.checks.filter((row) => row.check === "roster" && !row.ok).length, 1);
  assert.deepEqual(s.runs(), []);
});

test("start a dsh-tui bot: plain dsh-tui, its briefing after --; no permission, add-dir, approval, model or effort flag", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = agentWords(s.runs()[0]);
  assert.deepEqual(words.slice(0, 2), ["dsh-tui", "--"]);
  assert.equal(words.length, 3);
  assert.match(words[2], /^Genie - <herdr-bot>\n[^]*You are Genie, this project's main bot/);
  assert.equal(words.some((w) => /^--(permission|add-dir|approval|model|effort|sandbox)/.test(w)), false, words.join(" "));
});

test("a per-bot opt-in dsh-tui start runs the per-pane hc helper before DSH",
  { skip: process.platform !== "linux" }, (t) => {
  const s = scene(t);
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
  s.approve();
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = paneWords(s.runs()[0]);
  assert.equal(words[0], "/bin/sh");
  assert.match(words[1], /\/bin\/run\.sh$/);
  assert.match(words[2], /\/hcPane\.mjs$/);
  assert.deepEqual(words.slice(3, 7), ["--bot", ID, "--project", s.project]);
  const cut = words.indexOf("--", 3);
  assert.deepEqual(words.slice(cut + 1, cut + 3), ["dsh-tui", "--"]);
  assert.equal(s.runs()[0].includes("AM_HC_PROXY=1"), false, "the saved bot entry controls workers");
});

test("M4: switch off keeps the complete start argv byte for byte, even with AM_HC_PROXY=1", (t) => {
  const s = scene(t);
  const argv = (extra = {}) => {
    const state = join(s.root, "hc.json");
    writeFileSync(state, JSON.stringify({ terminals: [], next: 100 }));
    rmSync(join(s.app, "automagik-herdr", "attach.jsonl"), { force: true });
    assert.equal(s.cli(["start", "Genie", "--json"], extra).code, 0);
    return s.runs().at(-1);
  };
  const original = argv();
  // Re-recorded from dev (0524c6e1) after #729; only fixture folders normalised.
  // #747's C1 baseline differs only by the fixture bot's "Genie - " prompt prefix.
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/dsh-proxy-off-argv.json",
    import.meta.url), "utf8")).start;
  assert.deepEqual(original.map((word) => word.split(s.root).join("<root>")
    .split(GUARD_DIR).join("<guard>")), baseline);
  assert.deepEqual(paneWords(original).slice(0, 2), ["dsh-tui", "--"]);
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "off"]).code, 0);
  assert.deepEqual(argv({ AM_HC_PROXY: "1" }), original);
});

test("the switch is saved for one bot; invalid values do not write or start a pane", (t) => {
  const s = scene(t);
  const file = join(s.project, ".herdr/bots.json");
  const roster = JSON.parse(readFileSync(file, "utf8"));
  roster.bots.push({ ...roster.bots[0], id: "b-otheraaaaa", name: "Other", kind: "member" });
  writeFileSync(file, JSON.stringify(roster));
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
  assert.equal(s.cli(["show", "Genie", "--json"]).json().hcProxy, true);
  assert.equal(s.cli(["show", "Other", "--json"]).json().hcProxy, false);
  const before = readFileSync(file, "utf8");
  const bad = s.cli(["edit", "Genie", "--hc-proxy", "yes"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--hc-proxy is on or off/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(s.runs(), [], "editing a switch never starts or restarts a pane");
  assert.equal(s.cli(["start", "Other", "--json"], { AM_HC_PROXY: "1" }).code, 0);
  assert.equal(paneWords(s.runs().at(-1))[0], "dsh-tui");
});

test("doctor shows the saved switch and a missing proxy for the attached bot",
  { skip: process.platform !== "linux" }, (t) => {
  const s = withPane(t, { turn: 1 });
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
  s.approve();
  const before = readFileSync(join(s.project, ".herdr/bots.json"), "utf8");
  const report = s.cli(["dsh-tui", "doctor", "--json"]).json();
  assert.equal(report.bots[0].id, ID);
  assert.equal(report.bots[0].hcProxy, true);
  assert.equal(report.bots[0].terminal, "t5");
  assert.equal(report.bots[0].up, false);
  const check = report.checks.find((row) => row.check === `hc-proxy:${ID}`);
  assert.equal(check.ok, false);
  assert.match(check.detail, /hcProxy working on; approved on; proxy runtime path is unavailable/);
  assert.equal(readFileSync(join(s.project, ".herdr/bots.json"), "utf8"), before);
  assert.deepEqual(s.runs(), [], "doctor never starts a proxy or pane");
});

test("restart re-reads approval; off plus approve and restart restores the plain command",
  { skip: process.platform !== "linux" }, (t) => {
  const s = withPane(t, { turn: 3, session: SID });
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "on"]).code, 0);
  s.approve();
  assert.equal(s.cli(["restart", "Genie", "--json"]).code, 0);
  assert.match(paneWords(s.runs().at(-1))[2], /\/hcPane\.mjs$/);
  assert.deepEqual(agentWords(s.runs().at(-1)).slice(0, 4), ["dsh-tui", "--resume", SID, "--"]);
  assert.equal(s.cli(["edit", "Genie", "--hc-proxy", "off"]).code, 0);
  s.approve();
  const rollback = s.cli(["restart", "Genie", "--force", "--json"]);
  assert.equal(rollback.code, 0, rollback.err);
  assert.equal(paneWords(s.runs().at(-1))[0], "dsh-tui");
});

test("edit a dsh-tui bot's --model: refused with one clear line, nothing written", (t) => {
  const s = scene(t);
  const before = readFileSync(join(s.project, ".herdr/bots.json"), "utf8");
  const r = s.cli(["edit", "Genie", "--model", "deepseek-v4"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /dsh-TUI takes no --model or --effort: its DSH profile on the machine it runs on sets both\./);
  assert.equal(readFileSync(join(s.project, ".herdr/bots.json"), "utf8"), before);
});

test("edit a dsh-tui bot's --worker-model or --worker-effort: refused, nothing written", (t) => {
  for (const flag of ["--worker-model", "--worker-effort"]) {
    const s = scene(t);
    const before = readFileSync(join(s.project, ".herdr/bots.json"), "utf8");
    const r = s.cli(["edit", "Genie", flag, flag === "--worker-model" ? "deepseek-v4" : "high"]);
    assert.notEqual(r.code, 0, flag);
    assert.match(r.err, /--worker-model \/ --worker-effort: dsh-TUI takes no --model or --effort: its DSH profile on the machine it runs on sets both\./, flag);
    assert.equal(readFileSync(join(s.project, ".herdr/bots.json"), "utf8"), before, flag);
  }
});

test("restart a dsh-tui bot with a known session: dsh-tui --resume <id> -- <brief>; --fresh: no resume words", (t) => {
  const s = withPane(t, { turn: 3, session: SID });
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = agentWords(s.runs().at(-1));
  assert.deepEqual(words.slice(0, 4), ["dsh-tui", "--resume", SID, "--"]);
  assert.match(words[4], /^Genie - <herdr-bot>\n/);
  assert.equal(words.length, 5, "the brief once, last");
  // A known id resumes by id whatever the turn counter says: the guard is only for the id-less -c.
  const early = withPane(t, { turn: 0, session: SID });
  assert.equal(early.cli(["restart", "Genie", "--json"]).code, 0);
  assert.deepEqual(agentWords(early.runs().at(-1)).slice(0, 4), ["dsh-tui", "--resume", SID, "--"]);
  const f = withPane(t, { turn: 3, session: SID });
  assert.equal(f.cli(["restart", "Genie", "--fresh", "--json"]).code, 0);
  const fresh = agentWords(f.runs().at(-1));
  assert.deepEqual(fresh.slice(0, 2), ["dsh-tui", "--"]);
  assert.equal(fresh.some((w) => w === "-c" || w === "--continue" || w.startsWith("--resume")), false, fresh.join(" "));
});

test("restart a dsh-tui bot with no session id: -c after a finished turn; with none (turn 0 or no counter) a new conversation, said", (t) => {
  for (const turn of [1, 2]) {
    const done = withPane(t, { turn });
    const r = done.cli(["restart", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(agentWords(done.runs().at(-1)).slice(0, 3), ["dsh-tui", "-c", "--"], `turn ${turn}: one finished turn is enough`);
  }
  for (const turn of [0, undefined, "2"]) {
    const s = withPane(t, { turn });
    const out = s.cli(["restart", "Genie", "--json"]);
    assert.equal(out.code, 0, out.err);
    const words = agentWords(s.runs().at(-1));
    assert.deepEqual(words.slice(0, 2), ["dsh-tui", "--"], `turn ${turn}: ${words.join(" ")}`);
    assert.match(out.json().warnings.join("\n"), /Genie starts on a new conversation: dsh-TUI has no finished turn in t5 to continue\./, `turn ${turn}`);
    assert.equal(out.json().note, "dsh-TUI has no finished turn in t5 to continue");
  }
});
