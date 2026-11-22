import { startFakeCore } from "./fake-core.mjs";
// Revive (#939): the bots come back after a restart of this computer. revive.js over plain data,
// then `automagik-herdr revive` run as a program against a scratch project, a scratch home and
// app home, a fake `hc` (test/fake-hc.mjs), a fake `herdr-app` and a fake `systemctl`. No live
// Herdr, herdr-core, DSH, Antigravity or systemd is ever touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { loginFixture } from "./login-fixture.mjs";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { helperPlan } from "../mods/am-sidebar/restart.js";
import { chosenHomeWords } from "../mods/am-sidebar/agentHome.js";
import { envWords } from "../mods/am-sidebar/logins.js";
import { AGENTS } from "../mods/am-sidebar/models.js";
import { FIRST_SESSION_MS, KEEP_DOWN, PLIST_DECL, PLIST_LABEL, PLIST_MARK, UNIT_MARK, UNIT_NAME, agyCandidates, agyHistoryPath, byHandCommand, countsLine, dshHomeOf, dshSessionOf, dshSessionsDir, isBareShell, launchEnvOf, launchHomeEnv, launchdNotLoaded, ledgerRivals,
  latestResumeIn, pickSession, plistIsOurs, plistKeepsPath, plistPath, plistText, reportLine, reviveOrder, reviveTargets, sameBoot, seatHomeOf, seatHomesRecorded, sweptSince, unitIsOurs, unitPath, unitText } from "../mods/am-sidebar/revive.js";
import { firstLine as firstLineTrusted, firstLineWithIdentity, passReads } from "../mods/am-sidebar/sessionFiles.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { servicePath, unitKeepsPath } from "../mods/am-sidebar/revive.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";
import { codexCandidate, codexHomeOf, codexRolloutId, codexSessionsDir, kimiCandidates, kimiHomeOf, kimiIndexPath, uuidV7Ms } from "../mods/am-sidebar/revive.js";

// #1417: every CLI run below reads Codex's and Kimi's homes under its scratch home only.
delete process.env.CODEX_HOME;
delete process.env.KIMI_CODE_HOME;
// A host's real DSH home must not stand in for the scratch one the session cases build.
delete process.env.DSH_HOME;

const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
const SID2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SID3 = "11111111-2222-4333-8444-555555555555";
const SID4 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

// ---- revive.js, pure ----

test("isBareShell: a live pane with a shell (a login shell, the keep wrapper's, or none named) in front; never an agent or a finished pane", () => {
  const pane = (argv, state = "live") => ({ state, foreground: argv ? { argv } : undefined });
  for (const argv of [["zsh"], ["/bin/bash"], ["-zsh"], ["sh", "-i"], null, []]) assert.equal(isBareShell(pane(argv)), true, JSON.stringify(argv));
  for (const argv of [["claude"], ["dsh-tui", "-c"], ["vim", "x"], ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", "claude", "--resume", SID]]) {
    assert.equal(isBareShell(pane(argv)), false, JSON.stringify(argv));
  }
  assert.equal(isBareShell(pane(["zsh"], "finished")), false);
  assert.equal(isBareShell(null), false);
});

test("pickSession: only the pane's first session, the one born within two minutes after its start; one another terminal holds never counts", () => {
  const c = (id, born) => ({ id, born });
  const T = 10_000_000;
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 500)] }), SID);
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T - 1000)] }), SID, "two seconds of slack");
  // #992 review: a session from outside the ledger (a person's terminal, DSH Desktop), born ten
  // minutes later and written last, is never taken over the pane's own.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 5000), c(SID2, T + 600_000)] }), SID);
  // Only an outside session, born later: nothing, never that one.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID2, T + 600_000)] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + FIRST_SESSION_MS + 1)] }), null);
  // Two born in the window: they can't be told apart.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 500), c(SID2, T + 9000)] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 500), c(SID2, T + 9000)], claimed: new Set([SID]) }), SID2);
  // Born before the pane (one it resumed, or another's): not this launch's.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T - 100_000)] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [] }), null);
  assert.equal(pickSession({ createdMs: null, candidates: [c(SID, 5)] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [c("not-an-id", T + 500)] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [{ id: SID }] }), null, "no birth time");
});

test("pickSession: beside another pane or launch of that agent in the folder, nothing when it started near: right or nothing", () => {
  const c = (id, born) => ({ id, born });
  const T = 10_000_000;
  // A rival that started long before: this pane's first session, never a later one.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800), c(SID2, T + 500_000)], rivals: [{ created_ms: T - 10 * FIRST_SESSION_MS }] }), SID);
  // A rival that started around the same time (a reboot's pass starts them together): nothing.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T - 5000 }] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T + 300 }] }), null);
  // A rival that started after the session was born can't own it.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T + 60_000 }] }), SID);
  // A rival whose start time isn't known counts as near.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: null }] }), null);
});

test("ledgerRivals: the other launches of that agent in the folder not ended before this one, and the ids other launches hold", () => {
  const rows = [
    { event: "start", kind: "seat", terminal: "t1", created_ms: 100, agent: "dsh-tui", worktree: "/p" },
    { event: "end", terminal: "t1", created_ms: 100, at: new Date(500).toISOString() },
    { event: "start", kind: "seat", terminal: "t2", created_ms: 200, agent: "dsh-tui", worktree: "/p" },
    { event: "start", kind: "worker", terminal: "t3", created_ms: 300, agent: "claude", worktree: "/p", session: SID3 },
    { event: "start", kind: "seat", terminal: "t4", created_ms: 400, agent: "dsh-tui", worktree: "/elsewhere" },
    { event: "session", terminal: "t2", session: SID2, agent: "dsh-tui", created_ms: 200 },
    { event: "start", kind: "seat", terminal: "t9", created_ms: 1000, agent: "dsh-tui", worktree: "/p" },
    { event: "session", terminal: "t9", session: SID, agent: "dsh-tui", created_ms: 1000 },
  ];
  const { rivals, claimed } = ledgerRivals(rows, { terminal: "t9", createdMs: 1000, agentKey: "dsh-tui", folders: ["/p"] });
  assert.deepEqual(rivals, [{ terminal: "t2", created_ms: 200 }], "t1 ended before, t3 is Claude's, t4 is elsewhere, t9 is itself");
  assert.deepEqual([...claimed].sort(), [SID3, SID2].sort(), "its own id is not another's");
});

test("dshSessionsDir, dshSessionOf, agyCandidates: where each agent leaves its sessions", () => {
  assert.equal(dshSessionsDir("/home/u/.dsh", "/srv/team/app"), "/home/u/.dsh/sessions/--srv-team-app--");
  assert.equal(dshSessionsDir("/home/u/.dsh/", "/home/u/.dsh/bot-workspace"), "/home/u/.dsh/sessions/--home-u-.dsh-bot-workspace--");
  assert.equal(dshHomeOf("/home/u/", {}), "/home/u/.dsh");
  assert.equal(dshHomeOf("/home/u", { DSH_HOME: "/data/dsh" }), "/data/dsh", "$DSH_HOME wins");
  assert.equal(dshHomeOf("/home/u", { DSH_HOME: "relative" }), "/home/u/.dsh");
  assert.equal(dshHomeOf("/home/u", { DSH_HOME: "" }), "/home/u/.dsh");
  assert.equal(dshSessionOf(SID), SID);
  assert.equal(dshSessionOf(`session-${SID}`), SID);
  assert.equal(dshSessionOf("session.lock"), null);
  assert.equal(agyHistoryPath("/home/u"), "/home/u/.gemini/antigravity-cli/history.jsonl");
  const line = (o) => JSON.stringify(o);
  const text = [line({ display: "secret words", timestamp: 2000, workspace: "/p", conversationId: SID }),
    line({ display: "more", timestamp: 9000, workspace: "/p", conversationId: SID }),
    line({ display: "x", timestamp: 4000, workspace: "/q", conversationId: SID2 }),
    line({ display: "y", timestamp: 5000, workspace: "/p", conversationId: "nope" }), "{torn", ""].join("\n");
  const found = agyCandidates(text, ["/p"]);
  assert.deepEqual(found, [{ id: SID, born: 2000 * 1000, touched: 9000 * 1000 }], "seconds read as ms; another folder's and a bad id left out");
  assert.ok(!JSON.stringify(found).includes("secret"), "a prompt's text is never kept");
  assert.deepEqual(agyCandidates(line({ timestamp: 1794323267380, workspace: "/q", conversationId: SID2 }), ["/p", "/q"]), [{ id: SID2, born: 1794323267380, touched: 1794323267380 }]);
});

test("reviveTargets: a gone pane or a bare shell comes back; a pane with a program in front is never touched; one hc can't read is said", () => {
  const b = (bot, terminal, created_ms = 1) => ({ bot, project: "/p", terminal, created_ms });
  const live = (argv, created_ms = 1) => ({ state: "live", get: { state: "live", created_ms, foreground: { argv } } });
  const states = new Map([["t1", live(["zsh"])], ["t2", live(["claude"])], ["t3", { state: "gone" }], ["t4", { state: "finished", get: { state: "finished", created_ms: 1 } }],
    ["t5", live(["zsh"], 77)], ["t6", { state: "unknown", why: "hc get t6 failed (boom)" }]]);
  const r = reviveTargets({ bindings: [b("b-a", "t1"), b("b-b", "t2"), b("b-c", "t3"), b("b-d", "t4"), b("b-e", "t5"), b("b-f", "t6")], states,
    swept: [{ bot: "b-g", project: "/p", terminal: "t8", created_ms: 3 }, { bot: "b-a", project: "/p", terminal: "t0", created_ms: 0 }, { bot: "b-b", project: "/p", terminal: "t0", created_ms: 0 }] });
  assert.deepEqual(r.targets.map((t) => [t.bot, t.terminal, t.pane]), [["b-a", "t1", "shell"], ["b-c", "t3", "gone"], ["b-d", "t4", "gone"], ["b-e", "t5", "gone"], ["b-g", "t8", "gone"]],
    "t5's id was reused (another created_ms): gone; a swept row of a bot bound now, running or not, never adds a second");
  assert.deepEqual(r.skipped, [{ bot: "b-f", project: "/p", terminal: "t6", why: "hc get t6 failed (boom)" }]);
});

test("sweptSince: the bindings a sweep ended since the boot, their bot not bound since, this computer's only", () => {
  const row = (event, bot, terminal, at, by, extra = {}) => ({ v: 1, event, bot, project: "/p", terminal, core: "c1", created_ms: 1, machine: null, at: new Date(at).toISOString(), by, ...extra });
  const rows = [row("attach", "b-a", "t1", 100, "start"), row("end", "b-a", "t1", 5000, "sweep"),
    row("attach", "b-b", "t2", 100, "start"), row("end", "b-b", "t2", 900, "sweep"), // ended before the boot
    row("attach", "b-c", "t3", 100, "start"), row("end", "b-c", "t3", 5000, "sweep"), row("attach", "b-c", "t9", 6000, "start"), // bound again
    row("attach", "b-d", "t4", 100, "start"), row("detach", "b-d", "t4", 5000, "detach"), // a person's detach
    row("attach", "b-e", "t5", 100, "start", { core: "other" }), row("end", "b-e", "t5", 5000, "sweep", { core: "other" }),
    row("attach", "b-f", "t6", 100, "attach", { machine: "lab" }), row("end", "b-f", "t6", 5000, "sweep", { machine: "lab" })];
  assert.deepEqual(sweptSince(rows, 1000, "c1").map((r) => r.bot), ["b-a"]);
});

test("reviveOrder: the main bot first, each bot after its lead, per project", () => {
  const t = (bot, project = "/p") => ({ bot, project });
  const leads = { dev: "cap", cap: "main", solo: null, main: null };
  const order = reviveOrder([t("dev"), t("solo"), t("cap"), t("main"), t("dev", "/q")], { leadOf: (x) => leads[x.bot], isMain: (x) => x.bot === "main" });
  const at = (bot, project = "/p") => order.findIndex((x) => x.bot === bot && x.project === project);
  assert.equal(at("main"), 0);
  assert.ok(at("cap") < at("dev"), JSON.stringify(order));
  assert.equal(order.length, 5);
  assert.ok(at("dev", "/q") >= 0, "another project's dev waits for no lead that isn't coming back there");
  // A lead cycle still ends.
  assert.equal(reviveOrder([t("a"), t("b")], { leadOf: (x) => (x.bot === "a" ? "b" : "a") }).length, 2);
});

test("reportLine: one line: who resumed, who is on a new conversation and why, who isn't back and the command by hand; never a session id", () => {
  const line = reportLine("/p", [
    { name: "Genie", bot: "b-aaaaaaaaaa", outcome: "resumed", terminal: "t100", helpers: [{ name: "fix-1", outcome: "resumed" }, { name: "rev-2", outcome: "failed", why: "hc run failed" }] },
    { name: "Captain", bot: "b-bbbbbbbbbb", outcome: "fresh", terminal: "t101", why: "codex has no finished turn", helpers: [] },
    { name: "Dev", bot: "b-cccccccccc", outcome: "failed", terminal: null, why: "claude isn't installed on this computer", helpers: [] },
    { name: "Ops", bot: "b-dddddddddd", outcome: "skipped", terminal: "t9", why: "hc get t9 failed", helpers: [] },
  ]);
  assert.ok(!line.includes("\n"), "one message");
  assert.match(line, /^Revive after a restart of this computer, project \/p\./);
  assert.match(line, /Resumed where they were: Genie \(t100\)\./);
  assert.match(line, /Back on a new conversation: Captain \(t101\), codex has no finished turn\./);
  assert.match(line, /Helpers resumed: fix-1 \(under Genie\)\./);
  assert.match(line, /Helpers not back: rev-2 \(under Genie\), hc run failed\./);
  assert.ok(line.includes(`Not back: Dev, claude isn't installed on this computer; by hand: ${byHandCommand("b-cccccccccc", "/p")}.`), line);
  assert.equal(byHandCommand("b-cccccccccc", "/p"), "am restart b-cccccccccc --project /p --tree");
  assert.match(line, /Left alone: Ops, hc get t9 failed\./);
  assert.ok(line.endsWith(KEEP_DOWN), "how a bot is kept down is said every time");
  assert.match(KEEP_DOWN, /am detach <bot>/);
  assert.equal(reportLine("/p", []), null, "nothing came back and nothing failed: no report");
  // The boot pass's own line (the user journal keeps it): counts, never a folder or a name.
  const counts = countsLine([{ project: "/home/u/secret", results: [{ name: "Genie", outcome: "resumed" }, { name: "Dev", outcome: "failed" }] }, { project: "/q", results: [{ name: "Cap", outcome: "fresh" }] }]);
  assert.match(counts, /^revive: 1 resumed, 1 on a new conversation, 1 not back, 0 left alone, in 2 projects;/);
  for (const word of ["/home/u", "Genie", "Dev", "Cap", "/q"]) assert.ok(!counts.includes(word), counts);
});

test("unitText: a oneshot user unit that runs revive --boot and waits for herdr-core itself; only a unit with the pack's mark is ours", () => {
  const text = unitText({ runner: "/home/u/.local/bin/automagik-herdr", env: { HERDR_APP_HOME: "/home/u/my app/100%" }, wait: 600 });
  assert.ok(text.startsWith(`${UNIT_MARK}\n[Unit]\n`), text);
  assert.match(text, /^Type=oneshot$/m);
  assert.match(text, /^ExecStart="\/home\/u\/\.local\/bin\/automagik-herdr" revive --boot --wait 600$/m);
  assert.match(text, /^Environment="HERDR_APP_HOME=\/home\/u\/my app\/100%%"$/m, "a % is doubled for systemd");
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(text, /Restart=/, "it runs once: it never restarts itself");
  assert.match(text, /^TimeoutStartSec=infinity$/m, "systemd never ends a long pass part way: the pass bounds its own waits");
  assert.equal(unitIsOurs(text), true);
  assert.equal(unitIsOurs("[Unit]\nDescription=someone's\n"), false);
  assert.equal(unitIsOurs(null), false);
  assert.equal(unitPath("/home/u"), `/home/u/.config/systemd/user/${UNIT_NAME}`);
  assert.equal(sameBoot(1_000_000, 1_000_900), true);
  assert.equal(sameBoot(1_000_000, 1_090_000), false);
  assert.equal(sameBoot(null, 5), false);
});

test("plistText: a launchd agent that runs revive --boot at login, marked on its second line, with the kept PATH (#939, #1418)", () => {
  const text = plistText({ runner: "/Users/u/.local/bin/automagik-herdr", env: { HERDR_APP_HOME: "/Users/u/my app/100%", PATH: `/opt/my tools/bin:/opt/$x:/opt/&<>"` }, wait: 600 });
  assert.ok(text.startsWith(`${PLIST_DECL}\n${PLIST_MARK}\n`), text);
  assert.ok(text.includes(`<key>Label</key><string>${PLIST_LABEL}</string>`), "the label launchd knows the job by");
  assert.match(text, /<key>ProgramArguments<\/key><array>\n\s*<string>\/Users\/u\/\.local\/bin\/automagik-herdr<\/string>\n\s*<string>revive<\/string>\n\s*<string>--boot<\/string>\n\s*<string>--wait<\/string>\n\s*<string>600<\/string>\n\s*<\/array>/, text);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/, "it runs at login");
  assert.match(text, /<key>KeepAlive<\/key><false\/>/, "once: it never restarts itself");
  assert.doesNotMatch(text, /StartInterval|StartCalendarInterval/, "no schedule of its own");
  assert.match(text, /<key>HERDR_APP_HOME<\/key><string>\/Users\/u\/my app\/100%<\/string>/, "a % is literal in a plist");
  assert.ok(text.includes(`<key>PATH</key><string>/opt/my tools/bin:/opt/$x:/opt/&amp;&lt;&gt;&quot;</string>`), text);
  assert.equal(plistIsOurs(text), true);
  assert.equal(plistKeepsPath(text), true);
  assert.equal(plistKeepsPath(plistText({ runner: "/r", env: { HERDR_APP_HOME: "/a" } })), false);
  assert.equal(plistIsOurs(`${PLIST_DECL}\n<plist version="1.0"><dict/></plist>\n`), false, "the declaration alone is anyone's");
  assert.equal(plistIsOurs(`<?xml version="1.0"?>\n${PLIST_MARK}\n`), false, "a comment may not come before the declaration");
  assert.equal(plistIsOurs(null), false);
  assert.equal(plistPath("/Users/u/"), "/Users/u/Library/LaunchAgents/dev.herdr.automagik-herdr-revive.plist");
  assert.ok(plistPath("/Users/u").startsWith("/Users/u/Library/LaunchAgents/"), "the person's own launch agents, never a system folder");
});

test("launchdNotLoaded: only launchctl's own exit 113 or its exact 'Could not find service' says the job is not loaded (#939)", () => {
  const r = (code, stderr = "", stdout = "") => ({ code, stderr, stdout });
  assert.equal(launchdNotLoaded(r(113)), true, "113 is launchd's not-found");
  assert.equal(launchdNotLoaded(r(0, "", "Could not find service")), true, "the exact words, whatever the exit");
  assert.equal(launchdNotLoaded(r(1, "Could not find service \"x\" in domain for user gui: 501")), true);
  assert.equal(launchdNotLoaded(r(1, "print failed")), false, "a failed probe is not a not-found");
  assert.equal(launchdNotLoaded(r(64, "usage: launchctl print <domain-target>")), false);
  assert.equal(launchdNotLoaded(r(1, "Operation not permitted")), false);
  assert.equal(launchdNotLoaded(r(5, "Input/output error")), false);
  assert.equal(launchdNotLoaded(r(0, "Could not find servicex")), false, "the exact message, not a word that starts it");
  assert.equal(launchdNotLoaded(r(0)), false, "exit 0 with no words is loaded");
});

test("helperPlan: a helper that is a bare shell names its agent by its launch command only when revive asks", () => {
  const get = { address: "t8", name: "side", cwd: "/p", state: "live", labels: { "agent.session": SID }, argv: ["/usr/bin/env", "PATH=/bin", "claude", "--session-id", SID, "do the thing"],
    foreground: { argv: ["zsh"], cwd: "/p" } };
  const asked = helperPlan({ get, session: SID, agents: AGENTS, launchAgent: true });
  assert.equal(asked.agent, "claude");
  assert.deepEqual(asked.argv, ["claude", "--resume", SID], "its first prompt and its old session words are not sent again");
  assert.equal(asked.mode, "resume");
  assert.match(helperPlan({ get, session: SID, agents: AGENTS }).error ?? "", /can't be run again/, "a restart by hand keeps its rule");
});

// ---- automagik-herdr revive, as a program ----

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const RUNTIME = process.env.AUTOMAGIK_HERDR_TEST_RUNTIME || process.execPath;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const FAKE_AGY = new URL("./fake-agy.mjs", import.meta.url).pathname;
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc" };
const CORE = "fakecore0000";
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const team = (over = {}) => ({ version: 1, categories: [], bots: [
  bot(ID.main, "main", { name: "Genie", ...over.main }),
  bot(ID.cap, "member", { name: "Captain", ...over.cap }),
  bot(ID.dev, "member", { name: "Dev", lead: ID.cap, ...over.dev }),
] });
/** An hc pane: `front` is what runs in front (["zsh"]: the bare shell hc keeps), `argv` its launch command. */
const pane = (address, { bot: b, front = ["zsh"], argv = ["claude"], cwd, created = 1, labels = {}, parent = null, status = "working", die = Boolean(parent),
  launchEnv = null, noHome = false } = {}) => ({
  address, name: address, cwd, state: "live", parent, die_with_parent: die, created_ms: created, argv, labels: { ...(b ? { bot: b } : {}), ...labels },
  foreground: { argv: front, cwd }, status: { app: "claude-code", state: status }, ...(launchEnv ? { launchEnv } : {}), ...(noHome ? { noHome } : {}) });

/** The program a pane's launch argv runs, past a leading `env [-u NAME…] K=V…` wrapper. */
function programOf(argv = []) {
  let i = 0;
  if (argv[i] === "env" || String(argv[i] ?? "").endsWith("/env")) {
    i += 1;
    for (;;) {
      if (argv[i] === "-u" || argv[i] === "--unset") { i += 2; continue; }
      if (argv[i] === "-i" || argv[i] === "--ignore-environment" || /^(-u.|--unset=)/.test(argv[i] ?? "")) { i += 1; continue; }
      break;
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? "")) i += 1;
  }
  return argv[i] ?? null;
}

function world(t, { file = team(), terminals = () => [], attach = null, hcExtra = {}, os = null } = {}) {
  const root = scratchRoot(t, "hb-revive-");
  const project = scratchProject(root, "proj", { isGit: true, commit: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  exe(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  for (const name of ["claude", "codex", "dsh-tui"]) exe(join(bin, name), "#!/bin/sh\nexit 0\n");
  // A system that says it is another one (`os`): both the installer and the CLI read uname -s.
  if (os) exe(join(bin, "uname"), `#!/bin/sh\necho ${os}\n`);
  // launchd's stand-in: it logs every call. A job is loaded only when the test says so, and a
  // bootout fails only when it asks for that. A test can also make `print` itself fail, with the
  // exit and the words it wants, to test that only launchd's own not-found answer means "not
  // loaded". The real launchctl is never reached.
  const lcLog = join(root, "launchctl.log");
  exe(join(bin, "launchctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${lcLog}"\ncase $1 in
  print)
    if [ -n "\${LAUNCHCTL_PRINT_EXIT:-}" ]; then printf '%s\\n' "\${LAUNCHCTL_PRINT_TEXT:-}" >&2; exit "$LAUNCHCTL_PRINT_EXIT"; fi
    if [ -n "\${LAUNCHCTL_PRINT_OUT:-}" ]; then printf '%s\\n' "$LAUNCHCTL_PRINT_OUT"; exit 0; fi
    [ "\${LAUNCHCTL_LOADED:-}" = 1 ] && exit 0
    echo "Could not find service" >&2; exit 113 ;;
  bootout) [ "\${LAUNCHCTL_BOOTOUT_FAIL:-}" = 1 ] && { echo "Boot-out failed: Input/output error" >&2; exit 1; }; exit 0 ;;
esac
exit 0
`);
  const sysLog = join(root, "systemctl.log");
  exe(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sysLog}"\n[ -n "$SYSTEMCTL_FAIL" ] && { echo "Failed to connect to bus" >&2; exit 1; }\nexit 0\n`);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "sonnet" }));
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  mkdirSync(join(app, "automagik-herdr"), { recursive: true });
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify(file, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  // #1490: model a hand launch's env HOME= words. A pack Start records its home in the seat
  // row (the Start test below). A pane can opt out with noHome or name another with launchEnv.
  const terms = terminals(project, { root, home }).map(({ noHome = false, launchEnv = null, ...x }) => {
    if (noHome || !["dsh-tui", "agy", "codex", "kimi"].includes(programOf(x.argv))) return x;
    if (launchEnvOf(x.argv).HOME) return x;
    const recorded = Object.entries({ HOME: home, ...(launchEnv ?? {}) }).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => `${k}=${v}`);
    return { ...x, argv: ["/usr/bin/env", ...recorded, ...x.argv] };
  });
  writeFileSync(statePath, JSON.stringify({ terminals: terms, next: 100, ...hcExtra }));
  writeFileSync(logPath, "");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify({ down: true }));
  writeFileSync(appLog, "");
  writeFileSync(join(root, "agy.log"), "");
  // The attach ledger: by default every pane that carries a bot label, bound as hc shows it.
  const rows = attach ? attach(project) : terms.filter((x) => x.labels?.bot).map((x) => ({ bot: x.labels.bot, terminal: x.address, created_ms: x.created_ms }));
  writeFileSync(attachPath(app), rows.map((r) => `${JSON.stringify({ v: 1, event: "attach", project, core: CORE, machine: null, at: "2026-11-01T10:00:00.000Z", by: "start", ...r })}\n`).join(""), { mode: 0o600 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog, AGY_FAKE_LOG: join(root, "agy.log"), GIT_CEILING_DIRECTORIES: root,
    AUTOMAGIK_HERDR_TAB_WAIT_MS: "100", AUTOMAGIK_HERDR_RESTART_STABLE_MS: "200", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "3000",
    AUTOMAGIK_HERDR_TREE_TURN_WAIT_MS: "1000", AUTOMAGIK_HERDR_REVIVE_SETTLE_MS: "0" };
  for (const k of ["HC_TERMINAL_ID", "HC_SOCKET", "HERMES_HOME", "AUTOMAGIK_HERDR_BOOT_MS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "DSH_HOME"]) delete env[k];
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, { ...core.env });
  Object.assign(env, { HC_SOCKET: "", HC_SESSION: "" });
  const cli = (args, { env: extra = {}, cwd = project } = {}) => {
    core.control({ ...env, ...extra });
    const r = spawnSync(RUNTIME, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const calls = () => readJsonLines(logPath);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const ledger = () => readLedger(existsSync(ledgerPath(app)) ? readFileSync(ledgerPath(app), "utf8") : "");
  const attachRows = () => readAttach(readFileSync(attachPath(app), "utf8")).rows;
  const lastReport = () => JSON.parse(readFileSync(join(app, "automagik-herdr/revive-last.json"), "utf8"));
  const sysCalls = () => (existsSync(sysLog) ? readFileSync(sysLog, "utf8").split("\n").filter(Boolean) : []);
  const lcCalls = () => (existsSync(lcLog) ? readFileSync(lcLog, "utf8").split("\n").filter(Boolean) : []);
  return { root, project, home, app, env, cli, calls, hcState, ledger, attachRows, lastReport, sysCalls, lcCalls };
}
const runsOf = (s) => s.calls().filter((c) => c[0] === "run");
const wordsOf = (run) => run.slice(run.indexOf("--") + 1);
const cwdOf = (run) => run[run.indexOf("--cwd") + 1];
const changes = (s) => s.calls().filter((c) => ["run", "kill", "label", "send"].includes(c[0]));
const hasSeq = (words, seq) => words.some((_, i) => seq.every((w, j) => words[i + j] === w));
/** The run that started bot `botId` (its hc labels name it). */
const runFor = (s, botId) => runsOf(s).find((run) => run.includes(`bot=${botId}`));
/** The value of a label passed to hc run, before its command. */
const labelOf = (run, key) => run?.slice(0, run.indexOf("--"))
  .find((arg, i) => run[i - 1] === "--label" && arg.startsWith(`${key}=`))?.slice(key.length + 1);
/** Session ids written with hc label on this terminal. */
const sessionOn = (s, terminal) => sessionLabels(s).filter(([t]) => t === terminal).map(([, id]) => id);
/** The run `name` was given (a helper keeps its old pane's name when hc still has it free). */
const runNamed = (s, name) => runsOf(s).find((run) => run[run.indexOf("--name") + 1] === name);

test("revive: after a reboot each bot at a bare shell is restarted in its place, the main bot first and a member after its lead, resumed by id; a running bot is never touched; the main bot gets one report", (t) => {
  const s = world(t, { terminals: (p) => [
    pane("t7", { bot: ID.dev, cwd: p, labels: { "agent.session": SID3, "herdr.space": "sp9", "herdr.tab": "tb5" } }),
    pane("t6", { bot: ID.cap, cwd: p, front: ["claude"], status: "idle" }), // its agent runs
    pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID, "herdr.space": "sp9", "herdr.tab": "tb3", squad: "core" } }),
  ] });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const runs = runsOf(s);
  assert.equal(runs.length, 2, JSON.stringify(runs));
  // Genie (the main bot) first, in its old space, tab and folder, resumed by its pane's session id.
  assert.ok(hasSeq(wordsOf(runs[0]), ["--resume", SID]), runs[0].join(" "));
  assert.ok(["herdr.space=sp9", "herdr.tab=tb3", `bot=${ID.main}`, `agent.session=${SID}`, "squad=core"].every((l) => runs[0].includes(l)), runs[0].join(" "));
  assert.equal(cwdOf(runs[0]), s.project);
  assert.ok(hasSeq(wordsOf(runs[1]), ["--resume", SID3]), runs[1].join(" "));
  assert.ok(["herdr.space=sp9", "herdr.tab=tb5", `bot=${ID.dev}`].every((l) => runs[1].includes(l)), runs[1].join(" "));
  // The old shells ended, each only after its replacement; Captain's running pane was never touched.
  const state = s.hcState();
  const stateOf = (a) => state.terminals.find((x) => x.address === a).state;
  assert.deepEqual(["t5", "t6", "t7", "t100", "t101"].map(stateOf), ["finished", "live", "finished", "live", "live"]);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t5", "t7"]);
  // Captain's pane was never ended or typed into (a restart's own tidy may set its missing labels; Dev starts under it, its lead's).
  assert.ok(!s.calls().some((c) => ["kill", "send", "keys"].includes(c[0]) && c[1] === "t6"), JSON.stringify(changes(s)));
  assert.equal(runs[1][runs[1].indexOf("--parent") + 1], "t6");
  // One report, to the main bot's new pane, naming who resumed; no session id in it or in any output.
  assert.equal(state.sent.length, 1, JSON.stringify(state.sent));
  assert.equal(state.sent[0].to, "t100");
  assert.match(state.sent[0].text, /^Revive after a restart of this computer, project .*Resumed where they were: Genie \(t100\); Dev \(t101\)\. To keep a bot down across restarts of this computer: am detach <bot>\.$/);
  const out = r.json();
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].sent, "t100");
  assert.deepEqual(out.projects[0].results.map((x) => [x.name, x.outcome, x.terminal]), [["Genie", "resumed", "t100"], ["Dev", "resumed", "t101"]]);
  for (const text of [r.out, r.err, state.sent[0].text, JSON.stringify(s.lastReport())]) for (const id of [SID, SID3]) assert.ok(!text.includes(id), text);
  assert.equal(statSync(join(s.app, "automagik-herdr/revive-last.json")).mode & 0o777, 0o600);
  // The ledger moved each bot to its new pane, and a second pass finds nothing to do.
  const bound = new Map(s.attachRows().filter((x) => x.event === "attach").map((x) => [x.bot, x.terminal]));
  assert.deepEqual([bound.get(ID.main), bound.get(ID.dev), bound.get(ID.cap)], ["t100", "t101", "t6"]);
  const again = s.cli(["revive"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /nothing to bring back/);
  assert.equal(runsOf(s).length, 2);
});

test("#1413: revive after a reboot starts a Claude bot with its own permission mode", (t) => {
  const s = world(t, {
    file: team({ main: { permissionMode: "bypassPermissions" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })],
  });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const words = wordsOf(runsOf(s)[0]);
  const at = words.indexOf("--permission-mode");
  assert.notEqual(at, -1, words.join(" "));
  assert.equal(words[at + 1], "bypassPermissions");
});

test("revive --dry-run prints the plan and touches nothing", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } }), pane("t6", { bot: ID.cap, cwd: p, front: ["claude"] })],
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 1 }, { bot: ID.cap, terminal: "t6", created_ms: 1 }, { bot: ID.dev, terminal: "t44", created_ms: 9 }] });
  const before = readFileSync(attachPath(s.app), "utf8");
  const r = s.cli(["revive", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Genie \(b-aaaaaaaaaa\) in .*: would restart; its pane t5 is a bare shell/);
  assert.match(r.out, /Dev \(b-cccccccccc\) in .*: would restart; its pane t44 is gone/);
  assert.doesNotMatch(r.out, /Captain/);
  assert.deepEqual(changes(s), []);
  assert.equal(readFileSync(attachPath(s.app), "utf8"), before, "no row written, no sweep");
  assert.equal(existsSync(join(s.app, "automagik-herdr/revive-last.json")), false);
  const j = s.cli(["revive", "--dry-run", "--json"]).json();
  assert.deepEqual(j.targets.map((x) => [x.name, x.pane, x.action]), [["Genie", "shell", "restart"], ["Dev", "gone", "restart"]]);
});

test("revive records a dsh-TUI pane's session from DSH's own folder and resumes it by id; the id is never printed", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"], labels: { "herdr.space": "sp1" } })] });
  // DSH's sessions for the project folder: one from before the pane (not its own), one born with it.
  const dir = dshSessionsDir(join(s.home, ".dsh"), s.project);
  for (const [id, at] of [[SID2, born - 86_400_000], [SID, born + 1500]]) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "session.v4.jsonl.zstd"), "x");
    utimesSync(join(dir, id, "session.v4.jsonl.zstd"), at / 1000 + 60, at / 1000 + 60);
    utimesSync(join(dir, id), at / 1000, at / 1000);
  }
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  // Recorded on the old pane first: its label and a session row naming the agent.
  assert.deepEqual(s.calls().filter((c) => c[0] === "label" && c[1] === "t5").map((c) => c.slice(2)), [[`agent.session=${SID}`]]);
  assert.deepEqual(s.ledger().filter((x) => x.event === "session").map((x) => [x.terminal, x.session, x.agent]), [["t5", SID, "dsh-tui"], ["t100", SID, "dsh-tui"]]);
  const run = runsOf(s)[0];
  assert.ok(hasSeq(wordsOf(run), ["--resume", SID]), run.join(" "));
  assert.ok(run.includes(`agent.session=${SID}`), "the next restart finds it on the new pane");
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Genie", "resumed"]]);
  for (const text of [r.out, r.err, s.hcState().sent[0].text, JSON.stringify(s.lastReport())]) assert.ok(!text.includes(SID), text);
});

test("revive: two dsh-TUI bots started together in one folder can't be told apart on disk: each comes back on a new conversation, and the report says why", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" }, cap: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"] }), pane("t6", { bot: ID.cap, cwd: p, created: born + 500, argv: ["dsh-tui"] })] });
  writeFileSync(ledgerPath(s.app), [["t5", ID.main, born], ["t6", ID.cap, born + 500]].map(([terminal, botId, created_ms]) =>
    `${JSON.stringify({ event: "start", kind: "seat", terminal, botId, project: s.project, worktree: s.project, agent: "dsh-tui", core: CORE, created_ms, at: new Date(created_ms).toISOString() })}\n`).join(""), { mode: 0o600 });
  const dir = dshSessionsDir(join(s.home, ".dsh"), s.project);
  for (const [id, at] of [[SID, born + 1500], [SID2, born + 2500]]) { mkdirSync(join(dir, id), { recursive: true }); utimesSync(join(dir, id), at / 1000, at / 1000); }
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.calls().filter((c) => c[0] === "label" && c[2]?.startsWith("agent.session=")).length, 0, "no id guessed");
  for (const run of runsOf(s)) assert.ok(!wordsOf(run).includes("--resume") && !wordsOf(run).includes("-c"), run.join(" "));
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["Genie", "fresh"], ["Captain", "fresh"]]);
  assert.match(results[0].why, /no dsh-TUI session id is known for t5/);
  assert.match(s.hcState().sent[0].text, /Back on a new conversation: Genie \(t100\), no dsh-TUI session id is known for t5/);
});

test("restart finds an Antigravity pane's conversation in agy's history and resumes it by id (--conversation), recording it", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "antigravity" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, front: ["agy", "--mode", "auto"], argv: ["agy", "--mode", "auto"], status: "idle" })] });
  mkdirSync(join(s.home, ".gemini/antigravity-cli"), { recursive: true });
  writeFileSync(agyHistoryPath(s.home), [
    { display: "an older talk", timestamp: born - 50_000, workspace: s.project, conversationId: SID2 },
    { display: "the briefing", timestamp: born + 900, workspace: s.project, conversationId: SID },
    { display: "elsewhere", timestamp: born + 950, workspace: "/elsewhere", conversationId: SID3 },
    { display: "next", timestamp: born + 90_000, workspace: s.project, conversationId: SID },
  ].map((x) => `${JSON.stringify(x)}\n`).join(""));
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().mode, "resume");
  const run = runsOf(s)[0];
  assert.ok(hasSeq(wordsOf(run), ["--conversation", SID]), run.join(" "));
  assert.ok(run.includes(`agent.session=${SID}`));
  assert.deepEqual(s.ledger().filter((x) => x.event === "session").map((x) => [x.terminal, x.session, x.agent]), [["t100", SID, "antigravity"]]);
  assert.ok(!r.out.includes(SID) && !r.err.includes(SID), r.out + r.err);
});

test("revive: a pane that is gone whole comes back in its seat row's folder, resumed by the ledger's session; a resume that exits is tried again as a new conversation, and said", (t) => {
  const seat = (p, extra = {}) => `${JSON.stringify({ event: "start", kind: "seat", terminal: "t5", botId: ID.main, project: p, worktree: p, agent: "claude", core: CORE, created_ms: 50,
    session: SID, at: "2026-11-01T10:00:00.000Z", ...extra })}\n`;
  const s = world(t, { attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 50 }] });
  writeFileSync(ledgerPath(s.app), seat(s.project), { mode: 0o600 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runsOf(s)[0];
  assert.ok(hasSeq(wordsOf(run), ["--resume", SID]), run.join(" "));
  assert.equal(cwdOf(run), s.project);
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome, x.terminal]), [["Genie", "resumed", "t100"]]);
  assert.deepEqual(s.ledger().filter((x) => x.event === "session").map((x) => [x.terminal, x.session]), [["t100", SID]]);
  assert.equal(s.hcState().sent[0].to, "t100");

  // The resume finds nothing and exits: one more try, a new conversation, and the report says so.
  const s2 = world(t, { attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 50 }], hcExtra: { runQueue: [{ runAs: "exit", screen: "No conversation found with session ID\n" }] } });
  writeFileSync(ledgerPath(s2.app), seat(s2.project), { mode: 0o600 });
  const r2 = s2.cli(["revive", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  const runs = runsOf(s2);
  assert.equal(runs.length, 2, JSON.stringify(r2.json()) + r2.err);
  assert.ok(wordsOf(runs[0]).includes("--resume") && !wordsOf(runs[1]).includes("--resume"), JSON.stringify(runs));
  const res = r2.json().projects[0].results[0];
  assert.deepEqual([res.name, res.outcome, res.terminal], ["Genie", "fresh", "t101"]);
  assert.match(res.why, /^its conversation couldn't be resumed \(/);
  assert.match(s2.hcState().sent[0].text, /Back on a new conversation: Genie \(t101\), its conversation couldn't be resumed/);
});

/** #1418: the pane is gone whole, so only its seat row can name its template. */
function goneSeat(t, { seat = {}, bot = {}, templates = [], hcExtra = {} } = {}) {
  const agent = bot.agent ?? "omp";
  const s = world(t, { file: team({ main: { agent, ...bot } }),
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 50 }], hcExtra: { templates, ...hcExtra } });
  exe(join(s.root, "bin", agent), "#!/bin/sh\nexit 0\n");
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t5", botId: ID.main, project: s.project,
    worktree: s.project, agent, core: CORE, created_ms: 50, at: "2026-11-01T10:00:00.000Z", ...seat })}\n`, { mode: 0o600 });
  return s;
}

function assertRevivedSeat(s, address, argv, template, agent = "omp") {
  const get = s.hcState().terminals.find((p) => p.address === address);
  const at = get.argv.findIndex((word, i) => i > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  assert.deepEqual(get.argv.slice(at).filter((w) => !w.startsWith("--append-system-prompt=<herdr-bot>")), argv);
  assert.equal(get.labels["worker.template"], template ?? undefined);
  const rows = s.ledger().filter((r) => r.event === "start" && r.kind === "seat" && r.terminal === address);
  assert.deepEqual(rows.map((r) => [r.botId, r.agent, r.template, r.created_ms]), [[ID.main, agent, template, get.created_ms]]);
}

const chosenReviveArgv = ["/usr/bin/env",
  ...envWords(["PATH=/bin"], chosenHomeWords("claude", "/homes/b", SID)), "claude"];

test("#1208 revive refuses an initially chosen replacement before writing the seat rows", (t) => {
  const s = goneSeat(t, { hcExtra: { getReply: { t100: { address: "t100", state: "live", created_ms: 100, argv: chosenReviveArgv } } } });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 1, r.err);
  const [result] = r.json().projects[0].results;
  assert.equal(result.outcome, "failed");
  assert.match(result.why, /t100 is a worker on a chosen agent home/);
  assert.equal(s.attachRows().some((x) => x.terminal === "t100"), false);
  assert.equal(s.ledger().some((x) => x.terminal === "t100"), false);
  assert.equal(s.calls().some(([verb]) => verb === "kill"), false);
});

test("#1208 an ordinary gone seat is recorded and visible during readiness before timeout cleanup", (t) => {
  const s = goneSeat(t, { hcExtra: { runAs: "shell" } });
  const initial = join(s.root, "initial-get");
  const poll = join(s.root, "readiness-get");
  const snapshot = join(s.root, "pre-kill");
  for (const file of [initial, poll]) writeFileSync(file, "");
  exe(join(s.root, "bin/hc"), `#!/bin/sh
if [ "$1 $2" = "get t100" ]; then
  if [ -f "${initial}" ]; then rm -f "${initial}"
  elif [ -f "${poll}" ]; then
    rm -f "${poll}"
    "${RUNTIME}" "${CLI}" ls --json >"${s.root}/ls.json" || exit $?
    "${RUNTIME}" "${CLI}" whois --bot Genie --json >"${s.root}/whois.json" || exit $?
    "${RUNTIME}" "${CLI}" start Genie --json >"${s.root}/start.json" || exit $?
  fi
fi
if [ "$1 $2" = "kill t100" ]; then
  mkdir "${snapshot}"
  cp "${attachPath(s.app)}" "${snapshot}/attach.jsonl"
  cp "${ledgerPath(s.app)}" "${snapshot}/workers.jsonl"
fi
exec "${process.execPath}" "${FAKE_HC}" "$@"
`);
  const r = s.cli(["revive", "--json"], { env: { AUTOMAGIK_HERDR_RESTART_WAIT_MS: "1500" } });
  assert.equal(r.code, 1, r.err);
  assert.match(r.json().projects[0].results[0].why, /t100 didn't keep an agent in front .*so it was ended/);

  const observed = (command) => JSON.parse(readFileSync(join(s.root, `${command}.json`), "utf8"));
  const listed = observed("ls").projects[0].bots.find((b) => b.id === ID.main);
  assert.deepEqual([listed.terminal, listed.status], ["t100", "no agent in front"]);
  assert.equal(observed("whois").terminal, "t100");
  const { id, running } = observed("start");
  assert.deepEqual([id, running], [ID.main, "t100"]);

  const attached = readAttach(readFileSync(join(snapshot, "attach.jsonl"), "utf8")).rows;
  const starts = readLedger(readFileSync(join(snapshot, "workers.jsonl"), "utf8"));
  const pane = s.hcState().terminals.find((x) => x.address === "t100");
  assert.deepEqual(attached.filter((x) => x.terminal === "t100").map((x) => [x.event, x.bot, x.by, x.created_ms]),
    [["attach", ID.main, "start", pane.created_ms]]);
  assert.deepEqual(starts.filter((x) => x.terminal === "t100").map((x) => [x.event, x.kind, x.botId, x.created_ms]),
    [["start", "seat", ID.main, pane.created_ms]]);
  assert.equal(runsOf(s).length, 1);
  assert.equal(pane.state, "finished");
});

test("#1208 revive retries an ordinary resume fresh when readiness exits 3 with internal", (t) => {
  const s = goneSeat(t, { bot: { agent: "claude" }, seat: { session: SID },
    hcExtra: { runQueue: [{ runAs: "exit", screen: "No conversation found with session ID\n" }] } });
  const initial = join(s.root, "initial-get");
  writeFileSync(initial, "");
  exe(join(s.root, "bin/hc"), `#!/bin/sh
if [ "$1 $2" = "get t100" ]; then
  if [ -f "${initial}" ]; then rm -f "${initial}"
  else
    "${process.execPath}" "${FAKE_HC}" "$@" >/dev/null || exit $?
    echo '{"error":{"kind":"internal","message":"server error reading t100"}}' >&2
    exit 3
  fi
fi
exec "${process.execPath}" "${FAKE_HC}" "$@"
`);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const [result] = r.json().projects[0].results;
  assert.deepEqual([result.outcome, result.terminal], ["fresh", "t101"]);
  assert.match(result.why, /^its conversation couldn't be resumed/);
  const runs = runsOf(s).map(wordsOf);
  assert.equal(runs.length, 2);
  assert.ok(hasSeq(runs[0], ["--resume", SID]));
  assert.ok(!runs[1].includes("--resume"));
  assert.deepEqual(s.ledger().filter((row) => row.event === "start" && row.terminal !== "t5").map((row) => row.terminal), ["t100", "t101"]);
});

test("#1208 a gone seat rechecks chosen evidence and the current binding under the attach lock", (t) => {
  const s = goneSeat(t, { hcExtra: { runAs: "shell" } });
  const initial = join(s.root, "initial-get");
  const poll = join(s.root, "readiness-get");
  const checked = join(s.root, "checked-under-lock");
  const chosen = join(s.root, "chosen.mjs");
  for (const file of [initial, poll]) writeFileSync(file, "");
  writeFileSync(chosen, `import { readFileSync } from "node:fs";
const get = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({ ...get, argv: ${JSON.stringify(chosenReviveArgv)} }));
`);
  exe(join(s.root, "bin/hc"), `#!/bin/sh
if [ "$1 $2" = "get t100" ]; then
  if [ -f "${initial}" ]; then rm -f "${initial}"
  elif [ -f "${poll}" ]; then
    rm -f "${poll}"
    "${RUNTIME}" "${CLI}" detach Genie --json >"${s.root}/detach.json" || exit $?
    "${RUNTIME}" "${CLI}" attach Captain t100 --json >"${s.root}/attach.json" || exit $?
    "${process.execPath}" "${FAKE_HC}" "$@" | "${process.execPath}" "${chosen}"
    exit $?
  elif [ -f "${attachPath(s.app)}.lock" ] && [ -f "${s.root}/attach.json" ]; then
    : >"${checked}"
    "${process.execPath}" "${FAKE_HC}" "$@" | "${process.execPath}" "${chosen}"
    exit $?
  fi
fi
exec "${process.execPath}" "${FAKE_HC}" "$@"
`);
  const r = s.cli(["revive", "--json"], { env: { AUTOMAGIK_HERDR_RESTART_WAIT_MS: "8000" } });
  assert.equal(r.code, 1, r.err);
  assert.match(r.json().projects[0].results[0].why, /t100 was attached to .* during readiness and was left as it is/);
  assert.equal(existsSync(checked), true);
  assert.ok(s.attachRows().some((row) => row.event === "attach" && row.bot === ID.cap && row.terminal === "t100"));
  assert.deepEqual(s.calls().filter(([verb]) => verb === "kill"), []);
  assert.equal(s.hcState().terminals.find((pane) => pane.address === "t100").state, "live");
});

test("#1208 revive --dry-run still targets an ordinary seat when hc exits 3 with internal", (t) => {
  const s = goneSeat(t, { hcExtra: { failGet: ["t5"], failGetExit: 3 } });
  const r = s.cli(["revive", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.err);
  const { targets, skipped } = r.json();
  assert.deepEqual(targets.map((pane) => [pane.bot, pane.terminal, pane.pane, pane.action]), [[ID.main, "t5", "gone", "restart"]]);
  assert.deepEqual(skipped, []);
  assert.equal(runsOf(s).length, 0);
});

const seatTemplate = { name: "dev-kimi", command: "/opt/agents/omp --auto-approve --model kimi/k3" };

for (const args of [["revive"], ["revive", "--boot"]]) {
  test(`#1418: ${args.join(" ")} runs the current template command when the pane is gone`, (t) => {
    const s = goneSeat(t, { seat: { template: seatTemplate.name }, templates: [seatTemplate] });
    const r = s.cli([...args, "--json"], { env: { AUTOMAGIK_HERDR_BOOT_MS: String(Date.now() - 60_000) } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json().projects[0].results.map((x) => [x.outcome, x.terminal]), [["resumed", "t100"]]);
    assert.equal(runsOf(s).length, 1);
    assertRevivedSeat(s, "t100", ["sh", "-c", `${seatTemplate.command} "$@"`, "sh", "--continue"], seatTemplate.name);
    assert.doesNotMatch(r.err, /differs from its source/);
  });
}

for (const { why, seat, templates, lookups } of [
  { why: "the template is no longer listed", seat: { template: seatTemplate.name }, templates: [], lookups: 1 },
  { why: "an old seat row has no template field", seat: {}, templates: [seatTemplate], lookups: 0 },
  { why: "the seat row names another agent", seat: { agent: "claude", template: seatTemplate.name }, templates: [seatTemplate], lookups: 0 },
]) {
  test(`#1418: revive uses the agent row when ${why}`, (t) => {
    const s = goneSeat(t, { seat, templates });
    const r = s.cli(["revive", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json().projects[0].results.map((x) => [x.outcome, x.terminal]), [["resumed", "t100"]]);
    assert.equal(runsOf(s).length, 1);
    assert.equal(s.calls().filter((c) => c[0] === "templates").length, lookups);
    assertRevivedSeat(s, "t100", ["omp", "--continue"], null);
  });
}

test("#1418: a gone paired Hermes seat resumes Bot Chat even when its row names a template", (t) => {
  const bot = { agent: "hermes", hermes: { home: "/srv/research", profile: "default" } };
  const s = goneSeat(t, { bot, seat: { template: "research" }, templates: [{ name: "research", command: "hermes --tui" }],
    hcExtra: { noStatus: ["hermes"] } });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.outcome, x.terminal]), [["resumed", "t100"]]);
  assert.equal(runsOf(s).length, 1);
  assert.equal(s.calls().filter((c) => c[0] === "templates").length, 0);
  assert.ok(wordsOf(runsOf(s)[0]).includes("HERMES_HOME=/srv/research"));
  assertRevivedSeat(s, "t100", ["hermes", "--profile", "default", "--tui", "--continue", "Bot Chat"], null, "hermes");
});

test("#1418: when a gone seat's template resume exits, revive keeps the template on its --fresh retry", (t) => {
  const s = goneSeat(t, { seat: { template: seatTemplate.name, session: SID }, templates: [seatTemplate],
    hcExtra: { runQueue: [{ runAs: "exit", screen: "No conversation found with session ID\n" }] } });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const res = r.json().projects[0].results[0];
  assert.deepEqual([res.outcome, res.terminal], ["fresh", "t101"]);
  assert.match(res.why, /^its conversation couldn't be resumed \(/);
  assert.equal(runsOf(s).length, 2);
  assert.equal(s.hcState().terminals.find((p) => p.address === "t100").state, "finished");
  assertRevivedSeat(s, "t100", ["sh", "-c", `${seatTemplate.command} "$@"`, "sh", `--resume=${SID}`], seatTemplate.name);
  assertRevivedSeat(s, "t101", ["sh", "-c", seatTemplate.command], seatTemplate.name);
});

test("#1509 revive names a helper with a late login refusal and records its end", (t) => {
  const s = world(t, { terminals: (p) => [
    pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } }),
    // A Codex helper all through: its launch, its foreground and the app hc reports.
    { ...pane("t8", { cwd: p, parent: "t5", created: 8, front: ["codex"], argv: ["codex"], status: "idle" }),
      name: "reader-helper", status: { app: "codex", state: "idle" } },
  ] });
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "worker", terminal: "t8",
    core: CORE, created_ms: 8, agent: "codex", botId: ID.main, project: s.project, worktree: s.project })}\n`);
  const root = join(s.root, "acp", "cli-homes");
  const claude = loginFixture(t, root, "claude");
  const codex = loginFixture(t, root, "codex");
  const state = s.hcState();
  state.onKillWrite = { terminal: "t5", path: join(dirname(codex.dir), "paused"), text: "" };
  writeFileSync(s.env.HC_FAKE_STATE, JSON.stringify(state));
  const r = s.cli(["revive", "--json"], { env: claude.env });
  assert.equal(r.code, 1, r.err);
  const project = r.json().projects[0];
  const [helper] = project.results[0].helpers;
  assert.ok(helper, JSON.stringify(r.json()) + r.err);
  assert.equal(helper.login, "login-paused");
  assert.equal(helper.why, "The Bot login record is missing or out of date; sign in again. (login-paused)");
  assert.match(project.report, /reader-helper \(under Genie\), .*\(login-paused\)/);
  assert.deepEqual(s.ledger().filter((row) => row.event === "end" && row.terminal === "t8")
    .map((row) => [row.kind, row.core, row.created_ms, row.reason]), [["worker", CORE, 8, "replaced"]]);
  assert.equal(runsOf(s).length, 1, "only the parent restarted");
});

test("revive brings a bot's helpers back under its new pane (--tree): a helper at a bare shell is run again from its launch command, resumed by its own session", (t) => {
  const s = world(t, { terminals: (p) => [
    pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } }),
    pane("t8", { cwd: p, parent: "t5", labels: { "agent.session": SID4, "worker.of": ID.main, "worker.role": "dev" }, argv: ["/usr/bin/env", "PATH=/bin", "claude", "--session-id", SID4, "fix the thing"] }),
  ] });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const runs = runsOf(s);
  assert.equal(runs.length, 2, JSON.stringify(runs));
  assert.ok(hasSeq(wordsOf(runs[0]), ["--resume", SID]));
  // The helper: under the bot's new pane, its labels kept, resumed by its own id, its task not sent again.
  assert.equal(runs[1][runs[1].indexOf("--parent") + 1], "t100");
  assert.ok(hasSeq(wordsOf(runs[1]), ["--resume", SID4]), runs[1].join(" "));
  assert.ok(!wordsOf(runs[1]).includes("fix the thing"));
  assert.ok([`worker.of=${ID.main}`, "worker.role=dev"].every((l) => runs[1].includes(l)));
  const res = r.json().projects[0].results[0];
  assert.deepEqual(res.helpers.map((h) => [h.name, h.outcome]), [["t8", "resumed"]]);
  assert.match(s.hcState().sent[0].text, /Helpers resumed: t8 \(under Genie\)\./);
  for (const id of [SID, SID4]) assert.ok(!(r.out + r.err + s.hcState().sent[0].text).includes(id));
});

test("revive: a bot that can't come back is reported as not back with the command by hand, the others still come back, and the exit code says so", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } }), pane("t6", { bot: ID.cap, cwd: p })],
    hcExtra: { failRun: ["captain"] } });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 1, r.err);
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["Genie", "resumed"], ["Captain", "failed"]]);
  assert.match(results[1].why, /^hc run failed/);
  assert.ok(s.hcState().sent[0].text.includes(`by hand: am restart ${ID.cap} --project ${s.project} --tree.`), s.hcState().sent[0].text);
  assert.equal(s.hcState().terminals.find((x) => x.address === "t6").state, "live", "its shell stays");
});

test("revive: with no main bot's pane to tell, or a send hc refuses, the report is kept in the app home and the answer says so", (t) => {
  const s = world(t, { terminals: (p) => [pane("t6", { bot: ID.cap, cwd: p, labels: { "agent.session": SID2 } })] });
  const r = s.cli(["revive"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Resumed where they were: Captain \(t100\)\./);
  assert.match(r.out, /Not sent: Genie has no pane\. It is kept in .*revive-last\.json\./);
  assert.equal(s.hcState().sent, undefined);
  assert.equal(s.lastReport().projects[0].sent, null);

  const s2 = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })], hcExtra: { failSend: ["t100"] } });
  const r2 = s2.cli(["revive", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.json().projects[0].unsent, /^hc send t100 failed/);
});

test("revive run from inside a bot's own bare shell leaves that pane alone and says to run it elsewhere", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const r = s.cli(["revive", "--json"], { env: { HC_TERMINAL_ID: "t5" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(runsOf(s), []);
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome, x.why]), [["Genie", "skipped", "revive runs inside its pane; run it from another terminal"]]);
});

test("revive --boot runs once per boot, and also brings back a bot whose ended pane another command swept since the boot", (t) => {
  const boot = Date.parse("2026-11-10T12:00:00.000Z");
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })],
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 1 },
      { bot: ID.cap, terminal: "t6", created_ms: 2 }, { bot: ID.cap, terminal: "t6", created_ms: 2, event: "end", by: "sweep", reason: "finished", at: "2026-11-10T12:00:30.000Z" },
      { bot: ID.dev, terminal: "t7", created_ms: 3 }, { bot: ID.dev, terminal: "t7", created_ms: 3, event: "end", by: "sweep", reason: "finished", at: "2026-11-09T08:00:00.000Z" }] });
  const env = { AUTOMAGIK_HERDR_BOOT_MS: String(boot) };
  // By hand: the ledger as it stands, so only Genie.
  const dry = s.cli(["revive", "--dry-run", "--json"], { env }).json();
  assert.deepEqual(dry.targets.map((x) => x.name), ["Genie"]);
  // The boot's pass: Captain too (swept after the boot); Dev ended the day before and stays ended.
  const r = s.cli(["revive", "--boot", "--json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Genie", "resumed"], ["Captain", "fresh"]]);
  assert.match(r.json().projects[0].results[1].why, /its pane was gone and no conversation of its own was on record/);
  assert.equal(runsOf(s).length, 2);
  // Once per boot: a second login in the same boot does nothing; a new boot looks again.
  const again = s.cli(["revive", "--boot", "--json"], { env: { AUTOMAGIK_HERDR_BOOT_MS: String(boot + 800) } });
  assert.deepEqual(again.json(), { ran: false, reason: "already ran for this boot" });
  assert.equal(runsOf(s).length, 2);
  assert.equal(s.cli(["revive", "--boot", "--json"], { env: { AUTOMAGIK_HERDR_BOOT_MS: String(boot + 7_200_000) } }).json().ran, true);
});

test("revive --wait: with herdr-core not answering it starts nothing and says so; usage mistakes exit 2", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p })] });
  exe(join(s.root, "bin", "hc"), "#!/bin/sh\necho 'core is not running' >&2\nexit 1\n");
  const r = s.cli(["revive", "--wait", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /herdr-core isn't answering 1s on \(core is not running\)\. Nothing was started\./);
  assert.equal(s.cli(["revive", "--wait", "soon"]).code, 2);
  assert.equal(s.cli(["revive", "everything"]).code, 2);
  assert.equal(s.cli(["revive", "--machine", "lab"]).code, 2);
});

for (const os of ["Linux", "Darwin"]) test(`#1509 revive service on ${os} preserves a present empty pointer without a marker`, () => {
  const env = { AUTOMAGIK_BOT_CLI_POINTER: "", PATH: "/usr/bin" };
  const text = (os === "Linux" ? unitText : plistText)({ runner: "/bin/am", env });
  const line = os === "Linux" ? 'Environment="AUTOMAGIK_BOT_CLI_POINTER="' : "<key>AUTOMAGIK_BOT_CLI_POINTER</key><string></string>";
  assert.ok(text.includes(line), text);
  assert.doesNotMatch(text, /AUTOMAGIK_NATIVE_WORKER_LOGIN/);
});

for (const os of ["Linux", "Darwin"]) test(`#1509 revive service on ${os} keeps the Bot login policy`, (t) => {
  const home = scratchRoot(t, "revive-login-service-");
  const bin = join(home, "bin"), app = join(home, "app"), log = join(home, "service.log");
  mkdirSync(bin);
  mkdirSync(app);
  exe(join(bin, "uname"), `#!/bin/sh\necho ${os}\n`);
  for (const program of ["systemctl", "launchctl"]) {
    exe(join(bin, program), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  }
  const env = { AUTOMAGIK_BOT_CLI_POINTER: join(home, "cli-homes/current/claude"),
    AUTOMAGIK_NATIVE_WORKER_LOGIN: "required", DSH_HOME: join(home, "dsh"), AUTOMAGIK_HOME: home };
  const errorPath = join(home, "stderr");
  const stderr = openSync(errorPath, "w", 0o600);
  let installed;
  try {
    installed = spawnSync(RUNTIME, [CLI, "revive", "service", "install", "--json"], {
      cwd: home, env: { ...process.env, ...env, HOME: home, HERDR_APP_HOME: app, PATH: `${bin}:${process.env.PATH}`,
        AUTOMAGIK_HERDR_TEST_ROOTS: home },
      stdio: ["ignore", "ignore", stderr],
    });
  } finally { closeSync(stderr); }
  assert.equal(installed.status, 0, installed.error?.message ?? readFileSync(errorPath, "utf8"));
  const text = readFileSync(os === "Linux" ? unitPath(home) : plistPath(home), "utf8");
  for (const [name, value] of Object.entries(env)) {
    const line = os === "Linux" ? `Environment="${name}=${value}"` : `<key>${name}</key><string>${value}</string>`;
    assert.ok(text.includes(line), line);
  }
  if (os === "Linux") assert.equal(readFileSync(log, "utf8"), `--user daemon-reload\n--user enable ${UNIT_NAME}\n`);
  else assert.equal(existsSync(log), false);
});

test("revive service: installs and enables a systemd user unit that runs revive --boot, never starts it, and removes only a unit it wrote", { skip: process.platform !== "linux" }, (t) => {
  const s = world(t);
  const path = unitPath(s.home);
  assert.match(s.cli(["revive", "service", "status"]).out, /isn't installed/);
  const r = s.cli(["revive", "service", "install", "--json"]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(path, "utf8");
  assert.equal(unitIsOurs(text), true);
  assert.match(text, /^ExecStart=".*\/bin\/automagik-herdr" revive --boot --wait \d+$/m);
  assert.ok(text.includes(`Environment="HERDR_APP_HOME=${s.app}"`), text);
  assert.deepEqual(s.sysCalls(), ["--user daemon-reload", `--user enable ${UNIT_NAME}`], "enabled, never started");
  assert.equal(r.json().enabled, true);
  assert.deepEqual(changes(s), [], "no pane was touched");
  assert.match(s.cli(["revive", "service", "status"]).out, /Automagik Herdr's, enabled\./);
  const gone = s.cli(["revive", "service", "uninstall"]);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(existsSync(path), false);
  assert.ok(s.sysCalls().includes(`--user disable ${UNIT_NAME}`));
  // Someone else's unit at that path is left as it is, by install and by uninstall.
  mkdirSync(join(s.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(path, "[Unit]\nDescription=mine\n");
  for (const verb of ["install", "uninstall"]) {
    const no = s.cli(["revive", "service", verb]);
    assert.equal(no.code, 1);
    assert.match(no.err, /isn't one Automagik Herdr wrote, so it was left as it is/);
  }
  assert.equal(readFileSync(path, "utf8"), "[Unit]\nDescription=mine\n");
  // systemd not reachable (no user bus): the unit is written and the answer says how to enable it.
  const s2 = world(t);
  const off = s2.cli(["revive", "service", "install"], { env: { SYSTEMCTL_FAIL: "1" } });
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /written but not enabled \(systemctl --user: Failed to connect to bus\)/);
  assert.equal(unitIsOurs(readFileSync(unitPath(s2.home), "utf8")), true);
  assert.equal(s.cli(["revive", "service", "start"]).code, 2);
});

test("revive service on macOS: writes the LaunchAgent in the person's own LaunchAgents, starts nothing, and uninstalls only after launchd lets go of the label", (t) => {
  const s = world(t, { os: "Darwin" });
  const uid = process.getuid();
  const plist = plistPath(s.home);
  const label = PLIST_LABEL;
  // The command as install.sh links it: what the agent runs.
  mkdirSync(join(s.home, ".local/bin"), { recursive: true });
  exe(join(s.home, ".local/bin/automagik-herdr"), "#!/bin/sh\nexit 0\n");
  assert.match(s.cli(["revive", "service", "status"]).out, /isn't installed/);
  assert.deepEqual(s.lcCalls(), [], "status asks launchd nothing");

  const r = s.cli(["revive", "service", "install", "--json"]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(plist, "utf8");
  assert.equal(plistIsOurs(text), true);
  assert.ok(text.includes(`<string>${join(s.home, ".local/bin/automagik-herdr")}</string>`), text);
  assert.ok(text.includes("<string>revive</string>") && text.includes("<string>--boot</string>"), text);
  assert.ok(text.includes(`<key>HERDR_APP_HOME</key><string>${s.app}</string>`), text);
  const installed = r.json();
  assert.equal(installed.enabled, true);
  assert.equal(installed.label, label);
  assert.equal(installed.path, plist);
  assert.ok(installed.kept_path.split(":").includes(join(s.home, ".local/bin")), installed.kept_path);
  assert.deepEqual(s.lcCalls(), [], "written only: never bootstrapped, so the pass never runs while the person is using the computer");
  assert.deepEqual(changes(s), [], "no pane was touched");
  const status = s.cli(["revive", "service", "status", "--json"]).json();
  assert.deepEqual([status.path, status.installed, status.ours, status.enabled, status.path_kept], [plist, true, true, true, true]);
  assert.match(s.cli(["revive", "service", "status"]).out, /Automagik Herdr's, runs at your next login/);

  // Not loaded yet (no login since the install): the file goes, and launchd is only asked first.
  const gone = s.cli(["revive", "service", "uninstall", "--json"]);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(existsSync(plist), false);
  assert.equal(gone.json().loaded, false);
  assert.deepEqual(s.lcCalls(), [`print gui/${uid}/${label}`]);
  assert.match(s.cli(["revive", "service", "status"]).out, /isn't installed/);

  // Loaded (a login ran it): bootout comes first, then the plist goes: no label is left behind.
  assert.equal(s.cli(["revive", "service", "install"]).code, 0);
  const u2 = s.cli(["revive", "service", "uninstall", "--json"], { env: { LAUNCHCTL_LOADED: "1" } });
  assert.equal(u2.code, 0, u2.err);
  assert.equal(u2.json().loaded, true);
  assert.equal(existsSync(plist), false);
  assert.deepEqual(s.lcCalls().slice(-2), [`print gui/${uid}/${label}`, `bootout gui/${uid}/${label}`]);

  // A bootout that fails while launchd holds the job: refused, and the plist is left whole.
  assert.equal(s.cli(["revive", "service", "install"]).code, 0);
  const before = readFileSync(plist, "utf8");
  const no = s.cli(["revive", "service", "uninstall"], { env: { LAUNCHCTL_LOADED: "1", LAUNCHCTL_BOOTOUT_FAIL: "1" } });
  assert.equal(no.code, 1);
  assert.match(no.err, /launchd still holds dev\.herdr\.automagik-herdr-revive and its bootout failed \(Boot-out failed: Input\/output error\), so .* was left in place/);
  assert.ok(no.err.includes(`launchctl bootout gui/${uid}/${label}`), no.err);
  assert.equal(readFileSync(plist, "utf8"), before, "no orphaned plist: it is left exactly as it was");

  // Someone else's plist at that path is left as it is, by install and by uninstall.
  writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n');
  for (const verb of ["install", "uninstall"]) {
    const theirs = s.cli(["revive", "service", verb]);
    assert.equal(theirs.code, 1);
    assert.match(theirs.err, /isn't one Automagik Herdr wrote, so it was left as it is/);
  }
  assert.match(readFileSync(plist, "utf8"), /<dict\/>/);
});

test("revive service uninstall on macOS refuses when launchctl print fails, whatever the failure; the plist stays and the command is named (#939)", (t) => {
  const s = world(t, { os: "Darwin" });
  const uid = process.getuid();
  const plist = plistPath(s.home);
  const command = ["launchctl", "bootout", `gui/${uid}/${PLIST_LABEL}`].join(" ");
  const cases = [
    ["exit 1", { LAUNCHCTL_PRINT_EXIT: "1", LAUNCHCTL_PRINT_TEXT: "print failed" }],
    ["exit 64", { LAUNCHCTL_PRINT_EXIT: "64", LAUNCHCTL_PRINT_TEXT: "usage: launchctl print <domain-target>" }],
    ["an I/O error", { LAUNCHCTL_PRINT_EXIT: "5", LAUNCHCTL_PRINT_TEXT: "Input/output error" }],
  ];
  for (const [why, env] of cases) {
    assert.equal(s.cli(["revive", "service", "install"]).code, 0);
    const before = readFileSync(plist, "utf8");
    const r = s.cli(["revive", "service", "uninstall"], { env });
    assert.notEqual(r.code, 0, `${why}: a failed probe is a refusal, not a removal`);
    assert.equal(readFileSync(plist, "utf8"), before, `${why}: the plist is left exactly as it was`);
    assert.ok(r.err.includes(command), `${why}: names the command that finishes by hand (${r.err})`);
  }
  // A launchctl that cannot be executed at all (EPERM/EACCES) is a refusal too, never a not-found.
  assert.equal(s.cli(["revive", "service", "install"]).code, 0);
  const lc = join(s.root, "bin", "launchctl");
  chmodSync(lc, 0o644);
  const denied = s.cli(["revive", "service", "uninstall"]);
  assert.notEqual(denied.code, 0, denied.err);
  assert.equal(existsSync(plist), true, "a permission failure is not a not-found");
  assert.ok(denied.err.includes(command), denied.err);
  chmodSync(lc, 0o755);
});

test("revive service uninstall on macOS reads only 113 or the exact 'Could not find service' as not loaded (#939)", (t) => {
  const s = world(t, { os: "Darwin" });
  const uid = process.getuid();
  const plist = plistPath(s.home);
  const cases = [
    ["exit 113", { LAUNCHCTL_PRINT_EXIT: "113", LAUNCHCTL_PRINT_TEXT: `Could not find service "${PLIST_LABEL}" in domain for user gui: ${uid}` }],
    ["exit 0 with the words", { LAUNCHCTL_PRINT_OUT: `Could not find service "${PLIST_LABEL}" in domain for user gui: ${uid}` }],
  ];
  for (const [why, env] of cases) {
    assert.equal(s.cli(["revive", "service", "install"]).code, 0);
    const asked = s.lcCalls().length;
    const r = s.cli(["revive", "service", "uninstall", "--json"], { env });
    assert.equal(r.code, 0, `${why}: ${r.err}`);
    assert.equal(r.json().loaded, false, why);
    assert.equal(existsSync(plist), false, why);
    assert.deepEqual(s.lcCalls().slice(asked), [`print gui/${uid}/${PLIST_LABEL}`], `${why}: not loaded, so no bootout`);
  }
});

test("revive service uninstall on macOS, with no plist, still asks launchd and boots out a label an earlier run left behind (#939)", (t) => {
  const s = world(t, { os: "Darwin" });
  const uid = process.getuid();
  const plist = plistPath(s.home);
  // What a run that removed the plist while launchd held the label left: no file, a loaded label.
  const r = s.cli(["revive", "service", "uninstall", "--json"], { env: { LAUNCHCTL_LOADED: "1" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().removed, r.json().loaded, r.json().booted_out], [false, true, true]);
  assert.equal(existsSync(plist), false);
  assert.deepEqual(s.lcCalls(), [`print gui/${uid}/${PLIST_LABEL}`, `bootout gui/${uid}/${PLIST_LABEL}`], "asked, then booted out");
  const said = s.cli(["revive", "service", "uninstall"], { env: { LAUNCHCTL_LOADED: "1" } });
  assert.equal(said.code, 0, said.err);
  assert.match(said.out, /plist is gone .*launchd still held .*booted it out/i);
  // And once launchd no longer holds it either, there is nothing left to say.
  const none = s.cli(["revive", "service", "uninstall"]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /isn't installed/);
});

test("revive service on macOS refuses when it cannot ask launchd, and on a system with no login service it says why and writes nothing", (t) => {
  const s = world(t, { os: "Darwin" });
  const plist = plistPath(s.home);
  assert.equal(s.cli(["revive", "service", "install"]).code, 0);
  assert.equal(existsSync(plist), true);
  // A PATH with only the fake uname: launchctl is nowhere, so no real one can be reached either.
  const bare = join(s.root, "bare-bin");
  mkdirSync(bare);
  exe(join(bare, "uname"), "#!/bin/sh\necho Darwin\n");
  const no = s.cli(["revive", "service", "uninstall"], { env: { PATH: bare } });
  assert.equal(no.code, 1);
  assert.match(no.err, /launchctl isn't here, so whether launchd holds dev\.herdr\.automagik-herdr-revive can't be read, and .* was left in place/);
  assert.equal(existsSync(plist), true, "removing it blind could orphan a loaded job");

  // Any other system: every verb refuses, naming the services that exist, and nothing is written.
  const other = world(t, { os: "FreeBSD" });
  for (const verb of ["install", "uninstall", "status"]) {
    const r = other.cli(["revive", "service", verb]);
    assert.equal(r.code, 1);
    assert.match(r.err, /The revive login service is built for Linux \(a systemd user unit\) and macOS \(a launchd agent\), not for FreeBSD: nothing was written or removed\./);
  }
  assert.equal(existsSync(join(other.home, "Library")), false);
  assert.equal(existsSync(join(other.home, ".config/systemd")), false);
});

// ---- #992 review ----

/** DSH session folders for the project, each born at its time. */
function dshSessions(s, rows, dshHome = join(s.home, ".dsh")) {
  const dir = dshSessionsDir(dshHome, s.project);
  for (const [id, at] of rows) { mkdirSync(join(dir, id), { recursive: true }); utimesSync(join(dir, id), at / 1000, at / 1000); }
}
const sessionLabels = (s) => s.calls().filter((c) => c[0] === "label" && c[2]?.startsWith("agent.session=")).map((c) => [c[1], c[2].slice("agent.session=".length)]);

test("a session from outside the ledger, born later and written last in the bot's folder, is never recorded as the bot's; the bot's own first one is", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"] })] });
  dshSessions(s, [[SID, born + 5000], [SID2, born + 600_000]]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), [["t5", SID]]);
  assert.ok(hasSeq(wordsOf(runsOf(s)[0]), ["--resume", SID]), runsOf(s)[0].join(" "));
});

test("only a later session from outside the ledger in the folder: nothing is recorded and the bot comes back on a new conversation", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"] })] });
  dshSessions(s, [[SID2, born + 600_000]]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), []);
  for (const run of runsOf(s)) assert.ok(!wordsOf(run).includes(SID2) && !wordsOf(run).includes("--resume") && !wordsOf(run).includes("-c"), run.join(" "));
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Genie", "fresh"]]);
});

test("an hc pane started by hand on that agent in the folder, in no ledger, is a rival: started near the bot's pane, no session is recorded", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"] }),
      pane("t7", { cwd: p, created: born - 30_000, front: ["dsh-tui"], argv: ["zsh"] })] });
  dshSessions(s, [[SID, born + 5000]]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), [], "the session may be the hand-started pane's");
  for (const run of runsOf(s)) assert.ok(!wordsOf(run).includes(SID), run.join(" "));
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Genie", "fresh"]]);
});

test("a recorded session is never replaced: a pane that holds an agent.session label keeps it whatever is found on disk later", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"], labels: { "agent.session": SID3 } })] });
  dshSessions(s, [[SID, born + 5000]]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), []);
  assert.ok(hasSeq(wordsOf(runsOf(s)[0]), ["--resume", SID3]), runsOf(s)[0].join(" "));
});

test("#1490: DSH's sessions are read under the seat's own $DSH_HOME, never the reviving process's", (t) => {
  const born = Date.now() - 3_600_000;
  const root = scratchRoot(t, "hb-revive-");
  const dshHome = join(root, "dsh-home");
  const decoyHome = join(root, "decoy-dsh");
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"], launchEnv: { DSH_HOME: dshHome } })] });
  dshSessions(s, [[SID, born + 5000]], dshHome);
  dshSessions(s, [[SID2, born + 6000]]); // ~/.dsh is not DSH's home here
  dshSessions(s, [[SID3, born + 5000]], decoyHome); // the reviving process's $DSH_HOME: never this
  const r = s.cli(["revive", "--json"], { env: { DSH_HOME: decoyHome } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), [["t5", SID]]);
});

test("a detached bot stays down: revive never brings it back, at a bare shell or with its pane gone, and --boot neither", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, front: ["claude"] }), pane("t6", { bot: ID.cap, cwd: p })],
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 1 }, { bot: ID.cap, terminal: "t6", created_ms: 1 }, { bot: ID.dev, terminal: "t44", created_ms: 9 },
      { event: "detach", bot: ID.cap, terminal: "t6", created_ms: 1, by: "detach", at: "2026-11-01T11:00:00.000Z" },
      { event: "detach", bot: ID.dev, terminal: "t44", created_ms: 9, by: "detach", at: "2026-11-01T11:00:00.000Z" }] });
  assert.deepEqual(s.attachRows().map((x) => x.event), ["attach", "attach", "attach", "detach", "detach"], "the ledger reads whole");
  for (const args of [["revive", "--json"], ["revive", "--boot", "--json"]]) {
    const r = s.cli(args, { env: { AUTOMAGIK_HERDR_BOOT_MS: String(Date.parse("2026-11-01T10:30:00.000Z")) } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(changes(s), [], args.join(" "));
  }
});

test("revive --boot prints counts only: no folder and no bot name reaches the user journal", (t) => {
  const s = world(t, { terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const r = s.cli(["revive", "--boot"], { env: { AUTOMAGIK_HERDR_BOOT_MS: String(Date.now() - 60_000) } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^revive: 1 resumed, 0 on a new conversation, 0 not back, 0 left alone, in 1 project;/);
  for (const text of [r.out, r.err]) for (const word of [s.project, s.home, s.root, "Genie", SID]) assert.ok(!text.includes(word), text);
  assert.equal(s.lastReport().projects[0].project, s.project, "the kept report still names the project");
});

// #1411: a reboot's recovery rebuilds a Codex seat from its record, the seat's own reasoning
// effort and service tier included.
test("#1411: revive passes a Codex seat's own effort and tier to its replacement pane", (t) => {
  const file = team({ main: { agent: "codex", effort: "high", tier: "fast" } });
  const s = world(t, { file, terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runsOf(s)[0];
  const words = wordsOf(run);
  assert.ok(hasSeq(words, ["-c", "model_reasoning_effort=high"]), run.join(" "));
  assert.ok(hasSeq(words, ["-c", "service_tier=priority"]), run.join(" "));
  assert.ok(hasSeq(words, ["resume", SID]), "resumed by its own id");
  assert.equal(r.out.includes(SID), false, "no session id printed");
});

// ---- #1417: Codex and Kimi, whose ids are found on disk after the launch ----

/** A version-7 UUID whose time is `ms`, as Codex makes its thread ids. */
const v7 = (ms, tail = "8abc-0123456789ab") => { const h = Math.trunc(ms).toString(16).padStart(12, "0"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-7def-${tail}`; };
const KID = "session_3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
const KID2 = "session_7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`; };

/** Writes a Codex rollout under `codexHome` (default ~/.codex): its first line a session_meta for `cwd`, filed under day `dayMs`. */
function codexRollout(s, { id, cwd, dayMs = Date.now(), codexHome = join(s.home, ".codex"), firstLine = null, rest = "" }) {
  const dir = join(codexSessionsDir(codexHome), localDay(dayMs));
  mkdirSync(dir, { recursive: true });
  const meta = firstLine ?? JSON.stringify({ timestamp: new Date(dayMs).toISOString(), type: "session_meta",
    payload: { id, session_id: id, timestamp: new Date(uuidV7Ms(id) ?? dayMs).toISOString(), cwd, base_instructions: { text: "the bot's briefing" } } });
  writeFileSync(join(dir, `rollout-2026-11-16T12-00-00-${id}.jsonl`), `${meta}\n${rest}`);
}

/** Writes Kimi's session index under `kimiHome` (default ~/.kimi-code), each row's session folder born at `at`. */
function kimiIndex(s, rows, kimiHome = join(s.home, ".kimi-code")) {
  mkdirSync(kimiHome, { recursive: true });
  const lines = [];
  for (const { id, at, workDir = s.project, deleted = false } of rows) {
    if (deleted) { lines.push(JSON.stringify({ sessionId: id, deleted: true })); continue; }
    const sessionDir = join(kimiHome, "sessions", "ws1", id);
    mkdirSync(sessionDir, { recursive: true });
    utimesSync(sessionDir, at / 1000, at / 1000);
    lines.push(JSON.stringify({ sessionId: id, sessionDir, workDir }));
  }
  writeFileSync(kimiIndexPath(kimiHome), `${lines.join("\n")}\n`);
}
const kimiBin = (s) => exe(join(s.root, "bin", "kimi"), "#!/bin/sh\nexit 0\n");

test("codexHomeOf, kimiHomeOf, uuidV7Ms, codexRolloutId: where Codex and Kimi keep their sessions, and the time a Codex id carries", () => {
  assert.equal(codexHomeOf("/home/u/", {}), "/home/u/.codex");
  assert.equal(codexHomeOf("/home/u", { CODEX_HOME: "/data/codex" }), "/data/codex", "an absolute $CODEX_HOME wins");
  assert.equal(codexHomeOf("/home/u", { CODEX_HOME: "relative" }), "/home/u/.codex");
  assert.equal(codexSessionsDir("/home/u/.codex/"), "/home/u/.codex/sessions");
  assert.equal(kimiHomeOf("/home/u", {}), "/home/u/.kimi-code");
  assert.equal(kimiHomeOf("/home/u", { KIMI_CODE_HOME: "/data/kimi" }), "/data/kimi");
  assert.equal(kimiHomeOf("/home/u", { KIMI_CODE_HOME: "kimi" }), "/home/u/.kimi-code");
  assert.equal(kimiIndexPath("/home/u/.kimi-code"), "/home/u/.kimi-code/session_index.jsonl");
  // Seen from codex-cli 0.169.0: the id's time is its session_meta timestamp.
  assert.equal(uuidV7Ms("01a1e509-07dc-7621-b3f2-733a5a470bdd"), Date.parse("2026-11-16T15:45:36.732Z"));
  assert.equal(uuidV7Ms(SID), null, "a version-4 UUID carries no time");
  assert.equal(uuidV7Ms("not-an-id"), null);
  const id = v7(1794843936732);
  assert.equal(codexRolloutId(`rollout-2026-11-16T12-45-36-${id}.jsonl`), id);
  assert.equal(codexRolloutId(`rollout-2026-11-16T12-45-36-${id}.json`), null);
  assert.equal(codexRolloutId("notes.jsonl"), null);
});

test("codexCandidate: a session_meta for one of the folders gives its id and its birth; another folder's is null; anything unreadable is undefined", () => {
  const id = v7(5_000_000);
  const meta = (payload, extra = {}) => JSON.stringify({ timestamp: "2026-11-16T15:45:36.813Z", type: "session_meta", payload, ...extra });
  assert.deepEqual(codexCandidate(meta({ id, timestamp: "2026-11-16T15:45:36.733Z", cwd: "/p", base_instructions: "secret" }), ["/p", "/q"]), { id, born: 5_000_000 });
  assert.equal(codexCandidate(meta({ id, timestamp: "2026-11-16T15:45:36.733Z", cwd: "/elsewhere" }), ["/p"]), null);
  // A version-4 id: the payload's timestamp, else the line's own.
  assert.deepEqual(codexCandidate(meta({ id: SID, timestamp: "2026-11-16T15:45:36.733Z", cwd: "/p" }), ["/p"]), { id: SID, born: Date.parse("2026-11-16T15:45:36.733Z") });
  assert.deepEqual(codexCandidate(meta({ id: SID, cwd: "/p" }), ["/p"]), { id: SID, born: Date.parse("2026-11-16T15:45:36.813Z") });
  for (const bad of ["{torn", "", meta({ id: "--last", cwd: "/p" }), meta({ cwd: "/p" }), JSON.stringify({ type: "response_item", payload: { id, cwd: "/p" } })]) {
    assert.equal(codexCandidate(bad, ["/p"]), undefined, bad);
  }
  assert.ok(!JSON.stringify(codexCandidate(meta({ id, cwd: "/p", base_instructions: "secret" }), ["/p"])).includes("secret"), "only id and time are kept");
});

test("kimiCandidates: the index replayed in order, a deleted id dropped, other folders' and bad ids left out, a session folder only under Kimi's own sessions", () => {
  const home = "/home/u/.kimi-code";
  const row = (o) => JSON.stringify(o);
  const text = [
    row({ sessionId: KID, sessionDir: `${home}/sessions/w/${KID}`, workDir: "/p" }),
    row({ sessionId: KID2, sessionDir: `${home}/sessions/w/${KID2}`, workDir: "/p" }),
    row({ sessionId: KID2, deleted: true }),
    row({ sessionId: KID, sessionDir: `${home}/sessions/w2/${KID}`, workDir: "/p" }), // a later row for the same id wins
    row({ sessionId: "session_nope", sessionDir: `${home}/sessions/w/x`, workDir: "/p" }),
    row({ sessionId: `session_${SID}`, sessionDir: `${home}/sessions/w/session_${SID}`, workDir: "/q" }),
    row({ sessionId: `session_${SID2}`, sessionDir: `${home}/sessions/../../.ssh`, workDir: "/p" }),
    row({ sessionId: `session_${SID3}`, sessionDir: "/tmp/elsewhere", workDir: "/p" }),
    row({ sessionId: `session_${SID4}`, sessionDir: `${home}/sessions`, workDir: "/p" }),
    row({ sessionId: "session_22222222-3333-4444-8555-666666666666", sessionDir: `${home}/sessions/w/another`, workDir: "/p" }),
    "{torn", "",
  ].join("\n");
  assert.deepEqual(kimiCandidates(text, ["/p"], home), [{ id: KID, sessionDir: `${home}/sessions/w2/${KID}` }]);
  assert.deepEqual(kimiCandidates(text, ["/q"], home), [{ id: `session_${SID}`, sessionDir: `${home}/sessions/w/session_${SID}` }], "a folder not named by its id is refused");
  assert.deepEqual(kimiCandidates("", ["/p"], home), []);
});

test("pickSession takes Kimi's session_<uuid> ids as it takes UUIDs, and no other shape", () => {
  assert.equal(pickSession({ createdMs: 1_000_000, candidates: [{ id: KID, born: 1_001_000 }] }), KID);
  for (const id of ["session_nope", "session-" + SID, `x${KID}`, "--last"]) assert.equal(pickSession({ createdMs: 1_000_000, candidates: [{ id, born: 1_001_000 }] }), null, id);
});

test("#1417 revive: a Codex bot at a bare shell is resumed by the id its rollout holds, though its first turn wrote it a day after the launch; the id is never printed", (t) => {
  const born = Date.now() - 2 * 86_400_000;
  const id = v7(born + 3000);
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "herdr.space": "sp1" } })] });
  codexRollout(s, { id, cwd: s.project, dayMs: born + 86_400_000 });
  // Another folder's thread from the same moment, and an older one of this folder: never this pane's.
  codexRollout(s, { id: v7(born + 4000, "9abc-0123456789ab"), cwd: "/elsewhere", dayMs: born + 86_400_000 });
  codexRollout(s, { id: v7(born - 86_400_000), cwd: s.project, dayMs: born - 86_400_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), [["t5", id]]);
  assert.deepEqual(s.ledger().filter((x) => x.event === "session").map((x) => [x.terminal, x.session, x.agent]), [["t5", id, "codex"], ["t100", id, "codex"]]);
  const run = runsOf(s)[0];
  assert.ok(hasSeq(wordsOf(run), ["resume", id]), run.join(" "));
  assert.ok(!wordsOf(run).includes("--last"), run.join(" "));
  assert.ok(run.includes(`agent.session=${id}`), "the next restart finds it on the new pane");
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Lead", "resumed"]]);
  for (const text of [r.out, r.err, s.hcState().sent[0].text, JSON.stringify(s.lastReport())]) assert.ok(!text.includes(id), text);
});

test("#1417 revive: a Codex bot whose pane is gone whole comes back by its seat row and its rollout, under the seat's own $CODEX_HOME", (t) => {
  const born = Date.now() - 3_600_000;
  const id = v7(born + 5000);
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }), attach: () => [{ bot: ID.main, terminal: "t5", created_ms: born }] });
  const codexHome = join(s.root, "codex-home");
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t5", botId: ID.main, project: s.project, worktree: s.project,
    agent: "codex", core: CORE, created_ms: born, env: { HOME: s.home, CODEX_HOME: codexHome }, at: new Date(born).toISOString() })}\n`, { mode: 0o600 });
  codexRollout(s, { id, cwd: s.project, codexHome });
  codexRollout(s, { id: v7(born + 6000, "9abc-0123456789ab"), cwd: s.project }); // ~/.codex is not Codex's home here
  const r = s.cli(["revive", "--json"], { env: { CODEX_HOME: join(s.root, "decoy-codex") } });
  assert.equal(r.code, 0, r.err);
  const run = runsOf(s)[0];
  assert.ok(hasSeq(wordsOf(run), ["resume", id]), run.join(" "));
  assert.equal(cwdOf(run), s.project);
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome, x.terminal]), [["Lead", "resumed", "t100"]]);
});

test("#1417 revive: a Kimi bot at a bare shell is resumed by the session its index ties to the folder (--session=), never another's", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "kimi", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["kimi"] })] });
  kimiBin(s);
  kimiIndex(s, [{ id: KID2, at: born - 86_400_000 }, { id: KID, at: born + 4000 }, { id: `session_${SID}`, at: born + 4500, workDir: "/elsewhere" }]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), [["t5", KID]]);
  const run = runsOf(s)[0];
  assert.ok(wordsOf(run).includes(`--session=${KID}`), run.join(" "));
  assert.ok(!wordsOf(run).includes("--continue"), run.join(" "));
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["Lead", "resumed"]]);
  for (const text of [r.out, r.err, s.hcState().sent[0].text, JSON.stringify(s.lastReport())]) assert.ok(!text.includes(KID), text);
});

test("#1417 revive: two Codex bots started together in one folder can't be told apart: no id is recorded and each comes back on a new conversation, said", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" }, cap: { agent: "codex" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] }), pane("t6", { bot: ID.cap, cwd: p, created: born + 500, argv: ["codex"] })] });
  writeFileSync(ledgerPath(s.app), [["t5", ID.main, born], ["t6", ID.cap, born + 500]].map(([terminal, botId, created_ms]) =>
    `${JSON.stringify({ event: "start", kind: "seat", terminal, botId, project: s.project, worktree: s.project, agent: "codex", core: CORE, created_ms, at: new Date(created_ms).toISOString() })}\n`).join(""), { mode: 0o600 });
  codexRollout(s, { id: v7(born + 1500), cwd: s.project });
  codexRollout(s, { id: v7(born + 2500, "9abc-0123456789ab"), cwd: s.project });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), [], "no id guessed");
  for (const run of runsOf(s)) assert.ok(!wordsOf(run).includes("resume") && !wordsOf(run).includes("--last"), run.join(" "));
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["Lead", "fresh"], ["Captain", "fresh"]]);
  assert.match(results[0].why, /no Codex conversation of its own could be identified for t5/);
});

test("#1417 revive never guesses a Codex or Kimi bot's latest conversation: alone in its folder with no session of its own, it starts new and says so", (t) => {
  const born = Date.now() - 3_600_000;
  for (const agent of ["codex", "kimi"]) {
    const s = world(t, { file: team({ main: { agent, name: "Lead" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: [agent] })] });
    if (agent === "kimi") kimiBin(s);
    const r = s.cli(["revive", "--json"]);
    assert.equal(r.code, 0, r.err);
    const run = runsOf(s)[0];
    // codex's -c is --config; kimi's -c is --continue.
    for (const w of agent === "codex" ? ["resume", "--last"] : ["--continue", "-c"]) assert.ok(!wordsOf(run).includes(w), `${agent}: ${run.join(" ")}`);
    assert.ok(!wordsOf(run).some((w) => w.startsWith("--session")), `${agent}: ${run.join(" ")}`);
    const res = r.json().projects[0].results[0];
    assert.deepEqual([res.name, res.outcome], ["Lead", "fresh"]);
    assert.match(res.why, new RegExp(`no ${agent === "codex" ? "Codex" : "Kimi"} conversation of its own could be identified for t5, so its folder's latest one was not guessed`));
    assert.match(s.hcState().sent[0].text, /Back on a new conversation: Lead \(t100\), no .* conversation of its own could be identified/);
  }
});

test("#1417: a restart by hand keeps its fallback for a Codex bot alone in its folder with no id (resume --last)", (t) => {
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: Date.now() - 3_600_000, front: ["codex"], argv: ["codex"], status: "idle" })] });
  const r = s.cli(["restart", "Lead", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(hasSeq(wordsOf(runsOf(s)[0]), ["resume", "--last"]), runsOf(s)[0].join(" "));
});

test("#1417 fails closed: an unreadable or oversized rollout of the launch's moment, or an oversized Kimi index, records nothing", (t) => {
  const born = Date.now() - 3_600_000;
  for (const firstLine of ["{torn", `{"type":"session_meta","payload":{"id":"x","pad":"${"y".repeat(1024 * 1024 + 10)}"}}`]) {
    const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] })] });
    codexRollout(s, { id: v7(born + 1000), cwd: s.project });
    codexRollout(s, { id: v7(born + 2000, "9abc-0123456789ab"), cwd: s.project, firstLine }); // may be a rival's: nothing is taken
    const r = s.cli(["revive", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(sessionLabels(s), []);
    assert.deepEqual(r.json().projects[0].results.map((x) => x.outcome), ["fresh"]);
  }
  // A rollout far from the launch is never opened: its torn line changes nothing.
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] })] });
  const id = v7(born + 1000);
  codexRollout(s, { id, cwd: s.project });
  codexRollout(s, { id: v7(born + 900_000, "9abc-0123456789ab"), cwd: s.project, firstLine: "{torn" });
  const ok = s.cli(["revive", "--json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), [["t5", id]]);
  // Kimi's index over its 16 MiB cap.
  const k = world(t, { file: team({ main: { agent: "kimi", name: "Lead" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["kimi"] })] });
  kimiBin(k);
  kimiIndex(k, [{ id: KID, at: born + 4000 }]);
  writeFileSync(kimiIndexPath(join(k.home, ".kimi-code")), `\n${" ".repeat(16 * 1024 * 1024)}`, { flag: "a" });
  const rk = k.cli(["revive", "--json"]);
  assert.equal(rk.code, 0, rk.err);
  assert.deepEqual(sessionLabels(k), []);
  assert.deepEqual(rk.json().projects[0].results.map((x) => x.outcome), ["fresh"]);
});

test("#1417: a Kimi session folder that is a symlink, or is gone, is never taken", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "kimi", name: "Lead" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["kimi"] })] });
  kimiBin(s);
  const kimiHome = join(s.home, ".kimi-code");
  kimiIndex(s, [{ id: KID, at: born + 4000 }]);
  const real = join(s.root, "elsewhere-session");
  mkdirSync(real);
  utimesSync(real, (born + 3000) / 1000, (born + 3000) / 1000);
  const linked = join(kimiHome, "sessions", "ws1", KID2);
  symlinkSync(real, linked);
  writeFileSync(kimiIndexPath(kimiHome), `${JSON.stringify({ sessionId: KID2, sessionDir: linked, workDir: s.project })}\n`
    + `${JSON.stringify({ sessionId: `session_${SID}`, sessionDir: join(kimiHome, "sessions", "ws1", `session_${SID}`), workDir: s.project })}\n`, { flag: "a" });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), [["t5", KID]], "only the real folder counts");
});

// ---- #1490: a seat claims only its own launch's conversation; the search root is its own ----

test("#1490 launchEnvOf, seatHomeOf, launchHomeEnv, seatHomesRecorded: the search root is the seat's own launch record", () => {
  const launch = ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "PATH=/bin", "HOME=/home/u", "CODEX_HOME=/data/codex", "codex"];
  assert.deepEqual(launchEnvOf(launch), { HOME: "/home/u", CODEX_HOME: "/data/codex" });
  assert.deepEqual(launchEnvOf(["/usr/bin/env", "PATH=/bin", "codex", "--home=/elsewhere"]), {}, "only the env prefix is read");
  assert.deepEqual(launchEnvOf(["codex"]), {});
  assert.deepEqual(seatHomeOf("codex", { argv: launch }), { home: "/home/u", env: { HOME: "/home/u", CODEX_HOME: "/data/codex" } });
  // The launch record stands in when the pane's argv names none; the argv's own words win.
  assert.deepEqual(seatHomeOf("kimi", { argv: ["kimi"], record: { env: { HOME: "/r", KIMI_CODE_HOME: "/k" } } }),
    { home: "/r", env: { HOME: "/r", KIMI_CODE_HOME: "/k" } });
  assert.deepEqual(seatHomeOf("kimi", { argv: ["/usr/bin/env", "HOME=/a", "kimi"], record: { env: { HOME: "/r" } } }).env, { HOME: "/a" });
  // Antigravity's history lives under HOME alone: another agent's override isn't its search root.
  assert.equal(seatHomeOf("antigravity", { argv: ["/usr/bin/env", "CODEX_HOME=/c", "agy"] }), null);
  // Unknown (relative or absent) is unknown: the search fails closed.
  assert.equal(seatHomeOf("codex", { argv: ["/usr/bin/env", "CODEX_HOME=relative", "codex"] }), null);
  assert.equal(seatHomeOf("codex", { argv: ["codex"], record: null }), null);
  assert.deepEqual(launchHomeEnv("codex", { HOME: "/home/u/", CODEX_HOME: "relative", DSH_HOME: "/d" }), { HOME: "/home/u" });
  assert.deepEqual(launchHomeEnv("dsh-tui", { HOME: "/h", DSH_HOME: "/d/" }), { HOME: "/h", DSH_HOME: "/d" });
  assert.equal(seatHomesRecorded([{ event: "start", env: { HOME: "/h" } }]), true);
  assert.equal(seatHomesRecorded([{ event: "start", env: { HOME: "relative" } }, { event: "session", session: SID }]), false);
  assert.deepEqual(launchEnvOf(["codex", "exec", "env", "HOME=/x"]), {});
  assert.deepEqual(launchEnvOf(["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", "/usr/bin/env", "HOME=/a", "codex"]), { HOME: "/a" });
  assert.deepEqual(launchEnvOf(["env", "-u", "CODEX_HOME", "HOME=/a", "codex"]), { CODEX_HOME: null, HOME: "/a" });
  assert.deepEqual(launchEnvOf(["env", "--unset=CODEX_HOME", "codex"]), { CODEX_HOME: null });
  assert.deepEqual(launchEnvOf(["env", "-uCODEX_HOME", "codex"]), { CODEX_HOME: null });
  assert.deepEqual(launchEnvOf(["env", "-i", "HOME=/a", "codex"]), { HOME: "/a", DSH_HOME: null, CODEX_HOME: null, KIMI_CODE_HOME: null });
  assert.equal(launchEnvOf(["env", "-S", "HOME=/a codex"]), null);
  assert.deepEqual(seatHomeOf("codex", { argv: ["env", "-u", "CODEX_HOME", "HOME=/a", "codex"], record: { env: { CODEX_HOME: "/k" } } }),
    { home: "/a", env: { HOME: "/a" } });
  assert.equal(seatHomeOf("codex", { argv: ["env", "-i", "codex"], record: { env: { HOME: "/r" } } }), null);
  assert.equal(seatHomeOf("codex", { argv: ["env", "-S", "x"], record: { env: { HOME: "/r" } } }), null);
  assert.equal(latestResumeIn("codex", "codex resume --last"), "--last");
  assert.equal(latestResumeIn("kimi", 'exec kimi --continue "$@"'), "--continue");
  assert.equal(latestResumeIn("kimi", "kimi"), null);
  assert.equal(latestResumeIn("dsh-tui", "dsh-tui -c"), null);
});

test("#1490 pickSession: an older rival far from the launch never blocks the seat's one window session (#1499); two candidates or a claimed id give nothing; the accepted residual (#1619)", () => {
  const c = (id, born) => ({ id, born });
  const T = 10_000_000;
  const old = { created_ms: T - 10 * FIRST_SESSION_MS };
  const own = c(SID, T + 800), other = c(SID2, T + 20_000);
  assert.equal(pickSession({ createdMs: T, candidates: [own], rivals: [old] }), SID);
  assert.equal(pickSession({ createdMs: T, candidates: [own], rivals: [{ ...old, live: true }] }), SID);
  assert.equal(pickSession({ createdMs: T, candidates: [own, other], rivals: [old] }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [own], claimed: new Set([SID]) }), null);
  assert.equal(pickSession({ createdMs: T, candidates: [own, other], rivals: [old], claimed: new Set([SID2]) }), SID);
  // owner-accepted (#1619); README What stays unknowable
  assert.equal(pickSession({ createdMs: T, candidates: [other], rivals: [old] }), SID2);
});

test("#1490 a session file is read only when it is a regular file and didn't change under the read", (t) => {
  const root = scratchRoot(t, "hb-revive-");
  const text = `${JSON.stringify({ type: "session_meta", payload: { id: SID } })}\n`;
  const file = join(root, "rollout-a.jsonl");
  writeFileSync(file, text);
  assert.equal(firstLineTrusted(file), JSON.stringify({ type: "session_meta", payload: { id: SID } }));
  // A symlink is refused, never followed.
  const link = join(root, "rollout-link.jsonl");
  symlinkSync(file, link);
  assert.equal(firstLineTrusted(link), null);
  // A file renamed over the path under the read is refused.
  const swapped = join(root, "rollout-b.jsonl");
  writeFileSync(swapped, text);
  const replacement = join(root, "rollout-new.jsonl");
  writeFileSync(replacement, "other\n");
  assert.equal(firstLineTrusted(swapped, { afterOpen: () => renameSync(replacement, swapped) }), null);
  // A file rewritten shorter under the read is refused too.
  const rewritten = join(root, "rollout-c.jsonl");
  writeFileSync(rewritten, text);
  assert.equal(firstLineTrusted(rewritten, { afterOpen: () => writeFileSync(rewritten, "x\n") }), null);
  assert.equal(firstLineTrusted(file, { afterOpen: () => {
    const moved = `${file}.moved`;
    renameSync(file, moved);
    symlinkSync(moved, file);
  } }), null);
});

test("#1490 a session file replaced inside the read is refused for the rest of the pass", (t) => {
  const root = scratchRoot(t, "hb-revive-");
  const file = join(root, "rollout.jsonl"), replacement = join(root, "replacement.jsonl");
  writeFileSync(file, "old\n");
  writeFileSync(replacement, "other\n");
  const reads = passReads();
  const read = (f) => {
    const got = firstLineWithIdentity(f);
    renameSync(replacement, f);
    return got;
  };
  assert.equal(reads.once(file, read), "old");
  assert.equal(reads.once(file, firstLineWithIdentity), null);
  assert.equal(reads.once(file, firstLineWithIdentity), null);
  reads.reset();
  assert.equal(reads.once(file, firstLineWithIdentity), "other");
});

test("#1490 revive: two Codex seats far apart in one folder; the later seat's window holds its own thread and the older seat's /new: it takes neither (two candidates)", (t) => {
  const born = Date.now() - 3_600_000;
  const aId = v7(born + 1000, "8abc-0123456789ab");
  const own = v7(born + 183_000, "7abc-0123456789ab");
  const newId = v7(born + 200_000, "9abc-0123456789ab"); // A's /new, born inside B's window
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": aId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["codex"] }),
    ] });
  codexRollout(s, { id: aId, cwd: s.project, dayMs: born });
  codexRollout(s, { id: own, cwd: s.project, dayMs: born + 183_000 });
  codexRollout(s, { id: newId, cwd: s.project, dayMs: born + 200_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const aRun = runFor(s, ID.main), bRun = runFor(s, ID.cap);
  assert.ok(hasSeq(wordsOf(aRun), ["resume", aId]), aRun.join(" "));
  assert.ok(!wordsOf(bRun).includes("resume") && !wordsOf(bRun).includes("--last"), bRun.join(" "));
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => ["t6", "t101"].includes(terminal)), [], "B takes no id");
  assert.ok(!sessionLabels(s).some(([, id]) => id === newId), "the later thread is never recorded");
  const results = r.json().projects[0].results;
  assert.equal(labelOf(runFor(s, ID.cap), "agent.session"), undefined);
  assert.ok(!s.ledger().some((row) => [own, newId].includes(row.session) && ["t6", results[1].terminal].includes(row.terminal)));
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["A", "resumed"], ["B", "fresh"]]);
  assert.match(results[1].why, /no Codex conversation of its own could be identified for t6/);
  for (const text of [r.out, r.err, JSON.stringify(s.lastReport())]) assert.ok(!text.includes(newId), text);
});

test("#1490 revive: a rival's recorded id is never claimed by another seat (a near rival)", (t) => {
  const born = Date.now() - 3_600_000;
  const rivalId = v7(born + 1000, "8abc-0123456789ab");
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": rivalId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 500, argv: ["codex"] }),
    ] });
  codexRollout(s, { id: rivalId, cwd: s.project, dayMs: born + 1000 }); // born inside B's window
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!sessionLabels(s).some(([terminal, id]) => ["t6", "t101"].includes(terminal) && id === rivalId));
  assert.ok(!wordsOf(runFor(s, ID.cap)).includes(rivalId));
  assert.deepEqual(r.json().projects[0].results.map((x) => [x.name, x.outcome]), [["A", "resumed"], ["B", "fresh"]]);
});

test("#1499 revive: an unlabelled Codex seat beside an older live Codex seat keeps its own launch-window thread", (t) => {
  const born = Date.now() - 3_600_000;
  const aId = v7(born + 1000), own = v7(born + 183_000, "7abc-0123456789ab");
  const newId = v7(born + 400_000, "9abc-0123456789ab");
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": aId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["codex"] }),
    ] });
  codexRollout(s, { id: aId, cwd: s.project, dayMs: born + 1000 });
  codexRollout(s, { id: own, cwd: s.project, dayMs: born + 183_000 });
  codexRollout(s, { id: newId, cwd: s.project, dayMs: born + 400_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionOn(s, "t6"), [own]);
  const run = runFor(s, ID.cap);
  assert.ok(hasSeq(wordsOf(run), ["resume", own]), run.join(" "));
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["A", "resumed"], ["B", "resumed"]]);
  assert.ok(s.ledger().some((row) => row.event === "session" && row.terminal === "t6" && row.session === own));
  assert.ok(!sessionOn(s, results[1].terminal).includes(newId));
  assert.notEqual(labelOf(run, "agent.session"), newId);
  assert.ok(!run.some((word) => word.includes(newId)));
  assert.ok(!s.ledger().some((row) => row.session === newId && ["t6", results[1].terminal].includes(row.terminal)));
  for (const output of [r.out, r.err, JSON.stringify(s.lastReport())]) {
    for (const id of [aId, own, newId]) assert.ok(!output.includes(id), output);
  }
});

test("#1499 revive: a Kimi seat beside an older live Kimi seat keeps its session born in its window", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "kimi", name: "A" }, cap: { agent: "kimi", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["kimi"], labels: { "agent.session": KID2 } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["kimi"] }),
    ] });
  kimiBin(s);
  kimiIndex(s, [{ id: KID2, at: born + 1000 }, { id: KID, at: born + 183_000 }]);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runFor(s, ID.cap);
  assert.ok(wordsOf(run).includes(`--session=${KID}`), run.join(" "));
  assert.deepEqual(sessionOn(s, "t6"), [KID]);
  assert.equal(r.json().projects[0].results[1].outcome, "resumed");
});

test("#1490 revive: an older seat's claimed thread born in the later seat's window is never taken", (t) => {
  const born = Date.now() - 3_600_000;
  const newId = v7(born + 183_000);
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": newId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["codex"] }),
    ] });
  codexRollout(s, { id: newId, cwd: s.project, dayMs: born + 183_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(hasSeq(wordsOf(runFor(s, ID.main)), ["resume", newId]));
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["A", "resumed"], ["B", "fresh"]]);
  assert.match(results[1].why, /no Codex conversation of its own could be identified for t6/);
  assert.deepEqual(sessionOn(s, "t6"), []);
  const run = runFor(s, ID.cap);
  assert.ok(!wordsOf(run).includes(newId), run.join(" "));
  assert.equal(labelOf(run, "agent.session"), undefined);
  assert.ok(!s.ledger().some((row) => row.session === newId && ["t6", results[1].terminal].includes(row.terminal)));
});

test("#1490 revive: with an older seat's claimed thread beside its own, the seat resumes its own; a pane started after that birth can't own it", (t) => {
  const born = Date.now() - 3_600_000;
  const newId = v7(born + 183_000), own = v7(born + 182_000, "7abc-0123456789ab");
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": newId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["codex"] }),
      pane("t7", { cwd: p, created: born + 300_000, front: ["codex"], argv: ["codex"] }),
    ] });
  codexRollout(s, { id: newId, cwd: s.project, dayMs: born + 183_000 });
  codexRollout(s, { id: own, cwd: s.project, dayMs: born + 182_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const b = r.json().projects[0].results[1];
  const run = runFor(s, ID.cap);
  assert.ok(hasSeq(wordsOf(run), ["resume", own]), run.join(" "));
  assert.ok(labelOf(run, "agent.session") === own || sessionOn(s, b.terminal).includes(own));
  assert.ok(s.ledger().some((row) => row.event === "session" && row.session === own && ["t6", b.terminal].includes(row.terminal)));
  assert.equal(b.outcome, "resumed");
});

test("#1490 revive: an id another live pane's label holds is never taken, whatever folder or agent that pane shows", (t) => {
  const born = Date.now() - 3_600_000;
  const own = v7(born + 2000);
  const s = world(t, { file: team({ main: { agent: "codex", name: "B" } }),
    terminals: (p, { root }) => [
      pane("t6", { bot: ID.main, cwd: p, created: born, argv: ["codex"] }),
      pane("t7", { cwd: join(root, "elsewhere"), created: born, front: ["claude"], argv: ["claude"], labels: { "agent.session": own } }),
    ] });
  codexRollout(s, { id: own, cwd: s.project, dayMs: born + 2000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().projects[0].results[0].outcome, "fresh");
  assert.deepEqual(sessionOn(s, "t6"), []);
  assert.ok(!runFor(s, ID.main).some((word) => word.includes(own)));
});

test("#1490 revive: a live pane hc can't read, or reads incompletely, leaves ownership unresolved", (t) => {
  const born = Date.now() - 3_600_000;
  const own = v7(born + 2000);
  for (const hcExtra of [{ failGet: ["t7"], failGetExit: 3 }, { failGet: ["t7"] }, { getReply: { t7: { address: "t7" } } }]) {
    const s = world(t, { file: team({ main: { agent: "codex", name: "B" } }), hcExtra,
      terminals: (p) => [
        pane("t6", { bot: ID.main, cwd: p, created: born, argv: ["codex"] }),
        pane("t7", { cwd: p, created: born, front: ["zsh"], argv: ["zsh"] }),
      ] });
    codexRollout(s, { id: own, cwd: s.project, dayMs: born + 2000 });
    const r = s.cli(["revive", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(sessionOn(s, "t6"), [], JSON.stringify(hcExtra));
    assert.ok(!runFor(s, ID.main).some((word) => word.includes(own)), JSON.stringify(hcExtra));
    assert.equal(r.json().projects[0].results[0].outcome, "fresh", JSON.stringify(hcExtra));
  }
});

test("#1490 revive --tree: a Codex and a Kimi helper with no recorded id start fresh, never the folder's latest; a manual restart keeps its fallback", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "claude", name: "Lead" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, labels: { "agent.session": SID } }),
      pane("t8", { cwd: p, created: born + 1000, parent: "t5", front: ["codex"], argv: ["codex"], status: "idle",
        labels: { "worker.of": ID.main, "worker.role": "dev" } }),
      pane("t9", { cwd: p, created: born + 2000, parent: "t5", front: ["kimi"], argv: ["kimi"], status: "idle",
        labels: { "worker.of": ID.main, "worker.role": "review" } }),
    ] });
  kimiBin(s);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const helpers = r.json().projects[0].results[0].helpers;
  assert.deepEqual(helpers.map((h) => [h.name, h.outcome]), [["t8", "fresh"], ["t9", "fresh"]], r.json().projects[0].results[0].why);
  const codexRun = runNamed(s, "t8"), kimiRun = runNamed(s, "t9");
  assert.ok(codexRun && kimiRun, JSON.stringify(runsOf(s)));
  assert.ok(!wordsOf(codexRun).includes("resume") && !wordsOf(codexRun).includes("--last"), codexRun.join(" "));
  assert.ok(!wordsOf(kimiRun).includes("--continue") && !wordsOf(kimiRun).includes("-c"), kimiRun.join(" "));
  assert.match(helpers[0].why ?? "", /no Codex conversation of its own could be identified for t8/);
  assert.match(helpers[1].why ?? "", /no Kimi conversation of its own could be identified for t9/);

  // A manual restart (not revive) keeps the pre-existing fallback: codex resume --last.
  const m = world(t, { file: team({ main: { agent: "claude", name: "Lead" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, front: ["claude"], argv: ["claude"], status: "idle", labels: { "agent.session": SID } }),
      pane("t8", { cwd: p, created: born + 1000, parent: "t5", front: ["codex"], argv: ["codex"], status: "idle",
        labels: { "worker.of": ID.main, "worker.role": "dev" } }),
    ] });
  const mr = m.cli(["restart", "Lead", "--tree", "--json"]);
  assert.equal(mr.code, 0, mr.err + mr.out);
  const manualRun = runNamed(m, "t8");
  assert.ok(manualRun && hasSeq(wordsOf(manualRun), ["resume", "--last"]), manualRun?.join(" "));
});

test("#1490 revive --tree: a helper's launch home comes only from its own launch's worker row, never a reused terminal's", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "claude", name: "Lead" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, labels: { "agent.session": SID } }),
      pane("t8", { cwd: p, created: born + 1000, parent: "t5", front: ["codex"], argv: ["codex"], status: "idle", noHome: true,
        labels: { "worker.of": ID.main, "worker.role": "dev" } }),
    ] });
  const decoy = join(s.root, "decoy-home"), codexHome = join(decoy, ".codex");
  const old = born - 500_000;
  writeFileSync(ledgerPath(s.app), `${JSON.stringify({ event: "start", kind: "worker", terminal: "t8", botId: ID.main,
    project: s.project, worktree: s.project, agent: "codex", core: CORE, created_ms: old,
    at: new Date(old).toISOString(), env: { HOME: decoy, CODEX_HOME: codexHome } })}\n`, { mode: 0o600 });
  const id = v7(born + 2000);
  codexRollout(s, { id, cwd: s.project, dayMs: born + 2000, codexHome });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const helper = r.json().projects[0].results[0].helpers[0];
  assert.equal(helper.outcome, "fresh");
  assert.match(helper.why, /no Codex conversation of its own could be identified for t8/);
  const run = runNamed(s, "t8");
  assert.ok(!wordsOf(run).some((word) => word === `HOME=${decoy}` || word.startsWith("CODEX_HOME=") || word.includes(id)), run.join(" "));
  const newTerminal = s.hcState().terminals.find((pane) => pane.name === "t8" && pane.state === "live").address;
  const start = s.ledger().find((row) => row.event === "start" && row.kind === "worker" && row.terminal === newTerminal);
  assert.ok(start);
  assert.equal(Object.hasOwn(start, "env"), false);
});

test("#1490 revive --tree: a helper whose own command names its latest flag isn't started; one that doesn't runs as written", (t) => {
  const born = Date.now() - 3_600_000;
  const fixture = { file: team({ main: { agent: "claude", name: "Lead" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, labels: { "agent.session": SID }, status: "idle" }),
      pane("t8", { cwd: p, created: born + 1000, parent: "t5", front: ["zsh"], argv: ["sh", "-c", "kimi --continue"], status: "idle" }),
      pane("t9", { cwd: p, created: born + 2000, parent: "t5", front: ["zsh"], argv: ["sh", "-c", "kimi"], status: "idle" }),
      pane("t10", { cwd: p, created: born + 3000, parent: "t5", front: ["zsh"], argv: ["sh", "-c", "codex resume --last"], status: "idle",
        labels: { "worker.of": ID.main, "worker.role": "dev", "worker.template": "tpl" } }),
    ] };
  const s = world(t, fixture);
  kimiBin(s);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 1, r.err + r.out);
  const helpers = r.json().projects[0].results[0].helpers;
  const [held, fresh, template] = ["t8", "t9", "t10"].map((name) => helpers.find((h) => h.name === name));
  assert.equal(runNamed(s, "t8"), undefined);
  assert.equal(held.outcome, "failed");
  assert.match(held.why, /names --continue, which resumes its folder's latest Kimi conversation/);
  const hand = s.lastReport().projects[0].results[0].helpers.find((h) => h.name === "t8").by_hand;
  assert.match(hand, /^hc run .* -- \S*env PATH=\S+ sh -c 'kimi --continue'$/);
  assert.ok(hasSeq(wordsOf(runNamed(s, "t9")), ["sh", "-c", "kimi"]));
  assert.equal(fresh.outcome, "fresh");
  assert.equal(runNamed(s, "t10"), undefined);
  assert.equal(template.outcome, "failed");

  const manual = world(t, fixture);
  kimiBin(manual);
  const restarted = manual.cli(["restart", "Lead", "--tree", "--json"]);
  const run = runNamed(manual, "t8");
  assert.ok(run && hasSeq(wordsOf(run), ["sh", "-c", "kimi --continue"]), restarted.err + restarted.out);
});

test("#1490 legacy inputs: dev's pre-#1490 inputs (the reviving process's home, no recorded home) start new once, said", (t) => {
  const born = Date.now() - 3_600_000;
  const dsh = world(t, { file: team({ main: { agent: "dsh-tui" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"], noHome: true })] });
  const dshHome = join(dsh.root, "dsh-home");
  dshSessions(dsh, [[SID, born + 5000]], dshHome);
  const dr = dsh.cli(["revive", "--json"], { env: { DSH_HOME: dshHome } });
  assert.equal(dr.code, 0, dr.err);
  assert.deepEqual(sessionLabels(dsh), []);
  assert.equal(labelOf(runFor(dsh, ID.main), "agent.session"), undefined);
  const dshResult = dr.json().projects[0].results[0];
  assert.equal(dshResult.outcome, "fresh");
  assert.ok(dshResult.why);

  const codex = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: born }] });
  writeFileSync(ledgerPath(codex.app), `${JSON.stringify({ event: "start", kind: "seat", terminal: "t5", botId: ID.main,
    project: codex.project, worktree: codex.project, agent: "codex", core: CORE, created_ms: born,
    at: new Date(born).toISOString() })}\n`, { mode: 0o600 });
  const codexHome = join(codex.root, "codex-home");
  codexRollout(codex, { id: v7(born + 5000), cwd: codex.project, codexHome });
  const cr = codex.cli(["revive", "--json"], { env: { CODEX_HOME: codexHome } });
  assert.equal(cr.code, 0, cr.err);
  const run = runFor(codex, ID.main);
  assert.ok(!wordsOf(run).includes("resume"), run.join(" "));
  const codexResult = cr.json().projects[0].results[0];
  assert.equal(codexResult.outcome, "fresh");
  assert.match(codexResult.why, /no conversation of its own was on record/);
});

test("#1490 revive: a Codex seat the pack started records its home in its seat row, and revive searches there", (t) => {
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }) });
  const start = s.cli(["start", "Lead", "--json"]);
  assert.equal(start.code, 0, start.err);
  const seat = s.ledger().find((row) => row.event === "start" && row.kind === "seat" && row.botId === ID.main);
  assert.deepEqual(seat.env, { HOME: s.env.HOME });
  const state = s.hcState();
  state.terminals.find((pane) => pane.address === seat.terminal).foreground.argv = ["zsh"];
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(state));
  const born = seat.created_ms + 2000;
  const own = v7(born);
  codexRollout(s, { id: own, cwd: s.project, dayMs: born });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const run = runsOf(s).filter((call) => labelOf(call, "bot") === ID.main).at(-1);
  assert.ok(hasSeq(wordsOf(run), ["resume", own]), run.join(" "));
});

test("#1490 revive: the search root is the seat's own recorded launch, not the reviving process's; an unknown home fails closed", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p, ctx) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], launchEnv: { HOME: join(ctx.root, "other-home") } })] });
  const otherHome = join(s.root, "other-home");
  const own = v7(born + 2000, "8abc-0123456789ab"), decoy = v7(born + 3000, "9abc-0123456789ab");
  codexRollout(s, { id: own, cwd: s.project, codexHome: join(otherHome, ".codex"), dayMs: born + 2000 });
  codexRollout(s, { id: decoy, cwd: s.project, dayMs: born + 3000 }); // the reviver's home: never searched
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => terminal === "t5"), [["t5", own]]);
  const run = runFor(s, ID.main);
  assert.ok(hasSeq(wordsOf(run), ["resume", own]), run.join(" "));
  assert.ok(run.includes(`HOME=${otherHome}`), "the replacement keeps the seat's own home");
  assert.ok(!r.out.includes(decoy) && !r.err.includes(decoy), r.out + r.err);

  // A pane whose launch names no home: nothing is searched, even under the reviver's own home.
  const u = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p) => [{ ...pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] }), noHome: true }] });
  codexRollout(u, { id: decoy, cwd: u.project, dayMs: born + 3000 });
  const ur = u.cli(["revive", "--json"]);
  assert.equal(ur.code, 0, ur.err);
  assert.deepEqual(sessionLabels(u), []);
  const urun = runFor(u, ID.main);
  assert.ok(!wordsOf(urun).includes("resume") && !wordsOf(urun).includes("--last"), urun.join(" "));
  assert.match(ur.json().projects[0].results[0].why, /no Codex conversation of its own could be identified for t5/);
});

test("#1490 revive: a Kimi index row whose folder isn't named by its id is refused", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "kimi", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["kimi"] })] });
  kimiBin(s);
  const kimiHome = join(s.home, ".kimi-code");
  const dir = join(kimiHome, "sessions", "ws1", "not-the-id");
  mkdirSync(dir, { recursive: true });
  utimesSync(dir, (born + 4000) / 1000, (born + 4000) / 1000);
  writeFileSync(kimiIndexPath(kimiHome), `${JSON.stringify({ sessionId: KID, sessionDir: dir, workDir: s.project })}\n`);
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), []);
  const run = runFor(s, ID.main);
  assert.ok(!wordsOf(run).some((w) => w.startsWith("--session") || w === "--continue" || w === "-c"), run.join(" "));
  assert.deepEqual(r.json().projects[0].results.map((x) => x.outcome), ["fresh"]);
});

test("#1490 revive: a rollout whose file-name id differs from the id inside is refused", (t) => {
  const born = Date.now() - 3_600_000;
  const fileId = v7(born + 1000, "8abc-0123456789ab"), contentId = v7(born + 2000, "9abc-0123456789ab");
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] })] });
  codexRollout(s, { id: fileId, cwd: s.project, dayMs: born + 1000, firstLine: JSON.stringify({ timestamp: new Date(born + 2000).toISOString(),
    type: "session_meta", payload: { id: contentId, session_id: contentId, timestamp: new Date(born + 2000).toISOString(), cwd: s.project } }) });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), []);
  for (const id of [fileId, contentId]) assert.ok(!runsOf(s).some((run) => wordsOf(run).includes(id)), id);
  assert.deepEqual(r.json().projects[0].results.map((x) => x.outcome), ["fresh"]);
});

test("#1490 revive: a symlinked rollout file is refused, never followed", (t) => {
  const born = Date.now() - 3_600_000;
  const id = v7(born + 1000, "8abc-0123456789ab");
  const s = world(t, { file: team({ main: { agent: "codex", name: "Lead" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"] })] });
  const real = join(s.root, "real-rollout.jsonl");
  writeFileSync(real, `${JSON.stringify({ timestamp: new Date(born + 1000).toISOString(), type: "session_meta",
    payload: { id, session_id: id, timestamp: new Date(born + 1000).toISOString(), cwd: s.project } })}\n`);
  const dir = join(codexSessionsDir(join(s.home, ".codex")), localDay(born + 1000));
  mkdirSync(dir, { recursive: true });
  symlinkSync(real, join(dir, `rollout-2026-11-16T12-00-00-${id}.jsonl`));
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sessionLabels(s), []);
  assert.ok(!wordsOf(runFor(s, ID.main)).includes(id));
  assert.deepEqual(r.json().projects[0].results.map((x) => x.outcome), ["fresh"]);
});

// ---- #1418: the login service keeps the PATH it was installed with ----

/** The PATH an installed unit keeps, read back as systemd would hand it to the boot pass. */
const keptPathOf = (text) => {
  const line = text.split("\n").find((l) => l.startsWith('Environment="PATH='));
  return line ? line.slice('Environment="PATH='.length, -1).replace(/%%/g, "%").replace(/\\(["\\])/g, "$1") : null;
};
/** The pane PATH an `hc run` gave its program (the env wrapper's PATH word). */
const panePathOf = (run) => wordsOf(run).find((w) => w.startsWith("PATH="))?.slice(5) ?? null;
/** The first folder of `path` that holds an executable `name`: what the pane's own lookup runs. */
const firstOnPath = (path, name) => {
  for (const dir of path.split(":")) {
    try { if (statSync(join(dir, name)).mode & 0o111) return join(dir, name); } catch { /* next */ }
  }
  return null;
};

test("servicePath: the caller's PATH, absolute words only, once each, without guard folders, node_modules/.bin or the venv's bin; ~/.local/bin and /usr/bin:/bin always there (#1418)", () => {
  const drop = (d) => /(^|\/)(guard|hc-kill)\/?$/.test(d);
  assert.equal(servicePath("/opt/agents/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin", { binDir: "/home/u/.local/bin" }),
    "/opt/agents/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin", "already whole: unchanged, binDir never moved");
  assert.equal(servicePath("/home/u/.automagik/parts/automagik.am/3.149.9/hc-kill:/pack/guard/:/opt/a:relative/bin::/opt/a:/p/node_modules/.bin:/p/node_modules/.bin/:/venv/bin:/opt/b",
    { binDir: "/home/u/.local/bin", venv: "/venv/", drop }),
  "/opt/a:/opt/b:/home/u/.local/bin:/usr/bin:/bin");
  assert.equal(servicePath("", { binDir: "/home/u/.local/bin" }), "/home/u/.local/bin:/usr/bin:/bin", "no PATH at all still finds the CLI's link and the system's tools");
  assert.equal(servicePath("/ok:/bad\nword:/tab\there", { binDir: "/b" }), "/ok:/b:/usr/bin:/bin", "a word with a control character never reaches the unit");
});

test("unitText: a kept PATH is its own Environment= line; % doubled, \" and \\ escaped, $ and spaces left as they are (#1418)", () => {
  const text = unitText({ runner: "/home/u/.local/bin/automagik-herdr", env: { HERDR_APP_HOME: "/a", PATH: '/opt/my tools/bin:/opt/$x:/opt/100%:/opt/q"t' }, wait: 600 });
  assert.ok(text.split("\n").includes('Environment="PATH=/opt/my tools/bin:/opt/$x:/opt/100%%:/opt/q\\"t"'), text);
  assert.equal(keptPathOf(text), '/opt/my tools/bin:/opt/$x:/opt/100%:/opt/q"t', "read back word for word");
  assert.match(text, /^ExecStart="\/home\/u\/\.local\/bin\/automagik-herdr" revive --boot --wait 600$/m, "ExecStart as before");
  assert.equal(unitKeepsPath(text), true);
  assert.equal(unitKeepsPath(unitText({ runner: "/r", env: { HERDR_APP_HOME: "/a" } })), false, "a unit from before #1418 keeps none");
  assert.equal(unitKeepsPath(null), false);
});

test("revive service install keeps the installer's PATH, without the pack's guard folders; status says when a unit keeps none (#1418)", { skip: process.platform !== "linux" }, (t) => {
  const s = world(t);
  // A pane's PATH: the kill shim's folder (beside an hcGuard.mjs) first, a project's node_modules/.bin, then the person's own.
  const shim = join(s.root, "parts/automagik.am/3.0.0/hc-kill");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(s.root, "parts/automagik.am/3.0.0/hcGuard.mjs"), "// an older copy\n");
  exe(join(shim, "hc"), "#!/bin/sh\nexit 0\n");
  const tools = join(s.root, "tools");
  mkdirSync(tools);
  const r = s.cli(["revive", "service", "install", "--json"], { env: { PATH: `${shim}:${join(s.project, "node_modules/.bin")}:${tools}:${s.env.PATH}` } });
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.equal(out.path, unitPath(s.home), "--json's path is still the unit's");
  const text = readFileSync(unitPath(s.home), "utf8");
  const kept = keptPathOf(text);
  assert.equal(out.kept_path, kept);
  const words = kept.split(":");
  assert.equal(words[0], tools, kept);
  assert.ok(!words.includes(shim), "a pane's versioned shim folder is never the boot pass's");
  assert.ok(!words.some((w) => w.includes("node_modules")), kept);
  assert.ok(words.includes(join(s.home, ".local/bin")) && words.includes("/usr/bin") && words.includes("/bin"), kept);
  assert.ok(text.includes(`Environment="HERDR_APP_HOME=${s.app}"`), text);
  const status = s.cli(["revive", "service", "status", "--json"]);
  assert.equal(status.json().path_kept, true);
  assert.doesNotMatch(s.cli(["revive", "service", "status"]).out, /keeps no PATH/);
  // A unit written before #1418: status says so, and how to refresh it.
  writeFileSync(unitPath(s.home), unitText({ runner: "/r", env: { HERDR_APP_HOME: s.app } }));
  assert.equal(s.cli(["revive", "service", "status", "--json"]).json().path_kept, false);
  assert.match(s.cli(["revive", "service", "status"]).out, /It keeps no PATH, so after a restart it may start other agent programs than your terminal does: rerun am revive service install\./);
});

test("revive with the unit's kept PATH starts the agent the person's terminal starts, not an older one a minimal PATH finds first (#1418)", { skip: process.platform !== "linux" }, (t) => {
  const make = () => world(t, { file: team({ main: { agent: "codex" } }),
    terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, argv: ["codex"], labels: { "herdr.space": "sp9", "herdr.tab": "tb3" } })] });
  const setup = (s) => {
    // An old global codex (no status reports) where systemd's minimal PATH looks first, and the
    // person's current codex earlier on their own PATH.
    const system = join(s.root, "usr-local-bin"), mine = join(s.root, "home-local-bin");
    for (const dir of [system, mine]) { mkdirSync(dir); exe(join(dir, "codex"), "#!/bin/sh\nexit 0\n"); }
    return { system, mine };
  };
  // Installed from the person's terminal: their PATH is kept.
  const s = make();
  const { system, mine } = setup(s);
  const install = s.cli(["revive", "service", "install"], { env: { PATH: `${mine}:${s.env.PATH}:${system}` } });
  assert.equal(install.code, 0, install.err);
  const kept = keptPathOf(readFileSync(unitPath(s.home), "utf8"));
  assert.ok(kept.startsWith(`${mine}:`), kept);
  // The boot pass runs with exactly that PATH.
  const r = s.cli(["revive", "--json"], { env: { PATH: kept } });
  assert.equal(r.code, 0, r.err);
  const runs = runsOf(s);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(firstOnPath(panePathOf(runs[0]), "codex"), join(mine, "codex"), runs[0].join(" "));
  // Contrast, the unit before #1418: the boot pass under a minimal PATH starts the old one.
  const before = make();
  const old = setup(before);
  const b = before.cli(["revive", "--json"], { env: { PATH: `${old.system}:${before.env.PATH}` } });
  assert.equal(b.code, 0, b.err);
  assert.equal(firstOnPath(panePathOf(runsOf(before)[0]), "codex"), join(old.system, "codex"), "what #1418 saw: another agent than the person's");
});

// ---- #1419: every pass is recorded, one that stops early too, and `revive --last` shows it ----

import { lastText } from "../mods/am-sidebar/revive.js";

const hcDown = (s) => exe(join(s.root, "bin", "hc"), "#!/bin/sh\necho 'core is not running' >&2\nexit 1\n");
const hcUp = (s) => exe(join(s.root, "bin", "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
const recordPath = (s) => join(s.app, "automagik-herdr/revive-last.json");
const stampPath = (s) => join(s.app, "automagik-herdr/revive-boot.json");
const CHIEF = team({ main: { name: "Chief" } });

test("lastText: the last pass, by the login service or by hand, each report and whether it was sent; one that stopped early; none on record", () => {
  assert.match(lastText(null, "/x/revive-last.json"), /^No revive pass is on record on this computer \(\/x\/revive-last\.json\)\. .*am revive service status\.$/);
  const sent = lastText({ at: "2026-11-16T10:00:00.000Z", boot: true, projects: [{ project: "/p", report: "Revive after a restart of this computer, project /p.", sent: "t9", unsent: null }] }, "/x");
  assert.equal(sent, "Last revive pass: 2026-11-16T10:00:00.000Z, the login service's pass (--boot).\nRevive after a restart of this computer, project /p.\n  Sent to the main bot (t9).");
  const unsent = lastText({ at: "2026-11-16T10:00:00.000Z", boot: false, projects: [{ project: "/p", report: "R.", sent: null, unsent: "Main has no pane" }] }, "/x");
  assert.match(unsent, /, run by hand\.\nR\.\n {2}Not sent: Main has no pane\.$/);
  // An older record has no `boot`: neither is said. Nothing came back: said so.
  assert.equal(lastText({ at: "2026-11-16T10:00:00.000Z", projects: [] }, "/x"), "Last revive pass: 2026-11-16T10:00:00.000Z.\nNothing to bring back: every bot the ledger named ran its agent.");
  // Stopped early: the reason, never "nothing to bring back"; a project with no report yet is named.
  const stopped = lastText({ boot_ms: 1, projects: [{ project: "/p", report: null, sent: null, unsent: "the pass stopped early" }],
    stopped: { at: "2026-11-16T11:00:00.000Z", boot: true, reason: "herdr-core isn't answering 600s on (down). Nothing was started." } }, "/x");
  assert.match(stopped, /^Last revive pass: 2026-11-16T11:00:00\.000Z, the login service's pass \(--boot\)\.\nProject \/p: no report\.\n {2}Not sent: the pass stopped early\.\nA pass stopped early \(2026-11-16T11:00:00\.000Z, --boot\): herdr-core isn't answering/);
  assert.doesNotMatch(stopped, /Nothing to bring back/);
});

test("revive --boot with herdr-core not answering keeps a record that says it stopped early, stamps nothing, and the next boot pass runs", (t) => {
  const s = world(t, { file: CHIEF, terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const env = { AUTOMAGIK_HERDR_BOOT_MS: String(Date.now() - 60_000) };
  hcDown(s);
  const r = s.cli(["revive", "--boot", "--wait", "1"], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /herdr-core isn't answering 1s on \(core is not running\)\. Nothing was started\./);
  const rec = s.lastReport();
  assert.equal(statSync(recordPath(s)).mode & 0o777, 0o600);
  assert.deepEqual(rec.projects, []);
  assert.equal(rec.stopped.boot, true);
  assert.match(rec.stopped.reason, /^herdr-core isn't answering 1s on/);
  assert.ok(!JSON.stringify(rec).includes("at "), "no stack in the record");
  assert.equal(existsSync(stampPath(s)), false, "an aborted pass never stamps the boot");
  const last = s.cli(["revive", "--last"]);
  assert.equal(last.code, 0, last.err);
  assert.match(last.out, /A pass stopped early \(.*, --boot\): herdr-core isn't answering 1s on/);
  // herdr-core answers again: the same boot's pass runs, records, stamps.
  hcUp(s);
  const again = s.cli(["revive", "--boot", "--json"], { env });
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json().ran, true);
  assert.equal(s.lastReport().boot, true);
  assert.equal(s.lastReport().stopped, undefined);
  assert.ok(existsSync(stampPath(s)));
});

test("a pass that stops early keeps the report this boot's pass couldn't send, under its own stop", (t) => {
  const s = world(t, { file: CHIEF, terminals: (p) => [pane("t6", { bot: ID.cap, cwd: p, labels: { "agent.session": SID2 } })] });
  const env = { AUTOMAGIK_HERDR_BOOT_MS: String(Date.now() - 60_000) };
  const r = s.cli(["revive"], { env });
  assert.equal(r.code, 0, r.err);
  const before = s.lastReport();
  assert.equal(before.boot, false);
  assert.equal(before.projects[0].unsent, "Chief has no pane");
  hcDown(s);
  assert.equal(s.cli(["revive", "--wait", "1"], { env }).code, 1);
  const after = s.lastReport();
  assert.deepEqual(after.projects, before.projects);
  assert.equal(after.at, before.at);
  assert.equal(after.stopped.boot, false);
  const last = s.cli(["revive", "--last"]).out;
  assert.match(last, /, run by hand\.\nRevive after a restart of this computer, project .*Captain \(t100\).*\n {2}Not sent: Chief has no pane\.\nA pass stopped early/);
});

test("a second boot pass while herdr-core is down says it already ran and leaves the record as it is", (t) => {
  const s = world(t, { file: CHIEF, terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const env = { AUTOMAGIK_HERDR_BOOT_MS: String(Date.now() - 60_000) };
  assert.equal(s.cli(["revive", "--boot"], { env }).code, 0);
  const record = readFileSync(recordPath(s), "utf8");
  const stamp = readFileSync(stampPath(s), "utf8");
  hcDown(s);
  const r = s.cli(["revive", "--boot", "--json", "--wait", "1"], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), { ran: false, reason: "already ran for this boot" });
  assert.equal(readFileSync(recordPath(s), "utf8"), record);
  assert.equal(readFileSync(stampPath(s), "utf8"), stamp);
});

test("the main bot's report goes only to a pane this core bound: a binding of another core is no pane of its own", (t) => {
  const s = world(t, { file: CHIEF, terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, front: ["claude"], status: "idle" }), pane("t6", { bot: ID.cap, cwd: p, labels: { "agent.session": SID2 } })],
    attach: () => [{ bot: ID.main, terminal: "t5", created_ms: 1, core: "othercore000" }, { bot: ID.cap, terminal: "t6", created_ms: 1 }] });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.hcState().sent, undefined, "nothing typed into another core's pane");
  assert.equal(r.json().projects[0].unsent, "Chief has no pane");
  assert.equal(s.lastReport().projects[0].unsent, "Chief has no pane");
});

test("revive --last shows the last pass and whether its report was sent, asks hc nothing and writes nothing; --json gives the record", (t) => {
  const s = world(t, { file: CHIEF, terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, labels: { "agent.session": SID } })] });
  const none = s.cli(["revive", "--last"]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /^No revive pass is on record on this computer \(.*revive-last\.json\)\. To see whether the login service that runs it after a restart is installed: am revive service status\./);
  assert.deepEqual(s.cli(["revive", "--last", "--json"]).json(), { path: recordPath(s), record: null });
  assert.equal(s.cli(["revive"]).code, 0);
  const files = [recordPath(s), attachPath(s.app)].map((f) => readFileSync(f, "utf8"));
  const calls = s.calls().length;
  hcDown(s);
  const r = s.cli(["revive", "--last"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Last revive pass: .*, run by hand\.\nRevive after a restart of this computer, project .*Resumed where they were: Chief \(t100\)\..*\n {2}Sent to the main bot \(t100\)\.\n?$/);
  assert.ok(!r.out.includes(SID) && !r.err.includes(SID), r.out);
  const j = s.cli(["revive", "--last", "--json"]).json();
  assert.equal(j.path, recordPath(s));
  assert.equal(j.record.projects[0].sent, "t100");
  assert.equal(s.calls().length, calls, "no hc call");
  assert.deepEqual([recordPath(s), attachPath(s.app)].map((f) => readFileSync(f, "utf8")), files);
  assert.equal(existsSync(stampPath(s)), false);
});

test("revive --last: a record that isn't JSON exits 1 and says so; --last with a pass's options or a verb is a usage mistake", (t) => {
  const s = world(t, { file: CHIEF });
  writeFileSync(recordPath(s), "{ not json");
  const r = s.cli(["revive", "--last"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /The revive record isn't valid JSON \(.*revive-last\.json\)\./);
  for (const args of [["revive", "--last", "--boot"], ["revive", "--last", "--wait", "0"], ["revive", "--last", "--dry-run"], ["revive", "service", "install", "--last"]]) {
    const u = s.cli(args);
    assert.equal(u.code, 2, args.join(" "));
    assert.match(u.err, /revive --last \[--json\]/, args.join(" "));
  }
  assert.deepEqual(s.sysCalls(), [], "service install never ran");
});

test("preBootSeat: requires a known boot and an integer stamp strictly before the ten-minute margin", async () => {
  const { PRE_BOOT_MARGIN_MS, preBootSeat } = await import("../mods/am-sidebar/revive.js");
  const boot = 3_600_000, minute = 60_000;
  assert.equal(PRE_BOOT_MARGIN_MS, 10 * minute);
  for (const [stamp, expected] of [[9, false], [10, false], [11, true]]) {
    assert.equal(preBootSeat(boot - stamp * minute, boot), expected);
  }
  assert.equal(preBootSeat(undefined, boot), false);
  assert.equal(preBootSeat(1.5, boot), false);
  for (const invalid of [NaN, 0, undefined]) assert.equal(preBootSeat(0, invalid), false);
});

test("lostSeatRefusal: only the boot pass can use a pre-boot binding despite missing or conflicting hc stamps", async () => {
  const { lostSeatRefusal } = await import("../mods/am-sidebar/revive.js");
  const bootMs = 3_600_000;
  const preBoot = { created_ms: bootMs - 11 * 60_000 };
  const recent = { created_ms: bootMs - 9 * 60_000 };
  const current = { created_ms: bootMs };
  const lost = (target) => ({ reason: "holder_lost", created_ms: target.created_ms });
  const reason = (target, get, boot, time = bootMs) => lostSeatRefusal({ target, get, boot, bootMs: time })?.code ?? null;
  for (const get of [lost(preBoot), { reason: "holder_lost" }, { ...lost(preBoot), created_ms: 7 }, { ...lost(preBoot), created_ms: 1.5 }]) {
    assert.equal(reason(preBoot, get, true), null);
    assert.equal(reason(preBoot, get, false), get.created_ms === preBoot.created_ms ? "ordinary_pass" : "uncertain_identity");
  }
  assert.equal(reason(recent, lost(recent), true), "inside_margin");
  assert.equal(reason(current, lost(current), true), "this_boot");
  assert.equal(reason(current, { reason: "holder_lost" }, true), "uncertain_identity");
  assert.equal(reason(preBoot, lost(preBoot), true, NaN), "no_boot_time");
  assert.equal(reason({ ...preBoot, swept: true }, undefined, true), null);
  assert.equal(reason({ ...recent, swept: true }, undefined, true), "inside_margin");
  assert.equal(reason({ ...current, swept: true }, undefined, true), "this_boot");
  assert.equal(reason({ ...current, swept: true }, undefined, true, 0), "no_boot_time");
  assert.equal(reason(current, undefined, true), null);
  assert.equal(reason(current, { reason: "finished" }, true), null);
  assert.equal(reason(current, { reason: "finished" }, false), null);
  const swept = reviveTargets({ swept: [{ ...current, terminal: "t1", bot: "b-aaaaaaaaaa", project: "/p" }] });
  assert.equal(swept.targets[0].swept, true);
});

test("the revive command quotes a folder as one POSIX or zsh word", async () => {
  const { q } = await import("../mods/am-sidebar/revive.js");
  assert.equal(q("/a-b/0.txt"), "/a-b/0.txt");
  assert.equal(q("/a b"), "'/a b'");
  assert.equal(q("/it's here"), "'/it'\\''s here'");
  assert.equal(q("=sh"), "'=sh'");
  assert.equal(byHandCommand("b-aaaaaaaaaa", "/a b"), "am restart b-aaaaaaaaaa --project '/a b' --tree");
});

test("seatNow distinguishes a newer attachment, a detach, an exact end and missing evidence", async () => {
  const { seatNow } = await import("../mods/am-sidebar/revive.js");
  const seat = { bot: "b-aaaaaaaaaa", core: "c1", terminal: "t1", created_ms: 1, machine: null };
  const attach = { ...seat, v: 1, event: "attach", project: "/p" };
  const end = { ...attach, event: "end" };
  const newer = { ...attach, terminal: "t2", created_ms: 2 };
  assert.equal(seatNow([attach, end], seat).now, "not_attached");
  assert.equal(seatNow([attach, end, newer], seat).now, "attached_again");
  assert.equal(seatNow([attach, end, newer, { ...newer, event: "detach" }], seat).now, "detached");
  assert.equal(seatNow([attach], seat).now, "unknown");
  assert.equal(seatNow([end].map((row) => ({ ...row, core: "c2" })), seat).now, "unknown");
  assert.equal(seatNow([attach, end, { ...newer, core: "c2", machine: "h2" }], seat).now, "not_attached");
});

test("seatHint chooses the roster and safe command form for the seat's recorded destination", async () => {
  const { seatHint } = await import("../mods/am-sidebar/revive.js");
  const bot = "b-aaaaaaaaaa";
  const seat = { bot, core: "c1", terminal: "t1" };
  const base = { seat, core: "c1", folder: "/a b", def: { id: bot, name: "Main", agent: "claude" } };
  const hint = (extra) => seatHint({ ...base, ...extra });
  assert.match(hint({}), /am restart b-aaaaaaaaaa --project '\/a b' \(a new conversation\)/);
  assert.match(hint({ folder: null, def: undefined }), /from its project's folder: am restart b-aaaaaaaaaa/);
  for (const core of [null, "c2"]) assert.match(hint({ core }), /its core can't be confirmed.*no command/);
  assert.match(hint({ def: undefined }), /bots\.json can't be read.*no command/);
  assert.match(hint({ def: null }), /no longer defines it.*no command/);
  assert.match(hint({ def: { ...base.def, agent: "hermes", hermes: {} } }), /doesn't cover a paired Hermes Bot/);
  assert.match(hint({ def: { ...base.def, agent: "hermes" } }), /am restart.*new conversation/);
  const machineSeat = { ...seat, machine: "h2" };
  const machine = new Map([["c1", { name: "h3", connected: false }]]);
  const remote = hint({ seat: machineSeat, machines: machine, def: { agent: "hermes", hermes: {} } });
  assert.match(remote, /--machine h3 --project '\/a b'; it runs on h3 with that machine's roster/);
  assert.match(remote, /h3 isn't connected now/);
  assert.doesNotMatch(remote, /Hermes|new conversation/);
  assert.match(hint({ seat: machineSeat, machines: machine, folder: null }), /--machine h3 --project <its folder on h3>.*not runnable/);
  assert.match(hint({ seat: machineSeat }), /machine h2 isn't linked now.*no command/);
});
