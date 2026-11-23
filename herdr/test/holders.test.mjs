import { startFakeCore } from "./fake-core.mjs";
// #1432: the holder pool's CLI, its start distribution, and the holder-loss record. A holder
// is an hc session's core on this computer, exposed as a linked machine by `am holders add
// --local`; starts there use the pack's own linked-machine path. Fake hc and a scratch home
// only: the real hc, the window and any live core are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const MAIN = "b-aaaaaaaaaa", MEMBER = "b-bbbbbbbbbb", WORKER = "b-cccccccccc";
// A burst's bots: `b-` + ten base32 chars, unique and never Main's.
const burstId = (i) => `b-${"a".repeat(9)}${"bcdefghijklmn"[i]}`;
const BURST = Array.from({ length: 13 }, (_, i) => burstId(i));
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

function scene(t, { folder = "proj" } = {}) {
  const root = scratchRoot(t, "hb-holders-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vmBin]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  for (const command of ["herdr-core", "systemctl"]) exe(join(bin, command), "#!/bin/sh\nexit 125\n");
  exe(join(bin, "am"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  for (const a of ["claude", "codex"]) { exe(join(bin, a), "#!/bin/sh\nexit 0\n"); exe(join(vmBin, a), "#!/bin/sh\nexit 0\n"); }
  const look = { character: "star", colour: "blue" };
  const project = scratchProject(root, folder, { bots: { version: 1, categories: [], bots: [
    { id: MAIN, name: "Main", kind: "main", look, role: "lead", instructions: "", agent: "claude" },
    { id: MEMBER, name: "Member", kind: "member", lead: MAIN, look, role: "r", instructions: "", agent: "claude" },
    { id: WORKER, name: "Worker", kind: "member", lead: MAIN, look, role: "r", instructions: "", agent: "claude" },
  ] } });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ next: 100, terminals: [], machines: [],
    core: { id: "core-holder", name: "host" }, machinePath: vmBin }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    GIT_CEILING_DIRECTORIES: root, HC_SESSION: "", HC_SOCKET: "", HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "" };
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, core.env);
  const cli = (args, extraEnv) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  // A start that must be launched beside another one: no sleep, the promises settle on close.
  const cliAsync = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err, json: () => JSON.parse(out) }));
  });
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (fn) => { const s = state(); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  const calls = () => readJsonLines(logPath);
  const rows = () => (existsSync(attachPath(app)) ? readAttach(readFileSync(attachPath(app), "utf8")).rows : []);
  const holdersFile = join(app, "automagik-herdr/holders.json");
  const lossesFile = join(app, "automagik-herdr/holder-loss.log");
  const reservationsFile = join(app, "automagik-herdr/holder-reservations.json");
  const reservations = () => {
    try { return JSON.parse(readFileSync(reservationsFile, "utf8")).reserved ?? []; } catch { return []; }
  };
  const addBots = (ids) => {
    const file = join(project, ".herdr", "bots.json"), def = JSON.parse(readFileSync(file, "utf8"));
    for (const id of ids) {
      if (def.bots.some((b) => b.id === id)) continue;
      def.bots.push({ id, name: `Burst ${id.slice(-1)}`, kind: "member", lead: MAIN, look, role: "r", instructions: "", agent: "claude" });
    }
    writeFileSync(file, JSON.stringify(def));
  };
  const runHint = (line) => spawnSync("/bin/sh", ["-c", line], { cwd: project, env, encoding: "utf8" });
  return { root, project, app, cli, cliAsync, runHint, state, setState, calls, rows, holdersFile, lossesFile, reservationsFile,
    reservations, addBots };
}

test("holders: one local holder and the documented default limit; the limit is configurable", (t) => {
  const s = scene(t);
  const d = s.cli(["holders", "--json"]);
  assert.equal(d.code, 0, d.err);
  assert.equal(d.json().limit, 6);
  assert.deepEqual(d.json().holders.map((h) => [h.name, h.local, h.count]), [["local", true, 0]]);
  assert.match(s.cli(["holders"]).out, /limit 6 agents each/);
  assert.match(s.cli(["holders"]).out, /one holder: a holder loss ends every agent/);

  const set = s.cli(["holders", "limit", "3", "--json"]);
  assert.equal(set.code, 0, set.err);
  assert.equal(set.json().limit, 3);
  assert.equal(statSync(s.holdersFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(s.holdersFile, "utf8")).limit, 3);

  assert.equal(s.cli(["holders", "limit", "0"]).code, 2);
  assert.equal(s.cli(["holders", "limit", "65"]).code, 2);
  assert.match(s.cli(["holders", "limit", "0"]).err, /whole number from 1 to 64/);
});

test("holders add --local makes a second holder; remove refuses while it holds an agent", (t) => {
  const s = scene(t);
  const add = s.cli(["holders", "add", "--local", "h2", "--json"]);
  assert.equal(add.code, 0, add.err);
  assert.equal(add.json().added, "h2");
  assert.equal(add.json().connected, true);
  assert.ok(s.calls().some((c) => c[0] === "machine" && c[1] === "add" && c.includes("h2") && c.some((w) => String(w).includes("am-holder-h2"))),
    "the holder is a local hc session exposed as a machine");
  const two = s.cli(["holders", "--json"]).json();
  assert.deepEqual(two.holders.map((h) => h.name), ["local", "h2"]);
  assert.equal(two.holders[1].session, "am-holder-h2");

  // Give h2 one live agent (its attach row and hc terminal) and try to remove it.
  s.setState((st) => {
    st.terminals.push({ address: "h2/t100", state: "live", created_ms: 5, cwd: s.project, labels: { bot: MEMBER },
      foreground: { argv: ["claude"], cwd: s.project, pid: 1 }, status: { state: "idle" } });
  });
  const row = { v: 1, event: "attach", bot: MEMBER, project: s.project, terminal: "t100", core: "core-h2", created_ms: 5,
    machine: "h2", at: new Date().toISOString(), by: "start" };
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(attachPath(s.app), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const rm = s.cli(["holders", "remove", "h2", "--json"]);
  assert.equal(rm.code, 1);
  assert.match(rm.err, /holds 1 agent \(b-bbbbbbbbbb\); move them off before removing it/);
  const refused = rm.json();
  assert.equal(refused.holder, "h2");
  assert.deepEqual(refused.agents, [MEMBER]);
  assert.match(refused.error, /holds 1 agent \(b-bbbbbbbbbb\)/);
  assert.ok(s.state().machines.some((m) => m.name === "h2"), "the machine stays while it holds an agent");

  // Without the agent, it goes: the machine is removed and the pool is one holder again.
  s.setState((st) => { st.terminals = []; });
  writeFileSync(attachPath(s.app), "", { mode: 0o600 });
  const gone = s.cli(["holders", "remove", "h2", "--json"]);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(gone.json().removed, "h2");
  assert.deepEqual(s.cli(["holders", "--json"]).json().holders.map((h) => h.name), ["local"]);
});

test("remove refuses a holder whose line is down while it still holds an agent", (t) => {
  // #1881: the machine's line dropped, but its core and terminal keep running there; the attach
  // row still names the holder. Live-only counting let remove delete the machine and strand the
  // agent, so the refusal must count the unknown binding too and leave everything in place.
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  assert.equal(s.cli(["start", "Main", "--json"]).code, 0);
  const member = s.cli(["start", "Member", "--json"]);
  assert.equal(member.code, 0, member.err);
  assert.equal(member.json().holder, "h2");
  const address = `${member.json().machine}/${member.json().terminal}`;
  s.setState((st) => {
    const m = st.machines.find((x) => x.name === "h2");
    m.state = "disconnected";
    m.since_ms = Date.parse("2026-11-16T10:00:00.000Z");
  });

  // The holder is away, but the pack's own loss record says it holds the agent.
  const view = s.cli(["holders", "--json"]);
  assert.equal(view.code, 0, view.err);
  const h2 = view.json().holders.find((h) => h.name === "h2");
  assert.equal(h2.connected, false);
  assert.equal(h2.count, 1, "an unknown binding still counts as held");
  assert.ok(existsSync(s.lossesFile));
  assert.ok(readJsonLines(s.lossesFile).some((e) => e.holder === "h2" && e.reason === "holder_unreachable"));

  const removedBefore = s.calls().filter((c) => c[0] === "machine" && c[1] === "rm").length;
  const rm = s.cli(["holders", "remove", "h2", "--json"]);
  assert.equal(rm.code, 1);
  assert.match(rm.err, /holds 1 agent \(b-bbbbbbbbbb\); move them off before removing it/);
  const refused = rm.json();
  assert.equal(refused.holder, "h2");
  assert.deepEqual(refused.agents, [MEMBER]);
  assert.match(refused.error, /holds 1 agent \(b-bbbbbbbbbb\)/);

  // Nothing was removed: the pool, the machine line, the attach row and the pane all stay.
  assert.equal(s.calls().filter((c) => c[0] === "machine" && c[1] === "rm").length, removedBefore, "hc machine rm was not called");
  assert.deepEqual(s.cli(["holders", "--json"]).json().holders.map((h) => h.name), ["local", "h2"]);
  assert.ok(s.state().machines.some((m) => m.name === "h2"), "the machine stays");
  assert.ok(s.rows().some((r) => r.event === "attach" && r.bot === MEMBER && r.machine === "h2"), "the attach row keeps naming h2");
  assert.equal(s.state().terminals.find((x) => x.address === address)?.state, "live", "the h2 pane keeps running");

  // The bot is still found where it plays, unknown rather than stopped.
  const shown = s.cli(["ls", "--json"]).json().projects[0].bots.find((b) => b.id === MEMBER);
  assert.equal(shown.machine, "h2");
  assert.equal(shown.terminal, member.json().terminal);
  assert.equal(shown.status, "unknown");
  assert.match(s.cli(["ls"]).out, new RegExp(`Member.* unknown in h2/${member.json().terminal}`));
  assert.match(s.cli(["whois", "--bot", MEMBER]).out, new RegExp(`plays in h2/${member.json().terminal}`));
});

test("starts spread over the pool, and one holder's loss leaves the other's agent live", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);

  // The first start has both at 0: the pool's order picks local; the second goes to h2.
  const one = s.cli(["start", "Main", "--json"]);
  assert.equal(one.code, 0, one.err);
  assert.equal(one.json().holder, undefined, "a local start keeps its answer as it was");
  const two = s.cli(["start", "Member", "--json"]);
  assert.equal(two.code, 0, two.err);
  assert.equal(two.json().holder, "h2");
  assert.equal(two.json().machine, "h2");
  assert.ok(s.calls().some((c) => c[0] === "run" && c.includes("--on") && c.includes("h2")), "the pane starts on the holder's core");
  const memberAddress = `${two.json().machine}/${two.json().terminal}`;
  const held = s.rows().filter((r) => r.event === "attach");
  assert.deepEqual(held.map((r) => [r.bot, r.machine ?? null]).sort(), [[MAIN, null], [MEMBER, "h2"]]);

  // `--holder` names one; a bot that already has a seat is refused, never started twice (#1881).
  const again = s.cli(["start", "Member", "--json"]);
  assert.equal(again.code, 1, "a bot that already has a seat is refused");
  const already = again.json();
  assert.equal(already.bot, MEMBER);
  assert.equal(already.holder, "h2");
  assert.match(already.error, /already has a seat on holder "h2"/);
  assert.match(again.err, /start refused so one bot never gets two panes/);
  assert.equal(s.rows().filter((r) => r.event === "attach").length, 2, "no second row was written");

  // The team view names the holder and its terminal, so a spread seat doesn't read as stopped.
  const ls = s.cli(["ls", "--json"]).json().projects[0].bots;
  const shown = ls.find((b) => b.id === MEMBER);
  assert.equal(shown.machine, "h2");
  assert.equal(shown.terminal, two.json().terminal);
  assert.match(s.cli(["ls"]).out, new RegExp(`Member.* in h2/${two.json().terminal}`));

  // Lose the local holder: its terminal ends with hc's holder_lost. h2's agent stays live.
  s.setState((st) => {
    const t = st.terminals.find((x) => x.address === "t100");
    t.state = "finished";
    t.reason = "holder_lost";
  });
  const counted = s.cli(["holders", "--json"]);
  assert.equal(counted.code, 0, counted.err);
  assert.deepEqual(counted.json().holders.map((h) => [h.name, h.count]), [["local", 0], ["h2", 1]]);
  assert.ok(s.state().terminals.some((x) => x.address === memberAddress && x.state === "live"), "the other holder's agent is untouched");
  assert.ok(s.lossesFile && existsSync(s.lossesFile), "the loss is recorded where the lead can read it");
  const loss = readJsonLines(s.lossesFile);
  assert.equal(loss.length, 1);
  assert.equal(loss[0].holder, "local");
  assert.deepEqual(loss[0].agents, [MAIN]);
  assert.equal(JSON.stringify(loss[0]).includes(s.project), false, "no project path in the record");
  assert.match(s.cli(["holders", "losses"]).out, /holder lost: 1 agent in holder "local" \(b-aaaaaaaaaa\)/);
});

test("a holder machine whose line is down is recorded as unreachable, once", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  // Main on local first, so Member has one fewer agent on h2 and goes there.
  assert.equal(s.cli(["start", "Main", "--json"]).code, 0);
  assert.equal(s.cli(["start", "Member", "--json"]).code, 0);
  // The machine drops: its binding is unknown, dated by since_ms.
  s.setState((st) => {
    const m = st.machines.find((x) => x.name === "h2");
    m.state = "disconnected";
    m.since_ms = Date.parse("2026-11-16T10:00:00.000Z");
  });
  assert.equal(s.cli(["holders", "--json"]).code, 0);
  const losses = readJsonLines(s.lossesFile).filter((e) => e.reason === "holder_unreachable");
  assert.equal(losses.length, 1);
  assert.equal(losses[0].holder, "h2");
  assert.deepEqual(losses[0].agents, [MEMBER]);
  assert.equal(losses[0].at, "2026-11-16T10:00:00.000Z");
  // A second run doesn't duplicate the same drop.
  assert.equal(s.cli(["holders", "--json"]).code, 0);
  assert.equal(readJsonLines(s.lossesFile).filter((e) => e.reason === "holder_unreachable").length, 1);
});

test("a start over the limit is accepted and says so, in text and --json", (t) => {
  // #1881: README and the PR body say a start past the budget is never refused but "says so".
  // Three bots with two holders at limit 1: the third goes to the least loaded (local, first)
  // and the start reports the over-limit move on stderr and as `limitWarning`.
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  assert.equal(s.cli(["holders", "limit", "1"]).code, 0);
  assert.equal(s.cli(["start", "Main", "--json"]).code, 0);
  const member = s.cli(["start", "Member", "--json"]);
  assert.equal(member.code, 0, member.err);
  assert.equal(member.json().holder, "h2");
  assert.doesNotMatch(member.err, /limit/, "a start under the budget stays quiet");

  const worker = s.cli(["start", "Worker", "--json"]);
  assert.equal(worker.code, 0, worker.err);
  assert.equal(worker.json().holder, undefined, "the least loaded holder takes it: local, first");
  assert.match(worker.json().limitWarning, /holder "local" is at its limit \(1\/1\); Worker starts there anyway/);
  assert.match(worker.err, /am: holder "local" is at its limit \(1\/1\); Worker starts there anyway/);
  assert.match(worker.err, /am holders add --local|am holders limit/);

  const rows = s.cli(["holders", "--json"]).json().holders;
  assert.deepEqual(rows.map((h) => [h.name, h.count, h.overLimit]), [["local", 2, true], ["h2", 1, false]]);
});

// #1881: the start's choice and seat are reserved together under holders.json's lock. Two
// starts launched together must not both read 0/0 and pick local; the peer takes the other
// holder. Three fresh runs, a real Promise.all (no sleep, no shared fixture).
for (let run = 1; run <= 3; run += 1) {
  test(`two starts launched together go to different holders (run ${run}/3)`, async (t) => {
    const s = scene(t);
    assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
    assert.equal(s.cli(["holders", "limit", "1"]).code, 0);
    const [a, b] = await Promise.all([
      s.cliAsync(["start", "Main", "--json"]),
      s.cliAsync(["start", "Member", "--json"]),
    ]);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    const rows = s.rows().filter((r) => r.event === "attach");
    assert.deepEqual(rows.map((r) => r.bot).sort(), [MAIN, MEMBER].sort(), "both starts wrote their row");
    assert.deepEqual(rows.map((r) => r.machine ?? null).sort(), [null, "h2"].sort(), "one on local, the other on h2");
    assert.equal(rows.filter((r) => (r.machine ?? null) === null).length, 1, "not both on local");
    assert.deepEqual(s.reservations(), [], "both reservations are released once the rows are written");
  });
}

// #1881: the same bot never gets two seats. Two `am start Main`s at once, two holders at
// limit 1: the first reserves and starts, the second must refuse under the holder lock. The
// regression checked `liveAt` before the lock and never refused a live reservation, so both
// starts passed and wrote `local` and `h2` rows. Three fresh runs, no sleep.
for (let run = 1; run <= 3; run += 1) {
  test(`two starts of the same bot create one seat, the second refuses (run ${run}/3)`, async (t) => {
    const s = scene(t);
    assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
    assert.equal(s.cli(["holders", "limit", "1"]).code, 0);
    const [a, b] = await Promise.all([
      s.cliAsync(["start", "Main", "--json"]),
      s.cliAsync(["start", "Main", "--json"]),
    ]);
    const won = [a, b].filter((r) => r.code === 0);
    const refused = [a, b].filter((r) => r.code !== 0);
    assert.equal(won.length, 1, `exactly one start won: ${a.code}/${b.code} ${a.err}${b.err}`);
    const rows = s.rows().filter((r) => r.event === "attach");
    assert.equal(rows.length, 1, "one seat, never two rows");
    assert.equal(rows[0].bot, MAIN);
    const no = refused[0];
    const answer = no.json();
    assert.equal(answer.bot, MAIN, "the refusal names the bot");
    assert.equal(answer.holder, rows[0].machine ?? "local", "it names the holder that got the seat");
    assert.match(answer.error, /already has a seat|already starting/);
    assert.match(no.err, /start refused so one bot never gets two panes/);
    assert.deepEqual(s.reservations(), [], "the winner released its reservation");
  });
}

// #1881: a retry with the bot's only binding unknown on a dropped holder must refuse, not add
// a second seat on local. Only `liveAt` was read before, so the retry missed the binding and
// started a fresh pane here.
test("a retry refuses while the bot's binding is unknown on a dropped holder", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  assert.equal(s.cli(["start", "Main", "--json"]).code, 0);
  const member = s.cli(["start", "Member", "--json"]);
  assert.equal(member.code, 0, member.err);
  assert.equal(member.json().holder, "h2");
  const before = s.rows().filter((r) => r.event === "attach").length;
  s.setState((st) => {
    const m = st.machines.find((x) => x.name === "h2");
    m.state = "disconnected";
    m.since_ms = Date.parse("2026-11-16T10:00:00.000Z");
  });
  assert.equal(s.cli(["holders", "--json"]).json().holders.find((h) => h.name === "h2").count, 1,
    "the unknown binding still counts as held");
  const retry = s.cli(["start", "Member", "--json"]);
  assert.equal(retry.code, 1, "the retry is refused, not started on local");
  const answer = retry.json();
  assert.equal(answer.bot, MEMBER);
  assert.equal(answer.holder, "h2");
  assert.match(answer.error, /already has a seat on holder "h2"/);
  assert.match(retry.err, /start refused so one bot never gets two panes/);
  const rows = s.rows().filter((r) => r.event === "attach");
  assert.equal(rows.length, before, "no second row was written");
  assert.equal(rows.some((r) => r.bot === MEMBER && (r.machine ?? null) === null), false, "no local seat");
  assert.deepEqual(s.reservations(), [], "the refused retry reserved nothing");
});

test("a burst of ten starts spreads over two holders and stays within the limit", async (t) => {
  // #1881: a team start in parallel must not pile every seat on local. Ten concurrent starts,
  // two holders, limit 6: the seats split 5/5 (the least-loaded rule), each holder stays at or
  // under the limit, and no start says it is over budget. Then the pool is filled to 6/6 and the
  // next start is still accepted (the budget is soft) but says so, as the README documents.
  const s = scene(t);
  s.addBots(BURST);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  assert.equal(s.cli(["holders", "limit", "6"]).code, 0);
  const results = await Promise.all(BURST.slice(0, 10).map((id) => s.cliAsync(["start", id, "--json"])));
  for (const r of results) {
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().limitWarning, undefined, "no holder is full at ten starts");
  }
  const by = new Map();
  for (const row of s.rows().filter((r) => r.event === "attach")) by.set(row.machine ?? "local", (by.get(row.machine ?? "local") ?? 0) + 1);
  assert.deepEqual([...by.entries()].sort(), [["h2", 5], ["local", 5]], "ten seats spread 5/5, never six on one holder");
  assert.ok(Math.max(...by.values()) <= 6, "no holder over the limit");
  assert.deepEqual(s.reservations(), [], "every reservation is released");

  // Fill the pool: 6/6. The eleventh and twelfth starts are accepted quietly (neither holder is
  // full at 5/6); the thirteenth finds every holder full and says so.
  const eleventh = s.cli(["start", BURST[10], "--json"]);
  assert.equal(eleventh.code, 0, eleventh.err);
  assert.equal(eleventh.json().limitWarning, undefined);
  const twelfth = s.cli(["start", BURST[11], "--json"]);
  assert.equal(twelfth.code, 0, twelfth.err);
  assert.equal(twelfth.json().limitWarning, undefined);
  const rows = s.cli(["holders", "--json"]).json().holders;
  assert.deepEqual(rows.map((h) => [h.name, h.count]), [["local", 6], ["h2", 6]]);

  const thirteenth = s.cli(["start", BURST[12], "--json"]);
  assert.equal(thirteenth.code, 0, thirteenth.err);
  assert.match(thirteenth.json().limitWarning, /holder "local" is at its limit \(6\/6\)/);
  assert.match(thirteenth.err, /at its limit \(6\/6\)/);
  assert.deepEqual(s.cli(["holders", "--json"]).json().holders.map((h) => [h.name, h.count]), [["local", 7], ["h2", 6]]);
});

test("a start that fails releases its holder reservation", (t) => {
  // #1881: a reserved seat must not outlive a failed start (the CLI releases it in `finally`),
  // or one failed start would push every later start off local for the reservation's lifetime.
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  assert.equal(s.cli(["holders", "limit", "1"]).code, 0);
  s.setState((st) => { st.failRun = ["main"]; });
  const failed = s.cli(["start", "Main", "--json"]);
  assert.notEqual(failed.code, 0, "the forced hc run failure fails the start");
  assert.match(failed.err, /can't start main/);
  assert.deepEqual(s.reservations(), [], "the failed start's reservation is released");
  assert.equal(s.rows().filter((r) => r.event === "attach").length, 0, "no attach row was written");

  // With the seat free again, the next start is the first seat: local, not h2.
  const member = s.cli(["start", "Member", "--json"]);
  assert.equal(member.code, 0, member.err);
  assert.equal(member.json().holder, undefined, "the failed start left local free");
});

test("a linked machine that isn't a holder is not recorded as a holder loss", (t) => {
  // #1881: a pack that never runs `am holders` must not gain a holder-loss line when an
  // unrelated linked machine's line drops; only a pool holder's loss is a holder loss.
  const s = scene(t);
  assert.equal(s.cli(["holders", "add", "--local", "h2"]).code, 0);
  s.setState((st) => {
    st.machines = [...(st.machines ?? []), { name: "mac", id: "core-mac", state: "disconnected",
      since_ms: Date.parse("2026-11-16T10:00:00.000Z") }];
  });
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const row = { v: 1, event: "attach", bot: MAIN, project: s.project, terminal: "t7", core: "core-mac", created_ms: 5,
    machine: "mac", at: new Date().toISOString(), by: "start" };
  appendFileSync(attachPath(s.app), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const view = s.cli(["holders", "--json"]);
  assert.equal(view.code, 0, view.err);
  assert.equal(existsSync(s.lossesFile) && readJsonLines(s.lossesFile).some((e) => e.holder === "mac"), false);
  assert.equal(existsSync(s.lossesFile), false, "no holder-loss record was made for a non-holder");
});

test("a corrupt holders.json is said, not silently replaced by one holder", (t) => {
  // #1881: a typo used to turn spreading off in silence. The warning goes to stderr (so --json
  // still parses) and the command keeps the safe one-holder default.
  const s = scene(t);
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(s.holdersFile, "{not json");
  const view = s.cli(["holders", "--json"]);
  assert.equal(view.code, 0, view.err);
  assert.match(view.err, /am: holders: the file isn't JSON/);
  assert.equal(view.json().limit, 6);
  assert.deepEqual(view.json().holders.map((h) => [h.name, h.count]), [["local", 0]]);

  const start = s.cli(["start", "Main", "--json"]);
  assert.equal(start.code, 0, start.err);
  assert.match(start.err, /am: holders: the file isn't JSON/);
  assert.equal(s.rows().filter((r) => r.event === "attach" && r.machine == null).length, 1);
});

const MINUTE = 60_000;
const launchCount = (s) => s.calls().filter((c) => c[0] === "run").length;

function ok(result) {
  assert.equal(result.code, 0, result.err);
  return result;
}

function endInHolderLoss(s, address, changes = () => {}) {
  s.setState((st) => {
    const terminal = st.terminals.find((x) => x.address === address);
    assert.ok(terminal, address);
    Object.assign(terminal, { state: "finished", reason: "holder_lost", finished_ms: Date.now() - MINUTE });
    changes(terminal);
  });
}

function localLoss(t, stamp = "matching") {
  const s = scene(t, { folder: "project with space" });
  const created = Date.now() - 60 * MINUTE;
  ok(s.cli(["holders", "add", "--local", "h2"]));
  s.setState((st) => { st.runCreatedMs = created; });
  ok(s.cli(["start", "Main", "--json"]));
  assert.equal(s.rows().find((r) => r.bot === MAIN).created_ms, created);
  endInHolderLoss(s, "t100", (terminal) => {
    if (stamp === "missing") delete terminal.created_ms;
    if (stamp === "mismatched") terminal.created_ms += 1;
  });
  return { s, created };
}

function pass(s, bootMs, ...flags) {
  return ok(s.cli(["revive", "--json", "--wait", "0", ...flags], {
    AUTOMAGIK_HERDR_BOOT_MS: String(bootMs), AUTOMAGIK_HERDR_REVIVE_SETTLE_MS: "0",
  })).json();
}

function realPass(s, bootMs, { refused = null, launches, boot = true }) {
  const before = launchCount(s);
  const reply = pass(s, bootMs, ...(boot ? ["--boot"] : []));
  assert.equal(reply.ran, true);
  const main = reply.projects.flatMap((p) => p.results).find((r) => r.bot === MAIN);
  assert.ok(main, JSON.stringify(reply));
  assert.equal(main.refused, refused, main.why);
  if (refused) assert.equal(main.outcome, "skipped");
  else assert.ok(["fresh", "resumed"].includes(main.outcome), main.why);
  assert.equal(launchCount(s) - before, launches);
  return reply;
}

function sweepLoss(s) {
  const r = ok(s.cli(["holders", "--json"]));
  const end = s.rows().find((row) => row.bot === MAIN && row.event === "end");
  assert.equal(end?.by, "sweep");
  return r;
}

test("holder loss: ordinary revive refuses an unswept seat, and after sweep has nothing to bring back", (t) => {
  const { s, created } = localLoss(t);
  const bootMs = created + 11 * MINUTE;
  const before = s.rows();
  const target = pass(s, bootMs, "--dry-run").targets.find((x) => x.bot === MAIN);
  assert.equal(target?.action, "skip");
  assert.equal(target.refused, "ordinary_pass");
  assert.match(target.why, /may still be running.*By hand: am restart b-aaaaaaaaaa --project '/);
  const reply = realPass(s, bootMs, { refused: "ordinary_pass", launches: 0, boot: false });
  assert.match(reply.projects[0].report, /Left alone: Main/);
  assert.deepEqual(s.rows(), before);
  sweepLoss(s);
  assert.deepEqual(pass(s, bootMs, "--dry-run").targets, []);
  assert.equal(ok(s.cli(["revive", "--dry-run", "--wait", "0"])).out.trim(), "There is nothing to bring back.");
});

for (const stamp of ["matching", "missing", "mismatched"]) {
  for (const swept of [false, true]) {
    const order = swept ? "after sweep" : "before sweep";
    test(`holder loss: a pre-boot seat with a ${stamp} hc stamp starts once ${order}`, (t) => {
      const { s, created } = localLoss(t, stamp);
      const bootMs = created + 11 * MINUTE;
      const unswept = pass(s, bootMs, "--boot", "--dry-run").targets.find((x) => x.bot === MAIN);
      assert.equal(unswept?.action, "restart");
      assert.equal(s.rows().some((r) => r.event === "end"), false);
      if (swept) {
        if (stamp === "missing") {
          const ordinary = pass(s, bootMs, "--dry-run").targets.find((x) => x.bot === MAIN);
          assert.equal(ordinary?.action, "skip");
          assert.equal(ordinary.refused, "uncertain_identity");
        }
        sweepLoss(s);
        const losses = ok(s.cli(["holders", "losses", "--json"])).json().losses;
        assert.deepEqual(losses.flatMap((e) => e.seats), stamp === "mismatched" ? [] : [{
          bot: MAIN, core: "core-holder", terminal: "t100", created_ms: created, machine: null,
          ...(stamp === "missing" ? { identity: "uncertain" } : {}), now: "not_attached",
        }]);
        if (stamp === "missing") assert.match(ok(s.cli(["holders", "losses"])).out, /hc gave no creation stamp/);
      }
      realPass(s, bootMs, { launches: 1 });
    });

    test(`holder loss: a current-boot seat with a ${stamp} hc stamp starts zero agents ${order}`, (t) => {
      const { s, created } = localLoss(t, stamp);
      const bootMs = created - MINUTE;
      const before = launchCount(s);
      if (swept) {
        sweepLoss(s);
        assert.deepEqual(pass(s, bootMs).projects, []);
      } else {
        realPass(s, bootMs, { refused: stamp === "matching" ? "ordinary_pass" : "uncertain_identity", launches: 0, boot: false });
      }
      realPass(s, bootMs, { refused: swept || stamp === "matching" ? "this_boot" : "uncertain_identity", launches: 0 });
      assert.equal(launchCount(s), before);
    });
  }
}

test("holder loss: plus nine minutes and the exact ten-minute boundary refuse in either sweep order", (t) => {
  for (const swept of [false, true]) {
    const { s, created } = localLoss(t);
    if (swept) sweepLoss(s);
    for (const minutes of [9, 10]) {
      const target = pass(s, created + minutes * MINUTE, "--boot", "--dry-run").targets.find((x) => x.bot === MAIN);
      assert.equal(target?.action, "skip");
      assert.equal(target.refused, "inside_margin");
    }
    realPass(s, created + 10 * MINUTE, { refused: "inside_margin", launches: 0 });
  }
});

test("holder loss: a failed diagnostic append leaves the sweep and boot eligibility intact", (t) => {
  for (const eligible of [false, true]) {
    const { s, created } = localLoss(t, "missing");
    const bootMs = created + (eligible ? 11 : -1) * MINUTE;
    mkdirSync(s.lossesFile);
    assert.match(sweepLoss(s).err, /couldn't record this loss in holder-loss\.log .*am holders losses won't list it/);
    assert.deepEqual(ok(s.cli(["holders", "losses", "--json"])).json().losses, []);
    realPass(s, bootMs, { refused: eligible ? null : "this_boot", launches: eligible ? 1 : 0 });
  }
});

test("holder losses: the local hint runs as printed, omits resume, and reads later ledger changes", (t) => {
  const { s, created } = localLoss(t);
  const finished = s.state().terminals.find((term) => term.address === "t100").finished_ms;
  const swept = sweepLoss(s);
  assert.match(swept.err, /Main \(b-aaaaaaaaaa\) was in local\/t100/);
  assert.match(swept.err, /Its program may still be running/);
  const text = ok(s.cli(["holders", "losses"])).out;
  assert.match(text, /not attached again/);
  assert.match(ok(s.cli(["holders"])).out, /1 lost seat.*not attached again/);
  const json = ok(s.cli(["holders", "losses", "--json"])).out;
  const [event] = JSON.parse(json).losses;
  assert.equal(event.at, new Date(finished).toISOString());
  assert.deepEqual(event.seats, [{ bot: MAIN, core: "core-holder", terminal: "t100", created_ms: created, machine: null, now: "not_attached" }]);
  assert.ok(!json.includes(s.project) && !readFileSync(s.lossesFile, "utf8").includes(s.project));
  const command = text.match(/By hand: (am restart .*?) \(a new conversation\)/)?.[1];
  assert.ok(command?.endsWith(`--project '${s.project}'`), text);
  s.setState((st) => { delete st.runCreatedMs; });
  const before = launchCount(s);
  const restarted = s.runHint(command);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(launchCount(s) - before, 1);
  assert.ok(!s.calls().filter((c) => c[0] === "run").at(-1).includes("--resume"));
  const attached = s.rows().filter((r) => r.event === "attach" && r.bot === MAIN);
  assert.equal(attached.length, 2);
  const readback = ok(s.cli(["holders", "losses"])).out;
  assert.ok(readback.includes(`attached again since (in ${attached[1].terminal})`), readback);
  assert.doesNotMatch(readback, /By hand:/);
  ok(s.cli(["detach", MAIN]));
  assert.match(ok(s.cli(["holders", "losses"])).out, /detached since/);
});

test("holder losses: am start after a sweep is reported as attached again", (t) => {
  const { s } = localLoss(t);
  sweepLoss(s);
  const before = launchCount(s);
  const { terminal } = ok(s.cli(["start", MAIN, "--json"])).json();
  assert.equal(launchCount(s) - before, 1);
  const readback = ok(s.cli(["holders", "losses"])).out;
  assert.ok(readback.includes(`attached again since (in ${terminal})`), readback);
  assert.doesNotMatch(readback, /By hand:/);
  const [loss] = ok(s.cli(["holders", "losses", "--json"])).json().losses;
  assert.equal(loss.seats[0].now, "attached_again");
  ok(s.cli(["detach", MAIN]));
  assert.match(ok(s.cli(["holders", "losses"])).out, /detached since/);
});

function machineLoss(t) {
  const s = scene(t);
  ok(s.cli(["holders", "add", "--local", "h2"]));
  ok(s.cli(["start", "Main", "--json"]));
  const member = ok(s.cli(["start", "Member", "--json"])).json();
  assert.equal(member.machine, "h2");
  const address = `h2/${member.terminal}`;
  endInHolderLoss(s, address);
  return { s, address };
}

test("holder losses: the machine command runs on the linked host with its roster and no resume", (t) => {
  const { s, address } = machineLoss(t);
  ok(s.cli(["holders", "--json"]));
  const text = ok(s.cli(["holders", "losses"])).out;
  assert.ok(text.includes(`was in ${address}`), text);
  const command = text.match(/By hand: (am restart .*?); it runs on h2 with that machine's roster/)?.[1];
  assert.equal(command, `am restart ${MEMBER} --machine h2 --project ${s.project}`);
  const before = launchCount(s);
  const result = s.runHint(command);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(launchCount(s) - before, 1);
  const run = s.calls().filter((c) => c[0] === "run").at(-1);
  assert.equal(run[run.indexOf("--on") + 1], "h2");
  assert.ok(!run.includes("--resume"));
});

test("holder losses: machine hints ignore a different local roster and resolve the current machine by core", (t) => {
  const { s } = machineLoss(t);
  ok(s.cli(["holders", "--json"]));
  const botsPath = join(s.project, ".herdr/bots.json");
  const roster = JSON.parse(readFileSync(botsPath, "utf8"));
  const member = roster.bots.find((bot) => bot.id === MEMBER);
  Object.assign(member, { name: "Local Roster Name", agent: "hermes", hermes: { home: join(s.root, "hermes"), profile: "test" } });
  writeFileSync(botsPath, JSON.stringify(roster));

  s.setState((st) => { st.machines.find((m) => m.name === "h2").name = "h3"; });
  const hint = ok(s.cli(["holders", "losses"])).out;
  assert.match(hint, /--machine h3 --project .*runs on h3 with that machine's roster/);
  assert.doesNotMatch(hint, /Local Roster Name|Hermes|new conversation/);
  s.setState((st) => { st.machines.find((m) => m.name === "h3").state = "disconnected"; });
  assert.match(ok(s.cli(["holders", "losses"])).out, /h3 isn't connected now; the command refuses until it is/);
  s.setState((st) => { st.machines = []; });
  const away = ok(s.cli(["holders", "losses"])).out;
  assert.match(away, /state unknown \(machine h2 isn't linked now\)/);
  assert.doesNotMatch(away, /am restart/);
});

test("holder losses: a machine seat with no folder keeps both flags in a non-runnable hint", (t) => {
  const { s } = machineLoss(t);
  const rows = s.rows().map((r) => r.bot === MEMBER ? { ...r, project: null } : r);
  writeFileSync(attachPath(s.app), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ok(s.cli(["holders", "--json"]));
  const text = ok(s.cli(["holders", "losses"])).out;
  assert.match(text, /am restart b-bbbbbbbbbb --machine h2 --project <its folder on h2>/);
  assert.match(text, /not runnable as printed/);
});

test("holder losses: a local paired Hermes definition has neither a restart command nor a conversation claim", (t) => {
  const { s } = localLoss(t);
  const path = join(s.project, ".herdr/bots.json");
  const roster = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(roster.bots[0], { agent: "hermes", hermes: { home: join(s.root, "hermes"), profile: "test" } });
  writeFileSync(path, JSON.stringify(roster));
  sweepLoss(s);
  const text = ok(s.cli(["holders", "losses"])).out;
  assert.match(text, /doesn't cover a paired Hermes Bot/);
  assert.doesNotMatch(text, /am restart|new conversation/);
});

test("holder losses: the locked holds path records once and legacy records give no seat hint", (t) => {
  const { s } = localLoss(t);
  const checked = ok(s.cli(["detach", MAIN]));
  assert.match(checked.err, /holder lost: 1 agent/);
  assert.equal(s.rows().find((r) => r.event === "end").by, "sweep");
  ok(s.cli(["holders", "--json"]));
  assert.equal(readJsonLines(s.lossesFile).length, 1);
  appendFileSync(s.lossesFile, JSON.stringify({ v: 1, at: "unknown", holder: "legacy", reason: "holder_lost", agents: [MEMBER] }) + "\n");
  const legacy = ok(s.cli(["holders", "losses", "--all"])).out.split('holder "legacy"')[1];
  assert.match(legacy, /which panes is not on record/);
  assert.doesNotMatch(legacy, /am restart/);
});

test("holder losses: a terminal id reused before the sweep doesn't count as the original seat's loss", (t) => {
  const { s, created } = localLoss(t);
  s.setState((st) => {
    Object.assign(st.terminals.find((x) => x.address === "t100"), { reuseAfterGets: 0, reuseCreated: created + 1 });
  });
  sweepLoss(s);
  assert.deepEqual(ok(s.cli(["holders", "losses", "--json"])).json().losses, []);
});
