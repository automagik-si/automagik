// The bot view over plain data: which bots are live (DESIGN Decision 3, counting every
// machine), each bot's pose (Decision 7, A6), the tree of a project (A1 nesting, A2
// categories, A3 planned, helpers from herdr-core's parent field), where each project's tree
// goes in the sidebar (A8), the rows a fold state leaves showing (A7) and the machines' order.
// Pure: no `herdr`, `gpui-kit` or `gpui-base`, so `node --test` runs it. Apache-2.0.

import { BOT_LABEL, RANKS, cleanProjectPath, crossMemberWarnings, mainBotOf, effectiveLead } from "./model.js";
import { agentInForeground, rowIsAgent, waitsOnPermission } from "./launchArgs.js";
import { AGENTS, detectModel, defaultModelFrom, resolveAgent } from "./models.js";
import { workerBranch, workerTaskId } from "./workers.js";
import { NEEDS_OWNER_LABEL, needsOwnerStale } from "./tidy.js";

/** Idle this long is asleep (Automagik's own threshold). */
export const ASLEEP_MS = 10 * 60 * 1000;

/** A project's identity in the view: its machine and key. */
export const projectId = (p) => JSON.stringify([p?.machine ?? null, p?.key ?? null]);

const addressOf = (t) => t?.address ?? t?.id ?? null;
// Decision 3: an agent in front, by the program table or by the foreground process. The
// table can say shell while an agent runs (herdr-core lists the pane by its shell when the
// agent's report is missing or stale), so a false there never hides an agent in front: the
// row's own `foreground.argv` when it has one, else the command line the view read with
// `hc get` (`readArgv`, for this pane only).
const agentInFront = (t, readArgv) => rowIsAgent(t) === true
  || agentInForeground(Array.isArray(t.foreground?.argv) ? t : { foreground: { argv: readArgv(t) } });

/**
 * The program a core report's app name stands for (`report.app`, #793): Herdr's own table
 * names it by key or a key prefix (`claude-code` is claude's), else the pack's agent table maps
 * the run's program name (`agy` is antigravity) to that table's entry, or a plain one when Herdr
 * doesn't list the agent. Null when neither knows the name.
 */
export function programForApp(app, known = []) {
  if (typeof app !== "string" || !app) return null;
  const listed = known ?? [];
  const direct = listed.find((x) => x.key === app || app.startsWith(`${x.key}-`));
  if (direct) return direct;
  const key = resolveAgent(app);
  if (!key) return null;
  return listed.find((x) => x.key === key) ?? { key, name: AGENTS[key]?.name ?? key, icon: null, tint: false };
}

const machineOfAddress = (a) => (typeof a === "string" && a.includes("/") ? a.slice(0, a.indexOf("/")) : null);
// A ledger binding's terminal address (the full one: `hx/t4`), and the project id of the
// project it plays in, or null.
const bindingAddress = (b) => (typeof b?.address === "string" && b.address ? b.address
  : (b?.machine && typeof b?.terminal === "string" && !b.terminal.includes("/") ? `${b.machine}/${b.terminal}` : b?.terminal ?? null));
const bindingProject = (b) => (b?.project
  ? projectId({ machine: b.machine ?? machineOfAddress(bindingAddress(b)), key: b.project }) : null);

/**
 * The live map: bot id -> its live pane, from `terminals()` rows. With `bindings` (the attach
 * ledger's `whois --all` answer, rows with `{ bot, address, project, machine, state }`), the
 * ledger names each bot's pane: a terminal counts while it is live and has an agent in front,
 * whatever its `bot=` label says, and only the bindings that are `live` count. Without
 * `bindings` (`null`), a terminal counts while it is live, carries `bot=<id>` for a bot in
 * `known` (every id when `known` is null) and has an agent in front. On any machine: the view
 * shows remote bots too (launch.js' liveTerminalOf is this computer's only, for Start and
 * Attach). Several holders: the newest by `created_ms` counts, flagged `duplicate`. `argv`:
 * the pane's foreground command line when the row carries it (`foreground.argv`), else what
 * `argvOf(address, created_ms)` gives (the command line the view read with `hc get` for that
 * very pane: see argvReader), else null. `parent`: the hc parent of that terminal (null: none),
 * where its click opens a tab. `panes`, only with several holders: every holder's address, the
 * counted one first (the parent mark compares with all of them). By project and id
 * (paneCounts): `keyOf(row)` gives a pane's project key or null, or the binding's `project`;
 * a pane with one is at liveKey(id, its projectId), the newest of that project's panes and
 * those with none; a bot's panes with none at its bare id. Read it with liveOf.
 */
export function liveFrom(terminals, known = null, argvOf = () => null, keyOf = () => null, bindings = null) {
  const readArgv = (t) => { const v = argvOf(addressOf(t), t.created_ms ?? null); return Array.isArray(v) ? v : null; };
  // id -> { any: the panes with no project, at: Map project id -> that project's panes }
  const holders = new Map();
  const hold = (id, pid, t) => {
    if (!holders.has(id)) holders.set(id, { any: [], at: new Map() });
    const h = holders.get(id);
    if (pid === null) h.any.push(t);
    else h.at.set(pid, [...(h.at.get(pid) ?? []), t]);
  };
  if (bindings !== null) {
    const rows = new Map((terminals ?? []).filter((t) => addressOf(t)).map((t) => [addressOf(t), t]));
    for (const b of bindings ?? []) {
      const id = b?.bot;
      if (!id || (known && !known.has(id)) || (b.state && b.state !== "live")) continue;
      const t = rows.get(bindingAddress(b));
      if (t && t.state === "live" && agentInFront(t, readArgv)) hold(id, bindingProject(b), t);
    }
  } else {
    for (const t of terminals ?? []) {
      const id = t?.labels?.[BOT_LABEL];
      if (!id || (known && !known.has(id)) || t.state !== "live" || !addressOf(t) || !agentInFront(t, readArgv)) continue;
      hold(id, paneProject(t, keyOf), t);
    }
  }
  const entry = (rows) => {
    const pick = rows.reduce((a, b) => ((b.created_ms ?? -1) > (a.created_ms ?? -1) ? b : a));
    return {
      terminal: addressOf(pick), duplicate: rows.length > 1, parent: pick.parent ?? null, status: pick.status ?? null,
      status_ms: typeof pick.status_ms === "number" ? pick.status_ms : null, program: pick.program ?? null,
      argv: Array.isArray(pick.foreground?.argv) ? pick.foreground.argv : readArgv(pick),
      ...(rows.length > 1 ? { panes: [addressOf(pick), ...rows.filter((r) => r !== pick).map(addressOf)] } : {}),
    };
  };
  // A project's holders are its own panes and the panes with no project (paneCounts).
  const live = {};
  for (const [id, { any, at }] of holders) {
    if (any.length) live[id] = entry(any);
    for (const [pid, rows] of at) live[liveKey(id, pid)] = entry([...rows, ...any]);
  }
  return live;
}

/**
 * The live map's key for bot `botId`'s pane in the project `pid` (projectId), or, with no
 * `pid`, for its pane with no project: liveOf reads either.
 */
export const liveKey = (botId, pid = null) => (pid === null ? botId : `${pid}\n${botId}`);

/** Bot `botId`'s live pane for `project` in liveFrom()'s map (paneCounts), or null. */
export const liveOf = (live, project, botId) => live?.[liveKey(botId, projectId(project))] ?? live?.[botId] ?? null;

/**
 * The terminal address -> bot id map the sidebar draws rows from: the ledger's live bindings
 * when it answers (`bindings`), never the pane's `bot=` label; the labels when it can't answer
 * (`null`), so a CLI without `whois --all` still draws its rows. `known`: the ids a project
 * defines; a binding for any other id is no bot row.
 */
export function botTerminals(terminals, known, bindings = null) {
  const rows = new Map((terminals ?? []).filter((t) => addressOf(t)).map((t) => [addressOf(t), t]));
  const out = new Map();
  if (bindings !== null) {
    for (const b of bindings ?? []) {
      const id = b?.bot;
      if (!id || (known && !known.has(id)) || (b.state && b.state !== "live")) continue;
      const t = rows.get(bindingAddress(b));
      if (t) out.set(addressOf(t), id);
    }
    return out;
  }
  for (const t of rows.values()) {
    const id = t?.labels?.[BOT_LABEL];
    if (id && known.has(id)) out.set(addressOf(t), id);
  }
  return out;
}

// An address on `machine`: a bare id given for a pane there is that machine's, so two
// addresses compare on the same machine (box/t1 and t1 reported by a box pane are one).
const onMachine = (a, machine) => (machine && !a.includes("/") ? `${machine}/${a}` : a);

/**
 * The parent mark (automagik#231): `own`, a bot's live pane (liveOf), reports through an hc
 * parent that is neither absent nor any of its lead's live panes (`leadLive`, the lead's
 * liveOf entry: its `panes` when it has several, else its `terminal`). Returns { parent,
 * leadPanes, lead, leadName }, every address on its machine, or null: no parent, one of the
 * lead's panes, or a lead with no live pane (nothing to compare with). Membership never
 * follows the hc parent (buildTree); this only shows it.
 */
export function parentMarkOf(own, leadLive, lead = null, leadName = null) {
  if (typeof own?.parent !== "string" || !own.parent || typeof leadLive?.terminal !== "string") return null;
  const parent = onMachine(own.parent, machineOfAddress(own.terminal));
  const leadPanes = Array.isArray(leadLive.panes) && leadLive.panes.length ? leadLive.panes : [leadLive.terminal];
  return leadPanes.includes(parent) ? null : { parent, leadPanes, lead, leadName };
}

/** The parent mark's tooltip: the hc parent, then every live pane of the lead. */
export const parentMarkText = (m) => `Its hc parent is ${m.parent}, not its lead's ${m.leadPanes.length > 1 ? "panes" : "pane"} `
  + `${m.leadPanes.join(", ")}${m.leadName ? ` (${m.leadName})` : ""}`;
// A pane's project id (projectId: its address's machine and the key `keyOf(row)` gives), or
// null when keyOf gives none.
const paneProject = (t, keyOf) => {
  const key = keyOf(t);
  return typeof key === "string" && key ? projectId({ machine: machineOfAddress(addressOf(t)), key }) : null;
};

/**
 * Whether a bot's pane counts for `project` (automagik#227, RFC 0014 Q16): a clone or second
 * checkout carries the same bot ids, so a pane counts by project and id. `keyOf(row)`: the
 * project key of the pane's folder (git's main checkout, so a worktree is its main
 * checkout's), or null. A pane with no project (no folder, not in git, git failing, not read
 * yet) counts for every project defining its bot, as before, so an older pane never drops off.
 */
export function paneCounts(t, project, keyOf = () => null) {
  const pid = paneProject(t, keyOf);
  return pid === null || pid === projectId(project);
}

/**
 * liveFrom's `keyOf` from `folderKeyOf(row)` (the project key of the pane's folder): that key
 * only when one of `projects` (discoverProjects' entries) with that key, on the pane's
 * machine, defines the pane's bot; else null, paneCounts' fallback. So a bot pane whose folder
 * is another repository (a restart --cwd there, a clone the sidebar doesn't list) still
 * counts as before, never shown nowhere.
 */
export function listedKeyOf(projects, folderKeyOf = () => null) {
  const defines = new Map(); // projectId -> its bot ids
  for (const p of projects ?? []) {
    const pid = projectId(p);
    if (!defines.has(pid)) defines.set(pid, new Set());
    for (const b of p.file?.bots ?? []) defines.get(pid).add(b.id);
  }
  return (t) => {
    const key = folderKeyOf(t);
    if (typeof key !== "string" || !key) return null;
    return defines.get(projectId({ machine: machineOfAddress(addressOf(t)), key }))?.has(t?.labels?.[BOT_LABEL]) ? key : null;
  };
}

/**
 * A bot's pose from herdr-core's status (Decision 7): working, blocked -> needs you, error ->
 * failed, done, idle -> idle or asleep once its status is ASLEEP_MS old. A live bot with no
 * status yet is idle with no asleep timer; a stopped or planned bot (no live pane) is asleep.
 */
export function poseOf(live, now) {
  if (!live) return "asleep";
  switch (live.status) {
    case "working": return "working";
    case "blocked": return "needs-you";
    case "error": return "failed";
    case "done": return "done";
    case "idle": return typeof live.status_ms === "number" && now - live.status_ms >= ASLEEP_MS ? "asleep" : "idle";
    default: return "idle";
  }
}

// The rate-limited chip's words (#1557), drawn by main.js status() beside the core status.
export const RATE_LIMITED = "Rate limited";

// The blocked chip's words, drawn by main.js status().
export const NEEDS_YOU = "Needs you";
export const NEEDS_YOU_PERMISSION = "Permission";
export const needsYouText = (report) => (waitsOnPermission(report) ? NEEDS_YOU_PERMISSION : NEEDS_YOU);

// The documented marker a stopped agent sets on its own pane with `hc label`: the short text of
// what it waits on. tidy.js owns the marker and the stale window its report uses; rows.js imports
// both, so the chip and that report cannot disagree. The sidebar draws it apart from the blocked
// chip; it never scans a pane's screen.
export { NEEDS_OWNER_LABEL };
// The owner-question chip's word, drawn by main.js status().
export const OWNER_QUESTION = "Question";
/** How much of the label one line can carry; the rest is cut, keeping the chip and its tooltip small. */
export const OWNER_TEXT_MAX = 160;

/**
 * The question a pane's needs-owner label carries while it waits on the person, or null. A
 * working, blocked or failed pane has no owner question: the chip clears in the drawing the
 * moment the agent works again, even before it removes the label. `status` is the row's drawn
 * status (a bot row draws `error` as blocked); `now` is the render's clock. The chip never
 * outlives the agent that asked: tidy.js's needsOwnerStale (a day, its stale-needs-owner rule)
 * and a live terminal are both required, so a label left on a dead or vanished pane draws
 * nothing. Blank and whitespace labels say nothing; a long one is cut to OWNER_TEXT_MAX
 * characters on one line.
 */
export function ownerQuestionOf(row, status = row?.status, now = Date.now()) {
  if (status === "working" || status === "blocked" || status === "error") return null;
  // A terminal gone from the snapshot has no row; one that exited may keep its label row around
  // in the app home. Neither has an agent behind it to wait on the person.
  if (row?.state !== "live") return null;
  if (needsOwnerStale(row, now)) return null;
  const text = row?.labels?.[NEEDS_OWNER_LABEL];
  if (typeof text !== "string") return null;
  const line = text.trim().replace(/\s+/g, " ");
  if (!line) return null;
  return line.length > OWNER_TEXT_MAX ? `${line.slice(0, OWNER_TEXT_MAX - 3)}...` : line;
}

/** When the next idle bot turns asleep (ms since the epoch), or null: the view's one wake-up. */
export function nextWake(live, now) {
  let next = null;
  for (const l of Object.values(live ?? {})) {
    if (l?.status !== "idle" || typeof l.status_ms !== "number") continue;
    const at = l.status_ms + ASLEEP_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * A pane's helpers: the live terminals whose hc parent it is, depth first, with their own
 * helpers beneath. A terminal tied to a known bot is never anyone's helper (it shows as that
 * bot, by definition), and what it started stays under it, so it is not followed.
 */
export function helpersOf(terminals, address, known = new Set(), depth = 0, seen = new Set([address])) {
  const kids = (terminals ?? []).filter((t) => t?.parent === address && t.state === "live" && !seen.has(addressOf(t))
    && !known.has(t.labels?.[BOT_LABEL]));
  return kids.flatMap((t) => {
    const terminal = addressOf(t);
    seen.add(terminal);
    // A bot's worker (automagik-herdr worker) names its template, or model and effort, in its labels.
    const row = { terminal, name: t.name || t.template || t.program?.name || terminal, agent: t.program?.key ?? null,
      program: t.program ?? null, status: t.status ?? null, depth,
      model: t.labels?.["worker.model"] || null, effort: t.labels?.["worker.effort"] || null,
      template: t.labels?.["worker.template"] || null,
      // The branch label, else the task label of a worker started before the task contract.
      branch: workerBranch(t.labels), task: workerTaskId(t.labels) };
    return [row, ...helpersOf(terminals, terminal, known, depth + 1, seen)];
  });
}

/**
 * Every project's bot tree. `projects`: discoverProjects()' entries ({ key, machine?, file,
 * warnings?, stale? }); one tree per machine and key however often it is listed (worktree
 * spaces), `stale` carried over.
 * `live`: liveFrom()'s map. `terminals`: terminals() rows, for helpers only. A member nests
 * under its effective lead (A1, by definition only, never by hc parent); the main bot's
 * direct reports group by `category` in file order, then the uncategorised; a planned bot
 * is never live and has no members (a planned lead falls back to the main bot).
 */
export function buildTree({ projects, live = {}, terminals = [], now = Date.now(), rateLimited = null }) {
  const known = knownBots(projects);
  const done = new Set();
  const unique = [];
  const byMachine = new Map();
  for (const p of projects ?? []) {
    const pid = projectId(p);
    if (done.has(pid)) continue;
    done.add(pid);
    unique.push(p);
    const m = p.machine ?? null;
    if (!byMachine.has(m)) byMachine.set(m, new Map());
    const clean = cleanProjectPath(p.key);
    if (clean) byMachine.get(m).set(clean, p);
  }
  const tagProject = (n, projKey) => {
    n.project = projKey;
    n.projectName = folderName(projKey);
    for (const m of n.members ?? []) tagProject(m, projKey);
  };
  const built = [];
  const treeByPid = new Map();
  const nodesByPid = new Map();
  const pendingCross = [];

  for (const p of unique) {
    const pid = projectId(p);
    const sameMachine = byMachine.get(p.machine ?? null) ?? new Map();
    const file = p.file ?? { version: 1, categories: [], bots: [] };
    const main = mainBotOf(file);
    const warnings = [...(p.warnings ?? [])];
    const leads = new Map(file.bots.map((b) => [
      b.id,
      b === main && !b.leadProject
        ? { lead: "", leadProject: null, leadBot: null, warning: null }
        : effectiveLead(file, b.id, { project: p.key, projects: sameMachine }),
    ]));
    const names = new Map(file.bots.map((b) => [b.id, b.name]));
    const placed = new Set();
    const nodeMap = new Map();
    nodesByPid.set(pid, nodeMap);

    const node = (bot) => {
      placed.add(bot.id);
      const planned = Boolean(bot.planned);
      const l = planned ? null : liveOf(live, p, bot.id);
      const eff = leads.get(bot.id);
      const members = planned
        ? []
        : file.bots
            .filter((b) => !placed.has(b.id) && b !== main && !leads.get(b.id)?.leadProject && leads.get(b.id)?.lead === bot.id)
            .map(node);
      // #1557: the rate-limit dialog a live Claude seat is blocked on, read from its pane tail
      // by the sidebar's own look (main.js) and keyed by the pane it was read on.
      const rate = l ? rateLimited?.get(l.terminal) ?? null : null;
      const n = {
        bot, planned, pose: poseOf(l, now), members,
        live: l ? { terminal: l.terminal, duplicate: l.duplicate, parent: l.parent ?? null } : null,
        status: l?.status ?? null, program: l?.program ?? null, argv: l?.argv ?? null,
        ...(rate ? { rateLimited: rate } : {}),
        helpers: l ? helpersOf(terminals, l.terminal, known) : [],
      };
      const crossWarn = (bot.crossMembers?.length || bot.members?.length)
        ? crossMemberWarnings(file, bot.id, { project: p.key, projects: sameMachine })[0] ?? null
        : null;
      const warning = (eff?.warning && (bot !== main || bot.leadProject) ? eff.warning : null) ?? crossWarn;
      if (warning) n.warning = warning;
      // A row's mark when its pane's hc parent is not its lead's pane (#231): two map reads.
      const leadId = l && (bot !== main || eff?.leadProject) ? eff?.lead : null;
      const targetProj = eff?.leadProject ? sameMachine.get(eff.leadProject) ?? p : p;
      const leadName = eff?.leadProject ? eff?.leadBot?.name ?? null : names.get(leadId) ?? null;
      const mark = leadId ? parentMarkOf(l, liveOf(live, targetProj, leadId), leadId, leadName) : null;
      if (mark) n.parentMark = mark;
      nodeMap.set(bot.id, n);
      return n;
    };

    if (!main) {
      // No main bot (or a file that did not parse): every bot at the top, nothing nested.
      if (!warnings.includes("no main bot") && file.bots.length) warnings.unshift("no main bot");
      const tree = { key: p.key, machine: p.machine ?? null, spaces: p.spaces ?? [], main: null, categories: [],
        uncategorised: file.bots.map((b) => ({ ...node(b), members: [] })), warnings, ...(p.stale ? { stale: true } : {}) };
      built.push({ p, pid, tree, skip: false });
      treeByPid.set(pid, tree);
      continue;
    }

    placed.add(main.id);
    // Build any member with a valid cross-project lead so it is placed and queued for its target lead.
    for (const b of file.bots) {
      if (b === main || placed.has(b.id)) continue;
      const eff = leads.get(b.id);
      if (eff?.leadProject && sameMachine.has(eff.leadProject)) {
        const moved = node(b);
        tagProject(moved, p.key);
        pendingCross.push({ moved, targetPid: projectId(sameMachine.get(eff.leadProject)), leadId: eff.lead });
      }
    }

    const direct = file.bots.filter((b) => b !== main && !leads.get(b.id)?.leadProject && leads.get(b.id)?.lead === main.id);
    const categories = file.categories
      .map((c) => ({ id: c.id, title: c.title, ...(c.sub ? { sub: c.sub } : {}), bots: direct.filter((b) => b.category === c.id && !placed.has(b.id)).map(node) }))
      .filter((c) => c.bots.length);
    const uncategorised = direct.filter((b) => !placed.has(b.id)).map(node);
    const mainNode = node(main);
    const mainEff = leads.get(main.id);
    if (mainEff?.leadProject && sameMachine.has(mainEff.leadProject)) {
      mainNode.members = [...categories.flatMap((c) => c.bots), ...uncategorised];
      tagProject(mainNode, p.key);
      pendingCross.push({ moved: mainNode, targetPid: projectId(sameMachine.get(mainEff.leadProject)), leadId: mainEff.lead });
      const tree = { key: p.key, machine: p.machine ?? null, spaces: p.spaces ?? [], main: null, categories: [], uncategorised: [], warnings,
        ...(p.stale ? { stale: true } : {}) };
      built.push({ p, pid, tree });
      treeByPid.set(pid, tree);
      continue;
    }
    // main's own `members` are its direct reports, already grouped above.
    mainNode.members = [];
    const tree = { key: p.key, machine: p.machine ?? null, spaces: p.spaces ?? [], main: mainNode, categories, uncategorised, warnings,
      ...(p.stale ? { stale: true } : {}) };
    built.push({ p, pid, tree });
    treeByPid.set(pid, tree);
  }

  for (const { moved, targetPid, leadId } of pendingCross) {
    const targetTree = treeByPid.get(targetPid);
    const targetNode = nodesByPid.get(targetPid)?.get(leadId);
    if (!targetTree || !targetNode) continue;
    if (targetTree.main === targetNode && !targetNode.project) {
      targetTree.uncategorised.push(moved);
    } else {
      targetNode.members.push(moved);
    }
  }

  return built.map((item) => item.tree);
}

/**
 * Where each project's tree is drawn (A8): after the first space row, in sidebar order, that
 * belongs to it (a project lists its spaces' ids); other spaces of the project draw none.
 * Returns { at: Map<space id, project id>, rest: project ids with no space shown }.
 */
export function placeTrees(orderedSpaceIds, trees) {
  const at = new Map();
  const placed = new Set();
  for (const sid of orderedSpaceIds) {
    const t = trees.find((x) => !placed.has(projectId(x)) && x.spaces.includes(sid));
    if (!t) continue;
    placed.add(projectId(t));
    at.set(sid, projectId(t));
  }
  return { at, rest: trees.map(projectId).filter((id) => !placed.has(id)) };
}

/**
 * Where each placed project's tree is (`at` from placeTrees) as an index into the same space
 * list: the place withSpaceless puts the project back at once its last space closes.
 */
export function placesOf(orderedSpaceIds, at) {
  const out = new Map();
  orderedSpaceIds.forEach((sid, i) => { if (at.has(sid)) out.set(at.get(sid), i); });
  return out;
}

/**
 * One sidebar list with its spaceless projects in it (A8): each where its space last was
 * (`last`: Map<project id, index> from placesOf), else right after the open spaces. Returns
 * the drawing order as { space: id } and { project: id } items.
 */
export function withSpaceless(orderedSpaceIds, spaceless, last = new Map()) {
  const n = orderedSpaceIds.length;
  // Two at one place keep their remembered order, then the order they came in.
  const pending = spaceless.map((id, i) => ({ id, i, was: last.get(id) ?? Infinity, at: Math.min(last.get(id) ?? n, n) }))
    .sort((a, b) => a.at - b.at || (a.was === b.was ? 0 : a.was < b.was ? -1 : 1) || a.i - b.i);
  const out = [];
  let k = 0;
  for (let s = 0; s <= n; s += 1) {
    while (k < pending.length && pending[k].at === s) out.push({ project: pending[k++].id });
    if (s < n) out.push({ space: orderedSpaceIds[s] });
  }
  return out;
}

/**
 * The machines' header order: the saved order first (the person's "Move to top", kept in the
 * sidebar's localStorage as machines.order; null is this computer), then every other machine
 * in its drawn place. `drawn` is the order without a saved one (this computer, then the
 * others by name); a saved name not drawn is skipped, so a removed machine takes no place.
 */
export function orderMachines(drawn, saved = []) {
  const here = new Set(drawn);
  const first = [...new Set(saved)].filter((m) => here.has(m));
  const set = new Set(first);
  return [...first, ...drawn.filter((m) => !set.has(m))];
}

/** The saved order after "Move to top" on machine `m`: it first, the rest kept in order. */
export function movedToTop(saved, m) {
  return [m, ...saved.filter((x) => x !== m)];
}

/** machines.order as read back: a list of names (null for this computer), else none. */
export function readMachineOrder(text) {
  try {
    const list = JSON.parse(text ?? "[]");
    return Array.isArray(list) ? list.filter((m) => m === null || (typeof m === "string" && m)) : [];
  } catch { return []; }
}

/** The fold id of a bot row, or of a project's category. */
export const botFold = (botId) => `b:${botId}`;
export const categoryFold = (tree, categoryId) => `c:${projectId(tree)}:${categoryId}`;

/**
 * The rows a tree shows under a fold state (A7). `open`: Map<fold id, boolean> of the
 * person's folds this session; anything not in it takes the default: the main bot open,
 * every category open, every other bot folded. Each row: { kind: "main" | "category" | "bot"
 * | "planned" | "helper" | "notice", id, guides, foldable, open, ... } where `guides` lists
 * the lines on its left, outermost first: "main" (inside the main bot), "member" (inside a
 * bot's team), "helper" (a dashed helper group).
 */
export function visibleRows(tree, open = new Map()) {
  const rows = [];
  const isOpen = (id, dflt) => (open instanceof Set ? open.has(id) : open.has(id) ? open.get(id) : dflt);
  const helperRows = (owner, helpers, guides) => helpers.map((h) => ({
    kind: "helper", id: `h:${h.terminal}`, owner: owner.bot.id, ownerTerminal: owner.live?.terminal ?? null, helper: h,
    foldable: false, open: false,
    guides: [...guides, ...Array(h.depth + 1).fill("helper")],
  }));
  const botRows = (n, guides) => {
    const id = botFold(n.bot.id);
    const cross = n.project ? { project: n.project, projectName: n.projectName } : {};
    if (n.planned) { rows.push({ kind: "planned", id, node: n, guides, foldable: false, open: false, ...cross }); return; }
    const foldable = n.members.length + n.helpers.length > 0;
    const o = foldable && isOpen(id, false);
    rows.push({ kind: "bot", id, node: n, guides, foldable, open: o, ...cross });
    if (!o) return;
    for (const m of n.members) botRows(m, [...guides, "member"]);
    rows.push(...helperRows(n, n.helpers, [...guides, "member"]));
  };
  if (!tree.main) {
    if (tree.warnings.length) rows.push({ kind: "notice", id: `n:${projectId(tree)}`, text: tree.warnings[0], guides: [], foldable: false, open: false });
    for (const n of tree.uncategorised) botRows(n, []);
    return rows;
  }
  const mainId = botFold(tree.main.bot.id);
  const foldable = tree.categories.length + tree.uncategorised.length + tree.main.helpers.length > 0;
  const mainOpen = foldable && isOpen(mainId, true);
  rows.push({ kind: "main", id: mainId, node: tree.main, guides: [], foldable, open: mainOpen });
  if (!mainOpen) return rows;
  for (const c of tree.categories) {
    const id = categoryFold(tree, c.id);
    const o = isOpen(id, true);
    rows.push({ kind: "category", id, category: c, guides: ["main"], foldable: true, open: o });
    if (o) for (const n of c.bots) botRows(n, ["main"]);
  }
  for (const n of tree.uncategorised) botRows(n, ["main"]);
  rows.push(...helperRows(tree.main, tree.main.helpers, ["main"]));
  return rows;
}

// The agents whose default model is one cheap local file (models.js defaultModelFrom).
const DEFAULTED = ["claude", "codex", "antigravity"];

/**
 * Each agent's configured default model (models.js defaultModelFrom) out of `texts`
 * (configPaths' files), parsed once: { claude, codex, antigravity }, null where none.
 */
export function modelDefaultsFrom(texts = {}) {
  const out = {};
  for (const key of DEFAULTED) out[key] = defaultModelFrom(key, texts);
  return out;
}

/**
 * main.js loadModelTexts' step: null when `texts` reads as it did when `seen` was taken, else
 * { seen, texts, defaults } with the defaults parsed once, so a row drawn parses nothing.
 */
export function modelTextsUpdate(seen, texts) {
  const now = JSON.stringify(texts);
  if (now === seen) return null;
  return { seen: now, texts, defaults: modelDefaultsFrom(texts) };
}

// The default model secondLine shows for `agentKey`: from the parsed `defaults` when given.
function defaultOf(agentKey, defaults, texts) {
  if (defaults) return (Object.hasOwn(defaults, agentKey) ? defaults[agentKey] : null) || null;
  return defaultModelFrom(agentKey, texts) || null;
}

const folderName = (key) => String(key ?? "").replace(/\/+$/, "").split("/").pop();

/**
 * A bot row's second line (A4, A12). Planned: its note. Main bot: `Main bot · model ·
 * project`, stopped `Main bot · not running · project`. Member: `role · model`, stopped
 * `not running · role`. The model is models.js shownModel's for the live pane: the model its
 * foreground command line names, else the agent's own configured default (`texts`:
 * configPaths' files read by the caller). Never typed text: a stopped bot's line keeps A4's
 * shape with no model, and a live pane whose command line isn't known yet shows none rather
 * than a guess. `argvOf(terminal)`: the command line the caller read with `hc get` for a
 * row that didn't carry it. `defaults`: modelDefaultsFrom(texts), parsed once by the caller
 * (main.js loadModelTexts); without it the default is parsed from `texts` here. Either way
 * only when the command line names no model.
 */
export function secondLine(r, tree, { texts = {}, defaults = null, argvOf = () => null } = {}) {
  const n = r.node, b = n.bot;
  if (r.kind === "planned") return b.planned?.note || "planned";
  let model = null;
  if (n.live) {
    const argv = n.argv ?? argvOf(n.live.terminal) ?? null;
    // models.js shownModel for a live pane: what its command line names, else the default.
    if (argv) model = detectModel(argv, b.agent) || defaultOf(b.agent, defaults, texts);
  }
  if (r.kind === "main") return ["Main bot", n.live ? model : "not running", folderName(tree.key)].filter(Boolean).join(" · ");
  const role = b.role || (b.kind === "main" ? "Main bot" : "");
  return (n.live ? [role, model, n.projectName] : ["not running", role, n.projectName]).filter(Boolean).join(" · ");
}

/**
 * Which bot panes' command lines to read with `hc get` (A12), from `terminals()` rows:
 * live, labelled with a `known` bot, and not carrying `foreground.argv`. A pane already in
 * `cached` (address -> argvEntry) with the same `created_ms` and its agent in front is
 * skipped: a bot pane runs the command it was started with. One read while still in its
 * `sh -c` wrapper (or at a shell) is asked again, and so is one whose row doesn't say
 * `program.agent` true (false, or no program): the read alone can keep it live (liveFrom), so
 * it is kept fresh and an agent that quits back to its shell stops counting. At most `max` per
 * call: panes never read (no read cached, or one for an older pane at that address) first, so
 * a just-started bot shows as running on the next refresh, but at most `max - 1` of them while
 * any other is due; the rest (unsettled reads and re-reads) share what's left, taken from
 * `start` round their list, so panes that never settle (a bot pane at its shell) can't starve
 * each other. Returns { ask: addresses, gone:
 * cached addresses no longer wanted, next: the `start` for the next call }.
 */
export function argvToAsk(terminals, known, cached = new Map(), max = 3, start = 0) {
  const rows = (terminals ?? []).filter((k) => k?.address && k.state === "live" && known.has(k.labels?.[BOT_LABEL])
    && !Array.isArray(k.foreground?.argv));
  const wanted = new Set(rows.map((k) => k.address));
  const fresh = (k) => { const hit = cached.get(k.address); return !hit || hit.created !== (k.created_ms ?? null); };
  const due = rows.filter((k) => !fresh(k) && (!cached.get(k.address).settled || rowIsAgent(k) !== true)).map((k) => k.address);
  // One slot stays with the rotation while it has anything, so first reads can't hold it off.
  const first = rows.filter(fresh).map((k) => k.address).slice(0, due.length && max > 1 ? max - 1 : max);
  const from = due.length ? ((start % due.length) + due.length) % due.length : 0;
  const turn = Array.from({ length: Math.min(max - first.length, due.length) }, (_, n) => due[(from + n) % due.length]);
  return { ask: [...first, ...turn], gone: [...cached.keys()].filter((a) => !wanted.has(a)), next: due.length ? (from + turn.length) % due.length : 0 };
}

/**
 * What the view keeps of a pane's `hc get` answer: its foreground argv (null: none), the
 * pane's `created_ms`, and whether that argv is final (an agent in front, not a shell or
 * the `sh -c` wrapper an agent starts in), so argvToAsk asks again until it is.
 */
export function argvEntry(get, created) {
  const argv = Array.isArray(get?.foreground?.argv) ? get.foreground.argv : null;
  return { argv, created: created ?? null, settled: Boolean(argv) && agentInForeground(get) };
}

/**
 * What the view keeps after one `hc get` of a pane: `get` is its parsed answer, null when the
 * ask failed. A read with a command line replaces `prev`; a failed or empty one keeps `prev`
 * for the same pane (`created`), else leaves an unsettled entry with no command line, so the
 * pane is no longer "never read" (argvToAsk) and waits its turn instead of taking a first-read
 * slot every call (a remote machine that is down but still listed).
 */
export function argvAfter(prev, get, created) {
  const entry = argvEntry(get, created);
  if (entry.argv) return entry;
  return prev && prev.created === entry.created ? prev : entry;
}

/**
 * liveFrom's `argvOf` over the view's reads (address -> argvAfter entry): the command line
 * read for that pane only, so a terminal reborn at an old address (another `created_ms`)
 * isn't counted by the read of the one before it.
 */
export function argvReader(cache) {
  return (address, created) => {
    const e = cache?.get(address);
    return e && e.created === (created ?? null) && Array.isArray(e.argv) ? e.argv : null;
  };
}

/** The ids of every bot the projects define: a terminal labelled with one is drawn as that bot. */
export function knownBots(projects) {
  return new Set((projects ?? []).flatMap((p) => p.file?.bots?.map((b) => b.id) ?? []));
}

/** Every terminal a tree holds: each live bot's pane and every bot's helpers, folded or not. */
function treeTerminals(tree) {
  const out = new Set();
  const walk = (n) => {
    if (!n) return;
    if (n.live?.terminal) out.add(n.live.terminal);
    for (const h of n.helpers ?? []) out.add(h.terminal);
    for (const m of n.members ?? []) walk(m);
  };
  walk(tree?.main);
  for (const c of tree?.categories ?? []) for (const n of c.bots) walk(n);
  for (const n of tree?.uncategorised ?? []) walk(n);
  return out;
}

// R3's place of a bot among its siblings: captains (by rank, or a bot with no rank that leads
// others) first, then by rank in RANKS order, then the unranked; file order within each.
const rankOf = (n) => (n.bot.rank ? RANKS.indexOf(n.bot.rank) : n.members.length ? 0 : RANKS.length);
const byRank = (nodes) => nodes.map((n, i) => [n, i]).sort(([a, i], [b, j]) => rankOf(a) - rankOf(b) || i - j)
  .map(([n]) => ({ ...n, members: byRank(n.members) }));

/** A tree with every bot's siblings in R3 order (byRank); categories keep bots.json order. */
export function rankedTree(tree) {
  if (!tree) return tree;
  return { ...tree, main: tree.main ? { ...tree.main, members: byRank(tree.main.members) } : null,
    categories: tree.categories.map((c) => ({ ...c, bots: byRank(c.bots) })), uncategorised: byRank(tree.uncategorised) };
}

/**
 * R3 (sidebar-rules D2): one space's rows, in the order the sidebar draws them. First the
 * project's bot tree when placeTrees put it in this space (visibleRows under `open` over
 * rankedTree: the main bot; categories in bots.json order, each with its captains, then its
 * members by rank; each bot's helpers beneath it), then
 * the plain agents not tied to a bot, each followed by its sub-agents, then shells. A bot is
 * never drawn below a plain agent, and a terminal the tree holds (a bot's pane, or a helper
 * of any bot, folded or not) is not listed again as an agent or a shell; nor is what such an
 * agent started. `agents`: [{ terminal, subs?: [{ terminal, depth }] }] in the caller's
 * order; `shells`: [{ terminal }]. Each descriptor: { kind: "main" | "category" | "bot" |
 * "helper" | "notice" | "agent" | "shell", id, depth, terminal (null when none) } plus what
 * it was made from: `row` (visibleRows' row), `agent` and `sub`, or `shell`.
 */
export function spaceRowOrder({ tree = null, agents = [], shells = [], open = new Map() } = {}) {
  const out = [];
  const seen = tree ? treeTerminals(tree) : new Set();
  if (tree) {
    for (const r of visibleRows(rankedTree(tree), open)) {
      const terminal = r.kind === "helper" ? r.helper.terminal : r.node?.live?.terminal ?? null;
      out.push({ kind: r.kind === "planned" ? "bot" : r.kind, id: r.id, depth: r.guides.length, terminal, row: r });
    }
  }
  for (const a of agents ?? []) {
    if (!a?.terminal || seen.has(a.terminal)) continue;
    seen.add(a.terminal);
    out.push({ kind: "agent", id: `a:${a.terminal}`, depth: 0, terminal: a.terminal, agent: a });
    for (const s of a.subs ?? []) {
      if (!s?.terminal || seen.has(s.terminal)) continue;
      seen.add(s.terminal);
      out.push({ kind: "agent", id: `a:${s.terminal}`, depth: (s.depth ?? 0) + 1, terminal: s.terminal, agent: a, sub: s });
    }
  }
  for (const s of shells ?? []) {
    if (!s?.terminal || seen.has(s.terminal)) continue;
    seen.add(s.terminal);
    out.push({ kind: "shell", id: `s:${s.terminal}`, depth: 0, terminal: s.terminal, shell: s });
  }
  return out;
}

/**
 * What a click on a terminal's row runs. A pane shows it: agent.focus. None does (a parked
 * seat: running, no pane): terminal.peek, which peeks over the tab with keep-as-tab and close,
 * so the person sees it and chooses to keep it; never terminal.keep on their behalf. The same
 * on any machine (`box/t4`). A bot's helper row goes through workerTab.js instead: it opens as
 * a tab after its bot's tab (the owner's ruling, 2026-11-02). `panes`: panes() rows, read at click time.
 */
export function clickActionOf(terminal, panes) {
  const shown = (panes ?? []).some((p) => p?.terminal === terminal);
  return { command: shown ? "agent.focus" : "terminal.peek", args: { terminal } };
}

/**
 * The live terminal a bot's row holds when liveFrom doesn't count it (no agent seen in front
 * yet: the `sh -c` wrapper, a command line not read yet, a shell): the bot row's click still
 * goes to it (clickActionOf), never nowhere. With `bindings` (liveFrom's ledger answer) the
 * ledger names it, never the `bot=` label; a bound terminal still counts, and an unbound label
 * names nothing. Without (`null`), the live terminal labelled with bot `botId`. Of several, one
 * a pane shows (`panes`: panes() rows) first, then the newest by `created_ms`. Null when the
 * bot has no live terminal. With `project`, only the terminals that count for it (paneCounts,
 * `keyOf` as liveFrom's; the binding's project with `bindings`).
 */
export function heldTerminalOf(botId, terminals, panes = [], project = null, keyOf = () => null, bindings = null) {
  const shown = new Set((panes ?? []).map((p) => p?.terminal).filter(Boolean));
  let held;
  if (bindings !== null) {
    const rows = new Map((terminals ?? []).filter((t) => addressOf(t)).map((t) => [addressOf(t), t]));
    const pid = project ? projectId(project) : null;
    held = [];
    const seen = new Set();
    for (const b of bindings ?? []) {
      if (b?.bot !== botId || (b.state && b.state !== "live")) continue;
      if (pid !== null && bindingProject(b) !== pid) continue;
      const address = bindingAddress(b);
      const t = rows.get(address);
      if (!t || t.state !== "live" || seen.has(address)) continue;
      seen.add(address);
      held.push(t);
    }
  } else {
    held = (terminals ?? []).filter((t) => botId && t?.labels?.[BOT_LABEL] === botId && t.state === "live" && addressOf(t)
      && (!project || paneCounts(t, project, keyOf)));
  }
  if (!held.length) return null;
  const rank = (t) => [shown.has(addressOf(t)) ? 1 : 0, t.created_ms ?? -1];
  const pick = held.reduce((a, b) => {
    const [sa, ca] = rank(a), [sb, cb] = rank(b);
    return sb > sa || (sb === sa && cb > ca) ? b : a;
  });
  return addressOf(pick);
}

/**
 * A held bot row's click, decided at click time from fresh `terminals` and `panes`: focus or
 * peek its live terminal (clickActionOf), or null when it holds none any more (do nothing).
 */
export function heldClickOf(botId, terminals, panes, project = null, keyOf = () => null, bindings = null) {
  const held = heldTerminalOf(botId, terminals, panes, project, keyOf, bindings);
  return held ? clickActionOf(held, panes) : null;
}
