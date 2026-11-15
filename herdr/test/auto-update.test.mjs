// Installing updates on their own (updater.js over updateCheck.js): a fake exec answering as
// update.mjs does, fake timers, a Map for Herdr's shared values and a Map for files. Nothing here
// runs update.mjs or touches an app home; update.test.mjs covers update.mjs's side in temp homes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Updater } from "../mods/am-sidebar/updater.js";
import {
  FIRST_CHECK_MS, LANDING_MS, LANDING_WAIT_MS, RELOAD_GRACE_MS, REQUEST_KEY, STATE_KEY, autoPlan, backoffOf, busyOf,
} from "../mods/am-sidebar/updateCheck.js";
import { AUTO_FILE, CHECK_FILE, RESTORE_FILE, parseAuto } from "../mods/am-sidebar/release.js";
import { autoLabel, statusLabel } from "../mods/am-status/label.js";

const HOME = "/fake/herdr-app";
const NOW = 1_800_000_000_000;
const MANAGED = { on: true, skip: null, managed: true, why: null };
const update = (version) => ({ version, page: `https://x/v${version}`, sequence: 1 });
const line = (o) => ({ code: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "" });
const text = (l) => l.parts.map((p) => p.text).join("");

/**
 * One Herdr with the pack at `version`: `answer(args)` is update.mjs's reply (the args after the
 * script). Every build (`build()`) shares the shared values, the files, the clock and the notes; a
 * reload is `old.reloaded = true` (its timers stop, as Herdr stops a replaced build's) and a new build.
 */
function herdr({ version = "0.8.0", latest = "0.8.1", auto = MANAGED, answer = null } = {}) {
  const h = { shared: new Map(), files: new Map(), notes: [], execs: [], timers: [], tasks: [], now: NOW };
  h.files.set(`${HOME}/mods/am-sidebar/VERSION`, `${version}\n`);
  h.version = version;
  h.check = () => line({ current: h.version, latest, update: latest === h.version ? null : update(latest), disabled: false, auto });
  h.apply = (to) => line({ current: h.version, latest, update: update(latest), installed: { version: to }, notice: [] });
  h.answer = answer ?? ((args) => (args[1] === "check" ? h.check() : h.apply(args[args.indexOf("--expect") + 1])));
  h.build = () => {
    const b = { reloaded: false };
    b.u = new Updater({
      exec: async (node, args) => { h.execs.push(args.slice(1)); return h.answer(args); },
      get: (k) => h.shared.get(k), set: (k, v) => { h.shared.set(k, structuredClone(v)); return null; },
      notify: (n) => { h.notes.push(n); },
      after: (ms, fn) => { h.timers.push({ at: h.now + ms, fn, b }); },
      spawn: (fn) => { h.tasks.push(Promise.resolve().then(fn)); },
      readText: async (p) => h.files.get(p) ?? null,
      writeText: async (p, text, before) => { if ((h.files.get(p) ?? null) !== before) throw new Error("stale snapshot"); h.files.set(p, text); },
      appHome: HOME, now: () => h.now,
    });
    return b;
  };
  // Lets every task that can move on do so (one that waits on a hung exec stays waiting).
  h.flush = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)); };
  /** Moves the clock `ms` on, running each due timer of a build not reloaded. */
  h.tick = async (ms) => {
    const end = h.now + ms;
    for (;;) {
      await h.flush();
      const due = h.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers.splice(h.timers.indexOf(due), 1);
      h.now = Math.max(h.now, due.at);
      if (!due.b.reloaded) due.fn();
    }
    h.now = end;
    await h.flush();
  };
  /** update.mjs swapped the pack to `to`: VERSION says so, and Herdr reloads the build. */
  h.swap = (old, to) => { h.version = to; h.files.set(`${HOME}/mods/am-sidebar/VERSION`, `${to}\n`); old.reloaded = true; };
  h.applies = () => h.execs.filter((a) => a[0] === "apply");
  h.state = () => h.shared.get(STATE_KEY) ?? {};
  return h;
}

test("a newer verified release installs on its own through apply --expect <v> --auto; the new build says so once", async () => {
  const h = herdr();
  const old = h.build();
  // The exec of the install: the folders swap (Herdr reloads the mods) before update.mjs answers.
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = h.apply("0.8.1"); // update.mjs reports the version it replaced as current
    h.swap(old, "0.8.1");
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.applies(), [["apply", "--expect", "0.8.1", "--auto", "--mods", `${HOME}/mods`]]);
  assert.equal(h.notes.length, 0, "no 'update available' notice for a release that installs on its own");
  assert.equal(h.state().kind, "installed");
  assert.equal(busyOf(h.state(), h.now), null, "the claim is freed");
  // The new build: its VERSION is the release just installed.
  const fresh = h.build();
  fresh.u.start();
  await h.tick(1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /Your bots kept running\./);
  assert.match(h.notes[0].body, /`am update --rollback` puts 0\.8\.0 back/);
  // The old build's grace timer stopped with the reload; a later reload of the same build says nothing.
  await h.tick(RELOAD_GRACE_MS);
  h.build().u.start();
  await h.tick(1);
  assert.equal(h.notes.length, 1);
});

test("when Herdr does not reload the mods, the old build says what to do, once", async () => {
  const h = herdr();
  const old = h.build();
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.applies().length, 1);
  await h.tick(RELOAD_GRACE_MS);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /quit Herdr \(⌘Q\) and open it again/);
});

test("the new build waits for the old one's answer (bots to restart), and announces anyway when it never comes", async () => {
  const h = herdr();
  const old = h.build();
  let answer;
  h.answer = (args) => (args[1] === "check" ? h.check() : new Promise((done) => { answer = done; }));
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  h.swap(old, "0.8.1");
  const fresh = h.build();
  fresh.u.start();
  await h.tick(5_000);
  assert.equal(h.notes.length, 0, "the old build's install is still running");
  answer(line({ current: "0.8.0", latest: "0.8.1", installed: { version: "0.8.1" }, notice: ["IMPORTANT: the bots' briefing hook moved"] }));
  await h.tick(1_000);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /restart each Claude bot/);

  // The old build stopped mid-install and never answers: the lock is freed and the notice posted.
  const g = herdr();
  const gold = g.build();
  g.answer = (args) => (args[1] === "check" ? g.check() : new Promise(() => {}));
  gold.u.start();
  await g.tick(FIRST_CHECK_MS);
  g.swap(gold, "0.8.1");
  g.build().u.start();
  await g.tick(LANDING_WAIT_MS + 2_000);
  assert.deepEqual(g.notes.map((n) => [n.title, /bots kept running\./.test(n.body)]), [["Automagik Herdr updated to 0.8.1", true]]);
  assert.equal(busyOf(g.state(), g.now), null);
  assert.equal(g.state().kind, "installed");
});

test("off: no install, today's notice once", async () => {
  const h = herdr({ auto: { ...MANAGED, on: false } });
  h.build().u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.applies(), []);
  assert.deepEqual(h.notes.map((n) => n.body), ["Automagik Herdr 0.8.1 is out. Run `am update` to install it (https://x/v0.8.1)."]);
  await h.tick(backoffOf(1));
  assert.equal(h.notes.length, 1, "the next check doesn't announce it again");
});

test("a bad pack is restored: one notice names the failed version and mod, the mods reload, nothing restarts", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", check: { failed: ["am-tabs"], checked: true },
        restored: { version: "0.8.0", failedVersion: "0.8.1", mod: "am-tabs", failed: ["am-tabs"], checked: true,
          prevRemoved: true, warnings: ["the failed pack could not be removed (EACCES: permission denied, rm '/x/.prev-next-1'): it is in /x/.prev-next-1"] } } });
    h.swap(old, "0.8.0"); // the kept set is back: Herdr reloads the mods into it
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.applies(), [["apply", "--expect", "0.8.1", "--auto", "--mods", `${HOME}/mods`]], "only the updater ran");
  assert.equal(old.reloaded, true, "the restored folders reloaded the mod");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /0\.8\.1 failed to load \(am-tabs failed herdr-app check\): the previous version 0\.8\.0 is back/);
  assert.match(h.notes[0].body, /The failed pack was removed, so `am update --rollback` has nothing to go back to\./);
  assert.match(h.notes[0].body, /Warning: the failed pack could not be removed .*\.prev-next-1/);
  assert.equal(h.state().kind, "restored");
  assert.equal(h.state().announced, "0.8.0");
  assert.equal(h.state().autoFailed, null, "a restore is not a failed install with a backoff");
  assert.equal(h.state().autoHeld, null);
  // The reloaded restored build says nothing more; the bad version is held, not retried.
  h.check = () => line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), disabled: false, auto: { ...MANAGED, skip: "0.8.1" } });
  h.build().u.start();
  await h.tick(LANDING_MS + 1_000);
  assert.equal(h.notes.length, 1);
  await h.tick(backoffOf(1));
  assert.equal(h.applies().length, 1, "the bad version waits for a newer release");
  assert.equal(h.notes.length, 1, "no second notice for the held version");
});

test("the restored build reads update.mjs's note when the old build never hears back", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => (args[1] === "check" ? h.check() : new Promise(() => {}));
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  h.files.set(`${HOME}/automagik-herdr/${RESTORE_FILE}`, JSON.stringify({ version: "0.8.0", failedVersion: "0.8.1",
    mod: "am-tabs", failed: ["am-tabs"], checked: true, prevRemoved: true,
    warnings: ["the failed pack could not be removed (EACCES: permission denied, rm '/x/.prev-next-1'): it is in /x/.prev-next-1"], at: h.now }));
  h.check = () => line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), disabled: false, auto: { ...MANAGED, skip: "0.8.1" } });
  h.swap(old, "0.8.0");
  h.build().u.start();
  await h.tick(1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr restored 0.8.0"]);
  assert.match(h.notes[0].body, /0\.8\.1 failed to load \(am-tabs failed herdr-app check\): the previous version 0\.8\.0 is back/);
  assert.match(h.notes[0].body, /The failed pack was removed, so `am update --rollback` has nothing to go back to\./);
  assert.match(h.notes[0].body, /Warning: the failed pack could not be removed .*\.prev-next-1/);
  // A later build of the restored version says nothing more.
  h.build().u.start();
  await h.tick(1);
  assert.equal(h.notes.length, 1);
  // The next check holds the bad version.
  await h.tick(backoffOf(1));
  assert.equal(h.applies().length, 1);
});

test("the new build reads update.mjs's unchecked note when the old build never hears back", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => (args[1] === "check" ? h.check() : new Promise(() => {}));
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  h.files.set(`${HOME}/automagik-herdr/${CHECK_FILE}`, JSON.stringify({ version: "0.8.1", from: "0.8.0",
    unavailable: "herdr-app is not on PATH", at: h.now }));
  h.swap(old, "0.8.1");
  h.build().u.start();
  await h.tick(1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /herdr-app is not on PATH: the update was kept, but its mods were not checked/);
  h.build().u.start();
  await h.tick(1);
  assert.equal(h.notes.length, 1, "the note doesn't repeat");
});

test("a bad pack with nothing kept: one clear notice, the bad version kept, no retry loop", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    h.swap(old, "0.8.1"); // nothing to restore: the bad pack stays installed
    return line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", check: { failed: ["am-tabs"], checked: true },
        restoreError: "could not restore: no previous version kept" } });
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /previous version could not be restored: no previous version kept/);
  assert.equal(h.state().kind, "restore-failed");
  assert.equal(h.state().announced, "0.8.1");
  // The build of the bad release stays quiet, and the next check has nothing to install.
  h.build().u.start();
  await h.tick(LANDING_MS + 1_000);
  assert.equal(h.notes.length, 1);
  await h.tick(backoffOf(1));
  assert.equal(h.applies().length, 1, "the bad version is not installed again");
});

test("herdr-app missing after an install: the update is kept, one notice says it was not checked", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", check: { failed: [], checked: false, unavailable: "herdr-app is not on PATH" } } });
    h.swap(old, "0.8.1");
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.notes.length, 0, "the old build waits for the reload");
  h.build().u.start();
  await h.tick(1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /herdr-app is not on PATH: the update was kept, but its mods were not checked/);
  await h.tick(LANDING_MS + 1_000);
  assert.equal(h.notes.length, 1);
});


test("a failed mod wins over a later dead check: one restore notice says both", async () => {
  const h = herdr();
  const old = h.build();
  const unavailable = "the herdr-app check could not run (SIGTERM)";
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", check: { failed: ["am-sidebar"], checked: true, unavailable },
        restored: { version: "0.8.0", failedVersion: "0.8.1", mod: "am-sidebar", failed: ["am-sidebar"],
          checked: true, unavailable } } });
    h.swap(old, "0.8.0");
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /0\.8\.1 failed to load \(am-sidebar failed herdr-app check; the herdr-app check could not run \(SIGTERM\)\): the previous version 0\.8\.0 is back/);
  assert.equal(h.state().kind, "restored");
  assert.equal(h.state().announced, "0.8.0");
});

test("a check killed before any mod is judged: the update is kept, one unchecked notice", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", check: { failed: [], checked: false,
        unavailable: "the herdr-app check could not run (SIGTERM)" } } });
    h.swap(old, "0.8.1");
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.notes.length, 0, "the old build waits for the reload");
  h.build().u.start();
  await h.tick(1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr updated to 0.8.1"]);
  assert.match(h.notes[0].body, /the herdr-app check could not run \(SIGTERM\): the update was kept, but its mods were not checked/);
  await h.tick(LANDING_MS + 1_000);
  assert.equal(h.notes.length, 1);
});

test("a version rolled back is skipped and the notice says it waits for a newer one; a newer one installs", async () => {
  const h = herdr({ auto: { ...MANAGED, skip: "0.8.1" } });
  const b = h.build();
  b.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.applies(), []);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /you rolled it back here, so it won't install on its own: the next newer release will/);
  assert.match(h.state().autoHeld, /0\.8\.1 was rolled back here/);
  const l = autoLabel({ state: h.state(), now: h.now });
  assert.equal(l.text, "Install updates automatically: on");
  assert.match(l.tooltip, /0\.8\.1 was rolled back here: it waits for a newer release/);
  // 0.8.2 is out: newer than the skip, so it goes in.
  h.check = () => line({ current: "0.8.0", latest: "0.8.2", update: update("0.8.2"), disabled: false, auto: { ...MANAGED, skip: "0.8.1" } });
  await h.tick(backoffOf(1));
  assert.deepEqual(h.applies().map((a) => a[2]), ["0.8.2"]);
});

test("no install while another check or install holds the claim", async () => {
  const h = herdr();
  h.shared.set(STATE_KEY, { busy: { what: "apply", since: NOW, id: "apply-other", to: "0.8.1" } });
  const b = h.build();
  b.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.execs, [], "the claim is held: not even a check");
  assert.equal(b.u.apply(null, "0.8.1", { auto: true }), false);
  await h.flush();
  assert.deepEqual(h.applies(), []);
});

test("a checkout or a hand-installed pack is never installed on its own: today's notice", async () => {
  for (const why of ["mods/am-sidebar is a link to a checkout: update it with git", "this pack was not installed by install.sh (no install record)"]) {
    const h = herdr({ auto: { on: true, skip: null, managed: false, why } });
    h.build().u.start();
    await h.tick(FIRST_CHECK_MS);
    assert.deepEqual(h.applies(), []);
    assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr update"]);
    assert.equal(autoLabel({ state: h.state(), now: h.now }), null, "no switch where it doesn't apply");
  }
  // An update.mjs from before auto-update answers no `auto`: today's behaviour too.
  const h = herdr({ auto: null });
  h.build().u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.applies(), []);
  assert.equal(h.notes.length, 1);
});

test("a failed install on its own: one notice with the reason, then it backs off and never loops", async () => {
  const h = herdr();
  h.answer = (args) => (args[1] === "check" ? h.check() : { code: 1, stdout: '{"error":"sha256 mismatch for automagik-herdr-pack-0.8.1.tgz"}\n', stderr: "" });
  const b = h.build();
  b.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.applies().length, 1);
  assert.deepEqual(h.notes.map((n) => n.title), ["Automagik Herdr not updated"]);
  assert.match(h.notes[0].body, /Installing 0\.8\.1 failed: sha256 mismatch.*Nothing was changed; it tries again in 4 h/);
  assert.equal(busyOf(h.state(), h.now), null);
  // A check within the backoff (the status bar's "check now") installs nothing.
  await h.tick(60 * 60_000);
  b.u.check(false);
  await h.flush();
  assert.equal(h.applies().length, 1);
  assert.match(h.state().autoHeld, /the last try failed/);
  // After it: tried again; a second failure of the same version posts nothing and doubles the wait.
  await h.tick(backoffOf(1));
  assert.equal(h.applies().length, 2);
  assert.equal(h.notes.length, 1);
  assert.equal(h.state().autoFailed.count, 2);
  await h.tick(backoffOf(1));
  assert.equal(h.applies().length, 2, `the third try waits ${backoffOf(2)} ms`);
  assert.ok(backoffOf(2) > backoffOf(1) && backoffOf(9) === 24 * 60 * 60 * 1000);
});

test("a held install (update.mjs saw the switch off or a rollback under its lock) is quiet", async () => {
  const h = herdr();
  h.answer = (args) => (args[1] === "check" ? h.check()
    : line({ current: "0.8.0", latest: "0.8.1", installed: null, held: "another update or rollback is running: try again when it is done" }));
  h.build().u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.applies().length, 1);
  assert.deepEqual(h.notes, []);
  assert.equal(h.state().autoFailed, undefined, "not a failure: the next check tries again");
  assert.match(h.state().autoHeld, /another update or rollback/);
});

test("the status bar's switch writes the pack's setting file and shows at once", async () => {
  const h = herdr();
  const b = h.build();
  b.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(autoLabel({ state: h.state(), now: h.now }).text, "Install updates automatically: on");
  h.shared.set(REQUEST_KEY, { id: "auto-1", what: "auto", on: false, at: h.now });
  b.u.request();
  await h.flush();
  assert.deepEqual(parseAuto(h.files.get(`${HOME}/automagik-herdr/${AUTO_FILE}`)), { on: false, skip: null });
  assert.equal(autoLabel({ state: h.state(), request: h.shared.get(REQUEST_KEY), now: h.now }).text, "Install updates automatically: off");
  // The skip survives the switch.
  h.files.set(`${HOME}/automagik-herdr/${AUTO_FILE}`, '{ "auto": false, "skip": "0.8.1" }\n');
  h.shared.set(REQUEST_KEY, { id: "auto-2", what: "auto", on: true, at: h.now });
  b.u.request();
  await h.flush();
  assert.deepEqual(parseAuto(h.files.get(`${HOME}/automagik-herdr/${AUTO_FILE}`)), { on: true, skip: "0.8.1" });
});

test("a version that just landed is never installed again on its own, even when the record still says otherwise", () => {
  const state = { kind: "update", update: update("0.8.1"), auto: MANAGED, landed: { version: "0.8.1", from: "0.8.0", at: NOW } };
  assert.deepEqual(autoPlan(state, NOW + 60_000), { hold: "0.8.1 was just installed" });
  assert.deepEqual(autoPlan(state, NOW + LANDING_MS), { apply: "0.8.1" }, "after the landing window, a check's answer stands");
});

test("the latest moved on between check and install: no failure, no notice, it goes in at the next check", async () => {
  const h = herdr();
  h.answer = (args) => (args[1] === "check" ? h.check()
    : line({ current: "0.8.0", latest: "0.8.2", update: update("0.8.2"), installed: null, refused: { expected: "0.8.1", latest: "0.8.2" }, auto: MANAGED }));
  h.build().u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.deepEqual(h.notes, []);
  assert.equal(h.state().autoFailed, undefined);
  assert.equal(h.state().applyError, null);
  assert.equal(h.state().autoHeld, "a newer release came out; it installs at the next check");
  h.check = () => line({ current: "0.8.0", latest: "0.8.2", update: update("0.8.2"), disabled: false, auto: MANAGED });
  await h.tick(backoffOf(1));
  assert.deepEqual(h.applies().map((a) => a[2]), ["0.8.1", "0.8.2"]);
});

test("the switch is written by one sidebar copy, not by each", async () => {
  const h = herdr();
  const [a, b] = [h.build(), h.build()];
  a.u.start(); b.u.start();
  await h.tick(FIRST_CHECK_MS);
  h.shared.set(REQUEST_KEY, { id: "auto-1", what: "auto", on: false, at: h.now });
  a.u.request(); b.u.request();
  await h.flush();
  const file = `${HOME}/automagik-herdr/${AUTO_FILE}`;
  assert.equal(h.files.has(file), true);
  assert.equal(h.state().autoError ?? null, null, "no second writer hit a stale snapshot");
});

test("failure retries land 4 h, then 8 h, 16 h and 24 h after each failure, then daily", async () => {
  const h = herdr();
  // A failed install takes a while (the download's timeout): its failure is recorded after the
  // check that started it, so the check due at the end of the wait comes a little early.
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    h.now += 2 * 60_000;
    return { code: 1, stdout: '{"error":"network down"}\n', stderr: "" };
  };
  h.build().u.start();
  await h.tick(FIRST_CHECK_MS);
  const tries = [h.now];
  for (let i = 0; i < 12 * 6; i++) {
    const before = h.applies().length;
    await h.tick(backoffOf(1));
    if (h.applies().length > before) tries.push(h.now);
  }
  const gaps = tries.slice(1).map((t, i) => Math.round((t - tries[i]) / 3_600_000));
  assert.deepEqual(gaps.slice(0, 6), [4, 8, 16, 24, 24, 24]);
  assert.equal(h.notes.length, 1, "one notice for the version, however many tries");
});

test("a failed record write is not 'nothing was changed': the notice says the release went in", async () => {
  const { autoFailedNotice } = await import("../mods/am-sidebar/updateCheck.js");
  const note = autoFailedNotice({ version: "0.8.1", count: 1, at: NOW,
    why: "0.8.1 went in, but the install record could not be written (/x/installed-by-install.sh)" });
  assert.equal(note.title, "Automagik Herdr update not finished");
  assert.doesNotMatch(note.body, /Nothing was changed/);
  assert.match(note.body, /0\.8\.1 was put in place, but its install record could not be saved/);
  assert.match(autoFailedNotice({ version: "0.8.1", count: 1, at: NOW, why: "network down" }).body, /Nothing was changed/);
});

test("a mod an install held for a layout reaches the new build's notice, with what retires it", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => {
    if (args[1] === "check") return h.check();
    const answer = line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [],
      installed: { version: "0.8.1", held: [{ mod: "old-mod", layouts: ["mine", "work"] }] } });
    h.swap(old, "0.8.1");
    return answer;
  };
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  const fresh = h.build();
  fresh.u.start();
  await h.tick(1);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /Kept mods\/old-mod: 0\.8\.1 no longer ships it, but the layouts mine, work show it/);
  assert.match(h.notes[0].body, /Take its block out of each of those layouts, or remove them/);
  assert.match(h.notes[0].body, /Switching layouts does not retire it/);
  // A later build of this release, the record still there: it says nothing more.
  h.build().u.start();
  await h.tick(1);
  assert.equal(h.notes.length, 1, "the note doesn't repeat");
});

const HELD = `${HOME}/automagik-herdr/held-mods.json`;
const heldJson = (version) => JSON.stringify({ version, held: [{ mod: "old-mod", layouts: ["mine"] }] });

test("the old build never answers: the new build reads the held file, says it once, and another release's file says nothing", async () => {
  const run = async (fileVersion) => {
    const g = herdr();
    const gold = g.build();
    g.answer = (args) => (args[1] === "check" ? g.check() : new Promise(() => {}));
    gold.u.start();
    await g.tick(FIRST_CHECK_MS);
    g.files.set(HELD, heldJson(fileVersion));
    g.swap(gold, "0.8.1");
    g.build().u.start();
    await g.tick(LANDING_WAIT_MS + 2_000);
    return g;
  };
  const g = await run("0.8.1");
  assert.equal(g.notes.length, 1);
  assert.match(g.notes[0].body, /Your bots kept running\. Kept mods\/old-mod: 0\.8\.1 no longer ships it, but the mine layout shows it/);
  // Later builds and later checks of this release, with the file still there: nothing more.
  g.build().u.start();
  await g.tick(LANDING_WAIT_MS + 2_000);
  assert.equal(g.notes.length, 1, "the note doesn't repeat");
  const stale = await run("0.8.0");
  assert.equal(stale.notes.length, 1);
  assert.doesNotMatch(stale.notes[0].body, /Kept mods/, "a release that held nothing repeats no old note");
});

test("Herdr doesn't reload: the old build's notice says what it held, and the new build says nothing more", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => (args[1] === "check" ? h.check()
    : line({ current: "0.8.0", latest: "0.8.1", update: update("0.8.1"), notice: [], installed: { version: "0.8.1", held: [{ mod: "old-mod", layouts: ["mine"] }] } }));
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.notes.length, 0);
  await h.tick(RELOAD_GRACE_MS + 1);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /^Herdr did not reload its mods: .* Kept mods\/old-mod: 0\.8\.1 no longer ships it, but the mine layout shows it/);
  // Quit and opened again, as the notice says: the new build stays quiet.
  h.files.set(HELD, heldJson("0.8.1"));
  h.swap(old, "0.8.1");
  h.build().u.start();
  await h.tick(LANDING_WAIT_MS + 2_000);
  assert.equal(h.notes.length, 1, "the note doesn't repeat");
});

test("a check during an automatic apply waits: updating, then the install result, never couldn't check", async () => {
  const h = herdr();
  const old = h.build();
  h.answer = (args) => (args[1] === "check" ? h.check() : new Promise(() => {})); // the install never answers
  old.u.start();
  await h.tick(FIRST_CHECK_MS);
  assert.equal(h.applies().length, 1);
  await h.tick(2_000); // after the check's own answer, so only the install can answer this request
  const request = { id: "bar-check-1", what: "check", at: h.now };
  h.shared.set(REQUEST_KEY, request);
  old.u.request();
  await h.flush();
  assert.equal(h.state().queued?.id, request.id, "the sidebar takes the request behind the install");
  const bar = () => statusLabel({ state: h.state(), request: h.shared.get(REQUEST_KEY), version: h.version, now: h.now });
  assert.equal(text(bar()), "0.8.0 → 0.8.1 · updating…");
  // The install outlives ANSWER_MS: still updating, never couldn't check.
  await h.tick(15_000);
  assert.equal(text(bar()), "0.8.0 → 0.8.1 · updating…");
  assert.doesNotMatch(text(bar()), /couldn't/);
  // The folders swap and Herdr reloads the mods; the old build's lock is still on the install, and
  // VERSION already says the release it went for, so the install branch is skipped.
  h.swap(old, "0.8.1");
  const fresh = h.build();
  fresh.u.start();
  await h.tick(1);
  fresh.u.request(); // the new build's 250 ms poll: it must not run a second look
  assert.equal(h.execs.filter((args) => args[0] === "check").length, 1, "one check, the one that found the update");
  assert.equal(h.state().busy?.what, "apply", "the new build waits for the old build's answer");
  assert.equal(text(bar()), "Automagik Herdr 0.8.1 · checking…", "the queued check is waiting, not failed");
  assert.doesNotMatch(text(bar()), /couldn't/);
  // The old build never answers (the reload stopped it): the landing records the install and
  // answers the queued check with its result.
  await h.tick(LANDING_WAIT_MS + 2_000);
  assert.equal(busyOf(h.state(), h.now), null);
  assert.equal(h.state().kind, "installed");
  assert.equal(h.state().request, request.id);
  assert.equal(h.state().queued, null);
  assert.equal(text(bar()), "Automagik Herdr 0.8.1");
  assert.doesNotMatch(text(bar()), /couldn't/);
});

test("a check asked for while one runs is answered by it: one check, the later request gets its result", async () => {
  const h = herdr({ auto: { ...MANAGED, on: false } });
  let release;
  const running = new Promise((done) => { release = done; });
  h.answer = (args) => (args[1] === "check" ? running.then(() => h.check()) : h.apply(args[args.indexOf("--expect") + 1]));
  const b = h.build();
  b.u.start();
  await h.tick(FIRST_CHECK_MS); // the check is in flight: its exec has not answered
  const checks = () => h.execs.filter((args) => args[0] === "check").length;
  assert.equal(checks(), 1);
  const request = { id: "bar-check-2", what: "check", at: h.now };
  h.shared.set(REQUEST_KEY, request);
  b.u.request();
  await h.flush();
  assert.equal(h.state().queued?.id, request.id, "queued behind the running check");
  assert.equal(text(statusLabel({ state: h.state(), request, version: h.version, now: h.now })), "Automagik Herdr 0.8.0 · checking…");
  release();
  await h.tick(1);
  assert.equal(checks(), 1, "no second check");
  assert.equal(h.state().request, request.id, "the running check's result answers the later request");
  assert.equal(h.state().queued, null);
  assert.equal(text(statusLabel({ state: h.state(), request, version: h.version, now: h.now })), "0.8.0 → 0.8.1 · update");
});

test("a request still waiting at a mods reload is answered by the new build once; an answered one is not answered twice", async () => {
  const h = herdr({ auto: { ...MANAGED, on: false } });
  const checks = () => h.execs.filter((args) => args[0] === "check").length;
  const old = h.build();
  old.u.start();
  // The click is saved, and Herdr reloads the mods before that build's 250 ms poll takes it.
  const request = { id: "bar-check-3", what: "check", at: h.now };
  h.shared.set(REQUEST_KEY, request);
  old.reloaded = true;
  const fresh = h.build();
  fresh.u.start();
  fresh.u.request(); // the reloaded build's poll: it answers the waiting request
  await h.flush();
  assert.equal(checks(), 1, "the waiting request runs once, in the new build");
  assert.equal(h.state().request, request.id);
  assert.equal(h.state().queued, null);
  // Polling again is a no-op: the same request is not answered twice.
  fresh.u.request();
  await h.flush();
  assert.equal(checks(), 1);
  assert.equal(h.state().request, request.id);
  // A later build over the shared state sees it answered: no second run, no second answer.
  const at = h.state().at;
  fresh.reloaded = true;
  const newer = h.build();
  newer.u.start();
  newer.u.request();
  await h.flush();
  assert.equal(checks(), 1, "an answered request survives the reload without a second check");
  assert.equal(h.state().at, at, "and without a second answer");
  assert.equal(h.state().request, request.id);
});
