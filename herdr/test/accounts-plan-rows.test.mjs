// Process-only. The CLI uses scratch homes and only reads the fixture's plan and fleet records.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fleetRows } from "../mods/am-quota/fleet.js";
import { emptyPlan, PLAN_FILE, planText } from "../mods/am-sidebar/accountsPlanRecord.js";
import { newest, onAccount, planRowFor, planRows } from "../mods/am-sidebar/accountsPlanRows.js";
import { viewsFrom } from "../mods/am-sidebar/accountsPlan.js";
import { nextObs, rowFor } from "../mods/am-sidebar/accountsRows.js";
import { AM, AT, BOT, PACK, READER, fixtureHere, json, scene } from "./accounts-fixture.mjs";

const A = "ana@example.test", B = "bo@example.test";
const ONE = "core-one", TWO = "core-two", HOME = "/example-home/app";
const SEEN = "2026-11-20T10:01:00.000Z", LATER = "2026-11-20T10:02:00.000Z";
const NOW = Date.parse(LATER);
const ACCOUNT = "1234abcd", GEN = "a".repeat(64), PROXY = "https://proxy.example.test";
const progress = (state, extra = {}) => ({ state, why: null, at: AT, tried: null, attempt: null, read: null, ...extra });

function fleetRead(email = A, { core = ONE, home = HOME, name = "vm-one", at = AT } = {}) {
  const answer = fixtureHere({ email });
  return { ...answer, name, state: "read", reason: null, cli: "pack", at, core, appHome: home,
    codex: nextObs("codex", null, answer.codex, at), claude: nextObs("claude", null, answer.claude, at) };
}

function applyRead(email, at) {
  const { record, snapshot, selected, effective, slots, slotsComplete, nextSlot, state } = fleetRead(email).claude;
  return { at, core: ONE, home: HOME, record, snapshot, selected, effective, email, state, slots, slotsComplete, nextSlot };
}

function claudePlan(state = "pending", extra = {}) {
  const plan = emptyPlan(AT);
  plan.names[ONE] = "vm-one";
  plan.claude.members[ONE] = { home: HOME, since: AT };
  plan.claude.assign[ONE] = A;
  plan.claude.seen[ONE] = { home: HOME, snapshot: "none", email: A };
  plan.claude.progress[ONE] = progress(state, extra);
  return plan;
}

test("planRowFor covers plan states and prefers a newer read-back to fleet failures", () => {
  const ref = { email: B };
  const a = fleetRead(), b = fleetRead(B);
  const row = (entry, plan) => planRowFor("claude", entry, plan, ONE, ref, NOW);
  a.claude.changedAt = AT;
  assert.equal(rowFor("claude", a, ref, NOW).state, "changed");
  assert.deepEqual(row(a, claudePlan()), {
    state: "on", code: null, account: A, wanted: A, here: "same", grant: null, managed: true, actions: [],
  });
  b.claude.slots.push({ id: "two", email: A, state: "eligible" });
  for (const [state, extra, expected, code, actions] of [
    ["pending", {}, "still-on", null, []],
    ["pending", { attempt: { at: SEEN, outcome: null } }, "switching", null, []],
    ["pending", { attempt: { at: SEEN, outcome: "lost" }, why: "lost" }, "still-on", "lost", []],
    ["pending", { why: "no-login" }, "no-login", "no-login", []],
    ["pending", { why: "not-eligible" }, "still-on", "not-eligible", ["move-off"]],
    ["pending", { why: "update-first" }, "unknown", "update-first", []],
    ["suspended", { why: "changed" }, "changed", "changed", ["adopt", "reapply"]],
    ["suspended", { why: "gone" }, "gone", "gone", ["rebind", "forget"]],
  ]) {
    const result = row(b, claudePlan(state, extra));
    assert.deepEqual([result.state, result.code, result.account, result.actions], [expected, code, B, actions]);
  }
  const failed = { ...b, state: "failed", reason: "timeout", at: SEEN };
  assert.equal(row(failed, claudePlan("done", { read: applyRead(A, LATER) })).state, "on");
  assert.equal(row({ ...failed, at: LATER }, claudePlan("done", { read: applyRead(A, SEEN) })).state, "failed");
  const drift = row(b, claudePlan("done", { read: applyRead(B, SEEN) }));
  assert.deepEqual([drift.state, drift.account, drift.actions], ["changed", B, ["adopt", "reapply", "move-off"]]);
  assert.deepEqual(row(a, null), { ...rowFor("claude", a, ref, NOW), wanted: null, managed: false, actions: ["add"] });
  assert.deepEqual(planRowFor("claude", a, null, "local", ref, NOW).actions, ["add"]);
  assert.deepEqual(planRowFor("codex", null, null, "local", {}, NOW).actions, ["place"]);
});

test("onAccount reads the newest Claude email and separates the Codex account from its grant", () => {
  const plan = claudePlan(), b = fleetRead(B, { at: SEEN });
  for (const [read, source, account] of [[applyRead(A, AT), "fleet", B], [applyRead(A, LATER), "apply", A]]) {
    plan.claude.progress[ONE].read = read;
    const chosen = newest(b, plan.claude.progress[ONE], ONE);
    const view = viewsFrom({ machines: { [ONE]: b } }, plan)[0];
    assert.deepEqual([chosen.from, view.claude.email], [source, account]);
    assert.deepEqual(onAccount("claude", ONE, plan, chosen.read), { on: account === A, grant: null });
  }
  assert.equal(onAccount("claude", ONE, plan, { email: A, state: "override" }).on, false);

  const name = "codex-one";
  const current = { home: "/example-home/codex", account: ACCOUNT, generation: GEN, proxy: PROXY,
    active: { name, fingerprint: ACCOUNT } };
  plan.codex.members.local = { home: current.home, since: AT };
  plan.codex.assign.local = name;
  plan.codex.progress.local = progress("done");
  const placed = { name, proxy: PROXY, account: ACCOUNT, generation: GEN, at: AT };
  plan.codex.seen.local = { ...current, placed };
  assert.deepEqual(onAccount("codex", "local", plan, current), { on: true, grant: "placed" });
  for (const obs of [{ ...current, generation: "b".repeat(64) }, { ...current, proxy: "https://other.example.test" }]) {
    assert.deepEqual(onAccount("codex", "local", plan, obs), { on: true, grant: "origin-unknown" });
  }
  plan.codex.seen.local.placed = null;
  assert.deepEqual(onAccount("codex", "local", plan, current), { on: true, grant: "origin-unknown" });
  assert.deepEqual(onAccount("codex", "local", plan, { ...current, active: { ...current.active, name: "other" } }),
    { on: false, grant: "unknown" });
  assert.deepEqual(onAccount("codex", ONE, plan, current), { on: false, grant: "unknown" });
  const ref = { codexLocal: current, active: current.active };
  const row = planRowFor("codex", null, plan, "local", ref, NOW);
  assert.deepEqual([row.state, row.account, row.actions], ["on", name, ["place"]]);
  plan.codex.progress.local = progress("pending");
  assert.equal(planRowFor("codex", null, plan, "local", ref, NOW).state, "still-on");
});

test("a managed account row requires a complete and unambiguous inventory to show on", () => {
  const plan = claudePlan("done");
  const incomplete = fleetRead(A);
  incomplete.claude.slotsComplete = false;
  incomplete.claude.slots.push({ id: "late", email: null, state: "timeout" });
  const ambiguous = fleetRead(A);
  ambiguous.claude.slots.push({ id: "second", email: A, state: "ambiguous" });
  for (const entry of [incomplete, ambiguous]) {
    assert.equal(planRowFor("claude", entry, plan, ONE, {}, NOW).state, "still-on");
    const [row] = fleetRows({ record: { machines: { [ONE]: entry } }, tool: "claude", ref: {}, now: NOW, plan });
    assert.notEqual(row.tone, "good");
  }
});

test("a fresh read of a changed linked app home offers Forget", () => {
  const plan = claudePlan("suspended", { why: "changed", at: SEEN });
  const other = "/example-home/other";
  const actions = (entry) => planRowFor("claude", entry, plan, ONE, {}, NOW).actions;
  assert.deepEqual(actions(fleetRead(B, { home: other, at: LATER })), ["forget"]);
  assert.deepEqual(actions(fleetRead(B, { home: other, at: AT })), ["adopt", "reapply"]);
  assert.deepEqual(actions(fleetRead(B, { home: other, at: LATER, core: TWO })), ["adopt", "reapply"]);
});

test("planRows lists the union in machine order and excludes unbound and other-home reads from the plan observation", () => {
  const plan = claudePlan("suspended", { why: "gone" });
  const local = { ...fleetRead(), name: null };
  const record = { machines: { [TWO]: fleetRead(B, { core: TWO, name: "vm-two" }), local } };
  const rows = planRows({ plan, fleet: record, now: NOW });
  assert.deepEqual(rows.claude.map(({ machine, name, state }) => [machine, name, state]),
    [["local", "local", "observed"], [ONE, "vm-one", "gone"], [TWO, "vm-two", "observed"]]);
  assert.deepEqual(rows.codex.map(({ machine, code }) => [machine, code]), [["local", null], [ONE, "held"], [TWO, "held"]]);
  const managed = claudePlan("done");
  for (const changes of [{ core: null }, { core: TWO }, { home: "/example-home/other" }]) {
    const entry = fleetRead(B, { at: SEEN, ...changes });
    const view = planRowFor("claude", entry, managed, ONE, {}, NOW);
    assert.deepEqual([view.state, view.account], ["still-on", null]);
    if ("core" in changes) {
      const [link] = fleetRows({ record: { machines: { [ONE]: entry } }, tool: "claude", ref: {}, now: NOW, plan: managed });
      assert.ok(link.lines.includes(`signed in as ${B}; this Mac has no Claude login to compare with`));
      const { claude: [shown] } = planRows({ plan: managed, fleet: { machines: { [ONE]: entry } }, now: NOW });
      assert.deepEqual(shown.observation, rowFor("claude", entry, undefined, NOW));
    }
  }
});

test("fleetRows preserves read-only output and bot bindings and draws a missing plan member", () => {
  // This project is an exception. Its binding stays, with its own restart description.
  const entry = fleetRead();
  entry.exceptions.bound = [{ project: "/project", why: "own-path" }];
  const bot = { id: BOT, project: "/project", expect: { core: ONE, terminal: "t1", created_ms: 3 } };
  const record = { at: AT, machines: { [ONE]: entry, local: fleetRead() } };
  const args = { record, tool: "claude", ref: { email: A }, now: NOW, answer: { at: AT, bots: { [ONE]: { claude: [bot] } } } };
  const readOnly = { core: ONE, name: "vm-one", state: "observed", words: `signed in as ${A}, the same account as this Mac`,
    tone: "good", lines: [`A start or restart from here starts ${A}; a tree restart there starts ${A}.`,
      "/project sets its own PATH: not covered by this read"], bots: [bot], restart: `A restart from here starts ${A}` };
  assert.deepEqual(fleetRows(args), [readOnly]);
  assert.deepEqual(fleetRows({ ...args, plan: null }), [readOnly]);
  const plan = claudePlan("done");
  plan.names[TWO] = "vm-two";
  plan.claude.members[TWO] = { home: HOME, since: AT };
  plan.claude.progress[TWO] = progress("suspended", { why: "gone" });
  assert.deepEqual(fleetRows({ ...args, plan }), [
    { ...readOnly, state: "on", words: `on ${A}`, actions: [], restart: null,
      lines: [`A start or restart in a managed project starts ${A}.`, readOnly.lines[1]],
      bots: [{ ...bot, restart: "Restart starts a login this read couldn't confirm" }] },
    { core: TWO, name: "vm-two", state: "gone", words: "gone: unlinked", tone: "warn", lines: [], bots: [], restart: null,
      actions: ["rebind", "forget"] },
  ]);
});

test("plan --show prints plan-aware and observed rows through both CLIs while local is pending", (t) => {
  const s = scene(t, { scratchClaude: true });
  const plan = claudePlan("done", { read: applyRead(A, LATER) });
  plan.claude.members.local = { home: s.app, since: AT };
  plan.claude.assign.local = B;
  plan.claude.seen.local = { home: s.app, snapshot: "none", email: A };
  plan.claude.progress.local = progress("pending");
  writeFileSync(join(s.app, PLAN_FILE), planText(plan), { mode: 0o600 });
  json(s.file, { v: 1, at: SEEN, linked: null, machines: {
    [ONE]: { ...fleetRead(B), state: "failed", reason: "timeout", at: SEEN },
    [TWO]: fleetRead(B, { core: TWO, name: "vm-two" }),
  } });
  const show = (entry, ...args) => {
    const result = s.run(entry, [...args, "plan", "--show"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.json();
  };
  const answer = show(PACK, "accounts");
  assert.deepEqual(show(AM, "accounts"), answer);
  assert.deepEqual(show(READER), answer);
  assert.deepEqual(answer.tools.claude.rows.map((row) => [row.machine, row.state, row.progress?.state ?? null]),
    [["local", "still-on", "pending"], [ONE, "on", "done"], [TWO, "observed", null]]);
  assert.equal(answer.tools.codex.rows.find(({ machine }) => machine === TWO).code, "held");
  assert.deepEqual(s.log(), []);
});

test("accountsPlanRows.js is a byte-equal copy in am-quota", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../mods/am-sidebar/accountsPlanRows.js", import.meta.url));
  const copy = await readFile(new URL("../mods/am-quota/accountsPlanRows.js", import.meta.url));
  assert.deepEqual(copy, source);
});
