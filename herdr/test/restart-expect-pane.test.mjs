import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AM, BOT, PACK, json, scene } from "./accounts-fixture.mjs";

const command = (s, args, program = PACK) => s.run(program, ["restart", ...args, "--json"]);
const pin = ({ core, terminal, created_ms }) => `${core}/${terminal}/${created_ms}`;
const noAction = (s) => assert.ok(s.log().every((a) => !["run", "kill", "label", "send", "keys"].includes(a[0])));
const refusal = (r, name, machine, terminal) => {
  const message = `${name}'s pane couldn't be confirmed as the one shown (${machine}/${terminal}); nothing was restarted.`;
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json(), { error: message, refused: "binding" });
  assert.equal(r.stderr, `am: ${message}\n`);
};

test("--expect-pane needs --machine and a plain restart, checked before other modes; malformed values exit 2", (t) => {
  const s = scene(t);
  const bound = ["--expect-pane", "core/t8/8"];
  for (const args of [[...bound], ...[["--tree"], ["--queued"], ["--cancel"], ["--due"], ["--run-queued", "token"]]
    .map((flags) => ["--machine", "vm-other", ...bound, ...flags])]) {
    assert.equal(command(s, [BOT, ...args]).code, 2);
  }
  for (const value of ["", "core/t8", "/t8/1", "c /t8/1", "core/t 8/1", "core/t8/-1", "core/t8/9007199254740992", "core/t8/00000000000000001"]) {
    assert.equal(command(s, [BOT, "--machine", "vm-other", "--expect-pane", value], AM).code, 2, value);
  }
  assert.deepEqual(s.log(), []);
});

test("another terminal, created_ms, bot or project in the ledger is refused before any hc call", (t) => {
  const s = scene(t), machine = s.machine("vm-other");
  const { attach, project } = s.botProject(machine);
  for (const changed of [{ terminal: "t9" }, { created_ms: 9 }, { bot: "b-bbbbbbbbbb" }, { project: join(machine.home, "elsewhere") }]) {
    s.ledger({ ...attach, ...changed });
    const result = command(s, [BOT, "--machine", machine.name, "--project", project, "--expect-pane", pin(attach)]);
    refusal(result, BOT, machine.name, "t8");
  }
  assert.deepEqual(s.log(), []);
});

test("identity failures inside linkedObservation become the fixed binding refusal", async (t) => {
  for (const change of ["core", "created_ms", "label", "project", "get"]) await t.test(change, (t) => {
    const s = scene(t), machine = s.machine("vm-other");
    const { attach, project } = s.botProject(machine);
    s.ledger(attach);
    if (change === "project") {
      const { project: elsewhere } = s.botProject({ ...machine, home: join(machine.home, "other") }, { terminal: "t9" });
      s.setState((state) => { state.terminals[0].cwd = elsewhere; state.terminals.pop(); });
    } else {
      s.setState((state) => {
        if (change === "core") state.machines[0].id = "core-another";
        if (change === "created_ms") state.terminals[0].created_ms += 1;
        if (change === "label") state.terminals[0].labels.bot = "b-bbbbbbbbbb";
        if (change === "get") state.failGet = [state.terminals[0].address];
      });
    }
    const r = command(s, [BOT, "--machine", machine.name, "--project", project, "--expect-pane", pin(attach)]);
    refusal(r, "Bot A", machine.name, "t8");
    noAction(s);
  });
});

test("--expect-pane on a bot whose pane is gone is refused, never started", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  const { attach, project } = s.botProject(m);
  s.ledger(attach);
  s.setState((state) => { state.terminals = []; });
  refusal(command(s, [BOT, "--machine", m.name, "--project", project, "--expect-pane", pin(attach)]), "Bot A", m.name, "t8");
  noAction(s);
});

test("without --expect-pane the existing linked and local restart refusals read as before", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  const { project } = s.botProject(m);
  const r = command(s, [BOT, "--machine", m.name, "--project", project]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `am: Bot A already runs in ${m.name}/t8, without a confirmed caller attachment. Inspect it, then use am attach ${BOT} ${m.name}/t8 --machine ${m.name} --project ${project} before restarting.\n`);
  const local = join(s.home, "local");
  json(join(local, ".herdr/bots.json"), { version: 1, categories: [], bots: [] });
  assert.equal(command(s, [BOT, "--project", local]).stderr, `am: No bot "${BOT}" in this project.\n`);
  noAction(s);
});
