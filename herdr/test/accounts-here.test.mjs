import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { codexHome, CODEX_MAX_BYTES, exceptions, hereAnswer, HERE_BUDGET_MS, HERE_MAX_BYTES, panelState, readClaude, readCodex, versions } from "../mods/am-sidebar/accountsHere.js";
import { accountFingerprint, fingerprint } from "../mods/am-sidebar/accountsRows.js";
import { readHere } from "../mods/am-sidebar/accountsFleet.js";
import { AUTH_SCRIPT, FOLDER_SCRIPT, PRESENT_SCRIPT } from "../mods/am-sidebar/loginProbe.js";
import { paneEnvOf } from "../mods/am-sidebar/agentPath.mjs";
import { fingerprint as localFingerprint, tokenIdentity } from "../mods/am-quota/translate.js";
import { AM, AM_READER, PACK, READER, auth, exe, fakeClaude, fpr, json, scene, snapshot } from "./accounts-fixture.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const missing = (code = "ENOENT") => Object.assign(new Error(), { code });
const status = (email, extra = {}) => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, ...extra }) });
const fileIO = (files = new Map(), more = {}) => ({
  env: {}, home: "/example-home", appHome: "/app", amStore: "/am", realpath: (p) => p, isDir: () => true, paneEnvOf, now: Date.now, sha256,
  readBytes: (path) => { if (files.has(path)) return Buffer.from(files.get(path)); throw missing(); },
  exec: async (_cmd, args) => {
    if (args[1] === FOLDER_SCRIPT) return { code: 0, stdout: "ok\n" };
    assert.equal(args[1], AUTH_SCRIPT);
    return status(args[3]?.startsWith("CLAUDE_CONFIG_DIR=") ? "BO@example.com" : "ANA@example.com");
  },
  ...more,
});

test("codex: CODEX_HOME else ~/.codex; absent, unreadable, present; the account-id fingerprint, no-account-id never the refresh-token fallback; last_refresh only when shaped; generation is the file's SHA-256", () => {
  assert.deepEqual(codexHome({}, "/example-home"), { home: "/example-home/.codex", from: "default" });
  assert.deepEqual(codexHome({ CODEX_HOME: " ~/other/// " }, "/example-home"), { home: "/example-home/other", from: "env" });
  assert.deepEqual(codexHome({ CODEX_HOME: " ~ " }, "/example-home"), { home: "/example-home", from: "env" });
  for (const [code, expected] of [["ENOENT", "absent"], ["ENOTDIR", "absent"], ["EACCES", "unreadable"]]) {
    assert.equal(readCodex(fileIO(new Map(), { readBytes: () => { throw missing(code); } })).file, expected);
  }
  assert.equal(readCodex(fileIO(new Map(), { readBytes: () => Buffer.alloc(CODEX_MAX_BYTES + 1) })).file, "unreadable");
  const lastRefresh = "2026-11-20T10:00:00.123456789+00:00";
  const data = auth("account-a", { last_refresh: lastRefresh });
  const read = readCodex(fileIO(new Map([["/example-home/.codex/auth.json", data]])));
  assert.deepEqual(read, { home: "/example-home/.codex", from: "default", file: "present", account: fpr("account-a"),
    accountId: "present", lastRefresh, generation: sha256(data) });
  assert.doesNotMatch(JSON.stringify(read), /CANARY-REFRESH-0043/);
  for (const text of ["{", auth("", { last_refresh: "yesterday" })]) {
    const noId = readCodex(fileIO(new Map([["/example-home/.codex/auth.json", text]])));
    assert.equal(noId.file, "present");
    assert.deepEqual([noId.account, noId.accountId, noId.lastRefresh], [null, "absent", null]);
  }
});

test("fingerprint and accountFingerprint match translate.js on a corpus (ASCII, non-ASCII, empty, no account_id)", () => {
  for (const id of ["account-a", "ábaco", "🪁", "", undefined]) {
    assert.equal(fingerprint(id), localFingerprint(id));
    const text = auth(id ?? "");
    assert.equal(accountFingerprint(text), id ? tokenIdentity("codex", text) : null);
  }
  assert.notEqual(tokenIdentity("codex", auth("")), accountFingerprint(auth("")));
  assert.equal(accountFingerprint(auth("  account-a ")), fpr("account-a"));
});

test("claude slots: eligible, not-signed-in, bad-folder, override (a method, a moved folder, a credential variable), ambiguous, timeout, failed; emails lowercased; the default slot included; a signed-out answer's email is dropped", async () => {
  const logins = ["out", "bad", "key", "moved", "same", "late", "nobin", "broken"].map((id) => ({ id, dir: id === "bad" ? "relative" : `/example-home/${id}` }));
  const files = new Map([["/app/claude-logins.json", JSON.stringify({ use: "default", logins })]]);
  const io = fileIO(files);
  const answers = { out: { code: 1, stdout: '{"loggedIn":false,"email":"cy@example.com"}' },
    key: status("bo@example.com", { authMethod: "apiKey" }), moved: status("cy@example.com", { configDirectory: "/elsewhere" }),
    same: status("ANA@example.com"), late: { late: true }, nobin: { code: 127 }, broken: { code: 1, stdout: "CANARY-STATUS-0043" } };
  const normal = io.exec;
  io.exec = async (cmd, args) => {
    const id = args[3]?.split("/").at(-1);
    return args[1] === AUTH_SCRIPT && id in answers ? answers[id] : normal(cmd, args);
  };
  const read = await readClaude(io, Date.now() + 1000);
  assert.deepEqual(read.slots.map(({ id, state, email }) => [id, state, email]), [
    ["default", "ambiguous", "ana@example.com"], ["out", "not-signed-in", null], ["bad", "bad-folder", null],
    ["key", "override", "bo@example.com"], ["moved", "override", "cy@example.com"],
    ["same", "ambiguous", "ana@example.com"], ["late", "timeout", null], ["nobin", "failed", null], ["broken", "failed", null],
  ]);
  const override = fileIO(new Map(), { env: { ANTHROPIC_API_KEY: "CANARY-KEY-0043" } });
  const calls = [];
  override.exec = (cmd, args) => { calls.push(args); return normal(cmd, args); };
  assert.equal((await readClaude(override, Date.now() + 1000)).state, "override");
  assert.ok(calls.length > 0 && calls.every((args) => !args.includes(PRESENT_SCRIPT)));
  assert.equal((await readClaude(fileIO(), Date.now() + 1000)).state, "eligible");
});

test("a credential variable overrides even where printenv fails, and its value never leaves", (t) => {
  const s = scene(t);
  exe(join(s.bin, "printenv"), "#!/bin/sh\nexit 127\n");
  const result = s.run(READER, ["here"], { ANTHROPIC_API_KEY: "CANARY-KEY-0043" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().claude.slots[0].state, "override");
  assert.doesNotMatch(result.stdout, /CANARY-KEY-0043/);
});

test("an overridden slot keeps its email in the inventory but its route names no account", (t) => {
  const s = scene(t);
  const result = s.run(READER, ["here"], { ANTHROPIC_API_KEY: "CANARY-KEY-0043" });
  assert.equal(result.code, 0, result.stderr);
  const { slots: [{ email, state }], routes, email: effective, routesDiffer } = result.json().claude;
  assert.deepEqual({ email, state }, { email: "ana@example.com", state: "override" });
  assert.deepEqual(routes.record, { email: null, state: "failed" });
  assert.equal(effective, null);
  assert.equal(routesDiffer, false);
  assert.doesNotMatch(result.stdout, /CANARY-KEY-0043/);
});

test("selected, effective and snapshot come from one read: no file is default with a null snapshot; a bad record or a slot's bad folder is effective default; the record file is read once", async () => {
  for (const [text, record, selected] of [[null, "absent", "default"], ["{", "bad", "default"],
    ['{"use":"missing","logins":[]}', "bad", "default"], ['{"use":"2","logins":[{"id":"2","dir":"relative"}]}', "ok", "2"]]) {
    let reads = 0;
    const io = fileIO(new Map(), { readBytes: (path) => {
      assert.equal(path, "/app/claude-logins.json");
      reads += 1;
      if (text === null) throw missing();
      return Buffer.from(text);
    } });
    const result = await readClaude(io, Date.now() + 1000);
    assert.equal(reads, 1);
    assert.deepEqual([result.record, result.selected, result.effective, result.snapshot], [record, selected, "default", text === null ? null : sha256(text)]);
  }
});

test("routes: inherited slot 2 with use default, each route reported on its own, and the bare route uses the shipped claude word", async (t) => {
  const s = scene(t);
  const slot = join(s.home, ".claude-2");
  mkdirSync(slot);
  json(join(s.app, "claude-logins.json"), { use: "default", logins: [{ id: "2", dir: slot }] });
  const run = s.run(PACK, ["accounts", "here"], { CLAUDE_CONFIG_DIR: slot });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json().claude.routes, { bare: { email: "bo@example.com", state: "eligible" }, record: { email: "ana@example.com", state: "eligible" } });
  assert.equal(run.json().claude.routesDiffer, true);
  for (const [bare, record] of [[{ late: true }, status("ana@example.com")], [status("bo@example.com"), { code: 1, stdout: '{"loggedIn":false}' }]]) {
    const read = await readClaude(fileIO(new Map(), { exec: async (_cmd, args) =>
      args[1] === PRESENT_SCRIPT ? { code: 0, stdout: "" } : args.length === 3 ? bare : record }), Date.now() + 1000);
    assert.deepEqual([read.routes.bare.state, read.routes.record.state], bare.late ? ["timeout", "eligible"] : ["eligible", "not-signed-in"]);
  }
});

test("the read runs no login shell: a SHELL whose startup would leave a mark is never started, and the bare route still reads", (t) => {
  const s = scene(t);
  const shell = join(s.root, "marking-shell"), mark = join(s.root, "shell-ran");
  exe(shell, `#!/bin/sh\necho ran >> "${mark}"\nexec /bin/sh "$@"\n`);
  for (const [cli, args] of [[PACK, ["accounts", "here"]], [READER, ["here"]]]) {
    const run = s.run(cli, args, { SHELL: shell });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.json().claude.routes.bare, { email: "ana@example.com", state: "eligible" });
  }
  assert.equal(existsSync(mark), false);
});

test("the record route is probed only for the shipped claude run: any other launcher is unresolved, runs nothing and leaves the effective account unknown", (t) => {
  const s = scene(t);
  const programs = join(s.app, "programs.json"), other = join(s.bin, "claude-other"), script = join(s.bin, "claude-cy.sh");
  const cy = join(s.bin, "cy"), ana = join(s.bin, "ana");
  const mark = join(s.root, "launcher-ran"), argv = join(s.root, "claude-argv");
  exe(cy, fakeClaude("cy@example.com"));
  exe(ana, fakeClaude("ana@example.com"));
  const markAndRun = `echo ran >> "${mark}"; exec "${cy}" "$@"`;
  for (const path of [other, script, ...["bun", "env", "npx"].map((name) => join(s.bin, name))]) {
    exe(path, `#!/bin/sh\n${markAndRun}\n`);
  }
  exe(join(s.bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argv}"\nexec "${ana}" "$@"\n`);
  const eligible = { email: "ana@example.com", state: "eligible" };
  const unresolved = { email: null, state: "unresolved" };
  // Launcher words are checked as whole argv words: a scratch path may contain "-lc".
  const canary = /CANARY-KEY-0043/;
  const launcherWords = new Set(["--settings", "-lc", "x", "-C"]);
  for (const [i, words] of [
    ["claude"], [other], ["/old-program/claude"], ["sh", script], ["claude", "--settings", "/s.json"],
    ["bun", "x", "claude"], ["env", "-C", s.root, "sh", "-lc", markAndRun, "sh"],
    ["env", "CANARY_VAR=CANARY-KEY-0043", "claude"], ["npx", "@anthropic-ai/claude-code"],
    ["sh", "-lc", markAndRun, "sh"],
  ].entries()) {
    json(programs, { programs: { claude: { run: words } } });
    const run = s.run(READER, ["here"]);
    assert.equal(run.code, 0, run.stderr);
    const { email, state, routes, routesDiffer, slots } = run.json().claude;
    const expected = i === 0 ? eligible : unresolved;
    assert.deepEqual({ email, state }, expected);
    assert.deepEqual(routes, { record: expected, bare: eligible });
    assert.equal(routesDiffer, false);
    assert.deepEqual(slots.map(({ email, state }) => ({ email, state })), [eligible]);
    assert.doesNotMatch(run.stdout, canary);
  }
  assert.equal(existsSync(mark), false);
  const calls = readFileSync(argv, "utf8");
  assert.doesNotMatch(calls, canary);
  for (const line of calls.trim().split("\n")) {
    assert.deepEqual(line.split(" ").filter((w) => launcherWords.has(w)), [], line);
  }
});

test("an unreadable or FIFO programs.json fails only the Claude record route: Codex and the bare route still read, within the budget", async (t) => {
  const check = (t, create) => {
    const s = scene(t);
    writeFileSync(join(s.codex, "auth.json"), auth());
    create(join(s.app, "programs.json"));
    const r = s.run(READER, ["here"], {}, { timeout: HERE_BUDGET_MS + 5000 });
    assert.equal(r.code, 0, r.stderr);
    const { codex, claude } = r.json();
    assert.equal(codex.file, "present");
    assert.deepEqual(claude.routes.record, { email: null, state: "failed" });
    assert.deepEqual(claude.routes.bare, { email: "ana@example.com", state: "eligible" });
    assert.deepEqual(claude.slots[0], { id: "default", dir: null, email: "ana@example.com", state: "eligible" });
    assert.deepEqual([claude.email, claude.state], [null, "failed"]);
  };
  await t.test("unreadable file", (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read a file with mode 000");
    check(t, (path) => writeFileSync(path, "{}", { mode: 0o000 }));
  });
  await t.test("FIFO", (t) => check(t, (path) => {
    assert.equal(spawnSync("mkfifo", [path], { stdio: "ignore" }).status, 0);
  }));
});

test("exceptions: bound projects first, then all three lists, capped at 200, with the bound exceptions kept apart", () => {
  const bound = ["/z-bound", "/y-unread"], ten = Array.from({ length: 205 }, (_, i) => `/p-${String(i).padStart(3, "0")}`);
  const files = new Map([["/app/am-sidebar-projects.json", JSON.stringify(["/one", "/same", "/empty", ...ten.slice(0, 5)])],
    ["/app/automagik-herdr/projects.json", '["/two"]'], ["/app/shared.json", JSON.stringify({ "am.sidebar.projects": [
      { key: "/three" }, { key: "/remote", machine: "vm-away" }, ...ten.slice(5)] })]]);
  for (const path of ["/one", "/two", "/three", ...ten]) files.set(`${path}/.herdr/pane-env`, "PATH_PREPEND=/own");
  files.set("/z-bound/.herdr/pane-env", "HERDR_APP_HOME=/elsewhere");
  files.set("/same/.herdr/pane-env", "HERDR_APP_HOME=/app/");
  const io = fileIO(files);
  const read = io.readBytes;
  const touched = [];
  io.readBytes = (p) => { touched.push(p); if (p.startsWith("/y-unread/")) throw missing("EACCES"); return read(p); };
  const answer = exceptions(io, bound);
  assert.deepEqual(answer.bound, [{ project: "/z-bound", why: "own-app-home" }, { project: "/y-unread", why: "unread" }]);
  assert.equal(answer.list.length, 20);
  assert.equal(answer.more, 176);
  assert.equal(touched.filter((p) => p.endsWith("/pane-env")).length, 200);
  for (const p of ["/p-200", "/remote"]) assert.ok(!touched.includes(`${p}/.herdr/pane-env`));
  for (const p of ["/one", "/two", "/three", ...bound]) assert.ok(touched.includes(`${p}/.herdr/pane-env`));
});

test("versions apart and the panel's switch: pack and am VERSION read, never run; a malformed VERSION is null; on, off, absent", () => {
  const files = new Map([["/app/mods/am-sidebar/VERSION", "3.160.3\nexit 91"], ["/am/current/VERSION", "3.161.0\n"]]);
  const io = fileIO(files);
  assert.deepEqual(versions(io), { pack: "3.160.3", am: "3.161.0" });
  files.set("/am/current/VERSION", "#!/bin/sh\nexit 91");
  assert.deepEqual(versions(io), { pack: "3.160.3", am: null });
  for (const [folder, expected] of [["/app/mods/am-quota", "on"], ["/app/mods-disabled/am-quota", "off"], [null, "absent"]]) {
    assert.equal(panelState({ ...io, isDir: (path) => path === folder }), expected);
  }
});

test("read-only: accounts here leaves the home byte for byte through am accounts here and bin/accounts.mjs here; am ls repairs the stale link", (t) => {
  const s = scene(t), link = s.staleLink();
  writeFileSync(join(s.codex, "auth.json"), auth());
  const before = snapshot(s.home);
  for (const [cli, args] of [[PACK, ["accounts", "here", "--json"]], [READER, ["here"]], [AM, ["accounts", "here"]]]) {
    const result = s.run(cli, args);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY-(REFRESH|STATUS)-0043/);
  }
  assert.deepEqual(snapshot(s.home), before);
  assert.deepEqual(s.log(), []);
  assert.match(readlinkSync(link), /automagik-herdr\.mjs$/);
  s.run(PACK, ["ls"]);
  assert.match(readlinkSync(link), /automagik-herdr$/);
});

test("one versioned answer with fixed codes: raw status, including an invalid email, is dropped; under 64 KB with many slots", async () => {
  const slots = Array.from({ length: 201 }, (_, i) => ({ id: `x${i}`, dir: `/example-home/${i}-${"x".repeat(450)}` }));
  const files = new Map([["/app/claude-logins.json", JSON.stringify({ use: "x200", logins: slots })]]);
  const io = fileIO(files);
  const normal = io.exec;
  io.exec = (cmd, args) => args[1] === AUTH_SCRIPT ? status("CANARY-STATUS-0043 thrown", { ignored: "CANARY-STATUS-0043" }) : normal(cmd, args);
  const answer = await hereAnswer(io);
  const text = JSON.stringify(answer);
  assert.ok(Buffer.byteLength(text) < HERE_MAX_BYTES);
  assert.equal(answer.claude.slotsComplete, false);
  assert.equal(answer.claude.slots.length, 16);
  assert.ok(answer.claude.slots.some((s) => s.id === "x200"));
  assert.doesNotMatch(text, /CANARY-STATUS-0043/);
  assert.deepEqual(readHere(text), answer);
});

test("a slow probe is timeout and the program exits within the budget", async (t) => {
  const s = scene(t);
  exe(join(s.bin, "claude"), "#!/bin/sh\nexec sleep 60\n");
  const start = Date.now();
  const result = await s.start(READER, ["here"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().claude.state, "timeout");
  assert.ok(Date.now() - start < HERE_BUDGET_MS + 2000);
});

test("more than eight slow probes: bounded to process exit and no fake claude pid survives", async (t) => {
  const s = scene(t);
  const file = join(s.root, "probe-pids");
  const logins = Array.from({ length: 12 }, (_, i) => {
    const dir = join(s.home, `.claude-${i + 2}`);
    mkdirSync(dir);
    return { id: String(i + 2), dir };
  });
  json(join(s.app, "claude-logins.json"), { use: "default", logins });
  exe(join(s.bin, "claude"), `#!/bin/sh\necho $$ >> "${file}"\nexec sleep 60\n`);
  const start = Date.now();
  const result = await s.start(PACK, ["accounts", "here"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - start < HERE_BUDGET_MS + 2000);
  assert.equal(result.json().claude.slotsComplete, false);
  assert.ok(result.json().claude.slots.some((s) => s.state === "timeout"));
  const pids = readFileSync(file, "utf8").trim().split("\n").map(Number);
  // Thirteen slots overrun the CLI's eight running programs. How many queued probes start
  // before the answer is printed is timing, so only "some started" is asserted; none may survive.
  assert.ok(pids.length > 0);
  for (const pid of pids) {
    for (let i = 0; i < 20; i += 1) {
      try { process.kill(pid, 0); } catch { break; }
      await pause(20);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("--within shortens the target's budget: a sleeping probe is timeout, the reader exits in time and no probe outlives it", async (t) => {
  const s = scene(t);
  const file = join(s.root, "probe-pids");
  exe(join(s.bin, "claude"), `#!/bin/sh\necho $$ >> "${file}"\nexec sleep 60\n`);
  const start = Date.now();
  const result = await s.start(READER, ["here", "--within", "5"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().claude.state, "timeout");
  assert.ok(Date.now() - start < 5000 + 2000);
  const pids = readFileSync(file, "utf8").trim().split("\n").map(Number);
  assert.ok(pids.every((pid) => pid > 0));
  const until = Date.now() + 1000;
  for (const pid of pids) {
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { break; }
      await pause(20);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("--started counts the runtime's start: a reader started late ends at started + within and leaves no probe", async (t) => {
  const s = scene(t);
  const file = join(s.root, "probe-pids");
  exe(join(s.bin, "claude"), `#!/bin/sh\necho $$ >> "${file}"\nexec sleep 60\n`);
  const start = Date.now();
  const result = await s.start(READER, ["here", "--within", "5", "--started", String(Math.floor(start / 1000) - 3)]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().claude.state, "timeout");
  assert.ok(Date.now() - start < 3500);
  const pids = readFileSync(file, "utf8").trim().split("\n").map(Number);
  assert.ok(pids.every((pid) => pid > 0));
  const until = Date.now() + 1000;
  for (const pid of pids) {
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { break; }
      await pause(20);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("a probe that answers and leaves a background worker: the worker does not outlive the read", async (t) => {
  const s = scene(t);
  const file = join(s.root, "worker-pids");
  exe(join(s.bin, "claude"), `#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 3
sleep 60 >/dev/null 2>&1 &
echo $! >> "${file}"
printf '{"loggedIn":true,"email":"ana@example.com","authMethod":"claude.ai","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
`);
  const result = await s.start(READER, ["here"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().claude.state, "eligible");
  const pids = readFileSync(file, "utf8").trim().split("\n").map(Number);
  const until = Date.now() + 1000;
  for (const pid of pids) {
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { break; }
      await pause(20);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("the read-only boundary with a writing claude: the vendor probe can write to its own config folder", (t) => {
  const s = scene(t);
  const slot = join(s.home, ".claude");
  mkdirSync(slot);
  const baseline = s.run(READER, ["here"]).json();
  const probe = fakeClaude("ana@example.com").replace("case $folder", 'echo example > "$folder/vendor-state"\ncase $folder');
  exe(join(s.bin, "claude"), probe);
  const before = snapshot(s.home, (p) => p === slot);
  assert.deepEqual(s.run(READER, ["here"]).json(), baseline);
  assert.deepEqual(snapshot(s.home, (p) => p === slot), before);
  assert.equal(readFileSync(join(slot, "vendor-state"), "utf8"), "example\n");
});

test("three entry points give the same answer: the sidebar, am and both dedicated programs", (t) => {
  const s = scene(t);
  const results = [[PACK, ["accounts", "here"]], [AM, ["accounts", "here"]], [READER, ["here"]], [AM_READER, ["here"]]]
    .map(([cli, args]) => s.run(cli, args));
  assert.ok(results.every((r) => r.code === 0 && r.stdout === results[0].stdout));
  assert.equal(results[0].stdout.trim().split("\n").length, 1);
});

test("accounts takes here or fleet: another word, extra words to fleet, a relative project or --machine exit 2", (t) => {
  const s = scene(t);
  for (const args of [["other"], ["fleet", "/project"], ["here", "relative"], ["here", "--machine", "vm-other"]]) {
    assert.equal(s.run(PACK, ["accounts", ...args]).code, 2, args.join(" "));
  }
  for (const args of [["here", "--within", "4"], ["here", "--within", "16"], ["here", "--within", "x"], ["fleet", "--within", "5"],
    ["here", "--started", "1"], ["here", "--within", "5", "--started", "x"], ["fleet", "--within", "5", "--started", "1"]]) {
    assert.equal(s.run(READER, args).code, 2, args.join(" "));
  }
  assert.deepEqual(s.log(), []);
});
