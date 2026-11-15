// automagik-herdr doc get: a herdr-core doc read through `hc connect` (doc.get, read-only), for a
// mod that can only exec a program. test/fake-hc.mjs answers the connect stream; the real hc and
// its docs are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DocError, docGet } from "../mods/am-sidebar/docGet.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const METER = { tasks: { "gl-1": { usd: 1.25, work_min: 30, lead_min: 4 } } };
// Taken before any test mocks setTimeout: that test's own waits stay on the wall clock.
const realSetTimeout = setTimeout;

function scene(t, state = {}) {
  const root = scratchRoot(t, "hb-doc-cli-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, home, app]) mkdirSync(d, { recursive: true });
  const hc = join(bin, "hc");
  writeFileSync(hc, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  chmodSync(hc, 0o755);
  writeFileSync(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "herdr-app"), 0o755);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100, ...state }));
  writeFileSync(logPath, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => readJsonLines(logPath);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  return { cli, calls, hcState, hc, env };
}

test("doc get: the doc's value as one line of JSON, exit 0, through one doc.get on hc connect", (t) => {
  const s = scene(t, { docs: { "herdr-meter": { value: METER, version: 7 } } });
  const r = s.cli(["doc", "get", "herdr-meter"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.equal(r.out, `${JSON.stringify(METER)}\n`);
  assert.deepEqual(s.calls(), [["connect"]]);
  assert.deepEqual(s.hcState().connectRequests, [{ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-meter" } }]);
});

test("doc get: a doc never written, or deleted (value null), exits 3 with nothing on stdout", (t) => {
  const s = scene(t, { docs: { gone: { value: null, version: 4 } } });
  for (const name of ["herdr-meter", "gone"]) {
    const r = s.cli(["doc", "get", name]);
    assert.equal(r.code, 3, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, new RegExp(`No doc ${name}`));
  }
});

test("doc get --machine: herdr-core's on param names the machine; its own docs answer", (t) => {
  const s = scene(t, {
    docs: { "herdr-meter": { value: { here: true }, version: 1 } },
    machines: [{ name: "vm", state: "connected", docs: { "herdr-meter": { value: METER, version: 2 } } },
      { name: "off", state: "disconnected" }],
  });
  const r = s.cli(["doc", "get", "herdr-meter", "--machine", "vm"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), METER);
  assert.deepEqual(s.hcState().connectRequests.at(-1).params, { name: "herdr-meter", on: "vm" });
  assert.equal(s.cli(["doc", "get", "nothing", "--machine", "vm"]).code, 3);
  // A machine hc doesn't know, or one not connected: a failure, not "no such doc".
  for (const m of ["nope", "off"]) {
    const bad = s.cli(["doc", "get", "herdr-meter", "--machine", m]);
    assert.equal(bad.code, 1, bad.err);
    assert.equal(bad.out, "");
    assert.match(bad.err, m === "nope" ? /machine_unknown/ : /unavailable/);
  }
  assert.ok(s.hcState().connectRequests.every((q) => q.method === "doc.get"));
});

test("doc get: a bad name exits 1 before hc is asked", (t) => {
  const s = scene(t);
  for (const name of ["", ".", "..", "a b", "../meter", "x".repeat(129), "doc;rm", "naïve"]) {
    const r = s.cli(["doc", "get", name]);
    assert.equal(r.code, 1, `${name}: ${r.err}`);
    assert.equal(r.out, "");
    assert.match(r.err, /not a doc name/);
  }
  assert.equal(s.cli(["doc", "get", "x".repeat(128)]).code, 3);
  assert.equal(s.cli(["doc", "get", "...meter"]).code, 3);
  assert.deepEqual(s.calls(), [["connect"], ["connect"]]);
});

test("doc: a usage mistake exits 2, hc failing 1, each with a plain message", (t) => {
  const s = scene(t, { fail: ["connect"] });
  for (const args of [["doc"], ["doc", "set", "x"], ["doc", "get"], ["doc", "get", "a", "b"]]) {
    const r = s.cli(args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.equal(r.out, "");
    assert.match(r.err, /^am: doc/);
  }
  assert.deepEqual(s.calls(), []);
  const down = s.cli(["doc", "get", "herdr-meter"]);
  assert.equal(down.code, 1);
  assert.match(down.err, /without an answer.*can't reach the server/);
});

test("doc get: a notification and a broken line before the answer are skipped", (t) => {
  const s = scene(t, {
    docs: { "herdr-meter": { value: METER, version: 7 } },
    connectBefore: ["not json {", JSON.stringify({ jsonrpc: "2.0", method: "doc", params: { name: "herdr-meter", version: 8 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { value: "someone else's", version: 1 } })],
  });
  const r = s.cli(["doc", "get", "herdr-meter"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${JSON.stringify(METER)}\n`);
});

test("doc get: malformed JSON from hc, or an answer with no value, exits 1 with nothing on stdout", (t) => {
  for (const answer of ['{"jsonrpc":"2.0","id":1,"result":{"value":', '{"jsonrpc":"2.0","id":1,"result":{"version":3}}', "[]"]) {
    const s = scene(t, { docs: { "herdr-meter": { value: METER, version: 7 } }, connectAnswer: answer });
    const r = s.cli(["doc", "get", "herdr-meter"]);
    assert.equal(r.code, 1, `${answer}: ${r.err}`);
    assert.equal(r.out, "");
    assert.match(r.err, /^am: hc/);
  }
});

test("docGet: no answer in time is a failure (1), and hc connect is ended", { timeout: 30_000 }, async (t) => {
  const s = scene(t, { connectHang: true });
  // docGet's 2 s runs on a mocked clock that this test moves only once the fake has written its
  // pid, so the fake's start (bin/hc, exec node, imports, the write) races nothing (#426). The
  // wait ends at that write; 20 s is only where a fake that never gets there stops being waited
  // for, and it then fails at the pid below.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refused = assert.rejects(docGet("herdr-meter", { hc: s.hc, env: s.env, timeoutMs: 2000 }), (e) => {
    assert.ok(e instanceof DocError);
    assert.equal(e.code, 1);
    assert.match(e.message, /no answer for doc herdr-meter/);
    return true;
  });
  const startBudget = Date.now() + 20_000;
  while (!s.hcState().connectPid && Date.now() < startBudget) await new Promise((go) => realSetTimeout(go, 20));
  const { connectPid } = s.hcState();
  // A docGet that misses this tick never ends the fake: the test's timeout fails it, and this ends it.
  let alive = true;
  t.after(() => { if (alive && connectPid) { try { process.kill(connectPid, "SIGKILL"); } catch { /* gone */ } } });
  t.mock.timers.tick(2000);
  await refused;
  t.mock.timers.tick(1000); // docGet's grace before its SIGKILL
  t.mock.timers.reset();
  assert.ok(connectPid > 0);
  const deadline = Date.now() + 3000;
  while (alive && Date.now() < deadline) {
    try { process.kill(connectPid, 0); await new Promise((go) => setTimeout(go, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, "hc connect still runs after the timeout");
});

test("docGet: the default timeout is 10 s", async () => {
  const { DOC_TIMEOUT_MS } = await import("../mods/am-sidebar/docGet.mjs");
  assert.equal(DOC_TIMEOUT_MS, 10_000);
});
