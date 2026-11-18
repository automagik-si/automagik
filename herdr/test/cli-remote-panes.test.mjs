// automagik-herdr's pane commands on a linked machine (automagik#206 part b): start, attach,
// detach, restart and whois with --machine, against fake-hc's linked machine "vm" (a scratch
// home; its terminals are "vm/tN"). Shaped on the Atlas bot on lab: a Hermes pane under hc's
// keep wrapper, reporting no status. The ledger rows keep the bare terminal, `machine` and that
// machine's core id (bots.attach-ledger@1); whois keeps its shape (bots.whois-json@1). No call
// ever sends a pane keys. The real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { GUARD_DIR, KILL_GUARD_DIR } from "../mods/am-sidebar/workers.js";
import { AGY_FIXED_DENY } from "../mods/am-sidebar/models.js";
import { WORKER_LINE } from "../mods/am-sidebar/briefingText.mjs";
import { approveProject, recordFileOf } from "../mods/am-sidebar/approved.js";
import { DEADLINE_CALL_MS, DEADLINE_MARGIN_MS, DEADLINE_PLACE_MS } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const CORE = "core-of-vm";
const ATLAS = "b-atlasaaaaa", HEDGE = "b-hedgeaaaaa";
const KEEP = ["sh", "-c", "\"$@\"; exec \"${SHELL:-sh}\" -i", "sh", "hermes", "--tui"];
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

/** The warning a start on a machine with no `hc kill` shim prints (#955). */
const NO_KILL_SHIM = /^\S.* runs on vm without the hc kill shim \(#955\): /;

function scene(t, { terminals = [], tui = true } = {}) {
  const root = scratchRoot(t, "hb-panes-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vm, vmBin]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  // Never the real window: a herdr-app that fails, first on PATH.
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  // On vm: hermes and claude are installed (what `command -v` finds there), and uname is Linux.
  exe(join(vmBin, "hermes"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "uname"), "#!/bin/sh\necho Linux\n");
  // A shell's children there (pgrep -P through hc exec): never the host's processes.
  exe(join(vmBin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  // The owner's override, as programs.json holds it: Atlas runs the TUI.
  if (tui) writeFileSync(join(app, "programs.json"), JSON.stringify({ programs: { hermes: { run: ["hermes", "--tui"] } } }));
  const look = { character: "star", colour: "blue" };
  const project = scratchProject(vm, "atlas", {
    bots: { version: 1, categories: [], bots: [
      { id: ATLAS, name: "Atlas", kind: "main", look, role: "incident agent", instructions: "", agent: "hermes" },
      { id: HEDGE, name: "Hedge", kind: "member", look, role: "r", instructions: "", agent: "claude" },
    ] },
  });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ next: 100, noStatus: ["hermes"], terminals: terminals.map((x) => ({ cwd: project, ...x })),
    machines: [{ name: "vm", id: CORE, state: "connected", uname: "Linux x86_64", home: vm, path: vmBin }] }));
  writeFileSync(logPath, "");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  const env = { ...process.env, XDG_DATA_HOME: "", PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog,
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "4000", AUTOMAGIK_HERDR_TAB_WAIT_MS: "300",
    GIT_CEILING_DIRECTORIES: root };
  // Run from a pane (t1), as a bot would: hc run's default parent is the calling terminal.
  env.HC_TERMINAL_ID = "t1";
  const cli = (args, more = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...more }, encoding: "utf8" });
    // #955: vm in this scene has no automagik-herdr on its pane PATH, so a start of any agent but
    // dsh-tui adds the "no hc kill shim there" warning. json() leaves that one line out, so each
    // test still counts the warnings it is about; raw() is the answer as printed (the shim's own tests).
    const raw = () => JSON.parse(r.stdout);
    const json = () => {
      const out = raw();
      return Array.isArray(out?.warnings) ? { ...out, warnings: out.warnings.filter((w) => !NO_KILL_SHIM.test(w)) } : out;
    };
    return { code: r.status, out: r.stdout, err: r.stderr, json, raw };
  };
  const on = ["--machine", "vm", "--project", project];
  const calls = () => readJsonLines(logPath);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (fn) => { const s = hcState(); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  const rows = () => (existsSync(attachPath(app)) ? readAttach(readFileSync(attachPath(app), "utf8")).rows : []);
  // A window that shows `spaces` (herdr-app ls); any other herdr-app call fails.
  const windowShows = (spaces) => {
    writeFileSync(join(root, "window.json"), JSON.stringify({ spaces }));
    exe(join(bin, "herdr-app"), `#!/bin/sh\n[ "$1" = ls ] && exec cat "${join(root, "window.json")}"\nexit 1\n`);
  };
  // fake-herdr-app.mjs as the window, from `state` (its space.new, tab.close and `place`).
  const fakeWindow = (state) => {
    writeFileSync(appState, JSON.stringify(state));
    writeFileSync(appLog, "");
    exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  };
  const appCalls = () => readJsonLines(appLog);
  const windowNow = () => JSON.parse(readFileSync(appState, "utf8"));
  const approve = () => approveProject({ project,
    env: { HOME: vm, XDG_DATA_HOME: "" }, approvedBy: "tester" });
  return { root, project, app, home, cli, on, calls, hcState, setState, rows,
    windowShows, fakeWindow, appCalls, windowNow, approve };
}

// The Atlas pane as lab/t8 is: live, under the keep wrapper, no status reported.
const atlasPane = (extra = {}) => ({ address: "vm/t8", name: null, state: "live", created_ms: 1700000000008, parent: null, labels: {},
  foreground: { argv: KEEP, name: "sh" }, status: null, ...extra });
const keysSent = (calls) => calls.filter((c) => ["send", "keys", "interrupt"].includes(c[0]));

test("linked Linux starts require approval, then refuse approved on even with working off", (t) => {
  const s = scene(t);
  const path = join(s.project, ".herdr", "bots.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(file.bots[0], { agent: "dsh-tui", hcProxy: true });
  writeFileSync(path, JSON.stringify(file));
  const unapproved = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.match(unapproved.err, /run am proxy approve first/);
  s.approve();
  file.bots[0].hcProxy = false;
  writeFileSync(path, JSON.stringify(file));
  for (const verb of ["start", "restart"]) {
    const r = s.cli([verb, "Atlas", ...s.on, "--json"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /hc proxy: start this opted-in bot on its own computer/);
  }
  assert.equal(s.calls().some((call) => call[0] === "run"), false);
});

test("L4: linked non-Linux starts and restarts ignore hcProxy on", (t) => {
  const s = scene(t);
  const path = join(s.project, ".herdr/bots.json");
  const file = JSON.parse(readFileSync(path));
  Object.assign(file.bots[0], { agent: "dsh-tui", hcProxy: true });
  writeFileSync(path, JSON.stringify(file));
  exe(join(s.root, "vm-bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  s.setState((state) => { state.machines[0].uname = "Darwin arm64"; });
  for (const verb of ["start", "restart"]) {
    const result = s.cli([verb, "Atlas", ...s.on, "--force", "--json"]);
    assert.equal(result.code, 0, result.err);
  }
  assert.equal(s.calls().some((call) => call.some((word) => word.endsWith("/hcPane.mjs"))), false);
});

test("linked record path is pinned to recordFileOf for a fixture alias and custom data home", (t) => {
  const s = scene(t);
  const file = JSON.parse(readFileSync(join(s.project, ".herdr/bots.json")));
  Object.assign(file.bots[0], { agent: "dsh-tui", hcProxy: true });
  writeFileSync(join(s.project, ".herdr/bots.json"), JSON.stringify(file));
  const alias = join(s.root, "project alias");
  symlinkSync(s.project, alias);
  const env = { XDG_DATA_HOME: join(s.root, "custom data home") };
  approveProject({ project: s.project, env, approvedBy: "tester" });
  const result = s.cli(["start", "Atlas", "--machine", "vm", "--project", alias], env);
  assert.match(result.err, /linked Linux launches cannot verify the proxy execution path/);
  const expected = recordFileOf(alias, env);
  const reads = s.calls().filter((call) => call[0] === "file" && call[1] === "read"
    && call.at(-1).includes("/approved/"));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].at(-1), expected);
});

test("the same invalid record warns off to plain linked argv and refuses working on", (t) => {
  for (const verb of ["start", "restart"]) {
    const s = scene(t);
    const filePath = join(s.project, ".herdr/bots.json");
    const file = JSON.parse(readFileSync(filePath));
    Object.assign(file.bots[0], { agent: "dsh-tui", hcProxy: false });
    writeFileSync(filePath, JSON.stringify(file));
    exe(join(s.root, "vm-bin/dsh-tui"), "#!/bin/sh\nexit 0\n");
    const initialState = readFileSync(join(s.root, "hc.json"));
    const args = [verb, "Atlas", ...s.on, "--force", "--json"];
    const baseline = s.cli(args);
    assert.equal(baseline.code, 0, baseline.err);
    const plain = s.calls().filter((call) => call[0] === "run").at(-1);
    const reset = () => {
      writeFileSync(join(s.root, "hc.json"), initialState);
      rmSync(attachPath(s.app), { force: true });
    };
    reset();
    file.bots[0].hcProxy = true;
    writeFileSync(filePath, JSON.stringify(file));
    const { path, record } = s.approve();
    file.bots[0].hcProxy = false;
    writeFileSync(filePath, JSON.stringify(file));
    const corrupt = JSON.stringify({ ...record, sha256: "invalid" });
    writeFileSync(path, corrupt);
    const off = s.cli(args);
    assert.equal(off.code, 0, off.err);
    assert.deepEqual(s.calls().filter((call) => call[0] === "run").at(-1), plain);
    assert.equal((off.err.match(/WARNING hc proxy:/g) ?? []).length, 1);
    assert.ok(off.err.includes(path));
    assert.match(off.err, /does not match its sha256.*starting plain.*am proxy approve/);
    assert.doesNotMatch(off.out, /^WARNING hc proxy:/m);
    reset();
    file.bots[0].hcProxy = true;
    writeFileSync(filePath, JSON.stringify(file));
    const before = s.calls().filter((call) => call[0] === "run").length;
    const on = s.cli(args);
    assert.notEqual(on.code, 0);
    assert.match(on.err, /does not match its sha256.*am proxy approve first/);
    assert.equal(s.calls().filter((call) => call[0] === "run").length, before);
    assert.equal(readFileSync(path, "utf8"), corrupt);
  }
});

test("linked uname failure warns off to a plain start and refuses working on", (t) => {
  const s = scene(t);
  const path = join(s.project, ".herdr/bots.json");
  const file = JSON.parse(readFileSync(path));
  Object.assign(file.bots[0], { agent: "dsh-tui", hcProxy: false });
  writeFileSync(path, JSON.stringify(file));
  exe(join(s.root, "vm-bin/dsh-tui"), "#!/bin/sh\nexit 0\n");
  s.setState((state) => { state.execUnanswered = ["uname"]; });
  const off = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(off.code, 0, off.err);
  assert.match(off.err, /WARNING hc proxy: cannot check the target platform:.*starting plain/);
  assert.match(off.err, /am proxy approve/);
  const run = s.calls().find((call) => call[0] === "run");
  assert.ok(run.includes("dsh-tui"));
  assert.equal(run.some((word) => word.endsWith("/hcPane.mjs")), false);
  file.bots[0].hcProxy = true;
  writeFileSync(path, JSON.stringify(file));
  const on = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.notEqual(on.code, 0);
  assert.match(on.err, /cannot check the target platform:.*proxy approve first/);
  assert.equal(s.calls().filter((call) => call[0] === "run").length, 1);
});

test("start --machine: hc run --on there with the Mac's agent table (programs.json's hermes --tui); the row keeps tN, machine and its core", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.equal(out.terminal, "t100");
  assert.equal(out.machine, "vm");
  assert.deepEqual(out.argv, ["hermes", "--tui"], "the override, read on this computer, builds the command there");
  const run = s.calls().find((c) => c[0] === "run");
  assert.deepEqual(run.slice(0, 3), ["run", "--on", "vm"]);
  assert.ok(run.includes(`bot=${ATLAS}`) && run.includes(s.project));
  // Never the calling terminal as its hc parent (hc run's default), which it would end with.
  assert.ok(run.includes("--no-parent") && !run.includes("--parent"));
  const pane = s.hcState().terminals.find((x) => x.address === "vm/t100");
  assert.deepEqual([pane.parent, pane.die_with_parent], [null, false], "run from t1, still no parent: it never ends with t1");
  const [row] = s.rows();
  assert.deepEqual([row.event, row.terminal, row.machine, row.core, row.by], ["attach", "t100", "vm", CORE, "start"]);
  // A second start: already running, by its address.
  assert.match(s.cli(["start", "Atlas", ...s.on]).out, /Atlas is already running in vm\/t100/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
  // ls: its status from the pane there.
  const ls = s.cli(["ls", ...s.on, "--json"]).json().projects[0].bots.find((b) => b.id === ATLAS);
  assert.deepEqual([ls.terminal, ls.machine, ls.status], ["t100", "vm", "running"]);
  assert.deepEqual(keysSent(s.calls()), []);
});

test("start --machine lands in that machine's space on the project, in a tab of its own: never the space's selected tab", (t) => {
  const s = scene(t);
  s.windowShows([{ id: "sp-vm", folder: s.project, machine: "vm", active: true,
    tabs: [{ id: "tb-a", active: false }, { id: "tb-b", active: true }] }]);
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().space, r.json().tab], ["sp-vm", null]);
  const run = s.calls().find((c) => c[0] === "run");
  assert.ok(run.includes("herdr.space=sp-vm"), run.join(" "));
  assert.equal(run.some((a) => a.startsWith("herdr.tab=")), false, run.join(" "));
});

test("start --machine in a space it opened closes that space's shell tab only while it is the fresh bare idle shell", (t) => {
  // No space on the project there: space.new on vm makes one, its shell (vm/t-sh1, printed bare)
  // the one tab's one terminal; Herdr shows the bot (vm/t100) in a tab of its own.
  const s = scene(t);
  s.fakeWindow({ spaces: [], place: true });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().space, r.json().tab], ["sp-new1", null]);
  // Never `confirmed`: Herdr asks the person only before closing a space's last tab.
  assert.deepEqual(s.appCalls().filter((c) => c[0] === "do").map((c) => [c[1], JSON.parse(c[2])]),
    [["space.new", { name: "atlas", folder: s.project, machine: "vm" }], ["tab.close", { id: "tb-new1" }]]);
  assert.deepEqual(s.windowNow().spaces.map((x) => [x.id, x.tabs.map((tb) => tb.id)]), [["sp-new1", ["tb-vm/t100"]]]);
  // Its shell was asked of hc there, and its children of that machine (pgrep -P through hc exec).
  assert.ok(s.calls().some((c) => c[0] === "get" && c[1] === "vm/t-sh1"), JSON.stringify(s.calls()));
  assert.ok(s.calls().some((c) => c[0] === "exec" && c.includes("vm") && c.slice(-3).join(" ") === "pgrep -P 9001"));
  // Kept: vim in front of the shell, a job left running at its prompt, its children unknown.
  for (const extra of [{ shellBusy: true }, { shellJob: true }, { shellUnknown: true }, { shellPgrepError: true },
    { shellPgrepKilled: true }]) {
    const k = scene(t);
    k.fakeWindow({ spaces: [], place: true, ...extra });
    const kr = k.cli(["start", "Atlas", ...k.on]);
    assert.equal(kr.code, 0, kr.err);
    assert.deepEqual(k.appCalls().filter((c) => c[0] === "do").map((c) => c[1]), ["space.new"], JSON.stringify(extra));
    assert.deepEqual(k.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-new1", "tb-vm/t100"], JSON.stringify(extra));
  }
  // A bot Herdr doesn't show in time: the shell's tab is the space's only one, kept.
  const n = scene(t);
  n.fakeWindow({ spaces: [] });
  assert.equal(n.cli(["start", "Atlas", ...n.on]).code, 0);
  assert.deepEqual(n.appCalls().filter((c) => c[0] === "do").map((c) => c[1]), ["space.new"]);
  assert.deepEqual(n.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-new1"]);
  // A space of vm open on the project already is never this start's: nothing is closed there.
  const o = scene(t);
  o.fakeWindow({ place: true, spaces: [{ id: "sp-vm", name: "atlas", folder: o.project, machine: "vm", active: true,
    tabs: [{ id: "tb-a", name: "1", active: true, terminals: [{ terminal: "vm/t-sh9", pane: "p9" }] }] }] });
  assert.equal(o.cli(["start", "Atlas", ...o.on]).code, 0);
  assert.deepEqual(o.appCalls().filter((c) => c[0] === "do"), []);
  // (No spare to close, so the window isn't read again: the fake never adds the bot's tab.)
  assert.deepEqual(o.windowNow().spaces[0].tabs.map((tb) => tb.id), ["tb-a"]);
});

test("start --machine: an agent not installed there is refused before anything runs; without the override, plain hermes", (t) => {
  const s = scene(t, { tui: false });
  const plain = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(plain.code, 0, plain.err);
  assert.deepEqual(plain.json().argv, ["hermes"]);
  s.setState((st) => { st.machines[0].path = null; });
  const r = s.cli(["start", "Hedge", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /isn't installed on vm/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

// ---- the briefing there (#582): written on that machine, in its app home, through hc ----

/** The words hc run starts there: after `--`, the `/usr/bin/env` words, then the agent's. */
const startedWith = (s) => { const run = s.calls().find((c) => c[0] === "run"); return run.slice(run.indexOf("--") + 1); };
const agentPart = (argv) => (argv[0] === "/usr/bin/env" ? argv.slice(argv.findIndex((w, i) => i > 0 && !/^[A-Z_]+=/.test(w))) : argv);
/** The pack's briefing entry and script in an app home on vm, as an install there puts them. */
const packAt = (dir) => {
  for (const f of ["automagik-herdr/briefing.mjs", "mods/am-sidebar/briefing.mjs"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "// stand-in\n");
  }
};
const vmApp = (s) => join(s.root, "vm/.config/herdr-app");
const briefedIn = (dir) => (existsSync(join(dir, "automagik-herdr/briefings")) ? readdirSync(join(dir, "automagik-herdr/briefings")) : []);
const hookOf = (s) => JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;

const modeOf = (path) => statSync(path).mode & 0o777;

test("start --machine of a Claude bot with no app home there: none is made; one warning, no briefing file or hook, started", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const warnings = r.json().warnings;
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], new RegExp(`^Hedge runs on vm without its briefing in its system prompt or per turn: its app home there, `
    + `${vmApp(s)}, isn't a folder, and a start never makes one\\.`));
  assert.match(r.err, /Hedge runs on vm without its briefing/);
  assert.equal(r.json().hookWritten, false);
  // The shared-box rule: nothing under that machine's home, no hook in the project there.
  assert.equal(existsSync(join(s.root, "vm/.config")), false, "no app home made there");
  assert.equal(existsSync(join(s.project, ".claude")), false);
  assert.equal(existsSync(join(s.home, ".claude")), false);
  assert.deepEqual(withoutSession(agentPart(startedWith(s))), ["claude", "--permission-mode", "auto"], "started, without the briefing flag");
  assert.deepEqual(briefedIn(s.app), [], "never this computer's app home");
});

// RFC 0026 (e), T9's linked seat: the pane's agent.session label is the linked machine's own
// record of the seat's session, so its meter can tie the session to the seat's bot label there.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An agent argv without `--session-id <id>` (the id Herdr chose, different every run). */
const withoutSession = (argv) => { const i = argv.indexOf("--session-id"); return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]; };
/** The hc run call's labels, as { key: value }. */
const runLabels = (run) => Object.fromEntries(run.flatMap((w, i) => (run[i - 1] === "--label" ? [[w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]] : [])));

test("start --machine of a Claude bot: it runs on a session id Herdr chose (--session-id), set as its agent.session label there, as a local start", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = s.calls().find((c) => c[0] === "run");
  const words = agentPart(startedWith(s));
  assert.deepEqual(words.slice(0, 4), ["claude", "--permission-mode", "auto", "--session-id"]);
  const id = words[4];
  assert.match(id, UUID, "a random UUID, as Claude Code's --session-id takes");
  assert.equal(words.length, 5);
  // The same id is the pane's label on vm, beside the seat's bot label: both are in the one hc run --on.
  assert.deepEqual(run.slice(0, 3), ["run", "--on", "vm"]);
  const labels = runLabels(run);
  assert.equal(labels["agent.session"], id);
  assert.equal(labels.bot, HEDGE);
  const pane = s.hcState().terminals.find((x) => x.address === "vm/t100");
  assert.equal(pane.labels["agent.session"], id);
  assert.equal(pane.labels.bot, HEDGE);
  // Output never shows a session id (RFC 0021): the argv's value and the label are masked, stderr too.
  const out = r.json();
  assert.deepEqual(out.argv, ["claude", "--permission-mode", "auto", "--session-id", "***"]);
  assert.equal(out.labels["agent.session"], "***");
  assert.equal(`${r.out}${r.err}`.includes(id), false);
  // The attach row is the starting machine's and names no session.
  const [row] = s.rows();
  assert.deepEqual([row.event, row.terminal, row.machine, row.core, row.by], ["attach", "t100", "vm", CORE, "start"]);
  assert.equal(JSON.stringify(s.rows()).includes(id), false);
  // Every start chooses its own.
  const s2 = scene(t);
  assert.equal(s2.cli(["start", "Hedge", ...s2.on]).code, 0);
  assert.notEqual(agentPart(startedWith(s2))[2], id);
});

test("start --machine: an agent Herdr chooses no id for gets none, and a Claude command that picks its own session keeps it", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["start", "Atlas", ...s.on]).code, 0);
  const run = s.calls().find((c) => c[0] === "run");
  assert.equal(run.includes("--session-id"), false);
  assert.equal("agent.session" in runLabels(run), false);
  // programs.json's claude row resumes a session of the person's: no --session-id beside it, no label.
  const own = scene(t);
  writeFileSync(join(own.app, "programs.json"), JSON.stringify({ programs: { claude: { run: ["claude", "--continue"] } } }));
  assert.equal(own.cli(["start", "Hedge", ...own.on]).code, 0);
  const ownRun = own.calls().find((c) => c[0] === "run");
  assert.deepEqual(agentPart(startedWith(own)), ["claude", "--continue", "--permission-mode", "auto"]);
  assert.equal("agent.session" in runLabels(ownRun), false);
});

test("restart --machine --fresh of a Claude bot: the new conversation runs on a new chosen id, the pane's new agent.session label; a resume keeps its own", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["start", "Hedge", ...s.on]).code, 0);
  const first = agentPart(startedWith(s))[2];
  const lastRun = () => { const run = s.calls().filter((c) => c[0] === "run").at(-1); return { run, words: agentPart(run.slice(run.indexOf("--") + 1)) }; };
  const r = s.cli(["restart", "Hedge", ...s.on, "--fresh", "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  const fresh = lastRun();
  assert.deepEqual(fresh.words.slice(0, 4), ["claude", "--permission-mode", "auto", "--session-id"]);
  assert.match(fresh.words[4], UUID);
  assert.notEqual(fresh.words[4], first);
  assert.equal(fresh.words.length, 5);
  assert.equal(runLabels(fresh.run)["agent.session"], fresh.words[4], "the new pane's label is the new session, never the old one carried");
  assert.equal(s.hcState().terminals.find((x) => x.address === r.json().terminal || x.address === `vm/${r.json().terminal}`).labels["agent.session"], fresh.words[4]);
  assert.deepEqual(r.json().argv, ["claude", "--permission-mode", "auto", "--session-id", "***"]);
  assert.equal(`${r.out}${r.err}`.includes(fresh.words[4]), false);
  // A resume keeps its session: --resume <that id>, no --session-id, the label carried.
  const again = s.cli(["restart", "Hedge", ...s.on, "--force", "--json"]);
  assert.equal(again.code, 0, again.err);
  const resumed = lastRun();
  assert.deepEqual(resumed.words, ["claude", "--permission-mode", "auto", "--resume", fresh.words[4]]);
  assert.equal(runLabels(resumed.run)["agent.session"], fresh.words[4]);
});

test("start --machine with a pane-env that is left out: no app home there is used, not even the default one", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  writeFileSync(join(s.project, ".herdr/pane-env"), "HERDR_APP_HOME=/srv/bots/herdr-app \n");
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const warnings = r.json().warnings;
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /pane-env on vm was left out \(line 1: HERDR_APP_HOME: "\/srv\/bots\/herdr-app " has a space at its start or end\)/);
  assert.match(warnings[1], /^Hedge runs on vm without its briefing in its system prompt or per turn: its \.herdr\/pane-env there was left out, so no app home there is used, not even the default one\./);
  assert.deepEqual(withoutSession(agentPart(startedWith(s))), ["claude", "--permission-mode", "auto"]);
  assert.equal(startedWith(s).some((w) => w.startsWith("HERDR_APP_HOME=")), false);
  assert.deepEqual(briefedIn(vmApp(s)), [], "the default app home there is left alone");
  assert.equal(existsSync(join(s.project, ".claude")), false);
});

test("linked worker scope: launch uses the linked project's git state and code setting", async (t) => {
  for (const mode of ["git", "non-git", "opt-out"]) {
    await t.test(mode, (t) => {
      const s = scene(t);
      packAt(vmApp(s));
      // A fake remote path whose local-disk folder has the opposite git state from vm's project,
      // so checking project.key on this computer's disk instead of vm's fails both git and non-git.
      const remoteProject = join(s.root, `remote-${mode}`);
      mkdirSync(remoteProject);
      if (mode === "non-git") {
        rmSync(join(s.project, ".git"), { recursive: true });
        execFileSync("git", ["init", "-q", remoteProject]);
      }
      s.setState((st) => { st.machines[0].paths = { [remoteProject]: s.project }; });
      const on = ["--machine", "vm", "--project", remoteProject];
      if (mode === "opt-out") {
        const edited = s.cli(["edit", "Hedge", "--code", "false", ...on]);
        assert.equal(edited.code, 0, edited.err);
      }
      const r = s.cli(["start", "Hedge", ...on, "--json"]);
      assert.equal(r.code, 0, r.err);
      const words = agentPart(startedWith(s));
      const text = readFileSync(words[words.indexOf("--append-system-prompt-file") + 1], "utf8");
      assert.equal(text.includes(WORKER_LINE), mode === "git", mode);
      if (mode !== "git") assert.doesNotMatch(text, /worker/i);
    });
  }
});

test("start --machine of a Claude bot: the briefing file and the per-turn hook in that project, both pointing at vm's app home", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().warnings, []);
  assert.equal(r.json().hookWritten, true);
  const words = agentPart(startedWith(s));
  assert.deepEqual(words.slice(0, 2), ["claude", "--append-system-prompt-file"]);
  assert.ok(words[2].startsWith(`${vmApp(s)}/automagik-herdr/briefings/`) && existsSync(words[2]), words[2]);
  // The hook runs the stable entry of vm's app home, written there through hc file ops.
  assert.match(hookOf(s), new RegExp(`${vmApp(s)}/automagik-herdr/briefing\\.mjs`));
  assert.match(readFileSync(join(s.project, ".git/info/exclude"), "utf8"), /\*\*\/\.claude\/settings\.local\.json/);
  assert.ok(s.calls().some((c) => c[0] === "file" && c[1] === "edit" && c.at(-1) === join(s.project, ".git/info/exclude")));
  // Nothing on this computer: its app home, home and the CLI's own folder stay as they were.
  assert.deepEqual(briefedIn(s.app), []);
  assert.equal(existsSync(join(s.home, ".claude")), false);
  assert.equal(existsSync(join(s.root, ".claude")), false);
  assert.equal(modeOf(words[2]).toString(8), "600");
  // A second start there (after the first pane ends) finds the hook in place: written once. Its
  // briefing file, changed and opened up since, is rewritten through hc file edit and made 0600 again.
  assert.equal(s.cli(["detach", "Hedge", ...s.on]).code, 0);
  writeFileSync(words[2], "<herdr-bot>\nan older briefing\n");
  chmodSync(words[2], 0o664);
  const again = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json().warnings, []);
  assert.equal(again.json().hookWritten, false);
  assert.equal(JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8")).hooks.UserPromptSubmit.length, 1);
  assert.match(readFileSync(words[2], "utf8"), /You are Hedge/);
  assert.equal(modeOf(words[2]).toString(8), "600");
  assert.ok(s.calls().some((c) => c[0] === "file" && c[1] === "edit" && c.at(-1) === words[2]));
});

test("start --machine of a Claude bot: the hook merges into that project's settings.local.json there, keeping what is in it", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  const theirs = { permissions: { allow: ["Bash(ls:*)"] }, hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo their own prompt hook" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo their own tool hook" }] }],
  } };
  mkdirSync(join(s.project, ".claude"));
  writeFileSync(join(s.project, ".claude/settings.local.json"), `${JSON.stringify(theirs, null, 2)}\n`);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().hookWritten, true);
  const now = JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8"));
  assert.deepEqual(now.permissions, theirs.permissions);
  assert.deepEqual(now.hooks.PreToolUse, theirs.hooks.PreToolUse);
  assert.deepEqual(now.hooks.UserPromptSubmit[0], theirs.hooks.UserPromptSubmit[0], "their prompt hook first, as it was");
  assert.equal(now.hooks.UserPromptSubmit.length, 2);
  assert.match(now.hooks.UserPromptSubmit[1].hooks[0].command, new RegExp(`${vmApp(s)}/automagik-herdr/briefing\\.mjs`));
  // Edited in place there (hc file edit on the text read), never replaced from a local path.
  assert.ok(s.calls().some((c) => c[0] === "file" && c[1] === "edit" && c.at(-1) === join(s.project, ".claude/settings.local.json")));
});

test("start --machine of an omp bot: the briefing as its --append-system-prompt text; no file and no hook there", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  const file = join(s.project, ".herdr/bots.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"agent": "claude"/, '"agent": "omp"'));
  exe(join(s.root, "vm-bin", "omp"), "#!/bin/sh\nexit 0\n");
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().warnings, []);
  const words = agentPart(startedWith(s));
  assert.equal(words[0], "omp");
  assert.match(words[1], /^--append-system-prompt=<herdr-bot>\n[^]*You are Hedge/);
  assert.equal(words.filter((w) => w.includes("<herdr-bot>")).length, 1);
  assert.deepEqual(briefedIn(vmApp(s)), []);
  assert.equal(existsSync(join(s.project, ".claude")), false);
});

test("start --machine with a pane-env there: PATH_PREPEND first (its node runs the agent) and HERDR_APP_HOME in the env words and the briefing", (t) => {
  const s = scene(t);
  const own = join(s.root, "vm/srv/bots-app"), node = join(s.root, "vm/opt/node-22/bin");
  packAt(own);
  // claude there is a node script whose node only the prepended folder has.
  exe(join(s.root, "vm-bin", "claude"), "#!/usr/bin/env fakenode\n");
  mkdirSync(node, { recursive: true });
  exe(join(node, "fakenode"), "#!/bin/sh\necho agent ran\n");
  const refused = s.cli(["start", "Hedge", ...s.on]);
  assert.equal(refused.code, 1, "without the pane-env, no node there: refused");
  assert.match(refused.err, /runs under fakenode, which isn't on the PATH a pane on vm gets/);
  writeFileSync(join(s.project, ".herdr/pane-env"), `PATH_PREPEND=${node}\nHERDR_APP_HOME=${own}/\n`);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().warnings, []);
  const argv = startedWith(s);
  assert.equal(argv[0], "/usr/bin/env");
  assert.ok(argv[1].startsWith(`PATH=${node}:`), argv[1]);
  assert.ok(argv[1].includes(join(s.root, "vm-bin")), "what hc's own PATH reached stays reachable");
  assert.equal(argv[2], `HERDR_APP_HOME=${own}`);
  assert.deepEqual(argv.slice(3, 5), ["claude", "--append-system-prompt-file"]);
  assert.ok(argv[5].startsWith(`${own}/automagik-herdr/briefings/`) && existsSync(argv[5]), argv[5]);
  assert.match(hookOf(s), new RegExp(`${own}/automagik-herdr/briefing\\.mjs`));
  assert.deepEqual(briefedIn(vmApp(s)), [], "the default app home there is left alone");
  const ran = spawnSync(argv[0], argv.slice(1), { env: {}, encoding: "utf8" });
  assert.equal(ran.stdout, "agent ran\n", "the pane runs the agent under the chosen node");
});

test("start --machine with a pane-env that has another key or a relative path: one warning, started as without it", (t) => {
  for (const [text, why] of [["PATH_PREPEND=/opt/node-22/bin\nNODE_OPTIONS=--require=/tmp/x.js\n", /line 2: NODE_OPTIONS isn't a key pane-env takes/],
    ["PATH_PREPEND=opt/node-22/bin\n", /line 1: PATH_PREPEND: "opt\/node-22\/bin" isn't an absolute folder/],
    ["HERDR_APP_HOME=srv/app\n", /HERDR_APP_HOME: "srv\/app" isn't an absolute folder/]]) {
    const s = scene(t);
    writeFileSync(join(s.project, ".herdr/pane-env"), text);
    const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
    assert.equal(r.code, 0, r.err);
    const warnings = r.json().warnings;
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], new RegExp(`^${s.project}/\\.herdr/pane-env on vm was left out \\(`));
    assert.match(warnings[0], why);
    assert.match(warnings[0], /the pane starts as it would without it\.$/);
    const argv = startedWith(s);
    assert.deepEqual([argv[0], argv.slice(2)], ["/usr/bin/env", ["hermes", "--tui"]], argv.join(" "));
    assert.equal(argv[1].includes("/opt/node-22/bin"), false);
  }
});

// ---- the Antigravity permission list there (#823): written on that machine, through hc ----

/** Atlas on Antigravity, with the agent installed on vm and a linked project roster. */
function agyScene(t, { appHome = true } = {}) {
  const s = scene(t);
  exe(join(s.root, "vm-bin", "agy"), "#!/bin/sh\nexit 0\n");
  const path = join(s.project, ".herdr", "bots.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  file.bots.find((b) => b.id === ATLAS).agent = "antigravity";
  file.bots.find((b) => b.id === ATLAS).agyPermissions = { allow: ["command(npm publish)"], deny: [] };
  writeFileSync(path, JSON.stringify(file));
  if (appHome) mkdirSync(vmApp(s), { recursive: true });
  return s;
}

/** The 0600 permission file a linked Antigravity seat reads, under vm's own app home. */
const agySeatFile = (s) => join(vmApp(s), "automagik-herdr", "agy-settings", `${ATLAS}-seat.json`);
const LOCAL_AGY_DIR = (s) => join(s.app, "automagik-herdr", "agy-settings");

test("start --machine of an Antigravity bot: its 0600 permission file is written on vm through hc, and the argv names vm's path", (t) => {
  const s = agyScene(t);
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const file = agySeatFile(s);
  assert.deepEqual(r.json().argv, ["agy", "--settings", file, "--dangerously-skip-permissions", "--mode", "auto"], "the command names the file there");
  assert.deepEqual(agentPart(startedWith(s)), ["agy", "--settings", file, "--dangerously-skip-permissions", "--mode", "auto"]);
  // Written on vm, in vm's app home, through hc: 0600 in a 0700 folder.
  assert.ok(existsSync(file), file);
  assert.equal(modeOf(file).toString(8), "600");
  assert.equal(modeOf(join(vmApp(s), "automagik-herdr/agy-settings")).toString(8), "700");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(data.permissions.allow.includes(`write_file(${s.project})`), "the project on vm");
  assert.ok(data.permissions.allow.includes("command(npm publish)"), "the roster's addition");
  for (const rule of AGY_FIXED_DENY) assert.ok(data.permissions.deny.includes(rule), rule);
  // #884 Low A: the linked machine's own home (vm) is derived from its app home, so the project
  // it works in is still the one trusted folder.
  assert.deepEqual(data.trustedWorkspaces, [s.project], "the linked project, not vm's home");
  // Never this computer's app home: no file, no path in the argv.
  assert.equal(existsSync(LOCAL_AGY_DIR(s)), false, "never written here");
  assert.equal(r.json().argv.includes(file), true);
  assert.equal(r.json().argv.some((w) => w.startsWith(s.app)), false);
  // Restart --machine writes the same file there again and names it, resumed.
  const again = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(again.code, 0, again.err);
  const run = s.calls().filter((c) => c[0] === "run")[1];
  const words = agentPart(run.slice(run.indexOf("--") + 1));
  assert.deepEqual(words, ["agy", "--settings", file, "--dangerously-skip-permissions", "--mode", "auto", "--continue"]);
  assert.equal(modeOf(file).toString(8), "600");
  assert.equal(existsSync(LOCAL_AGY_DIR(s)), false, "still here nothing");
});

test("start and restart --machine of an Antigravity bot with no app home there: one clear refusal, nothing started, nothing written here", (t) => {
  const s = agyScene(t, { appHome: false });
  const line = new RegExp(`^Atlas runs on vm without its Antigravity permission list: its app home there, `
    + `${vmApp(s)}, isn't a folder, and a start never makes one\\. Install Automagik Herdr on vm, or set `
    + `HERDR_APP_HOME in the project's \\.herdr/pane-env there to an app home that is there\\. Nothing was started\\.$`);
  for (const args of [["start", "Atlas", ...s.on], ["restart", "Atlas", ...s.on, "--force"]]) {
    const r = s.cli(args);
    assert.equal(r.code, 1, args.join(" "));
    const said = r.err.split("\n").filter((x) => x.includes("Antigravity permission list"));
    assert.equal(said.length, 1, r.err);
    assert.match(said[0].replace(/^am: /, ""), line);
  }
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 0, "nothing started");
  assert.equal(existsSync(join(s.root, "vm/.config")), false, "no app home made there");
  assert.equal(existsSync(LOCAL_AGY_DIR(s)), false, "never this computer's app home");
});

test("attach --machine vm/t8 as it is: labels only, the row's terminal is t8; whois keeps its shape, no '/' in it", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  const r = s.cli(["attach", "Atlas", "vm/t8", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().terminal, r.json().machine], ["t8", "vm"]);
  const [row] = s.rows();
  assert.deepEqual([row.terminal, row.machine, row.core, row.by, row.created_ms], ["t8", "vm", CORE, "attach", 1700000000008]);
  assert.ok(s.calls().some((c) => c[0] === "label" && c[1] === "vm/t8" && c.includes(`bot=${ATLAS}`)));
  // The bare id with --machine names the same pane.
  assert.match(s.cli(["attach", "Atlas", "t8", ...s.on]).out, /Atlas is already vm\/t8/);
  for (const args of [["whois", "vm/t8", "--json"], ["whois", "t8", "--machine", "vm", "--json"], ["whois", "--bot", ATLAS, "--machine", "vm", "--json"]]) {
    const w = s.cli(args);
    assert.equal(w.code, 0, w.err);
    const out = w.json();
    assert.deepEqual(Object.keys(out).sort(), ["bot", "core", "created_ms", "project", "since", "terminal"], "bots.whois-json@1's keys");
    assert.deepEqual([out.terminal, out.core, out.bot], ["t8", CORE, ATLAS]);
    assert.ok(!Object.entries(out).some(([k, v]) => k !== "project" && typeof v === "string" && v.includes("/")), "no machine address in whois");
  }
  // Its status: the agent under the keep wrapper is in front, though it reports none.
  const ls = s.cli(["ls", ...s.on, "--json"]).json().projects[0].bots.find((b) => b.id === ATLAS);
  assert.deepEqual([ls.terminal, ls.status], ["t8", "running"]);
  assert.deepEqual(keysSent(s.calls()), []);
});

test("attach: a machine's terminal with another project, or this computer's, is refused", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.match(s.cli(["attach", "Atlas", "other/t8", ...s.on]).err, /other\/t8 is on other/);
  const here = s.cli(["attach", "Atlas", "vm/t8"]);
  assert.equal(here.code, 2);
  assert.match(here.err, /vm\/t8 is on vm; name the bot's project there/);
});

test("restart --machine of a pane that reports no status: refused in plain words; --force starts hermes --tui --continue, then ends the old one", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const refused = s.cli(["restart", "Atlas", ...s.on]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /vm\/t8 doesn't tell hc whether Atlas's agent is busy or waiting for an approval/);
  assert.match(refused.err, /pass --force to restart anyway \(it sends the pane no keys/);
  assert.equal(s.calls().filter((c) => c[0] === "run" || c[0] === "kill").length, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual([out.terminal, out.machine, out.replaced, out.mode], ["t100", "vm", "t8", "resume"]);
  assert.deepEqual(out.argv, ["hermes", "--tui", "--continue"], "Hermes' own resume of the folder's latest conversation");
  const run = s.calls().find((c) => c[0] === "run");
  assert.ok(run.includes("--cwd") && run[run.indexOf("--cwd") + 1] === s.project);
  // The old pane ends only after the new one: run, then kill of vm/t8.
  const order = s.calls().map((c) => `${c[0]} ${c[1] ?? ""}`).filter((x) => /^(run|kill) /.test(x));
  assert.deepEqual(order.map((x) => x.split(" ")[0]), ["run", "kill"]);
  assert.ok(order[1].endsWith("vm/t8"));
  const rows = s.rows();
  assert.deepEqual(rows.slice(-2).map((x) => [x.event, x.terminal, x.machine, x.reason ?? null]), [["detach", "t8", "vm", "moved"], ["attach", "t100", "vm", null]]);
  assert.deepEqual(keysSent(s.calls()), [], "never a key to the pane, so never an approval answered");
});

test("restart --machine names a pane's stale flags without their values (#597 review F2/F4)", (t) => {
  const stale = ["/usr/bin/env", "PATH=/old", "hermes", "--tui", "--proxy=http://user:token@proxy.example:8080"];
  const s = scene(t, { terminals: [atlasPane({ status: { state: "idle", app: "hermes" }, argv: stale })] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Atlas: its pane's command differs from its source now \(drops --proxy=\*\*\*\): restarting from the source/);
  assert.equal(r.err.includes("proxy.example"), false, "the value is masked");
  assert.equal(r.err.includes("user:token"), false, "the URL's userinfo is masked");
  const run = s.calls().find((c) => c[0] === "run");
  assert.ok(run.includes("--proxy=http://user:token@proxy.example:8080") === false, "the source's command, never the pane's flag");
});

test("linked --tree runs the real local tree restart on the holding machine and moves the controller attachment", (t) => {
  const helper = atlasPane({ address: "vm/t9", created_ms: 1700000000009, parent: "vm/t8", die_with_parent: true,
    argv: ["claude"], foreground: { argv: ["claude"], name: "claude" }, status: { state: "idle" },
    labels: { "agent.session": "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" } });
  const s = scene(t, { terminals: [atlasPane({ status: { state: "idle", app: "hermes" } }), helper] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const bin = join(s.root, "vm-bin"), app = join(s.root, "holding-app");
  mkdirSync(app);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  const holdingCli = new URL("./fake-holding-cli.mjs", import.meta.url).pathname;
  exe(join(bin, "automagik-herdr"), `#!/bin/sh\nexec "${process.execPath}" "${holdingCli}" "$@"\n`);
  s.setState((state) => { state.machines[0].env = { HOLDING_CLI: CLI, HOLDING_APP: app }; });
  const r = s.cli(["restart", "Atlas", ...s.on, "--tree", "--force", "--fresh", "--json"]);
  assert.equal(r.code, 0, r.err);
  const result = r.json();
  assert.equal(result.machine, "vm");
  assert.equal(result.replaced, "t8");
  const panes = s.hcState().terminals;
  assert.equal(panes.find((p) => p.address === "vm/t8").state, "finished");
  assert.equal(panes.find((p) => p.address === "vm/t9").state, "finished");
  const replacements = panes.filter((p) => p.state === "live");
  assert.equal(replacements.length, 2);
  const child = replacements.find((p) => p.parent === `vm/${result.terminal}` && p.die_with_parent);
  assert.ok(child);
  assert.ok(child.argv.includes("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"), "the helper resumes its conversation");
  const who = s.cli(["whois", `vm/${result.terminal}`, "--json"]);
  assert.equal(who.code, 0, who.err);
  assert.equal(who.json().bot, ATLAS);
  assert.equal(s.rows().at(-1).terminal, result.terminal);
  assert.equal(s.rows().at(-1).core, CORE);
  const call = s.calls().find((c) => c[0] === "exec" && c.includes("--tree"));
  assert.ok(call.includes("540"));
  assert.equal(call.includes("--machine"), false, "the target CLI must execute its local tree route");
  assert.deepEqual(keysSent(s.calls()), []);
});

test("linked --tree without an installed CLI fails without ending the lead or its helpers", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--tree", "--force", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Automagik is missing on vm; install it there and retry/);
  assert.equal(s.hcState().terminals[0].state, "live");
  assert.equal(s.calls().filter((c) => c[0] === "run" || c[0] === "kill").length, 0);
});

for (const state of ["idle", "working"]) test(`linked restart with helpers offers both actions when the lead is ${state}`, (t) => {
  const helper = atlasPane({ address: "vm/t9", created_ms: 1700000000009, parent: "vm/t8", die_with_parent: true,
    status: { state: "working", app: "claude" } });
  const s = scene(t, { terminals: [atlasPane({ status: { state, app: "hermes" } }), helper] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--fresh", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.json().refused, "helpers");
  assert.match(r.json().error, /Restart with its helpers/);
  assert.match(r.json().error, /End helpers and restart/);
  assert.equal(s.calls().filter((c) => c[0] === "run" || c[0] === "kill").length, 0);
  const ok = s.cli(["restart", "Atlas", ...s.on, "--fresh", "--force", "--json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(s.hcState().terminals.find((p) => p.address === "vm/t9").state, "finished");
});

test("restart --machine: --continue is refused while another bot's same agent runs in that folder there", (t) => {
  const s = scene(t, { terminals: [atlasPane({ status: { state: "idle", app: "hermes" } }), atlasPane({ address: "vm/t9", created_ms: 9 })] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
  // No session id: refused unless --force; with --force, refused while another pane shares the folder.
  assert.match(s.cli(["restart", "Atlas", ...s.on]).err, /carries no session id/);
  const r = s.cli(["restart", "Atlas", ...s.on, "--force"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Hedge \(vm\/t9\) also runs Hermes/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 0);
});

test("detach --machine: the detach row and the labels off the pane there", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const r = s.cli(["detach", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().detached, r.json().machine], [["t8"], "vm"]);
  assert.deepEqual(s.rows().at(-1).event, "detach");
  assert.ok(s.calls().some((c) => c[0] === "label" && c[1] === "vm/t8" && c.includes("bot=")));
});

test("a machine away: its rows stay as saved (unknown), never ended; start and whois there are refused, not guessed", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  s.setState((st) => { st.machines[0].state = "disconnected"; });
  const ls = s.cli(["ls", ...s.on, "--json"]);
  assert.equal(ls.code, 1, "the file there can't be read either");
  assert.match(ls.err, /vm/);
  // This computer has no Atlas pane; vm's can't be asked while it is away.
  assert.equal(s.cli(["whois", "--bot", ATLAS, "--json"]).json().terminal, null);
  assert.match(s.cli(["whois", "--bot", ATLAS, "--machine", "vm"]).err, /vm isn't connected/);
  assert.match(s.cli(["whois", "vm/t8"]).err, /vm isn't connected/);
  assert.equal(s.rows().filter((r) => r.event === "end").length, 0, "never ended while away");
  s.setState((st) => { st.machines[0].state = "connected"; });
  assert.equal(s.cli(["whois", "--bot", ATLAS, "--machine", "vm", "--json"]).json().terminal, "t8", "back: as it was");
});

// A project's checkouts on two machines share their bots' ids: Atlas is also bound on this computer (t4).
const localAtlas = (s) => {
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(attachPath(s.app), `${JSON.stringify({ v: 1, event: "attach", bot: ATLAS, project: "/Users/me/atlas", terminal: "t4", core: "fakecore0000",
    created_ms: 4, machine: null, at: "2026-11-01T00:00:00.000Z", by: "attach" })}\n`, { mode: 0o600 });
};
const localPane = { address: "t4", name: "atlas-here", state: "live", created_ms: 4, parent: null, labels: { bot: ATLAS },
  foreground: { argv: ["hermes"], cwd: "/Users/me/atlas" }, status: { state: "idle", app: "hermes" } };
const touched = (calls, t) => calls.filter((c) => ["kill", "label", "send", "keys", "interrupt"].includes(c[0]) && c[1] === t);

test("a same-id bot on this computer is never touched by --machine: start, restart and detach act on that machine's only", (t) => {
  const s = scene(t, { terminals: [atlasPane(), localPane] });
  localAtlas(s);
  const start = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(start.code, 0, start.err);
  assert.equal(start.json().terminal, "t100", "started there, not 'already running in t4'");
  const restart = s.cli(["restart", "Atlas", ...s.on, "--force", "--fresh", "--json"]);
  assert.equal(restart.code, 0, restart.err);
  assert.equal(restart.json().replaced, "t100");
  assert.ok(s.calls().some((c) => c[0] === "kill" && c[1] === "vm/t100"));
  const detach = s.cli(["detach", "Atlas", ...s.on, "--json"]);
  assert.equal(detach.code, 0, detach.err);
  assert.deepEqual([detach.json().detached, detach.json().machine], [["t101"], "vm"]);
  assert.deepEqual(touched(s.calls(), "t4"), [], "t4 never killed, relabelled or sent anything");
  assert.equal(s.cli(["whois", "--bot", ATLAS, "--json"]).json().terminal, "t4", "this computer's Atlas still plays t4");
});

test("restart --machine: an old pane whose id is another terminal by the kill is left alone, and says so", (t) => {
  const s = scene(t, { terminals: [atlasPane({ status: { state: "idle", app: "hermes" }, labels: {} })] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  s.setState((st) => { const p = st.terminals.find((x) => x.address === "vm/t8"); p.reuseAfterGets = 1; p.reuseCreated = 77; });
  const r = s.cli(["restart", "Atlas", ...s.on, "--fresh"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /vm\/t8 is another terminal now \(its created_ms changed\), so it wasn't ended/);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill"), []);
});

test("start --machine: hc run that answers no address has its pane ended by name, never left beside the bot's", (t) => {
  const s = scene(t);
  s.setState((st) => { st.runNoAddress = true; });
  const r = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /gave no terminal address .*the pane it started \(vm\/t100, named atlas\) was ended/);
  assert.ok(s.calls().some((c) => c[0] === "kill" && c[1] === "vm/t100"));
  assert.deepEqual(s.rows(), []);
});

test("restart --machine resumes by id when the pane carries a session (--resume <id>); a label it can't use still meets the shared-folder refusal", (t) => {
  const pane = (extra) => atlasPane({ status: { state: "idle", app: "hermes" }, ...extra });
  const s = scene(t, { terminals: [pane({ labels: { "agent.session": "atlas-sess-1" } }), pane({ address: "vm/t9", created_ms: 9 })] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  // RFC 0021: --json masks the session id; what hc ran resumes it by id.
  assert.deepEqual(r.json().argv, ["hermes", "--tui", "--resume", "***"], "its own conversation, by id, though Hedge shares the folder");
  assert.equal(r.json().session, "***");
  assert.equal(r.out.includes("atlas-sess-1"), false);
  const now = s.hcState().terminals.find((x) => x.address === "vm/t100");
  assert.equal(now.labels["agent.session"], "atlas-sess-1", "carried, so the next restart resumes it too");
  // A label that can't be an id ("-x"): no --resume, so still refused while Hedge shares the folder, even with --force.
  const s2 = scene(t, { terminals: [pane({ labels: { "agent.session": "-x" } }), pane({ address: "vm/t9", created_ms: 9 })] });
  assert.equal(s2.cli(["attach", "Atlas", "vm/t8", ...s2.on]).code, 0);
  assert.equal(s2.cli(["attach", "Hedge", "vm/t9", ...s2.on]).code, 0);
  const forced = s2.cli(["restart", "Atlas", ...s2.on, "--force"]);
  assert.equal(forced.code, 1);
  assert.match(forced.err, /Hedge \(vm\/t9\) also runs Hermes/);
  assert.equal(s2.calls().filter((c) => c[0] === "run").length, 0);
});

test("restart --machine #413: codex can't resume a thread whose model provider is gone: one new pane there on a new thread, the old id in the note", (t) => {
  const thread = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
  const gone = "Error: model provider example-proxy is no longer configured (modelProviderNotConfigured)";
  const s = scene(t, { terminals: [{ address: "vm/t9", name: null, state: "live", created_ms: 1700000000009, parent: null,
    labels: { "agent.session": thread }, foreground: { argv: ["codex", "resume", thread], name: "codex" }, status: { state: "idle", app: "codex" } }] });
  const file = join(s.project, ".herdr/bots.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"agent": "claude"/, '"agent": "codex"'));
  writeFileSync(join(s.root, "vm-bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
  s.setState((st) => { st.runQueue = [{ runAs: "exit", screen: `${gone}\n$ ` }]; });
  const r = s.cli(["restart", "Hedge", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  const runs = s.calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].slice(-2), ["resume", thread], "it tried the thread first");
  assert.ok(!runs[1].includes("resume"), "then a new thread");
  const out = r.json();
  assert.deepEqual([out.mode, out.terminal, out.replaced], ["fresh", "t101", "t9"]);
  assert.equal(out.note, `codex can't resume its thread (***) (vm/t100 said "${gone}"), so it starts on a new one`);
  assert.ok(out.warnings.some((w) => w.includes("its thread (***)")));
  assert.equal(`${r.out}${r.err}`.includes(thread), false, "the thread's id is never printed (RFC 0021)");
  assert.equal(s.hcState().terminals.find((x) => x.address === "vm/t101").labels["agent.session"], undefined);
  assert.ok(s.calls().some((c) => c[0] === "kill" && c[1] === "vm/t9"), "the old pane ends once the new one is up");
});

test("restart --machine of a dsh-tui bot (#598): -c only after a finished turn there; turn 0 or no counter, a new conversation", (t) => {
  const restartAt = (turn, force, labels = {}) => {
    const s = scene(t, { terminals: [{ address: "vm/t9", name: null, state: "live", created_ms: 1700000000009, parent: null, labels,
      ...(turn === undefined ? {} : { turn }), foreground: { argv: ["dsh-tui", "--", "<herdr-bot>\nold"], name: "dsh-tui" },
      status: { state: "idle", app: "dsh-tui" } }] });
    const file = join(s.project, ".herdr/bots.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"agent": "claude"/, '"agent": "dsh-tui"'));
    exe(join(s.root, "vm-bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
    assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
    const r = s.cli(["restart", "Hedge", ...s.on, ...(force ? ["--force"] : []), "--json"]);
    assert.equal(r.code, 0, r.err);
    const run = s.calls().filter((c) => c[0] === "run").at(-1);
    return { out: r.json(), err: r.err, words: run.slice(run.indexOf("dsh-tui")) };
  };
  // A finished turn: the id-less -c, which a machine still takes only with --force (continueRefusal).
  for (const turn of [1, 2]) {
    const done = restartAt(turn, true);
    assert.deepEqual(done.words.slice(0, 3), ["dsh-tui", "-c", "--"], `turn ${turn}: ${done.words.join(" ")}`);
  }
  // A known session id resumes by it even at turn 0: the turn guard is for the id-less -c only.
  const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
  const byId = restartAt(0, false, { "agent.session": SID });
  assert.deepEqual(byId.words.slice(0, 4), ["dsh-tui", "--resume", SID, "--"], byId.words.join(" "));
  assert.equal(byId.out.note, null);
  for (const turn of [0, undefined]) {
    const fresh = restartAt(turn, false);
    assert.deepEqual(fresh.words.slice(0, 2), ["dsh-tui", "--"], `turn ${turn}: ${fresh.words.join(" ")}`);
    assert.match(fresh.words[2], /^Hedge - <herdr-bot>\n/);
    assert.equal(fresh.out.note, "dsh-TUI has no finished turn in vm/t9 to continue");
    assert.match(fresh.err, /Hedge starts on a new conversation: dsh-TUI has no finished turn in vm\/t9 to continue\./);
    // The sidebar shows --json's warnings only: why it didn't resume is there too (#600 review F3).
    assert.ok(fresh.out.warnings.includes("Hedge starts on a new conversation: dsh-TUI has no finished turn in vm/t9 to continue."), fresh.out.warnings.join("\n"));
  }
});

// ---- the agent's PATH there (#425): herdr-core as a service never read ~/.profile ----

/** What the pane was started with: the argv after hc run's `--`. */
const launched = (s) => { const run = s.calls().find((c) => c[0] === "run"); return run.slice(run.indexOf("--") + 1); };
/** Runs that argv with nothing in its environment, as a pane there would: proof the launch works. */
const pane = (argv) => spawnSync(argv[0], argv.slice(1), { env: {}, encoding: "utf8" });
const execs = (s) => s.calls().filter((c) => c[0] === "exec");
const SAYS = "#!/bin/sh\necho agent ran\n";

/** An agent only the login shell reaches, under an interpreter only it reaches too (codex under node). */
function loginOnly(s, { noise } = {}) {
  rmSync(join(s.root, "vm-bin/hermes"));
  const dir = join(s.root, "vm/.nvm-like/bin");
  mkdirSync(dir, { recursive: true });
  exe(join(dir, "hermes"), "#!/usr/bin/env fakenode\n");
  exe(join(dir, "fakenode"), SAYS);
  s.setState((st) => { st.machines[0].login = { path: `${dir}:/usr/bin:/bin`, noise }; });
  return dir;
}

test("start --machine: an agent only the login shell finds passes the check and the pane gets that PATH, so it really runs", (t) => {
  const s = scene(t);
  const dir = loginOnly(s);
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().warnings, []);
  assert.deepEqual(r.json().argv, ["hermes", "--tui"], "the agent's own words, never rewritten");
  const argv = launched(s);
  assert.equal(argv[0], "/usr/bin/env");
  assert.ok(argv[1].startsWith(`PATH=${dir}:`), argv[1]);
  assert.deepEqual(argv.slice(2), ["hermes", "--tui"]);
  assert.ok(argv[1].includes(join(s.root, "vm-bin")), "what hc's own PATH reached stays reachable");
  assert.equal(pane(argv).stdout, "agent ran\n");
  // Bounded, and only ever on the machine: the login shell's call and the check both.
  for (const c of execs(s).slice(-3)) assert.deepEqual([c[c.indexOf("--timeout") + 1], c[c.indexOf("--on") + 1]], ["10", "vm"]);
});

test("restart --machine: the same check and the same PATH, and the old pane ends only after", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const dir = loginOnly(s);
  const r = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().argv, ["hermes", "--tui", "--continue"]);
  const argv = launched(s);
  assert.ok(argv[1].startsWith(`PATH=${dir}:`), argv[1]);
  assert.deepEqual(argv.slice(2), ["hermes", "--tui", "--continue"]);
  assert.equal(pane(argv).stdout, "agent ran\n");
  assert.deepEqual(s.calls().map((c) => c[0]).filter((c) => c === "run" || c === "kill"), ["run", "kill"]);
});

test("restart --machine: an agent really missing there is refused and the old pane is left running", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  rmSync(join(s.root, "vm-bin/hermes"));
  const r = s.cli(["restart", "Atlas", ...s.on, "--force"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Hermes[^\n]* \(hermes\) isn't installed on vm/);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run" || c[0] === "kill"), []);
});

test("start --machine: a broken login shell falls back to the user bin folders, for the check and the pane, and says so", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  mkdirSync(join(s.root, "vm/.local/bin"), { recursive: true });
  exe(join(s.root, "vm/.local/bin/hermes"), SAYS);
  s.setState((st) => { st.machines[0].login = { exit: "1" }; });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json().warnings.join(), /vm's login shell gave no PATH, so Hermes starts with the PATH hc runs programs with there/);
  assert.equal(pane(launched(s)).stdout, "agent ran\n");
});

test("start --machine: a login shell that never answers is ended at the bound; ~/.bun/bin still finds the agent", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  mkdirSync(join(s.root, "vm/.bun/bin"), { recursive: true });
  exe(join(s.root, "vm/.bun/bin/hermes"), SAYS);
  s.setState((st) => { st.execTimedOut = ["-lc"]; });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json().warnings.join(), /vm's login shell didn't answer within 10 s/);
  assert.equal(pane(launched(s)).stdout, "agent ran\n");
});

test("start --machine: a stalled login shell over a slow link gets the warning and the fallback, never \"can't be reached\"", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  mkdirSync(join(s.root, "vm/.bun/bin"), { recursive: true });
  exe(join(s.root, "vm/.bun/bin/hermes"), SAYS);
  // hc's own 10 s plus 6 s of link: past the 15 s a plain hc call gets, inside the 20 s this one does.
  s.setState((st) => { st.execTimedOut = ["-lc"]; st.execTimedOutAfterMs = 16000; });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json().warnings.join(), /vm's login shell didn't answer within 10 s/);
  assert.equal(pane(launched(s)).stdout, "agent ran\n");
});

test("start --machine: really missing keeps the refusal, whether or not the login shell answered, and nothing runs", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  const r = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /\(hermes\) isn't installed on vm, or isn't on the PATH hc runs programs with there, its login shell's PATH, ~\/\.local\/bin or ~\/\.bun\/bin\./);
  s.setState((st) => { st.execTimedOut = ["-lc"]; });
  const slow = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(slow.code, 1);
  assert.match(slow.err, /isn't installed on vm.*\(vm's login shell didn't answer within 10 s\)\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
});

test("start --machine: a profile that prints to stdout is only text: its lines are never run, and never reach the PATH", (t) => {
  const s = scene(t);
  const canary = join(s.root, "ran-profile-output");
  const dir = loginOnly(s, { noise: `Welcome to vm!\nPATH=/evil:/bin\n$(touch ${canary})\n\`touch ${canary}\`\ntouch ${canary}; am-path-0-from/evil\n` });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().warnings, [], "the marker's line was found past the noise");
  const argv = launched(s);
  assert.ok(argv[1].startsWith(`PATH=${dir}:`), argv[1]);
  assert.ok(!argv[1].includes("evil") && !argv[1].includes("Welcome"), argv[1]);
  assert.equal(existsSync(canary), false);
});

test("start --machine: an agent whose interpreter a pane there couldn't find is refused, never a dead pane", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  exe(join(s.root, "vm-bin/hermes"), "#!/usr/bin/env no-such-runtime\n");
  const r = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /runs under no-such-runtime, which isn't on the PATH a pane on vm gets/);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
});

test("start --machine: a slow login shell's interpreter refusal says the shell was quiet, as the missing refusal does", (t) => {
  const s = scene(t);
  rmSync(join(s.root, "vm-bin/hermes"));
  exe(join(s.root, "vm-bin/hermes"), "#!/usr/bin/env no-such-runtime\n");
  s.setState((st) => { st.execTimedOut = ["-lc"]; });
  const r = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Put no-such-runtime on the PATH of vm's login shell \(vm's login shell didn't answer within 10 s\)\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
});

test("start --machine: a working machine keeps hc's copy of the agent and its interpreter, whatever the login shell's PATH shadows", (t) => {
  const s = scene(t);
  const login = join(s.root, "vm/login-bin");
  mkdirSync(login);
  exe(join(s.root, "vm-bin/hermes"), "#!/usr/bin/env fakenode\n");
  exe(join(s.root, "vm-bin/fakenode"), SAYS);
  exe(join(login, "hermes"), "#!/usr/bin/env no-such-runtime\n");
  exe(join(login, "fakenode"), "#!/bin/sh\nexit 1\n");
  s.setState((st) => { st.machines[0].login = { path: `${login}:/usr/bin:/bin` }; });
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch((r.json().warnings ?? []).join(), /login shell/);
  assert.equal(pane(launched(s)).stdout, "agent ran\n");
});

test("start --machine: a machine that stops answering is refused as unreachable, asked once, and nothing runs", (t) => {
  const s = scene(t);
  s.setState((st) => { st.execUnanswered = ["sh"]; });
  const r = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /vm can't be reached: vm stopped answering/);
  assert.doesNotMatch(r.err, /isn't installed/);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
  assert.equal(execs(s).filter((c) => c.includes("sh")).length, 1, "no second wait on a machine that is away");
});

test("start --machine under the sidebar's 30 s deadline (#444): too little left -> nothing started, the terminal command; enough -> started", (t) => {
  const s = scene(t);
  // The margin: hc run and at most two more calls at DEADLINE_CALL_MS each, 1 s for the row and the exit.
  assert.equal(DEADLINE_MARGIN_MS, 3 * DEADLINE_CALL_MS + 1000);
  const late = s.cli(["start", "Atlas", ...s.on], { AUTOMAGIK_HERDR_DEADLINE: String(Date.now() + 5000) });
  assert.equal(late.code, 1, late.err);
  assert.match(late.err, /Only \d s of this Herdr's 30 s limit for the sidebar's programs was left, and starting Atlas on vm needs 20 s to finish once its pane starts, so nothing was started\. /);
  assert.ok(late.err.trim().endsWith(`Start it from a terminal: am start ${ATLAS} --project ${s.project} --machine vm`), late.err);
  assert.equal((DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS) / 1000, 20);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
  assert.deepEqual(s.rows(), []);
  // With the whole 30 s ahead the start goes on: hc run there, and its row.
  const r = s.cli(["start", "Atlas", ...s.on, "--json"], { AUTOMAGIK_HERDR_DEADLINE: String(Date.now() + 30_000) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().terminal, "t100");
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
  assert.deepEqual(s.rows().map((x) => [x.event, x.terminal, x.machine]), [["attach", "t100", "vm"]]);
});

// ---- #612: this computer's programs.json override, and a linked machine that lacks it ----

/**
 * Hedge on dsh-tui there, with an override in this computer's programs.json: "skipped" (an
 * absolute run only this computer has), "there" (one both have) or null (no override). `shipped`:
 * vm has the shipped dsh-tui. `override` on the result is the override's first word.
 */
function dshTuiScene(t, { terminals = [], override = null, shipped = true, guard = true, pack: packName = "vm-pack" } = {}) {
  const s = scene(t, { terminals });
  const file = join(s.project, ".herdr/bots.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"agent": "claude"/, '"agent": "dsh-tui"'));
  if (shipped) exe(join(s.root, "vm-bin", "dsh-tui"), "#!/bin/sh\nexit 0\n");
  if (guard) {
    const pack = join(s.root, packName);
    mkdirSync(join(pack, "bin"), { recursive: true });
    mkdirSync(join(pack, "guard"), { recursive: true });
    exe(join(pack, "bin", "automagik-herdr"), "#!/bin/sh\nexit 0\n");
    exe(join(pack, "guard", "hc"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(pack, "hcGuard.mjs"), "// remote guard\n");
    symlinkSync(join(pack, "bin", "automagik-herdr"), join(s.root, "vm-bin", "automagik-herdr"));
    s.remoteGuard = join(pack, "guard");
  }
  if (override) {
    const path = override === "there" ? join(s.root, "vm-bin", "dsh-tui-custom") : join(s.root, "only-this-computer", "dsh-tui");
    if (override === "there") exe(path, "#!/bin/sh\nexit 0\n");
    s.override = path;
    writeFileSync(join(s.app, "programs.json"), JSON.stringify({ programs: { "dsh-tui": { run: [path, "--local"] } } }));
  }
  return s;
}

// ---- #955: the `hc kill` shim on a linked machine, for every agent but dsh-tui ----

/** An automagik-herdr on vm's pane PATH with the shim beside it, as an install there has. */
function shimOnVm(s) {
  const pack = join(s.root, "vm-shim-pack");
  for (const d of ["bin", "hc-kill"]) mkdirSync(join(pack, d), { recursive: true });
  exe(join(pack, "bin", "automagik-herdr"), "#!/bin/sh\nexit 0\n");
  exe(join(pack, "hc-kill", "hc"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(pack, "hcGuard.mjs"), "// remote guard\n");
  symlinkSync(join(pack, "bin", "automagik-herdr"), join(s.root, "vm-bin", "automagik-herdr"));
  return join(pack, "hc-kill");
}

test("start --machine (#955): a Claude bot gets that machine's hc kill shim first on its PATH, never this computer's, and no warning", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  const shim = shimOnVm(s);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.raw().warnings, []);
  const argv = startedWith(s);
  const pathWord = argv.find((word) => word.startsWith("PATH="));
  assert.ok(pathWord.startsWith(`PATH=${shim}:`), pathWord);
  assert.equal(pathWord.includes(KILL_GUARD_DIR), false, "not this computer's shim folder");
});

test("start --machine (#955): a machine with no hc kill shim starts the bot without it and says so once", (t) => {
  const s = scene(t);
  packAt(vmApp(s));
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const said = r.raw().warnings;
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /^Hedge runs on vm without the hc kill shim \(#955\): no automagik-herdr with hc-kill\/hc and hcGuard\.mjs beside it was found on its pane PATH; nothing there stops its hc kill\.$/);
  const pathWord = startedWith(s).find((word) => word.startsWith("PATH="));
  assert.equal(pathWord.split(":").some((dir) => dir.endsWith("/hc-kill")), false, pathWord);
});

const shippedWarning = (w, s) => /^dsh-TUI starts on vm from its shipped run \(dsh-tui\), skipping the programs\.json override here \(/
  .test(w) && w.includes(s.override) && w.includes("which isn't installed there.");

test("start --machine #612: the override isn't there but the shipped run is: the shipped run starts, with one warning naming both", (t) => {
  const s = dshTuiScene(t, { override: "skipped" });
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual(out.argv.slice(0, 2), ["dsh-tui", "--"], "the shipped run, then dsh-tui's own briefing separator");
  assert.equal(out.argv.includes("--local"), false, "the skipped override's words are not run");
  assert.equal(out.warnings.length, 1, out.warnings.join("\n"));
  assert.ok(shippedWarning(out.warnings[0], s), out.warnings[0]);
  assert.ok(s.calls().find((c) => c[0] === "run").includes("dsh-tui"));
});

test("start --machine #612: both there: the override is used as it is, and no warning", (t) => {
  const s = dshTuiScene(t, { override: "there" });
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual(out.argv.slice(0, 2), [s.override, "--local"], "the override, its own words kept");
  assert.deepEqual(out.warnings, []);
  assert.ok(s.calls().find((c) => c[0] === "run").includes(s.override));
});

test("start --machine #612: neither there: refused, naming the override and the shipped run; nothing runs", (t) => {
  const s = dshTuiScene(t, { override: "skipped", shipped: false });
  const r = s.cli(["start", "Hedge", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /dsh-TUI \(.+only-this-computer\/dsh-tui\) isn't installed on vm/);
  assert.ok(r.err.includes(`its shipped run (dsh-tui) isn't either`), r.err);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
});

test("start --machine of a dsh-tui bot uses the guard on that machine and says so in the briefing", (t) => {
  const s = dshTuiScene(t);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  const run = s.calls().find((c) => c[0] === "run");
  const pathWord = run[run.indexOf("--") + 2];
  assert.ok(pathWord.startsWith(`PATH=${s.remoteGuard}:`), pathWord);
  assert.equal(pathWord.startsWith(`PATH=${GUARD_DIR}:`), false, "not this computer's guard folder");
  assert.match(out.argv.join("\n"), /deny-by-default hc guard/);
  assert.deepEqual(out.warnings, []);
});

test("start --machine of a dsh-tui bot without a guard: no PATH guard, no briefing paragraph, one #624 warning", (t) => {
  const s = dshTuiScene(t, { guard: false });
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  const run = s.calls().find((c) => c[0] === "run");
  const pathWord = run[run.indexOf("--") + 2];
  assert.equal(pathWord.startsWith(`PATH=${GUARD_DIR}:`), false, "not this computer's guard folder");
  assert.equal(pathWord.split(":").some((dir) => dir.endsWith("/guard")), false, pathWord);
  assert.doesNotMatch(out.argv.join("\n"), /deny-by-default hc guard/);
  const said = out.warnings.filter((w) => /#624/.test(w) && /guard/.test(w));
  assert.equal(said.length, 1, out.warnings.join("\n"));
  assert.match(said[0], /no automagik-herdr with guard\/hc and hcGuard\.mjs beside it was found/, "the guard was missing");
  assert.doesNotMatch(said[0], /probe could not run/, "not a failed probe");
});

/** A dsh-tui start without the folder guard: no PATH guard, no paragraph, one #624 warning saying why. */
function noGuardStart(t, options) {
  const s = dshTuiScene(t, options);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  const run = s.calls().find((c) => c[0] === "run");
  const pathWord = run[run.indexOf("--") + 2];
  assert.equal(pathWord.split(":").some((dir) => dir.endsWith("/guard")), false, pathWord);
  assert.doesNotMatch(out.argv.join("\n"), /deny-by-default hc guard/);
  const said = out.warnings.filter((w) => /#624/.test(w) && /guard/.test(w));
  assert.equal(said.length, 1, out.warnings.join("\n"));
  return said[0];
}

test("start --machine of a dsh-tui bot: a guard folder with a space is left off PATH with the #624 warning", (t) => {
  const said = noGuardStart(t, { pack: "vm pack" });
  assert.match(said, /space or a colon/);
});

test("start --machine of a dsh-tui bot: a guard folder with a colon is left off PATH with the #624 warning", (t) => {
  const said = noGuardStart(t, { pack: "vm:pack" });
  assert.match(said, /space or a colon/);
});

test("start --machine of a dsh-tui bot: a failed guard probe is named as failed, not as a missing guard", (t) => {
  const s = dshTuiScene(t);
  s.setState((st) => { st.execTimedOut = ["automagik-herdr"]; st.machines[0].uname = "Darwin arm64"; });
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  const said = out.warnings.filter((w) => /#624/.test(w) && /guard/.test(w));
  assert.equal(said.length, 1, out.warnings.join("\n"));
  assert.match(said[0], /guard probe could not run there/);
  assert.doesNotMatch(said[0], /no automagik-herdr/);
});

test("restart --machine #612: an argv built from the table gets the same fallback, and one warning", (t) => {
  const pane = { address: "vm/t9", name: null, state: "live", created_ms: 1700000000009, parent: null, labels: {},
    turn: 1, foreground: { argv: ["dsh-tui", "--", "<herdr-bot>\nold"], name: "dsh-tui" }, status: { state: "idle", app: "dsh-tui" } };
  const s = dshTuiScene(t, { terminals: [pane], override: "skipped" });
  assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
  const r = s.cli(["restart", "Hedge", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual(out.argv.slice(0, 2), ["dsh-tui", "-c"], "the shipped run with dsh-tui's own -c");
  assert.equal(out.argv.includes("--local"), false);
  assert.ok(out.warnings.some((w) => shippedWarning(w, s)), out.warnings.join("\n"));
  assert.ok(s.calls().some((c) => c[0] === "kill" && c[1] === "vm/t9"), "the old pane ends once the new one runs");
});

// ---- #1033: on macOS, a core with no login keychain access (security show-keychain-info fails) is refused before hc run, kill or file writes ----

test("start and restart --machine (#1033): on Darwin when security show-keychain-info fails, refused with the keychain/Aqua hint before hc run, kill or writing files; exit 0 succeeds", (t) => {
  const s = agyScene(t);
  packAt(vmApp(s));
  const vmBin = join(s.root, "vm-bin");
  const denied = "security: SecKeychainCopySettings <NULL>: User interaction is not allowed.";
  exe(join(vmBin, "uname"), "#!/bin/sh\necho Darwin\n");
  exe(join(vmBin, "security"), `#!/bin/sh\nif [ "$1" = show-keychain-info ]; then\n  echo "${denied}" >&2\n  exit 36\nfi\nexit 2\n`);
  s.setState((st) => {
    st.machines[0].uname = "Darwin arm64";
    st.terminals.push(atlasPane({ foreground: { argv: ["agy"], name: "agy" }, status: { state: "idle", app: "agy" } }));
  });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const beforeCalls = s.calls().length;

  for (const args of [
    ["start", "Hedge", ...s.on],
    ["restart", "Atlas", ...s.on, "--force"],
  ]) {
    const r = s.cli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /herdr-core on vm has no access to the macOS login keychain: "security show-keychain-info" failed \(security: SecKeychainCopySettings <NULL>: User interaction is not allowed\.\)/);
    assert.match(r.err, /no Claude Code or gh login/);
    assert.match(r.err, /security show-keychain-info/);
    assert.match(r.err, /hc server status/);
  }

  // Also check `start --machine` of an Antigravity bot when not attached:
  assert.equal(s.cli(["detach", "Atlas", ...s.on]).code, 0);
  const startAgy = s.cli(["start", "Atlas", ...s.on]);
  assert.equal(startAgy.code, 1);
  assert.match(startAgy.err, /herdr-core on vm has no access to the macOS login keychain: "security show-keychain-info" failed/);
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);

  // Refused before running hc run, killing the old pane, or writing agySettings / briefing / hook files:
  const since = s.calls().slice(beforeCalls);
  assert.deepEqual(since.filter((c) => c[0] === "run" || c[0] === "kill"), []);
  assert.equal(s.hcState().terminals.find((x) => x.address === "vm/t8")?.state, "live", "vm/t8 is untouched");
  assert.equal(existsSync(agySeatFile(s)), false, "agySettings was not written before agentThere refused");
  assert.deepEqual(briefedIn(vmApp(s)), [], "no briefing file written");
  assert.equal(existsSync(join(s.project, ".claude")), false, "no hook written");

  // Once security show-keychain-info exits 0, start and restart both succeed:
  exe(join(vmBin, "security"), '#!/bin/sh\n[ "$1" = show-keychain-info ] && exit 0\nexit 2\n');
  const started = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(started.code, 0, started.err);
  assert.equal(started.json().terminal, "t100");
  assert.equal(briefedIn(vmApp(s)).length, 1);

  const restarted = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(restarted.code, 0, restarted.err);
  assert.deepEqual([restarted.json().terminal, restarted.json().replaced], ["t101", "t8"]);
  assert.equal(existsSync(agySeatFile(s)), true);
  assert.ok(s.calls().some((c) => c[0] === "kill" && c[1] === "vm/t8"));
});

test("linked --tree requires the explicit immediate choice instead of leaving an unattended remote queue", (t) => {
  const s = scene(t, { terminals: [atlasPane({ status: { state: "working" } })] });
  const r = s.cli(["restart", "Atlas", ...s.on, "--tree", "--json"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--tree --force/);
  assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "kill" || c.includes("--tree")), false);
});

for (const failure of ["timeout", "invalid-reply"]) test(`linked tree ${failure}: no automatic retry or controller kill`, (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  if (failure === "timeout") s.setState((state) => { state.execTimedOut = ["shift 5"]; });
  else exe(join(s.root, "vm-bin", "automagik-herdr"), `#!/bin/sh\nprintf '%s\\n' '{"terminal":"../other"}'\n`);
  const r = s.cli(["restart", "Atlas", ...s.on, "--tree", "--force", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /inspect its panes before retrying/);
  if (failure === "invalid-reply") assert.match(r.err, /returned an invalid pane/, "the shape check answers, not the later pane lookup");
  assert.equal(s.calls().filter((c) => c[0] === "exec" && c.includes("--tree")).length, 1);
  assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "kill"), false);
  assert.equal(s.rows().at(-1).terminal, "t8");
});

test("linked tree reply naming a live pane that is not the bot's replacement: not confirmed, no ledger move or kill", (t) => {
  const stranger = atlasPane({ address: "vm/t9", created_ms: 1700000000009 });
  const s = scene(t, { terminals: [atlasPane(), stranger] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  exe(join(s.root, "vm-bin", "automagik-herdr"), `#!/bin/sh\nprintf '%s\\n' '{"terminal":"t9"}'\n`);
  const r = s.cli(["restart", "Atlas", ...s.on, "--tree", "--force", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /its replacement pane could not be confirmed/);
  assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "kill"), false);
  assert.equal(s.rows().at(-1).terminal, "t8", "the controller attachment stays on the old pane");
});
