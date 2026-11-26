// The per-pane hc helper (#631 PR B): one helper per pane starts the proxy before DSH, gives
// the pane the three mask names, and refuses to start the pane when the proxy refuses. Hermetic:
// a fake core, temp app home/project/runtime, and a tiny child that records its environment.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { doctorBotProxies, installSandboxRow, sandboxRootOf, stableRunnerText } from "../mods/am-sidebar/dshTui.mjs";
import { approveProject, recordFileOf } from "../mods/am-sidebar/approved.js";
import { runPane } from "../mods/am-sidebar/hcPane.mjs";
import { startProxy } from "../mods/am-sidebar/hcProxy.mjs";
import { attachLine, attachPath, attachRow } from "../mods/am-sidebar/attach.js";
import { cmdDshTui } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { startFakeCore } from "./fake-hc-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = join(here, "..", "mods", "am-sidebar", "hcPane.mjs");
const ID = { dev: "b-cccccccccc" };

/** One scene: temp app home, project + roster, runtime, home and a fake core. */
async function scene(t, { version = "0.1.14", labels = { bot: ID.dev }, address = "t300", sandboxRow = true } = {}) {
  // A short root: the per-pane socket path must fit the platform's sun_path bound.
  const shortBase = existsSync("/tmp") ? "/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(shortBase, "hp-")));
  const app = join(root, "app"), project = join(root, "project"), home = join(root, "home"), runtime = join(root, "run");
  const paneTmp = join(root, "pane-tmp");
  for (const dir of [app, join(app, "automagik-herdr"), project, join(project, ".herdr"), home, runtime, paneTmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(project, ".herdr", "bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [
    { id: ID.dev, name: "Dev", kind: "main", look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "dsh-tui" },
  ] }, null, 2)}\n`);
  const socket = join(root, "core.sock");
  let fake;
  t.after(async () => {
    try { await fake?.close(); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  fake = await startFakeCore({ socket, version, terminals: [
    { address, name: "pane", labels, cwd: project, state: "live" },
  ] });
  const roots = [["the project", project], ["the app home", app], ["the temp folder", paneTmp], ["the runtime folder", runtime]];
  const harness = join(root, "helper-test.mjs");
  writeFileSync(harness, `import { runPane } from ${JSON.stringify(pathToFileURL(HELPER).href)};\ntry { process.exit(await runPane(process.argv.slice(2), process.env, { forbiddenRoots: ${JSON.stringify(roots)} })); } catch (e) { console.error("hc-pane: " + String(e?.message ?? e).replace(/\\s+/g, " ")); process.exit(1); }\n`);
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, ".local",
    "share"),
    HOME: home, DSH_HOME: join(home, ".dsh"), HERDR_APP_HOME: app, TMPDIR: paneTmp,
    HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: socket };
  if (sandboxRow) installSandboxRow({ env, forbiddenRoots: roots });
  approveProject({ project, env, approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: "test" });
  const proxySocket = join(runtime, "automagik-hc-proxy", address, "hc.sock");
  return { root, app, project, home, runtime, socket, fake, env, harness, proxySocket, forbiddenRoots: roots };
}

/** Run the helper with a child Node script that records the environment it was given. */
function runHelper(s, { bot = ID.dev, project = s.project, worker = false, cwd = s.project,
  out, childScript = envScript, extraArgs = [] } = {}) {
  const args = [s.harness, ...(bot ? ["--bot", bot] : []), ...(project ? ["--project", project] : []),
    ...(worker ? ["--worker"] : []), ...extraArgs, "--", process.execPath, "-e", childScript];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...s.env, PANE_OUT: out },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** The child: prove the proxy socket exists now, then write what the helper set. */
const envScript = `
const fs = require("node:fs"), path = require("node:path");
const proxy = process.env.AM_HC_PROXY_SOCKET;
const info = { env: { mask: process.env.DSH_SANDBOX_MASK, real: process.env.AM_HC_REAL_SOCKET,
  proxy, hcSocket: process.env.HC_SOCKET }, socket: false, folderMode: null };
try {
  info.socket = fs.statSync(proxy).isSocket();
  info.folderMode = fs.statSync(path.dirname(proxy)).mode & 0o777;
} catch {}
fs.writeFileSync(process.env.PANE_OUT, JSON.stringify(info));
`;

test("one pane: the helper starts the proxy before the command and gives the pane the mask names", async (t) => {
  const s = await scene(t);
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "", "the helper is quiet on a clean start");
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(got.env, { mask: "1", real: s.socket, proxy: join(s.runtime, "automagik-hc-proxy", "t300", "hc.sock"), hcSocket: s.socket });
  assert.equal(got.socket, true, "the proxy was listening when the command started");
  assert.equal(got.folderMode, 0o700, "the pane's own runtime folder is 0700");
  assert.equal(got.env.proxy.startsWith(`${s.runtime}/`), true);
  assert.equal(got.env.proxy.startsWith(s.project), false, "outside the project");
  assert.equal(got.env.proxy.startsWith(s.app), false, "outside the app home");
  assert.equal(existsSync(got.env.proxy), false, "the proxy socket is removed with the pane");
});

test("the helper refuses to start the pane when the proxy refuses (fail closed, no sandbox)", async (t) => {
  const s = await scene(t, { version: "0.1.13" });
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0, "the pane command was not started");
  assert.match(r.stderr, /^hc-pane: /m);
  assert.match(r.stderr, /not a supported version \(0\.1\.14, 0\.1\.21\)/);
  assert.equal(existsSync(out), false, "the sandboxed command never ran");
  assert.equal(existsSync(join(s.runtime, "automagik-hc-proxy", "t300")), false, "no socket folder was made");
});

test("the helper starts a pane on a 0.1.21 core", async (t) => {
  const s = await scene(t, { version: "0.1.21" });
  const out = join(s.root, "child.json");
  const result = await runHelper(s, { out });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).socket, true);
});

test("a version change between startup connections refuses the pane before spawn", async (t) => {
  const s = await scene(t);
  s.fake.state.reply = ({ id, method }, conn) => {
    if (conn !== 1 || method !== "server.status") return undefined;
    s.fake.state.version = "0.1.21";
    return { jsonrpc: "2.0", id, result: { version: "0.1.14", core: { id: "fake-core" } } };
  };
  const out = join(s.root, "child.json");
  const result = await runHelper(s, { out });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^hc-pane: .*version.*0\.1\.21.*0\.1\.14/m);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(dirname(s.proxySocket)), false);
  assert.deepEqual(s.fake.log.map(({ conn, method }) => [conn, method]),
    [[1, "server.status"], [2, "server.status"]]);
});

test("M2: proxy down never starts a child or falls back to the real socket", async (t) => {
  const s = await scene(t);
  await s.fake.close();
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /^hc-pane: /m);
  assert.equal(existsSync(out), false, "no fallback child ran");
});

test("doctor reports each saved switch and probes only its bound proxy, without a core fallback",
  async (t) => {
  const s = await scene(t);
  s.fake.state.terminals[0].created_ms = 1;
  const bot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: true };
  const bindings = new Map([[bot.id, { terminal: "t300", project: s.project, created_ms: 1 }]]);
  const status = () => doctorBotProxies({ bots: [bot,
    { id: "b-otheraaaaa", name: "Other", agent: "dsh-tui" }], project: s.project,
    bindings, env: s.env });
  const down = await status();
  assert.equal(down[0].hcProxy, true);
  assert.equal(down[0].up, false);
  assert.equal(down[1].hcProxy, false);
  assert.equal(down[1].terminal, null);
  assert.deepEqual(s.fake.log, [], "a missing proxy never falls back to querying the core");
  const proxy = await startProxy({ env: s.env, terminal: "t300", upstream: s.socket,
    caller: { bot: bot.id, project: s.project, worker: false }, bound: true,
    forbiddenRoots: [["the project", s.project], ["the app home", s.app],
      ["the temp folder", s.env.TMPDIR], ["the runtime folder", s.runtime]] });
  t.after(() => proxy.close());
  assert.equal((await status())[0].up, true);
  bindings.get(bot.id).created_ms = 2;
  const stale = (await status())[0];
  assert.equal(stale.up, false, "an old pane binding cannot report healthy");
  assert.equal(stale.coreVersion, null);
  bindings.get(bot.id).created_ms = 1;
  bot.hcProxy = false;
  const rollingBack = (await status())[0];
  assert.equal(rollingBack.hcProxy, false);
  assert.equal(rollingBack.up, true, "saved off does not pretend the old proxy has stopped");
  assert.equal(rollingBack.warning, true, "L2: incomplete rollback is a visible warning");
  assert.match(rollingBack.detail, /rollback not finished/);
  const io = doctorIO(s, bot);
  const report = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(report.checks.find((row) => row.check === `hc-proxy:${bot.id}`).warning, true);
  const text = await cmdDshTui({}, ["doctor"], io);
  assert.match(text, /WARN hc-proxy:.*rollback not finished/);
  await proxy.close();
  const before = s.fake.log.length;
  assert.equal((await status())[0].up, false);
  assert.equal(s.fake.log.length, before, "a stopped proxy never queries the real socket");
});

function doctorIO(s, bot) {
  s.fake.state.terminals[0].created_ms = 1;
  writeFileSync(attachPath(s.app), attachLine(attachRow({ event: "attach", bot: bot.id,
    project: s.project, terminal: "t300", core: "fixture", created_ms: 1, by: "test" })),
  { mode: 0o600 });
  return { env: s.env, project: { key: s.project, file: { bots: [bot] } }, forbiddenRoots: s.forbiddenRoots };
}

test("doctor shows the proxy's core version", async (t) => {
  const s = await scene(t, { version: "0.1.21" });
  const bot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: true };
  const io = doctorIO(s, bot);
  const proxy = await startProxy({ env: s.env, terminal: "t300", upstream: s.socket,
    caller: { bot: bot.id, project: s.project }, bound: true, forbiddenRoots: s.forbiddenRoots });
  t.after(() => proxy.close());
  const { bots: [row] } = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(row.up, true);
  assert.equal(row.coreVersion, "0.1.21");
  assert.match(await cmdDshTui({}, ["doctor"], io), /hc-proxy:.*proxy is up, core 0\.1\.21/);
  assert.deepEqual(s.fake.calls("proxy.status"), []);
});

test("an older proxy without proxy.status shows version unavailable", async (t) => {
  const s = await scene(t);
  const bot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: false };
  const io = doctorIO(s, bot);
  mkdirSync(dirname(s.proxySocket), { recursive: true });
  const connections = [];
  const old = net.createServer((socket) => {
    const methods = [];
    connections.push(methods);
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const { id, method } = JSON.parse(line);
      methods.push(method);
      const answer = method === "terminal.get" ? { result: s.fake.state.terminals[0] }
        : { error: { code: -32000, message: "hc-proxy: method not allowed" } };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...answer })}\n`);
    });
  });
  old.listen(s.proxySocket);
  await once(old, "listening");
  t.after(() => new Promise((done) => old.close(done)));
  const { bots: [row] } = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(row.up, true);
  assert.equal(row.coreVersion, null);
  assert.equal(row.warning, true);
  assert.match(await cmdDshTui({}, ["doctor"], io),
    /WARN hc-proxy:.*proxy is up, core version unavailable; rollback not finished/);
  assert.deepEqual(connections, [["terminal.get", "proxy.status"], ["terminal.get", "proxy.status"]]);
  assert.deepEqual(s.fake.log, [], "doctor only spoke to the proxy");
});

test("doctor rechecks the binding once when the proxy disconnects during status", async (t) => {
  for (const retryAnswers of [false, true]) {
    await t.test(retryAnswers ? "the binding still answers" : "the binding is down", async (t) => {
      const s = await scene(t);
      const bot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: true };
      const io = doctorIO(s, bot);
      mkdirSync(dirname(s.proxySocket), { recursive: true });
      const connections = [];
      const flaky = net.createServer((socket) => {
        const retry = connections.length > 0;
        const methods = [];
        connections.push(methods);
        const lines = createInterface({ input: socket });
        lines.on("line", (line) => {
          const { id, method } = JSON.parse(line);
          methods.push(method);
          if (method === "proxy.status" || (retry && !retryAnswers)) {
            socket.end();
            return;
          }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: s.fake.state.terminals[0] })}\n`);
        });
      });
      flaky.listen(s.proxySocket);
      await once(flaky, "listening");
      t.after(() => new Promise((done) => flaky.close(done)));
      const { bots: [row] } = await cmdDshTui({ json: true }, ["doctor"], io);
      assert.equal(row.up, retryAnswers);
      assert.equal(row.coreVersion, null);
      assert.deepEqual(connections, [["terminal.get", "proxy.status"], ["terminal.get"]]);
      assert.deepEqual(s.fake.log, [], "doctor only spoke to the proxy");
    });
  }
});

test("a version mismatch kills a pane that ignores SIGTERM and disconnects a client in a long wait", { timeout: 10000 }, async (t) => {
  const s = await scene(t);
  const bot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: true };
  const io = doctorIO(s, bot);
  const spawned = Promise.withResolvers();
  const messages = [];
  const childScript = `
    process.on("SIGTERM", () => console.log("SIGTERM"));
    setInterval(() => {}, 1000);
    console.log("ready");
  `;
  const pane = runPane(["--bot", ID.dev, "--project", s.project, "--",
    process.execPath, "-e", childScript], s.env, {
    forbiddenRoots: s.forbiddenRoots,
    stderr: { write: (line) => messages.push(line) },
    spawn: (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
      t.after(() => child.kill("SIGKILL"));
      const output = createInterface({ input: child.stdout });
      spawned.resolve({ exited: once(child, "exit"), output,
        ready: once(output, "line", { signal: AbortSignal.timeout(3000) }) });
      return child;
    },
  });
  const { exited, output, ready } = await Promise.race([spawned.promise,
    pane.then((code) => assert.fail(`the pane exited before starting its child (${code})`))]);
  assert.deepEqual(await ready, ["ready"], "the child installed its SIGTERM handler");
  assert.equal((await cmdDshTui({ json: true }, ["doctor"], io)).bots[0].up, true);

  const waiting = net.connect(s.proxySocket);
  t.after(() => waiting.destroy());
  await once(waiting, "connect");
  const waitClosed = once(waiting, "close");
  s.fake.state.hang = "terminal.wait";
  waiting.write('{"jsonrpc":"2.0","id":1,"method":"terminal.wait","params":{"children":"all"}}\n');
  for (let elapsed = 0; !s.fake.calls("terminal.wait").length && elapsed < 3000; elapsed += 10) await delay(10);
  assert.equal(s.fake.calls("terminal.wait").length, 1, "the other client has an in-flight wait");

  s.fake.state.version = "0.1.21";
  const trigger = net.connect(s.proxySocket);
  t.after(() => trigger.destroy());
  await once(trigger, "connect");
  const lines = createInterface({ input: trigger });
  const reply = once(lines, "line", { signal: AbortSignal.timeout(3000) });
  const terminated = once(output, "line", { signal: AbortSignal.timeout(3000) });
  trigger.write('{"jsonrpc":"2.0","id":42,"method":"terminal.list"}\n');
  const [[line], childOutput] = await Promise.all([reply, terminated]);
  const { id, error } = JSON.parse(line);
  assert.equal(id, 42);
  assert.match(error.message, /^hc-proxy: .*version/);

  const [code, [, signal]] = await Promise.all([pane, exited, waitClosed]);
  assert.equal(code, 1);
  assert.deepEqual(childOutput, ["SIGTERM"], "the child received and ignored SIGTERM");
  assert.equal(signal, "SIGKILL", "the helper killed the child after the grace period");
  assert.equal(existsSync(s.proxySocket), false, "the helper removed its socket");
  assert.match(messages.join(""), /hc-pane: .*version.*ending the pane/);
  const { bots: [row] } = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(row.up, false);
  assert.equal(row.coreVersion, null);
  assert.match(await cmdDshTui({}, ["doctor"], io), /hc-proxy:.*proxy is down/);
});

test("M1: proxy is listening before spawn; unexpected close ends the pane", async (t) => {
  const s = await scene(t);
  let proxy, child;
  const messages = [];
  const code = await runPane(["--bot", ID.dev, "--project", s.project, "--",
    process.execPath, "-e", "setInterval(() => {}, 1000)"], s.env, {
    forbiddenRoots: [["the project", s.project], ["the app home", s.app],
      ["the temp folder", s.env.TMPDIR], ["the runtime folder", s.runtime]],
    stderr: { write: (line) => messages.push(line) },
    startProxy: async (options) => { proxy = await startProxy(options); return proxy; },
    spawn: (...args) => {
      assert.equal(proxy?.server.listening, true, "the proxy is listening before spawn");
      child = spawn(...args);
      setImmediate(() => proxy.server.close());
      return child;
    },
  });
  assert.equal(code, 1);
  assert.equal(child.killed, true);
  assert.equal(existsSync(proxy.socket), false);
  assert.match(messages.join(""), /hc-pane: the proxy stopped; ending the pane/);
});

test("a worker pane starts the proxy with its worker.of caller", async (t) => {
  const s = await scene(t, { labels: { "worker.of": ID.dev }, address: "t302" });
  const out = join(s.root, "worker.json");
  const r = await runHelper(s, { worker: true, out });
  assert.equal(r.code, 0, r.stderr);
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(got.socket, true);
  assert.match(got.env.proxy, /\/automagik-hc-proxy\/t302\/hc\.sock$/);
});

test("a stale stable execution copy is refused before the proxy starts", async (t) => {
  const s = await scene(t);
  writeFileSync(join(sandboxRootOf(s.env), "hcPane.mjs"), "// stale\n");
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /sandbox row is not current|sandbox is not usable/);
  assert.equal(existsSync(out), false);
});

test("the helper refuses a stable runner whose baked node is gone", async (t) => {
  const s = await scene(t);
  writeFileSync(join(sandboxRootOf(s.env), "bin", "run.sh"), stableRunnerText(join(s.project, "gone-node")));
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the baked node .* is gone; run am dsh-tui install again/);
  assert.equal(existsSync(out), false);
});

test("without the dsh-tui sandbox row the helper starts neither proxy nor pane (no fallback)", async (t) => {
  const s = await scene(t, { sandboxRow: false });
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /sandbox row is not current|sandbox is not usable/);
  assert.match(r.stderr, /am dsh-tui install/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(join(s.runtime, "automagik-hc-proxy")), false);
});

test("the helper refuses a pane whose own label names another bot", async (t) => {
  const s = await scene(t, { labels: { bot: "b-zzzzzzzzzz" } });
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /does not carry the bot label/);
  assert.equal(existsSync(out), false);
});

test("each pane gets its own proxy folder", async (t) => {
  const s = await scene(t);
  const outA = join(s.root, "a.json"), outB = join(s.root, "b.json");
  const a = await runHelper(s, { out: outA });
  assert.equal(a.code, 0, a.stderr);
  s.env.HC_TERMINAL_ID = "t301";
  s.fake.state.terminals.push({ address: "t301", name: "pane-b", labels: { bot: ID.dev }, cwd: s.project, state: "live" });
  const b = await runHelper(s, { out: outB });
  assert.equal(b.code, 0, b.stderr);
  const first = JSON.parse(readFileSync(outA, "utf8")).env.proxy;
  const second = JSON.parse(readFileSync(outB, "utf8")).env.proxy;
  assert.notEqual(dirname(first), dirname(second));
  assert.match(first, /\/automagik-hc-proxy\/t300\/hc\.sock$/);
  assert.match(second, /\/automagik-hc-proxy\/t301\/hc\.sock$/);
});

test("the helper runs when it is started through a symlink", async (t) => {
  const s = await scene(t);
  const link = join(s.root, "hcPane-link.mjs");
  symlinkSync(HELPER, link);
  const r = spawnSync(process.execPath, [link, "--help"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: hcPane\.mjs/);
});

test("the pack's sandbox wrapper and helper are byte-equal to the DSH lane's sources", () => {
  const source = join(here, "..", "..", "apps", "dsh-sandbox", "bin");
  for (const name of ["hc-socket-mask.mjs", "dsh-sandbox.mjs"]) {
    const from = join(source, name), to = join(here, "..", "mods", "am-sidebar", "bin", name);
    assert.ok(readFileSync(from).equals(readFileSync(to)), `${to} is byte-equal to ${from}`);
    assert.ok(statSync(to).mode & 0o111, `${to} is executable`);
  }
});

test("G1 (o): a worker without --project is refused, never falls back to its cwd", async (t) => {
  const s = await scene(t, { labels: { "worker.of": ID.dev }, address: "t302" });
  const worktree = join(s.project, ".claude", "worktrees", "worker");
  mkdirSync(join(worktree, ".herdr"), { recursive: true });
  writeFileSync(join(worktree, ".herdr", "bots.json"),
    readFileSync(join(s.project, ".herdr", "bots.json")));
  s.fake.state.terminals[0].cwd = worktree;
  const out = join(s.root, "worker.json");
  const r = await runHelper(s, { worker: true, project: null, cwd: worktree, out });
  assert.notEqual(r.code, 0, "the worker pane was not started");
  assert.match(r.stderr, /--project is required for a worker/);
  assert.match(r.stderr, /never the worktree/);
  assert.equal(existsSync(out), false);
});

test("G1 (b): a working-tree roster edit warns once and the pane still starts", async (t) => {
  const s = await scene(t);
  const bots = JSON.parse(readFileSync(join(s.project, ".herdr", "bots.json"), "utf8"));
  bots.bots[0].rank = "pm";
  writeFileSync(join(s.project, ".herdr", "bots.json"), `${JSON.stringify(bots, null, 2)}\n`);
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "one warning line, no other noise");
  assert.match(lines[0], /^hc-pane: /);
  assert.match(lines[0], /am proxy approve/);
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(got.socket, true, "the approved roster still started the proxy");
});

test("G1 (c): a missing record refuses a proxied pane before the child starts", async (t) => {
  const s = await scene(t);
  rmSync(recordFileOf(s.project, s.env));
  const out = join(s.root, "child.json");
  const r = await runHelper(s, { out });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no approved roster .*am proxy approve/s);
  assert.equal(existsSync(out), false);
});

const macProxyBot = { id: ID.dev, name: "Dev", agent: "dsh-tui", hcProxy: true };
const approveFix = "am proxy approve (review the preview, then --confirm), then restart";

function writeProxyRoster(s, hcProxy, project = s.project) {
  const path = join(project, ".herdr", "bots.json");
  const roster = JSON.parse(readFileSync(join(s.project, ".herdr", "bots.json"), "utf8"));
  roster.bots[0].hcProxy = hcProxy;
  writeFileSync(path, JSON.stringify(roster));
}

async function macProxyRow(s, bot = macProxyBot, bindings = new Map(), project = s.project) {
  const args = { bots: [bot], project, bindings, env: s.env };
  if (process.platform === "darwin") {
    const [row] = await doctorBotProxies(args);
    return row;
  }
  if (process.platform === "linux") {
    assert.deepEqual(await doctorBotProxies({ ...args, platform: "linux" }), await doctorBotProxies(args));
  }
  const [row] = await doctorBotProxies({ ...args, platform: "darwin" });
  return row;
}

function assertUnmasked(row, observed, paneWarning = false) {
  assert.equal(row.applicable, false);
  assert.equal(row.warning, true);
  assert.equal(row.unmasked, true);
  assert.equal(row.paneWarning, paneWarning);
  assert.ok(row.detail.startsWith(`${observed}; this computer is macOS`), row.detail);
  assert.match(row.detail, /RFC 0044 §F.*starts plain/);
}

function assertNoUnmasked(row) {
  assert.equal(Object.hasOwn(row, "unmasked"), false);
  assert.equal(Object.hasOwn(row, "paneWarning"), false);
  assert.equal(Object.hasOwn(row, "warning"), false);
  assert.equal(row.detail, "no attached local pane");
}

test("macOS doctor warns on approved on with working on or off, and names the inspected project", async (t) => {
  const s = await scene(t);
  writeProxyRoster(s, true);
  approveProject({ project: s.project, env: s.env });
  for (const hcProxy of [true, false]) {
    await t.test(`working ${hcProxy ? "on" : "off"}`, async () => {
      const row = await macProxyRow(s, { ...macProxyBot, hcProxy });
      assertUnmasked(row, "no attached local pane");
      assert.equal(row.hcProxyState.working, hcProxy);
      assert.equal(row.hcProxyState.approved, true);
      const { approvalProjectWord } = await import("../mods/am-sidebar/approved.js");
      const project = approvalProjectWord(s.project);
      assert.ok(row.detail.includes(`am edit ${ID.dev} --hc-proxy off --project ${project}`));
      assert.ok(row.detail.includes(`am proxy approve --project ${project}`));
      assert.match(row.detail, /--confirm/);
      assert.doesNotMatch(row.detail, /am restart|can reach|has access/);
    });
  }
});

test("macOS doctor keeps existing observations for approval controls", async (t) => {
  const s = await scene(t);
  const record = recordFileOf(s.project, s.env);
  rmSync(record);
  const missing = await macProxyRow(s);
  assertNoUnmasked(missing);
  assert.equal(missing.hcProxyState.approved, null);

  writeProxyRoster(s, false);
  approveProject({ project: s.project, env: s.env });
  writeProxyRoster(s, true);
  const approvedOff = await macProxyRow(s);
  assertNoUnmasked(approvedOff);
  assert.equal(approvedOff.hcProxyState.approved, false);

  writeFileSync(record, "{invalid json");
  const invalid = await macProxyRow(s);
  assertNoUnmasked(invalid);
  assert.ok(invalid.hcProxyState.error);

  approveProject({ project: s.project, env: s.env });
  assertNoUnmasked(await macProxyRow(s, { ...macProxyBot, agent: "claude" }));

  writeProxyRoster(s, false);
  approveProject({ project: s.project, env: s.env });
  const rolledBack = await macProxyRow(s, { ...macProxyBot, hcProxy: false });
  assertNoUnmasked(rolledBack);
  assert.equal(rolledBack.hcProxyState.approved, false);
});

test("macOS doctor keeps the bound pane's proxy health and rollback warning", async (t) => {
  const s = await scene(t);
  writeProxyRoster(s, true);
  approveProject({ project: s.project, env: s.env });
  doctorIO(s, macProxyBot);
  const bindings = new Map([[ID.dev, { terminal: "t300", project: s.project, created_ms: 1 }]]);
  const proxy = await startProxy({ env: s.env, terminal: "t300", upstream: s.socket,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true, forbiddenRoots: s.forbiddenRoots });
  t.after(() => proxy.close());

  await t.test("live proxy, working on", async () => {
    const row = await macProxyRow(s, macProxyBot, bindings);
    assertUnmasked(row, "proxy is up, core 0.1.14");
    assert.equal(row.up, true);
    assert.equal(row.coreVersion, "0.1.14");
  });
  await t.test("live proxy, working off", async () => {
    const row = await macProxyRow(s, { ...macProxyBot, hcProxy: false }, bindings);
    assertUnmasked(row, "proxy is up, core 0.1.14; rollback not finished", true);
    assert.equal(row.up, true);
  });

  await proxy.close();
  await t.test("down proxy", async () => {
    const before = s.fake.log.length;
    const row = await macProxyRow(s, macProxyBot, bindings);
    assert.equal(s.fake.log.length, before, "a down proxy never queries the core");
    assert.equal(row.up, false);
    assertUnmasked(row, "proxy is down or not responding");
  });
});

test("macOS doctor's project word escapes a newline and ESC", async (t) => {
  const s = await scene(t);
  const project = join(s.root, "ctl proj \n\x1b[31mred\x1b[0m");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeProxyRoster(s, true, project);
  approveProject({ project, env: s.env });
  const row = await macProxyRow(s, macProxyBot, new Map(), project);
  assertUnmasked(row, "no attached local pane");
  const { approvalProjectWord } = await import("../mods/am-sidebar/approved.js");
  const word = approvalProjectWord(project);
  assert.ok(word.startsWith("$'"));
  assert.ok(word.includes("\\x0a\\x1b"));
  assert.equal(row.detail.split(`--project ${word}`).length, 3);
  assert.doesNotMatch(row.detail, /[\n\x1b]/);
});

test("the shared shell word keeps the approval printer's quoting", async () => {
  const { approvalProjectWord, shellWord } = await import("../mods/am-sidebar/approved.js");
  for (const [value, expected] of [["plain", "plain"], ["a b", "'a b'"], ["it's", "'it'\\''s'"]]) {
    assert.equal(shellWord(value), expected);
    assert.equal(approvalProjectWord(value), expected);
  }
  assert.equal(shellWord("x\ny"), "'x\ny'");
  assert.equal(approvalProjectWord("x\ny"), "$'x\\x0ay'");
});

async function darwinDoctor(s, cwd, preload, args = []) {
  const { execFile } = await import("node:child_process");
  const env = Object.fromEntries(Object.entries(s.env).filter(([key]) => !key.startsWith("HC_")));
  env.XDG_CONFIG_HOME = join(s.home, ".config");
  const cli = join(dirname(HELPER), "bin", "automagik-herdr.mjs");
  const pre = process.platform === "darwin" ? [] : ["--import", preload];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [...pre, cli, "dsh-tui", "doctor", "--project", s.project, ...args],
      { cwd, env }, (error, stdout, stderr) => {
        const status = error ? error.code : 0;
        if (!Number.isInteger(status)) return reject(error);
        resolve({ status, stdout, stderr });
      });
  });
}

test("macOS doctor renders the warning in JSON and text with invariant exit codes", async (t) => {
  const s = await scene(t);
  const cwd = join(s.root, "other dir");
  mkdirSync(cwd);
  const preload = join(s.root, "darwin.mjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
  const record = recordFileOf(s.project, s.env);
  const approve = () => approveProject({ project: s.project, env: s.env });
  const checkName = `hc-proxy:${ID.dev}`;

  async function observe() {
    const json = await darwinDoctor(s, cwd, preload, ["--json"]);
    assert.ok(json.stdout, json.stderr);
    const report = JSON.parse(json.stdout);
    const row = report.checks.find(({ check }) => check === checkName);
    assert.ok(row);
    assert.equal(json.status, report.code);
    const text = await darwinDoctor(s, cwd, preload);
    assert.equal(text.status, json.status, text.stderr);
    const line = text.stdout.split("\n").find((value) => value.includes(`${checkName}:`));
    assert.ok(line, text.stdout);
    return { status: json.status, report, row, line };
  }

  rmSync(record);
  writeProxyRoster(s, true);
  const baseline = await observe();
  assert.deepEqual(baseline.row, {
    check: checkName, ok: true, warning: false, fix: approveFix,
    detail: "Dev: hcProxy working on; approved missing; no attached local pane",
  });

  async function check(name, { warning, fix, detail, text, invalid = false }) {
    const result = await observe();
    assert.equal(result.status, baseline.status);
    await t.test(`${name} JSON`, () => {
      assert.deepEqual({ ok: result.row.ok, warning: result.row.warning, fix: result.row.fix },
        { ok: true, warning, fix });
      assert.match(result.row.detail, detail);
      if (!warning) assert.doesNotMatch(result.row.detail, /macOS/);
      const rosterWarnings = result.report.checks.filter(({ check }) => check === "approved-roster");
      assert.equal(rosterWarnings.length, invalid ? 1 : 0);
      if (invalid) assert.equal(rosterWarnings[0].warning, true);
    });
    await t.test(`${name} text`, () => {
      assert.match(result.line, text);
      if (!fix) assert.doesNotMatch(result.line, /\(fix:/);
      if (!warning) assert.doesNotMatch(result.line, /macOS/);
    });
  }

  writeProxyRoster(s, false);
  approve();
  writeProxyRoster(s, true);
  await check("approved off", { warning: false, fix: approveFix,
    detail: /^Dev: hcProxy working on; approved off; no attached local pane$/,
    text: /^ok   hc-proxy:.*working on; approved off; no attached local pane/ });

  approve();
  await check("working on, approved on", { warning: true, fix: null,
    detail: /approved on; no attached local pane; this computer is macOS/,
    text: /^WARN hc-proxy:b-cccccccccc: Dev: hcProxy working on; approved on; no attached local pane; this computer is macOS/ });

  writeProxyRoster(s, false);
  await check("working off, approved on", { warning: true, fix: null,
    detail: /working off; approved on; no attached local pane; this computer is macOS/,
    text: /^WARN hc-proxy:.*working off; approved on; no attached local pane; this computer is macOS/ });

  doctorIO(s, macProxyBot);
  const proxy = await startProxy({ env: s.env, terminal: "t300", upstream: s.socket,
    caller: { bot: ID.dev, project: s.project, worker: false }, bound: true, forbiddenRoots: s.forbiddenRoots });
  t.after(() => proxy.close());
  await check("live proxy during rollback", { warning: true, fix: `am restart ${ID.dev}`,
    detail: /rollback not finished; this computer is macOS/,
    text: /^WARN hc-proxy:.*rollback not finished; this computer is macOS.*\(fix: am restart b-cccccccccc\)$/ });
  await proxy.close();
  rmSync(attachPath(s.app));

  approve();
  await check("rolled back", { warning: false, fix: null,
    detail: /working off; approved off; no attached local pane/, text: /^ok   hc-proxy:/ });

  writeFileSync(record, "{invalid json");
  writeProxyRoster(s, true);
  await check("invalid approval", { warning: false, fix: approveFix, invalid: true,
    detail: /working on; approved unknown; invalid approved record .*; no attached local pane/,
    text: /^ok   hc-proxy:.*working on; approved unknown; invalid approved record/ });
});

test("Linux doctor keeps its approved and unapproved proxy rows", { skip: process.platform !== "linux" }, async (t) => {
  const s = await scene(t);
  writeProxyRoster(s, true);
  approveProject({ project: s.project, env: s.env });
  const io = { env: s.env, project: { key: s.project, file: { bots: [macProxyBot] } },
    forbiddenRoots: s.forbiddenRoots };
  const checkName = `hc-proxy:${ID.dev}`;
  const approved = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(Object.hasOwn(approved.bots[0], "unmasked"), false);
  const { ok, warning, fix } = approved.checks.find(({ check }) => check === checkName);
  assert.deepEqual({ ok, warning, fix }, { ok: true, warning: false, fix: null });

  rmSync(recordFileOf(s.project, s.env));
  const missing = await cmdDshTui({ json: true }, ["doctor"], io);
  const row = missing.checks.find(({ check }) => check === checkName);
  assert.equal(row.ok, false);
  assert.equal(row.fix, approveFix);
});
