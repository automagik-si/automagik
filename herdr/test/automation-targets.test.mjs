// A target (#498) is one string, "<kind>:<bot id>", and never a terminal address: the id is
// stable across restarts and renames, an address is not. These cases are the panel's rules
// without a form in the way.
import test from "node:test";
import assert from "node:assert/strict";

import { BOT_ID, RUNS_AS, parseTarget, targetLine, targetWarning } from "../mods/am-automations/targets.js";

const housekeeper = { id: "b-6jrz4bmxml", name: "Housekeeper" };

test("a target is bot:<id> or worker:<id>, and a terminal address is never one", () => {
  assert.deepEqual(parseTarget("bot:b-6jrz4bmxml"), { kind: "bot", bot: "b-6jrz4bmxml" });
  assert.deepEqual(parseTarget("worker:b-6jrz4bmxml"), { kind: "worker", bot: "b-6jrz4bmxml" });
  for (const bad of [null, undefined, "", "b-6jrz4bmxml", "bot:", "pane:b-6jrz4bmxml", "bot:t3q1", "bot:build-box/t7",
    "bot:b-6JRZ4BMXML", "bot:b-6jrz4bmxm", "bot:b-6jrz4bmxmll", "bot Housekeeper"]) {
    assert.equal(parseTarget(bad), null, `${JSON.stringify(bad)} is not a target`);
  }
  assert.match("b-6jrz4bmxml", BOT_ID);
});

test("a target reads as the bot a person knows, by name when there is one", () => {
  const nameOf = (id) => (id === housekeeper.id ? housekeeper.name : null);
  assert.equal(targetLine("bot:b-6jrz4bmxml", nameOf), "bot Housekeeper");
  assert.equal(targetLine("worker:b-6jrz4bmxml", nameOf), "a worker of Housekeeper");
  assert.equal(targetLine("bot:b-aaaaaaaaaa", nameOf), "bot b-aaaaaaaaaa", "an unknown id is shown as it is");
  assert.equal(targetLine("", nameOf), "");
});

test("a target that cannot run says why: the bot left the roster, or is only planned", () => {
  assert.equal(targetWarning("bot:b-6jrz4bmxml", [housekeeper]), null);
  assert.match(targetWarning("bot:b-6jrz4bmxml", []), /no longer in this project's bots.json/);
  assert.match(targetWarning("worker:b-6jrz4bmxml", [{ ...housekeeper, planned: { wave: 3 } }]), /only planned/);
  assert.equal(targetWarning("bot:b-6jrz4bmxml", null), null, "a roster not loaded yet claims nothing");
  assert.match(targetWarning("t3q1", []), /isn't a target this panel knows/);
});

test("the runs-as choices are a new session, a bot, or a worker of a bot", () => {
  assert.deepEqual(RUNS_AS.map(([value]) => value), ["none", "bot", "worker"]);
  assert.equal(new Set(RUNS_AS.map(([value]) => value)).size, RUNS_AS.length);
});
