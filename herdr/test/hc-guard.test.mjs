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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GUARD_DIR, KILL_GUARD_DIR, guardPath, guardPathWith, paneGuardOf, workerArgs } from "../mods/am-sidebar/workers.js";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { hcVerbOf } from "../mods/am-sidebar/hcGuard.mjs";

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

// The stub: logs every call, answers hc ls/get from the state file, and for any other verb
// prints the pass-through markers and exits HC_STUB_CODE.
const STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HC_STUB_LOG, JSON.stringify({ argv: args, marker: process.env.AM_HC_GUARD_REENTRY ?? null }) + "\\n");
const state = JSON.parse(readFileSync(process.env.HC_STUB_STATE, "utf8"));
if (args[0] === "ls") { process.stdout.write(JSON.stringify({ terminals: state.terminals }) + "\\n"); process.exit(0); }
if (args[0] === "get") {
  const at = args[1];
  const found = state.get[at] ?? Object.values(state.get).find((g) => g.name === at);
  if (!found) { process.stderr.write(JSON.stringify({ error: { kind: "not_found" } }) + "\\n"); process.exit(3); }
  process.stdout.write(JSON.stringify(found) + "\\n"); process.exit(0);
}
process.stdout.write("stub-out " + JSON.stringify(args) + "\\n");
process.stderr.write("stub-err " + args[0] + "\\n");
process.exit(Number(process.env.HC_STUB_CODE ?? 0));
`;

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
    },
  };
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

function assertRefused(r) {
  assert.notEqual(r.status, 0, "a refusal exits non-zero");
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `exactly one stderr line: ${JSON.stringify(r.stderr)}`);
  assert.match(r.stderr, /#624/);
  assert.match(r.stderr, /#628/);
  assert.match(r.stderr, /#631/);
  assert.equal(r.stdout, "", "a refusal prints no stdout");
}

// ---- the allow list ----

test("every allowed verb reaches the stub unchanged", (t) => {
  const s = scene(t);
  const allowed = [
    ["send", "t101", "hello"], ["read", "t101"], ["ls"], ["get", "t101"], ["wait", "t101"],
    ["put", "t101", "/tmp/file"], ["label", "t105", "role=dev"], ["rm", "t101"],
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
  const r = guardRun(s, ["read", "t101"], { HC_STUB_CODE: "7" });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, 'stub-out ["read","t101"]\n');
  assert.equal(r.stderr, "stub-err read\n");
  assert.deepEqual(calls(s), [["read", "t101"]]);
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
    state.get[address] = get(address, labels, { cwd: s.project, name: address, ...extra });
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

test("the widening is send only: keys is refused, kill is the main bot's (#955) and rm keeps today's unscoped pass", (t) => {
  const s = sharedScene(t);
  writeFileSync(s.logPath, "");
  const keys = guardRun(s, ["keys", "t203", "enter"], { HC_TERMINAL_ID: "t200" });
  assertRefused(keys);
  assert.deepEqual(calls(s), [], "keys never reaches hc");
  // A pm is not the project's main bot: its kill is refused like any member's (#955).
  writeFileSync(s.logPath, "");
  assertRefused(guardRun(s, ["kill", "t203"], { HC_TERMINAL_ID: "t200" }));
  assert.deepEqual(calls(s).filter((argv) => argv[0] === "kill"), []);
  // #636 leaves rm unscoped (#628 owns that scope); the widening does not touch it.
  for (const args of [["rm", "t203"]]) {
    writeFileSync(s.logPath, "");
    const r = guardRun(s, args, { HC_TERMINAL_ID: "t200" });
    assert.equal(r.status, 0, `${args[0]} is unchanged: ${r.stderr}`);
    assert.ok(calls(s).some((argv) => same(argv, args)), `${args[0]} arrives unchanged`);
  }
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

test("kill shim (#955): every other hc call goes to the real hc untouched, for a seat, a worker and an unknown pane", (t) => {
  const s = killScene(t);
  const others = [["send", "t105", "status?"], ["send", "t105", "kill"], ["--json", "send", "t105", "kill"], ["exec", "--", "sh", "-c", "echo kill"],
    ["run", "--bg", "claude"], ["keys", "t105", "enter"], ["interrupt", "t105"], ["rm", "t105"], ["read", "t105"], ["label", "t105", "a=b"],
    ["file", "write", "/x"], ["machine", "ls"], ["server", "status"], ["attach", "t105"], ["ls", "--all"], ["get", "t105"],
    ["--version"], ["--skill"], ["--help"], ["kill", "--help"], ["kill", "-h"], []];
  for (const terminal of ["t103", "t101", "t100", "t105", "t121"]) {
    for (const args of others) {
      writeFileSync(s.logPath, "");
      const r = shimRun(s, args, { HC_TERMINAL_ID: terminal, HC_STUB_CODE: "7" });
      // The stub answers ls and get itself (exit 0); everything else exits with the code it was given.
      const stubAnswers = ["ls", "get"].includes(args[0]);
      assert.equal(r.status, stubAnswers ? 0 : 7, `hc ${args.join(" ")} from ${terminal}: the real hc's exit code (${r.stderr})`);
      assert.doesNotMatch(r.stderr, /hc kill shim/, `hc ${args.join(" ")}: the shim says nothing`);
      assert.deepEqual(calls(s), [args], `hc ${args.join(" ")} from ${terminal}: one call, word for word, and nothing read for it`);
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
  assert.deepEqual(calls(s), [["send", "t105", "hi"]]);
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
    ["put", "m/t101", "/tmp/file"], ["label", "m/t101", "role=reviewer"], ["kill", "m/t101"], ["rm", "m/t101"],
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

// ---- the dsh-tui worker run shape ----

const exactRun = (s, over = {}) => workerArgs({
  botId: ID.dev, branch: "feat/x", role: "dev", name: "feat-x", cwd: s.worktree, parent: "t100",
  agent: "dsh-tui", argv: ["dsh-tui"], task: "do it", path: "/usr/bin:/bin", space: "sp1", ...over,
});

test("the exact dsh-tui worker argv reaches the stub unchanged", (t) => {
  const s = scene(t);
  const exact = exactRun(s);
  assert.equal(exact[exact.indexOf("--") + 3], "dsh-tui", exact.join(" "));
  assert.ok(exact[exact.indexOf("--") + 2].startsWith(`PATH=${GUARD_DIR}:`), exact.join(" "));
  writeFileSync(s.logPath, "");
  const r = guardRun(s, exact);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s), [exact]);
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
  const otherAgent = [...exact];
  otherAgent[otherAgent.indexOf("--") + 3] = "claude";
  const wrongCwd = exactRun(s, { cwd: s.project });
  const foreignParent = exactRun(s, { parent: "t101" });
  const foreignBot = exactRun(s, { botId: ID.cap });
  const bare = ["run", "--bg", "--parent", "t100", "--", "/usr/bin/env", `PATH=${GUARD_DIR}:/usr/bin`, "dsh-tui", "--", "task"];
  const cases = [
    ["bare", bare], ["foreign parent", foreignParent], ["foreign worker.of", foreignBot],
    ["cwd outside the worktrees", wrongCwd], ["template", template], ["another agent", otherAgent],
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
  assert.deepEqual(calls(s), [exact], "the real hc got the mixed-PATH worker argv once");
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
  assert.deepEqual(calls(s), [["read", "t101"]], "the real hc ran once; the guard copies did not");
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
  assert.equal(r.status, 7, r.stderr);
  assert.equal(existsSync(marker), true, "the planted hc was reached, not skipped");
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
  for (const file of ["hcGuard.mjs", "approved.js", "attach.js", "model.js", "models.js", "workers.js", "logins.js", "retired.js", "hermesPair.js"]) {
    copyFileSync(join(GUARD_DIR, "..", file), join(mod, file));
  }
  appendFileSync(join(mod, "hcGuard.mjs"), "\n// not this guard\n");
  copyFileSync(join(GUARD_DIR, "hc"), join(copyGuard, "hc"));
  chmodSync(join(copyGuard, "hc"), 0o755);
  writeFileSync(s.logPath, "");
  const r = spawnSync(process.execPath, [s.guard, "read", "t101"], {
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
  for (const file of ["hcGuard.mjs", "approved.js", "attach.js", "model.js", "models.js", "workers.js", "logins.js", "retired.js", "hermesPair.js"]) {
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
  st.get.t200 = get("t200", { bot: coordId }, { cwd: hubDir, name: "coord" });
  st.get.t201 = get("t201", { bot: unrelatedHubId }, { cwd: hubDir, name: "unrelated" });
  st.get.t202 = get("t202", { bot: hubTopId }, { cwd: hubDir, name: "hubtop" });
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
