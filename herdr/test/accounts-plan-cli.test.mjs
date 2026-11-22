// Process-only. All homes are scratch, and every hc call hits a refusing fake.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { planArgs } from "../mods/am-quota/plan.js";
import { planPreview, readPlanFile } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { markTried, settle, startAttempt, suspend } from "../mods/am-sidebar/accountsPlan.js";
import { FLEET_FILE, noExceptions, parseFleet } from "../mods/am-sidebar/accountsRows.js";
import { emptyPlan, LOCAL_CLAIM_MS, LOCAL_FENCE_MS, LOCAL_START_MS, LOCK_FILE, PLAN_FILE, PREVIEWS_DIR, PREVIEW_TTL_MS,
  REQUESTS_DIR, STOP_FILE, planText } from "../mods/am-sidebar/accountsPlanRecord.js";
import { AM, PACK, READER, auth, exe, json } from "./accounts-fixture.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const A = "ana@example.test", B = "bo@example.test", C = "cy@example.test";
const OWNER = "a".repeat(32), OTHER = "b".repeat(32);
const PROXY = "https://proxy.example.test";
const GEN = "1".repeat(64), INTENDED = "2".repeat(64);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const at = (ago = 0) => new Date(Date.now() - ago).toISOString();
const mode = (path) => statSync(path).mode & 0o777;
const progress = (state, why = null) => ({ state, why, at: at(), tried: null, attempt: null, read: null });

function scene(t) {
  const root = scratchRoot(t, "am-plan-");
  const below = (path) => assert.ok(path.startsWith(`${root}/`));
  const home = join(root, "home"), app = join(home, "app"), bin = join(home, "bin"), codex = join(home, "codex");
  const log = join(root, "hc.log"), loginFile = join(app, "claude-logins.json"), file = join(app, PLAN_FILE);
  const slot = join(home, "claude-two"), lastSlot = join(home, "claude-three");
  for (const dir of [app, bin, codex, slot, lastSlot, join(home, "claude"), join(root, "state")]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(app, "mods/am-quota"), { recursive: true });
  exe(join(bin, "hc"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PLAN_HC_LOG"\nexit 9\n');
  exe(join(bin, "claude"), `#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 9
echo CANARY-STDERR-0043 >&2
case "\${CLAUDE_CONFIG_DIR:-}" in
  */claude-two) email=${B} ;;
  */claude-three) email=${C} ;;
  *) email=${A} ;;
esac
printf '{"loggedIn":true,"email":"%s","authMethod":"claude.ai","configDirectory":"%s","extra":"CANARY-STATUS-0043"}\\n' "$email" "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
`);
  const loginText = `${JSON.stringify({ use: "default", logins: [{ id: "slot-two", dir: slot }, { id: "slot-three", dir: lastSlot }] }, null, 2)}\n`;
  writeFileSync(loginFile, loginText, { mode: 0o600 });
  const snapshot = sha256(loginText);
  const env = { HOME: home, HERDR_APP_HOME: app, AM_HOME: join(home, "am"), CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: join(home, "claude"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
    AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock"),
    HERDR_APP_BIN: "/bin/false", GIT_CEILING_DIRECTORIES: root, TMPDIR: root,
    PATH: `${bin}:${process.env.PATH}`, PLAN_HC_LOG: log };
  const run = (args, entry = PACK, nodeArgs = []) => {
    for (const key of ["HOME", "HERDR_APP_HOME", "AM_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR", "AUTOMAGIK_HERDR_CORE_SOCKET", "PLAN_HC_LOG"]) below(env[key]);
    assert.equal(env.AUTOMAGIK_HERDR_TEST_ROOTS, root);
    const argv = entry === READER ? args : args[0] === "--json" ? ["--json", "accounts", ...args.slice(1)] : ["accounts", ...args];
    const reply = mkdtempSync(join(root, "reply-"));
    const stdout = join(reply, "out"), stderr = join(reply, "err");
    const out = openSync(stdout, "wx", 0o600), err = openSync(stderr, "wx", 0o600);
    try {
      const result = spawnSync(process.execPath, [...nodeArgs, entry, ...argv], { cwd: home, env, stdio: ["ignore", out, err], timeout: 15_000 });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      assert.equal(existsSync(log), false, "accounts made no hc call");
      return { code: result.status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
    } finally {
      closeSync(out);
      closeSync(err);
      rmSync(reply, { recursive: true });
    }
  };
  const ok = (args, entry) => {
    const result = run(args, entry);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const refuses = (args, code, entry) => {
    const result = run(args, entry);
    assert.deepEqual(result, { code: 1, stdout: `${JSON.stringify({ error: code })}\n`, stderr: `am: accounts plan: ${code}\n` });
  };
  const usage = (args, entry) => assert.deepEqual(run(args, entry), { code: 2, stdout: "", stderr: "am: accounts plan: usage\n" });
  const request = (body) => {
    const id = randomUUID().replaceAll("-", "");
    const path = join(app, REQUESTS_DIR, `${id}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ v: 1, ...body }), { flag: "wx", mode: 0o600 });
    return id;
  };
  const save = (plan) => writeFileSync(file, planText(plan), { mode: 0o600 });
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const view = (id = "local", email = A) => {
    const eligible = (email) => ({ state: "eligible", email });
    return { id, name: id === "local" ? "local" : "vm-one", away: false, read: true, readAt: at(), from: "fleet",
      appHome: id === "local" ? app : join(root, "vm-one"), qualified: true, codex: null, exceptions: [],
      claude: { record: "ok", snapshot, selected: "default", effective: email === B ? "slot-two" : email === C ? "slot-three" : "default",
        ...eligible(email), routesDiffer: false,
        slots: [{ id: "default", ...eligible(A) }, { id: "slot-two", ...eligible(B) }, { id: "slot-three", ...eligible(C) }],
        slotsComplete: true, nextSlot: null, routes: { bare: eligible(email), record: eligible(email) } } };
  };
  const preview = (body, { views = [view()], now = Date.now() } = {}) => {
    const saved = process.env.HERDR_APP_HOME;
    below(app);
    process.env.HERDR_APP_HOME = app;
    try {
      const base = readPlanFile();
      const result = planPreview({ v: 1, ...body }, { base, plan: base.plan, views, now });
      assert.equal(result.error, undefined);
      return result;
    } finally {
      if (saved === undefined) delete process.env.HERDR_APP_HOME;
      else process.env.HERDR_APP_HOME = saved;
    }
  };
  const fixture = ({ local = B, codexPending = true, linked = false, rev = 1 } = {}) => {
    const plan = emptyPlan(at());
    plan.rev = rev;
    const add = (tool, machine, assign, home, seen, state) => {
      const section = plan[tool];
      section.assign[machine] = assign;
      section.pin[machine] = assign;
      section.members[machine] = { home, since: at() };
      section.seen[machine] = { home, ...seen };
      section.progress[machine] = progress(state);
    };
    add("claude", "local", local, app, { snapshot, email: A }, local === A ? "done" : "pending");
    if (linked) {
      add("claude", "core-one", A, view("core-one").appHome, { snapshot, email: A }, "done");
      plan.names["core-one"] = "vm-one";
    }
    if (codexPending) add("codex", "local", "codex-two", codex,
      { account: "ab123456", generation: GEN, proxy: PROXY, placed: null }, "pending");
    save(plan);
    return plan;
  };
  const evidence = (tool, extra = {}) => request({ kind: "evidence", ...(tool === "claude"
    ? { assign: B, before: snapshot, eff: A, effSlot: "default", slot: "slot-two", home: app, proxy: null }
    : { assign: "codex-two", before: GEN, eff: null, effSlot: null, slot: null, home: codex, proxy: PROXY }), ...extra });
  const start = (tool = "claude", { owner = OWNER, rev = 1, extra } = {}) =>
    planArgs("start-local", { tool, owner, rev, id: evidence(tool, extra) });
  const outcome = (tool, state, { owner = OWNER, n = 1, why = null, read = null, placed } = {}) =>
    planArgs("record-local", { tool, n, owner, id: request({ kind: "outcome", state, why, read, ...(placed ? { placed } : {}) }) });
  const privateFile = (id) => join(app, PREVIEWS_DIR, `${id}.json`);
  return { root, home, app, codex, file, loginFile, loginText, snapshot, run, ok, refuses, usage, request, save, read, view,
    preview, fixture, start, outcome, privateFile, bin, env };
}

const commit = ({ id, rev }) => planArgs("commit", { id, rev });
const write = ({ snapshot, n = 1, owner = OWNER }) => planArgs("write-local", { tool: "claude", n, owner, snapshot });
const fence = (extra = {}) => planArgs("fence-local", { tool: "codex", n: 1, owner: OWNER, generation: GEN,
  intended: INTENDED, proxy: PROXY, ...extra });
const install = (extra = {}) => planArgs("install-local", { tool: "codex", n: 1, rev: 1, owner: OWNER,
  intended: INTENDED, stamp: "2026-11-20T13-00-00-000Z", ...extra });
const localOps = (s, id) => [s.start(), s.start("codex"), write({ snapshot: s.snapshot }), fence(), install(),
  s.outcome("claude", "lost"), s.outcome("codex", "lost"), ...["claude", "codex"].flatMap((tool) => [
    planArgs("suspend-local", { tool, rev: 1 }), planArgs("fail-local", { tool, rev: 1, id }),
  ])];

test("plan commit requires explicit confirmation to keep a retired Claude dispatch warning", (t) => {
  const s = scene(t);
  const core = "core-one", now = Date.now(), date = new Date(now).toISOString();
  const plan = s.fixture({ linked: true });
  const dispatched = startAttempt(plan, "claude", core, { rev: plan.rev, slot: "default",
    slotDigest: sha256(`default\n${A}`), before: s.snapshot, eff: A, effDigest: sha256(`default\n${A}`),
    home: plan.claude.members[core].home, core, dispatch: OTHER, now });
  s.save(suspend(dispatched, "claude", core, "gone", now));

  const preview = s.preview({ kind: "forget", machine: core }, { views: [] });
  assert.ok(preview.flags.some(({ machine, code }) => machine === core && code === "open-dispatch"));
  s.refuses(commit(preview), "busy");
  s.usage(["plan", "--show", "--confirm-forget"]);
  const confirmed = planArgs("commit", { ...preview, confirmForget: true });
  assert.deepEqual(s.ok(confirmed, AM), { ok: true, rev: plan.rev + 1 });
  assert.equal(mode(s.file), 0o600);
  assert.equal(s.read().claude.members[core], undefined);
  assert.deepEqual(s.ok(["plan", "--show"], READER).exposures, { [core]: date });

  const dismiss = s.preview({ kind: "dismiss-exposure", machine: core });
  s.ok(commit(dismiss), PACK);
  assert.equal(s.ok(["plan", "--show"]).exposures, undefined);
});

test("commit increments rev, renames a private record and consumes the preview; an older panel is stale", (t) => {
  const s = scene(t);
  const manage = s.preview({ kind: "manage" });
  const duplicate = s.preview({ kind: "manage" });
  assert.deepEqual(manage.moves, []);
  assert.match(manage.id, /^[0-9a-f]{32}$/);
  assert.equal(mode(dirname(s.privateFile(manage.id))), 0o700);
  assert.equal(mode(s.privateFile(manage.id)), 0o600);
  assert.deepEqual(s.ok(commit(manage)), { ok: true, rev: 1 });
  const inode = statSync(s.file).ino;
  assert.equal(mode(s.file), 0o600);
  assert.equal(existsSync(s.privateFile(manage.id)), false);
  s.refuses(commit(manage), "missing");
  s.refuses(commit(duplicate), "stale");
  assert.equal(existsSync(s.privateFile(duplicate.id)), false);
  s.refuses(commit(duplicate), "missing");
  const edit = s.preview({ kind: "pin", tool: "claude", machine: "local", account: B });
  assert.deepEqual(s.ok(commit(edit), AM), { ok: true, rev: 2 });
  assert.equal(s.read().claude.assign.local, B);
  assert.notEqual(statSync(s.file).ino, inode);
  assert.equal(readdirSync(s.app).some((name) => name.endsWith(".tmp")), false);
});

test("a held accounts.lock returns busy and leaves the plan and preview alone", (t) => {
  const s = scene(t);
  const p = s.preview({ kind: "manage" });
  const lock = join(s.app, LOCK_FILE), token = `${process.pid} ${OWNER}`;
  writeFileSync(lock, token, { flag: "wx" });
  s.refuses(commit(p), "busy");
  assert.equal(readFileSync(lock, "utf8"), token);
  assert.equal(existsSync(s.file), false);
  assert.equal(existsSync(s.privateFile(p.id)), true);
});

test("expired previews and requests are swept and a direct old commit reports expired", (t) => {
  const s = scene(t);
  const stale = Date.now() - PREVIEW_TTL_MS - 1000;
  const old = s.preview({ kind: "manage" }, { now: stale });
  const swept = s.preview({ kind: "manage" });
  const id = s.request({ kind: "manage" });
  const request = join(s.app, REQUESTS_DIR, `${id}.json`);
  utimesSync(s.privateFile(swept.id), stale / 1000, stale / 1000);
  utimesSync(request, stale / 1000, stale / 1000);
  s.refuses(commit(old), "expired");
  for (const path of [request, s.privateFile(old.id), s.privateFile(swept.id), s.file]) assert.equal(existsSync(path), false);
});

test("Manage keeps the exact corrupt bytes private and cannot replace a newer plan", (t) => {
  const s = scene(t);
  const corrupt = "broken JSON\n";
  writeFileSync(s.file, corrupt, { mode: 0o644 });
  const p = s.preview({ kind: "manage" });
  writeFileSync(s.file, "different bytes\n");
  s.refuses(commit(p), "stale");
  writeFileSync(s.file, corrupt);
  s.refuses(commit(p), "missing");
  assert.equal(s.ok(commit(s.preview({ kind: "manage" }))).rev, 1);
  const saved = readdirSync(s.app).filter((name) => name.startsWith(`${PLAN_FILE}.corrupt-`));
  assert.equal(saved.length, 1);
  assert.equal(mode(join(s.app, saved[0])), 0o600);
  assert.equal(readFileSync(join(s.app, saved[0]), "utf8"), corrupt);
  const plan = s.read();
  const v2 = { ...plan, v: 2, stopped: false, retries: "pack" };
  for (const bytes of ['{"v":2}\n', '{"v":3}\n', JSON.stringify({ ...plan, v: 2 }),
    JSON.stringify({ ...v2, retries: "bogus" }), JSON.stringify(v2)]) {
    s.save(plan);
    const edit = s.preview({ kind: "second-login", machine: "local", allow: true });
    writeFileSync(s.file, bytes);
    s.refuses(commit(edit), "newer-plan");
    s.refuses(planArgs("request", { id: s.request({ kind: "manage" }) }), "newer-plan");
    assert.equal(readFileSync(s.file, "utf8"), bytes);
    assert.deepEqual(readdirSync(s.app).filter((name) => name.startsWith(`${PLAN_FILE}.corrupt-`)), saved);
  }
});

test("a readable v2 plan refuses all local mutations and keeps both credentials unchanged", (t) => {
  const s = scene(t);
  const plan = s.fixture();
  const bytes = JSON.stringify({ ...plan, v: 2, stopped: false, retries: "pack" });
  const codexAuth = join(s.codex, "auth.json"), initial = auth("account-a");
  writeFileSync(codexAuth, initial, { mode: 0o600 });
  writeFileSync(s.file, bytes);
  for (const args of localOps(s, "9".repeat(32))) s.refuses(args, "newer-plan");
  assert.equal(readFileSync(s.file, "utf8"), bytes);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assert.equal(readFileSync(codexAuth, "utf8"), initial);
});

test("the stop marker blocks local claims and writes while allowing settling and editing", (t) => {
  const s = scene(t);
  s.fixture();
  const marker = join(s.app, STOP_FILE), canary = "CANARY-STOP\n";
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, canary);
  const mtime = statSync(marker).mtimeMs, before = readFileSync(s.file, "utf8");
  for (const tool of ["claude", "codex"]) s.refuses(s.start(tool), "stopped");
  assert.equal(readFileSync(s.file, "utf8"), before);
  const request = planArgs("request", { id: s.request({ kind: "second-login", machine: "local", allow: true }) });
  s.ok(commit(s.ok(request)));
  assert.equal(s.ok(planArgs("show")).rev, 2);

  const plan = s.fixture({ local: A });
  s.ok(planArgs("suspend-local", { tool: "claude", rev: 1 }));
  const outcome = s.request({ kind: "outcome", assign: "codex-two", why: "proxy-url",
    read: { at: at(), home: s.codex, account: "ab123456", generation: GEN, proxy: null } });
  s.ok(planArgs("fail-local", { tool: "codex", rev: 1, id: outcome }));
  writeFileSync(s.file, JSON.stringify({ ...plan, v: 2, stopped: false, retries: "pack" }));
  s.refuses(s.start(), "newer-plan");
  assert.equal(readFileSync(marker, "utf8"), canary);
  assert.equal(statSync(marker).mtimeMs, mtime);
});

test("a directory stop marker blocks writers after a claim or fence", (t) => {
  const s = scene(t);
  const plan = s.fixture();
  const initial = auth("account-a"), payload = auth("account-b"), stamp = "2026-11-20T13-00-00-000Z";
  const codexAuth = join(s.codex, "auth.json"), staged = join(s.app, "data/am-quota", `codex-${stamp}.json`);
  const generation = sha256(initial), intended = sha256(payload);
  plan.codex.seen.local.generation = generation;
  s.save(plan);
  writeFileSync(codexAuth, initial, { mode: 0o600 });
  mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
  writeFileSync(staged, payload, { mode: 0o600 });
  s.ok(s.start());
  s.ok(s.start("codex", { extra: { before: generation } }));
  s.ok(fence({ generation, intended }));
  const marker = join(s.app, STOP_FILE);
  mkdirSync(marker);
  const mtime = statSync(marker).mtimeMs, before = readFileSync(s.file, "utf8");
  s.refuses(write({ snapshot: s.snapshot }), "stopped");
  s.refuses(install({ intended, stamp }), "stopped");
  assert.equal(readFileSync(s.file, "utf8"), before);
  assert.equal(s.read().codex.progress.local.attempt.installStarted, undefined);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assert.deepEqual(readdirSync(s.codex), ["auth.json"]);
  assert.equal(readFileSync(codexAuth, "utf8"), initial);
  assert.equal(readFileSync(staged, "utf8"), payload);
  s.ok(s.outcome("claude", "lost"));
  s.ok(s.outcome("codex", "lost"));
  assert.equal(statSync(marker).mtimeMs, mtime);
  rmSync(marker, { recursive: true });
  s.ok(s.start("codex", { extra: { before: generation } }));
  mkdirSync(marker);
  const fencedMtime = statSync(marker).mtimeMs;
  s.ok(fence({ n: 2, generation, intended }));
  assert.equal(statSync(marker).mtimeMs, fencedMtime);
  assert.deepEqual(readdirSync(marker), []);
});

test("local Claude persists the attempt before the slot write and records a bound read without changing rev", (t) => {
  const s = scene(t);
  s.fixture({ linked: true });
  s.refuses(s.start("claude", { rev: 0 }), "stale");
  s.refuses(s.start("claude", { extra: { assign: C } }), "stale");
  const started = s.ok(s.start());
  const initial = s.read();
  assert.deepEqual(started, { ok: true, attempt: { n: 1, at: initial.claude.progress.local.attempt.at, rev: 1,
    assign: B, slot: "slot-two", proxy: null }, seen: initial.claude.seen.local });
  assert.equal(initial.claude.progress.local.attempt.before, s.snapshot);
  assert.equal(initial.claude.progress.local.attempt.slotDigest, sha256(`slot-two\n${B}`));
  assert.equal(initial.claude.progress.local.attempt.effDigest, sha256(`default\n${A}`));
  s.refuses(s.start("claude", { owner: OTHER }), "claimed");
  s.refuses(write({ snapshot: s.snapshot, owner: OTHER }), "stale");
  s.refuses(write({ snapshot: GEN }), "conflict");
  s.usage([...write({ snapshot: s.snapshot }), "--slot", "slot-three"]);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);

  const edit = s.preview({ kind: "second-login", machine: "local", allow: true });
  s.refuses(commit(edit), "busy-local");
  const saved = s.ok(write({ snapshot: s.snapshot }), READER);
  const bytes = readFileSync(s.loginFile, "utf8");
  const logins = JSON.parse(bytes);
  assert.deepEqual(logins, { ...JSON.parse(s.loginText), use: "slot-two" });
  assert.deepEqual(saved, { ok: true, snapshot: sha256(bytes) });
  assert.equal(mode(s.loginFile), 0o600);
  assert.equal(s.read().claude.progress.local.attempt.after, saved.snapshot);
  s.refuses(write({ snapshot: s.snapshot }), "stale");

  const { slots } = s.view().claude;
  const read = { at: at(), core: null, home: s.app, record: "ok", snapshot: saved.snapshot,
    selected: "slot-two", effective: "slot-two", email: B, state: "eligible", slots, slotsComplete: true, nextSlot: null };
  s.refuses(s.outcome("claude", "done", { owner: OTHER, read }), "claimed");
  s.refuses(s.outcome("claude", "done", { read: { ...read, email: C } }), "bad-request");
  s.ok(s.outcome("claude", "done", { read }));
  const final = s.read();
  assert.equal(final.claude.progress.local.state, "done");
  assert.equal(final.claude.progress.local.attempt.outcome, "done");
  assert.deepEqual(final.claude.progress.local.read, read);
  assert.deepEqual(final.claude.seen.local, { home: s.app, snapshot: saved.snapshot, email: B });
  assert.deepEqual(final.claude.progress["core-one"], initial.claude.progress["core-one"]);
  assert.equal(final.rev, 1);
  s.refuses(s.outcome("claude", "lost"), "stale");
});

test("local write preserves a concurrent Claude record edit and refuses changed slot identity", (t) => {
  const s = scene(t);
  s.fixture();
  s.ok(s.start());
  const edited = `${s.loginText} `;
  writeFileSync(s.loginFile, edited);
  s.refuses(write({ snapshot: s.snapshot }), "conflict");
  assert.equal(readFileSync(s.loginFile, "utf8"), edited);
  writeFileSync(s.loginFile, s.loginText);
  exe(join(s.bin, "claude"), readFileSync(join(s.bin, "claude"), "utf8").replace(`email=${B}`, `email=${C}`));
  s.refuses(write({ snapshot: s.snapshot }), "slot-changed");
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assert.equal(s.read().claude.progress.local.attempt.after, null);
});

test("disabling Accounts after the Claude claim or Codex fence prevents the rename", (t) => {
  const s = scene(t);
  const enabled = join(s.app, "mods/am-quota"), disabled = join(s.app, "mods-disabled/am-quota");
  mkdirSync(dirname(disabled));
  s.fixture();
  s.ok(s.start());
  const login = join(s.bin, "claude");
  exe(login, readFileSync(login, "utf8").replace("case ", `if [ -d '${enabled}' ]; then mv '${enabled}' '${disabled}'; fi\ncase `));
  s.refuses(write({ snapshot: s.snapshot }), "off");
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assert.equal(s.read().claude.progress.local.attempt.after, null);
  assert.equal(existsSync(disabled), true);

  renameSync(disabled, enabled);
  const initial = auth("account-a"), payload = auth("account-b"), stamp = "2026-11-20T13-00-00-000Z";
  const file = join(s.codex, "auth.json"), staged = join(s.app, "data/am-quota", `codex-${stamp}.json`);
  const plan = s.read();
  plan.codex.seen.local.generation = sha256(initial);
  s.save(plan);
  writeFileSync(file, initial, { mode: 0o600 });
  mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
  writeFileSync(staged, payload, { mode: 0o600 });
  s.ok(s.start("codex", { extra: { before: sha256(initial) } }));
  s.ok(fence({ generation: sha256(initial), intended: sha256(payload) }));
  renameSync(enabled, disabled);
  s.refuses(planArgs("install-local", { tool: "codex", n: 1, rev: 1, owner: OWNER, intended: sha256(payload), stamp }), "off");
  assert.deepEqual(readdirSync(s.codex), ["auth.json"]);
  assert.equal(readFileSync(file, "utf8"), initial);
});

test("an old open attempt stays claimed, can be read back by a second owner and can be retired by a commit", (t) => {
  const s = scene(t);
  s.fixture();
  s.ok(s.start());
  const ageAttempt = (age) => {
    const plan = s.read();
    plan.claude.progress.local.attempt.at = at(age);
    s.save(plan);
  };
  ageAttempt(LOCAL_START_MS + 1000);
  s.refuses(write({ snapshot: s.snapshot }), "stale");
  s.refuses(s.outcome("claude", "lost", { owner: OTHER }), "claimed");
  ageAttempt(LOCAL_CLAIM_MS + 1000);
  s.refuses(s.start("claude", { owner: OTHER }), "claimed");
  s.refuses(s.outcome("claude", "failed", { owner: OTHER, why: "failed" }), "claimed");
  s.ok(s.outcome("claude", "lost", { owner: OTHER }));
  assert.equal(s.read().claude.progress.local.attempt.outcome, "lost");
  assert.equal(s.ok(s.start()).attempt.n, 2);
  s.refuses(s.outcome("claude", "lost"), "stale");
  ageAttempt(LOCAL_CLAIM_MS + 1000);
  const allowSecond = s.preview({ kind: "second-login", machine: "local", allow: true });
  assert.equal(s.ok(commit(allowSecond)).rev, 2);
  assert.equal(s.read().claude.progress.local.attempt.outcome, "lost");
  s.refuses(s.outcome("claude", "lost", { n: 2 }), "stale");
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
});

test("B then C in two panels: stale Claude evidence and Codex fences cannot authorize B", (t) => {
  const s = scene(t);
  s.fixture();
  const before = s.start();
  s.ok(s.start("codex"));
  const switchToC = s.preview({ kind: "pin", tool: "claude", machine: "local", account: C });
  assert.equal(s.ok(commit(switchToC), AM).rev, 2);
  s.refuses(before, "stale");
  s.refuses(s.start("claude", { rev: 2 }), "stale");
  s.refuses(fence(), "stale");
  s.refuses(s.outcome("claude", "lost"), "stale");
  assert.equal(s.read().claude.assign.local, C);
  assert.equal(s.read().codex.progress.local.attempt.fencedAt, null);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
});

test("an outcome for a retired assignment cannot close the same owner's newer attempt", (t) => {
  const s = scene(t);
  s.fixture();
  const first = s.ok(s.start()).attempt;
  s.ok(s.outcome("claude", "lost", { n: first.n }));
  const switchToC = s.preview({ kind: "pin", tool: "claude", machine: "local", account: C });
  const { rev } = s.ok(commit(switchToC));
  const second = s.ok(s.start("claude", { rev, extra: { assign: C, slot: "slot-three" } })).attempt;
  assert.notEqual(second.n, first.n);
  s.refuses(s.outcome("claude", "lost", { n: first.n }), "stale");
  s.refuses(write({ snapshot: s.snapshot, n: first.n }), "stale");
  assert.equal(s.read().claude.progress.local.attempt.outcome, null);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
});

test("the Codex fence binds one owner, assignment, proxy and generation and keeps a fresh install exclusive", (t) => {
  const s = scene(t);
  s.fixture();
  const started = s.ok(s.start("codex"));
  assert.equal(started.attempt.proxy, PROXY);
  s.refuses(fence({ owner: OTHER }), "stale");
  s.refuses(fence({ proxy: "https://other.example.test" }), "stale");
  s.refuses(fence({ generation: INTENDED }), "changed");
  s.usage(fence({ proxy: "https://name:CANARY-PLAN-0043@proxy.example.test" }));
  s.usage(fence({ proxy: "https://proxy.example.test?query=CANARY-PLAN-0043" }));
  const aged = s.read();
  aged.codex.progress.local.attempt.at = at(LOCAL_START_MS + 1000);
  s.save(aged);
  s.refuses(fence(), "stale");
  s.ok(s.outcome("codex", "lost"));
  s.refuses(fence(), "stale");
  assert.equal(s.ok(s.start("codex")).attempt.n, 2);
  s.ok(fence({ n: 2 }));
  s.refuses(fence({ n: 2 }), "stale");
  const fenced = s.read();
  assert.equal(fenced.codex.progress.local.attempt.intended, INTENDED);
  assert.ok(fenced.codex.progress.local.attempt.fencedAt);
  fenced.codex.progress.local.attempt.at = at(LOCAL_CLAIM_MS + 1000);
  s.save(fenced);
  const edit = s.preview({ kind: "add", tool: "codex", machine: "local", account: "codex-two",
    codexUsable: ["codex-two"], codexLocal: { home: s.codex, account: "ab123456", generation: GEN, proxy: PROXY } });
  s.refuses(commit(edit), "busy-local");
  s.refuses(s.outcome("codex", "lost", { n: 2, owner: OTHER }), "claimed");
  const read = { at: at(), home: s.codex, account: "01234567", generation: INTENDED, proxy: PROXY };
  const placed = { name: "codex-two", account: read.account, generation: INTENDED, proxy: PROXY };
  s.refuses(s.outcome("codex", "done", { n: 2, read, placed: { ...placed, generation: GEN } }), "bad-request");
  s.ok(s.outcome("codex", "done", { n: 2, read, placed }));
  assert.deepEqual(s.read().codex.seen.local.placed, { ...placed, at: s.read().at });
  assert.equal(s.read().rev, 1);
  assert.equal(existsSync(join(s.codex, "auth.json")), false);
});

test("a changed local observation suspends before any write; suspend-local requires done and the expected rev", (t) => {
  const s = scene(t);
  s.fixture();
  const suspend = (rev) => planArgs("suspend-local", { tool: "claude", rev });
  s.refuses(suspend(1), "not-done");
  s.refuses(s.start("claude", { extra: { before: GEN } }), "changed");
  assert.equal(s.read().claude.progress.local.why, "changed");
  assert.equal(s.read().claude.progress.local.attempt, null);
  s.fixture({ local: A });
  s.refuses(suspend(0), "stale");
  s.ok(suspend(1));
  assert.equal(s.read().claude.progress.local.state, "suspended");
  assert.equal(s.read().rev, 1);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
});

test("the panel argv for every operation works through all three entry points with exactly its companions", (t) => {
  const s = scene(t);
  const id = "9".repeat(32);
  const operations = [
    [planArgs("request", { id }), "bad-request"], [planArgs("commit", { id, rev: 0 }), "missing"],
    [planArgs("show"), null], [planArgs("start-local", { tool: "claude", owner: OWNER, rev: 1, id }), "bad-request"],
    [write({ snapshot: s.snapshot }), "stale"], [fence(), "stale"],
    [planArgs("record-local", { tool: "codex", n: 1, owner: OWNER, id }), "stale"],
    [planArgs("suspend-local", { tool: "claude", rev: 1 }), "not-done"],
  ];
  s.fixture();
  for (const entry of [PACK, AM, READER]) {
    for (const [args, refusal] of operations) {
      if (refusal) s.refuses(args, refusal, entry);
      else assert.equal(s.ok(args, entry).kind, "accounts.plan");
      s.usage([...args, "--unexpected"], entry);
      s.usage(args.slice(0, -1), entry);
    }
    s.usage(["plan", "--finalize-local", "codex", "--expect-rev", "1", "--intended", INTENDED], entry);
  }
  s.usage(["plan", "--show", "--show"]);
  s.usage(["plan", "--show", "--expect-rev", "0"]);
  s.usage(["plan", "--show", "--commit", id, "--expect-rev", "0"]);
  s.refuses(planArgs("request", { id: s.request({ kind: "rebind", to: "core-two" }) }), "bad-request");
  s.refuses(planArgs("request", { id: s.request({ kind: "pin", tool: "codex", machine: "core-one", account: "codex-one" }) }), "held");
});

test("show reports state and member progress with identical output through the pack, am and the dedicated entry", (t) => {
  const s = scene(t);
  const args = planArgs("show");
  assert.equal(s.ok(args).state, "absent");
  const plan = s.fixture({ linked: true });
  plan.exposures = { "core-one": at() };
  s.save(plan);
  const answer = s.ok(args);
  assert.equal(answer.state, "ok");
  assert.equal(answer.rev, plan.rev);
  assert.deepEqual(answer.tools.claude.rows.map((row) => [row.machine, row.name, row.progress.state]),
    [["local", "local", "pending"], ["core-one", "vm-one", "done"]]);
  for (const entry of [AM, READER]) assert.deepEqual(s.ok(args, entry), answer);
  writeFileSync(s.file, "broken\n");
  assert.equal(s.ok(args).state, "corrupt");
  writeFileSync(s.file, '{"v":2}\n');
  const malformed = s.ok(args);
  assert.equal(malformed.state, "newer");
  assert.equal(malformed.rev, null);
  assert.equal(malformed.tools.claude.mode, null);
  assert.equal(malformed.stopped, undefined);
  writeFileSync(s.file, JSON.stringify({ ...plan, v: 2, stopped: true, retries: "app" }));
  const v2 = s.run(args);
  assert.deepEqual(JSON.parse(v2.stdout), { ...answer, state: "newer", stopped: true, retries: "app" });
  for (const entry of [AM, READER]) assert.deepEqual(s.run(args, entry), v2);
});

test("chosen-home workers cannot mutate accounts and show never sweeps expired files", (t) => {
  const s = scene(t);
  s.fixture();
  const before = readFileSync(s.file, "utf8"), show = planArgs("show");
  const stale = Date.now() - PREVIEW_TTL_MS - 1000;
  const change = { kind: "second-login", machine: "local", allow: true };
  const preview = s.preview(change);
  const id = s.request(change);
  const oldFiles = [s.privateFile(preview.id), join(s.app, REQUESTS_DIR, `${id}.json`)];
  for (const path of oldFiles) utimesSync(path, stale / 1000, stale / 1000);
  const assertExpiredKept = () => { for (const path of oldFiles) assert.ok(existsSync(path), path); };
  const launch = ["set-login", "--launch-login", "--expect-home", s.app, "--expect-core", "core-one"];
  const unguarded = s.run(launch, READER);
  const normal = s.run(show);
  assertExpiredKept();

  s.env.AUTOMAGIK_AGENT_HOME_LAUNCH = randomUUID();
  const operations = [planArgs("request", { id }), commit(preview), ...localOps(s, id)];
  for (const entry of [PACK, READER]) {
    for (const args of operations) s.refuses(args, "chosen-home", entry);
    assert.deepEqual(s.run(show, entry), normal);
    s.usage(["plan", "--commit", id], entry);
    for (const verb of ["here", "fleet"]) {
      assert.deepEqual(s.run([verb, "--json"], entry), { code: 1, stdout: "",
        stderr: "am: Run am accounts from a Bot's pane, not a chosen-home worker.\n" });
    }
  }
  s.refuses(commit(preview), "chosen-home", AM);
  const binding = ["--expect-home", s.app, "--expect-core", "core-one", "--expect-rev", "1", "--attempt", "1", "--dispatch", OTHER];
  for (const words of [["--use", "slot-two", "--snapshot", s.snapshot], ["--remove", "slot-two", "--snapshot", s.snapshot],
    ["--add", "slot-four", "--dir", join(s.home, "claude-four"), "--snapshot", s.snapshot], ["--cancel-attempt", ...binding]]) {
    assert.deepEqual(s.run(["set-login", ...words], READER),
      { code: 1, stdout: '{"error":"chosen-home"}\n', stderr: "am: accounts set-login: chosen-home\n" });
  }
  assert.deepEqual(s.run(launch, READER), unguarded);
  assert.deepEqual(s.run(["set-login", "--use", "slot-two"], READER),
    { code: 2, stdout: "", stderr: "am: accounts set-login: usage\n" });
  assert.equal(existsSync(join(s.app, LOCK_FILE)), false);
  assert.equal(readFileSync(s.file, "utf8"), before);
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assertExpiredKept();

  delete s.env.AUTOMAGIK_AGENT_HOME_LAUNCH;
  assert.deepEqual(s.run(show), normal);
  assertExpiredKept();
  s.ok(planArgs("request", { id: s.request(change) }));
  for (const path of oldFiles) assert.equal(existsSync(path), false);
});

test("accounts routing preserves the reader's here and fleet usage and never repairs a stale link", (t) => {
  const s = scene(t);
  const ownBin = join(s.home, ".local", "bin"), installed = join(s.app, "mods", "am-sidebar", "bin");
  mkdirSync(ownBin, { recursive: true });
  mkdirSync(installed, { recursive: true });
  const old = join(installed, "automagik-herdr.mjs"), wrapper = join(installed, "automagik-herdr");
  writeFileSync(old, "");
  exe(wrapper, "#!/bin/sh\nexit 9\n");
  const link = join(ownBin, "am");
  symlinkSync(old, link);
  const args = planArgs("show");
  assert.deepEqual(s.ok(["--json", ...args], AM), s.ok(args));
  assert.deepEqual(s.ok(["--json", "here"], AM), s.ok(["here", "--json"], READER));
  assert.deepEqual(s.run(["fleet", "/project"]), { code: 2, stdout: "", stderr: "am: accounts fleet takes no projects.\n" });
  assert.deepEqual(s.run(["here", "relative"]), { code: 2, stdout: "", stderr: "am: accounts here takes up to 20 absolute project paths.\n" });
  assert.equal(s.run(["here", "--machine", "vm-other"]).code, 2);
  assert.equal(s.run(["other"]).stderr, "am: accounts takes here, fleet, plan, apply or set-login.\n");
  assert.equal(readlinkSync(link), old);
});

test("a real request commits after unrelated same-rev progress; a delivery 1 fleet row stays unqualified", (t) => {
  const s = scene(t);
  const plan = s.fixture({ linked: true });
  const timestamp = at();
  const { claude } = s.view("core-one");
  const fleet = { v: 1, at: timestamp, linked: null, machines: { "core-one": {
    name: "vm-one", at: timestamp, state: "read", reason: null, cli: "pack", panel: "off",
    versions: { pack: "1.0.0", am: null }, codex: null, exceptions: noExceptions(),
    claude: { ...claude, effective: "default", readAt: timestamp, prevEmail: null, changedAt: null },
  } } };
  assert.equal(parseFleet(JSON.stringify(fleet)).machines["core-one"].claude.email, A);
  json(join(s.app, FLEET_FILE), fleet);
  const noProof = s.ok(planArgs("request", { id: s.request({ kind: "pin", tool: "claude", machine: "core-one", account: B }) }));
  assert.deepEqual(noProof.changes, []);
  assert.ok(noProof.flags.some(({ code }) => code === "read-again"));
  const id = s.request({ kind: "second-login", machine: "local", allow: true });
  const preview = s.ok(planArgs("request", { id }));
  assert.equal(preview.rev, 1);
  assert.equal(existsSync(join(s.app, REQUESTS_DIR, `${id}.json`)), false);
  const now = at();
  const changed = settle(markTried(plan, "claude", "local", now), "claude", "core-one", { state: "pending", why: "lost", now });
  s.save(changed);
  assert.equal(s.ok(commit(preview)).rev, 2);
  assert.equal(s.read().claude.secondLogin.local, true);
  assert.deepEqual(s.read().claude.progress, changed.claude.progress);
  assert.deepEqual(JSON.parse(readFileSync(join(s.app, FLEET_FILE), "utf8")), fleet);
});

test("plan --request uses the fleet writer and reports exact moves, launch routes and exceptions", (t) => {
  const s = scene(t);
  s.fixture({ local: A, linked: true });
  const machine = "core-one", name = "vm-one", timestamp = at();
  const { appHome, claude } = s.view(machine);
  const ownHome = { project: join(s.root, "own-home"), why: "own-app-home" };
  const ownPath = { project: join(s.root, "own-path"), why: "own-path" };
  const observed = { name, at: timestamp, state: "read", reason: null, cli: "am", panel: "on",
    versions: { pack: "3.160.3", am: "3.160.4" }, codex: null, core: machine, appHome, write: true,
    writer: { setLogin: true, panel: "on", panelWrites: true, sidebarWrites: true, confirmed: true },
    exceptions: { bound: [ownHome], list: [ownPath], more: 0 },
    claude: { ...claude, effective: "default", readAt: timestamp, prevEmail: null, changedAt: null, routesDiffer: true,
      routes: { bare: { email: C, state: "eligible" }, record: { email: A, state: "eligible" } } },
  };
  const fleetFile = join(s.app, FLEET_FILE);
  const inspect = (entry, qualified = true) => {
    json(fleetFile, { v: 1, at: timestamp, linked: null, machines: { [machine]: entry } });
    const id = s.request({ kind: "pin", tool: "claude", machine, account: B });
    const { v, kind, rev, moves, flags, changes } = s.ok(planArgs("request", { id }));
    assert.deepEqual({ v, kind, rev }, { v: 1, kind: "accounts.preview", rev: 1 });
    assert.deepEqual(moves, [{ tool: "claude", machine, name, from: A, to: B }]);
    assert.deepEqual(changes, [{ tool: "claude", machine, name, join: false, pin: [A, B], assign: [A, B], observed: A,
      home: appHome, routes: { now: { start: C, tree: A }, next: qualified ? { start: B, tree: B } : { start: C, tree: A } },
      exceptions: [ownHome, ownPath] }]);
    return flags;
  };
  const flags = ["unmanaged-home", "routes-differ"].map((code) => ({ tool: "claude", machine, code }));
  assert.deepEqual(inspect(observed), flags);
  const update = { tool: "claude", machine, code: "update-first" };
  assert.deepEqual(inspect({ ...observed, writer: { ...observed.writer, confirmed: false } }, false), [update, ...flags]);
  assert.deepEqual(inspect({ ...observed, write: false }, false), [update, ...flags]);
});

test("private requests refuse links, oversized files and canary values with fixed errors", (t) => {
  const s = scene(t);
  s.fixture();
  s.refuses(planArgs("request", { id: s.request({ kind: "pin", tool: "claude", machine: "local", account: "CANARY-PLAN-0043" }) }), "bad-request");
  const id = s.request({ kind: "manage", extra: "x".repeat(65_536) });
  const request = join(s.app, REQUESTS_DIR, `${id}.json`);
  s.refuses(planArgs("request", { id }), "bad-request");
  assert.equal(existsSync(request), false);
  const linked = "8".repeat(32);
  symlinkSync(s.file, join(s.app, REQUESTS_DIR, `${linked}.json`));
  s.refuses(planArgs("request", { id: linked }), "bad-request");
  s.refuses(planArgs("request", { id: "../CANARY-PLAN-0043" }), "bad-request");
  assert.equal(s.read().rev, 1);
});

test("preview storage drops nested provider canaries from a valid local observation", (t) => {
  const s = scene(t);
  const { claude } = s.view();
  const claudeLocal = { ...claude, home: s.app, core: null, at: at(), effective: "default",
    diagnostics: "CANARY-PLAN-0043",
    slots: claude.slots.map((slot) => ({ ...slot, raw: "CANARY-STATUS-0043" })) };
  const preview = s.ok(planArgs("request", { id: s.request({ kind: "manage", claudeLocal }) }));
  const stored = readFileSync(s.privateFile(preview.id), "utf8");
  assert.doesNotMatch(stored, /CANARY-(PLAN|STATUS)-0043/);
  assert.equal(JSON.parse(stored).request.claudeLocal.email, A);
  assert.deepEqual(JSON.parse(stored).request.claudeLocal.slots, claude.slots);
});

test("Accounts locks keep a paused live holder and take over after that holder dies", async (t) => {
  const s = scene(t);
  const marker = join(s.root, "paused");
  const child = spawn(process.execPath, ["-e",
    'require("node:fs").writeFileSync(process.argv[1], ""); process.kill(process.pid, "SIGSTOP"); setInterval(() => {}, 1000);',
    marker], { cwd: s.home, env: s.env, stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(10);
  assert.ok(existsSync(marker));
  const locks = [join(s.app, LOCK_FILE), s.loginFile + ".lock"];
  for (const path of locks) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, OWNER), JSON.stringify({ host: hostname(), pid: child.pid, start: null }), { mode: 0o600 });
    utimesSync(path, 1, 1);
  }
  const manage = s.preview({ kind: "manage" });
  s.refuses(commit(manage), "busy");
  const use = ["--use", "slot-two", "--snapshot", s.snapshot];
  const login = () => s.run(["set-login", ...use], READER);
  const busy = login();
  assert.equal(busy.code, 1);
  assert.deepEqual(JSON.parse(busy.stdout), { error: "busy" });
  assert.equal(readFileSync(s.loginFile, "utf8"), s.loginText);
  assert.ok(child.kill("SIGKILL"));
  await exited;
  assert.deepEqual(s.ok(commit(manage)), { ok: true, rev: 1 });
  assert.equal(JSON.parse(login().stdout).ok, true);
  for (const path of locks) assert.equal(existsSync(path), false);
});

test("Codex installs only the staged generation owned by the live fenced attempt", (t) => {
  const s = scene(t);
  const initial = auth("account-a"), payload = auth("account-b"), stamp = "2026-11-20T12-00-00-000Z";
  const file = join(s.codex, "auth.json"), staged = join(s.app, "data/am-quota", `codex-${stamp}.json`);
  const before = sha256(initial), intended = sha256(payload);
  const plan = s.fixture();
  plan.codex.seen.local.generation = before;
  s.save(plan);
  writeFileSync(file, initial, { mode: 0o600 });
  mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
  writeFileSync(staged, payload, { mode: 0o600 });
  s.ok(s.start("codex", { extra: { before } }));
  s.ok(fence({ generation: before, intended }));
  const install = (extra = {}) => planArgs("install-local", { tool: "codex", n: 1, rev: 1, owner: OWNER, intended, stamp, ...extra });
  s.refuses(install({ owner: OTHER }), "stale");
  s.refuses(install({ n: 2 }), "stale");
  s.refuses(install({ rev: 2 }), "stale");
  s.refuses(install({ intended: GEN }), "stale");
  const expired = s.read();
  expired.codex.progress.local.attempt.at = at(LOCAL_CLAIM_MS + 1000);
  expired.codex.progress.local.attempt.fencedAt = at(LOCAL_FENCE_MS + 1000);
  s.save(expired);
  s.refuses(install(), "stale");
  assert.equal(readFileSync(file, "utf8"), initial);
  s.ok(s.outcome("codex", "lost", { owner: OTHER }));
  const replacement = s.preview({ kind: "pin", tool: "codex", machine: "local", account: "codex-three",
    codexLocal: { home: s.codex, generation: before, account: "ab123456", proxy: PROXY },
    codexUsable: ["codex-three"] });
  s.ok(commit(replacement));
  s.refuses(install(), "stale");
  assert.deepEqual(readdirSync(s.codex), ["auth.json"]);
  // The replacement can install its own payload, with a private backup, through the same path.
  const newer = s.ok(s.start("codex", { owner: OTHER, rev: 2, extra: { before, assign: "codex-three" } })).attempt;
  s.ok(fence({ n: newer.n, owner: OTHER, generation: before, intended }));
  s.refuses(install(), "stale");
  assert.deepEqual(s.ok(install({ n: newer.n, owner: OTHER, rev: newer.rev })), { ok: true });
  assert.equal(s.read().codex.progress.local.attempt.installStarted, true);
  assert.equal(readFileSync(file, "utf8"), payload);
  assert.equal(mode(file), 0o600);
  assert.equal(readFileSync(`${file}.bak-${stamp}`, "utf8"), initial);
  assert.equal(mode(`${file}.bak-${stamp}`), 0o600);
});

const active = (name, fingerprint) => JSON.stringify({ codex: { name, fingerprint } }, null, 2) + "\n";
const finalize = (rev, payload) => ["plan", "--finalize-local", "codex", "--expect-rev", String(rev), "--intended", sha256(payload)];

function installForCard(s, { rev, stamp, assign, original, payload, account }) {
  const staged = join(s.app, "data/am-quota", `codex-${stamp}.json`), intended = sha256(payload);
  const plan = s.fixture({ rev });
  plan.codex.assign.local = assign;
  plan.codex.seen.local.generation = sha256(original);
  s.save(plan);
  writeFileSync(staged, payload, { mode: 0o600 });
  const { attempt: { n } } = s.ok(s.start("codex", { rev, extra: { assign, before: sha256(original) } }));
  s.ok(fence({ n, generation: sha256(original), intended }));
  s.ok(planArgs("install-local", { tool: "codex", n, rev, owner: OWNER, intended, stamp }));
  const read = { at: at(), home: s.codex, account, generation: intended, proxy: PROXY };
  s.ok(s.outcome("codex", "done", { n, read, placed: { name: assign, proxy: PROXY, account, generation: intended } }));
}

test("a superseded Codex card finalizer leaves active.json alone after a newer placement or ordinary Switch", (t) => {
  const s = scene(t);
  const file = join(s.codex, "auth.json");
  const path = join(s.app, "data/am-quota/active.json");
  const a = auth("account-a"), b = auth("account-b"), c = auth("account-c");
  const before = active("codex-one", "aaaa0001"), later = active("codex-three", "cccc0003");

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, before, { mode: 0o600 });
  writeFileSync(file, a, { mode: 0o600 });
  installForCard(s, { rev: 1, stamp: "2026-11-20T12-00-00-000Z", assign: "codex-two", original: a, payload: b, account: "bbbb0002" });
  // The ordinary Switch recorded C while the managed install won the credential rename.
  writeFileSync(path, later);
  s.usage(finalize(1, b));
  assert.equal(readFileSync(path, "utf8"), later);
  assert.equal(readFileSync(file, "utf8"), b);
  writeFileSync(path, before);
  s.usage(finalize(1, b));
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(s.read().codex.seen.local.placed.generation, sha256(b));

  installForCard(s, { rev: 2, stamp: "2026-11-20T12-00-01-000Z", assign: "codex-three", original: b, payload: c, account: "cccc0003" });
  s.usage(finalize(2, c));
  const ino = statSync(path).ino;
  for (const args of [finalize(1, b), finalize(1, c), finalize(2, b)]) s.usage(args);
  writeFileSync(file, a);
  s.usage(finalize(2, c));
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(statSync(path).ino, ino);
});

test("an ordinary Codex Switch at the former finalizer rename keeps its credential and card", (t) => {
  const s = scene(t);
  const card = join(s.app, "data/am-quota/active.json"), file = join(s.codex, "auth.json");
  const a = auth("account-a"), b = auth("account-b"), c = auth("account-c");
  const later = active("codex-three", "cccc0003");
  mkdirSync(dirname(card), { recursive: true });
  writeFileSync(card, active("codex-one", "aaaa0001"), { mode: 0o600 });
  writeFileSync(file, a, { mode: 0o600 });
  installForCard(s, { rev: 1, stamp: "2026-11-20T12-00-00-000Z", assign: "codex-two", original: a, payload: b, account: "bbbb0002" });
  const probe = join(s.root, "ordinary-switch.mjs");
  writeFileSync(probe, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const card = ${JSON.stringify(card)};
    const rename = fs.renameSync;
    let switched = false;
    function ordinarySwitch() {
      if (switched) return;
      switched = true;
      fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(c)});
      fs.writeFileSync(card, ${JSON.stringify(later)});
    }
    fs.renameSync = (from, to) => {
      if (to === card) ordinarySwitch();
      return rename(from, to);
    };
    syncBuiltinESMExports();
    // In the absence of a card rename, the ordinary writer runs as the CLI returns.
    process.on("exit", ordinarySwitch);
  `);
  const result = s.run(finalize(1, b), PACK, ["--import", probe]);
  assert.equal(readFileSync(file, "utf8"), c);
  assert.equal(readFileSync(card, "utf8"), later);
  assert.equal(result.code, 2);
  assert.equal(s.read().codex.seen.local.placed.generation, sha256(b));
});
