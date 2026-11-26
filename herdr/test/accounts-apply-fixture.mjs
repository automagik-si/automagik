import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISCOVER, RUN_HERE, RUN_SET, WRITE_SINCE } from "../mods/am-sidebar/accountsFleet.js";
import { emptyPlan, parsePlan, PLAN_FILE, planText } from "../mods/am-sidebar/accountsPlanRecord.js";
import { AT, exe, fakeClaude, json, scene, snapshot } from "./accounts-fixture.mjs";

export const A = "ana@example.test", B = "bo@example.test";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function addMember(plan, core, name, home, before) {
  if (name) plan.names[core] = name;
  plan.claude.members[core] = { home, since: AT };
  plan.claude.assign[core] = B;
  plan.claude.seen[core] = { home, snapshot: before, email: A };
  plan.claude.progress[core] = { state: "pending", why: null, at: AT, tried: null, attempt: null, read: null };
}

export function setupLinked(t) {
  const s = scene(t, { scratchClaude: true });
  const vmOne = s.machine("vm-one", { email: A });
  const vmMixed = s.machine("vm-mixed", { email: A });
  const vmAway = s.machine("vm-away", { state: "disconnected", email: A });
  const vmOld = s.machine("vm-old", { email: A });
  const machines = [vmOne, vmMixed, vmAway, vmOld];
  const plan = emptyPlan(AT);
  plan.rev = 7;
  json(join(s.app, "mods/am-quota/mod.json"), {});
  json(join(vmMixed.app, "mods/am-quota/mod.json"), {});
  json(s.file, { unchanged: true });
  const file = join(s.app, PLAN_FILE);
  const old = vmOld.ship("pack", "1.0.0");
  const oldRan = join(vmOld.home, "old-ran");
  exe(join(old, "bin/run.sh"), `#!/bin/sh\n: > "${oldRan}"\nexit 9\n`);
  // A newer read-only install must not displace the compatible writer.
  const readOnly = vmOne.ship("am", "3.999.0");
  rmSync(join(readOnly, "accountsWrite.js"));
  const newerRan = join(vmOne.home, "newer-ran");
  exe(join(readOnly, "bin/run.sh"), `#!/bin/sh\n: > "${newerRan}"\nexit 9\n`);
  const codex = new Map(), records = new Map();
  for (const vm of machines) {
    if (vm !== vmOld) vm.ship("pack", WRITE_SINCE);
    const dir = join(vm.home, "claude-two");
    mkdirSync(dir);
    exe(join(vm.bin, "claude"), fakeClaude(A).replace(
      /\*\/\.claude-2\) email=[^;]+/, `*/claude-two) email=${B}`));
    const record = { use: "default", logins: [{ id: "slot-two", dir }] };
    const text = JSON.stringify(record, null, 2) + "\n";
    const path = join(vm.app, "claude-logins.json");
    writeFileSync(path, text, { mode: 0o600 });
    records.set(vm.name, { path, record, text });
    codex.set(vm.name, snapshot(vm.codex));
    addMember(plan, vm.id, vm.name, vm.app, sha256(text));
  }
  writeFileSync(file, planText(plan), { mode: 0o600 });
  return { s, plan, file, machines, records, codex, oldRan, newerRan };
}

export function verifyLinked({ s, plan, file, machines, records, codex, oldRan, newerRan }, reply, { positive }) {
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(reply.stderr, "");
  const [one, mixed, away, old] = machines;
  assert.deepEqual(reply.json(), { v: 1, kind: "accounts.apply", rev: plan.rev, stopped: null, linked: null, machines: [
    { core: away.id, name: away.name, state: "pending", why: "away" },
    { core: mixed.id, name: mixed.name, state: "pending", why: positive ? "update-first" : "no-core" },
    { core: old.id, name: old.name, state: "pending", why: "old-cli" },
    { core: one.id, name: one.name, state: positive ? "done" : "pending", why: positive ? null : "no-core" },
  ] });
  assert.equal(existsSync(oldRan), false);
  assert.equal(existsSync(newerRan), false);
  assert.equal(readFileSync(s.file, "utf8"), '{"unchanged":true}');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = parsePlan(readFileSync(file, "utf8"));
  assert.equal(saved.state, "ok");
  assert.equal(saved.plan.rev, plan.rev);
  const calls = s.log();
  assert.deepEqual(calls.map((call) => call[0] === "machine" ? "machines" : [call[5], call[9]]), [
    "machines", [mixed.name, DISCOVER], [mixed.name, RUN_HERE],
    [old.name, DISCOVER], [one.name, DISCOVER], [one.name, RUN_HERE],
    ...(positive ? ["machines", [one.name, RUN_SET], [one.name, RUN_HERE]] : []),
  ]);
  assert.ok(calls.every((call) => call[0] === "machine" || call[0] === "exec"));
  assert.doesNotMatch(JSON.stringify(calls), /example\.test|CANARY-|CODEX_HOME|--add|--remove/);
  for (const vm of machines) {
    const { path, record, text } = records.get(vm.name);
    const switched = positive && vm === one;
    assert.equal(readFileSync(path, "utf8"), switched ? JSON.stringify({ ...record, use: "slot-two" }, null, 2) + "\n" : text);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(snapshot(vm.codex), codex.get(vm.name));
    const progress = saved.plan.claude.progress[vm.id];
    assert.equal(progress.attempt?.outcome ?? null, switched ? "done" : null);
    assert.equal(progress.read?.core ?? null, positive && (vm === one || vm === mixed) ? vm.id : null);
    if (switched) assert.equal(progress.read.email, B);
  }
}
