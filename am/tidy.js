// tidy's planner (sidebar-rules Group 2): every drift between the window, the panes' labels,
// the bots files and the project registry, as a list of actions. Pure: it reads the State
// given and imports only other pure modules, so the CLI, the tests and the sidebar share it.
// Apache-2.0.
//
// State is Group 1's shape (test/fixtures/sidebar/), plus `folders`: what readState found
// about each folder on this computer, { [folder]: { exists, key, top, real? } } (`key`:
// model.js projectOf's key; `top`: git's top level, null outside git; `real`: its real path
// when it is reached through a symlink). A folder with no entry (one the disk couldn't answer
// for, a fixture recorded without it, or another machine's) is taken as present and its own
// top level, or its main checkout's worktree for the `<main>.worktrees/<name>` layout; folder
// drift (gone, a subfolder) is planned only from what was found, and never recreated on
// another machine (reported instead). Each rule (registryRule, labelRule, spaceRule,
// terminalRule) reads one contextOf(state) and returns its actions; plan() groups them.
//
// Action: { kind, visual, why, ... }. Non-visual (start, attach and create apply them):
//   prune-registry { key }; relabel { terminal, set } (role= and category=; "" removes).
// Visual (only `tidy --apply`):
//   create-space { key, machine, folder, name };
//   recreate-space { space, machine, from, to, name } (D14: a new space on `to`, the old
//     one's panes moved into it);
//   move-pane { terminal, from: { machine, space, tab }, to: { machine, space, tab, key },
//     reason: "stray" | "duplicate" } (`to.space` is the target's id now: a space being
//     recreated keeps its old id here, and null means the space create-space makes for
//     `to.key`; `to.tab` null lets Herdr pick);
//   rename-space { space, from, to }; close-space { space } (only a space already empty);
//   relabel { terminal, set } with `herdr.space` (Herdr places a terminal by that label).
// Reports (never acted on): report { report: "orphan-helper" | "foreign" |
//   "stale-worktree-space" | "stale-needs-owner" | "cross-machine", terminal?, space?, note }.
import { BOT_LABEL, effectiveCategory, mainBotOf, parseBots } from "./model.js";
import { CATEGORY_LABEL, ROLE_LABEL, roleOf } from "./launchArgs.js";

export const SPACE_LABEL = "herdr.space";
export const NEEDS_OWNER_LABEL = "automagik-herdr.needs-owner";
export const STALE_NEEDS_OWNER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a terminal's needs-owner label is over the pack's stale window (a day). The label has
 * no clock of its own: its age is the terminal's status age, else its creation age, and a
 * missing clock is never stale. One rule, two readers: tidy's stale-needs-owner report and the
 * sidebar's Question chip (rows.js).
 */
export function needsOwnerStale(t, now = Date.now()) {
  const since = t?.status_ms ?? t?.created_ms;
  return Number.isFinite(since) && now - since > STALE_NEEDS_OWNER_MS;
}

const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);
const baseOf = (p) => p.replace(/\/+$/, "").slice(p.replace(/\/+$/, "").lastIndexOf("/") + 1);
const at = (machine, key) => JSON.stringify([machine ?? null, key]);
const inside = (path, folder) => path === folder || (typeof path === "string" && path.startsWith(`${folder}/`));

/** What is known about a folder (see the header): recorded, else the guess. */
export function folderFacts(state, folder, machine = null) {
  const found = machine == null ? state.folders?.[folder] : null;
  if (found) return { exists: Boolean(found.exists), key: found.key ?? folder, top: found.top ?? null, real: found.real ?? null, recorded: true };
  const w = /^(.*)\.worktrees\/[^/]+$/.exec(folder);
  return { exists: true, key: w ? w[1] : folder, top: folder, real: null, recorded: false };
}

/** A project's display name (D7): bots.json's optional `name`, else its folder's name. */
export function displayName(project) {
  const name = project?.raw?.name;
  return typeof name === "string" && name.trim() ? name.trim() : baseOf(project.key);
}

/**
 * What every rule reads: the State indexed once. A bot pane's project is the one that defines
 * its bot on the pane's machine; when two do (a copied bots.json), the one the pane's folder
 * keys to, else none (reported, never relabelled).
 */
export function contextOf(state, { now = Date.now(), home = "~" } = {}) {
  const isHome = (f) => !f || f === "~" || f === home;
  const facts = (folder, machine) => folderFacts(state, folder, machine);
  const projects = new Map();
  const botProjects = new Map(); // at(machine, botId) -> [project]
  const botMachines = new Map(); // botId -> machines whose projects define it
  for (const p of state.projects ?? []) {
    let file;
    try { file = parseBots(JSON.stringify(p.file)).file; } catch { continue; }
    const project = { key: p.key, machine: p.machine ?? null, raw: p.file, file };
    projects.set(at(project.machine, p.key), project);
    for (const b of file.bots) {
      botProjects.set(at(project.machine, b.id), [...(botProjects.get(at(project.machine, b.id)) ?? []), project]);
      botMachines.set(b.id, [...new Set([...(botMachines.get(b.id) ?? []), project.machine])]);
    }
  }
  const projectAt = (machine, key) => projects.get(at(machine, key)) ?? null;
  const terms = (state.terminals ?? []).filter((t) => t?.address);
  const byAddress = new Map(terms.map((t) => [t.address, t]));
  const live = (t) => t?.state === "live";
  const folderKey = (t) => {
    if (isHome(t.cwd)) return null;
    const f = facts(t.cwd, machineOf(t.address));
    return f.exists ? f.key : null;
  };
  const owners = new Map(); // address -> project
  const ambiguous = []; // { terminal, id, keys }
  for (const t of terms) {
    const id = t.labels?.[BOT_LABEL];
    if (!live(t) || !id) continue;
    const list = botProjects.get(at(machineOf(t.address), id)) ?? [];
    const mine = list.length > 1 ? list.filter((p) => p.key === folderKey(t)) : list;
    if (mine.length === 1) owners.set(t.address, mine[0]);
    else if (list.length > 1) ambiguous.push({ terminal: t.address, id, keys: list.map((p) => p.key) });
  }
  const botOf = (t) => owners.get(t?.address) ?? null;
  // The live bot pane a terminal is tied to: itself, or the first bot up its hc parents.
  const tiedTo = (t) => {
    for (const seen = new Set(); t && !seen.has(t.address); t = byAddress.get(t.parent)) {
      seen.add(t.address);
      if (!live(t)) return null;
      if (botOf(t)) return t;
    }
    return null;
  };
  // The first hc parent up the chain that isn't live any more (null: the chain is whole).
  const goneParentOf = (t) => {
    for (const seen = new Set([t.address]); t?.parent; ) {
      const up = byAddress.get(t.parent);
      if (!live(up)) return t.parent;
      if (seen.has(up.address)) return null;
      seen.add(up.address);
      t = up;
    }
    return null;
  };
  // A terminal's project key: its bot's, the bot it was started from, else its folder's.
  const keyOfTerminal = (t) => { const tie = tiedTo(t); return tie ? botOf(tie).key : folderKey(t); };
  const machinesWithProjects = new Set([...projects.values()].map((p) => p.machine));
  return { state, now, home, isHome, facts, projects, projectAt, botMachines, terms, byAddress, live, botOf, ambiguous, tiedTo,
    goneParentOf, keyOfTerminal, machinesWithProjects };
}

const report = (kind, fields, note) => ({ kind: "report", visual: false, report: kind, ...fields, note, why: note });

/** Registry entries whose folder was found gone (issue #11); never one only guessed. */
export function registryRule(ctx) {
  return (ctx.state.registry ?? []).filter((key) => { const f = ctx.facts(key, null); return f.recorded && !f.exists; })
    .map((key) => ({ kind: "prune-registry", visual: false, key, why: "its folder is gone, so the sidebar should not list it" }));
}

/** role= and category= on this computer's bot panes (A16); a bot two projects define is reported. */
export function labelRule(ctx) {
  const out = [];
  for (const t of ctx.terms) {
    const project = machineOf(t.address) == null ? ctx.botOf(t) : null;
    if (!project) continue;
    const id = t.labels[BOT_LABEL];
    const want = { [ROLE_LABEL]: roleOf(project.file, id) ?? "", [CATEGORY_LABEL]: effectiveCategory(project.file, id) ?? "" };
    const set = Object.fromEntries(Object.entries(want).filter(([k, v]) => (t.labels[k] ?? "") !== v));
    if (Object.keys(set).length) {
      const words = Object.entries(set).map(([k, v]) => `${k}=${v}`).join(" ");
      out.push({ kind: "relabel", visual: false, terminal: t.address, set, why: `${project.key}/.herdr/bots.json says ${words}` });
    }
  }
  for (const a of ctx.ambiguous) {
    out.push(report("foreign", { terminal: a.terminal }, `${a.terminal} plays ${a.id}, which ${a.keys.join(" and ")} both define, and its folder doesn't say which; its labels are left alone`));
  }
  return out;
}

/** Each space's project, folder (D14) and panes: create, recreate, move, rename, close. */
export function spaceRule(ctx) {
  const { facts, isHome, live, botOf, projectAt, terms } = ctx;
  const reports = [];
  const spaces = (ctx.state.spaces ?? []).map((s, order) => {
    const machine = s.machine ?? null;
    const panes = (s.tabs ?? []).flatMap((tab) => (tab.panes ?? []).map((p) => ({ tab: tab.id, terminal: p.terminal, t: ctx.byAddress.get(p.terminal) })));
    const bots = new Set(panes.map((p) => botOf(p.t)).filter(Boolean).map((p) => p.key));
    const f = isHome(s.folder) ? null : facts(s.folder, machine);
    const at_ = (x) => s.folder === x || (f?.real != null && f.real === x); // the folder, or its real path
    let owner = null; // the project key the space is for
    if (bots.size === 1) owner = [...bots][0];
    else if (bots.size > 1) {
      if (f?.exists && bots.has(f.key)) owner = f.key;
      else reports.push(report("foreign", { space: s.id }, `"${s.name}" holds bots of ${[...bots].join(" and ")}, so tidy can't tell which project it is for`));
    } else if (f?.exists && (f.top || at_(f.key))) owner = f.key;
    else if (f && !f.exists) reports.push(report("foreign", { space: s.id }, `"${s.name}" is on ${s.folder}, which is gone, and holds no bot to say which project it is for`));
    const project = owner ? projectAt(machine, owner) : null;
    // Where it stands (D14): the project's top level, one of its worktrees, or elsewhere.
    let place = "plain";
    if (project) {
      if (f?.exists && at_(owner)) place = "top";
      else if (f?.exists && f.key === owner && at_(f.top)) place = "worktree";
      else place = "wrong";
    }
    return { s, order, machine, panes, owner, project, place, folder: f, empty: panes.length === 0, at: at_ };
  });

  // The canonical space of each project, per machine: on the top level, then holding the main bot.
  const mainPaneOf = (project) => terms.find((t) => botOf(t) === project && t.labels[BOT_LABEL] === mainBotOf(project.file)?.id);
  const holdsMain = (sp) => sp.panes.some((p) => p.t && p.t === mainPaneOf(sp.project));
  const canonical = new Map(); // at(machine, key) -> space entry
  for (const sp of spaces) {
    if (!sp.project || sp.place === "worktree" || sp.empty) continue;
    const k = at(sp.machine, sp.owner);
    const best = canonical.get(k);
    const score = (x) => (x.place === "top" ? 2 : 0) + (holdsMain(x) ? 1 : 0);
    if (!best || score(sp) > score(best)) canonical.set(k, sp);
  }
  // A project with live bots and no space keeps an empty one it has, rather than recreating it.
  const liveBots = new Set(terms.filter((t) => botOf(t)).map((t) => at(machineOf(t.address), botOf(t).key)));
  for (const sp of spaces) {
    const k = at(sp.machine, sp.owner);
    if (sp.project && sp.empty && sp.place === "top" && !canonical.has(k) && liveBots.has(k)) canonical.set(k, sp);
  }

  const creating = new Map(); // at(machine, key) -> create-space action
  const targetOf = (machine, project) => {
    const k = at(machine, project.key);
    const c = canonical.get(k);
    if (c) return { machine, space: c.s.id, tab: null, key: project.key };
    if (!creating.has(k)) {
      creating.set(k, { kind: "create-space", visual: true, key: project.key, machine, folder: project.key, name: displayName(project),
        why: `${displayName(project)} has bots and no space` });
    }
    return { machine, space: null, tab: null, key: project.key };
  };
  for (const k of liveBots) {
    const [machine, key] = JSON.parse(k);
    if (projectAt(machine, key)) targetOf(machine, projectAt(machine, key));
  }

  const recreate = [], moves = [], renames = [], closes = [], spaceLabels = [];
  for (const sp of spaces) {
    const { s, machine } = sp;
    if (sp.empty) {
      if (canonical.get(at(machine, sp.owner)) !== sp) closes.push({ kind: "close-space", visual: true, space: s.id, why: `"${s.name}" is empty` });
      continue;
    }
    const isCanonical = sp.project && canonical.get(at(machine, sp.owner)) === sp;
    if (isCanonical && sp.place === "wrong") {
      const why = isHome(s.folder) ? "it is on the home folder, not on a project"
        : !sp.folder.exists ? `its folder ${s.folder} is gone`
          : sp.folder.key === sp.owner ? `${s.folder} is inside ${sp.owner}, not its top level`
            : `its bots are ${sp.owner}'s, but it is on ${s.folder}${sp.at(sp.folder.key) ? "" : ` (${sp.folder.key}'s)`}`;
      // Another machine's folders are only guessed at from here: reported, never recreated.
      if (machine != null) reports.push(report("foreign", { space: s.id }, `"${s.name}" on ${machine}: ${why}; tidy doesn't recreate another machine's spaces`));
      else recreate.push({ kind: "recreate-space", visual: true, space: s.id, machine, from: s.folder, to: sp.owner, name: displayName(sp.project), why: `"${s.name}": ${why}` });
    } else if (isCanonical && s.name !== displayName(sp.project)) {
      renames.push({ kind: "rename-space", visual: true, space: s.id, from: s.name, to: displayName(sp.project), why: `${sp.owner}'s space is named after the project` });
    }
    if (sp.place === "worktree" && !terms.some((t) => live(t) && (inside(t.cwd, s.folder) || (sp.folder.real && inside(t.cwd, sp.folder.real))))) {
      reports.push(report("stale-worktree-space", { space: s.id }, `"${s.name}" is on the worktree ${s.folder}, and no terminal runs in it`));
    }
    for (const p of sp.panes) {
      const from = { machine, space: s.id, tab: p.tab };
      if (p.t && machineOf(p.terminal) !== machine) {
        reports.push(report("cross-machine", { terminal: p.terminal, space: s.id }, `${p.terminal} runs on ${machineOf(p.terminal) ?? "this computer"}, but "${s.name}" is on ${machine ?? "this computer"}`));
        continue;
      }
      if (!live(p.t)) continue;
      const key = ctx.keyOfTerminal(p.t);
      const project = key ? projectAt(machine, key) : null;
      // A space with no project (a plain folder) keeps its panes, unless one is a bot's.
      if (key && project && key !== sp.owner && (sp.owner || ctx.tiedTo(p.t))) {
        moves.push({ kind: "move-pane", visual: true, terminal: p.terminal, from, to: targetOf(machine, project), reason: "stray",
          why: `${p.terminal} belongs to ${key}, not to "${s.name}"` });
      } else if (sp.project && !isCanonical && sp.place !== "worktree" && key === sp.owner) {
        moves.push({ kind: "move-pane", visual: true, terminal: p.terminal, from, to: targetOf(machine, sp.project), reason: "duplicate",
          why: `"${s.name}" is a second space for ${sp.owner}` });
      } else if (isCanonical && sp.place !== "wrong" && botOf(p.t) && p.t.labels[SPACE_LABEL] !== s.id && machineOf(p.terminal) == null) {
        spaceLabels.push({ kind: "relabel", visual: true, terminal: p.terminal, set: { [SPACE_LABEL]: s.id },
          why: `${p.terminal} shows in "${s.name}", but its ${SPACE_LABEL} says ${p.t.labels[SPACE_LABEL] ?? "nothing"}` });
      }
    }
  }
  return [...creating.values(), ...recreate, ...moves, ...renames, ...closes, ...spaceLabels, ...reports];
}

/** Terminals: bots of another machine's project, orphan helpers, unseen ones, old owner decisions. */
export function terminalRule(ctx) {
  const { live, botOf, tiedTo, now } = ctx;
  const out = [];
  const shown = new Set((ctx.state.spaces ?? []).flatMap((s) => (s.tabs ?? []).flatMap((t) => (t.panes ?? []).map((p) => p.terminal))));
  for (const t of ctx.terms.filter(live)) {
    const id = t.labels?.[BOT_LABEL];
    const machine = machineOf(t.address);
    // Only where this State holds that machine's projects: elsewhere the bot's project is unknown.
    const defined = ctx.botMachines.get(id);
    if (id && defined && !defined.includes(machine) && ctx.machinesWithProjects.has(machine)) {
      out.push(report("cross-machine", { terminal: t.address }, `${t.address} plays ${id}, a bot of a project on ${defined.map((m) => m ?? "this computer").join(", ")}`));
    }
    const gone = ctx.goneParentOf(t);
    if (!botOf(t) && gone && !tiedTo(t)) {
      out.push(report("orphan-helper", { terminal: t.address }, `${t.address} was started from ${gone}, which is gone, so no bot shows it as a helper`));
    } else if (!botOf(t) && !tiedTo(t) && !shown.has(t.address) && t.labels?.[SPACE_LABEL] && machine == null) {
      out.push(report("foreign", { terminal: t.address }, `${t.address} is parked and tied to no bot, so no row shows it`));
    }
    if (t.labels?.[NEEDS_OWNER_LABEL] && needsOwnerStale(t, now)) {
      out.push(report("stale-needs-owner", { terminal: t.address }, `${t.address} has waited on the owner for over a day: "${t.labels[NEEDS_OWNER_LABEL]}"`));
    }
  }
  return out;
}

/** The rules, in the order their actions are listed within each group. */
export const RULES = [registryRule, labelRule, spaceRule, terminalRule];

/** The plan for a State: every rule's actions, grouped non-visual, visual, then reports. */
export function plan(state, opts = {}) {
  const ctx = contextOf(state, opts);
  const all = RULES.flatMap((rule) => rule(ctx));
  return [...all.filter((a) => !a.visual && a.kind !== "report"), ...all.filter((a) => a.visual), ...all.filter((a) => a.kind === "report")];
}

/** A State with the plan's non-visual actions done (what start, attach and create do). */
export function applyNonVisual(state, actions) {
  const pruned = new Set(actions.filter((a) => a.kind === "prune-registry").map((a) => a.key));
  const sets = new Map(actions.filter((a) => a.kind === "relabel" && !a.visual).map((a) => [a.terminal, a.set]));
  const terminals = (state.terminals ?? []).map((t) => {
    const set = sets.get(t.address);
    if (!set) return t;
    const labels = { ...t.labels };
    for (const [k, v] of Object.entries(set)) if (v === "") delete labels[k]; else labels[k] = v;
    return { ...t, labels };
  });
  return { ...state, terminals, registry: (state.registry ?? []).filter((k) => !pruned.has(k)) };
}

/** `hc label` words for a relabel's `set`. */
export const labelWordsOf = (set) => Object.entries(set).map(([k, v]) => `${k}=${v}`);

/** The plan as plain lines for people: non-visual, then visual, then reports. */
export function planText(actions) {
  if (!actions.length) return "Nothing to tidy.";
  const line = (a) => {
    switch (a.kind) {
      case "prune-registry": return `prune     ${a.key}: ${a.why}`;
      case "relabel": return `relabel   ${a.terminal} ${labelWordsOf(a.set).join(" ")}: ${a.why}`;
      case "create-space": return `create    "${a.name}" on ${a.folder}${a.machine ? ` (${a.machine})` : ""}: ${a.why}`;
      case "recreate-space": return `recreate  ${a.space} on ${a.to} as "${a.name}" (was ${a.from || "no folder"}): ${a.why}`;
      case "move-pane": return `move      ${a.terminal} from ${a.from.space} to ${a.to.space ?? `the new space for ${a.to.key}`} (${a.reason}): ${a.why}`;
      case "rename-space": return `rename    "${a.from}" to "${a.to}": ${a.why}`;
      case "close-space": return `close     ${a.space}: ${a.why}`;
      default: return `${a.report.padEnd(9)} ${a.note}`;
    }
  };
  const groups = [
    ["Non-visual (start, attach and create fix these on their own):", actions.filter((a) => !a.visual && a.kind !== "report")],
    ["Visual (they change the window; only tidy --apply runs them):", actions.filter((a) => a.visual)],
    ["Reports (nothing to run; for you to look at):", actions.filter((a) => a.kind === "report")],
  ];
  return groups.filter(([, list]) => list.length).map(([title, list]) => [title, ...list.map((a) => `  ${line(a)}`)].join("\n")).join("\n\n");
}
