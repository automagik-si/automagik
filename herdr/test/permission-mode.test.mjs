// #1413: a Claude Code bot's own permission mode. Claude Code's --permission-mode names what a
// session may run without asking; the pack passes `auto` by default, and a bot's record may name
// another of Claude Code's own modes. It is independent of the model, reasoning effort and service
// tier, and it reaches every launch path the pack builds (start, restart, revive, worker, helper).
// Pure: no herdr, home or window.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENTS, CLAUDE_PERMISSION_MODES, PERMISSION_MODE_DEFAULT, launchRun, permissionModeArgs,
  permissionModeFrom, permissionModeProblem,
} from "../mods/am-sidebar/models.js";
import { helperPlan, restartPlan } from "../mods/am-sidebar/restart.js";
import { workerPlan } from "../mods/am-sidebar/workers.js";

const ID = "b-aaaaaaaaaa";
const bot = (extra = {}) => ({ id: ID, name: "Genie", agent: "claude", ...extra });
const PERSON_SETTINGS = "--settings";

/** `argv` without the Claude person-feature settings pair the launch also carries (#1558). */
function withoutPerson(argv) {
  const i = argv.indexOf(PERSON_SETTINGS);
  return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)];
}
const permissionOf = (argv) => {
  const i = argv.indexOf("--permission-mode");
  return i < 0 ? null : argv[i + 1];
};

test("#1413: Claude Code's own permission mode names are accepted, and the default stays auto", () => {
  assert.deepEqual([...CLAUDE_PERMISSION_MODES], ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
  assert.equal(PERMISSION_MODE_DEFAULT, "auto");
  for (const mode of CLAUDE_PERMISSION_MODES) {
    assert.equal(permissionModeProblem("claude", mode), null, mode);
    assert.deepEqual(permissionModeArgs("claude", mode), ["--permission-mode", mode]);
  }
  assert.deepEqual(permissionModeArgs("claude"), ["--permission-mode", "auto"], "no stored mode: the pack's auto mode");
  // A value Claude Code doesn't accept is refused with every accepted name in the sentence.
  const bad = permissionModeProblem("claude", "banana");
  assert.match(bad, /"banana" isn't one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan/);
  assert.match(permissionModeProblem("claude", "default"), /"default" isn't one of/, "the old default spelling is not a mode");
  assert.match(permissionModeProblem("claude", 7), /isn't text/);
  // Only Claude Code has this per-bot mode; another agent says so instead of dropping the value.
  assert.deepEqual(permissionModeArgs("codex", "auto"), []);
  assert.match(permissionModeProblem("codex", "auto"), /Claude Code.*Codex has none/);
  assert.match(permissionModeProblem(null, "auto"), /no coding agent/);
});

test("#1413: a run already naming its approvals is left alone, unless the bot's record names a mode", () => {
  assert.deepEqual(withoutPerson(launchRun("claude", ["claude", "--permission-mode", "manual"], bot())),
    ["claude", "--permission-mode", "manual"]);
  assert.deepEqual(withoutPerson(launchRun("claude", ["claude", "--permission-mode", "manual"],
    bot({ permissionMode: "bypassPermissions" }))), ["claude", "--permission-mode", "manual", "--permission-mode", "bypassPermissions"]);
  const last = (argv) => argv[argv.lastIndexOf("--permission-mode") + 1];
  assert.equal(last(launchRun("claude", ["claude", "--permission-mode=plan"], bot({ permissionMode: "dontAsk" }))), "dontAsk",
    "the record wins, as its own later word");
});

test("#1413: start, restart, worker and tree helper all carry the bot's permission mode", () => {
  const record = bot({ permissionMode: "bypassPermissions" });
  const start = launchRun("claude", AGENTS.claude.run, record);
  assert.equal(permissionOf(withoutPerson(start)), "bypassPermissions");
  // A restart: the caller hands restartPlan launchRun's words, and a fresh start keeps them.
  const fresh = restartPlan({ bot: record, run: start, fresh: true });
  assert.equal(permissionOf(withoutPerson(fresh.argv)), "bypassPermissions");
  const resumed = restartPlan({ bot: record, run: start });
  assert.equal(permissionOf(withoutPerson(resumed.argv)), "bypassPermissions");
  // A worker and a Restart --tree helper run from the same definition.
  const worker = workerPlan(record, {});
  assert.equal(worker.error, undefined);
  assert.equal(permissionOf(withoutPerson(worker.argv)), "bypassPermissions");
  const helper = helperPlan({ get: { address: "t7", cwd: "/w", state: "live", argv: ["claude"],
    foreground: { argv: ["claude"], cwd: "/w" } }, worker: { agent: "claude", worktree: "/w" }, agents: AGENTS, bot: record });
  assert.equal(helper.error, undefined);
  assert.equal(permissionOf(withoutPerson(helper.argv)), "bypassPermissions");
});

test("#1413: what a live pane runs is read from its command line, both spellings", () => {
  assert.equal(permissionModeFrom(["/usr/bin/env", "PATH=/x", "claude", "--permission-mode", "plan"]), "plan");
  assert.equal(permissionModeFrom(["claude", "--permission-mode=acceptEdits"]), "acceptEdits");
  assert.equal(permissionModeFrom(["claude", "--dangerously-skip-permissions"]), "bypassPermissions");
  assert.equal(permissionModeFrom(["claude", "--permission-mode", "plan", "--permission-mode", "manual"]), "manual",
    "the last one wins");
  assert.equal(permissionModeFrom(["claude", "--", "--permission-mode", "plan"]), null, "after -- it is prompt text");
  assert.equal(permissionModeFrom(["claude"]), null);
});
