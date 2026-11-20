import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { botsOff, DISCOVER, execOutcome, fleetAfter, fleetMembers, HERE_MARGIN_S, HERE_SINCE, hereArgv, hereWithin, parseDiscover, pickCli, readHere, READ_SECONDS, RUN_HERE } from "../mods/am-sidebar/accountsFleet.js";
import { hereAnswer } from "../mods/am-sidebar/accountsHere.js";
import { PRESENT_SCRIPT } from "../mods/am-sidebar/loginProbe.js";
import { BOT_ID, CHANGED_MS, FLEET_V, nextObs, parseFleet, rowFor } from "../mods/am-sidebar/accountsRows.js";
import { BOT_SHAPE } from "../mods/am-sidebar/attach.js";
import { fleetRows } from "../mods/am-quota/fleet.js";
import { AM, AT, BOT, PACK, READER, auth, exe, fixtureHere, fpr, json, scene, snapshot } from "./accounts-fixture.mjs";

const LATER = "2026-11-20T11:00:00.000Z";
const NOW = Date.parse(LATER);
const joined = (...list) => ({ list, complete: true });
const member = (id, name = id, connected = true) => ({ id, name, connected });
const listReply = (machines) => ({ code: 0, stdout: JSON.stringify({ machines }) });
const observation = (answer, state = "read", name = "vm-other") => ({
  name, state, at: AT, reason: null, cli: "pack", panel: answer.panel, versions: answer.versions, exceptions: answer.exceptions,
  codex: nextObs("codex", null, answer.codex, AT), claude: nextObs("claude", null, answer.claude, AT),
});
const same = fpr("account-a"), other = fpr("account-b");
const codexRef = { fingerprint: same }, claudeRef = { email: "ana@example.com" };
const codexRow = (state, here, account = same, code = null) => ({ state, here, account, code, grant: "unknown" });
const claudeRow = (state, here, account = "ana@example.com", code = null) => ({ state, here, account, code, grant: null });

test("parseDiscover and pickCli: newest qualified, pack tie, marker required, strict versions, nothing found", () => {
  const newer = "3.999.0";
  const found = parseDiscover(`pack ${HERE_SINCE} yes /pack here\nam ${newer} yes /new am\nodd 4.0.0 yes /x\npack 4.0.0 yes relative\npack 4.0.0 nope /x\npack 4.0.0 yes /x\t\npack 4.0.0 yes /${"x".repeat(601)}`);
  assert.equal(found.length, 2);
  assert.deepEqual(pickCli(found), { cli: { kind: "am", marker: true, version: newer, dir: "/new am" } });
  assert.equal(pickCli(found.map((row) => ({ ...row, version: newer }))).cli.kind, "pack");
  for (const line of [`pack ${HERE_SINCE} no /p`, `am ${HERE_SINCE}-rc.1 yes /p`, "am 03.999.0 yes /p", "am 3.999.0-.. yes /p"]) {
    assert.deepEqual(pickCli(parseDiscover(line)), { reason: "old-cli" }, line);
  }
  assert.deepEqual(pickCli([]), { reason: "no-cli" });
});

test("HERE_SINCE is a strict X.Y.Z no later than the patch after this checkout's VERSION", () => {
  const version = readFileSync(new URL("../mods/am-sidebar/VERSION", import.meta.url), "utf8").trim();
  const next = (v) => v.split(".").reduce((n, part) => n * 1000 + Number(part), 0);
  assert.match(HERE_SINCE, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(next(HERE_SINCE) <= next(version) + 1);
});

test("hereWithin leaves time for the target to stop its probes before the transport times out", () => {
  assert.deepEqual([20, 12, 10, 9, 7].map(hereWithin), [10, 6, 5, null, null]);
  const cli = { dir: "/pack", version: HERE_SINCE };
  assert.deepEqual(hereArgv(cli, ["/p"], 7).slice(-3), ["--within", "7", "/p"]);
});

test("execOutcome: stdout decoded, timed_out and killed are timeout, malformed is unreachable; stderr dropped", () => {
  const canary = Buffer.from("CANARY-STDERR-0043").toString("base64");
  const wrapped = { code: 4, stdout: Buffer.from("answer").toString("base64"), stderr: canary };
  assert.deepEqual(execOutcome({ code: 0, stdout: JSON.stringify(wrapped), stderr: canary }), { kind: "ok", code: 4, stdout: "answer" });
  assert.deepEqual(execOutcome({ stdout: JSON.stringify({ ...wrapped, timed_out: true }) }), { kind: "timeout" });
  assert.deepEqual(execOutcome({ killed: true, stdout: "" }), { kind: "timeout" });
  for (const stdout of ["no", "{}", "null"]) assert.deepEqual(execOutcome({ stdout }), { kind: "unreachable" });
});

test("readHere is strict: wrong envelope, oversized or malformed fields fail; known fields rebuilt, emails lowercased", () => {
  for (const change of [
    (x) => { x.v = 2; }, (x) => { x.kind = "wrong"; }, (x) => { x.claude.slots[0].email = "bad email"; },
    (x) => { x.claude.slots[0].id = "bad/id"; }, (x) => { x.codex.generation = "secret"; },
    (x) => { x.codex.account = "wrong"; }, (x) => { x.claude.state = "nope"; },
    (x) => { x.claude.slots[0].dir = "not absolute"; }, (x) => { x.exceptions.list.push({ project: "/p", why: "raw" }); },
    (x) => { x.big = "x".repeat(65536); },
  ]) {
    const value = fixtureHere(); change(value);
    assert.deepEqual(readHere(JSON.stringify(value)), { reason: "bad-answer" });
  }
  const value = fixtureHere();
  value.claude.slots[0].email = "ANA@EXAMPLE.COM";
  value.claude.raw = "CANARY-STATUS-0043";
  assert.deepEqual(readHere(JSON.stringify(value)), fixtureHere());
  value.claude.routes.record = { email: "ana@example.com", state: "failed" };
  assert.deepEqual(readHere(JSON.stringify(value)).claude.routes.record, { email: null, state: "failed" });
});

test("a failed route never counts as a difference, received or stored", () => {
  const answer = fixtureHere(), core = "core-vm-other";
  answer.claude.routes.bare = { email: "ana@example.com", state: "eligible" };
  answer.claude.routesDiffer = true;
  for (const state of ["failed", "eligible"]) {
    answer.claude.routes.record = { email: "bo@example.com", state };
    const expected = state === "eligible";
    const received = readHere(JSON.stringify(answer)).claude;
    assert.deepEqual(received.routes.record, { email: expected ? "bo@example.com" : null, state });
    assert.equal(received.routesDiffer, expected);
    const record = parseFleet(JSON.stringify({ v: FLEET_V, at: AT, machines: { [core]: observation(answer) } }));
    assert.equal(record.machines[core].claude.routesDiffer, expected);
    const [row] = fleetRows({ record, tool: "claude", ref: claudeRef, now: NOW });
    assert.equal(row.lines.some((line) => line.includes("They differ.")), expected);
  }
});

test("an unresolved record route names no effective account, received or stored, and the slots stay", () => {
  // An answer that kept the inventory's email beside an unprobed launcher, as a reader of this
  // branch before review round 4 wrote it.
  const answer = fixtureHere(), core = "core-vm-other";
  answer.claude.routes.record = { email: null, state: "unresolved" };
  answer.claude.state = "eligible";
  answer.claude.email = "ana@example.com";
  const received = readHere(JSON.stringify(answer)).claude;
  assert.deepEqual([received.email, received.state], [null, "unresolved"]);
  assert.deepEqual(received.slots, fixtureHere().claude.slots);
  const record = parseFleet(JSON.stringify({ v: FLEET_V, at: AT, machines: { [core]: observation(answer) } }));
  const stored = record.machines[core].claude;
  assert.deepEqual([stored.email, stored.state], [null, "unresolved"]);
  const [row] = fleetRows({ record, tool: "claude", ref: claudeRef, now: NOW });
  assert.equal(row.words, "unknown: own-launcher");
  assert.equal(row.lines.some((line) => line.includes("same account")), false);
});

test("fleetMembers: nonzero, temporary, duplicate and malformed membership replies", () => {
  assert.equal(fleetMembers({ ...listReply([]), code: 1 }), null);
  assert.equal(fleetMembers({ code: 0, stdout: "not JSON" }), null);
  const keep = member("m", "vm-same");
  assert.deepEqual(fleetMembers(listReply([keep, { ...member("temp", "vm-other"), temporary: true }])), joined(keep));
  assert.deepEqual(fleetMembers(listReply([keep, ...["false", 1].map((temporary, i) => ({
    ...member(`temp-${i}`, `vm-${i}`), temporary,
  }))])), { list: [keep], complete: false });
  assert.deepEqual(fleetMembers(listReply([keep, member("d", "vm-away"), member("d", "vm-old"), member("d2", "vm-two"),
    member("d3", "vm-two"), member("", "vm-other"), member("d4", "bad/name"), member("d5", "vm-other", "true")])),
  { list: [keep], complete: false });
  assert.deepEqual(fleetMembers(listReply([{ id: "m", name: "vm-same", state: "connected" }])), joined(keep));
});

test("rowFor, Codex: observed comparisons, changed for 24 h, missing and unreadable, cached attempts", () => {
  const read = observation(fixtureHere());
  const cases = [
    [read, codexRef, codexRow("observed", "same")], [read, { fingerprint: other }, codexRow("observed", "other")],
    [read, { fingerprint: null }, codexRow("observed", "none")],
    [{ ...read, codex: { ...read.codex, changedAt: AT } }, codexRef, codexRow("changed", "same")],
    [{ ...read, codex: { ...read.codex, file: "absent", account: null } }, codexRef, codexRow("none", null, null)],
    [{ ...read, codex: { ...read.codex, file: "unreadable", account: null } }, codexRef, codexRow("unknown", null, null, "unreadable")],
    [{ ...read, codex: { ...read.codex, accountId: "absent", account: null } }, codexRef, codexRow("unknown", null, null, "no-account-id")],
    [{ ...read, codex: null }, codexRef, codexRow("unknown", null, null, "failed")],
    [{ ...read, state: "away" }, codexRef, codexRow("away", "same")],
    [{ ...read, state: "failed", reason: "timeout" }, codexRef, codexRow("failed", "same", same, "timeout")],
    [{ ...read, state: "unknown", reason: "old-cli" }, codexRef, codexRow("unknown", "same", same, "old-cli")],
    [null, codexRef, codexRow("unknown", null, null, "not-read")],
  ];
  for (const [entry, ref, expected] of cases) assert.deepEqual(rowFor("codex", entry, ref, NOW), expected);
  read.codex.changedAt = AT;
  assert.deepEqual(rowFor("codex", read, codexRef, Date.parse(AT) + CHANGED_MS), codexRow("observed", "same"));
});

test("rowFor, Claude: observed comparisons, changed, no-login only with a complete inventory", () => {
  const read = observation(fixtureHere());
  const bob = { email: "bo@example.com" };
  const slot = { id: "2", email: bob.email, state: "override" };
  assert.deepEqual(rowFor("claude", read, claudeRef, NOW), claudeRow("observed", "same"));
  assert.deepEqual(rowFor("claude", read, { email: null }, NOW), claudeRow("observed", "none"));
  assert.deepEqual(rowFor("claude", read, bob, NOW), claudeRow("no-login", "other"));
  assert.deepEqual(rowFor("claude", { ...read, claude: { ...read.claude, changedAt: AT } }, bob, NOW), claudeRow("changed", "other"));
  assert.deepEqual(rowFor("claude", { ...read, claude: { ...read.claude, slots: [...read.claude.slots, slot] } }, bob, NOW), claudeRow("observed", "other"));
  for (const [slots, state] of [[[{ id: "2", state: "timeout" }], "timeout"], [[{ id: "2", state: "failed" }], "failed"], [[], "failed"]]) {
    assert.deepEqual(rowFor("claude", { ...read, claude: { ...read.claude, slots, slotsComplete: false } }, bob, NOW),
      claudeRow("unknown", "other", "ana@example.com", state));
  }
  for (const code of ["override", "ambiguous", "not-signed-in", "timeout", "bad-folder", "failed"]) {
    assert.deepEqual(rowFor("claude", { ...read, claude: { ...read.claude, email: null, state: code } }, bob, NOW), claudeRow("unknown", null, null, code));
  }
});

test("nextObs: only a change between successful reads changes the account observation", () => {
  for (const [tool, key, previous, next, prevKey] of [["codex", "account", same, other, "prevAccount"],
    ["claude", "email", "ana@example.com", "bo@example.com", "prevEmail"]]) {
    const read = fixtureHere()[tool];
    const first = nextObs(tool, null, read, AT);
    assert.deepEqual([first[prevKey], first.changedAt], [null, null]);
    const refresh = nextObs(tool, first, { ...read, generation: "b".repeat(64) }, LATER);
    assert.deepEqual([refresh[prevKey], refresh.changedAt], [null, null]);
    const changed = nextObs(tool, refresh, { ...read, [key]: next }, LATER);
    assert.deepEqual([changed[prevKey], changed.changedAt], [previous, LATER]);
    assert.equal(rowFor(tool, { ...observation(fixtureHere()), [tool]: refresh }, tool === "codex" ? { fingerprint: next } : { email: null }, NOW).state, "observed");
  }
});

test("fleetAfter: observation retention, final membership failures, single-list entries, name rebound and known keys", () => {
  const answer = fixtureHere();
  const id = "core-a", cleared = "core-b", name = "vm-away";
  const first = joined(member(id, name));
  const old = observation(answer, "read", name);
  const prev = { v: FLEET_V, at: AT, linked: null, machines: { [id]: old, [cleared]: observation(answer), local: { ...old, name: null } } };
  const reads = new Map([[id, { name, state: "away" }], ["local", { answer }]]);
  const exact = fleetAfter(prev, reads, { first, final: first, at: LATER });
  assert.equal(exact.machines[id].state, "away");
  assert.equal(exact.machines[id].codex.readAt, AT);
  assert.ok(!exact.machines[cleared]);
  for (const final of [null, { list: [...first.list], complete: false }]) {
    const out = fleetAfter(prev, reads, { first, final, at: LATER });
    assert.deepEqual(out.linked, { at: LATER, reason: "failed" });
    assert.equal(out.machines[cleared].codex.readAt, AT);
    assert.equal(out.machines[id].state, final ? "away" : "failed");
    assert.equal(out.machines[id].at, LATER);
  }
  const malformedFlag = fleetMembers(listReply([...first.list, { ...member(cleared, "vm-other"), temporary: "false" }]));
  const retained = fleetAfter(prev, reads, { first, final: malformedFlag, at: LATER });
  assert.equal(retained.machines[cleared].codex.readAt, AT);
  const at = "2026-11-20T10:30:00.000Z";
  reads.set(id, { name, state: "read", answer: fixtureHere({ account: other }), at, extra: "CANARY-STATUS-0043" });
  const disconnected = fleetAfter(prev, reads, { first, final: joined(member(id, name, false)), at: LATER }).machines[id];
  assert.deepEqual([disconnected.state, disconnected.reason, disconnected.codex.account, disconnected.codex.readAt, disconnected.claude.readAt],
    ["away", null, other, at, at]);
  assert.deepEqual(rowFor("codex", disconnected, codexRef, NOW), codexRow("away", "other", other));
  const rebound = fleetAfter(prev, reads, { first, final: joined(member("core-new", name)), at: LATER });
  assert.equal(rebound.machines["core-new"].state, "unknown");
  assert.equal(rebound.machines["core-new"].codex, null);
  assert.equal(rebound.machines[id].codex.account, same);
  const renamed = fleetAfter(prev, reads, { first, final: joined(member(id, "vm-other")), at: LATER });
  assert.equal(renamed.machines[id].state, "failed");
  assert.equal(renamed.machines[id].codex.account, same);
  assert.doesNotMatch(JSON.stringify(renamed), /CANARY|extra|argv/);
  assert.deepEqual(parseFleet(JSON.stringify(exact)), exact);
  const malformed = structuredClone(exact);
  malformed.machines[id].codex.home = "relative";
  assert.deepEqual(Object.keys(parseFleet(JSON.stringify(malformed)).machines), ["local"]);
});

test("fleet bot ids match the attach ledger's shape", () => {
  assert.equal(BOT_ID.source, BOT_SHAPE.source);
});

test("botsOff: Claude by folder, default and alias; wordless panes unknown; Codex all listed, exceptions and counts", () => {
  const { claude } = fixtureHere();
  claude.slots.push({ id: "2", dir: "/claude-2", email: "bo@example.com", state: "eligible" });
  const make = (id, argv, extra = {}) => ({ id, name: id, project: "/p", expect: { core: "core", terminal: id, created_ms: 1 }, agent: "claude", argv, ...extra });
  const bindings = [
    make("a", ["env", "-u", "CLAUDE_CONFIG_DIR", "claude"]), make("b", ["env", "CLAUDE_CONFIG_DIR=/claude-2", "claude"]),
    make("c", ["env", "CLAUDE_CONFIG_DIR=/alias", "claude"], { real: "/claude-2" }), make("d", ["claude"]),
    make("e", ["env", "CLAUDE_CONFIG_DIR=/lost", "claude"]), make("f", ["codex"], { name: "é", agent: "codex" }),
    make("g", ["codex"], { project: "/own", agent: "codex" }),
  ];
  const bots = botsOff({ claude, bindings, exceptions: { bound: [{ project: "/own", why: "own-app-home" }] }, unbound: 5, more: 6 });
  assert.deepEqual(bots.claude.map(({ id, on }) => [id, on]), [
    ["b", "slot 2"], ["c", "slot 2"], ["d", "login unknown"], ["e", "an unknown folder"],
  ]);
  assert.deepEqual([bots.codex[0].name, bots.codexReliable, bots.ownHome, bots.unbound, bots.more], ["f", false, 1, 5, 6]);
  assert.deepEqual(botsOff({ reason: "failed" }), { reason: "failed" });
});

test("botsOff lists a Claude bot on the default slot when the record route failed", () => {
  const { claude } = fixtureHere();
  claude.routes.record = { email: null, state: "failed" };
  const binding = { id: BOT, name: "Bot A", project: "/p", expect: { core: "core", terminal: "t8", created_ms: 8 },
    agent: "claude", argv: ["env", "-u", "CLAUDE_CONFIG_DIR", "claude"] };
  const bots = botsOff({ claude, bindings: [binding] });
  assert.deepEqual(bots.claude.map(({ id, on }) => [id, on]), [[BOT, "slot default"]]);
});

test("botsOff counts a binding with unread launch settings among the unchecked bindings", () => {
  const binding = { id: BOT, project: "/unread/", agent: "codex", argv: ["codex"] };
  const bots = botsOff({ bindings: [binding], exceptions: { bound: [{ project: "/unread", why: "unread" }] }, more: 3 });
  assert.deepEqual(bots.codex, []);
  assert.equal(bots.more, 4);
});

test("checkHere is one validator: a malformed source field never leaves hereAnswer and the result passes readHere", async () => {
  const absent = Object.assign(new Error(), { code: "ENOENT" });
  const answer = await hereAnswer({ env: {}, home: "/example-home", appHome: "/app", amStore: "/am",
    readBytes: () => { throw absent; }, isDir: () => false, now: Date.now,
    exec: async (_command, args) => args[1] === PRESENT_SCRIPT ? { code: 0, stdout: "" } :
      { code: 0, stdout: '{"loggedIn":true,"email":"CANARY-STATUS-0043 is no email","authMethod":"claude.ai"}' },
  });
  const text = JSON.stringify(answer);
  assert.doesNotMatch(text, /CANARY-STATUS-0043/);
  assert.equal(answer.claude.slots[0].email, null);
  assert.deepEqual(readHere(text), answer);
});

const runFleet = (s, program = PACK) => s.run(program, program === READER ? ["fleet"] : ["accounts", "fleet", "--json"]);
const safeFleet = (s, program = PACK) => {
  const r = runFleet(s, program);
  assert.equal(r.code, 0, r.stderr);
  return r.json();
};
const observed = ({ core, name, state, reason, cli, rows }) => ({ core, name, state, reason, cli, rows });
const oldStub = (where, log, version = "3.160.2") => {
  mkdirSync(join(where, "bin"), { recursive: true });
  writeFileSync(join(where, "VERSION"), `${version}\n`);
  writeFileSync(join(where, "bin/automagik-herdr.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(log)}, "old cli ran");\n`);
  exe(join(where, "bin/run.sh"), `#!/bin/sh\necho old runner ran >> "${log}"\n`);
};

test("the fleet read (acceptance): local, vm-away, vm-old, vm-two, vm-other give exact rows through the sidebar and am", (t) => {
  const s = scene(t);
  writeFileSync(join(s.codex, "auth.json"), auth());
  const away = s.machine("vm-away", { state: "disconnected" });
  const old = s.machine("vm-old");
  const oldLog = join(s.root, "old.log");
  oldStub(join(old.app, "mods/am-sidebar"), oldLog);
  const two = s.machine("vm-two");
  two.ship("pack");
  const newer = two.ship("am", "3.999.0");
  const different = s.machine("vm-other", { account: "account-b", email: "bo@example.com" });
  different.ship("pack");
  const targets = [away, old, two, different];
  const snapshots = targets.map((m) => snapshot(m.home));
  for (const program of [PACK, AM]) {
    const out = safeFleet(s, program);
    assert.equal(out.kept, true);
    assert.deepEqual(out.local.rows, { codex: codexRow("observed", "same"), claude: claudeRow("observed", "same") });
    assert.deepEqual(out.machines.map(observed), [
      { core: away.id, name: away.name, state: "away", reason: null, cli: null, rows: {
        codex: codexRow("away", null, null), claude: claudeRow("away", null, null) } },
      { core: old.id, name: old.name, state: "unknown", reason: "old-cli", cli: null, rows: {
        codex: codexRow("unknown", null, null, "old-cli"), claude: claudeRow("unknown", null, null, "old-cli") } },
      { core: different.id, name: different.name, state: "read", reason: null, cli: "pack", rows: {
        codex: codexRow("observed", "other", other), claude: claudeRow("no-login", "other", "bo@example.com") } },
      { core: two.id, name: two.name, state: "read", reason: null, cli: "am", rows: {
        codex: codexRow("observed", "same"), claude: claudeRow("observed", "same") } },
    ]);
  }
  const calls = s.log();
  for (const [m, runs] of [[away, 0], [old, 1], [two, 2], [different, 2]]) {
    const commands = calls.filter((args) => args[0] === "exec" && args[args.indexOf("--on") + 1] === m.name);
    assert.equal(commands.length, 2 * runs);
    assert.equal(commands.filter((args) => args.includes(DISCOVER)).length, runs ? 2 : 0);
    if (m === two) for (const args of commands.filter((args) => args.includes(RUN_HERE))) assert.ok(args.includes(newer));
  }
  assert.ok(calls.every((a) => ["machine", "exec", "ls"].includes(a[0])));
  assert.equal(existsSync(oldLog), false);
  assert.deepEqual(targets.map((m) => snapshot(m.home)), snapshots);
  assert.equal(statSync(s.file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(s.file)).mode & 0o777, 0o700);
  const raw = readFileSync(s.file, "utf8");
  assert.deepEqual(JSON.parse(raw), parseFleet(raw));
  assert.doesNotMatch(raw, /CANARY|bots|argv|stderr/);
});

test("a rollback between discovery and run refuses a changed VERSION and runs nothing old", (t) => {
  const s = scene(t);
  const m = s.machine("vm-old");
  const dir = m.ship("pack");
  s.hcWrapper(`case "$*" in *'d=$1 want=$2'*) printf '3.160.2\\n' > "${dir}/VERSION";; esac`);
  const [row] = safeFleet(s).machines;
  assert.deepEqual([row.state, row.reason], ["failed", "failed"]);
});

test("an overlong VERSION line is not a version: the CLI is old-cli and nothing runs", (t) => {
  const s = scene(t), m = s.machine("vm-old");
  const version = join(m.ship("pack"), "VERSION");
  writeFileSync(version, `3.999.0-${"a".repeat(60)}\n`);
  const [row] = safeFleet(s).machines;
  assert.deepEqual([row.state, row.reason], ["unknown", "old-cli"]);
  assert.equal(s.log().filter((args) => args.includes(RUN_HERE)).length, 0);
  writeFileSync(version, `3.999.0-${"a".repeat(56)}\n`);
  assert.equal(safeFleet(s).machines[0].state, "read");
});

test("a folder swapped after the guard's last check runs nothing old", (t) => {
  const s = scene(t);
  const m = s.machine("vm-old");
  const dir = m.ship("pack");
  const old = join(s.root, "old-pack"), log = join(s.root, "old.log");
  oldStub(old, log);
  exe(join(m.bin, "node"), `#!/bin/sh\nif [ "$1" != --version ]; then mv "${dir}" "${dir}-away"; mv "${old}" "${dir}"; fi\nexec "${process.execPath}" "$@"\n`);
  assert.deepEqual(safeFleet(s).machines.map(({ state, reason }) => [state, reason]), [["failed", "failed"]]);
  assert.equal(existsSync(log), false);
});

test("a mixed folder fails at link time: a new bin/accounts.mjs over an old CLI evaluates nothing", (t) => {
  const s = scene(t);
  const m = s.machine("vm-old");
  const dir = m.ship("pack"), log = join(s.root, "old.log");
  // Leave the dedicated reader and run.sh in place, replacing only the CLI it imports.
  const old = join(s.root, "mixed-old");
  oldStub(old, log);
  writeFileSync(join(dir, "bin/automagik-herdr.mjs"), readFileSync(join(old, "bin/automagik-herdr.mjs")));
  assert.deepEqual(safeFleet(s).machines.map(({ state, reason }) => [state, reason]), [["failed", "failed"]]);
  assert.equal(existsSync(log), false);
});

test("the per-machine 20 s covers discovery and read from each first child's start, even past eight queued machines", async (t) => {
  const s = scene(t);
  for (let i = 0; i < 9; i += 1) s.machine(`vm-two-${i}`).ship("pack");
  s.hcWrapper(`case "$*" in *'one "$app_home'*) sleep 8;; esac`);
  const start = Date.now();
  const r = await s.start(READER, ["fleet"]);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.equal(out.machines.length, 9);
  assert.ok(out.machines.every((row) => row.state === "read" || row.state === "failed" && row.reason === "timeout"));
  const calls = s.log();
  const runs = calls.filter((a) => a.includes(RUN_HERE));
  assert.ok(runs.length > 0);
  for (const args of runs) {
    const timeout = Number(args[args.indexOf("--timeout") + 1]);
    const within = Number(args[args.indexOf("--within") + 1]);
    assert.ok(timeout <= 12);
    assert.ok(within <= timeout - HERE_MARGIN_S);
    assert.ok(within <= Math.floor(timeout / 2));
  }
  assert.ok(Date.now() - start < 42_000);
});

test("a target whose runtime is slow to start still ends its read before the transport and leaves no probe", async (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  s.hcWrapper(`case "$*" in *'one "$app_home'*) sleep 8;; esac`);
  const node = join(m.bin, "node");
  exe(node, readFileSync(node, "utf8").replace("#!/bin/sh\n", '#!/bin/sh\n[ "$1" = --version ] || sleep 3\n'));
  const file = join(m.target, "probe-pids");
  exe(join(m.bin, "claude"), `#!/bin/sh\necho $$ >> "${file}"\nexec sleep 60\n`);
  const r = await s.start(READER, ["fleet"]);
  assert.equal(r.code, 0, r.stderr);
  const [row] = r.json().machines;
  assert.deepEqual([row.state, row.reason], ["read", null]);
  const pids = readFileSync(file, "utf8").trim().split("\n").map(Number);
  assert.ok(pids.every((pid) => pid > 0));
  const until = Date.now() + 2000;
  for (const pid of pids) {
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(20);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  const runs = s.log().filter((args) => args.includes(RUN_HERE));
  assert.equal(runs.length, 1);
  assert.match(runs[0].find((word) => word === RUN_HERE), /--started/);
});

test("a discovery that leaves under 10 s starts no read on that machine", async (t) => {
  for (const seconds of [13, 11]) {
    await t.test(`${seconds} s discovery`, (t) => {
      const s = scene(t), m = s.machine("vm-other");
      m.ship("pack");
      s.hcWrapper(`case "$*" in *'one "$app_home'*) sleep ${seconds};; esac`);
      const [row] = safeFleet(s, READER).machines;
      assert.deepEqual([row.state, row.reason], ["failed", "timeout"]);
      assert.ok(s.log().some((args) => args.includes(DISCOVER)));
      assert.equal(s.log().filter((args) => args.includes(RUN_HERE)).length, 0);
    });
  }
});

test("a replacement core under the same name with an old CLI: zero runs of its CLI and its read dropped", (t) => {
  const s = scene(t), m = s.machine("vm-old");
  const dir = m.ship("pack");
  const old = join(s.root, "old-pack"), oldLog = join(s.root, "old.log"), replacement = join(s.root, "replacement.json");
  oldStub(old, oldLog);
  const state = s.states();
  state.machines[0].id = "core-replaced";
  json(replacement, state);
  s.hcWrapper(`case "$*" in *'d=$1 want=$2'*) mv "${dir}" "${dir}-away"; mv "${old}" "${dir}"; cp "${replacement}" "${s.statePath}";; esac`);
  const out = safeFleet(s);
  assert.deepEqual(out.machines.map(({ core, state, bots }) => [core, state, bots]),
    [["core-replaced", "unknown", null], [m.id, "unknown", null]].sort(([a], [b]) => a < b ? -1 : 1));
  assert.equal(existsSync(oldLog), false);
});

test("a rebind during the bot lookup drops that machine's read and bots", (t) => {
  const s = scene(t), m = s.machine("vm-same");
  m.ship("pack");
  const { attach } = s.botProject(m);
  s.ledger(attach);
  const [first] = safeFleet(s).machines;
  assert.equal(first.bots.claude[0].on, "login unknown");
  s.setState((state) => state.terminals.push({ ...state.terminals[0], address: `${m.name}/t9` }));
  const [unbound] = safeFleet(s).machines;
  assert.equal(unbound.bots.unbound, 1);
  const replacement = join(s.root, "replacement.json");
  const state = s.states();
  state.machines[0].id = "core-replaced";
  json(replacement, state);
  s.hcWrapper(`[ "$1" != get ] || cp "${replacement}" "${s.statePath}"`);
  const out = safeFleet(s);
  assert.equal(out.machines.find((x) => x.core === m.id).state, "unknown");
  assert.ok(out.machines.every((row) => row.bots === null));
  assert.equal(out.machines.find((x) => x.core === "core-replaced").rows.codex.account, null);
});

test("unlink loses observations immediately; a failed list keeps observations and reports its attempt", (t) => {
  const s = scene(t), m = s.machine("vm-away");
  m.ship("pack");
  safeFleet(s);
  const before = parseFleet(readFileSync(s.file, "utf8")).machines[m.id];
  s.setState((state) => { state.fail = ["machine"]; });
  const failed = safeFleet(s);
  assert.deepEqual(failed.linked, { reason: "failed" });
  const kept = parseFleet(readFileSync(s.file, "utf8"));
  assert.equal(kept.machines[m.id].state, "failed");
  assert.equal(kept.machines[m.id].codex.readAt, before.codex.readAt);
  assert.equal(kept.machines[m.id].at, kept.linked.at);
  s.setState((state) => { state.fail = []; state.machines = []; });
  assert.deepEqual(safeFleet(s).machines, []);
  assert.deepEqual(Object.keys(parseFleet(readFileSync(s.file, "utf8")).machines), ["local"]);
});

test("a target whose Claude runs through its own launcher reads unresolved and its row compares nothing", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  json(join(m.app, "programs.json"), { programs: { claude: { run: ["bun", "x", "claude"] } } });
  const mark = join(m.target, "launcher-ran");
  exe(join(m.bin, "bun"), `#!/bin/sh\necho ran > "${mark}"\nexec "${join(m.bin, "claude")}" auth status\n`);
  const [machine] = safeFleet(s).machines;
  assert.deepEqual(machine.rows.claude, claudeRow("unknown", null, null, "own-launcher"));
  const { claude } = parseFleet(readFileSync(s.file, "utf8")).machines[m.id];
  assert.deepEqual(claude.routes.record, { email: null, state: "unresolved" });
  assert.equal(existsSync(mark), false);
});

test("hc exec's stderr and target CLI stderr never appear in the fleet output or record; controller overrides are unresolved", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  const b = join(m.bin, "claude");
  exe(b, readFileSync(b, "utf8").replace('[ "$1', "echo CANARY-STDERR-0043 >&2\n[ \"$1"));
  json(join(s.app, "programs.json"), { programs: { claude: { run: ["/controller/claude"] } } });
  s.hcWrapper('[ "$1" != exec ] || echo CANARY-STDERR-0043 >&2');
  const r = runFleet(s);
  assert.equal(r.code, 0, r.stderr);
  const record = readFileSync(s.file, "utf8");
  assert.doesNotMatch(r.stdout + r.stderr + record, /CANARY-(STDERR|STATUS|REFRESH)-0043/);
  assert.deepEqual(parseFleet(record).machines[m.id].claude.routes.bare, { email: null, state: "unresolved" });
  const programs = join(s.app, "programs.json");
  json(programs, { programs: { claude: { run: ["claude", "--settings", "/s.json"] } } });
  safeFleet(s);
  assert.deepEqual(parseFleet(readFileSync(s.file, "utf8")).machines[m.id].claude.routes.bare, { email: null, state: "unresolved" });
  unlinkSync(programs);
  safeFleet(s);
  assert.deepEqual(parseFleet(readFileSync(s.file, "utf8")).machines[m.id].claude.routes.bare, { email: "ana@example.com", state: "eligible" });
});

test("a second fleet read while one runs is refused as busy; it writes nothing", async (t) => {
  const s = scene(t);
  s.hcWrapper('[ "$1" != machine ] || sleep 1');
  const pending = s.start(READER, ["fleet"]);
  for (let i = 0; i < 100 && !existsSync(join(dirname(s.file), "fleet.lock")); i += 1) await delay(20);
  const refused = runFleet(s);
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json(), { error: "busy" });
  assert.equal(existsSync(s.file), false);
  assert.equal((await pending).code, 0);
});

test("no app home folder: the read runs and kept is false", (t) => {
  const s = scene(t);
  const missing = join(s.root, "no-app");
  const r = s.run(READER, ["fleet"], { HERDR_APP_HOME: missing });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().kept, false);
  assert.equal(existsSync(missing), false);
});

test("accounts commands repair no link: a stale am link stays after accounts fleet", (t) => {
  const s = scene(t);
  const link = s.staleLink();
  const was = readlinkSync(link);
  safeFleet(s);
  assert.equal(readlinkSync(link), was);
});

test("a FIFO at fleet.json does not stall the read", (t) => {
  const s = scene(t);
  mkdirSync(dirname(s.file), { recursive: true, mode: 0o700 });
  assert.equal(spawnSync("mkfifo", [s.file], { stdio: "ignore" }).status, 0);
  const r = spawnSync(process.execPath, [READER, "fleet"], { cwd: s.root, env: s.env, timeout: 10_000, stdio: "ignore" });
  assert.ifError(r.error);
  assert.equal(r.status, 0);
  const stats = statSync(s.file);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.mode & 0o777, 0o600);
});

test("a FIFO at the controller's programs.json does not stall the fleet: the bare route is unresolved and no bots are offered", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  s.ledger(s.botProject(m).attach);
  assert.equal(spawnSync("mkfifo", [join(s.app, "programs.json")], { stdio: "ignore" }).status, 0);
  const r = s.run(READER, ["fleet"], {}, { timeout: 60_000 });
  assert.equal(r.code, 0, r.stderr);
  const [row] = r.json().machines;
  assert.equal(row.state, "read");
  const record = parseFleet(readFileSync(s.file, "utf8"));
  assert.deepEqual(record.machines[m.id].claude.routes.bare, { email: null, state: "unresolved" });
  assert.deepEqual(row.bots, { reason: "failed" });
});

test("bindings past the cap are counted separately and a failed bot lookup leaves both account reads intact", (t) => {
  const s = scene(t);
  const crowded = s.machine("vm-two"), lookup = s.machine("vm-other"), stale = s.machine("vm-same");
  for (const machine of [crowded, lookup, stale]) machine.ship("pack");
  const bindings = Array.from({ length: 22 }, (_, i) => {
    const bot = `b-${String.fromCharCode(97 + i).repeat(10)}`;
    return s.botProject(crowded, { terminal: `t${i + 1}`, bot, argv: ["codex"] }).attach;
  });
  const failed = s.botProject(lookup).attach;
  const { attach: live, project } = s.botProject(stale, { bot: "b-zzzzzzzzzz", argv: ["codex"] });
  live.project = join(stale.home, "z-own");
  mkdirSync(join(live.project, ".herdr"), { recursive: true });
  copyFileSync(join(project, ".herdr/bots.json"), join(live.project, ".herdr/bots.json"));
  writeFileSync(join(live.project, ".herdr/pane-env"), "HERDR_APP_HOME=/elsewhere\n");
  s.setState((state) => { state.terminals.find((pane) => pane.address === `${stale.name}/${live.terminal}`).cwd = live.project; });
  const old = bindings.slice(0, 20).map(({ bot }, i) => ({
    ...live, bot, project: join(stale.home, `p-${String(i).padStart(2, "0")}`), terminal: `t${i + 20}`,
  }));
  s.ledger(...bindings, failed, ...old, live);
  s.setState((state) => { state.failGet = [`${lookup.name}/${failed.terminal}`]; });
  const out = safeFleet(s).machines;
  const many = out.find((row) => row.core === crowded.id);
  assert.equal(many.state, "read");
  assert.deepEqual([many.bots.codex.length, many.bots.more, many.bots.unbound], [20, 2, 0]);
  assert.equal(s.log().filter((args) => args[0] === "get" && args[1].startsWith(`${crowded.name}/`)).length, 20);
  const unread = out.find((row) => row.core === lookup.id);
  assert.deepEqual([unread.state, unread.bots], ["read", { reason: "failed" }]);
  const afterStale = out.find((row) => row.core === stale.id);
  assert.deepEqual([afterStale.bots.codex, afterStale.bots.more, afterStale.bots.unbound], [[], 1, 0]);
});

test("a bound project whose launch settings can't be read is not offered", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  const { attach, project } = s.botProject(m, { argv: ["codex"] });
  mkdirSync(join(project, ".herdr/pane-env"));
  s.ledger(attach);
  const [{ bots }] = safeFleet(s).machines;
  assert.deepEqual(bots.codex, []);
  assert.equal(bots.more, 1);
});

test("a terminal id reused by another bot's pane after a stale binding counts as unbound", (t) => {
  const s = scene(t), m = s.machine("vm-other");
  m.ship("pack");
  const { attach } = s.botProject(m, { created_ms: 9, label: "b-cccccccccc" });
  s.ledger({ ...attach, created_ms: 8 });
  const [{ bots }] = safeFleet(s).machines;
  assert.deepEqual([bots.claude, bots.codex, bots.unbound], [[], [], 1]);
});

test("a bot lookup that outlasts its 20 s keeps the machine's rows and fails only its bots", async (t) => {
  const s = scene(t), m = s.machine("vm-other", { account: "account-b", email: "bo@example.com" });
  m.ship("pack");
  const { attach, pane } = s.botProject(m, { argv: ["codex"] });
  s.ledger(attach);
  const [baseline] = safeFleet(s).machines;
  assert.equal(baseline.bots.codex.length, 1);
  s.hcWrapper(`[ "$1" != get ] || [ "$2" != "${pane.address}" ] || sleep 25`);
  const start = Date.now();
  const r = await s.start(READER, ["fleet"]);
  assert.equal(r.code, 0, r.stderr);
  const [machine] = r.json().machines;
  assert.equal(machine.state, "read");
  assert.deepEqual(machine.rows, baseline.rows);
  assert.deepEqual(machine.bots, { reason: "failed" });
  assert.ok(Date.now() - start < READ_SECONDS * 1000 + 15_000);
});
