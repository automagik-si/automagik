// Bot definitions in Herdr: which projects have them (every open space's folder plus the
// remembered projects), reading and writing them on this machine or another (remoteFile.js),
// and watching them here. The rules themselves live in model.js. Apache-2.0.
//
// No `fs/promises` here: Herdr's writes only under its app home, and has no access().
// Files go through readTextFile/writeTextFile, folders through exec.

import { spaces, exec, readTextFile, writeTextFile, watchFolder, shared, setShared, home, appHome, hc, terminals, notify } from "herdr";
import { BOT_LABEL, BOTS_PATH, PROJECTS_FILE, botsText, projectOf, paneKeyOf, parseBots, checkBots, listedProjects, writeFolderOf } from "./model.js";
import { relabel, relabelPlan, relabelWarning } from "./launchArgs.js";
import { TimedOut, discover, machineGate } from "./discover.js";
import { writeRemoteText } from "./remoteFile.js";

// Projects a bot was created or attached in: [{ key, machine }], machine null for this one.
const REMEMBERED = "am.sidebar.projects";
// A folder's project changes rarely (a repo made or removed): looked up again after a minute.
const KEY_TTL = 60_000;
// The last discovery kept between runs (discoverySnapshot): a folder's key while a space has
// shown it in the last week; a project's file, drawn only until its machine answers in this
// run of Herdr, for at most a day after it was read and three discoveries without an answer.
const KEYS_KEPT_MS = 7 * 24 * 3600_000;
const SAVED_MS = 24 * 3600_000;
const SAVED_RUNS = 3;

const keys = new Map(); // JSON [machine, folder] -> { key, own, at, used } (model.js projectOf)
const paneKeys = new Map(); // folder on this computer -> { key, at } (model.js paneKeyOf)
// JSON [machine, key] -> { file, warnings, seen, saved? }: seen when it was read, saved when
// it came from the last run of Herdr (restoreDiscovery) and wasn't read again since.
const lastGood = new Map();
const gates = new Map(); // machine -> discover.js machineGate: every call there goes through it
const misses = new Map(); // machine -> discoveries it hasn't answered, while it has saved files

const id = (machine, key) => JSON.stringify([machine ?? null, key]);
const under = (key, rest) => `${key === "/" ? "" : key}/${rest}`;

function gateOf(machine) {
  const m = machine ?? null;
  if (!gates.has(m)) gates.set(m, machineGate());
  return gates.get(m);
}
// One call on a machine, through its gate (at most DISCOVER_LIMIT at once there; with
// `sleep`, the caller's timer, one to another machine gives up after CALL_TIMEOUT_MS).
const onMachine = (on, ask, sleep) => gateOf(on).call(ask, { sleep, remote: Boolean(on) });

// A call that rejects on another machine: rethrown when the machine can't be reached (the
// answer is unknown, never "no"), else `fallback` (the program or file isn't there).
// On this machine a rejection always means the program or file isn't there. A TimedOut
// (onMachine) means the machine is away.
async function orUnreachable(on, call, fallback, sleep) {
  try { return await onMachine(on, call, sleep); } catch (e) {
    if (!on) return fallback;
    if (e instanceof TimedOut) throw e;
    try { await onMachine(on, () => exec("true", [], { on }), sleep); } catch { throw e; }
    return fallback;
  }
}
function gitOn(on, sleep) {
  return (args, cwd) => orUnreachable(on, async () => {
    const r = await exec("git", args, { cwd, on });
    return r.code === 0 ? r.stdout : null;
  }, null, sleep);
}
function existsOn(on, sleep) {
  return (p) => orUnreachable(on, async () => (await readTextFile(p, { on })) !== null, false, sleep);
}

/**
 * The project of a folder on a machine (null: this one), as model.js projectOf's
 * `{ key, own }`, cached for a minute. When the machine can't be reached, the last answer
 * found for the folder (not asked again for a minute); with none, it rejects. `opts.sleep`:
 * see onMachine.
 */
export async function projectOfFolder(folder, machine = null, { sleep = null } = {}) {
  const k = id(machine, folder);
  const hit = keys.get(k);
  if (hit && Date.now() - hit.at < KEY_TTL) return { key: hit.key, own: hit.own };
  let found;
  try {
    found = await projectOf(folder, gitOn(machine, sleep), existsOn(machine, sleep));
  } catch (e) {
    if (!hit) throw e;
    hit.at = Date.now();
    return { key: hit.key, own: hit.own };
  }
  keys.set(k, { ...found, at: Date.now(), used: Date.now() });
  return found;
}

/** The project key of a folder seen in passing (a pane's, a space's): the walk-up rule. */
export async function keyOf(folder, machine = null) {
  return (await projectOfFolder(folder, machine)).key;
}

/**
 * The project key of a bot pane's folder on this computer (model.js paneKeyOf: null when the
 * folder names no project, or can't be read), cached for a minute like projectOfFolder.
 */
export async function paneKeyOfFolder(folder) {
  const hit = paneKeys.get(folder);
  if (hit && Date.now() - hit.at < KEY_TTL) return hit.key;
  let key = null;
  try { key = await paneKeyOf(folder, gitOn(null), existsOn(null)); } catch { /* unreadable: no project */ }
  paneKeys.set(folder, { key, at: Date.now() });
  return key;
}

/** The project of a folder someone picked as the project: its git main checkout, else itself. */
export async function ownKeyOf(folder, machine = null) {
  return (await projectOfFolder(folder, machine)).own;
}

/** Whether a folder is there now; false also when its machine can't be asked. */
export async function folderExists(folder, machine = null) {
  try { return (await exec("test", ["-d", folder], { on: machine })).code === 0; } catch { return false; }
}

// The projects the command line created, edited, started or attached bots in (model.js
// PROJECTS_FILE, local keys). Only the CLI writes the file; an unreadable one lists none.
async function listedByCli() {
  try { return listedProjects(await readTextFile(`${appHome()}/${PROJECTS_FILE}`)); } catch { return []; }
}

function remembered() {
  const list = shared(REMEMBERED);
  return Array.isArray(list) ? list.filter((p) => typeof p?.key === "string") : [];
}

/** Remembers a project so its bots are found with no open space (setShared only on a change). */
export function rememberProject(key, machine = null) {
  const list = remembered();
  if (list.some((p) => p.key === key && (p.machine ?? null) === machine)) return;
  setShared(REMEMBERED, [...list, { key, machine }]);
}

function forgetProject(key, machine) {
  const list = remembered();
  const kept = list.filter((p) => !(p.key === key && (p.machine ?? null) === machine));
  if (kept.length !== list.length) setShared(REMEMBERED, kept);
}

// One project's bots.json for discover.js: { file, warnings }, null when there is none (a
// remembered project is forgotten then); rejects when the machine can't answer.
async function readProject(p, sleep) {
  const k = id(p.machine, p.key);
  const text = await onMachine(p.machine, () => readTextFile(under(p.key, BOTS_PATH), { on: p.machine }), sleep);
  if (text === null) {
    lastGood.delete(k);
    if (p.remembered) forgetProject(p.key, p.machine);
    return null;
  }
  try {
    const { file, warnings } = parseBots(text);
    lastGood.set(k, { file, warnings, seen: Date.now() });
    return { file, warnings };
  } catch (e) {
    const why = `${under(p.key, BOTS_PATH)}: ${e?.message ?? e}`;
    const last = lastGood.get(k);
    return last ? { file: last.file, warnings: [why, ...last.warnings] } : { file: { version: 1, categories: [], bots: [] }, warnings: [why] };
  }
}

const ago = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3600_000)} h`);

// What a project shows when its read rejects or hasn't answered yet: its last good file. One
// from the last run of Herdr only until its machine answers, and within SAVED_MS and
// SAVED_RUNS; while the machine is away it is marked `stale`, with when it was read.
function lastOf(p) {
  const k = id(p.machine, p.key);
  const last = lastGood.get(k);
  if (!last) return undefined;
  if (!last.saved) return { file: last.file, warnings: last.warnings };
  const gate = gateOf(p.machine);
  if (gate.answered || (misses.get(p.machine) ?? 0) >= SAVED_RUNS || Date.now() - last.seen > SAVED_MS) {
    lastGood.delete(k);
    return undefined;
  }
  if (!gate.away) return { file: last.file, warnings: last.warnings };
  const note = `last seen ${ago(Date.now() - last.seen)} ago; ${p.machine ?? "this computer"} isn't answering`;
  return { file: last.file, warnings: [note, ...last.warnings], stale: true };
}

/**
 * Every project with definitions, once each however many spaces show it:
 * [{ key, machine, file, warnings, spaces }], `spaces` the ids of the open spaces keyed
 * to it, in sidebar order (A8 draws the tree under the first). For showing only: `file`
 * is parseBots' cleaned copy (see writeBots). A read that rejects (the machine is away)
 * keeps the last good one; a file that doesn't parse keeps the last good one too, else
 * comes back with no bots and the reason in `warnings`. A remembered project is forgotten
 * only when its file is gone (read returns null), never when the read rejects. The CLI's
 * projects (listedByCli) are found as the remembered ones are; one whose file is gone is
 * just not shown: its line in the CLI's file stays, as the view never writes that file.
 * Each machine is asked on its own, a few lookups at once (discover.js); a folder keyed
 * before is placed at once and, its key a minute old, looked up again in the same discovery.
 * `opts.sleep(ms)` (the caller's timer: a mod has no setTimeout) bounds each call to another
 * machine to CALL_TIMEOUT_MS, after which that machine's projects show their last good file
 * (lastOf: `stale` for one from the last run of Herdr); `opts.onUpdate(list)` gets the list
 * as soon as a machine is done, this computer's projects first.
 */
export async function discoverProjects({ sleep = null, onUpdate = null } = {}) {
  // An empty folder is that machine's home. Ours is home(); another machine's isn't known
  // here without asking it, so such a space is skipped (its projects can be remembered).
  const shown = spaces().map((s) => ({ id: s.id, machine: s.machine ?? null, folder: s.folder || (s.machine ? null : home()) }));
  const found = await discover({ spaces: shown, remembered: remembered() }, {
    listed: listedByCli,
    cachedKey: (folder, machine) => {
      const hit = keys.get(id(machine, folder));
      if (!hit) return undefined;
      hit.used = Date.now();
      return { key: hit.key, fresh: Date.now() - hit.at < KEY_TTL };
    },
    keyOf: async (folder, machine) => (await projectOfFolder(folder, machine, { sleep })).key,
    read: (p) => readProject(p, sleep),
    last: lastOf,
  }, { onUpdate });
  // A machine with files from the last run of Herdr that didn't answer this time.
  const waiting = new Set([...lastGood].filter(([, v]) => v.saved).map(([k]) => JSON.parse(k)[0]));
  for (const m of waiting) if (!gateOf(m).answered) misses.set(m, (misses.get(m) ?? 0) + 1);
  return found;
}

// ---- The last discovery, kept between runs (main.js keeps it in its localStorage) ----

/**
 * The text that restoreDiscovery draws from after a restart: the keys of the folders shown
 * in the last KEYS_KEPT_MS, and the projects found (`found`, discoverProjects' list), each
 * with its last good file and when that was read (a stale one keeps its old time).
 */
export function discoverySnapshot(found, now = Date.now()) {
  return JSON.stringify({
    keys: [...keys].filter(([, v]) => now - (v.used ?? 0) <= KEYS_KEPT_MS).map(([k, v]) => [...JSON.parse(k), v.key, v.own, v.used]),
    projects: found.map((p) => {
      const last = lastGood.get(id(p.machine, p.key));
      return { key: p.key, machine: p.machine ?? null, file: last?.file ?? p.file, warnings: last?.warnings ?? p.warnings, seen: last?.seen ?? now };
    }),
  });
}

/**
 * At startup, a discoverySnapshot text (null, or anything unreadable: nothing): its keys and
 * projects become the ones known (each folder looked up again at the next discovery, each
 * project read again; a machine away shows them as lastOf says), and the projects come back
 * as discoverProjects would list them for the spaces open now, to draw before it has
 * answered. Keys unused for KEYS_KEPT_MS and files read over SAVED_MS ago are left out.
 */
export function restoreDiscovery(text) {
  let saved;
  try { saved = JSON.parse(text); } catch { return []; }
  if (!saved || typeof saved !== "object") return [];
  const str = (v) => typeof v === "string";
  for (const e of Array.isArray(saved.keys) ? saved.keys : []) {
    if (!Array.isArray(e)) continue;
    const [machine, folder, key, own, used] = e;
    if (!(machine === null || str(machine)) || !str(folder) || !str(key) || !str(own)) continue;
    if (!Number.isFinite(used) || Date.now() - used > KEYS_KEPT_MS) continue;
    const k = id(machine, folder);
    if (!keys.has(k)) keys.set(k, { key, own, at: 0, used });
  }
  const out = [];
  for (const p of Array.isArray(saved.projects) ? saved.projects : []) {
    if (!p || !str(p.key) || !(p.machine === null || str(p.machine))) continue;
    if (!Number.isFinite(p.seen) || Date.now() - p.seen > SAVED_MS) continue;
    let file;
    try { ({ file } = parseBots(JSON.stringify(p.file))); } catch { continue; }
    const warnings = Array.isArray(p.warnings) ? p.warnings.filter(str) : [];
    const k = id(p.machine, p.key);
    if (!lastGood.has(k)) lastGood.set(k, { file, warnings, seen: p.seen, saved: true });
    const on = spaces().filter((s) => {
      const folder = s.folder || (s.machine ? null : home());
      return folder && keys.get(id(s.machine ?? null, folder))?.key === p.key && (s.machine ?? null) === p.machine;
    }).map((s) => s.id);
    out.push({ key: p.key, machine: p.machine, spaces: on, file, warnings });
  }
  return out;
}

// herdr-core's file ops and a shell on another machine, for remoteFile.js.
const remoteIo = { hc, exec: (command, args, on) => exec(command, args, { on }) };

/**
 * Writes a project's definitions on this machine, or on `machine` (a linked one, through
 * herdr-core: remoteFile.js), and remembers the project. Read-edit-write, so nobody's edit is lost:
 *   const text = await readTextFile(`${key}/.herdr/bots.json`, { on: machine });   // null: no file yet
 *   const file = text === null ? { version: 1, categories: [], bots: [] } : parseBots(text).raw;
 *   ... edit `file` ...
 *   await writeBots(key, file, text);
 * Edit `raw`, never parseBots' `file` or discoverProjects' copy: those leave out entries
 * that can't be shown, and writing them would delete those entries. `expected` is required:
 * the text read (null when there was no file); a file changed since rejects (writeTextFile's
 * stale-snapshot rule). A file checkBots faults is refused before anything is written.
 * On another machine the same rule holds there (a stale snapshot rejects, nothing written).
 * After an edit, the labels of the changed bots' live local panes follow (relabelLocal),
 * without the save waiting for them: resolves with { relabel }, that work's promise.
 * Another machine's panes are left as they are.
 * `dir` (this machine only): the folder written, when the edit was made from a worktree of the
 * project (editFolderOf; RFC 0014 Q16, #234). `expected` is then the text at `dir`, and
 * `before` the text the edit started from (the key's, where `dir` had no file yet).
 */
export async function writeBots(projectKey, file, expected, machine = null, { dir = projectKey, before = expected } = {}) {
  if (expected === undefined) throw new Error("writeBots: pass the text the edit started from (null for a new file)");
  const errors = checkBots(file, before);
  if (errors.length) throw new Error(`Not saved: ${errors.join("; ")}`);
  if (machine) {
    await writeRemoteText(remoteIo, machine, under(projectKey, BOTS_PATH), botsText(file, expected), expected);
    keys.clear();
    rememberProject(projectKey, machine);
    return { relabel: Promise.resolve({ done: [], failed: [], unchecked: [] }) };
  }
  // writeTextFile isn't documented to make folders; Herdr's fs writes only in its home.
  if (expected === null) {
    const herdr = under(dir, ".herdr");
    const r = await exec("mkdir", ["-p", herdr]);
    if (r.code !== 0) throw new Error(`Couldn't make ${herdr}: ${r.stderr.trim()}`);
  }
  // Indented as the file is, or as the key's where a worktree has none yet (#230).
  await writeTextFile(under(dir, BOTS_PATH), botsText(file, expected ?? before), expected);
  keys.clear(); // a folder outside git may belong to this project now
  rememberProject(projectKey, null);
  // Not awaited: the save is done; the labels follow on their own (A16).
  return { relabel: before === null ? Promise.resolve({ done: [], failed: [], unchecked: [] }) : relabelLocal(before, file) };
}

/**
 * Where an edit made from `folder` (a space's) to project `key` is written: its git top level
 * when that is a worktree of the project (model.js writeFolderOf), else the key. On another
 * machine always the key, as before.
 */
export async function editFolderOf(folder, key, machine = null) {
  if (machine || !folder) return key;
  try { return (await writeFolderOf(folder, gitOn(null))) ?? key; } catch { return key; }
}

/**
 * What git says about `key`'s .herdr/bots.json (this machine): "untracked" when git doesn't
 * know the file, "modified" when it is committed but has local changes, "deleted" when it is
 * committed and deleted in the working tree without that deletion being staged,
 * "deleted-autostash" when that deletion would be stashed for a rebase pull instead
 * (rebase.autoStash=true), "staged-deletion" when the deletion is staged, "committed-deletion"
 * when HEAD has no file, `dir` (the worktree an edit came from) does, and the merge base of HEAD
 * and that worktree had it; null when it is clean or git can't say. A pull that brings a
 * worktree's committed file stops on the first two (#234, #332); an unstaged deletion is
 * restored by a merge pull and refused by a rebase pull instead (#626); a deletion committed
 * after the worktree branched ends in modify/delete too, one before it only adds.
 */
export async function changesIn(key, dir = null) {
  try {
    const git = gitOn(null);
    // porcelain=v2 keeps the state an explicit field: v1's unstaged " D" loses its leading
    // space to a trimmed stdout, while a v2 record's "1" is its first character (#626).
    const out = (await git(["status", "--porcelain=v2", "--", BOTS_PATH], key)) ?? "";
    if (!out.trim()) return await committedDeletion(key, dir);
    const line = out.split("\n").find((l) => l);
    if (line.startsWith("? ")) return "untracked";
    if (line.startsWith("1 ")) {
      const state = line.split(" ")[1];
      // A staged deletion is not "modified": committing it turns the pull into modify/delete (#665).
      if (state === "D.") return "staged-deletion";
      if (state === ".D") return (await git(["config", "--bool", "--get", "rebase.autoStash"], key))?.trim() === "true" ? "deleted-autostash" : "deleted";
    }
    return "modified";
  } catch { return null; }
}

/**
 * #626: a committed deletion leaves `git status` empty, yet a pull that brings the worktree's
 * version of a file the merge base has, and HEAD has deleted, ends in a modify/delete conflict.
 * The merge base, not the path's history, is the test: a deletion committed before the worktree
 * branched leaves no file at the base, and the pull only adds the worktree's file.
 */
async function committedDeletion(key, dir) {
  if (!dir || dir === key) return null;
  if ((await gitOn(null)(["show", `HEAD:${BOTS_PATH}`], key)) !== null) return null;
  if ((await readTextFile(under(dir, BOTS_PATH))) === null) return null;
  const worktreeHead = (await gitOn(null)(["rev-parse", "HEAD"], dir))?.trim();
  if (!worktreeHead) return null;
  const base = (await gitOn(null)(["merge-base", "HEAD", worktreeHead], key))?.trim();
  if (!base) return null;
  return (await gitOn(null)(["cat-file", "-e", `${base}:${BOTS_PATH}`], key)) !== null ? "committed-deletion" : null;
}

/**
 * A16: after an edit (the form's save, any writeBots), the live panes on this computer of
 * every bot whose labels changed (rank, lead, category, a lead's captain status) get them
 * rewritten by launchArgs.js relabel. Another machine's panes are never touched. Never
 * rejects: panes left unlabelled are named in one notice. Resolves relabel's { done, failed }.
 */
export async function relabelLocal(beforeText, afterRaw) {
  try {
    const plan = relabelPlan(parseBots(beforeText).file, parseBots(JSON.stringify(afterRaw)).file);
    if (!plan.length) return { done: [], failed: [], unchecked: [] };
    const io = {
      rows: async (id) => terminals().filter((t) => t?.state === "live" && typeof t.address === "string" && !t.address.includes("/")
        && t.labels?.[BOT_LABEL] === id),
      label: async (address, words) => (await hc(["label", address, ...words])).code === 0,
    };
    const out = await relabel(plan, io);
    const warning = relabelWarning(out);
    if (warning) {
      notify({ title: "Bots", level: "warning", timeout: 15000,
        body: `${warning} Edit the bot again, or Detach and Attach it, to retry.` });
    }
    return out;
  } catch (e) {
    notify({ title: "Bots", level: "warning", timeout: 15000, body: `Saved, but the panes' labels weren't updated: ${e?.message ?? e}` });
    return { done: [], failed: [], unchecked: [] };
  }
}

/**
 * Watches a local project's `.herdr/` folder and calls onChange after each change, while
 * stillWanted() holds; run it in cx.spawn. Resolves false at once when the project has no
 * bots.json (the 15-second re-read covers it), and when the watch fails.
 * Another machine's projects can't be watched (watchFolder takes no `on`).
 */
export async function watchProject(key, stillWanted, onChange) {
  try { if ((await readTextFile(under(key, BOTS_PATH))) === null) return false; } catch { return false; }
  try {
    while (stillWanted()) {
      await watchFolder(under(key, ".herdr"));
      if (stillWanted()) await onChange();
    }
    return true;
  } catch { return false; }
}
