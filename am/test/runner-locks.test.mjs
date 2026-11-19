// Locks (a) and (c) at the module boundary: the folder chain, the socket and proof folder modes,
// the socket group's membership, and DSH's service account. Every refusal is a plain line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkLocks } from "../runner/locks.mjs";
import { Refusal, plain } from "../runner/proto.mjs";
import { readConfigFile, validateConfig } from "../runner/main.mjs";
import { accounts, base, fakeBin } from "./runner-helpers.mjs";

const GROUP_GID = process.getgid();

function fixture(t, { mode = 0o750, proofMode = 0o1730, accountText, config: extra = {} } = {}) {
  const root = base(t);
  const config = {
    socket: join(root, "sock", "runner.sock"),
    proofs: join(root, "proofs"),
    group: "dshsock",
    dshUid: 2000,
    workRoot: join(root, "work"),
    homesRoot: join(root, "homes"),
    state: join(root, "state.json"),
    uidStart: 200000,
    uidCount: 8,
    gidStart: 200000,
    gidCount: 8,
    limits: { memoryMax: "512M", tasksMax: 128 },
    maxTimeoutMs: 60000,
    maxOutputBytes: 1024 * 1024,
    maxConcurrent: 4,
    ...extra,
  };
  mkdirSync(join(root, "sock"), { recursive: true });
  chmodSync(join(root, "sock"), mode);
  mkdirSync(config.proofs, { recursive: true });
  chmodSync(config.proofs, proofMode);
  for (const path of [config.homesRoot, config.workRoot]) mkdirSync(path, { recursive: true });
  const bin = fakeBin(t);
  const host = {
    uid: process.getuid(),
    gid: process.getgid(),
    platform: "linux",
    fs,
    spawn,
    spawnSync,
    env: { PATH: `${bin.dir}:/usr/local/bin:/usr/bin:/bin` },
    accounts: accountText ?? accounts({ runnerGid: 4242, groupGid: GROUP_GID }),
  };
  return { root, config, host };
}

function refusal(fn, code = "LOCK_FAILED") {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("\n"), "a refusal is one plain line");
    return error.message;
  }
  assert.fail("expected a refusal");
}

test("a clean chain, a 0750 socket folder and a 1730 proof folder pass", (t) => {
  const f = fixture(t);
  const lock = checkLocks(f.config, f.host);
  assert.equal(lock.group.name, "dshsock");
  assert.equal(lock.user.name, "dsh");
  assert.equal(statSync(join(f.root, "sock")).mode & 0o7777, 0o750);
  assert.equal(statSync(f.config.proofs).mode & 0o7777, 0o1730);
});

test("a group-writable parent is refused", (t) => {
  const f = fixture(t);
  chmodSync(f.root, 0o775);
  assert.match(refusal(() => checkLocks(f.config, f.host)), /writable by group or others/);
});

test("a sticky world-writable parent, like a stock /tmp, is refused", (t) => {
  const f = fixture(t);
  chmodSync(f.root, 0o1777);
  assert.match(refusal(() => checkLocks(f.config, f.host)), /writable by group or others/);
});

test("a symlinked folder in the chain is refused", (t) => {
  const f = fixture(t);
  const real = join(f.root, "real");
  mkdirSync(real);
  chmodSync(real, 0o750);
  symlinkSync(real, join(f.root, "link"));
  f.config.socket = join(f.root, "link", "runner.sock");
  assert.match(refusal(() => checkLocks(f.config, f.host)), /is a symbolic link|is not a real folder/);
});

test("a socket folder with the wrong mode is refused", (t) => {
  for (const mode of [0o700, 0o755, 0o2750]) {
    const f = fixture(t, { mode });
    assert.match(refusal(() => checkLocks(f.config, f.host)), /socket folder .* is mode/);
  }
  for (const mode of [0o770, 0o777, 0o1777]) {
    const f = fixture(t, { mode });
    assert.match(refusal(() => checkLocks(f.config, f.host)), /writable by group or others/);
  }
});

test("a world-writable socket folder is reported writable even when it is another uid's", (t) => {
  const f = fixture(t, { mode: 0o1777 });
  const realLstat = fs.lstatSync;
  const wrapped = Object.create(fs);
  wrapped.lstatSync = (path, options) => {
    const info = realLstat(path, options);
    if (path !== join(f.root, "sock")) return info;
    const copy = Object.create(info);
    Object.defineProperty(copy, "uid", { value: 0, enumerable: true });
    return copy;
  };
  f.host.fs = wrapped;
  assert.match(refusal(() => checkLocks(f.config, f.host)), /writable by group or others/);
});

test("a proof folder with the wrong mode is refused", (t) => {
  for (const proofMode of [0o700, 0o750, 0o1733, 0o2730]) {
    const f = fixture(t, { proofMode });
    assert.match(refusal(() => checkLocks(f.config, f.host)), /proof folder .* is mode/);
  }
});

test("the socket group must have DSH as its only member", (t) => {
  for (const groupMembers of ["dsh,other", "other", ""]) {
    const f = fixture(t, { accountText: accounts({ runnerGid: 4242, groupGid: GROUP_GID, groupMembers }) });
    assert.match(refusal(() => checkLocks(f.config, f.host)), /only member/);
  }
});

test("the socket group may not be anyone's primary group", (t) => {
  const text = accounts({ runnerGid: 4242, groupGid: GROUP_GID });
  const passwd = `${text.passwd}\nother:x:3000:${GROUP_GID}:o:/x:/usr/sbin/nologin`;
  const f = fixture(t, { accountText: { ...text, passwd } });
  assert.match(refusal(() => checkLocks(f.config, f.host)), /primary group/);
});

test("a login shell, a real password and a sudo, admin or wheel membership are refused", (t) => {
  const shell = fixture(t, { accountText: accounts({ runnerGid: 4242, groupGid: GROUP_GID, dshShell: "/bin/bash" }) });
  assert.match(refusal(() => checkLocks(shell.config, shell.host)), /login shell/);
  const password = fixture(t, { accountText: accounts({ runnerGid: 4242, groupGid: GROUP_GID, shadow: "$6$r$abc" }) });
  assert.match(refusal(() => checkLocks(password.config, password.host)), /has a password/);
  const unreadable = fixture(t, { accountText: accounts({ runnerGid: 4242, groupGid: GROUP_GID, shadow: null }) });
  assert.equal(checkLocks(unreadable.config, unreadable.host).user.name, "dsh");
  for (const name of ["sudo", "admin", "wheel"]) {
    const f = fixture(t, {
      accountText: accounts({ runnerGid: 4242, groupGid: GROUP_GID, extraGroups: [`${name}:x:27:dsh`] }),
    });
    assert.match(refusal(() => checkLocks(f.config, f.host)), new RegExp(`${name} group`));
  }
});

test("uid 0, the runner's own uid, and a missing account are refused", (t) => {
  const zero = accounts({ dshUid: 0, runnerGid: 4242, groupGid: GROUP_GID });
  zero.passwd = zero.passwd.split("\n").filter((line) => !line.startsWith("root:")).join("\n");
  const root = fixture(t, { accountText: zero, config: { dshUid: 0 } });
  assert.match(refusal(() => checkLocks(root.config, root.host)), /uid is 0/);
  const own = accounts({ dshUid: process.getuid(), runnerGid: 4242, groupGid: GROUP_GID });
  own.passwd = own.passwd.split("\n").filter((line) => !line.startsWith("runner:")).join("\n");
  const mine = fixture(t, { accountText: own, config: { dshUid: process.getuid() } });
  assert.match(refusal(() => checkLocks(mine.config, mine.host)), /runner's own uid/);
  const missing = fixture(t, { config: { dshUid: 9999 } });
  assert.match(refusal(() => checkLocks(missing.config, missing.host)), /not exactly one local account/);
});

test("a missing socket group is refused, and a missing folder is made with its mode", (t) => {
  const missing = fixture(t, { config: { group: "nope" } });
  assert.match(refusal(() => checkLocks(missing.config, missing.host)), /does not exist/);
  const fresh = fixture(t);
  rmSync(join(fresh.root, "sock"), { recursive: true, force: true });
  rmSync(fresh.config.proofs, { recursive: true, force: true });
  checkLocks(fresh.config, fresh.host);
  assert.equal(statSync(join(fresh.root, "sock")).mode & 0o7777, 0o750);
  assert.equal(statSync(fresh.config.proofs).mode & 0o7777, 0o1730);
});

test("a stale socket of the runner's is replaced; a plain file is refused", async (t) => {
  const f = fixture(t);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      `const { createServer } = require("node:net");` +
        `createServer().listen(${JSON.stringify(f.config.socket)}, () => process.kill(process.pid, "SIGKILL"));`,
    ]);
    child.on("exit", (code, signal) => (signal === "SIGKILL" ? resolve() : reject(new Error(`no stale socket: ${code}`))));
  });
  assert.ok(statSync(f.config.socket).isSocket());
  checkLocks(f.config, f.host);
  assert.equal(existsSync(f.config.socket), false);
  const other = fixture(t);
  writeFileSync(other.config.socket, "not a socket");
  assert.match(refusal(() => checkLocks(other.config, other.host)), /not a socket/);
});

test("the config file must be a regular file the runner or root owns, not group writable", (t) => {
  const f = fixture(t);
  const file = join(f.root, "config.json");
  writeFileSync(file, JSON.stringify(f.config));
  chmodSync(file, 0o600);
  assert.deepEqual(readConfigFile(file, f.host), validateConfig(f.config));
  chmodSync(file, 0o660);
  assert.match(refusal(() => readConfigFile(file, f.host), "CONFIG_INVALID"), /writable by group or others/);
  assert.match(refusal(() => readConfigFile(join(f.root, "nope.json"), f.host), "CONFIG_INVALID"), /does not exist/);
  assert.match(refusal(() => readConfigFile(f.config.proofs, f.host), "CONFIG_INVALID"), /not a regular file/);
  symlinkSync(file, join(f.root, "link.json"));
  assert.match(refusal(() => readConfigFile(join(f.root, "link.json"), f.host), "CONFIG_INVALID"), /not a regular file/);
});

test("validateConfig refuses what is not a config", (t) => {
  const f = fixture(t);
  const good = f.config;
  assert.equal(validateConfig(good).socket, good.socket);
  for (const [patch, why] of [
    [{ nope: 1 }, /unknown config field/],
    [{ socket: "relative" }, /absolute/],
    [{ uidCount: 0 }, /uidCount/],
    [{ uidStart: 4294901760, uidCount: 65536, gidCount: 65536 }, /past the largest uid/],
    [{ gidCount: 1 }, /smaller than uidCount/],
    [{ limits: { memoryMax: "2 gigabytes", tasksMax: 10 } }, /systemd size/],
    [{ limits: { memoryMax: "2G", tasksMax: 0 } }, /tasksMax/],
    [{ maxConcurrent: 0 }, /maxConcurrent/],
    [{ maxTimeoutMs: 0 }, /maxTimeoutMs/],
    [{ dshUid: 0 }, /dshUid/],
  ]) {
    assert.throws(() => validateConfig({ ...good, ...patch }), why, JSON.stringify(patch));
  }
});

test("the runner refuses to run as root, and the allowlist is fixed", (t) => {
  const f = fixture(t);
  const asRoot = { ...f.host, uid: 0 };
  assert.match(refusal(() => checkLocks(f.config, asRoot)), /root/);
  const content = readFileSync(new URL("../runner/proto.mjs", import.meta.url), "utf8");
  assert.match(content, /DEFAULT_ENV_ALLOW = \["PATH", "LANG", "LC_ALL", "TERM", "TZ"\]/);
  assert.equal(plain({ code: "EACCES", message: "denied" }), "EACCES: denied");
  assert.equal(plain(new Error("a\nb\tc")), "a\\x0ab\\x09c");
  assert.equal(plain({ code: "EACCES", message: "x\ny" }), "EACCES: x\\x0ay");
  assert.ok(!plain(new Error("one\ntwo")).includes("\n"), "one plain line");
});
