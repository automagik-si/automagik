import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { attachLine, attachPath, attachRow, closingRow, readAttach } from "../mods/am-sidebar/attach.js";
import { ledgerPath } from "../mods/am-sidebar/workers.js";
import { startFakeCore } from "./fake-core.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLI = here("../mods/am-sidebar/bin/automagik-herdr.mjs");
const AM = here("../../am/bin/am");
const MAIN = "b-aaaaaaaaaa", MEMBER = "b-bbbbbbbbbb", OTHER = "b-cccccccccc", LAB = "b-dddddddddd";
const ABSENT = "b-eeeeeeeeee";
const UNRELATED = "b-ffffffffff";
const CORE = "core-local";
const holderAdd = ["holders", "add", "--local", "h2", "--json"];
const answerOf = (code, out, err) => ({ code, out, err, json: () => JSON.parse(out) });
const isClient = ({ origin }) => origin !== "core-status-helper";
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
const option = (argv, key) => argv[argv.indexOf(key) + 1];

function scene(t, { pool = true, core = true, qualifiedSpare, proxyTerminal } = {}) {
  const root = scratchRoot(t, "hb-local-only-");
  const bin = join(root, "bin"), vmBin = join(root, "vm"), home = join(root, "home"), app = join(root, "app");
  const config = join(root, "config");
  const data = join(app, "automagik-herdr");
  for (const dir of [bin, vmBin, home, config, data]) mkdirSync(dir, { recursive: true });
  for (const [name, fixture] of [["hc", "fake-hc.mjs"], ["herdr-app", "fake-herdr-app.mjs"], ["pgrep", "fake-pgrep.mjs"]]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(here(fixture)) + ' "$@"\n', { mode: 0o755 });
  }
  for (const dir of [bin, vmBin]) writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const look = { character: "star", colour: "blue" };
  const project = scratchProject(root, "proj", { bots: { version: 1, categories: [], bots: [
    { id: MAIN, name: "Main", kind: "main", look, role: "lead", instructions: "", agent: "claude" },
    { id: MEMBER, name: "Member", kind: "member", lead: MAIN, look, role: "member", instructions: "", agent: "claude" },
    { id: OTHER, name: ABSENT, kind: "member", lead: MAIN, look, role: "member", instructions: "", agent: "claude" },
    { id: UNRELATED, name: "Unrelated", kind: "member", lead: MAIN, look, role: "member", instructions: "", agent: "claude" },
  ] } });
  const roster = join(project, ".herdr/bots.json");
  const statePath = join(root, "hc.json"), log = join(root, "hc.log"), envLog = join(root, "env.log");
  const appState = join(root, "window.json"), appLog = join(root, "window.log");
  const holdersFile = join(data, "holders.json"), reservationsFile = join(data, "holder-reservations.json");
  const lossesFile = join(data, "holder-loss.log");
  save(statePath, { next: 100, terminals: [], machines: [{ name: "lab", id: "core-lab", state: "connected" }],
    core: { id: CORE, name: "host" }, machinePath: vmBin });
  save(appState, { place: true, qualifiedSpare, canonicalSpare: true });
  for (const file of [log, envLog, appLog, attachPath(app)]) writeFileSync(file, "", { mode: 0o600 });
  const env = { PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home, XDG_CONFIG_HOME: config,
    HERDR_APP_HOME: app, HERDR_APP_BIN: "/bin/false", AUTOMAGIK_HERDR_TEST_ROOTS: root, GIT_CEILING_DIRECTORIES: root,
    HC_FAKE_STATE: statePath, HC_FAKE_LOG: log, HC_FAKE_ENV_LOG: envLog, HC_FAKE_PROXY_TERMINAL: proxyTerminal,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog, AUTOMAGIK_HERDR_TAB_WAIT_MS: "1000" };
  const fakeCore = core ? startFakeCore(t, env) : null;
  Object.assign(env, fakeCore?.env ?? { AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "missing.sock") });
  const state = () => json(statePath);
  const setState = (edit) => { const s = state(); edit(s); save(statePath, s); };
  const bind = (id, address, created_ms, labels = {}) => {
    const [first, last] = address.split("/");
    const machine = last ? first : null;
    setState((s) => s.terminals.push({ address, state: "live", created_ms, cwd: project, labels: { bot: id, ...labels },
      foreground: { argv: ["claude"], cwd: project, pid: 1 }, status: { state: "idle" } }));
    appendFileSync(attachPath(app), attachLine(attachRow({ event: "attach", bot: id, terminal: last ?? first,
      machine, created_ms, project, core: machine ? "core-" + machine : CORE, by: "start" })));
  };
  const cli = (args, { launcher = false, env: extra = {}, timeout } = {}) => {
    const r = spawnSync(launcher ? AM : process.execPath, launcher ? args : [CLI, ...args],
      { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout });
    assert.ifError(r.error);
    return answerOf(r.status, r.stdout, r.stderr);
  };
  const cliAsync = (args, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extra } });
    let out = "", err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve(answerOf(code, out, err)));
  });
  const cliInProcess = (first, extra, next = null) => {
    const script = `
      const { main } = await import(process.argv[1]);
      const [first, next] = JSON.parse(process.argv[2]);
      const firstRun = main(first);
      let overlapping = null;
      if (next?.overlap) {
        const { setTimeout: delay } = await import("node:timers/promises");
        const until = Date.now() + 3000;
        while (process.env.HC_SOCKET !== process.env.AUTOMAGIK_HERDR_CORE_SOCKET) {
          if (Date.now() >= until) throw new Error("the first call did not pin its socket");
          await delay(10);
        }
        overlapping = main(next.args);
      }
      const code = await firstRun;
      const { HC_SOCKET, AUTOMAGIK_HERDR_CORE_SOCKET, HC_SESSION, HC_TERMINAL_ID, HC_TERMINAL_SOCKET } = process.env;
      const restored = { HC_SOCKET, AUTOMAGIK_HERDR_CORE_SOCKET, HC_SESSION, HC_TERMINAL_ID, HC_TERMINAL_SOCKET };
      if (next && !overlapping) Object.assign(process.env, next.env);
      const second = next ? await (overlapping ?? main(next.args)) : null;
      const final = Object.fromEntries(Object.keys(restored).map((key) => [key, process.env[key]]));
      console.log(JSON.stringify({ code, restored, second, ...(overlapping ? { final } : {}) }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "--eval", script, pathToFileURL(CLI).href, JSON.stringify([first, next])],
      { cwd: project, env: { ...env, ...extra }, encoding: "utf8" });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  };
  if (pool) assertSuccess(cli(holderAdd));
  if (pool) bind(OTHER, "h2/t9", 9);
  bind(LAB, "lab/t8", 8);
  bind(MAIN, "t1", 1, { role: "main", squad: "night" });
  const startArgs = (id = MEMBER) => ["start", id, "--project", project, "--local-only", "--json"];
  const envFrom = readJsonLines(envLog).length;
  const logged = () => readJsonLines(envLog).slice(envFrom);
  const envCalls = () => logged().filter(isClient);
  const reservations = () => json(reservationsFile).reserved;
  const rows = () => readAttach(readFileSync(attachPath(app), "utf8")).rows;
  return { root, project, env, app, appState, roster, holdersFile, reservationsFile, cli, cliAsync, cliInProcess, startArgs, state, setState, bind, reservations, rows,
    socket: fakeCore?.env.AUTOMAGIK_HERDR_CORE_SOCKET,
    calls: () => envCalls().map(({ argv }) => argv),
    envCalls,
    statusHelpers: () => logged().filter((row) => !isClient(row)),
    windowCalls: () => readJsonLines(appLog),
    losses: () => existsSync(lossesFile) ? readFileSync(lossesFile, "utf8") : null,
    localStart: (extra = {}) => cli(startArgs(), { env: { HC_SESSION: "wrong-session", ...extra } }),
  };
}

function assertSuccess(result) {
  assert.equal(result.code, 0, result.err);
  return result.json();
}

function assertRefused(result, code, refused) {
  assert.equal(result.code, code, result.err);
  assert.ok(result.out, result.err || "the refusal had no stdout or stderr");
  const answer = result.json();
  assert.deepEqual(Object.keys(answer).sort(), ["error", "refused"]);
  assert.equal(answer.refused, refused);
  assert.ok(result.err.includes("am: " + answer.error), result.err);
  return answer.error;
}

const runs = (s) => s.calls().filter((argv) => argv[0] === "run");
const newRows = (s) => s.rows().filter((row) => row.bot === MEMBER && row.event === "attach");
const seatRows = (s) => existsSync(ledgerPath(s.app)) ? readJsonLines(ledgerPath(s.app))
  .filter((row) => row.kind === "seat" && row.event === "start" && row.botId === MEMBER) : [];
const liveSeats = (s) => s.state().terminals.filter((pane) => pane.state === "live" && pane.labels.bot === MEMBER);
const comparable = ({ project, at, terminal, created_ms, ...row }) => row;

function assertLocalCalls(s) {
  const calls = s.calls();
  for (const argv of calls) {
    assert.ok(!argv.includes("--on") && !["machine", "exec", "file"].includes(argv[0]), JSON.stringify(argv));
    assert.ok(argv[0] !== "server" || argv[1] !== "status", JSON.stringify(argv));
    if (["get", "label", "read", "kill"].includes(argv[0])) assert.match(argv[1], /^t[0-9a-z]+$/, JSON.stringify(argv));
    if (argv.includes("--parent")) assert.match(option(argv, "--parent"), /^t[0-9a-z]+$/, JSON.stringify(argv));
  }
  const envCalls = s.envCalls();
  assert.equal(envCalls.length, calls.length);
  for (const { argv, HC_SOCKET, HC_SESSION } of envCalls) {
    assert.equal(HC_SOCKET, s.socket, JSON.stringify(argv));
    assert.equal(HC_SESSION, undefined, JSON.stringify(argv));
  }
}

test("local-only start pins hc, uses the local lead, and writes the same seat as a plain local launch", (t) => {
  const s = scene(t);
  const before = s.rows();
  const losses = s.losses();
  const out = assertSuccess(s.localStart());
  assert.equal(out.id, MEMBER);
  assert.equal(out.parent, "t1");
  assertLocalCalls(s);
  assert.equal(runs(s).length, 1);
  assert.equal(option(runs(s)[0], "--parent"), "t1");
  assert.ok(runs(s)[0].includes("squad=night"));
  assert.ok(runs(s)[0].includes("automagik-herdr.squad=night"));
  assert.ok(s.calls().some(([verb, address]) => verb === "get" && address === "tsh1"), "the local spare was looked up");
  const [pane] = liveSeats(s);
  const [row] = newRows(s);
  assert.deepEqual({ ...row, at: null }, { v: 1, event: "attach", bot: MEMBER, project: s.project, machine: null,
    by: "start", core: CORE, terminal: pane.address, created_ms: pane.created_ms, at: null });
  assert.equal(out.terminal, row.terminal);
  assert.deepEqual(s.rows(), [...before, row]);
  assert.deepEqual(s.reservations(), []);
  assert.equal(s.losses(), losses);

  const plain = scene(t);
  assertSuccess(plain.cli(["start", MEMBER, "--holder", "local", "--json"]));
  assert.ok(plain.calls().some(([verb, address]) => verb === "get" && address.includes("/")), "ordinary start probes linked panes");
  const [plainRow] = newRows(plain);
  assert.equal(plainRow.project, plain.project);
  assert.deepEqual(comparable(row), comparable(plainRow));
});

test("local-only start reports an existing local seat", (t) => {
  const s = scene(t);
  const out = assertSuccess(s.cli(s.startArgs(MAIN)));
  assert.deepEqual(out, { id: MAIN, running: "t1" });
  assertLocalCalls(s);
  assert.equal(runs(s).length, 0);
  assert.equal(existsSync(s.reservationsFile), false);
});

test("an unverifiable live binding refuses local-only start before any sweep", (t) => {
  const s = scene(t, { pool: false });
  s.bind(MEMBER, "t100", 100);
  s.bind(UNRELATED, "t200", 200);
  s.setState((state) => {
    state.terminals.find((pane) => pane.address === "t200").state = "finished";
    state.getReply = { t100: { address: "t100", state: "live" } };
  });
  const ledger = attachPath(s.app);
  const before = readFileSync(ledger);
  const missing = s.localStart();
  assert.equal(missing.code, 1, missing.err);
  assert.match(missing.err, /hc get t100 gave incomplete pane identity/);
  assert.ok(s.calls().some(([verb, address]) => verb === "get" && address === "t200"));
  assert.deepEqual(readFileSync(ledger), before);
  assert.equal(runs(s).length, 0);

  s.setState((state) => { state.getReply.t100 = { address: "lab/t100", state: "live", created_ms: 100 }; });
  const mismatch = s.localStart();
  assert.equal(mismatch.code, 1, mismatch.err);
  assert.match(mismatch.err, /hc get t100 gave incomplete pane identity/);
  assert.deepEqual(readFileSync(ledger), before);
  assert.equal(runs(s).length, 0);
  assertLocalCalls(s);
});

test("a pane list row with no address refuses before any sweep: the live binding stays, nothing runs", (t) => {
  const s = scene(t);
  s.bind(MEMBER, "t100", 100);
  // The bound pane is live and answers hc get, but its own hc ls row carries no address.
  s.setState((state) => { state.lsReply = { terminals: [{ name: "member", state: "live" }] }; });
  const ledger = attachPath(s.app);
  const before = readFileSync(ledger);
  const r = s.localStart();
  assert.deepEqual(readFileSync(ledger), before, "the live binding must not be swept");
  assert.equal(runs(s).length, 0);
  assert.match(assertRefused(r, 1, "incomplete-identity"), /hc ls gave a pane with no address/);
});

function seedProjectHomeBinding(s, terminal, created_ms) {
  const defaultLedger = attachPath(join(s.env.HOME, ".config/herdr-app"));
  mkdirSync(dirname(defaultLedger), { recursive: true });
  writeFileSync(defaultLedger, readFileSync(attachPath(s.app)), { mode: 0o600 });
  const projectLedger = attachPath(join(s.project, ".herdr/app-home"));
  mkdirSync(dirname(projectLedger), { recursive: true });
  writeFileSync(projectLedger, attachLine(attachRow({ event: "attach", bot: MEMBER, project: s.project,
    core: CORE, terminal, created_ms, by: "start" })), { mode: 0o600 });
  return defaultLedger;
}

test("local-only start refuses a project-home terminal name without passing it to hc", (t) => {
  const s = scene(t, { pool: false });
  const defaultLedger = seedProjectHomeBinding(s, "member", 100);
  const before = readFileSync(defaultLedger);

  const result = s.localStart({ HERDR_APP_HOME: undefined });
  assert.match(assertRefused(result, 1, "not-local"), /member/);
  assert.deepEqual(readFileSync(defaultLedger), before);
  assert.equal(runs(s).length, 0);
  assertLocalCalls(s);
});

test("local-only start skips an id-shaped name in a historical project-home row", (t) => {
  const s = scene(t, { pool: false });
  seedProjectHomeBinding(s, "tester", 8);
  s.setState((state) => { state.terminals.find((pane) => pane.address === "lab/t8").name = "tester"; });

  const out = assertSuccess(s.localStart({ HERDR_APP_HOME: undefined }));
  assert.equal(out.id, MEMBER);
  assert.equal(runs(s).length, 1);
  assert.ok(!s.calls().some(([verb, address]) => verb === "get" && address === "tester"));
  assertLocalCalls(s);
});

for (const connected of [true, false]) {
  test("local-only start refuses an h2 binding when h2 is " + (connected ? "connected" : "disconnected"), (t) => {
    const s = scene(t);
    s.bind(MEMBER, "h2/t10", 10);
    if (!connected) s.setState((state) => { state.machines.find((m) => m.name === "h2").state = "disconnected"; });
    assert.match(assertRefused(s.localStart(), 1, "held-elsewhere"), /am start run in a terminal checks it again/);
    assertLocalCalls(s);
    assert.equal(runs(s).length, 0);
    assert.equal(s.losses(), null);
  });
}

test("local-only start refuses a live reservation for the id", (t) => {
  const s = scene(t, { pool: false });
  s.bind(MEMBER, "lab/t10", 10); // A non-holder's pane does not spend the local reservation.
  const reserved = [{ id: "other-start", holder: "local", bot: MEMBER, at: new Date().toISOString() }];
  save(s.reservationsFile, { v: 1, reserved });
  assertRefused(s.localStart(), 1, "held-elsewhere");
  assertLocalCalls(s);
  assert.equal(runs(s).length, 0);
  assert.deepEqual(s.reservations(), reserved);
});

for (const [kind, content] of [["invalid JSON", "corrupt"], ["empty", ""], ["non-array holder list", '{"holders":"h2"}']]) {
  test(`a present ${kind} holder pool refuses an unconfirmed binding elsewhere`, (t) => {
    const s = scene(t);
    s.bind(MEMBER, "h2/t10", 10);
    writeFileSync(s.holdersFile, content);
    assertRefused(s.localStart(), 1, "held-elsewhere");
    assertLocalCalls(s);
    assert.equal(runs(s).length, 0);
  });
}

test("first local-only start creates the private state directory before taking the holder lock", (t) => {
  const s = scene(t, { pool: false });
  rmSync(s.app, { recursive: true });
  s.setState((state) => { state.terminals = []; });
  assert.equal(existsSync(s.app), false);
  const out = assertSuccess(s.localStart());
  assert.equal(statSync(dirname(s.reservationsFile)).mode & 0o777, 0o700);
  assert.equal(newRows(s)[0].terminal, out.terminal);
  assert.deepEqual(s.reservations(), []);
  assertLocalCalls(s);
});

test("a local binding spends only the same bot's local reservation", (t) => {
  const s = scene(t);
  const heldOnH2 = { id: "on-h2", holder: "h2", bot: MAIN, at: new Date().toISOString() };
  save(s.reservationsFile, { v: 1, reserved: [
    { ...heldOnH2, id: "on-local", holder: "local" }, heldOnH2,
  ] });
  assertSuccess(s.localStart());
  assert.deepEqual(s.reservations(), [heldOnH2]);
  assertLocalCalls(s);
});

test("a valid one-holder pool retains per-machine identity for a linked non-holder", (t) => {
  const s = scene(t, { pool: false });
  assertSuccess(s.cli(["holders", "limit", "6", "--json"]));
  s.bind(MEMBER, "lab/t10", 10);
  const out = assertSuccess(s.localStart());
  assertLocalCalls(s);
  assert.deepEqual(newRows(s).map((row) => [row.machine, row.terminal]), [["lab", "t10"], [null, out.terminal]]);
  assert.deepEqual(s.reservations(), []);
});

const otherStart = ["start", MEMBER, "--holder", "h2", "--json"];

function assertOneSeat(s) {
  assert.equal(runs(s).length, 1);
  assert.equal(liveSeats(s).length, 1);
  assert.equal(newRows(s).length, 1);
  assert.deepEqual(s.reservations(), []);
}

for (let i = 1; i <= 3; i += 1) {
  test("local-only start races an explicit h2 start (" + i + "/3)", async (t) => {
    const s = scene(t);
    const [local, other] = await Promise.all([s.cliAsync(s.startArgs()), s.cliAsync(otherStart)]);
    const diagnostic = local.err + other.err;
    if (local.code === 0) {
      assert.equal(other.code, 1, diagnostic);
      assert.match(other.json().error, /already has a seat|already starting/);
    } else {
      assertRefused(local, 1, "held-elsewhere");
      assertSuccess(other);
    }
    assertOneSeat(s);
  });
}

async function waitFor(predicate, message) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, message);
    await delay(20);
  }
}

test("an unrelated ordinary start preserves the local reservation after a second holder is added", async (t) => {
  const s = scene(t, { pool: false });
  s.bind(MEMBER, "lab/t10", 10);
  const labBinding = newRows(s)[0];
  const release = join(s.root, "open-space");
  save(s.appState, { place: true, waitForSpace: release });
  const launch = s.cliAsync(s.startArgs());
  try {
    await waitFor(() => s.windowCalls().some(([verb, command]) => verb === "do" && command === "space.new"),
      "the local start did not reach window placement");
    const reservation = s.reservations().find((r) => r.bot === MEMBER);
    assert.equal(reservation?.holder, "local");
    assertSuccess(await s.cliAsync(holderAdd));
    assertSuccess(await s.cliAsync(["start", UNRELATED, "--holder", "local", "--space", "sp-unrelated", "--json"]));
    assert.ok(s.reservations().some((r) => r.id === reservation.id), "the lab binding did not spend the local reservation");
    s.setState((state) => {
      state.terminals.find((pane) => pane.address === "lab/t10").state = "finished";
    });
    appendFileSync(attachPath(s.app), attachLine(closingRow(labBinding, "end", "sweep", "finished")));
    const other = await s.cliAsync(otherStart);
    assert.equal(other.code, 1, other.err);
    assert.match(other.json().error, /already starting on holder "local"/);
  } finally {
    writeFileSync(release, "");
    assertSuccess(await launch);
  }
  assert.equal(runs(s).filter((argv) => argv.includes(`bot=${MEMBER}`)).length, 1);
  assert.equal(liveSeats(s).length, 1);
  assert.equal(newRows(s).filter((row) => !row.machine).length, 1);
  assert.deepEqual(s.reservations(), []);
});

test("a timed-out local start records the pane found by name in the live list", (t) => {
  const s = scene(t);
  s.setState((state) => {
    state.runDelayMs = 10_000;
    state.terminals.push({ address: "t200", name: "member", state: "live", labels: {} });
  });
  const out = assertSuccess(s.localStart({ AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "1000" }));
  assert.equal(option(runs(s)[0], "--name"), "member-bbbb");
  const after = s.calls().slice(s.calls().findIndex(([verb]) => verb === "run") + 1);
  assert.deepEqual(after.slice(0, 2), [["ls", "--json"], ["get", out.terminal, "--json"]]);
  assert.equal(newRows(s)[0].terminal, out.terminal);
  assert.equal(seatRows(s)[0].terminal, out.terminal);
  assert.deepEqual(assertSuccess(s.localStart()), { id: MEMBER, running: out.terminal });
  assertOneSeat(s);
  assertLocalCalls(s);
});

for (const delayed of [false, true]) {
  test("a qualified address from " + (delayed ? "the timeout lookup" : "the run reply") + " is left alone", (t) => {
    const s = scene(t);
    s.setState((state) => { state.runAddress = "lab/t100"; if (delayed) state.runDelayMs = 10_000; });
    assert.match(assertRefused(s.localStart(delayed ? { AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "1000" } : {}), 1, "not-local"), /left as it is/);
    const after = s.calls().slice(s.calls().findIndex(([verb]) => verb === "run") + 1);
    assert.deepEqual(after, delayed ? [["ls", "--json"]] : []);
    assertLocalCalls(s);
    assert.deepEqual(newRows(s), []);
    assert.deepEqual(s.reservations(), []);
    assert.equal(runs(s).length, 1);
    assert.deepEqual(seatRows(s), []);
  });
}

test("a name-shaped run address is refused before it can become an hc get operand", (t) => {
  const s = scene(t);
  s.setState((state) => { state.runAddress = "member"; });
  assertRefused(s.localStart(), 1, "not-local");
  assert.deepEqual(s.calls().slice(s.calls().findIndex(([verb]) => verb === "run") + 1), []);
  assertLocalCalls(s);
  assert.equal(runs(s).length, 1);
  assert.deepEqual(newRows(s), []);
  assert.deepEqual(seatRows(s), []);
});

test("a qualified spare is left alone after the bot starts", (t) => {
  const s = scene(t, { qualifiedSpare: "lab" });
  assertSuccess(s.localStart());
  assertLocalCalls(s);
  assert.ok(s.windowCalls().some(([verb, command]) => verb === "do" && command === "space.new"));
  assert.ok(!s.windowCalls().some(([verb, command]) => verb === "do" && command === "tab.close"));
  assert.ok(s.state().terminals.some((pane) => pane.address === "lab/tsh1"));
});

test("post-start tidy and session recording only get canonical local ids", (t) => {
  const s = scene(t, { pool: false });
  mkdirSync(join(s.env.HOME, ".codex/sessions"), { recursive: true });
  s.setState((state) => {
    state.terminals.push({ address: "member-alias", cwd: s.project, state: "live", created_ms: 200, labels: {} });
  });
  const { terminal } = assertSuccess(s.localStart());
  const calls = s.calls();
  const started = calls.findIndex(([verb]) => verb === "run");
  const listedLive = ([verb, flag]) => verb === "ls" && flag === "--json";
  const tidy = calls.findIndex((argv, index) => index > started && listedLive(argv));
  const sessions = calls.findIndex((argv, index) => index > tidy && listedLive(argv));
  assert.ok(started >= 0 && started < tidy && tidy < sessions);
  assert.ok(calls.slice(tidy, sessions).some(([verb, address]) => verb === "get" && address === terminal));
  assert.ok(calls.slice(sessions).some(([verb, address]) => verb === "get" && address === terminal));
  assertLocalCalls(s);
});

test("timeout recovery refuses an ambiguous name without getting either terminal", (t) => {
  const s = scene(t);
  s.setState((state) => {
    state.runDelayMs = 10_000;
    state.addAfterLs = { nth: 2, terminal: { address: "lab/t101", name: "member", state: "live", labels: {} } };
  });
  const result = s.localStart({ AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "1000" });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /Terminal name member is ambiguous/);
  const after = s.calls().slice(s.calls().findIndex(([verb]) => verb === "run") + 1);
  assert.deepEqual(after, [["ls", "--json"]]);
  assert.deepEqual(newRows(s), []);
  assertLocalCalls(s);
});

test("timeout recovery verifies the chosen pane's bot label before attaching", (t) => {
  const s = scene(t);
  s.setState((state) => {
    state.runDelayMs = 10_000;
    state.getReply = { t100: { address: "t100", state: "live", created_ms: 100, labels: { bot: OTHER } } };
  });
  const result = s.localStart({ AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "1000" });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /did not verify the live pane's bot label/);
  const after = s.calls().slice(s.calls().findIndex(([verb]) => verb === "run") + 1);
  assert.deepEqual(after, [["ls", "--json"], ["get", "t100", "--json"]]);
  assert.deepEqual(newRows(s), []);
  assertLocalCalls(s);
});

test("space.new cannot authorize closing an existing linked space from its reply", (t) => {
  const s = scene(t);
  const linked = { id: "sp-linked", folder: s.project, machine: "lab", tabs: [
    { id: "tb-linked", terminals: [{ terminal: "lab/t8", pane: "p-linked" }] },
  ] };
  save(s.appState, { place: true, spaces: [linked], spaceReply: { space: linked.id, terminal: "lab/t8" } });
  assertSuccess(s.localStart());
  assert.ok(s.windowCalls().some(([verb, command]) => verb === "do" && command === "space.new"));
  assert.ok(!s.windowCalls().some(([verb, command]) => verb === "do" && command === "space.close"));
  assert.ok(json(s.appState).spaces.some((space) => space.id === linked.id));
  assertLocalCalls(s);
});

test("local placement leaves both new spaces alone when ownership is ambiguous", (t) => {
  const s = scene(t);
  save(s.appState, { place: true, canonicalSpare: true, rival: true, rivalTerminal: "tsh1", spaceReply: { space: "sp-new1" } });
  assertSuccess(s.localStart());
  assert.ok(!s.windowCalls().some(([verb, command]) => verb === "do" && ["space.close", "tab.close"].includes(command)));
  assert.deepEqual(json(s.appState).spaces.map((space) => space.id), ["sp-rival", "sp-new1"]);
  assertLocalCalls(s);
});

test("local placement closes its idle spare space only with a known pane count of one", (t) => {
  const unknown = scene(t);
  save(unknown.appState, { place: true, canonicalSpare: true, rival: true });
  assertSuccess(unknown.localStart());
  assert.ok(!unknown.windowCalls().some(([verb, command]) => verb === "do" && command === "space.close"));
  assert.deepEqual(json(unknown.appState).spaces.map((space) => space.id), ["sp-rival", "sp-new1"]);
  assertLocalCalls(unknown);

  const known = scene(t);
  save(known.appState, { place: true, canonicalSpare: true, rival: true, paneCounts: true });
  assertSuccess(known.localStart());
  const close = known.windowCalls().find(([verb, command]) => verb === "do" && command === "space.close");
  assert.ok(close, "the confirmed idle spare space was closed");
  assert.deepEqual(JSON.parse(close[2]), { id: "sp-new1", confirmed: true });
  assertLocalCalls(known);
});

for (const flag of ["shellBusy", "shellJob"]) {
  test(`local placement leaves a rival space's spare open with ${flag}`, (t) => {
    const s = scene(t);
    save(s.appState, { place: true, canonicalSpare: true, rival: true, paneCounts: true, [flag]: true });
    assertSuccess(s.localStart());
    const beforeRun = s.calls().slice(0, s.calls().findIndex(([verb]) => verb === "run"));
    assert.ok(beforeRun.some(([verb, address]) => verb === "get" && address === "tsh1"));
    assert.ok(!s.windowCalls().some(([verb, command]) => verb === "do" && command === "space.close"));
    assert.deepEqual(json(s.appState).spaces.map((space) => space.id), ["sp-rival", "sp-new1"]);
    assertLocalCalls(s);
  });
}

test("direct server status calls stay visible separately from the fake core helper", (t) => {
  const s = scene(t);
  assertSuccess(s.localStart());
  assert.ok(s.statusHelpers().some(({ argv }) => argv.join(" ") === "server status --json"));
  assertLocalCalls(s);
  assertSuccess(s.cli(["holders", "up", "--json"]));
  assert.ok(s.envCalls().some(({ argv, HC_SESSION }) => argv.join(" ") === "server status --json" && HC_SESSION === "am-holder-h2"));
});

function holderSessionEnv(t, s) {
  const holderState = join(s.root, "hc-h2.json");
  save(holderState, { core: { id: "core-h2", name: "holder" }, terminals: [] });
  const holder = startFakeCore(t, { ...s.env, HC_FAKE_STATE: holderState });
  const stateHome = join(s.root, "xdg-state");
  for (const [session, socket] of [["default", s.socket], ["am-holder-h2", holder.env.AUTOMAGIK_HERDR_CORE_SOCKET]]) {
    const dir = join(stateHome, "herdr-core", session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.lock"), socket + "\n");
  }
  return {
    HC_SESSION: "am-holder-h2", HC_SOCKET: undefined, AUTOMAGIK_HERDR_CORE_SOCKET: undefined, XDG_STATE_HOME: stateHome,
    AUTOMAGIK_HERDR_TEST_ROOTS: [s.env.AUTOMAGIK_HERDR_TEST_ROOTS, holder.env.AUTOMAGIK_HERDR_TEST_ROOTS].join(":"),
  };
}

test("session-only discovery ignores the configured extra holder and preserves the local binding", (t) => {
  const s = scene(t);
  const transport = holderSessionEnv(t, s);
  const before = s.rows();
  assertSuccess(s.localStart(transport));
  const [row] = newRows(s);
  assert.equal(row.core, CORE);
  assert.deepEqual(s.rows(), [...before, row]);
  assert.equal(option(runs(s)[0], "--parent"), "t1");
  assert.ok(s.statusHelpers().length);
  assert.ok(s.statusHelpers().every((call) => call.AUTOMAGIK_HERDR_CORE_SOCKET === s.socket));
  assertLocalCalls(s);
});

test("a configured extra holder socket refuses before any local view or sweep", (t) => {
  const s = scene(t);
  const transport = holderSessionEnv(t, s);
  const lockDir = join(transport.XDG_STATE_HOME, "herdr-core");
  const holderSocket = readFileSync(join(lockDir, "am-holder-h2/core.lock"), "utf8").trim();
  const ledger = attachPath(s.app);
  const before = readFileSync(ledger);

  const byHcSocket = s.localStart({ ...transport, HC_SOCKET: holderSocket });
  assert.match(assertRefused(byHcSocket, 2, "transport"), /belongs to holder "h2"/);
  const byOverride = s.localStart({ ...transport, HC_SESSION: undefined, AUTOMAGIK_HERDR_CORE_SOCKET: holderSocket });
  assert.match(assertRefused(byOverride, 2, "transport"), /belongs to holder "h2"/);
  writeFileSync(join(lockDir, "default/core.lock"), holderSocket + "\n");
  const byDiscovery = s.localStart(transport);
  assert.match(assertRefused(byDiscovery, 2, "transport"), /belongs to holder "h2"/);

  assert.deepEqual(s.statusHelpers(), []);
  assert.deepEqual(s.calls(), []);
  assert.equal(runs(s).length, 0);
  assert.deepEqual(readFileSync(ledger), before);
});

test("an ambiguous holder session with a blank pool refuses before any probe or ledger sweep", (t) => {
  const s = scene(t);
  const transport = holderSessionEnv(t, s);
  const before = readFileSync(attachPath(s.app));
  writeFileSync(s.holdersFile, "");
  assertRefused(s.localStart(transport), 2, "transport");
  assert.deepEqual(s.statusHelpers(), []);
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(readFileSync(attachPath(s.app)), before);
});

test("an imported main restores the pin and the next ordinary start discovers its own core", (t) => {
  const s = scene(t, { pool: false });
  const statePath = join(s.root, "hc-next.json");
  save(statePath, { core: { id: "core-next", name: "next" }, terminals: [], next: 200 });
  const next = startFakeCore(t, { ...s.env, HC_FAKE_STATE: statePath });
  const transport = { AUTOMAGIK_HERDR_CORE_SOCKET: s.socket, HC_SOCKET: "", HC_SESSION: "original-session" };
  const result = s.cliInProcess(s.startArgs(), transport, {
    args: ["start", UNRELATED, "--json"],
    env: { ...next.env, HC_FAKE_STATE: statePath },
  });
  assert.deepEqual(result, { code: 0, restored: transport, second: 0 });
  assert.equal(newRows(s)[0].core, CORE);
  assert.equal(s.rows().find((row) => row.bot === UNRELATED)?.core, "core-next");
  const firstRun = s.envCalls().find(({ argv }) => argv[0] === "run" && argv.includes(`bot=${MEMBER}`));
  assert.equal(firstRun.HC_SOCKET, s.socket);
  assert.equal(firstRun.HC_SESSION, undefined);
});

test("overlapping imported starts serialize the pin and restore the original transport", (t) => {
  const s = scene(t, { pool: false });
  s.setState((state) => { state.runDelayMs = 1500; });
  const transport = { AUTOMAGIK_HERDR_CORE_SOCKET: s.socket, HC_SOCKET: "", HC_SESSION: "original-session" };
  const result = s.cliInProcess(s.startArgs(), transport, { args: ["start", UNRELATED, "--json"], overlap: true });
  assert.deepEqual(result, { code: 0, restored: transport, second: 0, final: transport });
  const [local, ordinary] = s.envCalls().filter(({ argv }) => argv[0] === "run");
  assert.ok(local.argv.includes(`bot=${MEMBER}`));
  assert.equal(local.HC_SOCKET, s.socket);
  assert.equal(local.HC_SESSION, undefined);
  assert.ok(ordinary.argv.includes(`bot=${UNRELATED}`));
  assert.equal(ordinary.HC_SOCKET, "");
  assert.equal(ordinary.HC_SESSION, transport.HC_SESSION);
});

test("a valid pane proxy keeps the caller's transport environment through local-only start", (t) => {
  const s = scene(t, { pool: false, proxyTerminal: "t1" });
  const transport = { HC_SOCKET: s.socket, HC_SESSION: "pane-session", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: s.socket };
  assert.deepEqual(s.cliInProcess(s.startArgs(), { ...transport, AUTOMAGIK_HERDR_CORE_SOCKET: undefined }),
    { code: 0, restored: transport, second: null });
  assert.equal(newRows(s)[0].core, CORE);
  assert.equal(runs(s).length, 1);
  assert.deepEqual(s.statusHelpers(), []);
  for (const { argv, ...env } of s.envCalls()) assert.deepEqual(env, transport, JSON.stringify(argv));
});

test("a filtered proxy cannot complete the first attach import before a direct start", (t) => {
  const s = scene(t, { pool: false, proxyTerminal: "t1" });
  s.bind(MEMBER, "t100", 100);
  const ledger = attachPath(s.app);
  rmSync(ledger);
  s.setState((state) => { state.lsReply = { terminals: [] }; });
  const transport = { HC_SOCKET: s.socket, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: s.socket };
  assert.match(assertRefused(s.localStart(transport), 1, "transport"), /first attach ledger import needs the core's direct socket/);
  assert.equal(existsSync(ledger), false);
  assert.deepEqual(s.calls(), []);

  s.setState((state) => { delete state.lsReply; });
  assert.deepEqual(assertSuccess(s.localStart()), { id: MEMBER, running: "t100" });
  assert.equal(newRows(s)[0].by, "import");
  assert.equal(runs(s).length, 0);
  assertLocalCalls(s);
});

test("conflicting socket overrides refuse without invoking hc", (t) => {
  const s = scene(t, { pool: false });
  const second = startFakeCore(t, { ...s.env, AUTOMAGIK_HERDR_TEST_ROOTS: s.project });
  assertRefused(s.localStart({ HC_SOCKET: second.env.AUTOMAGIK_HERDR_CORE_SOCKET }), 2, "transport");
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(s.envCalls(), []);
});

test("an absent core refuses without invoking hc", (t) => {
  const s = scene(t, { pool: false, core: false });
  assertRefused(s.localStart(), 1, "no-core");
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(s.envCalls(), []);
});

test("usage, folder and roster refusals win before any hc calls", (t) => {
  const s = scene(t, { pool: false, core: false });
  const missing = join(s.project, "missing");
  const noRoster = join(s.project, "..", "no-roster");
  mkdirSync(noRoster);
  const roster = json(s.roster);
  roster.bots.find((b) => b.id === OTHER).planned = { wave: 1, note: "waiting" };
  save(s.roster, roster);
  const rows = [
    [2, "usage", ["start", "--local-only", "--machine", "x"]],
    [2, "usage", ["start", MEMBER, "--local-only", "--project="]],
    [2, "usage", ["start", MEMBER, "--local-only"]],
    [2, "bot-id", ["start", "--local-only", "--project", s.project]],
    [2, "bot-id", ["start", "Member", "--local-only", "--project", s.project]],
    [2, "usage", ["start", "--local-only", "--help"]],
    [2, "usage", ["start", "--local-only", "--version"]],
    [2, "usage", ["ls", "--local-only"]],
    [1, "not-in-roster", s.startArgs(ABSENT).slice(0, -1)],
    [2, "no-folder", ["start", MEMBER, "--local-only", "--project", missing]],
    [1, "no-roster", ["start", MEMBER, "--local-only", "--project", noRoster]],
    [1, "not-startable", s.startArgs(OTHER).slice(0, -1)],
  ];
  for (const [code, refused, args] of rows) {
    assertRefused(s.cli([...args, "--json"]), code, refused);
  }
  for (const flag of ["machine", "holder", "space", "tab"]) {
    assert.match(assertRefused(s.cli([...s.startArgs(), "--" + flag + "=x"]), 2, "usage"), new RegExp(`--${flag}\\b`));
  }
  for (const verb of ["here", "plan"]) {
    const result = s.cli(["accounts", verb, "--local-only", "--json"]);
    assert.equal(result.code, 2, result.err);
  }
  for (const verb of ["help", "--help", "-h", "update", "rollback", "self"]) {
    assertRefused(s.cli([verb, "--local-only", "--json"], { launcher: true }), 2, "usage");
  }
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(s.envCalls(), []);
});

test("a one-holder start writes the plain start row and keeps the local limit warning", (t) => {
  const local = scene(t, { pool: false });
  assertSuccess(local.cli(["holders", "limit", "1", "--json"]));
  const out = assertSuccess(local.localStart());
  assert.match(out.limitWarning, /holder "local" is at its limit \(1\/1\)/);
  assert.deepEqual(local.reservations(), []);

  const plain = scene(t, { pool: false });
  const ordinary = assertSuccess(plain.cli(["start", MEMBER, "--json"]));
  assert.equal(ordinary.limitWarning, undefined);
  const [a] = newRows(local), [b] = newRows(plain);
  assert.equal(a.project, local.project);
  assert.equal(b.project, plain.project);
  assert.deepEqual(comparable(a), comparable(b));
});
