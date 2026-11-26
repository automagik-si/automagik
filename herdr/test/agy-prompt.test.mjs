import { test } from "node:test";
import assert from "node:assert/strict";
import { AGY_APPS, AGY_SHAPES, QUESTION_MAX, agyPromptOf } from "../mods/am-sidebar/agyPrompt.js";
import { isPromptLine, pendingDialog } from "../mods/am-sidebar/dialog.js";
import { TRUST, CHOICES, SYNTHETIC, trustScreen, fileQuestion, fileScreen, capture } from "./agy-prompt-fixture.mjs";

const match = (screen, shapes = SYNTHETIC) => agyPromptOf(screen, shapes);
const trust = { kind: "folder-trust", question: TRUST, block: trustScreen };

const TRUST_Q = "Do you trust the contents of this project? Antigravity CLI requires permission to read, edit, and execute files here.";
const ACCESS_Q = "Allow access to this file?";
const T = capture("folder-trust.txt"), F = capture("file-access.txt");
const kindOf = (text, shapes) => agyPromptOf(text, shapes)?.kind ?? null;
const rowsOf = (text) => text.split("\n");
// Replaces the first row whose trimmed text matches re with rows (none removes it).
const swap = (text, re, rows) => {
  const a = rowsOf(text), i = a.findIndex((row) => re.test(row.trim()));
  assert.ok(i >= 0, String(re));
  a.splice(i, 1, ...rows);
  return a.join("\n");
};
// Replaces the rule row right under the "File access" heading with rows.
const swapRule = (text, rows) => {
  const a = rowsOf(text), i = a.findIndex((row) => row.trim() === "File access");
  assert.ok(i >= 0 && /^─+$/.test(a[i + 1].trim()));
  a.splice(i + 1, 1, ...rows);
  return a.join("\n");
};
const below = (text, row) => [...rowsOf(text.replace(/\n+$/, "")), row].join("\n");
const unmark = (text) => rowsOf(text).map((row) => row.replace(/^(\s*)> (?=(?:\d\. )?(?:Yes|No))/, "$1  ")).join("\n");
const READ = /^Read: /, REASON = /^Reason: /, MODEL = /^Gemini 4 Neon · high$/;
const LONG = ["Read: /work/outside/x", ...Array.from({ length: 33 }, (_, i) => `seg${i}`)];

test("captured 1.5.16: AGY_SHAPES holds the two shapes, AGY_APPS stays empty, all frozen", () => {
  assert.deepEqual(AGY_SHAPES.map((shape) => shape.kind), ["folder-trust", "file-access"]);
  assert.deepEqual(AGY_APPS, []);
  for (const table of [AGY_SHAPES, AGY_APPS, ...AGY_SHAPES, ...AGY_SHAPES.map((shape) => shape.after),
    ...AGY_SHAPES.flatMap((shape) => [shape.choices, shape.free, shape.context].filter(Boolean))]) {
    assert.ok(Object.isFrozen(table));
  }
  // The synthetic screens are not agy's: the shipped table leaves them alone.
  assert.equal(agyPromptOf(trustScreen), null);
  assert.equal(agyPromptOf(fileScreen()), null);
});

test("captured 1.5.16: each shape matches its fixture, with no path in its question or block", () => {
  const folder = agyPromptOf(T);
  const access = agyPromptOf(F);
  assert.deepEqual(folder, {
    kind: "folder-trust", question: TRUST_Q,
    block: [TRUST_Q, "> Yes, I trust this folder", "No, exit", "↑/↓ Navigate · enter Confirm",
      "Gemini 4 Neon · high"].join("\n"),
  });
  assert.deepEqual(access, {
    kind: "file-access", question: ACCESS_Q,
    block: [ACCESS_Q, "> 1. Yes, allow access", "2. Yes, and always allow non-workspace access",
      "3. No, deny access", "↑/↓ Navigate", "esc to cancel Gemini 4 Neon · high"].join("\n"),
  });
  for (const { question, block } of [folder, access]) {
    assert.ok(question.length <= QUESTION_MAX);
    for (const text of [question, block]) assert.doesNotMatch(text, /\/work|Read:|Reason:|File access/);
  }
});

test("captured 1.5.16: the pack-flags screen and an answered trust are not prompts", () => {
  for (const name of ["no-prompt-pack-flags.txt", "trust-answered-idle.txt"]) {
    assert.equal(agyPromptOf(capture(name)), null, name);
  }
});

test("captured 1.5.16: near-misses do not match", () => {
  const help = ["Example of agy's file prompt:", ACCESS_Q, "  1. Yes, allow access",
    "  2. Yes, and always allow non-workspace access", "  3. No, deny access",
    "", "  ↑/↓ Navigate", "esc to cancel"].join("\n");
  for (const screen of [
    swap(T, MODEL, ["│ > │"]), swap(T, MODEL, ["work %"]),
    below(T, ">"), below(F, ">"),
    unmark(T), unmark(F),
    swap(T, /^No, exit$/, ["> No, exit"]),
    swap(F, /^3\. No, deny access$/, ["> 3. No, deny access"]),
    swap(F, REASON, ["Reason: run a shell command"]), swap(F, /^File access$/, []),
    help, swap(help, /^1\. Yes, allow access$/, ["> 1. Yes, allow access"]),
    T.replace("trust the contents", "trust the files"),
    swap(T, /^↑\/↓ Navigate · enter Confirm$/, [""]),
    swap(F, /^2\./, ["2. Yes, and always allow outside"]),
    below(F, "End of output."),
  ]) assert.equal(agyPromptOf(screen), null, screen);
});

test("captured 1.5.16: tolerated variants still match", () => {
  for (const screen of [
    swap(T, MODEL, ["Some Model 7 · low"]),
    swap(T, /^Do you trust the contents of this project\?$/,
      ["Do you trust the contents", "of this project?"]),
    swap(unmark(T), /^No, exit$/, ["> No, exit"]),
  ]) assert.equal(kindOf(screen), "folder-trust", screen);
  for (const screen of [
    swap(unmark(F), /^2\. Yes, and always allow non-workspace access$/,
      ["> 2. Yes, and always allow non-workspace access"]),
    swap(unmark(F), /^3\. No, deny access$/, ["> 3. No, deny access"]),
    swap(F, /^esc to cancel/, ["esc to cancel"]),
  ]) assert.equal(kindOf(screen), "file-access", screen);
});

test("captured 1.5.16: an unknown shape is null", () => {
  assert.equal(agyPromptOf(T.replace("Do you trust the contents of this project?", "Do you trust this folder?")), null);
});

test("captured 1.5.16: the Read field is opaque, whatever the file name or its rows", () => {
  for (const rows of [
    ["Read: /work/outside/100%"],
    ["Read: /work/outside/a$"],
    ["Read: /work/outside/a>"],
    ["Read: /work/outside/> x"],
    ["Read: /work/outside/aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff/note.txt"],
    ["Read: /work/outside/a", "b100%", "c$", "d>", ">", "e.txt"],
    ["Read: /work/outside/my", "notes file.txt"],
  ]) assert.deepEqual(agyPromptOf(swap(F, READ, rows)), agyPromptOf(F));
  assert.equal(kindOf(swap(F, READ, LONG)), null);
});

test("captured 1.5.16: the file-access block above the question is fixed and contiguous", () => {
  for (const screen of [
    swap(F, /^File access$/, []),
    swap(F, /^File access$/, ["File access request"]),
    swapRule(F, []),
    swap(F, READ, []),
    swapRule(swap(F, READ, []), []),
    swapRule(swap(F, READ, ["Unrelated operation"]), ["End of example."]),
    swap(F, REASON, ["Reason: run a shell command"]),
    swap(F, REASON, ["Reason: outside workspace", "Reason: outside workspace"]),
    swap(F, READ, ["Read: /work/outside/note.txt", "File access"]),
    swap(F, READ, ["Read: /work/outside/note.txt", "────────"]),
    swap(F, REASON, ["Reason: outside workspace", "Unrelated operation"]),
    swap(F, READ, ["Read:"]),
    swap(F, READ, ["Write: /work/outside/note.txt"]),
    swap(F, REASON, ["Reason: run a shell command", "Reason: outside workspace"]),
    swap(F, READ, ["Read: /work/outside/note.txt", "Read:"]),
  ]) assert.equal(kindOf(screen), null, screen);
  assert.equal(kindOf(swap(F, READ, ["Read: /work/outside/note.txt", "Unrelated operation"])), "file-access");
  assert.equal(kindOf(swap(F, READ, ["Read: /work/out", "side/note.txt"])), "file-access");
});

test("captured 1.5.16: sparse, empty, duplicate or invalid choices, free and context lists make a shape invalid", () => {
  const [TS, FS] = AGY_SHAPES;
  assert.ok(TS && FS, "both captured shapes are required to test list validation");
  assert.equal(kindOf(T, [{ ...TS, free: Array(1) }]), null);
  assert.equal(kindOf(swap(T, MODEL, ["│ > │"]), [{ ...TS, free: Array(1) }]), null);
  assert.equal(kindOf(T, [{ ...TS, choices: [0, , 1] }]), null);
  assert.equal(kindOf(T, [{ ...TS, choices: [0, 0] }]), null);
  assert.equal(kindOf(T, [{ ...TS, choices: [9] }]), null);
  assert.equal(kindOf(T, [{ ...TS, free: [] }]), null);
  assert.equal(kindOf(F, [{ ...FS, context: [FS.context[0], , FS.context[2], FS.context[3]] }]), null);
  assert.equal(kindOf(F, [{ ...FS, context: FS.context.slice(1) }]), null);
  assert.equal(kindOf(F, [{ ...FS, context: ["File access", ...FS.context.slice(1)] }]), null);
  assert.equal(kindOf(F, [{ ...FS, context: [/^File access$/g, ...FS.context.slice(1)] }]), null);
  assert.deepEqual([kindOf(T, [TS]), kindOf(F, [FS])], ["folder-trust", "file-access"]);
});

test("captured 1.5.16: pendingDialog refuses the file-access misses and the trimmed unmarked trust screen", () => {
  assert.deepEqual(pendingDialog(F), { question: ACCESS_Q, who: "the owner" });
  for (const screen of [
    unmark(F),
    swap(F, /^3\. No, deny access$/, ["> 3. No, deny access"]),
    swap(F, REASON, ["Reason: run a shell command"]),
    swap(F, /^2\./, ["2. Yes, and always allow outside"]),
    swap(F, /^2\./, ["2. Yes, and always allow non-", "workspace access"]),
    swap(F, /^File access$/, []),
    swapRule(swap(F, READ, []), []),
    swap(F, READ, LONG),
  ]) assert.equal(pendingDialog(screen)?.question, ACCESS_Q, screen);
  for (const screen of [
    below(F, "> "), T, unmark(T), swap(T, /^No, exit$/, ["> No, exit"]),
    swap(T, /^↑\/↓ Navigate · enter Confirm$/, [""]), swap(T, MODEL, []),
  ]) assert.equal(pendingDialog(screen), null, screen);
  assert.deepEqual(pendingDialog(unmark(T).trimEnd()),
    { question: "Do you trust the contents of this project?", who: "the owner" });
});

test("each synthetic shape matches with its kind, question and block", () => {
  const colored = ["\u001b[32m" + TRUST + "\u001b[0m", "", ...CHOICES, " ", "", ""].join("\r\n");
  assert.deepEqual(match(colored), trust);
  assert.deepEqual(match(fileScreen()), { kind: "file-access", question: fileQuestion(), block: fileScreen() });
});

test("a question wrapped at a narrow width is joined, five lines included", () => {
  const wraps = ["SYNTHETIC allow", "file   access", "outside the", "workspace to", "synthetic/path?"];
  assert.deepEqual(match([...wraps, ...fileScreen().split("\n").slice(1)].join("\n")), match(fileScreen()));
});

test("a selected choice drawn with a prompt glyph still matches", () => {
  assert.ok(isPromptLine("❯ Allow once"));
  assert.equal(match(fileScreen()).kind, "file-access");
  assert.equal(match([TRUST, "❯ " + CHOICES[0], "2. SYNTHETIC no"].join("\n")).kind, "folder-trust");
});

test("the same block with an idle prompt below does not match", () => {
  for (const prompt of ["> ", "│ > │", "❯"]) assert.equal(match(trustScreen + "\n" + prompt), null);
});

test("an idle input line above the question stops the question", () => {
  assert.deepEqual(match("> \n" + trustScreen), trust);
  const shape = { ...SYNTHETIC[0], question: /^❯ SYNTHETIC trust this folder\?$/ };
  assert.equal(match("❯\n" + trustScreen, [shape]), null);
});

test("the block quoted mid-output does not match", () => {
  assert.equal(match("SYNTHETIC quote:\n" + trustScreen + "\nSYNTHETIC end quote."), null);
});

test("a block cut halfway does not match", () => {
  assert.equal(match([TRUST, ...Array(38).fill(""), ...CHOICES].join("\n")), null);
  assert.equal(match([TRUST, CHOICES[0]].join("\n")), null);
});

test("two questions differing after character 200 have different blocks and the same question", () => {
  const prefix = "x".repeat(QUESTION_MAX);
  const a = match(fileScreen(prefix + "a")), b = match(fileScreen(prefix + "b"));
  assert.equal(a.question.length, QUESTION_MAX);
  assert.equal(a.question, b.question);
  assert.notEqual(a.block, b.block);
  assert.equal(a.block, fileScreen(prefix + "a"));
});

test("an unknown shape is null", () => {
  assert.equal(match(trustScreen.replace("folder", "project")), null);
});

test("malformed shapes are skipped", () => {
  const shape = SYNTHETIC[0];
  const bad = [null, "folder-trust", { ...shape, kind: "other" }, { ...shape, question: "^.*$" },
    { ...shape, after: [] }, { ...shape, after: /./ }, { ...shape, after: ["yes", /no/] },
    { ...shape, after: Array(2) }, { ...shape, question: /folder/g },
    { ...shape, after: [/yes/y, /no/] }];
  assert.equal(match(trustScreen, bad), null);
  assert.deepEqual(match(trustScreen, [...bad, shape]), trust);
});

test("non-string screens and a non-array shapes list are null", () => {
  for (const screen of [null, {}, [], 1]) assert.equal(match(screen), null);
  for (const shapes of [null, {}, "shape"]) assert.equal(match(trustScreen, shapes), null);
});

test("a 40-row screen ending in a newline keeps its first row", () => {
  const screen = [TRUST, ...Array(37).fill(""), ...CHOICES].join("\n");
  assert.deepEqual(match(screen + "\n"), trust);
  assert.deepEqual(match(screen), trust);
});

test("pendingDialog keeps its answers for Claude, Codex and the folder-trust question", () => {
  for (const question of ["Do you want to make this edit?", "Would you like to run the following command?",
    "Do you trust the contents of this project?"]) {
    assert.deepEqual(pendingDialog(question + "\n❯ 1. Yes\n  2. No"), { question, who: "the owner" });
  }
});
