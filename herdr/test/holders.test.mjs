import { startFakeCore } from "./fake-core.mjs";
// #1432: the holder pool's CLI, its start distribution, and the holder-loss record. A holder
// is an hc session's core on this computer, exposed as a linked machine by `am holders add
// --local`; starts there use the pack's own linked-machine path. Fake hc and a scratch home
// only: the real hc, the window and any live core are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const MAIN = "b-aaaaaaaaaa", MEMBER = "b-bbbbbbbbbb";
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

function scene(t) {
  const root = scratchRoot(t, "hb-holders-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vmBin]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  for (const a of ["claude", "codex"]) { exe(join(bin, a), "#!/bin/sh\nexit 0\n"); exe(join(vmBin, a), "#!/bin/sh\nexit 0\n"); }
  const look = { character: "star", colour: "blue" };
  const project = scratchProject(root, "proj", { bots: { version: 1, categories: [], bots: [
    { id: MAIN, name: "Main", kind: "main", look, role: "lead", instructions: "", agent: "claude" },
    { id: MEMBER, name: "Member", kind: "member", lead: MAIN, look, role: "r", instructions: "", agent: "claude" },
  ] } });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ next: 100, terminals: [], machines: [],
    core: { id: "core-holder", name: "host" }, machinePath: vmBin }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    GIT_CEILING_DIRECTORIES: root, HC_SESSION: "", HC_SOCKET: "", HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "" };
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, core.env);
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (fn) => { const s = state(); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  const calls = () => readJsonLines(logPath);
  const rows = () => (existsSync(attachPath(app)) ? readAttach(readFileSync(attachPath(app), "utf8")).rows : []);
  const holdersFile = join(app, "automagik-herdr/holders.json");
  const lossesFile = join(app, "automagik-herdr/holder-loss.log");
  return { root, project, app, cli, state, setState, calls, rows, holdersFile, lossesFile };
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
  const rm = s.cli(["holders", "remove", "h2"]);
  assert.equal(rm.code, 1);
  assert.match(rm.err, /holds 1 agent/);

  // Without the agent, it goes: the machine is removed and the pool is one holder again.
  s.setState((st) => { st.terminals = []; });
  writeFileSync(attachPath(s.app), "", { mode: 0o600 });
  const gone = s.cli(["holders", "remove", "h2", "--json"]);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(gone.json().removed, "h2");
  assert.deepEqual(s.cli(["holders", "--json"]).json().holders.map((h) => h.name), ["local"]);
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

  // `--holder` names one; the bot already on h2 is reported, not started twice.
  const again = s.cli(["start", "Member", "--json"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json().running, two.json().terminal);
  assert.equal(again.json().holder, "h2");

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
