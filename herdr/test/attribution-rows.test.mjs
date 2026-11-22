// RFC 0021 delivery 3: the workers-ledger rows meter attribution needs, over plain data. Squad
// (model.js squadOf), the start, session and end rows (workers.js), the sweep's end rows, the
// session id a fresh Claude launch gets (models.js, restart.js) and what output shows of it.
// Session ids here are synthetic. Apache-2.0.
import { test } from "node:test";
import assert from "node:assert/strict";

import { squadOf } from "../mods/am-sidebar/model.js";
import { END_REASONS, endRow, finishedEnds, launchKey, readLedger, reapCandidates, sessionRow, startRow, workerArgs }
  from "../mods/am-sidebar/workers.js";
import { choosesSession, ownsSession, sessionIdArgs, withoutResume } from "../mods/am-sidebar/models.js";
import { SESSION_MASK, ledgerSession, maskedArgv, planText, restartPlan } from "../mods/am-sidebar/restart.js";

const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", solo: "b-dddddddddd", deep: "b-ffffffffff", plan: "b-eeeeeeeeee" };
const SID = "00000000-0000-4000-8000-000000000001";
const SID2 = "00000000-0000-4000-8000-000000000002";
const GEN1 = "11111111-1111-4111-8111-111111111111";
const bot = (id, kind, extra = {}) => ({ id, kind, name: id, agent: "claude", ...extra });
const file = (bots) => ({ version: 1, categories: [], bots });

// ---- squad (RFC 0021 (e)): the head of the lead chain, frozen at launch ----

test("squadOf: a bot that reports to the main bot and leads no one is its own squad", () => {
  const f = file([bot(ID.main, "main"), bot(ID.solo, "member")]);
  assert.equal(squadOf(f, ID.solo), ID.solo);
});

test("squadOf: a captain is its own squad; its members, at any depth, are its squad; the main bot heads none", () => {
  const f = file([bot(ID.main, "main"), bot(ID.cap, "member", { lead: ID.main }), bot(ID.dev, "member", { lead: ID.cap }),
    bot(ID.deep, "member", { lead: ID.dev })]);
  assert.equal(squadOf(f, ID.cap), ID.cap);
  assert.equal(squadOf(f, ID.dev), ID.cap, "the head of the chain, not the direct lead");
  assert.equal(squadOf(f, ID.deep), ID.cap, "the head of the chain, not the direct lead");
  assert.equal(squadOf(f, ID.main), null);
  assert.equal(squadOf(f, "b-zzzzzzzzzz"), null, "an unknown bot");
  assert.equal(squadOf(file([bot(ID.dev, "member")]), ID.dev), null, "no main bot");
});

test("squadOf: a chain with a loop or a missing or planned lead gives null, never a guess", () => {
  const loop = file([bot(ID.main, "main"), bot(ID.cap, "member", { lead: ID.dev }), bot(ID.dev, "member", { lead: ID.cap })]);
  assert.equal(squadOf(loop, ID.cap), null);
  assert.equal(squadOf(loop, ID.dev), null);
  const above = file([bot(ID.main, "main"), bot(ID.cap, "member", { lead: ID.dev }), bot(ID.dev, "member", { lead: ID.cap }),
    bot(ID.deep, "member", { lead: ID.cap })]);
  assert.equal(squadOf(above, ID.deep), null, "a loop further up the chain");
  const missing = file([bot(ID.main, "main"), bot(ID.dev, "member", { lead: "b-zzzzzzzzzz" })]);
  assert.equal(squadOf(missing, ID.dev), null);
  const missingAbove = file([bot(ID.main, "main"), bot(ID.cap, "member", { lead: "b-zzzzzzzzzz" }), bot(ID.dev, "member", { lead: ID.cap })]);
  assert.equal(squadOf(missingAbove, ID.dev), null, "a missing lead further up");
  const planned = file([bot(ID.main, "main"), bot(ID.plan, "member", { planned: { wave: 2 } }), bot(ID.dev, "member", { lead: ID.plan })]);
  assert.equal(squadOf(planned, ID.dev), null);
});

test("squadOf is frozen in the row: a start row keeps the squad it was written with", () => {
  const before = file([bot(ID.main, "main"), bot(ID.cap, "member"), bot(ID.dev, "member", { lead: ID.cap })]);
  const row = readLedger(JSON.stringify(startRow({ kind: "worker", terminal: "t9", botId: ID.dev, squad: squadOf(before, ID.dev) })))[0];
  const after = file([bot(ID.main, "main"), bot(ID.cap, "member"), bot(ID.dev, "member")]); // Dev moved under the main bot
  assert.equal(squadOf(after, ID.dev), ID.dev);
  assert.equal(row.squad, ID.cap);
});

// ---- the rows ----

test("startRow: core, created_ms, squad, session, generation and sequence, null when not given; an old row still reads", () => {
  const row = startRow({ kind: "seat", terminal: "t5", botId: ID.cap, role: "captain", lead: ID.main, squad: ID.cap, core: "core-1",
    createdMs: 1234, session: SID, generation: GEN1, sequence: 5, at: 0 });
  assert.deepEqual([row.core, row.created_ms, row.role, row.lead, row.squad, row.session, row.generation, row.sequence],
    ["core-1", 1234, "captain", ID.main, ID.cap, SID, GEN1, 5]);
  const bare = startRow({ kind: "seat", terminal: "t5", botId: ID.cap, createdMs: "1234" });
  assert.deepEqual([bare.core, bare.created_ms, bare.squad, bare.session, bare.role, bare.lead, bare.generation, bare.sequence],
    [null, null, null, null, null, null, null, null]);
  // An old row written before RFC 0021 has none of the new fields: it reads as it was.
  const old = readLedger('{"event":"start","kind":"worker","terminal":"t3","botId":"b-cccccccccc"}\n')[0];
  assert.equal(launchKey(old), null);
});

test("sessionRow: the harness, core and created_ms when known; Claude's rows look as the hook's always did", () => {
  assert.deepEqual({ ...sessionRow({ terminal: "t5", session: SID, at: 0 }) }, { event: "session", terminal: "t5", session: SID, transcript: null, at: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual(sessionRow({ terminal: "t5", session: "c-1", agent: "codex", core: "core-1", createdMs: 7, at: 0 }),
    { event: "session", terminal: "t5", session: "c-1", transcript: null, agent: "codex", core: "core-1", created_ms: 7, at: "1970-01-01T00:00:00.000Z" });
});

test("endRow: the launch key, its kind, why and when", () => {
  assert.deepEqual(endRow({ kind: "seat", terminal: "t5", core: "core-1", createdMs: 9, reason: "replaced", at: 0 }),
    { event: "end", kind: "seat", terminal: "t5", core: "core-1", created_ms: 9, reason: "replaced", at: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual(END_REASONS, ["replaced", "finished"]);
  assert.equal(launchKey(endRow({ terminal: "t5", core: "core-1", createdMs: 9, reason: "replaced" })), "core-1\nt5\n9");
});

// ---- reapCandidates reads start rows only ----

const created = (terminal, worktree, extra = {}) => startRow({ kind: "worker", terminal, botId: ID.dev, worktree, branch: "fix/a", project: "/p",
  created: true, at: 1000, ...extra });

test("reapCandidates gives the same answer on a ledger holding end and session rows", () => {
  const base = [created("t1", "/p/.claude/worktrees/a", { core: "core-1", createdMs: 10 }),
    startRow({ kind: "worker", terminal: "t2", botId: ID.dev, worktree: "/p/.claude/worktrees/a", created: false, at: 2000 }),
    created("t3", "/p/.claude/worktrees/b", { core: "core-1", createdMs: 30 })];
  const reaps = [{ worktree: "/p/.claude/worktrees/b", result: "kept", why: "uncommitted changes", at: "1970-01-01T00:00:05.000Z" }];
  const withEnds = [base[0], endRow({ kind: "worker", terminal: "t1", core: "core-1", createdMs: 10, reason: "finished", at: 1500 }),
    base[1], sessionRow({ terminal: "t2", session: SID, agent: "claude", core: "core-1", createdMs: 20 }), base[2],
    endRow({ kind: "worker", terminal: "t3", core: "core-1", createdMs: 30, reason: "replaced" })];
  assert.deepEqual(reapCandidates(withEnds, reaps), reapCandidates(base, reaps));
  assert.equal(reapCandidates(base, reaps).length, 2);
});

test("reapCandidates: an old row without the new fields still reaps", () => {
  const old = readLedger('{"event":"start","kind":"worker","terminal":"t3","botId":"b-cccccccccc","task":"fix/x","worktree":"/p/w","created":true,"at":"1970-01-01T00:00:01.000Z"}\n');
  assert.deepEqual(reapCandidates(old), [{ worktree: "/p/w", project: null, branch: "fix/x", terminals: ["t3"], last: null }]);
});

// ---- the sweep's end rows ----

test("finishedEnds: a finished worker launch of this core gets one end row; a reused id, an old row, a seat, another core don't", () => {
  const rows = [
    created("t1", "/w1", { core: "core-1", createdMs: 10 }),
    created("t2", "/w2", { core: "core-1", createdMs: 20 }), // t2's id reused since: another terminal now
    created("t3", "/w3"), // written before RFC 0021: no key
    startRow({ kind: "seat", terminal: "t4", botId: ID.cap, core: "core-1", createdMs: 40 }),
    created("t5", "/w5", { core: "core-2", createdMs: 50 }),
    created("t6", "/w6", { core: "core-1", createdMs: 60 }), // still live
    created("t7", "/w7", { core: "core-1", createdMs: 70 }),
    endRow({ kind: "worker", terminal: "t7", core: "core-1", createdMs: 70, reason: "replaced" }),
  ];
  const gets = new Map([
    ["t1", { created_ms: 10, finished_ms: 15 }], ["t2", { created_ms: 99, finished_ms: 100 }], ["t3", { created_ms: 30, finished_ms: 35 }],
    ["t4", { created_ms: 40, finished_ms: 45 }], ["t5", { created_ms: 50, finished_ms: 55 }], ["t6", { created_ms: 60 }],
    ["t7", { created_ms: 70, finished_ms: 75 }],
  ]);
  const ends = finishedEnds(rows, gets, "core-1");
  assert.deepEqual(ends.map((r) => [r.event, r.kind, r.terminal, r.core, r.created_ms, r.reason, r.at]),
    [["end", "worker", "t1", "core-1", 10, "finished", "1970-01-01T00:00:00.015Z"]]);
  assert.deepEqual(finishedEnds([...rows, ...ends], gets, "core-1"), [], "once");
});

// ---- the session id a fresh Claude launch gets (RFC 0021 (f) 2) ----

test("sessionIdArgs and ownsSession: Claude only; a command's own resume, continue or session id wins", () => {
  assert.equal(choosesSession("claude"), true);
  assert.equal(choosesSession("codex"), false);
  assert.deepEqual(sessionIdArgs("claude", SID), ["--session-id", SID]);
  assert.deepEqual(sessionIdArgs("codex", SID), []);
  assert.deepEqual(sessionIdArgs("claude", null), []);
  for (const argv of [["claude", "--resume", SID], ["claude", "-r", SID], ["claude", "--continue"], ["claude", "-c"], ["claude", `--session-id=${SID}`],
    ["claude", "--session-id", SID], ["claude", "--fork-session"]]) assert.equal(ownsSession(argv), true, argv.join(" "));
  assert.equal(ownsSession(["claude", "--model", "opus"]), false);
  assert.equal(ownsSession('claude --resume "$X" "$@"'), true, "a template command's words");
  assert.equal(ownsSession("claude --model opus"), false);
  // A reused command line drops an earlier --session-id, as it drops resume words.
  assert.deepEqual(withoutResume("claude", ["claude", "--session-id", SID, "--model", "opus"]), ["claude", "--model", "opus"]);
});

test("restartPlan: a fresh or swap Claude plan starts on the new id; a resume keeps its own and gets none", () => {
  const claude = { agent: "claude", model: "claude-opus-5-5" };
  const fresh = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", fresh: true, newSession: SID });
  assert.deepEqual([fresh.mode, fresh.argv, fresh.sessionId, fresh.resume], ["fresh", ["claude", "--session-id", SID, "--model", "claude-opus-5-5"], SID, []]);
  const resume = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", session: SID2, newSession: SID });
  assert.deepEqual([resume.mode, resume.argv, resume.sessionId], ["resume", ["claude", "--resume", SID2, "--model", "claude-opus-5-5"], null]);
  const cont = restartPlan({ bot: claude, run: ["claude"], runningAgent: "claude", newSession: SID });
  assert.deepEqual([cont.mode, cont.argv.includes("--session-id"), cont.sessionId], ["resume", false, null], "--continue keeps its session");
  const swapIn = restartPlan({ bot: { agent: "codex" }, run: ["claude"], agent: "claude", newSession: SID });
  assert.deepEqual([swapIn.mode, swapIn.sessionId, swapIn.argv], ["swap", SID, ["claude", "--session-id", SID]]);
  const swapOut = restartPlan({ bot: claude, run: ["codex"], agent: "codex", newSession: SID });
  assert.deepEqual([swapOut.sessionId, swapOut.argv.includes("--session-id")], [null, false]);
  const other = restartPlan({ bot: { agent: "codex" }, run: ["codex"], runningAgent: "codex", fresh: true, newSession: SID });
  assert.deepEqual([other.sessionId, other.argv], [null, ["codex"]]);
  // The person's own session words win: none added.
  const own = restartPlan({ bot: { agent: "claude" }, run: ["claude", "--session-id", SID2], runningAgent: "claude", fresh: true, newSession: SID });
  assert.deepEqual([own.sessionId, own.argv], [null, ["claude", "--session-id", SID2]]);
  // No id chosen: as before.
  assert.equal(restartPlan({ bot: claude, run: ["claude"], fresh: true }).sessionId, null);
});

test("restartPlan: a Claude template takes the new id through its \"$@\", unless it can't take words or picks its own", () => {
  const bot = { agent: "claude" };
  const tpl = (command) => restartPlan({ bot, run: ["claude"], runningAgent: "claude", fresh: true, newSession: SID, template: { name: "t", command } });
  assert.deepEqual([tpl("claude --model opus").argv, tpl("claude --model opus").sessionId], [["sh", "-c", 'claude --model opus "$@"', "sh", "--session-id", SID], SID]);
  assert.deepEqual([tpl("claude --model opus;").argv, tpl("claude --model opus;").sessionId], [["sh", "-c", "claude --model opus;"], null]);
  assert.equal(tpl("claude --continue").sessionId, null);
});

test("workerArgs: a new Claude worker's session id is its agent.session label, its argv the caller's", () => {
  const args = workerArgs({ botId: ID.dev, branch: "fix/a", role: "dev", name: "w", cwd: "/w", parent: "t1", agent: "claude",
    argv: ["claude", "--session-id", SID], task: "do it", path: "/bin", session: SID });
  assert.ok(args.includes(`agent.session=${SID}`));
  assert.deepEqual(args.slice(args.indexOf("--") + 3), ["claude", "--session-id", SID, "do it"]);
  const none = workerArgs({ botId: ID.dev, branch: "fix/a", cwd: "/w", parent: "t1", agent: "codex", argv: ["codex"], task: "x", path: "/bin" });
  assert.equal(none.some((w) => w.startsWith("agent.session=")), false);
});

// ---- never shown ----

test("output masks session ids: an argv's --session-id value, a resumed id, and the restart line", () => {
  assert.deepEqual(maskedArgv(["claude", "--session-id", SID, "--model", "m"]), ["claude", "--session-id", SESSION_MASK, "--model", "m"]);
  assert.deepEqual(maskedArgv(["claude", `--session-id=${SID}`]), ["claude", `--session-id=${SESSION_MASK}`]);
  assert.deepEqual(maskedArgv(["codex", "resume", SID2], SID2), ["codex", "resume", SESSION_MASK]);
  assert.equal(maskedArgv(null), null);
  const plan = { mode: "resume", agent: "codex", resume: ["resume", SID2] };
  assert.equal(planText(plan, SID2).includes(SID2), false);
  assert.equal(planText({ mode: "resume", agent: "claude", resume: ["--resume", SID] }, SID).includes(SID), false);
});

// ---- restart's ledger lookup reads the start row's session ----

test("ledgerSession: a start row naming its session counts for that launch only", () => {
  const rows = [startRow({ kind: "seat", terminal: "t5", botId: ID.main, agent: "claude", core: "c", createdMs: 100, session: SID })];
  assert.deepEqual(ledgerSession(rows, "t5", "claude", 100), { session: SID, transcript: null });
  assert.equal(ledgerSession(rows, "t5", "claude", 200), null, "another launch at a reused id");
  assert.deepEqual(ledgerSession(rows, "t5", "claude"), { session: SID, transcript: null });
  assert.equal(ledgerSession(rows, "t5", "codex", 100), null);
  // A later in-pane session (the hook, after /clear) wins over the start row's.
  const later = [...rows, { ...sessionRow({ terminal: "t5", session: SID2, at: 200 }) }];
  assert.deepEqual(ledgerSession(later, "t5", "claude", 100), { session: SID2, transcript: null });
});
