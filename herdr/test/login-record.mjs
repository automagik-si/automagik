// Shared by the pack and am CI jobs: the Bot login generation reader (#1509 design note rev 5).
// Pure rows use an in-memory record writer and stat-shaped folders; CLI rows use scratch homes.
// No real login, auth file, network call or hc call is read or made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { BACKWARDS_LINE, POINTER_VAR, REQUIRED_VAR, botLoginWords, directLoginVendor, loginLaunchHome, loginLaunchProblem, loginOverride, loginPolicyActive, loginReadIo, resolveLogin } from "../mods/am-sidebar/loginRecord.js";
import { chooseLogin, envWords } from "../mods/am-sidebar/logins.js";
import { paneCommand } from "../mods/am-sidebar/restart.js";
import { workerArgs } from "../mods/am-sidebar/workers.js";
import { installationDigest } from "../../apps/acp-dsh/src/host/installation.js";
import { loginPointerFixture, privateFixtureDir, privateFixtureFile, privateFixtureHome, selectedRootFixture } from "./login-fixture.mjs";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ACP = "/bot/acp";
const DSH = "/bot/dsh";
const CURRENT = `${ACP}/cli-homes/current`;
const SELECTED = `${ACP}/selected`;
const SELECTIONS = `${SELECTED}/${installationDigest(DSH)}`;
const INSTANCE = `${process.pid}-${U1}`;
const SELECTION = `${SELECTIONS}/${INSTANCE}.json`;
const INSTANCES = `${dirname(CURRENT)}/instances`;
const BOOT = "/proc/sys/kernel/random/boot_id", PROC = `/proc/${process.pid}/stat`;
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
const directory = (mode) => ({ isSymbolicLink: () => false, isDirectory: () => true, mode: 0o40000 | mode,
  uid: process.getuid?.() });
const privateFile = { isFile: () => true, size: 0, mode: 0o100600, uid: process.getuid?.(), dev: 1 };

function addHomeDirectories(stats, dir) {
  for (let at = dirname(dir); at !== dirname(CURRENT); at = dirname(at)) stats.set(at, directory(0o700));
}

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
  const birth = { platform: "linux", boot: U1, start: "1" };
  files.set(BOOT, U1);
  files.set(PROC, `${process.pid} (node) S ${Array(49).fill("1").join(" ")}`);
  for (const path of [ACP, SELECTED, SELECTIONS, CURRENT, dirname(CURRENT), INSTANCES, `${INSTANCES}/claude`, `${INSTANCES}/codex`]) {
    stats.set(path, directory(0o700));
  }
  const claims = new Map([
    [SELECTION, { version: 1, identity: DSH, root: dirname(CURRENT), pid: process.pid, instance: INSTANCE, birth, descriptor: 10,
      vendors: ["claude", "codex"] }],
    ...["claude", "codex"].map((vendor) => [`${INSTANCES}/${vendor}/${INSTANCE}`,
      { format: "app-birth-v1", pid: process.pid, nonce: INSTANCE, birth, marker: "root" }]),
  ]);
  for (const [path, value] of claims) {
    const bytes = JSON.stringify(value);
    files.set(path, bytes);
    stats.set(path, { ...privateFile, size: bytes.length, ino: stats.size });
  }
  for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
    addHomeDirectories(stats, dir);
  }
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
      platform: "linux",
      selectionOpen: (value) => value.descriptor === 10,
      realpath: (path) => path,
      readClaimBytes: (path) => { reads.push(path); return files.get(path); },
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
        if (path === SELECTIONS) return [`${INSTANCE}.json`];
        if (path === `${INSTANCES}/claude` || path === `${INSTANCES}/codex`) return [INSTANCE];
        enoent();
      },
      writeAtomic: (path, value) => { writes.push([path, value]); },
    },
  };
}

const run = (w, vendor = "claude", extra = {}) => resolveLogin({
  vendor, env: { [POINTER_VAR]: `${CURRENT}/claude`, DSH_HOME: DSH, AUTOMAGIK_HOME: "/bot" },
  memoryPath: MEMORY, io: w.io, ...extra,
});
const codeOf = (result) => result.code;

/** A scratch pointer world on disk: one record, both pointers, two private homes and a memory file. */
function disk(t, { claudeMode = 0o700, codexMode = 0o700 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "login-record-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliHomes = join(root, "acp", "cli-homes");
  const current = join(cliHomes, "current");
  const claudeDir = join(cliHomes, "homes", "claude", U1, ".claude"), codexDir = join(cliHomes, "homes", "codex", U2, ".codex");
  const app = join(root, "app"), memory = join(app, "automagik-herdr", "login-sequence");
  for (const dir of [current, claudeDir, codexDir, app]) mkdirSync(dir, { recursive: true });
  privateFixtureHome(claudeDir); privateFixtureHome(codexDir);
  chmodSync(claudeDir, claudeMode); chmodSync(codexDir, codexMode);
  writeFileSync(join(current, "generation.json"), JSON.stringify({ ...RECORD,
    claude: { generation: U1, configDir: claudeDir }, codex: { generation: U2, home: codexDir } }));
  writeFileSync(join(current, "claude"), U1);
  writeFileSync(join(current, "codex"), U2);
  const env = { ...process.env, ...loginPointerFixture(t, join(current, "claude")), HOME: root, HERDR_APP_HOME: app };
  delete env[REQUIRED_VAR];
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
    assert.deepEqual(w.reads, []);
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
      addHomeDirectories(w.stats, dir);
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

  test("the reader touches only panel evidence, generation and marker records, login-tree names and memory", () => {
    const w = world({ memory: 8 });
    run(w);
    const unexpected = w.reads.filter((path) => {
      const clean = path.replace(/^(?:lstat|readdir):/, "");
      return ![`${CURRENT}/generation.json`, `${CURRENT}/claude`, CLAUDE_DIR, MEMORY,
        join(dirname(CLAUDE_DIR), "paused"), join(dirname(CLAUDE_DIR), "changing"), join(dirname(CLAUDE_DIR), "login-trees"),
        SELECTED, SELECTIONS, SELECTION, dirname(CLAUDE_DIR), dirname(dirname(CLAUDE_DIR)),
        join(dirname(CURRENT), "homes"), ACP, CURRENT, dirname(CURRENT), INSTANCES,
        `${INSTANCES}/claude`, `${INSTANCES}/claude/${INSTANCE}`, BOOT, PROC].includes(clean);
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

  /** An ACP home with a live selection and a generated or legacy login fixture. */
  function acpWorld(t, acpFolder = "acp") {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "login-acp-")));
    chmodSync(base, 0o700);
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const acp = join(base, acpFolder), dsh = join(base, "dsh"), other = join(base, "dsh-other");
    const shared = join(acp, "cli-homes");
    const privateRoot = join(acp, "installations", installationDigest(dsh), "cli-homes");
    for (const dir of [shared, dsh, other]) mkdirSync(dir, { recursive: true });
    const select = (root = shared) => selectedRootFixture(t, acp, root, dsh);
    const signIn = (root, { legacy = false } = {}) => {
      const current = join(root, "current");
      privateFixtureDir(current);
      if (legacy) {
        const dir = join(root, "claude", ".claude");
        privateFixtureDir(dir);
        privateFixtureHome(dir);
        privateFixtureFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only" } }));
        privateFixtureFile(join(current, "generation.json"), JSON.stringify({ version: 1, sequence: 1, claude: null, codex: null }));
        return { pointer: join(current, "claude"), dir };
      }
      const dir = join(root, "homes", "claude", U1, ".claude");
      privateFixtureDir(dir);
      privateFixtureHome(dir);
      privateFixtureFile(join(current, "claude"), U1);
      privateFixtureFile(join(current, "generation.json"), JSON.stringify({ version: 1, sequence: 3, claude: { generation: U1, configDir: dir }, codex: null }));
      return { pointer: join(current, "claude"), dir };
    };
    const resolveFor = (pointer, env = {}, io = loginReadIo) => resolveLogin({ vendor: "claude", io,
      env: { [POINTER_VAR]: pointer, [REQUIRED_VAR]: "required", DSH_HOME: dsh, AUTOMAGIK_HOME: dirname(acp), ...env } });
    return { acp, dsh, other, shared, select, privateRoot, signIn, resolveFor };
  }

  test("#1509 an ACP home under installations can have a shared login root", (t) => {
    const w = acpWorld(t, "installations/acp");
    const login = w.signIn(w.shared);
    w.select();
    assert.deepEqual(w.resolveFor(login.pointer), { state: "ready", dir: login.dir, generation: U1, sequence: 3 });
  });

  for (const [name, replace] of Object.entries({
    missing: (path) => rmSync(path),
    unreadable: (path) => { rmSync(path); mkdirSync(path); },
    malformed: (path) => writeFileSync(path, "{"),
    version: (path, record) => writeFileSync(path, JSON.stringify({ ...record, version: 2 })),
    "foreign identity": (path, record, w) => writeFileSync(path, JSON.stringify({ ...record, identity: w.other })),
    "wrong birth": (path, record) => writeFileSync(path, JSON.stringify({ ...record, birth: { ...record.birth, start: record.birth.start + "0" } })),
    "unverifiable birth": (path, record) => writeFileSync(path, JSON.stringify({ ...record, birth: null })),
    "group-writable": (path) => chmodSync(path, 0o620),
    "other-writable": (path) => chmodSync(path, 0o602),
  })) {
    test(`#1509 a ${name} selected root refuses installation-unknown`, (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared);
      const { path, record } = w.select();
      replace(path, record, w);
      assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    });
  }

  test("#1509 a dead host with matching selection and registration refuses", (t) => {
    const w = acpWorld(t);
    const login = w.signIn(w.shared);
    const panel = w.select();
    const module = new URL("../../apps/acp-dsh/src/host/process-identity.js", import.meta.url).href;
    const script = `import { processBirth } from ${JSON.stringify(module)};
      console.log(JSON.stringify({ pid: process.pid, birth: processBirth(process.pid) }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const { pid, birth } = JSON.parse(child.stdout);
    assert.ok(birth);
    const instance = `${pid}-${U1}`;
    rmSync(panel.path);
    rmSync(panel.registration("claude"));
    writeFileSync(join(dirname(panel.path), `${instance}.json`),
      JSON.stringify({ ...panel.record, pid, birth, instance }), { mode: 0o600 });
    writeFileSync(join(dirname(panel.registration("claude")), instance), JSON.stringify({
      format: "app-birth-v1", marker: "root", pid, birth, nonce: instance,
    }), { mode: 0o600 });
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
  });

  test("#1509 a Linux selection requires readable /proc and the same boot",
    { skip: process.platform !== "linux" }, (t) => {
    const w = acpWorld(t);
    w.select();
    const login = w.signIn(w.shared);
    const io = { ...loginReadIo, read(path) {
      return path.startsWith("/proc/") ? enoent() : loginReadIo.read(path);
    } };
    assert.equal(codeOf(w.resolveFor(login.pointer, {}, io)), "installation-unknown");
    assert.equal(codeOf(w.resolveFor(login.pointer, {}, { ...loginReadIo, read(path) {
      return path === BOOT ? U1 : loginReadIo.read(path);
    } })), "installation-unknown");
  });

  test("#1509 Darwin verifies the ACP birth and refuses zombies and a reused PID", () => {
    const w = world();
    const birth = { platform: "darwin", start: "Sat Nov 21 14:03:00 2026" };
    for (const path of [SELECTION, `${INSTANCES}/claude/${INSTANCE}`]) {
      w.files.set(path, JSON.stringify({ ...JSON.parse(w.files.get(path)), birth }));
    }
    w.io.platform = "darwin";
    w.io.ps = (command, argv, options) => {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(argv, ["-p", String(process.pid), "-o", "state=", "-o", "lstart="]);
      assert.deepEqual(options.env, { LC_ALL: "C", TZ: "UTC" });
      return `S  ${birth.start}\n`;
    };
    assert.equal(run(w).state, "ready");
    w.io.ps = () => `Z  ${birth.start}\n`;
    assert.equal(codeOf(run(w)), "installation-unknown");
    w.io.ps = () => "S Sat Nov 21 14:02:00 2026\n";
    assert.equal(codeOf(run(w)), "installation-unknown");
    w.io.ps = () => `S  ${birth.start}\n`;
    w.io.selectionOpen = () => false;
    assert.equal(codeOf(run(w)), "installation-unknown", "the birth second alone cannot prove the same process");
  });

  for (const part of ["selected", "digest", "file"]) {
    test(`#1509 the ${part} selection entry requires owner and safe permissions`, (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared);
      const { path } = w.select();
      const target = part === "file" ? path : part === "digest" ? dirname(path) : dirname(dirname(path));
      const io = { ...loginReadIo, lstat(file) {
        const stat = loginReadIo.lstat(file);
        if (file === target) stat.uid += 1;
        return stat;
      } };
      assert.equal(codeOf(w.resolveFor(login.pointer, {}, io)), "installation-unknown");
      chmodSync(target, part === "file" ? 0o620 : 0o720);
      assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    });
  }

  for (const level of ["selected", "digest"]) {
    test(`#1509 a symlink at the ${level} directory refuses selection`, (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared);
      const { path } = w.select();
      const target = level === "digest" ? dirname(path) : dirname(dirname(path));
      renameSync(target, target + ".moved");
      symlinkSync(target + ".moved", target);
      assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    });
  }

  test("#1509 the selected record is opened without following links, checked by descriptor and bounded", (t) => {
    const w = acpWorld(t);
    const login = w.signIn(w.shared);
    const { path, record } = w.select();
    const own = JSON.stringify(record), saved = path + ".saved";
    renameSync(path, saved);
    symlinkSync(saved, path);
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    rmSync(path);
    writeFileSync(path, own.padEnd(4097), { mode: 0o600 });
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    writeFileSync(path, own, { mode: 0o600 });
    let opens = 0;
    const raced = { ...loginReadIo, openSelection(file) {
      opens++;
      rmSync(file);
      symlinkSync(saved, file);
      return loginReadIo.openSelection(file);
    } };
    assert.equal(codeOf(w.resolveFor(login.pointer, {}, raced)), "installation-unknown", "a link swapped in after lstat");
    assert.equal(opens, 1);
    rmSync(path);
    writeFileSync(path, own, { mode: 0o600 });
    const grown = { ...loginReadIo, openSelection(file) {
      writeFileSync(file, own.padEnd(4097));
      return loginReadIo.openSelection(file);
    } };
    assert.equal(codeOf(w.resolveFor(login.pointer, {}, grown)), "installation-unknown", "an oversized file swapped in after lstat");
    rmSync(path);
    renameSync(saved, path);
    opens = 0;
    const retried = { ...loginReadIo, openSelection(file) {
      if (++opens < 4) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      return loginReadIo.openSelection(file);
    } };
    assert.equal(w.resolveFor(login.pointer, {}, retried).state, "ready");
    assert.equal(opens, 5, "initial read and final selection recheck");
  });

  test("#1509 the live selection governs both roots even when the old claim says otherwise", (t) => {
    const w = acpWorld(t);
    const shared = w.signIn(w.shared);
    const own = w.signIn(w.privateRoot);
    writeFileSync(join(w.shared, "installation.json"), JSON.stringify({ version: 1, identity: w.dsh }));
    const isolated = w.select(w.privateRoot);
    assert.equal(codeOf(w.resolveFor(shared.pointer)), "installation-mismatch");
    assert.deepEqual(w.resolveFor(own.pointer), { state: "ready", dir: own.dir, generation: U1, sequence: 3 });
    writeFileSync(join(w.shared, "installation.json"), JSON.stringify({ version: 1, identity: w.other }));
    w.select();
    rmSync(isolated.path);
    assert.deepEqual(w.resolveFor(shared.pointer), { state: "ready", dir: shared.dir, generation: U1, sequence: 3 });
    assert.equal(codeOf(w.resolveFor(own.pointer)), "installation-mismatch");
  });

  test("#1509 AUTOMAGIK_HOME binds the pointer to this data root despite a matching foreign selection", (t) => {
    const w = acpWorld(t);
    const foreign = acpWorld(t);
    const stale = foreign.signIn(foreign.shared);
    selectedRootFixture(t, foreign.acp, foreign.shared, w.dsh);
    const env = { AUTOMAGIK_HOME: dirname(w.acp) };
    assert.equal(w.resolveFor(stale.pointer, { AUTOMAGIK_HOME: dirname(foreign.acp) }).state, "ready");
    assert.equal(codeOf(w.resolveFor(stale.pointer, env)), "installation-mismatch");
    w.select();
    assert.equal(w.resolveFor(w.signIn(w.shared).pointer, env).state, "ready");
    w.select(w.privateRoot);
    assert.equal(w.resolveFor(w.signIn(w.privateRoot).pointer, env).state, "ready");
    const wrongDigest = join(w.acp, "installations", "0".repeat(32), "cli-homes");
    selectedRootFixture(t, w.acp, wrongDigest, w.dsh);
    assert.equal(codeOf(w.resolveFor(w.signIn(wrongDigest).pointer)), "installation-mismatch");
  });

  test("#1509 two panel instances in one live PID have independent records", (t) => {
    const w = acpWorld(t);
    const login = w.signIn(w.shared);
    const first = w.select(), second = w.select();
    writeFileSync(second.path, JSON.stringify({ ...second.record, pid: { toString: null } }));
    assert.equal(w.resolveFor(login.pointer).state, "ready", "a malformed peer cannot deny the surviving panel");
    rmSync(second.path);
    assert.equal(w.resolveFor(login.pointer).state, "ready", "newer panel disposed before the older one");
    const unregistered = w.select();
    rmSync(unregistered.registration("claude"));
    rmSync(first.registration("claude"));
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown", "a live host cannot vouch for a disposed panel");
    writeFileSync(first.registration("claude"), "", { mode: 0o600 });
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown", "legacy ownership has no birth proof");
  });

  test("#1509 live panels in distinct processes survive orderly withdrawal of a peer",
    { skip: process.platform !== "linux" }, async (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared);
      const first = w.select();
      const fixture = new URL("./login-fixture.mjs", import.meta.url).href;
      const script = `import { selectedRootFixture } from ${JSON.stringify(fixture)};
        import { rmSync } from "node:fs";
        const panel = selectedRootFixture({ after() {} }, ...process.argv.slice(1));
        process.stdin.resume();
        process.stdin.on("end", () => {
          rmSync(panel.path); panel.close(); rmSync(panel.registration("claude"));
        });
        console.log("ready");`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, w.acp, w.shared, w.dsh],
        { stdio: ["pipe", "pipe", "inherit"] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => assert.fail("panel exited during setup"))]);
      assert.notEqual(child.pid, process.pid);
      rmSync(first.path);
      assert.equal(w.resolveFor(login.pointer).state, "ready", "the child alone can authorize its panel");
      w.select();
      const exited = once(child, "exit");
      child.stdin.end();
      assert.deepEqual(await exited, [0, null]);
      assert.equal(w.resolveFor(login.pointer).state, "ready", "the surviving panel can still authorize");
    });

  test("#1509 an unreadable withdrawal can revoke a selection and block stale shared evidence", (t) => {
    const w = acpWorld(t);
    const login = w.signIn(w.shared);
    const first = w.select(), peer = w.select();
    assert.equal(w.resolveFor(login.pointer).state, "ready");
    first.close();
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
    rmSync(first.registration("claude"));
    assert.equal(w.resolveFor(login.pointer).state, "ready");
    peer.close();
    assert.equal(codeOf(w.resolveFor(login.pointer)), "installation-unknown");
  });

  for (const removed of ["selection", "registration"]) {
    test(`#1509 ${removed} withdrawn while checking whether the login is paused refuses`, (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared);
      const panel = w.select();
      const io = { ...loginReadIo, lstat(path) {
        if (path === join(dirname(login.dir), "paused")) {
          rmSync(removed === "selection" ? panel.path : panel.registration("claude"));
        }
        return loginReadIo.lstat(path);
      } };
      assert.equal(codeOf(w.resolveFor(login.pointer, {}, io)), "installation-unknown");
    });
  }

  for (const [level, pick] of [
    ["ACP", (w) => w.acp],
    ["legacy vendor home", (_w, login) => dirname(login.dir)],
    ["generated home", (_w, login) => dirname(login.dir)],
    ["generated vendor", (_w, login) => dirname(dirname(login.dir))],
    ["generated homes", (_w, login) => dirname(dirname(dirname(login.dir)))],
  ]) {
    test(`#1509 a private target behind a symlink at the ${level} refuses`, (t) => {
      const w = acpWorld(t);
      const login = w.signIn(w.shared, { legacy: level.startsWith("legacy") });
      w.select();
      const path = pick(w, login);
      renameSync(path, path + ".real");
      symlinkSync(path + ".real", path);
      assert.equal(codeOf(w.resolveFor(login.pointer)), level === "ACP" ? "installation-unknown" : "login-unverified");
    });
  }

  test("#1509 the ACP directory and physical home require the current UID", (t) => {
    const w = acpWorld(t);
    const login = w.signIn(w.shared);
    w.select();
    for (const [target, expected] of [
      [w.acp, "installation-unknown"],
      [dirname(login.dir), "login-unverified"],
    ]) {
      const io = { ...loginReadIo, lstat(path) {
        const stat = loginReadIo.lstat(path);
        if (path === target) stat.uid += 1;
        return stat;
      } };
      assert.equal(codeOf(w.resolveFor(login.pointer, {}, io)), expected);
    }
  });

  for (const [change, mutate, expected] of [
    ["pointer", (w) => w.files.set(`${CURRENT}/claude`, U2), "generation-mismatch"],
    ["pause", (w) => w.stats.set(join(dirname(CLAUDE_DIR), "paused"), privateFile), "login-paused"],
  ]) {
    test(`#1509 a ${change} change during the final selection read refuses`, () => {
      const w = world();
      const read = w.io.readClaimBytes;
      let selectionReads = 0;
      w.io.readClaimBytes = (path) => {
        if (path === SELECTION && ++selectionReads === 2) mutate(w);
        return read(path);
      };
      assert.equal(codeOf(run(w)), expected);
      assert.deepEqual(w.writes, []);
    });
  }

  for (const legacy of [false, true]) for (const marker of ["paused", "changing"]) {
    test(`#1509 a ${legacy ? "legacy home" : "generation"} marked ${marker} refuses the login`, (t) => {
      const w = acpWorld(t);
      w.select();
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
    w.select();
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

  test("#1509 every active policy requires DSH_HOME and AUTOMAGIK_HOME", (t) => {
    const w = acpWorld(t);
    const shared = w.signIn(w.shared);
    w.select();
    for (const name of ["DSH_HOME", "AUTOMAGIK_HOME"]) for (const policy of ["required", ""]) {
      for (const value of ["", undefined]) {
        assert.equal(codeOf(w.resolveFor(shared.pointer, { [name]: value, [REQUIRED_VAR]: policy })), "installation-unknown");
      }
    }
    assert.equal(codeOf(w.resolveFor("/elsewhere/current/claude")), "installation-mismatch", "invalid cli-homes root");
  });

  test("#1509 a login from before any generation launches on the panel's own root, and only there", (t) => {
    const w = acpWorld(t);
    const panel = w.select();
    const legacy = w.signIn(w.shared, { legacy: true });
    assert.deepEqual(w.resolveFor(legacy.pointer), { state: "ready", dir: legacy.dir, generation: "legacy", sequence: 1 });
    rmSync(panel.path);
    const isolated = w.select(w.privateRoot);
    assert.equal(codeOf(w.resolveFor(legacy.pointer)), "installation-mismatch", "another installation's legacy login");
    rmSync(isolated.path);
    w.select();
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
