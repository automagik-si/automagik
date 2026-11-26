// The member runner's spawn path over a real socket, with the uid switch and systemd faked on a
// temp PATH (no setuid, no sudo, no new user, no systemd here). The proof is bypassed so the test
// can drive the request path; the proof itself has its own test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync as fsSymlink, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, listenServer } from "../runner/main.mjs";
import {
  MEMBER_GID,
  MEMBER_UID,
  accounts,
  base,
  clientExit,
  fakeBin,
  outputOf,
  prepareDirs,
  rawRequest,
  testConfig,
  testHost,
} from "./runner-helpers.mjs";

async function serve(t, { host: hostOverrides = {}, config: configOverrides = {}, dirs = {} } = {}) {
  const root = base(t);
  const bin = fakeBin(t);
  const config = testConfig(root, configOverrides);
  prepareDirs(config, dirs);
  const host = testHost({
    root,
    bin,
    accounts: accounts(),
    memberUids: { alice: MEMBER_UID, bob: MEMBER_UID + 1 },
    ...hostOverrides,
  });
  const instance = createServer(config, host, { proof: { challenge: async () => true } });
  await listenServer(instance.server, config.socket);
  t.after(() => instance.server.close());
  return { root, bin, config, host, instance };
}

const run = (s, argv, env = {}, extra = {}) =>
  rawRequest(s.config.socket, {
    v: 1,
    member: "alice",
    argv,
    cwd: join(s.config.workRoot, "alice"),
    env,
    timeoutMs: 5000,
    ...extra,
  });

test("runs the command as the member with HOME, the XDG homes and TMPDIR under its own home", async (t) => {
  const s = await serve(t);
  const result = await run(s, ["/bin/sh", "-c", "pwd; echo HOME=$HOME; echo USER=$USER"]);
  assert.equal(result.error, null);
  assert.equal(result.exit.code, 0);
  const start = result.frames.find((frame) => frame.t === "start");
  assert.equal(start.uid, MEMBER_UID);
  assert.equal(start.gid, MEMBER_GID);
  const home = join(s.config.homesRoot, "alice");
  const area = join(s.config.workRoot, "alice");
  assert.equal(result.output.out, `${area}\nHOME=${home}\nUSER=alice\n`);
  for (const path of [
    home,
    join(home, ".config"),
    join(home, ".cache"),
    join(home, ".local/share"),
    join(home, ".local/state"),
    join(home, ".local/run"),
    join(home, "tmp"),
    area,
  ]) {
    const info = statSync(path);
    assert.equal(info.uid, process.getuid(), path);
    assert.equal(info.mode & 0o7777, 0o700, path);
  }
  assert.notEqual(home, "/tmp");
  assert.ok(home.startsWith(s.config.homesRoot + "/"));
});

test("the child gets only the allowlisted request environment, never the runner's own", async (t) => {
  const s = await serve(t);
  s.host.env.DSH_TOKEN = "runner-secret";
  const result = await run(s, ["/bin/sh", "-c", "env | sort"], { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" });
  assert.equal(result.exit.code, 0);
  const lines = result.output.out.trim().split("\n");
  assert.ok(lines.includes("LANG=C.UTF-8"));
  assert.ok(lines.includes("PATH=/usr/bin:/bin"));
  assert.ok(lines.some((line) => line.startsWith("HOME=")));
  assert.ok(!result.output.out.includes("runner-secret"));
  assert.ok(!result.output.out.includes("DSH_TOKEN"));
  assert.ok(!result.output.out.includes("LD_PRELOAD"));
  delete s.host.env.DSH_TOKEN;
});

test("the exit code passes through, and a scope that cannot be made is refused", async (t) => {
  const s = await serve(t);
  const seven = await run(s, ["/bin/sh", "-c", "exit 7"]);
  assert.equal(seven.exit.code, 7);
  assert.equal(clientExit(seven), 7);
  s.bin.failScope();
  const failed = await run(s, ["/bin/sh", "-c", "true"]);
  assert.equal(failed.error.code, "SCOPE_FAILED");
  assert.equal(clientExit(failed), 125);
  assert.equal(failed.exit, null);
});

test("a cwd outside the member's own area is refused before anything runs", async (t) => {
  const s = await serve(t);
  const before = s.bin.calls("unshare").length;
  const result = await run(s, ["/bin/sh", "-c", "true"], {}, { cwd: join(s.config.workRoot, "bob") });
  assert.equal(result.error.code, "BAD_CWD");
  assert.equal(clientExit(result), 125);
  assert.equal(s.bin.calls("unshare").length, before);
});

test("a bad request is one error frame, and a protocol client exits 125", async (t) => {
  const s = await serve(t);
  const result = await rawRequest(s.config.socket, { v: 1, member: "alice", argv: [], cwd: "/", timeoutMs: 5 });
  assert.equal(result.error.code, "BAD_REQUEST");
  assert.equal(clientExit(result), 125);
});

test("a request field or environment name that must not reach the child is refused", async (t) => {
  const s = await serve(t);
  for (const [extra, code] of [
    [{ extra: 1 }, "BAD_REQUEST"],
    [{ env: { HOME: "/tmp" } }, "ENV_NOT_ALLOWED"],
    [{ env: { LD_PRELOAD: "/x.so" } }, "ENV_NOT_ALLOWED"],
    [{ env: { DSH_TOKEN: "x" } }, "ENV_NOT_ALLOWED"],
    [{ argv: ["/bin/sh", "-c", "true"], timeoutMs: 0 }, "BAD_REQUEST"],
  ]) {
    const result = await rawRequest(s.config.socket, {
      v: 1,
      member: "alice",
      argv: ["/bin/sh", "-c", "true"],
      cwd: join(s.config.workRoot, "alice"),
      timeoutMs: 1000,
      ...extra,
    });
    assert.equal(result.error.code, code, JSON.stringify(extra));
  }
});

test("the member's uid is stable in the state file, and the range can fill", async (t) => {
  const s = await serve(t, { config: { uidCount: 1, gidCount: 1 } });
  const first = await run(s, ["/bin/sh", "-c", "echo ok"]);
  assert.equal(first.frames.find((frame) => frame.t === "start").uid, MEMBER_UID);
  const again = await run(s, ["/bin/sh", "-c", "echo ok"]);
  assert.equal(again.frames.find((frame) => frame.t === "start").uid, MEMBER_UID);
  const full = await rawRequest(s.config.socket, {
    v: 1,
    member: "bob",
    argv: ["/bin/sh", "-c", "true"],
    cwd: join(s.config.workRoot, "bob"),
    timeoutMs: 1000,
  });
  assert.equal(full.error.code, "RANGE_FULL");
  const state = JSON.parse(readFileSync(s.config.state, "utf8"));
  assert.deepEqual(state.members, { alice: 0 });
  assert.equal(statSync(s.config.state).mode & 0o777, 0o600);
});

test("member B's shell never gets member A's home, and a planted file is not in its environment", async (t) => {
  const s = await serve(t);
  const a = await run(s, ["/bin/sh", "-c", "printf %s \"$HOME\""]);
  assert.equal(a.output.out, join(s.config.homesRoot, "alice"));
  mkdirSync(join(s.config.homesRoot, "alice"), { recursive: true });
  for (const name of [".npmrc", ".gitconfig", ".bashrc"]) {
    writeFileSync(join(s.config.homesRoot, "alice", name), "planted\n");
  }
  const b = await rawRequest(s.config.socket, {
    v: 1,
    member: "bob",
    argv: ["/bin/sh", "-c", "echo HOME=$HOME; echo XDG=$XDG_CONFIG_HOME; env"],
    cwd: join(s.config.workRoot, "bob"),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5000,
  });
  assert.equal(b.exit.code, 0);
  assert.equal(b.frames.find((frame) => frame.t === "start").uid, MEMBER_UID + 1);
  assert.ok(b.output.out.includes(`HOME=${join(s.config.homesRoot, "bob")}`));
  assert.ok(!b.output.out.includes(join(s.config.homesRoot, "alice")));
  assert.ok(!b.output.out.includes(".npmrc"));
});

test("the scope gets MemoryMax and TasksMax, and the child enters cwd after the switch", async (t) => {
  const s = await serve(t);
  const result = await run(s, ["/bin/sh", "-c", "pwd"]);
  assert.equal(result.exit.code, 0);
  const scope = s.bin.calls("systemd-run").at(-1);
  assert.ok(scope.includes("MemoryMax=512M"));
  assert.ok(scope.includes("TasksMax=128"));
  assert.ok(scope.includes("--scope"));
  const unshare = s.bin.calls("unshare").at(-1);
  const setpriv = s.bin.calls("setpriv").at(-1);
  assert.ok(unshare.includes("--setuid"));
  assert.ok(unshare.includes(String(MEMBER_UID)));
  assert.ok(setpriv.includes("--no-new-privs"));
  assert.equal(s.bin.calls("unshare").length, 2);
});

test("a run past its timeout ends with SIGKILL and the timeout marker", async (t) => {
  const s = await serve(t);
  const result = await run(s, ["/bin/sh", "-c", "sleep 5"], {}, { timeoutMs: 150 });
  // The timeout's own report is the proof: a run that ignored the deadline would come back as a
  // plain exit 0 from the 5 s sleep, never as a SIGKILL with timedOut set.
  assert.equal(result.exit.timedOut, true);
  assert.equal(result.exit.code, null);
  assert.equal(result.exit.signal, "SIGKILL");
  assert.equal(clientExit(result), 124);
});

test("output past the cap is cut and the run is stopped", async (t) => {
  const s = await serve(t, { config: { maxOutputBytes: 1024 } });
  const result = await run(s, ["/bin/sh", "-c", "i=0; while [ $i -lt 5000 ]; do printf x; i=$((i+1)); done"]);
  assert.equal(result.exit.truncated, true);
  assert.ok(result.output.out.length <= 1024);
});

test("a home that is a symlink, a folder that is a file and a symlinked XDG folder are refused", async (t) => {
  {
    const s = await serve(t);
    mkdirSync(s.config.homesRoot, { recursive: true });
    fsSymlink("/etc/hostname", join(s.config.homesRoot, "alice"));
    const result = await run(s, ["/bin/sh", "-c", "true"]);
    assert.equal(result.error.code, "HOME_INVALID");
    assert.match(result.error.message, /symbolic link|not a real folder/);
  }
  {
    const s = await serve(t);
    writeFileSync(join(s.config.homesRoot, "alice"), "file");
    const result = await run(s, ["/bin/sh", "-c", "true"]);
    assert.equal(result.error.code, "HOME_INVALID");
    assert.match(result.error.message, /not a real folder/);
  }
  {
    const s = await serve(t);
    mkdirSync(join(s.config.homesRoot, "alice"), { recursive: true });
    chmodSync(join(s.config.homesRoot, "alice"), 0o700);
    fsSymlink("/etc", join(s.config.homesRoot, "alice", ".config"));
    const result = await run(s, ["/bin/sh", "-c", "true"]);
    assert.equal(result.error.code, "HOME_INVALID");
    assert.match(result.error.message, /symbolic link|not a real folder/);
  }
});

test("a home root under a world-writable folder is refused at start", async (t) => {
  const root = base(t);
  const bin = fakeBin(t);
  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe, { recursive: true });
  chmodSync(unsafe, 0o1777);
  const homes = join(unsafe, "homes");
  mkdirSync(homes);
  chmodSync(homes, 0o711);
  const config = testConfig(root, { uidStart: 200000, gidStart: 200000 });
  config.homesRoot = homes;
  prepareDirs(config);
  const host = { ...testHost({ root, bin, accounts: accounts() }), uid: process.getuid(), gid: process.getgid() };
  assert.throws(() => createServer(config, host, { proof: { challenge: async () => true } }), /writable by group or others/);
});

test("a state file made for another range is refused", async (t) => {
  const s = await serve(t);
  s.instance.server.close();
  writeFileSync(
    s.config.state,
    JSON.stringify({ v: 1, uidStart: 999, uidCount: 8, gidStart: MEMBER_GID, members: {} }),
  );
  assert.throws(() => createServer(s.config, s.host, { proof: { challenge: async () => true } }), /another range/);
});

test("the runner's own uid and DSH's uid may not be in the member range", async (t) => {
  const s = await serve(t);
  s.instance.server.close();
  const own = { ...s.config, uidStart: 65534 };
  assert.throws(() => createServer(own, s.host, { proof: { challenge: async () => true } }), /own uid/);
  const dsh = { ...s.config, dshUid: MEMBER_UID, uidStart: MEMBER_UID, uidCount: 2 };
  assert.throws(() => createServer(dsh, s.host, { proof: { challenge: async () => true } }), /DSH's uid/);
});

test("a request over 64 KiB and a second request line are refused", async (t) => {
  const s = await serve(t);
  const big = JSON.stringify({
    v: 1,
    member: "alice",
    argv: ["/bin/sh", "-c", "true"],
    cwd: join(s.config.workRoot, "alice"),
    timeoutMs: 1000,
    pad: "x".repeat(70 * 1024),
  });
  const tooLarge = await rawRequest(s.config.socket, big);
  assert.equal(tooLarge.error.code, "TOO_LARGE");
  const line = JSON.stringify({
    v: 1,
    member: "alice",
    argv: ["/bin/sh", "-c", "true"],
    cwd: join(s.config.workRoot, "alice"),
    timeoutMs: 1000,
  });
  const two = await rawRequest(s.config.socket, `${line}\n${line}\n`);
  assert.equal(two.error.code, "BAD_REQUEST");
});

test("a second shell over the concurrency cap is BUSY", async (t) => {
  const s = await serve(t, { config: { maxConcurrent: 1 } });
  const go = join(s.root, "go");
  const first = run(s, ["/bin/sh", "-c", `while [ ! -e ${go} ]; do sleep 0.1; done`], {}, { timeoutMs: 10000 });
  // A net, not the proof: the spawn call is the state awaited, and the BUSY answer below is the
  // real evidence that the first run held the cap.
  const until = Date.now() + 10_000;
  while (s.bin.calls("systemd-run").length === 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(s.bin.calls("systemd-run").length > 0, "the first run started before the second asks");
  const second = await run(s, ["/bin/sh", "-c", "true"]);
  assert.equal(second.error.code, "BUSY");
  writeFileSync(go, "");
  assert.equal((await first).exit.code, 0);
});

test("a home owned by another uid than the member's is refused", async (t) => {
  const s = await serve(t, { host: { memberUids: {} } });
  const result = await run(s, ["/bin/sh", "-c", "true"]);
  assert.equal(result.error.code, "HOME_INVALID");
  assert.match(result.error.message, /not the member's/);
});

test("a cwd that leaves the member's area through a symbolic link is refused", async (t) => {
  const s = await serve(t);
  const area = join(s.config.workRoot, "alice");
  assert.equal((await run(s, ["/bin/sh", "-c", "true"])).exit.code, 0);
  fsSymlink("/etc", join(area, "escape"));
  const result = await run(s, ["/bin/sh", "-c", "pwd"], {}, { cwd: join(area, "escape") });
  assert.equal(result.error.code, "BAD_CWD");
  assert.match(result.error.message, /symbolic link/);
});

test("a failed state write uses no uid, and a restart gives each member a different one", async (t) => {
  const s = await serve(t);
  s.instance.server.close();
  const { idsFor, openState } = await import("../runner/spawn.mjs");
  const brokenFs = Object.create(fs);
  brokenFs.fsyncSync = () => {
    throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
  };
  const broken = { ...s.host, fs: brokenFs };
  const state = openState(s.config, s.host);
  assert.throws(() => idsFor(s.config, broken, state, "alice"), /disk is full/);
  assert.deepEqual(state.members, {});
  const fresh = openState(s.config, s.host);
  const bob = idsFor(s.config, s.host, fresh, "bob");
  const alice = idsFor(s.config, s.host, fresh, "alice");
  assert.equal(bob.uid, MEMBER_UID);
  assert.notEqual(alice.uid, bob.uid);
});

test("a member home that was never recorded is refused at start", async (t) => {
  const s = await serve(t);
  s.instance.server.close();
  mkdirSync(join(s.config.homesRoot, "ghost"));
  assert.throws(
    () => createServer(s.config, s.host, { proof: { challenge: async () => true } }),
    /no recorded uid/,
  );
});

test("a home owned by another uid than its record is refused at start", async (t) => {
  const s = await serve(t);
  assert.equal((await run(s, ["/bin/sh", "-c", "true"])).exit.code, 0);
  s.instance.server.close();
  const other = testHost({
    root: s.root,
    bin: s.bin,
    accounts: accounts(),
    memberUids: { alice: MEMBER_UID + 7 },
  });
  assert.throws(
    () => createServer(s.config, other, { proof: { challenge: async () => true } }),
    /not its recorded uid/,
  );
});

test("a state file with two members on one slot is refused", async (t) => {
  const s = await serve(t);
  s.instance.server.close();
  writeFileSync(
    s.config.state,
    JSON.stringify({
      v: 1,
      uidStart: MEMBER_UID,
      uidCount: 8,
      gidStart: MEMBER_GID,
      members: { alice: 0, bob: 0 },
    }),
  );
  assert.throws(
    () => createServer(s.config, s.host, { proof: { challenge: async () => true } }),
    /bad slot/,
  );
});
