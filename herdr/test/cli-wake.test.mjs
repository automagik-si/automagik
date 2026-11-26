// The CLI and a scratch roster, with fake hc on PATH as in cli.test.mjs and cli-remote.test.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { wakeAutomationName } from "../mods/am-sidebar/model.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const ID = "b-aaaaaaaaaa", SPEC = "daily@09:30";
const NEXT = "2026-11-20T09:30:00-03:00", LAST = "2026-11-19T09:30:42-03:00";
const BOT = {
  id: ID, name: "Research", kind: "main", agent: "claude", role: "", instructions: "",
  look: { character: "star", colour: "blue" },
};
const roster = (...bots) => ({ version: 1, categories: [], bots });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
const rosterPath = (project) => join(project, ".herdr/bots.json");
const exe = (path, text) => writeFileSync(path, text, { mode: 0o755 });

// Only the checkout paths matter here. Give Git an unborn branch and a linked checkout.
function checkout(project) {
  const common = join(project, ".git");
  for (const dir of ["objects", "refs"]) mkdirSync(join(common, dir), { recursive: true });
  writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
  return common;
}

function worktree(project, dir) {
  const metadata = join(checkout(project), "worktrees", "wake");
  mkdirSync(metadata, { recursive: true });
  mkdirSync(dir);
  writeFileSync(join(dir, ".git"), "gitdir: " + metadata + "\n");
  writeFileSync(join(metadata, "gitdir"), join(dir, ".git") + "\n");
  writeFileSync(join(metadata, "commondir"), "../..\n");
  writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/wake\n");
}

const fakeScheduler = [
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const argv = process.argv.slice(2);',
  'const stdin = readFileSync(0, "utf8");',
  'const file = (name) => join(process.env.HOME, name);',
  'const read = (path) => JSON.parse(readFileSync(path, "utf8"));',
  'const write = (path, data) => writeFileSync(path, JSON.stringify(data));',
  'const reply = (text) => writeFileSync(1, text + "\\n");',
  'const config = file("scheduler.json"), control = file("scheduler-control.json");',
  'const listing = read(config), plan = read(control);',
  'appendFileSync(file("scheduler.log"), JSON.stringify({ argv, stdin }) + "\\n");',
  'if (argv[0] === "ls" && argv[1] === "--json") {',
  '  if (plan.loseMutationReply) {',
  '    const hc = read(process.env.HC_FAKE_STATE);',
  '    hc.loseExecAnswer = "sh";',
  '    write(process.env.HC_FAKE_STATE, hc);',
  '    delete plan.loseMutationReply;',
  '    write(control, plan);',
  '  }',
  '  reply(plan.lsText ?? JSON.stringify(listing));',
  '} else if (argv[0] === "put") {',
  '  if (plan.putProblem) { reply(JSON.stringify({ problem: plan.putProblem })); process.exit(0); }',
  '  if (plan.putText !== undefined) { reply(plan.putText); process.exit(0); }',
  '  const entry = JSON.parse(stdin);',
  '  const old = listing.automations.findIndex((row) => row.name === argv[2]);',
  '  if (argv[1] === "--original" && old < 0) process.exit(1);',
  '  if (argv.length === 1 && listing.automations.some((row) => row.name === entry.name)) {',
  '    reply(JSON.stringify({ problem: "duplicate name" })); process.exit(0);',
  '  }',
  '  const saved = { disabled: false, last: null, next: ' + JSON.stringify(NEXT) + ', ...listing.automations[old], ...entry, ...plan.drift };',
  '  if (old < 0) listing.automations.push(saved); else listing.automations[old] = saved;',
  '  write(config, listing);',
  '  reply(JSON.stringify({ next: [saved.next] }));',
  '} else if (argv[0] === "rm" && argv.length === 2) {',
  '  listing.automations = listing.automations.filter((row) => row.name !== argv[1]);',
  '  write(config, listing);',
  '  if (plan.rmText !== undefined) reply(plan.rmText);',
  '} else process.exit(2);',
  'if (argv[0] === "put" || argv[0] === "rm") {',
  '  if (plan.failReadBack) plan.lsText = "broken read-back";',
  '  if (plan.edits?.length) {',
  '    const before = read(plan.roster);',
  '    const wake = plan.edits.shift();',
  '    if (wake === null) delete before.bots[0].wake; else before.bots[0].wake = wake;',
  '    write(plan.roster, before);',
  '  }',
  '  write(control, plan);',
  '}',
].join("\n");

function scheduler(home, binary, script) {
  const config = join(home, "scheduler.json");
  const control = join(home, "scheduler-control.json");
  const log = join(home, "scheduler.log");
  const base = { backend: "hc", paused: false, scheduler: 72, config: join(home, "automations.yaml"),
    state: join(home, "scheduler-state"), kinds: ["prompt", "workflow", "command"], targets: ["bot", "worker"],
    automations: [], invalid: [] };
  mkdirSync(home, { recursive: true });
  writeJson(config, base);
  writeJson(control, {});
  writeFileSync(log, "");
  const install = () => exe(binary, '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n');
  return { install, calls: () => readJsonLines(log), resetCalls: () => writeFileSync(log, ""),
    config: () => readJson(config), listing: (fields) => writeJson(config, { ...base, ...fields }),
    control: (plan) => writeJson(control, plan) };
}

function scene(t, { installed = true } = {}) {
  const root = scratchRoot(t, "hb-cli-wake-");
  const home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), bin = join(root, "bin");
  const remoteBin = join(vm, ".local/bin");
  for (const dir of [app, bin, remoteBin]) mkdirSync(dir, { recursive: true });
  // The programs the harness needs, with an isolated PATH on each machine.
  const systemBin = join(root, "system");
  mkdirSync(systemBin);
  for (const program of ["sh", "git", "test", "cat", "mkdir", "rm", "mv", "ln", "chmod"]) {
    const path = execFileSync("sh", ["-c", 'command -v "$1"', "sh", program], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // command -v returns the builtin's bare name for test.
    symlinkSync(path.startsWith("/") ? path : join("/bin", program), join(systemBin, program));
  }
  // Forward the fake's output through regular files so every reply is captured, including failures.
  exe(join(bin, "hc"), [
    "#!/bin/sh", 'reply=$HC_FAKE_LOG.$$',
    '"' + process.execPath + '" "' + FAKE_HC + '" "$@" >"$reply.out" 2>"$reply.err"',
    'code=$?', 'cat "$reply.out"; cat "$reply.err" >&2', 'rm -f "$reply.out" "$reply.err"', 'exit "$code"',
  ].join("\n") + "\n");
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  const script = join(root, "fake-automations.mjs");
  writeFileSync(script, fakeScheduler);
  const local = scheduler(home, join(bin, "herdr-automations"), script);
  const there = scheduler(vm, join(remoteBin, "herdr-automations"), script);
  if (installed) { local.install(); there.install(); }
  const project = scratchProject(root, "project", { isGit: false, bots: roster(BOT) });
  const willWriteHere = rosterPath(project);
  const linked = scratchProject(vm, "field 'notes' and \"ideas\"", { isGit: false, bots: roster(BOT) });
  const on = ["--machine", "vm", "--project", linked];
  const state = join(root, "hc.json"), log = join(root, "hc.log");
  writeJson(state, { next: 100, terminals: [], machines: [{ name: "vm", home: vm, state: "connected", env: { PATH: systemBin } }] });
  writeFileSync(log, "");
  const env = { ...process.env, PATH: bin + ":" + systemBin, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: state,
    HC_FAKE_LOG: log, GIT_CEILING_DIRECTORIES: root, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"), AUTOMAGIK_HERDR_TEST_ROOTS: root,
    AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock"), HC_SOCKET: "", HC_SESSION: "", HC_TERMINAL_SOCKET: "" };
  delete env.HC_TERMINAL_ID;
  const cli = (args, cwd = project) => {
    const outPath = join(root, "stdout"), errPath = join(root, "stderr");
    const outFd = openSync(outPath, "w"), errFd = openSync(errPath, "w");
    try {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, timeout: 15000, stdio: ["ignore", outFd, errFd] });
      assert.ifError(r.error);
      const out = readFileSync(outPath, "utf8"), err = readFileSync(errPath, "utf8");
      return { code: r.status, out, err, json: () => JSON.parse(out) };
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  };
  return { root, project, linked, on, cli, local, there, hcCalls: () => readJsonLines(log),
    edit: (...args) => cli(["edit", ID, ...args, "--json"]),
    seed: (...bots) => writeJson(willWriteHere, roster(...bots)), bots: () => readJson(willWriteHere).bots,
    hcState: (fields) => writeJson(state, { ...readJson(state), ...fields }) };
}

const wakeName = (project) => wakeAutomationName(ID, project);
const wire = (project) => ({
  name: wakeName(project), cron: "30 9 * * *", repo: project, target: "bot:" + ID, target_when_busy: "skip",
  catch_up_minutes: 1380, timeout_minutes: 10,
  prompt: "Scheduled wake (daily 09:30): check your recurring duties from your instructions and do what is due.",
});
const entry = (project, extra = {}) => ({ ...wire(project), disabled: false, next: NEXT, last: null, ...extra });
const argsOf = (scheduler) => scheduler.calls().map(({ argv }) => argv);
const mutations = (scheduler) => scheduler.calls().filter(({ argv }) => argv[0] !== "ls");
const setWake = (s, ...extra) => s.edit("--wake", SPEC, ...extra);

test("set, replace, and clear a wake with the exact put/rm wire contract", (t) => {
  const s = scene(t);
  const set = setWake(s);
  assert.equal(set.code, 0, set.err);
  assert.equal(s.bots()[0].wake, SPEC);
  assert.deepEqual(set.json().wake, { spec: SPEC, scheduled: true, state: "active", problem: null });
  assert.deepEqual(argsOf(s.local), [["ls", "--json"], ["put"], ["ls", "--json"]]);
  assert.deepEqual(JSON.parse(mutations(s.local)[0].stdin), wire(s.project));
  assert.ok(s.local.calls().filter((c) => c.argv[0] === "ls").every((c) => c.stdin === ""));

  s.local.listing({ automations: [entry(s.project, { repo: s.project + "/" })] });
  s.local.resetCalls();
  const changed = s.edit("--wake", "daily@00:00");
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual(mutations(s.local).map((c) => c.argv), [["put", "--original", wakeName(s.project)]]);
  assert.equal(s.local.config().automations[0].cron, "0 0 * * *");

  s.local.resetCalls();
  const clear = s.edit("--no-wake");
  assert.equal(clear.code, 0, clear.err);
  assert.equal(Object.hasOwn(s.bots()[0], "wake"), false);
  assert.deepEqual(clear.json().wake, { spec: null, scheduled: false, state: "not-scheduled", problem: null });
  assert.deepEqual(s.local.calls(), [
    { argv: ["ls", "--json"], stdin: "" }, { argv: ["rm", wakeName(s.project)], stdin: "" },
    { argv: ["ls", "--json"], stdin: "" },
  ]);
  assert.deepEqual(s.local.config().automations, []);
  s.local.resetCalls();
  assert.equal(s.edit("--no-wake").code, 0);
  assert.deepEqual(argsOf(s.local), [["ls", "--json"]]);
});

test("invalid flags exit 2, and a refused roster save never calls the scheduler", (t) => {
  const s = scene(t);
  for (const flags of [["--wake", "daily@24:00"], ["--wake", ""], ["--wake", SPEC, "--no-wake"]]) {
    const r = s.edit(...flags);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /daily@HH:MM|Choose one/);
    assert.equal(Object.hasOwn(s.bots()[0], "wake"), false);
  }
  s.seed(BOT, { ...BOT, id: "b-bbbbbbbbbb", name: "Invalid", kind: "other" });
  const r = setWake(s);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /unknown kind/);
  assert.equal(Object.hasOwn(s.bots()[0], "wake"), false);
  assert.deepEqual(s.local.calls(), []);
});

test("a stale linked roster snapshot makes no scheduler call on either machine", (t) => {
  const s = scene(t);
  s.hcState({ editRace: JSON.stringify(roster({ ...BOT, role: "their change" })) });
  const r = setWake(s, ...s.on);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /changed since it was read/);
  assert.deepEqual(s.local.calls(), []);
  assert.deepEqual(s.there.calls(), []);
});

test("an unrelated CLI edit preserves malformed and empty raw wakes without a scheduler call", (t) => {
  const s = scene(t);
  for (const wake of [" daily@9:30 ", { hour: 9 }, null, ""]) {
    s.seed({ ...BOT, wake });
    const r = s.edit("--role", "changed");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(s.bots()[0].wake, wake);
    assert.equal(s.bots()[0].role, "changed");
  }
  assert.deepEqual(s.local.calls(), []);
});

test("a missing scheduler leaves the wake saved and preserves create output in both modes", (t) => {
  const s = scene(t, { installed: false });
  const edit = setWake(s);
  assert.equal(edit.code, 1, edit.err);
  assert.deepEqual(edit.json().wake, { spec: SPEC, scheduled: false, state: "missing",
    problem: "herdr-automations is missing (checked PATH and ~/.local/bin)" });
  assert.equal(s.bots()[0].wake, SPEC);
  assert.ok(edit.err.includes("Rerun am edit " + ID + " --project " + s.project + " --wake " + SPEC));

  const create = ["create", "--agent", "claude", "--wake", SPEC];
  const text = s.cli([...create, "--name", "Text"]);
  assert.equal(text.code, 1, text.err);
  assert.match(text.out, /^b-[a-z2-7]{10}\n$/);
  assert.match(text.err, /wake daily@09:30 saved.*this computer.*missing/);
  const json = s.cli([...create, "--name", "JSON", "--json"]);
  assert.equal(json.code, 1, json.err);
  const { id, project, bot, relabelled, wake } = json.json();
  assert.equal(id, bot.id);
  assert.equal(project, s.project);
  assert.deepEqual(relabelled, []);
  assert.deepEqual(wake, edit.json().wake);
  assert.deepEqual(s.bots().slice(1).map((b) => [b.id, b.wake]), [[text.out.trim(), SPEC], [id, SPEC]]);
  assert.deepEqual(s.local.calls(), []);
});

test("an old build and the herdr backend give distinct repairs without changing the scheduler", (t) => {
  const s = scene(t);
  for (const [fields, repair] of [
    [{ targets: undefined }, /release after 0\.12\.1-am\.1/],
    [{ targets: undefined, backend: "herdr" }, /set backend: hc in .*automations\.yaml/],
  ]) {
    s.local.listing(fields);
    const r = setWake(s);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.json().wake.state, "no-bot-targets");
    assert.equal(r.json().wake.scheduled, false);
    assert.match(r.err, repair);
    assert.equal(s.bots()[0].wake, SPEC);
  }
  assert.deepEqual(mutations(s.local), []);
});

test("a put refusal at exit 0, unreadable acknowledgements and read-back drift are failures", (t) => {
  const s = scene(t);
  for (const [control, why] of [
    [{ putProblem: "the config refused it" }, /the config refused it/],
    [{ putText: "[]" }, /unreadable reply/],
    [{ drift: { repo: "/another/repo" } }, /does not match the saved wake/],
    [{ drift: { target: "worker:" + ID } }, /does not match the saved wake/],
    [{ drift: { prompt: "different prompt" } }, /does not match the saved wake/],
    [{ drift: { catch_up_minutes: 1440 } }, /does not match the saved wake/],
    [{ drift: { timeout_minutes: 11 } }, /does not match the saved wake/],
    [{ failReadBack: true }, /could not be verified/],
  ]) {
    s.local.listing({});
    s.local.control(control);
    const r = setWake(s);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.json().wake.state, "unverified");
    assert.equal(r.json().wake.scheduled, false);
    assert.match(r.err, why);
    assert.equal(s.bots()[0].wake, SPEC);
  }
  s.local.control({ rmText: "unexpected" });
  const clear = s.edit("--no-wake");
  assert.equal(clear.code, 1, clear.err);
  assert.equal(clear.json().wake.state, "unverified");
  assert.match(clear.err, /rm returned unexpected output/);
});

test("a foreign name, an invalid duplicate, and a renamed wake are never changed", (t) => {
  const s = scene(t);
  const ours = entry(s.project);
  for (const fields of [
    { automations: [{ ...ours, repo: "/elsewhere" }] },
    { automations: [{ ...ours, target: "bot:b-bbbbbbbbbb" }] },
    { automations: [{ ...ours, prompt: "independent scheduled prompt" }] },
    { automations: [ours], invalid: [{ name: ours.name, line: 2, message: "invalid cron" }] },
    { automations: [{ ...ours, name: "renamed-wake" }] },
  ]) {
    s.local.listing(fields);
    const before = s.local.config();
    const r = setWake(s);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.json().wake.state, "conflict");
    assert.match(r.err, /resolve it in .*automations\.yaml/);
    assert.ok(r.err.includes(fields.automations[0].name));
    assert.deepEqual(s.local.config(), before);
  }
  s.local.listing({ automations: [{ ...ours, prompt: "independent scheduled prompt" }] });
  const rm = s.cli(["rm", ID]);
  assert.equal(rm.code, 0, rm.err);
  assert.match(rm.err, /resolve it in .*automations\.yaml/);
  assert.doesNotMatch(rm.err, /herdr-automations rm/);
  assert.deepEqual(mutations(s.local), []);
});

test("two clones can schedule the same bot id; ls --all lists the scheduler once", (t) => {
  const s = scene(t);
  const clone = scratchProject(s.root, "clone", { isGit: false, bots: roster(BOT) });
  checkout(s.project);
  checkout(clone);
  assert.equal(setWake(s).code, 0);
  const another = s.cli(["edit", ID, "--wake", SPEC, "--project", clone]);
  assert.equal(another.code, 0, another.err);
  assert.notEqual(wakeName(s.project), wakeName(clone));
  assert.deepEqual(s.local.config().automations.map((a) => [a.repo, a.name]), [
    [s.project, wakeName(s.project)], [clone, wakeName(clone)],
  ]);
  s.local.resetCalls();
  const all = s.cli(["ls", "--all", "--json"]);
  assert.equal(all.code, 0, all.err);
  assert.deepEqual(all.json().projects.map((p) => p.bots[0].wakeStatus.state), ["active", "active"]);
  assert.deepEqual(argsOf(s.local), [["ls", "--json"]]);
});

test("worktree edits are saved-only with an exact repair, and worktree rm names its cleanup", (t) => {
  const s = scene(t);
  const wt = join(s.root, "work tree");
  worktree(s.project, wt);
  const args = ["--project", wt];
  const edit = setWake(s, ...args);
  assert.equal(edit.code, 0, edit.err);
  assert.equal(edit.json().wake.state, "saved-only");
  assert.ok(edit.err.includes("am edit " + ID + " --project " + s.project + " --wake " + SPEC));
  assert.equal(readJson(rosterPath(wt)).bots[0].wake, SPEC);
  assert.equal(Object.hasOwn(s.bots()[0], "wake"), false);
  assert.equal(Object.hasOwn(s.cli(["show", ID, ...args, "--json"]).json(), "wake"), false);
  const clear = s.edit("--no-wake", ...args);
  assert.ok(clear.err.includes("am edit " + ID + " --project " + s.project + " --no-wake"));
  const rm = s.cli(["rm", ID, ...args]);
  assert.equal(rm.code, 0, rm.err);
  assert.ok(rm.err.includes("herdr-automations rm " + wakeName(s.project) + " on this computer"));
  assert.ok(rm.err.includes(s.project));
  assert.deepEqual(s.local.calls(), []);
});

test("linked wake sends the quoted project as JSON on the owner and preserves linked offsets", (t) => {
  const s = scene(t);
  const wt = join(s.root, "linked worktree");
  worktree(s.linked, wt);
  const r = setWake(s, "--machine", "vm", "--project", wt);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().machine, "vm");
  assert.deepEqual(mutations(s.there).map((c) => [c.argv, JSON.parse(c.stdin)]), [[["put"], wire(s.linked)]]);
  assert.equal(readJson(rosterPath(s.linked)).bots[0].wake, SPEC);
  assert.equal(existsSync(rosterPath(wt)), false);
  const call = s.hcCalls().find((c) => c[0] === "exec" && c.at(-1) === "put");
  assert.deepEqual(call.slice(0, 9), ["exec", "--json", "--timeout", "30", "--on", "vm", "--", "sh", "-c"]);
  assert.equal(call[10], "sh");
  assert.equal(call[9].includes(s.linked), false);
  assert.deepEqual(JSON.parse(call[11]), wire(s.linked));
  assert.deepEqual(s.local.calls(), []);
  s.there.listing({ automations: [entry(s.linked, { last: { status: "done", at: LAST, result: "delivered" } })] });
  const ls = s.cli(["ls", ...s.on]);
  assert.ok(ls.out.includes("next " + NEXT));
  assert.ok(ls.out.includes("last done " + LAST + " (delivered)"));
  const show = s.cli(["show", ID, ...s.on]);
  assert.ok(show.out.includes("next " + NEXT + " · last done at " + LAST + " (delivered)"));
  assert.deepEqual(s.local.calls(), []);
});

test("linked ls distinguishes a timed-out scheduler from an absent binary", (t) => {
  const s = scene(t, { installed: false });
  writeJson(rosterPath(s.linked), roster({ ...BOT, wake: SPEC }));
  const status = () => s.cli(["ls", ...s.on, "--json"]).json().projects[0].bots[0].wakeStatus;
  assert.equal(status().state, "missing");
  s.hcState({ execTimedOut: ["herdr-automations"] });
  assert.equal(status().state, "unreachable");
  assert.match(status().problem, /timed out after 30 s/);
});

test("a lost put reply is verified, and an unreadable read-back after a lost rm is unknown", (t) => {
  const s = scene(t);
  s.there.control({ loseMutationReply: true });
  const set = setWake(s, ...s.on);
  assert.equal(set.code, 0, set.err);
  assert.equal(set.json().wake.scheduled, true);
  assert.deepEqual(argsOf(s.there), [["ls", "--json"], ["put"], ["ls", "--json"]]);

  s.there.resetCalls();
  s.there.control({ loseMutationReply: true, failReadBack: true });
  const clear = s.edit("--no-wake", ...s.on);
  assert.equal(clear.code, 1, clear.err);
  assert.equal(clear.json().wake.state, "unknown");
  assert.match(clear.err, /on vm.*the old wake may still fire/);
  assert.equal(Object.hasOwn(readJson(rosterPath(s.linked)).bots[0], "wake"), false);
  assert.deepEqual(argsOf(s.there), [["ls", "--json"], ["rm", wakeName(s.linked)], ["ls", "--json"]]);
});

test("reconciliation follows intervening roster edits for at most two passes", (t) => {
  const s = scene(t);
  const path = rosterPath(s.project);
  s.local.control({ roster: path, edits: ["daily@23:59"] });
  const once = setWake(s);
  assert.equal(once.code, 0, once.err);
  assert.equal(once.json().wake.spec, "daily@23:59");
  assert.deepEqual(mutations(s.local).map((c) => JSON.parse(c.stdin).cron), ["30 9 * * *", "59 23 * * *"]);

  s.local.resetCalls();
  s.local.control({ roster: path, edits: ["daily@20:00", "daily@21:00"] });
  const twice = setWake(s);
  assert.equal(twice.code, 1, twice.err);
  assert.equal(twice.json().wake.state, "superseded");
  assert.equal(twice.json().wake.spec, "daily@21:00");
  assert.deepEqual(mutations(s.local).map((c) => JSON.parse(c.stdin).cron), ["30 9 * * *", "0 20 * * *"]);

  s.local.resetCalls();
  s.local.control({ roster: path, edits: [null] });
  const cleared = setWake(s);
  assert.equal(cleared.code, 0, cleared.err);
  assert.equal(cleared.json().wake.state, "not-scheduled");
  assert.deepEqual(mutations(s.local).map((c) => c.argv[0]), ["put", "rm"]);
  assert.deepEqual(s.local.config().automations, []);
});

test("ls and show report schedule, last run details, and other automations without touching them", (t) => {
  const s = scene(t);
  s.seed({ ...BOT, wake: SPEC });
  const error = "Dialog opened\n" + "extra diagnostic words ".repeat(6).trim();
  const last = { status: "failed", at: LAST, error, run_id: "fixture" };
  const other = entry(s.project, { name: "weekly-review", prompt: "Weekly review" });
  s.local.listing({ automations: [entry(s.project, { last }), other] });
  const ls = s.cli(["ls"]);
  assert.match(ls.out, /wake daily@09:30 next 2026-11-20T09:30  last failed 2026-11-19T09:30 \(Dialog opened [^\n]+…\)/);
  const show = s.cli(["show", ID]);
  assert.match(show.out, /daily@09:30 · active · next 2026-11-20T09:30 · last failed at 2026-11-19T09:30 \(Dialog opened /);
  assert.match(show.out, /wake note +other automations target this bot: weekly-review/);
  const expected = { spec: SPEC, state: "active", next: NEXT,
    last: { status: "failed", at: LAST, error, result: null }, problem: null };
  assert.deepEqual(s.cli(["ls", "--json"]).json().projects[0].bots[0].wakeStatus, expected);
  const info = s.cli(["show", ID, "--json"]).json();
  assert.equal(info.wake, SPEC);
  assert.deepEqual(info.wakeStatus, expected);

  s.local.listing({ automations: [other] });
  assert.match(s.cli(["ls"]).out, /wake daily@09:30 \(not-scheduled\)/);
  assert.match(s.cli(["show", ID]).out, /daily@09:30 · not-scheduled/);
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots[0].wakeStatus.state, "not-scheduled");
  assert.equal(s.cli(["show", ID, "--json"]).json().wakeStatus.state, "not-scheduled");
  assert.equal(setWake(s).code, 0);
  assert.deepEqual(s.local.config().automations[0], other);
});

test("a verified wake can be stopped, paused, disabled or planned; auto qualifies the next run", (t) => {
  const s = scene(t);
  for (const [state, fields, bot, repair] of [
    ["stopped", { scheduler: 0 }, BOT, /herdr-automations service install/],
    ["paused", { paused: true }, BOT, /herdr-automations resume/],
    ["disabled", { automations: [entry(s.project, { disabled: true })] }, BOT, /herdr-automations resume wake-/],
    ["planned", {}, { ...BOT, kind: "member", planned: { wave: 2 } }, /--unplanned/],
    ["active", { backend: "auto" }, BOT, /whether the running service uses hc is unreadable/],
  ]) {
    s.seed(bot.kind === "main" ? bot : { ...BOT, id: "b-bbbbbbbbbb", name: "Lead" }, ...(bot.kind === "main" ? [] : [bot]));
    s.local.listing(fields);
    const r = setWake(s);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().wake.scheduled, true);
    assert.equal(r.json().wake.state, state);
    assert.match(r.err, repair);
    const listing = s.cli(["ls", "--json"]).json();
    assert.equal(listing.projects[0].bots.find((b) => b.id === ID).wakeStatus.state, state);
    assert.equal(s.cli(["show", ID, "--json"]).json().wakeStatus.state, state);
    if (state === "stopped") {
      assert.match(s.cli(["ls"]).out, /wake daily@09:30 \(stopped\)/);
      assert.match(s.cli(["show", ID]).out, /daily@09:30 · stopped/);
    }
    if (fields.backend === "auto") {
      for (const command of [["ls"], ["show", ID]]) {
        assert.match(s.cli(command).out, /next 2026-11-20T09:30 \(per the config\)/);
      }
    }
  }
});

test("listings detect invalid, conflicting, mismatching and unreadable scheduler entries", (t) => {
  const s = scene(t);
  s.seed({ ...BOT, wake: SPEC });
  for (const [state, fields] of [
    ["invalid", { invalid: [{ name: wakeName(s.project), line: 3, message: "invalid cron" }] }],
    ["conflict", { automations: [entry(s.project, { target: "worker:" + ID })] }],
    ...Object.entries({ cron: "0 0 * * *", target_when_busy: "queue", catch_up_minutes: 24,
      timeout_minutes: 99, prompt: "Scheduled wake (daily 09:30): altered" }).map(([key, value]) =>
      ["mismatch", { automations: [entry(s.project, { [key]: value })] }]),
  ]) {
    s.local.listing(fields);
    assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots[0].wakeStatus.state, state);
    assert.equal(s.cli(["show", ID, "--json"]).json().wakeStatus.state, state);
  }
  s.local.control({ lsText: "{}" });
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots[0].wakeStatus.state, "unreadable");
  const edit = setWake(s);
  assert.equal(edit.code, 1, edit.err);
  assert.equal(edit.json().wake.state, "unreadable");
  assert.deepEqual(mutations(s.local), []);
});

test("listing and showing a roster with no valid wakes never calls the scheduler", (t) => {
  const s = scene(t);
  for (const bot of [BOT, { ...BOT, wake: "daily@99:00" }]) {
    s.seed(bot);
    assert.equal(Object.hasOwn(s.cli(["ls", "--json"]).json().projects[0].bots[0], "wakeStatus"), false);
    assert.equal(Object.hasOwn(s.cli(["show", ID, "--json"]).json(), "wakeStatus"), false);
  }
  assert.deepEqual(s.local.calls(), []);
});

test("successful create prints only the id; rm and --no-wake clean up an owned leftover", (t) => {
  const s = scene(t);
  const made = s.cli(["create", "--name", "Writer", "--agent", "claude", "--wake", SPEC]);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /^b-[a-z2-7]{10}\n$/);
  assert.match(made.err, /scheduler entry verified/);
  const id = made.out.trim();
  assert.equal(s.local.config().automations[0].target, "bot:" + id);
  assert.equal(s.cli(["rm", id]).code, 0);
  assert.deepEqual(s.local.config().automations, []);

  s.local.listing({ automations: [entry(s.project)] });
  assert.equal(s.edit("--no-wake").code, 0);
  assert.deepEqual(s.local.config().automations, []);
  s.local.listing({ automations: [entry(s.project)] });
  const last = s.cli(["rm", ID, "--json"]);
  assert.equal(last.code, 0, last.err);
  assert.equal(last.json().deletedFile, true);
  assert.equal(existsSync(rosterPath(s.project)), false);
  assert.deepEqual(s.local.config().automations, []);
});
