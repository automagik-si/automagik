import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetRows, frozen, members, readFleetAnswer, restartArgs, restartWords, sameList } from "../mods/am-quota/fleet.js";
import { FLEET_V, nextObs, parseFleet } from "../mods/am-quota/accountsRows.js";
import { emptyPlan } from "../mods/am-quota/accountsPlanRecord.js";
import { readHere } from "../mods/am-sidebar/accountsFleet.js";
import { AT, BOT, fixtureHere, fpr } from "./accounts-fixture.mjs";

const core = "core-vm-other", name = "vm-other", now = Date.parse(AT) + 1000;
const row = (tool, change = () => {}, ref = {}, refName = null, bots = null, answerAt = AT) => {
  const { codex, claude, exceptions } = fixtureHere();
  const entry = { name, state: "read", exceptions, codex: nextObs("codex", null, codex, AT), claude: nextObs("claude", null, claude, AT) };
  change(entry);
  return fleetRows({ record: { at: AT, machines: { [core]: entry } }, tool, ref, refName, answer: { at: answerAt, bots: { [core]: bots } }, now })[0];
};

test("words for every state and comparison, with fixed codes", () => {
  const same = fpr("account-a");
  for (const [fingerprint, sentence, tone] of [
    [same, `the same account as this Mac (account ${same}), grant origin unknown`, "good"],
    [fpr("account-b"), `another account than this Mac's (account ${same}), grant origin unknown`, "warn"],
    [null, `signed in (account ${same}); this Mac has no Codex login to compare with`, "none"],
  ]) {
    const r = row("codex", undefined, { fingerprint });
    assert.deepEqual([r.words, r.tone], [sentence, tone]);
  }
  const changed = row("codex", (r) => { r.codex.changedAt = AT; }, { fingerprint: same });
  assert.equal(changed.words, `changed on the machine: now account ${same}`);
  assert.deepEqual(changed.lines, ["The same account as this Mac."]);
  assert.equal(row("codex", (r) => { r.codex.file = "absent"; }).words, "no Codex sign-in there");
  assert.equal(row("claude", undefined, { email: "ana@example.com" }).words, "signed in as ana@example.com, the same account as this Mac");
  assert.equal(row("claude").words, "signed in as ana@example.com; this Mac has no Claude login to compare with");
  assert.equal(row("claude", undefined, { email: "bo@example.com" }).words, "no login of bo@example.com here");
  const other = row("claude", (r) => r.claude.slots.push({ id: "2", email: "bo@example.com", state: "override" }), { email: "bo@example.com" });
  assert.equal(other.words, "signed in as ana@example.com; this Mac uses bo@example.com");
  assert.equal(row("claude", (r) => { r.claude.changedAt = AT; }).words, "changed on the machine: now ana@example.com");
  const away = row("codex", (r) => { r.state = "away"; });
  assert.equal(away.words, "away (not connected)");
  assert.match(away.lines[0], /^Last read .+: signed in/);
  const codes = { "no-cli": "no am or sidebar there", "old-cli": "its am or sidebar is older than this read needs: update it there",
    unreachable: "hc couldn't reach it", timeout: "it didn't answer in 20 s", "bad-answer": "its answer couldn't be read", failed: "the read failed" };
  for (const [code, line] of Object.entries(codes)) {
    const r = row("codex", (r) => { r.state = code === "no-cli" || code === "old-cli" ? "unknown" : "failed"; r.reason = code; });
    assert.equal(r.words, `${r.state}: ${code}`);
    assert.equal(r.lines[0], line);
    assert.match(r.lines[1], /^Last read /);
  }
  assert.equal(row("codex", (r) => { r.state = null; }).words, "unknown: not-read");
  for (const [field, value, code] of [["file", "unreadable", "unreadable"], ["accountId", "absent", "no-account-id"]]) {
    assert.equal(row("codex", (r) => { r.codex[field] = value; }).words, `unknown: ${code}`);
  }
});

test("Codex is named by the matched local fingerprint, and other accounts stay distinct", () => {
  const fingerprint = fpr("account-a");
  const named = row("codex", undefined, { fingerprint }, { email: "ana@example.com", plan: "pro" });
  assert.match(named.words, /\(ana@example\.com · Pro\)/);
  for (const id of ["account-b", "account-c"]) {
    const other = row("codex", (r) => { r.codex.account = fpr(id); }, { fingerprint }, "ana@example.com");
    assert.equal(other.words, `another account than this Mac's (account ${fpr(id)}), grant origin unknown`);
  }
});

test("a machine whose Claude starts with its own launcher compares nothing", () => {
  const change = (r) => {
    r.claude.email = null;
    r.claude.state = "unresolved";
    r.claude.routes.record = { email: null, state: "unresolved" };
  };
  const ref = { email: "ana@example.com" };
  const direct = row("claude", change, ref);
  const answer = fixtureHere();
  change(answer);
  const entry = { ...answer, name, at: AT, state: "read", reason: null, cli: "pack",
    codex: nextObs("codex", null, answer.codex, AT), claude: nextObs("claude", null, answer.claude, AT) };
  const record = parseFleet(JSON.stringify({ v: FLEET_V, at: AT, machines: { [core]: entry } }));
  assert.equal(record.machines[core].claude.state, "unresolved");
  const [stored] = fleetRows({ record, tool: "claude", ref, now });
  for (const r of [direct, stored]) {
    assert.equal(r.words, "unknown: own-launcher");
    assert.equal(r.tone, "none");
    assert.equal(r.lines[0], "Claude starts there with its own command, which this read doesn't run");
    assert.ok(r.lines.every((line) => !/the same account|this Mac uses/.test(line)));
  }
  answer.claude.slots[0].state = "unresolved";
  assert.deepEqual(readHere(JSON.stringify(answer)), { reason: "bad-answer" });
});

const bot = { id: BOT, name: "Bot A", project: "/p", expect: { core, terminal: "t8", created_ms: 8 }, on: "login unknown" };
const looked = { claude: [bot], codex: [bot], codexReliable: false, ownHome: 1, unbound: 2, more: 3 };

test("slots, both routes, bound exceptions first, bots and counts have fixed words", () => {
  const changes = (r) => {
    r.claude.slots.push({ id: "2", email: null, state: "bad-folder" });
    r.claude.routes.bare = { email: "bo@example.com", state: "eligible" };
    r.claude.routesDiffer = true;
    r.exceptions = { bound: [{ project: "/z", why: "own-app-home" }], list: [{ project: "/a", why: "own-path" }], more: 4 };
  };
  assert.deepEqual(row("claude", changes, {}, null, looked).lines, [
    "login 2 · that login's folder isn't in the form launches use",
    "A start or restart from here starts bo@example.com; a tree restart there starts ana@example.com. They differ.",
    "/z uses its own app home: not managed", "/a sets its own PATH: not covered by this read", "+4 more",
    "1 bot there use their project's own app home: not checked", "2 bots there have no binding here, so they are not listed",
    "+3 more bindings there, not checked",
  ]);
  const one = row("claude", (r) => { r.claude.routes.bare = { email: null, state: "unresolved" }; });
  assert.match(one.lines[0], /this Mac starts Claude with its own command.*tree restart there starts ana@example.com/);
  assert.match(one.restart, /^A restart from here starts /);
  const failed = row("claude", (r) => { r.claude.routes.record = { email: "ana@example.com", state: "failed" }; });
  assert.deepEqual(failed.lines, ["A start or restart from here starts ana@example.com; a tree restart there starts the read failed."]);
  const skipped = row("claude", (r) => { r.claude.routes.record = { email: null, state: "unresolved" }; });
  assert.deepEqual(skipped.lines, [
    "A start or restart from here starts ana@example.com; a tree restart there starts its own Claude launcher, which this read doesn't run.",
  ]);
  assert.equal(row("codex", undefined, {}, null, looked).lines.at(-1), "Which login each Codex bot there started with can't be told: all are listed.");
  assert.deepEqual(row("codex", undefined, {}, null, { reason: "failed" }).lines, ["Its bots couldn't be read."]);
  const answer = { v: 1, at: AT, linked: null, machines: [{ core, bots: { ...looked, raw: "CANARY-STDERR-0043" } }] };
  assert.deepEqual(readFleetAnswer(JSON.stringify(answer)), { at: AT, linked: null, bots: { [core]: looked } });
  assert.equal(readFleetAnswer(JSON.stringify({ ...answer, v: 2 })), null);
});

test("readFleetAnswer keeps a session bot's binding beside an ordinary bot", () => {
  const session = { ...bot, id: "session-0b6a3c2e-6f1d-4c55-9a43-2d9a7f0c1e11",
    name: "Bot B", expect: { ...bot.expect, terminal: "t9" } };
  const bots = { ...looked, codex: [session, bot] };
  const answer = { v: 1, at: AT, linked: null, machines: [{ core, bots }] };
  assert.deepEqual(readFleetAnswer(JSON.stringify(answer)), { at: AT, linked: null, bots: { [core]: bots } });
});

test("a record newer than the bots' answer lists no bots and says they come with the next read", () => {
  const stale = row("codex", undefined, {}, null, looked, "2026-11-20T09:00:00.000Z");
  assert.deepEqual(stale.bots, []);
  assert.ok(stale.lines.includes("Its bots are listed again after the next read."));
  assert.deepEqual(row("codex", undefined, {}, null, looked, AT).bots, [bot]);
});

test("members needs exit zero and a machines array", () => {
  assert.equal(members({ code: 1, stdout: '{"machines":[]}' }), null);
  assert.equal(members({ code: 0, stdout: "{}" }), null);
  assert.deepEqual(members({ code: 0, stdout: JSON.stringify({ machines: [{ id: core, name, connected: true }] }) }), [
    { id: core, name, connected: true },
  ]);
});

test("restartArgs binds the shown pane; sameList checks every part of the binding", () => {
  assert.deepEqual(restartArgs(bot, name), ["restart", BOT, "--project", "/p", "--machine", name, "--expect-pane", `${core}/t8/8`]);
  const list = frozen([bot]);
  assert.ok(sameList(list, [bot]));
  for (const changes of [{ id: "b-bbbbbbbbbb" }, { project: "/other" }, { expect: { ...bot.expect, core: "other" } },
    { expect: { ...bot.expect, terminal: "t9" } }, { expect: { ...bot.expect, created_ms: 9 } }]) {
    assert.equal(sameList(list, [{ ...bot, ...changes }]), false);
  }
  assert.notEqual(list[0].expect, bot.expect);
});

test("restartWords uses the code only and never displays stderr or error text", () => {
  for (const [refused, words] of [
    ["binding", "Bot A's pane is no longer the one shown: nothing was restarted."],
    ["helpers", "Bot A has running helpers: nothing was restarted."],
    ["busy", "Bot A is busy: nothing was restarted."],
    ["duplicate", "Bot A has more than one live pane: nothing was restarted."],
    ["CANARY-STDERR-0043", "Bot A wasn't restarted (see the sidebar's actions log)."],
  ]) assert.equal(restartWords({ name: "Bot A", code: 1, out: { refused, error: "CANARY-STDERR-0043" }, stderr: "CANARY-STDERR-0043" }), words);
  const success = { name: "Bot A", code: 0, out: { error: "CANARY-STDERR-0043" } };
  for (const retired of ["ended", "gone", "kept"]) {
    assert.equal(restartWords({ ...success, retired }), "Bot A restarted.");
  }
  for (const result of [success, { ...success, retired: "CANARY-STDERR-0043" }, { ...success, out: null }]) {
    assert.equal(restartWords(result), "Bot A restarted in a new pane, but whether its old pane ended couldn't be verified: check it in Herdr.");
  }
  assert.equal(restartWords({ ...success, retired: "unconfirmed" }),
    "Bot A restarted in a new pane, but its old pane couldn't be confirmed ended: check it in Herdr before ending it.");
});

test("fleetRows uses fixed plan words and names the record route for a managed Restart", () => {
  const ana = "ana@example.test", bo = "bo@example.test";
  const appHome = "/example-home/app";
  const wire = fixtureHere({ email: ana });
  const claude = nextObs("claude", null, wire.claude, AT);
  claude.routes.bare = { email: bo, state: "eligible" };
  claude.routesDiffer = true;
  const entry = { core, name, state: "read", at: AT, appHome, exceptions: wire.exceptions, claude,
    codex: nextObs("codex", null, wire.codex, AT) };
  const plan = emptyPlan(AT), section = plan.claude;
  section.members[core] = { home: appHome, since: AT };
  const read = (tool = "claude") => fleetRows({ plan, record: { machines: { [core]: entry } }, tool, ref: {}, now })[0];
  for (const [state, why, wanted, attempt, words] of [
    ["done", null, ana, null, `on ${ana}`],
    ["pending", null, bo, null, `still on ${ana}`],
    ["pending", null, bo, { at: new Date(now).toISOString(), outcome: null }, `switching to ${bo}…`],
    ["pending", "no-login", bo, null, `no login of ${bo} here`],
    ["pending", "not-eligible", bo, null, `still on ${ana}`],
    ["pending", "update-first", bo, null, "update this machine first"],
    ["suspended", "changed", bo, null, `changed on the machine: now ${ana}`],
    ["suspended", "gone", bo, null, "gone: unlinked"],
  ]) {
    section.assign[core] = wanted;
    section.progress[core] = { state, why, at: AT, attempt };
    assert.equal(read().words, words);
  }
  section.progress[core] = { state: "done", why: null, at: AT };
  for (const [state, reason, words] of [
    ["away", null, "away (not connected)"], ["failed", "timeout", "failed: timeout"], ["unknown", "old-cli", "unknown: old-cli"],
  ]) {
    Object.assign(entry, { state, reason, at: new Date(now).toISOString() });
    assert.equal(read().words, words);
  }
  Object.assign(entry, { state: "read", reason: null, at: AT });
  const linked = read("codex");
  assert.equal(linked.words, "Codex isn't moved on other machines yet.");
  assert.match(linked.lines[0], /^signed in \(account /);
  assert.deepEqual(linked.actions, []);
  assert.equal(read().restart, `A start or restart from here starts ${ana}`);
  assert.deepEqual(read().lines, [`A start or restart from here starts ${ana}.`]);
  for (const why of ["own-path", "own-app-home", "unread"]) {
    entry.exceptions.bound = [{ project: "/project", why }];
    assert.equal(read().restart, null);
    assert.ok(read().lines.includes(`A start or restart in a managed project starts ${ana}.`));
  }
  entry.exceptions.bound = [];
  entry.appHome = "/example-home/other";
  assert.equal(read().restart, `A restart from here starts ${bo}`);
  entry.appHome = appHome;
  entry.claude.routes.bare = { email: null, state: "unresolved" };
  assert.equal(read().restart, "A restart from here starts this Mac starts Claude with its own command, which this read doesn't follow");
});

test("Restart describes each project's Claude route on the same managed core", () => {
  const ana = "ana@example.test", bo = "bo@example.test", appHome = "/example-home/app";
  const wire = fixtureHere({ email: ana });
  const claude = nextObs("claude", null, wire.claude, AT);
  claude.routes.bare = { email: bo, state: "eligible" };
  const plan = emptyPlan(AT);
  plan.claude.members[core] = { home: appHome, since: AT };
  const exceptions = { bound: [{ project: "/own-path", why: "own-path" }], list: [], more: 0 };
  const entry = { core, name, state: "read", at: AT, appHome, exceptions, claude };
  const bots = [{ ...bot, project: "/managed" }, { ...bot, id: "b-bbbbbbbbbb", project: "/own-path" }];
  const [shown] = fleetRows({ plan, record: { at: AT, machines: { [core]: entry } },
    answer: { at: AT, bots: { [core]: { ...looked, claude: bots } } }, tool: "claude", ref: {}, now });
  assert.equal(shown.restart, null);
  assert.deepEqual(shown.bots.map(({ restart }) => restart), [
    `Restart starts ${ana}`, "Restart starts a login this read couldn't confirm",
  ]);
});
