import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { coreSockets, coreStatus, inTestRoots, userCoreSockets } from "../mods/am-sidebar/coreSocket.mjs";
import { coreHere } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { attachPath } from "../mods/am-sidebar/attach.js";
import { scratchProject, scratchRoot, shortSocketDir } from "./scratch-project.mjs";

const options = { platform: "linux", uid: 42, home: "/scratch/userdir" };
test("coreSockets: overrides are absolute, exclusive and ordered", () => {
  assert.deepEqual(coreSockets({ AUTOMAGIK_HERDR_CORE_SOCKET: "/fake.sock", HC_SOCKET: "/other.sock" }, options), ["/other.sock"]);
  assert.deepEqual(coreSockets({ AUTOMAGIK_HERDR_CORE_SOCKET: "relative", HC_SOCKET: "/other.sock" }, options), ["/other.sock"]);
  assert.deepEqual(coreSockets({ HC_SOCKET: "/other.sock", HC_SESSION: "../bad" }, options), []);
  assert.deepEqual(coreSockets({ HC_SOCKET: "relative" }, options), []);
  assert.deepEqual(coreSockets({ AUTOMAGIK_HERDR_CORE_SOCKET: "/fake.sock", HC_SOCKET: "" }, options), ["/fake.sock"]);
});
test("coreSockets: Linux and macOS runtime and state defaults; Windows excluded", () => {
  const env = { AUTOMAGIK_HERDR_TEST_ROOTS: "/scratch" };
  for (const platform of ["linux", "darwin"]) {
    const opts = { ...options, platform };
    assert.deepEqual(coreSockets({ ...env, XDG_RUNTIME_DIR: "/scratch/run", HC_SESSION: "session-1.x_2" }, opts), ["/scratch/run/herdr-core/session-1.x_2.sock"]);
    assert.deepEqual(coreSockets({ ...env, XDG_RUNTIME_DIR: "relative" }, opts), ["/scratch/userdir/.local/state/herdr-core/default/default.sock"]);
    assert.deepEqual(coreSockets({ ...env, XDG_STATE_HOME: "/scratch/state" }, { ...opts, uid: null }), ["/scratch/state/herdr-core/default/default.sock"]);
    assert.deepEqual(coreSockets({ ...env, XDG_STATE_HOME: "relative", HC_SESSION: "s1" }, opts), ["/scratch/userdir/.local/state/herdr-core/s1/s1.sock"]);
  }
  assert.deepEqual(coreSockets(env, { ...options, platform: "win32" }), []);
  const win = { ...options, platform: "win32" };
  for (const e of [env, { ...env, HC_SOCKET: "/scratch/explicit.sock", AUTOMAGIK_HERDR_CORE_SOCKET: "/scratch/test.sock" }]) {
    assert.deepEqual(coreSockets(e, win), []);
    assert.deepEqual(userCoreSockets(e, win), []);
  }
});
test("coreSockets: invalid sessions name no socket", () => {
  for (const session of [".", "..", "../x", "a/b", "a\\b", "a:b", "a\tb", "a\nb", "smoke\n"]) {
    assert.deepEqual(coreSockets({ HC_SESSION: session }, options), []);
  }
  for (const [session, name] of [["a b", "a b"], ["team one", "team one"], [" smoke ", "smoke"], ["  ", "default"]]) {
    assert.deepEqual(coreSockets({ HC_SESSION: session, XDG_RUNTIME_DIR: "/scratch/run" }, options),
      [`/scratch/run/herdr-core/${name}.sock`]);
  }
});
test("coreSockets: default precedes lock, first line only, deduplicated", (t) => {
  const root = scratchRoot(t, "hc-lock-");
  const folder = join(root, "herdr-core/default");
  mkdirSync(folder, { recursive: true });
  const env = { XDG_STATE_HOME: root, XDG_RUNTIME_DIR: join(root, "run") };
  const first = join(root, "run/herdr-core/default.sock");
  const lock = join(folder, "core.lock");
  writeFileSync(lock, `  ${root}/recorded.sock \n/ignored.sock\n`);
  assert.deepEqual(coreSockets(env, options), [first, join(root, "recorded.sock")]);
  writeFileSync(lock, `${first}\n`);
  assert.deepEqual(coreSockets(env, options), [first]);
  writeFileSync(lock, "/garbage");
  assert.deepEqual(coreSockets(env, options), [first, "/garbage"]);
  for (const bad of ["relative.sock", "", "not a path\n/ignored.sock"]) {
    writeFileSync(lock, bad);
    assert.deepEqual(coreSockets(env, options), [first]);
  }
  const guarded = { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root };
  writeFileSync(lock, "/garbage");
  assert.deepEqual(coreSockets(guarded, options), [first]);
  const extensionless = join(root, "recorded");
  writeFileSync(lock, `${extensionless}\n/ignored.sock\n`);
  assert.deepEqual(coreSockets(guarded, options), [first, extensionless]);
  assert.ok(userCoreSockets({ ...guarded, HC_SOCKET: first }, options).includes(extensionless));
  writeFileSync(lock, "relative.sock");
  assert.throws(() => userCoreSockets(guarded, options), /Invalid herdr-core lock path/);
});
test("coreSockets: guard excludes system runtime and paths outside complete roots", () => {
  const env = { AUTOMAGIK_HERDR_TEST_ROOTS: "/scratch:/other" };
  assert.deepEqual(coreSockets(env, options), ["/scratch/userdir/.local/state/herdr-core/default/default.sock"]);
  assert.deepEqual(coreSockets({ ...env, XDG_RUNTIME_DIR: "/outside/run" }, options), []);
  assert.deepEqual(coreSockets(env, { ...options, home: "/outside" }), []);
  assert.deepEqual(coreSockets({ ...env, HC_SOCKET: "/scratch/s.sock" }, options), ["/scratch/s.sock"]);
  assert.deepEqual(coreSockets({ ...env, HC_SOCKET: "/outside/s.sock" }, options), []);
  for (const path of ["/scratch-other/a", "/scratch/../outside/a", "relative", "/outside/a"]) assert.equal(inTestRoots(path, env), false);
  assert.equal(inTestRoots("/other/a", env), true);
  assert.equal(inTestRoots("/anywhere", {}), true);
});

async function serving(t, answer, path = join(shortSocketDir(t, "hc-rpc-"), "core.sock")) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const clients = new Set();
  let connections = 0;
  const server = createServer((client) => {
    connections += 1;
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    let input = "";
    client.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) answer(client, input);
    });
  });
  t.after(() => { for (const client of clients) client.destroy(); return new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { path, env: { AUTOMAGIK_HERDR_CORE_SOCKET: path, AUTOMAGIK_HERDR_TEST_ROOTS: dir }, connections: () => connections };
}

const configFile = (dir) => join(dir, "herdr-core/config.toml");
function writeConfig(dir, text) {
  const path = configFile(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function discoveryEnv(root) {
  return {
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"), HERDR_APP_HOME: join(root, "app"), AUTOMAGIK_HOME: join(root, "automagik"),
    AUTOMAGIK_HERDR_TEST_ROOTS: root,
  };
}

const defaultSocket = (env) => join(env.XDG_RUNTIME_DIR, "herdr-core/default.sock");
const lockPath = (env) => join(env.XDG_STATE_HOME, "herdr-core/default/core.lock");
function writeLock(env, text) {
  const lock = lockPath(env);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, text);
}

test("config selects one absolute socket from the supported TOML subset", (t) => {
  const root = scratchRoot(t, "hc-config-");
  const env = discoveryEnv(root);
  const socket = join(root, "team socket#qa");
  for (const entry of [
    `socket = ${JSON.stringify(socket)}`,
    `socket = '${socket}' # comment`,
    `'socket' = '${socket}'`,
    `"socket" = "${root}/team\\u0020socket\\U00000023qa"`,
  ]) {
    writeConfig(env.XDG_CONFIG_HOME, [
      "# core config", "", entry, 'shell = ["sh", "-l", "a,b # c", ] # comment', 'detach_key = "ctrl+\\\\"',
      'headless = "200x120"', "notes = false", "restore_screen = true", "wait_timeout = 10",
      "notes_quiet = -0.5", "draft_wait = +2.5", "history_mb = 0", "machine_timeout = 1000000000", "extra = ['x']",
    ].join("\r\n"));
    assert.deepEqual(coreSockets(env), [socket], entry);
    assert.deepEqual(userCoreSockets({ ...env, HC_SOCKET: join(root, "explicit"), AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "test") }),
      [join(root, "explicit"), join(root, "test"), socket]);
  }
  writeConfig(join(env.HOME, ".config"), `socket = '${socket}'`);
  for (const xdg of [undefined, ""]) assert.deepEqual(coreSockets({ ...env, XDG_CONFIG_HOME: xdg }), [socket]);
});

test("explicit socket choices take precedence over a configured socket", (t) => {
  const root = scratchRoot(t, "hc-choice-");
  const env = discoveryEnv(root);
  const configured = join(root, "configured"), testSocket = join(root, "test"), explicit = join(root, "explicit");
  writeConfig(env.XDG_CONFIG_HOME, `socket = '${configured}'`);
  assert.deepEqual(coreSockets({ ...env, AUTOMAGIK_HERDR_CORE_SOCKET: testSocket }), [testSocket]);
  assert.deepEqual(coreSockets({ ...env, HC_SOCKET: explicit, AUTOMAGIK_HERDR_CORE_SOCKET: testSocket }), [explicit]);
  assert.deepEqual(coreSockets({ ...env, HC_SOCKET: "relative", AUTOMAGIK_HERDR_CORE_SOCKET: testSocket }), [],
    "a non-empty invalid HC_SOCKET still excludes lower-priority choices");
  assert.deepEqual(coreSockets({ ...env, AUTOMAGIK_HERDR_CORE_SOCKET: "relative" }), [],
    "a non-empty invalid test override still excludes the config");
});

test("config falls back when there is no literal socket text, and refuses unsupported socket-bearing files", (t) => {
  const root = scratchRoot(t, "hc-config-");
  const env = discoveryEnv(root);
  const dir = env.XDG_CONFIG_HOME;
  writeConfig(dir, "unrelated and invalid\n[array]\nitems = [1, 2]");
  assert.deepEqual(coreSockets(env), [defaultSocket(env)]);
  for (const text of [
    "# socket can be configured here\nshell = ['sh']",
    'name = "socket"\nother = true',
  ]) {
    writeConfig(dir, text);
    assert.deepEqual(coreSockets(env), [defaultSocket(env)]);
  }
  const valid = `socket = '${root}/preferred'\n`;
  for (const text of [
    `${valid}[notes]`, `${valid}notes = "yes"`, `${valid}draft_wait = 1e100`, `${valid}history_mb = 1000000001`,
    `${valid}shell = []`, `${valid}shell = ['', 'sh']`, `${valid}shell = ['sh', 5]`,
    `${valid}shell = [\n'sh'\n]`, `${valid}foo = true\n"foo" = false`, `${valid}'socket' = '/duplicate'`,
    `${valid}a.b = true`, `${valid}unclassified`, `${valid}\u0000`,
    `[table]\n${valid}`, `decoy = """\n${valid}"""\n`, `decoy = '''\n${valid}'''\n`,
    "socket = 'relative'", `socket = "${root}/bad\\q"`, `socket = "${root}/bad\\uD800"`,
    `socket = "${root}/bad\\U00110000"`, `${valid}#${"x".repeat(65536)}`,
  ]) {
    writeConfig(dir, text);
    assert.deepEqual(coreSockets(env), [], text.slice(0, 100));
    assert.throws(() => userCoreSockets({ ...env, HC_SOCKET: defaultSocket(env) }), /Cannot determine/);
  }
  rmSync(configFile(dir));
  mkdirSync(configFile(dir));
  assert.deepEqual(coreSockets(env), [], "a config that cannot be read as a file is indeterminate");
});

test("the scratch guard excludes outside configs, configured sockets and symlinked lookup directories", (t) => {
  const root = scratchRoot(t, "hc-inside-"), outside = scratchRoot(t, "hc-outside-");
  const env = discoveryEnv(root), inside = join(root, "configured"), other = join(outside, "configured");
  writeConfig(outside, `socket = '${inside}'`);
  assert.deepEqual(coreSockets({ ...env, XDG_CONFIG_HOME: outside }), [defaultSocket(env)]);
  symlinkSync(outside, env.XDG_CONFIG_HOME, "dir");
  assert.deepEqual(coreSockets(env), []);
  unlinkSync(env.XDG_CONFIG_HOME);
  writeConfig(env.XDG_CONFIG_HOME, `socket = '${other}'`);
  assert.deepEqual(coreSockets(env), []);
  rmSync(configFile(env.XDG_CONFIG_HOME));

  const outsideEnv = discoveryEnv(outside);
  writeLock(outsideEnv, inside);
  mkdirSync(dirname(defaultSocket(outsideEnv)), { recursive: true });
  writeFileSync(defaultSocket(outsideEnv), "");
  symlinkSync(outsideEnv.XDG_STATE_HOME, env.XDG_STATE_HOME, "dir");
  symlinkSync(outsideEnv.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR, "dir");
  assert.deepEqual(coreSockets(env), []);
  assert.deepEqual(userCoreSockets(env), []);
});

test("user scan includes another session's extensionless lock and only runtime .sock names", (t) => {
  const root = scratchRoot(t, "hc-user-");
  const env = discoveryEnv(root);
  const other = join(root, "other-session"), runtime = join(env.XDG_RUNTIME_DIR, "herdr-core");
  const otherLock = join(env.XDG_STATE_HOME, "herdr-core/other/core.lock");
  mkdirSync(dirname(otherLock), { recursive: true });
  writeFileSync(otherLock, `${other}\n/ignored`);
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "another.sock"), "");
  writeFileSync(join(runtime, "not-a-socket"), "");
  const sockets = userCoreSockets(env);
  assert.ok(sockets.includes(other), "the per-session scan reads extensionless lock endpoints");
  assert.ok(sockets.includes(join(runtime, "another.sock")), "runtime .sock names are included");
  assert.ok(!sockets.includes(join(runtime, "not-a-socket")), "runtime non-.sock names are excluded");
});

const modulePath = (file) => new URL(`../mods/am-sidebar/${file}`, import.meta.url).pathname;
const botId = "b-aaaaaaaaaa";
function cliScene(t) {
  const root = shortSocketDir(t, "hc-cli-");
  const env = discoveryEnv(root);
  const cwd = scratchProject(root, "team", { isGit: false, bots: { version: 1, categories: [], bots: [
    { id: botId, name: "Lead", kind: "main", agent: "claude", look: { character: "star", colour: "blue" }, role: "", instructions: "" },
  ] } });
  const bin = join(root, "bin"), log = join(root, "calls.jsonl");
  mkdirSync(bin);
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: root,
    AUTOMAGIK_HERDR_NO_UPDATE: "1", HC_CALLS: log, HC_FOLDER: cwd });
  mkdirSync(env.HOME);
  writeFileSync(join(bin, "hc"), "#!/bin/sh\n" + `exec "${process.execPath}" "${join(bin, "hc.mjs")}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "hc.mjs"), `
import { appendFileSync } from 'node:fs';
const [verb] = process.argv.slice(2);
const socket = process.env.HC_SOCKET || "";
appendFileSync(process.env.HC_CALLS, JSON.stringify({ verb, socket }) + "\\n");
if (process.env.EXPECT_HC_SOCKET !== undefined && socket !== process.env.EXPECT_HC_SOCKET) process.exit(86);
const pane = { address: "t1", state: "live", created_ms: 17, cwd: process.env.HC_FOLDER,
  foreground: { argv: ["claude"], cwd: process.env.HC_FOLDER }, labels: { bot: ${JSON.stringify(botId)} } };
const json = (value) => process.stdout.write(JSON.stringify(value));
if (verb === "get") json(pane);
else if (verb === "ls") json({ terminals: [pane], machines: [] });
else if (verb === "machine") json({ machines: [] });
else process.exit(1);
`);
  const run = (file, args, extra) => new Promise((resolve) => {
    const child = execFile(process.execPath, [modulePath(file), ...args],
      { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin?.end("{}");
  });
  const cli = (args, extra) => run("bin/automagik-herdr.mjs", [...args, "--json"], extra);
  const brief = (extra) => run("briefing.mjs", [], { HC_TERMINAL_ID: "t1", CLAUDE_PROJECT_DIR: cwd, HERDR_BRIEFING_TIME_SCALE: "3", ...extra });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { root, env, cwd, cli, brief, calls };
}

function coreReply(id) {
  return (client, line) => {
    const request = JSON.parse(line);
    const reply = request.method === "server.status" ? { result: { core: { id } } }
      : { error: { code: -32601, message: "unknown method" } };
    client.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
  };
}

test("configured socket is exclusive in coreStatus and in the CLI's core-id lookup", async (t) => {
  const s = cliScene(t), { env } = s;
  const standard = await serving(t, coreReply("default-core"), defaultSocket(env));
  const configured = await serving(t, coreReply("configured-core"), join(s.root, "configured.sock"));
  const missing = join(s.root, "missing.sock");
  writeConfig(env.XDG_CONFIG_HOME, `socket = '${missing}'`);
  assert.deepEqual(await coreStatus(env), { none: true, tried: [missing] });
  const stale = await s.cli(["whois", "--all"]);
  assert.equal(stale.code, 1, stale.stderr);
  assert.match(stale.stderr, new RegExp(`tried ${missing}`));
  assert.equal(standard.connections(), 0);
  assert.equal(configured.connections(), 0);

  writeConfig(env.XDG_CONFIG_HOME, `socket = '${configured.path}'`);
  const live = await s.cli(["whois", "--all"]);
  assert.equal(live.code, 0, live.stderr);
  assert.equal(JSON.parse(live.stdout).core, "configured-core");
  assert.equal(configured.connections(), 1);
  assert.equal(standard.connections(), 0);
});

test("invalid socket-bearing configs and relative config roots cannot stamp a core id on an attach row", async (t) => {
  const s = cliScene(t), { env } = s;
  const standard = await serving(t, coreReply("default-core"), defaultSocket(env));
  const configured = await serving(t, coreReply("configured-core"), join(s.root, "configured.sock"));
  const socketLine = `socket = '${configured.path}'\n`;
  writeConfig(join(env.HOME, ".config"), socketLine);
  writeConfig(join(s.cwd, "cfg"), `socket = '${standard.path}'`);
  for (const text of [
    `${socketLine}[notes]\n`, `${socketLine}draft_wait = 1e100\n`,
    `${socketLine}notes = "yes"\n`, "socket = 'relative'\n", null,
  ]) {
    if (text !== null) writeConfig(env.XDG_CONFIG_HOME, text);
    const configEnv = { XDG_CONFIG_HOME: text === null ? "cfg" : env.XDG_CONFIG_HOME };
    assert.deepEqual(await coreStatus({ ...env, ...configEnv }), { none: true, tried: [] });
    const result = await s.cli(["attach", botId, "t1"], configEnv);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /server status failed.*tried no socket/);
    assert.equal(existsSync(attachPath(env.HERDR_APP_HOME)), false);
    assert.equal(await coreHere({ ...env, ...configEnv, HC_SOCKET: standard.path }), null);
  }
  assert.equal(standard.connections(), 0);
  assert.equal(configured.connections(), 0);
});

test("coreHere requires HC_SOCKET itself to answer and refuses a second responding id", async (t) => {
  const root = shortSocketDir(t, "hc-here-"), env = discoveryEnv(root);
  const first = await serving(t, coreReply("core-one"), join(root, "one"));
  const second = await serving(t, coreReply("core-two"), join(root, "two"));
  const missing = join(root, "missing");
  assert.equal(await coreHere({ ...env, HC_SOCKET: missing, AUTOMAGIK_HERDR_CORE_SOCKET: second.path }), null);
  assert.equal(await coreHere({ ...env, HC_SOCKET: first.path, AUTOMAGIK_HERDR_CORE_SOCKET: missing }), "core-one");
  assert.equal(await coreHere({ ...env, HC_SOCKET: first.path, AUTOMAGIK_HERDR_CORE_SOCKET: second.path }), null);
  writeConfig(env.XDG_CONFIG_HOME, `socket = '${second.path}'`);
  assert.equal(await coreHere({ ...env, HC_SOCKET: first.path }), null, "configured socket is also scanned");
});

test("coreHere dispatch uses the test override before HC_TERMINAL_SOCKET and falls back to the terminal socket", async (t) => {
  const root = scratchRoot(t, "hc-dispatch-");
  const env = discoveryEnv(root);
  const testSocket = join(root, "test"), terminal = join(root, "terminal");
  const queried = [];
  const status = async (_env, { sockets }) => {
    queried.push(sockets[0]);
    return { status: { core: { id: "core-one" } }, socket: sockets[0] };
  };
  const sockets = () => [];
  assert.equal(await coreHere({ ...env, AUTOMAGIK_HERDR_CORE_SOCKET: testSocket, HC_TERMINAL_SOCKET: terminal },
    { sockets, status }), "core-one");
  assert.deepEqual(queried, [testSocket]);
  queried.length = 0;
  assert.equal(await coreHere({ ...env, HC_TERMINAL_SOCKET: terminal }, { sockets, status }), "core-one");
  assert.deepEqual(queried, [terminal]);
});

for (const [name, lockContents] of [["exact path", (path) => path], ["first line", (path) => `  ${path}  \n/ignored\n`]]) {
  test(`extensionless lock with ${name} supplies HC_SOCKET to later CLI calls and the briefing's first get`, async (t) => {
    const s = cliScene(t), { env } = s;
    const recorded = await serving(t, coreReply("lock-core"), join(s.root, "recorded"));
    writeLock(env, lockContents(recorded.path));
    assert.equal(s.calls().length, 0);
    const cli = await s.cli(["whois", "t1"], { EXPECT_HC_SOCKET: recorded.path });
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).core, "lock-core");
    // whois reads the pane with `hc get` (an empty ledger needs no `hc ls`).
    assert.ok(s.calls().some(({ verb }) => verb === "get"));
    assert.ok(s.calls().every(({ socket }) => socket === recorded.path));

    const before = s.calls().length;
    const hook = await s.brief({ EXPECT_HC_SOCKET: recorded.path });
    assert.equal(hook.code, 0, hook.stderr);
    assert.match(hook.stdout, /<herdr-bot>/);
    const hookCalls = s.calls().slice(before);
    assert.deepEqual(hookCalls[0], { verb: "get", socket: recorded.path });
    assert.ok(hookCalls.some(({ verb }) => verb === "ls"));
    assert.ok(hookCalls.every(({ socket }) => socket === recorded.path));
    assert.equal(recorded.connections(), 2);
  });
}

test("explicit HC_SOCKET and the runtime default keep their own routing when a lock also answers", async (t) => {
  const s = cliScene(t), { env } = s;
  const recorded = await serving(t, coreReply("lock-core"), join(s.root, "recorded"));
  const standard = await serving(t, coreReply("default-core"), defaultSocket(env));
  const explicit = await serving(t, coreReply("explicit-core"), join(s.root, "explicit"));
  writeLock(env, recorded.path);
  for (const [socket, core] of [["", "default-core"], [explicit.path, "explicit-core"]]) {
    const from = s.calls().length;
    const result = await s.cli(["whois", "t1"], { HC_SOCKET: socket, EXPECT_HC_SOCKET: socket });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).core, core);
    assert.ok(s.calls().slice(from).every((call) => call.socket === socket));
  }
  assert.equal(recorded.connections(), 0);
  assert.equal(standard.connections(), 1);
  assert.equal(explicit.connections(), 1);
});

test("briefing keeps an explicit HC_SOCKET when an extensionless lock also answers", async (t) => {
  const s = cliScene(t), { env } = s;
  const recorded = await serving(t, coreReply("lock-core"), join(s.root, "recorded"));
  const explicit = await serving(t, coreReply("explicit-core"), join(s.root, "explicit"));
  writeLock(env, recorded.path);
  const hook = await s.brief({ HC_SOCKET: explicit.path, EXPECT_HC_SOCKET: explicit.path });
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /<herdr-bot>/);
  assert.deepEqual(s.calls()[0], { verb: "get", socket: explicit.path });
  assert.ok(s.calls().some(({ verb }) => verb === "ls"));
  assert.ok(s.calls().every(({ socket }) => socket === explicit.path));
  // An explicit socket needs no status probe of the hook's own; the lock's core is never asked.
  assert.equal(recorded.connections(), 0);
});

test("coreStatus and the CLI's worker probe make zero connections via symlinks to an outside responder", async (t) => {
  const s = cliScene(t), outside = await serving(t, coreReply("outside-core"));
  const socketLink = join(s.root, "link.sock"), dirLink = join(s.root, "link-dir");
  symlinkSync(outside.path, socketLink);
  symlinkSync(dirname(outside.path), dirLink, "dir");
  for (const socket of [socketLink, join(dirLink, "core.sock")]) {
    const extra = { HC_SOCKET: socket, HC_TERMINAL_ID: "t1" };
    assert.deepEqual(await coreStatus({ ...s.env, ...extra }, { sockets: [socket] }), { none: true, tried: [] });
    const result = await s.cli(["whois", "--all"], extra);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /tried no socket/);
  }
  assert.equal(outside.connections(), 0);
  assert.deepEqual(s.calls(), []);
});

test("coreStatus sends exactly one status request and reads one reply line", async (t) => {
  const requests = [];
  const s = await serving(t, (client, input) => {
    requests.push(input);
    client.end('{"jsonrpc":"2.0","id":1,"result":{"core":{"id":"fake"}}}\nignored\n');
  });
  assert.deepEqual(await coreStatus(s.env), { status: { core: { id: "fake" } }, socket: s.path });
  assert.deepEqual(requests, ['{"jsonrpc":"2.0","id":1,"method":"server.status","params":{}}\n']);
});
test("coreStatus skips missing and non-socket candidates, then reads the lock socket", async (t) => {
  const s = await serving(t, (client) => client.end('{"id":1,"result":{"core":{"id":"lock"}}}\n'));
  const regular = join(s.env.AUTOMAGIK_HERDR_TEST_ROOTS, "file");
  writeFileSync(regular, "not a socket");
  assert.deepEqual(await coreStatus(s.env, { sockets: [`${s.path}.missing`, regular, s.path] }), { status: { core: { id: "lock" } }, socket: s.path });
});
test("coreStatus reaches the lock socket after the missing runtime default", async (t) => {
  const s = await serving(t, (client) => client.end('{"id":1,"result":{"core":{"id":"recorded"}}}\n'));
  const dir = s.env.AUTOMAGIK_HERDR_TEST_ROOTS;
  const state = join(dir, "state"), lockDir = join(state, "herdr-core/default");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "core.lock"), `${s.path}\n`);
  const result = await coreStatus({ XDG_RUNTIME_DIR: join(dir, "missing-run"), XDG_STATE_HOME: state,
    AUTOMAGIK_HERDR_TEST_ROOTS: dir });
  assert.deepEqual(result, { status: { core: { id: "recorded" } }, socket: s.path });
});
test("coreStatus no answers reports all tried paths and guard never connects outside", async (t) => {
  const dir = shortSocketDir(t, "hc-none-");
  const paths = [join(dir, "one.sock"), join(dir, "two.sock")];
  assert.deepEqual(await coreStatus({ AUTOMAGIK_HERDR_TEST_ROOTS: dir }, { sockets: paths }), { none: true, tried: paths });
  assert.deepEqual(await coreStatus({ AUTOMAGIK_HERDR_TEST_ROOTS: dir }, { sockets: ["/run/user/42/herdr-core/default.sock"] }), { none: true, tried: [] });
});
for (const [name, response, expected] of [
  ["malformed JSON", "bad\n", /not JSON/],
  ["wrong id", '{"id":2,"result":{}}\n', /id is not 1/],
  ["null response", "null\n", /id is not 1/],
  ["closed mid-reply", '{"id":1', /closed before/],
  ["oversized reply", "x".repeat(65537), /64 KiB/],
]) {
  test(`coreStatus stops on ${name}, without trying a later socket`, async (t) => {
    const s = await serving(t, (client) => client.end(response));
    let later = 0;
    const next = await serving(t, () => { later += 1; });
    const result = await coreStatus({ AUTOMAGIK_HERDR_TEST_ROOTS: `${s.env.AUTOMAGIK_HERDR_TEST_ROOTS}:${next.env.AUTOMAGIK_HERDR_TEST_ROOTS}` }, { sockets: [s.path, next.path] });
    assert.match(result.error, expected);
    assert.ok(result.error.startsWith(`${s.path}: `));
    assert.equal(later, 0);
  });
}
test("coreStatus preserves RPC error message", async (t) => {
  const s = await serving(t, (client) => client.end('{"id":1,"error":{"code":-1,"message":"core is not running"}}\n'));
  assert.deepEqual(await coreStatus(s.env), { error: "core is not running" });
});
test("coreStatus has one deadline and does not retry an answering but silent socket", async (t) => {
  const s = await serving(t, () => {});
  // A deadline already past: the socket is never opened, so the deadline is the one given.
  const past = await coreStatus(s.env, { sockets: [s.path], timeoutMs: 0 });
  assert.match(past.error, /timed out/);
  assert.equal(s.connections(), 0, "no deadline left: no connection");
  // A silent socket is tried exactly once (the missing first path never connects) and then the
  // deadline ends it. Nothing waits for a second round or a default timeout.
  const result = await coreStatus(s.env, { sockets: [`${s.path}.missing`, s.path], timeoutMs: 80 });
  assert.match(result.error, /timed out/);
  assert.equal(s.connections(), 1, "one connection, no retry");
});
