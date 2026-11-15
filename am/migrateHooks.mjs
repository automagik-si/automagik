// The briefing hook across the rename (Group 6b): every hook the pack wrote moves onto the fixed
// entry point <app home>/automagik-herdr/briefing.mjs (briefingEntry.mjs, which runs whichever
// sidebar folder is installed), and back to v0.3's path when a rollback lands a release that
// doesn't know that entry point. It looks where the pack writes hooks: the projects it knows (the
// sidebar's and the CLI's remembered lists), each one's git worktrees (so bot workers'
// <project>/.claude/worktrees/<slug> are covered) and a bounded scan of their subfolders (Attach
// writes into the pane's folder, which may be any subfolder of the project), the ledger's start
// folders, and, when the caller passes them, the open spaces' and bot panes' folders.
// In each .claude/settings.local.json only a UserPromptSubmit command of the pack's own shape,
// naming this app home's script, is edited, in place: every other byte stays. A file that isn't
// JSON, one whose command can't be changed in place, a link and any other shape are reported and left. Each rewrite is backed
// up beside the file first (settings.local.json.am-backup, then -2, -3…: never over an earlier
// one) and journalled in <app home>/automagik-herdr/hooks-journal.json before it is written; the
// revert reads that journal and edits a command back only where it still holds what was written.
// It also repoints the CLI link at the sidebar folder installed. Node only. Apache-2.0.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ENTRY_SOURCE, OURS, directHookCommand, hookCommand, isAmPartEntry, legacyHookCommand, scriptOf, stableBriefingPath } from "./briefingText.mjs";
import { PATH_RENAMES, SHARED_RENAMES, renamedFrom } from "./migrate.js";
import { PROJECTS_FILE, listedProjects } from "./model.js";
import { removePath } from "./layoutSafe.mjs";
import { OLD_PACK_NAME, PACK_NAME } from "./release.js";

export const HOOKS_JOURNAL = "hooks-journal.json";
export const BACKUP_SUFFIX = ".am-backup";
export const CLI_LINK = "automagik-herdr";
/** The same command under its own name (install.sh links both). */
export const AM_LINK = "am";
/** The sidebar folders, in the order the entry point tries them. */
export const SIDEBARS = Object.freeze([PACK_NAME, OLD_PACK_NAME]);
const MAX_BACKUPS = 100;

const lstat = (path) => { try { return lstatSync(path); } catch { return null; } };
const isLink = (path) => Boolean(lstat(path)?.isSymbolicLink());
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const why = (error) => String(error?.message ?? error).split("\n")[0];
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const short = (text) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

/** Written beside `path` under a fresh name, created exclusively (never through a planted file or link), then renamed over it. */
function writeAtomic(path, body, mode) {
  const tmp = `${path}.am-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(tmp, mode ?? 0o644);
    renameSync(tmp, path);
  } catch (error) { rmSync(tmp, { force: true }); throw error; }
}

// ---- the edit, over text ----

/**
 * A settings.local.json text with each UserPromptSubmit command moved where `choose(command)`
 * says: a string replaces it, `false` marks one of the pack's of another shape (reported, kept),
 * null leaves it. Only the command's own JSON string changes, at that hook's place (the same
 * text elsewhere, under another event, stays); every other byte is kept. Returns
 * `{ text, edits: {before, after}[], odd: string[] }`, or `{ error }` when it is no JSON object or
 * a command can't be changed in place (an escape the file spells its own way): then it is left.
 */
export function retargetHooks(text, choose) {
  let settings;
  try { settings = JSON.parse(text); } catch (e) { return { error: `not valid JSON (${why(e)})` }; }
  if (!isObject(settings)) return { error: "not a JSON object" };
  const list = isObject(settings.hooks) ? settings.hooks.UserPromptSubmit : undefined;
  const edits = [];
  const odd = [];
  (Array.isArray(list) ? list : []).forEach((group, g) => (Array.isArray(group?.hooks) ? group.hooks : []).forEach((h, i) => {
    if (!isObject(h) || typeof h.command !== "string") return;
    const to = choose(h.command);
    if (to === false) odd.push(h.command);
    else if (typeof to === "string" && to !== h.command) edits.push({ before: h.command, after: to, at: [g, i] });
  }));
  if (!edits.length) return { text, edits, odd };
  const out = inPlace(text, edits);
  if (out === null) return { error: "its briefing hook's command can't be changed in place (the file spells it with escapes of its own)" };
  return { text: out, edits: edits.map(({ before, after }) => ({ before, after })), odd };
}

/**
 * Each edit's command swapped at its own hook: of the places its JSON string occurs, the one
 * whose swap parses to the file with exactly that hook changed. Null when there is none.
 */
function inPlace(text, edits) {
  const expected = JSON.parse(text);
  let out = text;
  for (const { before, after, at: [g, i] } of edits) {
    expected.hooks.UserPromptSubmit[g].hooks[i].command = after;
    const from = JSON.stringify(before);
    let next = null;
    for (let at = out.indexOf(from); at >= 0 && next === null; at = out.indexOf(from, at + 1)) {
      const candidate = out.slice(0, at) + JSON.stringify(after) + out.slice(at + from.length);
      try { if (isDeepStrictEqual(JSON.parse(candidate), expected)) next = candidate; } catch { /* not this one */ }
    }
    if (next === null) return null;
    out = next;
  }
  return out;
}

/**
 * Forward: a command of the pack's shape (the run.sh form, or the older `node` one) naming this app
 * home's own sidebar script, or its stable one in the older form, or am's own entry (a CLI-only
 * host) → this app home's stable one through run.sh, which runs am's briefing first. Another app
 * home's hook (or a checkout's) is not this run's to move: left.
 */
export function toStable(appHome) {
  const home = appHome.replace(/\/+$/, "");
  const target = hookCommand(home);
  const mine = scriptsOf(home);
  return (command) => {
    if (!OURS.test(command) || command === target) return null;
    const script = scriptOf(command);
    if (script === null) return false;
    return mine.has(script) || isAmPartEntry(script) ? target : null;
  };
}

/** The briefing scripts a hook of this app home's pack runs: each sidebar folder's, and the stable entry point. */
const scriptsOf = (home) => new Set([...SIDEBARS.map((m) => `${home}/mods/${m}/briefing.mjs`), stableBriefingPath(home)]);

/** Whether `command` is a briefing hook of the pack's shape running one of this app home's scripts. */
export function ownHook(appHome) {
  const mine = scriptsOf(appHome.replace(/\/+$/, ""));
  return (command) => typeof command === "string" && OURS.test(command) && mine.has(scriptOf(command));
}

/**
 * A settings.local.json text without the UserPromptSubmit hooks `isMine(command)` names: a group
 * left with no hook goes, then an empty UserPromptSubmit, then an empty `hooks`. Every other key
 * and hook stays; the text is written back as 2-space JSON (the file is backed up first).
 * Returns `{ text, removed }` (the same text when none was removed), or `{ error }`.
 */
export function withoutHooks(text, isMine) {
  let settings;
  try { settings = JSON.parse(text); } catch (e) { return { error: `not valid JSON (${why(e)})` }; }
  if (!isObject(settings)) return { error: "not a JSON object" };
  const list = isObject(settings.hooks) ? settings.hooks.UserPromptSubmit : undefined;
  if (!Array.isArray(list)) return { text, removed: 0 };
  let removed = 0;
  const groups = [];
  for (const group of list) {
    if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) { groups.push(group); continue; }
    const kept = group.hooks.filter((h) => !(isObject(h) && isMine(h.command)));
    removed += group.hooks.length - kept.length;
    if (kept.length === group.hooks.length) groups.push(group);
    else if (kept.length) groups.push({ ...group, hooks: kept });
  }
  if (!removed) return { text, removed: 0 };
  if (groups.length) settings.hooks.UserPromptSubmit = groups;
  else delete settings.hooks.UserPromptSubmit;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { text: json(settings), removed };
}

// ---- where the hooks are ----

const runGit = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  } catch { return null; }
};
const usable = (p) => typeof p === "string" && isAbsolute(p) && resolve(p) !== "/" && isDir(p);

/**
 * The projects the pack knows on this computer: the sidebar's remembered projects (shared.json,
 * read only: am.sidebar.projects, then its name before the rename), the CLI's lists (PROJECTS_FILE,
 * then the name PATH_RENAMES copies it from) and `extra` (the open spaces' folders). Absolute paths, once each.
 */
export function knownProjects(appHome, extra = []) {
  const keys = [];
  try {
    const shared = JSON.parse(readFileSync(join(appHome, "shared.json"), "utf8"));
    for (const name of ["am.sidebar.projects", renamedFrom(SHARED_RENAMES, "am.sidebar.projects")]) {
      const list = isObject(shared) && Object.hasOwn(shared, name) ? shared[name] : null;
      for (const p of Array.isArray(list) ? list : []) if (typeof p?.key === "string" && !p.machine) keys.push(p.key);
    }
  } catch { /* none, or unreadable: none */ }
  for (const name of [PROJECTS_FILE, PATH_RENAMES.find(([, to]) => to === PROJECTS_FILE)?.[0]].filter(Boolean)) {
    try { keys.push(...listedProjects(readFileSync(join(appHome, name), "utf8"))); } catch { /* none */ }
  }
  keys.push(...extra);
  return [...new Set(keys.filter((k) => typeof k === "string" && isAbsolute(k)))];
}

/** The folders of this computer's open spaces (`herdr-app ls`), or none when it gives no answer. */
export function openSpaces(run = execFileSync) {
  try {
    const ls = JSON.parse(run("herdr-app", ["ls"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
    return (Array.isArray(ls?.spaces) ? ls.spaces : []).filter((s) => !s?.machine && typeof s?.folder === "string").map((s) => s.folder);
  } catch { return []; }
}

/**
 * The folders of this computer's bot panes (live, labelled `bot`), from `hc ls` and `hc get`; none
 * without hc. The foreground's cwd comes first: it is the folder Attach writes the hook into.
 */
export function botPaneFolders(run = execFileSync) {
  const ask = (args) => {
    try { return JSON.parse(run("hc", [...args, "--json"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
  };
  const ls = ask(["ls"]);
  const rows = (Array.isArray(ls?.terminals) ? ls.terminals : []).filter((r) => typeof r?.address === "string" && r.state === "live" && !r.address.includes("/"));
  const out = [];
  for (const row of rows.slice(0, 200)) {
    const get = ask(["get", row.address]);
    const cwd = get?.foreground?.cwd ?? get?.cwd ?? row.cwd;
    if (get?.labels?.bot && typeof cwd === "string") out.push(cwd);
  }
  return out;
}

/** The Herdr ledgers (workers.js LEDGER_FILE and attach.js ATTACH_FILE), named here so the updater needs no more of the pack. */
const LEDGER = join("automagik-herdr", "workers.jsonl");
const ATTACH_LEDGER = join("automagik-herdr", "attach.jsonl");
export const HERDR_LEDGERS = Object.freeze([LEDGER, ATTACH_LEDGER]);

function readSafeLedgerText(path, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  const flags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd;
  try { fd = openSync(path, flags); } catch { return ""; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink?.()) return "";
    if (uid !== null && typeof st.uid === "number" && st.uid !== uid) return "";
    return readFileSync(fd, "utf8");
  } catch {
    return "";
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** The folders the ledger's start rows name (each worker's worktree, each bot seat's folder). */
export function ledgerFolders(appHome, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  const text = readSafeLedgerText(join(appHome, LEDGER), uid);
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    try { const row = JSON.parse(line); if (row?.event === "start" && typeof row.worktree === "string") out.push(row.worktree); } catch { /* a torn line */ }
  }
  return out;
}

/** Project folders derived from `ledgerFolders(appHome)` and the ledgers' `project` rows. */
function ledgerProjectFolders(appHome, git = runGit, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  const distinct = new Set();
  for (const rel of HERDR_LEDGERS) {
    const text = readSafeLedgerText(join(appHome, rel), uid);
    if (!text) continue;
    for (const line of text.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (typeof row?.project === "string" && isAbsolute(row.project) && resolve(row.project) !== "/") distinct.add(row.project);
        if (typeof row?.worktree === "string" && isAbsolute(row.worktree) && resolve(row.worktree) !== "/") distinct.add(row.worktree);
      } catch { /* a torn line */ }
    }
  }
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const out = new Set();
  for (const f of distinct) {
    out.add(f);
    const at = f.indexOf(marker);
    if (at > 0) out.add(f.slice(0, at));
    if (usable(f)) out.add(keyOf(f, git));
  }
  return [...out];
}

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Tightens existing Herdr ledgers (`automagik-herdr/workers.jsonl` and `automagik-herdr/attach.jsonl`)
 * to 0600 (or 0400 when owner read-only) in `appHome` and in `<project>/.herdr/app-home` for every
 * project in `knownProjects` and `ledgerFolders` (#839). Never follows symlinks, never creates
 * missing files, never widens a stricter mode (0400/0000), and leaves unowned or owner-unreadable
 * files alone with a warning.
 *
 * Returns `{ tightened, warnings }`. Every warning is logged (`warn`), except one (#883): a ledger
 * its owner cannot read (0070) is returned in `warnings` and logged nowhere. Nothing here can
 * change it, so every install and update would say it again; the doctor reports it
 * (`herdr-ledgers`, with the chmod to run). A ledger whose mode lets its owner read it but which
 * still cannot be opened (an ACL, a file flag) is warned about with that reason, not as unreadable.
 */
export function tightenLedgers(appHome, {
  extra = [], git = runGit, getuid = process.getuid,
  stat = lstatSync, open = openSync, fstat = fstatSync, fchmod = fchmodSync, close = closeSync,
  log = () => {}, warn = true,
} = {}) {
  const uid = typeof getuid === "function" ? getuid() : null;
  const homes = [resolve(appHome)];
  const known = new Set(knownProjects(appHome, extra));
  const projects = new Set([...known, ...ledgerProjectFolders(appHome, git, uid)]);
  for (const k of known) {
    if (typeof k === "string" && isAbsolute(k) && resolve(k) !== "/" && usable(k)) {
      projects.add(keyOf(k, git));
    }
  }
  for (const p of projects) {
    if (typeof p !== "string" || !isAbsolute(p) || resolve(p) === "/") continue;
    homes.push(join(p, ".herdr", "app-home"));
  }
  const seenResolved = new Set();
  const seenCanonical = new Set();
  const tightened = [];
  const modes = new Set();
  const warnings = [];
  const noteWarn = (w) => {
    warnings.push(w);
    if (warn) log(`warning: ${w}`);
  };
  /** An owner-unreadable ledger: returned, never logged here (the doctor's to report). */
  const noteUnreadable = (file, oct) => {
    warnings.push(`${file} is not readable by its owner (mode ${oct}): left as it is; run chmod 600 ${shQuote(file)}`);
  };
  for (const home of homes) {
    for (const rel of HERDR_LEDGERS) {
      const file = join(home, rel);
      const abs = resolve(file);
      if (seenResolved.has(abs)) continue;
      seenResolved.add(abs);
      let st;
      try { st = stat(file); } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
        noteWarn(`${file} could not be inspected (${e?.message ?? e})`);
        continue;
      }
      if (!st) continue;
      const realParent = realOf(dirname(file));
      const canonical = realParent ? join(realParent, basename(file)) : abs;
      if (seenCanonical.has(canonical)) continue;
      seenCanonical.add(canonical);
      if (st.isSymbolicLink() || !st.isFile()) {
        const kind = st.isSymbolicLink() ? "a symlink" : "not a regular file";
        noteWarn(`${file} is ${kind}: left as it is (Herdr ledgers must be plain files)`);
        continue;
      }
      if (uid !== null && typeof st.uid === "number" && st.uid !== uid) {
        noteWarn(`${file} is owned by uid ${st.uid}, not ${uid}: left as it is (chmod 600 requires the owner)`);
        continue;
      }
      const mode = st.mode & 0o777;
      if ((mode & 0o177) !== 0) {
        const oct = `0${mode.toString(8).padStart(3, "0")}`;
        if ((mode & 0o400) === 0) {
          noteUnreadable(file, oct);
          continue;
        }
        try {
          let fd = null;
          try {
            fd = open(file, (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          } catch (e) {
            if (e?.code === "ELOOP" || e?.code === "EFTYPE") {
              noteWarn(`${file} became a symlink: left as it is (Herdr ledgers must be plain files)`);
              continue;
            }
            if (e?.code === "EACCES" || e?.code === "EPERM") {
              // The mode lets the owner read it (checked above), so the mode is not the reason.
              noteWarn(`${file} could not be opened (${e.code}) although its mode ${oct} lets its owner read it`
                + " (an ACL, a file flag or its folder may refuse it): left as it is");
              continue;
            }
            throw e;
          }
          try {
            const fst = fstat(fd);
            if (!fst || fst.isSymbolicLink?.() || !fst.isFile()
              || fst.dev !== st.dev || fst.ino !== st.ino) {
              noteWarn(`${file} changed during inspection: left as it is (Herdr ledgers must be plain files)`);
              continue;
            }
            if (uid !== null && typeof fst.uid === "number" && fst.uid !== uid) {
              noteWarn(`${file} is owned by uid ${fst.uid}, not ${uid}: left as it is (chmod 600 requires the owner)`);
              continue;
            }
            const fmode = fst.mode & 0o777;
            if ((fmode & 0o400) === 0) {
              noteUnreadable(file, `0${fmode.toString(8).padStart(3, "0")}`);
              continue;
            }
            if ((fmode & 0o177) !== 0) {
              const target = fmode & 0o600;
              fchmod(fd, target);
              tightened.push(file);
              modes.add(`0${target.toString(8).padStart(3, "0")}`);
            }
          } finally {
            close(fd);
          }
        } catch (e) {
          noteWarn(`${file} could not be tightened (${e?.message ?? e})`);
        }
      }
    }
  }
  if (tightened.length) {
    const onlyMode = modes.size === 1 ? [...modes][0] : null;
    log(onlyMode
      ? `tightened Herdr ledger(s) to ${onlyMode}: ${tightened.join(", ")}`
      : `tightened Herdr ledger(s): ${tightened.join(", ")}`);
  }
  return { tightened, warnings };
}

/** The key git gives a worktree root: its main checkout (model.js projectOf, for folders in git). */
function keyOf(folder, git) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], folder)?.trim();
  if (!common) return folder;
  if (basename(common) === ".git") return dirname(common);
  return git(["rev-parse", "--show-toplevel"], folder)?.trim() || folder;
}
const realOf = (path) => { try { return realpathSync(path); } catch { return null; } };

export const SCAN_DEPTH = 4;
const SCAN_MAX = 5000;
/** Never entered, beside every dot-folder (.git; .claude, where worker worktrees live): node_modules
 * and macOS's privacy-protected folders (entering one can raise a permission prompt at the person;
 * Library covers iCloud Drive's Library/Mobile Documents). */
const SCAN_SKIP = new Set([
  "node_modules", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures",
]);
/** True when `root` is the home folder or holds it (/, /Users): such a root is never walked. */
function holdsHome(root, home = homedir()) {
  const h = realOf(home);
  const r = realOf(root);
  return Boolean(h && r) && (h === r || h.startsWith(r.endsWith(sep) ? r : r + sep));
}
/**
 * The subfolders of `root`, at most SCAN_DEPTH below it, that hold a .claude folder: no link is
 * followed, and SCAN_SKIP's folders, dot-folders and any folder with its own .git (a nested
 * repository or worktree) are not entered. At most SCAN_MAX folders per root: a scan that stops
 * there says so through `log`. None for a root that is the home folder or one of its ancestors:
 * only the root's own .claude is read there.
 */
function scan(root, log, max = SCAN_MAX) {
  const found = [];
  if (holdsHome(root)) return found;
  let seen = 0;
  let stopped = false;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stopped) return;
      if (!e.isDirectory() || SCAN_SKIP.has(e.name) || e.name.startsWith(".")) continue;
      if (++seen > max) { stopped = true; log(`scan stopped at ${max} in ${root}`); return; }
      const sub = join(dir, e.name);
      if (lstat(join(sub, ".git"))) continue;
      if (lstat(join(sub, ".claude"))) found.push(sub);
      if (depth < SCAN_DEPTH) walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * Where hooks may be, each once: every known project, those of its git worktrees whose key is a
 * known project (a known subfolder of a repository never brings in the repository's root), and a
 * scan of each of those trees (scan); then the `also` folders as they are (panes', the ledger's).
 * `log` hears of a scan that stopped at its cap; `scanMax` lowers that cap (tests).
 */
export function foldersOf(projects, { git = runGit, also = [], log = () => {}, scanMax = SCAN_MAX } = {}) {
  const seen = new Set();
  const out = [];
  const add = (folder) => {
    if (!usable(folder)) return false;
    const real = realOf(folder);
    if (real === null || seen.has(real)) return false;
    seen.add(real);
    out.push(folder);
    return true;
  };
  const known = projects.filter(usable);
  const knownReal = new Set(known.map(realOf));
  const roots = [];
  for (const project of known) {
    if (add(project)) roots.push(project);
    for (const line of (git(["worktree", "list", "--porcelain"], project) ?? "").split("\n")) {
      const tree = line.startsWith("worktree ") ? line.slice("worktree ".length) : null;
      if (tree && usable(tree) && knownReal.has(realOf(keyOf(tree, git))) && add(tree)) roots.push(tree);
    }
  }
  for (const root of roots) for (const sub of scan(root, log, scanMax)) add(sub);
  for (const folder of also) add(folder);
  return out;
}

const SETTINGS = "settings.local.json";
/** A folder's settings.local.json: null when there is none; `skip` when it may not be written. */
function settingsOf(folder) {
  const dir = join(folder, ".claude");
  const file = join(dir, SETTINGS);
  const d = lstat(dir);
  if (!d) return null;
  if (d.isSymbolicLink()) return existsSync(file) ? { file, skip: "its .claude folder is a link (the person's own): left as it is" } : null;
  const f = lstat(file);
  if (!f) return null;
  if (f.isSymbolicLink()) return { file, skip: "a link (the person's own): left as it is" };
  if (!f.isFile()) return { file, skip: "not a file: left as it is" };
  return { file, mode: f.mode & 0o7777 };
}
/** A journalled path the revert may write: an absolute <folder>/.claude/settings.local.json. */
const settingsPath = (file) => typeof file === "string" && isAbsolute(file) && basename(file) === SETTINGS
  && basename(dirname(file)) === ".claude" && resolve(file) === file;

/** A copy of `raw` beside `file`, never over an earlier one: .am-backup, then .am-backup-2… */
function backupOf(file, raw) {
  for (let n = 1; n <= MAX_BACKUPS; n++) {
    const path = n === 1 ? `${file}${BACKUP_SUFFIX}` : `${file}${BACKUP_SUFFIX}-${n}`;
    try { writeFileSync(path, raw, { flag: "wx", mode: 0o600 }); return path; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  throw new Error(`${MAX_BACKUPS} backups are there already`);
}

// ---- the journal ----

const journalPath = (appHome) => join(appHome, "automagik-herdr", HOOKS_JOURNAL);
const entryOk = (e) => isObject(e) && settingsPath(e.file) && typeof e.before === "string" && typeof e.after === "string";
function readJournal(appHome) {
  const path = journalPath(appHome);
  if (isLink(dirname(path)) || isLink(path)) throw new Error(`${path} or its folder is a link: not read`);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return []; throw new Error(`${path} is unreadable (${why(e)})`); }
  return parsed?.version === 1 && Array.isArray(parsed.hooks) ? parsed.hooks.filter(entryOk) : [];
}
function writeJournal(appHome, entries) {
  const path = journalPath(appHome);
  if (isLink(dirname(path)) || isLink(path)) throw new Error(`${path} or its folder is a link: not written`);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, json({ version: 1, hooks: entries }), 0o644);
}

// ---- forward and back ----

/** Rewrites `p.file` from `p.raw` to `p.text` when it still holds `p.raw` and is still no link. */
function rewrite(p) {
  const again = settingsOf(dirname(dirname(p.file)));
  if (!again || again.skip) throw new Error("it became a link or went away");
  if (!readFileSync(p.file).equals(p.raw)) throw new Error("it changed meanwhile");
  writeAtomic(p.file, p.text, p.mode);
}

/**
 * Moves every briefing hook of the pack's shape in `projects` (and their worktrees) onto this app
 * home's stable entry point. `backup` (default true): each file is copied beside itself first; one
 * that can't be is left. The journal is written before the first rewrite.
 * Returns `{ rewritten: string[], skipped: {file, reason}[], journal }` (journal: its path, or null).
 */
export function migrateHooks(projects, { appHome, backup = true, git = runGit, also = [], log } = {}) {
  appHome = resolve(appHome);
  const rewritten = [];
  const skipped = [];
  const due = [];
  const choose = toStable(appHome);
  for (const folder of foldersOf(projects, { git, also, log })) {
    const found = settingsOf(folder);
    if (!found) continue;
    let raw;
    try { raw = readFileSync(found.file); } catch (e) { skipped.push({ file: found.file, reason: `unreadable (${why(e)}): left as it is` }); continue; }
    if (found.skip) { if (OURS.test(raw.toString("utf8"))) skipped.push({ file: found.file, reason: found.skip }); continue; }
    const r = retargetHooks(raw.toString("utf8"), choose);
    if (r.error) { skipped.push({ file: found.file, reason: `${r.error}: left as it is` }); continue; }
    for (const c of r.odd) skipped.push({ file: found.file, reason: `a briefing hook of another shape (${short(c)}): left as it is` });
    if (r.edits.length) due.push({ ...found, raw, text: r.text, edits: r.edits });
  }
  if (!due.length) return { rewritten, skipped, journal: null };
  const ready = [];
  for (const p of due) {
    if (!backup) { ready.push(p); continue; }
    try { p.backup = backupOf(p.file, p.raw); ready.push(p); } catch (e) { skipped.push({ file: p.file, reason: `no backup could be made (${why(e)}): left as it is` }); }
  }
  if (!ready.length) return { rewritten, skipped, journal: null };
  const at = new Date().toISOString();
  writeJournal(appHome, [...readJournal(appHome), ...ready.flatMap((p) => p.edits.map((e) => ({ file: p.file, ...e, backup: p.backup ?? null, at })))]);
  for (const p of ready) {
    try { rewrite(p); rewritten.push(p.file); } catch (e) { skipped.push({ file: p.file, reason: `not rewritten (${why(e)}): left as it was` }); }
  }
  return { rewritten, skipped, journal: journalPath(appHome) };
}

/**
 * The way back, for a release whose own hook code doesn't know the stable entry point (v0.3 and
 * older would otherwise add a second hook beside it). Each journalled command goes back to what
 * it was, and a command still exactly this app home's stable one (written since by a Start or a
 * worker) goes back to v0.3's path, and so does this pack's own direct command (directHookCommand,
 * written when the entry point couldn't be placed), but only where the file still holds it: every other key, and
 * a command changed since, stays. Entries done, or no longer applicable, leave the journal; the
 * backups stay for manual recovery. Returns `{ restored: string[], skipped: {file, reason}[] }`.
 */
export function revertHooks(projects, { appHome, git = runGit, also = [], log } = {}) {
  appHome = resolve(appHome);
  const restored = [];
  const skipped = [];
  const entries = readJournal(appHome);
  const byFile = new Map();
  for (const e of entries) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
  const files = new Set(byFile.keys());
  for (const folder of foldersOf(projects, { git, also, log })) files.add(resolve(join(folder, ".claude", SETTINGS)));
  const stable = hookCommand(appHome);
  const direct = directHookCommand(appHome);
  const legacy = legacyHookCommand(appHome);
  const keep = [];
  for (const file of files) {
    const mine = [...(byFile.get(file) ?? [])];
    const found = settingsPath(file) ? settingsOf(dirname(dirname(file))) : null;
    if (!found) continue; // gone: nothing to restore, its entries leave the journal
    if (found.skip) { if (mine.length) { skipped.push({ file, reason: found.skip }); keep.push(...mine); } continue; }
    let raw;
    try { raw = readFileSync(file); } catch (e) { skipped.push({ file, reason: `unreadable (${why(e)})` }); keep.push(...mine); continue; }
    const pending = [...mine];
    const r = retargetHooks(raw.toString("utf8"), (command) => {
      const i = pending.findIndex((e) => e.after === command);
      if (i >= 0) return pending.splice(i, 1)[0].before;
      return command === stable || command === direct ? legacy : null;
    });
    if (r.error) {
      if (mine.length || OURS.test(raw.toString("utf8"))) skipped.push({ file, reason: `${r.error}: left as it is` });
      keep.push(...mine);
      continue;
    }
    for (const e of pending) skipped.push({ file, reason: `no longer ${short(e.after)}: left as it is` });
    if (!r.edits.length) continue;
    try { rewrite({ file, raw, text: r.text, mode: found.mode }); restored.push(file); } catch (e) {
      skipped.push({ file, reason: `not restored (${why(e)})` });
      keep.push(...mine);
    }
  }
  if (entries.length) writeJournal(appHome, keep);
  return { restored, skipped };
}

/**
 * The pack's uninstall (the herdr.am-sidebar part): every briefing hook of this app home's pack
 * (ownHook) leaves the settings.local.json files where syncHooks looks (`projects`, their worktrees
 * and subfolders, the `also` folders). Another app home's hook and a command of another shape stay.
 * Each file is copied beside itself first (.am-backup…); one that can't be, a link, or a file that
 * isn't JSON is left and reported. Returns `{ removed: string[], skipped: {file, reason}[] }`.
 */
export function removeHooks(projects, { appHome, git = runGit, also = [], log } = {}) {
  appHome = resolve(appHome);
  const isMine = ownHook(appHome);
  const removed = [];
  const skipped = [];
  for (const folder of foldersOf(projects, { git, also, log })) {
    const found = settingsOf(folder);
    if (!found) continue;
    let raw;
    try { raw = readFileSync(found.file); } catch (e) { skipped.push({ file: found.file, reason: `unreadable (${why(e)}): left as it is` }); continue; }
    if (found.skip) { if (OURS.test(raw.toString("utf8"))) skipped.push({ file: found.file, reason: found.skip }); continue; }
    const r = withoutHooks(raw.toString("utf8"), isMine);
    if (r.error) { if (OURS.test(raw.toString("utf8"))) skipped.push({ file: found.file, reason: `${r.error}: left as it is` }); continue; }
    if (!r.removed) continue;
    try { backupOf(found.file, raw); } catch (e) { skipped.push({ file: found.file, reason: `no backup could be made (${why(e)}): left as it is` }); continue; }
    try { rewrite({ file: found.file, raw, text: r.text, mode: found.mode }); removed.push(found.file); } catch (e) {
      skipped.push({ file: found.file, reason: `not rewritten (${why(e)}): left as it was` });
    }
  }
  return { removed, skipped };
}

/**
 * The settings.local.json files, where syncHooks looks, whose UserPromptSubmit runs one of `scripts`
 * (absolute paths) through a hook of the pack's shapes, or whose hook command names one of
 * `runners` (absolute paths: a runner such as the sidebar's bin/run.sh). Reads only.
 */
export function hooksRunning(projects, { scripts = [], runners = [], git = runGit, also = [], log } = {}) {
  const want = new Set(scripts.map((s) => resolve(s)));
  const via = runners.map((r) => resolve(r));
  const found = [];
  for (const folder of foldersOf(projects, { git, also, log })) {
    const s = settingsOf(folder);
    if (!s || s.skip) continue;
    let settings;
    try { settings = JSON.parse(readFileSync(s.file, "utf8")); } catch { continue; }
    const list = isObject(settings) && isObject(settings.hooks) ? settings.hooks.UserPromptSubmit : null;
    const runs = (h) => isObject(h) && typeof h.command === "string" && (want.has(scriptOf(h.command) ?? "") || via.some((r) => h.command.includes(r)));
    if ((Array.isArray(list) ? list : []).some((g) => (Array.isArray(g?.hooks) ? g.hooks : []).some(runs))) found.push(s.file);
  }
  return found;
}

/**
 * The notice printed last after syncHooks (lines; none when nothing calls for one): every settings
 * file it rewrote, with its project; that a Claude session already running there keeps the hook it
 * loaded; and, after a move forward, how a project the pack doesn't know gets the new hook. A run
 * that crossed the rename (`hooks.crossed`, update.mjs moveHooks) always warns, even with no file
 * rewritten. install.sh, `update.mjs install|update|repair|rollback` and `automagik-herdr update` print it.
 */
export function hooksNotice(hooks) {
  const forward = hooks?.direction === "forward";
  const files = (forward ? hooks.rewritten : hooks?.direction === "back" ? hooks.restored : null) ?? [];
  if (!files.length && !(forward && hooks.crossed)) return [];
  const n = `${files.length} settings file${files.length === 1 ? "" : "s"}`;
  return [
    !files.length ? "IMPORTANT: the sidebar moved to a new folder, and no settings file's briefing hook was rewritten (the pack knew of none)."
      : forward ? `IMPORTANT: the bots' briefing hook moved to a new path in ${n}:`
        : `IMPORTANT: the bots' briefing hook went back to the older release's path in ${n}:`,
    ...files.map((f) => `  ${dirname(dirname(f))}: ${f}`),
    forward ? `A Claude session already running in ${files.length ? "those projects" : "a bot's project"} keeps the OLD hook and gets NO briefing until it is restarted. Restart the bot: am restart <bot> (or the bot row's Restart).`
      : "A Claude session already running in those projects keeps the hook it loaded until it is restarted. Restart the bot: am restart <bot> (or the bot row's Restart).",
    ...(forward ? ["Projects the pack doesn't know about were not rewritten and get no briefing. In one, run `am start <bot>` or `am attach <bot>` (either writes the new hook), or open it as a space in Herdr and run the installer again."] : []),
  ];
}

// ---- the entry point and the CLI link ----

/** The sidebar folder the entry point runs (the first of SIDEBARS with a briefing.mjs), or null. */
export const sidebarOf = (modsDir) => SIDEBARS.find((m) => existsSync(join(modsDir, m, "briefing.mjs"))) ?? null;

/**
 * Puts the sidebar folder's ENTRY_SOURCE at the stable path (atomically, only when it differs).
 * A link there, or a link for its folder, is the person's: an error, nothing written.
 * Returns true when it wrote.
 */
/** Whether `path` resolves into am's parts store ($AM_HOME, else $AUTOMAGIK_HOME, else ~/.automagik; parts.mjs amStoreOf). */
function intoAmStore(path, env = process.env) {
  const home = env.AM_HOME || env.AUTOMAGIK_HOME || join(env.HOME || homedir(), ".automagik");
  try {
    const store = realpathSync(join(home, "parts"));
    return realpathSync(path).startsWith(`${store}/`);
  } catch { return false; }
}

export function placeEntry(appHome, sidebar) {
  const body = readFileSync(join(appHome, "mods", sidebar, ENTRY_SOURCE));
  const path = stableBriefingPath(appHome);
  if (isLink(dirname(path))) throw new Error(`${dirname(path)} is a link: the hook's entry point was not placed`);
  mkdirSync(dirname(path), { recursive: true });
  const st = lstat(path);
  // The am part's link (RFC 0012): am owns the entry point once it has placed one; the pack leaves it.
  if (st?.isSymbolicLink() && intoAmStore(path)) return false;
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`${path} is a link or not a file: left as it is`);
  if (st && readFileSync(path).equals(body)) return false;
  // The owner's alone, as the ledgers beside it (RFC 0021 delivery 3): run through sh and node, never executed.
  writeAtomic(path, body, 0o600);
  return true;
}

/**
 * After an install, update or rollback: when the installed sidebar knows the stable entry point
 * (ships ENTRY_SOURCE), it is put in place and the hooks move onto it; when it doesn't, they move
 * back (revertHooks). `extra`: more folders to look in as they are (the open spaces', the bot
 * panes'); the ledger's start folders are always looked in. Throws on what stops it.
 * Returns `{ direction: "forward" | "back" | null, rewritten?, restored?, skipped }`.
 */
export function syncHooks({ modsDir, extra = [], log = () => {}, git = runGit, warnLedgers = true }) {
  const appHome = dirname(resolve(modsDir));
  tightenLedgers(appHome, { extra, git, log, warn: warnLedgers });
  const sidebar = sidebarOf(modsDir);
  if (!sidebar) return { direction: null, skipped: [] };
  const projects = knownProjects(appHome);
  const also = [...ledgerFolders(appHome), ...extra];
  const left = (s) => log(`left: ${s.file} (${s.reason})`);
  if (existsSync(join(modsDir, sidebar, ENTRY_SOURCE))) {
    if (placeEntry(appHome, sidebar)) log(`the briefing hook's entry point is ${stableBriefingPath(appHome)}`);
    const r = migrateHooks(projects, { appHome, git, also, log });
    for (const f of r.rewritten) log(`briefing hook moved to the entry point in ${f} (the original is beside it, ${basename(f)}${BACKUP_SUFFIX}…)`);
    r.skipped.forEach(left);
    return { direction: "forward", ...r };
  }
  const r = revertHooks(projects, { appHome, git, also, log });
  for (const f of r.restored) log(`briefing hook back on ${sidebar}'s own path in ${f}`);
  r.skipped.forEach(left);
  return { direction: "back", ...r };
}

/**
 * Repoints `<binDir>/automagik-herdr` at the CLI of the sidebar folder the record lists (PACK_NAME,
 * else OLD_PACK_NAME) when it is a link to either one's CLI in this app home: its bin/automagik-herdr
 * wrapper when the folder ships one (it runs the .mjs through bin/run.sh, which finds a node where
 * PATH has none; install.sh's cli_target), else bin/automagik-herdr.mjs. A link to either entry is
 * ours. A link elsewhere is the person's and stays; a file there is left with a note; no link
 * there: nothing. Returns the line to log, or null.
 */
export function relink({ binDir, modsDir, owned }) {
  const lines = [CLI_LINK, AM_LINK].map((name) => relinkOne({ binDir, modsDir, owned, name })).filter(Boolean);
  return lines.length ? lines.join("; ") : null;
}

function relinkOne({ binDir, modsDir, owned, name }) {
  const link = join(binDir, name);
  const st = lstat(link);
  const bin = (m) => join(resolve(modsDir), m, "bin");
  const entries = (m) => [join(bin(m), "automagik-herdr"), join(bin(m), "automagik-herdr.mjs")];
  const cli = (m) => entries(m).find((p) => isFile(p)) ?? null;
  if (!st) {
    // am's link, missing on an install from before it: made, for the sidebar folder the record lists.
    const made = name === AM_LINK ? SIDEBARS.find((m) => owned.has(m) && cli(m)) : null;
    if (!made) return null;
    mkdirSync(binDir, { recursive: true });
    const tmp = join(binDir, `.${name}.am-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    symlinkSync(cli(made), tmp);
    try { renameSync(tmp, link); } catch (error) { removePath(tmp, { force: true }); throw error; }
    return `linked ${link} to ${cli(made)}`;
  }
  if (!st.isSymbolicLink()) return `left ${link} alone: it is a file, not a link (remove it and run install.sh again to link ${name})`;
  const to = resolve(binDir, readlinkSync(link));
  if (!SIDEBARS.some((m) => entries(m).includes(to))) return null;
  const want = SIDEBARS.find((m) => owned.has(m) && cli(m));
  if (!want || to === cli(want)) return null;
  const tmp = join(binDir, `.${name}.am-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  symlinkSync(cli(want), tmp);
  try { renameSync(tmp, link); } catch (error) { removePath(tmp, { force: true }); throw error; }
  return `linked ${link} to ${cli(want)}`;
}
