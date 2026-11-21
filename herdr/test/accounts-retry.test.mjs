// Process-only: the detached launcher runs a scratch stub that records its arguments.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MACHINES_EVERY_MS, SETTING_FILE, START_ACCOUNTS, startAccountsRetry, startCycle } from "../mods/am-sidebar/machineUpdates.js";
import { PLAN_FILE } from "../mods/am-sidebar/accountsPlanRecord.js";
import { exe, json, scene } from "./accounts-fixture.mjs";

test("startAccountsRetry only starts when the enabled mod manifest and plan both read", async () => {
  const calls = [];
  const args = { appHome: "/example-home/app", exec: (...words) => { calls.push(words); } };
  const files = new Map();
  args.readText = async (path) => {
    if (!files.has(path)) throw new Error();
    return files.get(path);
  };
  files.set(join(args.appHome, "mods-disabled/am-quota/mod.json"), "{}");
  files.set(join(args.appHome, PLAN_FILE), "");
  assert.deepEqual(await startAccountsRetry(args), { started: false, why: "off" });
  files.set(join(args.appHome, "mods/am-quota/mod.json"), "{}");
  files.delete(join(args.appHome, PLAN_FILE));
  assert.deepEqual(await startAccountsRetry(args), { started: false, why: "no-plan" });
  assert.deepEqual(calls, []);
  files.set(join(args.appHome, PLAN_FILE), "{}");
  assert.deepEqual(await startAccountsRetry(args), { started: true });
  assert.deepEqual(calls, [["sh", ["-c", START_ACCOUNTS, "sh", args.appHome]]]);
  args.exec = () => { throw new Error("CANARY-SHELL-0043"); };
  assert.deepEqual(await startAccountsRetry(args), { started: false, why: "no-shell" });
});

test("START_ACCOUNTS detaches the retry from the shared hourly cycle even with linked updates off", async (t) => {
  const s = scene(t, { scratchClaude: true });
  const bin = join(s.app, "mods/am-sidebar/bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "automagik-herdr"), reader = join(bin, "accounts.mjs");
  const started = join(s.root, "started"), finished = join(s.root, "finished"), release = join(s.root, "release");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  writeFileSync(reader, "");
  exe(join(bin, "run.sh"), `#!/bin/sh
printf '%s\\n' "$HERDR_APP_HOME" "$@" > "${started}.tmp"
mv "${started}.tmp" "${started}"
while [ ! -f "${release}" ]; do sleep 0.02; done
: > "${finished}"
`);
  json(join(s.app, "mods/am-quota/mod.json"), {});
  json(join(s.app, PLAN_FILE), {});
  writeFileSync(join(s.store, SETTING_FILE), "off\n");
  const exec = async (program, words) => {
    assert.equal(program, "sh");
    assert.equal(s.env.HERDR_APP_BIN, "/bin/false");
    for (const key of ["HOME", "XDG_CONFIG_HOME", "HERDR_APP_HOME", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME",
      "AUTOMAGIK_HERDR_CORE_SOCKET"]) assert.ok(s.env[key].startsWith(s.root + "/"));
    assert.equal(s.env.AUTOMAGIK_HERDR_TEST_ROOTS, s.root);
    return promisify(execFile)(program, words, { cwd: s.root, env: s.env, timeout: 3000 });
  };
  let last = null;
  const now = 2 * MACHINES_EVERY_MS;
  const cycle = { exec, cli, now: () => now, get: () => last, set: (key, value) => { last = value; } };
  const waitFor = async (path) => {
    for (let i = 0; i < 100 && !existsSync(path); i += 1) await delay(20);
    assert.ok(existsSync(path), path);
  };
  try {
    assert.deepEqual(await startCycle(cycle), { started: true });
    assert.deepEqual(await startAccountsRetry({ exec, appHome: s.app, readText: (path) => readFileSync(path, "utf8") }), { started: true });
    await waitFor(started);
    assert.deepEqual(readFileSync(started, "utf8").trimEnd().split("\n"), [s.app, reader, "apply", "--retry"]);
    assert.equal(existsSync(finished), false);
    assert.deepEqual(await startCycle(cycle), { started: false, why: "fresh" });
    assert.equal(readFileSync(join(s.store, SETTING_FILE), "utf8"), "off\n");
  } finally {
    writeFileSync(release, "");
    if (existsSync(started)) await waitFor(finished);
  }
});
