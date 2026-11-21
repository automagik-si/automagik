// Process-only. There are no listeners, and the child processes use scratch homes and a fake hc.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AM, AM_READER, PACK, READER, exe } from "./accounts-fixture.mjs";
import { scratchRoot } from "./scratch-project.mjs";
import { coreHere, setLoginRun } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { idDigest } from "../mods/am-sidebar/accountsPlanRecord.js";
import { loginEdit, nextSlotDir, PANEL_MARKER, setLoginOp, SIDEBAR_MARKERS, SIDEBAR_VERSION, WRITER_FILE } from "../mods/am-sidebar/accountsWrite.js";
import { userCoreSockets } from "../mods/am-sidebar/coreSocket.mjs";
import { nextSlot, writeRecord } from "../mods/am-quota/logins.js";
import { snapshotOf } from "../mods/am-quota/setLogin.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const use = (id, snapshot, ...extra) => ["--use", id, "--snapshot", snapshot, ...extra];
const refused = (code) => ({ code: 1, stdout: `${JSON.stringify({ error: code })}\n`, stderr: `am: accounts set-login: ${code}\n` });
const usage = { code: 2, stdout: "", stderr: "am: accounts set-login: usage\n" };
const format = (use, logins) => `${JSON.stringify({ use, logins }, null, 2)}\n`;
const A = "ana@example.test", B = "bo@example.test", C = "cy@example.test";
const dispatch = "d".repeat(32);
const fence = { "expect-rev": "4", attempt: "1", dispatch };
const fenceArgs = Object.entries(fence).flatMap(([key, value]) => ["--" + key, value]);

function scene(t) {
  const root = scratchRoot(t, "am-set-login-");
  const home = join(root, "home"), app = join(home, "app"), bin = join(home, "bin");
  const folder = join(home, "login-é"), other = join(home, "login-two"), codex = join(home, "codex");
  const file = join(app, "claude-logins.json"), log = join(root, "hc.log"), lock = `${file}.lock`;
  const logins = [{ id: "slot-two", dir: folder }];
  const text = format("default", logins), snapshot = sha256(text);
  const env = { HOME: home, HERDR_APP_HOME: app, AM_HOME: join(home, "am"), CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: join(home, "claude"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
    AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock"),
    HERDR_APP_BIN: "/bin/false", GIT_CEILING_DIRECTORIES: root, TMPDIR: root, PATH: `${bin}:${process.env.PATH}`, SET_LOGIN_HC_LOG: log };
  for (const dir of [app, bin, folder, other, codex, env.CLAUDE_CONFIG_DIR, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  exe(join(bin, "hc"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SET_LOGIN_HC_LOG"\nexit 9\n');
  writeFileSync(file, text, { mode: 0o644 });

  function call(args, entry, extra) {
    const childEnv = { ...env, ...extra };
    for (const key of ["HOME", "HERDR_APP_HOME", "AM_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR", "AUTOMAGIK_HERDR_CORE_SOCKET", "SET_LOGIN_HC_LOG", "TMPDIR"]) {
      assert.ok(childEnv[key] === root || childEnv[key].startsWith(`${root}/`), key);
    }
    assert.equal(childEnv.AUTOMAGIK_HERDR_TEST_ROOTS, root);
    assert.equal(childEnv.HERDR_APP_BIN, "/bin/false");
    const argv = entry.endsWith("/accounts.mjs") ? [entry, "set-login", ...args] : [entry, "accounts", "set-login", ...args];
    const reply = mkdtempSync(join(root, "reply-"));
    const outPath = join(reply, "out"), errPath = join(reply, "err");
    const out = openSync(outPath, "wx", 0o600), err = openSync(errPath, "wx", 0o600);
    const options = { cwd: home, env: childEnv, stdio: ["ignore", out, err] };
    const finish = (code, signal) => {
      assert.equal(signal, null);
      assert.equal(existsSync(log), false, "set-login made no hc call");
      return { code, stdout: readFileSync(outPath, "utf8"), stderr: readFileSync(errPath, "utf8") };
    };
    const close = () => { closeSync(out); closeSync(err); };
    return { argv, options, finish, close };
  }
  function run(args, entry = PACK, extra) {
    const { argv, options, finish, close } = call(args, entry, extra);
    try {
      const result = spawnSync(process.execPath, argv, { ...options, timeout: 15_000 });
      if (result.error) throw result.error;
      return finish(result.status, result.signal);
    } finally { close(); }
  }
  function start(args) {
    const { argv, options, finish, close } = call(args, PACK);
    try {
      const child = spawn(process.execPath, argv, options);
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          try { resolve(finish(code, signal)); } catch (error) { reject(error); }
        });
      });
    } finally { close(); }
  }
  const read = () => readFileSync(file, "utf8");
  const op = (extra = {}) => ({ kind: "use", id: "slot-two", snapshot, home: app, core: "core-one", ...extra });
  const io = (extra = {}) => ({ appHome: () => app, coreHere: async () => "core-one", ...extra });
  const install = (leaf, contents = "") => {
    const path = join(app, leaf);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  };
  const confirm = (version = "1.2.3") => install(WRITER_FILE, JSON.stringify({ v: 1, setLogin: true, version }));
  return { root, home, app, env, folder, other, file, lock, logins, text, snapshot, run, start, read, op, io, install, confirm };
}

function success(reply, id, text) {
  assert.deepEqual(reply, { code: 0, stdout: `${JSON.stringify({ ok: true, snapshot: sha256(text), use: id })}\n`, stderr: "" });
}

test("use, add and remove rename a 0600 record in the panel format and return its SHA-256", async (t) => {
  const s = scene(t);
  const inode = statSync(s.file).ino;
  success(s.run(use("slot-two", snapshotOf(s.text))), "slot-two", format("slot-two", s.logins));
  assert.notEqual(statSync(s.file).ino, inode);
  assert.equal(statSync(s.file).mode & 0o777, 0o600);
  const next = [...s.logins, { id: "slot-three", dir: s.other }];
  success(s.run(["--add", "slot-three", "--dir", s.other, "--snapshot", sha256(s.read())]), "slot-two", format("slot-two", next));
  let wrote;
  await writeRecord(s.app, { use: "slot-two", logins: next }, null, (_, text) => { wrote = text; });
  assert.equal(s.read(), wrote);
  success(s.run(["--remove", "slot-three", "--snapshot", sha256(s.read())]), "slot-two", format("slot-two", s.logins));
  assert.equal(s.read(), format("slot-two", s.logins));
  assert.deepEqual(readdirSync(s.app), ["claude-logins.json"]);
});

test("a stale snapshot keeps the other edit, and none creates an absent record", (t) => {
  const s = scene(t);
  const edited = format("slot-two", s.logins);
  writeFileSync(s.file, edited);
  assert.deepEqual(s.run(use("default", s.snapshot)), refused("conflict"));
  assert.equal(s.read(), edited);
  rmSync(s.file);
  const added = format("default", s.logins);
  success(s.run(["--add", "slot-two", "--dir", s.folder, "--snapshot", "none"]), "default", added);
  assert.equal(s.read(), added);
});

test("two writers from one snapshot yield one winner and one conflict", async (t) => {
  const s = scene(t);
  const [select, remove] = await Promise.all([
    s.start(use("slot-two", s.snapshot)), s.start(["--remove", "slot-two", "--snapshot", s.snapshot]),
  ]);
  const selected = select.code === 0;
  const text = selected ? format("slot-two", s.logins) : format("default", []);
  success(selected ? select : remove, selected ? "slot-two" : "default", text);
  assert.deepEqual(selected ? remove : select, refused("conflict"));
  assert.equal(s.read(), text);
});

test("bad record, unknown slot, in-use slot, duplicate, bad folder and home report fixed refusals", (t) => {
  const s = scene(t);
  const add = (id, dir) => ["--add", id, "--dir", dir, "--snapshot", s.snapshot];
  for (const [args, error] of [
    [use("slot-three", s.snapshot), "no-slot"], [["--remove", "slot-three", "--snapshot", s.snapshot], "no-slot"],
    [add("slot-two", s.other), "exists"], [add("slot-three", s.folder), "exists"], [add("default", s.other), "exists"],
    [add("slot-three", `${s.other}/`), "bad-folder"], [use("default", s.snapshot, "--expect-home", s.other), "home"],
  ]) {
    assert.deepEqual(s.run(args), refused(error));
    assert.equal(s.read(), s.text);
  }
  assert.deepEqual(s.run(use("default", s.snapshot), PACK, { HERDR_APP_HOME: join(s.root, "missing") }), refused("no-home"));
  const selected = format("slot-two", s.logins);
  writeFileSync(s.file, selected);
  assert.deepEqual(s.run(["--remove", "slot-two", "--snapshot", sha256(selected)]), refused("in-use"));
  assert.equal(s.read(), selected);
  writeFileSync(s.file, "{ CANARY-PLAN-0043");
  assert.deepEqual(s.run(use("default", sha256(s.read()))), refused("bad-record"));
  assert.equal(s.read(), "{ CANARY-PLAN-0043");
});

test("a legacy login lock stays busy even when its mtime is old", (t) => {
  const s = scene(t);
  const token = `${process.pid} holder`;
  writeFileSync(s.lock, token);
  // Future mtime keeps the busy case independent of a slow CI worker.
  const fresh = new Date(Date.now() + 60_000);
  utimesSync(s.lock, fresh, fresh);
  assert.deepEqual(s.run(use("slot-two", s.snapshot)), refused("busy"));
  assert.equal(readFileSync(s.lock, "utf8"), token);
  assert.equal(s.read(), s.text);
  utimesSync(s.lock, 1, 1);
  assert.deepEqual(s.run(use("slot-two", s.snapshot), PACK, { AUTOMAGIK_HERDR_LOCK_STALE_MS: "100" }), refused("busy"));
  assert.equal(readFileSync(s.lock, "utf8"), token);
  assert.equal(s.read(), s.text);
});

test("fleet qualification is checked under the lock, including a panel enabled or downgraded while waiting", async (t) => {
  const s = scene(t);
  const run = (extra) => setLoginRun(s.op(), s.io(extra));
  assert.equal((await run()).ok, true, "absent panel");
  writeFileSync(s.file, s.text);
  mkdirSync(join(s.app, "mods-disabled/am-quota"), { recursive: true });
  assert.equal((await run()).ok, true, "disabled panel");
  writeFileSync(s.file, s.text);
  assert.deepEqual(await run({ lock: () => { throw new Error("CANARY-STDERR-0043"); } }), { error: "failed" });
  const activate = (path, fn) => {
    assert.equal(path, s.lock);
    mkdirSync(join(s.app, "mods/am-quota"), { recursive: true });
    return fn();
  };
  assert.deepEqual(await run({ lock: activate }), { error: "update-first" });
  s.install(PANEL_MARKER);
  assert.deepEqual(await run(), { error: "update-first" }, "missing sidebar markers");
  for (const marker of SIDEBAR_MARKERS) s.install(marker);
  s.install(SIDEBAR_VERSION, "1.2.3\n");
  s.confirm();
  const unknown = { dir: () => "unknown", readable: () => "yes", readText: () => null };
  assert.deepEqual(await run({ capabilityIo: unknown }), { error: "update-first" }, "folder inspection refused");
  assert.deepEqual(await run({ lock: (_, fn) => { rmSync(join(s.app, PANEL_MARKER)); return fn(); } }), { error: "update-first" });
  assert.equal(s.read(), s.text);
});

test("on requires readable markers and confirmation for the current version, while local edits still work", async (t) => {
  const s = scene(t);
  const run = () => setLoginRun(s.op(), s.io());
  s.install(PANEL_MARKER);
  const [marker] = SIDEBAR_MARKERS.map((path) => s.install(path));
  s.install(SIDEBAR_VERSION, "1.2.3\n");
  assert.deepEqual(await run(), { error: "update-first" });
  s.install(WRITER_FILE, "{broken");
  assert.deepEqual(await run(), { error: "update-first" });
  s.confirm("1.2.2");
  assert.deepEqual(await run(), { error: "update-first" });
  assert.equal(s.read(), s.text);
  success(s.run(use("slot-two", s.snapshot)), "slot-two", format("slot-two", s.logins));
  const added = [...s.logins, { id: "slot-three", dir: s.other }];
  success(s.run(["--add", "slot-three", "--dir", s.other, "--snapshot", sha256(s.read())]), "slot-two", format("slot-two", added));
  success(s.run(["--remove", "slot-three", "--snapshot", sha256(s.read())]), "slot-two", format("slot-two", s.logins));
  writeFileSync(s.file, s.text);
  s.confirm();
  if (process.getuid?.() !== 0) {
    chmodSync(marker, 0o000);
    assert.ok(statSync(marker).isFile());
    assert.deepEqual(await run(), { error: "update-first" });
    assert.equal(s.read(), s.text);
    chmodSync(marker, 0o600);
  }
  assert.equal((await run()).ok, true);
});

test("core binding refuses the wrong core, no answer and ambiguous sessions before reading the record", async (t) => {
  const s = scene(t);
  const untouchable = { readBytes: () => assert.fail("read the record"), lock: () => assert.fail("took the lock") };
  const refuseCore = async (coreHere, error) => assert.deepEqual(await setLoginRun(s.op(), s.io({ ...untouchable, coreHere })), { error });
  await refuseCore(async () => "core-two", "wrong-core");
  await refuseCore(async () => null, "no-core");
  const status = (env, { sockets: [path], timeoutMs }) => {
    assert.equal(env.AUTOMAGIK_HERDR_CORE_SOCKET, runtime);
    assert.ok(timeoutMs <= 2000);
    return { status: { core: { id: path.endsWith("one.sock") ? "core-one" : "core-two" } } };
  };
  const runtime = join(s.env.XDG_RUNTIME_DIR, "herdr-core", "one.sock");
  const recorded = join(s.root, "two.sock"), lock = join(s.env.XDG_STATE_HOME, "herdr-core", "other", "core.lock");
  for (const [path, text] of [[runtime, ""], [lock, `${recorded}\n`]]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  assert.deepEqual(new Set(userCoreSockets(s.env)), new Set([s.env.AUTOMAGIK_HERDR_CORE_SOCKET, runtime, recorded]));
  const dispatched = { ...s.env, AUTOMAGIK_HERDR_CORE_SOCKET: runtime };
  await refuseCore(() => coreHere(dispatched, { status, sockets: () => [runtime, recorded] }), "no-core");
  assert.equal(await coreHere(dispatched, { status, sockets: () => [runtime, runtime] }), "core-one");
  assert.equal(s.read(), s.text);
  assert.deepEqual(s.run(use("slot-two", s.snapshot, "--expect-core", "core-one", "--expect-home", s.app,
    "--expect-slot", "a".repeat(64), "--expect-eff", "b".repeat(64), ...fenceArgs)), refused("no-core"));
  assert.equal(s.read(), s.text);
  assert.equal((await setLoginRun(s.op(), s.io())).ok, true);
  writeFileSync(s.file, s.text);
  const skip = { coreHere: () => assert.fail("opened a core socket") };
  assert.equal((await setLoginRun(s.op({ core: undefined }), s.io(skip))).ok, true);
});

test("slot identity changes and incomplete probes refuse with the same record bytes", async (t) => {
  const s = scene(t);
  const args = ["--expect-slot", idDigest("slot-two", B, sha256), "--expect-eff", idDigest("default", A, sha256)];
  assert.doesNotMatch(args.join(" "), /example\.test/);
  const { op } = setLoginOp({ use: "slot-two", snapshot: s.snapshot, "expect-core": "core-one",
    "expect-home": s.app, "expect-slot": args[1], "expect-eff": args[3], ...fence });
  const observation = { record: "ok", snapshot: s.snapshot, slotsComplete: true, effective: "default", email: A,
    state: "eligible", slots: [{ id: "slot-two", state: "eligible", email: B }] };
  const inode = statSync(s.file).ino;
  for (const [patch, error] of [
    [{ slots: [{ id: "slot-two", state: "eligible", email: C }] }, "slot-changed"],
    [{ email: C }, "slot-changed"], [{ slotsComplete: false }, "timeout"], [{ state: "failed" }, "timeout"],
    [{ snapshot: "c".repeat(64) }, "conflict"],
  ]) {
    const attempt = { ...op.attempt, n: 2 + readdirSync(s.app).filter((name) => name.includes(".cancelled-")).length };
    const result = await setLoginRun({ ...op, attempt }, s.io({ readClaude: async () => ({ ...observation, ...patch }) }));
    assert.deepEqual(result, { error });
    assert.equal(s.read(), s.text);
    assert.equal(statSync(s.file).ino, inode);
  }
  assert.equal((await setLoginRun(op, s.io({ readClaude: async () => observation }))).ok, true);
});

test("usage has one fixed line for missing, conflicting, duplicate or malformed flags", (t) => {
  const s = scene(t);
  for (const args of [[], use("default", "CANARY-PLAN-0043"), [...use("default", s.snapshot), "--remove", "slot-two"],
    ["--add", "slot-three", "--dir", "relative", "--snapshot", s.snapshot], [...use("default", s.snapshot), "--use", "default"],
    [...use("default", s.snapshot), "--expect-home", "relative"], [...use("default", s.snapshot), "--expect-core", "two cores"],
    ["--remove", "slot-two", "--snapshot", s.snapshot, "--expect-core", "core-one"], [...use("default", s.snapshot), "--other"]]) {
    assert.deepEqual(s.run(args), usage);
  }
  assert.equal(s.read(), s.text);
});

test("am, the pack command and both dedicated entry points agree and leave stale links alone", (t) => {
  const s = scene(t);
  const link = join(s.home, ".local/bin/am");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(s.root, "stale"), link);
  for (const entry of [PACK, AM, READER, AM_READER]) {
    writeFileSync(s.file, s.text);
    success(s.run(use("slot-two", s.snapshot), entry), "slot-two", format("slot-two", s.logins));
    assert.equal(readlinkSync(link), join(s.root, "stale"));
  }
});

test("a mixed folder without accountsWrite.js fails at link time and keeps the record", (t) => {
  const s = scene(t);
  const closure = join(s.root, "mixed");
  cpSync(dirname(dirname(READER)), closure, { recursive: true });
  rmSync(join(closure, "accountsWrite.js"));
  const reply = s.run(use("slot-two", s.snapshot), join(closure, "bin/accounts.mjs"));
  assert.equal(reply.code, 1);
  assert.equal(reply.stdout, "");
  assert.match(reply.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*accountsWrite\.js/);
  assert.equal(s.read(), s.text);
});

test("loginEdit keeps the record parser and the panel's next-slot rule", () => {
  for (const text of ["{", "[]", "null", '{"logins":[]}', '{"use":"x"}', '{"use":"2","logins":[{"id":"default","dir":"/a"}]}',
    '{"use":"2","logins":[{"id":"2","dir":"/a"},{"id":"2","dir":"/b"}]}', '{"use":"2","logins":[{"id":"-x","dir":"/a"}]}']) {
    assert.deepEqual(loginEdit(text, { kind: "use", id: "default" }), { error: "bad-record" });
  }
  const edit = loginEdit('{"use":"2","logins":[{"id":"2","dir":"/a","extra":1}]}', { kind: "use", id: "default" });
  assert.deepEqual(edit, { use: "default", text: format("default", [{ id: "2", dir: "/a", extra: 1 }]) });
  for (const logins of [[], [{ id: "2", dir: "/elsewhere" }], [{ id: "3", dir: "/scratch/.claude-2" }],
    [{ id: "2", dir: "/elsewhere" }, { id: "other", dir: "/scratch/.claude-3" }]]) {
    assert.equal(nextSlotDir("/scratch/", logins), nextSlot(logins, "/scratch/").dir);
  }
});

test("a failed rename removes the private temporary file and returns only a fixed failure", async (t) => {
  const s = scene(t);
  const result = await setLoginRun(s.op(), s.io({ rename: (tmp) => {
    assert.equal(statSync(tmp).mode & 0o777, 0o600);
    throw new Error("CANARY-STDERR-0043");
  } }));
  assert.deepEqual(result, { error: "failed" });
  assert.deepEqual(readdirSync(s.app), ["claude-logins.json"]);
  assert.equal(s.read(), s.text);
});

test("set-login refuses one answering core alongside a timeout before any write", async (t) => {
  const s = scene(t);
  const socket = s.env.AUTOMAGIK_HERDR_CORE_SOCKET;
  const identify = () => coreHere(s.env, { sockets: () => [join(s.root, "other.sock")],
    status: (_env, { sockets: [path] }) => path === socket ? { status: { core: { id: "core-one" } } } : { error: "timed out" } });
  const result = await setLoginRun(s.op(), s.io({ coreHere: identify,
    readBytes: () => assert.fail("read the record"), lock: () => assert.fail("took the lock") }));
  assert.deepEqual(result, { error: "no-core" });
  assert.equal(s.read(), s.text);
});

test("cancelling a linked attempt under the login lock refuses its paused writer", async (t) => {
  const s = scene(t);
  const bound = { "expect-home": s.app, "expect-core": "core-one", ...fence };
  const write = { ...bound, use: "slot-two", snapshot: s.snapshot,
    "expect-slot": idDigest("slot-two", B, sha256), "expect-eff": idDigest("default", A, sha256) };
  const { op } = setLoginOp(write);
  const { op: cancel } = setLoginOp({ ...bound, "cancel-attempt": true });
  assert.deepEqual(setLoginOp({ ...write, attempt: undefined }), { usage: true });
  let started, resume;
  const probing = new Promise((resolve) => { started = resolve; });
  const delayed = setLoginRun(op, s.io({ readClaude: () => {
    started();
    return new Promise((resolve) => { resume = resolve; });
  } }));
  await probing;
  assert.deepEqual(await setLoginRun(cancel, s.io()), { ok: true, cancelled: true, outcome: "indeterminate", snapshot: null });
  const [receipt] = readdirSync(s.app).filter((name) => name.startsWith("claude-logins.json.cancelled-"));
  assert.equal(statSync(join(s.app, receipt)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(s.app, receipt), "utf8")), { outcome: "indeterminate", snapshot: null });
  resume({ record: "ok", snapshot: s.snapshot, slotsComplete: true, effective: "default", email: A,
    state: "eligible", slots: [{ id: "slot-two", state: "eligible", email: B }] });
  assert.deepEqual(await delayed, { error: "stale" });
  assert.equal(s.read(), s.text);
});

test("a linked dispatch keeps its written snapshot through a local switch-back and repeated cancellation", async (t) => {
  const s = scene(t);
  const bound = { "expect-home": s.app, "expect-core": "core-one", ...fence };
  const write = (dispatch, snapshot) => setLoginOp({ ...bound, dispatch, use: "slot-two", snapshot,
    "expect-slot": idDigest("slot-two", B, sha256), "expect-eff": idDigest("default", A, sha256) }).op;
  const cancel = (dispatch) => setLoginOp({ ...bound, dispatch, "cancel-attempt": true }).op;
  const io = s.io({ readClaude: async () => ({ record: "ok", snapshot: s.snapshot, slotsComplete: true,
    effective: "default", email: A, state: "eligible", slots: [{ id: "slot-two", state: "eligible", email: B }] }) });
  const first = "1".repeat(32), second = "2".repeat(32);
  const landed = await setLoginRun(write(first, s.snapshot), io);
  assert.equal(landed.snapshot, sha256(s.read()));
  success(s.run(use("default", landed.snapshot)), "default", s.text);
  assert.equal(s.read(), s.text);
  for (let n = 0; n < 2; n += 1) {
    assert.deepEqual(await setLoginRun(cancel(first), io),
      { ok: true, cancelled: true, outcome: "written", snapshot: landed.snapshot });
  }
  assert.deepEqual(await setLoginRun(write(second, "f".repeat(64)), io), { error: "conflict" });
  assert.deepEqual(await setLoginRun(cancel(second), io), { ok: true, cancelled: true, outcome: "not-written", snapshot: null });
  assert.deepEqual(await setLoginRun(write(first, s.snapshot), io), { error: "stale" });
  assert.equal(s.read(), s.text);
});

test("an interrupted completion receipt fences the dispatch with an indeterminate outcome", async (t) => {
  const s = scene(t);
  const bound = { "expect-home": s.app, "expect-core": "core-one", ...fence };
  const { op } = setLoginOp({ ...bound, use: "slot-two", snapshot: s.snapshot,
    "expect-slot": idDigest("slot-two", B, sha256), "expect-eff": idDigest("default", A, sha256) });
  const cancellation = setLoginOp({ ...bound, "cancel-attempt": true }).op;
  let landed = false;
  const result = await setLoginRun(op, s.io({ readClaude: async () => ({ record: "ok", snapshot: s.snapshot,
    slotsComplete: true, effective: "default", email: A, state: "eligible", slots: [{ id: "slot-two", state: "eligible", email: B }] }),
    rename: (from, to) => {
      if (landed) throw new Error("fixture lost the completion receipt");
      renameSync(from, to);
      landed = to === s.file;
    } }));
  assert.deepEqual(result, { error: "failed" });
  assert.equal(JSON.parse(s.read()).use, "slot-two");
  success(s.run(use("default", sha256(s.read()))), "default", s.text);
  assert.deepEqual(await setLoginRun(cancellation, s.io()),
    { ok: true, cancelled: true, outcome: "indeterminate", snapshot: null });
});

test("a linked use changes only use and preserves extra record and slot fields", async (t) => {
  const s = scene(t);
  const original = { use: "default", logins: [{ ...s.logins[0], label: "Second login", extra: { v: 1 } }],
    memo: ["kept"] };
  const bytes = JSON.stringify(original);
  writeFileSync(s.file, bytes);
  const result = await setLoginRun(s.op({ snapshot: sha256(bytes) }), s.io());
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(s.read()), { ...original, use: "slot-two" });
});

const qualifiedOptions = (s, email = A) => ({ use: "slot-two", snapshot: s.snapshot, "expect-qualified": true,
  "expect-home": s.app, "expect-slot": idDigest("slot-two", B, sha256), "expect-eff": idDigest("default", email, sha256) });
const optionArgs = (values) => Object.entries(values).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value]);
const qualifiedRead = (s) => async () => ({ record: "ok", snapshot: s.snapshot, slotsComplete: true,
  effective: "default", email: A, state: "eligible", slots: [{ id: "slot-two", state: "eligible", email: B }] });

function installClaude(s, defaultEmail = A) {
  const normal = defaultEmail ? JSON.stringify({ loggedIn: true, email: defaultEmail, authMethod: "claude.ai" })
    : JSON.stringify({ loggedIn: false });
  const alternate = JSON.stringify({ loggedIn: true, email: B, authMethod: "claude.ai" });
  exe(join(s.home, "bin/claude"), `#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 3
case "$CLAUDE_CONFIG_DIR" in
  */login-é) printf '%s\\n' '${alternate}' ;;
  *) printf '%s\\n' '${normal}' ;;
esac
`);
}

test("qualified local use accepts an absent, disabled or confirmed panel and refuses unconfirmed or unknown panels", (t) => {
  const s = scene(t);
  installClaude(s);
  const args = optionArgs(qualifiedOptions(s));
  const writes = (entry = PACK) => {
    success(s.run(args, entry), "slot-two", format("slot-two", s.logins));
    writeFileSync(s.file, s.text);
  };
  writes();
  mkdirSync(join(s.app, "mods-disabled/am-quota"), { recursive: true });
  writes(AM_READER);
  const panel = s.install("mods/am-quota");
  assert.deepEqual(s.run(args), refused("update-first"), "unknown panel");
  assert.equal(s.read(), s.text);
  rmSync(panel);
  s.install(PANEL_MARKER);
  for (const marker of SIDEBAR_MARKERS) s.install(marker);
  s.install(SIDEBAR_VERSION, "1.2.3\n");
  assert.deepEqual(s.run(args), refused("update-first"), "unconfirmed panel");
  assert.equal(s.read(), s.text);
  s.confirm();
  writes();
});

test("qualified local use checks a panel that was enabled while acquiring the login lock", async (t) => {
  const s = scene(t);
  const { op } = setLoginOp(qualifiedOptions(s));
  const result = await setLoginRun(op, s.io({ readClaude: qualifiedRead(s), lock: (path, run) => {
    assert.equal(path, s.lock);
    mkdirSync(join(s.app, "mods/am-quota"), { recursive: true });
    return run();
  } }));
  assert.deepEqual(result, { error: "update-first" });
  assert.equal(s.read(), s.text);
});

test("qualified local use preserves the panel's edit when it activates during the temporary write", async (t) => {
  const s = scene(t);
  const { op } = setLoginOp(qualifiedOptions(s));
  const competing = format("default", [...s.logins, { id: "slot-three", dir: s.other }]);
  let temp;
  const result = await setLoginRun(op, s.io({ readClaude: qualifiedRead(s), writeTemp: (path, text) => {
    temp = path;
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    mkdirSync(join(s.app, "mods/am-quota"), { recursive: true });
    writeFileSync(s.file, competing);
  } }));
  assert.deepEqual(result, { error: "update-first" });
  assert.equal(s.read(), competing);
  assert.equal(existsSync(temp), false);
  assert.deepEqual(readdirSync(s.app).sort(), ["claude-logins.json", "mods"]);
});

test("qualified use requires local use with both login digests and an expected home", (t) => {
  const s = scene(t);
  const valid = qualifiedOptions(s);
  const bound = { "expect-qualified": true, "expect-home": s.app, "expect-core": "core-one" };
  const args = [
    ["--add", "slot-three", "--dir", s.other, "--snapshot", s.snapshot, "--expect-qualified"],
    ["--remove", "slot-two", "--snapshot", s.snapshot, "--expect-qualified"],
    optionArgs({ ...bound, ...fence, "cancel-attempt": true }),
    optionArgs({ ...bound, "launch-login": true }),
    optionArgs({ ...valid, "expect-core": bound["expect-core"], ...fence }),
  ];
  for (const key of ["expect-home", "expect-slot", "expect-eff"]) {
    args.push(optionArgs(Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))));
  }
  for (const options of args) assert.deepEqual(s.run(options), usage);
  assert.equal(s.read(), s.text);
  assert.deepEqual(readdirSync(s.app), ["claude-logins.json"]);
});

test("a mixed folder whose older operation parser ignores qualification refuses usage", (t) => {
  const s = scene(t);
  installClaude(s);
  const closure = join(s.root, "mixed");
  cpSync(dirname(dirname(READER)), closure, { recursive: true });
  const writer = join(closure, "accountsWrite.js");
  renameSync(writer, join(closure, "accountsWrite-current.js"));
  writeFileSync(writer, `import { setLoginOp as current } from "./accountsWrite-current.js";
export * from "./accountsWrite-current.js";
export function setLoginOp(opts) {
  const { "expect-qualified": ignored, ...old } = opts;
  return current(old);
}
`);
  assert.deepEqual(s.run(optionArgs(qualifiedOptions(s)), join(closure, "bin/accounts.mjs")), usage);
  assert.equal(s.read(), s.text);
  assert.deepEqual(readdirSync(s.app), ["claude-logins.json"]);
});

test("qualified use can switch away from a signed-out default and refuses an own launcher with the same digests", (t) => {
  const s = scene(t);
  installClaude(s, null);
  const args = optionArgs(qualifiedOptions(s, ""));
  success(s.run(args), "slot-two", format("slot-two", s.logins));
  writeFileSync(s.file, s.text);
  const ownLauncher = join(s.home, "bin/custom-claude");
  const marker = join(s.root, "launcher-ran");
  exe(ownLauncher, `#!/bin/sh\ntouch "${marker}"\n`);
  s.install("programs.json", JSON.stringify({ programs: { claude: { run: [ownLauncher] } } }));
  assert.deepEqual(s.run(args), refused("slot-changed"));
  assert.equal(s.read(), s.text);
  assert.equal(existsSync(marker), false);
});
