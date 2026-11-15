import { test } from "node:test";
import assert from "node:assert/strict";
import { actionError } from "../mods/am-sidebar/actionError.js";
import { restartAnswer } from "../mods/am-sidebar/restart.js";

const stack = "am: Error: launch failed\n    at launchRun (models.js:508:3)\n    at main (cli.mjs:42:1)";
test("bot action errors keep the cause and an action, never a stack frame", () => {
  for (const error of [stack, new Error("launch failed"), "TypeError: launch failed\n    at main (cli.mjs:42:1)"]) {
    const message = actionError(error, "Restart");
    assert.equal(message, "launch failed; check the log and try again.");
    assert.equal(actionError(message, "Restart"), message);
  }
  assert.equal(restartAnswer({ code: 1, err: stack }).refused, "launch failed; check the log and try again.");
  assert.equal(actionError("\n    at main (cli.mjs:42:1)", "Start"), "Start failed; check the log and try again.");
  assert.equal(actionError("The command selects a different Hermes profile; match --profile to the bot's pairing."),
    "The command selects a different Hermes profile; match --profile to the bot's pairing.");
  assert.match(actionError("Hermes isn't installed on this computer."), /; install the agent on that machine and try again\.$/);
});
