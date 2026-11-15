// agentPath.mjs: the PATH an agent worker starts with when its `#!/usr/bin/env node` (or bun)
// interpreter isn't on the pane's PATH. Fake agents and fake runtimes in temp folders; no real
// codex, node install or Herdr is touched. The last test runs the CLI with the fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOnMachine, besideDirs, envInterpreter, interpreterPath, loginPathAsk, loginPathOf, paneEnvOf, safe } from "../mods/am-sidebar/agentPath.mjs";
import { KILL_GUARD_DIR, workerArgs } from "../mods/am-sidebar/workers.js";
import { withoutBriefing } from "../mods/am-sidebar/models.js";
import { readJsonLines } from "./log-lines.mjs";
// Start and Restart put each bot's briefing in its agent's command (models.js withBriefing);
// the tests on the rest of the command compare it with those words out.
const strip = (words) => withoutBriefing("codex", withoutBriefing("claude", words));
const plain = (argv) => { const i = argv.indexOf("--"); return i < 0 ? strip(argv) : [...argv.slice(0, i + 1), ...strip(argv.slice(i + 1))]; };
// #1125: a Codex run's words without its --add-dir grants (those follow the runner's environment).
const noGrants = (words) => words.filter((w, i) => w !== "--add-dir" && words[i - 1] !== "--add-dir");

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const exe = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); chmodSync(path, 0o755); };
const runtime = (path, version) => exe(path, `#!/bin/sh\necho ${version}\n`);
const NODE_SCRIPT = "#!/usr/bin/env node\nconsole.log('hi');\n";

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-agentpath-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const empty = join(root, "empty");
  mkdirSync(empty);
  const sys = join(root, "sys");
  exe(join(sys, "uname"), "#!/bin/sh\necho Linux\n");
  // No nvm, no Homebrew, no ~/.bun unless a test makes one: the host's runtimes can't answer.
  const env = { HOME: join(root, "home"), NVM_DIR: join(root, "nvm"), AUTOMAGIK_HERDR_RUNTIME_DIRS: "" };
  return { root, empty, sys, env };
}

/** npm's global layout: <prefix>/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js, node beside. */
function npmPrefix(root, { node = "v22.22.0" } = {}) {
  const prefix = join(root, "nvm/versions/node", node);
  exe(join(prefix, "lib/node_modules/@openai/codex/bin/codex.js"), NODE_SCRIPT);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin/codex"));
  runtime(join(prefix, "bin/node"), node);
  return prefix;
}

/** The PATH word workerArgs hands `/usr/bin/env`. */
const pathOf = (path) => {
  const args = workerArgs({ botId: "b-cccccccccc", branch: "feat/x", role: "dev", name: "x", cwd: "/w", parent: "t1",
    agent: "codex", model: null, effort: null, argv: ["codex"], task: "do it", template: null, path });
  const argv = args.slice(args.indexOf("--") + 1);
  assert.equal(argv[0], "/usr/bin/env");
  // #955: a worker of any agent but dsh-tui has the `hc kill` shim first; the rest is the PATH under test.
  assert.ok(argv[1].startsWith(`PATH=${KILL_GUARD_DIR}:`), "the hc kill shim is first on the worker PATH");
  return argv[1].slice(`PATH=${KILL_GUARD_DIR}:`.length);
};

test("envInterpreter: the word env runs, past -S, other flags and VAR=x; null for anything else", () => {
  assert.equal(envInterpreter("#!/usr/bin/env node"), "node");
  assert.equal(envInterpreter("#! /usr/bin/env -S node --no-warnings"), "node");
  assert.equal(envInterpreter("#!/usr/bin/env NODE_OPTIONS=x bun"), "bun");
  assert.equal(envInterpreter("#!/usr/bin/env node\r"), "node", "a CRLF script's line loses its \\r");
  assert.equal(envInterpreter("#!/usr/bin/env -u NODE_OPTIONS node"), "node", "-u takes NAME as its argument");
  assert.equal(envInterpreter("#!/usr/bin/env -i PATH=/x -u FOO bun"), "bun");
  assert.equal(envInterpreter("#!/usr/bin/env -i node\r"), "node");
  assert.equal(envInterpreter("#!/bin/sh"), null);
  assert.equal(envInterpreter("#!/opt/homebrew/bin/node"), null);
  assert.equal(envInterpreter("\u007fELF\u0002"), null);
  assert.equal(envInterpreter(null), null);
});

test("besideDirs: every hop of the link chain, then npm's <prefix>/bin", (t) => {
  const s = scratch(t);
  const prefix = npmPrefix(s.root);
  const links = join(s.root, "links");
  mkdirSync(links);
  symlinkSync(join(prefix, "bin/codex"), join(links, "codex"));
  assert.deepEqual(besideDirs(join(links, "codex")), [links, join(prefix, "bin"), join(prefix, "lib/node_modules/@openai/codex/bin")]);
});

test("node already on the worker's PATH: PATH unchanged, nothing said", (t) => {
  const s = scratch(t);
  const prefix = npmPrefix(s.root);
  runtime(join(s.empty, "node"), "v18.0.0"); // any node env finds will do: env checks no version
  const path = `${join(prefix, "bin")}:${s.empty}`;
  const got = interpreterPath("codex", path, s.env);
  assert.deepEqual(got, { path, note: null });
  assert.equal(pathOf(got.path), path);
});

test("node missing, codex reached through a link to nvm's bin: nvm's bin goes first, nothing removed", (t) => {
  const s = scratch(t);
  const prefix = npmPrefix(s.root);
  const links = join(s.root, "links");
  mkdirSync(links);
  symlinkSync(join(prefix, "bin/codex"), join(links, "codex"));
  const path = `${links}:${s.empty}`;
  const got = interpreterPath("codex", path, s.env);
  assert.equal(got.path, `${join(prefix, "bin")}:${path}`);
  assert.equal(pathOf(got.path), `${join(prefix, "bin")}:${path}`);
  assert.equal(got.note, `codex runs under node, which isn't on its PATH: ${join(prefix, "bin")} put first on it.`);
});

test("node missing and not beside the agent: run.sh's order, nvm's newest 22.7+ before Homebrew's", (t) => {
  const s = scratch(t);
  const agents = join(s.root, "agents");
  exe(join(agents, "codex"), NODE_SCRIPT);
  const nvm = (v) => runtime(join(s.env.NVM_DIR, "versions/node", v, "bin/node"), v);
  nvm("v22.6.0"); nvm("v24.1.0"); nvm("v22.10.0");
  const brew = join(s.root, "brew");
  runtime(join(brew, "node"), "v25.0.0");
  const env = { ...s.env, AUTOMAGIK_HERDR_RUNTIME_DIRS: brew };
  assert.equal(pathOf(interpreterPath("codex", agents, env).path), `${join(s.env.NVM_DIR, "versions/node/v24.1.0/bin")}:${agents}`);
  rmSync(s.env.NVM_DIR, { recursive: true });
  assert.equal(pathOf(interpreterPath("codex", agents, env).path), `${brew}:${agents}`);
  runtime(join(brew, "node"), "v22.6.0"); // too old: run.sh passes it over, and so does this
  const none = interpreterPath("codex", agents, env);
  assert.equal(none.path, agents);
  assert.match(none.note, /codex runs under node .* may fail with "env: node: No such file or directory"/);
});

test("bun: a #!/usr/bin/env bun agent gets ~/.bun/bin; bun alone never stands in for node", (t) => {
  const s = scratch(t);
  const agents = join(s.root, "agents");
  exe(join(agents, "omp"), "#!/usr/bin/env bun\n");
  exe(join(agents, "codex"), NODE_SCRIPT);
  runtime(join(s.env.HOME, ".bun/bin/bun"), "1.2.3");
  assert.equal(interpreterPath("omp", agents, s.env).path, `${join(s.env.HOME, ".bun/bin")}:${agents}`);
  assert.equal(interpreterPath("codex", agents, s.env).path, agents);
});

/** A fake runtime that leaves `<path>.ran` behind when it is run. */
const tattler = (path, version) => exe(path, `#!/bin/sh\n: > "${path}.ran"\necho ${version}\n`);

test("an unsafe folder or interpreter (world-writable) is neither run nor put on PATH", (t) => {
  const s = scratch(t);
  // codex and a node side by side in a 0777 folder, reached through a link in a safe PATH
  // folder: the node there is never run.
  const open = join(s.root, "open");
  exe(join(open, "codex"), NODE_SCRIPT);
  tattler(join(open, "node"), "v24.1.0");
  chmodSync(open, 0o777);
  const links = join(s.root, "links");
  mkdirSync(links);
  symlinkSync(join(open, "codex"), join(links, "codex"));
  // A 0777 node file in a safe nvm folder, and a 0777 Homebrew folder: passed over too.
  const nvmBin = join(s.env.NVM_DIR, "versions/node/v24.1.0/bin");
  tattler(join(nvmBin, "node"), "v24.1.0");
  chmodSync(join(nvmBin, "node"), 0o777);
  const brew = join(s.root, "brew");
  tattler(join(brew, "node"), "v24.1.0");
  chmodSync(brew, 0o777);
  const got = interpreterPath("codex", links, { ...s.env, AUTOMAGIK_HERDR_RUNTIME_DIRS: brew });
  assert.equal(got.path, links);
  assert.match(got.note, /may fail/);
  for (const p of [join(open, "node"), join(nvmBin, "node"), join(brew, "node")]) assert.equal(existsSync(`${p}.ran`), false, `${p} was run`);
  // The same folder made safe: its node is run and put first.
  chmodSync(open, 0o755);
  assert.equal(interpreterPath("codex", links, s.env).path, `${open}:${links}`);
  assert.equal(existsSync(join(open, "node.ran")), true);
});

test("safe() checks the real file and every folder above it: links out and open parents are refused", (t) => {
  const s = scratch(t);
  // A safe bin/node that links to a 0755 node inside a 0777 folder: neither run nor put first.
  const pkg = join(s.root, "pkg");
  exe(join(pkg, "codex.js"), NODE_SCRIPT);
  const bin = join(s.root, "bin");
  mkdirSync(bin);
  symlinkSync(join(pkg, "codex.js"), join(bin, "codex"));
  const ww = join(s.root, "ww");
  tattler(join(ww, "node"), "v24.1.0");
  chmodSync(ww, 0o777);
  symlinkSync(join(ww, "node"), join(bin, "node"));
  const pane = join(s.root, "pane");
  mkdirSync(pane);
  symlinkSync(join(bin, "codex"), join(pane, "codex"));
  assert.equal(safe(bin), true);
  assert.equal(safe(join(bin, "node")), false, "the link's real file sits in a 0777 folder");
  assert.equal(interpreterPath("codex", pane, s.env).path, pane);
  assert.equal(existsSync(join(ww, "node.ran")), false);
  // A 0755 bin inside a 0777 parent that isn't sticky, and inside a sticky 01777 parent this
  // user (not root) owns: both refused.
  for (const [name, mode] of [["open-parent", 0o777], ["user-sticky", 0o1777]]) {
    const parent = join(s.root, name);
    tattler(join(parent, "bin/node"), "v24.1.0");
    chmodSync(parent, mode);
    const got = interpreterPath("codex", pane, { ...s.env, AUTOMAGIK_HERDR_RUNTIME_DIRS: join(parent, "bin") });
    assert.equal(got.path, pane, name);
    assert.equal(existsSync(join(parent, "bin/node.ran")), false, `${name}: its node was run`);
  }
});

test("a root-owned sticky folder like /tmp passes: a safe node under it is run and put first", (t) => {
  const st = statSync(realpathSync("/tmp"));
  if (st.uid !== 0 || !(st.mode & 0o1000)) return t.skip("/tmp here isn't a root-owned sticky folder");
  const s = scratch(t);
  assert.equal(safe("/tmp"), true);
  const under = mkdtempSync("/tmp/hb-agentpath-");
  t.after(() => rmSync(under, { recursive: true, force: true }));
  chmodSync(under, 0o755);
  tattler(join(under, "bin/node"), "v24.1.0");
  const agents = join(s.root, "agents");
  exe(join(agents, "codex"), NODE_SCRIPT);
  const got = interpreterPath("codex", agents, { ...s.env, AUTOMAGIK_HERDR_RUNTIME_DIRS: join(under, "bin") });
  assert.equal(got.path, `${join(under, "bin")}:${agents}`);
  assert.equal(existsSync(join(under, "bin/node.ran")), true);
});

test("relative folders are never run or put on PATH: PATH entries, NVM_DIR, AUTOMAGIK_HERDR_RUNTIME_DIRS", (t) => {
  const s = scratch(t);
  const was = process.cwd();
  process.chdir(s.root);
  t.after(() => process.chdir(was));
  exe(join(s.root, "rel/codex"), NODE_SCRIPT);
  tattler(join(s.root, "rel/node"), "v24.1.0");
  tattler(join(s.root, "relnvm/versions/node/v24.1.0/bin/node"), "v24.1.0");
  tattler(join(s.root, "relbrew/node"), "v24.1.0");
  const env = { ...s.env, NVM_DIR: "relnvm", AUTOMAGIK_HERDR_RUNTIME_DIRS: "relbrew:." };
  // The agent only on a relative PATH entry: the CLI can't tell what the worker's cwd finds.
  assert.deepEqual(interpreterPath("codex", "rel:.", env), { path: "rel:.", note: null });
  assert.deepEqual(interpreterPath("./rel/codex", s.empty, env), { path: s.empty, note: null });
  // The agent on an absolute entry, node only in relative folders: nothing put first.
  const agents = join(s.root, "agents");
  exe(join(agents, "codex"), NODE_SCRIPT);
  const got = interpreterPath("codex", `${agents}:rel:.`, env);
  assert.equal(got.path, `${agents}:rel:.`);
  assert.match(got.note, /may fail/);
  for (const p of ["rel/node", "relnvm/versions/node/v24.1.0/bin/node", "relbrew/node"]) {
    assert.equal(existsSync(join(s.root, `${p}.ran`)), false, `${p} was run`);
  }
});

test("a binary, a #!/bin/sh script or an agent not on PATH: PATH unchanged, nothing said", (t) => {
  const s = scratch(t);
  exe(join(s.empty, "claude"), "\u007fELF\u0002\u0001\u0001");
  exe(join(s.empty, "agy"), "#!/bin/sh\nexit 0\n");
  for (const program of ["claude", "agy", "codex"]) assert.deepEqual(interpreterPath(program, s.empty, s.env), { path: s.empty, note: null });
});

/**
 * A scratch project for the CLI: codex on PATH only as a link into a fake nvm prefix (node beside
 * it, nowhere on PATH), the fake hc, git, and a live t1 playing Dev. `extra` bots join the file.
 */
function codexProject(t, extra = [], { terminals = [], env: more = {} } = {}) {
  const s = scratch(t);
  const prefix = npmPrefix(s.root);
  const bin = join(s.root, "bin");
  mkdirSync(bin);
  symlinkSync(join(prefix, "bin/codex"), join(bin, "codex"));
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const project = join(s.root, "proj");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: project, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  const look = { character: "star", colour: "blue" };
  writeFileSync(join(project, ".herdr/bots.json"), JSON.stringify({ version: 1, categories: [], bots: [
    { id: "b-aaaaaaaaaa", name: "Genie", kind: "main", look, role: "r", instructions: "i", agent: "claude" },
    { id: "b-cccccccccc", name: "Dev", kind: "member", look, role: "r", instructions: "i", agent: "claude", worker: { agent: "codex" } },
    ...extra.map((b) => ({ look, role: "r", instructions: "i", ...b })),
  ] }));
  const app = join(s.root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  const state = join(s.root, "hc.json");
  const log = join(s.root, "hc.log");
  writeFileSync(state, JSON.stringify({ next: 100, templates: [], terminals: [{ address: "t1", name: "t1", cwd: project, state: "live",
    parent: null, created_ms: 1, labels: { bot: "b-cccccccccc" }, foreground: { argv: ["claude"], cwd: project, pid: 4000 },
    status: { app: "claude-code", state: "idle" } }, ...terminals] }));
  writeFileSync(log, "");
  const path = `${bin}:${s.empty}`;
  const env = { ...s.env, PATH: path, HERDR_APP_HOME: app, HC_FAKE_STATE: state, HC_FAKE_LOG: log, HC_TERMINAL_ID: "t1", ...more };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
  const run = () => readJsonLines(log).find((c) => c[0] === "run");
  return { s, prefix, path, app, cli, run };
}

test("worker CLI: a codex the pane reaches without node starts under env PATH=<nvm bin>:<pane PATH>, and says so", (t) => {
  const { prefix, path, cli, run: runCall } = codexProject(t);
  const r = cli("worker", "fix it", "--branch", "feat/x");
  assert.equal(r.status, 0, r.stderr);
  const run = runCall();
  assert.deepEqual(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 4), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:${join(prefix, "bin")}:${path}:/usr/bin:/bin`, "codex"]);
  assert.match(r.stderr, new RegExp(`am: codex runs under node, which isn't on its PATH: ${join(prefix, "bin")} put first on it\\.`));
});

test("start CLI (#56): a codex bot whose node is only in nvm starts under env PATH=<nvm bin>:<PATH>, and the command runs", (t) => {
  const { prefix, path, app, cli, run: runCall } = codexProject(t, [{ id: "b-dddddddddd", name: "Maint", kind: "member", agent: "codex" }]);
  const r = cli("start", "Maint", "--json");
  assert.equal(r.status, 0, r.stderr);
  const run = runCall();
  const argv = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(noGrants(plain(argv)), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:${join(prefix, "bin")}:${path}:/usr/bin:/bin`, `HERDR_APP_HOME=${app}`, "codex", "--approve-for-me", "--disable", "hooks", "--no-daemon", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.match(argv[4], /^-c$/);
  assert.match(argv[5], /^developer_instructions="<herdr-bot>\\nAutomagik Herdr briefing/, "codex takes it as a TOML string");
  assert.deepEqual(noGrants(plain(JSON.parse(r.stdout).argv)), ["codex", "--approve-for-me", "--disable", "hooks", "--no-daemon", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.match(r.stderr, new RegExp(`am: codex runs under node, which isn't on its PATH: ${join(prefix, "bin")} put first on it\\.`));
  // The seat's command as hc would run it: with the caller's PATH alone, env finds no node (127); as started, it runs.
  const bare = spawnSync("codex", [], { env: { PATH: path }, encoding: "utf8" });
  assert.equal(bare.status, 127, bare.stderr);
  const seat = spawnSync(argv[0], argv.slice(1), { env: {}, encoding: "utf8" });
  assert.equal(seat.status, 0, seat.stderr);
});

test("restart CLI (#56): restarting a codex bot whose node is only in nvm runs under env PATH=<nvm bin>:<PATH>, not into 127", (t) => {
  const old = { address: "t7", name: "maint", cwd: "", state: "live", parent: null, created_ms: 1, labels: { bot: "b-dddddddddd" },
    foreground: { argv: ["codex"], cwd: "", pid: 4100 }, status: { app: "codex", state: "idle" } };
  const { prefix, path, app, cli, run: runCall } = codexProject(t, [{ id: "b-dddddddddd", name: "Maint", kind: "member", agent: "codex" }],
    { terminals: [old], env: { AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300" } });
  const r = cli("restart", "Maint", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).replaced, "t7");
  const run = runCall();
  const argv = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(noGrants(plain(argv)), ["/usr/bin/env", `PATH=${KILL_GUARD_DIR}:${join(prefix, "bin")}:${path}:/usr/bin:/bin`, `HERDR_APP_HOME=${app}`, "codex", "--approve-for-me", "--disable", "hooks", "--no-daemon", "-c", "sandbox_workspace_write.network_access=true", "resume", "--last"]);
  assert.ok(argv.findIndex((w) => w.startsWith("developer_instructions=")) < argv.indexOf("resume"), "its -c before the subcommand");
  assert.equal(argv.filter((w) => w.startsWith("developer_instructions=")).length, 1, "never twice after a restart");
  const seat = spawnSync(argv[0], argv.slice(1), { env: {}, encoding: "utf8" });
  assert.equal(seat.status, 0, seat.stderr);
});

// ---- an agent on a linked machine (#425): the real sh scripts, here, with a stand-in login shell ----

const LOGIN = new URL("./fake-login-shell", import.meta.url).pathname;
/** agentOnMachine's exec, as hc exec runs a program there: a service's PATH (login.hc comes first on it), the machine's HOME. */
const service = (s, login = {}) => async (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", env: { HOME: s.env.HOME, PATH: `${login.hc ? `${login.hc}:` : ""}${s.sys}:/usr/bin:/bin`, SHELL: LOGIN,
    FAKE_LOGIN_PATH: login.path ?? "", FAKE_LOGIN_NOISE: login.noise ?? "", FAKE_LOGIN_EXIT: login.exit ?? "" } });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

test("loginPathOf: this call's markers only, the last pair, one line, absolute folders once each", () => {
  const said = (p) => "m-from" + p + "\nm-to";
  assert.equal(loginPathOf("Welcome\n" + said("/a:/b"), "m"), "/a:/b");
  assert.equal(loginPathOf(said("/old") + "\n" + said("/a"), "m"), "/a", "a profile that echoed one earlier");
  assert.equal(loginPathOf(said("/a:rel:.:~/x::/a:/b"), "m"), "/a:/b");
  assert.equal(loginPathOf(said("/a\nrm -rf /"), "m"), null, "two lines are no PATH");
  assert.equal(loginPathOf(said("rel:."), "m"), null);
  assert.equal(loginPathOf(said("/" + "a".repeat(20000)), "m"), null);
  assert.equal(loginPathOf("m-from/a", "m"), null);
  assert.equal(loginPathOf("no markers", "m"), null);
  assert.equal(loginPathOf(said("/a"), "other"), null);
  assert.equal(loginPathOf(undefined, "m"), null);
});

test("loginPathAsk reads PATH through /usr/bin/env, which a NixOS-like system has, and never /usr/bin/printenv", () => {
  assert.match(loginPathAsk("m"), /\/usr\/bin\/env printenv PATH/);
  assert.doesNotMatch(loginPathAsk("m"), /\/usr\/bin\/printenv/);
});

test("agentOnMachine: an agent hc's PATH doesn't find gets the login shell's PATH first, hc's and the user folders after, nothing lost", async (t) => {
  const s = scratch(t);
  const tools = join(s.root, "tools");
  exe(join(tools, "codex"), "#!/bin/sh\n");
  mkdirSync(join(s.env.HOME, ".local/bin"), { recursive: true });
  const got = await agentOnMachine(service(s, { path: tools + ":/usr/bin:/bin" }), "codex");
  assert.deepEqual(got, { state: "found", path: [tools, "/usr/bin", "/bin", s.sys, join(s.env.HOME, ".local/bin")].join(":"), file: join(tools, "codex"), login: true });
});

/** Which fakenode a PATH runs an agent under: what really runs, not what the check says. */
const runs = (path, agent) => spawnSync("/usr/bin/env", ["PATH=" + path, agent], { env: {}, encoding: "utf8" });

test("agentOnMachine: hc's PATH finds the agent and the login shell's shadows it with a broken copy: hc's copy, never a refusal", async (t) => {
  const s = scratch(t);
  const hc = join(s.root, "hc-bin"), login = join(s.root, "login-bin");
  exe(join(hc, "codex"), "#!/bin/sh\necho hc copy\n");
  exe(join(login, "codex"), "#!/usr/bin/env no-such-runtime\n");
  const got = await agentOnMachine(service(s, { hc, path: login + ":/usr/bin:/bin" }), "codex");
  assert.deepEqual(got, { state: "found", path: [hc, s.sys, "/usr/bin", "/bin", login].join(":"), file: join(hc, "codex"), login: true });
  assert.equal(runs(got.path, "codex").stdout, "hc copy\n");
});

test("agentOnMachine: hc's PATH finds the agent and its interpreter and the login shell's shadows the interpreter: hc's runs, never a dead launch", async (t) => {
  const s = scratch(t);
  const hc = join(s.root, "hc-bin"), login = join(s.root, "login-bin");
  exe(join(hc, "codex"), "#!/usr/bin/env fakenode\n");
  exe(join(hc, "fakenode"), "#!/bin/sh\necho hc interpreter\n");
  exe(join(login, "fakenode"), "#!/bin/sh\nexit 1\n");
  const got = await agentOnMachine(service(s, { hc, path: login + ":/usr/bin:/bin" }), "codex");
  assert.deepEqual([got.state, got.file], ["found", join(hc, "codex")]);
  const ran = runs(got.path, "codex");
  assert.deepEqual([ran.status, ran.stdout], [0, "hc interpreter\n"]);
});

test("agentOnMachine: an agent only the login shell finds stays login-first, so its interpreter wins over hc's", async (t) => {
  const s = scratch(t);
  const hc = join(s.root, "hc-bin"), login = join(s.root, "login-bin");
  exe(join(hc, "fakenode"), "#!/bin/sh\necho hc interpreter\n");
  exe(join(login, "codex"), "#!/usr/bin/env fakenode\n");
  exe(join(login, "fakenode"), "#!/bin/sh\necho login interpreter\n");
  const got = await agentOnMachine(service(s, { hc, path: login + ":/usr/bin:/bin" }), "codex");
  assert.deepEqual(got, { state: "found", path: [login, "/usr/bin", "/bin", hc, s.sys].join(":"), file: join(login, "codex"), login: true });
  assert.equal(runs(got.path, "codex").stdout, "login interpreter\n");
});

test("agentOnMachine: an absolute agent hc can run keeps hc's PATH first; a login folder after it stays one word, never evaluated", async (t) => {
  const s = scratch(t);
  const hc = join(s.root, "hc-bin"), canary = join(s.root, "ran");
  const odd = join(s.root, "a b$(touch " + canary.replaceAll("/", "_") + ")");
  mkdirSync(odd, { recursive: true });
  exe(join(s.root, "own/codex"), "#!/bin/sh\n");
  const got = await agentOnMachine(service(s, { hc, path: odd + ":/usr/bin:/bin" }), join(s.root, "own/codex"));
  assert.equal(got.state, "found");
  assert.deepEqual(got.path.split(":").slice(0, 5), [hc, s.sys, "/usr/bin", "/bin", odd]);
  assert.equal(existsSync(canary), false);
});

test("agentOnMachine: npm's layout reached through a link puts <prefix>/bin on the PATH, so its node is found", async (t) => {
  const s = scratch(t);
  const prefix = npmPrefix(s.root);
  const links = join(s.env.HOME, ".local/bin");
  mkdirSync(links, { recursive: true });
  symlinkSync(join(prefix, "bin/codex"), join(links, "codex"));
  const got = await agentOnMachine(service(s, { exit: "1" }), "codex");
  assert.deepEqual([got.state, got.login], ["found", false]);
  assert.ok(got.path.split(":").includes(join(prefix, "bin")), got.path);
  assert.equal(spawnSync("/usr/bin/env", ["PATH=" + got.path, "sh", "-c", 'command -v node'], { encoding: "utf8" }).stdout.trim(), join(prefix, "bin/node"));
});

test("agentOnMachine: a name and a PATH are data: nothing in them is ever evaluated", async (t) => {
  const s = scratch(t);
  const canary = join(s.root, "ran");
  const evil = "x$(touch " + canary + ")";
  const odd = join(s.root, "a b$(touch " + canary.replaceAll("/", "_") + ")");
  exe(join(odd, "codex"), "#!/bin/sh\n");
  const ran = await agentOnMachine(service(s, { path: odd + ":/usr/bin:/bin" }), "codex");
  assert.deepEqual([ran.state, ran.file], ["found", join(odd, "codex")]);
  assert.deepEqual(await agentOnMachine(service(s), evil), { state: "missing", login: true });
  assert.deepEqual(await agentOnMachine(service(s), "`touch " + canary + "`"), { state: "missing", login: true });
  assert.deepEqual(await agentOnMachine(service(s), "true"), { state: "missing", login: true }, "a shell builtin is no agent");
  assert.equal(existsSync(canary), false);
});

test("agentOnMachine: no answer is away, a timed-out login shell is not, and the interpreter is checked on the same PATH", async (t) => {
  const s = scratch(t);
  const away = async () => ({ code: -1, stdout: "", stderr: "hc: vm stopped answering" });
  assert.deepEqual(await agentOnMachine(away, "codex"), { state: "away", why: "hc: vm stopped answering" });
  const calls = [];
  const slow = async (command, args, o) => { calls.push(o.timeout); return calls.length === 1 ? { code: -1, stdout: "", stderr: "timed out after 7 s" } : service(s)(command, args); };
  assert.deepEqual(await agentOnMachine(slow, "no-such-agent", { wait: 7 }), { state: "missing", login: "timed out" });
  assert.deepEqual(calls, [7, 7]);
  // A profile that kills its own shell: hc answers with no exit code, and the machine is still there.
  let asks = 0;
  const killed = async (command, args) => (asks++ === 0 ? { code: -1, stdout: "", stderr: "" } : service(s)(command, args));
  assert.deepEqual(await agentOnMachine(killed, "no-such-agent"), { state: "missing", login: false });
  exe(join(s.env.HOME, ".bun/bin/omp"), "#!/usr/bin/env bun\n");
  assert.deepEqual(await agentOnMachine(service(s), "omp"), { state: "no-interpreter", file: join(s.env.HOME, ".bun/bin/omp"), interpreter: "bun", login: true });
  assert.equal((await agentOnMachine(service(s, { exit: "1" }), "omp")).login, false);
  runtime(join(s.env.HOME, ".bun/bin/bun"), "1.2.3");
  assert.equal((await agentOnMachine(service(s), "omp")).state, "found");
});

// ---- a project's pane-env on a linked machine (#582): two keys, absolute folders, all or nothing ----

test("paneEnvOf: PATH_PREPEND and HERDR_APP_HOME, absolute folders; blank lines and # comments skipped; no file is nothing", () => {
  const none = { prepend: null, appHome: null, error: null };
  assert.deepEqual(paneEnvOf(null), none);
  assert.deepEqual(paneEnvOf(""), none);
  assert.deepEqual(paneEnvOf("PATH_PREPEND=/opt/node-22/bin:/opt/tools/bin\nHERDR_APP_HOME=/srv/bots/herdr-app/\n"),
    { prepend: "/opt/node-22/bin:/opt/tools/bin", appHome: "/srv/bots/herdr-app", error: null });
  assert.deepEqual(paneEnvOf("# our team's runtime\r\n\r\nPATH_PREPEND=/opt/node-22/bin/\r\n"), { prepend: "/opt/node-22/bin", appHome: null, error: null });
  assert.deepEqual(paneEnvOf("HERDR_APP_HOME=/srv/a b"), { prepend: null, appHome: "/srv/a b", error: null }, "a space is data: one argv word");
});

test("paneEnvOf: another key, a relative path, a key twice or a line that isn't KEY=value refuses the whole file, with why", () => {
  const refused = (text, why) => {
    const got = paneEnvOf(text);
    assert.deepEqual([got.prepend, got.appHome], [null, null], text);
    assert.match(got.error, why, text);
  };
  refused("PATH_PREPEND=/opt/node-22/bin\nLD_PRELOAD=/tmp/x.so\n", /line 2: LD_PRELOAD isn't a key pane-env takes \(PATH_PREPEND, HERDR_APP_HOME\)/);
  refused("PATH=/opt/node-22/bin", /PATH isn't a key/);
  refused("PATH_PREPEND=/opt/node-22/bin:node_modules/.bin", /line 1: PATH_PREPEND: "node_modules\/\.bin" isn't an absolute folder/);
  refused("PATH_PREPEND=", /PATH_PREPEND: "" isn't an absolute folder/);
  refused("PATH_PREPEND=/a::/b", /PATH_PREPEND: "" isn't an absolute folder/);
  refused("HERDR_APP_HOME=~/herdr-app", /line 1: HERDR_APP_HOME: "~\/herdr-app" isn't an absolute folder/);
  refused("HERDR_APP_HOME=/a\nHERDR_APP_HOME=/b", /line 2: HERDR_APP_HOME is set twice/);
  refused("export PATH_PREPEND=/a", /export PATH_PREPEND isn't a key/);
  refused("PATH_PREPEND /a", /line 1: "PATH_PREPEND \/a" isn't KEY=value/);
  // A space at a value's start or end would make a folder of that name there (review F3).
  refused("HERDR_APP_HOME=/srv/app ", /line 1: HERDR_APP_HOME: "\/srv\/app " has a space at its start or end/);
  refused("HERDR_APP_HOME= /srv/app", /HERDR_APP_HOME: " \/srv\/app" has a space at its start or end/);
  refused("PATH_PREPEND=/opt/a:/opt/b :/opt/c", /PATH_PREPEND: "\/opt\/b " has a space at its start or end/);
  refused("\ufeffPATH_PREPEND=/opt/a", /isn't a key pane-env takes/);
  refused("HERDR_APP_HOME=/a\u0007", /line 1: a control character/);
  refused(`${"X".repeat(500)}`, /isn't KEY=value/);
  assert.ok(paneEnvOf("X".repeat(500)).error.length < 200, "a long line is cut short in the warning");
});

test("agentOnMachine: PATH_PREPEND's folders come first, so the agent and its interpreter are found there; none given, as before", async (t) => {
  const s = scratch(t);
  const pre = join(s.root, "pre-bin"), hc = join(s.root, "hc-bin");
  exe(join(hc, "claude"), "#!/usr/bin/env fakenode\n");
  exe(join(hc, "fakenode"), "#!/bin/sh\necho hc node\n");
  exe(join(pre, "fakenode"), "#!/bin/sh\necho chosen node\n");
  const before = await agentOnMachine(service(s, { hc }), "claude");
  assert.deepEqual(before, await agentOnMachine(service(s, { hc }), "claude", { prepend: null }), "no prepend: the same answer");
  assert.equal(runs(before.path, "claude").stdout, "hc node\n");
  const got = await agentOnMachine(service(s, { hc }), "claude", { prepend: `${pre}:/usr/bin` });
  assert.deepEqual(got.path.split(":").slice(0, 3), [pre, "/usr/bin", hc]);
  assert.equal(got.state, "found");
  assert.equal(runs(got.path, "claude").stdout, "chosen node\n");
  // Only there: the interpreter check runs on that PATH, so a node only the prepend has is enough.
  rmSync(join(hc, "fakenode"));
  assert.equal((await agentOnMachine(service(s, { hc }), "claude")).state, "no-interpreter");
  assert.equal((await agentOnMachine(service(s, { hc }), "claude", { prepend: pre })).state, "found");
});

test("AGENT_PATH_SH: PATH_PREPEND folders with spaces, $, backticks and quotes are one word each, never evaluated", async (t) => {
  const s = scratch(t);
  const canary = join(s.root, "ran");
  const odd = join(s.root, `a b $HOME \`touch ${canary}\` $(touch ${canary}) 'q' "d"`);
  const hc = join(s.root, "hc-bin");
  exe(join(hc, "claude"), "#!/usr/bin/env fakenode\n");
  exe(join(odd, "fakenode"), "#!/bin/sh\necho odd node\n");
  const got = await agentOnMachine(service(s, { hc }), "claude", { prepend: odd });
  assert.equal(got.state, "found");
  assert.equal(got.path.split(":")[0], odd, "the folder as it is, first");
  assert.equal(runs(got.path, "claude").stdout, "odd node\n");
  assert.equal(existsSync(canary), false, "nothing in it ran");
});

test("agentOnMachine (#1033): on Darwin, failing security show-keychain-info returns no-keychain; exit 0 returns found", async (t) => {
  const s = scratch(t);
  const hc = join(s.root, "hc-bin");
  const denied = "security: SecKeychainCopySettings <NULL>: User interaction is not allowed.";
  exe(join(hc, "codex"), "#!/bin/sh\n");
  exe(join(hc, "uname"), "#!/bin/sh\necho Darwin\n");
  exe(join(hc, "security"), `#!/bin/sh\nif [ "$1" = show-keychain-info ]; then\n  echo "${denied}" >&2\n  exit 36\nfi\nexit 2\n`);
  assert.deepEqual(await agentOnMachine(service(s, { hc }), "codex"), {
    state: "no-keychain",
    detail: denied,
    login: true,
  });
  assert.deepEqual(await agentOnMachine(service(s, { hc, exit: "1" }), "codex"), {
    state: "no-keychain",
    detail: denied,
    login: false,
  });
  exe(join(hc, "security"), '#!/bin/sh\n[ "$1" = show-keychain-info ] && exit 0\nexit 2\n');
  assert.deepEqual(await agentOnMachine(service(s, { hc }), "codex"), {
    state: "found",
    path: [hc, s.sys, "/usr/bin", "/bin"].join(":"),
    file: join(hc, "codex"),
    login: true,
  });
});
