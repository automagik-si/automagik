// Golden hashes from origin/dev, with #805 restart advice in the briefing; re-recorded for #955,
// whose briefing ends a worker with `am worker kill` (the text and its five carriers), and again
// when the briefing took the command's name, am (the fixture's base is the dev commit under it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { launchBriefingText } from "../mods/am-sidebar/briefingText.mjs";
import { briefingLaunch, withBriefing, withoutBriefing, promptArgs } from "../mods/am-sidebar/models.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/bot-prompt-name.json", import.meta.url), "utf8"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const self = { id: "b-guideaaaaa", name: "Team Guide", kind: "main", role: "Guide", instructions: "Help the team.", agent: "dsh-tui" };
const file = { version: 1, bots: [self], categories: [] };
const text = launchBriefingText({ self, file });

test("the briefing and every other agent's launch row match the restart-advice goldens", () => {
  assert.equal(hash(text), golden.text);
  for (const [agent, want] of Object.entries(golden.rows)) {
    assert.equal(hash(briefingLaunch(agent, { path: "/app/automagik-herdr/briefings/bot.md", text })), want, agent);
  }
});

test("DSH's first prompt starts with the display name then the whole original briefing", () => {
  for (const kind of ["main", "member"]) for (const name of ["Team Guide", "Guia, equipe - α"]) {
    const brief = launchBriefingText({ self: { ...self, name, kind }, file });
    const launch = briefingLaunch("dsh-tui", { text: brief });
    assert.deepEqual(launch, { args: ["--", `${name} - ${brief}`], env: {} });
    const argv = ["dsh-tui", "--resume", "session", ...launch.args];
    assert.deepEqual(withBriefing("dsh-tui", argv, launch), argv, "a restart replaces the old named prompt once");
    assert.deepEqual(withoutBriefing("dsh-tui", argv.slice(1)), ["--resume", "session"]);
  }
  assert.deepEqual(promptArgs("dsh-tui", "fix the task"), ["--", "fix the task"], "worker task unchanged");
  assert.deepEqual(withoutBriefing("dsh-tui", ["--", "Team Guide - my request"]), ["--", "Team Guide - my request"]);
});
