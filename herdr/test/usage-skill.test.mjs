import { test } from "node:test";
import assert from "node:assert/strict";
import { USAGE } from "../mods/am-sidebar/bin/automagik-herdr.mjs";

test("the help ends with the agent skill, its install command and where to report a problem", () => {
  const footer = [
    "For a code agent: the am skill teaches these commands,",
    "https://github.com/automagik-si/automagik/blob/dev/skills/am/SKILL.md",
    "Install it: npx skills add automagik-si/automagik --skill am",
    "Report what am cannot do: https://github.com/automagik-si/automagik/issues",
  ];
  for (const line of footer) assert.ok(USAGE.includes(line), line);
  assert.ok(USAGE.trimEnd().endsWith(`\n\n${footer.join("\n")}`));
});
