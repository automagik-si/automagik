// Managed Claude seats with injected linked reads. The only child is sh on a scratch folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { exceptionWarning, folderVerdict, managedLogin, routeManaged } from "../mods/am-sidebar/accountsLaunch.js";
import { exceptions } from "../mods/am-sidebar/accountsHere.js";
import { readHere } from "../mods/am-sidebar/accountsFleet.js";
import { buildPreview, commitPreview } from "../mods/am-sidebar/accountsPlan.js";
import { paneEnvOf } from "../mods/am-sidebar/agentPath.mjs";
import { nextObs } from "../mods/am-sidebar/accountsRows.js";
import { fleetRows } from "../mods/am-quota/fleet.js";
import { emptyPlan, parsePlan, planText, routeManaged as planRouteManaged } from "../mods/am-sidebar/accountsPlanRecord.js";
import { claudeLauncher, DEADLINE_MARGIN_MS, DEADLINE_PLACE_MS, managedLoginOn, setLoginRun } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { FOLDER_SCRIPT } from "../mods/am-sidebar/loginProbe.js";
import { chooseLogin, DEFAULT_WORDS } from "../mods/am-sidebar/logins.js";
import { setLoginOp } from "../mods/am-sidebar/accountsWrite.js";
import { scratchRoot } from "./scratch-project.mjs";
import { AT, fixtureHere } from "./accounts-fixture.mjs";

const CORE = "core-one", MACHINE = "vm-one", BOT = { name: "Demo" };
const HOME = "/scratch/target", APP = HOME + "/.config/herdr-app", SLOT = HOME + "/claude-2";
const BIND = { complete: true, list: [{ id: CORE, name: MACHINE, connected: true }] };
const ENV = { unread: false, refused: false, appHome: null, prepend: null };
const warning = (why) => exceptionWarning(BOT.name, MACHINE, why);
const except = (why) => ({ words: null, warning: warning(why) });
const record = (use = "2", dir = SLOT) => JSON.stringify({ use, logins: [{ id: "2", dir }] });
const runFile = promisify(execFile);

function approved() {
  const at = "2026-11-20T00:00:00.000Z";
  const plan = emptyPlan(at);
  plan.rev = 1;
  plan.names[CORE] = MACHINE;
  plan.claude.members[CORE] = { home: APP, since: at };
  return planText(plan);
}

const CLI = { kind: "pack", dir: "/scratch/cli", version: "3.160.3" };
const launchWords = ["--launch-login", "--expect-home", APP, "--expect-core", CORE];

function scene({ text = record(), plan = approved(), target = {}, ...over } = {}) {
  const calls = [];
  const io = {
    readPlanFile: () => parsePlan(plan),
    deadlineLeft: () => Infinity, now: Date.now,
    machines: async (opts) => { calls.push(["machines", opts]); return BIND; },
    discover: async (machine, limit) => { calls.push(["discover", machine, limit]); return CLI; },
    resolve: async (machine, cli, words, limit) => {
      calls.push(["resolve", machine, cli, words, limit]);
      const { op } = setLoginOp({ "launch-login": true, "expect-home": words[2], "expect-core": words[4],
        "project-home": words.includes("--project-home") });
      return setLoginRun(op, { appHome: () => APP, coreHere: async () => CORE, kind: () => "dir",
        readBytes: () => {
          if (text === null) throw Object.assign(new Error(), { code: "ENOENT" });
          return Buffer.from(text);
        },
        form: { home: HOME, realpath: (p) => p, isDir: () => true }, ...target });
    },
    ...over,
  };
  return { calls, run: (env = ENV, core = CORE, launcher) => managedLoginOn(MACHINE, core, env, BOT, io, launcher) };
}

const seatArgs = (login) => {
  const argv = startArgs({ botId: "b-demo", cwd: "/scratch/project", name: "Demo", parent: ["--no-parent"],
    argv: ["claude", "--continue"], path: "/scratch/bin", env: { HERDR_APP_HOME: APP }, login, guard: null });
  argv.splice(1, 0, "--on", MACHINE);
  return argv;
};

test("Manage predicts the selected slot for managed start and plain restart when the inherited login is signed out", async () => {
  const email = "ana@example.test";
  const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
  const answer = fixtureHere({ email });
  const slot = { id: "2", dir: SLOT, state: "eligible", email };
  Object.assign(answer.claude, {
    record: "ok", snapshot: sha256Hex(record()), selected: slot.id, effective: slot.id,
    slots: [{ id: "default", dir: null, state: "not-signed-in", email: null }, slot],
    routes: { ...answer.claude.routes, bare: { state: "not-signed-in", email: null } },
  });
  const base = { state: "absent", rev: 0 };
  const options = { now: Date.parse(AT), sha256Hex };
  const { preview } = buildPreview({ plan: null, base, request: { v: 1, kind: "manage" }, ...options,
    views: [{ id: CORE, name: MACHINE, appHome: APP, read: true, readAt: AT, qualified: true, claude: answer.claude }] });
  assert.equal(preview.changes[0].join, true);
  const { plan } = commitPreview(null, base, preview, { expectRev: 0, ...options });
  const login = await scene({ plan: planText(plan) }).run();
  assert.deepEqual(login, { words: [`CLAUDE_CONFIG_DIR=${SLOT}`], warning: null });
  assert.ok(seatArgs(login.words).includes(`CLAUDE_CONFIG_DIR=${slot.dir}`));
  assert.deepEqual(preview.changes[0].routes, {
    now: { start: "not-signed-in", tree: email }, next: { start: slot.email, tree: slot.email },
  });
});

test("RFC fixture: an inherited slot 2 is unset for default and selected for use 2, like a local launch", async () => {
  for (const use of ["default", "2"]) {
    const text = record(use);
    const { run, calls } = scene({ text, now: () => 0 });
    const local = chooseLogin(APP, { read: () => text, realpath: (p) => p, isDir: () => true, home: HOME });
    const words = use === "default" ? DEFAULT_WORDS : [`CLAUDE_CONFIG_DIR=${SLOT}`];
    assert.deepEqual(await run(), { words, warning: null });
    assert.deepEqual(words, local.words);
    assert.deepEqual(calls, [["machines", { timeout: 20_000 }], ["discover", MACHINE, 20_000],
      ["resolve", MACHINE, CLI, launchWords, 20_000]]);
  }
  assert.deepEqual(await scene({ text: null }).run(), { words: DEFAULT_WORDS, warning: null });
});

test("hc run puts the unset first, the slot assignment last, and preserves the old argv without login words", async () => {
  const run = ["run", "--on", MACHINE, "--bg", "--json", "--name", "Demo", "--cwd", "/scratch/project",
    "--label", "bot=b-demo", "--no-parent", "--", "/usr/bin/env"];
  const vars = ["PATH=/scratch/bin", `HERDR_APP_HOME=${APP}`], claude = ["claude", "--continue"];
  const defaultLogin = await scene({ text: record("default") }).run();
  const slot = await scene().run();
  assert.deepEqual(seatArgs(defaultLogin.words), [...run, "-u", "CLAUDE_CONFIG_DIR", ...vars, ...claude]);
  assert.deepEqual(seatArgs(slot.words), [...run, ...vars, `CLAUDE_CONFIG_DIR=${SLOT}`, ...claude]);
  assert.deepEqual(seatArgs(undefined), [...run, ...vars, ...claude]);
});

test("an unreadable managed login record preserves the inherited seat and gives a fixed warning", async () => {
  for (const code of ["EACCES", "EIO"]) {
    const target = { readBytes: () => { throw Object.assign(new Error("CANARY-STDERR-0043"), { code }); } };
    const launch = await scene({ target }).run();
    assert.deepEqual(launch, except("unread"));
    assert.deepEqual(seatArgs(launch.words ?? []), seatArgs());
    assert.doesNotMatch(launch.warning, /CANARY-STDERR-0043/);
  }
});

test("missing, symlinked and file slots, the default folder, a bad record and unlisted use give a fixed fallback", async () => {
  const dir = join(HOME, "CANARY-PLAN-0043");
  for (const folder of ["missing", "symlink", "notdir"]) {
    const result = await scene({ text: record("2", dir), target: { form: { home: HOME, isDir: () => folder === "ok", realpath: (p) => {
      if (folder === "missing") throw new Error();
      return folder === "symlink" ? p + "/elsewhere" : p;
    } } } }).run();
    assert.deepEqual(result, { words: DEFAULT_WORDS, warning: "Demo's Claude login on vm-one couldn't be followed: it starts with the default login." });
  }
  for (const text of ["{", record("3"), record("2", HOME + "/.claude"), record("2", SLOT + "\n")]) {
    assert.deepEqual(await scene({ text }).run(), { words: DEFAULT_WORDS, warning: warning("fallback") });
  }
  assert.deepEqual(managedLogin({ member: { home: APP }, home: "/scratch/other", text: "{}", bot: BOT.name, machine: MACHINE }),
    except("other-home"));
});

test("no plan, corrupt or newer plan, or another core makes zero linked calls", async () => {
  for (const [plan, core] of [[null, CORE], ["{", CORE], ['{"v":2}', CORE], ['{"v":3}', CORE], [approved(), "core-two"]]) {
    const s = scene({ plan });
    assert.equal(await s.run(ENV, core), null);
    assert.deepEqual(s.calls, []);
  }
});

test("a readable stopped v2 plan still supplies managed linked login words", async () => {
  const v1 = scene({ now: () => 0 });
  const v2 = scene({ now: () => 0, plan: JSON.stringify({ ...JSON.parse(approved()), v: 2, stopped: true, retries: "pack" }) });
  assert.deepEqual(await v2.run(), await v1.run());
  assert.deepEqual(v2.calls, v1.calls);
  assert.ok(v2.calls.some(([step]) => step === "resolve"));
});

test("project and transport exceptions leave the old argv and give only a fixed warning", async () => {
  const fail = async () => { throw new Error("CANARY-RPC-0043 ana@example.test /scratch/private"); };
  const cases = [
    [{ appHome: APP + "-other" }, {}, "other-home", false],
    [{ prepend: "/scratch/private" }, {}, "own-path", false],
    [{ unread: true, refused: true }, {}, "unread", false],
    [{ refused: true }, {}, "refused-env", false],
    [{}, { deadlineLeft: () => DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS + 4999 }, "late", false],
    [{}, { machines: async () => ({ ...BIND, list: [{ ...BIND.list[0], id: "core-two" }] }) }, "rebound", false],
    [{}, { machines: async () => ({ ...BIND, complete: false }) }, "rebound", false],
    [{}, { machines: async () => ({ complete: true, list: [...BIND.list, { ...BIND.list[0], id: "core-two" }] }) }, "rebound", false],
    [{}, { machines: async () => null }, "rebound", false],
    [{}, { machines: fail }, "rebound", false],
    [{}, { target: { kind: () => "none" } }, "no-home", true],
    [{}, { target: { form: { home: HOME + "-other" } } }, "other-home", true],
    [{}, { discover: fail }, "unread", true],
    [{}, { resolve: fail }, "unread", true],
    [{}, { resolve: async () => null }, "unread", true],
    [{}, { resolve: async () => ({ ok: true, core: CORE, home: APP, dir: "relative", fallback: false }) }, "unread", true],
    [{}, { resolve: async () => ({ ok: true, core: CORE, home: APP, dir: SLOT + "\nCANARY-RPC-0043", fallback: false }) }, "unread", true],
  ];
  for (const [env, opts, why, resolved] of cases) {
    const s = scene(opts);
    const result = await s.run({ ...ENV, ...env });
    assert.deepEqual(result, except(why), why);
    assert.deepEqual(seatArgs(result.words ?? []), seatArgs(), why);
    assert.doesNotMatch(result.warning, /CANARY-RPC-0043|ana@example\.test|\/scratch\//);
    assert.ok(s.calls.some(([step]) => step === "machines") === resolved, why);
  }
});

test("Restart only displays the managed login when the project resolves to its approved home", async () => {
  const project = "/scratch/project";
  const recordEmail = "ana@example.test", inherited = "bo@example.test";
  const plan = parsePlan(approved()).plan;
  for (const appHome of [null, APP]) {
    const paneEnv = appHome ? `HERDR_APP_HOME=${appHome}` : null;
    const projects = exceptions({ home: HOME + "-unmanaged", appHome: APP, paneEnvOf, readBytes(path) {
      if (path === `${project}/.herdr/pane-env` && paneEnv) return paneEnv;
      throw Object.assign(new Error(), { code: "ENOENT" });
    } }, [project]);
    assert.deepEqual(projects.bound, []);
    assert.deepEqual(projects.defaults?.bound ?? [], appHome ? [] : [project]);
    const fixture = fixtureHere({ email: recordEmail });
    fixture.claude.routes.bare.email = inherited;
    const answer = readHere(JSON.stringify({ ...fixture, exceptions: projects }));
    assert.deepEqual(answer.exceptions, projects);
    const entry = { ...answer, core: CORE, appHome: APP, state: "read", at: AT,
      claude: nextObs("claude", null, answer.claude, AT), exceptions: projects };
    const bot = { id: "b-aaaaaaaaaa", project };
    const [row] = fleetRows({ record: { at: AT, machines: { [CORE]: entry } }, tool: "claude", ref: {},
      now: Date.parse(AT), plan, answer: { at: AT, bots: { [CORE]: { claude: [bot] } } } });
    const s = scene({ target: { form: { home: HOME + "-unmanaged" } }, text: record("default") });
    const result = await s.run({ ...ENV, appHome });
    if (appHome) {
      assert.match(row.restart, new RegExp(recordEmail));
      assert.ok(seatArgs(result.words).includes("-u"));
    } else {
      assert.equal(row.bots[0].restart, `Restart starts ${inherited}`);
      assert.equal(row.restart, null);
      assert.deepEqual(seatArgs(result.words ?? []), seatArgs());
    }
  }
});

test("a transient name rebound cannot supply login words from another core or app home", async () => {
  const poisoned = { ok: true, core: "core-two", home: APP, dir: HOME + "/other-slot", fallback: false };
  for (const [answer, why] of [[poisoned, "rebound"], [{ ...poisoned, core: CORE, home: APP + "-other" }, "other-home"]]) {
    const { run } = scene({ resolve: async (machine, _cli, words) => {
      assert.equal(machine, MACHINE);
      assert.deepEqual(words, launchWords);
      return answer;
    } });
    assert.deepEqual(await run(), except(why));
  }
  const { run } = scene({ target: { coreHere: async () => "core-two", readBytes: () => assert.fail("read another core's record") } });
  assert.deepEqual(await run(), except("rebound"));
});

test("folder verdict ignores the two advisories and uses the target's own folder check", async (t) => {
  for (const verdict of ["ok", "missing", "symlink", "notdir"]) assert.equal(folderVerdict(`${verdict}\n`), verdict);
  assert.equal(folderVerdict("unlinked settings.json\nunlinked CLAUDE.md\nok\n"), "ok");
  for (const bad of ["", "ok\nunlinked settings.json\n", "unknown\n", "unlinked other\nok\n", " ok\n"]) {
    assert.equal(folderVerdict(bad), null);
  }
  const root = scratchRoot(t, "accounts-launch-");
  const slot = join(root, "claude-2");
  mkdirSync(slot);
  writeFileSync(join(slot, "settings.json"), "{}");
  writeFileSync(join(slot, "CLAUDE.md"), "# Fixture\n");
  const exec = async (cmd, args, on) => {
    assert.equal(on, MACHINE);
    assert.equal(cmd, "sh");
    assert.equal(args.at(-1), slot);
    const env = { PATH: process.env.PATH, HOME: root, HERDR_APP_HOME: join(root, "app"),
      AM_HOME: join(root, "am"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "inherited"),
      HERDR_APP_BIN: "/bin/false", XDG_STATE_HOME: join(root, "state"),
      AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock") };
    const { stdout } = await runFile(cmd, args, { env, cwd: root, encoding: "utf8" });
    assert.equal(stdout, root + "\nunlinked settings.json\nunlinked CLAUDE.md\nok\n");
    return { code: 0, stdout };
  };
  assert.match((await exec("sh", ["-c", 'printf "%s\\n" "$HOME"; exec sh -c "$1" sh "$2"', "sh", FOLDER_SCRIPT, slot], MACHINE)).stdout, /ok/);
  const text = record("2", slot);
  const local = chooseLogin(APP, { read: () => text, realpath: realpathSync, isDir: (p) => statSync(p).isDirectory(), home: root });
  assert.deepEqual(local.words, [`CLAUDE_CONFIG_DIR=${slot}`]);
  assert.deepEqual(await scene({ text, target: {
    form: { home: root, realpath: realpathSync, isDir: (p) => statSync(p).isDirectory() },
  } }).run({ ...ENV, appHome: APP }), { words: local.words, warning: null });
});

test("one deadline bounds a sequence of reads and shrinks their timeouts", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const timeouts = [];
  const budget = 6000, left = DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS + 2000 + budget;
  let startRead;
  const started = new Promise((done) => { startRead = done; });
  const s = scene({
    now: () => Date.now(), deadlineLeft: () => left,
    machines: async ({ timeout }) => { timeouts.push(timeout); t.mock.timers.tick(2000); return BIND; },
    discover: async (_machine, limit) => { timeouts.push(limit); t.mock.timers.tick(2000); return CLI; },
    resolve: async (_machine, _cli, _words, limit) => { timeouts.push(limit); startRead(); return new Promise(() => {}); },
  });
  const at = Date.now(), result = s.run();
  await started;
  assert.deepEqual(timeouts, [6000, 4000, 2000]);
  t.mock.timers.tick(2000);
  assert.deepEqual(await result, except("late"));
  assert.equal(Date.now() - at, budget);
  assert.ok(Date.now() - at < left - DEADLINE_MARGIN_MS - DEADLINE_PLACE_MS);
});

test("a slow folder probe alone uses the deadline and an expired resolver starts no further reads", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let startProbe, finishProbe;
  const started = new Promise((done) => { startProbe = done; });
  const s = scene({
    now: () => Date.now(), deadlineLeft: () => DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS + 5000,
    resolve: async (_machine, _cli, _words, limit) => {
      assert.equal(limit, 3000);
      startProbe();
      return new Promise((done) => { finishProbe = done; });
    },
  });
  const result = s.run();
  await started;
  t.mock.timers.tick(3000);
  assert.deepEqual(await result, except("late"));
  finishProbe({ ok: true, core: CORE, home: APP, dir: SLOT, fallback: false });
  assert.deepEqual(await result, except("late"));
  const nearlyLate = scene({
    now: () => Date.now(), deadlineLeft: () => DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS + 5000,
    machines: async () => { t.mock.timers.tick(2001); return BIND; },
  });
  assert.deepEqual(await nearlyLate.run(), except("late"));
  assert.deepEqual(nearlyLate.calls, []);
});

test("the launch and preview share the rule that only projects without an exception are managed", async () => {
  assert.equal(routeManaged, planRouteManaged);
  assert.equal(routeManaged(null), true);
  for (const why of ["own-path", "own-app-home", "unread"]) assert.equal(routeManaged(why), false, why);
  assert.deepEqual(await scene().run({ ...ENV, appHome: APP }), { words: [`CLAUDE_CONFIG_DIR=${SLOT}`], warning: null });
});

test("a configured Claude wrapper or an unreadable launcher keeps the old linked route", async () => {
  const { calls, run } = scene();
  const wrapper = { claude: { run: ["claude-wrapper"] } };
  assert.deepEqual(await run(ENV, CORE, claudeLauncher(wrapper, "claude-wrapper")), except("own-launcher"));
  assert.deepEqual(await run(ENV, CORE, claudeLauncher(null)), except("unread"));
  const shipped = { claude: { run: ["claude"] } };
  assert.deepEqual(await run(ENV, CORE, claudeLauncher(shipped, "claude-wrapper")), except("own-launcher"));
  assert.deepEqual(calls, []);
  assert.equal(claudeLauncher(shipped), "shipped");
});
