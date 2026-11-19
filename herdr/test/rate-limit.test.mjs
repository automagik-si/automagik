// #1557: Claude Code's rate-limit dialog, read from a pane tail and never answered. The pure
// rules the CLI and the sidebar share (restart.js, model.js), over text alone: no pane, no hc.
import { test } from "node:test";
import assert from "node:assert/strict";

import { durationMs, rateLimitDialog, rateLimitLine, resetTimeFrom, wakeWait } from "../mods/am-sidebar/restart.js";
import { checkBots, onRateLimitProblem, parseBots, rateLimitModeOf } from "../mods/am-sidebar/model.js";

// A fixed local noon, so a clock time in a dialog is the same day and the assertions are too.
const NOW = new Date(2026, 10, 19, 12, 0, 0).getTime();
const localIso = (h, m = 0, day = 19) => new Date(2026, 10, day, h, m, 0, 0).toISOString();

const DIALOG = [
  "  ⎿  Rate limit reached",
  "",
  "  You have reached your Claude usage limit.",
  "  Your limit resets in 2 hours 10 minutes.",
  "",
  "  ❯ 1. Wait until it resets",
  "    2. Upgrade your plan",
  "    3. Switch accounts",
  "",
].join("\n");

test("a rate-limit dialog is found in the pane tail, with the reset time it shows", () => {
  const found = rateLimitDialog(DIALOG, NOW);
  assert.ok(found);
  assert.match(found.question, /usage limit|rate limit/i);
  assert.equal(found.resets_at, new Date(NOW + (2 * 60 + 10) * 60_000).toISOString());
  // ANSI colouring and a frame do not hide it.
  const framed = `\u001b[2m╭─\u001b[0m\n\u001b[1mRate limit reached\u001b[0m\nYour limit resets at 3:00 PM.\n1. Wait\n`;
  assert.deepEqual(rateLimitDialog(framed, NOW), { question: "Rate limit reached", resets_at: localIso(15) });
  // A dialog with no time still counts; the reset is omitted, never guessed.
  const noTime = rateLimitDialog("Rate limit reached\nYou have reached your usage limit.\n1. Wait\n", NOW);
  assert.ok(noTime);
  assert.equal("resets_at" in noTime, false);
});

test("the detector is narrow: scrollback, a passing retry line and a permission dialog are not the rate-limit dialog", () => {
  const scrollback = `${DIALOG}\n${Array.from({ length: 25 }, (_, i) => `an older line ${i}`).join("\n")}\n❯ \n`;
  assert.equal(rateLimitDialog(scrollback, NOW), null);
  assert.equal(rateLimitDialog("API Error: 429 rate_limit_error\nretrying in 30s\n", NOW), null);
  assert.equal(rateLimitDialog("Do you want to proceed?\n❯ 1. Yes\n  2. No\n", NOW), null);
  assert.equal(rateLimitDialog("", NOW), null);
  assert.equal(rateLimitDialog(null, NOW), null);
  // The limit words alone, with no wait and no choice, are a status line, not the dialog.
  assert.equal(rateLimitDialog("rate limit reached\n", NOW), null);
});

test("reset times: ISO, a duration, a local clock, tomorrow, and no guess when the dialog names none", () => {
  assert.equal(resetTimeFrom("resets at 2026-11-20T04:05:06Z", NOW), "2026-11-20T04:05:06.000Z");
  assert.equal(resetTimeFrom("try again in 45s", NOW), new Date(NOW + 45_000).toISOString());
  assert.equal(resetTimeFrom("You can continue in 1 hour 30 minutes.", NOW), new Date(NOW + 90 * 60_000).toISOString());
  assert.equal(resetTimeFrom("Your limit resets at 3:00 PM.", NOW), localIso(15));
  assert.equal(resetTimeFrom("Your limit resets at 9:15 AM.", NOW), localIso(9, 15, 20), "a time already past is tomorrow");
  assert.equal(resetTimeFrom("resets tomorrow at 9:00 AM", NOW), localIso(9, 0, 20));
  assert.equal(resetTimeFrom("resets at 15:30", NOW), localIso(15, 30));
  // Nothing to read: a bare number, a date without a time, an unknown unit.
  for (const text of ["resets at 5", "resets on 2026-11-20", "resets in 2 fortnights", "resets", ""]) {
    assert.equal(resetTimeFrom(text, NOW), null, text);
  }
});

test("duration parsing is exact and ignores words that are not units", () => {
  assert.equal(durationMs("2 hours 10 minutes"), 7_800_000);
  assert.equal(durationMs("5m"), 300_000);
  assert.equal(durationMs("1 day 2h 3s"), 86_400_000 + 7_200_000 + 3_000);
  assert.equal(durationMs("soon"), null);
});

test("an item says what happened once: parked, switched, or parked for want of a login, with the time when known", () => {
  const until = "2026-11-19T14:10:00.000Z";
  const local = (() => { const d = new Date(until); const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; })();
  assert.equal(rateLimitLine("Genie", { outcome: "parked", resetsAt: until }), `Genie is rate-limited until ${local}; parked`);
  assert.equal(rateLimitLine("Genie", { outcome: "switched to login 2", resetsAt: until }), `Genie is rate-limited until ${local}; switched to login 2`);
  assert.equal(rateLimitLine("Genie", { outcome: "parked", resetsAt: null }), "Genie is rate-limited; parked");
  assert.equal(rateLimitLine("Genie", { outcome: "parked (no second login with headroom)", resetsAt: until }),
    `Genie is rate-limited until ${local}; parked (no second login with headroom)`);
});

test("a parked wake is a duration, never negative, and a missing or bad time is due at once", () => {
  assert.equal(wakeWait(new Date(NOW + 90_000).toISOString(), NOW), 90_000);
  assert.equal(wakeWait(new Date(NOW - 90_000).toISOString(), NOW), 0);
  assert.equal(wakeWait(null, NOW), 0);
  assert.equal(wakeWait("not a time", NOW), 0);
});

test("a project's onRateLimit is park by default, switch when written, and never a third word", () => {
  const base = { version: 1, categories: [], bots: [{ id: "b-aaaaaaaaaa", name: "Main", kind: "main", role: "r", instructions: "i",
    agent: "claude", look: { character: "star", colour: "blue" } }] };
  assert.equal(rateLimitModeOf(base), "park");
  assert.equal(rateLimitModeOf({ ...base, onRateLimit: "switch" }), "switch");
  assert.equal(rateLimitModeOf({ ...base, onRateLimit: "nope" }), "park");
  assert.equal(onRateLimitProblem(undefined), null);
  assert.equal(onRateLimitProblem("park"), null);
  assert.equal(onRateLimitProblem("switch"), null);
  assert.match(onRateLimitProblem("nope"), /isn't one of park, switch/);
  assert.deepEqual(checkBots({ ...base, onRateLimit: "switch" }), []);
  assert.match(checkBots({ ...base, onRateLimit: "nope" }).join("; "), /onRateLimit "nope"/);
  const parsed = parseBots(JSON.stringify({ ...base, onRateLimit: "nope" }));
  assert.ok(parsed.warnings.some((w) => /onRateLimit "nope".*parks rate-limited seats/.test(w)));
  assert.equal(parseBots(JSON.stringify({ ...base, onRateLimit: "switch" })).file.onRateLimit, "switch");
});
