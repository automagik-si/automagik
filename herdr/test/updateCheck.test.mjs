// The mod's update check (A14, updateCheck.js) and the CLI's `update` (A15): which node runs
// update.mjs, what its answer means, when to look again, one notice per version; and
// `automagik-herdr update` over a fake GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { announce, CHECK_EVERY_MS, EXEC_TIMEOUT_MS, NODE_PATHS, RETRY_MS, SHOWN_KEY, nextCheckIn, nodeOrder, noticeFor, readCheck, runCheck, shownFrom } from "../mods/am-sidebar/updateCheck.js";
import { POINTER_SIG_URL, POINTER_URL } from "../mods/am-sidebar/release.js";
import { keys, pointerBytes, signatureOf } from "./pointer.mjs";
import { cmdUpdate, CliError } from "../mods/am-sidebar/bin/automagik-herdr.mjs";

const UP = { version: "0.2.0", tag: "v0.2.0", page: "https://github.com/automagik-dev/automagik/releases/tag/v0.2.0" };
const line = (o) => `${JSON.stringify(o)}\n`;
/** Herdr's exec over a table node path → result, "missing" (rejects: can't start) or a function. */
const fakeExec = (table, calls = []) => async (command, args) => {
  calls.push([command, ...args]);
  const r = table[command] ?? "missing";
  if (r === "missing") throw new Error(`${command}: not found`);
  return typeof r === "function" ? r(args) : r;
};

test("nodeOrder: PATH, then Homebrew (Apple silicon), then /usr/local; the one that worked first", () => {
  assert.deepEqual(NODE_PATHS, ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]);
  assert.deepEqual(nodeOrder(), NODE_PATHS);
  assert.deepEqual(nodeOrder("/usr/local/bin/node"), ["/usr/local/bin/node", "node", "/opt/homebrew/bin/node"]);
  assert.deepEqual(nodeOrder("/tmp/evil"), NODE_PATHS, "only a listed node is remembered");
});

test("runCheck: node missing from a Dock-started Herdr's PATH, found under /opt/homebrew", async () => {
  const calls = [];
  const exec = fakeExec({ "/opt/homebrew/bin/node": { code: 0, stdout: line({ current: "0.1.0", latest: "0.2.0", update: UP }), stderr: "" } }, calls);
  const r = await runCheck(exec, "/app/mods/am-sidebar/update.mjs");
  assert.equal(r.node, "/opt/homebrew/bin/node");
  assert.deepEqual(calls.map((c) => c[0]), ["node", "/opt/homebrew/bin/node"]);
  assert.deepEqual(calls[1].slice(1), ["/app/mods/am-sidebar/update.mjs", "check"]);
  assert.equal(readCheck(r.result).kind, "update");
});

test("runCheck: a node too old to load update.mjs is passed over; none at all is null", async () => {
  const old = { code: 1, stdout: "", stderr: "SyntaxError: Cannot use import statement outside a module" };
  const r = await runCheck(fakeExec({ node: old, "/usr/local/bin/node": { code: 0, stdout: line({ current: "0.1.0", latest: "0.1.0", update: null }) } }), "u.mjs");
  assert.equal(r.node, "/usr/local/bin/node");
  assert.equal(readCheck(r.result).kind, "current");
  const lone = await runCheck(fakeExec({ node: old }), "u.mjs");
  assert.deepEqual([lone.node, readCheck(lone.result).kind], [null, "retry"]);
  const none = await runCheck(fakeExec({}), "u.mjs");
  assert.deepEqual(none, { node: null, result: null });
  assert.deepEqual(readCheck(none.result), { kind: "retry", why: "node not found" });
});

test("runCheck: a node that never answers is given up after EXEC_TIMEOUT_MS and the next one tried", async () => {
  assert.equal(EXEC_TIMEOUT_MS, 30_000);
  const calls = [];
  const exec = fakeExec({
    node: () => new Promise(() => {}), // hangs for ever
    "/opt/homebrew/bin/node": { code: 0, stdout: line({ current: "0.1.0", latest: "0.2.0", update: UP }) },
  }, calls);
  const waits = [];
  const sleep = (ms) => { waits.push(ms); return new Promise((done) => setTimeout(done, 5)); };
  const r = await runCheck(exec, "u.mjs", null, { sleep });
  assert.equal(r.node, "/opt/homebrew/bin/node");
  assert.deepEqual(waits, [EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS]);
  // Every node hanging: no answer, a retry later, and the check itself still ends.
  const stuck = await runCheck(fakeExec({ node: () => new Promise(() => {}) }), "u.mjs", null, { sleep, timeoutMs: 1 });
  assert.deepEqual(stuck, { node: null, result: null });
});

test("runCheck: --mods names the app home's mods folder, so the installed version is that Herdr's", async () => {
  const calls = [];
  await runCheck(fakeExec({ node: { code: 0, stdout: line({ current: "0.1.0", latest: "0.1.0", update: null }) } }, calls),
    "/home/x/app/mods/am-sidebar/update.mjs", null, { mods: "/home/x/app/mods" });
  assert.deepEqual(calls[0], ["node", "/home/x/app/mods/am-sidebar/update.mjs", "check", "--mods", "/home/x/app/mods"]);
});

test("the announced version is kept in shared: a reload or a second view doesn't announce it again", () => {
  assert.equal(SHOWN_KEY, "am.sidebar.update-shown");
  assert.deepEqual([shownFrom(undefined), shownFrom(null), shownFrom(5), shownFrom(""), shownFrom("0.2.0")], [null, null, null, null, "0.2.0"]);
  // Herdr's shared values as a map and its notify as a log, through the mod's own announce().
  const shared = new Map();
  const posted = [];
  const get = (k) => shared.get(k);
  const set = (k, v) => { shared.set(k, v); };
  const post = (n) => { posted.push(n); };
  const found = { kind: "update", update: UP };
  assert.ok(announce(found, get, set, post), "first view, first time: one notice");
  assert.equal(shared.get(SHOWN_KEY), "0.2.0");
  assert.equal(announce(found, get, set, post), null, "a second view, or the same view after a reload");
  assert.equal(announce({ kind: "retry" }, get, set, post), null);
  assert.equal(posted.length, 1);
  assert.ok(announce({ kind: "update", update: { ...UP, version: "0.3.0" } }, get, set, post), "a newer version is announced");
  assert.deepEqual(posted.map((n) => n.body.match(/Herdr (\S+) is out/)[1]), ["0.2.0", "0.3.0"]);
});

test("readCheck: an {error}, a non-zero exit or garbage is a retry, never an error to show", () => {
  assert.deepEqual(readCheck({ code: 1, stdout: line({ error: "fetch failed" }) }), { kind: "retry", why: "fetch failed" });
  assert.equal(readCheck({ code: 0, stdout: line({ error: "GitHub answered 403" }) }).kind, "retry");
  assert.equal(readCheck({ code: 0, stdout: "not json" }).kind, "retry");
  assert.equal(readCheck({ code: 0, stdout: line({ current: "0.1.0", latest: null, update: null, disabled: true }) }).kind, "off");
  assert.deepEqual(readCheck({ code: 0, stdout: `warning\n${line({ current: "0.1.0", latest: "0.2.0", update: UP })}` }), { kind: "update", update: UP });
  assert.equal(readCheck({ code: 0, stdout: line({ current: "0.1.0", latest: "0.2.0", update: { version: 2 } }) }).kind, "current");
});

test("nextCheckIn and noticeFor: retry after RETRY_MS, then every CHECK_EVERY_MS; one notice per version", () => {
  assert.equal(nextCheckIn("retry"), RETRY_MS);
  assert.equal(nextCheckIn("current"), CHECK_EVERY_MS);
  assert.equal(nextCheckIn("update"), CHECK_EVERY_MS);
  assert.equal(nextCheckIn("off"), null);
  const n = noticeFor({ kind: "update", update: UP });
  assert.equal(n.level, "info");
  assert.match(n.body, /0\.2\.0 is out\. Run `am update`/);
  assert.equal(noticeFor({ kind: "update", update: UP }, "0.2.0"), null);
  assert.equal(noticeFor({ kind: "retry" }), null);
});

// ---- the CLI ----

/** The herdr-lane release serving a pointer to `version`, signed by the test key (or another, `untrusted`). */
const served = (version, { untrusted = false } = {}) => {
  const bytes = pointerBytes(version);
  return { [POINTER_URL]: bytes, [POINTER_SIG_URL]: signatureOf(bytes, { untrusted }) };
};
const fetchOf = (table) => async (url) => {
  const body = table[url];
  if (body instanceof Error) throw body;
  if (body === undefined) return new Response("not found", { status: 404 });
  return new Response(body);
};
function mods(t, version = "0.1.0") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automagik-herdr-up-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "mods");
  mkdirSync(join(dir, "am-sidebar"), { recursive: true });
  writeFileSync(join(dir, "am-sidebar/VERSION"), `${version}\n`);
  return { root, dir };
}

test("am update --check reports current and latest", async (t) => {
  const { dir } = mods(t);
  const io = { modsDir: dir, env: {}, keys };
  assert.equal(await cmdUpdate({ check: true }, [], { ...io, fetch: fetchOf(served("0.1.0")) }),
    "Automagik Herdr 0.1.0 is installed; the latest release is 0.1.0. Up to date.");
  assert.match(await cmdUpdate({ check: true }, [], { ...io, fetch: fetchOf(served("0.2.0")) }),
    /^Automagik Herdr 0\.1\.0 is installed; 0\.2\.0 is out \(https:\/\/github\.com\/automagik-dev\/automagik\/releases\/tag\/v0\.2\.0\)\. Run `am update` to install it\.$/);
  const json = await cmdUpdate({ check: true, json: true }, [], { ...io, fetch: fetchOf(served("0.2.0")) });
  assert.deepEqual([json.current, json.latest, json.update.version], ["0.1.0", "0.2.0", "0.2.0"]);
  await assert.rejects(cmdUpdate({ check: true }, [], { ...io, fetch: fetchOf(served("0.2.0", { untrusted: true })) }),
    (e) => e instanceof CliError && e.code === 1 && /signature does not match: refusing it/.test(e.message), "a pointer signed by another key is refused");
  assert.equal(await cmdUpdate({ check: true }, [], { ...io, fetch: fetchOf({}) }),
    "Automagik Herdr 0.1.0 is installed; the latest release is none yet. Up to date.");
  assert.match(await cmdUpdate({ check: true }, [], { modsDir: dir, env: { AUTOMAGIK_HERDR_NO_UPDATE: "1" }, fetch: fetchOf({}) }), /Updates are off \(AUTOMAGIK_HERDR_NO_UPDATE=1\)/);
});

test("am update: the network down is one clear line, exit 1; flag misuse exit 2", async (t) => {
  const { dir } = mods(t);
  const down = fetchOf({ [POINTER_URL]: new TypeError("fetch failed") });
  await assert.rejects(cmdUpdate({ check: true }, [], { modsDir: dir, env: {}, keys, fetch: down }),
    (e) => e instanceof CliError && e.code === 1 && e.message === "Couldn't check for updates: fetch failed");
  await assert.rejects(cmdUpdate({}, [], { modsDir: dir, env: {}, keys, fetch: down }), (e) => e instanceof CliError && /^Not updated: fetch failed/.test(e.message));
  await assert.rejects(cmdUpdate({ check: true, rollback: true }, [], { modsDir: dir }), (e) => e instanceof CliError && e.code === 2);
  await assert.rejects(cmdUpdate({ rollback: true }, [], { modsDir: dir }), (e) => e instanceof CliError && /^Nothing rolled back: no earlier pack kept/.test(e.message));
});

const BIN = new URL("../mods/am-sidebar/bin/", import.meta.url).pathname;
const run = (file, args, env = {}) => spawnSync(process.execPath, [join(BIN, file), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("the program: update --check --json with updates off touches no network", (t) => {
  const { root } = mods(t);
  const r = run("automagik-herdr.mjs", ["update", "--check", "--json"], { HERDR_APP_HOME: root, AUTOMAGIK_HERDR_NO_UPDATE: "1" });
  assert.equal(r.status, 0, r.stderr);
  const { auto, ...answer } = JSON.parse(r.stdout);
  assert.deepEqual(answer, { current: "0.1.0", latest: null, update: null, disabled: true });
  assert.equal(auto.on, true, "Install updates automatically is on by default");
});
