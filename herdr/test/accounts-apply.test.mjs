// Process-only: a fake hc on PATH and scratch homes with no listening core sockets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { APPLY_BUDGET_MS, applyRun, MACHINE_BUDGET_MS } from "../mods/am-sidebar/accountsApply.js";
import { buildPreview, commitPreview, startAttempt, viewsFrom } from "../mods/am-sidebar/accountsPlan.js";
import { planRowFor } from "../mods/am-sidebar/accountsPlanRows.js";
import { DISCOVER, parseDiscover, RUN_HERE, RUN_SET, WRITE_SINCE } from "../mods/am-sidebar/accountsFleet.js";
import { DRIFT_EVERY_MS, emptyPlan, linkedDue, LOCK_FILE, NO_LOGIN_EVERY_MS, parsePlan, PLAN_FILE, planText, PREVIEWS_DIR,
  REQUESTS_DIR, RETRY_EVERY_MS } from "../mods/am-sidebar/accountsPlanRecord.js";
import { AM, AM_READER, AT, exe, fixtureHere, json, PACK, READER, scene } from "./accounts-fixture.mjs";
import { addMember, A, B, setupLinked, verifyLinked } from "./accounts-apply-fixture.mjs";

const C = "cy@example.test", BEFORE = "a".repeat(64), AFTER = "b".repeat(64), OTHER = "c".repeat(64);
const HOME = "/example-home/app", NOW = Date.parse(AT);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const writer = { setLogin: true, panel: "absent", panelWrites: false, sidebarWrites: false, confirmed: false };
const slot = (id, email, state = "eligible") => ({ id, email, state });
const one = { id: "core-one", name: "vm-one", connected: true };
const two = { id: "core-two", name: "vm-two", connected: true };
const memberList = (...list) => ({ list, complete: true });
const copies = parseDiscover(`pack ${WRITE_SINCE} yes yes /pack\nam 3.999.0 yes yes /am`);
const here = ({ core = one.id, home = HOME, email = A, snapshot = BEFORE, record = "ok",
  selected = "default", slots = [slot("default", A), slot("slot-two", B)], slotsComplete = true,
  capability = writer, state = email ? "eligible" : "not-signed-in" } = {}) => ({
  core, appHome: home, writer: capability,
  claude: { at: AT, record, snapshot, selected, effective: selected, email, state, slots, slotsComplete, nextSlot: null },
});
const onB = (core = one.id) => here({ core, email: B, selected: "slot-two", snapshot: AFTER });
const wrote = { ok: true, use: "slot-two", snapshot: AFTER };
const DISPATCH = "d".repeat(32);

function fixture(...members) {
  let plan = emptyPlan(AT);
  plan.rev = 7;
  let time = NOW;
  let enabled = true;
  const calls = [], writes = [];
  for (const m of members) addMember(plan, m.id, m.name, HOME, BEFORE);
  let list = memberList(...members);
  const io = {
    readPlan: () => parsePlan(JSON.stringify(plan)),
    quotaOn: () => enabled,
    machines: async () => { calls.push("machines"); return list; },
    fleet: () => null,
    discover: async (name) => { calls.push(["discover", name]); return copies; },
    here: async (name, cli) => { calls.push(["here", name, cli.kind]); return here({ core: members.find((m) => m.name === name).id }); },
    setLogin: async (name, cli, words) => { calls.push(["set-login", name, cli.kind, words]); return wrote; },
    write(edit, rev) {
      if (plan.rev !== rev) return null;
      const next = edit(plan);
      if (next !== plan) {
        assert.equal(next.rev, rev);
        assert.equal(parsePlan(planText(next)).state, "ok");
        plan = next;
        writes.push(structuredClone(next));
      }
      return plan;
    },
    clock: () => time, sha256Hex: sha256, dispatchId: () => DISPATCH,
  };
  return { io, calls, writes, run: (retry = false) => applyRun({ io, retry }),
    plan: () => plan, progress: (core = one.id) => plan.claude.progress[core],
    setList: (next) => { list = next; }, setPlan: (next) => { plan = next; },
    advance: (ms) => { time += ms; }, off: () => { enabled = false; } };
}

const state = (p) => [p.state, p.why];
const status = (f, ...expected) => assert.deepEqual(state(f.progress()), expected);
const switchWords = (home = HOME, before = BEFORE) => ["--use", "slot-two", "--snapshot", before, "--expect-home", home,
  "--expect-core", one.id, "--expect-rev", "7", "--attempt", "1", "--dispatch", DISPATCH,
  "--expect-slot", sha256("slot-two\n" + B), "--expect-eff", sha256("default\n" + A)];

test("one machine switches through the selected writer after persisting the attempt and is read back", async () => {
  const f = fixture(one);
  const original = f.io.setLogin;
  f.io.setLogin = (...args) => {
    const { attempt } = f.progress();
    assert.equal(attempt.outcome, null);
    assert.equal(attempt.after, null);
    assert.equal(attempt.rev, f.plan().rev);
    assert.equal(attempt.slot, "slot-two");
    f.io.here = async (name, cli) => {
      assert.equal(f.progress().attempt.after, AFTER);
      f.calls.push(["here", name, cli.kind]);
      return onB();
    };
    return original(...args);
  };
  assert.deepEqual(await f.run(), { v: 1, kind: "accounts.apply", rev: 7, stopped: null, linked: null,
    machines: [{ core: one.id, name: one.name, state: "done", why: null }] });
  assert.deepEqual(f.calls, ["machines", ["discover", one.name], ["here", one.name, "am"], "machines",
    ["set-login", one.name, "am", switchWords()], ["here", one.name, "am"]]);
  assert.deepEqual(f.plan().claude.seen[one.id], { home: HOME, snapshot: AFTER, email: B });
  assert.equal(f.progress().attempt.outcome, "done");
  assert.equal(f.progress().read.email, B);
  assert.doesNotMatch(JSON.stringify(f.calls), /example\.test/);
});

test("a lost answer is read first: landed is done, known unwritten is retried, switch-back and uncertainty suspend", async () => {
  for (const [next, outcome, expected, writes] of [[onB(), "written", ["done", null], 0],
    [here(), "not-written", ["done", null], 1], [here({ snapshot: OTHER }), "indeterminate", ["suspended", "changed"], 0],
    [here(), "written", ["suspended", "changed"], 0], [here(), "indeterminate", ["suspended", "changed"], 0],
    [here(), undefined, ["suspended", "changed"], 0]]) {
    const f = fixture(one);
    f.io.setLogin = async () => outcome === "indeterminate" ? { error: "failed" } : { kind: "unreachable" };
    await f.run();
    status(f, "pending", "lost");
    assert.equal(f.progress().attempt.outcome, null);
    const order = [];
    let answer = next;
    f.io.here = async () => { order.push("here"); return answer; };
    f.io.setLogin = async (_name, _cli, words) => {
      if (words[0] === "--cancel-attempt") {
        order.push("cancel");
        return { ok: true, cancelled: true, outcome, snapshot: outcome === "written" ? AFTER : null };
      }
      order.push("set-login");
      answer = onB();
      return wrote;
    };
    await f.run();
    status(f, ...expected);
    assert.deepEqual(order, writes ? ["here", "cancel", "here", "set-login", "here"] : ["here", "cancel", "here"]);
    assert.equal(f.progress().attempt.n, 1 + writes);
    if (outcome === "written") assert.equal(f.progress().attempt.after, AFTER);
  }
});

test("a disconnected linked attempt blocks a replacement until the target cancels it and is read back", async () => {
  const f = fixture(one);
  f.io.setLogin = async () => ({ kind: "unreachable" });
  await f.run();
  const preview = () => {
    const plan = f.plan();
    const read = f.progress().read;
    const views = [{ id: one.id, name: one.name, appHome: HOME, read: true, readAt: read.at, claude: read }];
    const base = { state: "ok", rev: plan.rev };
    const options = { now: NOW, sha256Hex: sha256 };
    const { preview } = buildPreview({ plan, base, views, request: { v: 1, kind: "pin", tool: "claude",
      machine: one.id, account: A }, ...options });
    return commitPreview(plan, base, preview, { expectRev: plan.rev, ...options });
  };
  assert.deepEqual(preview(), { error: "busy" });
  f.io.setLogin = async (_name, _cli, words) => {
    assert.deepEqual(words, ["--cancel-attempt", "--expect-home", HOME, "--expect-core", one.id,
      "--expect-rev", "7", "--attempt", "1", "--dispatch", DISPATCH]);
    return { kind: "unreachable" };
  };
  await f.run();
  assert.deepEqual(preview(), { error: "busy" });
  // The target acknowledges cancellation, but the replacement still waits for a bound read.
  let reads = 0;
  f.io.here = async () => ++reads === 1 ? here() : { reason: "timeout" };
  f.io.setLogin = async () => ({ ok: true, cancelled: true, outcome: "not-written", snapshot: null });
  await f.run();
  assert.deepEqual(preview(), { error: "busy" });
  // A complete read without the wanted login closes the attempt without starting another.
  f.io.here = async () => here({ slots: [slot("default", A)] });
  await f.run();
  assert.equal(f.progress().attempt.outcome, "lost");
  assert.equal(preview().plan.claude.assign[one.id], A);
});

test("a changed revision after dispatch records lost even when the target confirms its write", async () => {
  const f = fixture(one);
  f.io.setLogin = async () => {
    f.plan().rev++;
    f.io.here = () => assert.fail("read back a superseded in-flight write");
    return wrote;
  };
  assert.equal((await f.run()).stopped, "rev");
  status(f, "pending", "lost");
  assert.equal(f.progress().attempt.outcome, null);
  assert.equal(f.progress().attempt.after, AFTER);
});

test("Q10 suspends changed snapshots and changed effective accounts with or without an open attempt", async () => {
  for (const changed of [here({ snapshot: OTHER }), here({ email: C, slots: [slot("default", C), slot("slot-two", B)] })]) {
    for (const attempted of [false, true]) {
      const f = fixture(one);
      if (attempted) {
        f.io.setLogin = async () => ({ kind: "timeout" });
        await f.run();
        assert.equal(f.progress().attempt.outcome, null);
      }
      let reads = 0;
      f.io.here = async () => { reads += 1; return changed; };
      f.io.setLogin = (_name, _cli, words) => {
        assert.equal(words[0], "--cancel-attempt", "overwrote a changed login");
        return { ok: true, cancelled: true };
      };
      await f.run();
      status(f, "suspended", "changed");
      if (attempted) assert.equal(f.progress().attempt.outcome, "changed");
      f.advance(DRIFT_EVERY_MS);
      await f.run(true);
      assert.equal(reads, attempted ? 2 : 1);
    }
  }
});

test("an empty inventory, a different slot or duplicate effective IDs cannot confirm the wanted Claude account", async () => {
  for (const broken of [here({ email: B, selected: "slot-two", slots: [] }), here({ email: B, selected: "default" }),
    here({ email: B, selected: "default", slots: [slot("default", A), slot("default", B)] })]) {
    const f = fixture(one);
    f.io.here = async () => broken;
    f.io.setLogin = () => assert.fail("wrote from a contradictory inventory");
    await f.run();
    status(f, "pending", "bad-answer");
    const read = f.progress().read;
    assert.notEqual(planRowFor("claude", null, f.plan(), one.id, null, NOW).state, "on");
    assert.equal(read.email, B);
    const g = fixture(one);
    g.io.setLogin = async () => { g.io.here = async () => ({ ...broken, claude: { ...broken.claude, snapshot: AFTER } }); return wrote; };
    await g.run();
    status(g, "pending", "bad-answer");
    assert.equal(g.progress().attempt.after, AFTER);
  }
});

test("no-login waits an hour and requires the approved snapshot when the login appears", async () => {
  for (const snapshot of [BEFORE, OTHER]) {
    const f = fixture(one);
    let answer = here({ slots: [slot("default", A)] });
    let sets = 0, reads = 0;
    f.io.here = async () => { reads += 1; return answer; };
    f.io.setLogin = async () => { sets += 1; answer = onB(); return wrote; };
    await f.run();
    status(f, "pending", "no-login");
    f.advance(NO_LOGIN_EVERY_MS - 1);
    await f.run(true);
    assert.equal(reads, 1);
    answer = here({ snapshot });
    f.advance(1);
    await f.run(true);
    status(f, ...(snapshot === BEFORE ? ["done", null] : ["suspended", "changed"]));
    assert.equal(sets, Number(snapshot === BEFORE));
  }
});

test("an incomplete inventory cannot authorize a write; a complete ineligible slot is not-eligible", async () => {
  for (const [extra, slotsComplete, why] of [[slot("slot-three", null, "timeout"), false, "timeout"],
    [slot("slot-three", null, "failed"), false, "failed"], [null, false, "failed"],
    [slot("slot-two", B, "override"), true, "not-eligible"],
    [slot("slot-three", B), true, "not-eligible"]]) {
    const f = fixture(one);
    const slots = [slot("default", A)];
    if (extra?.id !== "slot-two") slots.push(slot("slot-two", B));
    if (extra) slots.push(extra);
    f.io.here = async () => here({ slots, slotsComplete });
    f.io.setLogin = () => assert.fail("wrote without a complete unambiguous inventory");
    await f.run();
    status(f, "pending", why);
  }
});

test("a wanted Claude login with an incomplete inventory cannot complete apply or read-back", async () => {
  const incomplete = here({ email: B, selected: "slot-two", snapshot: AFTER, slotsComplete: false,
    slots: [slot("default", null, "timeout"), slot("slot-two", B)] });
  const f = fixture(one);
  f.io.here = async () => ({ ...incomplete, claude: { ...incomplete.claude, snapshot: BEFORE } });
  f.io.setLogin = () => assert.fail("wrote with an incomplete inventory");
  await f.run();
  status(f, "pending", "timeout");
  const g = fixture(one);
  let reads = 0;
  g.io.here = async () => ++reads === 1 ? here() : incomplete;
  await g.run();
  status(g, "pending", "timeout");
  assert.equal(g.progress().attempt.outcome, null);
  g.io.here = async () => onB();
  await g.run();
  status(g, "done", null);
});

test("an absent Claude record uses snapshot none; a bad record cannot confirm or authorize a write", async () => {
  const f = fixture(one);
  const seen = f.plan().claude.seen[one.id];
  seen.snapshot = "none";
  seen.email = null;
  f.io.here = async () => here({ snapshot: null, record: "absent", email: null });
  f.io.setLogin = async (name, cli, words) => {
    assert.equal(words[3], "none");
    f.io.here = async () => onB();
    return wrote;
  };
  await f.run();
  status(f, "done", null);
  const bad = fixture(one);
  bad.io.here = async () => here({ record: "bad", email: B, slotsComplete: false });
  bad.io.setLogin = () => assert.fail("wrote a bad record");
  await bad.run();
  status(bad, "pending", "bad-answer");
  const row = planRowFor("claude", null, bad.plan(), one.id, {}, NOW);
  assert.deepEqual([row.state, row.code], ["still-on", "bad-answer"]);
});

test("the implicit default is confirmed without a write when it already matches", async () => {
  const f = fixture(one);
  f.plan().claude.seen[one.id].snapshot = "none";
  f.io.here = async () => here({ snapshot: null, record: "absent", email: B, slots: [slot("default", B)] });
  f.io.setLogin = () => assert.fail("rewrote an already active default");
  await f.run();
  status(f, "done", null);
  assert.equal(f.plan().claude.seen[one.id].snapshot, "none");
});

test("every actionable read binds the core and home; a different target refuses set-login", async () => {
  for (const [answer, expected] of [[onB(two.id), ["pending", "rebound"]],
    [here({ core: null, email: B }), ["pending", "no-core"]],
    [here({ home: "/other/app", email: B }), ["suspended", "changed"]]]) {
    const f = fixture(one);
    f.io.here = async () => answer;
    f.io.setLogin = () => assert.fail("wrote after an unbound read");
    await f.run();
    status(f, ...expected);
    assert.equal(f.progress().read, null);
  }
  const f = fixture(one);
  f.io.setLogin = async (name, cli, words) => {
    assert.deepEqual(words, switchWords());
    return { error: "wrong-core" };
  };
  await f.run();
  status(f, "pending", "rebound");
  assert.equal(f.progress().attempt.outcome, "lost");
  assert.equal(f.progress().read.core, one.id);
  assert.equal(f.progress().read.home, HOME);
});

test("a changed linked home needs Forget and fresh enrollment before apply may write it", async () => {
  const f = fixture(one);
  const other = HOME + "-other";
  const changed = here({ home: other });
  f.io.here = async () => changed;
  f.io.setLogin = () => assert.fail("used the old approval in the new app home");
  await f.run();
  await f.run();
  status(f, "suspended", "changed");
  const views = [{ id: one.id, name: one.name, read: true, readAt: AT, appHome: other, claude: changed.claude }];
  const request = (plan, kind, extra = {}) => {
    const base = { state: "ok", rev: plan.rev };
    const options = { now: NOW, sha256Hex: sha256 };
    const { preview } = buildPreview({ plan, base, views, request: { v: 1, kind, machine: one.id, ...extra }, ...options });
    return { preview, commit: () => commitPreview(plan, base, preview, { expectRev: plan.rev, ...options }).plan };
  };
  assert.deepEqual(request(f.plan(), "reapply", { tool: "claude" }).preview.patch.entries, []);
  const forgotten = request(f.plan(), "forget").commit();
  assert.equal(forgotten.claude.members[one.id], undefined);
  const rejoined = request(forgotten, "add", { tool: "claude", account: B }).commit();
  assert.equal(rejoined.claude.members[one.id].home, other);
  assert.equal(rejoined.claude.seen[one.id].home, other);
  assert.equal(rejoined.claude.assign[one.id], B);
});

test("read-back on another home or core and a bad record are lost; the next run reads again", async () => {
  for (const back of [here({ home: "/other/app", email: B }), onB(two.id),
    here({ record: "bad", email: B }), { reason: "timeout" }]) {
    const f = fixture(one);
    f.io.setLogin = async () => {
      f.io.here = async () => back;
      return wrote;
    };
    await f.run();
    status(f, "pending", "lost");
    assert.equal(f.progress().read.email, A);
    assert.equal(f.progress().attempt.after, AFTER);
    f.io.here = async () => onB();
    f.io.setLogin = () => assert.fail("retried before confirming read-back");
    await f.run();
    status(f, "done", null);
  }
});

test("a saved after snapshot with a different confirmed Claude account suspends after a lost read-back", async () => {
  const changed = here({ snapshot: AFTER, email: C, selected: "slot-two", slots: [slot("default", A), slot("slot-two", C)] });
  for (const lost of [true, false]) {
    const f = fixture(one);
    f.io.setLogin = async () => { f.io.here = async () => lost ? { reason: "unreachable" } : changed; return wrote; };
    await f.run();
    assert.equal(f.progress().attempt.after, AFTER);
    if (lost) {
      status(f, "pending", "lost");
      f.io.here = async () => changed;
      f.io.setLogin = () => assert.fail("a known write must not be repeated or cancelled");
      f.advance(RETRY_EVERY_MS);
      await f.run(true);
    }
    status(f, "suspended", "changed");
    assert.equal(f.progress().attempt.outcome, "changed");
    assert.equal(f.progress().read.email, C);
  }
});

test("slot digest refusals suspend on identity change and close target timeouts as lost", async () => {
  for (const [why, expected, outcome] of [["slot-changed", ["suspended", "changed"], "changed"],
    ["timeout", ["pending", "timeout"], "lost"], ["no-core", ["pending", "no-core"], "lost"]]) {
    const f = fixture(one);
    f.io.setLogin = async (name, cli, words) => {
      assert.deepEqual(words, switchWords());
      return { error: why };
    };
    await f.run();
    status(f, ...expected);
    assert.equal(f.progress().attempt.outcome, outcome);
  }
});

test("incomplete membership changes nothing up front and blocks a write after a read", async () => {
  const incomplete = { list: [one], complete: false };
  for (const listing of [null, incomplete]) {
    const f = fixture(one, two);
    f.setList(listing);
    assert.deepEqual((await f.run()).linked, { reason: "failed" });
    assert.deepEqual(f.calls, ["machines"]);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture(one);
  f.io.here = async () => { f.setList(incomplete); return here(); };
  f.io.setLogin = () => assert.fail("wrote with incomplete membership");
  await f.run();
  status(f, "pending", "failed");
  assert.equal(f.progress().attempt, null);
});

test("done survives observation failures and hourly drift finds a different account even without fleet.json", async () => {
  for (const retry of [false, true]) {
    const f = fixture(one);
    f.io.here = async () => onB();
    f.io.setLogin = () => assert.fail("a done member was written");
    await f.run(retry);
    status(f, "done", null);
    const confirmed = f.progress().read;
    const discover = f.io.discover;
    for (const failure of ["away", "unreachable", "no-cli", "rebound"]) {
      f.advance(DRIFT_EVERY_MS);
      f.setList(memberList({ ...one, connected: failure !== "away" }));
      f.io.discover = failure === "no-cli" ? async () => [] : discover;
      f.io.here = async () => failure === "rebound" ? here({ core: two.id }) : { reason: "unreachable" };
      await f.run(retry);
      status(f, "done", null);
      assert.deepEqual(f.progress().read, confirmed);
      assert.equal(f.progress().tried, new Date(f.io.clock()).toISOString());
    }
    f.advance(DRIFT_EVERY_MS);
    f.io.here = async () => here();
    await f.run(retry);
    status(f, "suspended", "changed");
  }
});

test("a newer fleet observation schedules a bound drift read without proving drift itself", async () => {
  const f = fixture(one);
  f.io.here = async () => onB();
  await f.run();
  f.advance(RETRY_EVERY_MS);
  f.io.fleet = () => ({ machines: { [one.id]: { state: "read", core: one.id,
    claude: { email: A, readAt: new Date(f.io.clock()).toISOString() } } } });
  f.io.here = async () => ({ reason: "unreachable" });
  await f.run(true);
  status(f, "done", null);
  assert.equal(f.progress().tried, new Date(f.io.clock()).toISOString());
});

test("a conflict keeps the other edit and suspends on the next read", async () => {
  const f = fixture(one);
  f.io.setLogin = async () => {
    f.io.here = async () => here({ snapshot: OTHER });
    return { error: "conflict" };
  };
  await f.run();
  status(f, "pending", "conflict");
  assert.equal(f.progress().attempt.outcome, "failed");
  f.io.setLogin = () => assert.fail("overwrote the concurrent edit");
  await f.run();
  status(f, "suspended", "changed");
});

test("rev or switch-off after the attempt retires it without sending the write", async () => {
  for (const stop of ["rev", "off"]) {
    const f = fixture(one);
    const write = f.io.write;
    f.io.write = (...args) => {
      const saved = write(...args);
      if (saved?.claude.progress[one.id].attempt?.outcome === null) {
        if (stop === "off") f.off();
        else saved.rev += 1;
      }
      return saved;
    };
    f.io.setLogin = () => assert.fail("sent an attempt after the stop");
    assert.equal((await f.run()).stopped, stop);
    assert.equal(f.progress().attempt.outcome, "lost");
    assert.equal(f.plan().rev, stop === "rev" ? 8 : 7);
  }
});

test("a rev change between machines stops the run and switch-off before the write starts no attempt", async () => {
  const f = fixture(two, one);
  f.io.here = async () => {
    f.plan().rev += 1;
    return onB();
  };
  f.io.setLogin = () => assert.fail("wrote under a stale revision");
  assert.equal((await f.run()).stopped, "rev");
  assert.equal(f.progress(two.id).tried, null);
  const off = fixture(one);
  off.io.here = async () => { off.off(); return here(); };
  off.io.setLogin = () => assert.fail("wrote after switch-off");
  assert.equal((await off.run()).stopped, "off");
  assert.equal(off.progress().attempt, null);
});

test("gone suspends only linked Claude members even when they have no due assignment", async () => {
  const f = fixture(one, two);
  addMember(f.plan(), "local", null, HOME, BEFORE);
  f.plan().codex = { ...f.plan().codex, members: { local: { since: AT, home: HOME } } };
  delete f.plan().claude.assign[two.id];
  delete f.plan().claude.progress[two.id];
  f.plan().claude.progress[one.id].state = "done";
  const local = structuredClone([f.plan().claude.progress.local, f.plan().codex]);
  f.setList(memberList());
  assert.deepEqual((await f.run()).machines.map(({ core, state, why }) => [core, state, why]), [
    [one.id, "suspended", "gone"], [two.id, "suspended", "gone"],
  ]);
  assert.deepEqual([f.plan().claude.progress.local, f.plan().codex], local);
  assert.deepEqual(f.calls, ["machines"]);
});

test("an uncached name rebound before the write starts no attempt", async () => {
  const f = fixture(one);
  f.io.here = async () => { f.setList(memberList({ ...one, id: two.id })); return here(); };
  f.io.setLogin = () => assert.fail("sent set-login to a rebound name");
  await f.run();
  status(f, "pending", "rebound");
  assert.equal(f.progress().attempt, null);
});

test("mixed installs require a qualified writer and recheck it on the target", async () => {
  const on = { ...writer, panel: "on", panelWrites: true, sidebarWrites: true, confirmed: true };
  for (const capability of [null, { ...on, panelWrites: false }, { ...on, sidebarWrites: false },
    { ...on, confirmed: false }, { ...writer, panel: "unknown" }]) {
    const f = fixture(one);
    f.io.here = async () => here({ capability });
    f.io.setLogin = () => assert.fail("wrote through an unqualified panel");
    await f.run();
    status(f, "pending", "update-first");
  }
  for (const capability of [on, { ...writer, panel: "off" }, writer]) {
    const f = fixture(one);
    f.io.here = async () => here({ capability });
    f.io.setLogin = async () => { f.io.here = async () => onB(); return wrote; };
    await f.run();
    status(f, "done", null);
  }
  const f = fixture(one);
  f.io.setLogin = async () => ({ error: "update-first" });
  await f.run();
  status(f, "pending", "update-first");
});

test("partial success lists linked progress in machine order", async () => {
  const away = { id: "core-away", name: "vm-away", connected: false };
  const old = { id: "core-old", name: "vm-old", connected: true };
  const f = fixture(two, one, old, away);
  f.io.discover = async (name) => name === old.name ? copies.map((cli) => ({ ...cli, write: false })) : copies;
  f.io.here = async (name) => name === two.name ? here({ core: two.id, slots: [slot("default", A)] }) : onB();
  f.io.setLogin = () => assert.fail("no pending machine could be written");
  assert.deepEqual((await f.run()).machines.map(({ core, state, why }) => [core, state, why]), [
    [away.id, "pending", "away"], [old.id, "pending", "old-cli"], [one.id, "done", null], [two.id, "pending", "no-login"],
  ]);
});

test("linked Codex makes the plan newer and local Claude and Codex are never handled", async () => {
  const f = fixture(one);
  f.plan().codex.machines.push(one.id);
  assert.deepEqual(await f.run(), { error: "newer-plan" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
  f.plan().codex.machines = [];
  addMember(f.plan(), "local", null, HOME, BEFORE);
  const local = structuredClone(f.plan().claude.progress.local);
  f.io.here = async () => onB();
  assert.equal((await f.run()).machines.length, 1);
  assert.deepEqual(f.plan().claude.progress.local, local);
});

test("the machine budget prevents a late write and the run budget prevents another machine starting", async () => {
  const first = fixture(two, one);
  const discover = first.io.discover;
  first.io.discover = async (name, until) => {
    if (name === one.name) {
      assert.equal(until, NOW + MACHINE_BUDGET_MS);
      first.advance(MACHINE_BUDGET_MS);
    }
    return discover(name);
  };
  first.io.here = async (name) => {
    assert.equal(name, two.name);
    return onB(two.id);
  };
  await first.run();
  status(first, "pending", "timeout");
  assert.equal(first.progress(two.id).state, "done");

  const f = fixture(two, one);
  f.io.discover = async (name, until) => {
    assert.equal(until, NOW + MACHINE_BUDGET_MS);
    f.advance(APPLY_BUDGET_MS);
    return copies;
  };
  f.io.here = () => assert.fail("read after the budget");
  await f.run();
  status(f, "pending", "timeout");
  assert.equal(f.progress(two.id).tried, null);
});

test("CLI without a core changes no target and only asks for membership, discovery and here", (t) => {
  const fixture = setupLinked(t);
  const response = fixture.s.run(PACK, ["accounts", "apply", "--json"]);
  verifyLinked(fixture, response, { positive: false });
});

test("CLI routes set-login through the writer, which refuses an unconfirmed core", (t) => {
  const { s, file, machines, records, plan } = setupLinked(t);
  const [vm] = machines;
  const { path, text, record } = records.get(vm.name);
  const answer = fixtureHere({ email: A });
  Object.assign(answer, { appHome: vm.app, core: vm.id, writer });
  Object.assign(answer.claude, { record: "ok", snapshot: sha256(text),
    slots: [...answer.claude.slots, { ...slot("slot-two", B), dir: record.logins[0].dir }] });
  const wire = JSON.stringify({ code: 0, stdout: Buffer.from(JSON.stringify(answer)).toString("base64") });
  s.hcWrapper(`if [ "$1" = exec ] && [ "$6" = vm-one ]; then
  case "${'\$'}{10}" in *'here --started'*) printf '%s\\n' '${wire}'; exit 0 ;; esac
fi`);
  const response = s.run(READER, ["apply"]);
  assert.equal(response.code, 0);
  assert.equal(response.stderr, "");
  assert.equal(response.json().machines.find(({ core }) => core === vm.id).why, "no-core");
  const set = s.log().find((call) => call.includes(RUN_SET));
  assert.ok(set);
  const state = parsePlan(readFileSync(file, "utf8")).plan.claude.progress[vm.id].attempt;
  assert.match(state.dispatch, /^[a-f0-9]{32}$/);
  assert.deepEqual(set.slice(13), switchWords(vm.app, plan.claude.seen[vm.id].snapshot)
    .map((word, i, words) => words[i - 1] === "--expect-rev" ? String(plan.rev)
      : word === one.id ? vm.id : word === DISPATCH ? state.dispatch : word));
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(state.outcome, "lost");
});

test("CLI Unpin keeps the newer read for a One preview and Apply reaches done", (t) => {
  const s = scene(t, { scratchClaude: true });
  const vm = s.machine("vm-one", { email: A });
  vm.ship("pack", WRITE_SINCE);
  json(join(s.app, "mods/am-quota/mod.json"), {});
  const answer = (email, selected, snapshot) => {
    const reply = fixtureHere({ email });
    Object.assign(reply, { appHome: vm.app, core: vm.id, writer, codex: null });
    const slots = [slot("default", A), slot("slot-two", B), slot("slot-three", C)];
    Object.assign(reply.claude, { record: "ok", snapshot, selected, effective: selected,
      slots: slots.map((login) => ({ ...login, dir: null })) });
    return reply;
  };
  const current = answer(A, "default", BEFORE);
  const older = answer(B, "slot-two", OTHER);
  json(s.file, { v: 1, at: AT, linked: null, machines: { [vm.id]: {
    ...older, name: vm.name, at: AT, state: "read", reason: null, cli: "pack", write: true,
    claude: { ...older.claude, readAt: AT, prevEmail: null, changedAt: null },
  } } });

  const file = join(s.app, PLAN_FILE);
  const saved = () => parsePlan(readFileSync(file, "utf8")).plan;
  const plan = emptyPlan(AT);
  plan.rev = 7;
  addMember(plan, vm.id, vm.name, vm.app, BEFORE);
  plan.claude.assign[vm.id] = plan.claude.pin[vm.id] = A;
  const readAt = new Date(NOW + 1000).toISOString();
  Object.assign(plan.claude.progress[vm.id], { state: "done", at: readAt,
    read: { ...current.claude, at: readAt, core: vm.id, home: vm.app } });
  writeFileSync(file, planText(plan), { mode: 0o600 });

  const wire = (value) => JSON.stringify({ code: 0, stdout: Buffer.from(JSON.stringify(value)).toString("base64") });
  const written = join(s.root, "written");
  s.hcWrapper(`if [ "$1" = exec ] && [ "$6" = vm-one ]; then
  case "\${10}" in
    *'here --started'*)
      if [ -f '${written}' ]; then printf '%s\\n' '${wire(answer(C, "slot-three", AFTER))}'
      else printf '%s\\n' '${wire(current)}'; fi
      exit 0 ;;
  esac
  case " $* " in
    *' --use slot-three --snapshot ${BEFORE} '*)
      [ ! -f '${written}' ] || exit 1
      : > '${written}'
      printf '%s\\n' '${wire({ ok: true, use: "slot-three", snapshot: AFTER })}'; exit 0 ;;
  esac
fi`);
  const run = (...args) => {
    const result = s.run(READER, args);
    assert.equal(result.code, 0, result.stderr);
    return result.json();
  };
  const preview = (id, request) => {
    json(join(s.app, REQUESTS_DIR, `${id}.json`), { v: 1, tool: "claude", ...request });
    return run("plan", "--request", id);
  };
  const commit = ({ id, rev }) => run("plan", "--commit", id, "--expect-rev", String(rev));
  commit(preview("a".repeat(32), { kind: "unpin", machine: vm.id }));
  assert.equal(saved().claude.assign[vm.id], undefined);
  const next = preview("b".repeat(32), { kind: "mode", mode: "one", account: C });
  assert.equal(next.changes[0].observed, A);
  commit(next);
  assert.deepEqual(saved().claude.seen[vm.id], { home: vm.app, snapshot: BEFORE, email: A });

  assert.deepEqual(run("apply").machines, [{ core: vm.id, name: vm.name, state: "done", why: null }]);
  assert.equal(existsSync(written), true);
  assert.equal(saved().claude.progress[vm.id].read.email, C);
});

test("a concurrent CLI apply holds accounts.lock and the second one is busy", async (t) => {
  const { s, file } = setupLinked(t);
  const signal = join(s.root, "listing");
  const release = join(s.root, "release");
  const lock = join(s.app, LOCK_FILE);
  const before = readFileSync(file);
  s.hcWrapper(`if [ "$1" = machine ]; then : > "${signal}"; while [ ! -f "${release}" ]; do sleep 0.02; done; fi`);
  const first = s.start(READER, ["apply"]);
  try {
    for (let i = 0; i < 250 && !existsSync(signal); i += 1) await delay(20);
    assert.ok(existsSync(signal));
    assert.ok(existsSync(lock));
    const second = s.run(AM_READER, ["apply"]);
    assert.equal(second.code, 1);
    assert.deepEqual(second.json(), { error: "busy" });
    assert.equal(second.stderr, "am: accounts apply: busy\n");
    assert.deepEqual(readFileSync(file), before);
  } finally {
    writeFileSync(release, "");
    assert.equal((await first).code, 0);
  }
  assert.equal(existsSync(lock), false);
});

test("CLI retries skip recent attempts and refuse an absent, corrupt, newer or switched-off plan", (t) => {
  const { s, file, plan } = setupLinked(t);
  const tried = new Date().toISOString();
  for (const progress of Object.values(plan.claude.progress)) progress.tried = tried;
  writeFileSync(file, planText(plan), { mode: 0o600 });
  const before = readFileSync(file);
  const retry = s.run(AM, ["--json", "accounts", "apply", "--retry"]);
  assert.equal(retry.code, 0);
  assert.deepEqual(s.log(), [["machine", "ls", "--json"]]);
  assert.deepEqual(readFileSync(file), before);
  const refused = (reason) => {
    const result = s.run(READER, ["apply"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.json(), { error: reason });
    assert.equal(result.stderr, `am: accounts apply: ${reason}\n`);
    assert.equal(s.log().length, 1);
  };
  rmSync(file);
  refused("no-plan");
  assert.equal(existsSync(file), false);
  writeFileSync(file, "broken");
  refused("no-plan");
  assert.equal(readFileSync(file, "utf8"), "broken");
  const future = JSON.stringify({ ...plan, v: 2 });
  writeFileSync(file, future);
  refused("newer-plan");
  assert.equal(readFileSync(file, "utf8"), future);
  writeFileSync(file, before);
  rmSync(join(s.app, "mods/am-quota"), { recursive: true });
  refused("off");
  assert.deepEqual(readFileSync(file), before);

  for (const args of [["apply", "vm-one"], ["apply", "--retry", "--retry"], ["apply", "--use", "slot-two"]]) {
    const result = s.run(READER, args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "am: accounts apply: usage\n");
  }
});

test("transport and CLI error canaries do not escape to output or records", (t) => {
  const { s, file, machines } = setupLinked(t);
  const [vm] = machines;
  const am = vm.ship("am", "3.999.0");
  exe(join(am, "bin/run.sh"), '#!/bin/sh\nprintf "CANARY-STDERR-0043\\n" >&2\nprintf "CANARY-RPC-0043\\n"\n');
  s.hcWrapper(`if [ "$1" = exec ] && [ "$6" = vm-mixed ]; then
  printf '{"error":"CANARY-RPC-0043"}\\n'
  printf 'CANARY-STDERR-0043\\n' >&2
  exit 1
fi`);
  const paths = [join(s.app, PREVIEWS_DIR, "example.json"), join(s.app, REQUESTS_DIR, "example.json"), s.file];
  for (const path of paths) { mkdirSync(dirname(path), { recursive: true }); json(path, { unchanged: true }); }
  const response = s.run(READER, ["apply"]);
  assert.equal(response.code, 0);
  assert.equal(response.stderr, "");
  assert.deepEqual(response.json().machines.map(({ why }) => why), ["away", "unreachable", "old-cli", "bad-answer"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch([response.stdout, response.stderr, ...[file, ...paths].map((path) => readFileSync(path, "utf8")),
    JSON.stringify(s.log())].join("\n"), /CANARY-(?:STDERR|RPC|STATUS|REFRESH)-0043/);
  for (const path of paths) assert.equal(readFileSync(path, "utf8"), '{"unchanged":true}');
  assert.ok(s.log().some((call) => call.includes(DISCOVER)));
  assert.ok(s.log().some((call) => call.includes(RUN_HERE)));
});

test("a confirmed Claude switch followed by a machine-side revert suspends through the next retry", async () => {
  const f = fixture(one);
  let writes = 0;
  f.io.setLogin = async () => { writes++; return wrote; };
  await f.run();
  status(f, "suspended", "changed");
  assert.equal(f.progress().attempt.after, AFTER);
  assert.equal(f.progress().read.snapshot, BEFORE);
  f.advance(DRIFT_EVERY_MS * 2);
  await f.run(true);
  status(f, "suspended", "changed");
  assert.equal(writes, 1);
});

test("Forget and Rebind are busy for a gone core until its open Claude dispatch has a known after", async () => {
  for (const known of [false, true]) {
    const f = fixture(one);
    f.io.setLogin = async () => { f.io.here = async () => ({ reason: "unreachable" }); return known ? wrote : null; };
    await f.run();
    f.setList(memberList(two));
    await f.run();
    status(f, "suspended", "gone");
    assert.equal(f.progress().attempt.after, known ? AFTER : null);
    assert.equal(f.progress().attempt.outcome, null);
    const plan = f.plan(), base = { state: "ok", rev: plan.rev };
    plan.claude.pin[one.id] = B;
    const views = [{ id: two.id, name: two.name, appHome: HOME, read: true, readAt: AT, qualified: true, claude: here().claude }];
    for (const request of [{ kind: "forget", machine: one.id }, { kind: "rebind", from: one.id, to: two.id }]) {
      const options = { now: NOW, sha256Hex: sha256 };
      const { preview } = buildPreview({ plan, base, views, request: { v: 1, ...request }, ...options });
      const result = commitPreview(plan, base, preview, { expectRev: plan.rev, ...options });
      if (!known) {
        assert.deepEqual(result, { error: "busy" });
        assert.equal(plan.claude.progress[one.id].attempt.dispatch, DISPATCH);
        continue;
      }
      assert.ok(result.plan, result.error);
      assert.equal(result.plan.claude.members[one.id], undefined);
      if (request.kind === "rebind") {
        assert.equal(result.plan.claude.pin[two.id], B);
        assert.equal(result.plan.claude.progress[two.id].attempt, null);
        assert.equal(result.plan.claude.seen[two.id].snapshot, BEFORE);
      }
    }
  }
});

test("a lost Claude dispatch is fenced only when the unlinked core returns, then Forget succeeds", async () => {
  const f = fixture(one);
  const commands = [];
  f.io.setLogin = async (_name, _cli, words) => {
    commands.push(words);
    return words[0] === "--cancel-attempt" ? { ok: true, cancelled: true, outcome: "not-written", snapshot: null } : null;
  };
  await f.run();
  status(f, "pending", "lost");
  assert.equal(f.progress().attempt.after, null);
  f.setList(memberList());
  await f.run();
  status(f, "suspended", "gone");
  assert.deepEqual(commands, [switchWords()]);

  const request = { v: 1, kind: "forget", machine: one.id };
  const forget = () => {
    const plan = f.plan(), base = { state: "ok", rev: plan.rev };
    const options = { now: f.io.clock(), sha256Hex: sha256 };
    const { preview } = buildPreview({ plan, base, views: [], request, ...options });
    return commitPreview(plan, base, preview, { expectRev: plan.rev, ...options });
  };
  const actions = () => planRowFor("claude", null, f.plan(), one.id, null, f.io.clock()).actions;
  assert.deepEqual(forget(), { error: "busy" });
  assert.deepEqual(actions(), ["forget"]);
  f.setList(memberList({ ...two, name: one.name }));
  await f.run();
  f.setList({ list: [one], complete: false });
  await f.run();
  assert.equal(commands.length, 1);
  f.setList(memberList(one));
  assert.deepEqual(linkedDue(f.plan(), { now: NOW, retry: true, members: [one] }), []);
  f.advance(RETRY_EVERY_MS);
  assert.deepEqual(linkedDue(f.plan(), { now: f.io.clock(), retry: true, members: [one] }),
    [{ tool: "claude", machine: one.id }]);
  await f.run(true);
  assert.deepEqual(commands, [switchWords(), ["--cancel-attempt", "--expect-home", HOME,
    "--expect-core", one.id, "--expect-rev", "7", "--attempt", "1", "--dispatch", DISPATCH]]);
  status(f, "suspended", "gone");
  assert.equal(f.progress().attempt.outcome, "lost");
  assert.deepEqual(actions(), ["rebind", "forget"]);
  await f.run();
  assert.equal(commands.length, 2);
  const result = forget();
  assert.ok(result.plan, result.error);
  assert.equal(result.plan.claude.members[one.id], undefined);
});

test("confirmed Forget retires a permanently absent Claude core and its name's replacement needs its own press", async () => {
  const f = fixture(one);
  const commands = [];
  f.io.setLogin = async (_name, _cli, words) => { commands.push(words); return null; };
  await f.run();
  const sentAt = f.progress().attempt.at;
  const replacement = { ...two, name: one.name };
  f.setList(memberList(replacement));
  await f.run();
  status(f, "suspended", "gone");
  const target = here({ core: replacement.id });
  const views = [{ id: replacement.id, name: replacement.name, read: true, qualified: true, readAt: AT,
    appHome: target.appHome, claude: target.claude }];
  const change = (request, confirmForget) => {
    const plan = f.plan(), base = { state: "ok", rev: plan.rev };
    const options = { now: f.io.clock(), sha256Hex: sha256 };
    const { preview } = buildPreview({ plan, base, views, request: { v: 1, ...request }, ...options });
    return commitPreview(plan, base, preview, { expectRev: base.rev, confirmForget, ...options });
  };
  assert.deepEqual(change({ kind: "rebind", from: one.id, to: replacement.id }), { error: "busy" });
  assert.deepEqual(change({ kind: "forget", machine: one.id }), { error: "busy" });
  const forgotten = change({ kind: "forget", machine: one.id }, true);
  assert.ok(forgotten.plan, forgotten.error);
  f.setPlan(forgotten.plan);
  assert.deepEqual(f.plan().exposures, { [one.id]: sentAt });
  assert.deepEqual(f.plan().claude.members, {});
  assert.deepEqual(f.plan().claude.progress, {});
  assert.deepEqual(f.plan().names, {});
  f.advance(RETRY_EVERY_MS);
  await f.run(true);
  assert.deepEqual(commands, [switchWords()]);

  const joined = change({ kind: "add", tool: "claude", machine: replacement.id });
  assert.ok(joined.plan, joined.error);
  f.setPlan(joined.plan);
  assert.deepEqual(Object.keys(f.plan().claude.members), [replacement.id]);
  assert.equal(f.plan().claude.assign[replacement.id], A);
  assert.deepEqual(f.plan().exposures, { [one.id]: sentAt });
  const dismissed = change({ kind: "dismiss-exposure", machine: one.id });
  assert.ok(dismissed.plan, dismissed.error);
  assert.equal(dismissed.plan.exposures, undefined);
  assert.deepEqual(dismissed.plan.claude, f.plan().claude);
});

test("one A is busy between a Pinned Unpin commit and its delayed cancellation receipt", async () => {
  const f = fixture(one);
  f.plan().claude.pin[one.id] = B;
  const commands = [];
  f.io.setLogin = async (_name, _cli, words) => {
    commands.push(words[0]);
    return null;
  };
  await f.run();
  const core = one.id;
  const view = { id: core, name: one.name, appHome: HOME, read: true, readAt: AT, qualified: true, claude: here().claude };
  const change = (request) => {
    const plan = f.plan(), base = { state: "ok", rev: plan.rev };
    const options = { now: NOW, sha256Hex: sha256 };
    const { preview } = buildPreview({ plan, base, views: [view], request: { v: 1, tool: "claude", ...request }, ...options });
    return { preview, result: commitPreview(plan, base, preview, { expectRev: plan.rev, ...options }) };
  };
  const unpin = change({ kind: "unpin", machine: core }).result;
  assert.ok(unpin.plan, unpin.error);
  f.setPlan(unpin.plan);
  assert.equal(f.progress().cancel, true);
  const oneA = { kind: "mode", mode: "one", account: A };
  const { preview, result } = change(oneA);
  assert.deepEqual(preview.patch.entries, [], "the retained pin bypasses the per-entry guard");
  assert.deepEqual(result, { error: "busy" });

  f.io.setLogin = async (_name, _cli, words) => {
    commands.push(words[0]);
    return { ok: true, cancelled: true, outcome: "not-written", snapshot: null };
  };
  await f.run();
  assert.deepEqual(commands, ["--use", "--cancel-attempt"]);
  assert.equal(f.plan().claude.mode, "pinned");
  assert.equal(f.plan().claude.assign[core], undefined);
  const committed = change(oneA).result;
  assert.ok(committed.plan, committed.error);
  assert.equal(committed.plan.claude.assign[core], A);
});

test("Unpin commits offline and only an enabled Apply fences the lost dispatch before clearing the assignment", (t) => {
  const { s, file, machines, records } = setupLinked(t);
  const [vm] = machines;
  const { path, text, record } = records.get(vm.name);
  let plan = emptyPlan(AT);
  plan.rev = 7;
  addMember(plan, vm.id, vm.name, vm.app, sha256(text));
  plan.claude.pin[vm.id] = B;
  plan = startAttempt(plan, "claude", vm.id, { rev: 7, slot: "slot-two", slotDigest: sha256("slot-two\n" + B),
    before: sha256(text), eff: A, effDigest: sha256("default\n" + A), home: vm.app, core: vm.id, dispatch: DISPATCH, now: NOW });
  writeFileSync(file, planText(plan));
  const receipt = JSON.stringify({ ok: true, cancelled: true, outcome: "indeterminate", snapshot: null });
  const wire = JSON.stringify({ code: 0, stdout: Buffer.from(receipt).toString("base64") });
  const answer = fixtureHere({ email: A });
  Object.assign(answer, { appHome: vm.app, core: vm.id, writer });
  Object.assign(answer.claude, { record: "ok", snapshot: sha256(text),
    slots: [...answer.claude.slots, { ...slot("slot-two", B), dir: record.logins[0].dir }] });
  const readWire = JSON.stringify({ code: 0, stdout: Buffer.from(JSON.stringify(answer)).toString("base64") });
  const cancelled = join(s.root, "cancelled");
  const allow = join(s.root, "allow-cancel");
  s.hcWrapper(`if [ "$1" = exec ] && [ "$6" = vm-one ]; then
  case "\${10}" in *'here --started'*) printf '%s\\n' '${readWire}'; exit 0 ;; esac
  case " $* " in *' --cancel-attempt '*) [ -f '${allow}' ] || exit 1; printf '%s\\n' "$*" >> '${cancelled}'; printf '%s\\n' '${wire}'; exit 0 ;; esac
fi`);
  const id = "b".repeat(32);
  json(join(s.app, REQUESTS_DIR, `${id}.json`), { v: 1, kind: "unpin", tool: "claude", machine: vm.id });
  const preview = s.run(READER, ["plan", "--request", id]);
  assert.equal(preview.code, 0, preview.stderr);
  const enabled = join(s.app, "mods/am-quota"), disabled = join(s.app, "quota-off");
  renameSync(enabled, disabled);
  const committed = s.run(READER, ["plan", "--commit", preview.json().id, "--expect-rev", "7"]);
  assert.equal(committed.code, 0, committed.stderr);
  const savedPlan = () => parsePlan(readFileSync(file, "utf8")).plan.claude;
  const protectedAttempt = () => {
    const saved = savedPlan();
    assert.equal(saved.assign[vm.id], B);
    assert.equal(saved.pin[vm.id], B);
    assert.equal(saved.progress[vm.id].cancel, true);
    assert.equal(saved.progress[vm.id].attempt.dispatch, DISPATCH);
  };
  assert.equal(s.run(READER, ["apply"]).json().error, "off");
  assert.deepEqual(s.log(), []);
  assert.equal(existsSync(cancelled), false);
  protectedAttempt();
  renameSync(disabled, enabled);
  assert.equal(s.run(READER, ["apply"]).code, 0);
  protectedAttempt();
  writeFileSync(allow, "");
  assert.equal(s.run(READER, ["apply"]).code, 0);
  const saved = savedPlan();
  assert.ok(saved.members[vm.id]);
  assert.equal(saved.assign[vm.id], undefined);
  assert.equal(saved.pin[vm.id], undefined);
  assert.equal(saved.progress[vm.id], undefined);
  const calls = readFileSync(cancelled, "utf8").trim().split("\n");
  assert.equal(calls.filter((call) => call.includes("--cancel-attempt") && call.includes(DISPATCH)).length, 1);
  assert.equal(s.log().some((call) => call.includes(RUN_SET)), false, "only the intercepted cancellation may reach the target");
  assert.equal(readFileSync(path, "utf8"), text);
});

test("an unresolved first Claude route leaves the next machine free to switch", async () => {
  const f = fixture(one, two);
  const writes = [];
  f.io.here = async (name) => name === one.name ? here({ email: null, state: "unresolved" })
    : writes.length ? onB(two.id) : here({ core: two.id });
  f.io.setLogin = async (name) => { writes.push(name); return wrote; };
  await f.run();
  status(f, "pending", "update-first");
  assert.equal(f.progress().read.state, "unresolved");
  assert.deepEqual(state(f.progress(two.id)), ["done", null]);
  assert.deepEqual(writes, [two.name]);
});

test("the hourly drift read can drive Adopt and Re-apply without fleet.json", async () => {
  const f = fixture(one);
  f.plan().claude.progress[one.id].state = "done";
  f.io.here = async () => here();
  f.io.setLogin = () => assert.fail("wrote during drift detection");
  const clock = f.io.clock;
  f.io.clock = () => { f.advance(1); return clock(); };
  await f.run(true);
  status(f, "suspended", "changed");
  assert.equal(f.progress().at, f.progress().read.at);
  const plan = f.plan();
  const views = viewsFrom(null, plan);
  for (const kind of ["adopt", "reapply"]) {
    const { preview } = buildPreview({ plan, base: { state: "ok", rev: plan.rev }, views,
      request: { v: 1, kind, tool: "claude", machine: one.id }, now: clock(), id: "a".repeat(32), sha256Hex: sha256 });
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.flags.some(({ code }) => code === "read-again"), false);
  }
});
