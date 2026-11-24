// The deny-by-default hc guard (#624, stopgap C): every allowed verb passes to a stub hc
// unchanged; every refused verb is one stderr line naming #624, #628 and #631 and never calls it;
// send is scoped to the caller's team, widened for a pm, integrator or fixer caller to any bot
// the project lists (its workers do not inherit it), and the declared lead chain reaches a
// planned lead; the dsh-tui worker run shape is exact. Hermetic: a temp app home, a temp project
// and a stub hc on PATH; the real hc is never run. No escape route (an absolute hc path, a raw
// socket, `hc connect`) is tested here: the guard is a guardrail, not a boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { GUARD_DIR, KILL_GUARD_DIR, guardPath, guardPathWith, paneGuardOf, stableRootOf, workerArgs } from "../mods/am-sidebar/workers.js";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { hcVerbOf, launchHomeOf } from "../mods/am-sidebar/hcGuard.mjs";
import { STABLE_FILES, STABLE_FOLDERS, stableFilesCurrent, stableRunnerText } from "../mods/am-sidebar/dshTui.mjs";
import { observe } from "../mods/am-sidebar/agyScan.js";
import { SYNTHETIC, trustScreen, fileScreen, capture } from "./agy-prompt-fixture.mjs";
import { GUARD_APP, quietScreen, agyHookSource } from "./agy-guard-shapes.mjs";

const ID = {
  main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc",
  junior: "b-dddddddddd", tester: "b-eeeeeeeeee", other: "b-ffffffffff",
};
const bot = (id, kind, extra = {}) => ({
  id, name: id, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "dsh-tui", ...extra,
});
const team = () => ({
  version: 1,
  categories: [],
  bots: [
    bot(ID.main, "main", { name: "Main" }),
    bot(ID.cap, "member", { name: "Captain", rank: "captain" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.junior, "member", { name: "Junior", lead: ID.dev }),
    bot(ID.tester, "member", { name: "Tester", lead: ID.main, rank: "reviewer" }),
    bot(ID.other, "member", { name: "Other", lead: ID.main }),
  ],
});

// The stub: logs every call, answers hc ls/get/read from the state file, and for any other
// verb prints the pass-through markers and exits HC_STUB_CODE. A pane's `screen` is what a
// `read` returns; a pane's `readFail` makes that read fail as a transport error would.
const STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HC_STUB_LOG, JSON.stringify({ argv: args, marker: process.env.AM_HC_GUARD_REENTRY ?? null }) + "\\n");
const state = JSON.parse(readFileSync(process.env.HC_STUB_STATE, "utf8"));
const found = (at) => state.get[at] ?? Object.values(state.get).find((g) => g.name === at);
if (args[0] === "ls") { process.stdout.write(JSON.stringify({ terminals: state.terminals }) + "\\n"); process.exit(0); }
if (args[0] === "get") {
  const at = args[1];
  const hit = found(at);
  if (!hit) { process.stderr.write(JSON.stringify({ error: { kind: "not_found" } }) + "\\n"); process.exit(3); }
  process.stdout.write(JSON.stringify(hit) + "\\n"); process.exit(0);
}
if (args[0] === "read") {
  // The target is the first positional; #628 reads may name their options before it
  // (read --lines 5 t102), so skip a value-taking option and its word.
  const optionValue = new Set(["--lines"]);
  let at = null;
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i];
    if (optionValue.has(word)) { i += 1; continue; }
    if (word.startsWith("-")) continue;
    at = word;
    break;
  }
  const hit = found(at);
  if (!hit) { process.stderr.write(JSON.stringify({ error: { kind: "not_found" } }) + "\\n"); process.exit(3); }
  if (hit.readFail) { process.stderr.write("the screen could not be read\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ text: hit.screen ?? "", complete: true, how: "screen", why: null }) + "\\n"); process.exit(0);
}
process.stdout.write("stub-out " + JSON.stringify(args) + "\\n");
process.stderr.write("stub-err " + args[0] + "\\n");
process.exit(Number(process.env.HC_STUB_CODE ?? 0));
`;

const launchArgv = (app) => ["/usr/bin/env", `HERDR_APP_HOME=${app}`, "dsh-tui"];
const get = (address, labels, extra = {}) => ({ address, state: "live", created_ms: 100, labels, ...extra });

/** One hermetic scene: temp app home, project, worktree, stub hc and a ledger-bound bot pane. */
function scene(t, { caller = "t100" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hc-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app"), project = join(root, "project"), bin = join(root, "bin"), home = join(root, "home");
  for (const dir of [app, project, bin, home, join(project, ".herdr"), join(project, ".claude", "worktrees", "wt")]) mkdirSync(dir, { recursive: true });
  const worktree = realpathSync(join(project, ".claude", "worktrees", "wt"));
  writeFileSync(join(project, ".herdr", "bots.json"), `${JSON.stringify(team(), null, 2)}\n`);
  const terminals = [
    { address: "t100", name: "dev", state: "live" }, { address: "t101", name: "cap", state: "live" },
    { address: "t102", name: "junior", state: "live" }, { address: "t103", name: "main", state: "live" },
    { address: "t105", name: "worker", state: "live" }, { address: "t106", name: "reviewer", state: "live" },
    { address: "t107", name: "fixer", state: "live" }, { address: "t108", name: "tester", state: "live" },
    { address: "t110", name: "worker-dev", state: "live" },
    { address: "t120", name: "other", state: "live" }, { address: "t121", name: "bare", state: "live" },
    // Linked machine panes, reachable by name through `hc ls`; the guard must refuse the
    // resolved `machine/tN` address, never forward it (the proxy-off path, #628).
    { address: "m/t101", name: "cap-m", state: "live" }, { address: "m/t120", name: "other-m", state: "live" },
    { address: "m/t105", name: "worker-m", state: "live" },
  ];
  const state = {
    terminals,
    get: {
      t100: get("t100", { bot: ID.dev }, { cwd: project }),
      t101: get("t101", { bot: ID.cap }, { cwd: project, name: "cap" }),
      t102: get("t102", { bot: ID.junior }, { cwd: project, name: "junior" }),
      t103: get("t103", { bot: ID.main }, { cwd: project, name: "main" }),
      t105: get("t105", { "worker.of": ID.dev }, { cwd: worktree, name: "worker", parent: "t100" }),
      t106: get("t106", { role: "reviewer" }, { cwd: project, name: "reviewer" }),
      t107: get("t107", { role: "fixer" }, { cwd: project, name: "fixer" }),
      t108: get("t108", { bot: ID.tester }, { cwd: project, name: "tester" }),
      t110: get("t110", { "worker.of": ID.dev }, { cwd: worktree, created_ms: 200, name: "worker-dev" }),
      t120: get("t120", { bot: ID.other }, { cwd: project, name: "other" }),
      t121: get("t121", {}, { cwd: project, name: "bare" }),
      "m/t101": get("m/t101", { bot: ID.cap }, { cwd: project, name: "cap" }),
      "m/t120": get("m/t120", { bot: ID.other }, { cwd: project, name: "other" }),
      "m/t105": get("m/t105", { "worker.of": ID.dev }, { cwd: worktree, name: "worker-m", parent: "t100" }),
    },
  };
  for (const pane of Object.values(state.get)) pane.argv = launchArgv(app);
  const statePath = join(root, "hc-state.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");
  writeFileSync(join(bin, "hc"), STUB);
  chmodSync(join(bin, "hc"), 0o755);
  const ledgerDir = join(app, "automagik-herdr");
  mkdirSync(ledgerDir, { recursive: true });
  if (caller === "t100") {
    const row = { v: 1, event: "attach", bot: ID.dev, project, terminal: "t100", core: "core", created_ms: 100, machine: null,
      at: "2026-11-01T00:00:00.000Z", by: "start" };
    const ledger = join(ledgerDir, "attach.jsonl");
    writeFileSync(ledger, `${JSON.stringify(row)}\n`);
    chmodSync(ledger, 0o600);
  }
  return { root, app, project, bin, home, worktree, statePath, logPath, guard: join(GUARD_DIR, "hc") };
}

const envFor = (s, extra = {}) => ({
  PATH: `${GUARD_DIR}:${s.bin}:${dirname(process.execPath)}`,
  HOME: s.home,
  HERDR_APP_HOME: s.app,
  HC_TERMINAL_ID: "t100",
  HC_STUB_LOG: s.logPath,
  HC_STUB_STATE: s.statePath,
  HC_STUB_CODE: "0",
  ...extra,
});

const guardRun = (s, args, extra = {}) => {
  const r = spawnSync(process.execPath, [s.guard, ...args], { env: envFor(s, extra), encoding: "utf8" });
  return r;
};

const readLog = (s) => readFileSync(s.logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const calls = (s) => readLog(s).map((row) => row.argv);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Patch one pane's hc get answer in the scene's state file (its status, screen, readFail). */
const editPane = (s, address, patch) => {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get[address] = { ...state.get[address], ...patch };
  writeFileSync(s.statePath, JSON.stringify(state));
};
/** A visible question dialog, as the pack's pendingDialog reads one. */
const DIALOG_SCREEN = "This command requires approval\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend";
/** A free pane: its prompt is the last line, with no dialog below it. */
const FREE_SCREEN = "all done\n❯ ";

test("launchHomeOf reads only the env prefix and resolves the default lazily (#628)", () => {
  const defaultHome = () => "/default";
  const unexpectedDefault = () => { throw new Error("default should never be needed"); };
  for (const argv of [
    ["/usr/bin/env", "HERDR_APP_HOME=/seat", "dsh-tui"],
    ["/usr/bin/env", "HERDR_APP_HOME=/seat///", "dsh-tui"],
    ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "HERDR_APP_HOME=/seat", "claude"],
    ["/usr/bin/env", "-u", "HERDR_APP_HOME", "HERDR_APP_HOME=/old", "HERDR_APP_HOME=/seat", "dsh-tui"],
  ]) {
    assert.deepEqual(launchHomeOf(argv, unexpectedDefault), { home: "/seat" }, JSON.stringify(argv));
  }
  for (const argv of [
    ["/usr/bin/env", "-u", "HERDR_APP_HOME", "dsh-tui"],
    ["/usr/bin/env", "PATH=/bin", "dsh-tui"],
    ["/usr/bin/env", "dsh-tui", "HERDR_APP_HOME=/ignored"],
    ["claude", "HERDR_APP_HOME=/ignored"],
  ]) {
    assert.deepEqual(launchHomeOf(argv, defaultHome), { home: "/default" }, JSON.stringify(argv));
  }
  for (const argv of [
    null, [], ["claude", 1], ["/usr/bin/env", "-u"], ["/usr/bin/env", "HERDR_APP_HOME=/seat"],
    ["/usr/bin/env", "HERDR_APP_HOME=relative", "dsh-tui"],
    ["/usr/bin/env", "HERDR_APP_HOME=/bad\npath", "dsh-tui"],
  ]) {
    assert.match(launchHomeOf(argv, defaultHome).error, /caller/, JSON.stringify(argv));
  }
  assert.match(launchHomeOf(["claude"], unexpectedDefault).error,
    /start or restart the bot from the sidebar or with HERDR_APP_HOME set/i);
});

function assertRefused(r) {
  assert.notEqual(r.status, 0, "a refusal exits non-zero");
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `exactly one stderr line: ${JSON.stringify(r.stderr)}`);
  assert.match(r.stderr, /#624/);
  assert.match(r.stderr, /#628/);
  assert.match(r.stderr, /#631/);
  assert.equal(r.stdout, "", "a refusal prints no stdout");
}

/** A held-pane refusal: hc's blocked exit, one JSON error line, the pane and the reason. */
function assertHeld(r, address) {
  assert.equal(r.status, 9, `a held pane exits 9 (hc's blocked code): ${r.stderr}`);
  assert.equal(r.stdout, "", "a held refusal prints no stdout");
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `exactly one stderr line: ${JSON.stringify(r.stderr)}`);
  const error = JSON.parse(lines[0]).error;
  assert.equal(error.kind, "blocked", "a relay can tell it from a transport error");
  assert.ok(error.message.includes(address), `the pane is named: ${error.message}`);
  assert.match(error.message, /held by a dialog/);
  assert.match(error.message, /nothing was sent/);
  assert.match(error.hint, /answer the dialog|route this message/i);
}

// ---- the allow list ----

test("every allowed verb reaches the stub unchanged", (t) => {
  const s = scene(t);
  const allowed = [
    ["send", "t101", "hello"], ["read", "t101"], ["ls"], ["get", "t101"], ["wait", "t101"],
    ["label", "t105", "role=dev"],
    ["events"], ["schema"], ["templates"],
  ];
  for (const args of allowed) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(calls(s).some((argv) => same(argv, args)), `${args.join(" ")} arrived unchanged: ${JSON.stringify(calls(s))}`);
    assert.equal(readLog(s).every((row) => row.marker === null), true, `${args.join(" ")}: no re-entry marker`);
  }
});

test("the allowed call keeps the stub's stdout, stderr and exit code", (t) => {
  const s = scene(t);
  const r = guardRun(s, ["templates"], { HC_STUB_CODE: "7" });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, 'stub-out ["templates"]\n');
  assert.equal(r.stderr, "stub-err templates\n");
  assert.deepEqual(calls(s), [["templates"]]);
});

test("the doc-only forms pass; a doc flag on a refused command does not", (t) => {
  const s = scene(t);
  for (const args of [["--help"], ["-h"], ["--version"], ["--skill"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(calls(s), [args]);
  }
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["exec", "--help"]);
  assertRefused(r);
  assert.deepEqual(calls(s), [], "exec --help is refused before hc");
});

// ---- the refuse list ----

test("every refused verb is one line naming #624, #628 and #631, and the stub is never called", (t) => {
  const s = scene(t);
  const refused = [
    ["exec", "echo", "x"], ["file", "write", "/tmp/x"], ["file", "edit", "/tmp/x", "--old", "a", "--new", "b"],
    ["file", "read", "/tmp/x"], ["machine", "ls"], ["server", "status"], ["update"], ["connect"],
    ["keys", "t101", "enter"], ["attach", "t101"], ["read", "--on", "m", "t101"], ["ls", "--on=m"],
  ];
  for (const args of refused) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.deepEqual(calls(s), [], `${args.join(" ")} never reaches hc`);
  }
});

test("receiving a command without HC_TERMINAL_ID is refused, not passed through", (t) => {
  const s = scene(t);
  const r = guardRun(s, ["ls"], { HC_TERMINAL_ID: "" });
  assertRefused(r);
  assert.deepEqual(calls(s), []);
});

test("no real hc: the guard fails closed with one line", (t) => {
  const s = scene(t);
  const r = spawnSync(process.execPath, [s.guard, "ls"], {
    env: { ...envFor(s), PATH: `${GUARD_DIR}:${dirname(process.execPath)}` }, encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.match(r.stderr, /#624/);
  assert.match(r.stderr, /#628/);
  assert.match(r.stderr, /#631/);
});

// ---- send: the team, deny by default ----

test("send is allowed to each kind of team target", (t) => {
  const s = scene(t);
  const targets = [
    ["t101", "the lead"], ["t102", "a member"], ["t103", "the main bot"], ["t105", "its own worker"],
    ["t106", "a reviewer"], ["t107", "a fixer"], ["t108", "a reviewer-rank bot"],
    ["m/t101", "a machine address"], ["--on", "m", "t101", "with --on"],
  ];
  for (const target of targets) {
    const args = target[0] === "--on" ? ["send", ...target] : ["send", ...target, "hi"];
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(calls(s).some((argv) => same(argv, args)), `${args.join(" ")} arrived: ${JSON.stringify(calls(s))}`);
  }
});

test("send to a target outside the team or an unresolvable target is refused", (t) => {
  const s = scene(t);
  for (const args of [["send", "t120", "hi"], ["send", "t121", "hi"], ["send", "t999", "hi"], ["send"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.equal(calls(s).some((argv) => argv[0] === "send"), false, `${args.join(" ")} never reaches send`);
  }
});

test("a worker pane sends to its bot through its worker.of label", (t) => {
  const s = scene(t);
  const r = guardRun(s, ["send", "t100", "report"], { HC_TERMINAL_ID: "t110" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["send", "t100", "report"])));
  const bad = guardRun(s, ["send", "t120", "report"], { HC_TERMINAL_ID: "t110" });
  assertRefused(bad);
});

test("a worker's team is the main checkout's, not a bots file in its worktree", (t) => {
  const s = scene(t);
  mkdirSync(join(s.worktree, ".herdr"), { recursive: true });
  writeFileSync(join(s.worktree, ".herdr", "bots.json"), `${JSON.stringify({
    version: 1, categories: [], bots: [bot(ID.other, "main", { name: "Other" })],
  })}\n`);
  const r = guardRun(s, ["send", "t100", "report"], { HC_TERMINAL_ID: "t110" });
  assert.equal(r.status, 0, r.stderr);
});

// ---- send: the shared coordination roles and the declared lead chain ----

const SHARED_ID = {
  pm: "b-gggggggggg", integrator: "b-hhhhhhhhhh", fixer: "b-iiiiiiiiii",
  capB: "b-jjjjjjjjjj", devB: "b-kkkkkkkkkk", testerB: "b-llllllllll",
  plain: "b-mmmmmmmmmm", planned: "b-nnnnnnnnnn", unlisted: "b-oooooooooo",
  capOrch: "b-pppppppppp", capMissing: "b-qqqqqqqqqq",
};
const plannedBot = (id, extra = {}) => ({
  id, name: id, kind: "member", look: { character: "star", colour: "blue" }, role: "r",
  instructions: "i", planned: { wave: 3 }, ...extra,
});
const sharedTeam = () => {
  const file = team();
  file.bots.find((entry) => entry.id === ID.dev).rank = "dev";
  file.bots.push(
    bot(SHARED_ID.pm, "member", { name: "PM", rank: "pm", lead: ID.main }),
    bot(SHARED_ID.integrator, "member", { name: "Integrator", rank: "integrator", lead: ID.main }),
    bot(SHARED_ID.fixer, "member", { name: "Fixer", rank: "fixer", lead: ID.main }),
    bot(SHARED_ID.capB, "member", { name: "Captain B", rank: "captain", lead: ID.main }),
    bot(SHARED_ID.devB, "member", { name: "Dev B", rank: "dev", lead: SHARED_ID.capB }),
    bot(SHARED_ID.testerB, "member", { name: "Tester B", rank: "tester", lead: SHARED_ID.capB }),
    bot(SHARED_ID.plain, "member", { name: "Plain", lead: ID.main }),
    plannedBot(SHARED_ID.planned, { name: "Orchestrator" }),
    bot(SHARED_ID.capOrch, "member", { name: "Captain Orch", rank: "captain", lead: SHARED_ID.planned }),
    bot(SHARED_ID.capMissing, "member", { name: "Captain Missing", rank: "captain", lead: SHARED_ID.unlisted }),
  );
  return file;
};

/**
 * The base scene plus the shared roles, another squad, a planned listed bot and an unlisted
 * bot. The shared-role pane labels carry the same rank bots.json does, so a mutant that reads
 * role= still passes the ordinary rows and only the forged-label row catches it.
 */
function sharedScene(t) {
  const s = scene(t);
  writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(sharedTeam(), null, 2)}\n`);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const add = (address, labels, extra = {}) => {
    state.terminals.push({ address, name: address, state: "live" });
    state.get[address] = get(address, labels, { cwd: s.project, name: address, argv: launchArgv(s.app), ...extra });
  };
  add("t200", { bot: SHARED_ID.pm, role: "pm" });
  add("t201", { bot: SHARED_ID.integrator, role: "integrator" });
  add("t202", { bot: SHARED_ID.fixer, role: "fixer" });
  add("t203", { bot: SHARED_ID.capB, role: "captain" });
  add("t204", { bot: SHARED_ID.planned });
  add("t205", { bot: SHARED_ID.devB, role: "dev" });
  add("t206", { bot: SHARED_ID.testerB, role: "tester" });
  add("t207", { bot: SHARED_ID.plain });
  add("t208", { bot: ID.dev, role: "pm" }, { name: "forged" });
  add("t209", { bot: SHARED_ID.unlisted });
  add("t210", { bot: SHARED_ID.capOrch, role: "captain" });
  add("t211", { "worker.of": SHARED_ID.pm }, { cwd: s.worktree, parent: "t200" });
  add("t212", { "worker.of": SHARED_ID.integrator }, { cwd: s.worktree, parent: "t201" });
  add("t213", { "worker.of": SHARED_ID.fixer }, { cwd: s.worktree, parent: "t202" });
  add("t214", { bot: SHARED_ID.capMissing, role: "captain" });
  add("t215", { "worker.of": SHARED_ID.capOrch, role: "captain" },
    { cwd: s.worktree, parent: "t210" });
  writeFileSync(s.statePath, JSON.stringify(state));
  const bind = (terminal, id) => ({ v: 1, event: "attach", bot: id, project: s.project, terminal, core: "core",
    created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" });
  const rows = [
    ["t200", SHARED_ID.pm], ["t201", SHARED_ID.integrator], ["t202", SHARED_ID.fixer],
    ["t203", SHARED_ID.capB], ["t205", SHARED_ID.devB], ["t206", SHARED_ID.testerB],
    ["t207", SHARED_ID.plain], ["t208", ID.dev], ["t210", SHARED_ID.capOrch],
    ["t214", SHARED_ID.capMissing],
  ];
  const ledger = join(s.app, "automagik-herdr", "attach.jsonl");
  appendFileSync(ledger, rows.map(([terminal, id]) => `${JSON.stringify(bind(terminal, id))}\n`).join(""));
  chmodSync(ledger, 0o600);
  return s;
}

test("pm, integrator and fixer callers send to any listed bot outside their team", (t) => {
  const s = sharedScene(t);
  const cases = [
    ["t200", "t203", "a captain of another squad"], ["t200", "t201", "another shared role"],
    ["t200", "t204", "a planned listed bot"],
    ["t201", "t203", "a captain of another squad"], ["t201", "t200", "another shared role"],
    ["t201", "t204", "a planned listed bot"],
    ["t202", "t203", "a captain of another squad"], ["t202", "t200", "another shared role"],
    ["t202", "t201", "another shared role"],
  ];
  for (const [caller, target, why] of cases) {
    writeFileSync(s.logPath, "");
    const args = ["send", target, "sync"];
    const r = guardRun(s, args, { HC_TERMINAL_ID: caller });
    assert.equal(r.status, 0, `${caller} -> ${target} (${why}): ${r.stderr}`);
    assert.deepEqual(calls(s).filter((argv) => argv[0] === "send"), [args], `${caller} -> ${target} (${why}) arrives once, unchanged`);
  }
});

test("another rank sending sideways to a listed bot outside its team is refused", (t) => {
  const s = sharedScene(t);
  const cases = [
    ["t203", "t204", "captain"], ["t205", "t200", "dev"],
    ["t206", "t201", "tester"], ["t207", "t204", "no rank"],
  ];
  for (const [caller, target, rank] of cases) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, ["send", target, "hi"], { HC_TERMINAL_ID: caller });
    assertRefused(r);
    assert.equal(calls(s).some((argv) => argv[0] === "send"), false, `${rank} -> ${target} never reaches send`);
  }
});

test("a worker of a pm, integrator or fixer bot does not inherit the widening", (t) => {
  const s = sharedScene(t);
  const cases = [["t211", "t203"], ["t212", "t200"], ["t213", "t204"]];
  for (const [caller, target] of cases) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, ["send", target, "hi"], { HC_TERMINAL_ID: caller });
    assertRefused(r);
    assert.equal(calls(s).some((argv) => argv[0] === "send"), false, `${caller} -> ${target} never reaches send`);
  }
});

test("the rank comes from bots.json, not the caller pane's role= label", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t203", "hi"], { HC_TERMINAL_ID: "t208" });
  assertRefused(r);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false, "a forged role=pm on a dev bot's pane never widens send");
});

test("a pm caller cannot send to a pane whose bot= is not listed", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t209", "hi"], { HC_TERMINAL_ID: "t200" });
  assertRefused(r);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false, "an unlisted bot= target never reaches send");
});

test("the widening is send only: keys and rm are refused, kill is the main bot's (#955)", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const keys = guardRun(s, ["keys", "t203", "enter"], { HC_TERMINAL_ID: "t200" });
  assertRefused(keys);
  assert.deepEqual(calls(s), [], "keys never reaches hc");
  // A pm is not the project's main bot: its kill is refused like any member's (#955).
  writeFileSync(s.logPath, "");
  assertRefused(guardRun(s, ["kill", "t203"], { HC_TERMINAL_ID: "t200" }));
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "kill"), []);
  // #628: rm is the caller's own workers only; a foreign pane is refused even for a pm.
  writeFileSync(s.logPath, "");
  const rm = guardRun(s, ["rm", "t203"], { HC_TERMINAL_ID: "t200" });
  assertRefused(rm);
  assert.match(rm.stderr, /own worker/);
  assert.equal(calls(s).some((argv) => argv[0] === "rm"), false, "a foreign rm never reaches hc");
});

// ---- kill: a project's main bot only (#955, the owner's rule) ----

/** The base scene with the main bot's and the captain's seats bound in the ledger too. */
function killScene(t) {
  const s = scene(t);
  const bind = (terminal, id) => ({ v: 1, event: "attach", bot: id, project: s.project, terminal, core: "core",
    created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" });
  const ledger = join(s.app, "automagik-herdr", "attach.jsonl");
  appendFileSync(ledger, [["t103", ID.main], ["t101", ID.cap], ["t102", ID.junior]].map(([terminal, id]) => `${JSON.stringify(bind(terminal, id))}\n`).join(""));
  chmodSync(ledger, 0o600);
  return s;
}
const killsSeen = (s) => calls(s).filter((argv) => argv.includes("kill"));

test("hc kill (#955): a main bot's seat ends a pane; the roster's kind decides, on any agent", (t) => {
  // The guard never reads the agent: the same answer for a Claude, Codex, Antigravity or dsh-tui main bot.
  for (const agent of ["claude", "codex", "antigravity", "dsh-tui"]) {
    const s = killScene(t);
    const file = team();
    for (const b of file.bots) b.agent = agent;
    writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(file, null, 2)}\n`);
    const main = guardRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t103" });
    assert.equal(main.status, 0, `${agent} main: ${main.stderr}`);
    assert.deepEqual(killsSeen(s), [["kill", "t105"]], `${agent}: the main bot's kill arrives unchanged`);
    // A member that leads (the captain), a member that leads no one's squad (junior's lead dev), and a plain member.
    for (const [who, terminal] of [["a member lead", "t101"], ["a member", "t100"], ["a member with no members", "t102"]]) {
      writeFileSync(s.logPath, "");
      const r = guardRun(s, ["kill", "t105"], { HC_TERMINAL_ID: terminal });
      assertRefused(r);
      assert.match(r.stderr, /refused kill: hc kill is for a project's main bot only; end a worker you started with am worker kill <pane>/, `${agent} ${who}`);
      assert.deepEqual(killsSeen(s), [], `${agent} ${who}: nothing reached hc`);
    }
    // A worker, the main bot's own included, never kills.
    writeFileSync(s.logPath, "");
    const worker = guardRun(s, ["kill", "t110"], { HC_TERMINAL_ID: "t105" });
    assertRefused(worker);
    assert.match(worker.stderr, /hc kill is for a project's main bot only, never a worker/);
    assert.deepEqual(killsSeen(s), []);
  }
});

test("with the proxy off, a main bot's kill refuses a machine-resolving name and the direct address (#628)", (t) => {
  // `edit <bot> --hc-proxy off` leaves this guard as the only hc check. `worker-m` is a pane
  // `hc ls` resolves to `m/t105`; the guard refuses the resolved address, never forwards the
  // name, and the main bot still ends a local pane at the address it checked.
  const s = killScene(t);
  for (const args of [["kill", "worker-m"], ["kill", "m/t105"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args, { HC_TERMINAL_ID: "t103" });
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.deepEqual(killsSeen(s), [], `${args.join(" ")} never reaches hc`);
  }
  writeFileSync(s.logPath, "");
  const local = guardRun(s, ["kill", "worker"], { HC_TERMINAL_ID: "t103" });
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(killsSeen(s), [["kill", "t105"]], "the checked address is the one forwarded");
});

test("hc kill (#955): a flag before the command is refused for everyone, the main bot too; an unknown caller is refused", (t) => {
  const s = killScene(t);
  for (const terminal of ["t103", "t101", "t100", "t105"]) {
    for (const args of [["--json", "kill", "t105"], ["--timeout", "5", "kill", "t105"], ["-q", "kill", "t105"]]) {
      writeFileSync(s.logPath, "");
      assertRefused(guardRun(s, args, { HC_TERMINAL_ID: terminal }));
      assert.deepEqual(calls(s), [], `${args.join(" ")} from ${terminal} never reaches hc`);
    }
  }
  // A pane that is neither bound nor a worker; and a bound bot its project's roster doesn't list.
  writeFileSync(s.logPath, "");
  assertRefused(guardRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t121" }));
  const file = team();
  file.bots = file.bots.filter((b) => b.id !== ID.main);
  writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(file, null, 2)}\n`);
  const gone = guardRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t103" });
  assertRefused(gone);
  assert.match(gone.stderr, /the caller's bot is not in its project's bots\.json/);
  assert.deepEqual(killsSeen(s), []);
});

// ---- the hc kill shim: the same rule on every other agent's pane (#955) ----

const KILL_SHIM = join(KILL_GUARD_DIR, "hc");
/** The shim as a Claude, Codex or Antigravity pane runs it: its folder first on PATH, then the real hc's. */
const shimRun = (s, args, extra = {}) => spawnSync(process.execPath, [KILL_SHIM, ...args],
  { env: envFor(s, { PATH: `${KILL_GUARD_DIR}:${s.bin}:${dirname(process.execPath)}`, ...extra }), encoding: "utf8" });
function assertShimRefused(r, why) {
  assert.equal(r.status, 2, `a refusal exits 2: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `exactly one stderr line: ${JSON.stringify(r.stderr)}`);
  assert.match(r.stderr, /^hc kill shim: refused kill: /);
  assert.match(r.stderr, /\(#955\)\. This shim is a guardrail on the pane's PATH, not a boundary\.\n$/);
  if (why) assert.match(r.stderr, why);
  assert.equal(r.stdout, "", "a refusal prints nothing on stdout");
}
/** Every order hc takes `kill` in: its one option before, between and after. */
const KILL_ORDERS = [["kill", "t105"], ["--json", "kill", "t105"], ["kill", "--json", "t105"], ["kill", "t105", "--json"]];

test("the kill shim's entry is an executable file beside hcGuard.mjs, and names the command of a call", () => {
  assert.ok(statSync(KILL_SHIM).mode & 0o111, "hc-kill/hc is executable");
  assert.equal(dirname(KILL_GUARD_DIR), dirname(GUARD_DIR), "beside the full guard's folder");
  assert.equal(hcVerbOf(["kill", "t1"]), "kill");
  assert.equal(hcVerbOf(["--json", "kill", "t1"]), "kill");
  assert.equal(hcVerbOf(["send", "t1", "kill"]), "send", "kill as text is no kill");
  assert.equal(hcVerbOf(["--json", "send", "kill"]), "send");
  assert.equal(hcVerbOf([]), "");
  assert.equal(hcVerbOf(["--version"]), "");
});

test("kill shim (#955): per agent kind and per bot kind, hc kill in every flag order is the main bot's seat only", (t) => {
  // The roster's kind decides, never the agent: Claude Code, Codex and Antigravity panes get the shim;
  // a dsh-tui roster gives the same answers (its panes run the full guard, which uses the same rule).
  for (const agent of ["claude", "codex", "antigravity", "dsh-tui"]) {
    const s = killScene(t);
    const file = team();
    for (const b of file.bots) b.agent = agent;
    writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(file, null, 2)}\n`);
    for (const args of KILL_ORDERS) {
      const said = `${agent}: hc ${args.join(" ")}`;
      writeFileSync(s.logPath, "");
      const main = shimRun(s, args, { HC_TERMINAL_ID: "t103" });
      assert.equal(main.status, 0, `${said} from the main bot's seat: ${main.stderr}`);
      assert.deepEqual(killsSeen(s), [args], `${said}: the main bot's kill arrives word for word`);
      for (const [who, terminal] of [["a member lead's seat", "t101"], ["a member's seat", "t100"], ["a member's seat with a lead that is no main bot", "t102"]]) {
        writeFileSync(s.logPath, "");
        assertShimRefused(shimRun(s, args, { HC_TERMINAL_ID: terminal }),
          /hc kill is for a project's main bot only; end a worker you started with am worker kill <pane>/);
        assert.deepEqual(killsSeen(s), [], `${said} from ${who}: no kill reached hc`);
      }
      // A worker never kills: a member's and the main bot's own alike.
      writeFileSync(s.logPath, "");
      assertShimRefused(shimRun(s, args, { HC_TERMINAL_ID: "t105" }), /hc kill is for a project's main bot only, never a worker/);
      assert.deepEqual(killsSeen(s), [], `${said} from a worker: no kill reached hc`);
    }
  }
});

test("kill shim (#955): a main bot's own worker is a worker; a seat on a roster edited to main gets kill", (t) => {
  const s = killScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.t105.labels["worker.of"] = ID.main;
  writeFileSync(s.statePath, JSON.stringify(state));
  assertShimRefused(shimRun(s, ["kill", "t110"], { HC_TERMINAL_ID: "t105" }), /never a worker/);
  // The kind is the roster's, read on every call: no label and no environment word grants it.
  writeFileSync(s.logPath, "");
  assertShimRefused(shimRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t101", AM_BOT_KIND: "main", HERDR_BOT_KIND: "main" }));
  assert.deepEqual(killsSeen(s), []);
});

test("kill shim (#955): every other hc call goes to the real hc untouched; a send is read first (#1414)", (t) => {
  const s = killScene(t);
  const others = [["send", "t105", "status?"], ["send", "t105", "kill"], ["--json", "send", "t105", "kill"], ["exec", "--", "sh", "-c", "echo kill"],
    ["run", "--bg", "claude"], ["keys", "t105", "enter"], ["interrupt", "t105"], ["rm", "t105"], ["read", "t105"], ["label", "t105", "a=b"],
    ["file", "write", "/x"], ["machine", "ls"], ["server", "status"], ["attach", "t105"], ["ls", "--all"], ["get", "t105"],
    ["--version"], ["--skill"], ["--help"], ["kill", "--help"], ["kill", "-h"], []];
  // A send first resolves its target and looks at its screen (one call each); the text then
  // goes to the real hc word for word, exactly once.
  const sendLookups = [["ls", "--json"], ["get", "t105", "--json"], ["read", "t105", "--lines", "40", "--json"]];
  for (const terminal of ["t103", "t101", "t100", "t105", "t121"]) {
    for (const args of others) {
      writeFileSync(s.logPath, "");
      const r = shimRun(s, args, { HC_TERMINAL_ID: terminal, HC_STUB_CODE: "7" });
      // The stub answers ls, get and read itself (exit 0); everything else exits with the code it was given.
      const stubAnswers = ["ls", "get", "read"].includes(args[0]);
      assert.equal(r.status, stubAnswers ? 0 : 7, `hc ${args.join(" ")} from ${terminal}: the real hc's exit code (${r.stderr})`);
      assert.doesNotMatch(r.stderr, /hc kill shim/, `hc ${args.join(" ")}: the shim says nothing`);
      const isSend = args[0] === "send" || args[1] === "send";
      const expected = isSend ? [...sendLookups, args] : [args];
      assert.deepEqual(calls(s), expected, `hc ${args.join(" ")} from ${terminal}: the lookups then one call, word for word`);
    }
  }
  // No HC_TERMINAL_ID at all: still passed on (only a kill needs a caller).
  writeFileSync(s.logPath, "");
  const bare = spawnSync(process.execPath, [KILL_SHIM, "send", "t105", "hi"], { env: (() => {
    const env = envFor(s, { PATH: `${KILL_GUARD_DIR}:${s.bin}:${dirname(process.execPath)}` });
    delete env.HC_TERMINAL_ID;
    return env;
  })(), encoding: "utf8" });
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(calls(s), [...sendLookups, ["send", "t105", "hi"]]);
});

test("kill shim (#955): a kill it cannot check is refused; no real hc is exit 127; it never hands a call to another guard", (t) => {
  const s = killScene(t);
  // A pane that is neither bound nor a worker.
  assertShimRefused(shimRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t121" }), /neither bound in the attach ledger nor a worker pane/);
  // No terminal id; a ledger anyone could have written (never read).
  assertShimRefused(shimRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "" }), /a call without HC_TERMINAL_ID cannot be checked/);
  chmodSync(join(s.app, "automagik-herdr", "attach.jsonl"), 0o666);
  assertShimRefused(shimRun(s, ["kill", "t105"], { HC_TERMINAL_ID: "t103" }), /the caller could not be checked/);
  chmodSync(join(s.app, "automagik-herdr", "attach.jsonl"), 0o600);
  assert.deepEqual(killsSeen(s), []);
  // No real hc on PATH: said once, exit 127, for a kill and for any other call.
  for (const args of [["kill", "t105"], ["ls"]]) {
    const none = shimRun(s, args, { HC_TERMINAL_ID: "t103", PATH: `${KILL_GUARD_DIR}:${dirname(process.execPath)}` });
    assert.equal(none.status, 127, none.stderr);
    assert.equal(none.stderr, "hc kill shim: the real hc is not on PATH (#955).\n");
  }
  // The full guard's folder after the shim (a Claude worker that inherited a dsh-tui pane's PATH):
  // the shim goes past it to the real hc, so a call the full guard refuses is still passed on.
  writeFileSync(s.logPath, "");
  const past = shimRun(s, ["exec", "--", "true"], { HC_TERMINAL_ID: "t100", PATH: `${KILL_GUARD_DIR}:${GUARD_DIR}:${s.bin}:${dirname(process.execPath)}` });
  assert.equal(past.status, 0, past.stderr);
  assert.deepEqual(calls(s), [["exec", "--", "true"]]);
  // The shim's folder after the full guard: the guard does not take the shim for the real hc.
  writeFileSync(s.logPath, "");
  const under = guardRun(s, ["ls"], { HC_TERMINAL_ID: "t100", PATH: `${GUARD_DIR}:${KILL_GUARD_DIR}:${s.bin}:${dirname(process.execPath)}` });
  assert.equal(under.status, 0, under.stderr);
  assert.deepEqual(calls(s), [["ls"]], "one call: the guard went straight to the real hc");
  // And a dsh-tui worker's PATH word that starts with the shim's folder is no guard to the full guard.
  writeFileSync(s.logPath, "");
  const shape = guardRun(s, ["run", "--bg", "--cwd", s.worktree, "--parent", "t100", "--label", `worker.of=${ID.dev}`, "--",
    "/usr/bin/env", `PATH=${KILL_GUARD_DIR}:/bin`, "dsh-tui", "--", "task"], { HC_TERMINAL_ID: "t100" });
  assertRefused(shape);
  assert.match(shape.stderr, /the PATH word does not start with a guard/);
});

test("a captain reaches its declared lead even when that lead is planned", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const args = ["send", "t204", "status"];
  const r = guardRun(s, args, { HC_TERMINAL_ID: "t210" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "send"), [args]);
});

test("a captain can send to another squad's captain by roster rank", (t) => {
  const s = sharedScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  delete state.get.t203.labels.role;
  state.get.t210.labels.role = "dev";
  writeFileSync(s.statePath, JSON.stringify(state));
  writeFileSync(s.logPath, "");
  const args = ["send", "t203", "gate request"];
  const r = guardRun(s, args, { HC_TERMINAL_ID: "t210" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "send"), [args]);
});

test("a dev can send to another squad's tester by roster rank", (t) => {
  const s = sharedScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  delete state.get.t206.labels.role;
  writeFileSync(s.statePath, JSON.stringify(state));
  const args = ["send", "t206", "verdict request"];
  const r = guardRun(s, args, { HC_TERMINAL_ID: "t208" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "send"), [args]);
});

test("a dev cannot send to another squad's captain", (t) => {
  const s = sharedScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.t208.labels.role = "captain";
  writeFileSync(s.statePath, JSON.stringify(state));
  const r = guardRun(s, ["send", "t203", "hi"], { HC_TERMINAL_ID: "t208" });
  assertRefused(r);
  assert.match(r.stderr, /the target is not in the caller's team/);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
});

test("a captain's worker cannot use captain-to-captain sends", (t) => {
  const s = sharedScene(t);
  const r = guardRun(s, ["send", "t203", "hi"], { HC_TERMINAL_ID: "t215" });
  assertRefused(r);
  assert.match(r.stderr, /the target is not in the caller's team/);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
});

test("tester and captain target labels alone do not widen sends", (t) => {
  const s = sharedScene(t);
  for (const role of ["tester", "captain"]) {
    const state = JSON.parse(readFileSync(s.statePath, "utf8"));
    state.get.t205.labels.role = role;
    state.get.t209.labels.role = role;
    writeFileSync(s.statePath, JSON.stringify(state));
    for (const target of ["t205", "t209"]) {
      writeFileSync(s.logPath, "");
      const r = guardRun(s, ["send", target, "hi"], { HC_TERMINAL_ID: "t210" });
      assertRefused(r);
      assert.match(r.stderr, /the target is not in the caller's team/);
      assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
    }
  }
});

test("a declared lead id not listed in bots.json adds nothing", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t209", "hi"], { HC_TERMINAL_ID: "t214" });
  assertRefused(r);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false, "an unlisted declared lead never names a target");
});

// ---- machine targets, and label on the caller's own workers ----

test("a machine target is refused on every allowed verb but send", (t) => {
  const s = scene(t);
  const cases = [
    ["read", "m/t101"], ["read", "--lines", "5", "m/t101"], ["get", "m/t101"], ["wait", "m/t101"],
    ["label", "m/t101", "role=reviewer"], ["kill", "m/t101"], ["rm", "m/t101"],
  ];
  for (const args of cases) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.deepEqual(calls(s), [], `${args.join(" ")} never reaches hc`);
  }
  writeFileSync(s.logPath, "");
  const team = guardRun(s, ["send", "m/t101", "hi"]);
  assert.equal(team.status, 0, team.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["send", "m/t101", "hi"])));
  for (const args of [["send", "m/t120", "hi"], ["send", "--on", "m", "t120", "hi"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
  }
});

test("with the proxy off, a machine target named by a name is refused (#628)", (t) => {
  // `edit <bot> --hc-proxy off` leaves this guard as the only hc check. The lexical check
  // above cannot see a name; the resolved address decides, for reads/waits and rm alike.
  const s = scene(t);
  for (const [args, address] of [
    [["read", "cap-m"], "m/t101"], [["get", "cap-m"], "m/t101"], [["wait", "cap-m"], "m/t101"],
    [["rm", "worker-m"], "m/t105"],
    [["read", "other-m"], "m/t120"], [["rm", "other-m"], "m/t120"],
  ]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.equal(calls(s).some((argv) => same(argv, [args[0], address])), false,
      `${args.join(" ")} never forwards its machine address`);
  }
});

test("with the proxy off, label and events refuse a machine-resolving name and the direct address (#628)", (t) => {
  // `edit <bot> --hc-proxy off` leaves this guard as the only hc check. A name passes the
  // lexical check; the address hc resolves decides, and the checked address is what is
  // forwarded. `worker-m` is the caller's own worker on a machine, so label's own-worker
  // check passes and only the resolved-address rule refuses it.
  const s = scene(t);
  for (const args of [
    ["label", "worker-m", "role=reviewer"], ["label", "m/t105", "role=reviewer"],
  ]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.equal(calls(s).some((argv) => argv[0] === "label"), false, `${args.join(" ")} never reaches hc`);
  }
  for (const args of [
    ["events", "--terminal", "cap-m"], ["events", "--terminal=m/t101"],
    ["events", "--children-of", "worker-m"], ["events", "--children-of=m/t105"],
  ]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.equal(calls(s).some((argv) => argv[0] === "events"), false, `${args.join(" ")} never reaches hc`);
  }
  // A local name still passes, at the address the guard checked.
  writeFileSync(s.logPath, "");
  const label = guardRun(s, ["label", "worker", "role=dev"]);
  assert.equal(label.status, 0, label.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["label", "t105", "role=dev"])), JSON.stringify(calls(s)));
  writeFileSync(s.logPath, "");
  const events = guardRun(s, ["events", "--terminal", "cap"]);
  assert.equal(events.status, 0, events.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["events", "--terminal", "t101"])), JSON.stringify(calls(s)));
});

test("a machine target named by an hc events option is refused", (t) => {
  const s = scene(t);
  const cases = [
    ["events", "--terminal", "m/t101"], ["events", "--terminal=m/t101"],
    ["events", "--children-of", "m/t101"], ["events", "--children-of=m/t101"],
  ];
  for (const args of cases) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.deepEqual(calls(s), []);
  }
  writeFileSync(s.logPath, "");
  const local = guardRun(s, ["events", "--terminal", "t101"]);
  assert.equal(local.status, 0, local.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["events", "--terminal", "t101"])));
});

test("label is the caller's own workers only; a label cannot widen send", (t) => {
  const s = scene(t);
  writeFileSync(s.logPath, "");
  let r = guardRun(s, ["label", "t101", "role=reviewer"]);
  assertRefused(r);
  assert.match(r.stderr, /own worker/);
  assert.equal(calls(s).some((argv) => argv[0] === "label"), false, "a foreign label never reaches hc");
  r = guardRun(s, ["label", "t120", "role=reviewer"]);
  assertRefused(r);
  assert.equal(calls(s).some((argv) => argv[0] === "label"), false, "the label-then-send pane is never labelled");
  r = guardRun(s, ["send", "t120", "hi"]);
  assertRefused(r);
  r = guardRun(s, ["label", "t105", "role=dev"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["label", "t105", "role=dev"])));
});

// ---- #628: reads and waits, rm, and put, on the same team boundary as the proxy ----

test("read, get and wait see the caller's pane, its own workers and its team (#628)", (t) => {
  const s = scene(t);
  // Its own pane, its lead, a member, the main bot and its own workers: the team graph.
  for (const args of [["read", "t100"], ["read", "t101"], ["read", "--lines", "5", "t102"],
    ["get", "t103"], ["wait", "t102"], ["read", "t110"], ["wait", "--timeout", "1", "t105"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  }
  // A name is resolved once and the checked address is the one forwarded.
  writeFileSync(s.logPath, "");
  assert.equal(guardRun(s, ["get", "cap"]).status, 0);
  assert.ok(calls(s).some((argv) => same(argv, ["get", "t101"])), "the resolved address is forwarded");
  // The shared send roles stay send only: a reviewer/fixer label, a roster reviewer rank, a
  // stranger's pane, a bare pane and an unknown target are all refused.
  for (const args of [["read", "t106"], ["read", "t107"], ["get", "t108"], ["wait", "t108"],
    ["read", "t120"], ["get", "t120"], ["wait", "t120"], ["read", "t121"], ["read", "t999"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    const verb = args[0];
    if (verb !== "get") {
      assert.equal(calls(s).some((argv) => same(argv, [verb, args.at(-1)])), false,
        `${args.join(" ")} never reaches ${verb}`);
    }
  }
  assert.match(guardRun(s, ["read", "t120"]).stderr, /not in the caller's team/);
  assert.match(guardRun(s, ["read", "t999"]).stderr, /not resolvable/);
});

test("rm ends the caller's own workers only (#628)", (t) => {
  const s = scene(t);
  for (const target of ["t105", "t110"]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, ["rm", target]);
    assert.equal(r.status, 0, `rm ${target}: ${r.stderr}`);
    assert.ok(calls(s).some((argv) => same(argv, ["rm", target])), `rm ${target} arrives at its address`);
  }
  for (const target of ["t101", "t102", "t106", "t108", "t120", "t121"]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, ["rm", target]);
    assertRefused(r);
    assert.match(r.stderr, /own worker/);
    assert.equal(calls(s).some((argv) => same(argv, ["rm", target])), false, `rm ${target} never reaches hc`);
  }
  const self = guardRun(s, ["rm", "t100"]);
  assertRefused(self);
  assert.match(self.stderr, /own pane/);
  const unknown = guardRun(s, ["rm", "t999"]);
  assertRefused(unknown);
  assert.match(unknown.stderr, /not resolvable/);
  // A worker pane ends nothing, not even a sibling of its own bot.
  writeFileSync(s.logPath, "");
  const worker = guardRun(s, ["rm", "t105"], { HC_TERMINAL_ID: "t110" });
  assertRefused(worker);
  assert.match(worker.stderr, /worker pane ends no panes/);
  assert.equal(calls(s).some((argv) => same(argv, ["rm", "t105"])), false);
});

test("put is refused: a guarded pane writes nothing beside another pane (#628)", (t) => {
  const s = scene(t);
  for (const args of [["put", "t101", "/tmp/file"], ["put", "t105", "/tmp/file"],
    ["put", "t120", "/tmp/file"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.match(r.stderr, /terminal\.put/);
    assert.deepEqual(calls(s), [], `${args.join(" ")} never reaches hc`);
  }
  // Its help still passes, like every other named command's.
  writeFileSync(s.logPath, "");
  const help = guardRun(s, ["put", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["put", "--help"])));
});

// ---- the dsh-tui worker run shape ----

const exactRun = (s, over = {}) => workerArgs({
  botId: ID.dev, branch: "feat/x", role: "dev", name: "feat-x", cwd: s.worktree, parent: "t100",
  agent: "dsh-tui", argv: ["dsh-tui"], task: "do it", path: "/usr/bin:/bin", space: "sp1", ...over,
});

function forgedMainHome(s) {
  const app = join(s.root, "forged-app");
  const ledger = join(s.app, "automagik-herdr", "attach.jsonl");
  const row = JSON.parse(readFileSync(ledger, "utf8"));
  mkdirSync(join(app, "automagik-herdr"), { recursive: true });
  writeFileSync(join(app, "automagik-herdr", "attach.jsonl"),
    `${JSON.stringify({ ...row, bot: ID.main })}\n`, { mode: 0o600 });
  return { HERDR_APP_HOME: app };
}

test("a forged invocation home grants neither a foreign send nor a main-only kill (#628)", (t) => {
  const s = scene(t);
  const env = forgedMainHome(s);
  const foreign = guardRun(s, ["send", "t120", "hi"], env);
  assertRefused(foreign);
  assert.match(foreign.stderr, /not in the caller's team/);
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);

  writeFileSync(s.logPath, "");
  const team = guardRun(s, ["send", "t101", "hi"], env);
  assert.equal(team.status, 0, team.stderr);
  assert.deepEqual(calls(s).at(-1), ["send", "t101", "hi"]);

  for (const invoke of [guardRun, shimRun]) {
    writeFileSync(s.logPath, "");
    const kill = invoke(s, ["kill", "t120"], env);
    if (invoke === guardRun) assertRefused(kill);
    else assertShimRefused(kill);
    assert.match(kill.stderr, /main bot only/);
    assert.deepEqual(calls(s), [["get", "t100", "--json"]]);
  }
});

test("guarded sends, kills and worker starts require a live caller with a valid launch record (#628)", (t) => {
  const cases = [
    ["not found", null, /not resolvable/],
    ["different address", { address: "t101" }, /not resolvable/],
    ["finished", { state: "finished" }, /not live/],
    ["absent argv", { argv: undefined }, /no valid launch argv/],
    ["non-array argv", { argv: "dsh-tui" }, /no valid launch argv/],
    ["absent created_ms", { created_ms: undefined }, /no valid created_ms/],
    ["unsafe created_ms", { created_ms: Number.MAX_SAFE_INTEGER + 1 }, /no valid created_ms/],
  ];
  for (const [name, patch, reason] of cases) {
    const s = killScene(t);
    if (patch) editPane(s, "t100", patch);
    else {
      const state = JSON.parse(readFileSync(s.statePath, "utf8"));
      delete state.get.t100;
      writeFileSync(s.statePath, JSON.stringify(state));
    }
    for (const args of [["send", "t101", "hi"], ["kill", "t105"], exactRun(s)]) {
      writeFileSync(s.logPath, "");
      const r = guardRun(s, args);
      assertRefused(r);
      assert.match(r.stderr, reason, name);
      assert.deepEqual(calls(s), [["get", "t100", "--json"]], name);
    }
    writeFileSync(s.logPath, "");
    assertShimRefused(shimRun(s, ["kill", "t105"]), reason);
    assert.deepEqual(calls(s), [["get", "t100", "--json"]], name);
  }
});

test("a machine-qualified caller is refused before hc is queried (#628)", (t) => {
  const s = scene(t);
  const env = { HC_TERMINAL_ID: "m/t101" };
  const r = guardRun(s, ["send", "t100", "hi"], env);
  assertRefused(r);
  assert.match(r.stderr, /caller.*machine-qualified/);
  assertShimRefused(shimRun(s, ["kill", "t100"], env), /caller.*machine-qualified/);
  assert.deepEqual(calls(s), []);
});

test("a binding from an earlier pane lifetime grants no seat (#628)", (t) => {
  const s = scene(t);
  editPane(s, "t100", { created_ms: 101 });
  const r = guardRun(s, ["send", "t101", "hi"]);
  assertRefused(r);
  assert.match(r.stderr, /neither bound in the attach ledger nor a worker pane/);
  assert.deepEqual(calls(s), [["get", "t100", "--json"]]);
});

test("a worker's caller lookup also supplies its worker.of fallback (#628)", (t) => {
  const s = scene(t);
  const r = guardRun(s, ["send", "t100", "hi"], { HC_TERMINAL_ID: "t110" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "get" && argv[1] === "t110"),
    [["get", "t110", "--json"]]);
});

test("a worker launch cannot set HERDR_APP_HOME in its env prefix (#628)", (t) => {
  const s = scene(t);
  const args = exactRun(s);
  args.splice(args.indexOf("--") + 3, 0, `HERDR_APP_HOME=${s.app}`);
  const r = guardRun(s, args);
  assertRefused(r);
  assert.match(r.stderr, /worker launch cannot set HERDR_APP_HOME/);
  assert.deepEqual(calls(s), []);
});

test("a recognized worker program still requires the caller's real ledger binding (#628)", (t) => {
  const s = scene(t);
  const env = forgedMainHome(s);
  const worker = { agent: "codex", argv: ["codex"], path: `${GUARD_DIR}:/usr/bin:/bin` };
  const wrongBot = guardRun(s, exactRun(s, { ...worker, botId: ID.main }), env);
  assertRefused(wrongBot);
  assert.match(wrongBot.stderr, /worker\.of is not the caller's bot/);
  assert.deepEqual(calls(s), [["get", "t100", "--json"]]);

  writeFileSync(s.logPath, "");
  const exact = exactRun(s, worker);
  const ownBot = guardRun(s, exact, env);
  assert.equal(ownBot.status, 0, ownBot.stderr);
  assert.deepEqual(calls(s), [["get", "t100", "--json"], exact]);
});

test("the exact dsh-tui worker argv reaches the stub unchanged", (t) => {
  const s = scene(t);
  const exact = exactRun(s);
  assert.equal(exact[exact.indexOf("--") + 3], "dsh-tui", exact.join(" "));
  assert.ok(exact[exact.indexOf("--") + 2].startsWith(`PATH=${GUARD_DIR}:`), exact.join(" "));
  writeFileSync(s.logPath, "");
  const r = guardRun(s, exact);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), [["get", "t100", "--json"], exact]);
});

// #1011: a dsh-tui lead's full guard starts a worker of any agent the pack launches, not dsh-tui
// alone. Claude carries its agent.session label and its login words (the default login puts
// `-u CLAUDE_CONFIG_DIR` before PATH); every other agent kind starts from its own program.
test("a dsh-tui lead's guard accepts a Claude worker with its session label (#1011)", (t) => {
  const s = scene(t);
  const exact = exactRun(s, {
    agent: "claude", argv: ["claude", "--session-id", "session-1"], session: "session-1", login: ["-u", "CLAUDE_CONFIG_DIR"],
    path: `${GUARD_DIR}:/usr/bin:/bin`,
  });
  assert.ok(exact.includes("agent.session=session-1"), exact.join(" "));
  writeFileSync(s.logPath, "");
  const r = guardRun(s, exact);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), [["get", "t100", "--json"], exact], "the Claude worker launch reached hc unchanged");
});

test("a dsh-tui lead's guard accepts every other agent kind's worker launch (#1011)", (t) => {
  const s = scene(t);
  const starts = {
    codex: ["codex"], antigravity: ["agy", "--mode", "auto"], omp: ["omp"], pi: ["pi"],
    opencode: ["opencode"], cursor: ["cursor-agent"], copilot: ["copilot"], amp: ["amp"], grok: ["grok"],
    kimi: ["kimi"], kiro: ["kiro-cli"], hermes: ["hermes"], qoder: ["qodercli"], crush: ["crush"],
  };
  for (const [agent, argv] of Object.entries(starts)) {
    const exact = exactRun(s, { agent, argv, task: "do it", path: `${GUARD_DIR}:/usr/bin:/bin` });
    writeFileSync(s.logPath, "");
    const r = guardRun(s, exact);
    assert.equal(r.status, 0, `${agent}: ${r.stderr}`);
    assert.deepEqual(calls(s), [["get", "t100", "--json"], exact], `${agent}: the worker launch reached hc unchanged`);
  }
});

test("a run that is not the worker shape is refused before hc", (t) => {
  const s = scene(t);
  const exact = exactRun(s);
  const parentAt = exact.indexOf("--parent");
  const withoutParent = [...exact.slice(0, parentAt), "--no-parent", ...exact.slice(parentAt + 2)];
  const beforeDash = exact.indexOf("--");
  const withFlag = (flag) => [...exact.slice(0, beforeDash), flag, ...exact.slice(beforeDash)];
  const noGuardPath = [...exact];
  noGuardPath[noGuardPath.indexOf("--") + 2] = "PATH=/usr/bin:/bin";
  const template = [...exact.slice(0, parentAt), "--label", "worker.template=dev-sol", ...exact.slice(parentAt)];
  const notAnAgent = [...exact];
  notAnAgent[notAnAgent.indexOf("--") + 3] = "bash";
  const wrongCwd = exactRun(s, { cwd: s.project });
  const foreignParent = exactRun(s, { parent: "t101" });
  const foreignBot = exactRun(s, { botId: ID.cap });
  const bare = ["run", "--bg", "--parent", "t100", "--", "/usr/bin/env", `PATH=${GUARD_DIR}:/usr/bin`, "dsh-tui", "--", "task"];
  const cases = [
    ["bare", bare], ["foreign parent", foreignParent], ["foreign worker.of", foreignBot],
    ["cwd outside the worktrees", wrongCwd], ["template", template], ["not an agent", notAnAgent],
    ["no parent", withoutParent], ["outlive-parent", withFlag("--outlive-parent")], ["keep", withFlag("--keep")],
    ["--on", withFlag("--on")], ["no guard on PATH", noGuardPath],
  ];
  for (const [name, args] of cases) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args);
    assertRefused(r);
    assert.equal(calls(s).some((argv) => argv[0] === "run"), false, `${name}: run never reaches hc`);
  }
});

test("a worker pane cannot start a worker: the ledger has no binding for it", (t) => {
  const s = scene(t);
  const withWorker = exactRun(s, { parent: "t110", botId: ID.dev });
  const r = guardRun(s, withWorker, { HC_TERMINAL_ID: "t110" });
  assertRefused(r);
  assert.deepEqual(calls(s).some((argv) => argv[0] === "run"), false);
});

// ---- the PATH word: dsh-tui only ----

/** A folder with a planted hcGuard.mjs and a guard/hc: not a guard after #643. */
function plantedGuard(root, name) {
  const mod = join(root, name), guard = join(mod, "guard");
  mkdirSync(guard, { recursive: true });
  writeFileSync(join(mod, "hcGuard.mjs"), "// planted, not this guard\n");
  return guard;
}

/**
 * A guard copy (#643): hcGuard.mjs byte-equal to this pack's, and an `hc` entry that logs a
 * marker and exits 9. If the copy is a guard, it is skipped and the marker never appears.
 */
function guardCopy(root, name, { entry = null } = {}) {
  const mod = join(root, name), guard = join(mod, "guard");
  mkdirSync(guard, { recursive: true });
  writeFileSync(join(mod, "hcGuard.mjs"), readFileSync(join(GUARD_DIR, "..", "hcGuard.mjs")));
  if (entry) writeFileSync(join(guard, "hc"), entry);
  else copyFileSync(join(GUARD_DIR, "hc"), join(guard, "hc"));
  chmodSync(join(guard, "hc"), 0o755);
  return guard;
}

test("a mixed am+pack guard PATH reaches the real hc once, never a guard as hc", (t) => {
  const s = scene(t);
  const marker = join(s.root, "am-guard-called");
  const amGuard = guardCopy(s.root, "am", { entry: `#!/bin/sh\n: > "${marker}"\nexit 1\n` });
  const exact = exactRun(s);
  exact[exact.indexOf("--") + 2] = `PATH=${amGuard}:${GUARD_DIR}:/usr/bin:/bin`;
  writeFileSync(s.logPath, "");
  const r = guardRun(s, exact, { PATH: `${amGuard}:${GUARD_DIR}:${s.bin}:${dirname(process.execPath)}` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), [["get", "t100", "--json"], exact], "the real hc got the mixed-PATH worker argv once");
  assert.equal(existsSync(marker), false, "the am guard copy was skipped, not run as hc");
});

test("a pair of guard copies never loops: both are skipped and the stub runs once", (t) => {
  const s = scene(t);
  const copy = (name) => {
    const marker = join(s.root, `${name}-ran`);
    return { marker, guard: guardCopy(s.root, name, { entry: `#!/bin/sh\n: > "${marker}"\nexit 9\n` }) };
  };
  const a = copy("copy-a"), b = copy("copy-b");
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["read", "t101"], { PATH: `${a.guard}:${b.guard}:${s.bin}:${dirname(process.execPath)}` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "read"), [["read", "t101"]],
    "the real hc ran once; the guard copies did not");
  assert.equal(existsSync(a.marker), false, "the first guard copy was skipped");
  assert.equal(existsSync(b.marker), false, "the second guard copy was skipped");
});

test("a planted hcGuard.mjs is not a guard: its hc is an ordinary PATH entry, not skipped", (t) => {
  const s = scene(t);
  const guard = plantedGuard(s.root, "planted");
  const marker = join(s.root, "planted-ran");
  writeFileSync(join(guard, "hc"), `#!/bin/sh\n: > "${marker}"\nexit 7\n`);
  chmodSync(join(guard, "hc"), 0o755);
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["read", "t101"], { PATH: `${GUARD_DIR}:${guard}:${dirname(process.execPath)}` });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(existsSync(marker), true, "the planted hc was reached, not skipped");
  // The planted hc answered no target record, so the team check fails closed instead of
  // forwarding a read it could not check.
  assert.match(r.stderr, /not resolvable/);
  assert.deepEqual(calls(s), [], "the stub never ran: the planted folder was not skipped");
});

test("a planted guard folder is not the worker shape's guard word", (t) => {
  const s = scene(t);
  const planted = plantedGuard(s.root, "planted-word");
  writeFileSync(join(planted, "hc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(planted, "hc"), 0o755);
  const exact = exactRun(s);
  exact[exact.indexOf("--") + 2] = `PATH=${planted}:/usr/bin`;
  writeFileSync(s.logPath, "");
  const r = guardRun(s, exact);
  assertRefused(r);
  assert.match(r.stderr, /PATH word does not start with a guard/);
  assert.deepEqual(calls(s), [], "the run never reached hc");
});

test("#721: the byte-equal guard rule is one helper, which the CLI imports and the proxy does not copy", async (t) => {
  const s = scene(t);
  const { isGuardFolder } = await import("../mods/am-sidebar/hcGuard.mjs");
  assert.equal(isGuardFolder(GUARD_DIR), true, "this pack's own guard folder");
  assert.equal(isGuardFolder(guardCopy(s.root, "equal-copy")), true, "a byte-equal copy (am's)");
  assert.equal(isGuardFolder(plantedGuard(s.root, "planted-rule")), false, "a planted hcGuard.mjs");
  assert.equal(isGuardFolder(join(s.root, "missing", "guard")), false, "a folder that is not there");
  assert.equal(isGuardFolder(""), false);
  const mod = join(GUARD_DIR, "..");
  const cli = readFileSync(join(mod, "bin", "automagik-herdr.mjs"), "utf8");
  assert.match(cli, /^import \{ isGuardFolder \} from "\.\.\/hcGuard\.mjs";$/m, "the CLI imports the guard's rule");
  assert.doesNotMatch(cli, /function isGuard|["']hcGuard\.mjs["']\)/, "the CLI reads no hcGuard.mjs bytes of its own");
  const proxy = readFileSync(join(mod, "hcProxy.mjs"), "utf8");
  assert.doesNotMatch(proxy, /isGuardFolder|["']hcGuard\.mjs["']\)/, "the proxy keeps no guard-folder rule of its own");
});

test("a set re-entry marker is refused, never allowed: no guard has to be behind it", (t) => {
  const s = scene(t);
  const r = guardRun(s, ["read", "t101"], { AM_HC_GUARD_REENTRY: "1" });
  assertRefused(r);
  assert.match(r.stderr, /re-entry/);
  assert.deepEqual(calls(s), [], "a marked call never reaches the real hc");
});

test("a guard copy that calls its caller stops at once instead of looping", (t) => {
  const s = scene(t);
  const mod = join(s.root, "other-guard"), copyGuard = join(mod, "guard");
  mkdirSync(copyGuard, { recursive: true });
  for (const file of ["hcGuard.mjs", "agyPrompt.js", "launchArgs.js", "dialog.js", "approved.js", "attach.js", "model.js", "models.js", "workers.js", "logins.js", "loginWords.js", "retired.js", "hermesPair.js"]) {
    copyFileSync(join(GUARD_DIR, "..", file), join(mod, file));
  }
  appendFileSync(join(mod, "hcGuard.mjs"), "\n// not this guard\n");
  copyFileSync(join(GUARD_DIR, "hc"), join(copyGuard, "hc"));
  chmodSync(join(copyGuard, "hc"), 0o755);
  writeFileSync(s.logPath, "");
  const r = spawnSync(process.execPath, [s.guard, "ls"], {
    env: envFor(s, { PATH: `${GUARD_DIR}:${copyGuard}:${s.bin}:${dirname(process.execPath)}` }),
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /re-entry/);
  assert.deepEqual(calls(s), [], "the stub never ran; the pair stopped at once");
});

test("an older guard copy after this one cannot turn a refusal into an allow", (t) => {
  const s = scene(t);
  const mod = join(s.root, "older-guard"), olderGuard = join(mod, "guard");
  const log = join(mod, "older.log");
  mkdirSync(olderGuard, { recursive: true });
  for (const file of ["hcGuard.mjs", "agyPrompt.js", "launchArgs.js", "dialog.js", "approved.js", "attach.js", "model.js", "models.js", "workers.js", "logins.js", "loginWords.js", "retired.js", "hermesPair.js"]) {
    copyFileSync(join(GUARD_DIR, "..", file), join(mod, file));
  }
  // An older copy: it predates the re-entry marker, so it ignores the marker on its env.
  const older = readFileSync(join(mod, "hcGuard.mjs"), "utf8")
    .replace('    if (reentry(env)) return refused("a re-entry: the guard already ran for this call");\n', "");
  assert.doesNotMatch(older, /reentry\(env\)/, "the copy ignores the marker");
  writeFileSync(join(mod, "hcGuard.mjs"), older);
  // Its hc is only a pass-through to the stub, logging the lookups the current guard asks for.
  writeFileSync(join(olderGuard, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${join(s.bin, "hc")}" "$@"\n`);
  chmodSync(join(olderGuard, "hc"), 0o755);
  const path = `${GUARD_DIR}:${olderGuard}:${s.bin}:${dirname(process.execPath)}`;
  const olderCalls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  // A refused verb never resolves a real hc: the older copy is not even reached.
  writeFileSync(log, "");
  writeFileSync(s.logPath, "");
  const exec = guardRun(s, ["exec", "echo", "x"], { PATH: path });
  assertRefused(exec);
  assert.match(exec.stderr, /refused exec/);
  assert.deepEqual(olderCalls(), [], "the older guard copy never ran for a refused verb");
  assert.deepEqual(calls(s), [], "the refusal came first; the stub never ran");
  // send and label resolve their target through the older copy: its answers are the stub's
  // (the pass-through), and the current guard still checks that target against the team it
  // computed from bots.json, so a refused target stays refused.
  for (const [args, why] of [
    [["send", "t120", "hi"], /not in the caller's team/],
    [["label", "t120", "role=reviewer"], /own worker/],
  ]) {
    writeFileSync(log, "");
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args, { PATH: path });
    assertRefused(r);
    assert.match(r.stderr, why);
    assert.ok(olderCalls().some((line) => line.startsWith("ls")), `the older copy answered ls: ${olderCalls()}`);
    assert.ok(olderCalls().some((line) => line.startsWith("get t120")), `the older copy answered get t120: ${olderCalls()}`);
    assert.equal(calls(s).some((argv) => argv[0] === args[0]), false, `${args[0]} never reached the stub`);
  }
});

test("the guard shim's own failure lines name #628", (t) => {
  const s = scene(t);
  const shim = (name, hcGuard = null) => {
    const mod = join(s.root, name);
    mkdirSync(join(mod, "guard"), { recursive: true });
    copyFileSync(join(GUARD_DIR, "hc"), join(mod, "guard", "hc"));
    chmodSync(join(mod, "guard", "hc"), 0o755);
    if (hcGuard !== null) writeFileSync(join(mod, "hcGuard.mjs"), hcGuard);
    return join(mod, "guard", "hc");
  };
  const missing = spawnSync(process.execPath, [shim("shim-missing"), "read", "t101"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /#624/);
  assert.match(missing.stderr, /#628/);
  assert.match(missing.stderr, /#631/);
  assert.match(missing.stderr, /did not load/);
  const broken = spawnSync(process.execPath, [shim("shim-broken", "export const nothing = 1;\n"), "read", "t101"], { encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /#628/);
  assert.match(broken.stderr, /internal error/);
});

test("the guard goes first on a dsh-tui PATH; every other named agent gets the hc kill shim there (#955); no agent, no change", () => {
  assert.equal(guardPath("/a:/b", "claude"), "/a:/b");
  assert.equal(guardPath("/a:/b", null), "/a:/b");
  assert.equal(guardPath(null, "dsh-tui"), null);
  assert.equal(guardPath("/a:/b", "dsh-tui"), `${GUARD_DIR}:/a:/b`);
  assert.equal(guardPath(`${GUARD_DIR}:/a`, "dsh-tui"), `${GUARD_DIR}:/a`, "already first: not repeated");

  const base = { botId: ID.dev, name: "dev", cwd: "/p", parent: ["--no-parent"], path: "/bin" };
  assert.deepEqual(startArgs({ ...base, argv: ["claude"] }), ["run", "--bg", "--json", "--name", "dev", "--cwd", "/p", "--label", `bot=${ID.dev}`,
    "--no-parent", "--", "/usr/bin/env", "PATH=/bin", "claude"], "an old caller (no agent) is unchanged");
  // #955: one folder per pane. dsh-tui keeps the full guard; every other agent kind gets the kill shim.
  assert.equal(paneGuardOf("dsh-tui"), GUARD_DIR);
  assert.equal(paneGuardOf(null), null);
  assert.notEqual(KILL_GUARD_DIR, GUARD_DIR);
  for (const agent of ["claude", "codex", "antigravity", "omp", "hermes", "pi", "opencode"]) {
    assert.equal(paneGuardOf(agent), KILL_GUARD_DIR, agent);
    const seat = startArgs({ ...base, argv: [agent], agent });
    assert.deepEqual(seat.slice(seat.indexOf("--") + 1), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:/bin`, agent], `${agent} seat`);
    const worker = workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", agent, argv: [agent], task: "t", path: "/a:/b" });
    assert.equal(worker[worker.indexOf("--") + 2], `PATH=${KILL_GUARD_DIR}:/a:/b`, `${agent} worker`);
    assert.equal(startArgs({ ...base, argv: [agent], agent, guard: null }).includes(`PATH=/bin`), true, `${agent}: an explicit null (a machine with no shim) adds none`);
  }
  // A worker of another agent kind inherits its bot's pane PATH: the pack's other folder is taken out.
  // The stricter folder wins. A Claude or Codex worker started from a dsh-tui bot's pane inherits
  // that pane's PATH: it keeps the full guard it had before the shim existed, and gets no shim.
  assert.equal(guardPathWith(`${GUARD_DIR}:/a`, KILL_GUARD_DIR), `${GUARD_DIR}:/a`, "a Claude worker of a dsh-tui bot keeps the full guard");
  assert.equal(guardPathWith(`/a:${GUARD_DIR}`, KILL_GUARD_DIR), `/a:${GUARD_DIR}`, "wherever it stands: the PATH is left as it is");
  assert.equal(guardPathWith("/stable/guard:/a", "/stable/hc-kill"), "/stable/guard:/a", "the stable folder's pair too (a sandboxed bot's worker)");
  assert.equal(guardPathWith("/other/guard:/a", "/stable/hc-kill"), "/stable/hc-kill:/other/guard:/a", "a guard that is not the shim's own neighbour does not count");
  assert.equal(guardPathWith("/stable/hc-kill:/a", "/stable/guard"), "/stable/guard:/a", "the stable full guard takes its shim out");
  for (const agent of ["claude", "codex", "antigravity", "omp"]) {
    const inherited = workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", agent, argv: [agent], task: "t", path: `${GUARD_DIR}:/a:/b` });
    assert.equal(inherited[inherited.indexOf("--") + 2], `PATH=${GUARD_DIR}:/a:/b`, `${agent} worker of a dsh-tui bot: the full guard, as before #955`);
  }
  assert.equal(guardPathWith(`${KILL_GUARD_DIR}:/a`, GUARD_DIR), `${GUARD_DIR}:/a`, "a dsh-tui worker of a Claude bot: the full guard, not both");
  assert.equal(guardPathWith(`${KILL_GUARD_DIR}:/a`, KILL_GUARD_DIR), `${KILL_GUARD_DIR}:/a`, "already first: not repeated");
  assert.equal(guardPathWith(`${GUARD_DIR}:/a`, "/stable/guard"), `/stable/guard:${GUARD_DIR}:/a`, "another copy's folder leaves this pack's alone");
  const dsh = startArgs({ ...base, argv: ["dsh-tui"], agent: "dsh-tui" });
  assert.deepEqual(dsh.slice(dsh.indexOf("--") + 1), ["/usr/bin/env", `PATH=${GUARD_DIR}:/bin`, "dsh-tui"]);

  const omp = workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", agent: "omp", argv: ["omp"], task: "t", path: "/a:/b" });
  assert.deepEqual(omp.slice(omp.indexOf("--") + 1), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:/a:/b`, "omp", "t"]);
  const noShim = workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", agent: "omp", argv: ["omp"], task: "t", path: "/a:/b", killGuard: null });
  assert.deepEqual(noShim.slice(noShim.indexOf("--") + 1), ["/usr/bin/env", "PATH=/a:/b", "omp", "t"], "killGuard null: none");
  const dshWorker = workerArgs({ botId: ID.dev, branch: "b", cwd: "/w", parent: "t1", agent: "dsh-tui", argv: ["dsh-tui"], task: "t", path: "/a:/b" });
  assert.deepEqual(dshWorker.slice(dshWorker.indexOf("--") + 1), ["/usr/bin/env", `PATH=${GUARD_DIR}:/a:/b`, "dsh-tui", "--", "t"]);
});

test("cross-project lead (#850): hc send and proxy require reciprocal crossMembers and an approved 0600 snapshot, and allow only the direct lead <-> member link", async (t) => {
  const { teamOf } = await import("../mods/am-sidebar/hcGuard.mjs");
  const { policyOf } = await import("../mods/am-sidebar/hcProxy.mjs");
  const { approveProject, recordFileOf } = await import("../mods/am-sidebar/approved.js");
  const { parseBots } = await import("../mods/am-sidebar/model.js");

  const hubTopId = "b-8888888888";
  const coordId = "b-7777777777";
  const unrelatedHubId = "b-6666666666";
  const spokeMainId = "b-5555555555";
  const spokeDevId = "b-4444444444";

  const hubRaw = {
    version: 1,
    categories: [],
    bots: [
      bot(hubTopId, "main", { name: "HubTop" }),
      bot(coordId, "member", {
        name: "Coord",
        lead: hubTopId,
        crossMembers: [{ id: spokeMainId, project: "/work/spoke" }],
      }),
      bot(unrelatedHubId, "member", { name: "UnrelatedHub", lead: hubTopId }),
    ],
  };
  const spokeRaw = {
    version: 1,
    categories: [],
    bots: [
      bot(spokeMainId, "main", { name: "SpokeMain", lead: coordId, leadProject: "/work/hub" }),
      bot(spokeDevId, "member", { name: "SpokeDev", lead: spokeMainId }),
    ],
  };
  const hubFile = parseBots(JSON.stringify(hubRaw)).file;
  const spokeFile = parseBots(JSON.stringify(spokeRaw)).file;
  const projects = new Map([["/work/hub", hubFile], ["/work/spoke", spokeFile]]);

  // Direct link only: SpokeMain reaches Coord in /work/hub, NEVER Coord's lead (HubTop) or UnrelatedHub.
  const spokeMainTeam = teamOf(spokeFile, spokeMainId, { project: "/work/spoke", projects });
  assert.equal(spokeMainTeam.has(coordId), true);
  assert.equal(spokeMainTeam.has(hubTopId), false);
  assert.equal(spokeMainTeam.has(unrelatedHubId), false);

  // SpokeMain's member (SpokeDev) and SpokeMain's worker do NOT reach Coord across projects.
  const spokeDevTeam = teamOf(spokeFile, spokeDevId, { project: "/work/spoke", projects });
  assert.equal(spokeDevTeam.has(coordId), false);
  const spokeMainWorkerTeam = teamOf(spokeFile, spokeMainId, true, { project: "/work/spoke", projects });
  assert.equal(spokeMainWorkerTeam.has(coordId), false);

  // Coord in /work/hub reaches SpokeMain (its direct cross-project member), NEVER SpokeDev (SpokeMain's member),
  // and HubTop (Coord's lead) does NOT reach SpokeMain.
  const coordTeam = teamOf(hubFile, coordId, { project: "/work/hub", projects });
  assert.equal(coordTeam.has(spokeMainId), true);
  assert.equal(coordTeam.has(spokeDevId), false);
  const hubTopTeam = teamOf(hubFile, hubTopId, { project: "/work/hub", projects });
  assert.equal(hubTopTeam.has(spokeMainId), false);

  // One-sided declaration (spoke names Coord, but Coord does not list SpokeMain in crossMembers) gives nothing.
  const oneSidedHub = parseBots(JSON.stringify({
    version: 1,
    categories: [],
    bots: [
      bot(hubTopId, "main", { name: "HubTop" }),
      bot(coordId, "member", { name: "Coord", lead: hubTopId }),
    ],
  })).file;
  const oneSidedProjects = new Map([["/work/hub", oneSidedHub], ["/work/spoke", spokeFile]]);
  assert.equal(teamOf(spokeFile, spokeMainId, { project: "/work/spoke", projects: oneSidedProjects }).has(coordId), false);
  assert.equal(teamOf(oneSidedHub, coordId, { project: "/work/hub", projects: oneSidedProjects }).has(spokeMainId), false);

  // Without verified projects, a cross-project lead is not trusted by teamOf.
  const unverifiedTeam = teamOf(spokeFile, spokeMainId);
  assert.equal(unverifiedTeam.has(coordId), false);

  // End-to-end guard run and hcProxy policyOf across two projects on disk.
  const s = scene(t);
  const hubDir = join(s.root, "hub");
  mkdirSync(join(hubDir, ".herdr"), { recursive: true });
  const diskHubOneSided = {
    version: 1,
    categories: [],
    bots: [
      bot(hubTopId, "main", { name: "HubTop" }),
      bot(coordId, "member", { name: "Coord", lead: hubTopId }),
      bot(unrelatedHubId, "member", { name: "UnrelatedHub", lead: hubTopId }),
    ],
  };
  const diskSpoke = {
    version: 1,
    categories: [],
    bots: [
      bot(ID.main, "main", { name: "Main", lead: coordId, leadProject: hubDir }),
      bot(ID.dev, "member", { name: "Dev", lead: ID.main }),
    ],
  };
  writeFileSync(join(hubDir, ".herdr", "bots.json"), JSON.stringify(diskHubOneSided, null, 2));
  writeFileSync(join(s.project, ".herdr", "bots.json"), JSON.stringify(diskSpoke, null, 2));

  const st = JSON.parse(readFileSync(s.statePath, "utf8"));
  st.terminals.push(
    { address: "t200", name: "coord", state: "live" },
    { address: "t201", name: "unrelated", state: "live" },
    { address: "t202", name: "hubtop", state: "live" },
  );
  st.get.t200 = get("t200", { bot: coordId }, { cwd: hubDir, name: "coord", argv: launchArgv(s.app) });
  st.get.t201 = get("t201", { bot: unrelatedHubId }, { cwd: hubDir, name: "unrelated", argv: launchArgv(s.app) });
  st.get.t202 = get("t202", { bot: hubTopId }, { cwd: hubDir, name: "hubtop", argv: launchArgv(s.app) });
  writeFileSync(s.statePath, JSON.stringify(st));
  const ledger = join(s.app, "automagik-herdr", "attach.jsonl");
  const rows = [
    { v: 1, event: "attach", bot: ID.main, project: s.project, terminal: "t103", core: "core", created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" },
    { v: 1, event: "attach", bot: ID.dev, project: s.project, terminal: "t100", core: "core", created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" },
    { v: 1, event: "attach", bot: coordId, project: hubDir, terminal: "t200", core: "core", created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" },
    { v: 1, event: "attach", bot: hubTopId, project: hubDir, terminal: "t202", core: "core", created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start" },
  ];
  writeFileSync(ledger, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  chmodSync(ledger, 0o600);

  // (a) One-sided on disk (even after approving both): Main -> Coord and Coord -> Main are refused.
  approveProject({ project: hubDir, env: envFor(s) });
  approveProject({ project: s.project, env: envFor(s) });
  assertRefused(guardRun(s, ["send", "t200", "one-sided"], { HC_TERMINAL_ID: "t103" }));
  assertRefused(guardRun(s, ["send", "t103", "one-sided"], { HC_TERMINAL_ID: "t200" }));

  // (b) Both sides declare the link in .herdr/bots.json, but hubDir's approved snapshot is NOT updated yet:
  // live .herdr/bots.json alone is untrusted (digest mismatch with approved snapshot) -> fails closed.
  const diskHubReciprocal = {
    ...diskHubOneSided,
    bots: [
      bot(hubTopId, "main", { name: "HubTop" }),
      bot(coordId, "member", {
        name: "Coord",
        lead: hubTopId,
        crossMembers: [{ id: ID.main, project: s.project }],
      }),
      bot(unrelatedHubId, "member", { name: "UnrelatedHub", lead: hubTopId }),
    ],
  };
  writeFileSync(join(hubDir, ".herdr", "bots.json"), JSON.stringify(diskHubReciprocal, null, 2));
  assertRefused(guardRun(s, ["send", "t200", "unapproved-edit"], { HC_TERMINAL_ID: "t103" }));

  // (c) Approve hubDir, then loosen snapshot permissions to 0644 -> fails closed.
  approveProject({ project: hubDir, env: envFor(s) });
  const hubApprovedFile = recordFileOf(hubDir, envFor(s));
  chmodSync(hubApprovedFile, 0o644);
  assertRefused(guardRun(s, ["send", "t200", "bad-mode"], { HC_TERMINAL_ID: "t103" }));
  const diskSpokeParsed = parseBots(JSON.stringify(diskSpoke)).file;
  const diskHubParsed = parseBots(JSON.stringify(diskHubReciprocal)).file;
  const badModePolicy = policyOf({
    caller: { bot: ID.main, project: s.project, worker: false, terminal: "t103" },
    file: diskSpokeParsed,
    approvalEnv: envFor(s),
  });
  assert.equal(badModePolicy?.team?.has(coordId), false);

  // (d) Restore 0600 on approved snapshot: direct link Main (t103) <-> Coord (t200) is allowed in guard and proxy.
  chmodSync(hubApprovedFile, 0o600);
  const toLead = guardRun(s, ["send", "t200", "status report"], { HC_TERMINAL_ID: "t103" });
  assert.equal(toLead.status, 0, toLead.stderr);
  const toReport = guardRun(s, ["send", "t103", "ack"], { HC_TERMINAL_ID: "t200" });
  assert.equal(toReport.status, 0, toReport.stderr);

  const okPolicyMain = policyOf({
    caller: { bot: ID.main, project: s.project, worker: false, terminal: "t103" },
    file: diskSpokeParsed,
    approvalEnv: envFor(s),
  });
  assert.equal(okPolicyMain?.team?.has(coordId), true);
  assert.equal(okPolicyMain?.team?.has(hubTopId), false);
  const okPolicyCoord = policyOf({
    caller: { bot: coordId, project: hubDir, worker: false, terminal: "t200" },
    file: diskHubParsed,
    approvalEnv: envFor(s),
  });
  assert.equal(okPolicyCoord?.team?.has(ID.main), true);
  assert.equal(okPolicyCoord?.team?.has(ID.dev), false);

  // (e) Upward chain (HubTop t202), unrelated hub bot (t201), and Main's member (Dev t100) stay out.
  assertRefused(guardRun(s, ["send", "t202", "nope-upward"], { HC_TERMINAL_ID: "t103" }));
  assertRefused(guardRun(s, ["send", "t201", "nope-unrelated"], { HC_TERMINAL_ID: "t103" }));
  assertRefused(guardRun(s, ["send", "t200", "nope-member-team"], { HC_TERMINAL_ID: "t100" }));
  assertRefused(guardRun(s, ["send", "t100", "nope-member-team"], { HC_TERMINAL_ID: "t200" }));
  assertRefused(guardRun(s, ["send", "t103", "nope-from-hubtop"], { HC_TERMINAL_ID: "t202" }));
});

// ---- #1421: send text must not become an agent command ----

test("#1421 commandPrefixOf truth table: only a leading ! or / after whitespace", async () => {
  const { commandPrefixOf } = await import("../mods/am-sidebar/hcGuard.mjs");
  for (const [text, expected] of [
    ["!x", "!"], ["/x", "/"], ["!", "!"], ["/", "/"],
    [" \t!x", "!"], [" \t/x", "/"], ["\n!x", "!"], ["\r\n /x", "/"],
    ["hello /x", null], ["a!b", null], ["x", null], ["", null], [" \n\t", null],
    [null, null], [undefined, null], [42, null], [{}, null],
  ]) assert.equal(commandPrefixOf(text), expected, JSON.stringify(text));
});

test("#1421 prefixTarget truth table: status agents, stale shell argv, other and unknown", async () => {
  const { prefixTarget } = await import("../mods/am-sidebar/hcGuard.mjs");
  for (const [value, expected] of [
    [null, "unknown"], [undefined, "unknown"], [false, "unknown"], [42, "unknown"], ["bash", "unknown"],
    [{}, "other"], [{ status: {} }, "other"], [{ foreground: { argv: [] } }, "other"],
    [{ status: { app: "bash" }, foreground: { argv: ["bash"] } }, "other"],
    [{ status: { app: "python3" }, foreground: { argv: ["python3", "script.py"] } }, "other"],
    ...["claude-code", "codex", "dsh-tui", "antigravity"].map((app) => [{ status: { app } }, "agent"]),
    [{ status: { app: "bash" }, foreground: { argv: ["claude"] } }, "agent"],
    [{ foreground: { argv: ["claude"] } }, "agent"],
  ]) assert.equal(prefixTarget(value), expected, JSON.stringify(value));
});

test("#1421 sendTextProblem truth table: prefixed texts refuse agents and unknown targets only", async () => {
  const { sendTextProblem } = await import("../mods/am-sidebar/hcGuard.mjs");
  const targets = [
    ["unknown", null, true], ["missing", undefined, true],
    ...["claude-code", "codex", "dsh-tui", "antigravity"].map((app) => [app, { status: { app } }, true]),
    ["stale bash", { status: { app: "bash" }, foreground: { argv: ["claude"] } }, true],
    ["bash", { status: { app: "bash" }, foreground: { argv: ["bash"] } }, false],
    ["python3", { status: { app: "python3" }, foreground: { argv: ["python3", "script.py"] } }, false],
    ["empty object", {}, false],
  ];
  for (const [name, target, refusesPrefix] of targets) {
    for (const [texts, prefix] of [
      [[], null], [["hello /x", "a!b", "x"], null], [["", " \n"], null],
      [["!x"], "!"], [["/x"], "/"], [[" \n\t!x"], "!"], [["\n /x"], "/"],
      [["hello", "/x"], "/"], [["/x", "!x"], "/"], [["!x", "/x"], "!"],
    ]) {
      const expected = prefix && refusesPrefix
        ? `a message starting with "${prefix}" would run as a command in that agent, not reach it as text (#1421)`
        : null;
      assert.equal(sendTextProblem(texts, target), expected, `${name}: ${JSON.stringify(texts)}`);
    }
  }
});

test("#1421 shim refuses prefixed sends to each agent, unknown targets and option/name forms", async (t) => {
  const agentCases = [
    ...["claude-code", "codex", "dsh-tui", "antigravity"].map((app) => [app, { status: { app } }]),
    ["claude argv under stale bash", { status: { app: "bash" }, foreground: { argv: ["claude"] } }],
  ];
  const cases = agentCases.flatMap(([name, report]) => ["!x", "/x"].map((text) => ({
    name: `${name}: ${text}`, report, args: ["send", "t101", text], target: "t101", prefix: text[0],
  })));
  cases.push(
    { name: "leading space before !", args: ["send", "t101", " \t!x"], target: "t101", prefix: "!" },
    { name: "leading space before /", args: ["send", "t101", " \t/x"], target: "t101", prefix: "/" },
    { name: "leading newline before !", args: ["send", "t101", "\n!x"], target: "t101", prefix: "!" },
    { name: "leading newline before /", args: ["send", "t101", "\n/x"], target: "t101", prefix: "/" },
    { name: "global --json send", args: ["--json", "send", "t101", "/x"], target: "t101", prefix: "/" },
    { name: "--if idle and --", args: ["send", "--if", "idle", "t101", "--", "/x"], target: "t101", prefix: "/" },
    { name: "name resolved through ls", args: ["send", "cap", "!x"], target: "cap", prefix: "!" },
    { name: "later text word", args: ["send", "t101", "hello", "/x"], target: "t101", prefix: "/" },
    { name: "unresolvable address", args: ["send", "t999", "!x"], target: "t999", prefix: "!" },
    { name: "unresolvable name", args: ["send", "missing", "/x"], target: "missing", prefix: "/" },
    { name: "get returns an error", report: { error: { kind: "not_found" } }, args: ["send", "t101", "/x"], target: "t101", prefix: "/" },
  );
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const s = killScene(t);
      const state = JSON.parse(readFileSync(s.statePath, "utf8"));
      Object.assign(state.get.t101, c.report ?? { status: { app: "claude-code" } });
      writeFileSync(s.statePath, JSON.stringify(state));
      const r = shimRun(s, c.args);
      assert.ifError(r.error);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr.trim().split("\n").length, 1, JSON.stringify(r.stderr));
      assert.match(r.stderr, /^hc send: refused a message starting with /);
      assert.ok(r.stderr.includes(`starting with "${c.prefix}" to ${c.target}:`), r.stderr);
      assert.match(r.stderr, /#1421/);
      assert.match(r.stderr, /Start it with other text/);
      assert.match(r.stderr, /a real command goes with hc keys/);
      assert.match(r.stderr, /would run as a command/);
      assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false, "no send reached hc");
      if (c.target === "cap") {
        assert.deepEqual(calls(s), [["ls", "--json"], ["get", "t101", "--json"]], "ls resolves the name before get");
      }
    });
  }
});

test("#1421 shim passes prefixed sends to bash and python3 at the resolved address", async (t) => {
  for (const app of ["bash", "python3"]) {
    for (const [args, expected] of [
      [["send", "cap", "!x"], ["send", "t101", "!x"]],
      [["--json", "send", "cap", "\n/x"], ["--json", "send", "t101", "\n/x"]],
      [["send", "--if", "idle", "cap", "--", "/x"], ["send", "--if", "idle", "t101", "--", "/x"]],
    ]) {
      await t.test(`${app}: ${JSON.stringify(args)}`, (t) => {
        const s = killScene(t);
        const state = JSON.parse(readFileSync(s.statePath, "utf8"));
        state.get.t101.status = { app };
        state.get.t101.foreground = { argv: [app] };
        writeFileSync(s.statePath, JSON.stringify(state));
        const r = shimRun(s, args, { HC_STUB_CODE: "7" });
        assert.ifError(r.error);
        assert.equal(r.status, 7, r.stderr);
        assert.equal(r.stdout, `stub-out ${JSON.stringify(expected)}\n`);
        assert.equal(r.stderr, `stub-err ${expected[0]}\n`);
        assert.deepEqual(calls(s), [["ls", "--json"], ["get", "t101", "--json"], ["read", "t101", "--lines", "40", "--json"], expected]);
      });
    }
  }
});

test("#1421 shim plain texts pass unchanged after the target check", (t) => {
  const s = killScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.t101.status = { app: "claude-code" };
  state.get.t101.foreground = { argv: ["claude"] };
  writeFileSync(s.statePath, JSON.stringify(state));
  for (const target of ["t101", "cap", "t999"]) {
    for (const text of ["hello /x", "a!b", "x"]) {
      for (const args of [["send", target, text], ["--json", "send", target, text]]) {
        writeFileSync(s.logPath, "");
        const r = shimRun(s, args);
        assert.ifError(r.error);
        assert.equal(r.status, 0, r.stderr);
        const forwarded = args.map((word, i) => i === args.indexOf("send") + 1 && word === "cap" ? "t101" : word);
        assert.equal(r.stdout, `stub-out ${JSON.stringify(forwarded)}\n`);
        assert.equal(r.stderr, `stub-err ${args[0]}\n`);
        // The checked target is canonical. The message text and flag order are preserved.
        const expected = target === "t999"
          ? [["ls", "--json"], ["get", "t999", "--json"], forwarded]
          : [["ls", "--json"], ["get", "t101", "--json"], ["read", "t101", "--lines", "40", "--json"], forwarded];
        assert.deepEqual(calls(s), expected);
      }
    }
  }
});

test("#1421 full guard refuses !x and /x to a team agent without hc keys advice", async (t) => {
  for (const text of ["!x", "/x"]) {
    await t.test(text, (t) => {
      const s = scene(t);
      const state = JSON.parse(readFileSync(s.statePath, "utf8"));
      state.get.t101.status = { app: "claude-code" };
      state.get.t101.foreground = { argv: ["claude"] };
      writeFileSync(s.statePath, JSON.stringify(state));
      const r = guardRun(s, ["send", "cap", text], { HC_TERMINAL_ID: "t100" });
      assert.ifError(r.error);
      assertRefused(r);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /^hc guard: refused send: /);
      assert.match(r.stderr, /#1421/);
      assert.ok(r.stderr.includes(`starting with "${text[0]}"`), r.stderr);
      assert.match(r.stderr, /start it with other text/);
      assert.doesNotMatch(r.stderr, /hc keys/);
      assert.ok(calls(s).some((argv) => same(argv, ["get", "t101", "--json"])), "checks the resolved team target");
      assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false, "no send reached hc");
    });
  }
});

test("#1421 full guard keeps the non-team or unresolvable target's own refusal reason", async (t) => {
  for (const [target, reason] of [
    ["t120", /the target is not in the caller's team/],
    ["t999", /the target is not resolvable with hc/],
  ]) {
    for (const text of ["!x", "/x"]) {
      await t.test(`${target}: ${text}`, (t) => {
        const s = scene(t);
        const state = JSON.parse(readFileSync(s.statePath, "utf8"));
        state.get.t120.status = { app: "claude-code" };
        state.get.t120.foreground = { argv: ["claude"] };
        writeFileSync(s.statePath, JSON.stringify(state));
        const r = guardRun(s, ["send", target, text], { HC_TERMINAL_ID: "t100" });
        assert.ifError(r.error);
        assertRefused(r);
        assert.equal(r.status, 2);
        assert.match(r.stderr, reason);
        assert.doesNotMatch(r.stderr, /#1421|hc keys|would run as a command/);
        assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false, "no send reached hc");
      });
    }
  }
});

test("#1421 full guard passes prefixed sends to a shell team target at its address", (t) => {
  const s = scene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.t101.status = { app: "bash" };
  state.get.t101.foreground = { argv: ["bash"] };
  writeFileSync(s.statePath, JSON.stringify(state));
  for (const args of [["send", "cap", "!x"], ["send", "--if", "idle", "cap", "--", "/x"]]) {
    writeFileSync(s.logPath, "");
    const expected = args.map((word) => word === "cap" ? "t101" : word);
    const r = guardRun(s, args, { HC_TERMINAL_ID: "t100" });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `stub-out ${JSON.stringify(expected)}\n`);
    assert.equal(r.stderr, "stub-err send\n");
    assert.ok(calls(s).some((argv) => same(argv, ["ls", "--json"])));
    assert.ok(calls(s).some((argv) => same(argv, ["get", "t101", "--json"])));
    assert.deepEqual(calls(s).filter((argv) => hcVerbOf(argv) === "send"), [expected]);
  }
});

// ---- a send to a pane held by a dialog (#1414) ----
//
// A question dialog takes an incoming send as its own answer: the text is pasted into the
// dialog's input and submitted, and a person's question disappears unanswered. A dialog is a
// blocked status in herdr-core, or a visible prompt/banner on the pane's screen when the pane's
// status is stale or absent (a linked machine, a revived pane). These cases pin both.

test("#1414 a blocked question pane refuses the send before anything is typed", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "blocked", kind: "question" }, screen: DIALOG_SCREEN });
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t101", "the report"]);
  assertHeld(r, "t101");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false, "nothing was typed into the dialog");
  assert.equal(calls(s).some((argv) => argv[0] === "read"), false, "a blocked status is enough; no screen read");
});

test("#1414 a visible dialog whose status says idle is refused, not answered", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "idle", app: "claude-code" }, screen: DIALOG_SCREEN });
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t101", "the report"]);
  assertHeld(r, "t101");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false);
  assert.ok(calls(s).some((argv) => same(argv, ["read", "t101", "--lines", "40", "--json"])), "the screen was looked at");
});

test("#1557 a footerless rate-limit dialog holds a message to an idle seat", (t) => {
  const s = scene(t);
  const screen = "You've hit your usage limit.\nYour limit resets in 2 hours.\n❯ 1. Wait for reset\n  2. Dismiss";
  editPane(s, "t101", { status: { state: "idle", app: "claude-code" }, screen });
  writeFileSync(s.logPath, "");
  assertHeld(guardRun(s, ["send", "t101", "the report"]), "t101");
  assert.equal(calls(s).some(args => hcVerbOf(args) === "send"), false);
});

test("#1414 a linked-machine pane with no status is checked by its screen", (t) => {
  const s = scene(t);
  editPane(s, "m/t101", { screen: DIALOG_SCREEN });
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "m/t101", "the report"]);
  assertHeld(r, "m/t101");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false);
});

test("#1414 a free pane's send is unchanged, byte for byte", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "idle", app: "claude-code" }, screen: FREE_SCREEN });
  writeFileSync(s.logPath, "");
  const r = guardRun(s, ["send", "t101", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'stub-out ["send","t101","hello"]\n');
  assert.equal(r.stderr, "stub-err send\n");
  assert.deepEqual(calls(s).filter((argv) => hcVerbOf(argv) === "send"), [["send", "t101", "hello"]]);
});

test("#1414 a finished pane's last dialog screen is not mistaken for a live hold", (t) => {
  const s = scene(t);
  editPane(s, "t101", { state: "finished", status: { state: "done", app: "claude-code" }, screen: DIALOG_SCREEN });
  const r = guardRun(s, ["send", "t101", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => hcVerbOf(argv) === "send"), [["send", "t101", "hello"]]);
});

test("#1414 --force cannot answer a person's dialog", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "blocked", kind: "question" } });
  const r = guardRun(s, ["send", "--force", "t101", "the report"]);
  assertHeld(r, "t101");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false);
});

test("#1414 two messages while held are both refused; order is kept once it is free", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "idle", app: "claude-code" }, screen: DIALOG_SCREEN });
  assertHeld(guardRun(s, ["send", "t101", "first"]), "t101");
  assertHeld(guardRun(s, ["send", "t101", "second"]), "t101");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false, "neither was typed");
  editPane(s, "t101", { screen: FREE_SCREEN });
  for (const text of ["first", "second"]) {
    const r = guardRun(s, ["send", "t101", text]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(calls(s).filter((argv) => hcVerbOf(argv) === "send"),
    [["send", "t101", "first"], ["send", "t101", "second"]]);
});

test("#1414 a screen that cannot be read is left to hc's own send", (t) => {
  const s = scene(t);
  editPane(s, "t101", { status: { state: "idle", app: "claude-code" }, readFail: true });
  const r = guardRun(s, ["send", "t101", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s).filter((argv) => hcVerbOf(argv) === "send"), [["send", "t101", "hello"]]);
});

test("#1414 the kill shim refuses a send to a held pane too", (t) => {
  const s = killScene(t);
  editPane(s, "t105", { status: { state: "blocked", kind: "question" }, screen: DIALOG_SCREEN });
  const r = shimRun(s, ["send", "t105", "the report"], { HC_TERMINAL_ID: "t103" });
  assertHeld(r, "t105");
  assert.equal(calls(s).some((argv) => hcVerbOf(argv) === "send"), false);
});

// Older guard/hc shipped in the tags checked for #1728. Keep its bytes, including the final newline.
const OLD_GUARD_ENTRY = `#!/usr/bin/env node
// The guard's executable entry (automagik#624): a tiny shim, so the logic stays in
// hcGuard.mjs, which the pack's node --check gate covers. Dynamic import works whether this
// extensionless file loads as CommonJS (an installed pack has no package.json) or as ESM
// (\`herdr/package.json\` says type module). Apache-2.0.
"use strict";
import("../hcGuard.mjs").then(
  ({ runGuard }) => runGuard(process.argv.slice(2), process.env),
  () => {
    process.stderr.write("hc guard: failed closed (#624): the guard's logic did not load; this wrapper is a guardrail, not a boundary (#631).\\n");
    return 1;
  },
).then(
  (code) => { process.exitCode = Number.isInteger(code) ? code : 1; },
  () => {
    process.stderr.write("hc guard: failed closed (#624): internal error; this wrapper is a guardrail, not a boundary (#631).\\n");
    process.exitCode = 1;
  },
);
`;

test("#1728 the CLI vouches for skewed guard entries only at recognized install paths", async (t) => {
  const { isGuardFolder, isInstalledGuardFolder } = await import("../mods/am-sidebar/hcGuard.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hc-guard-install-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, AM_HOME: join(root, "am") + "/" };
  const store = join(env.AM_HOME, "parts", "automagik.am");
  const app = join(root, ".config", "herdr-app");
  const pack = join(app, "mods", "am-sidebar");
  const fixture = (parent, name = "guard", entry = readFileSync(join(GUARD_DIR, "hc"))) => {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(parent, "hcGuard.mjs"), "// a different release\n");
    writeFileSync(join(dir, "hc"), entry);
    return dir;
  };
  const version = fixture(join(store, "3.158.1"));
  const reinstall = fixture(join(store, "3.158.1-a1b2"), "hc-kill", readFileSync(join(KILL_GUARD_DIR, "hc")));
  const named = fixture(join(store, "restored"));
  symlinkSync(dirname(named), join(store, "current"));
  symlinkSync(dirname(reinstall), join(store, "previous"));
  const packGuard = fixture(pack, "guard", OLD_GUARD_ENTRY);
  const alias = join(root, "pane-tools");
  symlinkSync(packGuard, alias);
  const linkedApp = join(root, "linked-app");
  mkdirSync(join(linkedApp, "mods"), { recursive: true });
  symlinkSync(pack, join(linkedApp, "mods", "am-sidebar"));
  for (const [name, dir] of [
    ["version", version],
    ["hex reinstall", reinstall],
    ["current pointing to a non-version child", join(store, "current", "guard")],
    ["non-version child linked as current", named],
    ["previous", join(store, "previous", "hc-kill")],
    ["pack mod with the older shipped entry", packGuard],
    ["stable root", fixture(stableRootOf(env))],
    ["alias to the guard folder", alias],
  ]) assert.equal(isInstalledGuardFolder(dir, env), true, name);
  assert.equal(isInstalledGuardFolder(packGuard, { ...env, HERDR_APP_HOME: linkedApp + "/" }), true, "symlinked pack mod root");
  assert.equal(isGuardFolder(version), false, "the #643/#721 byte-equal rule still rejects skew");

  const staging = fixture(join(store, ".staging"));
  unlinkSync(join(store, "previous"));
  symlinkSync(dirname(staging), join(store, "previous"));
  for (const [name, dir] of [
    ["planted outside the roots", fixture(join(root, "planted"))],
    ["staging even when linked as previous", join(store, "previous", "guard")],
    ["unlinked non-version child", fixture(join(store, "unlinked"))],
    ["other folder basename", fixture(pack, "bin")],
    ["different entry", fixture(join(store, "3.158.2"), "guard", "#!/bin/sh\nexit 1\n")],
    ["pack kept for rollback", fixture(join(app, "automagik-herdr", ".prev", "am-sidebar"))],
    ["missing folder", join(root, "missing")],
    ["empty path", ""],
  ]) assert.equal(isInstalledGuardFolder(dir, env), false, name);
});

test("#628 send forwards a name at its checked address and keeps flags and text", (t) => {
  const s = scene(t);
  for (const [args, expected] of [
    [["send", "cap", "hello"], ["send", "t101", "hello"]],
    [["send", "--if", "idle", "cap", "--", "hi"], ["send", "--if", "idle", "t101", "--", "hi"]],
    [["send", "cap", "--", "--on", "m"], ["send", "t101", "--", "--on", "m"]],
  ]) {
    const r = guardRun(s, args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(s).at(-1), expected);
  }
});

test("#628 send preserves direct terminal IDs and existing --on sends by ID", (t) => {
  const s = scene(t);
  for (const args of [["send", "t101", "hello"], ["send", "--on", "m", "t101", "hello"]]) {
    const r = guardRun(s, args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(s).at(-1), args);
  }
});

test("#628 send with --on forwards the bare checked terminal ID", (t) => {
  const s = scene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get["m/cap"] = state.get["m/t101"];
  writeFileSync(s.statePath, JSON.stringify(state));
  for (const [args, expected] of [
    [["send", "--on", "m", "cap", "hello"], ["send", "--on", "m", "t101", "hello"]],
    [["send", "--on=m", "cap", "--", "hello"], ["send", "--on=m", "t101", "--", "hello"]],
    [["send", "--on=m", "m/t101", "hello"], ["send", "--on=m", "t101", "hello"]],
  ]) {
    const r = guardRun(s, args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(s).at(-1), expected);
  }
});

test("#628 send with --on refuses an address off the named machine", (t) => {
  const s = scene(t);
  for (const address of ["t101", "other/t101"]) {
    editPane(s, "m/t101", { address });
    const r = guardRun(s, ["send", "--on", "m", "t101", "hello"]);
    assertRefused(r);
    assert.match(r.stderr, /hc resolved the target off the --on machine/);
  }
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
});

test("#628 a machine address returned only by get is refused for every checked non-send verb", (t) => {
  const s = killScene(t);
  editPane(s, "ghost", get("m/t120", { bot: ID.cap, "worker.of": ID.dev }, {
    cwd: s.project, parent: "t100",
  }));
  for (const args of [
    ["read", "ghost"], ["get", "ghost"], ["wait", "ghost"],
    ["label", "ghost", "role=dev"], ["kill", "ghost"], ["rm", "ghost"],
    ["events", "--terminal", "ghost"], ["events", "--children-of=ghost"],
  ]) {
    writeFileSync(s.logPath, "");
    const caller = args[0] === "kill" ? "t103" : "t100";
    const r = guardRun(s, args, { HC_TERMINAL_ID: caller });
    assertRefused(r);
    assert.match(r.stderr, /machine target/, args.join(" "));
    assert.ok(calls(s).some((argv) => same(argv, ["get", "ghost", "--json"])));
    assert.equal(calls(s).some((argv) => same(argv, args)), false, `${args.join(" ")} never reaches hc`);
  }
});

test("#628 read and events forward a local alias resolved only by get", (t) => {
  const s = scene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.alias = state.get.t101;
  writeFileSync(s.statePath, JSON.stringify(state));
  const read = guardRun(s, ["read", "alias"]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(calls(s).at(-1), ["read", "t101"]);
  const events = guardRun(s, ["events", "--terminal=alias"]);
  assert.equal(events.status, 0, events.stderr);
  assert.deepEqual(calls(s).at(-1), ["events", "--terminal=t101"]);
});

test("#628 a name shaped like a terminal ID can resolve through get alone", (t) => {
  const s = scene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals = state.terminals.filter((row) => row.name !== "tester");
  writeFileSync(s.statePath, JSON.stringify(state));
  const r = guardRun(s, ["send", "tester", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls(s).some((argv) => same(argv, ["get", "tester", "--json"])));
  assert.deepEqual(calls(s).at(-1), ["send", "t108", "hello"]);
});

test("#628 the guard refuses invalid terminal addresses from get", (t) => {
  const s = scene(t);
  for (const address of ["cap", "", "t 1", 101, "m/n/t1"]) {
    editPane(s, "t101", { address });
    const r = guardRun(s, ["send", "cap", "hello"]);
    assertRefused(r);
    assert.match(r.stderr, /the target's address from hc is not a terminal id/);
  }
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
});

test("#628 the guard refuses when ls and get resolve to different panes", (t) => {
  const s = scene(t);
  editPane(s, "t101", { address: "t103" });
  for (const target of ["cap", "t101"]) {
    const r = guardRun(s, ["send", target, "hello"]);
    assertRefused(r);
    assert.match(r.stderr, /hc resolved the target to two different panes/);
  }
  assert.equal(calls(s).some((argv) => argv[0] === "send"), false);
});

test("#628 the kill shim forwards a get-only alias by address and preserves --json", (t) => {
  const s = killScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.alias = state.get.t105;
  writeFileSync(s.statePath, JSON.stringify(state));
  const r = shimRun(s, ["--json", "kill", "alias"], { HC_TERMINAL_ID: "t103" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(killsSeen(s), [["--json", "kill", "t105"]]);
});

test("#628 checked verbs forward get-only local aliases at their canonical addresses", (t) => {
  const s = killScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get.memberAlias = state.get.t101;
  state.get.workerAlias = state.get.t105;
  writeFileSync(s.statePath, JSON.stringify(state));
  for (const [args, expected, caller] of [
    [["get", "memberAlias"], ["get", "t101"], "t100"],
    [["wait", "memberAlias"], ["wait", "t101"], "t100"],
    [["label", "workerAlias", "role=dev"], ["label", "t105", "role=dev"], "t100"],
    [["rm", "workerAlias"], ["rm", "t105"], "t100"],
    [["kill", "workerAlias"], ["kill", "t105"], "t103"],
    [["events", "--children-of=memberAlias"], ["events", "--children-of=t101"], "t100"],
  ]) {
    const r = guardRun(s, args, { HC_TERMINAL_ID: caller });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(calls(s).at(-1), expected);
  }
});

test("#540 a bot can set and clear the owner question on its own pane", (t) => {
  const s = scene(t);
  const expected = [
    ["label", "t100", "automagik-herdr.needs-owner=Ship?"],
    ["label", "t100", "automagik-herdr.needs-owner="],
  ];
  for (const args of expected) {
    const result = guardRun(s, args);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), expected);
});

test("#540 the guard forwards the canonical own-pane address returned by hc get", (t) => {
  const s = scene(t);
  editPane(s, "t100", { name: "renamed" }); // hc ls still has the old name.
  const label = "automagik-herdr.needs-owner=Ship?";
  const result = guardRun(s, ["label", "renamed", label]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(s), [
    ["ls", "--json"], ["get", "renamed", "--json"], ["label", "t100", label],
  ]);
});

test("#540 an unbound pane can label itself without ledger identity or worker labels", (t) => {
  const s = scene(t, { caller: "t121" });
  editPane(s, "t121", { labels: undefined });
  const args = ["label", "t121", "automagik-herdr.needs-owner=Ship?"];
  const result = guardRun(s, args, { HC_TERMINAL_ID: "t121" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(s), [["ls", "--json"], ["get", "t121", "--json"], args]);
});

test("#540 a guarded worker can label its own pane", (t) => {
  const s = scene(t);
  const args = ["label", "t105", "automagik-herdr.needs-owner=Ship?"];
  const result = guardRun(s, args, { HC_TERMINAL_ID: "t105" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), [args]);
});

test("#540 the guard refuses other self-label keys and extra arguments", (t) => {
  const s = scene(t);
  const label = "automagik-herdr.needs-owner=Ship?";
  for (const words of [
    ["t100", "role=reviewer"],
    ["t100", "automagik-herdr.needs-owner"],
    ["t100", label, "role=reviewer"],
    ["--json", "t100", label],
    ["t100", label, "--json"],
    ["--", "t100", label],
    ["t100", "--", label],
  ]) {
    const result = guardRun(s, ["label", ...words]);
    assertRefused(result);
    assert.match(result.stderr, /the caller's own pane takes only the automagik-herdr\.needs-owner label/, words.join(" "));
  }
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), []);
});

test("#540 the guard refuses owner questions on a stranger's pane or a worker's sibling", (t) => {
  const s = scene(t);
  editPane(s, "t110", { parent: "t100" });
  const label = "automagik-herdr.needs-owner=Ship?";
  for (const [caller, target] of [["t100", "t120"], ["t105", "t110"]]) {
    const result = guardRun(s, ["label", target, label], { HC_TERMINAL_ID: caller });
    assertRefused(result);
    assert.match(result.stderr, /the target is not the caller's own worker/);
  }
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), []);
});

test("#540 guard labelling refuses a machine-qualified canonical address", (t) => {
  const s = scene(t);
  editPane(s, "t105", { address: "m/t105" });
  const result = guardRun(s, ["label", "worker", "automagik-herdr.needs-owner=Ship?"]);
  assertRefused(result);
  // #628's checked resolution refuses the ls/get disagreement first; either way it never reaches hc.
  assert.match(result.stderr, /a machine target is not allowed|hc resolved the target to two different panes/);
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), []);
});

test("#540 a non-self label still needs a verified caller, an address and target labels", (t) => {
  const s = scene(t);
  const args = ["label", "t105", "role=dev"];
  editPane(s, "t105", { labels: undefined });
  const unbound = guardRun(s, args, { HC_TERMINAL_ID: "t121" });
  assertRefused(unbound);
  assert.match(unbound.stderr, /neither bound in the attach ledger nor a worker pane/);

  const noLabels = guardRun(s, args);
  assertRefused(noLabels);
  assert.match(noLabels.stderr, /the target is not resolvable with hc/);

  editPane(s, "t105", { labels: { "worker.of": ID.dev }, address: undefined });
  const noAddress = guardRun(s, args);
  assertRefused(noAddress);
  assert.match(noAddress.stderr, /the target's address from hc is not a terminal id/);
  assert.deepEqual(calls(s).filter(([verb]) => verb === "label"), []);
});

test("#540 the guard uses the label key the sidebar and tidy read", async () => {
  const { OWNER_QUESTION_LABEL } = await import("../mods/am-sidebar/hcGuard.mjs");
  const { NEEDS_OWNER_LABEL } = await import("../mods/am-sidebar/tidy.js");
  assert.equal(OWNER_QUESTION_LABEL, NEEDS_OWNER_LABEL);
});

// ---- an Antigravity pane at its prompt (RFC 0042 delivery 2) ----
// agy fires no hook while it waits, so the guard reads a candidate's screen on each send.
// These shapes are synthetic and are armed only in the wrapper's child process by a load hook.
// The stable copy keeps the installed bytes, so the test still exercises its real imports.
const MOD = join(GUARD_DIR, "..");
const AGY_FG = { argv: ["agy", "--mode", "auto"] };
const KEEP = ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh"];
const heldLine = (address) => `${JSON.stringify({ error: { kind: "blocked",
  message: `${address} is held by a dialog: a person must answer a question, permission or sign-in in it, so nothing was sent.`,
  hint: "Answer the dialog in that pane, or route this message to another pane; it was not typed and was not dropped." } })}\n`;
const readsOf = (s) => calls(s).filter((argv) => argv[0] === "read");
const sendsOf = (s) => calls(s).filter((argv) => hcVerbOf(argv) === "send");
const readOf = (address) => ["read", address, "--lines", "40", "--json"];

function agyStable(s, { drop = null, name = "stable" } = {}) {
  const dir = join(s.root, name);
  const copy = (file) => {
    const from = join(MOD, file), to = join(dir, file);
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  };
  for (const file of STABLE_FILES) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    if (file === "bin/run.sh") writeFileSync(to, stableRunnerText(process.execPath), { mode: 0o755 });
    else copy(file);
  }
  for (const folder of STABLE_FOLDERS) {
    mkdirSync(join(dir, folder), { recursive: true });
    for (const file of readdirSync(join(MOD, folder))) copy(join(folder, file));
  }
  const hook = join(s.root, `${name}-hook.mjs`);
  if (drop) unlinkSync(join(dir, drop));
  else {
    assert.equal(stableFilesCurrent(MOD, dir), true);
    const target = pathToFileURL(realpathSync(join(dir, "agyPrompt.js"))).href;
    writeFileSync(hook, agyHookSource(target));
  }
  return { dir, guard: join(dir, "guard", "hc"), shim: join(dir, "hc-kill", "hc"), hook };
}

function agyRun(s, st, entry, args, { armed = true, ...extra } = {}) {
  const hookArgs = armed ? ["--import", pathToFileURL(st.hook).href] : [];
  return spawnSync(process.execPath, [...hookArgs, entry, ...args], {
    env: envFor(s, { PATH: `${dirname(entry)}:${s.bin}:${dirname(process.execPath)}`, ...extra }),
    encoding: "utf8",
  });
}

const agyWrappers = [
  { entry: "guard", at: "t101", packRun: guardRun, env: {} },
  { entry: "shim", at: "t105", packRun: shimRun, env: { HC_TERMINAL_ID: "t103" } },
];
const agySend = (s, st, wrapper, args = ["send", wrapper.at, "x"], { armed = true, pack = false } = {}) => {
  writeFileSync(s.logPath, "");
  return pack ? wrapper.packRun(s, args, wrapper.env)
    : agyRun(s, st, st[wrapper.entry], args, { armed, ...wrapper.env });
};

function assertAgyHeld(s, result, address, reads = [readOf(address)]) {
  assert.ifError(result.error);
  assertHeld(result, address);
  assert.equal(result.stderr, heldLine(address));
  assert.deepEqual(sendsOf(s), []);
  assert.deepEqual(readsOf(s), reads);
}

function assertAgyForwarded(s, result, args, reads) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `stub-out ${JSON.stringify(args)}\n`);
  assert.equal(result.stderr, "stub-err send\n");
  assert.deepEqual(sendsOf(s), [args]);
  assert.deepEqual(readsOf(s), reads);
  const log = calls(s);
  const sendIndex = log.findIndex((argv) => same(argv, args));
  for (const read of reads) {
    assert.ok(log.findIndex((argv) => same(argv, read)) < sendIndex, "the guard reads before forwarding");
  }
}

test("RFC 0042 with the shipped shapes both wrappers read a working Antigravity pane at a synthetic screen once and forward it", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    editPane(s, at, { status: { state: "working" }, screen: trustScreen, foreground: AGY_FG });
    const args = ["send", at, "x"];
    for (const pack of [true, false]) {
      const result = agySend(s, st, wrapper, args, { armed: false, pack });
      assertAgyForwarded(s, result, args, [readOf(at)]);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 both wrappers refuse a working Antigravity pane at either prompt with #1414's line", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    for (const screen of [trustScreen, fileScreen("x/y")]) {
      editPane(s, wrapper.at, { status: { state: "working" }, screen, foreground: AGY_FG });
      assertAgyHeld(s, agySend(s, st, wrapper), wrapper.at);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 the kill shim refuses a working Antigravity pane at the captured trust prompt with the issue 1414 line", (t) => {
  const s = killScene(t), st = agyStable(s);
  const wrapper = agyWrappers.find((w) => w.entry === "shim");
  editPane(s, wrapper.at, { status: { state: "working" }, screen: capture("folder-trust.txt"), foreground: AGY_FG });
  const result = agySend(s, st, wrapper, undefined, { armed: false });
  assertAgyHeld(s, result, wrapper.at);
  assert.doesNotMatch(result.stdout + result.stderr, /\/work/);
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 the refusal names the pane, never the prompt's folder or words", (t) => {
  const s = killScene(t), st = agyStable(s);
  const folder = "/srv/agy-distinct-folder-q93z";
  for (const wrapper of agyWrappers) {
    for (const screen of [fileScreen(folder), quietScreen(folder)]) {
      editPane(s, wrapper.at, { status: { state: "idle", app: GUARD_APP }, screen, foreground: AGY_FG });
      const result = agySend(s, st, wrapper);
      assertAgyHeld(s, result, wrapper.at);
      for (const output of [result.stdout, result.stderr]) {
        assert.doesNotMatch(output, /agy-distinct-folder-q93z|\/srv\/|SYNTHETIC|outside the workspace/);
      }
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 a linked target and --force are refused the same way", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    const linked = `m/${at}`;
    for (const address of [at, linked]) {
      editPane(s, address, { status: { state: "working" }, screen: trustScreen, foreground: AGY_FG });
    }
    for (const [args, address] of [
      [["send", linked, "x"], linked],
      [["send", "--on", "m", at, "x"], linked],
      [["send", "--force", at, "x"], at],
    ]) {
      assertAgyHeld(s, agySend(s, st, wrapper, args), address);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 the kill shim reads and names the address hc get answered, never a typed name", (t) => {
  const s = killScene(t), st = agyStable(s);
  const shim = agyWrappers[1];
  const address = "m/t105", name = "agy-solo";
  const args = ["send", name, "x"];
  // hc ls still calls it worker-m. Only hc get knows agy-solo.
  editPane(s, address, { name, status: { state: "working" }, screen: trustScreen, foreground: AGY_FG });
  const result = agySend(s, st, shim, args);
  assertAgyHeld(s, result, address);
  assert.doesNotMatch(result.stderr, /agy-solo/);

  editPane(s, address, { status: { state: "idle" }, screen: DIALOG_SCREEN });
  const generic = agySend(s, st, shim, args);
  assertAgyHeld(s, generic, address, [readOf(address)]);
  assert.doesNotMatch(generic.stderr, /agy-solo/);
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 idle, done and no status are refused on a shape pendingDialog does not know", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    for (const status of [{ state: "idle", app: GUARD_APP }, { state: "done" }, undefined]) {
      editPane(s, at, { status, screen: quietScreen(), foreground: AGY_FG });
      assertAgyHeld(s, agySend(s, st, wrapper), at);
      const args = ["send", at, "x"];
      assertAgyForwarded(s, agySend(s, st, wrapper, args, { pack: true }), args, [readOf(at)]);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 an Antigravity miss still falls to #1414 only where it applied", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    editPane(s, at, { status: { state: "working" }, screen: DIALOG_SCREEN, foreground: AGY_FG });
    const args = ["send", at, "x"];
    assertAgyForwarded(s, agySend(s, st, wrapper, args), args, [readOf(at)]);
    editPane(s, at, { status: { state: "idle", app: GUARD_APP } });
    assertAgyHeld(s, agySend(s, st, wrapper), at);
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 a second send against the same block is refused again, each after its own read", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    editPane(s, at, { status: { state: "working" }, screen: trustScreen, foreground: AGY_FG });
    for (const text of ["first", "second"]) {
      assertAgyHeld(s, agySend(s, st, wrapper, ["send", at, text]), at);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 output changing above a quoted block: every send is refused, the sidebar holds nothing", (t) => {
  const s = killScene(t), st = agyStable(s);
  const a = "SYNTHETIC output 1\n" + trustScreen, b = "SYNTHETIC output 2\n" + trustScreen;
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    editPane(s, at, { status: { state: "working" }, screen: a, foreground: AGY_FG });
    assertAgyHeld(s, agySend(s, st, wrapper), at);
    editPane(s, at, { screen: b });
    assertAgyHeld(s, agySend(s, st, wrapper), at);
  }
  const first = observe(null, { ok: true, text: a }, 100, SYNTHETIC);
  assert.equal(observe(first, { ok: true, text: b }, 100, SYNTHETIC).held, null);
  assert.notEqual(observe(first, { ok: true, text: a }, 100, SYNTHETIC).held, null);
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 a mid-turn Antigravity pane is forwarded word for word", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    const screen = "SYNTHETIC building step 3 of 9\nSYNTHETIC thinking";
    editPane(s, at, { status: { state: "working" }, screen, foreground: AGY_FG });
    const args = ["send", at, "a message unchanged", "a second line"];
    assertAgyForwarded(s, agySend(s, st, wrapper, args), args, [readOf(at)]);
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 a working Claude or Codex pane is still not read", (t) => {
  const s = killScene(t), st = agyStable(s);
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    const args = ["send", at, "x"];
    for (const [argv0, app] of [["claude", "claude-code"], ["codex", "codex"]]) {
      editPane(s, at, { status: { state: "working", app }, screen: trustScreen, foreground: { argv: [argv0] } });
      assertAgyForwarded(s, agySend(s, st, wrapper, args), args, []);
    }
    editPane(s, at, {
      status: { state: "idle", app: "claude-code" }, screen: quietScreen(), foreground: { argv: ["claude"] },
    });
    assertAgyForwarded(s, agySend(s, st, wrapper, args), args, [readOf(at)]);
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 the hc get record decides who is Antigravity", (t) => {
  const s = killScene(t), st = agyStable(s);
  const working = { state: "working" };
  const reported = { state: "working", app: GUARD_APP };
  const evidence = [
    { pane: { foreground: { argv: [...KEEP, "agy"] } }, held: true, both: true },
    { pane: { status: reported, foreground: { argv: ["zsh", "-i"] } }, held: false, both: true },
    { pane: { status: reported }, held: true },
    { pane: { status: { state: "working", app: "gemini" } }, held: false },
    { pane: { foreground: AGY_FG, created_ms: null }, held: false },
    { pane: { argv: ["agy"] }, held: false },
  ];
  for (const { pane, held, both } of evidence) {
    for (const wrapper of both ? agyWrappers : agyWrappers.slice(0, 1)) {
      const { at } = wrapper;
      editPane(s, at, {
        status: working, screen: trustScreen, created_ms: 100, foreground: undefined, ...pane,
      });
      const args = ["send", at, "x"];
      const result = agySend(s, st, wrapper, args);
      if (held) assertAgyHeld(s, result, at);
      else assertAgyForwarded(s, result, args, []);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 an unreadable screen, a finished pane, blocked and error keep #1414's answers", (t) => {
  const s = killScene(t), st = agyStable(s);
  const states = [
    { pane: { readFail: true }, read: true, held: false },
    { pane: { state: "finished" }, read: false, held: false },
    { pane: { status: { state: "blocked" } }, read: false, held: true },
    { pane: { status: { state: "error" }, screen: quietScreen() }, read: true, held: false },
  ];
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    const args = ["send", at, "x"];
    for (const { pane, read, held } of states) {
      editPane(s, at, {
        state: "live", status: { state: "working" }, screen: trustScreen, foreground: AGY_FG,
        readFail: false, ...pane,
      });
      const result = agySend(s, st, wrapper, args);
      const reads = read ? [readOf(at)] : [];
      if (held) assertAgyHeld(s, result, at, reads);
      else assertAgyForwarded(s, result, args, reads);
    }
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
});

test("RFC 0042 the stable folder from STABLE_FILES runs the guard; a missing file fails closed", (t) => {
  const s = killScene(t), st = agyStable(s);
  const short = agyStable(s, { drop: "agyPrompt.js", name: "stable-short" });
  for (const wrapper of agyWrappers) {
    const { at } = wrapper;
    editPane(s, at, { status: { state: "idle" }, screen: FREE_SCREEN });
    const args = ["send", at, "x"];
    assertAgyForwarded(s, agySend(s, st, wrapper, args, { armed: false }), args, [readOf(at)]);

    const result = agySend(s, short, wrapper, args, { armed: false });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const failure = wrapper.entry === "guard" ? /the guard's logic did not load/
      : /its logic did not load, so this hc call was not run/;
    assert.match(result.stderr, failure);
    assert.deepEqual(calls(s), []);
  }
  assert.equal(stableFilesCurrent(MOD, st.dir), true);
  assert.equal(stableFilesCurrent(MOD, short.dir), false);
});

test("#1557 the kill shim sends to the canonical address it inspected, including with --on", (t) => {
  const s = killScene(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.get["only-in-get"] = { ...state.get.t105, address: "t105", screen: FREE_SCREEN };
  state.get["m/only-in-get"] = { ...state.get.t105, address: "m/t105", screen: FREE_SCREEN };
  state.get["m/off-machine"] = { ...state.get.t105, address: "other/t105", screen: FREE_SCREEN };
  writeFileSync(s.statePath, JSON.stringify(state));
  for (const [input, expected, inspected] of [
    [["send", "only-in-get", "ping"], ["send", "t105", "ping"], "t105"],
    [["send", "--on=m", "only-in-get", "ping"], ["send", "--on=m", "t105", "ping"], "m/t105"],
  ]) {
    writeFileSync(s.logPath, "");
    const result = shimRun(s, input, { HC_TERMINAL_ID: "t103" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls(s).some(args => args[0] === "read" && args[1] === inspected));
    assert.deepEqual(calls(s).at(-1), expected);
  }
  writeFileSync(s.logPath, "");
  const offMachine = shimRun(s, ["send", "--on=m", "off-machine", "ping"], { HC_TERMINAL_ID: "t103" });
  assert.equal(offMachine.status, 2, offMachine.stderr);
  assert.match(offMachine.stderr, /off the --on machine/);
  assert.equal(calls(s).some(args => args[0] === "send"), false);
});

test("#1557 the kill shim refuses a plain send when ls and get disagree", (t) => {
  const s = killScene(t);
  editPane(s, "t101", { address: "m/t105", screen: DIALOG_SCREEN });
  const result = shimRun(s, ["send", "cap", "plain text"], { HC_TERMINAL_ID: "t103" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /different panes \(t101 and m\/t105\)/);
  assert.equal(calls(s).some(args => args.includes("send")), false);
});

test("the guard and proxy docs say what RFC 0044 decided for keys, attach, events and the list (#628)", () => {
  // Whitespace is normalized: the README and the comment wrap sentences across lines.
  const flat = (text) => text.replace(/\s+/g, " ");
  const guard = readFileSync(join(MOD, "hcGuard.mjs"), "utf8");
  const header = flat(guard.slice(0, guard.indexOf("\nimport ")).replace(/^\/\/ ?/gm, ""));
  const readme = readFileSync(join(MOD, "..", "..", "README.md"), "utf8");
  const at = readme.indexOf("## The hc guard (a guardrail, not a boundary)");
  const end = readme.indexOf("\n\n`send` is scoped", at);
  assert.ok(at >= 0 && end > at, "the README's guard section is found");
  const section = flat(readme.slice(at, end));
  const doc = readFileSync(join(MOD, "hcProxy.md"), "utf8");
  // Two separate passages of hcProxy.md: the policy table's terminal.list row and the list paragraph.
  const rowAt = doc.indexOf("| `terminal.list` |");
  assert.ok(rowAt >= 0, "hcProxy.md's terminal.list policy row is found");
  const row = flat(doc.slice(rowAt, doc.indexOf("\n", rowAt)));
  const listAt = doc.indexOf("`terminal.list` is filtered");
  assert.ok(listAt >= 0, "hcProxy.md's list paragraph is found");
  const list = flat(doc.slice(listAt, doc.indexOf("\n\n", listAt)));
  for (const [where, text] of [["hcGuard.mjs's header", header], ["the README's guard section", section]]) {
    assert.doesNotMatch(text, /Both wait on herdr-core/, `${where} promises no joint upstream unlock for keys and attach`);
    assert.match(text, /attach[^.]*refused for sandboxed panes for good \(RFC 0044 Q5\)/i, `${where}: attach is refused for good`);
    assert.match(text, /keys[^.]*RFC 0044 delivery 6[^.]*\(R1-R3\)[^.]*\(R4, advertised as `checked_input`\)/i,
      `${where}: keys waits on delivery 6, and checked_input is R4's per-write check`);
  }
  assert.doesNotMatch(header, /list and events are filtered/, "the proxy refuses the event subscription; it filters none");
  assert.match(header, /refuses its event subscription/, "hcGuard.mjs's header: the proxy refuses the subscription");
  const crossTeam = /by the recipient's role or the caller's\)?, which may belong to another team/;
  for (const [where, text] of [["hcProxy.md's terminal.list row", row], ["hcProxy.md's list paragraph", list]]) {
    assert.doesNotMatch(text, /(other teams'|another team's) panes (are|and)[^.|]*(left out|never named)/i,
      `${where} does not claim other teams' panes are always left out`);
    assert.match(text, crossTeam, `${where} names the authorized cross-team recipients, by either role`);
  }
  assert.match(row, /linked-machine row[^|]*left out, and the `machines` inventory is empty/, "the row keeps machines out");
  assert.match(list, /as the core answered it, nested fields included/, "hcProxy.md: only the envelope is reviewed");
});
