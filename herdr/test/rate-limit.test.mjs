// #1557: Claude Code's rate-limit dialog, read from a pane tail and never answered. The pure
// rules the CLI and the sidebar share (restart.js, model.js), over text alone: no pane, no hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { durationMs, pendingDialog, rateLimitDialog, rateLimitLine, resetTimeFrom, wakeWait } from "../mods/am-sidebar/restart.js";
import { checkBots, onRateLimitProblem, parseBots, rateLimitModeOf } from "../mods/am-sidebar/model.js";

const screenFixture = (name) => readFileSync(new URL(`../mods/pocket-link/chat/fixtures/screens/${name}`, import.meta.url), "utf8");

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
  const framed = `\u001b[2m╭─\u001b[0m\n\u001b[1mRate limit reached\u001b[0m\nYour limit resets at 3:00 PM.\n`
    + `\u001b[2m❯ 1. Wait until it resets\u001b[0m\n  2. Upgrade your plan\n`;
  assert.deepEqual(rateLimitDialog(framed, NOW), { question: "Rate limit reached", resets_at: localIso(15) });
  // A dialog with no time still counts; the reset is omitted, never guessed.
  const noTime = rateLimitDialog("Rate limit reached\nYou have reached your usage limit.\nTry again later.\n❯ 1. Wait until it resets\n  2. Upgrade your plan\n", NOW);
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

// The repo's own permission dialog text: the question and yes/no choices the restart rules
// already pin as a dialog the owner answers.
const PERMISSION = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
const LIMIT_SENTENCE = "I checked the rate limit path; the limit resets at 3:00 PM.";

test("a permission dialog after a limit sentence is never the rate-limit dialog", () => {
  // The HIGH: the cue was any limit line within ten lines above the options, so a permission
  // question after the sentence became a rate-limit match with a 3:00 PM reset. The seat can
  // be labelled rate-limited, parked, switched or force-restarted at that time while
  // pendingDialog() already knows it is the owner's question. The two rules must not disagree.
  const screen = `${LIMIT_SENTENCE}\n${PERMISSION}`;
  assert.equal(pendingDialog(screen)?.question, "Do you want to proceed?");
  assert.equal(rateLimitDialog(screen, NOW), null);
  // The same defect on the repo's full permission screen fixture: the limit sentence directly
  // above its question must not become the dialog's own line.
  const withCue = screenFixture("claude-dialog.txt").replace(" This command requires approval",
    ` ${LIMIT_SENTENCE}\n This command requires approval`);
  assert.equal(pendingDialog(withCue)?.question, "Do you want to proceed?");
  assert.equal(rateLimitDialog(withCue, NOW), null);
});

test("a real rate-limit dialog with an allowed footer is still the dialog", () => {
  // The review's second blocking case: `Esc to cancel` and `Press enter to confirm` are allowed
  // footers of the rate-limit dialog, but pendingDialog() claimed them first, so a genuinely
  // blocked seat was missed. The options/limit shape decides, never the footer's absence.
  for (const footer of ["Esc to cancel", "Press enter to confirm"]) {
    const screen = `${DIALOG}\n  ${footer}\n`;
    // The guard still sees a held pane (the dialog is a person's to answer either way), but the
    // claim is marked as the shared footer, so the rate-limit shape has the final word below.
    assert.equal(pendingDialog(screen)?.footer, true, footer);
    const found = rateLimitDialog(screen, NOW);
    assert.ok(found, footer);
    assert.equal(found.resets_at, new Date(NOW + (2 * 60 + 10) * 60_000).toISOString(), footer);
    assert.equal(screen.includes("Rate limit reached"), true);
  }
  // The permission dialog with the same footer is still the owner's, never rate-limited.
  const permission = `${PERMISSION}\nEsc to cancel\n`;
  assert.equal(pendingDialog(permission)?.question, "Do you want to proceed?");
  assert.equal(rateLimitDialog(permission, NOW), null);
});

test("a permission question that itself names the reset is rejected by the permission guard", () => {
  // This is the shape the rate-limit block alone would accept: the question is the line
  // directly above the choices and it carries both the cue and the reset words. Only the
  // explicit pendingDialog() rejection keeps it from being parked at 2 hours from now.
  const question = "Your usage limit resets in 2 hours. Do you want to proceed?";
  const screen = `${question}\n❯ 1. Yes\n  2. No\n`;
  assert.equal(pendingDialog(screen)?.question, question);
  assert.equal(rateLimitDialog(screen, NOW), null);
});

test("a quoted dialog, an unclosed fence and a patch hunk are not the live dialog", () => {
  // A verbatim quote is text the person is reading, never a modal waiting for an answer.
  const quote = ["Here is the dialog I saw:", "> Rate limit reached", "> Your limit resets at 3:00 PM.",
    "> ❯ 1. Wait until it resets", ">   2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(quote, NOW), null);
  // An unclosed fenced code block is still a code block.
  const fenced = ["Here is the dialog I saw:", "```", "Rate limit reached", "Your limit resets at 3:00 PM.",
    "❯ 1. Wait until it resets", "  2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(fenced, NOW), null);
  // A patch hunk carries the dialog lines as indented context: the leading space is not a dialog.
  const patch = ["@@ -1,3 +1,5 @@", " Rate limit reached", " Your limit resets at 3:00 PM.",
    " ❯ 1. Wait until it resets", "   2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(patch, NOW), null);
});

test("the quote guard, not the option shape, rejects a quoted cue with unquoted choices", () => {
  // Every line quoted is already rejected by the option shape (a `>` is not the dialog's
  // cursor), so that row cannot prove the quote guard. This partial quote can only be caught
  // by the guard: the cue is quoted, the choices are not, and everything else fits the shape.
  const partial = ["> Rate limit reached", "> Your limit resets at 3:00 PM.",
    "❯ 1. Wait until it resets", "  2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(partial, NOW), null);
});

test("a patch is rejected however far its hunk header sits above the dialog", () => {
  // The review's blocking case: the patch check used to start five non-empty lines above the
  // cue, so a hunk with six or more context lines above it matched. The rule must not use the
  // header's distance: any unified-diff marker in the visible tail makes the screen text.
  for (const contextLines of [5, 10, 14, 20, 30]) {
    const context = Array.from({ length: contextLines }, (_, i) => ` context line ${i}`);
    const patch = ["diff --git a/screen.txt b/screen.txt", "index 1111111..2222222 100644",
      "--- a/screen.txt", "+++ b/screen.txt", "@@ -1,18 +1,18 @@", ...context,
      " Rate limit reached", " Your limit resets in 2 hours 10 minutes.",
      " ❯ 1. Wait until it resets", "   2. Upgrade your plan"].join("\n");
    assert.equal(rateLimitDialog(patch, NOW), null, `${contextLines} context lines`);
  }
  // The same hunk without its header is outside the visible tail's evidence: it is the raw
  // paste limitation stated in the README, not a form the rule can tell from the modal.
  const noHeader = [" Rate limit reached", " Your limit resets in 2 hours 10 minutes.",
    " ❯ 1. Wait until it resets", "   2. Upgrade your plan"].join("\n");
  assert.ok(rateLimitDialog(noHeader, NOW), "a headerless raw paste is the documented limitation");
});

test("a limit sentence that is not the dialog's own line is not a cue", () => {
  // Adjacent prose between the sentence and the choices: the cue belongs to a report.
  const report = [LIMIT_SENTENCE, "Findings:", "❯ 1. Wait until it resets", "  2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(report, NOW), null);
  // Far above the choices is never the dialog's own header.
  const far = [LIMIT_SENTENCE, ...Array.from({ length: 8 }, (_, i) => `note ${i}`),
    "❯ 1. Wait until it resets", "  2. Upgrade your plan"].join("\n");
  assert.equal(rateLimitDialog(far, NOW), null);
});

test("a permission dialog is never the rate-limit dialog; only the shared footer may claim both", () => {
  const screens = [
    DIALOG,
    `${DIALOG}\nEsc to cancel\n`,
    `${DIALOG}\nPress enter to confirm\n`,
    `${LIMIT_SENTENCE}\n${PERMISSION}`,
    `${PERMISSION}\nEsc to cancel\n`,
    "Do you want to proceed?\n❯ 1. Yes\n  2. No\n",
    "Completed steps:\n1. Read files\n2. Run tests\n❯ ",
    ...["claude-dialog", "claude-draft", "claude-idle", "codex-draft", "codex-idle", "omp-draft", "omp-idle"]
      .map((name) => screenFixture(`${name}.txt`)),
  ];
  for (const screen of screens) {
    const pending = pendingDialog(screen);
    // A real question or choice is the owner's, never rate-limited. The one shared claim is the
    // footer both Claude Code dialogs show, marked `footer`, and the rate-limit shape answers it.
    if (pending && !pending.footer) assert.equal(rateLimitDialog(screen, NOW), null, screen.slice(0, 80));
  }
  for (const footer of ["Esc to cancel", "Press enter to confirm"]) {
    const screen = `${DIALOG}\n${footer}\n`;
    assert.equal(pendingDialog(screen)?.footer, true, footer);
    assert.ok(rateLimitDialog(screen, NOW), footer);
  }
});

test("reset times: ISO, a duration, a local clock, tomorrow, and no guess when the dialog names none", () => {
  assert.equal(resetTimeFrom("resets at 2026-11-20T04:05:06Z", NOW), "2026-11-20T04:05:06.000Z");
  assert.equal(resetTimeFrom("try again in 45s", NOW), new Date(NOW + 45_000).toISOString());
  assert.equal(resetTimeFrom("You can continue in 1 hour 30 minutes.", NOW), new Date(NOW + 90 * 60_000).toISOString());
  assert.equal(resetTimeFrom("Your limit resets at 3:00 PM.", NOW), localIso(15));
  assert.equal(resetTimeFrom("Your limit resets at 9:15 AM.", NOW), localIso(9, 15, 20), "a time already past is tomorrow");
  assert.equal(resetTimeFrom("resets tomorrow at 9:00 AM", NOW), localIso(9, 0, 20));
  assert.equal(resetTimeFrom("resets at 15:30", NOW), localIso(15, 30));
  // `tomorrow` means tomorrow even when the clock time is still ahead today (the old rule
  // ignored the word and saw 9:00 later that same morning as today).
  const MORNING = new Date(2026, 10, 19, 8, 0, 0).getTime();
  assert.equal(resetTimeFrom("resets tomorrow at 9:00 AM", MORNING), localIso(9, 0, 20));
  assert.equal(resetTimeFrom("resets today at 9:00 AM", MORNING), localIso(9, 0, 19));
  // A timestamp already past is not a reset now: it proves nothing, so it is unknown.
  assert.equal(resetTimeFrom("resets at 2020-01-01T00:00:00Z", NOW), null);
  // Nothing to read: a bare number, a date without a time, an unknown unit.
  for (const text of ["resets at 5", "resets on 2026-11-20", "resets in 2 fortnights", "resets", ""]) {
    assert.equal(resetTimeFrom(text, NOW), null, text);
  }
});

test("a report that mentions the limit and lists findings is not the options dialog", () => {
  // The review's false positive: an idle seat's last turn is a report with the words "rate
  // limit" and a markdown numbered list. It has no selection cursor and no dialog block.
  const report = [
    "I checked the rate limit path in the restart queue.",
    "",
    "Findings:",
    "1. The retry loop waits, but no reset is recorded.",
    "2. `am ls` reports a rate-limit status.",
    "3. No test covers the parser.",
    "",
  ].join("\n");
  assert.equal(rateLimitDialog(report, NOW), null);
  // The exact text the review used, including its trailing idle prompt.
  const review = ["Here is what I found about the rate limit handling:", "", "1. The detector reads the last 15 lines.",
    "2. It never sends keys.", "", "❯"].join("\n");
  assert.equal(rateLimitDialog(review, NOW), null);
  // A quoted markdown list uses ">" for the quote, never the dialog's own cursor.
  assert.equal(rateLimitDialog("Rate limit report:\n> 1. Wait until it resets\n> 2. Upgrade your plan\n", NOW), null);
  // Numbered options without the selection cursor are still not the dialog.
  assert.equal(rateLimitDialog("Rate limit reached\nYour limit resets in 2 hours.\n1. Wait until it resets\n2. Upgrade your plan\n", NOW), null);
  // Prose after the options means they are scrollback, not the live dialog.
  assert.equal(rateLimitDialog(`${DIALOG}\nI'll fix the parser next.\n`, NOW), null);
});

test("a raw, unmarked paste at the tail is the accepted limitation, as the README says", () => {
  // The rule reads text only: a transcript pasted raw with no `>` quote, fence or patch marker
  // and ending the pane tail is byte-identical to the live modal, so it is (and is documented
  // as) indistinguishable. An intro line above the dialog does not mark the text either.
  const pasted = `${DIALOG}\n`;
  assert.ok(rateLimitDialog(pasted, NOW));
  const withIntro = ["Here is what the dialog showed:", pasted].join("\n");
  assert.ok(rateLimitDialog(withIntro, NOW));
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
