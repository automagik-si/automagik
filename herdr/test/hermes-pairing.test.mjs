import { test } from "node:test";
import assert from "node:assert/strict";
import { hermesPairProblem, hermesPairArgs, hermesPairEnv, hermesPairConflict } from "../mods/am-sidebar/hermesPair.js";
import { restartPlan } from "../mods/am-sidebar/restart.js";
import { launchRun } from "../mods/am-sidebar/models.js";
import { formFrom, entryOf, commandOf, problemOf } from "../mods/am-sidebar/formModel.js";
import { applyBotEdit } from "../mods/am-sidebar/model.js";

const pair = { home: "/srv/agents/example", profile: "research" };
const bot = { id: "b-aaaaaaaaaa", agent: "hermes", hermes: pair };

test("the form edits, validates, copies and removes the same pairing as the CLI", () => {
  const stored = { ...bot, name: "Research", kind: "main", role: "", instructions: "" };
  const file = { version: 1, bots: [stored], categories: [] };
  const initial = formFrom({ mode: "edit", bot: stored, file });
  assert.equal(initial.hermesProfile, "research");
  assert.deepEqual(entryOf(initial, file).entry.hermes, pair);
  assert.match(problemOf({ ...initial, agent: "claude" }, { key: "/work", file }), /Unpair/);
  const changed = { ...initial, hermesProfile: "another" };
  assert.match(commandOf(changed, { key: "/work", file, initial }), /--hermes-profile=another/);
  const cleared = { ...initial, hermesHome: "", hermesProfile: "" };
  assert.match(commandOf(cleared, { key: "/work", file, initial }), /--no-hermes/);
  assert.equal(applyBotEdit(file, entryOf(cleared, file).entry).bots[0].hermes, undefined);
});

test("pairing requires explicit home and profile; malformed values never fall back", () => {
  assert.equal(hermesPairProblem(pair), null);
  assert.match(hermesPairProblem({ ...pair, home: "/srv//agents/example" }), /absolute/);
  for (const value of [null, {}, { ...pair, home: "~/.hermes" }, { ...pair, profile: "../default" }, { ...pair, session: "--latest" }, { ...pair, session: "Bot Chat" }, { ...pair, home: "/srv/x\nHOME=y" }, { ...pair, typo: true }]) {
    assert.equal(typeof hermesPairProblem(value), "string", JSON.stringify(value));
  }
  assert.deepEqual(hermesPairEnv(bot), { HERMES_HOME: pair.home, HERMES_PROFILE: pair.profile });
  assert.deepEqual(hermesPairEnv({ agent: "claude", hermes: pair }), {});
});

test("a paired seat resumes its exact profile/session, never latest or a new chat", () => {
  const expected = ["--profile", "research", "--tui", "--continue", "Bot Chat"];
  assert.deepEqual(hermesPairArgs(bot), expected);
  assert.deepEqual(launchRun("hermes", ["hermes"], bot), ["hermes", ...expected]);
  const plan = restartPlan({ bot, run: launchRun("hermes", ["hermes"], bot), runningAgent: "hermes", session: "another-session" });
  assert.equal(plan.mode, "resume");
  assert.deepEqual(plan.argv, ["hermes", ...expected]);
  assert.equal(plan.sessionId, null);
  assert.throws(() => restartPlan({ bot, run: ["hermes"], fresh: true }), /paired|unpair/i);
  assert.throws(() => restartPlan({ bot, run: ["hermes"], model: "different" }), /paired|unpair/i);
  assert.throws(() => launchRun("hermes", ["hermes", "--profile", "other"], bot), /override|pair/i);
  assert.deepEqual(launchRun("hermes", ["hermes"], { agent: "hermes" }), ["hermes"]);
});

test("one Hermes profile cannot pair to two seats even with different session IDs", () => {
  const other = { ...bot, id: "b-bbbbbbbbbb", name: "Other", hermes: { ...pair } };
  assert.match(hermesPairConflict({ bots: [bot, other] }, bot), /Other/);
  assert.equal(hermesPairConflict({ bots: [bot] }, bot), null);
  assert.equal(hermesPairConflict({ bots: [bot, { ...other, hermes: { ...pair, profile: "separate" } }] }, bot), null);
});

test("paired launch keeps overrides and merges options without deleting repeated values", () => {
  const cases = [
    [["hermes", "--tui"], ["hermes", "--tui", "--profile", "research", "--continue", "Bot Chat"]],
    [["wrapper", "--profile=research", "--tui", "--continue", "Bot Chat"], ["wrapper", "--profile=research", "--tui", "--continue", "Bot Chat"]],
    [["hermes", "--profile", "research", "--profile=research", "--tui", "--tui"], ["hermes", "--profile", "research", "--tui", "--continue", "Bot Chat"]],
    [["hermes", "--label", "research", "--tag", "research"], ["hermes", "--label", "research", "--tag", "research", "--profile", "research", "--tui", "--continue", "Bot Chat"]],
    [["hermes", "--", "--profile", "other"], ["hermes", "--profile", "research", "--tui", "--continue", "Bot Chat", "--", "--profile", "other"]],
  ];
  for (const [run, expected] of cases) {
    const original = [...run];
    const argv = launchRun("hermes", run, bot);
    assert.deepEqual(argv, expected);
    assert.deepEqual(run, original);
    assert.deepEqual(launchRun("hermes", argv, bot), argv, "idempotent");
    assert.deepEqual(restartPlan({ bot, run: argv }).argv, expected);
    assert.deepEqual(restartPlan({ bot, run, agent: "hermes", model: "" }).argv, expected);
  }
  for (const run of [["hermes", "--profile=other"], ["hermes", "--profile", "research", "--profile", "other"]]) {
    assert.throws(() => launchRun("hermes", run, bot), { message: "The command selects a different Hermes profile; match --profile to the bot's pairing." });
  }
});
