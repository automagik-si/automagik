// am-status: the status bar's version label (label.js) and the sidebar's one-check-at-a-time lock
// and request handling (updateCheck.js) they share through two shared values.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as label from "../mods/am-status/label.js";
import * as check from "../mods/am-sidebar/updateCheck.js";

const { statusLabel, confirmText, offered, ago } = label;
const NOW = 1_800_000_000_000;
const text = (l) => l.parts.map((p) => p.text).join("");
const clicks = (l) => l.parts.filter((p) => p.click).map((p) => [p.text, p.click]);

// A Map behind Herdr's shared/setShared.
function sharedStore() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, structuredClone(v)); return null; }, m };
}

test("label.js names the same shared keys and stale times as updateCheck.js (no import across mod folders)", () => {
  assert.equal(label.STATE_KEY, check.STATE_KEY);
  assert.equal(label.REQUEST_KEY, check.REQUEST_KEY);
  assert.equal(label.CHECK_STALE_MS, check.CHECK_STALE_MS);
  assert.equal(label.APPLY_STALE_MS, check.APPLY_STALE_MS);
});

test("up to date: 'Automagik Herdr 0.8.0', dim, a click checks now; the tooltip says when it looked", () => {
  const l = statusLabel({ state: { kind: "current", current: "0.8.0", latest: "0.8.0", at: NOW - 12 * 60_000 }, version: "0.8.0", now: NOW });
  assert.equal(text(l), "Automagik Herdr 0.8.0");
  assert.deepEqual(l.parts.map((p) => p.tone), ["dim"]);
  assert.deepEqual(clicks(l), [["Automagik Herdr 0.8.0", "check"]]);
  assert.match(l.tooltip, /Up to date \(checked 12 min ago\)/);
});

test("update available: '0.8.0 → 0.8.1 · update', only 'update' is accent and installs", () => {
  const state = { kind: "update", current: "0.8.0", latest: "0.8.1", update: { version: "0.8.1", page: "https://x" }, at: NOW };
  const l = statusLabel({ state, version: "0.8.0", now: NOW });
  assert.equal(text(l), "0.8.0 → 0.8.1 · update");
  assert.deepEqual(l.parts.filter((p) => p.tone === "accent").map((p) => p.text), ["update"]);
  assert.deepEqual(clicks(l), [["update", "update"]]);
  assert.match(l.tooltip, /0\.8\.1 is out/);
  // A failed install keeps offering the update, the reason in the tooltip.
  const failed = statusLabel({ state: { ...state, applyError: "sha256 mismatch" }, version: "0.8.0", now: NOW });
  assert.equal(text(failed), "0.8.0 → 0.8.1 · update");
  assert.match(failed.tooltip, /Not installed: sha256 mismatch/);
  assert.equal(offered(state, "0.8.0"), "0.8.1");
  assert.equal(offered(state, "0.8.1"), null, "already installed (VERSION moved on): nothing to confirm");
  assert.equal(offered({ kind: "current" }, "0.8.0"), null);
});

test("an update whose version is already installed (VERSION read after the swap) reads as up to date", () => {
  const l = statusLabel({ state: { kind: "update", current: "0.8.0", update: { version: "0.8.1", page: "p" }, at: NOW }, version: "0.8.1", now: NOW });
  assert.equal(text(l), "Automagik Herdr 0.8.1");
});

test("checking: the sidebar's lock, or the bar's own request before the sidebar takes it", () => {
  const busy = statusLabel({ state: { kind: "current", busy: { what: "check", since: NOW - 1000, id: "c" } }, version: "0.8.0", now: NOW });
  assert.equal(text(busy), "Automagik Herdr 0.8.0 · checking…");
  assert.deepEqual(clicks(busy), [], "no second check while one runs");
  const asked = statusLabel({ state: { kind: "current", at: NOW - 60_000 }, request: { id: "r", what: "check", at: NOW - 500 }, version: "0.8.0", now: NOW });
  assert.equal(text(asked), "Automagik Herdr 0.8.0 · checking…");
  // Answered: the state's request id, or an answer newer than the request.
  const done = statusLabel({ state: { kind: "current", at: NOW, request: "r" }, request: { id: "r", what: "check", at: NOW - 500 }, version: "0.8.0", now: NOW });
  assert.equal(text(done), "Automagik Herdr 0.8.0");
});

test("a request no sidebar takes turns into 'couldn't check' after ANSWER_MS, then is forgotten", () => {
  const request = { id: "r", what: "check", at: NOW - label.ANSWER_MS };
  const l = statusLabel({ state: { kind: "current", at: NOW - 3_600_000 }, request, version: "0.8.0", now: NOW });
  assert.equal(text(l), "0.8.0 · couldn't check");
  assert.match(l.tooltip, /sidebar/);
  assert.deepEqual(clicks(l), [["0.8.0 · couldn't check", "check"]]);
  const old = statusLabel({ state: { kind: "current", at: NOW - 3_600_000 }, request: { ...request, at: NOW - 3 * 60_000 }, version: "0.8.0", now: NOW });
  assert.equal(text(old), "Automagik Herdr 0.8.0");
  // No sidebar at all: checking just before ANSWER_MS, failed from it, never before.
  const fresh = { id: "r2", what: "check", at: NOW };
  const state = { kind: "current", at: NOW - 3_600_000 };
  assert.equal(text(statusLabel({ state, request: fresh, version: "0.8.0", now: NOW + label.ANSWER_MS - 1 })),
    "Automagik Herdr 0.8.0 · checking…");
  assert.equal(text(statusLabel({ state, request: fresh, version: "0.8.0", now: NOW + label.ANSWER_MS })),
    "0.8.0 · couldn't check");
});

test("a request queued behind a busy run waits (checking/updating), never 'couldn't check'", () => {
  const request = { id: "r", what: "check", at: NOW - 15_000 };
  const busy = { what: "apply", since: NOW - 40_000, id: "a", to: "0.8.1", from: "0.8.0" };
  // The folders swapped (VERSION says 0.8.1) while the old build still holds the install's lock:
  // the install branch is skipped, but the queued request is waiting for its answer.
  const state = { kind: "update", busy, queued: { id: request.id, what: "check", at: request.at } };
  assert.equal(text(statusLabel({ state, request, version: "0.8.1", now: NOW })), "Automagik Herdr 0.8.1 · checking…");
  // The run's own lock says it waited too, acknowledged or not.
  assert.equal(text(statusLabel({ state: { kind: "update", busy }, request, version: "0.8.1", now: NOW })),
    "Automagik Herdr 0.8.1 · checking…");
  // The acknowledgment alone, once the lock is gone, is a dead run: couldn't check, clickable.
  const dead = statusLabel({ state: { queued: state.queued }, request, version: "0.8.1", now: NOW });
  assert.equal(text(dead), "0.8.1 · couldn't check");
  assert.deepEqual(clicks(dead), [["0.8.1 · couldn't check", "check"]]);
  assert.match(dead.tooltip, /run did not finish/);
  // An install asked for while the install ran is waiting for it, not failed.
  const apply = { id: "a2", what: "apply", to: "0.8.1", at: NOW - 15_000 };
  const l = statusLabel({ state, request: apply, version: "0.8.1", now: NOW });
  assert.equal(text(l), "Automagik Herdr 0.8.1 · updating…");
  assert.doesNotMatch(text(l), /couldn't/);
});

test("a queued request whose run died falls back to couldn't check (the run did not finish), not checking forever", () => {
  const request = { id: "r", what: "check", at: NOW };
  // The sidebar took the click and then closed: no lock, no answer, no sidebar.
  const state = { kind: "current", at: NOW - 3_600_000, queued: { id: request.id, what: "check", at: NOW } };
  const at = (ms, s = state) => statusLabel({ state: s, request, version: "0.8.0", now: NOW + ms });
  assert.equal(text(at(label.ANSWER_MS - 1)), "Automagik Herdr 0.8.0 · checking…", "the first 10 s are grace");
  const dead = at(label.ANSWER_MS);
  assert.equal(text(dead), "0.8.0 · couldn't check", "dead run: the wait is bounded");
  assert.deepEqual(clicks(dead), [["0.8.0 · couldn't check", "check"]], "and it can be clicked again");
  assert.match(dead.tooltip, /run did not finish/);
  // A lock left behind and gone stale is the same dead run, not a live wait.
  const stale = { ...state, busy: { what: "check", since: NOW - label.CHECK_STALE_MS - 1_000, id: "c" } };
  assert.equal(text(at(30_000, stale)), "0.8.0 · couldn't check");
  // A live run keeps the wait: checking while it runs, however long ANSWER_MS is past.
  const live = { ...state, busy: { what: "check", since: NOW - 1_000, id: "c" } };
  assert.equal(text(at(30_000, live)), "Automagik Herdr 0.8.0 · checking…");
  assert.doesNotMatch(text(at(30_000, live)), /couldn't/);
  // After the 2-minute request window it is forgotten, as before.
  assert.equal(text(at(2 * 60_000)), "Automagik Herdr 0.8.0");
});

test("offline or an error: '0.8.0 · couldn't check', the reason in the tooltip, a click tries again", () => {
  const l = statusLabel({ state: { kind: "retry", why: "getaddrinfo ENOTFOUND api.github.com", at: NOW - 60_000 }, version: "0.8.0", now: NOW });
  assert.equal(text(l), "0.8.0 · couldn't check");
  assert.match(l.tooltip, /ENOTFOUND/);
  assert.deepEqual(clicks(l), [["0.8.0 · couldn't check", "check"]]);
});

test("updates off: the version alone, nothing to click; not checked yet: the version, click to check", () => {
  const off = statusLabel({ state: { kind: "off", current: "0.8.0" }, version: "0.8.0", now: NOW });
  assert.equal(text(off), "Automagik Herdr 0.8.0");
  assert.deepEqual(clicks(off), []);
  assert.match(off.tooltip, /AUTOMAGIK_HERDR_NO_UPDATE/);
  const fresh = statusLabel({ state: null, version: "0.8.0", now: NOW });
  assert.equal(text(fresh), "Automagik Herdr 0.8.0");
  assert.match(fresh.tooltip, /Not checked yet/);
  assert.equal(text(statusLabel({ now: NOW })), "Automagik Herdr", "no VERSION read yet: never blank");
});

test("installing: '0.8.0 → 0.8.1 · updating…' until VERSION says 0.8.1; a stale lock is ignored", () => {
  const busy = { what: "apply", since: NOW - 5000, id: "a", to: "0.8.1" };
  assert.equal(text(statusLabel({ state: { kind: "update", busy }, version: "0.8.0", now: NOW })), "0.8.0 → 0.8.1 · updating…");
  assert.equal(text(statusLabel({ state: { kind: "update", update: { version: "0.8.1" }, busy }, version: "0.8.1", now: NOW })), "Automagik Herdr 0.8.1");
  const stale = { ...busy, since: NOW - check.APPLY_STALE_MS };
  assert.equal(text(statusLabel({ state: { kind: "update", update: { version: "0.8.1" }, busy: stale }, version: "0.8.0", now: NOW })), "0.8.0 → 0.8.1 · update");
  const installed = statusLabel({ state: { kind: "installed", from: "0.8.0", current: "0.8.1", at: NOW }, version: "0.8.1", now: NOW });
  assert.equal(text(installed), "Automagik Herdr 0.8.1");
  assert.match(installed.tooltip, /Updated from 0\.8\.0; Herdr reloaded its mods/);
});

test("the confirm dialog names both versions and the rollback", () => {
  const c = confirmText("0.8.0", "0.8.1");
  assert.equal(c.title, "Update Automagik Herdr to 0.8.1?");
  assert.match(c.detail, /0\.8\.1 in place of 0\.8\.0/);
  assert.match(c.detail, /am update --rollback/);
});

test("ago: minutes, hours, days", () => {
  assert.equal(ago(NOW - 10_000, NOW), "just now");
  assert.equal(ago(NOW - 5 * 60_000, NOW), "5 min ago");
  assert.equal(ago(NOW - 3 * 3_600_000, NOW), "3 h ago");
  assert.equal(ago(NOW - 72 * 3_600_000, NOW), "3 days ago");
});

test("one check at a time: a second claim while one runs is refused, whoever asks; finish frees it", () => {
  const s = sharedStore();
  const first = check.claim(s.get, s.set, "check", NOW);
  assert.equal(typeof first, "string");
  assert.equal(check.claim(s.get, s.set, "check", NOW + 1000), null, "a second check (another sidebar copy, a click)");
  assert.equal(check.claim(s.get, s.set, "apply", NOW + 1000), null, "an install waits for the check");
  check.finish(s.get, s.set, first, { kind: "current", at: NOW + 2000 });
  assert.equal(s.get(check.STATE_KEY).busy, null);
  assert.equal(s.get(check.STATE_KEY).kind, "current");
  const next = check.claim(s.get, s.set, "check", NOW + 3000);
  assert.equal(typeof next, "string");
  assert.notEqual(next, first);
});

test("one check at a time: a lock whose holder went quiet frees after its stale time, and the late holder can't clear the new one", () => {
  const s = sharedStore();
  const lost = check.claim(s.get, s.set, "check", NOW);
  assert.equal(check.claim(s.get, s.set, "check", NOW + check.CHECK_STALE_MS - 1), null);
  const taken = check.claim(s.get, s.set, "check", NOW + check.CHECK_STALE_MS);
  assert.equal(typeof taken, "string");
  check.finish(s.get, s.set, lost, { kind: "retry", why: "late", at: NOW + check.CHECK_STALE_MS + 1 });
  assert.equal(s.get(check.STATE_KEY).busy.id, taken, "the newer lock stays");
  assert.equal(s.get(check.STATE_KEY).why, "late", "the late answer is still recorded");
  // An install holds longer than a check.
  const t = sharedStore();
  check.claim(t.get, t.set, "apply", NOW, { to: "0.8.1" });
  assert.equal(check.claim(t.get, t.set, "check", NOW + check.CHECK_STALE_MS), null);
  assert.equal(t.get(check.STATE_KEY).busy.to, "0.8.1");
  assert.equal(typeof check.claim(t.get, t.set, "check", NOW + check.APPLY_STALE_MS), "string");
});

test("requestDue: a new, fresh check or apply request, once per id", () => {
  const r = { id: "r1", what: "check", at: NOW - 1000 };
  assert.equal(check.requestDue(r, null, NOW), "check");
  assert.equal(check.requestDue(r, "r1", NOW), null, "already handled");
  assert.equal(check.requestDue({ ...r, what: "apply" }, null, NOW), "apply");
  assert.equal(check.requestDue({ ...r, at: NOW - check.REQUEST_FRESH_MS - 1 }, null, NOW), null, "saved before a restart");
  assert.equal(check.requestDue({ ...r, what: "rm -rf" }, null, NOW), null);
  assert.equal(check.requestDue(null, null, NOW), null);
  assert.equal(check.requestDue("check", null, NOW), null);
});

test("checkPatch and applyPatch: update.mjs's JSON line as the shared state", () => {
  const out = (o, code = 0) => ({ code, stdout: `${JSON.stringify(o)}\n`, stderr: "" });
  const u = { version: "0.8.1", page: "https://example.invalid/r", tarball: "t", sums: "s" };
  assert.deepEqual(check.checkPatch(out({ current: "0.8.0", latest: "0.8.1", update: u, disabled: false }), NOW),
    { kind: "update", update: u, why: null, current: "0.8.0", latest: "0.8.1", at: NOW, applyError: null });
  assert.equal(check.checkPatch(out({ error: "offline" }, 1), NOW).kind, "retry");
  assert.equal(check.checkPatch(null, NOW).why, "node not found");

  const before = { kind: "update", current: "0.8.0", update: u };
  const done = check.applyPatch(out({ current: "0.8.0", latest: "0.8.1", update: u, installed: { version: "0.8.1" } }), before, NOW);
  assert.deepEqual([done.kind, done.from, done.current], ["installed", "0.8.0", "0.8.1"]);
  assert.match(check.applyNotice(done).body, /0\.8\.0 → 0\.8\.1.*--rollback.*Herdr reloads its mods/);
  const failed = check.applyPatch(out({ error: "sha256 mismatch for automagik-herdr-pack-0.8.1.tgz" }, 1), before, NOW);
  assert.deepEqual(failed, { applyError: "sha256 mismatch for automagik-herdr-pack-0.8.1.tgz", at: NOW });
  assert.equal(check.applyNotice(failed).level, "error");
  const nothing = check.applyPatch(out({ current: "0.8.1", latest: "0.8.1", update: null, installed: null }), before, NOW);
  assert.equal(nothing.kind, "current");
  assert.equal(check.applyNotice(nothing), null);
});

test("runCheck runs `apply` with the same node fallback when asked", async () => {
  const calls = [];
  const exec = async (node, args) => { calls.push([node, ...args]); return { code: 0, stdout: '{"installed":null}\n' }; };
  const { node } = await check.runCheck(exec, "/p/update.mjs", "/usr/local/bin/node", { mods: "/m", command: "apply" });
  assert.equal(node, "/usr/local/bin/node");
  assert.deepEqual(calls, [["/usr/local/bin/node", "/p/update.mjs", "apply", "--mods", "/m"]]);
});

test("manual checks at most once a minute (GitHub's 60/hour): coolingDown over the last answer", () => {
  assert.equal(check.MANUAL_CHECK_COOLDOWN_MS, 60_000);
  assert.equal(check.coolingDown({ at: NOW - 59_000 }, NOW), true);
  assert.equal(check.coolingDown({ at: NOW - 60_000 }, NOW), false);
  assert.equal(check.coolingDown({}, NOW), false, "never checked");
  assert.equal(check.coolingDown({ at: NOW + 120_000 }, NOW), false, "a clock that went back doesn't block for ever");
  // The sidebar answers a click inside the cooldown with the last check: the bar says "checked just now".
  const s = sharedStore();
  s.set(check.STATE_KEY, { kind: "current", current: "0.8.0", at: NOW - 20_000 });
  check.finish(s.get, s.set, null, { request: "r" });
  const l = statusLabel({ state: s.get(check.STATE_KEY), request: { id: "r", what: "check", at: NOW - 100 }, version: "0.8.0", now: NOW });
  assert.equal(text(l), "Automagik Herdr 0.8.0");
  assert.match(l.tooltip, /checked just now/);
});

test("an install runs only for the version the person confirmed", () => {
  const offer = { kind: "update", current: "0.8.0", update: { version: "0.8.1", page: "p" } };
  assert.equal(check.applyRefusal({ to: "0.8.1" }, offer), null);
  assert.match(check.applyRefusal({ to: "0.8.1" }, { ...offer, update: { version: "0.8.2", page: "p" } }), /0\.8\.2 is out now, not 0\.8\.1: confirm again/);
  assert.match(check.applyRefusal({}, offer), /no confirmed version/);
  assert.match(check.applyRefusal({ to: "0.8.1" }, { kind: "current", current: "0.8.1" }), /nothing to install/);
  // update.mjs's own refusal (the latest moved between the sidebar's look and the install): the
  // bar offers the new version and says why nothing went in.
  const out = { code: 0, stdout: `${JSON.stringify({ current: "0.8.0", latest: "0.8.2", update: { version: "0.8.2", page: "p" }, installed: null,
    refused: { expected: "0.8.1", latest: "0.8.2" } })}\n` };
  const patch = check.applyPatch(out, offer, NOW);
  assert.equal(patch.kind, "update");
  assert.equal(patch.update.version, "0.8.2");
  const l = statusLabel({ state: patch, version: "0.8.0", now: NOW });
  assert.equal(text(l), "0.8.0 → 0.8.2 · update");
  assert.match(l.tooltip, /Not installed: 0\.8\.2 is out now, not 0\.8\.1: confirm again/);
});

test("runCheck passes `--expect <v>` through to update.mjs apply", async () => {
  const calls = [];
  const exec = async (node, args) => { calls.push(args); return { code: 0, stdout: '{"installed":null}\n' }; };
  await check.runCheck(exec, "/p/update.mjs", "node", { mods: "/m", command: "apply", extra: ["--expect", "0.8.1"] });
  assert.deepEqual(calls, [["/p/update.mjs", "apply", "--expect", "0.8.1", "--mods", "/m"]]);
});

test("applyPatch carries installed.held; landedNotice says each held mod and drops a malformed one", () => {
  const out = (o) => ({ code: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "" });
  const held = [{ mod: "old-mod", layouts: ["mine"] }, { mod: 7 }, { mod: "x", layouts: [] }];
  const patch = check.applyPatch(out({ current: "0.8.0", installed: { version: "0.8.1", held } }), {}, NOW);
  assert.deepEqual(patch.heldMods, [held[0]]);
  assert.deepEqual(check.applyPatch(out({ current: "0.8.0", installed: { version: "0.8.1" } }), {}, NOW).heldMods, []);
  const { body } = check.landedNotice("0.8.1", "0.8.0", false, patch.heldMods);
  assert.match(body, /^Your bots kept running\. Kept mods\/old-mod: 0\.8\.1 no longer ships it, but the mine layout shows it, /);
  assert.match(body, /Take its block out of each of those layouts, or remove them.*Switching layouts does not retire it/);
  assert.equal(check.landedNotice("0.8.1", null).body, "Your bots kept running.", "nothing held: the notice as before");
});
