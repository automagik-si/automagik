// Revive (#939): the bots come back after a restart of this computer. revive.js over plain data,
// then `automagik-herdr revive` run as a program against a scratch project, a scratch home and
// app home, a fake `hc` (test/fake-hc.mjs), a fake `herdr-app` and a fake `systemctl`. No live
// Herdr, herdr-core, DSH, Antigravity or systemd is ever touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { helperPlan } from "../mods/am-sidebar/restart.js";
import { AGENTS } from "../mods/am-sidebar/models.js";
import { FIRST_SESSION_MS, KEEP_DOWN, UNIT_MARK, UNIT_NAME, agyCandidates, agyHistoryPath, byHandCommand, countsLine, dshHomeOf, dshSessionOf, dshSessionsDir, isBareShell, ledgerRivals,
  pickSession, reportLine, reviveOrder, reviveTargets, sameBoot, sweptSince, unitIsOurs, unitPath, unitText } from "../mods/am-sidebar/revive.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

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
const pane = (address, { bot: b, front = ["zsh"], argv = ["claude"], cwd, created = 1, labels = {}, parent = null, status = "working", die = Boolean(parent) } = {}) => ({
  address, name: address, cwd, state: "live", parent, die_with_parent: die, created_ms: created, argv, labels: { ...(b ? { bot: b } : {}), ...labels },
  foreground: { argv: front, cwd }, status: { app: "claude-code", state: status } });

function world(t, { file = team(), terminals = () => [], attach = null, hcExtra = {} } = {}) {
  const root = scratchRoot(t, "hb-revive-");
  const project = scratchProject(root, "proj", { isGit: true, commit: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  exe(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  for (const name of ["claude", "codex", "dsh-tui"]) exe(join(bin, name), "#!/bin/sh\nexit 0\n");
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
  const terms = terminals(project);
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
  for (const k of ["HC_TERMINAL_ID", "HC_SOCKET", "HERMES_HOME", "AUTOMAGIK_HERDR_BOOT_MS", "CLAUDE_CONFIG_DIR"]) delete env[k];
  const cli = (args, { env: extra = {}, cwd = project } = {}) => {
    const r = spawnSync(RUNTIME, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const calls = () => readJsonLines(logPath);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const ledger = () => readLedger(existsSync(ledgerPath(app)) ? readFileSync(ledgerPath(app), "utf8") : "");
  const attachRows = () => readAttach(readFileSync(attachPath(app), "utf8")).rows;
  const lastReport = () => JSON.parse(readFileSync(join(app, "automagik-herdr/revive-last.json"), "utf8"));
  const sysCalls = () => (existsSync(sysLog) ? readFileSync(sysLog, "utf8").split("\n").filter(Boolean) : []);
  return { root, project, home, app, env, cli, calls, hcState, ledger, attachRows, lastReport, sysCalls };
}
const runsOf = (s) => s.calls().filter((c) => c[0] === "run");
const wordsOf = (run) => run.slice(run.indexOf("--") + 1);
const cwdOf = (run) => run[run.indexOf("--cwd") + 1];
const changes = (s) => s.calls().filter((c) => ["run", "kill", "label", "send"].includes(c[0]));
const hasSeq = (words, seq) => words.some((_, i) => seq.every((w, j) => words[i + j] === w));

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

test("DSH's sessions are read under $DSH_HOME when it is set", (t) => {
  const born = Date.now() - 3_600_000;
  const s = world(t, { file: team({ main: { agent: "dsh-tui" } }), terminals: (p) => [pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["dsh-tui"] })] });
  const dshHome = join(s.root, "dsh-home");
  dshSessions(s, [[SID, born + 5000]], dshHome);
  dshSessions(s, [[SID2, born + 6000]]); // ~/.dsh is not DSH's home here
  const r = s.cli(["revive", "--json"], { env: { DSH_HOME: dshHome } });
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
