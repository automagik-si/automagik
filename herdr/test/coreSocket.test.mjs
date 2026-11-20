import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { coreSockets, coreStatus, inTestRoots } from "../mods/am-sidebar/coreSocket.mjs";
import { scratchRoot, shortSocketDir } from "./scratch-project.mjs";

const options = { platform: "linux", uid: 42, home: "/scratch/userdir" };
test("coreSockets: overrides are absolute, exclusive and ordered", () => {
  assert.deepEqual(coreSockets({ AUTOMAGIK_HERDR_CORE_SOCKET: "/fake.sock", HC_SOCKET: "/other.sock" }, options), ["/fake.sock"]);
  assert.deepEqual(coreSockets({ AUTOMAGIK_HERDR_CORE_SOCKET: "relative", HC_SOCKET: "/other.sock" }, options), []);
  assert.deepEqual(coreSockets({ HC_SOCKET: "/other.sock", HC_SESSION: "../bad" }, options), ["/other.sock"]);
  assert.deepEqual(coreSockets({ HC_SOCKET: "relative" }, options), []);
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
});
test("coreSockets: invalid sessions name no socket", () => {
  for (const session of [".", "..", "../x", "a/b", "a b", "a\nb"]) assert.deepEqual(coreSockets({ HC_SESSION: session }, options), []);
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
  for (const bad of ["relative.sock", "/garbage", "", "not a path\n/ignored.sock"]) {
    writeFileSync(lock, bad);
    assert.deepEqual(coreSockets(env, options), [first]);
  }
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

async function serving(t, answer) {
  const dir = shortSocketDir(t, "hc-rpc-");
  const path = join(dir, "core.sock");
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
