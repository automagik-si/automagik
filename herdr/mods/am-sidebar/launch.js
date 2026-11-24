// Start and Attach on this computer (DESIGN Approach, Decisions 1-3 and 5, A1), through the
// automagik-herdr CLI: the attach ledger it writes is the only answer to which pane plays a
// bot, so the sidebar never sets a `bot=` label itself. The CLI runs through bin/run.sh (it
// finds node 22.7 or later, or bun, where Herdr's PATH has none) with this app home. Apache-2.0.

import { spaces, panes, focused, run, readTextFile, writeTextFile, exec, appHome, notify, home } from "herdr";
import { keyOf, rememberProject } from "./bots.js";
import { installHook, runnerPath } from "./briefingText.mjs";
import { spareTab } from "./launchArgs.js";
import { configPaths } from "./models.js";
import { MODEL_PROBE, parseModelProbe } from "./modelsRemote.js";
import { PACK_NAME } from "./release.js";
import { actionError } from "./actionError.js";

const local = (address) => typeof address === "string" && !address.includes("/");
const cliPath = (dir) => `${dir.replace(/\/+$/, "")}/mods/${PACK_NAME}/bin/automagik-herdr.mjs`;

/**
 * Runs `automagik-herdr <args> --json` with this app home: { code, out (its JSON, or null),
 * err (stderr, the `automagik-herdr: ` prefixes dropped) }; `thrown: true` when exec itself
 * failed (Herdr ended the CLI at its limit, say). Never rejects. `timeout`: exec's, in ms;
 * `env`: more KEY=value words for the CLI.
 */
export async function runCli(args, { timeout, env = [] } = {}) {
  const dir = appHome();
  let r;
  try {
    r = await exec("env", [`HERDR_APP_HOME=${dir}`, ...env, "sh", runnerPath(dir), cliPath(dir), ...args, "--json"], ...(timeout ? [{ timeout }] : []));
  } catch (e) {
    console.error(e?.stack ?? e);
    return { code: 127, out: null, err: String(e?.message ?? e), thrown: true };
  }
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { code: r.code, out, err: String(r.stderr ?? "").replace(/^(?:am|automagik-herdr): /gm, "").trim() };
}

// ---- Start and Restart on a linked machine (#444): Herdr's exec limit ----
//
// Herdr ends a mod's exec at 30 s unless given a `timeout` (its cap 10 min), and its kill reaches
// the CLI itself (run.sh execs node). Ended after `hc run`, a start leaves a pane with no attach
// row, and a restart leaves the new pane beside the old one, both able to resume one session.
// The CLI's own worst case there, every call at its own bound (15 s for each hc, herdr-app or
// remote program; 20 s for each of agentThere's three questions; 3 s for each lock wait), with
// git answering on the machine and at most 8 ledger rows, helpers and other panes there to check:
// a start 18 x 15 s + 71.2 s = 341.2 s (agentThere 60 s, closeSpare's 5 s wait), plus 60 s for
// each other space of that machine Herdr shows; a restart 23 x 15 s + 2 x 60 s (agentThere)
// + 2 x 45.25 s (agentUp: its 30 s, a 250 ms step, then one last hc get) + 6 s of locks = 561.5 s
// (two seats when codex can't resume its thread, #413). More rows, helpers or spaces, or a
// project outside git deep in the tree there, can still pass the cap. The timeout is passed on
// every Herdr: one that doesn't take it ignores it.
export const MACHINE_WORST_MS = Object.freeze({ start: 341_200, restart: 561_500 });
export const MACHINE_EXEC_MS = 600_000;
/** Herdr's own limit for a program run with no timeout it takes. */
export const SHORT_EXEC_MS = 30_000;

/**
 * Whether the running Herdr honours exec's `timeout` (am-quota's probe): one that does refuses
 * a timeout that isn't a number, before it runs anything; one that doesn't runs the harmless
 * program. Any other answer counts as not, the safe side. Asked on every press, never kept: an
 * answer that couldn't be read then is asked again next time.
 */
export async function honoursTimeout() {
  try {
    await exec("true", [], { timeout: "probe" });
    return false;
  } catch (e) {
    return /timeout must be/.test(String(e?.message ?? e));
  }
}

const shellWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`);

/**
 * runCli for `start` or `restart` with --machine (`what`), or this computer's `restart --tree`
 * (it runs each helper in turn: 26.5 s with 4 helpers, 36.8 s with 6), with MACHINE_EXEC_MS. On a Herdr that
 * doesn't take it, or can't say, Herdr ends the CLI at 30 s: a start runs with that deadline
 * (AUTOMAGIK_HERDR_DEADLINE, an absolute time taken before exec, so it counts run.sh and node's
 * startup), and the CLI starts nothing when too little of it is left to finish; a restart isn't
 * run, since after hc run it may still wait 30 s for the agent, and two panes on one session is
 * the worse failure. That refusal, and an exec that failed (Herdr ended the CLI at its limit),
 * come back as { code: 1, out: null, err, asIs: true }: err names what to check and the same
 * command for a terminal, where no limit applies.
 */
export async function machineCli(args, what) {
  const at = args.indexOf("--machine");
  const machine = at >= 0 ? args[at + 1] : "this computer";
  const onMachine = at >= 0 ? ` --machine ${shellWord(machine)}` : "";
  const command = `am ${args.map(shellWord).join(" ")}`;
  const long = await honoursTimeout();
  if (!long && what === "restart") {
    return { code: 1, out: null, asIs: true,
      err: `This Herdr ends the sidebar's programs at 30 s (it takes no longer exec timeout, or didn't say), and a restart on ${machine} `
        + `can take minutes when it answers slowly: ended after its new pane started, it would leave that pane running beside the old one, `
        + `both on one session. Nothing was restarted. Restart it from a terminal: ${command}` };
  }
  const env = long ? [] : [`AUTOMAGIK_HERDR_DEADLINE=${Date.now() + SHORT_EXEC_MS}`];
  const r = await runCli(args, { timeout: MACHINE_EXEC_MS, env });
  if (!r.thrown) return r;
  const bot = shellWord(args[1]);
  const project = args.indexOf("--project") >= 0 ? ` --project ${shellWord(args[args.indexOf("--project") + 1])}` : "";
  const check = what === "restart"
    ? `its old pane and a new one may both run it: check ${machine}'s panes (hc ls) and end the one am whois --bot ${bot}${project}${onMachine} doesn't name with hc kill`
    : `a pane may run it with no attach row: check with am whois --bot ${bot}${project}${onMachine} and ${machine}'s panes (hc ls), and end a pane of it the attach ledger doesn't name with hc kill`;
  return { code: 1, out: null, asIs: true,
    err: `Herdr ended am ${what} on ${machine} (${r.err}), and it may have stopped part-way: ${check}. `
      + `Then ${what} it from a terminal if it isn't running: ${command}` };
}

const refusedBy = (r, what) => {
  if (what !== "start") return { refused: r.err || `am ${what} failed (exit ${r.code}).` };
  console.error(`am ${what}: ${r.err || `exit ${r.code}`}`);
  return { refused: actionError(r.err, what === "start" ? "Start" : "Attach") };
};
const warn = (bodies) => { for (const body of bodies ?? []) notify({ title: "Bots", body, level: "warning", timeout: 15000 }); };

/**
 * A bot's pane by the attach ledger (`automagik-herdr whois --bot`): { terminal, duplicate:
 * false }, or null when it plays nowhere (or the CLI can't answer).
 */
export async function liveTerminalOf(botId, machine = null) {
  // On a linked machine: its binding there (whois keeps the bare tN), addressed machine/tN.
  const r = await runCli(["whois", "--bot", botId, ...(machine ? ["--machine", machine] : [])]);
  const terminal = r.code === 0 ? r.out?.terminal ?? null : null;
  return terminal ? { terminal: machine ? `${machine}/${terminal}` : terminal, duplicate: false } : null;
}

/** The bot a terminal plays by the attach ledger (`automagik-herdr whois <t>`), or null. */
export async function botOfTerminal(terminal) {
  if (!local(terminal)) return null;
  const r = await runCli(["whois", terminal]);
  return r.code === 0 ? r.out?.bot ?? null : null;
}

/**
 * Every binding the attach ledger holds (`automagik-herdr whois --all --json`, its
 * bots.whois-all-json@1 answer), rows of { terminal, core, created_ms, bot, project, since,
 * address, machine, state } with `state` "live" or "unknown" (a machine away), or null when the
 * CLI can't answer. The CLI is asked the exact call runCli completes with `--json`; an older
 * build without `--all` (it lands with #1616) refuses the flag, so null keeps rows.js on the
 * bot= labels: no row is lost and nothing is thrown. A success that isn't the @1 shape reads
 * the same way.
 */
export async function ledgerBindings() {
  const r = await runCli(["whois", "--all"]);
  if (r.code !== 0) return null;
  return Array.isArray(r.out?.bindings) ? r.out.bindings : null;
}

/**
 * The briefing hook for a Claude bot (DESIGN Approach "Group 3", Decision 9): it ties the session
 * to its pane, and gives the briefing once to a pane whose agent wasn't started with it (the CLI's
 * Start and Restart put it in the agent's system prompt). Merges the
 * hook entry, if absent, into `<sessionFolder>/.claude/settings.local.json` (never the shared
 * settings.json) and keeps that file out of git through the clone's exclude file. Writes
 * nothing, and tells the owner the README fix, when the pack's briefing.mjs isn't at the path
 * computed from appHome(). `claude`: whether the session is Claude Code (no other agent runs
 * these hooks). Never throws: a failure is a notification, never a refused Start or Attach.
 * Resolves with { written } (true when the hook entry was added or updated).
 */
export async function afterBind(bot, sessionFolder, claude = bot?.agent === "claude") {
  if (!claude || !sessionFolder) return { written: false };
  const folder = sessionFolder.length > 1 ? sessionFolder.replace(/\/+$/, "") : sessionFolder;
  const io = {
    git: async (args, cwd) => { try { return await exec("git", args, { cwd }); } catch { return null; } },
    read: (path) => readTextFile(path),
    write: (path, text, before) => writeTextFile(path, text, before),
    // The stable briefing entry, made the owner's alone (briefingText.mjs entryCommand).
    private: async (path) => { await exec("chmod", ["600", path]); },
    mkdir: async (dir) => {
      const r = await exec("mkdir", ["-p", dir]);
      if (r.code !== 0) throw new Error(`couldn't make ${dir}: ${r.stderr.trim()}`);
    },
  };
  // The same flow as the CLI's (briefingText.mjs installHook); warnings become notifications.
  const { written, warnings } = await installHook(bot.name, folder, appHome(), io);
  for (const body of warnings) notify({ title: "Bots", body, level: "warning", timeout: 15000 });
  return { written };
}

// The agents' own config texts (models.js configPaths), for the model pin list here and
// the default model the sidebar's rows show (main.js).
export async function modelTexts() {
  const out = {};
  for (const [name, path] of Object.entries(configPaths(home()))) {
    try { out[name] = await readTextFile(path); } catch { out[name] = null; }
  }
  return out;
}

// The same defaults' files on a linked machine (#2097): null when it can't be read (away, no
// shell), else the texts modelsRemote.js parses.
export async function remoteModelTexts(machine) {
  try { return parseModelProbe(await exec("sh", ["-c", MODEL_PROBE], { on: machine })); } catch { return null; }
}

/** A sleep from a mod context's timer (mods have no setTimeout), for startBot; null without one. */
export const sleepOf = (cx) => (cx?.timer ? (ms) => new Promise((done) => cx.timer.after(ms, () => done())) : null);

const localSpaces = () => spaces().filter((s) => !s.machine);
// Every space of `list` whose folder keys to the project, in window order.
async function keyedSpaces(list, projectKey) {
  const out = [];
  for (const s of list) {
    try { if (s.folder && (await keyOf(s.folder)) === projectKey) out.push(s); } catch {}
  }
  return out;
}

// Spaces being opened now, one per project: a second Start in that project waits for it.
const opening = new Map(); // project key -> promise of the shared create and placement result

const shownSpace = () => {
  const mine = localSpaces();
  return mine.find((s) => s.id === focused()?.space) ?? mine.find((s) => s.active) ?? null;
};

// A space's tabs as spareTab reads them: each tab's id, the terminals its panes show and
// `count`, every pane in it: panes() lists a mod pane too (with no terminal), and the tab's own
// `panes` count is taken when it says more.
const tabsOf = (space) => {
  const ps = panes() ?? [];
  return (space?.tabs ?? []).map((t) => {
    const mine = ps.filter((p) => p?.tab === t.id);
    return { id: t.id, terminals: mine.filter((p) => p.terminal).map((p) => p.terminal),
      count: Math.max(mine.length, Number.isSafeInteger(t.panes) ? t.panes : 0) };
  });
};
// The spare shell has the shell itself in front (panes()' program), nothing else running.
const shellIdleIn = (terminal) => {
  const program = (panes() ?? []).find((p) => p?.terminal === terminal)?.program;
  return program?.shell === true && program.agent !== true;
};

// Only a failure before sending the request allows the old run() path. A timeout or lost reply
// can leave the window still processing the create.
async function requestSpace(args) {
  let r;
  try {
    r = await exec("env", [`HERDR_APP_HOME=${appHome()}`, "herdr-app", "do", "space.new", JSON.stringify(args)], { timeout: 5000 });
  } catch (e) {
    const spawnFailed = /^cannot run env: /.test(e?.message ?? "") || (e?.code === "ENOENT" && e.syscall === "spawn env");
    return { fallback: spawnFailed, ack: null };
  }
  const err = (r.stderr ?? "").trim();
  if (!(r.stdout ?? "").trim()) {
    const noWindow = (r.code === 1 || r.code === 2)
      && /^herdr-app: (?:no window is open|no Herdr window at [^\n]+: [^\n]+)$/.test(err);
    const missing = r.code === 127 && /^env: (?:herdr-app|'herdr-app'|‘herdr-app’): No such file or directory$/.test(err);
    if (noWindow || missing) return { fallback: true, ack: null };
  }
  let ack = null;
  if (r.code === 0 && !err.includes("hung up")) {
    try { ack = JSON.parse(r.stdout); } catch { /* the reply may have been lost */ }
  }
  if (!local(ack?.terminal) || !ack.terminal.trim() || Object.hasOwn(ack, "error")) ack = null;
  return { fallback: false, ack };
}

// Two starts can each open a space: use the first space on the project, or the shown space
// after the wait. The acknowledgement identifies the create's shell for cleanup.
async function openSpace(projectKey, sleep, { waitMs = 5000, stepMs = 100 } = {}) {
  const before = new Set(localSpaces().map((s) => s.id));
  const args = { name: projectKey.replace(/\/+$/, "").split("/").pop(), folder: projectKey, machine: "" };
  const { fallback, ack } = await requestSpace(args);
  if (fallback) {
    console.error("Sidebar Start: herdr-app could not send space.new, falling back to run().");
    try { run("space.new", args); } catch { return null; }
  } else if (!ack) {
    console.error("Sidebar Start: herdr-app did not acknowledge space.new with a terminal id.");
  }
  let space = null, spare = null, late = null;
  for (let waited = 0; ; waited += stepMs) {
    const here = localSpaces();
    const fresh = await keyedSpaces(here.filter((s) => !before.has(s.id)), projectKey);
    if (fresh.length) {
      const [first] = await keyedSpaces(here, projectKey);
      if (fallback) {
        for (const s of fresh) if (s.id !== first?.id) closeMadeSpace(s);
      }
      if (first) {
        space = first;
        if (fallback && !before.has(first.id)) spare = spareOf(first);
        break;
      }
    }
    if (waited >= waitMs) {
      if (fallback) late = before;
      break;
    }
    await sleep(stepMs);
  }
  if (!fallback) space ??= shownSpace();
  if (ack && space) {
    const tab = acknowledgedTab(space, tabsOf(space), ack);
    if (tab) spare = { space: space.id, tab: tab.id, terminal: ack.terminal };
  }
  return { space, spare, late, ack, fallback };
}

function acknowledgedTab(space, tabs, ack) {
  if (ack.space !== undefined && space.id !== ack.space) return null;
  return tabs.find((tab) => (ack.tab === undefined || tab.id === ack.tab) && tab.terminals.includes(ack.terminal)) ?? null;
}

async function closeAcknowledgedSpace(ack, usedSpace, sleep, { waitMs = 60_000, stepMs = 1000 } = {}) {
  for (let waited = 0; ; waited += stepMs) {
    // Read the current layout without yielding between inspecting it and asking to close.
    for (const space of localSpaces()) {
      if (ack.space !== undefined && space.id !== ack.space) continue;
      const tabs = tabsOf(space);
      const tab = acknowledgedTab(space, tabs, ack);
      if (!tab) continue;
      if (space.id !== usedSpace && tabs.length === 1 && tab.count === 1 && shellIdleIn(ack.terminal)) {
        run("space.close", { id: space.id, confirmed: true });
      }
      return;
    }
    if (waited >= waitMs) return;
    await sleep(stepMs);
  }
}

// The spare shell of a space this start just made, as closeSpare takes it: its one tab holds
// that shell alone. Null when the window shows no such tab (nothing is ever closed unseen).
function spareOf(space) {
  const [first] = tabsOf(space);
  const alone = first?.terminals.length === 1 && first.count === 1;
  return alone ? { space: space.id, tab: first.id, terminal: first.terminals[0] } : null;
}

// A space this start opened that another start's space made superfluous: closed only while it
// holds space.new's own shell, alone in its one tab and idle. Every tab is inspected: a space
// with a second tab (a CLI-started bot there, say) is left whole, since closing it would take
// that tab down too. When the window can't say the shell is alone, never closed.
function closeMadeSpace(space) {
  const tabs = tabsOf(space);
  if (tabs.length !== 1) return false;
  const [tab] = tabs;
  if (tab?.terminals.length !== 1 || tab.count !== 1 || !shellIdleIn(tab.terminals[0])) return false;
  try { run("space.close", { id: space.id, confirmed: true }); return true; } catch { return false; }
}

// A start whose space.new didn't show in time starts in the shown space; the space Herdr was
// making can still show afterwards. This closes it once it does, while it holds only
// space.new's shell, alone and idle: a bot that started there is never touched. `before`: the
// spaces there when this start asked for one.
async function sweepLateSpaces(projectKey, before, sleep, { waitMs = 60_000, stepMs = 1000 } = {}) {
  const closed = new Set();
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await sleep(stepMs);
    const late = await keyedSpaces(localSpaces().filter((s) => !before.has(s.id) && !closed.has(s.id)), projectKey);
    for (const s of late) if (closeMadeSpace(s)) closed.add(s.id);
  }
}

// Once the bot just started (`terminal`) shows in its own tab of the space openSpace made, that
// space's spare shell tab is closed (spareTab: only while it holds that shell alone, one pane,
// with nothing but the shell in front). Never `confirmed`: Herdr asks the person only before
// closing a space's last tab, and this is never the last one (the bot's tab stays). Looked for
// every stepMs for up to waitMs; a bot that doesn't show in time leaves it.
async function closeSpare(spare, terminal, sleep, { waitMs = 5000, stepMs = 100 } = {}) {
  for (let waited = 0; ; waited += stepMs) {
    const space = localSpaces().find((s) => s.id === spare.space);
    if (!space) return;
    const tabs = tabsOf(space);
    if (tabs.some((t) => t.terminals.includes(terminal))) {
      const tab = spareTab(spare, tabs, terminal, shellIdleIn(spare.terminal));
      if (tab) try { run("tab.close", { id: tab }); } catch { /* the shell tab stays: nothing lost */ }
      return;
    }
    if (waited >= waitMs) return;
    await sleep(stepMs);
  }
}

// Where a started bot opens: the first space of this computer whose folder keys to the
// project, else a space opened on it (with a `sleep` to wait for it), else the shown space;
// in a tab of its own there (no --tab).
async function placeFor(projectKey, { sleep = null, ...wait } = {}) {
  let space = (await keyedSpaces(localSpaces(), projectKey))[0] ?? null;
  let opened = null;
  if (!space && sleep) {
    if (!opening.has(projectKey)) {
      opening.set(projectKey, openSpace(projectKey, sleep, wait).finally(() => opening.delete(projectKey)));
    }
    opened = await opening.get(projectKey);
    space = opened?.space ?? null;
  }
  if (!opened || opened.fallback) space ??= shownSpace();
  return { space: space?.id ?? null, opened };
}

// Bots being started now: a second click waits for nothing and is refused.
const starting = new Set();

/**
 * Starts a bot as a new pane on this computer (`automagik-herdr start`, which writes its
 * attach row), or focuses the pane the ledger already ties it to. The CLI's refusals (a
 * planned bot, no agent, an unlisted model pin) come back as { refused }. `place.sleep`
 * (sleepOf(cx)) lets it open a space on the project when none shows it (placeFor).
 */
export async function startBot(projectKey, botId, place = {}, machine = null) {
  if (starting.has(botId)) return { refused: `${botId} is already starting.` };
  starting.add(botId);
  try { return await (machine ? startOn(projectKey, botId, machine) : startOnce(projectKey, botId, place)); }
  catch (e) {
    console.error(e?.stack ?? e);
    return { refused: actionError(e, "Start") };
  } finally { starting.delete(botId); }
}

// Start on a linked machine (automagik#206): the CLI finds the window place there itself.
async function startOn(projectKey, botId, machine) {
  const r = await machineCli(["start", botId, "--project", projectKey, "--machine", machine], "start");
  if (r.code !== 0) return refusedBy(r, "start");
  if (r.out?.running) {
    run("agent.focus", { terminal: `${machine}/${r.out.running}` });
    return { focused: `${machine}/${r.out.running}` };
  }
  warn(r.out?.warnings);
  rememberProject(projectKey, machine);
  return { terminal: r.out?.terminal ? `${machine}/${r.out.terminal}` : null };
}

async function startOnce(projectKey, botId, place) {
  const { space, opened } = await placeFor(projectKey, place);
  // Without --space the CLI can ask for another create of its own.
  if (!space && opened?.fallback === false) {
    return { refused: "Herdr has no visible space for this Start. Wait for the project space to appear, or open a space and try again." };
  }
  const where = space ? ["--space", space] : [];
  const r = await runCli(["start", botId, "--project", projectKey, ...where]);
  const { ack, spare, late } = opened ?? {};
  const lateWait = { waitMs: place.lateWaitMs, stepMs: place.lateStepMs };
  if (ack && !spare && ack.space !== space && !opened.closing) {
    opened.closing = true;
    closeAcknowledgedSpace(ack, space, place.sleep, lateWait).catch(() => {});
  }
  // A space that showed after openSpace gave up is closed once it holds only its shell.
  // Started with no --space, the CLI may have used it for the bot: then it holds more.
  if (late && place.sleep) {
    sweepLateSpaces(projectKey, late, place.sleep, lateWait).catch(() => {});
  }
  if (r.code !== 0) return refusedBy(r, "start");
  warn(r.out?.warnings);
  if (r.out?.running) {
    run("agent.focus", { terminal: r.out.running });
    return { focused: r.out.running };
  }
  rememberProject(projectKey);
  if (spare && r.out?.terminal) {
    const { sleep, ...wait } = place;
    await closeSpare(spare, r.out.terminal, sleep, wait);
  }
  return { terminal: r.out?.terminal ?? null };
}

/**
 * Ties a running pane on this computer to a bot (`automagik-herdr attach`, which writes the
 * attach row and sets the labels). Never a silent move: a bot the ledger ties to another
 * pane is refused, naming it (the CLI's `attach --move` moves it).
 */
export async function attachBot(projectKey, botId, terminal, machine = null) {
  // A bot plays a pane on its project's machine only (this computer's, or that linked one's).
  const mine = machine ? typeof terminal === "string" && terminal.startsWith(`${machine}/`) : local(terminal);
  if (!mine) {
    return { refused: machine ? `${terminal} isn't on ${machine}, where this bot's project is; focus one of ${machine}'s panes.`
      : `Attach works on this computer's panes only; ${terminal} is on another machine.` };
  }
  const r = await runCli(["attach", botId, terminal, "--project", projectKey, ...(machine ? ["--machine", machine] : [])]);
  if (r.code !== 0) return refusedBy(r, "attach");
  warn(r.out?.warnings);
  rememberProject(projectKey, machine);
  return { ok: true };
}
