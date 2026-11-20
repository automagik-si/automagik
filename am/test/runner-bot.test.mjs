// Bot identities, durable slots and switch frames with fake tools. Apache-2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer, listenServer, start, validateConfig } from "../runner/main.mjs";
import { BOT_ID_RE, PROTOCOL_VERSION, PROTOCOL_VERSIONS, parseRequest } from "../runner/proto.mjs";
import { PROVISION_RELS, SWITCH_GUARD, createRunner, idsFor, layoutOf, openState } from "../runner/spawn.mjs";
import { base, clientExit, fakeBin, prepareDirs, rawRequest, testConfig, testHost } from "./runner-helpers.mjs";

const alice = { kind: "member", name: "alice" };
const bot = { kind: "bot", id: "b-abcdefghij" };
const otherBot = { kind: "bot", id: "session-12345678-abcd-abcd-abcd-123456789abc" };
const uidStart = 9001;
const gidStart = 9101;
const proof = { challenge: async () => true };

function request(identity, cwd, argv = ["/bin/true"], v = 2) {
  return { v, ...(v === 1 ? { member: identity.name } : { identity }), cwd, argv, timeoutMs: 5000 };
}

function fixture(t, { config: extra = {}, botSlot = 0, botUids = {}, memberUids = {} } = {}) {
  const root = base(t);
  const bin = fakeBin(t);
  const config = testConfig(root, { uidStart, gidStart, ...extra });
  prepareDirs(config);
  const logs = [];
  const host = testHost({
    root,
    bin,
    botUids: { [bot.id]: uidStart + botSlot, [otherBot.id]: uidStart + 1, ...botUids },
    memberUids: { alice: uidStart, ...memberUids },
    log: (line) => logs.push(line),
  });
  return { root, bin, config, host, logs };
}

function seed(f, record = {}) {
  const state = { v: 1, uidStart, uidCount: f.config.uidCount, gidStart, members: {}, ...record };
  fs.writeFileSync(f.config.state, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(f.config.state, 0o600);
}

const disk = (f) => JSON.parse(fs.readFileSync(f.config.state, "utf8"));

async function listen(t, f) {
  const instance = createServer(f.config, f.host, { proof });
  const { server } = instance;
  await listenServer(server, f.config.socket);
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(() => server.listening && close());
  return {
    close,
    run: (identity, argv, { cwd = layoutOf(f.config, identity).area, v = 2, timeoutMs = 5000 } = {}) =>
      rawRequest(f.config.socket, { ...request(identity, cwd, argv, v), timeoutMs }),
  };
}

function refused(result, code) {
  assert.equal(clientExit(result), 125);
  assert.deepEqual(result.frames.map((frame) => frame.t), ["error"]);
  assert.equal(result.error.code, code);
  return result.error.message;
}

function started(result, kind, name, slot, code = 0) {
  assert.equal(clientExit(result), code);
  assert.equal(result.error, null);
  assert.equal(result.exit.code, code);
  const start = result.frames[0];
  assert.deepEqual(start, {
    t: "start", [kind]: name, uid: uidStart + slot, gid: gidStart + slot,
    mode: "subuid", run: start.run, unit: `am-${kind}-${start.run}`,
  });
  assert.match(start.run, /^[0-9a-f]{12}$/);
  assert.deepEqual(result.frames.filter((frame) => frame.t === "start" || frame.t === "exit"), [start, result.exit]);
  assert.equal(result.frames.at(-1), result.exit);
}

test("parses v1 and v2 members and both Bot registry id shapes", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.deepEqual(PROTOCOL_VERSIONS, [1, 2]);
  const fields = { argv: ["sh", "-c", "id -u"], cwd: "/work", env: { LANG: "C" }, timeoutMs: 5000 };
  for (const [wire, identity] of [
    [{ v: 1, member: "alice" }, alice],
    [{ v: 2, identity: alice }, alice],
    [{ v: 2, identity: bot }, bot],
    [{ v: 2, identity: otherBot }, otherBot],
  ]) {
    assert.deepEqual(parseRequest(JSON.stringify({ ...wire, ...fields }), { maxTimeoutMs: 5000 }), { identity, ...fields });
  }
});

test("refuses a wrong version, mixed fields and malformed identities before argv checks", () => {
  const parse = (value) => parseRequest(JSON.stringify(value), {});
  for (const value of [null, [], "request"]) assert.throws(() => parse(value), { code: "BAD_REQUEST", message: /not an object/ });
  assert.throws(() => parseRequest("{", {}), { code: "BAD_REQUEST", message: /not JSON/ });
  for (const v of [3, "2"]) assert.throws(() => parse({ v, extra: true }), { code: "BAD_VERSION", message: "v must be 1 or 2" });
  for (const [value, field] of [
    [{ v: 2, member: "alice", identity: bot }, "member"],
    [{ v: 1, member: "alice", identity: alice }, "identity"],
    [{ v: 1, extra: 1 }, "extra"],
  ]) {
    assert.throws(() => parse(value), { code: "BAD_REQUEST", message: `unknown field ${field}` });
  }
  for (const identity of [
    null, [], "alice", { id: bot.id }, { kind: "bot", id: bot.id, extra: true },
    { kind: "owner", name: "alice" }, { kind: "member", name: ".alice" },
    { kind: "member", name: "Alice" }, { kind: "bot", name: bot.id }, { kind: "member", id: "alice" },
    ...["unfold-root", "../x", ".bots", "B-ABCDEFGHIJ", "b-abc", "b-abcdefghij/x",
      `session-${"a".repeat(35)}`, "b-abcdefghij\n", 1].map((id) => ({ kind: "bot", id })),
  ]) {
    assert.throws(() => parse({ v: 2, identity }), { code: "BAD_REQUEST", message: /identity|bot id|member/ }, JSON.stringify(identity));
  }
});

test("Bot id syntax matches the registry", async () => {
  const { BOT_ID } = await import("../../apps/bots-dsh/src/shared/registry.js");
  assert.equal(BOT_ID_RE.source, BOT_ID.source);
});

test("a Bot gets its own layout, environment, uid and gid through the socket", async (t) => {
  const f = fixture(t);
  const server = await listen(t, f);
  const result = await server.run(bot, ["/bin/sh", "-c", 'pwd; printf "%s\n" "$HOME" "$USER" "$LOGNAME"']);
  started(result, "bot", bot.id, 0);
  const home = join(f.config.homesRoot, ".bots", bot.id);
  const area = join(f.config.workRoot, ".bots", bot.id);
  assert.equal(result.output.out, `${area}\n${home}\n${bot.id}\n${bot.id}\n`);
  for (const path of [home, area, ...PROVISION_RELS.map((rel) => join(home, rel))]) {
    const info = f.host.fs.lstatSync(path);
    assert.equal(info.mode & 0o7777, 0o700, path);
    assert.equal(info.uid, uidStart, path);
  }
  for (const root of [f.config.homesRoot, f.config.workRoot]) {
    const info = f.host.fs.lstatSync(join(root, ".bots"));
    assert.equal(info.mode & 0o7777, 0o711);
    assert.equal(info.uid, f.host.uid);
  }
  const calls = f.bin.calls("unshare");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].filter((arg) => arg.startsWith("--map-")), [
    `--map-users=${uidStart}:${uidStart}:1`, `--map-groups=${gidStart}:${gidStart}:1`,
  ]);
  assert.deepEqual(calls[1].slice(calls[1].indexOf("--setgid"), calls[1].indexOf("--")), [
    "--setgid", String(gidStart), "--setuid", String(uidStart),
  ]);
  assert.ok(f.logs.some((line) => line.includes(`bot=${bot.id} uid=${uidStart} exit=0`)));
});

test("members and Bots share the range in separate namespaces", (t) => {
  const f = fixture(t);
  const runner = createRunner(f.config, f.host);
  const expectSlot = (identity, slot) =>
    assert.deepEqual(runner.idsFor(identity), { uid: uidStart + slot, gid: gidStart + slot });
  expectSlot("alice", 0);
  assert.deepEqual(disk(f), { v: 1, uidStart, uidCount: 8, gidStart, members: { alice: 0 } });
  expectSlot(bot, 1);
  expectSlot("bob", 2);
  expectSlot(bot.id, 3);
  expectSlot("constructor", 4);
  const members = { alice: 0, bob: 2, [bot.id]: 3, constructor: 4 };
  const bots = { [bot.id]: 1 };
  assert.deepEqual(runner.state.members, members);
  assert.deepEqual(runner.state.bots, bots);
  assert.deepEqual(disk(f), { v: 2, uidStart, uidCount: 8, gidStart, members, bots });
  assert.equal(layoutOf(f.config, bot.id).home, join(f.config.homesRoot, bot.id));
  assert.equal(layoutOf(f.config, bot).home, join(f.config.homesRoot, ".bots", bot.id));
});

test("a v1 state serves both member protocols and keeps the Bot slot after restart", async (t) => {
  const f = fixture(t, { botSlot: 1 });
  seed(f, { members: { alice: 0 } });
  const { home, area } = layoutOf(f.config, alice);
  fs.mkdirSync(home, 0o700);
  fs.mkdirSync(area, 0o700);
  const shell = ["/bin/sh", "-c", 'printf "%s\n" "$HOME"; pwd'];
  const first = await listen(t, f);
  for (const v of [1, 2]) {
    const result = await first.run(alice, shell, { v });
    started(result, "member", alice.name, 0);
    assert.equal(result.output.out, `${home}\n${area}\n`);
  }
  assert.equal(disk(f).v, 1);
  started(await first.run(bot), "bot", bot.id, 1);
  await first.close();
  const restart = await listen(t, f);
  started(await restart.run(bot), "bot", bot.id, 1);
  started(await restart.run(alice), "member", alice.name, 0);
  assert.deepEqual(disk(f).bots, { [bot.id]: 1 });
});

test("a full range refuses a Bot without an unshare call", async (t) => {
  const f = fixture(t, { config: { uidCount: 1, gidCount: 1 } });
  const server = await listen(t, f);
  started(await server.run(alice), "member", alice.name, 0);
  const calls = f.bin.calls("unshare").length;
  assert.equal(refused(await server.run(bot), "RANGE_FULL"), `no free uid left in the range for bot ${bot.id}`);
  assert.equal(f.bin.calls("unshare").length, calls);
});

test("a member and a Bot cannot request cwd in another identity's area", async (t) => {
  const f = fixture(t);
  const server = await listen(t, f);
  for (const cwd of [layoutOf(f.config, alice).area, layoutOf(f.config, otherBot).area, join(f.config.workRoot, ".bots")]) {
    assert.equal(refused(await server.run(bot, undefined, { cwd }), "BAD_CWD"), `cwd is outside bot ${bot.id}'s area`);
  }
  refused(await server.run(alice, undefined, { cwd: layoutOf(f.config, bot).area }), "BAD_CWD");
  assert.deepEqual(f.bin.calls("unshare"), []);
});

test("another Bot's home and planted files stay out of the child environment", async (t) => {
  const f = fixture(t);
  const server = await listen(t, f);
  started(await server.run(bot), "bot", bot.id, 0);
  const aHome = layoutOf(f.config, bot).home;
  fs.writeFileSync(join(aHome, ".npmrc"), "planted-value\n");
  const result = await server.run(otherBot, ["/usr/bin/env"]);
  started(result, "bot", otherBot.id, 1);
  assert.ok(result.output.out.split("\n").includes(`HOME=${layoutOf(f.config, otherBot).home}`));
  for (const text of [aHome, ".npmrc", "planted-value"]) assert.ok(!result.output.out.includes(text));
});

test("invalid state versions, Bot ids and duplicate slots are refused at start", (t) => {
  const f = fixture(t);
  for (const [record, message] of [
    [{ v: 3, bots: {} }, /has an unknown version$/],
    [{ v: 1, bots: {} }, /was made for another range$/],
    [{ v: 2 }, /was made for another range$/],
    [{ v: 2, bots: [] }, /was made for another range$/],
    [{ v: 2, members: { alice: 0 }, bots: { [bot.id]: 0 } }, /has a bad slot$/],
    [{ v: 2, bots: { "unfold-root": 0 } }, /names a bad Bot id$/],
    [{ v: 2, bots: { [bot.id]: 8 } }, /has a bad slot$/],
  ]) {
    seed(f, record);
    assert.throws(() => createRunner(f.config, f.host), { code: "STATE_INVALID", message }, JSON.stringify(record));
  }
});

const overlappingRoots = { code: "ROOT_INVALID", message: "homesRoot and workRoot must be disjoint" };

test("overlapping homes and work roots refuse startup before creating folders or state", async (t) => {
  const root = base(t);
  const bin = fakeBin(t);
  const host = testHost({ root, bin });
  for (const [homes, work] of [
    ["homes", "homes/.bots"], ["work/.bots", "work"], ["homes", "homes"], ["homes", "homes/child"],
    ["homes", "work/../homes"],
  ]) {
    const config = testConfig(root, { homesRoot: `${root}/${homes}`, workRoot: `${root}/${work}` });
    assert.throws(() => validateConfig(config), overlappingRoots);
    await assert.rejects(start(config, host), overlappingRoots);
    assert.throws(() => createRunner(config, host), overlappingRoots);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("realpath aliases of a root refuse startup before creating folders or state", async (t) => {
  const f = fixture(t);
  const alias = join(f.root, "alias");
  fs.symlinkSync(f.config.homesRoot, alias);
  for (const workRoot of [alias, join(alias, ".bots")]) {
    assert.throws(() => createRunner({ ...f.config, workRoot }, f.host), overlappingRoots);
    await assert.rejects(start({ ...f.config, workRoot }, f.host), overlappingRoots);
    assert.deepEqual(fs.readdirSync(f.config.homesRoot), []);
    assert.deepEqual(fs.readdirSync(f.config.workRoot), []);
    assert.equal(fs.existsSync(f.config.state), false);
  }
});

test("a socket folder inside a Bot root is refused and keeps its mode", async (t) => {
  for (const area of ["homesRoot", "workRoot"]) {
    const f = fixture(t);
    const folder = join(f.config[area], ".bots");
    fs.mkdirSync(folder, { mode: 0o750 });
    fs.chmodSync(folder, 0o750);
    const config = { ...f.config, socket: join(folder, "runner.sock") };
    const inBotRoot = { code: "ROOT_INVALID", message: "the socket folder must not be in a Bot root" };
    assert.throws(() => validateConfig(config), inBotRoot, area);
    await assert.rejects(start(config, f.host), inBotRoot, area);
    assert.throws(() => createRunner(config, f.host), inBotRoot, area);
    assert.equal(fs.statSync(folder).mode & 0o777, 0o750, area);
    assert.equal(fs.existsSync(f.config.state), false, area);
  }
});

test("a root shown at a second path (a bind mount) is refused by device and inode", (t) => {
  const f = fixture(t);
  const botHomes = join(f.config.homesRoot, ".bots");
  fs.mkdirSync(botHomes, { mode: 0o711 });
  const real = f.host.fs;
  const mounted = Object.create(real);
  mounted.lstatSync = (path, options) => real.lstatSync(path === f.config.workRoot ? botHomes : path, options);
  assert.throws(
    () => createRunner(f.config, { ...f.host, fs: mounted }),
    { code: "ROOT_INVALID", message: /Bot homes root .* is the same folder as the work root$/ },
  );
  assert.equal(fs.existsSync(f.config.state), false);
  assert.deepEqual(fs.readdirSync(f.config.workRoot), []);
});

test("the switch guard the runner launches refuses a symlink out with no marker and no payload", (t) => {
  const root = base(t);
  const area = join(root, "area");
  fs.mkdirSync(area);
  fs.mkdirSync(join(root, "outside"));
  fs.symlinkSync(join(root, "outside"), join(area, "escape"));
  const ran = join(root, "ran");
  const enter = (target) => spawnSync("/bin/sh", ["-c", SWITCH_GUARD, "am-enter", area, target, "/usr/bin/touch", ran], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const out = enter(join(area, "escape"));
  assert.equal(out.status, 125);
  assert.equal(out.output[3].length, 0);
  assert.equal(fs.existsSync(ran), false);
  const inside = enter(area);
  assert.equal(inside.status, 0);
  assert.equal(inside.output[3].toString(), "switched\n");
  assert.equal(fs.existsSync(ran), true);
});

test("unrecorded or wrongly owned Bot folders and unsafe .bots roots refuse start", (t) => {
  const f = fixture(t, { botSlot: 1 });
  const { home } = layoutOf(f.config, bot);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  seed(f);
  assert.throws(() => createRunner(f.config, f.host), { code: "STATE_INVALID", message: /bot b-abcdefghij has a home but no recorded uid/ });
  seed(f, { v: 2, bots: { [bot.id]: 0 } });
  assert.throws(() => createRunner(f.config, f.host), { code: "STATE_INVALID", message: /owned by uid 9002, not its recorded uid 9001/ });
  const linked = fixture(t);
  fs.symlinkSync(linked.config.workRoot, join(linked.config.homesRoot, ".bots"));
  assert.throws(() => createRunner(linked.config, linked.host), { code: "ROOT_INVALID", message: /not a real folder/ });
  const writable = fixture(t);
  const path = join(writable.config.workRoot, ".bots");
  fs.mkdirSync(path);
  fs.chmodSync(path, 0o773);
  assert.throws(() => createRunner(writable.config, writable.host), { code: "ROOT_INVALID", message: /writable by group or others/ });
});

test("a missing state stays missing when either Bot folder scan refuses start", (t) => {
  for (const kind of ["home", "area"]) {
    const f = fixture(t);
    assert.deepEqual(openState(f.config, f.host).bots, {});
    assert.equal(fs.existsSync(f.config.state), false);
    fs.mkdirSync(layoutOf(f.config, bot)[kind], { recursive: true, mode: 0o700 });
    assert.throws(() => createRunner(f.config, f.host), { code: "STATE_INVALID", message: /no recorded uid/ }, kind);
    assert.equal(fs.existsSync(f.config.state), false);
  }
});

test("a visible write failure blocks new slots until the state can be synced on restart", (t) => {
  const f = fixture(t);
  seed(f, { members: { alice: 0 } });
  const state = openState(f.config, f.host);
  const broken = Object.create(f.host.fs);
  broken.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("folder sync failed");
    fs.fsyncSync(fd);
  };
  const brokenHost = { ...f.host, fs: broken };
  assert.throws(() => idsFor(f.config, brokenHost, state, bot), { code: "STATE_INVALID", visible: true });
  assert.deepEqual(disk(f).bots, { [bot.id]: 1 });
  assert.deepEqual(state.bots, {});
  assert.ok(!Object.keys(state).includes("poisoned"));
  for (const who of [bot, "bob"]) {
    assert.throws(() => idsFor(f.config, f.host, state, who), { code: "STATE_INVALID", message: /restart the runner/ });
  }
  assert.deepEqual(idsFor(f.config, f.host, state, alice), { uid: uidStart, gid: gidStart });
  assert.throws(() => createRunner(f.config, brokenHost), { code: "STATE_INVALID", message: /folder sync failed/ });
  const fresh = createRunner(f.config, f.host);
  assert.deepEqual(fresh.idsFor(bot), { uid: uidStart + 1, gid: gidStart + 1 });
  assert.deepEqual(fresh.idsFor("bob"), { uid: uidStart + 2, gid: gidStart + 2 });
});

test("a Bot write failure before rename leaves memory and disk untouched", (t) => {
  const f = fixture(t);
  const runner = createRunner(f.config, f.host);
  f.host.fs.fsyncSync = () => { throw new Error("file sync failed"); };
  assert.throws(() => runner.idsFor(bot), { code: "STATE_INVALID", message: /file sync failed/ });
  assert.deepEqual(runner.state.bots, {});
  assert.equal(disk(f).v, 1);
  assert.ok(!Object.hasOwn(disk(f), "bots"));
  assert.deepEqual(f.bin.calls("unshare"), []);
  delete f.host.fs.fsyncSync;
  assert.deepEqual(runner.idsFor(bot), { uid: uidStart, gid: gidStart });
});

function amendFake(f, name, previous, replacement) {
  const path = join(f.bin.dir, name);
  const original = fs.readFileSync(path, "utf8");
  assert.ok(original.includes(previous));
  fs.writeFileSync(path, original.replace(previous, () => replacement));
}

test("a failed or timed-out systemd help probe refuses startup before any launch", (t) => {
  for (const [command, timeout] of [["exit 1", 10000], ["exec /bin/sleep 1", 25]]) {
    const f = fixture(t);
    amendFake(f, "systemd-run", 'if [ "$1" = "--help" ]; then exit 0; fi',
      `if [ "$1" = "--help" ]; then ${command}; fi`);
    const { spawnSync } = f.host;
    let help;
    f.host.spawnSync = (file, args, options) => {
      if (file !== join(f.bin.dir, "systemd-run")) return spawnSync(file, args, options);
      help = spawnSync(file, args, { ...options, timeout });
      return help;
    };
    f.host.spawn = () => assert.fail("the runner launched a child");
    assert.throws(() => createRunner(f.config, f.host), { code: "TOOL_MISSING", message: "systemd-run --help failed" });
    if (timeout === 25) assert.equal(help.error?.code, "ETIMEDOUT");
    else assert.equal(help.status, 1);
    assert.deepEqual(f.bin.calls("systemd-run"), []);
    assert.deepEqual(f.bin.calls("unshare"), []);
    assert.equal(fs.existsSync(f.config.state), false);
  }
});

test("a short state write followed by ENOSPC refuses allocation without changing the slot map", (t) => {
  const f = fixture(t);
  const runner = createRunner(f.config, f.host);
  runner.idsFor(alice);
  const bytes = fs.readFileSync(f.config.state);
  const state = structuredClone(runner.state);
  let writes = 0;
  f.host.fs.writeSync = (fd, buf, offset, length) => {
    assert.equal(offset, writes * 7);
    assert.equal(length, buf.length - offset);
    if (++writes === 1) return fs.writeSync(fd, buf, offset, 7);
    throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  };
  assert.throws(() => runner.idsFor(bot), { code: "STATE_INVALID", message: /ENOSPC/ });
  assert.equal(writes, 2);
  assert.deepEqual(fs.readFileSync(f.config.state), bytes);
  assert.deepEqual(runner.state, state);
  assert.deepEqual(f.bin.calls("unshare"), []);
  assert.equal(fs.existsSync(layoutOf(f.config, bot).home), false);
  delete f.host.fs.writeSync;
  assert.deepEqual(runner.idsFor(bot), { uid: uidStart + 1, gid: gidStart + 1 });
});

test("startup refuses group- and other-writable v2 state before reading it", (t) => {
  for (const mode of [0o664, 0o646]) {
    const f = fixture(t);
    seed(f, { v: 2, bots: { [bot.id]: 0 } });
    fs.chmodSync(f.config.state, mode);
    f.host.fs.readFileSync = () => assert.fail("read a writable state file");
    assert.throws(() => createRunner(f.config, f.host), {
      code: "STATE_INVALID", message: /writable by group or others/,
    });
    assert.equal(fs.statSync(f.config.state).mode & 0o777, mode);
  }
});

test("a failed switch and a closed marker fd each refuse the Bot before the payload", async (t) => {
  for (const command of ["printf 'switch failed\\nsecond line\\n' >&2; exit 1", 'exec 3>&-\nexec "$@"']) {
    const f = fixture(t);
    amendFake(f, "setpriv", 'exec "$@"', command);
    const server = await listen(t, f);
    const sideEffect = join(f.root, "ran");
    const message = refused(await server.run(bot, ["/usr/bin/touch", sideEffect]), "SPAWN_FAILED");
    assert.match(message, /^the command did not start under its own uid/);
    assert.ok(!message.includes("\n") && message.length <= 200);
    assert.ok(!message.includes("second line"));
    assert.equal(f.bin.calls("setpriv").length, 1);
    assert.equal(fs.existsSync(sideEffect), false);
  }
});

test("a switched Bot keeps its exit code and a scope failure stays SCOPE_FAILED", async (t) => {
  const f = fixture(t);
  const server = await listen(t, f);
  const result = await server.run(bot, ["/bin/sh", "-c", "echo 'Failed to x' >&2; echo still-running; exit 1"]);
  started(result, "bot", bot.id, 0, 1);
  assert.deepEqual(result.output, { out: "still-running\n", err: "Failed to x\n" });
  assert.ok(!f.bin.calls("systemd-run").at(-1).includes("--expand-environment=no"));
  f.bin.failScope();
  assert.equal(refused(await server.run(bot), "SCOPE_FAILED"), "the systemd scope could not be made");
});

test("scope expansion is disabled when advertised and literal shell variables reach the Bot", async (t) => {
  const f = fixture(t);
  amendFake(f, "systemd-run", 'if [ "$1" = "--help" ]; then exit 0; fi',
    'if [ "$1" = "--help" ]; then echo probe >> "$(dirname "$0")/help.calls"; echo "--expand-environment=BOOL"; exit 0; fi');
  const server = await listen(t, f);
  for (const arg of ["$HOME", "${HOME}"]) {
    const result = await server.run(bot, ["/usr/bin/printf", "%s", arg]);
    started(result, "bot", bot.id, 0);
    assert.equal(result.output.out, arg);
    const args = f.bin.calls("systemd-run").at(-1);
    assert.deepEqual(args.slice(0, 4), ["--user", "--scope", "--expand-environment=no", "--quiet"]);
    assert.equal(args.at(-1), arg);
  }
  assert.equal(fs.readFileSync(join(f.bin.dir, "help.calls"), "utf8"), "probe\n");
});

function framedRun(t, maxOutputBytes, timeoutMs = 5000) {
  const f = fixture(t, { config: { maxOutputBytes } });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const marker = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, marker];
  f.host.spawn = () => child;
  const runner = createRunner(f.config, f.host);
  const layout = layoutOf(f.config, bot);
  const frames = [];
  const result = { exit: null, error: null };
  const parsed = parseRequest(JSON.stringify({ ...request(bot, layout.area), timeoutMs }), f.config);
  runner.start(parsed, runner.idsFor(bot), layout, "test", {
    start: () => frames.push("start"),
    out: (chunk) => frames.push("out " + chunk),
    err: (chunk) => frames.push("err " + chunk),
    exit: (frame) => {
      result.exit = frame;
      frames.push(`exit ${frame.code} ${frame.truncated}`);
    },
    fail: (code, message) => {
      result.error = { code, message };
      frames.push(code);
    },
  });
  child.emit("spawn");
  return { child, marker, frames, result };
}

test("a split marker releases buffered stdout and stderr after start in arrival order", (t) => {
  const { child, marker, frames } = framedRun(t, 3);
  child.stdout.write("a");
  marker.write("swit");
  child.stderr.write("b");
  assert.deepEqual(frames, []);
  marker.write("ched\n");
  child.stdout.write("c");
  child.stderr.write("d");
  child.emit("close", 0, null);
  assert.deepEqual(frames, ["start", "out a", "err b", "out c", "exit 0 true"]);
});

test("an invalid marker sends just one refusal even when a valid line follows", (t) => {
  const { child, marker, frames } = framedRun(t, 1024);
  child.stderr.write("Failed to x\n");
  marker.write("unexpected\n");
  marker.write("switched\n");
  child.emit("close", 0, null);
  child.emit("error", new Error("late failure"));
  assert.deepEqual(frames, ["SPAWN_FAILED"]);
});

test("bytes after the switch marker refuse the run in coalesced and split chunks", (t) => {
  const kill = t.mock.method(process, "kill", () => {});
  for (const chunks of [["switched\nextra\n"], ["switched\n", "extra\n"]]) {
    const { child, marker, frames, result } = framedRun(t, 1024);
    child.pid = 1234;
    for (const chunk of chunks) marker.write(chunk);
    child.emit("close", 0, null);
    child.emit("error", new Error("late failure"));
    assert.deepEqual(frames, ["start", "SPAWN_FAILED"]);
    assert.deepEqual(result.error, { code: "SPAWN_FAILED", message: "the command wrote after the switch marker" });
    assert.equal(result.exit, null);
    assert.equal(clientExit(result), 125);
  }
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [[-1234, "SIGKILL"], [-1234, "SIGKILL"]]);
});

test("a deadline before the switch marker refuses the Bot before the payload", async (t) => {
  const f = fixture(t);
  amendFake(f, "setpriv", 'exec "$@"', '/bin/sleep 1\nexec "$@"');
  const server = await listen(t, f);
  const sideEffect = join(f.root, "ran");
  refused(await server.run(bot, ["/usr/bin/touch", sideEffect], { timeoutMs: 2 }), "SPAWN_FAILED");
  assert.equal(fs.existsSync(sideEffect), false);
});

test("a switch marker received after the deadline still reports a timed-out Bot run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kill = t.mock.method(process, "kill", () => {});
  const { child, marker, frames, result } = framedRun(t, 1024, 2);
  child.pid = 1234;
  child.stdout.write("a");
  t.mock.timers.tick(2);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [[-1234, "SIGKILL"]]);
  marker.write("swit");
  child.stderr.write("b");
  marker.write("ched\n");
  assert.deepEqual(frames, []);
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(frames, ["start", "out a", "err b", "exit null false"]);
  assert.equal(result.error, null);
  assert.equal(result.exit.timedOut, true);
  assert.equal(clientExit(result), 124);
});
