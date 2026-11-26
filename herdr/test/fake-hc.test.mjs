// The CLI tests' stand-in hc (fake-hc.mjs) under concurrent use: the CLI runs several hc calls at
// once (hc get of every helper, Promise.all), and a call that changes the state saves the whole
// file. A reader must never see a file part-way through a save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLines, readJsonLines } from "./log-lines.mjs";

const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;

/** One fake hc call: resolves { code, stderr }. */
function call(env, args) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [FAKE_HC, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => done({ code, stderr }));
  });
}

test("fake hc: many calls at once that save and read the state never read it part-way through a save", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-fakehc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "hc.json");
  const log = join(root, "hc.log");
  // A large state (about a megabyte) so a save takes long enough for a reader to land inside it.
  const terminals = Array.from({ length: 3000 }, (_, n) => ({ address: `t${n}`, name: `t${n}`, cwd: "/x", state: "live", parent: null,
    created_ms: 1, labels: { note: "x".repeat(200) }, foreground: { argv: ["claude"], cwd: "/x" }, status: { app: "claude-code", state: "idle" } }));
  writeFileSync(state, JSON.stringify({ terminals, next: 5000 }));
  writeFileSync(log, "");
  const env = { ...process.env, HC_FAKE_STATE: state, HC_FAKE_LOG: log };
  for (let round = 0; round < 4; round += 1) {
    // Writers (label saves the state) and readers (get) together.
    const calls = Array.from({ length: 24 }, (_, n) => (n % 2
      ? call(env, ["label", `t${n}`, `round=${round}`])
      : call(env, ["get", `t${n}`, "--json"])));
    const results = await Promise.all(calls);
    const torn = results.filter((r) => /SyntaxError|Unexpected end of JSON|Unexpected token/.test(r.stderr));
    assert.deepEqual(torn.map((r) => r.stderr.split("\n").find((l) => /Error/.test(l))), [], `round ${round}: a call read a torn state file`);
    assert.deepEqual(results.map((r) => r.code), results.map(() => 0), results.map((r) => r.stderr).join("\n"));
  }
  // The file left behind is whole, and no temp file is left beside it.
  assert.equal(JSON.parse(readFileSync(state, "utf8")).terminals.length, 3000);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(root).filter((f) => f.includes(".tmp")), []);
});

// #421: a call appends its line to the shared log while another call reads it, and that read can
// see the last line only part written. The readers keep complete lines; the next read sees it.
test("fake logs: a read leaves out a last line not yet ended by its newline; the next read has it (#421)", (t) => {
  assert.deepEqual(completeLines(""), []);
  assert.deepEqual(completeLines("a\nb"), ["a"]);
  assert.deepEqual(completeLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(completeLines("a\n\nb\n"), ["a", "b"]);
  const root = mkdtempSync(join(tmpdir(), "hb-fakelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "hc.log");
  // The log as CI run 42117078205 read it: the last line cut 4 characters in.
  writeFileSync(log, '["get","t0"]\n["ge');
  assert.throws(() => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)), SyntaxError,
    "the old reader parsed the cut line");
  assert.deepEqual(readJsonLines(log), [["get", "t0"]]);
  appendFileSync(log, 't","t9"]\n');
  assert.deepEqual(readJsonLines(log), [["get", "t0"], ["get", "t9"]]);
});

// CI run 44589606763: state.execTimedOut ["-lc"] is meant for the login-shell probe, yet it matched
// the whole argv, so a `test -d` of a scratch path drawn as hb-panes-lc… "timed out" (1 run in 961).
// The word matches the program (its sh -c script, else its command), never its data arguments.
test("fake hc: execTimedOut matches the program's own words, never a data path that holds them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-fakehc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "hc.json");
  writeFileSync(state, JSON.stringify({ execTimedOut: ["-lc"], terminals: [],
    machines: [{ name: "vm", state: "connected", uname: "Linux x86_64", home: root }] }));
  const env = { ...process.env, HC_FAKE_STATE: state, HC_FAKE_LOG: join(root, "hc.log") };
  const exec = (...argv) => {
    const r = spawnSync(process.execPath, [FAKE_HC, "exec", "--json", "--on", "vm", "--", ...argv], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).timed_out;
  };
  assert.equal(exec("test", "-d", join(root, "hb-panes-lcAbC1")), false, "a data path holding -lc is no login shell");
  assert.equal(exec("sh", "-c", 'exec "$0" -lc "$1"', "sh", "true"), true, "the login shell's script still times out");
});
