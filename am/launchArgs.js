// Start and Attach over plain data: the `hc run` arguments, the A1 parent rule, the live
// rule (DESIGN Decision 3), which terminal counts among duplicates, the labels of a pane and
// the attach refusal message. Pure: no `herdr`, so `node --test` runs it. Apache-2.0.

import { BOT_LABEL, effectiveCategory, effectiveLead, isSendGrantRole, mainBotOf, projectEntriesOf } from "./model.js";
import { ENV, guardPathWith, paneArgs, paneGuardOf, stableGuardDir, stableRootOf } from "./workers.js";
import { envWords } from "./logins.js";
import { hermesPairProblem, hermesPairConflict } from "./hermesPair.js";

const SHELLS = new Set(["sh", "zsh", "bash", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
const base = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");

/** An hc terminal name for a bot: 1-32 of a-z 0-9 - _, unique among `taken`. */
export function hcName(name, botId, taken = new Set()) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "bot";
  if (!taken.has(slug)) return slug;
  const tail = `-${String(botId).slice(-4)}`;
  const named = `${slug.slice(0, 32 - tail.length)}${tail}`;
  if (!taken.has(named)) return named;
  return null;
}

/**
 * The hc parent of a started bot (DESIGN Decision 5, A1): the main bot has none; a member
 * reports to its effective lead's live terminal and outlives it, else has none.
 * `liveOf(botId)` is that bot's live terminal address, or null.
 */
export function parentArgs(file, botOrId, liveOf, opts = {}) {
  const botId = typeof botOrId === "string" ? botOrId : botOrId?.id;
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot || (bot.kind === "main" && !bot.leadProject)) return ["--no-parent"];
  const { lead } = effectiveLead(file, botId, opts);
  const live = lead ? liveOf(lead) : null;
  return live ? ["--parent", live, "--outlive-parent"] : ["--no-parent"];
}

/** Why a bot can't be started, or null. */
export function startRefusal(file, botId) {
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot) return `No bot ${botId} in this project.`;
  if (bot.hermes !== undefined) {
    const why = bot.agent !== "hermes" ? "Hermes pairing requires the Hermes agent." : hermesPairProblem(bot.hermes) ?? hermesPairConflict(file, bot);
    if (why) return why;
    if (bot.model) return "A paired Hermes bot uses its own model; clear the model pin.";
  }
  if (bot.planned) return `${bot.name} is planned (wave ${bot.planned.wave}); edit it and clear "planned" to start it.`;
  if (!bot.agent) return `${bot.name} has no coding agent; edit it and pick one.`;
  if (bot.kind === "member" && !mainBotOf(file)) return `${bot.name}'s project has no main bot yet; create one first.`;
  return null;
}

/**
 * `hc run` arguments for Start: in the background, labelled with the bot and Herdr's
 * adoption labels, named, in the project folder, with the parent rule, never --no-notify.
 * With `path`, the agent runs as `/usr/bin/env PATH=<path> <argv>`, as a worker does
 * (workers.js workerArgs): the PATH agentPath.mjs interpreterPath gives it (#56). `env`: more
 * variables the agent starts with, after PATH (an agent that takes its briefing that way, models.js).
 * `login`: a Claude launch's login words (logins.js chooseLogin): `-u CLAUDE_CONFIG_DIR` first,
 * or `CLAUDE_CONFIG_DIR=<dir>` last. `agent`: when it is `dsh-tui`, the pack's deny-by-default
 * hc guard folder goes first on the pane PATH (workers.js GUARD_DIR); any other named agent gets
 * the `hc kill` shim's folder there instead (KILL_GUARD_DIR, #955: `hc kill` is for a project's
 * main bot only); no `agent` leaves the PATH as given. `guard`: an explicit folder for this pane
 * (a linked machine's own guard or shim, resolved there), or null for none; undefined uses the
 * agent's default.
 * `sandbox`: a dsh-tui pane runs behind the per-pane hc proxy (hcPane.mjs) before DSH starts;
 * `project` is the folder whose .herdr/bots.json the proxy snapshots (default `cwd`). Any other
 * agent, or no `sandbox`, keeps the argv byte for byte as before. The guard is a guardrail, not
 * a boundary (#624; #628 is the full send/keys/attach scope; #631 is the hard boundary).
 */
export function startArgs({ botId, name, cwd, space, tab, parent, argv, labels = {}, path = null, env: more = {}, login = [], agent = null, guard = undefined, project = cwd, sandbox = false, stableRoot = null }) {
  const args = ["run", "--bg", "--json"];
  if (name) args.push("--name", name);
  args.push("--cwd", cwd, "--label", `${BOT_LABEL}=${botId}`);
  // A16's labels (paneLabels), the bot label already above.
  for (const [k, v] of Object.entries(labels)) if (k !== BOT_LABEL && v) args.push("--label", `${k}=${v}`);
  if (space) args.push("--label", `herdr.space=${space}`);
  if (tab) args.push("--label", `herdr.tab=${tab}`);
  const sandboxRoot = sandbox === true && agent === "dsh-tui" ? (stableRoot ?? stableRootOf()) : null;
  const guardDir = sandboxRoot ? stableGuardDir(sandboxRoot)
    : guard === undefined ? paneGuardOf(agent) : guard;
  const vars = envWords([...(path ? [`PATH=${guardPathWith(path, guardDir)}`] : []), ...Object.entries(more ?? {}).map(([k, v]) => `${k}=${v}`)], login);
  const launchArgv = sandboxRoot ? paneArgs(argv, { botId, project, stableRoot: sandboxRoot }) : argv;
  return [...args, ...parent, "--", ...(vars.length ? [ENV, ...vars] : []), ...launchArgv];
}

// hc's keep wrapper (hc run --keep): the program, then a shell once it exits, as
// `sh -c '"$@"; exec "${SHELL:-sh}" -i' sh <program> <args>…`.
const KEEP_WRAPPER = '"$@"; exec "${SHELL:-sh}" -i';

/** A foreground argv with hc's keep wrapper taken off (the program it runs), else as it is. */
export function unwrapKeep(argv) {
  if (!Array.isArray(argv) || argv.length < 5 || !SHELLS.has(base(argv[0])) || argv[1] !== "-c" || argv[2] !== KEEP_WRAPPER) return argv;
  return argv.slice(4);
}

/**
 * True when `hc get`'s foreground is a program other than a shell (an agent, by Decision 3),
 * looking through hc's keep wrapper: once the program exits, the wrapper execs the shell, so
 * the foreground is a shell again.
 */
export function agentInForeground(get) {
  const argv0 = unwrapKeep(get?.foreground?.argv)?.[0];
  return Boolean(argv0) && !SHELLS.has(base(argv0));
}

/**
 * Whether a `terminals()` row is a live agent: `program.agent` when the row says, null
 * when it doesn't (then the caller asks `hc get`).
 */
export function rowIsAgent(row) {
  return typeof row?.program?.agent === "boolean" ? row.program.agent : null;
}

/** A Claude Code pane: by Herdr's program table, its own report, or its foreground. */
export function isClaude(row, get) {
  return row?.program?.key === "claude" || row?.report?.app === "claude-code" || get?.status?.app === "claude-code"
    || base(get?.foreground?.argv?.[0]) === "claude";
}

/**
 * Herdr-core's status object: `hc get`'s `status` or a terminals() row's `report`.
 * Another kind, no kind, a kind under another state, a plain word or nothing is false.
 */
export function waitsOnPermission(status) {
  return status?.state === "blocked" && status?.kind === "permission";
}

/** Of several `hc get` answers for one bot's label, the newest by created_ms counts. */
export function newest(gets) {
  return gets.reduce((a, b) => ((b?.created_ms ?? -1) > (a?.created_ms ?? -1) ? b : a), null);
}

// ---- A16: the labels a bot pane carries for the event envelope (herdr-meter reads them) ----

export const ROLE_LABEL = "role";
export const CATEGORY_LABEL = "category";
export const SQUAD_LABEL = "squad";
/**
 * Holds the `squad=` value this pack copied from the lead's pane. While the pane's squad
 * still equals it, the squad is ours to move or remove; a squad set later (the helper's)
 * differs from it and is never touched.
 */
export const SQUAD_MARK = "automagik-herdr.squad";

/** Whether a pane's squad is the one this pack copied (its mark still names it). */
export const copiedSquad = (have) => Boolean(have?.[SQUAD_LABEL]) && have?.[SQUAD_MARK] === have[SQUAD_LABEL];

/** The bot a member (or a main bot with a cross-project lead) reports to (A1), "" otherwise. */
export function leadIdOf(file, botOrId, opts = {}) {
  const botId = typeof botOrId === "string" ? botOrId : botOrId?.id;
  const bot = file?.bots?.find((b) => b.id === botId);
  return bot && (bot.kind === "member" || bot.leadProject) ? effectiveLead(file, botId, opts).lead : "";
}

/**
 * A bot pane's `role=` (A16): the main bot is `main`; a member that leads another bot (by
 * effective lead) is `captain`; else its rank. No rank: null (no label).
 */
export function roleOf(file, botOrId, opts = {}) {
  const botId = typeof botOrId === "string" ? botOrId : botOrId?.id;
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot) return null;
  if (bot === mainBotOf(file)) return "main";
  if (file.bots.some((b) => {
    if (b.id === botId || b.kind !== "member") return false;
    const eff = effectiveLead(file, b.id, opts);
    return !eff.leadProject && eff.lead === botId;
  })) return "captain";
  if (opts?.projects) {
    for (const [otherKey, otherFile] of projectEntriesOf(opts.projects)) {
      if (opts.project && otherKey === opts.project) continue;
      for (const b of otherFile?.bots ?? []) {
        if (!b?.leadProject) continue;
        const eff = effectiveLead(otherFile, b.id, { project: otherKey, projects: opts.projects });
        if (eff.lead === botId && (!opts.project || eff.leadProject === opts.project)) return "captain";
      }
    }
  }
  return bot.rank || null;
}

/**
 * The lead's pane whose labels a bot copies its squad from: of the panes carrying the lead's
 * label on this computer (terminals() rows or hc get answers), the live ones with an agent in
 * front (Decision 3), the newest by created_ms. Null when none. Used by Start, Attach and an
 * edit's relabel, in the CLI and the sidebar alike.
 */
export function leadPane(rows) {
  // program.agent false is not the last word: an agent in the foreground counts too.
  const live = (rows ?? []).filter((r) => r?.state === "live" && (rowIsAgent(r) === true || agentInForeground(r)));
  // newest() starts from null, so a row with no created_ms would never be picked.
  return live.length ? live.reduce((a, b) => ((b.created_ms ?? -1) > (a.created_ms ?? -1) ? b : a)) : null;
}

/**
 * The labels a bot's pane should carry (A16): `bot=<id>`; `role=` (roleOf) when there is one;
 * `category=<id>` when its effective category exists. `squad=` is never overwritten: when
 * `existing` (the pane's labels now) has one, it isn't listed; else the lead's pane's squad
 * (`leadLabels`) is copied, with SQUAD_MARK holding the copied value.
 */
function rosterLabels(file, botId, existing = {}, leadLabels = null) {
  const out = { [BOT_LABEL]: botId };
  const role = roleOf(file, botId);
  if (role) out[ROLE_LABEL] = role;
  const category = effectiveCategory(file, botId);
  if (category) out[CATEGORY_LABEL] = category;
  const squad = leadLabels?.[SQUAD_LABEL];
  if (!existing?.[SQUAD_LABEL] && squad) { out[SQUAD_LABEL] = squad; out[SQUAD_MARK] = squad; }
  return out;
}

/** Launch and reconciliation labels omit roles that need a verified grant. */
export function paneLabels(file, botId, existing, leadLabels) {
  const labels = rosterLabels(file, botId, existing, leadLabels);
  if (isSendGrantRole(labels[ROLE_LABEL])) delete labels[ROLE_LABEL];
  return labels;
}

export function grantWords(role, have = {}) {
  return isSendGrantRole(role) && !isSendGrantRole(have[ROLE_LABEL]) ? [`${ROLE_LABEL}=${role}`] : [];
}

/** `hc label` K=V words that bring a pane's labels (`have`) up to `want` (paneLabels): set only. */
export function labelWords(want, have = {}) {
  return Object.entries(want).filter(([k, v]) => v && have?.[k] !== v).map(([k, v]) => `${k}=${v}`);
}

/**
 * Attach's words for a pane (`have`: its labels, the bot label included), the lead's rows
 * given: the pane ends up matching paneLabels. A role= or category= this bot computes
 * differently is set, one it doesn't compute at all comes off (a stale one from the pane's
 * last bot). An unmarked squad is left alone; a squad this pack copied (copiedSquad) takes
 * the lead pane's, or comes off with its mark when the lead's pane has none.
 */
export function attachWords(file, botId, have, leadRows) {
  const leadSquad = leadPane(leadRows)?.labels?.[SQUAD_LABEL] ?? null;
  const want = paneLabels(file, botId, have, leadPane(leadRows)?.labels ?? null);
  if (isSendGrantRole(have?.[ROLE_LABEL])) want[ROLE_LABEL] = have[ROLE_LABEL];
  const words = labelWords(want, have);
  for (const k of [ROLE_LABEL, CATEGORY_LABEL]) if (have?.[k] && !want[k]) words.push(`${k}=`);
  if (copiedSquad(have) && have[SQUAD_LABEL] !== leadSquad) {
    words.push(...(leadSquad ? [`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`] : [`${SQUAD_LABEL}=`, `${SQUAD_MARK}=`]));
  }
  return words;
}

/**
 * The words after an edit (A16): `before` and `after` are paneLabels of the old and new file
 * (no pane labels known). A role or category that changed is set, or removed when the new file
 * has none and the pane still carries the one the old file gave it. The squad: a pane with
 * none gets the lead's (`leadSquad`, the lead pane's squad or null); a squad this pack copied
 * (copiedSquad) follows a lead change: the new lead's, or removed with its mark when the new
 * lead has none. A squad set by anyone else is never touched.
 */
export function relabelWords(before, after, have = {}, { leadChanged = false, leadSquad = null } = {}) {
  const words = [];
  for (const k of [ROLE_LABEL, CATEGORY_LABEL]) {
    if (k === ROLE_LABEL && (isSendGrantRole(have?.[k]) || isSendGrantRole(after[k]))) continue;
    if (after[k] && have?.[k] !== after[k]) words.push(`${k}=${after[k]}`);
    else if (!after[k] && before[k] && have?.[k] === before[k]) words.push(`${k}=`);
  }
  if (!have?.[SQUAD_LABEL]) {
    if (leadSquad) words.push(`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`);
  } else if (leadChanged && copiedSquad(have) && have[SQUAD_LABEL] !== leadSquad) {
    words.push(...(leadSquad ? [`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`] : [`${SQUAD_LABEL}=`, `${SQUAD_MARK}=`]));
  }
  return words;
}

/**
 * The words Detach sends: bot, role and category off (any value: nothing else sets them
 * today); the squad only while it is the one this pack copied, and the mark always.
 */
export function detachWords(have = {}, { preserveGrant = false } = {}) {
  const words = [`${BOT_LABEL}=`];
  if (have?.[ROLE_LABEL] && !(preserveGrant && isSendGrantRole(have[ROLE_LABEL]))) words.push(`${ROLE_LABEL}=`);
  if (have?.[CATEGORY_LABEL]) words.push(`${CATEGORY_LABEL}=`);
  if (copiedSquad(have)) words.push(`${SQUAD_LABEL}=`);
  if (have?.[SQUAD_MARK]) words.push(`${SQUAD_MARK}=`);
  return words;
}

/**
 * The bots whose pane labels an edit changes (A16): every bot of the new file whose role or
 * category differs from the old file's, or whose effective lead changed (a squad to copy or
 * move). Planned bots have no pane. Returns [{ id, lead, before, after, leadChanged }]
 * (before/after: roster labels before filtering grants; `lead`: its lead in the new file).
 */
export function relabelPlan(beforeFile, afterFile) {
  const plan = [];
  for (const b of afterFile?.bots ?? []) {
    if (b.planned) continue;
    const had = beforeFile?.bots?.some((x) => x.id === b.id);
    const before = had ? rosterLabels(beforeFile, b.id) : { [BOT_LABEL]: b.id };
    const after = rosterLabels(afterFile, b.id);
    const lead = leadIdOf(afterFile, b.id);
    const leadChanged = Boolean(had) && leadIdOf(beforeFile, b.id) !== lead;
    if (before[ROLE_LABEL] !== after[ROLE_LABEL] || before[CATEGORY_LABEL] !== after[CATEGORY_LABEL] || leadChanged) {
      plan.push({ id: b.id, lead, before, after, leadChanged });
    }
  }
  return plan;
}

/**
 * Carries out a relabelPlan on this computer's panes, the I/O given (as paneOf takes `ask`):
 * `io.rows(botId)` resolves with the live local panes carrying that bot's label ({ address,
 * labels, state, created_ms, program? | foreground? }); `io.label(address, words)` sets labels
 * and resolves true when hc did. A failure of either is caught and the rest go on: a pane hc
 * didn't label is listed in `failed`; a bot whose panes couldn't be looked up (io.rows threw:
 * hc unavailable) in `unchecked`, since whether it has panes at all is unknown.
 * Resolves { done: addresses, failed: addresses, unchecked: bot ids }.
 */
export async function relabel(plan, io) {
  const done = [], failed = [], unchecked = [];
  for (const item of plan) {
    let rows;
    let leadSquad = null;
    try {
      rows = await io.rows(item.id);
      if (item.lead) leadSquad = leadPane(await io.rows(item.lead))?.labels?.[SQUAD_LABEL] ?? null;
    } catch { unchecked.push(item.id); continue; }
    for (const row of rows.filter((r) => r?.state === "live" && r.address)) {
      const words = relabelWords(item.before, item.after, row.labels ?? {}, { leadChanged: item.leadChanged, leadSquad });
      if (!words.length) continue;
      let ok = false;
      try { ok = await io.label(row.address, words); } catch { ok = false; }
      (ok ? done : failed).push(row.address);
    }
  }
  return { done, failed, unchecked };
}

/** The warning after a relabel, naming the panes not labelled and the bots not checked; null when none. */
export function relabelWarning({ failed = [], unchecked = [] } = {}) {
  const parts = [];
  if (failed.length) parts.push(`these panes' labels weren't updated: ${failed.join(", ")}`);
  if (unchecked.length) parts.push(`these bots' panes could not be checked: ${unchecked.join(", ")}`);
  return parts.length ? `Saved, but ${parts.join("; ")}.` : null;
}

/**
 * The attach check for a Claude pane (DESIGN Approach): the folder its session runs in must
 * key to the bot's project. Returns the refusal, naming both folders and the fix, or null.
 */
export function attachRefusal({ botName, projectKey, sessionFolder, sessionKey }) {
  if (sessionKey === projectKey) return null;
  return `Not attached: this Claude session runs in ${sessionFolder}, which belongs to ${sessionKey}, `
    + `not to ${botName}'s project ${projectKey}. Claude reads its settings only from the folder its `
    + `session started in, so ${botName} would get no role or briefing there. Create the bot in `
    + `${sessionKey} instead, or Start ${botName} fresh in its own project.`;
}

/**
 * A mod command as nextCommand() gives it: its name, then optional arguments as JSON or
 * key=value words ("edit b-x", "edit {\"bot\":\"b-x\"}", "attach bot=b-x terminal=t7").
 */
export function parseCommand(text) {
  const s = String(text ?? "").trim();
  const space = s.search(/\s/);
  if (space < 0) return { name: s, args: {} };
  const name = s.slice(0, space), rest = s.slice(space + 1).trim();
  if (rest.startsWith("{")) { try { return { name, args: JSON.parse(rest) }; } catch { return { name, args: {} }; } }
  const args = {};
  for (const w of rest.split(/\s+/)) {
    const eq = w.indexOf("=");
    if (eq > 0) args[w.slice(0, eq)] = w.slice(eq + 1);
    else if (w.startsWith("b-")) args.bot = w;
    else args.terminal = w;
  }
  return { name, args };
}

// ---- a bot's pane through hc (the CLI and briefing.mjs; launch.js reads Herdr's terminals()) ----

/** What an `ask` resolves with when hc gave no answer in time (a machine away). */
export const UNANSWERED = Symbol.for("automagik-herdr.unanswered");

/** `hc ls --json`'s rows, whichever shape it printed. */
export const rowsOf = (ls) => (Array.isArray(ls?.terminals) ? ls.terminals : Array.isArray(ls) ? ls : []);

/**
 * The panes carrying `bot=<id>` (`hc ls --label`), a display hint only: the attach ledger
 * (attach.js) says which pane plays a bot. Used where there is no ledger yet (the briefing
 * hook before the CLI's first run) and to clear a detached bot's labels. Each is asked with
 * `hc get`, live when an agent is in front; among several, the newest by created_ms, flagged
 * `duplicate`.
 * `ask(args)` runs `hc <args> --json` and resolves with the parsed answer, null when hc
 * failed, or UNANSWERED when it ran out of time; it may also throw (the CLI does when hc
 * fails, so a failure never reads as "no pane"). `localOnly` keeps this computer's
 * terminals (Start, Attach, Detach); the briefing and `ls` look everywhere.
 * Resolves { get, duplicate, addresses, gets } (`get` null: not running; `addresses` every
 * terminal carrying the label; `gets` every hc get answer) or, when any call went
 * unanswered, the same with `unreachable: true`.
 */
export async function paneOf(botId, ask, { localOnly = false } = {}) {
  const none = { get: null, duplicate: false, addresses: [], gets: [] };
  const ls = await ask(["ls", "--label", `${BOT_LABEL}=${botId}`]);
  if (ls === UNANSWERED) return { ...none, unreachable: true };
  const rows = rowsOf(ls).filter((r) => r?.address && r.state !== "finished" && (!localOnly || !r.address.includes("/")));
  const addresses = rows.map((r) => r.address);
  const answers = await Promise.all(rows.map((r) => ask(["get", r.address])));
  // A pane that didn't answer may be the newest: no address beats a stale one.
  if (answers.includes(UNANSWERED)) return { ...none, addresses, unreachable: true };
  const gets = answers.filter((g) => g && typeof g === "object");
  const live = gets.filter((g) => g.state !== "finished" && agentInForeground(g));
  return { get: live.length ? newest(live) : null, duplicate: live.length > 1, addresses, gets };
}

/**
 * Where a bot started from the command line opens in Herdr: the space (and tab) of a live
 * terminal Herdr placed, from its `herdr.space` / `herdr.tab` labels. `gets` are `hc get`
 * answers of terminals whose folder keys to the project; the first placed one counts.
 */
export function placementFrom(gets) {
  const g = gets.find((x) => typeof x?.labels?.["herdr.space"] === "string" && x.labels["herdr.space"]);
  return g ? { space: g.labels["herdr.space"], tab: g.labels["herdr.tab"] || null, from: g.address } : null;
}

/**
 * The spare shell's tab to close once a start's bot shows in a space this start just made
 * (space.new leaves its first tab holding only a shell): `spare` { space, tab, terminal } from
 * when the space was made, `terminal` the bot's. `tabs`: that space's tabs now, each
 * { id, terminals, count } (the terminals its panes show; `count` every pane, a mod pane too,
 * null when unknown). `idle`: the shell has nothing but itself in front (shellIdle). The spare
 * tab's id only while it holds that idle shell alone and the bot shows in another tab of the
 * space, so the space is never left without a tab and nothing else is ever closed; else null.
 * Alone: a known count of one pane; with no count (`herdr-app ls` gives none), only a `fresh`
 * spare, one the start saw right after its own space.new as that space's one tab holding that
 * shell alone (freshSpare): else a mod pane could be there, and it is never closed.
 */
export function spareTab(spare, tabs, terminal, idle) {
  if (idle !== true || !spare?.tab || !spare.terminal || !terminal) return null;
  const list = tabs ?? [];
  const tab = list.find((t) => t?.id === spare.tab);
  const terminals = tab?.terminals ?? [];
  const alone = Number.isSafeInteger(tab?.count) ? tab.count === 1 : tab?.count == null && spare.fresh === true;
  if (!tab || !alone || terminals.length !== 1 || terminals[0] !== spare.terminal) return null;
  return list.some((t) => t?.id !== spare.tab && (t?.terminals ?? []).includes(terminal)) ? spare.tab : null;
}

/**
 * The spare shell space.new just made, as the start saw it in the window right after:
 * { space, tab, terminal, fresh } for `space` (state.mjs spacesOf) and the shell `terminal`
 * space.new printed, or null when no tab there shows it. `same(a, b)` compares two terminal
 * ids (a linked machine's may come with its name). `fresh`: the space is that one tab with that
 * shell as its only terminal, as space.new makes it (spareTab's proof when ls gives no count).
 */
export function freshSpare(space, terminal, same = (a, b) => a === b) {
  if (!space || typeof terminal !== "string" || !terminal) return null;
  const tabs = space.tabs ?? [];
  const tab = tabs.find((t) => (t?.panes ?? []).some((p) => same(p?.terminal, terminal)));
  if (!tab) return null;
  return { space: space.id, tab: tab.id, terminal, fresh: tabs.length === 1 && tab.panes.length === 1 };
}

/**
 * True when `hc get`'s answer shows the shell itself in front: its foreground process is the
 * terminal's own (foreground.pid === pid, both given) and a bare shell, its name and flags only,
 * with no process of its own running (`children`: its child pids, `pgrep -P`; [] for none).
 * False for anything else in front, a shell running a script or command (`bash deploy.sh`,
 * `sh -c …`) included; for a shell at its prompt with a job left running (`sleep 99 &`) or any
 * other child (hc get lists none, so they are asked of the OS); and when hc gave no answer or no
 * pids, or the children are unknown (`children` not an array): then the shell is never closed.
 */
export function shellIdle(get, children) {
  const fg = get?.foreground;
  if (!Array.isArray(children) || children.length) return false;
  if (!Number.isSafeInteger(get?.pid) || fg?.pid !== get.pid) return false;
  const argv = Array.isArray(fg.argv) && fg.argv.length ? fg.argv : [fg.name];
  // A bare interactive shell: its name and flags only (-zsh, bash -i, zsh -l); never -c or a script.
  return Boolean(argv[0]) && SHELLS.has(base(argv[0])) && argv.slice(1).every((a) => /^-[^c]*$/.test(String(a)));
}

/** A start's place with its space only: Herdr then opens the pane in a tab of its own there. */
export const spaceOnly = (place) => (place ? { ...place, tab: null } : place);

/**
 * The same from the window (`herdr-app ls` as state.mjs spacesOf has it): the first space of
 * this computer whose folder keys to the project (`keys`: Map<folder, key>), in its selected
 * tab, passing over the ids in `skip`. Null when none does.
 */
export function spacePlace(spaces, keys, key, skip = new Set()) {
  const s = spaces.find((x) => !x.machine && !skip.has(x.id) && x.folder && keys.get(x.folder) === key);
  return s ? { space: s.id, tab: s.tabs?.find((t) => t.selected)?.id ?? null, from: null } : null;
}
