// Restart over plain data (restart.js, models.js resumeArgs): what the replacement runs per
// agent (resume, fresh, swap), the refusals (a turn in progress, helpers that end with the
// pane) and the labels carried over. The hc side is in cli.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENTS, canResume, continuesAnywhere, resumeArgs, withoutModel, withoutResume } from "../mods/am-sidebar/models.js";
import { carriedLabels, commandArgv, continueRefusal, helperArgs, helperPlan, ledgerSession, launchChange, paneCommand, paneLaunch, paneSession, planText,
  restartAnswer, restartArgs, claudeSlug, restartPlan, restartRefusal, sameSessions, sessionId, sessionOf, sharedFolders, sharedFresh, takesWords, withoutPrompt }
  from "../mods/am-sidebar/restart.js";

const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
const SID2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const screenFixture = (name) => readFileSync(new URL(`../mods/pocket-link/chat/fixtures/screens/${name}`, import.meta.url), "utf8");

const claude = { agent: "claude", model: "claude-opus-5-5" };

test("resumeArgs: claude by session id, else --continue; codex resume --last; --continue for pi, omp, kimi, agy, hermes; none for the rest", () => {
  assert.deepEqual(resumeArgs("claude", "s-1"), ["--resume", "s-1"]);
  assert.deepEqual(resumeArgs("claude", null), ["--continue"]);
  assert.deepEqual(resumeArgs("claude", "  "), ["--continue"]);
  assert.deepEqual(resumeArgs("codex"), ["resume", "--last"]);
  for (const k of ["pi", "omp", "kimi", "antigravity", "hermes"]) assert.deepEqual(resumeArgs(k), ["--continue"], k);
  for (const k of ["opencode", "cursor", "copilot", "amp", "grok", "kiro", "qoder", "crush", "nope"]) {
    assert.equal(resumeArgs(k), null, k);
    assert.equal(canResume(k), false, k);
  }
});

test("restartPlan resume: claude with the pane's session and the bot's pin; --continue without one; codex resume before its model flag", () => {
  const withId = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: SID });
  assert.equal(withId.mode, "resume");
  assert.deepEqual(withId.argv, ["claude", "--resume", SID, "--model", "claude-opus-5-5"]);
  // RFC 0021: no session id in any output.
  assert.equal(planText(withId, SID), "resuming its session by id");
  const latest = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude" });
  assert.deepEqual(latest.argv, ["claude", "--continue", "--model", "claude-opus-5-5"]);
  assert.match(planText(latest, null), /--continue/);
  const codex = restartPlan({ bot: { agent: "codex", model: "gpt-5.5" }, run: ["codex", "--yolo"], runningAgent: "codex", session: "-rf" }); // not a session id: --last
  assert.deepEqual(codex.argv, ["codex", "--yolo", "resume", "--last", "--model", "gpt-5.5"]);
  assert.equal(planText(codex), "resuming its last conversation (resume --last)");
  const pi = restartPlan({ bot: { agent: "pi" }, run: ["pi"], runningAgent: "pi" });
  assert.deepEqual(pi.argv, ["pi", "--continue"]);
});

test("agy 1.5.3 restart (#793): --mode auto by default, a session resumes by --conversation, else --continue; --fresh starts new", () => {
  const agy = { agent: "antigravity", model: "gemini-4-argon-high" };
  const resume = restartPlan({ bot: agy, run: ["agy"], runningAgent: "antigravity", session: SID });
  assert.deepEqual([resume.mode, resume.argv], ["resume", ["agy", "--mode", "auto", "--conversation", SID, "--model", "gemini-4-argon-high"]]);
  assert.equal(planText(resume, SID), "resuming its session by id (--conversation ***)");
  const latest = restartPlan({ bot: agy, run: ["agy"], runningAgent: "antigravity" });
  assert.deepEqual(latest.argv, ["agy", "--mode", "auto", "--continue", "--model", "gemini-4-argon-high"]);
  const fresh = restartPlan({ bot: agy, run: ["agy"], runningAgent: "antigravity", session: SID, fresh: true });
  assert.deepEqual([fresh.mode, fresh.argv], ["fresh", ["agy", "--mode", "auto", "--model", "gemini-4-argon-high"]]);
  // The roster's mode is the one the replacement runs, and it is in the source launchChange compares.
  const plan = restartPlan({ bot: { ...agy, agyMode: "plan" }, run: ["agy"], runningAgent: "antigravity", session: SID });
  assert.deepEqual(plan.argv, ["agy", "--mode", "plan", "--conversation", SID, "--model", "gemini-4-argon-high"]);
  assert.deepEqual(plan.source, ["agy", "--mode", "plan", "--model", "gemini-4-argon-high"]);
  // A session id that isn't one safe word never reaches --conversation.
  assert.deepEqual(restartPlan({ bot: agy, run: ["agy"], runningAgent: "antigravity", session: "--dangerously-skip-permissions" }).argv,
    ["agy", "--mode", "auto", "--continue", "--model", "gemini-4-argon-high"]);
});

test("restartPlan fresh: --fresh, an agent with no resume, a pane running another agent (each says why)", () => {
  const fresh = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: SID, fresh: true });
  assert.deepEqual([fresh.mode, fresh.argv, fresh.note], ["fresh", ["claude", "--model", "claude-opus-5-5"], null]);
  const amp = restartPlan({ bot: { agent: "amp" }, run: ["amp"], runningAgent: "amp" });
  assert.equal(amp.mode, "fresh");
  assert.deepEqual(amp.argv, ["amp"]);
  assert.match(amp.note, /amp has no resume this pack knows/);
  assert.match(planText(amp), /a new conversation \(amp has no resume/);
  const crossed = restartPlan({ bot: claude, run: ["claude"], runningAgent: "codex", session: SID });
  assert.equal(crossed.mode, "fresh");
  assert.match(crossed.note, /runs codex, not claude/);
});

test("restartPlan swap: --agent starts fresh on the agent's default (the old pin left behind); --model alone keeps the agent; always new", () => {
  const toCodex = restartPlan({ bot: claude, run: ["codex"], runningAgent: "claude", session: SID, agent: "codex" });
  assert.deepEqual([toCodex.mode, toCodex.agent, toCodex.model, toCodex.argv], ["swap", "codex", null, ["codex"]]);
  const pinned = restartPlan({ bot: claude, run: ["codex"], agent: "codex", model: "gpt-5.5" });
  assert.deepEqual(pinned.argv, ["codex", "--model", "gpt-5.5"]);
  assert.equal(planText(pinned), "on codex (gpt-5.5), a new conversation");
  const sonnet = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: SID, model: "claude-sonnet-5-5" });
  assert.deepEqual([sonnet.mode, sonnet.argv], ["swap", ["claude", "--model", "claude-sonnet-5-5"]]);
  // An empty model (the CLI's "no pin") starts on the default.
  assert.deepEqual(restartPlan({ bot: claude, run: ["claude"], agent: "claude", model: "" }).argv, ["claude"]);
});

test("restartRefusal: a working pane, then helpers that die with it; outliving helpers and finished ones don't count; --force passes", () => {
  const idle = { address: "t5", status: { state: "idle" } };
  const working = { address: "t5", status: { state: "working" } };
  assert.match(restartRefusal({ name: "Genie", old: working }), /Genie is working in t5; restarting now would cut its turn in half\. .*--force/);
  assert.equal(restartRefusal({ name: "Genie", old: working, force: true }), null);
  const helpers = [
    { address: "t7", state: "live", die_with_parent: true },
    { address: "t8", state: "live", die_with_parent: false }, // a member bot, --outlive-parent
    { address: "t9", state: "finished", die_with_parent: true },
  ];
  assert.match(restartRefusal({ name: "Genie", old: idle, helpers }), /t5 has a helper that ends with it: t7\. .*--force/);
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: helpers.slice(1) }), null);
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers, force: true }), null);
  assert.equal(restartRefusal({ name: "Genie", old: idle }), null);
});

test("restartRefusal onMachine offers tree on the holding machine and explicit force", () => {
  const idle = { address: "vm/t5", status: { state: "idle" } };
  const helper = { address: "vm/t7", state: "live", die_with_parent: true, status: { state: "working" } };
  const refusal = restartRefusal({ name: "Genie", old: idle, helpers: [helper], onMachine: true });
  assert.match(refusal, /--tree runs on their machine/);
  assert.match(refusal, /End helpers and restart/);
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: [helper], onMachine: true, force: true }), null);
  assert.equal(restartAnswer({ code: 1, out: { refused: "helpers" }, err: refusal }).helpers, true);
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: [{ ...helper, die_with_parent: false }], onMachine: true }), null);
  assert.match(restartRefusal({ name: "Genie", old: { ...idle, status: { state: "working" } }, onMachine: true }), /Genie is working in vm\/t5/);
});

test("carriedLabels keeps the old pane's squad and its mark; sessionOf reads agent.session", () => {
  assert.deepEqual(carriedLabels({ labels: { bot: "b", squad: "s1", "automagik-herdr.squad": "s1", "herdr.space": "sp" } }),
    { squad: "s1", "automagik-herdr.squad": "s1" });
  assert.deepEqual(carriedLabels({ labels: { squad: "theirs" } }), { squad: "theirs" });
  assert.deepEqual(carriedLabels(null), {});
  assert.equal(sessionOf({ labels: { "agent.session": SID } }), SID);
  assert.equal(sessionOf({ labels: { "agent.session": "s-1" } }), null, "not UUID-shaped");
  assert.equal(sessionOf({ labels: {} }), null);
  assert.equal(sessionOf(null), null);
});

test("the sidebar's Restart: the CLI's restart through launch.js runCli; its answer read back", () => {
  assert.deepEqual(restartArgs({ botId: "b-1", projectKey: "/p" }), ["restart", "b-1", "--project", "/p"]);
  assert.deepEqual(restartArgs({ botId: "b-1", projectKey: "/p", agent: "codex", force: true, fresh: true }).slice(4), ["--agent", "codex", "--force", "--fresh"]);
  assert.deepEqual(restartAnswer({ code: 0, out: { terminal: "t100", replaced: "t5", warnings: ["w"] }, err: "" }), { terminal: "t100", replaced: "t5", warnings: ["w"] });
  assert.deepEqual(restartAnswer({ code: 0, out: { id: "b-1", running: "t7" }, err: "" }), { refused: "It is already running in t7.", forceable: false, freshable: false });
  const working = restartAnswer({ code: 1, out: null, err: "a warning\nGenie is working in t5; restarting now would cut its turn in half. Wait until it is idle, or pass --force." });
  assert.match(working.refused, /^Genie is working in t5/);
  assert.equal(working.forceable, true);
  assert.equal(restartAnswer({ code: 1, err: "Genie has no recorded Claude session ... restart with --fresh for a new conversation." }).freshable, true);
  assert.deepEqual(restartAnswer({ code: 1, out: null, err: "No bot x in this project." }), { refused: "No bot x in this project; check the log and try again.", forceable: false, freshable: false });
  assert.deepEqual(restartAnswer({ code: 127, out: null, err: "" }), { refused: "Restart failed; check the log and try again.", forceable: false, freshable: false });
});

test("session ids: only UUID-shaped ones resume; a flag-like value never reaches --resume; the ledger's last row for the terminal stands in", () => {
  assert.equal(sessionId(` ${SID} `), SID);
  for (const bad of ["-rf", "--dangerously-skip-permissions", "s-1", "", null, 7]) assert.equal(sessionId(bad), null, String(bad));
  assert.deepEqual(restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: "--print" }).argv, ["claude", "--continue", "--model", "claude-opus-5-5"]);
  assert.deepEqual(resumeArgs("claude", "-x"), ["--continue"]);
  const other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const rows = [{ event: "session", terminal: "t5", session: other, transcript: "/a.jsonl" }, { event: "start", terminal: "t5" },
    { event: "session", terminal: "t5", session: SID }, { event: "session", terminal: "t6", session: other }, { event: "session", terminal: "t5", session: "junk" }];
  assert.deepEqual(ledgerSession(rows, "t5"), { session: SID, transcript: null });
  assert.equal(ledgerSession(rows, "t7"), null);
  assert.equal(ledgerSession(null, "t5"), null);
});

test("ledgerSession per agent (#328): a row naming its agent feeds that agent, one safe word; an unnamed row is Claude's; never a flag", () => {
  const rows = [{ event: "session", terminal: "t5", session: "omp-sess-1", agent: "omp" }, { event: "session", terminal: "t5", session: SID },
    { event: "session", terminal: "t6", session: "-rf", agent: "omp" }, { event: "session", terminal: "t7", session: "pi-1", agent: "pi" }];
  assert.deepEqual(ledgerSession(rows, "t5", "omp"), { session: "omp-sess-1", transcript: null });
  assert.deepEqual(ledgerSession(rows, "t5", "claude"), { session: SID, transcript: null }, "an unnamed row is Claude's");
  assert.deepEqual(ledgerSession(rows, "t5"), { session: SID, transcript: null });
  assert.equal(ledgerSession(rows, "t6", "omp"), null, "a flag-like id never passes");
  assert.equal(ledgerSession(rows, "t7", "omp"), null, "another agent's row doesn't feed omp");
  assert.deepEqual(ledgerSession(rows, "t7", "pi"), { session: "pi-1", transcript: null });
});

test("ledgerSession on a reused address (#328 review): an earlier pane's row there never counts, by created_ms or a later start row", () => {
  const old = { event: "session", terminal: "t5", session: "old-pane", agent: "omp", at: "2026-11-04T10:00:00.000Z" };
  const born = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(ledgerSession([old], "t5", "omp", born), null, "stamped before this pane was created");
  assert.deepEqual(ledgerSession([old], "t5", "omp", Date.parse("2026-11-04T09:00:00.000Z")), { session: "old-pane", transcript: null });
  // No created_ms: a start row for t5 after the session row is a new pane there.
  assert.equal(ledgerSession([old, { event: "start", kind: "seat", terminal: "t5" }], "t5", "omp"), null);
  assert.deepEqual(ledgerSession([{ event: "start", kind: "seat", terminal: "t5" }, old], "t5", "omp"), { session: "old-pane", transcript: null });
});

test("sharedFresh (#328): null with no other bot there; else why the restart starts fresh, naming each sharer, the folder and the skipped resume", () => {
  assert.equal(sharedFresh({ name: "Herdr Tester", old: { address: "t5" }, cwd: "/p", agent: "omp", words: "--continue" }), null);
  assert.equal(sharedFresh({ name: "Herdr Tester", old: { address: "t5" }, cwd: "/p", sharers: [{ address: "t9", name: "Herdr Dev" }], agent: "omp", words: "--continue" }),
    "no omp session id is known for t5, and Herdr Dev (t9) also runs omp in /p, so --continue could resume theirs instead of Herdr Tester's");
  assert.match(sharedFresh({ name: "G", old: { address: "t5" }, cwd: "/p", sharers: [{ address: "t9", name: "A" }, { address: "t8", name: "B" }], agent: "Codex", words: "resume --last" }),
    /A \(t9\), B \(t8\) also run Codex in \/p, so resume --last could resume theirs/);
  // One known only by its seat row (its pane ended) ran there; agy's --continue isn't limited to the folder.
  assert.match(sharedFresh({ name: "G", old: { address: "t5" }, cwd: "/p", sharers: [{ address: "t9", name: "A", ended: true }], agent: "Oh My Pi", words: "--continue" }),
    /A \(t9, ended\) also ran Oh My Pi in \/p, so --continue/);
  assert.equal(sharedFresh({ name: "G", old: { address: "t5" }, cwd: "/p", sharers: [{ address: "t9", name: "A" }], agent: "Antigravity", words: "--continue", anywhere: true }),
    "no Antigravity session id is known for t5, and A (t9) also runs Antigravity, so --continue could resume theirs instead of G's (Antigravity's --continue isn't limited to one folder)");
  assert.equal(continuesAnywhere("antigravity"), true);
  for (const k of ["claude", "codex", "omp", "pi", "kimi", "hermes"]) assert.equal(continuesAnywhere(k), false, k);
});

test("continueRefusal: refused only when another bot's Claude shares the folder", () => {
  assert.equal(continueRefusal({ name: "Genie", old: { address: "t5" }, cwd: "/p" }), null);
  assert.match(continueRefusal({ name: "Genie", old: { address: "t5" }, cwd: "/p", sharers: [{ address: "t9", name: "Captain" }, { address: "t8", name: "Dev" }] }),
    /Genie has no recorded Claude session \(t5 has no agent.session label .*\), and Captain \(t9\), Dev \(t8\) also run Claude in \/p, so --continue could resume theirs\. Nothing was started; restart with --fresh/);
});

// ---- #213/#597: the source's command, resume by id, --tree ----

test("resumeArgs by session id: codex resume <id>, omp --resume=<id>, pi --session <id>, hermes --resume <id>, kimi --session=<id>, agy --conversation <id>", () => {
  assert.deepEqual(resumeArgs("codex", SID), ["resume", SID]);
  assert.deepEqual(resumeArgs("omp", SID), [`--resume=${SID}`]);
  assert.deepEqual(resumeArgs("pi", SID), ["--session", SID]);
  assert.deepEqual(resumeArgs("hermes", SID), ["--resume", SID]);
  assert.deepEqual(resumeArgs("kimi", SID), [`--session=${SID}`]);
  assert.deepEqual(resumeArgs("antigravity", SID), ["--conversation", SID]);
  assert.deepEqual(resumeArgs("omp", "-x"), ["--continue"], "never a flag as an id");
  assert.deepEqual(resumeArgs("kimi", "-x"), ["--continue"]);
});

test("withoutResume drops an earlier resume per agent (codex's -c is its config, kept); withoutModel drops the model flags", () => {
  assert.deepEqual(withoutResume("claude", ["claude", "--model", "m", "--resume", SID, "-c"]), ["claude", "--model", "m"]);
  assert.deepEqual(withoutResume("codex", ["codex", "-c", "x=1", "resume", "--last", "-m", "g"]), ["codex", "-c", "x=1", "-m", "g"]);
  assert.deepEqual(withoutResume("codex", ["codex", "resume", SID]), ["codex"]);
  assert.deepEqual(withoutResume("omp", ["omp", "-c", "--resume=abc", "--model=k", "--restore=x"]), ["omp", "--model=k"]);
  assert.deepEqual(withoutResume("pi", ["pi", "--session", SID, "--continue", "--model", "p"]), ["pi", "--model", "p"]);
  assert.deepEqual(withoutResume("kimi", ["kimi", "-c", "--session=abc", "-S", "--yolo"]), ["kimi", "--yolo"]);
  // -S, --session [id]: its value goes with it (#328 review), a flag after it doesn't.
  assert.deepEqual(withoutResume("kimi", ["kimi", "-S", "abc", "--yolo"]), ["kimi", "--yolo"]);
  assert.deepEqual(withoutResume("kimi", ["kimi", "--session", "abc"]), ["kimi"]);
  assert.deepEqual(withoutResume("kimi", ["kimi", "--session", "--plan"]), ["kimi", "--plan"]);
  assert.deepEqual(withoutResume("antigravity", ["agy", "-c", "--conversation", "abc", "--model", "m"]), ["agy", "--model", "m"]);
  assert.deepEqual(withoutModel("codex", ["codex", "-m", "a", "-mb", "--model=c", "-c", "model=d", "-c", "model_reasoning_effort=high"]),
    ["codex", "-c", "model_reasoning_effort=high"]);
  assert.deepEqual(withoutModel("omp", ["omp", "--model=k", "--thinking=high"]), ["omp", "--thinking=high"]);
});

test("paneCommand: hc's launch argv without this pack's env PATH prefix; a template's sh -c command, its \"$@\" and old arguments dropped", () => {
  assert.equal(paneCommand({}), null);
  assert.deepEqual(paneCommand({ argv: ["/usr/bin/env", "PATH=/a", "omp", "--model=k"] }), { argv: ["omp", "--model=k"] });
  assert.deepEqual(paneCommand({ argv: ["env", "FOO=1", "omp"] }), { argv: ["env", "FOO=1", "omp"] }, "someone else's env stays");
  assert.deepEqual(paneCommand({ argv: ["sh", "-c", "omp --x"] }), { shell: "omp --x" });
  assert.deepEqual(paneCommand({ argv: ["/usr/bin/env", "PATH=/a", "sh", "-c", 'omp --x "$@"', "sh", "--continue"] }), { shell: "omp --x" });
});

test("restartPlan rebuilds from the source, never the pane's command: flags the source doesn't name are dropped (#597)", () => {
  const omp = { agent: "omp" };
  // A template-less pane with a shell command: the agent row and its resume, never the shell.
  const tpl = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", launch: { shell: "omp --auto-approve --model k" } });
  assert.deepEqual([tpl.mode, tpl.argv, tpl.source], ["resume", ["omp", "--continue"], ["omp"]]);
  const fresh = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", fresh: true });
  assert.deepEqual([fresh.mode, fresh.argv], ["fresh", ["omp"]], "--fresh: the source, no resume words");
  // The bot's pin is the source's model, never the pane's old one or a hand-given flag.
  const codex = restartPlan({ bot: { agent: "codex", model: "gpt-b" }, run: ["codex"], runningAgent: "codex", session: SID });
  assert.deepEqual(codex.argv, ["codex", "resume", SID, "--model", "gpt-b"]);
  assert.deepEqual(codex.source, ["codex", "--model", "gpt-b"]);
  assert.equal(codex.model, "gpt-b");
  const same = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: SID });
  assert.deepEqual(same.argv, ["claude", "--resume", SID, "--model", "claude-opus-5-5"]);
  // Another agent in the pane, or a swap: the definition's command, fresh.
  const other = restartPlan({ bot: omp, run: ["omp"], runningAgent: "codex", launch: { argv: ["codex", "-m", "x"] } });
  assert.deepEqual([other.mode, other.argv], ["fresh", ["omp"]]);
  const swap = restartPlan({ bot: omp, run: ["codex"], runningAgent: "omp", agent: "codex" });
  assert.deepEqual([swap.mode, swap.argv], ["swap", ["codex"]]);
});

test("restartPlan runs a live template's CURRENT command with its resume words; a swap leaves it behind (#597 review F1)", () => {
  const omp = { agent: "omp" };
  const template = { name: "dev-kimi", command: "omp --auto-approve --model kimi/k3" };
  const resumed = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", session: SID, template });
  assert.deepEqual([resumed.mode, resumed.template, resumed.model], ["resume", "dev-kimi", null]);
  assert.deepEqual(resumed.argv, ["sh", "-c", 'omp --auto-approve --model kimi/k3 "$@"', "sh", `--resume=${SID}`]);
  const last = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", template });
  assert.deepEqual(last.argv, ["sh", "-c", 'omp --auto-approve --model kimi/k3 "$@"', "sh", "--continue"]);
  const fresh = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", fresh: true, template });
  assert.deepEqual(fresh.argv, ["sh", "-c", "omp --auto-approve --model kimi/k3"], "--fresh: the template, no resume words");
  // A command ending in a separator can't take words: fresh on the template, with the reason.
  const blocked = restartPlan({ bot: omp, run: ["omp"], runningAgent: "omp", session: SID, template: { name: "x", command: "omp --x;" } });
  assert.deepEqual([blocked.mode, blocked.argv, blocked.note], ["fresh", ["sh", "-c", "omp --x;"],
    "its template's command ends in a separator or a comment, so it can't take resume words"]);
  // A swap chooses the agent row: the template doesn't cross agents.
  const swap = restartPlan({ bot: omp, run: ["codex"], runningAgent: "omp", agent: "codex", template });
  assert.deepEqual([swap.template, swap.argv], [null, ["codex"]]);
});

test("restartPlan uses a live template only when it runs the bot's own agent (D2)", () => {
  const template = { name: "old-omp", command: "omp --auto-approve" };
  // The pane's agent can't be read and the bot was moved to dsh-tui: the template's runner decides.
  const moved = restartPlan({ bot: { agent: "dsh-tui" }, run: ["dsh-tui"], runningAgent: null, fresh: true, template });
  assert.deepEqual([moved.template, moved.argv], [null, ["dsh-tui"]]);
  // The same agent, pane unknown: the template is still the source.
  const same = restartPlan({ bot: { agent: "omp" }, run: ["omp"], runningAgent: null, fresh: true, template });
  assert.deepEqual([same.template, same.argv], ["old-omp", ["sh", "-c", "omp --auto-approve"]]);
  // A template running another agent never crosses into the bot's seat.
  const crossed = restartPlan({ bot: { agent: "omp" }, run: ["omp"], runningAgent: "omp", fresh: true, template: { name: "dsh", command: "dsh-tui" } });
  assert.deepEqual([crossed.template, crossed.argv], [null, ["omp"]]);
  // A quoted shell wrapper is looked into (F2): its own agent matches, another's never does.
  const quoted = restartPlan({ bot: { agent: "omp" }, run: ["omp"], runningAgent: null, fresh: true,
    template: { name: "quoted", command: 'sh -c "omp --auto-approve"' } });
  assert.deepEqual([quoted.template, quoted.argv], ["quoted", ["sh", "-c", 'sh -c "omp --auto-approve"']]);
  const quotedOther = restartPlan({ bot: { agent: "omp" }, run: ["omp"], runningAgent: null, fresh: true,
    template: { name: "quoted", command: 'sh -c "claude --model x"' } });
  assert.deepEqual([quotedOther.template, quotedOther.argv], [null, ["omp"]]);
});

test("paneLaunch and launchChange: only flag names are named, values masked, a template by name (#597 F1/F2)", () => {
  const stale = { argv: ["claude", "--proxy=http://user:token@proxy.example:8080", "--api-key=sk-secret-value", "-c"] };
  assert.deepEqual(paneLaunch(stale, "claude"), ["claude", "--proxy=http://user:token@proxy.example:8080", "--api-key=sk-secret-value"]);
  const line = launchChange({ name: "Genie", launch: stale, agent: "claude", argv: ["claude"] });
  assert.equal(line, "Genie: its pane's command differs from its source now (drops --proxy=***, --api-key=***): "
    + "restarting from the source, not the pane's command.");
  // No value reaches the line: no URL, host, userinfo or key.
  for (const raw of ["http://", "proxy.example", "user:token", "sk-secret-value"]) assert.equal(line.includes(raw), false, raw);
  // A person's own env assignment is masked by name; a flag's separate value is folded in masked.
  assert.equal(launchChange({ name: "Genie", launch: { argv: ["/usr/bin/env", "API_TOKEN=sk-secret-value", "claude"] }, agent: "claude", argv: ["claude"] }),
    "Genie: its pane's command differs from its source now (drops API_TOKEN=***): restarting from the source, not the pane's command.");
  assert.equal(launchChange({ name: "Genie", launch: { argv: ["claude", "--model", "opus"] }, agent: "claude", argv: ["claude"] }),
    "Genie: its pane's command differs from its source now (drops --model=***): restarting from the source, not the pane's command.");
  // The same flag with another value is a change, never the value.
  assert.equal(launchChange({ name: "Genie", launch: { argv: ["claude", "--model", "sonnet"] }, agent: "claude", argv: ["claude", "--model", "opus"] }),
    "Genie: its pane's command differs from its source now (changes --model=***): restarting from the source, not the pane's command.");
  assert.equal(launchChange({ name: "Genie", launch: { argv: ["hermes", "--yolo"] }, agent: "hermes", argv: ["hermes"] }),
    "Genie: its pane's command differs from its source now (drops --yolo): restarting from the source, not the pane's command.");
  // Its own resume words, briefing and a first prompt are this restart's to set: no line.
  const own = { argv: ["claude", "--append-system-prompt-file", "/h/automagik-herdr/briefings/b.md", "--resume", SID] };
  assert.deepEqual(paneLaunch(own, "claude"), ["claude"]);
  assert.equal(launchChange({ name: "Genie", launch: own, agent: "claude", argv: ["claude"] }), null);
  assert.equal(launchChange({ name: "Genie", launch: { argv: ["claude"] }, agent: "claude", argv: ["claude"] }), null);
  assert.equal(launchChange({ name: "Genie", launch: null, agent: "claude", argv: ["claude"] }), null);
  // A shell command without a template is named as one; its text is never printed.
  const shell = launchChange({ name: "Captain", launch: { shell: "omp --auto-approve --model k" }, agent: "omp", argv: ["omp"] });
  assert.equal(shell, "Captain: its pane's command (a shell command) differs from its source now: restarting from the source, not the pane's command.");
  assert.equal(shell.includes("auto-approve"), false);
  // A live template the pane's command already matches: no line; edited, the template is named.
  const live = { name: "dev-kimi", command: "omp --auto-approve --model kimi/k3" };
  assert.equal(launchChange({ name: "Captain", launch: { shell: live.command }, agent: "omp", argv: ["omp"], template: live, usedTemplate: true }), null);
  const edited = launchChange({ name: "Captain", launch: { shell: "omp --old" }, agent: "omp", argv: ["omp"], template: live, usedTemplate: true });
  assert.equal(edited, "Captain: its pane's command differs from template dev-kimi's current command: restarting through the template.");
  assert.equal(edited.includes("kimi/k3"), false);
  // A template hc no longer lists: its name, never its text.
  assert.equal(launchChange({ name: "Captain", launch: { shell: "env PATH=/x omp --auto-approve" }, agent: "omp", argv: ["omp"], template: { name: "dev-kimi" } }),
    "Captain: its pane's template dev-kimi differs from its source now: restarting from the source, not the pane's command.");
});

test("launchChange never prints a flag's value, whatever form it takes or starts with (D1)", () => {
  const secret = "s3cr3t-value";
  const forms = [
    ["--k=v", ["--k=" + secret], "--k=***"],
    ["--k v", ["--k", secret], "--k=***"],
    ["--k -v", ["--k", "-" + secret], "--k=***"],
    ["-kV", ["-k" + secret], "-k=***"],
    ["-k V", ["-k", secret], "-k=***"],
    ["env NAME=v", ["/usr/bin/env", "NAME=" + secret, "claude"], "NAME=***"],
    ["--proxy URL userinfo", ["--proxy", "http://user:token@proxy.example:8080"], "--proxy=***"],
    ["--proxy=URL userinfo", ["--proxy=http://user:token@proxy.example:8080"], "--proxy=***"],
  ];
  for (const [form, words, want] of forms) {
    const line = launchChange({ name: "Genie", launch: { argv: ["claude", ...words] }, agent: "claude", argv: ["claude"] });
    assert.ok(line, form);
    assert.ok(line.includes(want), `${form}: ${line}`);
    for (const raw of [secret, "user:token", "proxy.example"]) assert.equal(line.includes(raw), false, `${form}: ${raw} in ${line}`);
  }
  // The names it prints still name the flags that differ.
  assert.match(launchChange({ name: "Genie", launch: { argv: ["claude", "--k", "-" + secret] }, agent: "claude", argv: ["claude"] }), /drops --k=\*\*\*/);
  assert.match(launchChange({ name: "Genie", launch: { argv: ["claude", "-k" + secret] }, agent: "claude", argv: ["claude"] }), /drops -k=\*\*\*/);
});

test("launchChange masks a value in value position whatever it looks like (D1 fail-closed)", () => {
  const name = "Genie";
  const line = (words) => launchChange({ name, launch: { argv: ["omp", ...words] }, agent: "omp", argv: ["omp"] });
  // The lead's row: a proxy whose value looks like a long flag.
  const proxy = line(["--proxy", "--s3cr3t-value"]);
  assert.ok(proxy.includes("drops --proxy=***"), proxy);
  assert.equal(proxy.includes("--s3cr3t-value"), false, proxy);
  // A repeated value-taking flag: neither value prints.
  const twice = line(["--proxy", "first-secret", "--proxy", "second-secret"]);
  assert.ok(twice.includes("--proxy=***"), twice);
  for (const raw of ["first-secret", "second-secret"]) assert.equal(twice.includes(raw), false, twice);
  // An unknown flag followed by a token that looks like a flag: the token is its value.
  const unknown = line(["--mystery", "--token"]);
  assert.ok(unknown.includes("drops --mystery=***"), unknown);
  assert.equal(unknown.includes("--token"), false, unknown);
  // A known boolean keeps the flag after it: --tui --proxy=... still names the proxy.
  const known = launchChange({ name, launch: { argv: ["hermes", "--tui", "--proxy=http://user:token@proxy.example:8080"] },
    agent: "hermes", argv: ["hermes", "--tui"] });
  assert.ok(known.includes("drops --proxy=***"), known);
  assert.equal(known.includes("--tui"), false, known);
});

test("restartRefusal --tree: helpers that end with the pane don't refuse, mid-turn or not (waited for); without it the refusal names --tree and --force", () => {
  const idle = { address: "t5", status: { state: "idle" } };
  const helper = { address: "t7", state: "live", die_with_parent: true, status: { state: "idle" } };
  const without = restartRefusal({ name: "Genie", old: idle, helpers: [helper] });
  assert.match(without, /pass --tree to restart it too \(resumed, under the new pane\), or pass --force to end it with the pane\./);
  assert.equal(restartAnswer({ code: 1, err: without }).helpers, true, "the sidebar offers both explicit helper choices");
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: [helper], tree: true }), null);
  const busy = { ...helper, status: { state: "working" } };
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: [busy], tree: true }), null, "--tree waits for it before anything starts (the CLI)");
  assert.equal(restartRefusal({ name: "Genie", old: idle, helpers: [busy], tree: true, force: true }), null);
});

test("helperPlan: a worker rebuilt from its ledger row (its task not sent again), a template's command, anything else's own; resumed in its folder", () => {
  const get = { address: "t7", name: "fix-dev", cwd: "/w", foreground: { argv: ["bun", "/b/omp", "--model=k", "--thinking=high", "the task"], cwd: "/w/sub" },
    labels: { "worker.of": "b-1", "agent.session": SID }, argv: ["/usr/bin/env", "PATH=/x", "omp", "--model=k", "--thinking=high", "the task"] };
  const worker = { agent: "omp", model: "k", effort: "high", template: null };
  const w = helperPlan({ get, worker, session: SID, agents: AGENTS });
  assert.deepEqual([w.name, w.replaced, w.cwd, w.agent, w.mode, w.session], ["fix-dev", "t7", "/w", "omp", "resume", SID]);
  assert.deepEqual(w.argv, ["omp", "--model=k", "--thinking=high", `--resume=${SID}`]);
  const tpl = helperPlan({ get: { address: "t8", cwd: "/r", foreground: { argv: ["codex", "-m", "g"] }, argv: ["sh", "-c", "codex -m g"], template: "rev" }, agents: AGENTS });
  // #1125: an hc template's pane that is no template worker keeps its command, with the launch-mode words after it.
  assert.deepEqual(tpl.argv, ["sh", "-c", 'codex -m g "$@"', "sh", "--approve-for-me", "--disable", "hooks", "--no-daemon", "-c", "sandbox_workspace_write.network_access=true", "resume", "--last"]);
  const hand = helperPlan({ get: { address: "t9", cwd: "/h", foreground: { argv: ["claude", "--model", "m"] }, argv: ["claude", "--model", "m", "--continue"] }, agents: AGENTS });
  assert.deepEqual(hand.argv, ["claude", "--model", "m", "--continue"]);
  const none = helperPlan({ get: { address: "t10", cwd: "/h", foreground: { argv: ["claude"] } }, agents: AGENTS });
  assert.match(none.error, /t10 can't be run again: hc gave no command this pack can reuse/);
  const plain = helperPlan({ get: { address: "t11", cwd: "/h", foreground: { argv: ["amp"] }, argv: ["amp"] }, agents: AGENTS });
  assert.deepEqual([plain.mode, plain.argv, plain.note], ["fresh", ["amp"], "amp has no resume this pack knows"]);
  // An Antigravity worker runs again with its mode: the label it was started with, else auto.
  const agyWorker = { agent: "antigravity", model: null, effort: null, template: null };
  const agy = helperPlan({ get: { address: "t12", cwd: "/w", labels: { "worker.of": "b-1", "worker.agyMode": "plan" },
    foreground: { argv: ["agy"] } }, worker: agyWorker, agents: AGENTS });
  assert.deepEqual(agy.argv, ["agy", "--mode", "plan", "--continue"]);
  const agyAuto = helperPlan({ get: { address: "t13", cwd: "/w", labels: { "worker.of": "b-1" },
    foreground: { argv: ["agy"] } }, worker: agyWorker, agents: AGENTS });
  assert.deepEqual(agyAuto.argv, ["agy", "--mode", "auto", "--continue"]);
  const agyBad = helperPlan({ get: { address: "t14", cwd: "/w", labels: { "worker.of": "b-1", "worker.agyMode": "yolo" },
    foreground: { argv: ["agy"] } }, worker: agyWorker, agents: AGENTS });
  assert.match(agyBad.error, /can't be run again: Antigravity mode "yolo" isn't one of accept-edits, auto, plan\./);
  assert.deepEqual(helperArgs({ name: "fix-dev", cwd: "/w", labels: { a: "1", gone: "" }, parent: "t100", argv: ["omp"], path: "/p" }),
    ["run", "--bg", "--json", "--name", "fix-dev", "--cwd", "/w", "--label", "a=1", "--parent", "t100", "--", "/usr/bin/env", "PATH=/p", "omp"]);
});

test("sharedFolders: an id-less resume sharing a folder and agent with another run (bot or helper, resumed or fresh) is named; one alone, or every one with an id, isn't", () => {
  const six = ["t2p9", "t2pf", "t2ph", "t2pj", "t2pk", "t2pp"].map((who) => ({ who, agent: "codex", cwd: "/w/integration", session: null, mode: "resume" }));
  const bot = { who: "Genie", agent: "claude", cwd: "/w", session: null, mode: "resume" };
  assert.deepEqual(sharedFolders([bot, ...six]), [{ agent: "codex", cwd: "/w/integration", who: six.map((r) => r.who), idless: six.map((r) => r.who) }]);
  assert.deepEqual(sharedFolders([bot, ...six.map((r, n) => ({ ...r, session: `0f3c2a4e-1b2d-4c5e-9f60-71829300000${n}` }))]), [], "each with its own id");
  const fresh = { who: "Captain", agent: "codex", cwd: "/w/integration", session: null, mode: "fresh" };
  assert.deepEqual(sharedFolders([fresh, six[0]]).map((g) => [g.who, g.idless]), [[["Captain", "t2p9"], ["t2p9"]]], "a fresh run there makes the newest conversation");
  assert.deepEqual(sharedFolders([bot, six[0]]), []);
});

test("paneSession: the agent.session label, else revive.session when revive.agent names the agent (or is unset); never a non-id", () => {
  assert.equal(paneSession({ labels: { "agent.session": SID, "revive.session": SID2 } }, "codex"), SID);
  assert.equal(paneSession({ labels: { "revive.agent": "codex", "revive.session": SID2 } }, "codex"), SID2);
  assert.equal(paneSession({ labels: { "revive.session": SID2 } }, "omp"), SID2);
  assert.equal(paneSession({ labels: { "revive.agent": "claude", "revive.session": SID2 } }, "codex"), null, "another agent's session");
  assert.equal(paneSession({ labels: { "revive.session": "-rf" } }, "codex"), null);
});

test("commandArgv: no \"$@\" after a command ending in a separator or a comment (null), none twice; withoutPrompt drops a trailing first prompt only", () => {
  assert.equal(takesWords("omp --x"), true);
  for (const c of ["omp --x;", "a && b &", "omp |", "omp --x # pinned", `omp "a" # b`, "omp 'x';"]) assert.equal(commandArgv({ shell: c }, ["--continue"]), null, c);
  // Quoted text is an argument, never a comment or a separator (#453 review, Low 1).
  for (const c of [`claude --append-system-prompt "work on issue #12"`, "omp --x 'a; b|'", `omp "it's #1"`, "omp a\\;", "omp \\#x"]) {
    assert.deepEqual(commandArgv({ shell: c }, ["--continue"]), ["sh", "-c", `${c} "$@"`, "sh", "--continue"], c);
  }
  assert.deepEqual(commandArgv({ shell: 'omp --x "$@"' }, ["--continue"]), ["sh", "-c", 'omp --x "$@"', "sh", "--continue"], "its own \"$@\" takes them");
  assert.deepEqual(commandArgv({ shell: "omp;" }), ["sh", "-c", "omp;"], "no words: as it was");
  assert.deepEqual(withoutPrompt(["omp", "--model=k", "fix the login bug"]), ["omp", "--model=k"]);
  assert.deepEqual(withoutPrompt(["codex", "-c", "a=b c"]), ["codex", "-c", "a=b c"], "an option's value stays");
  assert.deepEqual(withoutPrompt(["omp", "task"]), ["omp", "task"], "a one-word prompt can't be told from an argument");
  const tpl = restartPlan({ bot: { agent: "omp" }, run: ["omp"], runningAgent: "omp", launch: { shell: "omp --x # note" } });
  assert.deepEqual([tpl.mode, tpl.argv, tpl.note], ["resume", ["omp", "--continue"], null], "a bot's restart never runs the pane's shell command (#597)");
});

test("helperPlan: the worker's worktree first, then the pane's folder, then its program's; fresh when asked, with the reason", () => {
  const get = { address: "t7", cwd: "/pane", foreground: { argv: ["omp"], cwd: "/pane/sub" }, labels: { "worker.of": "b-1" } };
  assert.equal(helperPlan({ get, worker: { agent: "omp", worktree: "/wt" }, agents: AGENTS }).cwd, "/wt");
  assert.equal(helperPlan({ get, agents: AGENTS }).cwd, "/pane");
  assert.equal(helperPlan({ get: { ...get, cwd: undefined }, agents: AGENTS }).cwd, "/pane/sub");
  const fresh = helperPlan({ get, worker: { agent: "omp" }, agents: AGENTS, fresh: "shared folder" });
  assert.deepEqual([fresh.mode, fresh.argv, fresh.note], ["fresh", ["omp"], "shared folder"]);
});

test("sameSessions: a session id two runs would resume is named with both; distinct ids and id-less runs aren't", () => {
  assert.deepEqual(sameSessions([{ who: "Genie", session: SID }, { who: "rev-1", session: SID }, { who: "dev", session: SID2 }, { who: "x", session: null }]),
    [{ session: SID, who: ["Genie", "rev-1"] }]);
  assert.deepEqual(sameSessions([{ who: "a", session: SID }, { who: "b", session: SID2 }, { who: "c", session: null }, { who: "d", session: null }]), []);
});

test("restartPlan: Hermes resumes a known session by id (--resume), as Claude does; a bad label falls back to --continue", () => {
  const bot = { agent: "hermes" };
  const run = ["hermes", "--tui"];
  const byId = restartPlan({ bot, run, runningAgent: "hermes", session: "atlas-sess-1" });
  assert.deepEqual(byId.argv, ["hermes", "--tui", "--resume", "atlas-sess-1"]);
  for (const bad of [null, "-x", "has space", ""]) {
    assert.deepEqual(restartPlan({ bot, run, runningAgent: "hermes", session: bad }).argv, ["hermes", "--tui", "--continue"], String(bad));
  }
  // Claude keeps its UUID rule: a word isn't a Claude session id.
  assert.deepEqual(restartPlan({ bot: { agent: "claude" }, run: ["claude"], runningAgent: "claude", session: "atlas-sess-1" }).resume, ["--continue"]);
});

test("claudeSlug: the path with every non-alphanumeric character as -, so automagik-herdr and automagik/herdr share one", () => {
  assert.equal(claudeSlug("/Users/me/workspace/repos/automagik-herdr"), "-Users-me-workspace-repos-automagik-herdr");
  assert.equal(claudeSlug("/Users/me/workspace/repos/automagik-herdr"), claudeSlug("/Users/me/workspace/repos/automagik/herdr"));
  assert.equal(claudeSlug("/a/.claude/worktrees/x_y"), "-a--claude-worktrees-x-y");
  assert.notEqual(claudeSlug("/a/b"), claudeSlug("/a/c"));
});


test("#805 shared idle: a working background shell at an empty prompt is idle", async () => {
  const { isPaneIdle, pendingDialog, hasAgentPrompt, hasBackgroundShellAtIdlePrompt, isPromptLine } = await import("../mods/am-sidebar/restart.js");
  const old = { address: "t5", state: "live", status: { state: "working" } };
  const idle = { address: "t5", state: "live", status: { state: "idle" } };
  const screen = "1 background task\n❯ ";
  assert.equal(typeof isPaneIdle, "function");
  assert.equal(isPaneIdle(old, screen), true);
  assert.equal(restartRefusal({ name: "Genie", old, screen }), null);
  assert.equal(hasBackgroundShellAtIdlePrompt("1 background task\n❯ do work"), false);
  // H1: a mid-turn spinner or interrupt hint is not idle, background task or not.
  for (const mid of ["1 background task\nesc to interrupt\n❯ ", "1 background task\nctrl+b to run in background\n❯ ",
    "1 background task\nworking (42s)\n❯ ", "1 background task\nrunning (12s)\n❯ "]) {
    assert.equal(hasBackgroundShellAtIdlePrompt(mid), false, mid);
    assert.equal(hasAgentPrompt(mid), false, mid);
    assert.equal(isPaneIdle(old, mid), false, mid);
  }
  assert.equal(hasBackgroundShellAtIdlePrompt("ctrl+b to run in background\n❯ "), false);
  for (const text of ["Run this command?", "Do you want to proceed?", "Allow this action?", "Requesting permission for: command", "1/2 answered (select)", "Choose a colour?\n> 1. Yes\n2. No\nEnter to confirm"]) {
    assert.equal(pendingDialog(text).who, "the owner", text);
    assert.ok(pendingDialog(text).question.length <= 200);
    assert.equal(isPaneIdle(old, text), false);
  }
  // H3: prose and ordinary numbered lists above an active prompt are scrollback, not a dialog.
  for (const text of ["Do you want to merge it now?", "Should I allow the deploy?"]) {
    assert.equal(pendingDialog(`${text}\n\n❯ `), null, text);
    assert.equal(isPaneIdle(idle, `${text}\n\n❯ `), true, text);
  }
  const numbered = "Completed steps:\n1. Read files\n2. Run tests\n❯ ";
  assert.equal(pendingDialog(numbered), null);
  assert.equal(isPaneIdle(idle, numbered), true);
  // M1: framed and placeholder prompts count as the agent's prompt when idle.
  for (const text of ["│ > │", "⌸ ❯ … ⛶", "│ Type a message... │", "› Ask Codex to do anything"]) {
    assert.equal(isPromptLine(text), true, text);
    assert.equal(pendingDialog(text), null, text);
    assert.equal(hasAgentPrompt(text), true, text);
    assert.equal(isPaneIdle(idle, text), true, text);
  }
  for (const state of ["idle", "done"]) {
    assert.equal(isPaneIdle({ state: "live", status: { state } }, "❯ "), true);
    assert.equal(isPaneIdle({ state: "live", status: { state } }, "still thinking"), false);
  }
  assert.equal(isPaneIdle({ ...old, state: "finished" }, screen), false);
  assert.equal(isPaneIdle({ ...old, status: { state: "blocked" } }, screen), false);
  assert.equal(isPaneIdle(null), false);
  for (const text of [null, undefined, "", "❯ ", "user@host $ "]) assert.equal(hasAgentPrompt(text), true);
  assert.equal(pendingDialog("old output\n❯ "), null);
  assert.equal(pendingDialog("Completed steps:\n1. Read files\n2. Run tests\n❯ "), null);
  assert.equal(pendingDialog("Are you sure?\n[y/n]").question, "Are you sure?");
});

test("#805 sidebar understands a queued restart", () => {
  assert.deepEqual(restartAnswer({ code: 0, out: { queued: true, terminal: "t5", reason: "working" } }),
    { terminal: "t5", replaced: null, queued: true, reason: "working", dialog: null, warnings: [] });
});

test("#805 H1: a spinner above 10 todo lines is still mid-turn", async () => {
  const { isPaneIdle, hasAgentPrompt, hasBackgroundShellAtIdlePrompt } = await import("../mods/am-sidebar/restart.js");
  const todos = Array.from({ length: 10 }, (_, i) => `  ⎿ todo ${i + 1}`);
  const screen = ["Thinking… (5s · esc to interrupt)", ...todos, "────────", "❯ ", "────────", "  1 background task"].join("\n");
  const old = { address: "t5", state: "live", status: { state: "working" } };
  assert.equal(hasAgentPrompt(screen), false);
  assert.equal(hasBackgroundShellAtIdlePrompt(screen), false);
  assert.equal(isPaneIdle(old, screen), false);
  const working = screen.replace("Thinking… (5s · esc to interrupt)", "Working… (5s · esc to interrupt)");
  assert.equal(hasAgentPrompt(working), false);
  assert.equal(isPaneIdle(old, working), false);
  // Low A: prose with parentheses is not a turn timer.
  assert.equal(hasAgentPrompt("I am working (3 files left) on it\n❯ "), true);
});

test("#805 H3: real Claude and Codex footers keep reply text above the prompt as scrollback", async () => {
  const { pendingDialog, isPaneIdle } = await import("../mods/am-sidebar/restart.js");
  const idle = { address: "t5", state: "live", status: { state: "idle" } };
  const replies = ["Do you want to create the PR now?", "Do you want to run the full gate?", "Allow the push to dev?",
    "Do you want to proceed?", "Do you want to proceed with the merge?", "Merge now?\n1. Yes\n2. No\nEnter to confirm",
    "Which should I do?\n1. Skip\n2. Proceed"];
  for (const [name, prompt] of [["claude-idle.txt", '❯ Try "how does <filepath> work?"'], ["codex-idle.txt", "› Ask Codex to do anything"]]) {
    const fixture = screenFixture(name);
    assert.ok(fixture.includes(prompt), name);
    for (const reply of replies) {
      const screen = fixture.replace(prompt, `${reply}\n\n${prompt}`);
      assert.equal(pendingDialog(screen), null, `${name}: ${reply}`);
      assert.equal(isPaneIdle(idle, screen), true, `${name}: ${reply}`);
    }
  }
  const dialog = screenFixture("claude-dialog.txt");
  assert.equal(pendingDialog(dialog)?.question, "Do you want to proceed?");
  assert.equal(isPaneIdle(idle, dialog), false);
});

test("#805 M1: an omp ╰─ prompt is an idle prompt", async () => {
  const { isPromptLine, hasAgentPrompt, pendingDialog, isPaneIdle } = await import("../mods/am-sidebar/restart.js");
  const omp = screenFixture("omp-idle.txt");
  assert.equal(isPromptLine("╰─"), true);
  assert.equal(isPromptLine("╰─ half typed words"), true);
  assert.equal(isPromptLine("╰─── Wall: 0.02s · Timeout: 60s ────────────"), false);
  assert.equal(pendingDialog(omp), null);
  assert.equal(hasAgentPrompt(omp), true);
  assert.equal(isPaneIdle({ address: "t5", state: "live", status: { state: "idle" } }, omp), true);
});

test("#805 H3: a markdown list above an idle prompt with many footers is not a dialog", async () => {
  const { pendingDialog, isPaneIdle } = await import("../mods/am-sidebar/restart.js");
  const screen = ["Which option?", "1. First item", "2. Second item", '❯ Try "how does <filepath> work?"',
    "  footer one", "  footer two", "  footer three", "  footer four", "  footer five", "  footer six"].join("\n");
  assert.equal(pendingDialog(screen), null);
  assert.equal(isPaneIdle({ address: "t5", state: "live", status: { state: "idle" } }, screen), true);
});

test("a tree restart with one failed helper reports the new lead and warning without offering another restart", () => {
  const r = restartAnswer({ code: 1, out: { terminal: "t100", replaced: "t5", helpers: [
    { replaced: "t7", name: "review", error: "hc run failed\n    at start (cli.js:1:1)" },
  ] }, err: "a helper failed" });
  assert.equal(r.terminal, "t100");
  assert.equal(r.refused, undefined);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /review: hc run failed/);
  assert.doesNotMatch(r.warnings[0], /\n|cli.js/);
});
