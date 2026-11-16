// main.mjs: the config file, the start locks, the socket mode, and the CLI's one plain line and
// exit 125. The real start is exercised with a fake host: real ids and real folders, fake accounts
// and fake tools on PATH; no setuid, no sudo and no systemd here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../runner/main.mjs";
import { accounts, base, fakeBin, fakePath, prepareDirs, testConfig } from "./runner-helpers.mjs";

const MAIN = fileURLToPath(new URL("../runner/main.mjs", import.meta.url));

function startFixture(t, { accountText } = {}) {
  const root = base(t);
  const bin = fakeBin(t);
  const config = testConfig(root, { uidStart: 200000, gidStart: 200000 });
  prepareDirs(config);
  const logs = [];
  const host = {
    uid: process.getuid(),
    gid: process.getgid(),
    platform: "linux",
    fs,
    spawn,
    spawnSync,
    env: { PATH: fakePath(bin) },
    now: () => Date.now(),
    log: (line) => logs.push(line),
    accounts:
      accountText ??
      accounts({ runnerUid: process.getuid(), runnerGid: 4242, groupGid: process.getgid() }),
  };
  return { root, bin, config, host, logs, groupGid: process.getgid() };
}

test("start passes all three locks, listens, and opens the socket to the group as 0660", async (t) => {
  const f = startFixture(t);
  const instance = await start(f.config, f.host);
  t.after(() => instance.close());
  const info = statSync(f.config.socket);
  assert.equal(info.mode & 0o7777, 0o660);
  assert.equal(info.gid, f.groupGid);
  assert.equal(info.uid, process.getuid());
  assert.ok(info.isSocket());
  assert.ok(f.logs.some((line) => line.startsWith("listening on ")));
});

test("start refuses when a lock fails, and leaves no socket", async (t) => {
  const f = startFixture(t, {
    accountText: accounts({
      runnerUid: process.getuid(),
      runnerGid: 4242,
      groupGid: process.getgid(),
      groupMembers: "dsh,other",
    }),
  });
  await assert.rejects(start(f.config, f.host), /only member/);
  assert.equal(existsSync(f.config.socket), false);
});

test("start refuses a symlinked ancestor before the path is made real", async (t) => {
  const f = startFixture(t);
  const real = join(f.root, "real");
  mkdirSync(join(real, "sock"), { recursive: true });
  chmodSync(join(real, "sock"), 0o750);
  symlinkSync(real, join(f.root, "alias"));
  const config = { ...f.config, socket: join(f.root, "alias", "sock", "runner.sock") };
  await assert.rejects(start(config, f.host), /symbolic link/);
  assert.equal(existsSync(config.socket), false);
});

test("start makes a missing socket folder, mode 0750, and opens the socket", async (t) => {
  const f = startFixture(t);
  rmSync(join(f.root, "sock"), { recursive: true, force: true });
  const instance = await start(f.config, f.host);
  t.after(() => instance.close());
  const folder = statSync(join(f.root, "sock"));
  assert.equal(folder.mode & 0o7777, 0o750);
  assert.equal(folder.gid, process.getgid());
  assert.equal(statSync(f.config.socket).mode & 0o7777, 0o660);
});

test("start refuses a proof folder that is a symbolic link", async (t) => {
  const f = startFixture(t);
  rmSync(f.config.proofs, { recursive: true, force: true });
  mkdirSync(join(f.root, "real-proofs"));
  chmodSync(join(f.root, "real-proofs"), 0o1730);
  symlinkSync(join(f.root, "real-proofs"), f.config.proofs);
  await assert.rejects(start(f.config, f.host), /symbolic link/);
});

test("start refuses a platform that has no user namespaces here", async (t) => {
  const f = startFixture(t);
  await assert.rejects(start(f.config, { ...f.host, platform: "darwin" }), /runs on Linux/);
});

test("the CLI refuses without a config: one plain line and exit 125", () => {
  for (const args of [[], ["--config"], ["--other", "x"]]) {
    const result = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8" });
    assert.equal(result.status, 125, args.join(" "));
    assert.match(result.stderr, /^member-runner: refused to start: /);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.ok(!result.stderr.includes(" at "), "no stack trace");
  }
});

test("the CLI refuses a config file writable by group or others", (t) => {
  const f = startFixture(t);
  const file = join(f.root, "config.json");
  writeFileSync(file, JSON.stringify(f.config));
  chmodSync(file, 0o666);
  const result = spawnSync(process.execPath, [MAIN, "--config", file], { encoding: "utf8" });
  assert.equal(result.status, 125);
  assert.match(result.stderr, /writable by group or others/);
  assert.ok(!result.stderr.includes(" at "));
});

test("the CLI refuses DSH's real account as a service account, before it makes a socket", (t) => {
  const f = startFixture(t);
  const config = { ...f.config, dshUid: process.getuid() };
  const file = join(f.root, "config.json");
  writeFileSync(file, JSON.stringify(config));
  chmodSync(file, 0o600);
  const result = spawnSync(process.execPath, [MAIN, "--config", file], { encoding: "utf8" });
  assert.equal(result.status, 125);
  assert.match(result.stderr, /^member-runner: refused to start: /);
  assert.match(result.stderr, /login shell|runner's own uid/);
  assert.equal(existsSync(config.socket), false);
  assert.ok(!result.stderr.includes(" at "));
});

test("the CLI refuses a config that is not JSON", (t) => {
  const f = startFixture(t);
  const file = join(f.root, "config.json");
  writeFileSync(file, "not json");
  chmodSync(file, 0o600);
  const result = spawnSync(process.execPath, [MAIN, "--config", file], { encoding: "utf8" });
  assert.equal(result.status, 125);
  assert.match(result.stderr, /not JSON/);
});
