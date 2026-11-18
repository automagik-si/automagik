import { startFakeCore } from "./fake-core.mjs";
// Revive (#939): the bots come back after a restart of this computer. revive.js over plain data,
// then `automagik-herdr revive` run as a program against a scratch project, a scratch home and
// app home, a fake `hc` (test/fake-hc.mjs), a fake `herdr-app` and a fake `systemctl`. No live
// Herdr, herdr-core, DSH, Antigravity or systemd is ever touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";
import { ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { helperPlan } from "../mods/am-sidebar/restart.js";
import { AGENTS } from "../mods/am-sidebar/models.js";
import { FIRST_SESSION_MS, KEEP_DOWN, UNIT_MARK, UNIT_NAME, agyCandidates, agyHistoryPath, byHandCommand, countsLine, dshHomeOf, dshSessionOf, dshSessionsDir, isBareShell, launchEnvOf, launchHomeEnv, ledgerRivals,
  pickSession, reportLine, reviveOrder, reviveTargets, sameBoot, seatHomeOf, seatHomesRecorded, sweptSince, unitIsOurs, unitPath, unitText } from "../mods/am-sidebar/revive.js";
import { firstLine as firstLineTrusted } from "../mods/am-sidebar/sessionFiles.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { servicePath, unitKeepsPath } from "../mods/am-sidebar/revive.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";
import { codexCandidate, codexHomeOf, codexRolloutId, codexSessionsDir, kimiCandidates, kimiHomeOf, kimiIndexPath, uuidV7Ms } from "../mods/am-sidebar/revive.js";

// #1417: every CLI run below reads Codex's and Kimi's homes under its scratch home only.
delete process.env.CODEX_HOME;
delete process.env.KIMI_CODE_HOME;

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
  // #1490: a discovered agent's pane records its launch home, as the pack's own launch does. A
  // row can opt out (`noHome`: an unknown home) or name another (`launchEnv`: { HOME, DSH_HOME… }).
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
  return { root, project, home, app, env, cli, calls, hcState, ledger, attachRows, lastReport, sysCalls };
}
const runsOf = (s) => s.calls().filter((c) => c[0] === "run");
const wordsOf = (run) => run.slice(run.indexOf("--") + 1);
const cwdOf = (run) => run[run.indexOf("--cwd") + 1];
const changes = (s) => s.calls().filter((c) => ["run", "kill", "label", "send"].includes(c[0]));
const hasSeq = (words, seq) => words.some((_, i) => seq.every((w, j) => words[i + j] === w));
/** The run that started bot `botId` (its hc labels name it). */
const runFor = (s, botId) => runsOf(s).find((run) => run.includes(`bot=${botId}`));
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
});

test("#1490 pickSession: a live rival makes an unclaimed session born while it runs ambiguous, whatever the launch gap", () => {
  const c = (id, born) => ({ id, born });
  const T = 10_000_000;
  // A rival live in the folder long before may start a new conversation at any time.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T - 10 * FIRST_SESSION_MS, live: true }] }), null);
  // Whatever the launch gap: a live rival in the folder is enough.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T + 60_000, live: true }] }), null);
  // A launch record (not a live pane) that started after the birth can't own it.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], rivals: [{ created_ms: T + 60_000 }] }), SID);
  // A claimed id is never taken, even with no rival at all.
  assert.equal(pickSession({ createdMs: T, candidates: [c(SID, T + 800)], claimed: new Set([SID]) }), null);
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
});

test("#1490 revive: two Codex seats far apart in one folder; a later thread of one is never the other's", (t) => {
  const born = Date.now() - 3_600_000;
  const aId = v7(born + 1000, "8abc-0123456789ab");
  const newId = v7(born + 200_000, "9abc-0123456789ab"); // A's /new, born inside B's window
  const s = world(t, { file: team({ main: { agent: "codex", name: "A" }, cap: { agent: "codex", name: "B" } }),
    terminals: (p) => [
      pane("t5", { bot: ID.main, cwd: p, created: born, argv: ["codex"], labels: { "agent.session": aId } }),
      pane("t6", { bot: ID.cap, cwd: p, created: born + 180_000, argv: ["codex"] }),
    ] });
  codexRollout(s, { id: aId, cwd: s.project, dayMs: born });
  codexRollout(s, { id: newId, cwd: s.project, dayMs: born + 200_000 });
  const r = s.cli(["revive", "--json"]);
  assert.equal(r.code, 0, r.err);
  const aRun = runFor(s, ID.main), bRun = runFor(s, ID.cap);
  assert.ok(hasSeq(wordsOf(aRun), ["resume", aId]), aRun.join(" "));
  assert.ok(!wordsOf(bRun).includes("resume") && !wordsOf(bRun).includes("--last"), bRun.join(" "));
  assert.deepEqual(sessionLabels(s).filter(([terminal]) => ["t6", "t101"].includes(terminal)), [], "B takes no id");
  assert.ok(!sessionLabels(s).some(([, id]) => id === newId), "the later thread is never recorded");
  const results = r.json().projects[0].results;
  assert.deepEqual(results.map((x) => [x.name, x.outcome]), [["A", "resumed"], ["B", "fresh"]]);
  assert.match(results[1].why, /no Codex conversation of its own could be identified for t6/);
  for (const text of [r.out, r.err, JSON.stringify(s.lastReport())]) assert.ok(!text.includes(newId), text);
});

test("#1490 revive: a rival's recorded id is never claimed by another seat", (t) => {
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
