// #1491: Claude's offered models (the pick list: the current menu) and its accepted models (what a
// pin may be, so a bot pinned to an older id still starts) are two lists. Near-miss words are in
// neither, unless one is the person's own configured default, which stays accepted as before.
import { test } from "node:test";
import assert from "node:assert/strict";

import { knownModelsFrom, modelArgs, offeredModelsFrom } from "../mods/am-sidebar/models.js";

const CATALOG = ["opus", "sonnet", "haiku", "claude-fable-5-2", "claude-fable-5-2[1m]", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const NEAR = ["claude-fable-5", "claude-fable-5-2[1", "claude-fable-5-2-x", "claude-fable-5-2[1m]x", "claude-fable-5-2[2m]",
  "Claude-Fable-5-2", "CLAUDE-FABLE-5-2[1M]", " claude-fable-5-2"];
const settings = (model) => (model === null ? {} : { claudeSettings: JSON.stringify({ model }) });

test("#1491 Claude offers exactly the current menu, whatever its configured default", () => {
  for (const def of [null, "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5-2-x"]) {
    assert.deepEqual(offeredModelsFrom("claude", settings(def)), CATALOG, `default ${def}`);
  }
  assert.equal(offeredModelsFrom("claude").includes("claude-fable-5-1"), false, "an older id is never offered");
});

test("#1491 Claude accepts the menu, the older Fable id and the configured default", () => {
  for (const def of [null, "claude-opus-5-5"]) {
    const accepted = knownModelsFrom("claude", settings(def));
    for (const id of [...CATALOG, "claude-fable-5-1"]) assert.ok(accepted.includes(id), `${id} accepted with default ${def}`);
  }
  // The recorded exception: a configured default outside the catalog stays accepted (a bot pinned
  // to it keeps starting), and is still not offered.
  assert.ok(knownModelsFrom("claude", settings("claude-fable-5-2-x")).includes("claude-fable-5-2-x"));
  assert.equal(offeredModelsFrom("claude", settings("claude-fable-5-2-x")).includes("claude-fable-5-2-x"), false);
});

test("#1491 every other agent offers what it accepts", () => {
  const codex = { codexConfig: 'model = "gpt-6.1-terra"\n', codexModels: JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }] }) };
  const agy = { antigravityModels: JSON.stringify({ version: 1, models: [{ id: "gemini-4-argon-high", label: "Argon" }] }) };
  assert.deepEqual(offeredModelsFrom("codex", codex), knownModelsFrom("codex", codex));
  assert.deepEqual(offeredModelsFrom("codex", codex), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"]);
  assert.deepEqual(offeredModelsFrom("antigravity", agy), knownModelsFrom("antigravity", agy));
  assert.deepEqual(offeredModelsFrom("antigravity", agy), ["gemini-4-argon-high"]);
  for (const agent of ["amp", "omp", "pi"]) assert.deepEqual(offeredModelsFrom(agent, {}), knownModelsFrom(agent, {}));
});

test("#1491 near-miss words are neither offered nor accepted (a prefix, an extended id, another case)", () => {
  for (const def of [null, "claude-opus-5-5"]) {
    const offered = offeredModelsFrom("claude", settings(def)), accepted = knownModelsFrom("claude", settings(def));
    for (const word of NEAR) {
      assert.equal(offered.includes(word), false, `${JSON.stringify(word)} offered with default ${def}`);
      assert.equal(accepted.includes(word), false, `${JSON.stringify(word)} accepted with default ${def}`);
    }
  }
});

test("#1491 the plain Fable id goes to --model as its own word", () => {
  assert.deepEqual(modelArgs("claude", "claude-fable-5-2"), ["--model", "claude-fable-5-2"]);
  assert.deepEqual(modelArgs("claude", "claude-fable-5-1"), ["--model", "claude-fable-5-1"]);
});
