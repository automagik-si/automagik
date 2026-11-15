// Start and Attach: the pure argument building and messages (launchArgs.js), then launch.js
// over the Herdr stand-ins with a scratch git project: it runs the real CLI against a fake hc
// (test/fake-hc.mjs) first on PATH. The real hc is never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { state } from "./use-stubs.mjs";
import { hcName, parentArgs, startRefusal, startArgs, agentInForeground, isClaude, newest, attachRefusal, parseCommand, freshSpare, shellIdle, spareTab, unwrapKeep } from "../mods/am-sidebar/launchArgs.js";
import { GUARD_DIR, stableGuardDir, stableHelper, stableRunner } from "../mods/am-sidebar/workers.js";
const { startBot, attachBot, liveTerminalOf, botOfTerminal, runCli } = await import("../mods/am-sidebar/launch.js");
import { briefingFilePath } from "../mods/am-sidebar/briefingText.mjs";
import { readJsonLines } from "./log-lines.mjs";

const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", plan: "b-eeeeeeeeee" };
const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const team = () => ({
  version: 1,
  categories: [],
  bots: [
    bot(ID.main, "main", { name: "Genie" }),
    bot(ID.cap, "member", { name: "Captain" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.plan, "member", { name: "Studio", agent: undefined, planned: { wave: 3 } }),
  ],
});

// ---- pure ----

test("start args: a main bot runs with --no-parent, labels, name, cwd and the agent after --", () => {
  const args = startArgs({ botId: ID.main, name: "genie", cwd: "/p", space: "sp1", tab: "tb1", parent: parentArgs(team(), ID.main, () => "t9"), argv: ["claude", "--x"] });
  assert.deepEqual(args, ["run", "--bg", "--json", "--name", "genie", "--cwd", "/p", "--label", "bot=b-aaaaaaaaaa",
    "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--no-parent", "--", "claude", "--x"]);
  assert.equal(args.includes("--no-notify"), false);
});

test("start args: a sandboxed dsh-tui pane runs through the per-pane helper before DSH", () => {
  const base = { botId: ID.dev, cwd: "/p", parent: ["--no-parent"], argv: ["dsh-tui", "--resume", "abc", "--", "brief"],
    path: "/bin", agent: "dsh-tui" };
  const sandboxed = startArgs({ ...base, project: "/p", sandbox: true, stableRoot: "/stable" });
  const tail = sandboxed.slice(sandboxed.indexOf("--") + 1);
  assert.deepEqual(tail, ["/usr/bin/env", `PATH=${stableGuardDir("/stable")}:/bin`, "/bin/sh", stableRunner("/stable"),
    stableHelper("/stable"), "--bot", ID.dev, "--project", "/p", "--", "dsh-tui", "--resume", "abc", "--", "brief"]);
  // Without the switch the argv is byte for byte what it was: the helper is PR B's only change.
  const plain = startArgs({ ...base, sandbox: false });
  assert.deepEqual(plain.slice(plain.indexOf("--") + 1), ["/usr/bin/env", `PATH=${GUARD_DIR}:/bin`, "dsh-tui", "--resume", "abc", "--", "brief"]);
});

test("start args: a member whose lead is live gets it as parent and outlives it", () => {
  const live = { [ID.cap]: "t7", [ID.main]: "t1" };
  assert.deepEqual(parentArgs(team(), ID.dev, (id) => live[id] ?? null), ["--parent", "t7", "--outlive-parent"]);
  // No lead field: the main bot is the lead.
  assert.deepEqual(parentArgs(team(), ID.cap, (id) => live[id] ?? null), ["--parent", "t1", "--outlive-parent"]);
});

test("start args: a member whose lead is down gets --no-parent; a lead that falls back uses the main bot", () => {
  assert.deepEqual(parentArgs(team(), ID.dev, () => null), ["--no-parent"]);
  const f = team();
  f.bots[2].lead = ID.plan; // a planned lead: A1 falls back to the main bot
  assert.deepEqual(parentArgs(f, ID.dev, (id) => (id === ID.main ? "t1" : "t8")), ["--parent", "t1", "--outlive-parent"]);
});

test("start args: briefing variables (hermes) go after PATH in the one env prefix; none and no PATH: no env at all", () => {
  const base = { botId: ID.main, cwd: "/p", parent: ["--no-parent"], argv: ["hermes"] };
  const both = startArgs({ ...base, path: "/bin", env: { HERMES_EPHEMERAL_SYSTEM_PROMPT: "<herdr-bot>\nx\n</herdr-bot>" } });
  assert.deepEqual(both.slice(both.indexOf("--") + 1), ["/usr/bin/env", "PATH=/bin", "HERMES_EPHEMERAL_SYSTEM_PROMPT=<herdr-bot>\nx\n</herdr-bot>", "hermes"]);
  const bare = startArgs(base);
  assert.deepEqual(bare.slice(bare.indexOf("--") + 1), ["hermes"]);
});

test("start: a planned bot, one with no agent, or a member with no main bot is refused", () => {
  assert.match(startRefusal(team(), ID.plan), /planned \(wave 3\)/);
  const f = team();
  delete f.bots[1].agent;
  assert.match(startRefusal(f, ID.cap), /no coding agent/);
  const g = team();
  g.bots.shift();
  assert.match(startRefusal(g, ID.cap), /no main bot/);
  assert.equal(startRefusal(team(), ID.dev), null);
});

test("spareTab: a new space's shell tab is closed only once the bot shows in a tab of its own, and only while the shell is alone", () => {
  const spare = { space: "s5", tab: "t5", terminal: "t-sh" };
  const shell = { id: "t5", terminals: ["t-sh"], count: 1 };
  const bot = { id: "t6", terminals: ["t100"], count: 1 };
  assert.equal(spareTab(spare, [shell, bot], "t100", true), "t5");
  // The bot not shown yet: closing would leave the space without a tab.
  assert.equal(spareTab(spare, [shell], "t100", true), null);
  // The shell tab holds more now (a split, or a mod pane: counted, though it has no terminal), or the bot itself: kept.
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t-sh", "t9"] }, bot], "t100", true), null);
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t-sh"], count: 2 }, bot], "t100", true), null);
  // No pane count (Herdr's ls has none): a mod pane could be there unseen, so never closed.
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t-sh"] }, bot], "t100", true), null);
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t-sh"], count: null }, bot], "t100", true), null);
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t-sh", "t100"] }], "t100", true), null);
  // A fresh spare (seen right after this start's own space.new as its one tab, that shell alone):
  // no count is enough; a count that says more still keeps it, and so does a second terminal.
  const fresh = { ...spare, fresh: true };
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh"] }, bot], "t100", true), "t5");
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh"], count: null }, bot], "t100", true), "t5");
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh"], count: 2 }, bot], "t100", true), null);
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh", "t9"] }, bot], "t100", true), null);
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh"] }], "t100", true), null);
  assert.equal(spareTab(fresh, [{ id: "t5", terminals: ["t-sh"] }, bot], "t100", false), null);
  // Something other than the shell in front, or not known: kept.
  assert.equal(spareTab(spare, [shell, bot], "t100", false), null);
  assert.equal(spareTab(spare, [shell, bot], "t100"), null);
  // Gone already, or another program in that tab now: nothing is closed.
  assert.equal(spareTab(spare, [bot], "t100", true), null);
  assert.equal(spareTab(spare, [{ id: "t5", terminals: ["t8"] }, bot], "t100", true), null);
  assert.equal(spareTab(null, [shell, bot], "t100", true), null);
});

test("shellIdle: the terminal's own process in front, a bare shell with no child; a script, a command, a job, another pid or no answer is not idle", () => {
  // A plain prompt: the shell in front, no process of its own (pgrep -P: none).
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["-zsh"] } }, []), true);
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["/bin/bash", "-i"] } }, []), true);
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, name: "zsh" } }, []), true);
  // At its prompt with a job left running (`sleep 99 &`): the shell is in front, but not idle.
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["-zsh"] } }, ["4242"]), false);
  // Its children unknown (pgrep missing or failing, never asked): never idle.
  for (const unknown of [undefined, null, "", 0]) assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["-zsh"] } }, unknown), false, String(unknown));
  // Another process in front: vim, or a shell's child (bash deploy.sh run from it).
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 8, argv: ["vim", "notes.md"] } }, []), false);
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 8, argv: ["bash", "deploy.sh"] } }, []), false);
  // The terminal's own process, but running a script or a command string.
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["bash", "deploy.sh"] } }, []), false);
  assert.equal(shellIdle({ pid: 7, foreground: { pid: 7, argv: ["sh", "-c", "\"$@\"; exec \"${SHELL:-sh}\" -i", "sh", "make"] } }, []), false);
  // No pids to compare, or no answer.
  assert.equal(shellIdle({ foreground: { argv: ["-zsh"] } }, []), false);
  assert.equal(shellIdle(null, []), false);
  assert.equal(shellIdle({}, []), false);
});

test("freshSpare: space.new's shell is fresh only while the space is that one tab with that shell alone", () => {
  const made = { id: "s5", tabs: [{ id: "t5", panes: [{ pane: "p5", terminal: "t-sh" }] }] };
  assert.deepEqual(freshSpare(made, "t-sh"), { space: "s5", tab: "t5", terminal: "t-sh", fresh: true });
  // Another tab there already, or a second terminal beside the shell: a spare, but not fresh.
  assert.equal(freshSpare({ ...made, tabs: [...made.tabs, { id: "t6", panes: [] }] }, "t-sh").fresh, false);
  assert.equal(freshSpare({ id: "s5", tabs: [{ id: "t5", panes: [{ terminal: "t-sh" }, { terminal: "t9" }] }] }, "t-sh").fresh, false);
  // A linked machine's ids, compared as the caller says.
  const vm = { id: "s7", tabs: [{ id: "t7", panes: [{ terminal: "vm/t-sh" }] }] };
  assert.equal(freshSpare(vm, "t-sh"), null);
  assert.deepEqual(freshSpare(vm, "t-sh", (a, b) => a.split("/").pop() === b), { space: "s7", tab: "t7", terminal: "t-sh", fresh: true });
  // Not shown there, or nothing printed: none.
  assert.equal(freshSpare(made, "t-other"), null);
  assert.equal(freshSpare(made, undefined), null);
  assert.equal(freshSpare(null, "t-sh"), null);
});

test("names: slugged to hc's alphabet, suffixed when taken", () => {
  assert.equal(hcName("Genie the Great!", ID.main), "genie-the-great");
  assert.equal(hcName("Genie", ID.main, new Set(["genie"])), "genie-aaaa");
  assert.equal(hcName("Genie", ID.main, new Set(["genie", "genie-aaaa"])), null);
  assert.equal(hcName("x".repeat(40), ID.main).length, 32);
  assert.equal(hcName("ñ", ID.main), "bot");
});

test("attach refusal names both folders and the fix; same project passes", () => {
  const msg = attachRefusal({ botName: "Genie", projectKey: "/repos/a", sessionFolder: "/repos/b/src", sessionKey: "/repos/b" });
  assert.match(msg, /\/repos\/b\/src/);
  assert.match(msg, /\/repos\/a/);
  assert.match(msg, /Create the bot in \/repos\/b instead, or Start Genie fresh/);
  assert.equal(attachRefusal({ botName: "G", projectKey: "/repos/a", sessionFolder: "/repos/a-wt", sessionKey: "/repos/a" }), null);
});

test("duplicates: the newest by created_ms counts; the live rule reads the foreground", () => {
  assert.equal(newest([{ address: "t1", created_ms: 5 }, { address: "t2", created_ms: 9 }, { address: "t3", created_ms: 7 }]).address, "t2");
  assert.equal(agentInForeground({ foreground: { argv: ["/bin/zsh", "-l"] } }), false);
  assert.equal(agentInForeground({ foreground: { argv: ["-zsh"] } }), false);
  assert.equal(agentInForeground({ foreground: { argv: ["bun", "omp"] } }), true);
  assert.equal(agentInForeground({ foreground: null }), false);
  assert.equal(isClaude(null, { foreground: { argv: ["claude", "--resume", "x"] } }), true);
  assert.equal(isClaude({ program: { key: "codex" } }, { foreground: { argv: ["codex"] } }), false);
});

test("commands: name with optional JSON or key=value arguments", () => {
  assert.deepEqual(parseCommand("new-bot"), { name: "new-bot", args: {} });
  assert.deepEqual(parseCommand("edit b-aaaaaaaaaa"), { name: "edit", args: { bot: "b-aaaaaaaaaa" } });
  assert.deepEqual(parseCommand('attach {"bot":"b-x","terminal":"t7"}'), { name: "attach", args: { bot: "b-x", terminal: "t7" } });
  assert.deepEqual(parseCommand("attach bot=b-x terminal=t7"), { name: "attach", args: { bot: "b-x", terminal: "t7" } });
});

// ---- launch.js over the stand-ins: the sidebar runs the real CLI ----
// launch.js execs `env HERDR_APP_HOME=<app> sh <app>/mods/am-sidebar/bin/run.sh <cli> …`
// through the stub's exec (a real execFile). The scratch app home's mods/am-sidebar links
// to this checkout, and this process's PATH starts with a fake hc (test/fake-hc.mjs) and a fake
// herdr-app with no window (test/fake-herdr-app.mjs), its HOME a scratch one, so the CLI never
// reaches a real hc, window or app home.

const run = promisify(execFile);
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const MOD = new URL("../mods/am-sidebar", import.meta.url).pathname;
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HC_FAKE_STATE: process.env.HC_FAKE_STATE,
  HC_FAKE_LOG: process.env.HC_FAKE_LOG, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HERDR_APP_HOME: process.env.HERDR_APP_HOME,
  HERDR_APP_FAKE_STATE: process.env.HERDR_APP_FAKE_STATE, HERDR_APP_FAKE_LOG: process.env.HERDR_APP_FAKE_LOG };

async function world(t, { file = team(), terminals = () => [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automagik-herdr-")));
  const main = join(root, "proj");
  mkdirSync(join(main, ".herdr"), { recursive: true });
  await run("git", ["init", "-q", main]);
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
  writeFileSync(join(main, ".herdr", "bots.json"), JSON.stringify(file));
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify({ down: true }));
  writeFileSync(appLog, "");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const app = join(root, "app");
  mkdirSync(join(app, "mods"), { recursive: true });
  symlinkSync(MOD, join(app, "mods/am-sidebar"));
  const statePath = join(root, "hc.json");
  const logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: terminals(main), next: 100 }));
  writeFileSync(logPath, "");
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog });
  delete process.env.HC_TERMINAL_ID;
  delete process.env.HERDR_APP_HOME;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(state, { spaces: [], panes: [], shared: new Map(), setSharedCalls: 0, offline: new Set(), calls: [], terminals: [], focused: null,
    hcCalls: [], runs: [], notes: [], appHome: app, agents: [{ key: "claude", name: "Claude Code", run: ["claude"], installed: true }] });
  const calls = () => readJsonLines(logPath);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setHc = (st) => writeFileSync(statePath, JSON.stringify(st));
  const ledger = () => { try { return readFileSync(join(app, "automagik-herdr/attach.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { root, main, app, calls, hcState, setHc, ledger };
}
const term = (address, { bot: b, cwd = "/x", argv = ["claude"], created = 1 } = {}) => ({ address, name: address, cwd, state: "live", parent: null,
  created_ms: created, labels: b ? { bot: b } : {}, foreground: { argv, cwd }, status: { app: "claude-code", state: "idle" } });

test("the fake hc is the one the CLI runs here: never the real one", async (t) => {
  await world(t);
  const { stdout } = await run("sh", ["-c", "command -v hc; command -v herdr-app"]);
  assert.match(stdout.trim(), /automagik-herdr-.*\/bin\/hc\n.*automagik-herdr-.*\/bin\/herdr-app$/);
});

test("startBot runs the CLI: hc run in the project's space, a tab of its own, an attach row by start; the sidebar sets no label", async (t) => {
  const w = await world(t, { terminals: (main) => [term("t7", { bot: ID.cap, cwd: main })] });
  state.spaces = [{ id: "s0", folder: "/elsewhere", machine: null, active: true, tabs: [{ id: "x", active: true }] },
    { id: "s1", folder: w.main, machine: null, active: false, tabs: [{ id: "a", active: false }, { id: "b", active: true }] }];
  const r = await startBot(w.main, ID.dev);
  assert.deepEqual(r, { terminal: "t100" });
  const runArgs = w.calls().find((a) => a[0] === "run");
  assert.ok(runArgs.includes(`bot=${ID.dev}`) && runArgs.includes("herdr.space=s1"), runArgs.join(" "));
  // Never the active tab (b): Herdr opens the bot in a tab of its own.
  assert.equal(runArgs.some((a) => a.startsWith("herdr.tab=")), false, runArgs.join(" "));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--parent"), runArgs.indexOf("--parent") + 3), ["--parent", "t7", "--outlive-parent"]);
  const rows = w.ledger();
  assert.deepEqual(rows.map((x) => [x.event, x.bot, x.terminal, x.by]), [["attach", ID.cap, "t7", "import"], ["attach", ID.dev, "t100", "start"]]);
  assert.deepEqual(state.hcCalls, [], "the sidebar itself calls no hc: no label, no run");
  assert.deepEqual(state.shared.get("am.sidebar.projects"), [{ key: w.main, machine: null }]);
  // Started already: the ledger's pane is focused, never a second one.
  assert.deepEqual(await startBot(w.main, ID.dev), { focused: "t100" });
  assert.deepEqual(state.runs, [["agent.focus", { terminal: "t100" }]]);
  assert.equal(w.calls().filter((a) => a[0] === "run").length, 1);
  assert.match((await startBot(w.main, ID.plan)).refused, /planned/);
});

test("startBot: a Claude bot starts with its briefing file, written under the app home before hc run, nothing live in it", async (t) => {
  const w = await world(t, { terminals: (main) => [term("t7", { bot: ID.cap, cwd: main })] });
  state.spaces = [{ id: "s1", folder: w.main, machine: null, active: true, tabs: [{ id: "a", active: true }] }];
  assert.deepEqual(await startBot(w.main, ID.dev), { terminal: "t100" });
  const runArgs = w.calls().find((a) => a[0] === "run");
  const path = briefingFilePath(w.app, w.main, ID.dev);
  const at = runArgs.lastIndexOf("claude");
  assert.deepEqual(runArgs.slice(at, at + 3), ["claude", "--append-system-prompt-file", path], "right after the executable");
  assert.equal(runArgs.filter((a) => a === "--append-system-prompt-file").length, 1);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^<herdr-bot>\n/);
  assert.match(text, new RegExp(`You are Dev, a team member \\(bot ${ID.dev}\\)`));
  assert.match(text, /Instructions:\ni\n/);
  assert.match(text, new RegExp(`hc ls --label bot=${ID.cap}`), "its lead, found by label, never a stored address");
  assert.doesNotMatch(text, /t7|idle|working/, "no terminal and no status: those change while it runs");
  assert.equal(statSync(path).mode & 0o077, 0, "the owner's alone");
});

test("startBot: no space shows the project -> space.new on its folder, waited for and matched by project key", async (t) => {
  const w = await world(t);
  const tree = join(w.root, "proj-wt");
  await run("git", ["worktree", "add", "-q", "-b", "wt", tree], { cwd: w.main });
  state.spaces = [{ id: "s0", folder: "/elsewhere", machine: null, active: true, tabs: [{ id: "x", active: true }] }];
  // Herdr makes the space a moment after run(), on its own folder spelling: here the worktree,
  // which keys to the project as the main checkout does.
  let looks = 0;
  const sleep = async () => {
    if (++looks === 2) state.spaces = [...state.spaces, { id: "s5", folder: tree, machine: null, active: true, tabs: [{ id: "t5", active: true }] }];
  };
  assert.deepEqual(await startBot(w.main, ID.main, { sleep }), { terminal: "t100" });
  assert.deepEqual(state.runs, [["space.new", { name: "proj", folder: w.main, machine: "" }]]);
  const runArgs = w.calls().find((a) => a[0] === "run");
  assert.ok(runArgs.includes("herdr.space=s5") && !runArgs.some((a) => a.startsWith("herdr.tab=")), runArgs.join(" "));
  // With no sleep to wait by, no space is opened (none left behind empty): the shown space.
  state.spaces = [{ id: "s0", folder: "/elsewhere", machine: null, active: true, tabs: [{ id: "x", active: true }] }];
  state.runs = [];
  assert.ok((await startBot(w.main, ID.cap)).terminal);
  assert.deepEqual(state.runs, []);
  assert.ok(w.calls().filter((a) => a[0] === "run")[1].includes("herdr.space=s0"));
});

test("startBot: the space it opened keeps no lone shell tab: closed once the bot shows in its own tab, never before", async (t) => {
  const w = await world(t);
  state.spaces = [];
  // Herdr makes the space with its shell (t-sh in tab t5); the bot's tab (t6) comes once hc runs it.
  let looks = 0;
  const sleep = async () => {
    looks += 1;
    if (looks === 1) {
      state.spaces = [{ id: "s5", folder: w.main, machine: null, active: true, tabs: [{ id: "t5", index: 1, active: true }] }];
      state.panes = [{ pane: "p5", terminal: "t-sh", tab: "t5", program: { key: "shell", shell: true, agent: false } }];
    }
    if (w.calls().some((a) => a[0] === "run") && !state.panes.some((p) => p.terminal === "t100")) {
      state.spaces = [{ ...state.spaces[0], tabs: [...state.spaces[0].tabs, { id: "t6", index: 2, active: false }] }];
      state.panes = [...state.panes, { pane: "p6", terminal: "t100", tab: "t6" }];
    }
  };
  assert.deepEqual(await startBot(w.main, ID.main, { sleep }), { terminal: "t100" });
  // Never `confirmed`: Herdr asks the person only before closing a space's last tab.
  assert.deepEqual(state.runs, [["space.new", { name: "proj", folder: w.main, machine: "" }], ["tab.close", { id: "t5" }]]);
  // A bot that never shows (within waitMs) leaves the shell's tab be: the space keeps a tab.
  state.spaces = [];
  state.panes = [];
  state.runs = [];
  let seen = 0;
  const quiet = async () => {
    if (++seen === 1) {
      state.spaces = [{ id: "s7", folder: w.main, machine: null, active: true, tabs: [{ id: "t7", index: 1, active: true }] }];
      state.panes = [{ pane: "p7", terminal: "t-sh7", tab: "t7" }];
    }
  };
  assert.ok((await startBot(w.main, ID.cap, { sleep: quiet, waitMs: 300 })).terminal);
  assert.deepEqual(state.runs, [["space.new", { name: "proj", folder: w.main, machine: "" }]]);
});

test("startBot: the new space's shell tab stays when the shell runs something, or a mod pane shares its tab", async (t) => {
  const w = await world(t);
  const cases = [
    // vim in front of the spare shell: the person is using it.
    { id: ID.main, shellPane: { program: { key: "nvim", shell: false, agent: false } }, extra: [] },
    // A mod pane beside the shell in its tab (panes() lists it with no terminal).
    { id: ID.cap, shellPane: { program: { key: "shell", shell: true, agent: false } }, extra: [{ pane: "pm", terminal: null, mod: "board", tab: "t5" }] },
  ];
  for (const c of cases) {
    state.spaces = [];
    state.panes = [];
    state.runs = [];
    let looks = 0;
    const sleep = async () => {
      if (++looks === 1) {
        state.spaces = [{ id: "s5", folder: w.main, machine: null, active: true, tabs: [{ id: "t5", index: 1, active: true }] }];
        state.panes = [{ pane: "p5", terminal: "t-sh", tab: "t5", ...c.shellPane }];
      }
      const ran = w.calls().filter((a) => a[0] === "run").at(-1);
      const mine = ran && ran.includes(`bot=${c.id}`) ? `t${99 + w.calls().filter((a) => a[0] === "run").length}` : null;
      if (mine && !state.panes.some((p) => p.terminal === mine)) {
        state.spaces = [{ ...state.spaces[0], tabs: [...state.spaces[0].tabs, { id: "t6", index: 2, active: false }] }];
        state.panes = [...state.panes, ...c.extra, { pane: "p6", terminal: mine, tab: "t6" }];
      }
    };
    assert.ok((await startBot(w.main, c.id, { sleep, waitMs: 300 })).terminal);
    assert.deepEqual(state.runs.map(([name]) => name), ["space.new"], JSON.stringify(state.runs));
  }
});

test("startBot: two bots of one project started at once open one space and both start in it", async (t) => {
  const w = await world(t);
  let looks = 0;
  const sleep = async () => {
    if (++looks === 3) state.spaces = [{ id: "s5", folder: w.main, machine: null, active: true, tabs: [{ id: "t5", active: true }] }];
  };
  await Promise.all([startBot(w.main, ID.main, { sleep }), startBot(w.main, ID.cap, { sleep })]);
  assert.equal(state.runs.filter(([name]) => name === "space.new").length, 1);
  const runs = w.calls().filter((a) => a[0] === "run");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((a) => a.includes("herdr.space=s5")));
});

test("startBot: two Starts at once open one pane", async (t) => {
  const w = await world(t);
  const [a, b] = await Promise.all([startBot(w.main, ID.main), startBot(w.main, ID.main)]);
  assert.deepEqual([a, b].map((r) => r.terminal ?? r.refused).sort(), [`${ID.main} is already starting.`, "t100"]);
  assert.equal(w.calls().filter((c) => c[0] === "run").length, 1);
});

test("attachBot runs the CLI: an attach row by attach; a bot attached elsewhere is refused naming it, never moved", async (t) => {
  const w = await world(t, { terminals: (main) => [term("t1", { bot: ID.main, cwd: main }), term("t2", { cwd: main }), term("t3", { cwd: main })] });
  assert.deepEqual(await attachBot(w.main, ID.cap, "t2"), { ok: true });
  assert.deepEqual(w.ledger().at(-1) && [w.ledger().at(-1).event, w.ledger().at(-1).bot, w.ledger().at(-1).terminal, w.ledger().at(-1).by],
    ["attach", ID.cap, "t2", "attach"]);
  assert.equal(w.hcState().terminals.find((x) => x.address === "t2").labels.bot, ID.cap);
  const moved = await attachBot(w.main, ID.cap, "t3");
  assert.match(moved.refused, /Captain \(b-bbbbbbbbbb\) is attached to t2 .*--move/);
  const taken = await attachBot(w.main, ID.dev, "t1");
  assert.match(taken.refused, /t1 already plays Genie \(b-aaaaaaaaaa\)/);
  assert.match((await attachBot(w.main, ID.dev, "vps/t9")).refused, /this computer's panes only/);
  assert.deepEqual(state.hcCalls, []);
});

test("runCli drops the CLI's own prefix from every stderr line: am's, and the long one an older CLI wrote", async (t) => {
  const w = await world(t, { terminals: (main) => [term("t1", { bot: ID.main, cwd: main })] });
  // The real CLI: a refusal reaches the sidebar without its "am: ".
  const taken = await attachBot(w.main, ID.dev, "t1");
  assert.match(taken.refused, /^t1 already plays Genie \(b-aaaaaaaaaa\)/);
  // A stand-in CLI under another app home (the pack's own launcher runs it) that writes both.
  const app = join(w.root, "app2"), bin = join(app, "mods/am-sidebar/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(MOD, "bin/run.sh"), join(bin, "run.sh"));
  writeFileSync(join(bin, "automagik-herdr.mjs"),
    "process.stderr.write(\"am: a warning first.\\nautomagik-herdr: an older CLI wrote this.\\nam: refused.\\n\");\nprocess.exitCode = 1;\n");
  state.appHome = app;
  const r = await runCli(["attach", ID.dev, "t1"]);
  assert.deepEqual([r.code, r.out, r.err], [1, null, "a warning first.\nan older CLI wrote this.\nrefused."]);
});

test("liveTerminalOf and botOfTerminal follow the ledger: a relabel moves nothing", async (t) => {
  const w = await world(t, { terminals: (main) => [term("t1", { bot: ID.main, cwd: main }), term("t2", { cwd: main })] });
  assert.deepEqual(await liveTerminalOf(ID.main), { terminal: "t1", duplicate: false });
  assert.equal(await botOfTerminal("t1"), ID.main);
  const st = w.hcState();
  st.terminals[0].labels = {};
  st.terminals[1].labels = { bot: ID.main };
  w.setHc(st);
  assert.deepEqual(await liveTerminalOf(ID.main), { terminal: "t1", duplicate: false });
  assert.equal(await botOfTerminal("t2"), null);
  assert.equal(await liveTerminalOf(ID.cap), null);
  assert.equal(await botOfTerminal("vps/t1"), null);
});

test("with no CLI under the app home, Start and Attach say so and nothing runs", async (t) => {
  await world(t);
  state.appHome = join(tmpdir(), "no-such-app-home-for-automagik-herdr");
  const r = await startBot("/p", ID.main);
  assert.ok(r.refused, "refused");
  assert.equal(await liveTerminalOf(ID.main), null);
});

// ---- a linked machine: Herdr's exec limit (#444) ----

// The world's hc with a linked machine `vm` (a scratch home here, claude on its PATH) holding
// the team's project, and Herdr's answer to the timeout probe; every exec timeout is kept.
async function linked(t, w, probe) {
  const vm = join(w.root, "vm"), vmBin = join(w.root, "vm-bin"), project = join(vm, "proj");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  mkdirSync(vmBin);
  exe(join(vmBin, "claude"), "#!/bin/sh\nexit 0\n");
  await run("git", ["init", "-q", project]);
  writeFileSync(join(project, ".herdr", "bots.json"), JSON.stringify(team()));
  w.setHc({ ...w.hcState(), machines: [{ name: "vm", id: "core-of-vm", state: "connected", uname: "Linux x86_64", home: vm, path: vmBin }] });
  Object.assign(state, { timeoutProbe: probe, execTimeouts: [] });
  t.after(() => { delete state.timeoutProbe; delete state.execTimeouts; });
  return project;
}
const { MACHINE_EXEC_MS, MACHINE_WORST_MS, SHORT_EXEC_MS, machineCli } = await import("../mods/am-sidebar/launch.js");
const { restartAnswer, restartArgs } = await import("../mods/am-sidebar/restart.js");

const deadlineOf = () => state.calls.filter((c) => c.kind === "exec" && c.command === "env")
  .map((c) => c.args.find((a) => a.startsWith("AUTOMAGIK_HERDR_DEADLINE=")) ?? null);

test("a start on a linked machine: exec gets 600 s, above the CLI's worst case there, on a Herdr that takes it; the pane and its row", async (t) => {
  const w = await world(t);
  const project = await linked(t, w, "honours");
  // The bound is Herdr's cap, and above the worst case computed for a start and a restart there.
  assert.equal(MACHINE_EXEC_MS, 600_000);
  assert.ok(MACHINE_EXEC_MS > MACHINE_WORST_MS.start && MACHINE_EXEC_MS > MACHINE_WORST_MS.restart);
  const r = await startBot(project, ID.dev, {}, "vm");
  assert.deepEqual(r, { terminal: "vm/t100" });
  const cli = state.execTimeouts.filter((x) => x.command === "env");
  assert.deepEqual(cli, [{ command: "env", timeout: MACHINE_EXEC_MS }], "the CLI ran once, with the machine bound");
  assert.deepEqual(state.execTimeouts[0], { command: "true", timeout: "probe" }, "asked first");
  assert.deepEqual(deadlineOf(), [null], "no deadline where Herdr takes the timeout");
  assert.ok(w.calls().some((c) => c[0] === "run" && c[1] === "--on" && c[2] === "vm"));
  assert.deepEqual(w.ledger().map((x) => [x.event, x.terminal, x.machine, x.by]), [["attach", "t100", "vm", "start"]]);
  // This computer's Start passes no timeout: only a linked machine's does.
  state.spaces = [{ id: "s1", folder: w.main, machine: null, active: true, tabs: [{ id: "a", active: true }] }];
  state.execTimeouts = [];
  assert.ok((await startBot(w.main, ID.dev)).terminal);
  assert.deepEqual(state.execTimeouts.filter((x) => x.command === "env"), []);
});

for (const probe of ["ignores", "unreadable"]) {
  test(`a Herdr whose exec timeout ${probe === "ignores" ? "is ignored" : "can't be read"} counts as 30 s: a start on a linked machine runs with that deadline, a restart is refused`, async (t) => {
    const w = await world(t);
    const project = await linked(t, w, probe);
    const before = Date.now();
    assert.deepEqual(await startBot(project, ID.dev, {}, "vm"), { terminal: "vm/t100" });
    const after = Date.now();
    // The deadline: 30 s from before exec, passed to the CLI beside the 600 s Herdr ignores.
    const [word] = deadlineOf();
    const at = Number(word?.split("=")[1]);
    assert.ok(at >= before + SHORT_EXEC_MS && at <= after + SHORT_EXEC_MS, word);
    assert.deepEqual(state.execTimeouts, [{ command: "true", timeout: "probe" }, { command: "env", timeout: MACHINE_EXEC_MS }]);
    assert.ok(w.calls().some((c) => c[0] === "run" && c[2] === "vm"));
    assert.deepEqual(w.ledger().map((x) => [x.event, x.terminal, x.machine]), [["attach", "t100", "vm"]]);
    // Restart, plain (it resumes), as the button asks: refused before the CLI, no Force or Fresh offered.
    const runs = w.calls().length;
    state.execTimeouts = [];
    const again = restartAnswer(await machineCli(restartArgs({ botId: ID.dev, projectKey: project, machine: "vm" }), "restart"));
    assert.deepEqual([again.forceable, again.freshable], [false, false]);
    assert.equal(again.refused, "This Herdr cannot wait long enough for a linked-machine restart; restart it from a terminal.");
    assert.deepEqual(state.execTimeouts, [{ command: "true", timeout: "probe" }], "only the probe ran");
    assert.equal(w.calls().length, runs, "no hc call");
    assert.equal(w.ledger().length, 1);
  });
}

test("Herdr ending the CLI (its 30 s, or the 600 s): may have stopped part-way, what to check, the terminal command; nothing offered again", async (t) => {
  const w = await world(t);
  const project = await linked(t, w, "honours");
  state.execFault = (command) => (command === "env" ? new Error("env took longer than 600 s and was stopped") : null);
  t.after(() => { delete state.execFault; });
  const r = await startBot(project, ID.dev, {}, "vm");
  assert.equal(r.refused, "Herdr stopped the start command before it finished; check the panes for a partial start before retrying from a terminal.");
  const again = restartAnswer(await machineCli(restartArgs({ botId: ID.dev, projectKey: project, force: true, machine: "vm" }), "restart"));
  assert.deepEqual([again.forceable, again.freshable], [false, false], "--force in the command offers no Restart anyway");
  assert.equal(again.refused, "Herdr stopped the restart command before it finished; check the panes for a partial start before retrying from a terminal.");
});

test("the terminal command quotes a folder the shell would split", async () => {
  state.timeoutProbe = "ignores";
  try {
    const r = await machineCli(["restart", ID.dev, "--project", "/srv/my proj's", "--machine", "vm"], "restart");
    assert.ok(r.err.endsWith(`am restart ${ID.dev} --project '/srv/my proj'\\''s' --machine vm`), r.err);
  } finally { delete state.timeoutProbe; }
});

test("hc's keep wrapper: the program it runs is in front (lab/t8's hermes --tui); once it exits, the shell", () => {
  const kept = ["sh", "-c", "\"$@\"; exec \"${SHELL:-sh}\" -i", "sh", "hermes", "--tui"];
  assert.deepEqual(unwrapKeep(kept), ["hermes", "--tui"]);
  assert.equal(agentInForeground({ foreground: { argv: kept, name: "sh" } }), true);
  // After the wrapper's exec the foreground is the login shell: no agent.
  assert.equal(agentInForeground({ foreground: { argv: ["/bin/bash", "-i"] } }), false);
  // Any other sh -c is left as it is.
  assert.deepEqual(unwrapKeep(["sh", "-c", "hermes --tui"]), ["sh", "-c", "hermes --tui"]);
  assert.equal(agentInForeground({ foreground: { argv: ["sh", "-c", "echo hi"] } }), false);
});
