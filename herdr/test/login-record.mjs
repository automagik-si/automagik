// Shared by the pack and am CI jobs: the Bot login generation reader (#1509 design note rev 5).
// Pure rows use an in-memory record writer and stat-shaped folders; CLI rows use scratch homes.
// No real login, auth file, network call or hc call is read or made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createHash } from "node:crypto";
import { BACKWARDS_LINE, POINTER_VAR, REQUIRED_VAR, botLoginWords, directLoginVendor, installationIdentity, loginLaunchHome, loginLaunchProblem, loginOverride, loginPolicyActive, loginReadIo, panelRoot, resolveLogin } from "../mods/am-sidebar/loginRecord.js";
import { chooseLogin, envWords } from "../mods/am-sidebar/logins.js";
import { paneCommand } from "../mods/am-sidebar/restart.js";
import { workerArgs } from "../mods/am-sidebar/workers.js";
import { installationCliHome } from "../../apps/acp-dsh/src/host/installation.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CURRENT = "/bot/cli-homes/current";
const CLAUDE_DIR = `${dirname(CURRENT)}/homes/claude/${U1}/.claude`;
const CODEX_DIR = `${dirname(CURRENT)}/homes/codex/${U2}/.codex`;
const MEMORY = "/bot/app/automagik-herdr/login-sequence";
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
      readdir: (path) => {
        reads.push(`readdir:${path}`);
        enoent();
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
  const current = join(root, "current");
  const claudeDir = join(root, "homes", "claude", U1, ".claude"), codexDir = join(root, "homes", "codex", U2, ".codex");
  const app = join(root, "app"), memory = join(app, "automagik-herdr", "login-sequence");
  for (const dir of [current, claudeDir, codexDir, app]) mkdirSync(dir, { recursive: true });
  chmodSync(claudeDir, claudeMode); chmodSync(codexDir, codexMode);
  writeFileSync(join(current, "generation.json"), JSON.stringify({ ...RECORD,
    claude: { generation: U1, configDir: claudeDir }, codex: { generation: U2, home: codexDir } }));
  writeFileSync(join(current, "claude"), U1);
  writeFileSync(join(current, "codex"), U2);
  const env = { ...process.env, HOME: root, [POINTER_VAR]: join(current, "claude"), HERDR_APP_HOME: app };
  // A run started inside an installation must not carry that installation's own export here.
  delete env.DSH_HOME; delete env[REQUIRED_VAR];
  const io = {
    ...loginReadIo,
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

/** Capture the login-only CLI's output without subprocess pipes or a core fixture. */
function loginCli(d, args, env = {}) {
  const stdout = join(d.root, "stdout"), stderr = join(d.root, "stderr");
  const out = openSync(stdout, "w", 0o600), err = openSync(stderr, "w", 0o600);
  try {
    const result = spawnSync(process.execPath, args, { cwd: d.root, env: { ...d.env, ...env }, stdio: ["ignore", out, err] });
    if (result.error) throw result.error;
    return { status: result.status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

export function loginRecordTests(cli) {
  test("no pointer is the ordinary no-op; the marker makes the same absence a refusal", () => {
    const w = world();
    assert.deepEqual(run(w, "claude", { env: {} }), { state: "absent" });
    assert.equal(codeOf(run(w, "claude", { env: { [REQUIRED_VAR]: "required" } })), "login-required");
    const other = resolveLogin({ vendor: "dsh-tui", env: { [POINTER_VAR]: `${CURRENT}/claude` }, memoryPath: MEMORY, io: w.io });
    assert.deepEqual(other, { state: "absent" });
  });

  test("#1509 a present empty pointer activates policy and refuses", () => {
    const env = { [POINTER_VAR]: "" };
    assert.equal(loginPolicyActive(env), true);
    assert.equal(codeOf(run(world(), "claude", { env })), "pointer-invalid");
  });

  test("#1509 the export has the exact shape root/current/vendor", () => {
    for (const pointer of [`${CURRENT}/other`, `${CURRENT}/claude/`, `${CURRENT}/../current/claude`,
      "/bot/cli-homes/previous/claude", "/current/claude", "current/claude"]) {
      const w = world();
      assert.equal(codeOf(run(w, "claude", { env: { [POINTER_VAR]: pointer } })), "pointer-invalid", pointer);
      assert.deepEqual(w.reads, []);
    }
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

  test("unknown fields are ignored; only the documented checks refuse", () => {
    const unknown = world({ record: { ...RECORD, future: { anything: true }, claude: { ...RECORD.claude, extra: "x" } } });
    assert.deepEqual(run(unknown), { state: "ready", dir: CLAUDE_DIR, generation: U1, sequence: 7 });
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
    assert.equal(codeOf(run(world({ pointerText: U2 }))), "generation-mismatch");
  });

  for (const [vendor, field, dir] of [["claude", "configDir", CLAUDE_DIR], ["codex", "home", CODEX_DIR]]) {
    test(`#1509 ${vendor} refuses a different folder even with the matching generation`, () => {
      const wrong = `${dir}-other`;
      const w = world({ record: { ...RECORD, [vendor]: { ...RECORD[vendor], [field]: wrong } } });
      w.stats.set(wrong, directory(0o700));
      assert.equal(codeOf(run(w, vendor)), "path-mismatch");
      assert.deepEqual(w.writes, []);
    });
  }

  test("#1509 pointer contents are compared byte for byte", () => {
    for (const pointerText of [` ${U1}`, `${U1}\n`]) {
      assert.equal(codeOf(run(world({ pointerText }))), "generation-mismatch");
    }
  });

  test("#1509 the generation is a lowercase ACP UUID of any version", () => {
    for (const [generation, expected] of [["abcdef01-2222-7222-1222-222222222222", "ready"],
      ["ABCDEF01-2222-4222-8222-222222222222", "generation-invalid"]]) {
      const dir = `${dirname(CURRENT)}/homes/claude/${generation}/.claude`;
      const w = world({ pointerText: generation, record: { ...RECORD, claude: { generation, configDir: dir } } });
      w.stats.set(dir, directory(0o700));
      const result = run(w);
      assert.equal(result.state ?? result.code, expected);
    }
  });

  test("#1509 only a direct vendor executable is accepted for a Bot login", () => {
    assert.equal(directLoginVendor(["/opt/tools/claude-code"]), "claude");
    assert.equal(directLoginVendor(["/opt/tools/codex"]), "codex");
    for (const argv of [["env", "PATH=/usr/bin", "codex"], ["node", "/opt/tools/codex.js"],
      ["sh", "-c", "exec claude"], ["bash", "-lc", "command /opt/tools/claude"], ["my-unknown-wrapper"]]) {
      assert.equal(loginLaunchProblem(argv, "claude")?.code, "launch-not-direct");
    }
    assert.equal(loginLaunchProblem(["omp", "claude"], "omp", ["omp"]), null);
    assert.equal(loginLaunchProblem(["/opt/tools/omp", "claude"], "omp", ["omp"])?.code, "launch-not-direct");
    assert.equal(loginLaunchProblem(["codex"], "claude")?.code, "launch-not-direct");
    assert.ok(loginOverride("export CLAUDE_CODE_USE_FOUNDRY=1"));
  });

  test("#1509 direct env checks assignment names, including values with other assignments", () => {
    assert.equal(directLoginVendor(["/usr/bin/env", "NOTE=keep CODEX_HOME=/scratch", "codex"]), "codex");
    assert.equal(directLoginVendor(["/usr/bin/env", "CODEX_HOME=/scratch", "codex"]), null);
  });

  for (const command of ["env -uCLAUDE_CONFIG_DIR", "unset -v CLAUDE_CONFIG_DIR", "export -n CODEX_HOME", "env -iv"]) {
    test(`#1509 login override detects ${command}`, () => {
      assert.equal(loginOverride(command), true);
    });
  }

  test("#1509 reader env options precede assignments and are stripped from a recorded helper argv (under the policy)", (t) => {
    const had = Object.hasOwn(process.env, REQUIRED_VAR), was = process.env[REQUIRED_VAR];
    process.env[REQUIRED_VAR] = "required";
    t.after(() => { if (had) process.env[REQUIRED_VAR] = was; else delete process.env[REQUIRED_VAR]; });
    for (const [vendor, variables, assignments] of [
      ["claude", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"], [`CLAUDE_CONFIG_DIR=${CLAUDE_DIR}`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=${CLAUDE_DIR}`]],
      ["codex", ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"], [`CODEX_HOME=${CODEX_DIR}`]],
    ]) {
      const path = "PATH=/usr/bin";
      const words = envWords([path], botLoginWords(vendor, vendor === "claude" ? CLAUDE_DIR : CODEX_DIR));
      assert.deepEqual(words, [...variables.flatMap((name) => ["-u", name]), path, ...assignments]);
      assert.deepEqual(paneCommand({ argv: ["/usr/bin/env", ...words, vendor] }), { argv: [vendor] });
      if (vendor === "claude") {
        const at = words.indexOf("CLAUDE_CODE_USE_FOUNDRY");
        const previous = [...words.slice(0, at - 1), ...words.slice(at + 1)];
        assert.deepEqual(paneCommand({ argv: ["/usr/bin/env", ...previous, vendor] }), { argv: [vendor] });
      }
    }
  });

  test("#1509 paneCommand preserves custom env argv that resembles the reader prefix", () => {
    const words = envWords(["PATH=/usr/bin"], botLoginWords("codex", CODEX_DIR));
    for (const argv of [
      [...words.slice(0, -1), "codex"],
      [...words, "omp"],
      [...words.slice(0, 6), "-u", "CUSTOM", ...words.slice(6), "codex"],
      [...words, "CODEX_HOME=/other", "codex"],
    ]) {
      const launch = ["/usr/bin/env", ...argv];
      assert.deepEqual(paneCommand({ argv: launch }), { argv: launch });
    }
  });

  test("an unusable sequence never refuses: accepted, not stored, logged once", () => {
    for (const sequence of ["7", -1, null, 1.5]) {
      const w = world({ record: { ...RECORD, sequence }, memory: 3 });
      const lines = [];
      const result = run(w, "claude", { log: (line) => lines.push(line) });
      assert.equal(result.state, "ready", `sequence ${JSON.stringify(sequence)}`);
      assert.equal(result.sequence, null);
      assert.deepEqual(w.writes, [], "an unusable record value is never stored");
      assert.equal(w.files.get(MEMORY), "3", "the prior usable memory is left alone");
      assert.equal(lines.length, 1);
      assert.match(lines[0], /not a usable number/);
    }
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

  test("the reader touches only the record, the requested pointer, folder and marker stats, login-tree names and its memory", () => {
    const w = world({ memory: 8 });
    run(w);
    const unexpected = w.reads.filter((path) => {
      const clean = path.replace(/^(?:lstat|readdir):/, "");
      return ![`${CURRENT}/generation.json`, `${CURRENT}/claude`, CLAUDE_DIR, MEMORY,
        join(dirname(CLAUDE_DIR), "paused"), join(dirname(CLAUDE_DIR), "changing"), join(dirname(CLAUDE_DIR), "login-trees")].includes(clean);
    });
    assert.deepEqual(unexpected, []);
  });

  test("one function, two launch call sites: worker and launchSeat both use botLogin (M18)", () => {
    const source = readFileSync(cli, "utf8");
    for (const [site, early, late, boundary] of [
      ["cmdWorker", "templateArgv ?? plan.argv", "templateArgv ?? workerArgv", "const inWorktree ="],
      ["launchSeat", "argv", "argv", "const hook ="],
    ]) {
      const start = source.indexOf(`async function ${site}(`);
      assert.notEqual(start, -1, site);
      const end = source.indexOf("\n}", start);
      const body = source.slice(start, end);
      const first = body.indexOf(`botLogin(${early},`);
      const fresh = body.indexOf(`const freshLogin = botLogin(${late},`);
      const lockOrHook = body.indexOf(boundary);
      assert.ok(first >= 0 && first < lockOrHook && lockOrHook < fresh, site);
      assert.match(body.slice(fresh), /login: [^\n]*freshLogin\?\.words[\s\S]+await hcStartRun\(/);
      if (site === "launchSeat") {
        const placement = body.indexOf("await windowPlace(");
        assert.ok(placement > first && placement < fresh, "the first login read precedes any window creation");
      }
    }
  });

  test("#1509 policy-active helper recovery avoids the raw command and fixed login folder", () => {
    const source = readFileSync(cli, "utf8");
    const recovery = source.slice(source.indexOf("function byHand("), source.indexOf("function helperCommand("));
    assert.match(recovery, /if \(loginPolicyActive\(process.env\)\) \{\s*return \{ line: "Start the helper through am so it uses the current Bot login\."/);
    assert.doesNotMatch(recovery, /botLogin\(/);
  });

  test("#1509 watcher policy env is gated before building its argv", () => {
    const source = readFileSync(cli, "utf8");
    const queue = source.slice(source.indexOf("async function queueRestart("), source.indexOf("\n}", source.indexOf("async function queueRestart(")));
    assert.match(queue, /const policyEnv = loginPolicy \? loginPolicyEnv\(process.env\) : \{\};/);
    assert.match(queue, /Object.hasOwn\(policyEnv, k\)/);
    assert.doesNotMatch(queue, /k === "DSH_HOME"/);
  });

  test("#1509 due restarts route through tree planning and check helper logins before queue mutations", () => {
    const source = readFileSync(cli, "utf8");
    const since = (name) => source.slice(source.indexOf(`async function ${name}(`));
    const due = since("restartDuePass").split("\n}")[0];
    assert.match(due, /if \(loginPolicy\) \{\s*return cmdRestart\(\{ \.\.\.options, project: r.key, _queueDue: true/);
    const queue = since("queueRestart").split("\n}")[0];
    const helperCheck = queue.indexOf("checkHelperLogins(helpers)");
    assert.ok(helperCheck >= 0 && helperCheck < queue.indexOf("killQueuedWatcher") && helperCheck < queue.indexOf("writeFileSync"));
  });

  test("#1509 revive preserves a late helper login refusal instead of truncating its code", () => {
    const source = readFileSync(cli, "utf8");
    const revive = source.slice(source.indexOf("async function reviveOne(")).split("\n}")[0];
    assert.match(revive, /h.login \? h.error : firstSentence\(h.error\)/);
    assert.match(revive, /\.\.\.\(h.login \? \{ login: h.login \} : \{\}\)/);
  });

  test("#1509 the Codex home in launch history is the late login's home", () => {
    const previous = { HOME: "/person", CODEX_HOME: "/caller" };
    assert.deepEqual(loginLaunchHome(previous, { vendor: "codex", dir: CODEX_DIR }), { HOME: "/person", CODEX_HOME: CODEX_DIR });
    assert.equal(loginLaunchHome(previous, { vendor: "claude", dir: CLAUDE_DIR }), previous);
    assert.equal(loginLaunchHome(previous, null), previous);
  });

  test("#1509 a policy-off worker keeps the complete default Claude login prefix", () => {
    const picked = chooseLogin("/app", { read: enoent });
    const args = workerArgs({ botId: "b-aaaaaaaaaa", branch: "main", role: "dev", name: "worker", cwd: "/p",
      parent: "t1", agent: "claude", argv: ["claude"], task: "go", login: picked.words, path: "/usr/bin", project: "/p" });
    assert.deepEqual(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 4), ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR"]);
  });

  test("#1509 final helper login check precedes attaching the new parent and killing the old tree", () => {
    const source = readFileSync(cli, "utf8");
    const since = (name) => source.slice(source.indexOf(`async function ${name}(`)).split("\n}")[0];
    assert.match(since("restartResolved"), /const beforeMove = managedTree \? \(\) => checkHelperLogins\(plans\) : undefined;/);
    assert.match(since("restartResolved"), /attachMoved\(bot, held.binding, seat.terminal, created, key, beforeMove\)[\s\S]+managedTree \? await hcKill\(old.address\)/);
    assert.match(since("attachMoved"), /beforeWrite\?\.\(\);\s*write\(rows\);/);
    assert.match(since("commitAdoption"), /beforeWrite\?\.\(\);\s*appendAttach\(path, rows\);/);
  });

  test("#1509 the worker's Codex trust check follows the fresh login read", () => {
    const source = readFileSync(cli, "utf8");
    const worker = source.slice(source.indexOf("async function cmdWorker("));
    const fresh = worker.indexOf("const freshLogin = botLogin(");
    const trust = worker.indexOf("const codexHome = freshLogin?.dir ??");
    assert.ok(fresh >= 0 && fresh < trust && trust < worker.indexOf("await hcStartRun("));
  });

  test("one CLI, one export: login --check hides paths and refuses invalid pointers", (t) => {
    const d = disk(t);
    const runCli = (args, extra = {}) => loginCli(d, [cli, ...args], extra);

    const claude = runCli(["login", "--check", "claude"]);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stdout, /generation 11111111-1111-4111-8111-111111111111/);
    assert.match(claude.stdout, /folder \.claude/);
    assert.equal(claude.stdout.includes(d.root), false, "login --check prints no path");
    assert.equal(existsSync(d.memory), false, "login --check is read-only and writes no sequence memory");

    const required = runCli(["login", "--check", "claude"], { [POINTER_VAR]: "", [REQUIRED_VAR]: "required" });
    assert.equal(required.status, 2);
    assert.match(required.stderr, /missing or out of date/);
    assert.match(required.stderr, /pointer-invalid/);
    assert.equal(required.stdout, "");
    assert.equal(required.stderr.includes(d.root), false, "a refusal prints no path");

    const empty = runCli(["login-env", "claude"], { [POINTER_VAR]: "" });
    assert.equal(empty.status, 2, empty.stderr);
    assert.match(empty.stderr, /pointer-invalid/);
    assert.equal(empty.stdout, "");
  });

  test("#1509 login-env prints exactly the launch words, one per line", (t) => {
    const d = disk(t);
    for (const [vendor, dir] of [["claude", d.claudeDir], ["codex", d.codexDir]]) {
      const result = loginCli(d, [cli, "login-env", vendor]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${botLoginWords(vendor, dir).join("\n")}\n`);
      assert.equal(result.stderr, "");
    }
    assert.equal((statSync(d.memory).mode & 0o777), 0o600, "the sequence memory is 0600");
  });

  test("#1509 a failed sequence-memory rename removes the temporary file and still resolves the login", (t) => {
    const d = disk(t);
    mkdirSync(d.memory, { recursive: true });
    const result = loginCli(d, [cli, "login-env", "codex"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(dirname(d.memory)), ["login-sequence"]);
  });

  test("#1509 login --check skips CLI link repair", (t) => {
    const d = disk(t);
    const marker = join(d.root, "repair-ran");
    const script = `import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
      import { writeFileSync } from "node:fs";
      process.exitCode = await main(["login", "--check", "claude"], {
        repairCliLinks: () => writeFileSync(${JSON.stringify(marker)}, "")
      });`;
    const checked = loginCli(d, ["--input-type=module", "-e", script]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(d.memory), false);
  });

  // #1509 R3: the reader retakes the panel's root decision at launch (acp-dsh installationCliHome,
  // #1769) and refuses any difference, so an export decided earlier can never fail open onto
  // another installation's login; and a login from before any generation launches when the
  // pointer is exactly the panel's own root.
  const fsIo = loginReadIo;

  /** An ACP home on disk: two DSH homes, an optional claim, and one generation in a root. */
  function acpWorld(t, acpFolder = "acp") {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "login-acp-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const acp = join(base, acpFolder), dsh = join(base, "dsh"), other = join(base, "dsh-other");
    const shared = join(acp, "cli-homes");
    for (const dir of [shared, dsh, other]) mkdirSync(dir, { recursive: true });
    const claim = (dshHome) => writeFileSync(join(shared, "installation.json"), JSON.stringify({ version: 1, identity: installationIdentity(dshHome) }));
    const privateRoot = (dshHome) => join(acp, "installations", createHash("sha256").update(installationIdentity(dshHome)).digest("hex").slice(0, 32), "cli-homes");
    /** One generation (or, with legacy, a pre-generation login) recorded in `root`. */
    const signIn = (root, { legacy = false } = {}) => {
      const current = join(root, "current");
      mkdirSync(current, { recursive: true });
      if (legacy) {
        const dir = join(root, "claude", ".claude");
        mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700);
        writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only" } }));
        writeFileSync(join(current, "generation.json"), JSON.stringify({ version: 1, sequence: 1, claude: null, codex: null }));
        return { pointer: join(current, "claude"), dir };
      }
      const dir = join(root, "homes", "claude", U1, ".claude");
      mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700);
      writeFileSync(join(current, "claude"), U1);
      writeFileSync(join(current, "generation.json"), JSON.stringify({ version: 1, sequence: 3, claude: { generation: U1, configDir: dir }, codex: null }));
      return { pointer: join(current, "claude"), dir };
    };
    const resolveFor = (pointer, env = {}) => resolveLogin({ vendor: "claude", io: fsIo,
      env: { [POINTER_VAR]: pointer, [REQUIRED_VAR]: "required", DSH_HOME: dsh, ...env } });
    return { acp, dsh, other, shared, claim, privateRoot, signIn, resolveFor };
  }

  test("#1509 an ACP home under installations can have a shared login root", (t) => {
    const w = acpWorld(t, "installations/acp");
    w.claim(w.dsh);
    const login = w.signIn(w.shared);
    assert.deepEqual(w.resolveFor(login.pointer), { state: "ready", dir: login.dir, generation: U1, sequence: 3 });
  });

  const CLAIMS = {
    "no claim": () => {},
    "own claim": (w) => w.claim(w.dsh),
    "foreign claim": (w) => w.claim(w.other),
    "corrupt claim": (w) => writeFileSync(join(w.shared, "installation.json"), "{"),
    "claim as a folder": (w) => mkdirSync(join(w.shared, "installation.json")),
  };
  for (const [name, plant] of Object.entries(CLAIMS)) {
    test(`#1509 the reader's root is the panel's root once the panel has run: ${name}`, (t) => {
      const w = acpWorld(t);
      plant(w);
      const before = panelRoot(w.acp, w.dsh, fsIo);
      const { root } = installationCliHome(w.acp, w.dsh);
      // An absent claim is the panel's to take at its start; by a worker's launch it is not.
      if (name === "no claim") assert.equal(before, null);
      else assert.equal(before, root);
      assert.equal(panelRoot(w.acp, w.dsh, fsIo), root, "after the panel ran, the same root");
    });
  }

  test("#1509 the claim is opened without following links, checked by descriptor and bounded", (t) => {
    const w = acpWorld(t);
    const path = join(w.shared, "installation.json"), saved = join(w.shared, "saved-claim");
    const own = JSON.stringify({ version: 1, identity: w.dsh });
    writeFileSync(saved, own);
    symlinkSync(saved, path);
    assert.equal(panelRoot(w.acp, w.dsh, loginReadIo), w.privateRoot(w.dsh));
    rmSync(path);
    writeFileSync(path, own.padEnd(4097));
    assert.equal(panelRoot(w.acp, w.dsh, loginReadIo), w.privateRoot(w.dsh));
    writeFileSync(path, own);
    let opens = 0;
    const raced = { ...loginReadIo, openClaim(file) {
      opens++;
      rmSync(file);
      symlinkSync(saved, file);
      return loginReadIo.openClaim(file);
    } };
    assert.equal(panelRoot(w.acp, w.dsh, raced), w.privateRoot(w.dsh), "a link swapped in after lstat");
    assert.equal(opens, 1);
    rmSync(path);
    writeFileSync(path, own);
    const grown = { ...loginReadIo, openClaim(file) {
      writeFileSync(file, own.padEnd(4097));
      return loginReadIo.openClaim(file);
    } };
    assert.equal(panelRoot(w.acp, w.dsh, grown), w.privateRoot(w.dsh), "an oversized file swapped in after lstat");
    writeFileSync(path, own);
    opens = 0;
    const retried = { ...loginReadIo, openClaim(file) {
      if (++opens < 4) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      return loginReadIo.openClaim(file);
    } };
    assert.equal(panelRoot(w.acp, w.dsh, retried), w.shared);
    assert.equal(opens, 4);
  });

  test("#1509 the export's root launches; another installation's root refuses installation-mismatch", (t) => {
    const w = acpWorld(t);
    w.claim(w.other);
    const theirs = w.signIn(w.shared);
    const mine = w.signIn(w.privateRoot(w.dsh));
    assert.equal(codeOf(w.resolveFor(theirs.pointer)), "installation-mismatch", "never the other installation's login");
    assert.deepEqual(w.resolveFor(mine.pointer), { state: "ready", dir: mine.dir, generation: U1, sequence: 3 });
    w.claim(w.dsh);
    assert.deepEqual(w.resolveFor(theirs.pointer), { state: "ready", dir: theirs.dir, generation: U1, sequence: 3 });
    assert.equal(codeOf(w.resolveFor(mine.pointer)), "installation-mismatch", "the private root once the shared one is ours");
  });

  test("#1509 AUTOMAGIK_HOME binds the pointer to this data root despite a matching foreign claim", (t) => {
    const w = acpWorld(t);
    const foreign = acpWorld(t);
    const stale = foreign.signIn(foreign.shared);
    foreign.claim(w.dsh);
    assert.equal(w.resolveFor(stale.pointer).state, "ready", "the foreign tree has this DSH home's claim");
    const env = { AUTOMAGIK_HOME: dirname(w.acp) };
    assert.equal(codeOf(w.resolveFor(stale.pointer, env)), "installation-mismatch");
    assert.equal(codeOf(w.resolveFor(stale.pointer, { ...env, DSH_HOME: "", [REQUIRED_VAR]: "" })), "installation-mismatch");
    w.claim(w.dsh);
    assert.equal(w.resolveFor(w.signIn(w.shared).pointer, env).state, "ready");
    w.claim(w.other);
    assert.equal(w.resolveFor(w.signIn(w.privateRoot(w.dsh)).pointer, env).state, "ready");
  });

  for (const legacy of [false, true]) for (const marker of ["paused", "changing"]) {
    test(`#1509 a ${legacy ? "legacy home" : "generation"} marked ${marker} refuses the login`, (t) => {
      const w = acpWorld(t);
      w.claim(w.dsh);
      const login = w.signIn(w.shared, { legacy });
      const path = join(dirname(login.dir), marker);
      if (marker === "changing") mkdirSync(path);
      else writeFileSync(path, "");
      assert.equal(codeOf(w.resolveFor(login.pointer)), `login-${marker}`);
      rmSync(path, { recursive: true });
      assert.equal(w.resolveFor(login.pointer).state, "ready");
    });
  }

  for (const legacy of [false, true]) test(`#1509 login-tree entries block a ${legacy ? "legacy home" : "generation"}`, (t) => {
    const w = acpWorld(t);
    w.claim(w.dsh);
    const login = w.signIn(w.shared, { legacy });
    const trees = join(dirname(login.dir), "login-trees");
    mkdirSync(trees);
    assert.equal(w.resolveFor(login.pointer).state, "ready", "an empty directory is allowed");
    const entry = join(trees, ".interrupted");
    writeFileSync(entry, "unchecked");
    assert.equal(codeOf(w.resolveFor(login.pointer)), "login-unverified");
    assert.equal(readFileSync(entry, "utf8"), "unchecked");
    rmSync(trees, { recursive: true });
    writeFileSync(trees, "");
    assert.equal(codeOf(w.resolveFor(login.pointer)), "login-unverified", "an unreadable directory is refused");
  });

  test("#1509 an unclaimed or untrusted shared root refuses; the marker without DSH_HOME refuses", (t) => {
    const w = acpWorld(t);
    const shared = w.signIn(w.shared);
    assert.equal(codeOf(w.resolveFor(shared.pointer)), "installation-mismatch", "no claim at launch");
    writeFileSync(join(w.shared, "installation.json"), "{");
    assert.equal(codeOf(w.resolveFor(shared.pointer)), "installation-mismatch", "a corrupt claim");
    w.claim(w.dsh);
    assert.equal(codeOf(w.resolveFor(shared.pointer, { DSH_HOME: "" })), "installation-unknown");
    assert.equal(codeOf(w.resolveFor("/elsewhere/current/claude")), "installation-mismatch", "not a cli-homes root");
    // Without the marker and without DSH_HOME the pointer is the one ACP put in its own Bot's env.
    assert.equal(w.resolveFor(shared.pointer, { DSH_HOME: "", [REQUIRED_VAR]: "" }).state, "ready");
  });

  test("#1509 a login from before any generation launches on the panel's own root, and only there", (t) => {
    const w = acpWorld(t);
    w.claim(w.dsh);
    const legacy = w.signIn(w.shared, { legacy: true });
    assert.deepEqual(w.resolveFor(legacy.pointer), { state: "ready", dir: legacy.dir, generation: "legacy", sequence: 1 });
    w.claim(w.other);
    assert.equal(codeOf(w.resolveFor(legacy.pointer)), "installation-mismatch", "another installation's legacy login");
    w.claim(w.dsh);
    // Anything acp-dsh's generationAt would not call legacy stays a refusal.
    for (const [why, plant, undo] of [
      ["a pointer file", () => writeFileSync(legacy.pointer, "damaged"), () => rmSync(legacy.pointer)],
      ["an .activated marker", () => writeFileSync(`${legacy.pointer}.activated`, ""), () => rmSync(`${legacy.pointer}.activated`)],
      ["generation homes", () => mkdirSync(join(w.shared, "homes", "claude"), { recursive: true }), () => rmSync(join(w.shared, "homes"), { recursive: true })],
      ["a retired home", () => mkdirSync(join(w.shared, "retired", "claude"), { recursive: true }), () => rmSync(join(w.shared, "retired"), { recursive: true })],
    ]) {
      plant();
      assert.equal(codeOf(w.resolveFor(legacy.pointer)), "vendor-null", why);
      undo();
    }
    chmodSync(legacy.dir, 0o755);
    assert.equal(codeOf(w.resolveFor(legacy.pointer)), "folder-mode", "the same folder checks");
    rmSync(join(w.shared, "claude"), { recursive: true });
    assert.equal(codeOf(w.resolveFor(legacy.pointer)), "folder-missing", "never signed in: no empty login");
  });

  test("#1509 a direct launch may carry env assignments, never a login variable or an env option", async () => {
    const { directLoginVendor } = await import("../mods/am-sidebar/loginWords.js");
    for (const [argv, vendor] of [
      [["/usr/bin/env", "HOME=/scratch/home", "codex"], "codex"],
      [["env", "PATH=/bin", "TERM=xterm", "claude", "--resume", "x"], "claude"],
      [["/usr/bin/env", "CODEX_HOME=/other", "codex"], null],
      [["env", "CLAUDE_SECURESTORAGE_CONFIG_DIR=/other", "claude"], null],
      [["env", "-i", "codex"], null],
      [["env", "-u", "CLAUDE_CONFIG_DIR", "claude"], null],
      [["sh", "-c", "exec codex"], null],
      [["claude"], "claude"],
    ]) assert.equal(directLoginVendor(argv), vendor, JSON.stringify(argv));
  });

  test("#1509 R4: a forwarded policy keeps an absent pointer as an empty one; policy off forwards nothing", async () => {
    const { loginPolicyForward, loginPolicyWords } = await import("../mods/am-sidebar/loginWords.js");
    assert.deepEqual(loginPolicyForward({ [REQUIRED_VAR]: "required" }), { [REQUIRED_VAR]: "required", [POINTER_VAR]: "" });
    assert.deepEqual(loginPolicyWords({ [REQUIRED_VAR]: "required" }), [`${REQUIRED_VAR}=required`, `${POINTER_VAR}=`]);
    assert.deepEqual(loginPolicyForward({ [POINTER_VAR]: "", DSH_HOME: "/d" }), { [POINTER_VAR]: "", DSH_HOME: "/d" });
    assert.deepEqual(loginPolicyForward({ DSH_HOME: "/d", AUTOMAGIK_HOME: "/data" }), {});
    assert.deepEqual(loginPolicyWords({}), []);
  });

  test("#1509 R4: a rebuilt helper keeps an explicitly empty pointer and drops other empty values", async () => {
    const { helperArgs } = await import("../mods/am-sidebar/restart.js");
    const args = helperArgs({ name: "h", cwd: "/p", parent: "t1", argv: ["dsh-tui"], env: { [POINTER_VAR]: "", OTHER: "", DSH_HOME: "/d" } });
    assert.ok(args.includes(`${POINTER_VAR}=`), JSON.stringify(args));
    assert.ok(args.includes("DSH_HOME=/d"));
    assert.equal(args.some((word) => word.startsWith("OTHER=")), false);
  });

  test("#1509 R4: with the policy off an existing env-prefixed pane's command is read exactly as before", async () => {
    const { paneCommand } = await import("../mods/am-sidebar/restart.js");
    const { botLoginWords } = await import("../mods/am-sidebar/loginWords.js");
    const argv = ["/usr/bin/env", ...botLoginWords("codex", "/x/codex-login/.codex").filter((w) => !w.includes("=")), "FOO=1", "CODEX_HOME=/x/codex-login/.codex", "codex"];
    const saved = { ...process.env };
    try {
      delete process.env[POINTER_VAR]; delete process.env[REQUIRED_VAR];
      assert.deepEqual(paneCommand({ argv }), { argv }, "policy off: verbatim");
      process.env[REQUIRED_VAR] = "required";
      assert.deepEqual(paneCommand({ argv }), { argv: ["codex"] }, "policy on: the reader's prefix is the launch's own");
    } finally {
      for (const k of [POINTER_VAR, REQUIRED_VAR]) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
    }
  });
}
