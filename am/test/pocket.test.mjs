import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ancestors, drawQr, findNode, pairingRefusal, pocketMain } from "../pocket/pocket.mjs";
import { servicePaths } from "../pocket/link/bridge/service-paths.js";
import { acquire } from "../pocket/link/bridge/service.mjs";
import { fakes, getJson, putJson } from "./pocket-fakes.mjs";

const ok = result => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result.json();
};
const operation = (s, name) => s.log().filter(a => a[0] === s.manager && a.includes(name));
const activeChanges = s => s.log().filter(a => a[0] === "npm" && a.includes("ci") ||
  a[0] === s.manager && a.some(v => ["enable", "disable", "bootstrap", "bootout"].includes(v)));
const onVerb = s => s.manager === "launchctl" ? "bootstrap" : "enable";
const offVerb = s => s.manager === "launchctl" ? "bootout" : "disable";
const hash = value => createHash("sha256").update(value).digest("hex");
const amPart = s => join(s.env.AM_HOME, "parts/automagik.am");
const retained = s => join(s.store, "current/pocket.mjs");
function writeCopy(s, version, change = () => {}) {
  const dir = join(amPart(s), version);
  mkdirSync(dir, { recursive: true });
  cpSync(s.pocket, join(dir, "pocket"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), version + "\n");
  change(join(dir, "pocket"));
  return dir;
}
function pointAm(s, dir) {
  const link = join(amPart(s), "current");
  try { unlinkSync(link); } catch (e) { if (e.code !== "ENOENT") throw e; }
  symlinkSync(dir, link);
}
const noOtherExecutables = s => assert.ok(s.log().every(([exe, command]) =>
  ["bridge", "npm", "launchctl", "systemctl"].includes(exe) && command !== "start"), JSON.stringify(s.log()));

test("manifest commands work from an am extract, and managed power is idempotent", async t => {
  const s = fakes(t);
  const manifest = getJson(join(s.pocket, "part.json"));
  assert.equal(manifest.select, "pocket/");
  // Manifest commands resolve relative to the selected folder.
  const fromPart = name => s.result(s.child(manifest.entry[name].slice(1),
    { AM_JSON: "1" }, manifest.entry[name][0], s.pocket));
  const installed = ok(await fromPart("install"));
  assert.equal(installed.ok, true);
  const record = s.record();
  assert.equal(servicePaths(readFileSync(s.service, "utf8")).entry, s.entry);
  assert.equal(record.state, s.state);
  const before = getJson(s.job).pid;
  assert.equal(ok(await s.am(["pocket", "link", "on", "--json"])).ok, true);
  assert.equal(getJson(s.job).pid, before);
  assert.equal(operation(s, onVerb(s)).length, 1);
  assert.equal(ok(await s.am(["pocket", "link", "off", "--json"])).running, false);
  assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).service, false);
  assert.equal(ok(await s.am(["pocket", "link", "on", "--json"])).ok, true);
  assert.notEqual(getJson(s.job).pid, before);
  const doctor = await fromPart("doctor");
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.deepEqual(doctor.stdout.trim().split("\n").map(row => JSON.parse(row).check),
    ["node", "npm", "packages", "service", "running", "state", "dialog"]);
  const retainedDoctor = await s.result(s.child([retained(s), "link", "doctor", "--json"]));
  assert.equal(retainedDoctor.code, 0, retainedDoctor.stdout + retainedDoctor.stderr);
  assert.equal(ok(await fromPart("uninstall")).ok, true);
  assert.equal(existsSync(s.store), false);
  assert.equal(existsSync(s.state), true);
  assert.equal(existsSync(s.service), false);
  noOtherExecutables(s);
});

test("a manager-only update restarts a running bridge; the same tree does not; npm failures preserve it", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const initial = s.record(), initialPid = getJson(s.job).pid;
  const newer = writeCopy(s, "9.0.1", dir => {
    const path = join(dir, "pocket.mjs");
    writeFileSync(path, readFileSync(path, "utf8") + "\n// A manager-only change.\n");
  });
  pointAm(s, newer);
  const r = ok(await s.am(["update", "automagik.am", "--json"]));
  assert.equal(r.pocket.state, "updated");
  assert.equal(s.record().previous.tree, initial.current.tree);
  assert.notEqual(getJson(s.job).pid, initialPid);
  const changedPid = getJson(s.job).pid;
  assert.equal(ok(await s.am(["update", "automagik.am", "--json"])).pocket.state, "current");
  assert.equal(getJson(s.job).pid, changedPid);
  assert.equal(s.log().filter(a => a[0] === "npm" && a[1] === "ci").length, 1);
  const broken = writeCopy(s, "9.0.2", dir => {
    const path = join(dir, "link/bridge/package-lock.json");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
  });
  pointAm(s, broken);
  const failure = await s.am(["update", "automagik.am", "--json"], { FAIL_NPM: "1" });
  assert.equal(failure.code, 1, failure.stdout + failure.stderr);
  assert.equal(failure.json().am.state, "none");
  assert.match(failure.json().pocket.detail, /npm ci failed/);
  assert.equal(s.record().current.version, "9.0.1");
  assert.equal(getJson(s.job).pid, changedPid);
  noOtherExecutables(s);
});

test("same-version package repair leaves an unrelated version directory alone and reuses a retained tree", async t => {
  const s = fakes(t);
  const occupied = join(s.store, readFileSync(join(s.extract, "VERSION"), "utf8").trim());
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "keep"), "unrelated");
  ok(await s.entryRun("install"));
  const first = s.record().current;
  assert.notEqual(first.dir, first.version);
  const originalModules = join(s.store, first.dir, "link/bridge/node_modules");
  rmSync(originalModules, { recursive: true });
  ok(await s.entryRun("install"));
  const repaired = s.record().current;
  assert.notEqual(repaired.dir, first.dir);
  const other = writeCopy(s, "9.1.0", dir => writeFileSync(join(dir, "payload"), "new"));
  pointAm(s, other);
  ok(await s.entryRun("install"));
  unlinkSync(join(amPart(s), "current"));
  ok(await s.entryRun("install"));
  assert.equal(s.record().current.dir, repaired.dir);
  assert.equal(readFileSync(join(occupied, "keep"), "utf8"), "unrelated");
  assert.equal(readdirSync(s.store).filter(name => /^\d/.test(name) && name !== first.version).length, 2);
});

test("foreign service, running detached bridge, and old enabled but off dialog refuse before npm", async t => {
  const s = fakes(t);
  const mod = join(s.app, "mods/pocket-link");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "main.js"), "export default class OlderDialog {}");
  const old = await s.entryRun("install");
  assert.equal(old.code, 1);
  assert.match(old.json().error, /Turn it off there/);
  writeFileSync(join(mod, "main.js"), "// Managed by am (am pocket)");
  const foreign = s.manager === "launchctl"
    ? "<plist><key>ProgramArguments</key><array><string>/old/node</string><string>/old/bridge.mjs</string></array></plist>"
    : "ExecStart=/old/node /old/bridge.mjs serve\n";
  writeFileSync(s.service, foreign);
  const conflict = await s.entryRun("install");
  assert.equal(conflict.code, 1);
  assert.match(conflict.json().error, /Turn it off there/);
  assert.equal(readFileSync(s.service, "utf8"), foreign);
  rmSync(s.service);
  mkdirSync(s.state);
  const pidStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...s.env,
    LC_ALL: "C", TZ: "UTC" } }).trim();
  putJson(join(s.state, "status.json"), { pid: process.pid, pidStart });
  const detached = await s.entryRun("install");
  assert.equal(detached.code, 1);
  assert.match(detached.json().error, /Turn it off there/);
  assert.deepEqual(activeChanges(s), []);
  assert.equal(existsSync(join(s.store, "record.json")), false);
});

test("failed replacement restores an owned service; failed unload reports the original running bridge", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const initial = s.record();
  const failed = join(s.root, "fail-once");
  writeFileSync(failed, "");
  const newer = writeCopy(s, "9.0.3", dir => writeFileSync(join(dir, "payload"), "newer"));
  pointAm(s, newer);
  const update = await s.am(["update", "automagik.am", "--json"], { FAIL_ENABLE: failed });
  assert.equal(update.code, 1, update.stdout + update.stderr);
  assert.match(update.json().pocket.detail, /refused to load replacement/);
  assert.deepEqual(s.record(), initial);
  assert.equal(readlinkSync(join(s.store, "current")), initial.current.dir);
  const restored = getJson(s.job).pid;
  const off = await s.am(["pocket", "link", "off", "--json"], { FAIL_STOP: "1" });
  assert.equal(off.code, 1);
  assert.match(off.json().error, /refused to unload/);
  assert.equal(restored, getJson(s.job).pid);
  assert.equal(existsSync(join(s.store, "pending.json")), false);
  noOtherExecutables(s);
});

test("a drop-in revealed by systemd reload blocks activation before enable", async t => {
  const s = fakes(t, { platform: "linux" });
  const install = await s.entryRun("install", { TEST_DROP_IN: "/foreign/herdr-pocket-link.service.d/override.conf" });
  assert.equal(install.code, 1, install.stdout + install.stderr);
  assert.match(install.json().error, /effective.*systemd|systemd.*definition/i);
  assert.ok(operation(s, "daemon-reload").length > 0);
  assert.deepEqual(operation(s, "enable"), []);
  assert.deepEqual(operation(s, "disable"), []);
  assert.equal(existsSync(s.service), false);
  assert.equal(existsSync(join(s.store, "pending.json")), false);
});

test("a failed start after systemd enablement rolls back and restarts the prior slot", async t => {
  const s = fakes(t, { platform: "linux" });
  ok(await s.entryRun("install"));
  const prior = s.record(), pid = getJson(s.job).pid;
  const failed = join(s.root, "fail-after-enable");
  writeFileSync(failed, "");
  pointAm(s, writeCopy(s, "9.0.4", dir => writeFileSync(join(dir, "payload"), "replacement")));
  const update = await s.am(["update", "automagik.am", "--json"], { FAIL_ENABLE: failed, TEST_PARTIAL_ENABLE: "1" });
  assert.equal(update.code, 1, update.stdout + update.stderr);
  assert.match(update.json().pocket.detail, /refused to load replacement/);
  assert.doesNotMatch(update.json().pocket.detail, /Recovery is pending/);
  assert.deepEqual(s.record(), prior);
  assert.notEqual(getJson(s.job).pid, pid);
  assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).running, true);
  assert.equal(existsSync(join(s.store, "pending.json")), false);
  assert.equal(operation(s, "disable").length, 2);
});

test("systemd configured argv keeps doubled dollars in a literal-dollar entry", async t => {
  const s = fakes(t, { platform: "linux", amDir: "am $HOME cash" });
  // systemd's configured argv is reported before environment substitution.
  const configured = s.entry.replace("$HOME", () => "$$HOME");
  const show = `{ path=${process.execPath} ; argv[]=${process.execPath} ${configured} serve ; ignore_errors=no ; }`;
  const env = { TEST_EXEC_START: show };
  ok(await s.entryRun("install", env));
  assert.match(readFileSync(s.service, "utf8"), /am \$\$HOME cash/);
  assert.ok(getJson(s.job).pid > 0);
  ok(await s.am(["pocket", "link", "off", "--json"], env));
});

test("an off slot stays off through update and every interrupted swap boundary", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const old = s.record();
  pointAm(s, writeCopy(s, "9.0.4", dir => writeFileSync(join(dir, "payload"), "newer")));
  assert.equal(ok(await s.am(["update", "automagik.am", "--json"])).pocket.state, "updated");
  const newRecord = s.record();
  assert.equal(existsSync(s.service), false);
  for (const step of ["prepared", "stopped", "swapped", "served", "recorded"]) {
    const prior = { ...old, previous: newRecord.current };
    putJson(join(s.store, "pending.json"), { op: "sync", state: old.state, node: old.node,
      prior: { record: prior, ready: false }, intended: newRecord, step });
    const before = activeChanges(s).length;
    assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).running, false);
    assert.equal(activeChanges(s).length, before);
    assert.equal(existsSync(join(s.store, "pending.json")), false);
    assert.deepEqual(s.record(), prior);
  }
});

test("purge resumes after the record commit, keeps unknown files and skips symlinks", async t => {
  const s = fakes(t);
  const custom = join(s.root, "custom pairing");
  mkdirSync(custom, { mode: 0o700 });
  ok(await s.entryRun("install", { POCKET_LINK_STATE_DIR: custom }));
  const record = s.record();
  ok(await s.am(["pocket", "link", "off", "--json"]));
  assert.equal(s.record().state, custom);
  const conflict = await s.am(["pocket", "link", "status", "--json"], { POCKET_LINK_STATE_DIR: s.state });
  assert.equal(conflict.code, 1);
  assert.match(conflict.json().error, /recorded at.*custom pairing/);
  writeFileSync(join(custom, "secret.key"), "fixture");
  writeFileSync(join(custom, "keep"), "unknown");
  symlinkSync(join(custom, "keep"), join(custom, "bridge.log"));
  putJson(join(custom, "purge.pending"), { store: s.store, token: "interrupted" });
  putJson(join(s.store, "pending.json"), { op: "uninstall", state: custom, node: record.node, purge: true, token: "interrupted",
    prior: { record, ready: false }, intended: null, step: "prepared" });
  rmSync(join(s.store, "record.json"));
  assert.equal(ok(await s.am(["pocket", "link", "uninstall", "--purge", "--json"])).ok, true);
  assert.deepEqual(readdirSync(custom).sort(), ["bridge.log", "keep"]);
  assert.equal(existsSync(s.store), false);
});

test("first install adopts a unique sibling with pairings and asks when there are several", async t => {
  const s = fakes(t);
  const paired = join(s.stateBase, "automagik-pocket-link-12345678");
  const other = join(s.stateBase, "automagik-pocket-link-87654321");
  for (const dir of [paired, other]) {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "secret.key"), "fixture");
  }
  const ambiguous = await s.entryRun("install");
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.json().error, /--state DIR.*12345678.*87654321/);
  rmSync(other, { recursive: true });
  const result = await s.entryRun("install");
  ok(result);
  assert.match(result.stderr, /keeping the pairings/);
  assert.equal(s.record().state, paired);
  assert.equal(readFileSync(join(paired, "secret.key"), "utf8"), "fixture");
});

test("linked updates and checks leave an installed out-of-date slot alone; older am keeps it", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const record = s.record();
  pointAm(s, writeCopy(s, "9.0.5", dir => writeFileSync(join(dir, "payload"), "newer")));
  const before = s.log().length;
  for (const args of [["update", "--json"], ["update", "automagik.am", "--json"]]) {
    const result = await s.am(args, { AUTOMAGIK_HERDR_LINKED_UPDATE: "1" });
    assert.equal(result.json().pocket, undefined);
  }
  assert.equal((await s.am(["update", "herdr.pack", "--json"])).json().pocket, undefined);
  assert.equal(ok(await s.am(["update", "--check", "--json"])).pocket, undefined);
  assert.equal(s.log().length, before);
  const oldAm = join(amPart(s), "old");
  mkdirSync(oldAm);
  pointAm(s, oldAm);
  assert.equal(ok(await s.am(["update", "automagik.am", "--json"])).pocket.state, "kept");
  assert.deepEqual(s.record(), record);
  const entry = await s.result(s.child([retained(s), "link", "uninstall", "--json"]));
  assert.equal(entry.code, 0, entry.stdout + entry.stderr);
});

test("two installers stage without pruning each other and commit one serving instance", async t => {
  const s = fakes(t);
  const results = await Promise.all([s.entryRun("install", { SLOW_NPM: "1" }), s.entryRun("install", { SLOW_NPM: "1" })]);
  for (const result of results) assert.equal(ok(result).ok, true);
  assert.equal(operation(s, onVerb(s)).length, 1);
  assert.equal(readdirSync(s.store).filter(name => name.startsWith(".staging")).length, 0);
});

test("read-only doctor leaves missing state and a pending transaction unchanged", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const record = s.record();
  rmSync(s.state, { recursive: true });
  const pending = join(s.store, "pending.json");
  writeFileSync(pending, JSON.stringify({ op: "off", state: s.state, prior: { record } }));
  const before = readFileSync(pending, "utf8");
  const changes = activeChanges(s).length;
  const r = await s.entryRun("doctor");
  assert.equal(r.code, 1);
  const rows = r.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.find(row => row.check === "service").ok, false);
  assert.equal(existsSync(s.state), false);
  assert.equal(readFileSync(pending, "utf8"), before);
  assert.equal(activeChanges(s).length, changes);
});

const tty = { stdin: true, stdout: true };
test("pair/reset refusal rules and unsupported platform run before touching state", async t => {
  const s = fakes(t);
  assert.equal(pairingRefusal({}, tty, []), null);
  for (const marker of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "CLAUDECODE", "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED", "DSH_SANDBOX_MASK", "AUTOMAGIK_DSH_ENTRY", "AM_JSON"]) {
    assert.ok(pairingRefusal({ [marker]: "1" }, tty, []), marker);
  }
  for (const endpoint of ["stdin", "stdout"]) assert.match(pairingRefusal({}, { ...tty, [endpoint]: false }, []), /interactive/);
  assert.match(pairingRefusal({}, tty, null), /Cannot check/);
  for (const command of [["herdr-core"], ["/path/to/codex"], ["/Applications/Electron", "--require", "/dir/dsh-launch.cjs"],
    ["/Applications/Automagik.app/Contents/MacOS/Automagik", "--require", "/app/close-fds.cjs", "/app/dsh-launch.cjs"],
    ["node", "/app/bots-dsh/src/host/start.js"]]) assert.match(pairingRefusal({}, tty, [{ command }]), /outside/);
  assert.equal(await pocketMain(["link", "install"], { platform: "win32", env: s.env }), 2);
  for (const args of [["--json", "pair"], ["pair", "--json"], ["pair", "--minutes", "1", "--json"],
    ["link", "reset", "--json"]]) {
    const result = await s.am(["pocket", ...args]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /cannot use JSON/);
    assert.equal(result.stdout, "");
  }
  assert.equal((await s.am(["pocket", "pair"], { AM_JSON: "1" })).code, 2);
  assert.deepEqual(s.log(), []);
  assert.equal(existsSync(s.store), false);
});

test("terminal QR round-trips matrix cells and quiet zone, including an odd final row", () => {
  for (const rows of [["1"], ["01", "10"], ["010", "100", "111"]]) {
    const qr = drawQr(rows, rows.length + 8);
    const pixels = qr.split("\n").flatMap(line => {
      const top = [], bottom = [];
      for (const [, fg, bg, blocks] of line.matchAll(/\x1b\[(30|97);(40|107)m(▀+)/g)) {
        top.push((fg === "30" ? "1" : "0").repeat(blocks.length));
        bottom.push((bg === "40" ? "1" : "0").repeat(blocks.length));
      }
      return [top.join(""), bottom.join("")];
    });
    const quiet = "0".repeat(rows.length + 8);
    assert.deepEqual(pixels, [...Array(4).fill(quiet), ...rows.map(row => "0000" + row + "0000"),
      ...Array(4 + rows.length % 2).fill(quiet)]);
    assert.equal(drawQr(rows, rows.length + 7), null);
  }
});

test("under Bun, recorded Node and newest NVM_DIR Node are probed", t => {
  const s = fakes(t);
  const nvm = join(s.root, "nvm");
  for (const name of ["v20.3.1", "v24.5.0", "v24.11.0"]) {
    const file = join(nvm, "versions/node", name, "bin/node");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}'\n`, { mode: 0o700 });
  }
  const env = { ...s.env, NVM_DIR: nvm, PATH: s.bin };
  const expected = join(nvm, "versions/node/v24.11.0/bin/node");
  assert.equal(findNode(env, expected, null, { bun: true }), expected);
  if (!existsSync("/opt/homebrew/bin/node") && !existsSync("/usr/local/bin/node")) {
    assert.equal(findNode(env, null, null, { bun: true }), expected);
  }
  if (!existsSync("/opt/homebrew/bin/node") && !existsSync("/usr/local/bin/node")) {
    assert.equal(findNode(env, null, null, { exec: "/missing/node", bun: false }), expected);
  }
});

test("the real copied bridge uses an offline npm fixture and reports a truthful stop", async t => {
  const s = fakes(t, { stub: false, control: false });
  const bridge = join(s.pocket, "link/bridge");
  assert.equal(spawnSync(s.env.AM_POCKET_NPM, ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: bridge, env: s.env }).status, 0);
  const state = join(s.root, "another &% state");
  const entry = join(s.root, "stable &% entry/bridge.mjs");
  const env = { POCKET_LINK_STATE_DIR: state, POCKET_LINK_SERVICE_ENTRY: entry,
    POCKET_LINK_SERVICE_NODE: join(s.root, "Node &% path/bin/node") };
  assert.equal(ok(await s.bridge(["install"], env)).path, s.service);
  assert.deepEqual(servicePaths(readFileSync(s.service, "utf8")), { node: env.POCKET_LINK_SERVICE_NODE, entry, state });
  assert.equal(ok(await s.bridge(["status"], env)).running, false);
  const fail = await s.bridge(["stop"], { ...env, FAIL_STOP: "1" });
  assert.equal(fail.code, 1);
  assert.deepEqual(fail.json(), { ok: false, unloaded: false, stopped: null, running: false, error: "refused to unload" });
  assert.equal(existsSync(s.service), true);
  assert.deepEqual(ok(await s.bridge(["uninstall"], env)), { ok: true, unloaded: true, stopped: null, running: false });
  assert.equal(existsSync(s.service), false);
  assert.deepEqual(ok(await s.bridge(["stop"], env)), { ok: true, unloaded: true, stopped: null, running: false });
  noOtherExecutables(s);
});

test("a real bridge serving from an explicit state directory preserves an unrelated meter file", async t => {
  const s = fakes(t, { stub: false });
  mkdirSync(s.state);
  const meter = join(s.state, "meter.json");
  writeFileSync(meter, "another program's meter");
  ok(await s.am(["pocket", "link", "install", "--state", s.state, "--json"]));
  assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).running, true);
  assert.equal(readFileSync(meter, "utf8"), "another program's meter");
});

test("an explicit state directory with either log symlink refuses before starting the bridge", async t => {
  const s = fakes(t, { stub: false });
  mkdirSync(s.state);
  const outside = join(s.root, "outside-log");
  writeFileSync(outside, "unrelated bytes");
  for (const name of ["bridge.log", "bridge.log.1"]) {
    const log = join(s.state, name);
    symlinkSync(outside, log);
    const result = await s.am(["pocket", "link", "install", "--state", s.state, "--json"]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.json().error, /unsafe.*bridge\.log/i);
    assert.equal(readlinkSync(log), outside);
    assert.equal(readFileSync(outside, "utf8"), "unrelated bytes");
    assert.equal(existsSync(join(s.state, "secret.key")), false);
    assert.equal(existsSync(s.service), false);
    assert.equal(operation(s, onVerb(s)).length, 0);
    unlinkSync(log);
  }
});

const PTY = String.raw`
import errno, os, pty, select, signal, sys, time
mode, exe, *args = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execv(exe, [exe, *args])
out = b""
action = False
finish = time.monotonic() + 20
while time.monotonic() < finish:
    if not select.select([master], [], [], 0.1)[0]:
        continue
    try:
        data = os.read(master, 65536)
    except OSError as e:
        if e.errno != errno.EIO:
            raise
        break
    if not data:
        break
    out += data
    if not action and mode == "interrupt" and b"herdr-pocket://pair" in out:
        if os.environ.get("TEST_REMOVE_BEFORE_INTERRUPT"):
            os.unlink(os.environ["TEST_REMOVE_BEFORE_INTERRUPT"])
        os.kill(pid, signal.SIGINT)
        action = True
    if not action and mode == "confirm" and b"[y/N]" in out:
        os.write(master, b"yes\n")
        action = True
else:
    os.kill(pid, signal.SIGKILL)
os.close(master)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

function pythonPty(t, s) {
  const py = "/usr/bin/python3";
  const probe = spawnSync(py, ["-c", "import os,pty; a,b=pty.openpty(); os.close(a); os.close(b)"], { env: s.env });
  if (probe.status !== 0) { t.skip("Python with PTY support is unavailable"); return null; }
  return (mode, args, env, entry = join(s.extract, "bin/am.mjs")) =>
    s.result(s.child(["-c", PTY, mode, process.execPath, entry, ...args], env, py));
}

/**
 * Runs `am pocket …` as bin/am.mjs does, with no ancestors: the test runner's own (a Herdr pane, an
 * agent) would refuse pairing, which is the guard working. The guard itself is the DSH test's.
 */
function noAncestry(s) {
  const entry = join(s.root, "pocket-no-ancestry.mjs");
  writeFileSync(entry, `import { pocketMain } from ${JSON.stringify(join(s.extract, "pocket/pocket.mjs"))};
process.exitCode = await pocketMain(process.argv.slice(3), { ancestry: () => [] });
`);
  return entry;
}

function selectableNode(s, entry) {
  const node = join(s.root, "selected node");
  symlinkSync(process.execPath, node);
  const hook = join(s.root, "selected-node.mjs");
  writeFileSync(hook, `if (process.argv[1] === ${JSON.stringify(entry)}) process.execPath = ${JSON.stringify(node)};`);
  return { node, NODE_OPTIONS: [s.env.NODE_OPTIONS, "--import=" + hook].filter(Boolean).join(" ") };
}

test("PTY ancestry refuses both DSH launchers and allows a bots-dsh working directory argument", async t => {
  const s = fakes(t);
  if (!pythonPty(t, s)) return;
  mkdirSync(s.store, { recursive: true });
  const pending = join(s.store, "pending.json");
  writeFileSync(pending, "{ deliberately invalid");

  const guard = join(s.root, "pocket-real-ancestry.mjs");
  writeFileSync(guard, `
import * as pocket from ${JSON.stringify(join(s.extract, "pocket/pocket.mjs"))};
process.exitCode = await pocket.pocketMain(["pair"], pocket.ancestors ? { ancestry: () => {
  return pocket.ancestors({ through: parent => parent.command.includes(process.env.TEST_LAUNCHER) });
} } : {});
`);
  const nodeParent = join(s.root, "ordinary.cjs");
  const direct = join(s.root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  const desktop = join(s.root, "dsh-launch.cjs");
  mkdirSync(dirname(direct), { recursive: true });
  const source = 'const { spawnSync } = require("node:child_process");\n' +
    'process.exitCode = spawnSync("/usr/bin/python3", ["-c", ' + JSON.stringify(PTY) +
    ', "wait", process.execPath, ' + JSON.stringify(guard) + '], { stdio: "inherit" }).status;\n';
  for (const launcher of [nodeParent, direct]) writeFileSync(launcher, source);
  writeFileSync(desktop, "");
  const preload = join(s.root, "preload.cjs");
  writeFileSync(preload, "");
  const electron = join(s.root, "Electron");
  symlinkSync(process.execPath, electron);
  const runParent = (cmd, launcher, args) => s.result(s.child(args, { TEST_LAUNCHER: launcher }, cmd));
  const allowed = await runParent(process.execPath, nodeParent, [nodeParent, "--cwd", "/fixture/bots-dsh/project"]);
  assert.equal(allowed.code, 1, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /JSON|Unexpected token/);
  for (const [cmd, launcher, args] of [
    [process.execPath, direct, ["--require", preload, direct]],
    [electron, desktop, ["--require", desktop, nodeParent]],
  ]) {
    const r = await runParent(cmd, launcher, args);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /outside Herdr, DSH/);
    assert.doesNotMatch(r.stdout + r.stderr, /herdr-pocket:\/\/|▀/);
  }
  assert.equal(readFileSync(pending, "utf8"), "{ deliberately invalid");
  assert.deepEqual(s.log(), []);
});

test("Linux ancestry permits ordinary SSH, refuses unreadable own processes and keeps the environ exception", () => {
  const denied = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
  const fixture = new Map([
    ["/proc/40/status", "Uid:\t1000\t1000\t1000\t1000\n"],
    ["/proc/40/stat", "40 (fish) S 30"],
    ["/proc/40/cmdline", "/usr/bin/fish\0-l\0"],
    ["/proc/30/status", "Uid:\t1000\t1000\t1000\t1000\n"],
    ["/proc/30/stat", "30 (sshd) S 20"],
    ["/proc/30/cmdline", "sshd: ada@pts/1\0"],
    ["/proc/20/status", "Uid:\t0\t0\t0\t0\n"],
  ]);
  const reads = [];
  const ancestry = () => ancestors({ platform: "linux", ppid: 40, uid: 1000, readProc(path) {
    reads.push(path);
    return fixture.has(path) ? fixture.get(path) : denied();
  }, procOwner: () => 0 });
  assert.equal(pairingRefusal({}, tty, ancestry()), null);
  assert.deepEqual(reads.slice(-1), ["/proc/20/status"]);
  fixture.delete("/proc/20/status");
  assert.equal(pairingRefusal({}, tty, ancestry()), null);
  const invisible = () => { throw Object.assign(new Error("hidden process"), { code: "ENOENT" }); };
  const hidden = (extra = {}) => ancestors({ platform: "linux", ppid: 40, uid: 1000,
    readProc: path => fixture.get(path) ?? (path.startsWith("/proc/20/") ? invisible() : denied()),
    procOwner: invisible, otherUser: pid => pid === 20,
    env: { SSH_CONNECTION: "fixture", SSH_TTY: "/dev/pts/1" }, ...extra });
  assert.equal(pairingRefusal({}, tty, hidden()), null);
  assert.match(pairingRefusal({}, tty, hidden({ otherUser: () => false })), /Cannot check/);
  assert.match(pairingRefusal({}, tty, hidden({ env: {} })), /Cannot check/);
  fixture.set("/proc/40/cmdline", "/usr/bin/fish\0");
  assert.match(pairingRefusal({}, tty, hidden()), /Cannot check/);
  fixture.set("/proc/40/cmdline", "/usr/bin/fish\0-l\0");
  fixture.set("/proc/40/stat", "40 (fish) S 30 40 40");
  fixture.set("/proc/self/stat", "50 (node) S 40 50 40");
  fixture.set("/proc/self/loginuid", "1000\n");
  assert.equal(pairingRefusal({}, tty, hidden({ env: {} })), null);
  fixture.set("/proc/self/loginuid", "4294967295\n");
  assert.match(pairingRefusal({}, tty, hidden({ env: {} })), /Cannot check/);
  fixture.set("/proc/30/environ", "AUTOMAGIK_DSH_ENTRY=/opt/dsh/bin.js\0");
  assert.match(pairingRefusal({}, tty, ancestry()), /outside Herdr, DSH/);
  fixture.delete("/proc/30/cmdline");
  assert.match(pairingRefusal({}, tty, ancestry()), /Cannot check/);
  fixture.set("/proc/30/cmdline", "sshd: ada@pts/1\0");
  fixture.delete("/proc/30/stat");
  assert.match(pairingRefusal({}, tty, ancestry()), /Cannot check/);
});

test("macOS ancestry sees direct and preloaded DSH launchers beneath spaced app paths", () => {
  const desktop = "/Applications/Automagik Beta.app/Contents";
  const commands = new Map([
    [41, { ppid: 31, comm: "/bin/zsh", command: "-zsh" }],
    [31, { ppid: 21, comm: desktop + "/MacOS/Automagik", command: desktop + "/MacOS/Automagik" }],
    [21, { ppid: 1, comm: "/usr/bin/login", command: "/usr/bin/login -pfl ada /bin/zsh" }],
  ]);
  const ancestry = () => ancestors({ platform: "darwin", ppid: 41, ps(pid, ...fields) {
    const row = commands.get(pid);
    return fields.map(field => row[field]).join(" ") + "\n";
  } });
  const app = commands.get(31);
  for (const args of [
    `--require ${desktop}/Resources/dsh-launch/dsh-launch.cjs /tmp/child.cjs`,
    `--require=${desktop}/Resources/dsh-launch/dsh-launch.cjs /tmp/child.cjs`,
    `--require ${desktop}/Resources/close-inherited.cjs ${desktop}/Resources/dsh-launch/dsh-launch.cjs --profile bot`,
    `${desktop}/Resources/node_modules/@deepseek-ai/dsh/lib/bin.js --profile bot`,
  ]) {
    app.command = app.comm + " " + args;
    const parents = ancestry();
    assert.equal(parents.length, 3);
    assert.match(pairingRefusal({}, tty, parents), /outside Herdr, DSH/);
  }
  app.command = app.comm + " /tmp/child.cjs --cwd /tmp/a bots-dsh/project";
  assert.equal(pairingRefusal({}, tty, ancestry()), null);
  app.comm = "/opt/homebrew/bin/node";
  app.command = app.comm + ' --require "/tmp/ordinary helper.cjs" "/tmp/host checkout/bots-dsh/src/host/index.js"';
  assert.match(pairingRefusal({}, tty, ancestry()), /outside Herdr, DSH/);
  app.command = app.comm + " /tmp/host checkout/bots-dsh/src/host/index.js";
  assert.match(pairingRefusal({}, tty, ancestry()), /outside Herdr, DSH/);
  app.command = app.comm + " /tmp/ordinary.cjs /tmp/host checkout/bots-dsh/src/host/index.js";
  assert.equal(pairingRefusal({}, tty, ancestry()), null);
});

test("interactive first pair, off-to-pair, re-pair, expiry and SIGINT use scoped cancellation", async t => {
  const s = fakes(t);
  const pty = pythonPty(t, s);
  if (!pty) return;
  const entry = noAncestry(s);
  const first = await pty("wait", ["pocket", "pair", "--minutes", "1"], { TEST_REPAIR: "1" }, entry);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /about 25 MB[\s\S]*herdr-pocket:\/\/pair[\s\S]*Paired Phone/);
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const again = await pty("wait", ["pocket", "pair"], { TEST_REPAIR: "1" }, entry);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /Paired Phone/);
  assert.equal(operation(s, onVerb(s)).length, 2);
  const expired = await pty("wait", ["pocket", "pair"], { TEST_LIFE: "70" }, entry);
  assert.equal(expired.code, 1, expired.stdout + expired.stderr);
  assert.match(expired.stdout, /pairing code expired/);
  const interrupted = await pty("interrupt", ["pocket", "pair"], {}, entry);
  assert.equal(interrupted.code, 130, interrupted.stdout + interrupted.stderr);
  assert.equal(existsSync(join(s.state, "pairing.json")), false);
  const cancel = s.log().filter(a => a[0] === "bridge" && a[1] === "cancel");
  assert.equal(cancel.length, 4);
  assert.ok(cancel.every(a => /^[0-9a-f]{64}$/.test(a[2])));
  assert.equal(new Set(cancel.map(a => a[2])).size, 4);
  const reset = await pty("confirm", ["pocket", "link", "reset"], {}, entry);
  assert.equal(reset.code, 0, reset.stdout + reset.stderr);
  assert.match(reset.stdout, /unpair every phone/);
  noOtherExecutables(s);
});

test("Ctrl-C rediscovers Node and cancels through the real bridge without passing the code in argv", async t => {
  const s = fakes(t);
  const pty = pythonPty(t, s);
  if (!pty) return;
  const entry = noAncestry(s);
  const { node, NODE_OPTIONS } = selectableNode(s, entry);
  const code = "test-pairing-code-1234";
  const result = await pty("interrupt", ["pocket", "pair"], {
    TEST_CODE: code, TEST_REMOVE_BEFORE_INTERRUPT: node, TEST_REAL_MUTATION: "1", NODE_OPTIONS,
  }, entry);
  assert.equal(result.code, 130, result.stdout + result.stderr);
  assert.equal(existsSync(node), false);
  assert.equal(existsSync(join(s.state, "pairing.json")), false);
  assert.ok(s.log().every(args => !args.includes(code)));
});

test("Ctrl-C reports the expiry and exits 1 if the live code could not be cancelled", async t => {
  const s = fakes(t);
  const pty = pythonPty(t, s);
  if (!pty) return;
  const result = await pty("interrupt", ["pocket", "pair"], { TEST_REFUSE_CANCEL: "1" }, noAncestry(s));
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the code is still valid until \d/i);
  const live = getJson(join(s.state, "pairing.json"));
  assert.deepEqual(s.log().find(args => args[1] === "cancel"), ["bridge", "cancel", hash(live.code)]);
  assert.ok(live.expires > Date.now());
});

test("overlapping pairing waiters report only the challenge the phone consumed", async t => {
  const s = fakes(t);
  const pty = pythonPty(t, s);
  if (!pty) return;
  ok(await s.entryRun("install"));
  const entry = noAncestry(s);
  const firstCode = "first-123456789abcdefg";
  const secondCode = "second-123456789abcdef";
  const path = join(s.state, "pairing.json");
  const first = pty("wait", ["pocket", "pair"], { TEST_CODE: firstCode }, entry);
  for (let i = 0; i < 100 && !existsSync(path); i++) await delay(20);
  assert.equal(getJson(path).code, firstCode);
  const second = pty("wait", ["pocket", "pair"], { TEST_CODE: secondCode, TEST_REPAIR: "1" }, entry);
  const [lost, won] = await Promise.all([first, second]);
  assert.equal(lost.code, 1, lost.stdout + lost.stderr);
  assert.doesNotMatch(lost.stdout, /Paired Phone/);
  assert.match(lost.stdout, /another pairing code replaced/i);
  assert.equal(won.code, 0, won.stdout + won.stderr);
  assert.match(won.stdout, /Paired Phone/);
});

test("the real bridge creates the QR from the same phone-valid link it returns", async t => {
  const s = fakes(t, { stub: false, control: false });
  const bridge = join(s.pocket, "link/bridge");
  assert.equal(spawnSync(s.env.AM_POCKET_NPM, ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: bridge, env: s.env }).status, 0);
  mkdirSync(s.state);
  const pidStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...s.env,
    LC_ALL: "C", TZ: "UTC" } }).trim();
  putJson(join(s.state, "status.json"), { pid: process.pid, pidStart, name: "A & B", ticket: "endpointabcdefghijklmnopqrstuvwxyz234567", id: "desktop" });
  const output = join(s.root, "qr.json");
  const challenge = ok(await s.bridge(["pair", "1"], { TEST_QR: output }));
  const link = new URL(challenge.link);
  assert.equal(link.protocol, "herdr-pocket:");
  assert.equal(link.hostname, "pair");
  assert.equal(link.searchParams.get("v"), "1");
  assert.equal(link.searchParams.get("n"), "A & B");
  assert.match(link.searchParams.get("t"), /^endpoint[a-z2-7]{20,2000}$/);
  assert.equal(link.searchParams.get("c"), challenge.code);
  assert.match(challenge.code, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(challenge.rows, ["010", "101", "010"]);
  assert.equal(readFileSync(output, "utf8"), challenge.link);
  const newer = ok(await s.bridge(["pair"]));
  assert.equal(challenge.challengeId, hash(challenge.code));
  assert.equal((await s.bridge(["cancel", "invalid-id"])).code, 1);
  assert.equal(ok(await s.bridge(["cancel", challenge.challengeId])).cancelled, false);
  assert.equal(getJson(join(s.state, "pairing.json")).code, newer.code);
  assert.equal(ok(await s.bridge(["copied", newer.challengeId])).ok, true);
  assert.equal(ok(await s.bridge(["cancel", newer.challengeId])).cancelled, true);
});

test("am rollback to a release without Pocket Link keeps its running slot", async t => {
  const s = fakes(t);
  const older = join(s.root, "older-am");
  cpSync(s.extract, older, { recursive: true });
  writeFileSync(join(older, "VERSION"), "1.1.1\n");
  rmSync(join(older, "pocket"), { recursive: true });
  // The historical extract's launcher does not load the new pocket module.
  writeFileSync(join(older, "bin/am.mjs"), 'console.log("am 1.1.1");\n');
  const installOld = await s.result(s.child([join(s.extract, "bin/am.mjs"), "self", "install", "--json"]));
  ok(installOld);
  const amStore = amPart(s);
  const previous = "1.1.1";
  cpSync(older, join(amStore, previous), { recursive: true });
  const installed = getJson(join(amStore, "record.json"));
  installed.previous = { ...installed.current, version: previous, dir: previous };
  putJson(join(amStore, "record.json"), installed);
  symlinkSync(previous, join(amStore, "previous"));

  ok(await s.entryRun("install"));
  const record = s.record();
  const original = getJson(s.job).pid;
  const result = ok(await s.am(["rollback", "automagik.am", "--json"]));
  assert.equal(result.detail.to, previous);
  assert.equal(result.pocket.state, "kept");
  assert.deepEqual(s.record(), record);
  assert.equal(getJson(s.job).pid, original);
  const retainedOff = await s.result(s.child([retained(s), "link", "off", "--json"]));
  assert.equal(ok(retainedOff).running, false);
});

test("recovery restarts a formerly serving slot or removes an uncommitted first install", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const record = s.record();
  const first = getJson(s.job).pid;
  const pending = join(s.store, "pending.json");
  ok(await s.am(["pocket", "link", "off", "--json"]));
  putJson(pending, { op: "sync", state: record.state, node: record.node,
    prior: { record, ready: true, pid: first }, intended: record, step: "stopped" });
  assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).running, true);
  assert.notEqual(getJson(s.job).pid, first);
  assert.equal(existsSync(pending), false);

  putJson(pending, { op: "sync", state: record.state, node: record.node,
    prior: { record: null, ready: false }, intended: record, step: "recorded" });
  const uncommitted = await s.am(["pocket", "link", "status", "--json"]);
  assert.equal(uncommitted.code, 2, uncommitted.stdout + uncommitted.stderr);
  assert.deepEqual(uncommitted.json(), { installed: false, running: false });
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(s.service), false);
});


test("a loaded foreign unit without a local file or PID makes zero manager writes", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const record = s.record();
  putJson(s.job, { loaded: true, fragment: join(s.root, "foreign", "pocket.service") });
  const count = s.log().length;
  for (const verb of ["off", "uninstall"]) {
    const attempt = await s.am(["pocket", "link", verb, "--json"]);
    assert.equal(attempt.code, 1, attempt.stdout + attempt.stderr);
    assert.match(attempt.json().error, /Turn it off/);
  }
  assert.deepEqual(s.record(), record);
  assert.ok(s.log().slice(count).every(row => row[0] !== s.manager || row.includes("show") || row.includes("print")));
});

test("off and full purge preserve unrelated locks, QR names and state symlinks", async t => {
  const s = fakes(t);
  writeFileSync(join(s.stateBase, "outside"), "untouched");
  mkdirSync(s.state);
  ok(await s.am(["pocket", "link", "install", "--state", s.state, "--json"]));
  writeFileSync(join(s.state, ".lock"), "another program");
  writeFileSync(join(s.state, "devices.lock"), "Pocket Link");
  symlinkSync(join(s.stateBase, "outside"), join(s.state, "pairing.json"));
  writeFileSync(join(s.state, "qr-1.svg"), "another program's image");
  symlinkSync(join(s.stateBase, "outside"), join(s.state, "qr-2.svg"));
  symlinkSync(join(s.stateBase, "outside"), join(s.state, "bridge.log.1"));
  const check = () => {
    assert.equal(readFileSync(join(s.state, "qr-1.svg"), "utf8"), "another program's image");
    for (const name of ["qr-2.svg", "bridge.log.1", "pairing.json"]) {
      assert.equal(readlinkSync(join(s.state, name)), join(s.stateBase, "outside"));
    }
  };
  ok(await s.am(["pocket", "link", "off", "--json"]));
  check();
  ok(await s.am(["pocket", "link", "uninstall", "--purge", "--json"]));
  assert.deepEqual(readdirSync(s.state).sort(), [".lock", "bridge.log.1", "pairing.json", "qr-1.svg", "qr-2.svg"]);
  check();
  assert.equal(readFileSync(join(s.stateBase, "outside"), "utf8"), "untouched");
});

test("interrupted purge fences acquisition and revalidates before deleting pairings", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const record = s.record();
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const journal = join(s.store, "pending.json");
  const marker = join(record.state, "purge.pending");
  const token = "interrupted-purge";
  putJson(journal, { op: "uninstall", state: record.state, node: record.node, purge: true, token,
    prior: { record, ready: false }, intended: null, step: "prepared" });
  putJson(marker, { store: s.store, token });
  rmSync(join(s.store, "record.json"));
  const other = { AM_HOME: join(s.root, "other-am") };
  const acquisition = await s.am(["pocket", "link", "install", "--state", record.state, "--json"], other);
  assert.equal(acquisition.code, 1, acquisition.stdout + acquisition.stderr);
  assert.match(acquisition.json().error, /purge/i);
  writeFileSync(join(record.state, "secret.key"), "new key");
  // Model a service acquired by a bridge from before it knew about the shared marker.
  putJson(s.job, { loaded: true, fragment: join(s.root, "other-am", "pocket.service") });
  const recovery = await s.entryRun("uninstall");
  assert.equal(recovery.code, 1, recovery.stdout + recovery.stderr);
  assert.equal(readFileSync(join(record.state, "secret.key"), "utf8"), "new key");
  assert.equal(existsSync(journal), true);
  putJson(s.job, { loaded: false });
  ok(await s.entryRun("uninstall"));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(record.state, "secret.key")), false);
});

function crashBeforeUnlink(s, path) {
  const hook = join(s.root, "interrupt-uninstall.mjs");
  writeFileSync(hook, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (path, ...args) => {
      if (path === process.env.TEST_CRASH_UNLINK) process.kill(process.pid, "SIGKILL");
      unlink(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  return { NODE_OPTIONS: "--import=" + hook, TEST_CRASH_UNLINK: path };
}

const crashBeforeRecordRemoval = s => crashBeforeUnlink(s, join(s.store, "record.json"));

test("an interrupted purge clears its fence before restoring the previously running worker", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const pid = getJson(s.job).pid;
  const record = s.record();
  const secret = join(record.state, "secret.key");
  writeFileSync(secret, "keep this key");
  const crash = await s.am(["pocket", "link", "uninstall", "--purge", "--json"], crashBeforeRecordRemoval(s));
  assert.equal(crash.signal, "SIGKILL", crash.stdout + crash.stderr);
  assert.ok(existsSync(join(record.state, "purge.pending")));
  assert.deepEqual(s.record(), record);
  const recovery = ok(await s.am(["pocket", "link", "status", "--json"]));
  assert.equal(recovery.running, true);
  assert.notEqual(getJson(s.job).pid, pid);
  assert.equal(existsSync(join(record.state, "purge.pending")), false);
  assert.equal(existsSync(join(s.store, "pending.json")), false);
  assert.equal(readFileSync(secret, "utf8"), "keep this key");
});

test("recovery captures and restores a real inactive disabled service without starting it", async t => {
  if (process.platform !== "linux") return t.skip("systemd disabled unit");
  const real = fakes(t);
  ok(await real.entryRun("install"));
  const record = real.record();
  const body = readFileSync(real.service, "utf8");
  assert.equal(spawnSync(join(real.bin, "systemctl"), ["--user", "disable", "--now", "herdr-pocket-link.service"],
    { env: real.env }).status, 0);
  for (let i = 0; i < 100 && existsSync(join(record.state, "status.json")); i++) await delay(20);
  assert.equal(existsSync(join(record.state, "status.json")), false);
  const crash = await real.am(["pocket", "link", "uninstall", "--json"], crashBeforeRecordRemoval(real));
  assert.equal(crash.signal, "SIGKILL", crash.stdout + crash.stderr);
  const prior = getJson(join(real.store, "pending.json")).prior;
  assert.deepEqual(prior.inactive, { body, enabled: "disabled" });
  assert.equal(prior.record.digest, createHash("sha256").update(body).digest("hex"));
  assert.equal(existsSync(real.service), false);
  const count = activeChanges(real).length;
  const result = ok(await real.am(["pocket", "link", "status", "--json"]));
  assert.equal(result.running, false);
  assert.equal(result.service, true);
  assert.equal(readFileSync(real.service, "utf8"), body);
  assert.equal(activeChanges(real).length, count);
  assert.deepEqual(real.record(), record);
});

test("the former store cannot reset, forget or purge a state directory adopted by another store", async t => {
  const s = fakes(t);
  const pty = pythonPty(t, s);
  if (!pty) return;
  ok(await s.entryRun("install"));
  ok(await s.am(["pocket", "link", "off", "--json"]));
  const other = { AM_HOME: join(s.root, "other-am"), TEST_REAL_MUTATION: "1" };
  const recordA = s.record();
  ok(await s.am(["pocket", "link", "install", "--state", recordA.state, "--json"], other));
  const pathB = join(other.AM_HOME, "parts/pocket.link/record.json");
  const recordB = getJson(pathB);
  assert.equal(recordA.state, recordB.state);
  const key = join(recordA.state, "secret.key");
  const devices = join(recordA.state, "devices.json");
  writeFileSync(key, "second store's key");
  putJson(devices, [{ id: "phone", name: "Pocket" }]);
  const forget = await s.am(["pocket", "link", "forget", "phone", "--json"], { TEST_REAL_MUTATION: "1" });
  assert.equal(forget.code, 1, forget.stdout + forget.stderr);
  assert.match(forget.json().error, /another am store/i);
  const reset = await pty("confirm", ["pocket", "link", "reset"], { TEST_REAL_MUTATION: "1" }, noAncestry(s));
  assert.equal(reset.code, 1, reset.stdout + reset.stderr);
  assert.match(reset.stdout, /another am store/i);
  ok(await s.am(["pocket", "link", "off", "--json"], other));
  const purge = await s.am(["pocket", "link", "uninstall", "--purge", "--json"]);
  assert.equal(purge.code, 1, purge.stdout + purge.stderr);
  assert.match(purge.json().error, /another am store/i);
  assert.deepEqual(getJson(pathB).current, recordB.current);
  assert.equal(readFileSync(key, "utf8"), "second store's key");
  assert.deepEqual(getJson(devices), [{ id: "phone", name: "Pocket" }]);
  assert.equal(ok(await s.am(["pocket", "link", "forget", "phone", "--json"], other)).removed, true);
  putJson(devices, [{ id: "phone", name: "Pocket" }]);
  ok(await s.am(["pocket", "link", "uninstall", "--json"], other));
  assert.equal(existsSync(join(recordA.state, "am-owner.json")), false);
  for (const [name, ...args] of [["forget", "phone"], ["uninstall", "--purge"]]) {
    const failed = await s.am(["pocket", "link", name, ...args, "--json"], { TEST_REAL_MUTATION: "1" });
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.json().error, /does not own/i);
  }
  const ownerlessReset = await pty("confirm", ["pocket", "link", "reset"], { TEST_REAL_MUTATION: "1" }, noAncestry(s));
  assert.equal(ownerlessReset.code, 1, ownerlessReset.stdout + ownerlessReset.stderr);
  assert.match(ownerlessReset.stdout, /does not own/i);
  assert.equal(readFileSync(key, "utf8"), "second store's key");
  assert.deepEqual(getJson(devices), [{ id: "phone", name: "Pocket" }]);
});

test("a replacement at the recorded service path and altered effective config make zero manager writes", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const record = s.record();
  const original = readFileSync(s.service, "utf8");
  assert.equal(spawnSync(join(s.bin, s.manager), s.manager === "launchctl"
    ? ["bootout", `gui/${process.getuid()}/dev.herdr.pocket-link`]
    : ["--user", "disable", "--now", "herdr-pocket-link.service"], { env: s.env }).status, 0);
  for (let i = 0; i < 100 && existsSync(join(record.state, "status.json")); i++) await delay(20);
  const foreign = original.replace(s.manager === "launchctl" ? "<string>serve</string>" : " serve\n",
    s.manager === "launchctl" ? "<string>status</string>" : " status\n");
  assert.notEqual(foreign, original);
  writeFileSync(s.service, foreign);
  const first = s.log().length;
  for (const verb of ["off", "uninstall", "on"]) {
    const result = await s.am(["pocket", "link", verb, "--json"]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.json().error, /Turn it off/);
  }
  assert.equal(readFileSync(s.service, "utf8"), foreign);
  writeFileSync(s.service, original);
  putJson(s.job, { loaded: true, ...(s.manager === "launchctl"
    ? { verb: "status" } : { dropIns: "/outside/override.conf" }) });
  const result = await s.am(["pocket", "link", "off", "--json"]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.json().error, /Turn it off/);
  assert.equal(readFileSync(s.service, "utf8"), original);
  assert.deepEqual(s.record(), record);
  assert.ok(s.log().slice(first).every(row => row[0] !== s.manager || row.includes("show") || row.includes("print")));
});

test("a byte-identical definition recreated after off is foreign to every power command", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const body = readFileSync(s.service);
  ok(await s.am(["pocket", "link", "off", "--json"]));
  writeFileSync(s.service, body);
  const count = activeChanges(s).length;
  for (const verb of ["off", "uninstall", "on"]) {
    const result = await s.am(["pocket", "link", verb, "--json"]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.json().error, /Turn it off/);
  }
  assert.deepEqual(readFileSync(s.service), body);
  assert.equal(s.record().digest, null);
  assert.equal(activeChanges(s).length, count);
});

test("recovery of a committed off leaves a reappearing definition alone", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const body = readFileSync(s.service), pending = join(s.store, "pending.json");
  const crashed = await s.am(["pocket", "link", "off", "--json"], crashBeforeUnlink(s, pending));
  assert.equal(crashed.signal, "SIGKILL", crashed.stdout + crashed.stderr);
  assert.equal(existsSync(pending), true);
  assert.equal(existsSync(s.service), false);
  writeFileSync(s.service, body);
  const count = activeChanges(s).length;
  const status = ok(await s.am(["pocket", "link", "status", "--json"]));
  assert.equal(status.service, false);
  assert.equal(status.running, false);
  assert.equal(existsSync(pending), false);
  assert.deepEqual(readFileSync(s.service), body);
  assert.equal(activeChanges(s).length, count);
});

test("control verbs and repair use a replacement for a removed recorded Node", async t => {
  const s = fakes(t);
  const old = join(s.root, "old node");
  ok(await s.entryRun("install"));
  symlinkSync(process.execPath, old);
  putJson(join(s.store, "record.json"), { ...s.record(), node: old });
  unlinkSync(old);
  assert.equal(ok(await s.am(["pocket", "link", "status", "--json"])).running, true);
  ok(await s.am(["pocket", "link", "on", "--json"]));
  assert.equal(s.record().node, process.execPath);
  assert.equal(servicePaths(readFileSync(s.service, "utf8")).node, process.execPath);
  const path = join(s.store, "record.json");
  putJson(path, { ...s.record(), node: old });
  ok(await s.am(["pocket", "link", "off", "--json"]));
  ok(await s.entryRun("uninstall"));
});

test("on repairs a missing current link while keeping the live bridge PID", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const pid = getJson(s.job).pid;
  const record = s.record();
  unlinkSync(join(s.store, "current"));
  const count = activeChanges(s).length;
  ok(await s.am(["pocket", "link", "on", "--json"]));
  assert.equal(readlinkSync(join(s.store, "current")), record.current.dir);
  assert.equal(getJson(s.job).pid, pid);
  assert.equal(activeChanges(s).length, count);
});

test("a loaded idle launchd job with a removed Node can be repaired and removed", async t => {
  const s = fakes(t, { platform: "darwin" });
  const entry = join(s.pocket, "pocket.mjs");
  const idle = async () => {
    const { node, NODE_OPTIONS } = selectableNode(s, entry);
    ok(await s.entryRun("install", { NODE_OPTIONS }));
    assert.equal(servicePaths(readFileSync(s.service, "utf8")).node, node);
    unlinkSync(node);
    putJson(s.request, { running: false, sequence: "missing node " + getJson(s.job).pid });
    for (let i = 0; i < 100 && existsSync(join(s.state, "status.json")); i++) await delay(20);
    assert.equal(existsSync(join(s.state, "status.json")), false);
    putJson(s.job, { loaded: true });
  };
  await idle();
  const prior = s.record(), body = readFileSync(s.service, "utf8");
  const failure = join(s.root, "fail-bootstrap");
  writeFileSync(failure, "");
  const repairFailure = await s.entryRun("install", { FAIL_ENABLE: failure });
  assert.equal(repairFailure.code, 1);
  assert.doesNotMatch(repairFailure.json().error, /Recovery is pending/);
  assert.deepEqual(s.record(), prior);
  assert.equal(readFileSync(s.service, "utf8"), body);
  assert.equal(getJson(s.job).loaded, true);
  ok(await s.am(["pocket", "link", "on", "--json"]));
  assert.equal(servicePaths(readFileSync(s.service, "utf8")).node, process.execPath);
  assert.ok(getJson(s.job).pid > 0);
  await idle();
  ok(await s.am(["pocket", "link", "off", "--json"]));
  assert.equal(getJson(s.job).loaded, false);
  assert.equal(existsSync(s.service), false);
  await idle();
  ok(await s.entryRun("uninstall"));
  assert.equal(getJson(s.job).loaded, false);
  assert.equal(existsSync(s.service), false);
});

test("doctor imports the native package even when the manifests and lockfile are intact", async t => {
  const s = fakes(t);
  ok(await s.entryRun("install"));
  const binding = join(s.store, "current/link/bridge/node_modules/@number0/iroh/index.js");
  const imported = join(dirname(binding), "binding.cjs");
  writeFileSync(binding, 'import "./binding.cjs";\n');
  writeFileSync(imported, "module.exports = {};\n");
  assert.equal((await s.entryRun("doctor")).code, 0);
  unlinkSync(imported);
  const diagnostic = await s.entryRun("doctor");
  const packages = diagnostic.stdout.trim().split("\n").map(JSON.parse).find(row => row.check === "packages");
  assert.equal(diagnostic.code, 1, diagnostic.stdout + diagnostic.stderr);
  assert.equal(packages.ok, false);
  assert.equal(packages.fix, "am pocket link on");
});

test("standalone start refuses a detached fallback with a service file and unavailable manager", async t => {
  const s = fakes(t, { control: false });
  assert.equal(spawnSync(s.env.AM_POCKET_NPM, ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: join(s.pocket, "link/bridge"), env: s.env }).status, 0);
  const options = { POCKET_LINK_STATE_DIR: s.state };
  ok(await s.bridge(["install"], options));
  const body = readFileSync(s.service, "utf8");
  const hook = join(s.root, "block-detached.mjs");
  writeFileSync(hook, `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    cp.spawn = () => { throw new Error("attempted a detached launch"); };
    syncBuiltinESMExports();
  `);
  const result = await s.bridge(["start"], { ...options, TEST_START_GUARD: "1", FAIL_MANAGER: "1", NODE_OPTIONS: "--import=" + hook });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.json().error, /login service.*turn it off/i);
  assert.equal(readFileSync(s.service, "utf8"), body);
});

test("the standalone bridge stops an entry-verified detached PID without a manager", async t => {
  const s = fakes(t, { control: false });
  const script = join(s.pocket, "link/bridge/bridge.mjs");
  mkdirSync(s.state);
  const worker = s.child([script, "serve"], { POCKET_LINK_STATE_DIR: s.state });
  const exited = new Promise(resolve => worker.once("exit", resolve));
  try {
    const status = join(s.state, "status.json");
    for (let i = 0; i < 100 && !existsSync(status); i++) await delay(20);
    assert.equal(getJson(status).pid, worker.pid);
    const stopped = await s.bridge(["stop"], { POCKET_LINK_STATE_DIR: s.state, FAIL_MANAGER: "1" });
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    assert.deepEqual(stopped.json(), { ok: true, unloaded: false, stopped: worker.pid, running: false, managerError: "manager unavailable" });
    await exited;
  } finally { worker.kill("SIGTERM"); await exited; }
});

test("standalone writes recheck am ownership after acquiring the manager lock", async t => {
  const s = fakes(t, { control: false });
  const bridge = join(s.pocket, "link/bridge");
  assert.equal(spawnSync(s.env.AM_POCKET_NPM, ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: bridge, env: s.env }).status, 0);
  const managerLock = join(dirname(s.service), ".herdr-pocket-link.lock");
  const held = await acquire(managerLock);
  const options = { POCKET_LINK_STATE_DIR: s.state };
  const click = s.bridge(["install"], options);
  try {
    const waiting = () => readdirSync(dirname(managerLock)).some(name => name.startsWith(".herdr-pocket-link.lock."));
    for (let i = 0; i < 100 && !waiting(); i++) await delay(20);
    assert.equal(waiting(), true);
    mkdirSync(s.store, { recursive: true });
    putJson(join(s.store, "record.json"), { current: { dir: "broken" }, state: s.state });
  } finally { held.release(); }
  for (const result of [await click, await s.bridge(["stop"], options), await s.bridge(["uninstall"], options)]) {
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.json().error, /managed by am/i);
  }
  assert.equal(existsSync(s.service), false);
  assert.ok(s.log().every(([executable]) => executable === "npm"));
});
