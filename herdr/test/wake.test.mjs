import assert from "node:assert/strict";
import { test } from "node:test";

import { entryOf, formFrom } from "../mods/am-sidebar/formModel.js";
import { applyBotEdit, checkBots, parseBots, wakeAutomationName, wakeCron, wakeProblem } from "../mods/am-sidebar/model.js";

const bot = {
  id: "b-aaaaaaaaaa", name: "Research", kind: "main", agent: "claude",
  look: { character: "star", colour: "blue" }, role: "", instructions: "",
};
const roster = (wake) => ({ version: 1, categories: [], bots: [{ ...bot, wake }] });

test("daily wake accepts only the two-digit civil time and uses a five-field cron", () => {
  for (const [spec, cron] of [
    ["daily@00:00", "0 0 * * *"], ["daily@09:30", "30 9 * * *"], ["daily@23:59", "59 23 * * *"],
  ]) {
    assert.equal(wakeProblem(spec), null);
    assert.equal(wakeCron(spec), cron);
  }
  for (const bad of ["daily@24:00", "daily@9:00", "daily@09:60", "daily@09:00\n", "", null, undefined, 930, {}]) {
    assert.match(wakeProblem(bad), /isn't daily@HH:MM$/);
    assert.equal(wakeCron(bad), null);
  }
});

test("wake names use FNV-1a with eight hex digits and scope the bot id to its project", () => {
  assert.equal(wakeAutomationName(bot.id, ""), "wake-b-aaaaaaaaaa-811c9dc5");
  assert.equal(wakeAutomationName(bot.id, "foobar"), "wake-b-aaaaaaaaaa-bf9cf968");
  const unicode = "/café/研究";
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(unicode)) hash = Math.imul(hash ^ byte, 0x1000193);
  assert.equal(wakeAutomationName(bot.id, unicode), `wake-${bot.id}-${(hash >>> 0).toString(16).padStart(8, "0")}`);
  assert.notEqual(wakeAutomationName(bot.id, "/repo"), wakeAutomationName(bot.id, "/clone"));
});

test("parse warns and drops malformed wakes only from its view; a save still validates", () => {
  for (const value of ["daily@24:00", null, "", { hour: 9 }]) {
    const raw = roster(value);
    const parsed = parseBots(JSON.stringify(raw));
    assert.equal(Object.hasOwn(parsed.file.bots[0], "wake"), false);
    assert.deepEqual(parsed.raw, raw);
    assert.ok(parsed.warnings.includes(`${bot.id}: wake ${JSON.stringify(value)} isn't daily@HH:MM; ignored`));
    assert.deepEqual(checkBots(raw), []);
  }
  assert.equal(parseBots(JSON.stringify(roster("daily@00:00"))).file.bots[0].wake, "daily@00:00");
});

test("an edit can set or clear wake, and a form entry that omits wake preserves the stored value", () => {
  const raw = roster("daily@09:30");
  const { file } = parseBots(JSON.stringify(raw));
  const state = formFrom({ mode: "edit", bot: file.bots[0], file });
  const { entry } = entryOf({ ...state, role: "new role" }, file);
  assert.equal(Object.hasOwn(entry, "wake"), false);
  assert.equal(applyBotEdit(raw, entry).bots[0].wake, "daily@09:30");
  assert.equal(applyBotEdit(raw, { ...entry, wake: "daily@20:00" }).bots[0].wake, "daily@20:00");
  for (const value of [undefined, null, ""]) {
    assert.equal(Object.hasOwn(applyBotEdit(raw, { ...entry, wake: value }).bots[0], "wake"), false);
  }
});
