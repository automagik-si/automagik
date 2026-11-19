// What tidy plans from (sidebar-rules Group 2): the State of Group 1's fixtures, read live.
// One `hc ls`, one `hc get` per live terminal on this computer (ls carries no labels and no
// parent), one `herdr-app ls`, the bots files, the CLI's project list, and what git says
// about each folder on this computer (tidy.js `folders`). Reads only; the I/O is given, so
// the CLI and the tests share it. Apache-2.0.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { BOTS_PATH, PROJECTS_FILE, listedProjects, projectOf } from "../model.js";
import { labelWordsOf } from "../tidy.js";

const SHELLS = new Set(["sh", "zsh", "bash", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
const local = (address) => !String(address).includes("/");
const under = (key, rest) => `${key === "/" ? "" : key}/${rest}`;
const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const parentOf = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), 1));
/**
 * "dir", "gone", or null when the disk can't say: only ENOENT and ENOTDIR mean gone, and only
 * under a parent that is there (an unmounted volume is not a deleted folder). Any other error
 * (EACCES, EPERM, EIO) is unknown, and the planner then takes the folder as present.
 */
function folderState(path) {
  const stat = (p) => { try { return statSync(p).isDirectory() ? "dir" : "gone"; } catch (e) { return ["ENOENT", "ENOTDIR"].includes(e?.code) ? "gone" : null; } };
  const here = stat(path);
  if (here !== "gone") return here;
  return stat(parentOf(path)) === "dir" ? "gone" : null;
}

/** A State terminal from an `hc ls` row and its `hc get` (null for another machine's). */
function terminalOf(row, get) {
  const agent = row.agent ?? get?.status?.app ?? null;
  return {
    address: row.address, agent, cwd: get?.cwd ?? row.cwd ?? null, state: row.state, status: row.status ?? get?.status?.state ?? null,
    status_ms: get?.status_ms ?? null, turn: row.turn ?? get?.turn ?? null, where: row.where ?? get?.labels?.where ?? null,
    parent: get?.parent ?? null, created_ms: get?.created_ms ?? null,
    program: agent ? { key: agent, agent: !SHELLS.has(agent) } : null, labels: get?.labels ?? {},
  };
}

/** State spaces from `herdr-app ls` (active becomes selected; a tab's terminals its panes). */
export function spacesOf(ls) {
  return (Array.isArray(ls?.spaces) ? ls.spaces : []).map((s) => ({
    id: s.id, name: s.name ?? "", machine: s.machine ?? null, folder: s.folder ?? "", selected: Boolean(s.active),
    tabs: (s.tabs ?? []).map((t) => ({
      id: t.id, name: t.name ?? "", selected: Boolean(t.active),
      panes: (t.terminals ?? []).filter((p) => p?.terminal).map((p) => ({ pane: p.pane ?? null, terminal: p.terminal })),
      // Every pane the tab holds, a mod pane too, when ls gives that count (`panes`), else null:
      // `terminals` lists terminal panes only, so it can't tell a tab holding one pane.
      paneCount: Number.isSafeInteger(t.panes) ? Math.max(t.panes, (t.terminals ?? []).filter((p) => p?.terminal).length) : null,
    })),
  }));
}

/**
 * Reads the State. `io.run(command, args, { cwd })` resolves with { code, stdout, stderr }
 * (the CLI's runProgram); `io.home` and `io.appHome` are folders. `window: false` skips
 * `herdr-app ls` (spaces: []), for the fixes that never touch the window. A failed hc or
 * herdr-app call rejects: a plan from half a picture would be wrong (except no hc at all with
 * `window: false`: no terminals, so only the registry is checked).
 */
export async function readState(io, { window = true } = {}) {
  const json = async (command, args) => {
    const r = await io.run(command, args);
    if (r.code === 127) throw new Error(`${command} is not on PATH`);
    if (r.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.code}`}`);
    try { return JSON.parse(r.stdout); } catch { throw new Error(`${command} ${args.join(" ")} printed no JSON`); }
  };
  // With no hc there are no labels to fix: the window-free read goes on without terminals.
  const ls = await json("hc", ["ls", "--json"]).catch((e) => { if (!window && /is not on PATH/.test(e.message)) return { terminals: [] }; throw e; });
  const rows = (Array.isArray(ls?.terminals) ? ls.terminals : Array.isArray(ls) ? ls : []).filter((r) => r?.address && r.state === "live");
  const terminals = await Promise.all(rows.map(async (row) => {
    if (!local(row.address)) return terminalOf(row, null);
    const r = await io.run("hc", ["get", row.address, "--json"]);
    let get = null;
    try { get = r.code === 0 ? JSON.parse(r.stdout) : null; } catch { get = null; }
    return terminalOf(row, get);
  }));
  const spaces = window ? spacesOf(await json("herdr-app", ["ls"])) : [];
  const registry = listedProjects(readText(`${io.appHome}/${PROJECTS_FILE}`));

  // What git and the disk say about every folder on this computer that the plan looks at.
  const home = (f) => !f || f === "~" || f === io.home;
  const wanted = new Set([...registry, ...spaces.filter((s) => s.machine == null).map((s) => s.folder),
    ...terminals.filter((t) => local(t.address)).map((t) => t.cwd)].filter((f) => typeof f === "string" && f.startsWith("/") && !home(f)));
  const git = async (args, cwd) => { const r = await io.run("git", args, { cwd }); return r.code === 0 ? r.stdout : null; };
  const exists = async (path) => readText(path) !== null;
  const folders = {};
  await Promise.all([...wanted].map(async (folder) => {
    const found = folderState(folder);
    if (found === null) return; // unknown: left out, so nothing is pruned or recreated on it
    if (found === "gone") { folders[folder] = { exists: false, key: null, top: null }; return; }
    const { key } = await projectOf(folder, git, exists);
    const top = (await git(["rev-parse", "--show-toplevel"], folder))?.trim() || null;
    // git answers with real paths: a symlinked folder keeps its own name, with the real one beside it.
    let real = folder;
    try { real = realpathSync(folder); } catch { /* raced away: compared by name only */ }
    folders[folder] = { exists: true, key, top, ...(real !== folder ? { real } : {}) };
  }));

  // The bots file of every project those folders key to.
  const keys = new Set(Object.values(folders).filter((f) => f.exists).map((f) => f.key));
  const projects = [];
  for (const key of [...keys].sort()) {
    const text = readText(under(key, BOTS_PATH));
    if (text === null) continue;
    try {
      const file = JSON.parse(text);
      if (file?.version === 1 && Array.isArray(file.bots)) projects.push({ key, machine: null, file });
    } catch { /* not JSON: the sidebar and the CLI say so; tidy leaves it out */ }
  }
  return { terminals, spaces, projects, registry, folders };
}

/**
 * Carries out a plan's non-visual actions: the registry prune (`io.prune(keys)`, which
 * rewrites PROJECTS_FILE and returns the keys it took off) and role=/category= relabels
 * (`hc label`). Returns lines to print, with prune notes when `notes` is true. With
 * `onRelabelFailure`, passes each failed label write's details to the caller instead.
 */
export async function fixNonVisual(actions, io, { notes = true, onRelabelFailure } = {}) {
  const warnings = [];
  const keys = actions.filter((a) => a.kind === "prune-registry").map((a) => a.key);
  if (keys.length) {
    try {
      const taken = io.prune(keys);
      for (const key of notes && Array.isArray(taken) ? taken : []) warnings.push(`tidy: ${key} taken off the project list: its folder is gone.`);
    } catch (e) { warnings.push(`tidy: couldn't take ${keys.join(", ")} off ${PROJECTS_FILE}: ${e?.message ?? e}`); }
  }
  for (const { terminal, set } of actions.filter((x) => x.kind === "relabel" && !x.visual)) {
    const words = labelWordsOf(set);
    let result;
    try {
      result = await io.run("hc", ["label", terminal, ...words]);
    } catch (error) {
      if (!onRelabelFailure) throw error;
      onRelabelFailure({ terminal, words, error });
      continue;
    }
    if (result.code === 0) continue;
    if (onRelabelFailure) onRelabelFailure({ terminal, words, result });
    else warnings.push(`tidy: ${terminal}'s labels ${words.join(" ")} weren't set: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return warnings;
}
