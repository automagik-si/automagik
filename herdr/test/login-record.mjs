// Shared by the pack and am CI jobs: the Bot login generation reader (#1509 design note rev 5).
// Pure rows use an in-memory record writer and stat-shaped folders; CLI rows use scratch homes.
// No real login, auth file, network call or hc call is read or made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BACKWARDS_LINE, POINTER_VAR, REQUIRED_VAR, resolveLogin } from "../mods/am-sidebar/loginRecord.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CLAUDE_DIR = "/bot/generations/one/.claude";
const CODEX_DIR = "/bot/generations/two/.codex";
const CURRENT = "/bot/cli-homes/current";
const MEMORY = "/bot/app/automagik-herdr/login-sequence.json";
const RECORD = {
  version: 1, sequence: 7,
  claude: { generation: U1, configDir: CLAUDE_DIR },
  codex: { generation: U2, home: CODEX_DIR },
  updatedAt: "2026-11-16T20:00:00.000Z",
};
const textOf = (record) => (typeof record === "string" ? record : JSON.stringify(record));
const enoent = () => { const error = new Error("ENOENT"); error.code = "ENOENT"; throw error; };
const directory = (mode) => ({ isSymbolicLink: () => false, isDirectory: () => true, mode: 0o40000 | mode });

/** An in-memory record world: reads are spied, folders are stat-shaped, memory writes captured. */
function world({ record = RECORD, pointerText = U1, claudeMode = 0o700, codexMode = 0o700, claudeKind = "dir",
  memory, activated = false, firstRecord } = {}) {
  const files = new Map([
    [`${CURRENT}/generation.json`, textOf(record)],
    [`${CURRENT}/claude`, pointerText],
    [`${CURRENT}/codex`, U2],
  ]);
  if (record === "") files.delete(`${CURRENT}/generation.json`);
  if (memory !== undefined) files.set(MEMORY, String(memory));
  if (activated) files.delete(`${CURRENT}/claude`);
  const stats = new Map([[CODEX_DIR, directory(codexMode)]]);
  if (claudeKind === "dir") stats.set(CLAUDE_DIR, directory(claudeMode));
  else if (claudeKind === "link") stats.set(CLAUDE_DIR, { isSymbolicLink: () => true, isDirectory: () => false, mode: 0o40700 });
  else if (claudeKind === "file") stats.set(CLAUDE_DIR, { isSymbolicLink: () => false, isDirectory: () => false, mode: 0o100600 });
  if (activated) stats.set(`${CURRENT}/claude.activated`, { isSymbolicLink: () => false, isDirectory: () => false, mode: 0o100600 });
  const reads = [];
  const writes = [];
  let recordReads = 0;
  return {
    reads, writes, files, stats,
    io: {
      read: (path) => {
        reads.push(path);
        if (path === `${CURRENT}/generation.json` && firstRecord !== undefined && (recordReads += 1) === 1) return firstRecord;
        if (!files.has(path)) enoent();
        return files.get(path);
      },
      lstat: (path) => {
        reads.push(`lstat:${path}`);
        if (!stats.has(path)) enoent();
        return stats.get(path);
      },
      writeAtomic: (path, value) => { writes.push([path, value]); },
    },
  };
}

const run = (w, vendor = "claude", extra = {}) => resolveLogin({
  vendor, env: { [POINTER_VAR]: `${CURRENT}/claude` }, memoryPath: MEMORY, io: w.io, ...extra,
});
const codeOf = (result) => result.code;

/** A scratch pointer world on disk: one record, both pointers, two private homes and a memory file. */
function disk(t, { claudeMode = 0o700, codexMode = 0o700 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "login-record-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, "current"), claudeDir = join(root, "claude-home"), codexDir = join(root, "codex-home");
  const app = join(root, "app"), memory = join(app, "automagik-herdr", "login-sequence.json");
  mkdirSync(current, { recursive: true }); mkdirSync(claudeDir); mkdirSync(codexDir); mkdirSync(app);
  chmodSync(claudeDir, claudeMode); chmodSync(codexDir, codexMode);
  writeFileSync(join(current, "generation.json"), JSON.stringify({ ...RECORD,
    claude: { generation: U1, configDir: claudeDir }, codex: { generation: U2, home: codexDir } }));
  writeFileSync(join(current, "claude"), U1);
  writeFileSync(join(current, "codex"), U2);
  const env = { ...process.env, [POINTER_VAR]: join(current, "claude"), HERDR_APP_HOME: app };
  const io = {
    read: (path) => readFileSync(path, "utf8"),
    lstat: (path) => lstatSync(path),
    writeAtomic: (path, text) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fresh = `${path}.${process.pid}.tmp`;
      writeFileSync(fresh, text, { mode: 0o600 });
      chmodSync(fresh, 0o600);
      renameSync(fresh, path);
    },
  };
  return { root, current, claudeDir, codexDir, app, memory, env, io };
}

export function loginRecordTests(cli) {
  test("no pointer is the ordinary no-op; the marker makes the same absence a refusal", () => {
    const w = world();
    assert.deepEqual(run(w, "claude", { env: {} }), { state: "absent" });
    assert.equal(codeOf(run(w, "claude", { env: { [REQUIRED_VAR]: "required" } })), "login-required");
    const other = resolveLogin({ vendor: "dsh-tui", env: { [POINTER_VAR]: `${CURRENT}/claude` }, memoryPath: MEMORY, io: w.io });
    assert.deepEqual(other, { state: "absent" });
  });

  test("the same export launches both vendors: current/claude derives current/codex", () => {
    const claude = world();
    assert.deepEqual(run(claude), { state: "ready", dir: CLAUDE_DIR, generation: U1, sequence: 7 });
    assert.ok(claude.reads.includes(`${CURRENT}/claude`));
    assert.equal(claude.reads.includes(`${CURRENT}/codex`), false, "the other vendor's pointer is not read");
    const codex = world();
    assert.deepEqual(run(codex, "codex"), { state: "ready", dir: CODEX_DIR, generation: U2, sequence: 7 });
    assert.ok(codex.reads.includes(`${CURRENT}/codex`));
    assert.equal(codex.reads.includes(`${CURRENT}/claude`), false);
  });

  test("the other vendor's null or bad field does not affect this launch", () => {
    const claudeNull = { ...RECORD, claude: null };
    assert.deepEqual(run(world({ record: claudeNull }), "codex"), { state: "ready", dir: CODEX_DIR, generation: U2, sequence: 7 });
    assert.equal(codeOf(run(world({ record: claudeNull }))), "vendor-null");
    const claudeBad = { ...RECORD, claude: { generation: "nope", configDir: "relative" } };
    assert.deepEqual(run(world({ record: claudeBad }), "codex"), { state: "ready", dir: CODEX_DIR, generation: U2, sequence: 7 });
  });

  test("missing, unreadable, invalid and version-2 records refuse with their own code", () => {
    assert.equal(codeOf(run(world({ record: "" }))), "record-absent");
    assert.equal(codeOf(run(world({ record: "{" }))), "record-invalid");
    assert.equal(codeOf(run(world({ record: { ...RECORD, version: 2 } }))), "record-version");
    assert.equal(codeOf(run(world({ record: { ...RECORD, claude: 3 } }))), "vendor-invalid");
  });

  test("the generation shape, path shape and pointer match are hard checks", () => {
    assert.equal(codeOf(run(world({ record: { ...RECORD, claude: { generation: "v1", configDir: CLAUDE_DIR } } }))), "generation-invalid");
    assert.equal(codeOf(run(world({ record: { ...RECORD, claude: { generation: U1, configDir: "relative" } } }))), "path-invalid");
    assert.equal(codeOf(run(world({ record: { ...RECORD, claude: { generation: U1, configDir: "/" } } }))), "path-invalid");
    assert.equal(codeOf(run(world({ record: { ...RECORD, sequence: "7" } }))), "sequence-invalid");
    assert.equal(codeOf(run(world({ pointerText: U2 }))), "generation-mismatch");
  });

  test("the folder must exist, be a real directory and be exactly 0700", () => {
    assert.equal(codeOf(run(world({ claudeKind: "missing" }))), "folder-missing");
    assert.equal(codeOf(run(world({ claudeKind: "file" }))), "folder-not-directory");
    assert.equal(codeOf(run(world({ claudeKind: "link" }))), "folder-link");
    assert.equal(codeOf(run(world({ claudeMode: 0o755 }))), "folder-mode");
    assert.equal(codeOf(run(world({ claudeMode: 0o750 }))), "folder-mode");
    assert.equal(codeOf(run(world({ claudeMode: 0o700 }))), undefined);
  });

  test("a missing pointer refuses; its .activated marker names the damage", () => {
    const missing = world();
    missing.files.delete(`${CURRENT}/claude`);
    assert.equal(codeOf(run(missing)), "pointer-missing");
    assert.equal(codeOf(run(world({ activated: true }))), "pointer-missing-activated");
  });

  test("a torn record read is re-read once; two bad reads refuse", () => {
    assert.deepEqual(run(world({ firstRecord: "{" })), { state: "ready", dir: CLAUDE_DIR, generation: U1, sequence: 7 });
    assert.equal(codeOf(run(world({ record: "{" }))), "record-invalid");
  });

  test("the sequence is advisory: no memory logs and stores; higher matching logs verbatim and stores", () => {
    const fresh = world();
    const lines = [];
    assert.equal(run(fresh, "claude", { log: (line) => lines.push(line) }).state, "ready");
    assert.deepEqual(fresh.writes, [[MEMORY, "7\n"]]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /record sequence 7 accepted/);

    const back = world({ memory: 9 });
    const backLines = [];
    assert.equal(run(back, "claude", { log: (line) => backLines.push(line) }).state, "ready");
    assert.deepEqual(backLines, [BACKWARDS_LINE]);
    assert.deepEqual(back.writes, [[MEMORY, "7\n"]]);

    const lower = world({ memory: 2 });
    assert.equal(run(lower).state, "ready");
    assert.deepEqual(lower.writes, [[MEMORY, "7\n"]]);

    const readOnly = world();
    assert.equal(run(readOnly, "claude", { readOnly: true }).state, "ready");
    assert.deepEqual(readOnly.writes, []);
  });

  test("the reader touches only the record, the requested pointer, the folder stat, the marker and its memory", () => {
    const w = world({ memory: 8 });
    run(w);
    const unexpected = w.reads.filter((path) => {
      const clean = path.replace(/^lstat:/, "");
      return clean !== `${CURRENT}/generation.json` && clean !== `${CURRENT}/claude` && clean !== CLAUDE_DIR && clean !== MEMORY;
    });
    assert.deepEqual(unexpected, []);
  });

  test("one CLI, one export: login --check hides paths, login-env prints only the assignment", (t) => {
    const d = disk(t);
    const runCli = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: d.root, env: { ...d.env, ...extra }, encoding: "utf8" });

    const claude = runCli(["login", "--check", "claude"]);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stdout, /generation 11111111-1111-4111-8111-111111111111/);
    assert.match(claude.stdout, /folder claude-home/);
    assert.equal(claude.stdout.includes(d.root), false, "login --check prints no path");
    assert.equal(existsSync(d.memory), false, "login --check is read-only and writes no sequence memory");
    const codex = runCli(["login-env", "codex"]);
    assert.equal(codex.status, 0, codex.stderr);
    assert.equal(codex.stdout.trim(), `CODEX_HOME=${d.codexDir}`);
    assert.equal((statSync(d.memory).mode & 0o777), 0o600, "the sequence memory is 0600");

    const required = runCli(["login", "--check", "claude"], { [POINTER_VAR]: "", [REQUIRED_VAR]: "required" });
    assert.equal(required.status, 2);
    assert.match(required.stderr, /missing or out of date/);
    assert.match(required.stderr, /login-required/);
    assert.equal(required.stdout, "");
    assert.equal(required.stderr.includes(d.root), false, "a refusal prints no path");

    const noop = runCli(["login-env", "claude"], { [POINTER_VAR]: "" });
    assert.equal(noop.status, 0);
    assert.equal(noop.stdout, "");
  });
}
