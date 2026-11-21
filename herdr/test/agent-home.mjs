// A worker on a chosen agent home (#1208): `am worker --agent-home DIR` and a bot's
// `worker.agentHome`. Shared by the pack and am (agent-home.test.mjs in each): the pure rules
// (agentHome.js, the roster, the ledger rows) and the worker launch itself, run as a program
// against a scratch git project with the fake hc first on PATH (fake-hc.mjs). The real hc,
// herdr-core and herdr-app are never run; a fake claude and codex print the environment they
// get, only when the test runs a recorded launch itself. Apache-2.0.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { AGENT_HOME_UNSETS, CLAUDE_STORAGE_VAR, LAUNCH_VAR, agentHomeFor, agentHomeRunProblem, agentHomeSettingsProblem,
  chosenHomeOfArgv, chosenHomeWords } from "../mods/am-sidebar/agentHome.js";
import { attachPath } from "../mods/am-sidebar/attach.js";
import { applyBotEdit, checkBots, parseBots, workerHomeLaunchProblem, workerHomeOf } from "../mods/am-sidebar/model.js";
import { AGENTS, configPaths, knownModels } from "../mods/am-sidebar/models.js";
import { GUARD_DIR, KILL_GUARD_DIR, chosenLoginGeneration, readLedger, startRow, unresolvedWorker, workerArgs, workerIntent } from "../mods/am-sidebar/workers.js";
import { approveProject } from "../mods/am-sidebar/approved.js";
import { FLEET_FILE } from "../mods/am-sidebar/accountsRows.js";
import { auth, fpr } from "./accounts-fixture.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { loginFixture } from "./login-fixture.mjs";
import { scratchProject, scratchRoot, shortSocketDir } from "./scratch-project.mjs";

const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const AM_GUARD_DIR = new URL("../../am/guard", import.meta.url).pathname;
const BOT = "b-aaaaaaaaaa";
const LAUNCH = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_LAUNCH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GEN = { claude: "11111111-1111-4111-8111-111111111111", codex: "22222222-2222-4222-8222-222222222222" };
const look = { character: "star", colour: "blue" };
const genie = (extra = {}) => ({ id: BOT, name: "Genie", kind: "main", look, role: "r", instructions: "i", agent: "claude", ...extra });
const roster = (extra = {}) => ({ version: 1, categories: [], bots: [genie(extra)] });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const statIo = (uid = process.getuid()) => ({ realpath: realpathSync, stat: statSync, uid, defaultClaude: "/nonexistent/.claude" });
/** A private 0700 folder under `root`, its real path. */
const privateDir = (root, name, mode = 0o700) => { const d = join(root, name); mkdirSync(d, { recursive: true }); chmodSync(d, mode); return realpathSync(d); };
/** What a chosen launch's argv starts with, as workerArgs builds it. */
const chosenArgv = (agent, home, launch = LAUNCH, path = "/usr/bin:/bin") => workerArgs({ botId: BOT, branch: "b", name: "w", cwd: "/w", parent: "t1",
  agent, argv: [agent], task: "t", path, login: chosenHomeWords(agent, home, launch), outliveParent: true, killGuard: null });
const afterDashes = (args) => args.slice(args.indexOf("--") + 1);
const branchesOf = (s) => s.branches();

// The post-run patch the scene's hc applies to the terminal a run just made (an hc whose core is
// inconsistent, or that reports another launch): { key: value } set, null deletes, `launch` swaps the id.
const PATCHER = `import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [statePath, patchPath] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const patch = JSON.parse(readFileSync(patchPath, "utf8"));
const t = state.terminals.at(-1);
const { replyAddress, ...fields } = patch;
for (const [k, v] of Object.entries(fields)) {
  if (k === "launch") t.argv = t.argv.map((w) => (w.startsWith("${LAUNCH_VAR}=") ? "${LAUNCH_VAR}=" + v : w));
  else if (v === null) delete t[k]; else t[k] = v;
}
if (replyAddress) state.getReply = { ...state.getReply, [t.address]: { ...t, address: replyAddress } };
writeFileSync(statePath + ".patch.tmp", JSON.stringify(state));
renameSync(statePath + ".patch.tmp", statePath);
`;

/**
 * A scratch world for one CLI (`cli`: the pack's or am's): a git project whose main bot Genie
 * (Claude, `bot` merged in) plays t1, the fake hc and herdr-core status, fake agents, a home with
 * its default ~/.claude, and the app home. Nothing outside the scratch root is read or written.
 */
function homeScene(t, cli, { bot = {}, callerArgv = ["/usr/bin/env", "claude"] } = {}) {
  const root = scratchRoot(t, "hb-agent-home-");
  const project = scratchProject(root, "proj", { branch: "main", commit: true, bots: roster(bot) });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const patchPath = join(root, "run-patch.json"), patcher = join(root, "patch-run.mjs");
  writeFileSync(patcher, PATCHER);
  exe(join(bin, "hc"), `#!/bin/sh\n"${process.execPath}" "${FAKE_HC}" "$@"\ncode=$?\n`
    + `if [ "$1" = run ] && [ -f "${patchPath}" ]; then "${process.execPath}" "${patcher}" "${statePath}" "${patchPath}"; fi\nexit $code\n`);
  for (const a of ["claude", "codex"]) exe(join(bin, a), "#!/bin/sh\n[ -n \"$AGENT_ENV_DUMP\" ] && exec env\nexit 0\n");
  for (const a of ["gh", "glab"]) exe(join(bin, a), `#!/bin/sh\necho "fake ${a}: no answer" >&2\nexit 1\n`);
  // git, with an optional hook that runs when the briefing hook step asks git about its file.
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitHook = join(root, "git-hook.sh");
  exe(join(bin, "git"), `#!/bin/sh\nif [ -f "${gitHook}" ]; then case "$*" in *check-ignore*settings.local.json*) sh "${gitHook}" ;; esac; fi\nexec "${realGit}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const caller = { address: "t1", name: "t1", cwd: project, state: "live", parent: null, created_ms: 1, labels: { bot: BOT },
    foreground: { argv: ["claude"], cwd: project, pid: 4000 }, status: { app: "claude-code", state: "idle" },
    ...(callerArgv ? { argv: callerArgv } : {}) };
  writeFileSync(statePath, JSON.stringify({ terminals: [caller], next: 100 }));
  writeFileSync(logPath, "");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify({ down: true }));
  writeFileSync(appLog, "");
  const env = { ...process.env, XDG_DATA_HOME: join(root, "data"), PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app,
    HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog,
    AUTOMAGIK_HERDR_TAB_WAIT_MS: "0", AUTOMAGIK_HERDR_NO_UPDATE: "1", GIT_CEILING_DIRECTORIES: root };
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, core.env, { HC_SESSION: "" });
  env.HC_SOCKET = core.env.AUTOMAGIK_HERDR_CORE_SOCKET;
  env.HC_TERMINAL_SOCKET = env.HC_SOCKET;
  for (const k of ["HC_TERMINAL_ID", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "AUTOMAGIK_BOT_CLI_POINTER", LAUNCH_VAR]) delete env[k];
  // The fake core answers with the scene's own PATH: a guard a test puts first is the CLI's alone.
  const run = (args, { from = "t1", env: extra = {} } = {}) => {
    core.control({ ...env, ...extra, PATH: env.PATH });
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: project, env: { ...env, ...extra, ...(from ? { HC_TERMINAL_ID: from } : {}) }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const runAsync = (args, { from = "t1", env: extra = {} } = {}) => new Promise((done) => {
    core.control({ ...env, ...extra });
    execFile(process.execPath, [cli, ...args], { cwd: project, env: { ...env, ...extra, HC_TERMINAL_ID: from }, encoding: "utf8" },
      (e, out, err) => done({ code: e ? e.code : 0, out, err }));
  });
  const calls = () => readJsonLines(logPath);
  const runs = () => calls().filter((c) => c[0] === "run");
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (fn) => { const st = hcState(); fn(st); writeFileSync(statePath, JSON.stringify(st)); };
  const ledger = () => { const p = join(app, "automagik-herdr/workers.jsonl"); return existsSync(p) ? readLedger(readFileSync(p, "utf8")) : []; };
  const bots = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8"));
  const branches = () => execFileSync("git", ["branch", "--list", "e2e/*"], { cwd: project, encoding: "utf8" }).trim();
  const commit = (files) => {
    for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "settings"], { cwd: project });
  };
  /** The environment a recorded launch's agent really gets, run here with credentials planted around it. */
  const effectiveEnv = (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: project, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, AGENT_ENV_DUMP: "1",
      ...Object.fromEntries([...AGENT_HOME_UNSETS.claude, ...AGENT_HOME_UNSETS.codex].map((k) => [k, "planted-secret"])),
      CLAUDE_CONFIG_DIR: "/planted/claude", [CLAUDE_STORAGE_VAR]: "/planted/storage", CODEX_HOME: "/planted/codex" } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  };
  const patchNextRun = (patch) => writeFileSync(patchPath, JSON.stringify(patch));
  return { root, project, app, home, bin, env, run, runAsync, calls, runs, hcState, setState, ledger, bots, branches, commit, effectiveEnv,
    patchNextRun, gitHook };
}

export function agentHomeTests(cli) {
  // ---- the pure rules ----

  test("#1208 agentHomeFor: an existing folder you own with mode exactly 0700, by its real path; Claude's default refused", (t) => {
    const root = scratchRoot(t, "hb-agent-home-");
    const dir = privateDir(root, "login"), alias = join(root, "alias"), file = join(root, "file");
    symlinkSync(dir, alias);
    writeFileSync(file, "");
    for (const agent of ["claude", "codex"]) assert.deepEqual(agentHomeFor(agent, alias, statIo()), { home: dir }, "a symlink is used by its real path");
    assert.match(agentHomeFor("dsh-tui", dir, statIo()).error, /only Claude and Codex/);
    assert.match(agentHomeFor("claude", "relative/login", statIo()).error, /must be an absolute path/);
    assert.match(agentHomeFor("claude", "/", statIo()).error, /not \//);
    assert.match(agentHomeFor("claude", file, statIo()).error, /is not a folder/);
    assert.match(agentHomeFor("claude", join(root, "missing"), statIo()).error, /is not a folder/);
    assert.match(agentHomeFor("codex", dir, statIo(process.getuid() + 1)).error, /owned by the current user/);
    for (const [mode, shown] of [[0o755, "0755"], [0o750, "0750"], [0o1700, "1700"], [0o2700, "2700"], [0o4700, "4700"]]) {
      chmodSync(dir, mode);
      assert.match(agentHomeFor("claude", dir, statIo()).error, new RegExp(`mode ${shown}; a login home must be 0700`));
    }
    chmodSync(dir, 0o700);
    // Claude's default folder, or a path resolving to it, names another (empty) login there.
    const claudeDefault = privateDir(root, "home/.claude");
    const io = { ...statIo(), defaultClaude: join(root, "home/.claude") };
    assert.match(agentHomeFor("claude", claudeDefault, io).error, /Claude's default login folder/);
    symlinkSync(claudeDefault, join(root, "claude-alias"));
    assert.match(agentHomeFor("claude", join(root, "claude-alias"), io).error, /Claude's default login folder/);
    assert.deepEqual(agentHomeFor("codex", claudeDefault, io), { home: claudeDefault }, "only Claude's own default is special");
  });

  test("#1208 the launch signature: the whole ordered unset run, the vendor folder and the launch id; nothing else reads as chosen", () => {
    for (const agent of ["claude", "codex"]) {
      const argv = afterDashes(chosenArgv(agent, "/homes/b"));
      assert.deepEqual(chosenHomeOfArgv(argv), { agent, home: "/homes/b", launch: LAUNCH });
      // env's options first, then PATH, then the assignments (logins.js envWords).
      const unsets = AGENT_HOME_UNSETS[agent].flatMap((k) => ["-u", k]);
      assert.deepEqual(argv.slice(0, 1 + unsets.length), ["/usr/bin/env", ...unsets]);
      assert.match(argv[1 + unsets.length], /^PATH=/);
      const vendor = agent === "claude" ? ["CLAUDE_CONFIG_DIR=/homes/b", `${CLAUDE_STORAGE_VAR}=/homes/b`] : ["CODEX_HOME=/homes/b"];
      assert.deepEqual(argv.slice(2 + unsets.length, 2 + unsets.length + vendor.length + 2), [...vendor, `${LAUNCH_VAR}=${LAUNCH}`, agent]);
      // Under hc's keep wrapper too.
      assert.deepEqual(chosenHomeOfArgv(["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", ...argv])?.home, "/homes/b");
      // Any word out of place, missing or added is an ordinary launch.
      const variants = [
        argv.filter((w) => w !== `${LAUNCH_VAR}=${LAUNCH}`),
        argv.map((w) => (w === `${LAUNCH_VAR}=${LAUNCH}` ? `${LAUNCH_VAR}=not-a-uuid` : w)),
        [argv[0], ...argv.slice(3, 1 + unsets.length), argv[1], argv[2], ...argv.slice(1 + unsets.length)],
        [argv[0], ...argv.slice(3)],
        argv.map((w) => (w === agent ? `/usr/local/bin/${agent}` : w)),
        ["env", ...argv.slice(1)],
        [...argv.slice(0, 1 + unsets.length + 1), "EXTRA=1", ...argv.slice(2 + unsets.length)],
      ];
      for (const v of variants) assert.equal(chosenHomeOfArgv(v), null, JSON.stringify(v));
    }
    const claude = afterDashes(chosenArgv("claude", "/homes/b"));
    assert.equal(chosenHomeOfArgv(claude.map((w) => (w.startsWith(`${CLAUDE_STORAGE_VAR}=`) ? `${CLAUDE_STORAGE_VAR}=/homes/c` : w))), null);
    // Dev's launches: the default login's lone unset, an Accounts login's assignment, a plain PATH.
    assert.equal(chosenHomeOfArgv(["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "PATH=/bin", "claude"]), null);
    assert.equal(chosenHomeOfArgv(["/usr/bin/env", "PATH=/bin", "CLAUDE_CONFIG_DIR=/logins/b", "claude"]), null);
    assert.equal(chosenHomeOfArgv(["/usr/bin/env", "PATH=/bin", "CODEX_HOME=/homes/b", "codex"]), null);
    assert.equal(chosenHomeOfArgv(null), null);
    assert.equal(chosenHomeOfArgv(["codex"]), null);
  });

  test("#1208 a chosen launch runs the shipped command only: a programs.json run is refused", () => {
    assert.equal(agentHomeRunProblem("claude", ["claude"], AGENTS.claude.run), null);
    assert.equal(agentHomeRunProblem("codex", ["codex"], AGENTS.codex.run), null);
    for (const run of [["env", "ANTHROPIC_API_KEY=x", "claude"], ["claude", "--settings", "/x.json"], ["codex", "-c", "model_provider=x"],
      ["codex", "--profile", "p"], ["/opt/codex"], []]) {
      assert.match(agentHomeRunProblem(run.includes("claude") ? "claude" : "codex", run, run.includes("claude") ? ["claude"] : ["codex"]),
        /runs (claude|codex)'s shipped command; programs\.json overrides it here/);
    }
  });

  test("#1208 repository settings that pick an account are refused by file and key, never by value", () => {
    for (const key of [...AGENT_HOME_UNSETS.claude, "CLAUDE_CONFIG_DIR", CLAUDE_STORAGE_VAR]) {
      const why = agentHomeSettingsProblem("claude", JSON.stringify({ env: { [key]: "secret-value" } }));
      assert.equal(why, `sets env ${key}`);
    }
    assert.equal(agentHomeSettingsProblem("claude", JSON.stringify({ apiKeyHelper: "/bin/echo secret" })), "sets apiKeyHelper");
    assert.equal(agentHomeSettingsProblem("claude", "{ not json"), "isn't valid JSON");
    assert.equal(agentHomeSettingsProblem("claude", "[1]"), "isn't a JSON object");
    assert.equal(agentHomeSettingsProblem("claude", JSON.stringify({ env: { FOO: "1" }, hooks: {}, permissions: { allow: [] } })), null);
    const codex = (text) => agentHomeSettingsProblem("codex", text);
    for (const key of ["model_provider", "model_providers", "profile", "profiles", "preferred_auth_method", "forced_login_method", "chatgpt_base_url"]) {
      for (const text of [`${key} = "x"`, `"${key}" = "x"`, `'${key}' = "x"`, `[${key}]\nx = 1`, `[${key}.x]\ny = 1`, `a.${key} = "x"`,
        `features = { ${key} = "x" }`, `features={${key}="x"}`, `[[${key}]]`, `  ${key}="x"`]) {
        assert.equal(codex(text), `sets ${key}`, text);
      }
    }
    assert.equal(codex('"model\\u005fprovider" = "x"'), "sets model_provider", "an escaped key is read decoded");
    assert.equal(codex('note = "#"\nmodel_provider = "x"'), "sets model_provider", "a # in a string hides nothing");
    assert.equal(codex('x = """\na\n"""\nprofile = "p"'), "sets profile");
    assert.equal(codex('x = "never ends\nprofile = "p"'), "has a string that never ends");
    assert.equal(codex('# model_provider = "x"\nmodel = "gpt-5.5" # profile\n[projects."/w"]\ntrust_level = "trusted"\n'), null);
    assert.equal(codex(""), null);
  });

  test("#1208 ledger rows: the intent row, the start row's two keys only with a home, and the login generation's own folder", () => {
    const row = workerIntent({ launch: LAUNCH, name: "e2e-x", project: "/p", worktree: "/p/.claude/worktrees/x", agent: "codex", agentHome: "/homes/b", at: 5 });
    assert.deepEqual(row, { event: "intent", kind: "worker", launch: LAUNCH, name: "e2e-x", project: "/p", worktree: "/p/.claude/worktrees/x", agent: "codex", agentHome: "/homes/b", at: 5 });
    const lines = [row, { ...row, launch: "nope" }, { ...row, agent: "dsh-tui" }, { ...row, agentHome: "relative" }, { event: "start", terminal: "t1" }, { event: "mystery" }]
      .map((r) => JSON.stringify(r)).join("\n");
    assert.deepEqual(readLedger(lines), [row, { event: "start", terminal: "t1" }, { event: "mystery" }], "a malformed intent is skipped; other rows as before");
    const unresolved = unresolvedWorker({ terminal: "t1", core: "this-core", launch: LAUNCH });
    assert.deepEqual(unresolved, { event: "unresolved", terminal: "t1", core: "this-core", created_ms: null, launch: LAUNCH });
    assert.deepEqual(readLedger([unresolved, { ...unresolved, core: "" }, { ...unresolved, created_ms: "5" },
      { ...unresolved, launch: "nope" }].map((r) => JSON.stringify(r)).join("\n")), [unresolved]);
    const base = { kind: "worker", terminal: "t9", botId: BOT, at: "2026-11-20T00:00:00.000Z" };
    const plain = startRow(base);
    assert.equal(Object.hasOwn(plain, "agentHome"), false);
    assert.equal(Object.hasOwn(plain, "launch"), false);
    assert.deepEqual(Object.keys(startRow({ ...base, agentHome: "/homes/b", launch: LAUNCH })).slice(-3), ["agentHome", "launch", "at"]);
    const record = { version: 1, sequence: 7, claude: { generation: GEN.claude, configDir: "/homes/b" }, codex: { generation: GEN.codex, home: "/homes/c" } };
    const real = (p) => p;
    assert.deepEqual(chosenLoginGeneration(record, "claude", "/homes/b", real), { generation: GEN.claude, sequence: 7 });
    assert.deepEqual(chosenLoginGeneration(record, "codex", "/homes/c", real), { generation: GEN.codex, sequence: 7 });
    assert.deepEqual(chosenLoginGeneration(record, "claude", "/homes/other", real), { generation: null, sequence: null });
    assert.deepEqual(chosenLoginGeneration(record, "codex", "/homes/b", real), { generation: null, sequence: null });
    assert.deepEqual(chosenLoginGeneration(record, "claude", "/homes/b", () => { throw new Error("gone"); }), { generation: null, sequence: null });
  });

  test("#1208 the roster: checkBots refuses a malformed home, parseBots keeps a dropped worker's home for the launch to refuse", () => {
    assert.deepEqual(checkBots(roster({ worker: { agent: "codex", agentHome: "/homes/b" } })), []);
    assert.deepEqual(checkBots(roster({ worker: { agentHome: "/may/not/exist" } })), [], "the save checks the shape only");
    for (const agentHome of [null, 17, "", "relative", "/", "/a\nb"]) {
      assert.ok(checkBots(roster({ worker: { agentHome } })).some((l) => l.includes("worker.agentHome")), JSON.stringify(agentHome));
    }
    assert.ok(checkBots(roster({ worker: { agent: "omp", agentHome: "/homes/b" } })).some((l) => /worker\.agentHome: needs a Claude or Codex/.test(l)));
    assert.ok(checkBots(roster({ worker: { template: "dev-sol", agentHome: "/homes/b" } })).some((l) => /can't be used with a worker template/.test(l)));
    // A worker object with a field that isn't text is dropped as before, its home kept aside.
    const parsed = parseBots(JSON.stringify(roster({ worker: { agent: "codex", model: 5, agentHome: "/homes/b" } })));
    const bot = parsed.file.bots[0];
    assert.equal(bot.worker, undefined, "dropped, as dev drops it");
    assert.ok(parsed.warnings.includes(`${BOT}: worker model not text; ignored`));
    assert.deepEqual(workerHomeOf(bot), { present: true, home: "/homes/b", error: "worker model not text" });
    assert.equal(workerHomeLaunchProblem(bot), "worker model not text");
    assert.ok(parsed.warnings.some((w) => /worker\.agentHome: worker model not text; launches using it will be refused/.test(w)));
    // No home: the same warnings and bots as before.
    const plain = parseBots(JSON.stringify(roster({ worker: { agent: "codex", model: 5 } })));
    assert.deepEqual(plain.warnings.filter((w) => w.startsWith(BOT)), [`${BOT}: worker model not text; ignored`]);
    assert.deepEqual(workerHomeOf(plain.file.bots[0]), { present: false, home: undefined, error: null });
  });

  test("#1208 applyBotEdit: the home follows the default worker agent; only a writer that gives it sets it, none brings back a dropped one", () => {
    const raw = roster({ worker: { agent: "codex", agentHome: "/homes/b" } });
    const stored = raw.bots[0];
    const edit = (entry, given = false) => applyBotEdit(raw, entry, null, { workerHomeGiven: given }).bots[0].worker;
    assert.deepEqual(edit({ ...stored, role: "new" }), { agent: "codex", agentHome: "/homes/b" }, "an unrelated edit keeps it");
    assert.deepEqual(edit({ ...stored, agent: "codex" }), { agent: "codex", agentHome: "/homes/b" }, "the seat agent alone isn't the worker default");
    assert.deepEqual(edit({ ...stored, worker: { agent: "claude", agentHome: "/homes/b" } }), { agent: "claude" }, "a new worker agent drops it");
    assert.deepEqual(edit({ ...stored, worker: { agent: "claude", agentHome: "/homes/c" } }, true), { agent: "claude", agentHome: "/homes/c" }, "unless given again");
    assert.deepEqual(edit({ ...stored, worker: { agent: "codex", agentHome: "" } }, true), { agent: "codex" }, "empty clears");
    assert.deepEqual(edit({ ...stored, worker: { agent: "codex", agentHome: "/homes/stale" } }), { agent: "codex", agentHome: "/homes/b" },
      "a writer that doesn't give it never writes its own copy");
    const dropped = roster({ worker: { agent: "claude" } });
    assert.deepEqual(applyBotEdit(dropped, { ...dropped.bots[0], worker: { agent: "claude", agentHome: "/homes/b" } }).bots[0].worker, { agent: "claude" },
      "a stale form entry never resurrects a dropped home");
    const seatOnly = roster({ agent: "codex", worker: { agentHome: "/homes/b" } });
    assert.deepEqual(applyBotEdit(seatOnly, { ...seatOnly.bots[0], agent: "claude" }).bots[0].worker, undefined, "with no worker agent, the seat's agent is the default");
    const plain = roster({ worker: { agent: "codex" } });
    assert.deepEqual(applyBotEdit(plain, { ...plain.bots[0], role: "x" }), { ...plain, bots: [{ ...plain.bots[0], role: "x" }] }, "no home: as before");
  });

  test("#1208 the Codex model list and config are read from a chosen home; the default paths are unchanged", (t) => {
    assert.deepEqual(configPaths("/h"), { ...configPaths("/h", "/h/.codex") });
    assert.equal(configPaths("/h").codexModels, "/h/.codex/models_cache.json");
    assert.equal(configPaths("/h", "/homes/b").codexConfig, "/homes/b/config.toml");
    const read = (p) => (p === "/homes/b/models_cache.json" ? JSON.stringify({ models: [{ slug: "gpt-chosen" }] }) : null);
    assert.deepEqual(knownModels("codex", { home: "/h", read, codexHome: "/homes/b" }), ["gpt-chosen"]);
    assert.deepEqual(knownModels("codex", { home: "/h", read }), []);
  });

  // ---- the roster through create and edit ----

  test("#1208 create/edit --worker-agent-home: set, kept, dropped with the worker agent, given again, cleared; a bad shape refused", (t) => {
    const s = homeScene(t, cli, { bot: { worker: { agent: "codex" } } });
    const ok = (...args) => { const r = s.run(args, { from: null }); assert.equal(r.code, 0, r.err); };
    const worker = () => s.bots().bots[0].worker;
    ok("edit", "Genie", "--worker-agent-home", "/absent/login");
    assert.deepEqual(worker(), { agent: "codex", agentHome: "/absent/login" }, "the save checks the shape only");
    ok("edit", "Genie", "--role", "lead");
    assert.equal(worker().agentHome, "/absent/login");
    ok("edit", "Genie", "--agent", "codex");
    assert.equal(worker().agentHome, "/absent/login", "the seat agent isn't the worker default here");
    ok("edit", "Genie", "--worker-agent", "claude");
    assert.equal(worker().agentHome, undefined, "a new default worker agent drops it");
    ok("edit", "Genie", "--worker-agent", "codex", "--worker-agent-home", "/homes/c");
    assert.deepEqual(worker(), { agent: "codex", agentHome: "/homes/c" });
    ok("edit", "Genie", "--worker-agent-home=");
    assert.deepEqual(worker(), { agent: "codex" });
    for (const bad of ["relative", "/"]) {
      const r = s.run(["edit", "Genie", "--worker-agent-home", bad], { from: null });
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /--worker-agent-home:/);
    }
    const omp = s.run(["edit", "Genie", "--worker-agent", "omp", "--worker-agent-home", "/homes/c"], { from: null });
    assert.notEqual(omp.code, 0);
    assert.match(omp.err, /worker\.agentHome: needs a Claude or Codex default worker agent/);
    assert.deepEqual(worker(), { agent: "codex" }, "nothing saved");
    ok("create", "--name", "Two", "--agent", "claude", "--worker-agent-home", "/homes/two");
    assert.deepEqual(s.bots().bots.find((b) => b.name === "Two").worker, { agentHome: "/homes/two" });
  });

  test("#1208 --agent-home anywhere but a worker start, and --worker-agent-home outside create/edit, exit 2 before anything runs", (t) => {
    const s = homeScene(t, cli);
    const dir = privateDir(s.root, "homes/b");
    for (const args of [["help", "--agent-home", dir], ["--help", "--agent-home", dir], ["worker", "kill", "t1", "--agent-home", dir],
      ["restart", "Genie", "--agent-home", dir], ["revive", "--agent-home", dir], ["start", "Genie", "--agent-home", dir],
      ["attach", "Genie", "t1", "--agent-home", dir], ["ls", "--agent-home", dir], ["worker", "x", "--branch", "e2e/x", "--help", "--agent-home", dir],
      ["restart", "Genie", "--worker-agent-home", dir], ["worker", "x", "--branch", "e2e/x", "--worker-agent-home", dir]]) {
      const r = s.run(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
      assert.match(r.err, /^am: --(worker-)?agent-home goes with/);
    }
    assert.deepEqual(s.calls(), [], "no hc call at all: no kill, no restart, no start");
  });

  // ---- the worker launch ----

  test("#1208 worker --agent-home (Claude): signature, --outlive-parent, the keys unset, the folder set, intent then start row", (t) => {
    const s = homeScene(t, cli);
    const dir = privateDir(s.root, "homes/claude-b");
    const r = s.run(["worker", "fix it", "--branch", "e2e/x", "--agent-home", dir, "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().agentHome, dir);
    const [run] = s.runs();
    assert.ok(run.includes("--outlive-parent"), "the worker outlives its lead");
    assert.deepEqual(run.slice(run.indexOf("--parent"), run.indexOf("--parent") + 3), ["--parent", "t1", "--outlive-parent"]);
    assert.equal(run.some((w) => w.startsWith("agent.home")), false, "no label of its own");
    const argv = afterDashes(run);
    const sig = chosenHomeOfArgv(argv);
    assert.deepEqual({ agent: sig.agent, home: sig.home }, { agent: "claude", home: dir });
    const pane = s.hcState().terminals.find((x) => x.address === "t100");
    assert.equal(pane.die_with_parent, false);
    assert.deepEqual(chosenHomeOfArgv(pane.argv), sig, "hc reports the signature for the pane's whole life");
    const rows = s.ledger();
    const intent = rows.findIndex((x) => x.event === "intent"), start = rows.findIndex((x) => x.event === "start");
    assert.ok(intent >= 0 && intent < start, "the intent row comes first");
    assert.deepEqual({ ...rows[intent], at: 0 }, { event: "intent", kind: "worker", launch: sig.launch, name: "e2e-x", project: realpathSync(s.project),
      worktree: rows[start].worktree, agent: "claude", agentHome: dir, at: 0 });
    assert.equal(rows[start].agentHome, dir);
    assert.equal(rows[start].launch, sig.launch);
    assert.deepEqual(rows[start].env, { HOME: s.home, CLAUDE_CONFIG_DIR: dir });
    assert.deepEqual([rows[start].generation, rows[start].sequence], [null, null]);
    const env = s.effectiveEnv(argv);
    assert.equal(env.CLAUDE_CONFIG_DIR, dir);
    assert.equal(env[CLAUDE_STORAGE_VAR], dir);
    for (const k of [...AGENT_HOME_UNSETS.claude]) assert.equal(env[k], undefined, `${k} is unset`);
    assert.equal(env.OPENAI_API_KEY, "planted-secret", "only Claude's keys are Claude's to unset");
    assert.doesNotMatch(r.err, /claude-logins\.json/);
  });

  // #1509 over #1208: under the Bot login policy (the pointer present) a chosen home may only be the
  // folder the panel's login record names; any other refuses before anything is made. With the
  // policy off every row above holds unchanged.
  test("#1509 under the login policy a chosen agent home must be the reader's own folder", (t) => {
    const s = homeScene(t, cli);
    const login = loginFixture(join(s.root, "cli-homes"), "claude");
    const policy = { env: { ...login.env } };
    const same = s.run(["worker", "same home", "--branch", "e2e/same", "--agent-home", realpathSync(login.dir), "--json"], policy);
    assert.equal(same.code, 0, same.err);
    assert.equal(chosenHomeOfArgv(afterDashes(s.runs().at(-1))).home, realpathSync(login.dir), "the chosen launch, on the reader's folder");
    const before = s.runs().length;
    const other = privateDir(s.root, "homes/claude-other");
    const differs = s.run(["worker", "other home", "--branch", "e2e/other", "--agent-home", other, "--json"], policy);
    assert.equal(differs.code, 2, differs.err);
    assert.match(differs.err, /\(agent-home-differs\)/);
    assert.equal(s.runs().length, before, "nothing launched");
    assert.equal(branchesOf(s).includes("e2e/other"), false, "no worktree made");
  });

  test("#1509 under the login policy the roster's worker.agentHome refuses when it is not the reader's folder", (t) => {
    const s = homeScene(t, cli);
    const login = loginFixture(join(s.root, "cli-homes"), "claude");
    const other = privateDir(s.root, "homes/claude-roster");
    const edit = s.run(["edit", "Genie", "--worker-agent-home", other], { from: null });
    assert.equal(edit.code, 0, edit.err);
    const before = s.runs().length;
    const r = s.run(["worker", "roster home", "--branch", "e2e/roster", "--json"], { env: { ...login.env } });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /\(agent-home-differs\)/);
    assert.equal(s.runs().length, before);
    // Policy off: the roster's home is the launch's, exactly as #1208 ships it.
    const off = s.run(["worker", "roster home", "--branch", "e2e/roster-off", "--json"]);
    assert.equal(off.code, 0, off.err);
    assert.equal(chosenHomeOfArgv(afterDashes(s.runs().at(-1))).home, other);
  });

  test("#1208 worker --agent-home (Codex): CODEX_HOME, its keys unset, its model list and trust config read from that folder", (t) => {
    const s = homeScene(t, cli);
    const dir = privateDir(s.root, "homes/codex-b");
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-chosen" }] }));
    writeFileSync(join(s.home, ".codex/models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-default" }] }));
    // The person's default config marks the project untrusted; the chosen folder's says nothing.
    writeFileSync(join(s.home, ".codex/config.toml"), `[projects."${realpathSync(s.project)}"]\ntrust_level = "untrusted"\n`);
    const r = s.run(["worker", "fix it", "--branch", "e2e/x", "--agent", "codex", "--model", "gpt-chosen", "--agent-home", dir, "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().warnings.some((w) => /isn't on codex's model list/.test(w)), false, "the chosen folder's model list");
    assert.equal(r.json().warnings.some((w) => /untrusted/.test(w)), false, "the chosen folder's trust config");
    const argv = afterDashes(s.runs()[0]);
    assert.deepEqual(chosenHomeOfArgv(argv)?.home, dir);
    const start = s.ledger().find((x) => x.event === "start");
    assert.deepEqual(start.env, { HOME: s.home, CODEX_HOME: dir });
    const env = s.effectiveEnv(argv);
    assert.equal(env.CODEX_HOME, dir);
    for (const k of AGENT_HOME_UNSETS.codex) assert.equal(env[k], undefined, `${k} is unset`);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/planted/claude", "a Codex launch leaves Claude's folder alone");
    // The same config in the chosen folder: the trust is withheld, as for a default launch.
    writeFileSync(join(dir, "config.toml"), `[projects."${realpathSync(s.project)}"]\ntrust_level = "untrusted"\n`);
    const again = s.run(["worker", "more", "--branch", "e2e/y", "--agent", "codex", "--agent-home", dir, "--json"]);
    assert.equal(again.code, 0, again.err);
    assert.ok(again.json().warnings.some((w) => /untrusted/.test(w)));
  });

  test("#1208 worker.agentHome: used for the default worker agent; the flag wins; another agent ignores it", (t) => {
    const roster = privateDir(scratchRoot(t, "hb-agent-home-r-"), "roster-home");
    const s = homeScene(t, cli, { bot: { agent: "claude-code", worker: { agentHome: roster } } });
    const flag = privateDir(s.root, "homes/flag");
    const home = (n) => chosenHomeOfArgv(afterDashes(s.runs()[n]))?.home ?? null;
    const alias = s.run(["worker", "a", "--branch", "e2e/a", "--agent", "claude"]);
    assert.equal(alias.code, 0, alias.err);
    assert.equal(home(0), roster, "the bot's claude-code alias resolves to claude");
    assert.equal(s.run(["worker", "b", "--branch", "e2e/b", "--agent", "claude", "--agent-home", flag]).code, 0);
    assert.equal(home(1), flag);
    const other = s.run(["worker", "c", "--branch", "e2e/c", "--agent", "codex"]);
    assert.equal(other.code, 0, other.err);
    assert.equal(home(2), null, "Codex gets its usual launch");
    assert.equal(s.runs()[2].includes("--outlive-parent"), false);
  });

  test("#1208 roster save requires a launchable default for an alias bot's worker home", (t) => {
    const agent = "claude-code";
    const s = homeScene(t, cli, { bot: { agent } });
    const dir = privateDir(s.root, "homes/claude");
    const worker = { agentHome: dir };
    assert.deepEqual(checkBots(roster({ agent })), []);
    assert.ok(checkBots(roster({ agent, worker })).some((line) => /worker\.agentHome: set worker\.agent/.test(line)));
    const args = ["worker", "x", "--branch", "e2e/x"];
    const plain = s.run(args);
    assert.equal(plain.code, 2, plain.err);
    assert.match(plain.err, /Genie has no coding agent for its workers; pass --agent/);
    assert.deepEqual(s.runs(), []);

    const invalid = roster({ agent, worker });
    writeFileSync(join(s.project, ".herdr/bots.json"), JSON.stringify(invalid));
    const savedEarlier = s.run(args);
    assert.equal(savedEarlier.code, 2, savedEarlier.err);
    assert.match(savedEarlier.err, /Genie has no coding agent for its workers; pass --agent/);
    assert.deepEqual(s.runs(), []);

    // An explicit roster default is resolved even when the worker command has no --agent.
    worker.agent = agent;
    const valid = roster({ agent, worker });
    assert.deepEqual(checkBots(valid), []);
    writeFileSync(join(s.project, ".herdr/bots.json"), JSON.stringify(valid));
    const chosen = s.run(args);
    assert.equal(chosen.code, 0, chosen.err);
    assert.equal(chosenHomeOfArgv(afterDashes(s.runs()[0]))?.home, dir);
  });

  test("#1208 worker.agentHome with an unknown worker.agent refuses before creating anything", (t) => {
    const worker = { agent: "unknown-worker-agent", agentHome: "/homes/b" };
    const s = homeScene(t, cli, { bot: { worker } });
    worker.agentHome = privateDir(s.root, "homes/b");
    writeFileSync(join(s.project, ".herdr/bots.json"), JSON.stringify(roster({ worker })));
    const r = s.run(["worker", "x", "--branch", "e2e/x"]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /worker\.agentHome names a login for worker\.agent "unknown-worker-agent", which isn't a coding agent Herdr knows/);
    assert.deepEqual(s.runs(), []);
    assert.deepEqual(s.ledger(), []);
    assert.equal(s.branches(), "");
    assert.equal(existsSync(join(s.project, ".claude/worktrees")), false);
    assert.equal(existsSync(join(s.project, ".claude/settings.local.json")), false);
  });

  test("#1208 a relative --agent-home is the folder it names from where the command runs, by its real path", (t) => {
    const s = homeScene(t, cli);
    const dir = privateDir(s.project, "logins/b");
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", "logins/b", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().agentHome, dir);
    assert.equal(chosenHomeOfArgv(afterDashes(s.runs()[0])).home, dir);
  });

  test("#1208 no home: the full worker launch and ledger match dev for both vendors", (t) => {
    const s = homeScene(t, cli);
    const current = privateDir(s.root, "cli-homes/current");
    const codex = privateDir(s.root, "core-codex");
    writeFileSync(join(codex, "config.toml"), `[projects.${JSON.stringify(s.project)}]\ntrust_level = "untrusted"\n`);
    // No Bot login pointer: since #1509 a present pointer is the login policy, which changes the
    // launch on purpose; without it every launch is dev's, and its rows name no generation.
    void current;
    const env = { PATH: [s.bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), CODEX_HOME: codex };
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: s.project, encoding: "utf8" }).trim();
    for (const [branch, agent] of [["e2e/a", "claude"], ["e2e/b", "codex"]]) {
      const r = s.run(["worker", "x", "--branch", branch, "--agent", agent], { env });
      assert.equal(r.code, 0, r.err);
    }
    const [claude, code] = s.hcState().terminals.slice(1);
    const rows = s.ledger();
    assert.equal(rows.length, 2);
    const session = rows[0].session;
    assert.match(session, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    const path = `PATH=${join(dirname(dirname(cli)), "hc-kill")}:${env.PATH}`;
    const task = "x\n\nBefore you report done: commit or discard every change you made and leave the worktree clean (`git status --porcelain` prints nothing).";
    const worktree = (name) => join(s.project, ".claude/worktrees", name);
    const prefix = (name, branch) => ["run", "--bg", "--json", "--name", name, "--cwd", worktree(name),
      "--label", `worker.of=${BOT}`, "--label", `branch=${branch}`, "--label", "worker.role=dev"];
    const parent = ["--parent", "t1", "--", "/usr/bin/env"];
    // These are dev's full launches. Only paths, the new session id and run times vary by scene.
    assert.deepEqual(s.runs(), [
      [...prefix("e2e-a", "e2e/a"), "--label", `agent.session=${session}`, ...parent, "-u", "CLAUDE_CONFIG_DIR", path,
        "claude", "--settings", '{"promptSuggestionEnabled":false,"awaySummaryEnabled":false,"env":{"CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES":"1"}}',
        "--permission-mode", "auto", "--session-id", session, task],
      [...prefix("e2e-b", "e2e/b"), ...parent, path, "codex", "--approve-for-me", "--disable", "hooks", "--no-daemon",
        "-c", "sandbox_workspace_write.network_access=true", "-c", "allow_login_shell=false", task],
    ]);
    assert.deepEqual([claude.labels, code.labels], [
      { "worker.of": BOT, branch: "e2e/a", "worker.role": "dev", "agent.session": session },
      { "worker.of": BOT, branch: "e2e/b", "worker.role": "dev" },
    ]);
    const start = (pane, name, branch, agent, pid) => ({
      event: "start", kind: "worker", terminal: pane.address, pid, botId: BOT, task: null, worktree: worktree(name),
      agent, model: null, effort: null, template: null, role: "dev", branch, project: s.project, lead: BOT, base,
      created: true, swap: false, override: true, override_requested: null, core: "fakecore0000", created_ms: pane.created_ms,
      squad: null, session: agent === "claude" ? session : null, generation: null, sequence: null,
    });
    const expected = [
      start(claude, "e2e-a", "e2e/a", "claude", 5100),
      { ...start(code, "e2e-b", "e2e/b", "codex", 5101), env: { HOME: s.home, CODEX_HOME: codex } },
    ];
    assert.deepEqual(rows.map(({ at, ...row }) => {
      assert.equal(new Date(at).toISOString(), at);
      assert.ok(Date.parse(at) >= row.created_ms);
      return row;
    }), expected);
  });

  test("#1208 refusals before anything is made: mode, owner, template, roster template, dropped defaults, programs.json, an argv-less hc", (t) => {
    const cases = [
      ["a 0755 folder", {}, (s) => ["--agent-home", privateDir(s.root, "homes/open", 0o755)], /mode 0755; a login home must be 0700/],
      ["a sticky 01700 folder", {}, (s) => ["--agent-home", privateDir(s.root, "homes/sticky", 0o1700)], /mode 1700/],
      ["Claude's default folder", {}, (s) => ["--agent-home", join(s.home, ".claude")], /Claude's default login folder/],
      ["a missing folder", {}, (s) => ["--agent-home", join(s.root, "nope")], /is not a folder/],
      ["an empty flag", {}, () => ["--agent-home="], /needs a folder/],
      ["a template", {}, (s) => ["--template", "dev-sol", "--agent-home", privateDir(s.root, "homes/t")], /template dev-sol owns its command/],
      ["another agent", {}, (s) => ["--agent", "omp", "--agent-home", privateDir(s.root, "homes/o")], /for Claude and Codex workers/],
      ["the roster's template", { worker: { template: "dev-sol", agentHome: "/homes/r" } }, () => [], /can't be used with its worker template dev-sol/],
      ["dropped worker defaults", { worker: { agent: "codex", model: 5, agentHome: "/homes/r" } }, () => [], /worker defaults were dropped \(worker model not text\)/],
      ["dropped defaults with the flag", { worker: { template: "bad name", agentHome: "/homes/r" } }, (s) => ["--agent-home", privateDir(s.root, "homes/f")], /worker defaults were dropped/],
      ["a programs.json run", {}, (s) => { writeFileSync(join(s.app, "programs.json"), JSON.stringify({ programs: { claude: { run: ["claude", "--settings", "/x"] } } }));
        return ["--agent-home", privateDir(s.root, "homes/p")]; }, /runs claude's shipped command; programs\.json overrides it here/],
    ];
    for (const [what, bot, args, message] of cases) {
      const s = homeScene(t, cli, { bot });
      const r = s.run(["worker", "x", "--branch", "e2e/x", ...args(s)]);
      assert.equal(r.code, 2, `${what}: ${r.err}`);
      assert.match(r.err, message, what);
      assert.deepEqual(s.runs(), [], `${what}: nothing started`);
      assert.equal(s.branches(), "", `${what}: no branch made`);
      assert.equal(existsSync(join(s.project, ".claude/settings.local.json")), false, `${what}: no hook`);
      assert.equal(s.ledger().length, 0, `${what}: no row`);
    }
    const s = homeScene(t, cli, { callerArgv: null });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /needs an hc that reports each pane's launch argv; this one doesn't/);
    assert.deepEqual(s.runs(), []);
    assert.equal(s.branches(), "");
    const plain = s.run(["worker", "x", "--branch", "e2e/x"]);
    assert.equal(plain.code, 0, `no home needs no argv: ${plain.err}`);
  });

  test("#1208 a full hc guard first on PATH refuses (the pack's, am's, another install's); the hc kill shim first is a normal seat and starts", (t) => {
    const s = homeScene(t, cli);
    const dir = privateDir(s.root, "homes/b");
    // Another install's guard: its own copy of the guard's modules beside an entry this copy ships.
    const other = join(s.app, "mods/am-sidebar");
    mkdirSync(join(other, "guard"), { recursive: true });
    for (const f of ["hcGuard.mjs", "agyPrompt.js", "launchArgs.js", "dialog.js", "approved.js", "attach.js", "model.js", "models.js", "workers.js", "logins.js", "loginWords.js", "retired.js", "hermesPair.js"]) {
      cpSync(join(GUARD_DIR, "..", f), join(other, f));
    }
    writeFileSync(join(other, "hcGuard.mjs"), `${readFileSync(join(other, "hcGuard.mjs"), "utf8")}\n// another version\n`);
    cpSync(join(GUARD_DIR, "hc"), join(other, "guard", "hc"));
    chmodSync(join(other, "guard", "hc"), 0o755);
    for (const guard of [GUARD_DIR, AM_GUARD_DIR, join(other, "guard")]) {
      const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", dir], { env: { PATH: `${guard}:${s.env.PATH}` } });
      assert.equal(r.code, 2, `${guard}: ${r.err}`);
      assert.match(r.err, /this pane's first hc is the hc guard in /);
    }
    assert.deepEqual(s.runs(), []);
    const shim = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", dir], { env: { PATH: `${KILL_GUARD_DIR}:${s.env.PATH}` } });
    assert.equal(shim.code, 0, shim.err);
    assert.equal(chosenHomeOfArgv(afterDashes(s.runs()[0]))?.home, dir);
  });

  test("#1208 through the hc proxy: the flag, a working home or an approved home field is refused before anything", async (t) => {
    const dir = (s) => privateDir(s.root, "homes/b");
    const proxied = async (s, args) => {
      const proxyDir = shortSocketDir(t, "ahp-");
      const sock = join(proxyDir, "p.sock");
      const server = net.createServer((c) => c.on("data", () => c.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { v: 1, terminal: "t1", core: { id: "fakecore0000", name: "fake" } } })}\n`)));
      await new Promise((done) => server.listen(sock, done));
      t.after(() => server.close());
      return s.runAsync(["worker", "x", "--branch", "e2e/x", ...args], { env: { HC_SOCKET: sock, HC_TERMINAL_SOCKET: sock,
        AUTOMAGIK_HERDR_TEST_ROOTS: `${s.env.AUTOMAGIK_HERDR_TEST_ROOTS}:${proxyDir}` } });
    };
    const flag = homeScene(t, cli);
    let r = await proxied(flag, ["--agent-home", dir(flag)]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /--agent-home needs a local, unproxied worker launch/);
    const working = homeScene(t, cli, { bot: { worker: { agent: "claude", agentHome: "/homes/w" } } });
    r = await proxied(working, ["--agent", "codex"]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /worker\.agentHome needs a local, unproxied worker launch/);
    const approved = homeScene(t, cli, { bot: { worker: { agent: "claude", agentHome: "/homes/a" } } });
    approveProject({ project: approved.project, env: approved.env, approvedBy: "tester" });
    writeFileSync(join(approved.project, ".herdr/bots.json"), JSON.stringify(roster({ worker: { agent: "claude" } })));
    r = await proxied(approved, []);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /approved roster names worker\.agentHome/);
    for (const s of [flag, working, approved]) {
      assert.deepEqual(s.runs(), []);
      assert.equal(s.branches(), "");
    }
  });

  test("#1208 a failed spawn verification records any pane left live as unresolved", (t) => {
    for (const [patch, kill, ended, message] of [
      [{ die_with_parent: true }, true, true, /hc says it ends with its lead, so it was ended/],
      [{ die_with_parent: null }, true, true, /hc doesn't say whether it outlives its lead, so it was ended/],
      [{ argv: null }, false, false, /can't be shown to be this worker: hc reports no launch argv for it/],
      [{ launch: OTHER_LAUNCH }, false, false, /can't be shown to be this worker: its launch argv is another launch's/],
      [{ created_ms: null }, false, false, /hc get gave no numeric created_ms/],
      [{ die_with_parent: true }, true, false, /it couldn't be confirmed ended/],
    ]) {
      const s = homeScene(t, cli);
      s.patchNextRun(patch);
      if (kill && !ended) s.setState((st) => { st.failKill = "t100"; });
      const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, message);
      const pane = s.hcState().terminals.find((x) => x.address === "t100");
      assert.equal(pane.state, ended ? "finished" : "live");
      assert.equal(s.calls().some((c) => c[0] === "kill"), kill, "only a positively identified instance is ended");
      const [intent, ...rest] = s.ledger();
      assert.equal(intent.event, "intent", "its reservation stays");
      assert.deepEqual(rest, ended ? [] : [{ event: "unresolved", terminal: "t100", core: "fakecore0000",
        created_ms: pane.created_ms ?? null, launch: intent.launch }]);
      if (ended) continue;
      const old = { ...intent, at: Date.now() - 11 * 60_000 };
      writeFileSync(join(s.app, "automagik-herdr/workers.jsonl"), [old, ...rest].map((row) => JSON.stringify(row) + "\n").join(""));
      s.setState((st) => { delete st.terminals.find((x) => x.address === "t100").argv; });
      const attach = s.run(["attach", "Genie", "t100", "--move"], { from: null });
      assert.equal(attach.code, 1, attach.err);
      assert.match(attach.err, /t100 may be a worker still starting on a chosen agent home/);
    }
  });

  test("#1208 chosen spawn verification refuses a reply for a different address", (t) => {
    const s = homeScene(t, cli);
    // Keep the recorded launch's real UUID in argv, but return another address and a lifecycle
    // that would authorize a kill if the reply were trusted.
    s.patchNextRun({ replyAddress: "t101", die_with_parent: true });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /hc get t100 returned t101, so t100 can't be shown to be this worker/);
    assert.equal(s.calls().some(([verb]) => verb === "kill"), false);
    assert.equal(s.hcState().terminals.find((x) => x.address === "t100").state, "live");
    const [intent, observation] = s.ledger();
    assert.equal(intent.event, "intent");
    assert.deepEqual(observation, unresolvedWorker({ terminal: "t100", core: "fakecore0000", created_ms: null, launch: intent.launch }));
    assert.equal(s.ledger().some((row) => row.event === "start"), false);
  });

  test("#1208 a failed first get keeps the name reserved when the next reply has created_ms but no argv", (t) => {
    const s = homeScene(t, cli);
    s.patchNextRun({ argv: null });
    s.setState((st) => { st.failGetOnRun = ["t100"]; });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /hc get can't read it/);
    const [intent, observation] = s.ledger();
    assert.equal(intent.event, "intent");
    assert.deepEqual(observation, { event: "unresolved", terminal: "t100", core: "fakecore0000", created_ms: null, launch: intent.launch });
    const pane = s.hcState().terminals.find((x) => x.address === "t100");
    assert.equal(pane.name, intent.name);
    assert.equal(pane.argv, undefined);
    assert.ok(Number.isSafeInteger(pane.created_ms));
    const bindings = () => existsSync(attachPath(s.app)) ? readFileSync(attachPath(s.app), "utf8") : null;
    const before = bindings();
    const callsBefore = s.calls().length;
    s.setState((st) => { delete st.failGet; });
    const refused = () => {
      const attach = s.run(["attach", "Genie", "t100", "--move"], { from: null });
      assert.equal(attach.code, 1, attach.err);
      assert.match(attach.err, /t100 may be a worker still starting on a chosen agent home/);
    };
    refused();
    const promoted = { ...observation, created_ms: pane.created_ms };
    assert.deepEqual(s.ledger(), [intent, observation, promoted]);
    for (const name of [undefined, "renamed-worker"]) {
      s.setState((st) => { st.terminals.find((x) => x.address === "t100").name = name; });
      refused();
      assert.deepEqual(s.ledger(), [intent, observation, promoted]);
    }
    assert.equal(s.calls().slice(callsBefore).some((c) => c[0] === "label" || c[0] === "kill"), false);
    assert.equal(bindings(), before);
  });

  test("#1208 a pending launch's UUID promotes its first timestamped reply even without its name", (t) => {
    const s = homeScene(t, cli);
    s.setState((st) => { st.failGetOnRun = ["t100"]; });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /hc get can't read it/);
    const [intent, pending] = s.ledger();
    const pane = s.hcState().terminals.find((x) => x.address === "t100");
    assert.equal(chosenHomeOfArgv(pane.argv).launch, intent.launch);
    assert.deepEqual(pending, unresolvedWorker({ terminal: "t100", core: "fakecore0000", created_ms: null, launch: intent.launch }));
    s.setState((st) => {
      delete st.failGet;
      delete st.terminals.find((x) => x.address === "t100").name;
    });
    const first = s.run(["attach", "Genie", "t100", "--move"], { from: null });
    assert.equal(first.code, 1, first.err);
    assert.match(first.err, /t100 is a worker on a chosen agent home/);
    const promoted = { ...pending, created_ms: pane.created_ms };
    assert.deepEqual(s.ledger(), [intent, pending, promoted]);
    s.setState((st) => { delete st.terminals.find((x) => x.address === "t100").argv; });
    const second = s.run(["attach", "Genie", "t100", "--move"], { from: null });
    assert.equal(second.code, 1, second.err);
    assert.match(second.err, /t100 may be a worker still starting on a chosen agent home/);
    assert.deepEqual(s.ledger(), [intent, pending, promoted]);
    assert.equal(s.calls().some(([verb]) => verb === "label" || verb === "kill"), false);
  });

  test("#1208 attach promotes a project-home UUID and recognizes the pane on a second read without argv or name", (t) => {
    const s = homeScene(t, cli);
    const app = join(s.project, ".herdr/app-home");
    const ledger = join(app, "automagik-herdr/workers.jsonl");
    const home = privateDir(s.root, "homes/b");
    const intent = workerIntent({ launch: LAUNCH, name: "pending-w", project: s.project, worktree: s.project,
      agent: "claude", agentHome: home });
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    s.setState((st) => {
      st.terminals.push({ address: "t60", state: "live", cwd: s.project, created_ms: 60, labels: {},
        argv: afterDashes(chosenArgv("claude", home)), foreground: { argv: ["claude"], cwd: s.project } });
    });

    const first = s.run(["attach", "Genie", "t60", "--move"], { from: null });
    assert.equal(first.code, 1, first.err);
    assert.match(first.err, /t60 is a worker on a chosen agent home/);
    const rows = [intent, unresolvedWorker({ terminal: "t60", core: "fakecore0000", created_ms: 60, launch: LAUNCH })];
    assert.deepEqual(readLedger(readFileSync(ledger, "utf8")), rows);
    assert.deepEqual(s.ledger(), []);

    s.setState((st) => { delete st.terminals.find((pane) => pane.address === "t60").argv; });
    const second = s.run(["attach", "Genie", "t60", "--move"], { from: null });
    assert.equal(second.code, 1, second.err);
    assert.match(second.err, /t60 may be a worker still starting on a chosen agent home/);
    assert.deepEqual(readLedger(readFileSync(ledger, "utf8")), rows);
    assert.equal(s.calls().some(([verb]) => verb === "label" || verb === "kill"), false);
  });

  test("#1208 a late hc run answer: the pane found by name is checked as this launch before it is recorded", (t) => {
    const s = homeScene(t, cli);
    s.setState((st) => { st.runDelayMs = 10_000; });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")], { env: { AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "800" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /e2e-x started, but hc run didn't answer within 0\.8s; its start is recorded/);
    const start = s.ledger().find((x) => x.event === "start");
    assert.equal(start.terminal, "t100");
    assert.equal(start.launch, chosenHomeOfArgv(s.hcState().terminals.find((x) => x.address === "t100").argv).launch);
    // Another pane holds the name by then, showing no launch argv: nothing is recorded or ended.
    const s2 = homeScene(t, cli);
    s2.setState((st) => { st.runDelayMs = 10_000; st.getReply = { "e2e-x": { address: "t55", name: "e2e-x", state: "live", created_ms: 3 } }; });
    const r2 = s2.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s2.root, "homes/b")], { env: { AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS: "800" } });
    assert.equal(r2.code, 1, r2.err);
    assert.match(r2.err, /t55 \(named e2e-x\) can't be shown to be this worker/);
    assert.equal(s2.calls().some((c) => c[0] === "kill"), false);
    const [intent, ...rest] = s2.ledger();
    assert.deepEqual(rest, [{ event: "unresolved", terminal: "t55", core: "fakecore0000", created_ms: 3, launch: intent.launch }]);
  });

  test("#1208 the launch is reserved before hc sees it: a reservation that can't be written starts nothing", (t) => {
    const s = homeScene(t, cli);
    mkdirSync(join(s.app, "automagik-herdr/workers.jsonl"), { recursive: true });
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /e2e-x wasn't started: its launch couldn't be reserved in automagik-herdr\/workers\.jsonl/);
    assert.deepEqual(s.runs(), []);
  });

  test("#1208 worktree settings that pick an account refuse the launch, by file and key; the hook step's change is caught too", (t) => {
    const cases = [
      ["claude", { ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-value" } }) }, /\.claude\/settings\.json sets env ANTHROPIC_API_KEY/],
      ["claude", { ".claude/settings.local.json": JSON.stringify({ apiKeyHelper: "print-key" }) }, /\.claude\/settings\.local\.json sets apiKeyHelper/],
      ["claude", { ".claude/settings.json": "{ broken" }, /\.claude\/settings\.json isn't valid JSON/],
      ["codex", { ".codex/config.toml": 'model_provider = "elsewhere"\n' }, /\.codex\/config\.toml sets model_provider/],
      ["codex", { ".codex/config.toml": '[profiles.work]\nmodel = "x"\n' }, /\.codex\/config\.toml sets profiles/],
      ["codex", { ".codex/config.toml": '"forced_login_method" = "api"\n' }, /\.codex\/config\.toml sets forced_login_method/],
    ];
    for (const [agent, files, message] of cases) {
      const s = homeScene(t, cli);
      s.commit(files);
      const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent", agent, "--agent-home", privateDir(s.root, "homes/b")]);
      assert.equal(r.code, 2, `${message}: ${r.err}`);
      assert.match(r.err, message);
      assert.doesNotMatch(r.err, /sk-value|elsewhere|print-key/, "never a value");
      assert.deepEqual(s.runs(), []);
    }
    const clean = homeScene(t, cli);
    clean.commit({ ".claude/settings.json": JSON.stringify({ permissions: { allow: [] } }), ".codex/config.toml": 'model = "gpt-5.5"\n' });
    for (const agent of ["claude", "codex"]) {
      const r = clean.run(["worker", "x", "--branch", `e2e/${agent}`, "--agent", agent, "--agent-home", privateDir(clean.root, `homes/${agent}`)]);
      assert.equal(r.code, 0, r.err);
    }
    // The briefing hook step itself: a settings file that changes while it runs is read again before hc run.
    const s = homeScene(t, cli);
    writeFileSync(s.gitHook, `mkdir -p .claude && printf '%s' '{"env":{"ANTHROPIC_AUTH_TOKEN":"late"}}' > .claude/settings.json\n`);
    const r = s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /settings\.json sets env ANTHROPIC_AUTH_TOKEN/);
    assert.deepEqual(s.runs(), []);
  });

  test("#1208 under #1509: with the pointer, only the record's own vendor folder may be chosen, and its generation is kept", (t) => {
    for (const agent of ["claude", "codex"]) {
      const s = homeScene(t, cli);
      const login = loginFixture(join(s.root, "cli-homes"), agent, GEN[agent]);
      const match = realpathSync(login.dir), other = privateDir(s.root, "homes/other");
      const env = { ...login.env };
      assert.equal(s.run(["worker", "x", "--branch", "e2e/a", "--agent", agent, "--agent-home", match], { env }).code, 0);
      const refused = s.run(["worker", "y", "--branch", "e2e/b", "--agent", agent, "--agent-home", other], { env });
      assert.equal(refused.code, 2, `${agent}: ${refused.err}`);
      assert.match(refused.err, /\(agent-home-differs\)/);
      const starts = s.ledger().filter((x) => x.event === "start");
      assert.equal(starts.length, 1, `${agent}: the other folder never started`);
      assert.deepEqual([starts[0].generation, starts[0].sequence], [GEN[agent], 1], `${agent}: the record names this folder`);
    }
  });


  test("#1208 Codex on the folder the Accounts panel manages: a switch replaces its auth.json, the worker keeps naming that folder", (t) => {
    const s = homeScene(t, cli);
    const shared = privateDir(s.root, "codex-accounts");
    writeFileSync(join(shared, "auth.json"), JSON.stringify({ account: "a" }));
    assert.equal(s.run(["worker", "x", "--branch", "e2e/x", "--agent", "codex", "--agent-home", shared]).code, 0);
    // The panel's switch (am-quota switch.js) replaces auth.json in that same folder.
    writeFileSync(join(shared, "auth.json.tmp"), JSON.stringify({ account: "b" }));
    cpSync(join(shared, "auth.json.tmp"), join(shared, "auth.json"));
    const pane = s.hcState().terminals.find((x) => x.address === "t100");
    assert.equal(chosenHomeOfArgv(pane.argv).home, shared, "the path stays: isolation needs a distinct folder");
    assert.equal(s.ledger().find((x) => x.event === "start").agentHome, shared);
  });

  test("#1208 ledger proof follows the creation time and core for both start and unresolved rows", (t) => {
    for (const event of ["start", "unresolved"]) {
      for (const [core, recorded, actual, proof] of [
        ["fakecore0000", 60, 60, true],
        ["fakecore0000", null, null, true],
        ["fakecore0000", null, 60, false],
        ["fakecore0000", 59, 60, false],
        ["fakecore0000", 60, null, false],
        ["wiped-core", 60, 60, false],
      ]) {
        const s = homeScene(t, cli);
        s.setState((st) => { st.terminals.push({ address: "t60", name: "pending-w", cwd: s.project, state: "live", created_ms: actual,
          labels: {}, argv: ["claude"], foreground: { argv: ["claude"], cwd: s.project } }); });
        const ledger = join(s.app, "automagik-herdr/workers.jsonl");
        mkdirSync(dirname(ledger), { recursive: true });
        writeFileSync(ledger, [
          workerIntent({ launch: LAUNCH, name: "pending-w", project: s.project, worktree: s.project, agent: "claude", agentHome: "/homes/b" }),
          { event, kind: "worker", terminal: "t60", core, created_ms: recorded, launch: LAUNCH, agentHome: "/homes/b" },
        ].map((row) => JSON.stringify(row) + "\n").join(""));
        const r = s.run(["attach", "Genie", "t60", "--move", "--json"], { from: null });
        const context = JSON.stringify({ event, core, recorded, actual, proof, err: r.err });
        if (proof) {
          assert.equal(r.code, 1, context);
          assert.match(r.err, /chosen agent home/);
        } else if (actual === null) {
          assert.equal(r.code, 1, context);
          assert.match(r.err, /gave no created_ms/);
        } else {
          assert.equal(r.code, 0, context);
          assert.equal(r.json().terminal, "t60");
        }
      }
    }
  });

  test("#1208 local attach checks the project app home's worker ledger for the exact pane", (t) => {
    for (const [event, core, created_ms, blocked] of [
      ["start", "fakecore0000", 60, true],
      ["unresolved", "fakecore0000", 60, true],
      ["unresolved", "old-core", 60, false],
      ["unresolved", "fakecore0000", 59, false],
    ]) {
      const s = homeScene(t, cli);
      s.setState((st) => {
        st.terminals[0].labels = {};
        st.terminals.push({ address: "t60", cwd: s.project, state: "live", created_ms: 60, labels: {},
          foreground: { argv: ["claude"], cwd: s.project } });
      });
      const ledger = join(s.project, ".herdr/app-home/automagik-herdr/workers.jsonl");
      mkdirSync(dirname(ledger), { recursive: true });
      writeFileSync(ledger, `${JSON.stringify({ event, kind: "worker", terminal: "t60", core, created_ms,
        launch: LAUNCH, agentHome: "/homes/b" })}\n`, { mode: 0o600 });
      const r = s.run(["attach", "Genie", "t60", "--json"], { from: null, env: { HERDR_APP_HOME: "" } });
      assert.equal(r.code, blocked ? 1 : 0, r.err);
      if (blocked) {
        assert.match(r.err, /t60 .*chosen agent home/);
        assert.equal(s.calls().some(([verb]) => verb === "label"), false);
      } else {
        assert.equal(r.json().terminal, "t60");
      }
    }
  });

  test("#1208 accounts here and fleet refuse a chosen worker's distinct Codex account before writing the cache", (t) => {
    const s = homeScene(t, cli);
    const coreHome = privateDir(s.root, "homes/core"), chosenHome = privateDir(s.root, "homes/chosen");
    writeFileSync(join(coreHome, "auth.json"), auth("core"));
    writeFileSync(join(chosenHome, "auth.json"), auth("chosen"));
    assert.notEqual(fpr("core"), fpr("chosen"));
    const env = { CODEX_HOME: chosenHome, [LAUNCH_VAR]: LAUNCH };
    for (const verb of ["here", "fleet"]) {
      const r = s.run(["accounts", verb, "--json"], { env });
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /Run am accounts from a Bot's pane, not a chosen-home worker/);
      assert.equal(r.out, "");
    }
    const fleet = join(s.app, FLEET_FILE);
    assert.equal(existsSync(fleet), false);
    const normal = s.run(["accounts", "fleet", "--json"], { env: { CODEX_HOME: coreHome } });
    assert.equal(normal.code, 0, normal.err);
    const before = readFileSync(fleet, "utf8");
    assert.equal(JSON.parse(before).machines.local.codex.account, fpr("core"));
    assert.equal(s.run(["accounts", "fleet", "--json"], { env }).code, 1);
    assert.equal(readFileSync(fleet, "utf8"), before);
  });

  test("#1208 a no-home Codex worker started from a chosen worker omits the caller's CODEX_HOME from its row", (t) => {
    const s = homeScene(t, cli);
    const chosenHome = privateDir(s.root, "homes/chosen");
    assert.equal(s.run(["whois", "--bot", BOT, "--json"], { from: null }).json().terminal, "t1");
    // An earlier CLI could leave a chosen worker holding a binding.
    s.setState((st) => { st.terminals[0].argv = afterDashes(chosenArgv("codex", chosenHome)); });
    const env = { CODEX_HOME: chosenHome };
    const inside = s.run(["worker", "x", "--agent", "codex", "--branch", "e2e/inside"], { env: { ...env, [LAUNCH_VAR]: LAUNCH } });
    assert.equal(inside.code, 0, inside.err);
    const outside = s.run(["worker", "x", "--agent", "codex", "--branch", "e2e/outside"], { env });
    assert.equal(outside.code, 0, outside.err);
    assert.deepEqual(s.ledger().map((row) => row.env), [{ HOME: s.home }, { HOME: s.home, CODEX_HOME: chosenHome }]);
    assert.ok(s.runs().every((run) => !afterDashes(run).some((word) => word.startsWith("CODEX_HOME="))));
  });

  test("#1208 a worker on a chosen home is never attached as a Bot's seat; an ordinary argv-less pane still is", (t) => {
    const s = homeScene(t, cli);
    assert.equal(s.run(["worker", "x", "--branch", "e2e/x", "--agent-home", privateDir(s.root, "homes/b")]).code, 0);
    const before = s.calls().length;
    const r = s.run(["attach", "Genie", "t100", "--move"], { from: null });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /t100 is a worker on a chosen agent home; it can't be a Bot's seat/);
    assert.equal(s.calls().slice(before).some((c) => c[0] === "label"), false, "no label written");
    // A pane hc shows no argv for, whose name a launch reserved minutes ago: unresolved, refused too.
    s.setState((st) => { st.terminals.push({ address: "t60", name: "pending-w", cwd: s.project, state: "live", parent: "t1", created_ms: 60, labels: {},
      foreground: { argv: ["claude"], cwd: s.project, pid: 6000 }, status: { app: "claude-code", state: "idle" } }); });
    writeFileSync(join(s.app, "automagik-herdr/workers.jsonl"), `${readFileSync(join(s.app, "automagik-herdr/workers.jsonl"), "utf8")}${JSON.stringify(workerIntent({
      launch: OTHER_LAUNCH, name: "pending-w", project: realpathSync(s.project), worktree: realpathSync(s.project), agent: "claude", agentHome: "/homes/p", at: Date.now() - 60_000 }))}\n`);
    const unresolved = s.run(["attach", "Genie", "t60", "--move"], { from: null });
    assert.equal(unresolved.code, 1, unresolved.err);
    assert.match(unresolved.err, /t60 may be a worker still starting on a chosen agent home/);
    assert.deepEqual(s.ledger().at(-1), { event: "unresolved", terminal: "t60", core: "fakecore0000", created_ms: 60, launch: OTHER_LAUNCH });
    // An old reservation (past ten minutes) proves nothing: the argv-less pane is ordinary, as before.
    s.setState((st) => { st.terminals.push({ address: "t61", name: "old-w", cwd: s.project, state: "live", parent: null, created_ms: 61, labels: {},
      foreground: { argv: ["claude"], cwd: s.project, pid: 6100 }, status: { app: "claude-code", state: "idle" } }); });
    writeFileSync(join(s.app, "automagik-herdr/workers.jsonl"), `${readFileSync(join(s.app, "automagik-herdr/workers.jsonl"), "utf8")}${JSON.stringify(workerIntent({
      launch: LAUNCH, name: "old-w", project: realpathSync(s.project), worktree: realpathSync(s.project), agent: "claude", agentHome: "/homes/p", at: Date.now() - 11 * 60_000 }))}\n`);
    const ordinary = s.run(["attach", "Genie", "t61", "--move", "--json"], { from: null });
    assert.equal(ordinary.code, 0, ordinary.err);
    assert.equal(ordinary.json().terminal, "t61");
  });
}
