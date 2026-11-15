// The per-pane hc proxy (#631 PR A): every row the brief asks for, against a fake herdr-core
// 0.1.14 over a scratch Unix socket. Hermetic: temp app home, project, worktree and runtime
// folder; no real core, no pane, no socket from the host. The proxy is imported and started
// in-process (one row spawns its CLI), and the fake records what actually reached the core.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { HC_PIN, MAX_CONNECTIONS, MAX_READ_LINES, MAX_REPLY_BYTES, METHOD_PARAMS, runProblem, socketPathLimit, startProxy } from "../mods/am-sidebar/hcProxy.mjs";
import { approveProject, approvedSettingsDir, recordFileOf, sha256Of } from "../mods/am-sidebar/approved.js";
import { ENV, GUARD_DIR, KILL_GUARD_DIR, WORKER_OF_LABEL, stableGuardDir, stableHelper, stableKillDir, stableRootOf, stableRunner, templateAgent, workerArgs, workerPlan } from "../mods/am-sidebar/workers.js";
import { stableRootProblem, stableRunnerText } from "../mods/am-sidebar/dshTui.mjs";
import { commandArgv } from "../mods/am-sidebar/restart.js";
import { agySettingsArgs, agySettingsFile } from "../mods/am-sidebar/models.js";
import { startFakeCore } from "./fake-hc-core.mjs";
import { shortSocketDir } from "./scratch-project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROXY = join(here, "..", "mods", "am-sidebar", "hcProxy.mjs");
const PROXY_HARNESS = join(here, "cli-proxy-harness.mjs");
/** A path under literal /tmp (real path, so macOS /private/tmp works), never created. */
const literalTmpData = () => join(realpathSync("/tmp"), `am-hc-literal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, "data");

const ID = {
  main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", jun: "b-dddddddddd",
  rev: "b-eeeeeeeeee", fix: "b-ffffffffff", other: "b-gggggggggg", pm: "b-hhhhhhhhhh",
};
const bot = (id, kind, extra = {}) => ({
  id, name: id, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i",
  agent: "dsh-tui", ...extra,
});
const team = () => ({
  version: 1,
  categories: [],
  bots: [
    bot(ID.main, "main", { name: "Main" }),
    bot(ID.cap, "member", { name: "Captain", rank: "captain" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.jun, "member", { name: "Junior", lead: ID.dev }),
    bot(ID.rev, "member", { name: "Reviewer", lead: ID.main, rank: "reviewer" }),
    bot(ID.fix, "member", { name: "Fixer", lead: ID.main, rank: "fixer" }),
    bot(ID.other, "member", { name: "Other", lead: ID.main }),
    bot(ID.pm, "member", { name: "PM", lead: ID.main, rank: "pm" }),
  ],
});

/** One scene: temp app home + ledger, project + bots.json, a worktree and the runtime folder. */
function scene() {
  const root = shortSocketDir(null, "hcp-");
  const app = join(root, "app"), project = join(root, "project"), home = join(root, "home"), runtime = join(root, "run");
  const worktree = join(project, ".claude", "worktrees", "wt");
  const bin = join(root, "bin");
  for (const dir of [app, join(app, "automagik-herdr"), project, join(project, ".herdr"), worktree, home, runtime, bin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileSync(join(bin, "dsh-tui"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "dsh-tui"), 0o755);
  // The installed shim lives under HOME/.local/bin; the worker PATH resolves dsh-tui there.
  const shimDir = join(home, ".local", "bin");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "dsh-tui"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(shimDir, "dsh-tui"), 0o755);
  const paneTmp = join(root, "pane-tmp");
  mkdirSync(paneTmp, { recursive: true });
  const stableRoot = join(home, ".local", "share", "automagik-herdr", "dsh-sandbox");
  const stableGuard = stableGuardDir(stableRoot);
  for (const dir of [stableGuard, join(stableRoot, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stableRoot, "hcPane.mjs"), "// stable helper\n");
  writeFileSync(join(stableRoot, "bin", "run.sh"), stableRunnerText(process.execPath), { mode: 0o755 });
  writeFileSync(join(project, ".herdr", "bots.json"), `${JSON.stringify(team(), null, 2)}\n`);
  const ledger = join(app, "automagik-herdr", "attach.jsonl");
  writeFileSync(ledger, `${JSON.stringify({
    v: 1, event: "attach", bot: ID.dev, project, terminal: "t100", core: "fake-core",
    created_ms: 100, machine: null, at: "2026-11-01T00:00:00.000Z", by: "start",
  })}\n`);
  chmodSync(ledger, 0o600);
  const rec = (address, labels, extra = {}) => ({
    address, name: address, agent: "dsh-tui", cwd: project, state: "live", status: "working",
    turn: 0, where: "test", labels, ...extra,
  });
  const terminals = [
    rec("t100", { bot: ID.dev }, { name: "dev" }),
    rec("t101", { bot: ID.cap }, { name: "cap" }),
    rec("t102", { bot: ID.jun }, { name: "junior" }),
    rec("t103", { bot: ID.main }, { name: "main" }),
    rec("t104", { bot: ID.rev }, { name: "reviewer" }),
    rec("t105", { [WORKER_OF_LABEL]: ID.dev }, { name: "worker", parent: "t100", cwd: worktree }),
    rec("t106", { [WORKER_OF_LABEL]: ID.other }, { name: "other-worker", parent: "t120", cwd: worktree }),
    rec("t107", { role: "fixer" }, { name: "fixer-pane" }),
    rec("t108", { bot: ID.pm }, { name: "pm" }),
    rec("t110", { bot: ID.other }, { name: "other" }),
    rec("t111", {}, { name: "bare" }),
    rec("t112", { bot: ID.jun }, { name: "huge", huge: true }),
    rec("t120", { bot: ID.other }, { name: "other-bot" }),
    rec("t121", { [WORKER_OF_LABEL]: ID.cap }, { name: "cap-worker", parent: "t101", cwd: worktree }),
  ];
  const forbiddenRoots = [["the project", project], ["the app home", app], ["the temp folder", paneTmp], ["the runtime folder", runtime]];
  const env = { XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, ".local", "share"), HOME: home,
    HERDR_APP_HOME: app, TMPDIR: paneTmp, PATH: `${stableGuard}:${shimDir}:${bin}:/usr/bin:/bin` };
  // The approved record every explicit-caller row reads (the by-hand rows keep the ledger).
  approveProject({ project, env, approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: "test" });
  return { root, app, project, home, runtime, worktree, bin, shimDir, paneTmp, stableRoot, stableGuard, ledger, terminals, env, forbiddenRoots };
}

/** Start the fake core and, unless proxy: false, the pane t100 proxy; one cleanup for all. */
async function sceneWithCore(t, { version = "0.1.14", proxy = true, proxyOptions = {} } = {}) {
  const s = scene();
  let fake = null;
  const proxies = [];
  const closeAll = async () => {
    for (const started of proxies.splice(0)) { try { await started.close(); } catch { /* gone */ } }
    try { await fake?.close(); } catch { /* gone */ }
    fake = null;
    rmSync(s.root, { recursive: true, force: true });
  };
  t.after(closeAll);
  try {
    fake = await startFakeCore({ socket: join(s.root, "core.sock"), terminals: s.terminals, version });
    const start = async (terminal = "t100", extra = {}) => {
      const started = await startProxy({ terminal, upstream: fake.socket, appHome: s.app, env: s.env, forbiddenRoots: s.forbiddenRoots, ...extra });
      started.server?.unref?.();
      proxies.push(started);
      return started;
    };
    const first = proxy ? await start("t100", proxyOptions) : null;
    return { s, fake, start, proxy: first };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

class Client {
  constructor(socket) {
    this.socket = socket;
    socket.unref?.();
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.nextId = 1;
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      for (;;) {
        const at = this.buffer.indexOf(10);
        if (at < 0) break;
        const line = this.buffer.subarray(0, at).toString("utf8");
        this.buffer = this.buffer.subarray(at + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line); else this.lines.push(line);
      }
    });
    socket.on("close", () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()(null);
    });
    socket.on("error", () => { /* the proxy may end the connection after a cap */ });
  }

  static async connect(path) {
    const socket = await new Promise((resolve, reject) => {
      const opened = net.connect(path);
      opened.once("connect", () => resolve(opened));
      opened.once("error", reject);
    });
    return new Client(socket);
  }

  next(timeout = 5000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer within the test timeout")), timeout);
      this.waiters.push((line) => {
        clearTimeout(timer);
        if (line === null) reject(new Error("the proxy closed the connection"));
        else resolve(line);
      });
    });
  }

  async call(method, params = {}, timeout = 5000) {
    const id = this.nextId++;
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const line = await this.next(timeout);
    return JSON.parse(line);
  }

  close() {
    this.socket.destroy();
  }
}

const clientFor = (path) => Client.connect(path);

/** The real hc run argv workerArgs emits for a worker, after hc's run's own `--`. */
const workerCallArgs = (s, { sandbox = true } = {}) => {
  const args = workerArgs({ botId: ID.dev, branch: "feat/worker", role: "dev", name: "worker-one", cwd: s.worktree,
    parent: "t100", agent: "dsh-tui", argv: ["dsh-tui"], task: "do the task", path: `${s.shimDir}:${s.bin}:/usr/bin:/bin`,
    project: s.project, taskId: "gn-1", sandbox, stableRoot: s.stableRoot });
  return args.slice(args.indexOf("--") + 1);
};
const helperArgv = (s) => workerCallArgs(s);
const plainArgv = (s) => workerCallArgs(s, { sandbox: false });

/** The exact worker shape the pack's workerArgs emits, as hc's CLI turns it into RPC params. */
const runParams = (s, extra = {}) => ({
  argv: helperArgv(s),
  name: "worker-one",
  cwd: s.worktree,
  env: { TERM: "xterm-256color", TERM_PROGRAM: "herdr" },
  labels: { [WORKER_OF_LABEL]: ID.dev, branch: "feat/worker", "worker.role": "dev", task: "gn-1" },
  parent: "t100",
  no_parent: false, no_notify: false, outlive_parent: false, die_with_parent: true,
  rm: false, keep: false, wait: false,
  caller: "t5q",
  ...extra,
});

const REFUSED_METHODS = [
  "doc.get", "doc.set", "events.subscribe", "file.edit", "file.read", "file.write", "hello",
  "machine.add", "machine.connect", "machine.exec", "machine.list", "machine.rename", "machine.rm",
  "rpc.discover", "server.restart", "server.status", "server.stop", "templates.list",
  "terminal.attach", "terminal.interrupt", "terminal.keep", "terminal.keys", "terminal.put",
];

const waitFor = async (check, timeout = 4000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

test("the allow-list forwards every allowed method and refuses every other one", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const allowed = [
    ["terminal.list", {}],
    ["terminal.get", { terminal: "t101" }],
    ["terminal.read", { terminal: "t101", lines: 5 }],
    ["terminal.wait", { terminal: "t101", timeout: 1 }],
    ["terminal.send", { terminal: "t101", text: "hi" }],
    ["terminal.kill", { terminal: "t105" }],
    ["terminal.rm", { terminal: "t105" }],
    ["terminal.label", { terminal: "t105", labels: { "herdr.tab": "tab-1" } }],
    ["terminal.run", runParams(s)],
  ];
  for (const [method, params] of allowed) {
    const client = await clientFor(proxy.socket);
    const answer = await client.call(method, params);
    client.close();
    assert.ok(answer.result, `${method} answers a result: ${JSON.stringify(answer)}`);
    assert.equal(answer.error, undefined, `${method} has no error`);
  }
  assert.equal(fake.calls("terminal.run").length, 1, "the exact worker shape reached the core");
  assert.equal(fake.calls("terminal.list").length, 1);
  assert.deepEqual(fake.calls("terminal.list")[0].params, {}, "list is forwarded as is");

  for (const method of REFUSED_METHODS) {
    const before = fake.log.length;
    const client = await clientFor(proxy.socket);
    const answer = await client.call(method, { terminal: "t101" });
    client.close();
    assert.ok(answer.error, `${method} is refused`);
    assert.match(answer.error.message, /^hc-proxy: /, `${method} names the proxy`);
    assert.equal(fake.log.length, before, `${method} never reached the core`);
  }
});

test("a forged caller is overwritten on every forwarded request", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const calls = [
    ["terminal.send", { terminal: "t101", caller: "t5q", text: "hi" }],
    ["terminal.get", { terminal: "t101", caller: "t5q" }],
    ["terminal.read", { terminal: "t101", caller: "t5q" }],
    ["terminal.run", runParams(s, { caller: "t5q" })],
  ];
  for (const [method, params] of calls) {
    const client = await clientFor(proxy.socket);
    const answer = await client.call(method, params);
    client.close();
    assert.ok(answer.result, `${method} answers: ${JSON.stringify(answer)}`);
  }
  for (const row of fake.log.filter((entry) => entry.params.caller !== undefined)) {
    assert.equal(row.params.caller, "t100", `${row.method}'s caller is the pane's`);
  }
  const send = fake.calls("terminal.send")[0].params;
  assert.equal(send.caller, "t100");
  assert.notEqual(send.caller, "t5q");
  assert.equal(fake.calls("terminal.run")[0].params.caller, "t100");
  const list = await (await clientFor(proxy.socket)).call("terminal.list", { caller: "t5q" });
  assert.ok(list.error, "terminal.list refuses a caller parameter it does not own");
  assert.match(list.error.message, /terminal\.list: unknown parameter caller/);
  assert.equal(fake.calls("terminal.list").length, 0, "the refused list never reached the core");
});

test("get/read/wait/send are scoped to the team and its own workers", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const allowed = (method, target, extra = {}) => [method, target, extra];
  for (const [method, target, extra] of [
    allowed("terminal.get", "t101"),
    allowed("terminal.get", "t102"),
    allowed("terminal.get", "t105"),
    allowed("terminal.get", "t100"),
    allowed("terminal.read", "t101", { lines: 3 }),
    allowed("terminal.wait", "t102", { timeout: 1 }),
    allowed("terminal.send", "t101", { text: "team" }),
    allowed("terminal.send", "t105", { text: "own worker" }),
    allowed("terminal.send", "t104", { text: "shared reviewer" }),
    allowed("terminal.send", "t107", { text: "shared fixer" }),
  ]) {
    const client = await clientFor(proxy.socket);
    const answer = await client.call(method, { ...extra, terminal: target });
    client.close();
    assert.ok(answer.result, `${method} ${target} is allowed: ${JSON.stringify(answer)}`);
  }
  for (const [method, target, extra] of [
    allowed("terminal.get", "t110"),
    allowed("terminal.read", "t110", { lines: 3 }),
    allowed("terminal.wait", "t110", { timeout: 1 }),
    allowed("terminal.send", "t110", { text: "not mine" }),
    allowed("terminal.send", "t121", { text: "another bot's worker" }),
    allowed("terminal.get", "t121"),
    allowed("terminal.read", "t104", { lines: 3 }),
    allowed("terminal.read", "t107", { lines: 3 }),
    allowed("terminal.send", "mac/t37n", { text: "elsewhere" }),
    allowed("terminal.read", "mac/t37n", { lines: 3 }),
  ]) {
    const before = fake.log.length;
    const client = await clientFor(proxy.socket);
    const answer = await client.call(method, { ...extra, terminal: target });
    client.close();
    assert.ok(answer.error, `${method} ${target} is refused`);
    assert.match(answer.error.message, /^hc-proxy: /);
    if (target.includes("/")) assert.equal(fake.log.length, before, "a machine target is refused before any call");
  }
  // --children waits on the caller's own children; it needs no target and cannot name one.
  const client = await clientFor(proxy.socket);
  const answer = await client.call("terminal.wait", { children: true, timeout: 1 });
  client.close();
  assert.ok(answer.result);
  const forwarded = fake.calls("terminal.wait").at(-1).params;
  assert.equal(forwarded.terminal, undefined);
  assert.equal(forwarded.caller, "t100");
});

test("the pm/integrator/fixer send widening is send only", async (t) => {
  const { s, fake, start } = await sceneWithCore(t);
  appendFileSync(s.ledger, `${JSON.stringify({
    v: 1, event: "attach", bot: ID.pm, project: s.project, terminal: "t108", core: "fake-core",
    created_ms: 150, machine: null, at: "2026-11-01T00:01:00.000Z", by: "attach",
  })}\n`);
  const pm = await start("t108");
  fake.clearLog();
  const send = await (await clientFor(pm.socket)).call("terminal.send", { terminal: "t110", text: "listed" });
  assert.ok(send.result, "a pm may send to a listed bot outside its team");
  const read = await (await clientFor(pm.socket)).call("terminal.read", { terminal: "t110", lines: 2 });
  assert.ok(read.error, "the widening does not reach reads");
  assert.match(read.error.message, /not in the caller's team/);
  const worker = await (await clientFor(pm.socket)).call("terminal.send", { terminal: "t105", text: "a worker" });
  assert.ok(worker.error, "another bot's worker is not a listed bot");
});

async function sharedSceneWithCore(t, terminal = "t100") {
  const { s, fake, start } = await sceneWithCore(t, { proxy: false });
  const capB = "b-iiiiiiiiii", testerB = "b-jjjjjjjjjj";
  const file = team();
  file.bots.find((entry) => entry.id === ID.dev).rank = "dev";
  file.bots.push(
    bot(capB, "member", { rank: "captain", lead: ID.main }),
    bot(testerB, "member", { rank: "tester", lead: capB }),
  );
  writeFileSync(join(s.project, ".herdr", "bots.json"), JSON.stringify(file));
  approveProject({ project: s.project, env: s.env, approvedBy: "test" });
  // No target role labels: reachability must come from the approved roster.
  s.terminals.push(
    { address: "t130", labels: { bot: capB }, cwd: s.project, state: "live" },
    { address: "t131", labels: { bot: testerB }, cwd: s.project, state: "live" },
  );
  s.terminals.find((row) => row.address === "t100").labels.role = "captain";
  s.terminals.find((row) => row.address === "t101").labels.role = "dev";
  s.terminals.find((row) => row.address === "t121").labels.role = "captain";
  appendFileSync(s.ledger, `${JSON.stringify({
    v: 1, event: "attach", bot: ID.cap, project: s.project, terminal: "t101", core: "fake-core",
    created_ms: 150, machine: null, at: "2026-11-01T00:01:00.000Z", by: "attach",
  })}\n`);
  const proxy = await start(terminal);
  const client = await clientFor(proxy.socket);
  t.after(() => client.close());
  fake.clearLog();
  return { client, fake, s };
}

test("proxy: a dev can send to another squad's tester by roster rank", async (t) => {
  const { client, fake } = await sharedSceneWithCore(t);
  const answer = await client.call("terminal.send", { terminal: "t131", text: "verdict request" });
  assert.ok(answer.result, JSON.stringify(answer));
  assert.equal(fake.calls("terminal.send").length, 1);
  for (const method of ["terminal.get", "terminal.read", "terminal.wait"]) {
    const refused = await client.call(method, { terminal: "t131" });
    assert.match(refused.error?.message ?? "", /not in the caller's team/);
  }
});

test("proxy: a captain can send to another squad's captain by roster rank", async (t) => {
  const { client, fake } = await sharedSceneWithCore(t, "t101");
  const answer = await client.call("terminal.send", { terminal: "t130", text: "gate request" });
  assert.ok(answer.result, JSON.stringify(answer));
  assert.equal(fake.calls("terminal.send").length, 1);
  for (const method of ["terminal.get", "terminal.read", "terminal.wait"]) {
    const refused = await client.call(method, { terminal: "t130" });
    assert.match(refused.error?.message ?? "", /not in the caller's team/);
  }
});

test("proxy: a dev cannot send to another squad's captain", async (t) => {
  const { client, fake } = await sharedSceneWithCore(t);
  const answer = await client.call("terminal.send", { terminal: "t130", text: "hi" });
  assert.match(answer.error?.message ?? "", /not in the caller's team/);
  assert.equal(fake.calls("terminal.send").length, 0);
});

test("proxy: a captain's worker cannot use captain-to-captain sends", async (t) => {
  const { client, fake } = await sharedSceneWithCore(t, "t121");
  const answer = await client.call("terminal.send", { terminal: "t130", text: "hi" });
  assert.match(answer.error?.message ?? "", /not in the caller's team/);
  assert.equal(fake.calls("terminal.send").length, 0);
});

test("proxy: tester and captain target labels alone do not widen sends", async (t) => {
  const { client, fake, s } = await sharedSceneWithCore(t, "t101");
  const target = s.terminals.find((row) => row.address === "t110");
  for (const role of ["tester", "captain"]) {
    target.labels.role = role;
    for (const bot of [ID.other, "b-kkkkkkkkkk"]) {
      target.labels.bot = bot;
      const answer = await client.call("terminal.send", { terminal: "t110", text: "hi" });
      assert.match(answer.error?.message ?? "", /not in the caller's team/);
    }
  }
  assert.equal(fake.calls("terminal.send").length, 0);
});

test("terminal.run accepts only the exact worker shape and refuses the rest", async (t) => {
  const { s, fake, proxy, start } = await sceneWithCore(t);
  fake.clearLog();
  const client = await clientFor(proxy.socket);
  const exact = await client.call("terminal.run", runParams(s));
  client.close();
  assert.ok(exact.result, `the worker shape is allowed: ${JSON.stringify(exact)}`);
  const forwarded = fake.calls("terminal.run")[0].params;
  assert.equal(forwarded.caller, "t100");
  assert.equal(forwarded.parent, "t100");
  assert.equal(forwarded.labels[WORKER_OF_LABEL], ID.dev);
  assert.deepEqual(forwarded.argv, runParams(s).argv);

  // A fake guard and a fake dsh-tui inside the writable worktree must not pass the shape.
  mkdirSync(join(s.worktree, "guard"), { recursive: true });
  writeFileSync(join(s.worktree, "hcGuard.mjs"), "// a fake beside the fake guard\n");
  writeFileSync(join(s.worktree, "dsh-tui"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.worktree, "dsh-tui"), 0o755);
  // The app home is writable too; a guard there is not the pack's guard either.
  mkdirSync(join(s.app, "guard"), { recursive: true });
  writeFileSync(join(s.app, "hcGuard.mjs"), "// a fake in the app home\n");

  const bad = [
    ["an on param", { on: "mac" }],
    ["a line", { line: "echo hi" }],
    ["a non-worker argv", { argv: (() => { const a = helperArgv(s); a[11] = "sh"; return a; })() }],
    ["a short argv", { argv: [ENV, `PATH=${s.stableGuard}:/usr/bin`, "dsh-tui", "--"] }],
    ["a parent that is not the caller", { parent: "t101" }],
    ["a cwd outside the worktrees", { cwd: s.root }],
    ["an extra label", { labels: { [WORKER_OF_LABEL]: ID.dev, bot: ID.dev } }],
    ["another bot's worker.of", { labels: { [WORKER_OF_LABEL]: ID.other } }],
    ["a shell key", { shell: true }],
    ["an agent key", { agent: "omp" }],
    ["die_with_parent false", { die_with_parent: false }],
    ["no die_with_parent", { die_with_parent: undefined }],
    ["a PATH without a guard", { argv: (() => { const a = helperArgv(s); a[1] = "PATH=/usr/bin:/bin"; return a; })() }],
    ["a guard inside the writable worktree", {
      argv: (() => { const a = helperArgv(s); a[1] = `PATH=${join(s.worktree, "guard")}:/usr/bin:/bin`; return a; })(),
    }],
    ["a guard inside the writable app home", {
      argv: (() => { const a = helperArgv(s); a[1] = `PATH=${join(s.app, "guard")}:/usr/bin:/bin`; return a; })(),
    }],
    ["a dsh-tui inside the writable worktree", {
      argv: (() => { const a = helperArgv(s); a[1] = `PATH=${s.stableGuard}:${s.worktree}:${s.shimDir}:/usr/bin:/bin`; return a; })(),
    }],
    ["a dsh-tui that is not on the worker PATH", {
      argv: (() => { const a = helperArgv(s); a[1] = `PATH=${s.stableGuard}:${s.home}`; return a; })(),
    }],
    ["a planted guard folder outside both trees", {
      argv: (() => {
        const guard = join(s.root, "planted-guard");
        mkdirSync(guard, { recursive: true });
        writeFileSync(join(guard, "..", "hcGuard.mjs"), "// fake\n");
        const a = helperArgv(s);
        a[1] = `PATH=${guard}:${s.shimDir}:/usr/bin:/bin`;
        return a;
      })(),
    }],
    ["a node planted inside the writable worktree", {
      argv: (() => {
        writeFileSync(join(s.worktree, "node"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(s.worktree, "node"), 0o755);
        const a = helperArgv(s);
        a[1] = `PATH=${s.stableGuard}:${s.worktree}:${s.shimDir}:/usr/bin:/bin`;
        return a;
      })(),
    }],
    ["a dsh-tui planted outside both trees", {
      argv: (() => {
        const planted = join(s.root, "planted-bin");
        mkdirSync(planted, { recursive: true });
        writeFileSync(join(planted, "dsh-tui"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(planted, "dsh-tui"), 0o755);
        const a = helperArgv(s);
        a[1] = `PATH=${s.stableGuard}:${planted}:${s.shimDir}:/usr/bin:/bin`;
        return a;
      })(),
    }],
    ["an env that is not identity only", { env: { LD_PRELOAD: "/tmp/escape.so" } }],
    ["a timeout", { timeout: 5 }],
    ["wait", { wait: true }],
  ];
  for (const [name, extra] of bad) {
    const before = fake.log.length;
    const badClient = await clientFor(proxy.socket);
    const call = await badClient.call("terminal.run", runParams(s, extra));
    badClient.close();
    assert.ok(call.error, `${name} is refused`);
    assert.match(call.error.message, /^hc-proxy: terminal\.run: /);
    assert.equal(fake.log.length, before, `${name} never reached the core`);
  }

  // A worker pane has no ledger row: it starts no workers, even with a worker's own shape.
  const workerProxy = await start("t105");
  const fromWorker = await (await clientFor(workerProxy.socket)).call("terminal.run", runParams(s, { parent: "t105" }));
  assert.ok(fromWorker.error);
  assert.match(fromWorker.error.message, /only a bot pane the attach ledger binds/);
});

test("the plain worker shape is refused, including the real default workerArgs output", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const plain = plainArgv(s);
  assert.equal(plain.length, 5, plain.join(" "));
  assert.deepEqual(plain.slice(2), ["dsh-tui", "--", "do the task"]);
  for (const [name, argv] of [["hand-written", [ENV, `PATH=${GUARD_DIR}:${s.bin}:/usr/bin:/bin`, "dsh-tui", "--", "task"]],
    ["real default workerArgs", plain]]) {
    const before = fake.log.length;
    const client = await clientFor(proxy.socket);
    const answer = await client.call("terminal.run", runParams(s, { argv }));
    client.close();
    assert.ok(answer.error, `${name} is refused`);
    assert.match(answer.error.message, /^hc-proxy: terminal\.run: argv is not the helper worker shape/);
    assert.equal(fake.log.length, before, `${name} never reached the core`);
  }
});

test("a dsh-tui that is not the installed shim is refused even with a matching PATH", async (t) => {
  const { s } = await sceneWithCore(t);
  const params = runParams(s);
  const snapshot = { terminal: "t100", caller: { bot: ID.dev, project: s.project, worker: false }, bound: true,
    appHome: s.app, path: s.env.PATH, stableRoot: s.stableRoot, shim: join(s.root, "another", "dsh-tui") };
  assert.match(runProblem(params, snapshot), /dsh-tui is not the installed shim/);
});

test("the proxy refuses a recorded pane PATH inside a writable tree", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  for (const [name, word] of [["project", s.project], ["app home", s.app], ["temp", s.paneTmp], ["runtime", s.runtime]]) {
    await assert.rejects(
      startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app,
        env: { ...s.env, PATH: `${s.stableGuard}:${word}:/usr/bin:/bin` } }),
      new RegExp(`the pane PATH word .* is inside the writable (project|app home)|the pane PATH word .* is inside the (temp|runtime) folder`),
      name,
    );
  }
});

test("a renamed ancestor of the pack cannot change a worker's stable paths", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  const pack = join(s.root, "fake-pack");
  mkdirSync(join(pack, "bin"), { recursive: true });
  writeFileSync(join(pack, "hcPane.mjs"), "// pack\n");
  writeFileSync(join(pack, "bin", "run.sh"), "#!/bin/sh\n");
  renameSync(pack, join(s.root, "fake-pack-moved"));
  const args = workerArgs({ botId: ID.dev, branch: "feat/worker", cwd: s.worktree, parent: "t100", agent: "dsh-tui",
    argv: ["dsh-tui"], task: "do the task", path: `${s.shimDir}:${s.bin}:/usr/bin:/bin`, project: s.project,
    taskId: "gn-1", sandbox: true, stableRoot: s.stableRoot });
  const argv = args.slice(args.indexOf("--") + 1);
  assert.equal(argv.some((word) => word.includes("fake-pack")), false, "no pack path is in the worker start");
  const answer = await (await clientFor(proxy.socket)).call("terminal.run", runParams(s, { argv }));
  assert.ok(answer.result, JSON.stringify(answer));
  assert.ok(fake.calls("terminal.run").length > 0);
});

test("the proxy refuses a stable execution root inside a writable tree", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  for (const [name, dataHome] of [["project", s.project], ["app home", s.app], ["temp", s.paneTmp], ["runtime", s.runtime]]) {
    await assert.rejects(
      startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app,
        env: { ...s.env, XDG_DATA_HOME: dataHome } }),
      /the stable execution root .* is inside/,
      name,
    );
  }
});

test("the proxy refuses a DSH profile, a shim, or a run.sh node inside a writable tree", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  writeFileSync(join(s.project, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.project, "node"), 0o755);
  const cases = [
    ["profile", { DSH_HOME: s.project }, /the DSH profile .* is inside the project/],
    ["shim", { HOME: s.project, DSH_HOME: join(s.root, "dsh"), XDG_DATA_HOME: join(s.root, "data") }, /the dsh-tui shim .* is inside the project/],
    ["node", { PATH: s.project }, /the node that runs the helper .* is inside the project/],
  ];
  for (const [name, extra, re] of cases) {
    await assert.rejects(
      startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: { ...s.env, ...extra } }),
      re,
      name,
    );
  }
});

test("NVM_DIR, the runtime-dirs override, and a baked node inside the project are refused", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  writeFileSync(join(s.project, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.project, "node"), 0o755);
  for (const [name, extra, re] of [
    ["NVM_DIR", { NVM_DIR: s.project }, /NVM_DIR .* is inside the project/],
    ["runtime dirs", { AUTOMAGIK_HERDR_RUNTIME_DIRS: s.project }, /AUTOMAGIK_HERDR_RUNTIME_DIRS .* is inside the project/],
  ]) {
    await assert.rejects(
      startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: { ...s.env, ...extra } }),
      re,
      name,
    );
  }
  writeFileSync(join(s.stableRoot, "bin", "run.sh"), stableRunnerText(join(s.project, "node")));
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env }),
    /the node that runs the helper .* is inside the project/,
  );
});

test("the dsh a shim executes is checked by real path, and literal /tmp is refused", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  writeFileSync(join(s.project, "dsh-real"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.project, "dsh-real"), 0o755);
  symlinkSync(join(s.project, "dsh-real"), join(s.bin, "dsh"));
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env }),
    /the dsh the shim executes .* is inside the project/,
  );
  rmSync(join(s.bin, "dsh"));
  const literal = { ...s.env, XDG_DATA_HOME: literalTmpData() };
  await assert.rejects(
    startProxy({ terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: literal }),
    /the stable execution root .* is inside the literal temp folder/,
  );
});

test("the stable runner must match its baked node, and the baked node must still exist", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  const runner = join(s.stableRoot, "bin", "run.sh");
  const original = stableRunnerText(process.execPath);
  writeFileSync(runner, original.replace(`exec '${process.execPath}'`, "exec '/bin/false'"));
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env }),
    /the stable runner .* does not match its baked node/,
  );
  const gone = join(s.project, "gone-node");
  writeFileSync(runner, stableRunnerText(gone));
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env }),
    /the baked node .* is gone; run am dsh-tui install again/,
  );
});

test("a missing path under literal /tmp or a symlinked temp root is refused", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-hc-missing-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const literal = join(realpathSync("/tmp"), `am-hc-literal-${process.pid}-${Date.now()}`, "data");
  assert.match(stableRootProblem(literal), /inside the (literal )?temp folder/);
  const real = join(root, "real-tmp");
  const link = join(root, "link-tmp");
  mkdirSync(real);
  symlinkSync(real, link);
  const missing = join(link, "new", "data");
  assert.match(stableRootProblem(missing, { env: { ...process.env, TMPDIR: link } }), /the temp folder/);
});

test("the production default still refuses a stable root under literal /tmp", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  const env = { ...s.env, XDG_DATA_HOME: literalTmpData() };
  await assert.rejects(
    startProxy({ terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env }),
    /the stable execution root .* is inside the literal temp folder/,
  );
});

test("a rename between the check and the forward cannot redirect the target", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  const victim = fake.state.terminals.find((row) => row.address === "t105");
  victim.name = "victim";
  fake.state.afterGet = (found) => {
    if (found.address !== "t105") return;
    found.name = "renamed";
    fake.state.terminals.find((row) => row.address === "t110").name = "victim";
  };
  const answer = await (await clientFor(proxy.socket)).call("terminal.send", { terminal: "victim", text: "hi" });
  assert.ok(answer.result, JSON.stringify(answer));
  const forwarded = fake.calls("terminal.send").at(-1).params;
  assert.equal(forwarded.terminal, "t105", "the resolved address is forwarded, not the name");
  assert.equal(answer.result.target, "t105", "the renamed name cannot redirect it to another terminal");});

test("the read cap refuses an over-long request and a reply over the byte cap", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const tooMany = await (await clientFor(proxy.socket)).call("terminal.read", {
    terminal: "t101", lines: MAX_READ_LINES + 1,
  });
  assert.ok(tooMany.error);
  assert.match(tooMany.error.message, new RegExp(`^hc-proxy: terminal\\.read: ${MAX_READ_LINES + 1} lines is over`));
  assert.equal(fake.calls("terminal.read").length, 0, "the core never sees an over-long read");

  const huge = await (await clientFor(proxy.socket)).call("terminal.read", { terminal: "t112", lines: 10 });
  assert.ok(huge.error, "a reply over the cap is a clear error");
  assert.match(huge.error.message, new RegExp(`over the ${MAX_REPLY_BYTES}-byte reply cap`));
  assert.ok(JSON.stringify(huge).length < MAX_REPLY_BYTES, "the proxy did not buffer the reply for the client");
});

test("hello is refused: framed mode and attach are unreachable", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const answer = await (await clientFor(proxy.socket)).call("hello", { framed: true });
  assert.ok(answer.error);
  assert.match(answer.error.message, /^hc-proxy: hello is not allowed/);
  assert.equal(fake.calls("hello").length, 0);
});

test("own-worker kill, rm and label are allowed; team and other workers are refused", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  for (const [method, params] of [
    ["terminal.kill", { terminal: "t105" }],
    ["terminal.rm", { terminal: "t105" }],
    ["terminal.label", { terminal: "t105", labels: { "herdr.tab": "tab-1" } }],
  ]) {
    const answer = await (await clientFor(proxy.socket)).call(method, params);
    assert.ok(answer.result, `${method} on the caller's own worker: ${JSON.stringify(answer)}`);
    const forwarded = fake.calls(method).at(-1).params;
    assert.equal(forwarded.terminal, "t105");
    if (method === "terminal.label") assert.equal(forwarded.caller, undefined, "label carries no caller");
    else assert.equal(forwarded.caller, "t100");
    for (const target of ["t101", "t121", "t106"]) {
      const before = fake.calls(method).length;
      const refused = await (await clientFor(proxy.socket)).call(method, { ...params, terminal: target });
      assert.ok(refused.error, `${method} on ${target} is refused`);
      assert.match(refused.error.message, /not the caller's own worker/);
      assert.equal(fake.calls(method).length, before, `${method} ${target} never reached the core`);
    }
  }
});

test("terminal.label forwards only its schema fields and refuses a caller", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const label = await (await clientFor(proxy.socket)).call("terminal.label", {
    terminal: "t105", labels: { "herdr.tab": "tab-1" },
  });
  assert.ok(label.result, JSON.stringify(label));
  assert.deepEqual(fake.calls("terminal.label").at(-1).params,
    { terminal: "t105", labels: { "herdr.tab": "tab-1" } },
    "label forwards exactly terminal and labels, no caller");
  const before = fake.log.length;
  const forged = await (await clientFor(proxy.socket)).call("terminal.label", {
    terminal: "t105", labels: { "herdr.tab": "tab-1" }, caller: "t5q",
  });
  assert.ok(forged.error, "label refuses a caller it does not own");
  assert.match(forged.error.message, /terminal\.label: unknown parameter caller/);
  assert.equal(fake.log.length, before, "the caller-bearing label never reached the core");
});

test("a dead upstream answers an error and never falls back", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  const live = await clientFor(proxy.socket);
  assert.ok((await live.call("terminal.list")).result, "the upstream answers first");
  await fake.close();
  const broken = await live.call("terminal.list");
  assert.ok(broken.error, "a dead upstream is an error");
  assert.match(broken.error.message, /^hc-proxy: .*upstream/);
  const fresh = await clientFor(proxy.socket);
  const refused = await fresh.call("terminal.list");
  assert.ok(refused.error);
  assert.match(refused.error.message, /^hc-proxy: .*upstream/);
});

test("a version mismatch refuses to start and creates no socket", async (t) => {
  const { s, fake } = await sceneWithCore(t, { version: "0.1.18", proxy: false });
  const socket = join(s.runtime, "automagik-hc-proxy", "t100", "hc.sock");
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: fake.socket, appHome: s.app, env: s.env }),
    /0\.1\.18.*not the pinned 0\.1\.14/,
  );
  assert.equal(existsSync(socket), false, "no socket exists after the refusal");

  const child = spawn(process.execPath, [PROXY_HARNESS, "--terminal", "t100", "--upstream", fake.socket, "--app-home", s.app], {
    cwd: s.root,
    env: { ...process.env, ...s.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1, stderr);
  assert.match(stderr, /hc-proxy: .*0\.1\.18.*not the pinned 0\.1\.14/);
  assert.equal(existsSync(socket), false);
});

test("the CLI starts a proxy, serves it, and removes its socket on SIGTERM", async (t) => {
  const { s, fake } = await sceneWithCore(t, { proxy: false });
  const socket = join(s.runtime, "automagik-hc-proxy", "t100", "hc.sock");
  const child = spawn(process.execPath, [PROXY_HARNESS, "--terminal", "t100", "--upstream", fake.socket, "--app-home", s.app], {
    cwd: s.root,
    env: { ...process.env, ...s.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.ok(await waitFor(() => existsSync(socket)), `the CLI listened: ${stderr}`);
  const answer = await (await clientFor(socket)).call("terminal.list");
  assert.ok(answer.result, JSON.stringify(answer));
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.ok(await waitFor(() => !existsSync(socket)), "the socket was removed");
});

test("a later edit to the writable bots.json or ledger does not widen the snapshot", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  const baseline = await (await clientFor(proxy.socket)).call("terminal.read", { terminal: "t110", lines: 2 });
  assert.ok(baseline.error, "t110 starts outside the team");
  // If the proxy re-read the roster, `other` would become dev's descendant and t110 readable.
  const file = JSON.parse(readFileSync(join(s.project, ".herdr", "bots.json"), "utf8"));
  file.bots.find((row) => row.id === ID.other).lead = ID.dev;
  writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(file, null, 2)}\n`);
  // If it re-read the ledger, t100 would bind to `other` now.
  appendFileSync(s.ledger, `${JSON.stringify({
    v: 1, event: "attach", bot: ID.other, project: s.project, terminal: "t100", core: "fake-core",
    created_ms: 900, machine: null, at: "2026-11-01T01:00:00.000Z", by: "attach",
  })}\n`);
  fake.clearLog();
  const after = await (await clientFor(proxy.socket)).call("terminal.read", { terminal: "t110", lines: 2 });
  assert.ok(after.error, "a later roster edit does not widen the running policy");
  assert.match(after.error.message, /not in the caller's team/);
  const run = await (await clientFor(proxy.socket)).call("terminal.run", runParams(s));
  assert.ok(run.result, "the snapshot still binds t100 to dev, not to the later ledger row");
});

test("the socket lives in a 0700 folder outside the project, and an inside folder is refused", async (t) => {
  const { s, proxy } = await sceneWithCore(t);
  const folder = dirname(proxy.socket);
  assert.equal(proxy.socket, join(s.runtime, "automagik-hc-proxy", "t100", "hc.sock"));
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(folder)).mode & 0o777, 0o700);
  assert.equal(lstatSync(proxy.socket).mode & 0o777, 0o600);
  assert.ok(!proxy.socket.startsWith(`${s.project}${sep}`), "the socket is outside the writable project");
  assert.ok(!proxy.socket.startsWith(`${s.app}${sep}`), "the socket is outside the app home");

  const inside = join(s.project, "run");
  mkdirSync(inside, { recursive: true });
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: proxy.policy.upstream, appHome: s.app, env: { ...s.env, XDG_RUNTIME_DIR: inside } }),
    /inside the writable project/,
  );
});

test("one upstream connection per downstream client", async (t) => {
  const { fake, proxy } = await sceneWithCore(t);
  const before = fake.connections();
  const first = await clientFor(proxy.socket);
  assert.ok((await first.call("terminal.list")).result);
  assert.ok((await first.call("terminal.list")).result);
  assert.equal(fake.connections() - before, 1, "two calls on one client share one upstream");
  const second = await clientFor(proxy.socket);
  assert.ok((await second.call("terminal.list")).result);
  assert.equal(fake.connections() - before, 2, "a second client gets its own upstream");
  first.close();
  second.close();
});

test("an unknown parameter is refused on every allowed method", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  fake.clearLog();
  const cases = [
    ["terminal.list", { bogus: true }],
    ["terminal.get", { terminal: "t101", bogus: true }],
    ["terminal.read", { terminal: "t101", lines: 2, bogus: true }],
    ["terminal.wait", { terminal: "t101", timeout: 1, bogus: true }],
    ["terminal.send", { terminal: "t101", text: "hi", bogus: true }],
    ["terminal.kill", { terminal: "t105", bogus: true }],
    ["terminal.rm", { terminal: "t105", bogus: true }],
    ["terminal.label", { terminal: "t105", labels: { "herdr.tab": "tab-1" }, bogus: true }],
    ["terminal.run", runParams(s, { bogus: true })],
  ];
  for (const [method, params] of cases) {
    const before = fake.log.length;
    const answer = await (await clientFor(proxy.socket)).call(method, params);
    assert.ok(answer.error, `${method} refuses an unknown parameter`);
    assert.match(answer.error.message, new RegExp(`^hc-proxy: ${method.replace(".", "\\.")}: unknown parameter bogus`));
    assert.equal(fake.log.length, before, `${method} never reached the core`);
  }
});

test("an over-limit socket path refuses to start with a named error", async (t) => {
  const { s, fake } = await sceneWithCore(t, { proxy: false });
  const long = join(s.root, "x".repeat(120));
  mkdirSync(long, { recursive: true });
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: fake.socket, appHome: s.app, env: { ...s.env, XDG_RUNTIME_DIR: long } }),
    new RegExp(`socket path is \\d+ bytes, over the ${socketPathLimit()}-byte limit`),
  );
  assert.equal(existsSync(join(long, "automagik-hc-proxy")), false);
  const child = spawn(process.execPath, [PROXY_HARNESS, "--terminal", "t100", "--upstream", fake.socket, "--app-home", s.app], {
    cwd: s.root,
    env: { ...process.env, ...s.env, XDG_RUNTIME_DIR: long },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1, stderr);
  assert.match(stderr, new RegExp(`hc-proxy: socket path is \\d+ bytes, over the ${socketPathLimit()}-byte limit`));
});

test("the connection cap refuses the extra client with a proxy error", async (t) => {
  const { proxy } = await sceneWithCore(t);
  const held = [];
  for (let i = 0; i < MAX_CONNECTIONS; i += 1) held.push(await clientFor(proxy.socket));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const extra = await clientFor(proxy.socket);
  const answer = JSON.parse(await extra.next());
  assert.match(answer.error.message, new RegExp(`^hc-proxy: too many connections \\(${MAX_CONNECTIONS} max\\)`));
  extra.close();
  for (const client of held) client.close();
});

test("an idle connection and a slow partial line are closed by the idle timeout", async (t) => {
  const { proxy } = await sceneWithCore(t, { proxyOptions: { idleTimeoutMs: 120 } });
  const idle = await clientFor(proxy.socket);
  assert.ok(await waitFor(() => idle.closed, 2000), "an idle connection is closed");
  const slow = await clientFor(proxy.socket);
  slow.socket.write('{"jsonrpc":"2.0","id":1');
  assert.ok(await waitFor(() => slow.closed, 2000), "a slow partial line is closed");
});

test("an in-flight wait keeps the connection alive", async (t) => {
  const { fake, proxy } = await sceneWithCore(t, { proxyOptions: { idleTimeoutMs: 120 } });
  fake.state.waitMs = 350;
  const answer = await (await clientFor(proxy.socket)).call("terminal.wait", { terminal: "t101", timeout: 1 });
  assert.ok(answer.result, "the wait was allowed to finish");
  fake.state.waitMs = 0;
});

test("a forwarded call other than wait times out", async (t) => {
  const { fake, proxy } = await sceneWithCore(t, { proxyOptions: { forwardTimeoutMs: 120 } });
  fake.state.hang = "terminal.list";
  const answer = await (await clientFor(proxy.socket)).call("terminal.list", {});
  assert.ok(answer.error, "the call is refused");
  assert.match(answer.error.message, /^hc-proxy: terminal\.list: did not answer within 120 ms/);
  fake.state.hang = null;
});

test("the version pin is one constant, 0.1.14", () => {
  assert.equal(HC_PIN, "0.1.14");
  assert.equal(readFileSync(PROXY, "utf8").includes('export const HC_PIN = "0.1.14"'), true);
});

test("the socket-path limit follows the platform: 104 on darwin, 107 on linux", async (t) => {
  assert.equal(socketPathLimit("linux"), 107);
  assert.equal(socketPathLimit("darwin"), 104);
  const { s, proxy } = await sceneWithCore(t, { proxy: false });
  assert.equal(proxy, null);
  const long = `t${"a".repeat(120)}`;
  s.terminals.push({ address: long, name: long, labels: { bot: ID.dev }, cwd: s.project, state: "live" });
  const before = existsSync(join(s.runtime, "automagik-hc-proxy"));
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: long, upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env, platform: "darwin",
      caller: { bot: ID.dev, project: s.project, worker: false }, bound: true }),
    /over the 104-byte limit/,
  );
  assert.equal(existsSync(join(s.runtime, "automagik-hc-proxy")), before, "the refused start creates no folder");
});

test("terminal.run's closed set covers the real hc 0.1.14 params; --json is not an RPC member", () => {
  // The real 0.1.14 request, captured on a pane with `hc run --bg --json` through a logging
  // relay: argv, caller, cwd, die_with_parent, env, keep, labels, name, no_notify, no_parent,
  // outlive_parent, parent, rm, timeout, wait. `--json` is CLI output only.
  const real = ["argv", "caller", "cwd", "die_with_parent", "env", "keep", "labels", "name",
    "no_notify", "no_parent", "outlive_parent", "parent", "rm", "timeout", "wait"];
  const allowed = METHOD_PARAMS.get("terminal.run");
  for (const key of real) assert.ok(allowed.has(key), `terminal.run allows ${key}`);
  assert.equal(allowed.has("json"), false, "0.1.14 sends no json member");
  assert.equal(allowed.has("line"), false, "line is refused by the worker shape");
  assert.equal(allowed.has("on"), false, "on is refused by the worker shape");
});

test("the helper's explicit caller starts a bot seat before its attach row exists", async (t) => {
  const { s, fake } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project, state: "live" });
  const started = await startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t200", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true });
  t.after(() => started.close());
  assert.equal(started.policy.caller.bot, ID.dev);
  assert.equal(started.snapshot.bound, true);
  const client = await clientFor(started.socket);
  const answer = await client.call("terminal.send", { terminal: "t101", text: "team" });
  client.close();
  assert.ok(answer.result, JSON.stringify(answer));
  assert.equal(fake.calls("terminal.send")[0].params.caller, "t200");
});

test("an explicit caller whose pane label names another bot is refused", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t100", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
      caller: { bot: ID.other, project: s.project, worker: false } }),
    /does not carry the bot label/,
  );
  await assert.rejects(
    startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t105", upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
      caller: { bot: ID.other, project: s.project, worker: true } }),
    /is not a worker of/,
  );
});

test("the docs say a roster change needs a pane restart", () => {
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const doc = readFileSync(join(here, "..", "mods", "am-sidebar", "hcProxy.md"), "utf8");
  assert.match(readme, /roster change needs a pane restart/i);
  assert.match(doc, /roster change needs a pane restart/i);
});

test("a sandboxed worker start: the real workerArgs output is accepted, and only for this caller", async (t) => {
  const { s, fake, proxy } = await sceneWithCore(t);
  const args = workerArgs({ botId: ID.dev, branch: "feat/worker", role: "dev", name: "worker-one", cwd: s.worktree,
    parent: "t100", agent: "dsh-tui", argv: ["dsh-tui"], task: "do the task", path: `${s.shimDir}:${s.bin}:/usr/bin:/bin`,
    project: s.project, taskId: "gn-1", sandbox: true, stableRoot: s.stableRoot });
  const cut = args.indexOf("--");
  const argv = args.slice(cut + 1);
  assert.equal(argv.length, 14, argv.join(" "));
  const params = runParams(s, { argv, labels: { [WORKER_OF_LABEL]: ID.dev, branch: "feat/worker", "worker.role": "dev", task: "gn-1" } });
  const client = await clientFor(proxy.socket);
  const answer = await client.call("terminal.run", params);
  client.close();
  assert.ok(answer.result, JSON.stringify(answer));
  assert.deepEqual(fake.calls("terminal.run")[0].params.argv, argv, "the real workerArgs output reached the core");
  // The same shape for another bot or another project is refused before the core.
  for (const [at, value] of [[6, ID.other], [8, "/tmp/not-the-project"]]) {
    const before = fake.calls("terminal.run").length;
    const bad = { ...params, argv: argv.map((word, i) => (i === at ? value : word)) };
    const c = await clientFor(proxy.socket);
    const refused = await c.call("terminal.run", bad);
    c.close();
    assert.ok(refused.error, `${at}: ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /^hc-proxy: terminal\.run: /);
    assert.equal(fake.calls("terminal.run").length, before, `${at}: never reached the core`);
  }
});

test("the pack's own guard is allowed inside the app home; the worker shape is not widened", async (t) => {
  const { s } = await sceneWithCore(t);
  const args = workerArgs({ botId: ID.dev, branch: "feat/worker", cwd: s.worktree, parent: "t100", agent: "dsh-tui",
    argv: ["dsh-tui"], task: "do the task", path: `${s.shimDir}:${s.bin}:/usr/bin:/bin`, project: s.project, sandbox: true, stableRoot: s.stableRoot });
  const argv = args.slice(args.indexOf("--") + 1);
  const params = runParams(s, { argv });
  const snapshot = { terminal: "t100", caller: { bot: ID.dev, project: s.project, worker: false }, bound: true,
    appHome: join(here, "..", "mods", "am-sidebar"), path: s.env.PATH, stableRoot: s.stableRoot, shim: join(s.home, ".local", "bin", "dsh-tui") };
  assert.equal(runProblem(params, snapshot), null, "the installed pack's own guard is the exception");
  const forged = { ...params, argv: argv.map((word, i) => (i === 3 ? join(s.root, "bin", "run.sh") : word)) };
  assert.match(runProblem(forged, snapshot), /helper runner is not the stable copy/);
});

// ---- #631 PR C1: the approved roster snapshot, the explicit-caller ledger removal ----

test(
  "G1 (a,b): an approved record is used, and a working-file edit warns once and still starts",
    async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project,
    state: "live" });
  // The working tree widens itself: dev becomes pm and an extra bot appears. The approved
  // record keeps the original team; a mutant that reads the working file would take both.
  const changed = team();
  changed.bots.find((bot) => bot.id === ID.dev).rank = "pm";
  changed.bots.push(bot("b-zzzzzzzzzz", "member", { name: "Injected" }));
  writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(changed, null, 2)}\n`);
  const events = [];
  const started = await startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t200",
    upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true,
    log: (event) => events.push(event) });
  t.after(() => started.close());
  assert.equal(started.policy.file.bots.length, team().bots.length, "the approved roster is used");
  assert.equal(started.policy.file.bots.find((bot) => bot.id === ID.dev).rank, undefined);
  assert.equal(started.policy.file.bots.some((bot) => bot.id === "b-zzzzzzzzzz"), false);
  const warnings = events.filter((event) => event.ev === "roster_unapproved");
  assert.equal(warnings.length, 1, "one warning for the start, not one per request");
  assert.match(warnings[0].message, /am proxy approve/);
  assert.match(warnings[0].message, /differs from the approved one/);
});

test("G1 (c): a missing record refuses a proxied pane and names the command", async (t) => {
  const { s, start } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project,
    state: "live" });
  rmSync(recordFileOf(s.project, s.env));
  await assert.rejects(
    start("t200", { caller: { bot: ID.dev, project: s.project, worker: false }, bound: true }),
    /no approved roster .*am proxy approve/s,
  );
});

test("G1 (d): a data root inside a writable tree refuses at start", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project,
    state: "live" });
  for (const [name, dataHome] of [["project", join(s.project, "data")], ["app home", join(s.app,
    "data")],
    ["temp", join(s.paneTmp, "data")], ["runtime", join(s.runtime, "data")]]) {
    await assert.rejects(
      startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t200", upstream: join(s.root,
        "core.sock"),
        appHome: s.app, env: { ...s.env, XDG_DATA_HOME: dataHome },
        caller: { bot: ID.dev, project: s.project, worker: false }, bound: true }),
      /is inside the (writable )?(project|app home|temp|runtime)|inside the (temp|runtime) folder/,
      name,
    );
  }
});

test("G1 (o): a worker in a worktree gets the main project's approved roster", async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  // The worker owns its worktree's .herdr/bots.json; it names only another bot. The approved
  // record is the lead seat's project, keyed by that main-checkout realpath, never the cwd.
  mkdirSync(join(s.worktree, ".herdr"), { recursive: true });
  writeFileSync(join(s.worktree, ".herdr", "bots.json"), `${JSON.stringify({
    version: 1, categories: [], bots: [bot(ID.other, "member", { name: "Other" })],
  }, null, 2)}\n`);
  const mainLink = join(s.root, "main-checkout");
  symlinkSync(s.project, mainLink);
  const started = await startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t105",
    upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
    caller: { bot: ID.dev, project: mainLink, worker: true }, bound: false });
  t.after(() => started.close());
  assert.equal(started.snapshot.caller.project, realpathSync(s.project));
  assert.equal(started.policy.file.bots.length, team().bots.length,
    "the main project's approved roster");
  assert.equal(started.policy.file.bots.some((bot) => bot.id === ID.dev), true);
  assert.equal(started.policy.file.bots.some((bot) => bot.id === ID.other), true);
});

test(
  "G2 (h): an explicit start never opens the ledger, so an unreadable one still starts",
    async (t) => {
  const { s } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project,
    state: "live" });
  rmSync(s.ledger);
  mkdirSync(s.ledger, { recursive: true });
  const started = await startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t200",
    upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true });
  t.after(() => started.close());
  assert.equal(started.policy.caller.bot, ID.dev);
});

test(
  "G2 (i): a forged ledger row naming another bot has no effect on an explicit start",
    async (t) => {
  const { s, start } = await sceneWithCore(t, { proxy: false });
  s.terminals.push({ address: "t200", name: "new-seat", labels: { bot: ID.dev }, cwd: s.project,
    state: "live" });
  const options = { caller: { bot: ID.dev, project: s.project, worker: false }, bound: true };
  const before = await start("t200", options);
  await before.close();
  appendFileSync(s.ledger, `${JSON.stringify({
    v: 1, event: "attach", bot: ID.other, project: s.project, terminal: "t200", core: "fake-core",
    created_ms: 999, machine: null, at: "2026-11-01T00:02:00.000Z", by: "forged",
  })}\n`);
  const started = await startProxy({ forbiddenRoots: s.forbiddenRoots, terminal: "t200",
    upstream: join(s.root, "core.sock"), appHome: s.app, env: s.env,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true });
  t.after(() => started.close());
  assert.equal(started.policy.caller.bot, ID.dev, "the explicit caller, not the ledger row");
  assert.equal(started.policy.team.has(ID.other), false, "the team comes from the approved roster");
  assert.deepEqual(started.policy, before.policy, "the entire policy is identical after forgery");
});

// Refs #631: approved template/agent workers, with every saved switch left off.
async function approvedWorkerScene(t, worker, botExtra = {}) {
  const result = await sceneWithCore(t, { proxy: false });
  const { s, fake, start } = result;
  const file = team();
  file.bots.find((row) => row.id === ID.dev).worker = worker;
  Object.assign(file.bots.find((row) => row.id === ID.dev), botExtra);
  writeFileSync(join(s.project, ".herdr", "bots.json"), JSON.stringify(file));
  approveProject({ project: s.project, env: s.env, approvedBy: "test",
    approvedAt: "2026-11-02T00:00:00.000Z" });
  fake.state.templates = [
    { name: "dev-sol", command: "codex --model chosen", description: "Approved", body: "Work" },
    { name: "review-sol", command: "claude --model chosen", description: "Other", body: "Review" },
    { name: "agy-sol", command: "agy --mode auto", description: "Antigravity", body: "Ag" },
  ];
  const proxy = await start("t100", { caller: { bot: ID.dev, project: s.project }, bound: true });
  const client = await clientFor(proxy.socket);
  t.after(() => client.close());
  return { ...result, proxy, client };
}

function approvedParams(s, worker, templateCommand = null, { killGuard = stableKillDir(s.stableRoot) } = {}) {
  const plan = workerPlan({ agent: "dsh-tui", worker });
  const task = "do the task";
  const runs = plan.agent ?? (templateCommand ? templateAgent(templateCommand) : null);
  const claude = runs === "claude";
  // #823: the deterministic permission file an approved Antigravity worker's argv names.
  const agySettingsPath = runs === "antigravity" ? agySettingsFile(approvedSettingsDir(s.env), ID.dev, "worker", "dev", s.worktree) : null;
  const args = workerArgs({ botId: ID.dev, branch: "feat/worker", role: "dev", name: "worker-one",
    cwd: s.worktree, parent: "t100", ...plan, task, path: s.env.PATH,
    project: s.project, taskId: "gn-1", lead: ID.dev,
    login: claude ? ["-u", "CLAUDE_CONFIG_DIR"] : [], agySettingsPath,
    // #955: an approved worker's `hc kill` shim is the stable folder's copy, first on its PATH.
    killGuard,
    templateArgv: plan.template && runs === "claude" ? commandArgv({ shell: templateCommand }, [task])
      : plan.template && runs === "antigravity" ? commandArgv({ shell: templateCommand }, [...agySettingsArgs("antigravity", agySettingsPath), task])
        : null });
  const labels = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label") {
      const [key, ...value] = args[++i].split("=");
      labels[key] = value.join("=");
    }
  }
  return runParams(s, { argv: plan.template && !claude && !agySettingsPath ? args.slice(-2)
    : args.slice(args.indexOf("--") + 1), labels, env: {} });
}

test("approved worker (#955): a sandboxed bot's worker of another agent keeps the pane's full guard, with no shim; the pack's own shim first is refused", async (t) => {
  for (const agent of ["claude", "codex", "antigravity"]) {
    const { s, client } = await approvedWorkerScene(t, { agent });
    // The sandboxed pane's PATH holds the stable full guard, so the stable shim is not added:
    // the worker's PATH word is the pane's own, the full guard still on it.
    assert.ok(s.env.PATH.split(":").includes(s.stableGuard), s.env.PATH);
    const good = approvedParams(s, { agent });
    const at = good.argv.findIndex((word) => word.startsWith("PATH="));
    assert.equal(good.argv[at], `PATH=${s.env.PATH}`);
    assert.equal(good.argv[at].includes("/hc-kill"), false, good.argv[at]);
    const own = await client.call("terminal.run", approvedParams(s, { agent }, null, { killGuard: KILL_GUARD_DIR }));
    assert.match(own.error?.message ?? "", /does not match approved agent/, `${agent}, the pack's own shim first: ${JSON.stringify(own)}`);
    assert.ok((await client.call("terminal.run", good)).result, `${agent}: the pane's own PATH is allowed`);
  }
});

for (const worker of [{ agent: "codex", model: "chosen", effort: "high" },
  { agent: "claude", model: "chosen", effort: "high" }, { template: "dev-sol" }, { template: "agy-sol" },
  { agent: "antigravity", agyMode: "auto" }, { agent: "antigravity", agyMode: "accept-edits" },
  // #1032: kimi's approved argv has no task word (its task is sent as its first message).
  { agent: "antigravity", agyMode: "plan" }, { agent: "kimi" }]) {
  test(`approved worker allows named ${worker.template ?? `${worker.agent} (${worker.agyMode ?? "default"})`} with today's identity`, async (t) => {
    const { s, client, fake } = await approvedWorkerScene(t, worker);
    const template = worker.template ? fake.state.templates.find((row) => row.name === worker.template).command : null;
    const params = approvedParams(s, worker, template);
    const answer = await client.call("terminal.run", params);
    assert.ok(answer.result, JSON.stringify(answer));
    const forwarded = fake.calls("terminal.run").at(-1).params;
    assert.deepEqual(forwarded, { ...params, caller: "t100" },
      "argv, parent and worker labels match today's plain start; verified caller replaces input");
    assert.equal(forwarded.argv.includes("--worker"), false, "no dsh-tui wrapper or mask");
    // An Antigravity worker's program is agy; every other named worker runs its key.
    const program = worker.agent === "antigravity" ? "agy" : worker.agent;
    const other = worker.template ? { ...params, argv: ["review-sol", "do the task"] }
      : { ...params, argv: params.argv.map((word) => word === program ? "pi" : word) };
    const refused = await client.call("terminal.run", other);
    assert.match(refused.error.message, /approved worker argv refused.*exactly/);
    assert.equal(fake.calls("terminal.run").length, 1);
  });
}

test("mode #821: approved Antigravity worker refuses a different argv mode without a mode label", async (t) => {
  const worker = { agent: "antigravity", agyMode: "auto" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const params = approvedParams(s, worker);
  assert.equal(params.labels["worker.agyMode"], undefined);
  const at = params.argv.indexOf("--mode");
  assert.ok(at > 0);
  assert.equal(params.argv[at + 1], "auto");
  const argv = params.argv.map((word, i) => i === at + 1 ? "plan" : word);
  const answer = await client.call("terminal.run", { ...params, argv });
  assert.match(answer.error?.message ?? "", /approved worker argv refused.*exactly/);
  assert.equal(fake.calls("terminal.run").length, 0);
});

test("approved Antigravity worker names the deterministic permission file; a forged path is refused", async (t) => {
  const worker = { agent: "antigravity", agyMode: "auto" };
  const { s, client } = await approvedWorkerScene(t, worker);
  const params = approvedParams(s, worker);
  const at = params.argv.indexOf("--settings");
  assert.ok(at > 0, JSON.stringify(params.argv));
  assert.equal(params.argv[at + 1], agySettingsFile(approvedSettingsDir(s.env), ID.dev, "worker", "dev", s.worktree));
  const forged = { ...params, argv: params.argv.map((word, i) => (i === at + 1 ? join(s.root, "other.json") : word)) };
  const answer = await client.call("terminal.run", forged);
  assert.ok(answer.error, "another settings file is not the approved plan");
  assert.match(answer.error.message, /approved worker argv refused: does not match approved agent antigravity exactly/);
});

test("approved Antigravity worker refuses a worker.agyMode label that does not match the approved mode", async (t) => {
  for (const [approved, wrong] of [["plan", "accept-edits"], ["accept-edits", "plan"], ["auto", "plan"]]) {
    const worker = { agent: "antigravity", agyMode: approved };
    const { s, client, fake } = await approvedWorkerScene(t, worker);
    const params = approvedParams(s, worker);
    const answer = await client.call("terminal.run", { ...params, labels: { ...params.labels, "worker.agyMode": wrong } });
    assert.ok(answer.error, `${approved} approved, ${wrong} label must be refused`);
    assert.match(answer.error.message, /approved worker label worker\.agyMode does not match approval/, approved);
    assert.equal(answer.error.message.includes("\n"), false);
    assert.equal(fake.calls("terminal.run").length, 0, "nothing forwarded");
  }
});

test("approved Antigravity worker: the proxy writes the permission file itself, and a file planted on that path is replaced", async (t) => {
  const worker = { agent: "antigravity", agyMode: "auto" };
  const { s, client } = await approvedWorkerScene(t, worker);
  // A file planted where the proxy will write: the proxy writes its own right before forwarding.
  const path = agySettingsFile(approvedSettingsDir(s.env), ID.dev, "worker", "dev", s.worktree);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["command(rm -rf /)"], deny: [] } }), { mode: 0o600 });
  // And one planted in the app home an unproxied worker names: it must never be the proxied plan's path.
  const appHomePath = join(s.app, "automagik-herdr", "agy-settings", "planted.json");
  mkdirSync(dirname(appHomePath), { recursive: true, mode: 0o700 });
  writeFileSync(appHomePath, JSON.stringify({ permissions: { allow: ["command(rm -rf /)"], deny: [] } }), { mode: 0o600 });
  const params = approvedParams(s, worker);
  const answer = await client.call("terminal.run", params);
  assert.ok(answer.result, JSON.stringify(answer));
  const at = params.argv.indexOf("--settings");
  assert.equal(params.argv[at + 1], path, "the argv names the proxy's folder under the data root");
  assert.equal(path.startsWith(`${s.app}/`), false, "never the app home");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.permissions.allow.some((rule) => rule.includes("rm -rf")), false, "the planted list is gone");
  assert.ok(written.permissions.allow.includes("command(gh pr create)"), "the approved defaults");
  assert.ok(written.permissions.allow.includes(`write_file(${s.worktree})`), "the approved worker's worktree");
  assert.ok(written.permissions.deny.includes("command(git push --force)"), "the fixed denies");
  // #879: the proxy-written file trusts the approved worktree, exact, and nothing above it.
  assert.deepEqual(written.trustedWorkspaces, [s.worktree], "the approved worker trusts its worktree");
  for (const wrong of [s.project, dirname(s.worktree), s.home, "/"]) {
    assert.equal(written.trustedWorkspaces.includes(wrong), false, `never ${wrong}`);
  }
});

test("approved Antigravity worker: a symlinked permission folder or file is refused, never followed", async (t) => {
  // A symlinked folder where the proxy writes: the request fails closed, nothing lands through it.
  const worker = { agent: "antigravity", agyMode: "auto" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const dir = approvedSettingsDir(s.env);
  const elsewhere = join(s.root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  symlinkSync(elsewhere, dir);
  const folder = await client.call("terminal.run", approvedParams(s, worker));
  assert.ok(folder.error, "the proxy fails closed");
  assert.match(folder.error.message, /is a symlink/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  assert.equal(fake.calls("terminal.run").length, 0, "nothing forwarded");
  // A symlinked file at the file's own path: refused too, target untouched.
  const other = await approvedWorkerScene(t, worker);
  const file = agySettingsFile(approvedSettingsDir(other.s.env), ID.dev, "worker", "dev", other.s.worktree);
  const target = join(other.s.root, "target.json");
  writeFileSync(target, "{}\n");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  symlinkSync(target, file);
  const linked = await other.client.call("terminal.run", approvedParams(other.s, worker));
  assert.ok(linked.error, "a symlinked file fails closed");
  assert.match(linked.error.message, /is a symlink/);
  assert.equal(readFileSync(target, "utf8"), "{}\n", "the link's target is untouched");
  assert.equal(other.fake.calls("terminal.run").length, 0, "nothing forwarded");
});

test("approved Antigravity worker: its permission file is the approved snapshot's, not the working roster's", async (t) => {
  const worker = { agent: "antigravity", agyMode: "auto" };
  const approvedRule = "command(npm publish)";
  const { s, client } = await approvedWorkerScene(t, worker, { agyPermissions: { allow: [approvedRule], deny: ["command(git stash)"] } });
  // A working-roster edit after approval adds a rule the proxy must not read.
  const path = join(s.project, ".herdr/bots.json");
  const working = JSON.parse(readFileSync(path, "utf8"));
  const dev = working.bots.find((row) => row.id === ID.dev);
  dev.agyPermissions = { allow: ["command(npm publish)", "command(rm -rf /tmp/x)"], deny: [] };
  writeFileSync(path, JSON.stringify(working));
  const params = approvedParams(s, worker);
  const answer = await client.call("terminal.run", params);
  assert.ok(answer.result, JSON.stringify(answer));
  const file = params.argv[params.argv.indexOf("--settings") + 1];
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(written.permissions.allow.includes(approvedRule), "the approved roster's rule reaches it");
  assert.ok(written.permissions.deny.includes("command(git stash)"), "the approved roster's deny too");
  assert.equal(written.permissions.allow.includes("command(rm -rf /tmp/x)"), false, "an unapproved working rule never reaches it");
});

test("approved worker template listing is filtered and a live edit widens neither list nor start", async (t) => {
  const worker = { template: "dev-sol" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const listed = await client.call("templates.list");
  assert.deepEqual(listed.result, { templates: [fake.state.templates[0]] }, "metadata is unchanged");
  const file = team();
  file.bots.find((row) => row.id === ID.dev).worker = { template: "review-sol" };
  writeFileSync(join(s.project, ".herdr", "bots.json"), JSON.stringify(file));
  assert.deepEqual((await client.call("templates.list")).result, listed.result);
  const refused = await client.call("terminal.run", approvedParams(s, { template: "review-sol" }));
  assert.match(refused.error.message, /approved worker label worker.template does not match/);
  assert.equal(fake.calls("terminal.run").length, 0);
  assert.ok((await client.call("terminal.run", approvedParams(s, worker))).result);
  fake.state.templates = [];
  assert.match((await client.call("terminal.run", approvedParams(s, worker))).error.message,
    /template dev-sol is not available/, "a removed template must not become a raw program");
});

test("approved worker agent allowance never comes from a live roster edit", async (t) => {
  const worker = { agent: "codex" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const file = team();
  file.bots.find((row) => row.id === ID.dev).worker = { agent: "claude" };
  writeFileSync(join(s.project, ".herdr", "bots.json"), JSON.stringify(file));
  assert.ok((await client.call("terminal.run", approvedParams(s, worker))).result);
  const refused = await client.call("terminal.run", approvedParams(s, { agent: "claude" }));
  assert.match(refused.error.message, /does not match approved agent codex exactly/);
  assert.equal(fake.calls("terminal.run").length, 1);
});

for (const [name, change] of [
  ["missing", (path) => rmSync(path)],
  ["unreadable", (path) => chmodSync(path, 0o000)],
  ["not a regular file", (path) => { rmSync(path); mkdirSync(path); }],
  ["sha mismatch", (path) => {
    const record = JSON.parse(readFileSync(path)); record.sha256 = "0".repeat(64);
    writeFileSync(path, JSON.stringify(record));
  }],
  ["different valid snapshot", (path) => {
    const record = JSON.parse(readFileSync(path));
    const file = JSON.parse(record.roster); file.bots[0].name = "Changed";
    record.roster = JSON.stringify(file); record.sha256 = sha256Of(record.roster);
    writeFileSync(path, JSON.stringify(record));
  }],
  ["approve stamp mismatch", (path) => {
    const record = JSON.parse(readFileSync(path)); record.approvedAt = "2026-11-03T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(record));
  }],
  ["approver mismatch", (path) => {
    const record = JSON.parse(readFileSync(path)); record.approvedBy = "other";
    writeFileSync(path, JSON.stringify(record));
  }],
]) {
  test(`approved worker re-reads at spawn time and refuses ${name}`, async (t) => {
    const worker = { agent: "codex" };
    const { s, client, fake } = await approvedWorkerScene(t, worker);
    const params = approvedParams(s, worker);
    assert.ok((await client.call("terminal.run", params)).result, "allow before outside change");
    change(recordFileOf(s.project, s.env));
    fake.clearLog();
    const answer = await client.call("terminal.run", params);
    assert.match(answer.error.message, /^hc-proxy: terminal.run: approved worker refused:/);
    assert.equal(answer.error.message.includes("\n"), false);
    assert.equal(fake.calls("terminal.run").length, 0, "no cached or live-roster fallback");
  });
}

test("approved helper worker re-reads at spawn time and refuses after re-approval", async (t) => {
  // The wrapped dsh-tui shape (`workerArgs` with sandbox: true): no named template or agent.
  const { s, client, fake } = await approvedWorkerScene(t, { agent: "dsh-tui" });
  const params = runParams(s);
  assert.equal(params.argv.length, 14, params.argv.join(" "));
  assert.ok((await client.call("terminal.run", params)).result, "the helper is allowed before change");
  approveProject({ project: s.project, env: s.env, approvedBy: "test",
    approvedAt: "2026-11-03T00:00:00.000Z" });
  fake.clearLog();
  const answer = await client.call("terminal.run", params);
  assert.equal(answer.result, undefined, "the start is refused after the re-approval");
  assert.match(answer.error.message,
    /^hc-proxy: terminal\.run: approved worker refused: worker allowance approval approvedAt changed; restart the pane after approval$/);
  assert.equal(fake.calls("terminal.run").length, 0, "the core never received the start");
});

test("approved worker #1032: a Kimi worker's argv is its approved command alone, with no task word; one with a task or an option is refused", async (t) => {
  const worker = { agent: "kimi" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const params = approvedParams(s, worker);
  // kimi 2.5.0 takes no first prompt on its command line: the last word is the program.
  assert.equal(params.argv.at(-1), "kimi", JSON.stringify(params.argv));
  assert.equal(params.argv.includes("do the task"), false);
  for (const [name, argv] of [
    ["a trailing task word", [...params.argv, "do the task"]],
    ["its one-shot print mode", [...params.argv, "-p", "do the task"]],
    ["an option of its own", [...params.argv, "--yolo"]],
    ["another program", params.argv.map((word) => word === "kimi" ? "pi" : word)],
    ["no argv", []],
  ]) {
    const answer = await client.call("terminal.run", { ...params, argv });
    assert.match(answer.error?.message ?? "", /^hc-proxy: terminal\.run: approved worker argv refused: does not match approved agent kimi exactly$/, name);
  }
  assert.equal(fake.calls("terminal.run").length, 0, "nothing reached the core");
  const answer = await client.call("terminal.run", params);
  assert.ok(answer.result, JSON.stringify(answer));
  assert.deepEqual(fake.calls("terminal.run").at(-1).params, { ...params, caller: "t100" });
  // The other agents' rule is as it was: a last word that is an option is no task.
  const codex = await approvedWorkerScene(t, { agent: "codex" });
  const codexParams = approvedParams(codex.s, { agent: "codex" });
  const refused = await codex.client.call("terminal.run", { ...codexParams, argv: [...codexParams.argv.slice(0, -1), "--yolo"] });
  assert.match(refused.error?.message ?? "", /approved worker task must be one text word that is not an option/);
});

test("approved worker rejects extra argv and nonterminal RPC env overrides", async (t) => {
  const worker = { agent: "codex", model: "chosen", effort: "high" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const params = approvedParams(s, worker);
  const rows = [
    ["extra args", { argv: [...params.argv.slice(0, -1), "--unsafe", params.argv.at(-1)] }],
    ["model override", { argv: params.argv.map((word) => word === "chosen" ? "other" : word) }],
    ["task option", { argv: [...params.argv.slice(0, -1), "--unsafe"] }],
    ["PATH override", { argv: params.argv.map((word) => word.startsWith("PATH=") ? "PATH=/bin" : word) }],
    ...[{ PATH: "/bin" }, { TERM: "bad value" }, { CLAUDE_CONFIG_DIR: "value" },
      { "-u": "CLAUDE_CONFIG_DIR" }, { CLAUDE_CONFIG_DIR: "value", EXTRA: "value" }]
      .map((env) => [`env ${Object.keys(env).join(",")}`, { env }]),
  ];
  for (const [name, patch] of rows) {
    const answer = await client.call("terminal.run", { ...params, ...patch });
    assert.ok(answer.error, name);
    assert.match(answer.error.message, /^hc-proxy: terminal.run: approved worker /, name);
    assert.equal(answer.error.message.includes("\n"), false, name);
  }
  assert.equal(fake.calls("terminal.run").length, 0);
});

test("approved Claude template exact rebuild rejects a one-arg change and caller env", async (t) => {
  const worker = { template: "dev-sol" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const command = "claude --model chosen";
  fake.state.templates[0].command = command;
  const params = approvedParams(s, worker, command);
  assert.deepEqual(params.argv.slice(0, 3), [ENV, "-u", "CLAUDE_CONFIG_DIR"]);
  assert.ok((await client.call("terminal.run", params)).result);
  for (const argv of [params.argv.map((word) => word === "sh" ? "bash" : word),
    params.argv.map((word) => word.includes(command) ? word.replace("chosen", "other") : word),
    [...params.argv.slice(0, -1), "--unsafe", params.argv.at(-1)],
    [ENV, "-u", "EXTRA", ...params.argv.slice(3)],
    [ENV, "-u", "CLAUDE_CONFIG_DIR", "EXTRA=value", ...params.argv.slice(3)]]) {
    assert.match((await client.call("terminal.run", { ...params, argv })).error.message,
      /approved worker argv refused.*exactly/);
  }
  for (const env of [{ CLAUDE_CONFIG_DIR: "value" }, { "-u": "CLAUDE_CONFIG_DIR" },
    { TERM: "bad value" }, { "-u": "CLAUDE_CONFIG_DIR", EXTRA: "value" }]) {
    assert.match((await client.call("terminal.run", { ...params, env })).error.message,
      /env .* override is refused/);
  }
  assert.equal(fake.calls("terminal.run").length, 1);
});

test("approved worker accepts four bounded terminal vars and refuses bad values or a fifth var", async (t) => {
  const worker = { agent: "codex" };
  const { s, client, fake } = await approvedWorkerScene(t, worker);
  const params = approvedParams(s, worker);
  const env = { TERM: "xterm-256color", COLORTERM: "truecolor",
    TERM_PROGRAM: "fixture", TERM_PROGRAM_VERSION: "1.0" };
  assert.ok((await client.call("terminal.run", { ...params, env })).result);
  assert.deepEqual(fake.calls("terminal.run").at(-1).params.env, env);
  for (const bad of [{ ...env, EXTRA: "fixture" }, { ...env, TERMINFO: "fixture" },
    ...Object.keys(env).map((key) => ({ ...env, [key]: "bad value" })),
    { COLORTERM: "x".repeat(65) }, { TERM: "" }, { TERM: 1 }]) {
    const answer = await client.call("terminal.run", { ...params, env: bad });
    assert.match(answer.error.message, /env .* override is refused/);
  }
  assert.equal(fake.calls("terminal.run").length, 1);
});


test("unbound approved pane refuses proxy.workerTransport", async (t) => {
  const { s, fake, start } = await sceneWithCore(t, { proxy: false });
  const proxy = await start("t100", { caller: { bot: ID.dev, project: s.project }, bound: false });
  assert.ok(proxy.policy.approval, "this pane has a valid approved snapshot");
  assert.equal(proxy.policy.bound, false, "only the bound check can refuse this transport");
  const client = await clientFor(proxy.socket);
  t.after(() => client.close());
  fake.clearLog();
  const answer = await client.call("proxy.workerTransport");
  assert.equal(answer.result, undefined, "an unbound pane receives no transport identity");
  assert.match(answer.error.message,
    /^hc-proxy: proxy\.workerTransport: only an approved bot pane has a worker transport$/);
  assert.deepEqual(fake.log, [], "the transport request is never forwarded upstream");
});

// RFC 0021 (f) 2: a new Claude worker's session id, as its agent.session label and exactly
// `--session-id <that id>` before its task. Synthetic ids only.
test("approved Claude worker: the proxy accepts its chosen session id and refuses every other shape", async (t) => {
  const SESSION = "00000000-0000-4000-8000-0000000000a1";
  const OTHER = "00000000-0000-4000-8000-0000000000b2";
  const withSession = (params, { label = SESSION, argvId = SESSION } = {}) => {
    const argv = [...params.argv];
    if (argvId !== null) argv.splice(argv.length - 1, 0, "--session-id", argvId);
    const labels = { ...params.labels };
    if (label !== null) labels["agent.session"] = label;
    return { ...params, argv, labels };
  };
  const claude = { agent: "claude", model: "chosen", effort: "high" };
  const { s, client, fake } = await approvedWorkerScene(t, claude);
  const params = approvedParams(s, claude);
  const ok = withSession(params);
  const accepted = await client.call("terminal.run", ok);
  assert.ok(accepted.result, JSON.stringify(accepted));
  assert.deepEqual(fake.calls("terminal.run").at(-1).params, { ...ok, caller: "t100" });
  const refusals = [
    ["a different id in argv", withSession(params, { argvId: OTHER }), /approved worker argv refused.*exactly/],
    ["a label with no id in argv", withSession(params, { argvId: null }), /approved worker argv refused.*exactly/],
    ["an id in argv with no label", withSession(params, { label: null }), /approved worker argv refused.*exactly/],
    ["a label that isn't a UUID", withSession(params, { label: "not-a-session", argvId: "not-a-session" }),
      /approved worker label agent\.session does not match approval/],
  ];
  for (const [what, call, why] of refusals) {
    const answer = await client.call("terminal.run", call);
    assert.ok(answer.error, what);
    assert.match(answer.error.message, why, what);
  }
  assert.equal(fake.calls("terminal.run").length, 1, "only the matching one was forwarded");
  // Another agent never takes a session label.
  const codex = { agent: "codex", model: "chosen", effort: "high" };
  const other = await approvedWorkerScene(t, codex);
  const cp = approvedParams(other.s, codex);
  const answer = await other.client.call("terminal.run", { ...cp, labels: { ...cp.labels, "agent.session": SESSION } });
  assert.match(answer.error?.message ?? "", /approved worker label agent\.session does not match approval/);
  assert.equal(other.fake.calls("terminal.run").length, 0);
});
