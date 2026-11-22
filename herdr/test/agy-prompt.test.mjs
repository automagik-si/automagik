import { test } from "node:test";
import assert from "node:assert/strict";
import { AGY_APPS, AGY_SHAPES, QUESTION_MAX, agyPromptOf } from "../mods/am-sidebar/agyPrompt.js";
import { isPromptLine, pendingDialog } from "../mods/am-sidebar/dialog.js";
import { TRUST, CHOICES, SYNTHETIC, trustScreen, fileQuestion, fileScreen } from "./agy-prompt-fixture.mjs";

const match = (screen, shapes = SYNTHETIC) => agyPromptOf(screen, shapes);
const trust = { kind: "folder-trust", question: TRUST, block: trustScreen };

test("AGY_SHAPES and AGY_APPS ship empty and frozen, so nothing matches in production", () => {
  for (const table of [AGY_SHAPES, AGY_APPS]) {
    assert.deepEqual(table, []);
    assert.ok(Object.isFrozen(table));
  }
  assert.equal(agyPromptOf(trustScreen), null);
  assert.equal(agyPromptOf(fileScreen()), null);
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
