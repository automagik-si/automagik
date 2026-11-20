// #1413: a Claude Code bot's own permission mode. Claude Code's --permission-mode names what a
// session may run without asking; the pack passes `auto` by default, and a bot's record may name
// another of Claude Code's own modes. It is independent of the model, reasoning effort and service
// tier, and it reaches every launch path the pack builds (start, restart, revive, worker, helper).
// Pure: no herdr, home or window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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

test("#1413 F2: refusing a mode on Codex or Antigravity names the control to use instead", () => {
  assert.match(permissionModeProblem("codex", "auto"),
    /Claude Code's \(--permission-mode\); Codex has none: use its fixed launch mode \(#1125\)/);
  assert.match(permissionModeProblem("antigravity", "auto"),
    /Antigravity has none: use its execution mode \(agyMode\)/);
  assert.equal(permissionModeProblem("claude", "auto"), null, "a Claude mode with a name is accepted");
});

test("#1413 F4: a worker helper inherits its seat's mode; a non-worker helper keeps its own command", () => {
  const record = bot({ permissionMode: "bypassPermissions" });
  const get = (argv) => ({ address: "t7", cwd: "/w", state: "live", argv, foreground: { argv, cwd: "/w" } });
  // A worker helper is rebuilt from the record, as before.
  const worker = helperPlan({ get: get(["claude"]), worker: { agent: "claude", worktree: "/w" }, agents: AGENTS, bot: record });
  assert.equal(worker.error, undefined);
  assert.equal(permissionOf(withoutPerson(worker.argv)), "bypassPermissions");
  // A non-worker helper runs the command the person gave it: its own explicit mode stands,
  // and one that names none is never given the seat's (the README's narrowed rule).
  const own = helperPlan({ get: get(["claude", "--permission-mode", "plan"]), agents: AGENTS, bot: record });
  assert.equal(own.error, undefined);
  assert.equal(permissionOf(withoutPerson(own.argv)), "plan");
  const plainHelper = helperPlan({ get: get(["claude"]), agents: AGENTS, bot: record });
  assert.equal(plainHelper.error, undefined);
  assert.equal(permissionOf(withoutPerson(plainHelper.argv)), null, "the seat's mode is not added to a non-worker helper");
});

test("#1413 F5: the pinned permission-mode list stays in step with the installed Claude Code", (t) => {
  const found = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  const claude = found.status === 0 ? found.stdout.trim() : "";
  if (!claude) {
    t.skip("Claude Code isn't on this machine's PATH; the list is pinned from Claude Code 2.1.328's --help");
    return;
  }
  const help = spawnSync(claude, ["--help"], { encoding: "utf8", timeout: 30_000 });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  const at = text.indexOf("--permission-mode");
  const choices = at < 0 ? null : /\(choices: ([\s\S]*?)\)/.exec(text.slice(at));
  assert.ok(choices, `Claude Code's --help no longer lists --permission-mode's choices; read it and update CLAUDE_PERMISSION_MODES in models.js`);
  const modes = [...choices[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modes.sort(), [...CLAUDE_PERMISSION_MODES].sort(),
    "Claude Code's --permission-mode list changed: update CLAUDE_PERMISSION_MODES in models.js and the README's permission-mode table, or a valid mode would be refused");
});
