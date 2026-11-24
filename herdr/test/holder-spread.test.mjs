// #1432 item 3: the holder pool's policy, pure and independent of hc. A holder is an hc
// session's core on this computer; one holder's loss ends every pane it held, so a new pane
// goes to the holder with the fewest pack agents, under a per-holder limit. The default is one
// local holder (today's behaviour), and the limit's default is documented in README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CUT_OFF_EXE, fixtureProcStat, writeFixtureProc, writeFixtureProcRoot } from "./fake-core.mjs";
import { scratchRoot } from "./scratch-project.mjs";

import { DEFAULT_HOLDER_LIMIT, MAX_HOLDER_LIMIT, chooseHolder, holderRows, holdersText, lossEvent, lossLine,
  parseHolders, sameLoss, spreadSummary } from "../mods/am-sidebar/holderSpread.mjs";

const pool = (names, limit = 2) => ({ limit, holders: names.map((name) => ({ name, machine: name === "local" ? null : name, session: name === "local" ? null : `am-holder-${name}` })) });
const counts = (pairs) => new Map(pairs);

test("the default pool is one local holder and the documented limit", () => {
  const c = parseHolders(null);
  assert.equal(c.limit, DEFAULT_HOLDER_LIMIT);
  assert.deepEqual(c.holders, [{ name: "local", machine: null, session: null }]);
  assert.deepEqual(parseHolders("").holders, c.holders);
  assert.equal(parseHolders("{not json").holders.length, 1);
  assert.match(parseHolders("{not json").warnings[0], /isn't JSON/);
});

test("strict parsing distinguishes missing holder configuration from malformed present content", () => {
  const strict = { strict: true };
  assert.deepEqual(parseHolders(null, strict).warnings, []);
  assert.deepEqual(parseHolders('{"holders":[]}', strict).warnings, []);
  for (const text of ["", "  ", '{"holders":"h2"}', '{"holders":[{"name":"h2","session":2}]}']) {
    assert.ok(parseHolders(text, strict).warnings.length, JSON.stringify(text));
    assert.deepEqual(parseHolders(text).warnings, []);
  }
});

test("the limit and holder names are validated, and bad entries are said and left out", () => {
  const c = parseHolders(JSON.stringify({ limit: 999, holders: [
    { name: "h2" }, "h3", { name: "../bad" }, { name: "h2" }, { name: "local" }, { name: "h4", machine: "x/y" },
  ] }));
  assert.equal(c.limit, DEFAULT_HOLDER_LIMIT);
  assert.deepEqual(c.holders.map((h) => h.name), ["local", "h2", "h3"]);
  assert.ok(c.warnings.length >= 2);
  assert.equal(parseHolders(JSON.stringify({ limit: 1 })).limit, 1);
  assert.equal(parseHolders(JSON.stringify({ limit: MAX_HOLDER_LIMIT })).limit, MAX_HOLDER_LIMIT);
  assert.equal(parseHolders(JSON.stringify({ limit: 0 })).limit, DEFAULT_HOLDER_LIMIT);
  assert.equal(parseHolders(JSON.stringify({ limit: "4" })).limit, 4);
});

test("the file keeps local implicit and round-trips the rest", () => {
  const c = pool(["local", "h2"], 3);
  const again = parseHolders(holdersText(c));
  assert.equal(again.limit, 3);
  assert.deepEqual(again.holders.map((h) => h.name), ["local", "h2"]);
  assert.equal(again.holders[1].machine, "h2");
  assert.match(holdersText(c), /"limit": 3/);
  assert.doesNotMatch(holdersText(c), /"name": "local"/);
});

test("a start goes to the least loaded holder, and never leaves every agent in one", () => {
  for (let h = 2; h <= 4; h += 1) {
    for (let limit = 1; limit <= 6; limit += 1) {
      const config = pool(["local", ...Array.from({ length: h - 1 }, (_, i) => `h${i + 2}`)], limit);
      const live = counts(config.holders.map((x) => [x.name, 0]));
      for (let n = 1; n <= 30; n += 1) {
        const pick = chooseHolder({ config, counts: live });
        assert.equal(pick.error, undefined);
        live.set(pick.name, live.get(pick.name) + 1);
        const summary = spreadSummary({ config, counts: live });
        assert.equal(summary.total, n);
        assert.ok(summary.largest <= Math.ceil(n / h), `N=${n} H=${h} L=${limit} largest ${summary.largest}`);
        if (n > limit) assert.ok(summary.used.length >= 2, `N=${n} H=${h} L=${limit} used ${summary.used}`);
        if (n <= h) assert.ok(summary.largest <= 1, `N=${n} H=${h} L=${limit} spreads from the first start`);
      }
    }
  }
});

test("a named holder wins, an unknown one is a usage problem, and a disconnected one is left out", () => {
  const config = pool(["local", "h2", "h3"], 2);
  assert.equal(chooseHolder({ config, counts: counts([["local", 2], ["h2", 1], ["h3", 0]]), holder: "local" }).name, "local");
  assert.match(chooseHolder({ config, holder: "nope" }).error, /no holder "nope"/);
  const disconnected = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0], ["h3", 0]]),
    connected: new Map([["h2", false], ["h3", true]]) });
  assert.equal(disconnected.name, "h3");
  // Every machine away: this computer's holder still takes it, rather than refusing the start.
  const allAway = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0], ["h3", 0]]),
    connected: new Map([["h2", false], ["h3", false]]) });
  assert.equal(allAway.name, "local");
});

test("a holder at its limit is full; only one above it is over the limit", () => {
  // #1881: `holderRows` and `chooseHolder` used `count > limit` and `count >= limit` for the
  // same `overLimit` name. One meaning now, in both: `atLimit` (`count >= limit`) is full,
  // which is when the next start moves on; `overLimit` (`count > limit`) is strictly above.
  const config = pool(["local", "h2"], 1);
  const rows = holderRows({ config, counts: counts([["local", 2], ["h2", 1]]) });
  assert.deepEqual(rows.map((r) => [r.name, r.count, r.atLimit, r.overLimit]),
    [["local", 2, true, true], ["h2", 1, true, false]]);
  // Both at the limit: the least loaded (h2) still takes it, and says it is full.
  const room = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0]]) });
  assert.equal(room.name, "h2");
  assert.equal(room.atLimit, false, "0/1 has room");
  const full = chooseHolder({ config, counts: counts([["local", 1], ["h2", 1]]) });
  assert.equal(full.name, "local", "a tie keeps the pool's order");
  assert.equal(full.atLimit, true);
  assert.equal(full.overLimit, false, "exactly at the limit is full, not over");
  const over = chooseHolder({ config, counts: counts([["local", 2], ["h2", 2]]) });
  assert.equal(over.atLimit, true);
  assert.equal(over.overLimit, true);
});

test("reserved seats count for the choice, so two starts in flight spread", () => {
  // #1881: the pure half of the concurrency repair. A start already chosen but not attached is
  // in `reserved`; the next choice must see that seat. Without it two starts both read 0/0 and
  // both pick local.
  const config = pool(["local", "h2"], 1);
  const none = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]) });
  assert.equal(none.name, "local");
  const first = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]), reserved: counts([["local", 1]]) });
  assert.equal(first.name, "h2", "local's seat is reserved by the first start");
  const both = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]), reserved: counts([["local", 1], ["h2", 1]]) });
  assert.equal(both.name, "local", "every holder full: the least loaded (a tie) takes it");
  assert.equal(both.count, 1, "the returned count includes the other starts' seats");
  assert.equal(both.atLimit, true);
});

test("a loss record names the holder and the bots it took, and nothing else", () => {
  const e = lossEvent({ at: "2026-11-16T10:00:00.000Z", holder: "h2", agents: ["b-two", "b-one", "b-two", null] });
  assert.deepEqual(e, { v: 1, at: "2026-11-16T10:00:00.000Z", holder: "h2", reason: "holder_lost", agents: ["b-one", "b-two"] });
  assert.equal(JSON.stringify(e).includes("/"), false, "no path or address");
  assert.equal(lossLine(e), 'holder lost: 2 agents in holder "h2" (b-one, b-two)');
  assert.equal(lossLine(lossEvent({ agents: ["b-one"], reason: "holder_unreachable" })),
    'holder unreachable: 1 agent in holder "local" (b-one)');
  assert.equal(sameLoss(e, { ...e }), true);
  assert.equal(sameLoss(e, { ...e, agents: ["b-one"] }), false);
  assert.equal(sameLoss(e, { ...e, at: "2026-11-16T10:00:01.000Z" }), false);
});

test("holder loss seats are sorted, store only identity fields, and deduplicate across observation times", () => {
  const first = { bot: "b-one", core: "c1", terminal: "t2", created_ms: 10, machine: null };
  const second = { bot: "b-two", core: "c2", terminal: "t1", created_ms: 20, machine: "h2", identity: "uncertain" };
  const third = { ...first, terminal: "t3" };
  const event = lossEvent({ agents: ["b-two", "b-one"], seats: [
    { ...second, project: "/tmp/project", socket: "/tmp/socket", address: "h2/t1" },
    { ...third, identity: "confirmed", env: { HOME: "/tmp/home" } }, first,
  ] });
  assert.deepEqual(event.seats, [first, third, second]);
  assert.ok(sameLoss(event, { ...event, at: "different observation time", seats: [...event.seats].reverse() }));
  assert.ok(!sameLoss(event, { ...event, seats: [first, second, { ...third, created_ms: 11 }] }));
  assert.ok(!sameLoss(event, { ...event, seats: [first, second] }));
  const legacy = lossEvent({ at: "unknown", holder: "h2", agents: ["b-one"], reason: "holder_unreachable" });
  assert.ok(!Object.hasOwn(legacy, "seats"));
  assert.ok(sameLoss(legacy, { ...legacy }));
  assert.ok(!sameLoss(legacy, { ...legacy, at: "later" }));
});

const spread = () => import("../mods/am-sidebar/holderSpread.mjs");
const cliReaders = () => import("../mods/am-sidebar/bin/automagik-herdr.mjs");
const DEFAULT_SOCKET = "/runtime/default.sock";
const H2_SOCKET = "/runtime/am-holder-h2.sock";
const EXE = "/prefix/herdr-core";
const NAMESPACE = "pid:[404]";
const hold = (pid = 222, socket = "/runtime/default.holder.1234abcd.sock") => ({
  pid, ppid: 1, starttime: "1000", exe: EXE, state: "S", argv: [EXE, "hold", "--socket", socket],
});
const status = (id = "core-local", pid = 400, holders = []) => ({ status: { core: { id }, pid, holders } });
const empty = { holders: [], unchecked: [], recheckMs: 0 };
const positive = { ...empty, holders: [{ holder: "local", pid: 222, programs: 0 }] };

function fakeCutOff({ names = ["local"], tables = [[hold()], [hold()]] } = {}) {
  let read = 0, now = 0;
  const calls = [], waits = [], processes = [];
  const sockets = new Map([["local", DEFAULT_SOCKET], ["h2", H2_SOCKET]]);
  const answers = new Map([[DEFAULT_SOCKET, status()], [H2_SOCKET, status("core-h2", 401)]]);
  const input = {
    members: () => ({ ...pool(names), warnings: [] }),
    discover: ({ name }) => [{ socket: sockets.get(name), names: [sockets.get(name)] }],
    rpc: async (socket, timeoutMs) => {
      calls.push([read, socket, timeoutMs]);
      const answer = answers.get(socket);
      return typeof answer === "function" ? answer(read) : answer;
    },
    proc: (index) => {
      read = index;
      processes.push(index);
      return { entries: tables[index], namespace: NAMESPACE, namespaceOf: () => NAMESPACE,
        coreProof: () => ({ exe: EXE, namespace: NAMESPACE }), listeningPaths: () => answers.keys() };
    },
    clock: { now: () => now, sleep: async (delay) => { waits.push(delay); now += delay; } },
    recheckMs: 0,
  };
  return { input, calls, waits, processes, answers, sockets, tables, advance: (ms) => { now += ms; } };
}

function assertUnchecked(result, reason, members = ["local"]) {
  assert.deepEqual(result, { ...empty, unchecked: members.map((holder) => ({ holder, reason })) });
}

test("U1 cut-off: Linux process fields preserve exact argv and reject truncated stat", async () => {
  const { parseProcStat, parseProcStatus, parseCmdline, liveProc } = await spread();
  const comm = "name with ) ( and space";
  const stat = fixtureProcStat(222, { comm, ppid: 7, state: "Z", starttime: "9007199254740995" });
  assert.deepEqual(parseProcStat(stat, 222), { ppid: 7, state: "Z", starttime: "9007199254740995" });
  assert.equal(liveProc(parseProcStat(stat, 222)), false);
  assert.equal(parseProcStat("222 (broken) S 9 0", 222), null);
  assert.equal(parseProcStat(stat, 223), null);
  assert.equal(parseProcStatus("Name:\tx\nUid:\t30\t31\t31\t31\n"), 30);
  assert.equal(parseProcStatus("Uid:\tbad\t31\t31\t31\n"), null);
  assert.deepEqual(parseCmdline("/bin/hc\0hold\0--socket\0/a folder/core.holder.sock\0"), ["/bin/hc", "hold", "--socket", "/a folder/core.holder.sock"]);
  assert.deepEqual(parseCmdline("a\0\0"), ["a", ""]);
  assert.deepEqual(parseCmdline(""), []);
  assert.equal(parseCmdline("a hold --socket /tmp"), null);
});

test("U2 cut-off: only exact hold argv and literal sibling socket names match", async () => {
  const { holderSocketOf, holdProcess, holderCutOffs } = await spread();
  const socket = "/runtime/default.holder.1234abcd.sock";
  assert.equal(holdProcess(hold()), socket);
  assert.equal(holdProcess({ ...hold(), argv: ["sh", "-c", `${EXE} hold --socket ${socket}`] }), null);
  assert.equal(holdProcess({ ...hold(), argv: [...hold().argv, "extra"] }), null);
  assert.equal(holdProcess({ ...hold(), argv: [EXE, "serve", "--socket", socket] }), null);
  assert.equal(holdProcess({ ...hold(), state: "X" }), null);
  const f = fakeCutOff();
  assert.deepEqual(await holderCutOffs(f.input), positive);
  for (const candidate of [socket, "/runtime/default.holder.sock", `/runtime/default.holder.${"a".repeat(32)}.sock`]) {
    assert.equal(holderSocketOf(DEFAULT_SOCKET, candidate), true);
  }
  for (const candidate of ["/other/default.holder.sock", H2_SOCKET, DEFAULT_SOCKET, "/runtime/default.holder.1234abcD.sock"]) {
    assert.equal(holderSocketOf(DEFAULT_SOCKET, candidate), false);
  }
  assert.equal(holderSocketOf("/runtime/x.control", "/runtime/x.holder.sock"), false);
});

test("U3 cut-off: every member needs a valid list and every listing vetoes", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff({ names: ["local", "h2"] });
  assert.deepEqual(await holderCutOffs(f.input), positive);
  for (const [answer, reason] of [
    [status("core-h2", 401, [{ pid: 222 }]), null],
    [{ none: true }, "its core did not answer"],
    [{ error: "disconnected" }, "its core did not answer"],
    [{ status: { core: { id: "core-h2" }, holders: [] } }, "its core did not answer"],
    [{ status: { core: { id: "core-h2" }, pid: 401 } }, "its core does not list its holder processes"],
    [status("core-h2", 401, null), "its core gave an unreadable holder list"],
    [status("core-h2", 401, [{ pid: "222" }]), "its core gave an unreadable holder list"],
    [status("core-local", 401), "pool membership is ambiguous"],
  ]) {
    f.answers.set(H2_SOCKET, answer);
    const result = await holderCutOffs(f.input);
    if (reason) assertUnchecked(result, reason, ["local", "h2"]);
    else assert.deepEqual(result, empty);
  }
  f.answers.set(H2_SOCKET, status("core-h2", 401));
  f.sockets.set("h2", DEFAULT_SOCKET);
  const before = f.calls.length;
  assertUnchecked(await holderCutOffs(f.input), "pool membership is ambiguous", ["local", "h2"]);
  assert.equal(f.calls.length, before, "shared canonical address is rejected before RPC");
});

test("U4 cut-off: recheck ties the holder and core identities to both observations", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff();
  assert.deepEqual(await holderCutOffs(f.input), positive);
  for (const entry of [null, { ...hold(), starttime: "1001" }, hold(222, "/runtime/default.holder.12345678.sock")]) {
    f.tables[1] = entry ? [entry] : [];
    assert.deepEqual(await holderCutOffs(f.input), empty);
  }
  f.tables[1] = [hold()];
  f.answers.set(DEFAULT_SOCKET, (read) => status("core-local", 400, read ? [{ pid: 222 }] : []));
  assert.deepEqual(await holderCutOffs(f.input), empty);
  f.answers.set(DEFAULT_SOCKET, (read) => status("core-local", 400 + read));
  assertUnchecked(await holderCutOffs(f.input), "its core changed between the reads");
  f.answers.set(DEFAULT_SOCKET, (read) => read ? { none: true } : status());
  assertUnchecked(await holderCutOffs(f.input), "its core did not answer");
  f.answers.set(DEFAULT_SOCKET, (read) => read ? status() : { none: true });
  assertUnchecked(await holderCutOffs(f.input), "its core did not answer");
});

test("U4b cut-off: only live direct children from the second table count", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff();
  const child = (pid, ppid = 222, state = "S") => ({ pid, ppid, state, exe: EXE });
  f.tables[0].push(child(801), child(802));
  for (const count of [0, 1, 3]) {
    f.tables[1] = [hold(), child(810, 222, "Z"), child(811, 222, "X"), child(812, 813),
      ...Array.from({ length: count }, (_, i) => child(820 + i))];
    assert.deepEqual(await holderCutOffs(f.input), { ...empty, holders: [{ holder: "local", pid: 222, programs: count }] });
  }
});

test("U5 cut-off: exact neutral header, unchecked reasons and zero, singular and plural hints", async () => {
  const { cutOffLines, CUT_OFF_REASONS } = await spread();
  const one = "  local: No pool core listed holder process 222 in either read. At the second read it had ";
  const warning = " They may include working agents. Verify that the previous agent stopped before starting it again.";
  const holders = [0, 1, 3].map((programs) => ({ holder: "local", pid: 222, programs }));
  const reasons = [
    "process table not readable on this system", "process table could not be read", "the check did not finish in time",
    "the pool file could not be read", "a custom core socket is set", "a core socket could not be determined",
    "its core did not answer", "pool membership is ambiguous", "its core does not list its holder processes",
    "its core gave an unreadable holder list", "its core changed between the reads",
  ];
  assert.deepEqual(Object.values(CUT_OFF_REASONS), reasons);
  const unchecked = reasons.map((reason) => ({ holder: "h2", reason }));
  assert.deepEqual(cutOffLines(empty), []);
  assert.deepEqual(cutOffLines({ ...empty, holders, unchecked }), [
    "cut-off check:", one + "no same-user live direct children. This does not establish that a previous agent stopped.",
    one + "1 same-user live direct child." + warning, one + "3 same-user live direct children." + warning,
    ...reasons.map((reason) => `  h2: not checked (${reason})`),
  ]);
});

function discoveryFixture(t) {
  const root = scratchRoot(t, "cut1432-io-");
  const home = join(root, "home"), runtime = join(root, "runtime"), state = join(root, "state"), config = join(root, "config");
  const env = { HOME: home, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state,
    AUTOMAGIK_HERDR_TEST_ROOTS: root };
  const socket = join(runtime, "herdr-core/default.sock");
  const lock = join(state, "herdr-core/default/core.lock");
  const conf = join(config, "herdr-core/config.toml");
  for (const file of [socket, lock, conf]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(socket, "");
  return { root, env, socket, lock, conf };
}

function withDiscovery(f, io, { env = io.env } = {}) {
  f.tables[0] = f.tables[1] = [hold(222, io.socket.replace(/\.sock$/, ".holder.sock"))];
  f.answers.set(io.socket, status());
  return cliReaders().then(({ cutOffEndpoints }) => {
    f.input.discover = (member, check) => cutOffEndpoints(env, member, check);
  });
}

test("U6 cut-off: a canonical alias is contacted once in each observation", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  const alias = join(dirname(io.socket), "alias.sock");
  symlinkSync(io.socket, alias);
  writeFileSync(io.lock, alias + "\n");
  assert.deepEqual(await holderCutOffs(f.input), positive);
  assert.deepEqual(f.calls.map(([index, socket]) => [index, socket]), [[0, io.socket], [1, io.socket]]);
});

test("U6b cut-off: strict discovery rejects malformed, escaping and dangling lock paths", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const before = f.calls.length;
  const dangling = join(dirname(io.socket), "dangling.sock");
  symlinkSync(join(io.root, "missing.sock"), dangling);
  for (const target of ["", "relative.sock", "/outside-test.sock", dangling, ` ${io.socket}`, `${io.socket} `, `${io.socket}\r`]) {
    writeFileSync(io.lock, target + "\n");
    assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  }
  rmSync(io.lock);
  mkdirSync(io.lock);
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  assert.equal(f.calls.length, before);
});

test("U6c cut-off: an advertised non-sock alias is rejected before canonical deduplication", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const alias = join(dirname(io.socket), "x.control");
  symlinkSync(io.socket, alias);
  writeFileSync(io.lock, alias + "\n");
  const before = f.calls.length;
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  assert.equal(f.calls.length, before);
});

test("U6d cut-off: strict discovery parses an escaped configured socket and rejects indeterminate config", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const before = f.calls.length;
  writeFileSync(io.conf, String.raw`"\u0073ocket" = "${io.socket}"` + "\n");
  assertUnchecked(await holderCutOffs(f.input), "a custom core socket is set");
  writeFileSync(io.conf, "notes = [\n");
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  assert.equal(f.calls.length, before);
});

test("U6e cut-off: an answering default does not cover a timed-out or disagreeing lock endpoint", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  const lockSocket = join(dirname(io.socket), "lock.sock");
  writeFileSync(lockSocket, "");
  writeFileSync(io.lock, lockSocket);
  f.answers.set(lockSocket, status());
  assert.deepEqual(await holderCutOffs(f.input), positive);
  f.answers.set(lockSocket, () => { f.advance(4000); return { error: "timeout" }; });
  assertUnchecked(await holderCutOffs(f.input), "the check did not finish in time");
  for (const answer of [status("other-id"), status("core-local", 401)]) {
    f.answers.set(lockSocket, answer);
    assertUnchecked(await holderCutOffs(f.input), "pool membership is ambiguous");
  }
});

test("U6f cut-off: member sessions use the exact stored name and the pool is reread", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff({ names: ["local", "team_a"] });
  f.sockets.set("team_a", H2_SOCKET);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const valid = f.input.members();
  f.input.members = () => ({ ...valid, holders: [valid.holders[0], { ...valid.holders[1], session: "am-holder-other" }] });
  assertUnchecked(await holderCutOffs(f.input), "the pool file could not be read", ["local", "team_a"]);
  let reads = 0;
  f.input.members = () => (++reads === 1 ? valid : { ...valid, holders: [valid.holders[0]] });
  assertUnchecked(await holderCutOffs(f.input), "its core changed between the reads", ["local", "team_a"]);
});

test("D1432-3 cut-off: an oversized lock leaves the socket unchecked", async (t) => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff(), io = discoveryFixture(t);
  await withDiscovery(f, io);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const before = f.calls.length;
  writeFileSync(io.lock, `${io.socket}\n${" ".repeat(128 * 1024)}`);
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  assert.equal(f.calls.length, before);
});

async function procFixture(t) {
  const { cutOffProcTable } = await cliReaders();
  const root = scratchRoot(t, "cut1432-proc-");
  const roots = [join(root, "first"), join(root, "second")];
  const env = { AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_PROC_ROOT: JSON.stringify(roots) };
  for (const dir of roots) {
    writeFixtureProcRoot(dir, [[DEFAULT_SOCKET, 900]]);
    writeFixtureProc(dir, 400, { fd: { 3: 900 } });
    writeFixtureProc(dir, 222, { argv: hold().argv });
    writeFixtureProc(dir, 223, { ppid: 222, state: "Z" });
    writeFixtureProc(dir, 224, { ppid: 222, uid: process.getuid() + 1 });
  }
  const f = fakeCutOff();
  f.input.proc = (index, check) => cutOffProcTable(env, index, check);
  return { ...f, root, roots, env };
}

test("U7 cut-off: a second valid candidate cannot survive an executable or namespace mismatch", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff();
  for (const table of f.tables) table.push(hold(223));
  const two = { ...positive, holders: [...positive.holders, { holder: "local", pid: 223, programs: 0 }] };
  assert.deepEqual(await holderCutOffs(f.input), two);
  f.tables[1][1] = { ...hold(223), exe: "/different/prefix/herdr-core" };
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
  f.tables[1][1] = hold(223);
  const original = f.input.proc;
  f.input.proc = (index) => ({ ...original(index), namespaceOf: ({ pid }) => index && pid === 223 ? "pid:[405]" : NAMESPACE });
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
});

test("U7b cut-off: every core needs a comparable namespace and a reported PID must own the endpoint", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  f.answers.set(DEFAULT_SOCKET, status("core-local", 222));
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  f.answers.set(DEFAULT_SOCKET, status());
  const fd = join(f.roots[0], "400/fd/3");
  unlinkSync(fd);
  symlinkSync("socket:[901]", fd);
  assertUnchecked(await holderCutOffs(f.input), "a core socket could not be determined");
  unlinkSync(fd);
  symlinkSync("socket:[900]", fd);
  const ns = join(f.roots[0], "400/ns/pid");
  unlinkSync(ns);
  symlinkSync("pid:[405]", ns);
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");

  const two = fakeCutOff({ names: ["local", "h2"] });
  assert.deepEqual(await holderCutOffs(two.input), positive);
  const proc = two.input.proc;
  two.input.proc = (index) => ({ ...proc(index), coreProof: (pid) => ({ exe: EXE, namespace: pid === 400 ? NAMESPACE : "pid:[405]" }) });
  assertUnchecked(await holderCutOffs(two.input), "process table could not be read", ["local", "h2"]);
});

test("U7c cut-off: a truncated child stat or unreadable same-UID process makes the table incomplete", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  for (const root of f.roots) writeFixtureProc(root, 300, { ppid: 222 });
  const oneChild = { ...positive, holders: [{ holder: "local", pid: 222, programs: 1 }] };
  assert.deepEqual(await holderCutOffs(f.input), oneChild);
  const childStat = join(f.roots[1], "300/stat");
  writeFileSync(childStat, "300 (child) S 222 0\n");
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
  writeFileSync(childStat, fixtureProcStat(300, { ppid: 222 }));
  for (const file of ["status", "stat", "cmdline", "exe"]) {
    const path = join(f.roots[1], "300", file);
    renameSync(path, path + ".bak");
    assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
    renameSync(path + ".bak", path);
  }
  assert.deepEqual(await holderCutOffs(f.input), oneChild);
});

test("U7d cut-off: fixture process directories, followed files and readlink parents cannot escape", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const paths = ["222", "222/status", "222/stat", "222/cmdline", "self", "self/ns", "222/ns", "400/ns", "400/fd", "net/unix"];
  for (const path of paths) {
    const from = join(f.roots[0], path), to = join(f.roots[1], path);
    renameSync(from, from + ".bak");
    symlinkSync(to, from);
    assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
    unlinkSync(from);
    renameSync(from + ".bak", from);
  }
});

test("U7e cut-off: test mode never replaces a missing fixture with the host process table", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const before = f.calls.length;
  delete f.env.AUTOMAGIK_HERDR_PROC_ROOT;
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
  assert.equal(f.calls.length, before);
});

test("D1432-2 cut-off: matching PID namespaces still require comparable mount namespaces and roots", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  assert.deepEqual(await holderCutOffs(f.input), positive);

  const mount = join(f.roots[0], "222/ns/mnt");
  const originalMount = readlinkSync(mount);
  unlinkSync(mount);
  symlinkSync("mnt:[999]", mount);
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");

  unlinkSync(mount);
  symlinkSync(originalMount, mount);
  const coreRoot = join(f.roots[0], "400/root");
  unlinkSync(coreRoot);
  symlinkSync("../222", coreRoot);
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
});

test("D1432-3 cut-off: a valid but oversized process file leaves the table unchecked", async (t) => {
  const { holderCutOffs } = await spread();
  const f = await procFixture(t);
  assert.deepEqual(await holderCutOffs(f.input), positive);
  const before = f.calls.length;
  writeFileSync(join(f.roots[0], "222/status"), `Name:\tfake\nUid:\t${process.getuid()}\t0\t0\t0${" ".repeat(128 * 1024)}\n`);
  assertUnchecked(await holderCutOffs(f.input), "process table could not be read");
  assert.equal(f.calls.length, before);
});

test("U8 cut-off: a late final RPC or final process read discards the observation", async () => {
  const { holderCutOffs } = await spread();
  const f = fakeCutOff();
  assert.deepEqual(await holderCutOffs(f.input), positive);
  f.answers.set(DEFAULT_SOCKET, (index) => { if (index) f.advance(4000); return status(); });
  assertUnchecked(await holderCutOffs(f.input), "the check did not finish in time");
  f.answers.set(DEFAULT_SOCKET, status());

  const original = f.input.proc;
  f.input.proc = (index) => {
    const table = original(index);
    if (index) f.advance(4000);
    return table;
  };
  const before = f.calls.length;
  assertUnchecked(await holderCutOffs(f.input), "the check did not finish in time");
  assert.equal(f.calls.length - before, 1, "a late table read prevents further RPC");

  f.input.proc = (index) => ({ ...original(index), namespaceOf() { if (index) f.advance(4000); return NAMESPACE; } });
  assertUnchecked(await holderCutOffs(f.input), "the check did not finish in time");
});

test("U9 cut-off: the recheck delay is bounded and only a candidate schedules a second read", async () => {
  const { cutOffRecheckMs, holderCutOffs } = await spread();
  for (const [value, expected] of [[-1, 5000], [0, 0], [60000, 60000], [60001, 5000], [1.5, 5000], ["", 5000], ["0", 0]]) {
    assert.equal(cutOffRecheckMs(value), expected);
  }
  const f = fakeCutOff();
  f.input.recheckMs = "60000";
  assert.deepEqual(await holderCutOffs(f.input), { ...positive, recheckMs: 60000 });
  assert.deepEqual(f.processes, [0, 1]);
  assert.deepEqual(f.waits, [60000]);
  f.answers.set(DEFAULT_SOCKET, status("core-local", 400, [{ pid: 222 }]));
  assert.deepEqual(await holderCutOffs(f.input), { ...empty, recheckMs: 60000 });
  assert.deepEqual(f.processes, [0, 1, 0]);
  assert.deepEqual(f.waits, [60000]);
});

test("U10 cut-off: the observation runs at most four RPCs at once", async () => {
  const { holderCutOffs } = await spread();
  const names = ["local", "h2", "h3", "h4", "h5", "h6"];
  const f = fakeCutOff({ names });
  for (const [i, name] of names.slice(2).entries()) {
    const endpoint = `/runtime/am-holder-${name}.sock`;
    f.sockets.set(name, endpoint);
    f.answers.set(endpoint, status(`core-${name}`, 402 + i));
  }
  const rpc = f.input.rpc;
  let active = 0, peak = 0;
  f.input.rpc = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    try { return await rpc(...args); }
    finally { active -= 1; }
  };
  assert.deepEqual(await holderCutOffs(f.input), positive);
  assert.equal(peak, 4);
  assert.equal(f.calls.length, 12);
});
