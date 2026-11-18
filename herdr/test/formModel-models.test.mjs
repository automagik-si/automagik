// #1491: the form's model list is the offered one, its check the accepted one: a bot pinned to an
// older Claude id opens, keeps its pin (marked "not in the list") and saves; a near-miss word is
// refused. The copied command line quotes a 1M-context id, whose brackets are glob characters.
import { test } from "node:test";
import assert from "node:assert/strict";

import { commandOf, formFrom, modelInfo, modelOptions, opt, problemOf, shellQuote } from "../mods/am-sidebar/formModel.js";

const look = { character: "star", colour: "blue" };
const FILE = { version: 1, categories: [], bots: [
  { id: "b-mainaaaaaa", name: "lead", kind: "main", look, role: "", instructions: "", agent: "claude", model: "claude-fable-5-1" },
] };
const KEY = "/tmp/proj";
const NEAR = ["claude-fable-5", "claude-fable-5-2[1", "claude-fable-5-2-x", "claude-fable-5-2[1m]x", "claude-fable-5-2[2m]",
  "Claude-Fable-5-2", "CLAUDE-FABLE-5-2[1M]", " claude-fable-5-2"];
const editOf = (pin) => ({ ...formFrom({ mode: "edit", bot: FILE.bots[0] }), pin });

test("#1491 modelInfo: the pick list is the offered menu, the accepted list keeps the older Fable id", () => {
  const info = modelInfo("claude", {});
  assert.equal(info.models.includes("claude-fable-5-1"), false);
  assert.ok(info.models.includes("claude-fable-5-2") && info.models.includes("claude-fable-5-2[1m]"));
  assert.ok(info.accepted.includes("claude-fable-5-1"));
  for (const id of info.models) assert.ok(info.accepted.includes(id), `${id} offered and accepted`);
});

test("#1491 problemOf: a bot pinned to the older Fable id saves; a near-miss pin is refused", () => {
  const ctx = { key: KEY, file: FILE, info: modelInfo("claude", {}) };
  assert.equal(problemOf(editOf("claude-fable-5-1"), ctx), null);
  assert.equal(problemOf(editOf("claude-fable-5-2[1m]"), ctx), null);
  for (const word of NEAR) {
    assert.equal(problemOf(editOf(word), ctx), `${word} isn't a model claude lists; pick one from the list or use the default.`, JSON.stringify(word));
  }
});

test("#1491 modelOptions: an older pin stays the selected extra entry, never a list entry", () => {
  const info = modelInfo("claude", {});
  const kept = modelOptions(info, "claude-fable-5-1");
  assert.deepEqual(kept.at(-1), { id: "claude-fable-5-1", label: "claude-fable-5-1", hint: "not in the list" });
  assert.equal(kept.filter((o) => o.id === "claude-fable-5-1").length, 1);
  assert.equal(modelOptions(info).some((o) => o.id === "claude-fable-5-1"), false);
});

test("#1491 the copied command line quotes a 1M-context id", () => {
  assert.equal(shellQuote("claude-fable-5-2[1m]"), "'claude-fable-5-2[1m]'");
  assert.equal(opt("model", "claude-fable-5-2[1m]"), "--model='claude-fable-5-2[1m]'");
  assert.equal(shellQuote("claude-fable-5-2"), "claude-fable-5-2");
  const line = commandOf(editOf("claude-fable-5-2[1m]"), { key: KEY, file: FILE, initial: editOf("claude-fable-5-1") });
  assert.ok(line.includes("--model='claude-fable-5-2[1m]'"), line);
});
