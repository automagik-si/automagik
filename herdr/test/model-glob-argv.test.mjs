// #1491: a 1M-context Claude id (`claude-fable-5-2[1m]`) holds shell glob characters. Every word
// the pack generates (the model pin, resume words) reaches the agent as an argv word of its own,
// never inside shell text, so a folder holding files the pattern matches changes nothing. A
// template's command is the owner's shell text, run by `sh -c` as written: the pack adds no pin to
// it, and a model written there carries the owner's own quotes. Run through a real /bin/sh in a
// scratch folder with matching files and a stand-in `claude` that records its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { commandArgv, restartPlan } from "../mods/am-sidebar/restart.js";
import { startArgs } from "../mods/am-sidebar/launchArgs.js";
import { workerPlan } from "../mods/am-sidebar/workers.js";
import { commandOf, formFrom } from "../mods/am-sidebar/formModel.js";
import { scratchRoot } from "./scratch-project.mjs";

const ID = "claude-fable-5-2[1m]";
const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A scratch folder where `claude-fable-5-2[1m]` unquoted would match files, and a recording `claude`. */
function world(t) {
  const root = scratchRoot(t, "hb-glob-");
  const bin = join(root, "bin"), cwd = join(root, "cwd");
  mkdirSync(bin); mkdirSync(cwd);
  for (const f of ["claude-fable-5-21", "claude-fable-5-2m"]) writeFileSync(join(cwd, f), "");
  const log = join(root, "argv.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n: > "${log}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LANG: "C" };
  /** Runs `argv` with no shell of ours (as hc does) and returns the words claude got. */
  const run = (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(log, "utf8").split("\n").slice(0, -1);
  };
  return { root, cwd, run };
}

test("#1491 sanity: in this folder an unquoted 1M id expands to the matching files", (t) => {
  const w = world(t);
  assert.deepEqual(w.run(["/bin/sh", "-c", `claude --model ${ID}`]), ["--model", "claude-fable-5-21", "claude-fable-5-2m"]);
});

test("#1491 restart from the agent row: the pin is one argv word, exact, through startArgs and a real exec", (t) => {
  const w = world(t);
  const bot = { agent: "claude", model: ID };
  const plan = restartPlan({ bot, run: ["claude"], runningAgent: "claude", session: SID });
  assert.equal(plan.model, ID);
  const at = plan.argv.indexOf("--model");
  assert.ok(at > 0, plan.argv.join(" "));
  assert.equal(plan.argv[at + 1], ID);
  assert.equal(plan.argv.filter((x) => x.includes("[1m]")).length, 1);
  const args = startArgs({ botId: "b-globaaaaaa", name: "g", cwd: w.cwd, parent: ["--no-parent"], argv: plan.argv });
  const launched = args.slice(args.indexOf("--") + 1);
  assert.deepEqual(launched, plan.argv, "hc run gets the argv as words after --");
  const got = w.run(launched);
  assert.equal(got[got.indexOf("--model") + 1], ID);
  assert.ok(!got.includes("claude-fable-5-21"));
  // A fresh start the same.
  const fresh = restartPlan({ bot, run: ["claude"], runningAgent: "claude", fresh: true });
  const gotFresh = w.run(fresh.argv);
  assert.equal(gotFresh[gotFresh.indexOf("--model") + 1], ID);
});

test("#1491 a template that quotes its own 1M id keeps it exact; resume words go after it as words of their own", (t) => {
  const w = world(t);
  const template = { name: "fable-1m", command: `claude --model '${ID}'` };
  const plan = restartPlan({ bot: { agent: "claude", model: ID }, run: ["claude"], runningAgent: "claude", session: SID, template });
  assert.equal(plan.template, "fable-1m");
  assert.equal(plan.model, null, "the template owns its command: the pack adds no pin");
  assert.deepEqual(plan.argv.slice(0, 2), ["sh", "-c"]);
  assert.equal(plan.argv[2], `${template.command} "$@"`);
  assert.deepEqual(plan.argv.slice(3), ["sh", ...plan.resume]);
  assert.ok(plan.resume.length > 0, "a resume adds words");
  assert.deepEqual(w.run(plan.argv), ["--model", ID, ...plan.resume]);
});

test("#1491 words the pack puts after a template's command arrive exact through \"$@\"", (t) => {
  const w = world(t);
  const argv = commandArgv({ shell: "claude" }, ["--model", ID]);
  assert.deepEqual(argv, ["sh", "-c", 'claude "$@"', "sh", "--model", ID]);
  assert.deepEqual(w.run(argv), ["--model", ID]);
});

test("#1491 a template that names no model gets no --model from the bot's pin", (t) => {
  const w = world(t);
  const plan = restartPlan({ bot: { agent: "claude", model: ID }, run: ["claude"], runningAgent: "claude", fresh: true,
    template: { name: "plain", command: "claude" } });
  assert.equal(plan.template, "plain");
  assert.equal(plan.argv.includes("--model"), false);
  assert.equal(w.run(plan.argv).includes("--model"), false);
});

test("#1491 a worker on the 1M id: --model and the id are adjacent, exact words", (t) => {
  const w = world(t);
  const plan = workerPlan({ id: "b-globaaaaaa", name: "g", agent: "claude" }, { model: ID });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.model, ID);
  assert.equal(plan.argv[plan.argv.indexOf("--model") + 1], ID);
  const got = w.run(plan.argv);
  assert.equal(got[got.indexOf("--model") + 1], ID);
});

test("#1491 the form's copied line, run by a shell in that folder, still names the exact id", (t) => {
  const w = world(t);
  const file = { version: 1, categories: [], bots: [
    { id: "b-mainaaaaaa", name: "lead", kind: "main", look: { character: "star", colour: "blue" }, role: "", instructions: "", agent: "claude" },
  ] };
  const initial = formFrom({ mode: "edit", bot: file.bots[0] });
  const line = commandOf({ ...initial, pin: ID }, { key: w.cwd, file, initial });
  // A stand-in `am` on that line: the shell's words, as the CLI would get them.
  const words = line.replace(/^am /, "claude ");
  const got = w.run(["/bin/sh", "-c", words]);
  assert.ok(got.includes(`--model=${ID}`), got.join(" "));
  assert.ok(!got.some((x) => x.includes("claude-fable-5-21")));
});
