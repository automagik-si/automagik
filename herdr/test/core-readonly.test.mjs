// Read-only identity lookup: all programs below are scratch stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { coreStatus } from "../mods/am-sidebar/coreSocket.mjs";
import { scratchProject, scratchRoot, shortSocketDir } from "./scratch-project.mjs";
import { startFakeCore } from "./fake-core.mjs";
import { noCoreEnv } from "./no-core-env.mjs";
import { readJsonLines } from "./log-lines.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE = new URL("./fake-hc.mjs", import.meta.url).pathname;
const HOLDING = new URL("./fake-holding-cli.mjs", import.meta.url).pathname;
const id = "b-aaaaaaaaaa";
const exe = (file, text) => { writeFileSync(file, text); chmodSync(file, 0o755); };
function scene(t) {
  const root = scratchRoot(t, "hc-readonly-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const dir of [bin, home, app]) mkdirSync(dir);
  const project = scratchProject(root, "project", { commit: true, bots: { version: 1, categories: [], bots: [
    { id, name: "lead", kind: "main", agent: "claude", look: { character: "star", colour: "blue" }, role: "", instructions: "" },
  ] } });
  const state = join(root, "hc.json"), log = join(root, "hc.log");
  writeFileSync(state, JSON.stringify({ core: { id: "controller-core" }, terminals: [
    { address: "t1", name: "t1", state: "live", cwd: project, parent: null, created_ms: 1, labels: {}, foreground: { argv: ["claude"], cwd: project } },
  ], next: 100, machines: [] }));
  writeFileSync(log, "");
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, GIT_CEILING_DIRECTORIES: root,
    LOCALDOMAIN: "invalid", TMPDIR: process.env.TMPDIR, HC_FAKE_STATE: state, HC_FAKE_LOG: log,
    HC_SOCKET: "", HC_SESSION: "", HC_TERMINAL_SOCKET: "", HC_TERMINAL_ID: "", XDG_RUNTIME_DIR: join(root, "run"),
    XDG_STATE_HOME: join(root, "state"), AUTOMAGIK_HERDR_TEST_ROOTS: root,
    AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "absent.sock"), AUTOMAGIK_HERDR_TAB_WAIT_MS: "0" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...extra }, encoding: "utf8" });
  return { root, env, project, state, log, run, calls: () => readJsonLines(log) };
}

for (const [name, args, status, calls] of [
  ["whois", ["whois", "t1", "--json"], 1, []],
  ["ls degrades", ["ls", "--json"], 0, []],
  ["start", ["start", id, "--json"], 1, []],
  ["attach", ["attach", id, "t1", "--json"], 1, [["get", "t1", "--json"]]],
  ["revive boot", ["revive", "--boot", "--wait", "1", "--json"], 1, []],
]) {
  test(`no core: ${name} does not run a status client or start a core`, (t) => {
    const s = scene(t);
    const r = s.run(args);
    assert.equal(r.status, status, r.stderr);
    assert.deepEqual(s.calls(), calls, "the entire hc log; attach's preceding get is outside identity lookup");
    if (args[0] === "ls") {
      const bot = JSON.parse(r.stdout).projects[0].bots[0];
      assert.match(bot.hcError, /isn't answering.*nothing was started/);
    } else assert.match(r.stderr, /isn't answering.*[Nn]othing was started/);
    assert.equal(existsSync(s.env.AUTOMAGIK_HERDR_CORE_SOCKET), false);
    assert.equal(existsSync(join(s.env.XDG_RUNTIME_DIR, "herdr-core/default.sock")), false);
  });
}

test("a stale socket inode is refused without invoking hc", async (t) => {
  const s = scene(t), dir = shortSocketDir(t, "hc-stale-");
  const socket = join(dir, "core.sock"), ready = join(dir, "ready");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {createServer} from 'node:net'; import {writeFileSync} from 'node:fs'; createServer().listen(process.argv[1],()=>writeFileSync(process.argv[2],'ready'));`, socket, ready], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const until = Date.now() + 5000;
  while (!existsSync(ready)) {
    if (Date.now() >= until) throw new Error("stale socket fixture did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(existsSync(socket), true, "SIGKILL leaves the bound inode behind");
  const r = s.run(["whois", "t1"], { AUTOMAGIK_HERDR_CORE_SOCKET: socket, AUTOMAGIK_HERDR_TEST_ROOTS: `${s.root}:${dir}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't answering.*nothing was started/);
  assert.deepEqual(s.calls(), []);
});

test("the fake core uses the effective call's PATH, state and log", async (t) => {
  const s = scene(t), core = startFakeCore(t, s.env);
  const other = join(s.root, "other-bin");
  mkdirSync(other);
  exe(join(other, "hc"), "#!/bin/sh\nprintf '%s\\n' 'other status' >> \"$HC_FAKE_LOG\"\nprintf '%s\\n' '{\"core\":{\"id\":\"other\"}}'\n");
  const log = join(s.root, "other.log");
  core.control({ ...s.env, PATH: other, HC_FAKE_LOG: log });
  assert.equal((await coreStatus({ ...s.env, ...core.env })).status.core.id, "other");
  assert.equal(readFileSync(log, "utf8"), "other status\n");
  assert.deepEqual(s.calls(), []);
  core.control(s.env);
  assert.equal((await coreStatus({ ...s.env, ...core.env })).status.core.id, "controller-core");
  assert.deepEqual(s.calls(), [["server", "status", "--json"]]);
});

test("a linked CLI uses its own fake core and never consults the controller socket", (t) => {
  const s = scene(t), core = startFakeCore(t, s.env);
  const app = join(s.root, "holding-app");
  mkdirSync(app);
  const result = spawnSync(process.execPath, [HOLDING, "whois", "t1", "--json"], { cwd: s.project,
    env: { ...s.env, ...core.env, HOLDING_CLI: CLI, HOLDING_APP: app }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).core, "core-of-vm");
  assert.deepEqual(s.calls(), [], "controller fake received no request");
  assert.ok(readJsonLines(`${s.state}.holding.log`).some((args) => args[0] === "server"));
});

test("unavailable hc stand-in allows create and records no status call", (t) => {
  const s = scene(t);
  const env = noCoreEnv(s.root, s.env.PATH);
  const r = s.run(["create", "--name", "New", "--agent", "claude", "--lead", id], env);
  assert.equal(r.status, 0, r.stderr);
  const log = existsSync(env.HC_UNAVAILABLE_LOG) ? readFileSync(env.HC_UNAVAILABLE_LOG, "utf8").trim().split("\n") : [];
  assert.equal(log.some((line) => /^server(?: |$)/.test(line)), false);
});

test("test guard rejects an executable sentinel outside its roots before execution", async (t) => {
  const { main } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
  const root = scratchRoot(t, "hc-guard-"), outside = scratchRoot(t, "hc-sentinel-");
  const ran = join(outside, "ran");
  exe(join(outside, "hc"), `#!/bin/sh\n: > '${ran}'\nprintf '%s\\n' '{"machines":[]}'\n`);
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { HOME: root, HERDR_APP_HOME: join(root, "app"), PATH: outside, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  let stderr = "";
  t.mock.method(process.stderr, "write", (text) => { stderr += text; return true; });
  assert.equal(await main(["doc", "get", "sentinel", "--json"]), 1);
  assert.match(stderr, /test guard: .* is outside AUTOMAGIK_HERDR_TEST_ROOTS; nothing was run\./);
  assert.equal(existsSync(ran), false);
  process.env.PATH = root;
  stderr = "";
  assert.equal(await main(["doc", "get", "missing", "--json"]), 1);
  assert.match(stderr, /hc \(herdr-core\) is not on PATH\./);
});

// The issue's observable: after a command on a path with no core, no new herdr-core process
// exists. Read from /proc (Linux) by each process's own name, never by its argv or socket, so a
// stray core that never bound a socket is still seen; nothing here starts or signals a core.
function herdrCorePids() {
  if (!existsSync("/proc")) return null;
  const pids = new Set();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let comm = "";
    try { comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim(); } catch { continue; }
    if (comm === "herdr-core") pids.add(entry);
  }
  return pids;
}
const newPids = (before, after) => [...after].filter((pid) => !before.has(pid));

test("the herdr-core process detector sees a process by its name alone", { skip: !existsSync("/proc") }, (t) => {
  const root = scratchRoot(t, "hc-detect-");
  // A harmless sleeper named herdr-core: the same name a stray core has, and no socket.
  const named = join(root, "herdr-core");
  copyFileSync("/bin/sleep", named);
  chmodSync(named, 0o755);
  const before = herdrCorePids();
  const child = spawn(named, ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const until = Date.now() + 5000;
  let seen = [];
  while (Date.now() < until && !seen.includes(String(child.pid))) seen = newPids(before, herdrCorePids());
  assert.ok(seen.includes(String(child.pid)), "the detector sees a new process named herdr-core");
});

test("no core on hc's own default path: whois starts nothing, runs no hc, and leaves no new herdr-core process",
  { skip: !existsSync("/proc") }, (t) => {
    const s = scene(t);
    // No socket override: the lookup takes hc's own order (the runtime default, then the state lock),
    // both inside the scratch root; nothing listens there.
    const env = { AUTOMAGIK_HERDR_CORE_SOCKET: "" };
    const before = herdrCorePids();
    const r = s.run(["whois", "t1", "--json"], env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /isn't answering on this computer \(tried [^)]*herdr-core\/default\.sock[^)]*\); nothing was started/);
    assert.deepEqual(s.calls(), [], "no hc call at all: nothing that could start a core");
    assert.equal(existsSync(join(s.env.XDG_RUNTIME_DIR, "herdr-core", "default.sock")), false);
    assert.deepEqual(newPids(before, herdrCorePids()), [], "no new herdr-core process");
  });

test("a core.lock naming a live socket is used when the runtime default is absent", (t) => {
  const s = scene(t), core = startFakeCore(t, s.env);
  const lockDir = join(s.env.XDG_STATE_HOME, "herdr-core", "default");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "core.lock"), `${core.env.AUTOMAGIK_HERDR_CORE_SOCKET}\n`);
  const r = s.run(["whois", "t1", "--json"], { AUTOMAGIK_HERDR_CORE_SOCKET: "",
    AUTOMAGIK_HERDR_TEST_ROOTS: core.env.AUTOMAGIK_HERDR_TEST_ROOTS });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.calls().filter((args) => args[0] === "server"), [["server", "status", "--json"]],
    "the status came from the core that answered (the fake core asks the fake hc), once");
});
