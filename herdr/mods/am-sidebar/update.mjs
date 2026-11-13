#!/usr/bin/env node
// Installs, updates and rolls back the pack as one unit (A14, D3, D10): one release tarball holds
// every pack mod folder plus layouts/automagik.json; it is checked against the release's
// automagik-herdr-pack-<v>.tgz.sha256, each folder is built in a staging folder beside mods/ (the mod's private paths
// carried in), then renamed into place, and the folders it replaced are kept together as one
// rollback set. Only folders the ownership record lists are replaced; any other folder in mods/
// is left alone, or adopted on an explicit --adopt (moved to backup/ first, never replaced).
// Node only (the CLI, and the mod through `exec("node", [<pack>/update.mjs, "check"])`, Herdr's
// runtime having no fetch); the rules over plain data live in release.js. Apache-2.0.
//
//   node update.mjs check             [--mods <dir>]   one JSON line: current, latest, update
//   node update.mjs update [--check] [--json] [--mods <dir>]   install the latest release (apply: the same, JSON;
//                                     apply --expect <v>: only if the latest is still <v>, else `refused`).
//       After the swap it runs `herdr-app check` on every pack mod. When one fails to load it
//       restores the kept set at once (the same rollback, still under the install lock) and
//       records the bad version as rolled back, so auto-update waits for a newer release. The
//       failed release's folders are removed, never kept, so a manual rollback refuses instead of
//       reinstalling them (#671); one the removal cannot take is said in the update's warnings,
//       the restore note and the notice, with where it stays. Exit 5:
//       installed, then restored; JSON `installed.restored` names the failed and the restored
//       version and the mods that failed. A missing or unrunnable herdr-app keeps the update
//       (`installed.check.checked` false, `unavailable` says why); `installed.restoreError` says
//       why a restore could not happen (for example no previous version kept). Both are a notice,
//       never a crash.
//   node update.mjs rollback          [--mods <dir>]   swap the kept set back; one JSON line
//   node update.mjs install --from <tgz> --version <v> [--sequence <n>] [--mods <dir>] [--adopt] [--setup]
//       a tarball already checked against its .sha256 (install.sh); one JSON line. --setup also
//       merges free keys, writes the mod manager's catalog.json, places the layout (D8) and runs
//       `herdr-app check` on every installed mod (exit 3 when one fails). Exit 4: installed, but a
//       step after the swap (the record, the kept set) did not finish; its warning says where things are.
//   node update.mjs repair --from <tgz> --version <v> [--mods <dir>]
//       install.sh's same-version rerun: checks every installed pack file against that tarball,
//       reinstalls a missing or damaged folder (its damaged copy kept in backup/), puts back a
//       missing automagik layout and runs `herdr-app check` on every mod (exit 3 / 4 as above).
//
// <dir> defaults to $HERDR_APP_HOME/mods (~/.config/herdr-app/mods), never this file's own
// folder, so running it from a checkout never replaces the checkout. Everything else lives in
// <app home>/automagik-herdr/, outside mods/ (a folder left inside mods/ is loaded as a mod):
//   installed-by-install.sh   the ownership record (release.js parseMarker)
//   .prev/                    the set the last install, update or rollback replaced (.prev/.pack lists it);
//                             a restore removes the failed release's set, so it names no earlier pack
//   backup/<mod>-<date>/      a folder the person owned, moved aside on --adopt; never replaced
//   backup/layouts-<date>/    the rename migration's backups and journal (migrateHome.mjs)
//
// Across the rename (Group 6a, D12) an old-named folder the record lists hands its private paths
// to its am-* folder and leaves with the kept set; a person's own is left, or adopted on --adopt.
// After the folders, layouts and keys.json follow the renamed folders (migrateHome.mjs), and a
// rollback across the rename reverts those edits from the journal. Then the briefing hooks follow
// (Group 6b, migrateHooks.mjs): onto <app home>/automagik-herdr/briefing.mjs when the installed
// sidebar ships it, back to v0.3's path when it doesn't, and the CLI link follows the sidebar folder.
//
// Needs Node 22.7 or later: the installed pack has no package.json, so Node loads release.js
// (shared with the mod, whose loader takes .js) as ESM by detecting its syntax.

import { execFile, execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  AUTO_FILE, CATALOG_URL, CHECK_FILE, HELD_FILE, OFF_BY_DEFAULT, OLD_PACK_NAME, PACK_CATALOG_URLS, PACK_KEYS, PACK_KEYS_FILE, PACK_LAYOUT, PACK_NAME, POCKET_LINK, POINTER_SIG_URL,
  POINTER_URL, RESTORE_FILE, TIMEOUT_MS, V020_LAYOUT_SHA256, autoHold, formatAuto, formatMarker, heldModLine, layoutNeeds, packOfPointer, parseAuto, parseMarker, parseSums,
  pickUpdate, updatesOff,
} from "./release.js";
import { ABSORBED, RENAMES, editTarget, own, renamedFrom } from "./migrate.js";
import {
  apply as applyMigration, pending, plan as migrationPlan, revert as revertMigration, revertedLayouts, strandedLayouts,
} from "./migrateHome.mjs";
import { change, removePath } from "./layoutSafe.mjs";
import { foldAttach, readAttach } from "./attach.js";
import { AM_LINK, CLI_LINK, botPaneFolders, hooksNotice, openSpaces, relink, syncHooks, tightenLedgers } from "./migrateHooks.mjs";

export { CHECK_EVERY_MS, FIRST_CHECK_MS, LANE_RELEASE, NO_UPDATE_ENV, PACK_MODS, PACK_NAME, POINTER_SIG_URL, POINTER_URL, RETRY_MS, compareVersions,
  noticeText, packOfPointer, parseSums, pickUpdate, sumsName, tarballName, updatesOff } from "./release.js";
export { tightenLedgers } from "./migrateHooks.mjs";

const run = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** How long one mod's `herdr-app check` may take before the update is kept and said as unchecked. */
const CHECK_TIMEOUT_MS = 60_000;
/** The version of a pack with no VERSION file: one installed before releases, older than any. */
export const UNRELEASED = "0.0.0";

export const appHomeOf = (env = process.env) => (env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app")).replace(/\/+$/, "");
export const defaultModsDir = (env = process.env) => join(appHomeOf(env), "mods");
/** Where the record, the kept set, backups and staging live: beside mods/, on the same file system. */
export const stateDirOf = (modsDir) => join(dirname(resolve(modsDir)), "automagik-herdr");
export const prevSetOf = (modsDir) => join(stateDirOf(modsDir), ".prev");
export const markerOf = (modsDir) => join(stateDirOf(modsDir), "installed-by-install.sh");
/** Where a mod switched off waits (the mod manager's setEnabled, or `am uninstall` of one pack mod): beside mods/. */
export const offDirOf = (modsDir) => join(dirname(resolve(modsDir)), "mods-disabled");
const backupOf = (modsDir) => join(stateDirOf(modsDir), "backup");

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
/**
 * Where a folder of the record's is: mods/<m>, else mods-disabled/<m> (switched off), else null.
 * A link in mods/ is never the record's to move (a checkout), and hides an off copy.
 */
function placeOf(modsDir, m) {
  const live = join(modsDir, m), off = join(offDirOf(modsDir), m);
  if (isLink(live)) return null;
  if (exists(live)) return live;
  return exists(off) && !isLink(off) ? off : null;
}
/** A folder name the pack may own: lowercase words and dashes, never Pocket Link's. */
const packFolder = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== POCKET_LINK;
/** The other name of a renamed folder (old → am-*, am-* → old), or undefined. */
const OLD_OF = Object.fromEntries(Object.entries(RENAMES).map(([old, now]) => [now, old]));
const twinOf = (name) => (Object.hasOwn(RENAMES, name) ? RENAMES[name] : Object.hasOwn(OLD_OF, name) ? OLD_OF[name] : undefined);

/** The version a pack folder carries in its VERSION file (UNRELEASED when it has none). */
export function readVersion(packDir) {
  try { return readFileSync(join(packDir, "VERSION"), "utf8").trim() || UNRELEASED; } catch { return UNRELEASED; }
}

/** release.js HELD_FILE: this install's held mods, or no file when it holds none, so an old note never outlives its release. */
function saveHeld(modsDir, version, held) {
  const file = join(stateDirOf(modsDir), HELD_FILE);
  if (held.length === 0) { rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version, held }));
  renameSync(tmp, file);
}

/** release.js RESTORE_FILE: what the restored build says once when the build that updated is gone. */
function saveRestore(modsDir, record) {
  const file = join(stateDirOf(modsDir), RESTORE_FILE);
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
}

/** release.js CHECK_FILE: what the new build says once when herdr-app could not judge the pack. */
function saveCheck(modsDir, record) {
  const file = join(stateDirOf(modsDir), CHECK_FILE);
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
}

/** A previous update's restore or check note says nothing about this one. */
function clearNotes(modsDir) {
  for (const name of [RESTORE_FILE, CHECK_FILE]) {
    try { rmSync(join(stateDirOf(modsDir), name), { force: true }); } catch {}
  }
}

/**
 * After the migration of an install: each layout it found stranded on a renamed folder already gone
 * from mods/ (migrateHome.mjs plan `stranded`, #432) joins `installed.held`, so the update command,
 * the auto-update's notice and HELD_FILE say it as they say a held mod, then HELD_FILE is rewritten.
 * A held old folder is in `held` already (applyUpdate). A failure to save is a warning, never a failed install.
 */
export function heldAfterMigration(modsDir, installed, log = () => {}) {
  const gone = (installed.migration?.stranded ?? []).filter((s) => s.gone && !installed.held.some((h) => h.mod === s.mod));
  if (gone.length === 0) return;
  installed.held = [...installed.held, ...gone];
  for (const h of gone) log(heldModLine(h, installed.version));
  try { saveHeld(modsDir, installed.version, installed.held); } catch (error) { log(`warning: the note about held mods was not saved (${error.message})`); }
}

/** The pack's auto-update setting and rollback skip (release.js AUTO_FILE), beside the record. */
export const autoFileOf = (modsDir) => join(stateDirOf(modsDir), AUTO_FILE);
export const readAuto = (modsDir) => { try { return parseAuto(readFileSync(autoFileOf(modsDir), "utf8")); } catch { return parseAuto(""); } };

/**
 * Changes the setting (`{ on }` and/or `{ skip }`), written whole through a rename, holding the
 * lock, so a switch never races a rollback's skip. Returns it; throws `locked` while a run holds it.
 */
export function writeAuto(modsDir, patch) {
  const free = takeLock(modsDir);
  try { return writeAutoHeld(modsDir, patch); } finally { free(); }
}

/** writeAuto for a caller already holding the lock (rollback). */
function writeAutoHeld(modsDir, patch) {
  const next = { ...readAuto(modsDir), ...patch };
  mkdirSync(stateDirOf(modsDir), { recursive: true });
  const tmp = join(stateDirOf(modsDir), `.${AUTO_FILE}.${process.pid}`);
  writeFileSync(tmp, formatAuto(next));
  renameSync(tmp, autoFileOf(modsDir));
  return next;
}

/**
 * Whether the updater may replace this pack on its own: install.sh put it in place (the record,
 * v2, with `version=`) from a signed release (`sequence=`), and mods/am-sidebar is a folder, not a
 * link to a checkout. Anything else keeps today's behaviour: a notice, and an update when asked.
 */
export function managedPack(modsDir) {
  if (isLink(join(modsDir, PACK_NAME))) return { managed: false, why: `mods/${PACK_NAME} is a link to a checkout: update it with git` };
  const record = readMarker(modsDir);
  if (!record || record.v1 || !record.version) return { managed: false, why: "this pack was not installed by install.sh (no install record)" };
  if (!Number.isSafeInteger(record.sequence)) {
    return { managed: false, why: "this pack came from before signed releases: run `am update` once" };
  }
  return { managed: true, why: null };
}

/** `{ on, skip, managed, why }`: the setting and whether it applies here (autoHold reads it). */
export const autoStatus = (modsDir) => ({ ...readAuto(modsDir), ...managedPack(modsDir) });

/** An update or rollback holds this folder while it runs; one older than this was a run that died. */
export const LOCK_STALE_MS = 10 * 60_000;
export const lockOf = (modsDir) => join(stateDirOf(modsDir), "update.lock");

const LOCK_TOKEN = "owner";
const lockedError = () => Object.assign(new Error("another update or rollback is running: try again when it is done"), { locked: true });
const tokenOf = (lock) => { try { return readFileSync(join(lock, LOCK_TOKEN), "utf8"); } catch { return null; } };

/**
 * One update, install, repair or rollback at a time (the mod's, the CLI's, install.sh's): takes
 * the lock folder or throws `locked`. The folder holds this run's token; the returned function
 * removes it only while the token is still this run's, so a run whose stale lock was taken over
 * never frees the newer holder's. A stale lock is renamed aside (one taker wins the rename).
 */
export function takeLock(modsDir, now = Date.now(), hooks = {}) {
  const lock = lockOf(modsDir);
  mkdirSync(stateDirOf(modsDir), { recursive: true });
  try { mkdirSync(lock); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let age = Infinity;
    try { age = now - statSync(lock).mtimeMs; } catch {}
    if (age < LOCK_STALE_MS) throw lockedError();
    // Two runs may both find it stale: the one that moves it aside first takes it. The token tells
    // whether what was moved is the stale lock looked at, or a lock another taker made since: that
    // one goes back where it was, and this run is refused. (`hooks`: tests' interleavings.)
    const seen = tokenOf(lock);
    hooks.beforeTakeover?.();
    const aside = freshPath(stateDirOf(modsDir), ".update.lock-stale-");
    try { renameSync(lock, aside); } catch { throw lockedError(); }
    if (tokenOf(aside) !== seen) {
      try { renameSync(aside, lock); } catch {}
      throw lockedError();
    }
    removePath(aside, { recursive: true, force: true }); // a planted dangling lock link: unlinked (#566)
    hooks.beforeRetake?.();
    try { mkdirSync(lock); } catch (again) { if (again?.code === "EEXIST") throw lockedError(); throw again; }
  }
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(join(lock, LOCK_TOKEN), token);
  return () => {
    if (tokenOf(lock) !== token) return;
    const gone = freshPath(stateDirOf(modsDir), ".update.lock-free-");
    try { renameSync(lock, gone); } catch { return; }
    if (tokenOf(gone) === token) removePath(gone, { recursive: true, force: true });
    else { try { renameSync(gone, lock); } catch {} }
  };
}

/** Runs `fn` holding the lock. */
async function locked(modsDir, fn) {
  const free = takeLock(modsDir);
  try { return await fn(); } finally { free(); }
}

export const readMarker = (modsDir) => { try { return parseMarker(readFileSync(markerOf(modsDir), "utf8")); } catch { return null; } };
const readSet = (modsDir) => { try { return parseMarker(readFileSync(join(prevSetOf(modsDir), ".pack"), "utf8")); } catch { return null; } };

/**
 * The restore note (release.js RESTORE_FILE) when the last restore removed the failed release's
 * pack (#671): `{ version, failedVersion }` for the installed pack, else null. A manual rollback
 * then says why there is nothing to go back to, naming the release that did not load.
 */
function removedByRestore(modsDir) {
  let note = null;
  try { note = JSON.parse(readFileSync(join(stateDirOf(modsDir), RESTORE_FILE), "utf8")); } catch { return null; }
  if (note?.prevRemoved !== true || typeof note.failedVersion !== "string" || typeof note.version !== "string") return null;
  const installed = readMarker(modsDir)?.version ?? readVersion(join(modsDir, PACK_NAME));
  return installed === note.version ? { version: note.version, failedVersion: note.failedVersion } : null;
}

/**
 * The installed pack's version: the ownership record's, else the VERSION in the sidebar folder
 * (PACK_NAME, else its name before the rename, OLD_PACK_NAME, as a hand-installed v0.2 has it).
 */
export const installedVersion = ({ modsDir = defaultModsDir() } = {}) => readMarker(modsDir)?.version
  ?? readVersion(join(modsDir, [PACK_NAME, OLD_PACK_NAME].find((m) => isFile(join(modsDir, m, "VERSION"))) ?? PACK_NAME));

/**
 * Checks `buf` against the sha256sum line for `name` in `sums` (the release's .sha256: its text or parseSums' Map).
 * Returns the hex digest; throws when the name is missing or the digest differs.
 */
export function verifySha256(buf, sums, name) {
  const table = sums instanceof Map ? sums : parseSums(sums);
  const want = table.get(name);
  if (!want) throw new Error(`${name} is not in its .sha256: refusing it`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name} does not match its .sha256 (sha256 ${got}, expected ${want}): refusing it`);
  return got;
}

async function download(fetch, url, timeoutMs) {
  const response = await fetch(url, { headers: { "user-agent": "automagik-herdr" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The keys this pack trusts for the pointer: pack-keys.json beside this file, which the release
 * tarball carries. The installed copy is the trust anchor; a key rotation ships in a pack whose
 * pointer the old key signed.
 */
export const packKeys = (dir = dirname(fileURLToPath(import.meta.url))) => {
  try { return JSON.parse(readFileSync(join(dir, PACK_KEYS_FILE), "utf8"))?.keys ?? []; } catch { return []; }
};

/**
 * pack.json's exact `bytes` and its base64 `signature` checked against `keys` (ed25519, as
 * plugin-lane's lane.json.sig): the update it names (packOfPointer). Throws when its key is not
 * one of `keys` or the signature does not match.
 */
export function verifyPointer(bytes, signature, keys) {
  let pointer;
  try { pointer = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("the pack pointer is not JSON: refusing it"); }
  const key = (keys ?? []).find((k) => k?.keyId === pointer?.keyId);
  if (!key) throw new Error(`the pack pointer is signed by ${pointer?.keyId}, a key this pack does not trust: refusing it`);
  let ok = false;
  try { ok = verifySignature(null, Buffer.from(bytes), createPublicKey(key.publicKey), Buffer.from(String(signature ?? "").trim(), "base64")); } catch {}
  if (!ok) throw new Error("the pack pointer's signature does not match: refusing it");
  return packOfPointer(pointer);
}

/**
 * The newest pack, as the signed pointer names it (verifyPointer), or null when updates are off or
 * there is no pointer yet (404: no pack released here). Throws on any other answer, a missing
 * signature, or one that does not verify.
 */
export async function fetchPointer({ fetch = globalThis.fetch, env = process.env, keys = packKeys(), timeoutMs = TIMEOUT_MS } = {}) {
  if (updatesOff(env)) return null;
  const get = (url) => fetch(url, { headers: { "user-agent": "automagik-herdr" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const response = await get(POINTER_URL);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the pack pointer`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sig = await get(POINTER_SIG_URL);
  if (!sig.ok) throw new Error(`GitHub answered ${sig.status} for the pack pointer's signature: refusing the pointer`);
  return verifyPointer(bytes, await sig.text(), keys);
}

/** Downloads `update`'s tarball (from pickUpdate) into `dir`, checked against the sha256 the signed pointer names before it is written; returns its path. */
export async function downloadUpdate(update, { fetch = globalThis.fetch, dir, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const buf = await download(fetch, update.tarball.url, timeoutMs);
  const got = sha256(buf);
  if (got !== update.sha256) throw new Error(`${update.tarball.name} does not match the signed pointer (sha256 ${got}, expected ${update.sha256}): refusing it`);
  const target = dir ?? mkdtempSync(join(tmpdir(), "automagik-herdr-"));
  mkdirSync(target, { recursive: true });
  const path = join(target, update.tarball.name);
  writeFileSync(path, buf);
  return path;
}

/**
 * What is wrong with a tarball's entries: `names` as `tar -tzf` lists them, `lines` as `tar -tvzf`
 * does (its first character is the entry's type). Every entry must be relative, have no `..`
 * segment, be a plain file or folder, and sit in a pack folder (a lowercase name, never
 * pocket-link) or be `layouts/automagik.json`. Empty when all is well.
 */
export function unsafeEntries(names, lines) {
  if (names.length === 0) return ["the tarball is empty"];
  if (names.length !== lines.length) return ["the tarball's listing does not add up (a name with a line break?)"];
  const problems = [];
  names.forEach((name, i) => {
    const segments = name.split("/");
    const type = lines[i][0];
    if (name.startsWith("/")) problems.push(`${name}: an absolute path`);
    else if (segments.includes("..")) problems.push(`${name}: a .. segment`);
    else if (segments[0] === "layouts" ? !["layouts/", PACK_LAYOUT].includes(name) : !packFolder(segments[0]) || segments.length < 2) {
      problems.push(`${name}: outside the pack's folders`);
    } else if ((type !== "-" && type !== "d") || lines[i].includes(" link to ") || lines[i].includes(" -> ")) {
      problems.push(`${name}: not a plain file or folder`);
    }
  });
  return problems;
}

async function listEntries(tgzPath) {
  const list = async (flags) => (await run("tar", [flags, tgzPath], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n").filter((l) => l !== "");
  return unsafeEntries(await list("-tzf"), await list("-tvzf"));
}

/** Paths under `dir` (itself included) that are neither a regular file nor a folder. */
function irregularPaths(dir) {
  const found = [];
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (!stat.isFile()) found.push(path);
  };
  walk(dir);
  return found;
}

/** A mod's private paths, never the pack's to judge: dot entries, node_modules and what herdr-app writes itself. */
const privateName = (name) => name.startsWith(".") || name === "node_modules" || name === "gpui-kit.d.ts" || name === "jsconfig.json";

/**
 * Copies `from`'s private paths into `to` (a staged folder), the person's over the package's. A
 * symlinked `.state` stays a link to the same place; nothing is followed or flattened.
 */
export function carryPrivate(from, to) {
  if (!from || !exists(from) || isLink(from)) return 0;
  let carried = 0;
  for (const name of readdirSync(from)) {
    if (!privateName(name)) continue;
    const src = join(from, name), dst = join(to, name);
    removePath(dst, { recursive: true, force: true }); // a kept set's own .state may be a link, dangling too
    if (isLink(src)) symlinkSync(readlinkSync(src), dst);
    else cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    carried += 1;
  }
  return carried;
}

/** A free name under backup/: `<mod>-<date>`, then `-2`, `-3`… */
function backupName(modsDir, mod) {
  const base = `${mod}-${today()}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!exists(join(backupOf(modsDir), name))) return name;
  }
}

/**
 * Renames in order, journalled (layoutSafe.mjs change(), which `options` reach): on any failure every
 * rename already done is reversed (the old folders go back where they were) and the error is
 * thrown. `rename` is injectable for tests.
 */
function swapAll(modsDir, moves, rename, options = {}) {
  return change(dirname(resolve(modsDir)), moves.map(([from, to]) => ({ op: "move", from, to, mkdir: true })), { ...options, modsDir, rename });
}

/**
 * A name under `dir` nothing has: `<prefix><pid>-<random>`. Never an earlier run's leftover (a
 * reused pid), so nothing here deletes a folder it did not make.
 */
function freshPath(dir, prefix) {
  for (;;) {
    const path = join(dir, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
    if (!exists(path)) return path;
  }
}

/**
 * Moves the old kept set out of the way before a swap that replaces it: to `.prev-old-<pid>-<random>`,
 * renamed back by `restoreSet` when the swap fails. Null when nothing is kept yet.
 */
function setAside(modsDir) {
  if (!exists(prevSetOf(modsDir))) return null;
  const old = freshPath(stateDirOf(modsDir), ".prev-old-");
  renameSync(prevSetOf(modsDir), old);
  return old;
}
const restoreSet = (modsDir, old) => { if (old) renameSync(old, prevSetOf(modsDir)); };

/**
 * After a swap: `next` (holding the folders it moved out of mods/) becomes the kept set, then the
 * old set is removed. Never deletes `next`; a step that fails is reported in `warnings` with where
 * the folders are, so a caller never says "nothing was installed" about an install that happened.
 */
function keepSet(modsDir, next, moved, record, old, rename, warnings, off = []) {
  if (moved.length > 0) {
    try {
      // off: the folders that were switched off when kept, so a rollback puts them back off.
      writeFileSync(join(next, ".pack"), formatMarker({ version: record?.version ?? UNRELEASED, mods: moved, sequence: record?.sequence ?? null, off: off.filter((m) => moved.includes(m)) }));
      rename(next, prevSetOf(modsDir));
    } catch (error) {
      warnings.push(`the replaced folders could not become the kept set (${error.message}): they are in ${next}`);
      try { restoreSet(modsDir, old); } catch {}
      return;
    }
  }
  if (!old) return;
  try { removePath(old, { recursive: true, force: true }); } catch (error) { // a dangling .prev link too (#566)
    warnings.push(`the older kept set could not be removed (${error.message}): it is in ${old}`);
  }
}

/**
 * A restore's rollback does not keep what it rolled away from (#671): the release that failed to
 * load (`next`) and the emptied older set (`old`, or `.prev` itself when setting it aside failed)
 * are removed, so `.prev` names no earlier pack and a manual rollback has nothing to reinstall.
 * A failure is a warning naming where the folders stay; the restore itself stands.
 */
function dropSet(modsDir, next, old, warnings) {
  for (const [what, path] of [["the failed pack", next], ["the earlier kept set", old], ["the kept set", prevSetOf(modsDir)]]) {
    if (!path || !exists(path)) continue;
    try { removePath(path, { recursive: true, force: true }); } catch (error) {
      warnings.push(`${what} could not be removed (${error.message}): it is in ${path}`);
    }
  }
}

/** In a kept set: the automagik layout its pack placed (the reference copy at the swap), which a
 *  rollback puts back under the same rule as placeLayout's. Dot-named, so no set lists it. */
export const KEPT_LAYOUT = ".layout.json";
const layoutRefOf = (modsDir) => join(stateDirOf(modsDir), "automagik.json");

function keepLayout(modsDir, dir, warnings) {
  try {
    if (isFile(layoutRefOf(modsDir))) cpSync(layoutRefOf(modsDir), join(dir, KEPT_LAYOUT));
  } catch (error) { warnings.push(`the layout was not kept for a rollback (${error.message})`); }
}

/** Why the pack's layout at `live` is the person's to change (#432): it, or layouts/, is a link; else null. */
const linkedLayout = (live) => (isLink(live) ? "it is a link" : isLink(dirname(live)) ? "layouts/ is a link" : null);

/**
 * After a rollback: the rolled-to pack's layout (`body`, from its kept set) goes back in place of
 * the rolled-out pack's when the live one is still that pack's own (byte-equal to the reference),
 * or absent; one the person edited is kept (D8). The reference becomes `body` either way.
 * Returns "restored", "same", "kept", or null (no layout was kept with that set).
 */
export function restoreLayout({ modsDir, body, log = () => {} }) {
  if (!body) return null;
  const live = join(dirname(resolve(modsDir)), PACK_LAYOUT);
  const ref = layoutRefOf(modsDir);
  const had = isFile(live) ? readFileSync(live) : null;
  const lastPack = isFile(ref) ? readFileSync(ref) : null;
  let placed = "kept";
  const link = linkedLayout(live);
  if (had && had.equals(body)) placed = "same";
  else if (link && had) log(`kept your automagik layout (${live}): ${link}; the rolled-back pack's is in ${ref}`);
  else if (link) placed = "same"; // nothing behind the link: a rollback doesn't add it back
  else if (had && lastPack && had.equals(lastPack)) {
    writeFileSync(live, body);
    log(`put back the automagik layout the rolled-back pack shipped (${live})`);
    placed = "restored";
  } else if (had) log(`kept your automagik layout (${live}): you changed it; the rolled-back pack's is in ${ref}`);
  else placed = "same"; // the person removed it: a rollback doesn't add it back
  writeFileSync(ref, body);
  return placed;
}

/**
 * After a rollback to a set kept with no layout (before v0.9; #503): the pack's own automagik.json
 * (`live`) stays as the rolled-out pack placed it, and its blocks name `gone`, the mods that left.
 */
export const staleLayoutLine = (live, gone) => `left automagik.json (${live}) as the rolled-out pack placed it: the pack rolled back to kept no layout `
  + `to put back (a set kept before v0.9), and its blocks name ${gone.join(", ")}, which left mods/ in this rollback. `
  + "Herdr drops a layout whose mod is gone (plain Herdr instead): if Herdr shows it, switch layouts (ctrl-shift-l)";

export const writeMarker = (modsDir, record) => {
  const path = markerOf(modsDir);
  writeFileSync(`${path}.tmp`, formatMarker(record));
  renameSync(`${path}.tmp`, path);
};

/**
 * v0.2.x left `<OLD_PACK_NAME>.before-install` (the pack found at the first install) and
 * `<OLD_PACK_NAME>.prev` in the state folder: both move to backup/, the first recorded as adopted
 * so --uninstall puts it back.
 */
function carryV1(modsDir, record, log) {
  const state = stateDirOf(modsDir);
  for (const [old, adopted] of [[`${OLD_PACK_NAME}.before-install`, true], [`${OLD_PACK_NAME}.prev`, false]]) {
    if (!exists(join(state, old))) continue;
    const name = backupName(modsDir, `${OLD_PACK_NAME}-${adopted ? "before-install" : "v0.2-prev"}`);
    mkdirSync(backupOf(modsDir), { recursive: true });
    renameSync(join(state, old), join(backupOf(modsDir), name));
    if (adopted) record.adopted.push({ mod: OLD_PACK_NAME, path: `backup/${name}` });
    log(`kept v0.2's ${old} in ${join(backupOf(modsDir), name)}`);
  }
}

/**
 * Installs the pack in `tgzPath` (a verified release tarball) into `modsDir`, as one unit. The
 * tarball's folders must be exactly the PACK_MODS of the release.js it carries, each with main.js
 * and mod.json, plain files and folders only, and its VERSION must be `version`. Per folder:
 * not there → installed; listed in the ownership record → replaced (the old copy into the kept
 * set, its private paths carried over); anyone else's → left alone, or with `adopt` moved to
 * backup/ and replaced. A link is never replaced. A folder the record lists that the release no
 * longer ships is retired into the kept set, or held in mods/ while a layout's block names it (#420);
 * a rename's old folder is held only while a layout the migration cannot move names it (#432).
 * Returns `{ version, mods, installed, replaced, left, adopted, retired, held, prev }` and rewrites
 * the record.
 */
/**
 * Unpacks a release tarball into `staging` (an empty folder) and checks it is a plain pack: only
 * folders and plain files, its folders exactly the PACK_MODS of the release.js it carries, each with
 * main.js and mod.json, and VERSION `version`. Returns its mod folders, sorted.
 */
async function stagePack(tgzPath, version, staging) {
  const unsafe = await listEntries(resolve(tgzPath));
  if (unsafe.length > 0) throw new Error(`${tgzPath} is not a plain pack (${unsafe.slice(0, 3).join("; ")}): refusing it`);
  await run("tar", ["-xzf", resolve(tgzPath), "-C", staging]);
  const irregular = irregularPaths(staging);
  if (irregular.length > 0) throw new Error(`${tgzPath} unpacked a link or special file (${irregular[0]}): refusing it`);
  const folders = readdirSync(staging).filter((n) => n !== "layouts").sort();
  const carrier = folders.filter((n) => isFile(join(staging, n, "update.mjs")) && isFile(join(staging, n, "release.js")));
  if (carrier.length !== 1) throw new Error(`${tgzPath} holds no one folder with update.mjs and release.js: refusing it`);
  const { PACK_MODS: listed } = await import(pathToFileURL(join(staging, carrier[0], "release.js")).href);
  if (!Array.isArray(listed) || [...listed].sort().join(",") !== folders.join(",") || !listed.every(packFolder)) {
    throw new Error(`${tgzPath}'s folders (${folders.join(", ")}) are not its PACK_MODS (${listed}): refusing it`);
  }
  for (const m of folders) {
    if (!isFile(join(staging, m, "main.js")) || !isFile(join(staging, m, "mod.json"))) throw new Error(`${tgzPath}: ${m}/ has no main.js and mod.json: refusing it`);
  }
  const carried = readVersion(join(staging, carrier[0]));
  if (carried !== version) throw new Error(`${tgzPath} carries VERSION ${carried}, not ${version}: refusing it`);
  return folders;
}

/** The files under `dir` (relative paths), a mod's private paths (privateName) left out. */
function shippedFiles(dir, rel = "") {
  const found = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (rel === "" && privateName(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    if (lstatSync(join(dir, path)).isDirectory()) found.push(...shippedFiles(dir, path));
    else found.push(path);
  }
  return found;
}

/**
 * Checks an installed pack against the release tarball it came from (`tgzPath`, already checked
 * against its .sha256), changing nothing. Every pack folder the ownership record lists must hold
 * each of the release's files byte for byte (a mod's private paths and files it added are not
 * judged), and a shipped executable must still be executable. A folder the record lists that is
 * not in mods/ is missing, unless the mod manager switched it off (moved it to <app
 * home>/mods-disabled/): that stays off. A folder the record does not list (the person's own,
 * present or not) and a link are left out. Returns `{ version, missing, damaged: [{ mod,
 * files }], repair, layout }`: `repair` lists the folders to reinstall, `layout` is "missing"
 * when <app home>/layouts/automagik.json is gone, else "present".
 */
export async function verifyInstall({ tgzPath, version, modsDir = defaultModsDir() }) {
  const staging = mkdtempSync(join(tmpdir(), "automagik-herdr-verify-"));
  try {
    const folders = await stagePack(tgzPath, version, staging);
    const owned = new Set(readMarker(modsDir)?.mods ?? []);
    const disabled = offDirOf(modsDir);
    const missing = [], damaged = [];
    for (const m of folders) {
      if (m.toLowerCase() === POCKET_LINK) continue;
      const live = join(modsDir, m);
      if (isLink(live)) continue;
      if (!owned.has(m)) continue;
      if (!exists(live)) {
        if (!exists(join(disabled, m))) missing.push(m);
        continue;
      }
      const files = shippedFiles(join(staging, m)).filter((f) => {
        const at = join(live, f);
        const want = join(staging, m, f);
        if (!isFile(at) || isLink(at) || !readFileSync(at).equals(readFileSync(want))) return true;
        // A shipped executable that lost its exec bit (gaining one is harmless: install.sh chmods the command).
        return (statSync(want).mode & 0o111) !== 0 && (statSync(at).mode & 0o111) === 0;
      });
      if (files.length) damaged.push({ mod: m, files });
    }
    const layout = isFile(join(dirname(resolve(modsDir)), PACK_LAYOUT)) ? "present" : "missing";
    return { version, missing, damaged, repair: [...missing, ...damaged.map((d) => d.mod)].sort(), layout };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The pack's automagik.json in a scan of layouts/ for a mod a release retires counts only when
 * placeLayout would keep it: an unedited copy gets the release's (layoutSafe.mjs change() `exclude`).
 */
const replacedLayout = (modsDir) => {
  const ref = layoutRefOf(modsDir);
  return (name, body) => name === basename(PACK_LAYOUT) && ((b) => sha256(b) === V020_LAYOUT_SHA256 || (isFile(ref) && b.equals(readFileSync(ref))))(body());
};

export async function applyUpdate({ tgzPath, version, sequence = null, modsDir = defaultModsDir(), adopt = false, repair = null, log = () => {}, rename = renameSync }) {
  if (typeof version !== "string" || version === "") throw new Error("applyUpdate needs the release's version");
  const state = stateDirOf(modsDir);
  mkdirSync(state, { recursive: true });
  const staging = mkdtempSync(join(state, "staging-"));
  const next = freshPath(state, ".prev-next-");
  let swapped = false;
  try {
    const folders = await stagePack(tgzPath, version, staging);

    const before = readMarker(modsDir);
    if (repair && before?.version !== version) throw new Error(`the installed pack is ${before?.version ?? "not this installer's"}, not ${version}: nothing to repair`);
    const record = {
      version, mods: [], layout: before?.layout ?? null, before: before?.before ?? "none", adopted: [...(before?.adopted ?? [])],
      migrated: [...(before?.migrated ?? [])], usagemeter: before?.usagemeter ?? null,
      usagemeterSequence: before?.usagemeterSequence ?? null,
      usagemeterOn: { ...(before?.usagemeterOn ?? {}) }, usagemeterScope: before?.usagemeterScope ?? null,
      // When the pack was put in place (the mod manager's INSTALLED); a repair keeps the date.
      installed: (repair ? before?.installed : null) ?? new Date().toISOString(),
      // The signed pointer's sequence when this release came through it; a repair keeps the record's.
      sequence: sequence ?? (repair ? before?.sequence ?? null : null),
    };
    const owned = new Set(before?.mods ?? []);
    const kept = readSet(modsDir);
    const plan = { installed: [], replaced: [], renamed: [], left: [], adopted: [], retired: [], held: [], repaired: [], off: [], installedOff: [] };
    const keptOff = [];
    const leftOff = [];       // a mods-disabled/ folder the record doesn't own, where an off-by-default mod would go
    const keptBackOff = [];   // a kept copy that was off when kept, put back off
    const both = [];
    const moves = [];
    // A folder the person owns moves to backup/ (never replaced) and is recorded, so --uninstall puts it back.
    const adoptFolder = (m) => {
      const name = backupName(modsDir, m);
      moves.push([join(modsDir, m), join(backupOf(modsDir), name)]);
      plan.adopted.push({ mod: m, backup: join(backupOf(modsDir), name) });
      record.adopted.push({ mod: m, path: `backup/${name}` });
    };
    for (const m of folders) {
      const live = join(modsDir, m), fresh = join(staging, m);
      // A repair reinstalls only the folders it names; every other one the record lists stays as it
      // is, and one it doesn't list (the person's own, or one they removed) is never installed.
      if (repair && !repair.includes(m)) { if (owned.has(m)) record.mods.push(m); continue; }
      // A mod of the record's switched off (in mods-disabled/, not mods/) is updated where it is and
      // stays off: its old copy goes into the kept set like any replaced folder, never back on.
      const off = join(offDirOf(modsDir), m);
      if (owned.has(m) && !exists(live) && exists(off) && !isLink(off)) {
        carryPrivate(off, fresh);
        moves.push([off, join(next, m)], [fresh, off]);
        plan.replaced.push(m);
        plan.off.push(m);
        keptOff.push(m);
        record.mods.push(m);
        continue;
      }
      if (owned.has(m) && exists(live) && exists(off)) both.push(m);
      if (isLink(live)) {
        if (owned.has(m)) throw new Error(`${live} is a link (a checkout?): update it with git instead`);
        plan.left.push(m);
        continue;
      }
      // Retired while it was off (the kept set's off=), and shipped again: it comes back off.
      if (!repair && !exists(live) && !exists(off) && kept?.mods.includes(m) && kept.off.includes(m) && exists(join(prevSetOf(modsDir), m))) {
        carryPrivate(join(prevSetOf(modsDir), m), fresh);
        moves.push([fresh, off]);
        plan.installed.push(m);
        plan.off.push(m);
        record.mods.push(m);
        continue;
      }
      if (!exists(live)) {
        // Across the rename: the old-named folder's private paths come into its am-* folder. The
        // record's leaves with the kept set (below); a person's own is left, or adopted.
        const old = own(OLD_OF, m), oldLive = old && join(modsDir, old);
        // Into mods-disabled/ instead of mods/: a kept copy coming back (a rollback's, or one
        // --uninstall moved out) that was off when kept, or a mod that ships off arriving for the
        // first time. Never the record's own, one renamed from an old folder, or a repair. A
        // folder already in mods-disabled/ that is not the record's is left alone.
        const wasKept = Boolean(kept?.mods.includes(m));
        const startsOff = !repair && !owned.has(m) && !(old && exists(oldLive))
          && (wasKept ? kept.off.includes(m) : OFF_BY_DEFAULT.includes(m));
        if (startsOff) {
          if (exists(off) || isLink(off)) { leftOff.push(m); continue; }
          if (wasKept) carryPrivate(join(prevSetOf(modsDir), m), fresh);
          moves.push([fresh, off]);
          plan.installed.push(m);
          (wasKept ? keptBackOff : plan.installedOff).push(m);
          record.mods.push(m);
          continue;
        }
        if (old && exists(oldLive) && !isLink(oldLive)) {
          if (owned.has(old)) { carryPrivate(oldLive, fresh); plan.renamed.push([old, m]); }
          else if (adopt) { carryPrivate(oldLive, fresh); adoptFolder(old); }
          else plan.left.push(old);
        } else if (kept?.mods.includes(m)) carryPrivate(join(prevSetOf(modsDir), m), fresh);
        // (A folder a rollback or --uninstall moved into the kept set comes back with its state.)
        plan.installed.push(m);
      } else if (owned.has(m) && repair) {
        // A damaged copy of the installed release goes to backup/, never into the kept set: that
        // stays the release before, for a rollback. Not recorded as adopted: --uninstall leaves it.
        carryPrivate(live, fresh);
        const backup = join(backupOf(modsDir), backupName(modsDir, m));
        moves.push([live, backup]);
        plan.repaired.push({ mod: m, backup });
      } else if (owned.has(m)) {
        carryPrivate(live, fresh);
        moves.push([live, join(next, m)]);
        plan.replaced.push(m);
      } else if (adopt) {
        carryPrivate(live, fresh);
        adoptFolder(m);
      } else {
        plan.left.push(m);
        continue;
      }
      moves.push([fresh, live]);
      record.mods.push(m);
    }
    // A person's old-named folder beside its am-* folder (left by an earlier run without --adopt):
    // left again, or adopted now. With no am-* folder yet, the loop above decided it.
    for (const m of repair ? [] : folders) {
      const old = own(OLD_OF, m), oldLive = old && join(modsDir, old);
      if (!old || owned.has(old) || plan.left.includes(old) || plan.adopted.some((a) => a.mod === old)) continue;
      if (!exists(oldLive) || isLink(oldLive)) continue;
      if (adopt) adoptFolder(old);
      else plan.left.push(old);
    }
    // A mod another pack mod took in (migrate.js ABSORBED): the record's leaves with the
    // set (below); a person's own is left, or adopted, once the mod that took it in is shipped.
    for (const [m, into] of Object.entries(ABSORBED)) {
      const live = join(modsDir, m);
      if (owned.has(m) || !exists(live) || isLink(live) || !(folders.includes(into) || folders.includes(RENAMES[into]))) continue;
      if (adopt) adoptFolder(m);
      else plan.left.push(m);
    }
    // A folder the record lists that this release no longer ships leaves mods/ with the set, unless
    // a layout's block names it (#420): Herdr would drop that layout for plain Herdr on the next
    // launch. Then it stays in mods/, still the record's, and an update after the layout changes
    // retires it. A rename's old folder stays only while a layout the migration cannot move names
    // it (#432: a link, whose target is the person's, or a shape rewriteLayout refuses); migrateRefs
    // moves the rest onto the new name. One switched off leaves (a layout naming it shows plain
    // Herdr already). A held mod's copy goes into the kept set too, so a rollback swaps it like any
    // folder and it stays in mods/ and the record. A repair moves none of them; a held one stays the record's.
    const retiring = [];
    for (const m of owned) {
      if (folders.includes(m) || !packFolder(m)) continue;
      const at = placeOf(modsDir, m);
      if (!at) continue;
      if (repair) { record.mods.push(m); continue; }
      const renamed = own(RENAMES, m);
      retiring.push({ mod: m, at, renamed: folders.includes(renamed) ? renamed : null });
      moves.push([at, join(next, m)]);
    }
    // Held or retired, decided by change() before the swap: a folder in mods/ (one in mods-disabled/
    // is never held) stays while a file in layouts/ names it, a rename's old one while
    // strandedLayouts finds a layout the migration cannot move onto the new name.
    const inMods = retiring.filter((r) => r.at === join(modsDir, r.mod));
    let keep = [];
    let old = null;
    const prepare = ({ held }) => {
      for (const r of retiring) {
        const h = held.find((x) => x.mod === r.mod);
        if (h) { plan.held.push(h); record.mods.push(r.mod); continue; }
        plan.retired.push(r.mod);
        if (r.at !== join(modsDir, r.mod)) keptOff.push(r.mod);
      }
      mkdirSync(modsDir, { recursive: true });
      for (const h of plan.held) cpSync(join(modsDir, h.mod), join(next, h.mod), { recursive: true, verbatimSymlinks: true });
      keep = [...plan.replaced, ...plan.retired, ...plan.held.map((h) => h.mod)];
      old = keep.length ? setAside(modsDir) : null;
    };
    try {
      const swap = swapAll(modsDir, moves, rename, {
        needed: "hold", mods: inMods.map((r) => r.mod), exclude: replacedLayout(modsDir), stranded: strandedLayouts, prepare,
        renamed: Object.fromEntries(inMods.filter((r) => r.renamed).map((r) => [r.mod, r.renamed])),
        // A mod that leaves while a layout that does not parse names it in its text: said (#489).
        unknown: "warn", log,
      });
      // A linked mods/ (#494): nothing done, prepare never ran.
      if (swap.refused) throw new Error(swap.refused);
    } catch (error) {
      restoreSet(modsDir, old);
      throw error;
    }
    swapped = true;
    // From here the new folders are live: nothing below undoes them or deletes `next`, and the
    // record is written first so it always names what mods/ holds.
    const warnings = [];
    let recorded = true;
    try { writeMarker(modsDir, record); } catch (error) { recorded = false; warnings.push(`the ownership record could not be written (${error.message})`); }
    if (before?.v1) { try { carryV1(modsDir, record, log); writeMarker(modsDir, record); } catch (error) { warnings.push(`v0.2's kept copies stay where they were (${error.message})`); } }
    // Only a note: failing to save it is said here, never a failed install (exit 4 reads as one).
    if (!repair) { try { saveHeld(modsDir, version, plan.held); } catch (error) { log(`warning: the note about held mods was not saved (${error.message})`); } }
    if (keep.length) keepLayout(modsDir, next, warnings);
    keepSet(modsDir, next, keep, before, old, rename, warnings, keptOff);
    for (const h of plan.held) log(heldModLine(h, version));
    for (const m of plan.off) log(`updated mods-disabled/${m}: it stays off`);
    for (const m of plan.installedOff) log(`installed mods-disabled/${m}: it ships off; turn it on in the Mods panel`);
    for (const m of keptBackOff) log(`installed mods-disabled/${m}: it was off when it was kept, so it stays off`);
    for (const m of leftOff) log(`left alone: mods-disabled/${m} (not installed by automagik-herdr), so ${m} was not installed`);
    for (const m of both) log(`warning: mods/${m} and mods-disabled/${m} both exist: mods/${m} was updated, the switched-off copy is left as it is`);
    for (const m of plan.left) {
      const why = Object.hasOwn(ABSORBED, m) ? "the pack's sidebar or Markdown mod does its job now" : "--adopt moves it to backup/ and installs the pack's";
      log(`left alone: mods/${m} (not installed by automagik-herdr; ${why})`);
    }
    for (const a of plan.adopted) log(`adopted mods/${a.mod}: the original is kept in ${a.backup}`);
    for (const r of plan.repaired) log(`repaired mods/${r.mod}: reinstalled ${version}; the damaged copy is kept in ${r.backup}`);
    for (const m of repair ? plan.installed : []) log(`repaired mods/${m}: it was missing; installed ${version}`);
    for (const w of warnings) log(`warning: ${w}`);
    tightenLedgers(dirname(resolve(modsDir)), { log });
    return { version, mods: record.mods, ...plan, prev: keep.length && !exists(next) ? prevSetOf(modsDir) : null, recorded, warnings };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!swapped) rmSync(next, { recursive: true, force: true });
  }
}

/**
 * Swaps the kept set back in: every folder of the current set leaves mods/ for the new kept set,
 * every folder of the kept one comes back (private paths carried over), so a second rollback
 * undoes the first. Refuses, changing nothing, when a folder in the way is not the record's.
 */
export function rollback(opts = {}) {
  const modsDir = opts.modsDir ?? defaultModsDir();
  const free = takeLock(modsDir);
  try { return rollbackLocked({ ...opts, modsDir }); } finally { free(); }
}

function rollbackLocked({ modsDir, rename = renameSync, log = () => {}, binDir = null, window = false, restore = false }) {
  const set = readSet(modsDir);
  const prev = prevSetOf(modsDir);
  if (!set || set.mods.length === 0) {
    const removed = removedByRestore(modsDir);
    throw new Error(removed
      ? `no earlier pack kept: ${removed.failedVersion} was removed after it failed to load, so ${removed.version} is the installed pack`
      : `no earlier pack kept at ${prev}: nothing to roll back to`);
  }
  const record = readMarker(modsDir) ?? { version: UNRELEASED, mods: [], layout: null, before: "none", adopted: [] };
  const owned = new Set(record.mods);
  // The layout the kept set's pack placed, read before the set moves (null: kept before v0.9).
  let keptLayout = null;
  try { if (isFile(join(prev, KEPT_LAYOUT))) keptLayout = readFileSync(join(prev, KEPT_LAYOUT)); } catch {}
  const next = freshPath(stateDirOf(modsDir), ".prev-next-");
  const moves = [];
  const out = [];
  // Private paths carried into the kept set, once the layouts allow the rollback (change()'s prepare).
  const carries = [];
  for (const m of set.mods) {
    const live = join(modsDir, m);
    if (!packFolder(m) || !exists(join(prev, m))) throw new Error(`the kept set lists ${m}, which is not there: nothing rolled back`);
    if (isLink(live)) throw new Error(`${live} is a link (a checkout?): roll it back with git instead`);
    if (exists(live) && !owned.has(m)) throw new Error(`mods/${m} is not this installer's: nothing rolled back`);
    const offNow = join(offDirOf(modsDir), m);
    if (!exists(live) && set.off.includes(m) && exists(offNow) && !owned.has(m)) throw new Error(`mods-disabled/${m} is not this installer's: nothing rolled back`);
  }
  const outOff = [];
  for (const m of set.mods) {
    const live = join(modsDir, m);
    const off = join(offDirOf(modsDir), m);
    if (exists(live)) {
      carries.push([live, join(prev, m)]);
      moves.push([live, join(next, m)]);
      out.push(m);
    } else if (owned.has(m) && exists(off) && !isLink(off)) {
      // Switched off: the kept copy comes back where it is, still off.
      carries.push([off, join(prev, m)]);
      moves.push([off, join(next, m)], [join(prev, m), off]);
      out.push(m);
      outOff.push(m);
      continue;
    } else if (set.off.includes(m)) {
      // Not here now (a release retired it, or this set is older than it), and it was off when
      // kept: it comes back off.
      moves.push([join(prev, m), off]);
      continue;
    } else {
      // Across the rename: the live twin's private paths go back with it (it leaves below).
      const twin = twinOf(m), twinLive = twin && join(modsDir, twin);
      if (twin && owned.has(twin) && !set.mods.includes(twin) && exists(twinLive) && !isLink(twinLive)) carries.push([twinLive, join(prev, m)]);
    }
    moves.push([join(prev, m), live]);
  }
  for (const m of owned) {
    if (set.mods.includes(m) || !packFolder(m)) continue;
    const at = placeOf(modsDir, m);
    if (!at) continue;
    moves.push([at, join(next, m)]);
    out.push(m);
    if (at !== join(modsDir, m)) outOff.push(m);
  }
  // The version rolled away from is never installed on its own again (auto-update waits for a
  // newer one). Recorded before the swap: a run that dies after it still leaves the skip; one
  // whose swap fails leaves that version installed, where the skip changes nothing.
  const recordSkip = () => {
    if (!/^\d+\.\d+\.\d+$/.test(record.version ?? "") || record.version === UNRELEASED) return;
    try { writeAutoHeld(modsDir, { skip: record.version }); } catch (error) {
      throw new Error(`the rollback could not be recorded in ${autoFileOf(modsDir)} (${error.message}): nothing rolled back`);
    }
  };
  // The kept set's folders come back out of `prev`, which then holds only what stays behind
  // (.pack and anything unlisted): it is set aside, and removed only once the swap stands.
  // Herdr is not asked (#488): a mod the rolled-to set lacks leaves mods/ only while no file in
  // layouts/ names it, else nothing is rolled back (the skip, the private paths: none written).
  // The pack's own unedited layout (the reference copy) does not count: restoreLayout gives it the
  // kept set's, or, for a set kept before v0.9 (no layout kept), leaves it as the pack's own (a gap
  // this guard does not close). An edited one counts. A layout that does not read is said, and the
  // rollback goes on (fail open).
  // Each layout is judged as it reads once revertRefs (below) has undone the migration's edits
  // whose mod leaves: its `due`, worked out from the moves before they are done (a folder put
  // back from backup/ counted as there, so fewer edits are undone, never more).
  const packLayout = join(dirname(resolve(modsDir)), PACK_LAYOUT);
  const after = new Set(exists(modsDir) ? readdirSync(modsDir) : []);
  for (const [from, to] of moves) {
    if (dirname(resolve(from)) === resolve(modsDir)) after.delete(basename(from));
    if (dirname(resolve(to)) === resolve(modsDir)) after.add(basename(to));
  }
  for (const a of record.adopted) after.add(a.mod);
  const leaving = (mod) => out.includes(mod) && !set.mods.includes(mod);
  const due = (edit) => { const mod = editTarget(edit); return !mod || leaving(mod) || !after.has(mod); };
  let afterRevert = new Map();
  try {
    const journals = [...(record.migrated ?? [])].reverse().map((p) => join(stateDirOf(modsDir), p));
    afterRevert = revertedLayouts(journals, { home: dirname(resolve(modsDir)), due });
  } catch {}
  const exclude = (name, body, mod) => {
    const view = afterRevert.get(join(dirname(resolve(modsDir)), "layouts", name));
    if (view && mod && !layoutNeeds(view).blocks.has(mod)) return true;
    if (name !== basename(PACK_LAYOUT) || linkedLayout(packLayout) || !isFile(layoutRefOf(modsDir))) return false;
    const had = body();
    return !(keptLayout && had.equals(keptLayout)) && had.equals(readFileSync(layoutRefOf(modsDir)));
  };
  const prepare = () => {
    recordSkip();
    for (const [from, to] of carries) carryPrivate(from, to);
  };
  // That gap, said (#503): with no layout kept, the pack's own unedited automagik.json (which the
  // guard above leaves out) stays as the rolled-out pack placed it. Read here, before the swap.
  let staleLayout = false;
  try {
    staleLayout = !keptLayout && isFile(packLayout) && !linkedLayout(packLayout) && isFile(layoutRefOf(modsDir))
      && readFileSync(packLayout).equals(readFileSync(layoutRefOf(modsDir)));
  } catch {}
  try {
    const r = swapAll(modsDir, moves, rename, { needed: "refuse", unknown: "warn", then: "roll back", exclude, prepare, log });
    if (r.refused) throw new Error(`nothing rolled back: ${r.refused}`);
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
  const warnings = [];
  // A folder the person had, adopted into backup/, comes back where mods/ is free once this
  // rollback drops the pack's copy of it (Group 3, D10): its own name or its renamed twin left
  // mods/; a mod the pack absorbed comes back when the set rolled back to has no am-* mod that
  // absorbed it (am-sidebar, am-markdown). Decided from the pack's sets only, never from a
  // person's folder that shares a name.
  const left = new Set(out);
  const dropped = (m) => {
    const into = own(ABSORBED, m);
    if (into) return !set.mods.includes(own(RENAMES, into) ?? into);
    const copies = [m, twinOf(m)].filter(Boolean);
    return copies.some((c) => left.has(c)) && !copies.some((c) => set.mods.includes(c));
  };
  const adopted = [];
  for (const a of record.adopted) {
    const from = join(stateDirOf(modsDir), a.path), to = join(modsDir, a.mod);
    if (exists(to) || !exists(from) || isLink(from) || !dropped(a.mod)) { adopted.push(a); continue; }
    try {
      const r = change(dirname(resolve(modsDir)), [{ op: "move", from, to }]);
      if (r.refused) throw new Error(r.refused);
      log(`put back mods/${a.mod} from ${a.path}`);
    } catch (error) {
      warnings.push(`mods/${a.mod} stays in ${from} (${error.message})`);
      adopted.push(a);
    }
  }
  try { writeMarker(modsDir, { ...record, version: set.version ?? UNRELEASED, mods: set.mods, adopted, installed: new Date().toISOString(), sequence: set.sequence ?? null }); } catch (error) { warnings.push(`the ownership record could not be written (${error.message})`); }
  let old = null;
  try { old = setAside(modsDir); } catch (error) { warnings.push(`the old kept set stays in ${prev} (${error.message})`); }
  if (restore) {
    // The set rolled out is the release that just failed to load (#671): it is removed, never kept
    // as the next rollback target, so a manual rollback refuses instead of putting it back.
    dropSet(modsDir, next, old, warnings);
  } else {
    // The rolled-out pack's layout goes with its folders, so a second rollback brings it back.
    if (out.length && exists(next)) keepLayout(modsDir, next, warnings);
    if (old || !exists(prev)) keepSet(modsDir, next, out, record, old, rename, warnings, outOff);
    else warnings.push(`the folders rolled out are in ${next}`);
  }
  let layout = null;
  try { layout = restoreLayout({ modsDir, body: keptLayout, log }); } catch (error) { warnings.push(`the automagik layout was not put back (${error.message})`); }
  // The migration's edits whose mod left mods/ in this rollback are reverted from the journals
  // (an edit to a mod still installed stays); then the references follow the folders now in
  // place (forward again, they move again).
  const reverted = revertRefs({ modsDir, log, warnings, left: (mod) => left.has(mod) && !set.mods.includes(mod) });
  const migration = migrateRefs({ modsDir, log, warnings });
  const hooks = moveHooks({ modsDir, log, warnings, binDir, window });
  // #503: the layout no kept set replaced still names the mods this rollback took out of mods/.
  if (staleLayout) {
    try {
      const gone = [...layoutNeeds(JSON.parse(readFileSync(packLayout, "utf8"))).blocks]
        .filter((m) => left.has(m) && !set.mods.includes(m) && !exists(join(modsDir, m))).sort();
      if (gone.length) log(staleLayoutLine(packLayout, gone));
    } catch {}
  }
  return { pack: modsDir, prev, mods: set.mods, version: set.version, from: record.version ?? null, layout, reverted: reverted.restored, migration, hooks, warnings };
}

/**
 * The rename migration after the folders (Group 6a): layouts and keys.json follow the folders
 * the record says were renamed, each rewritten file backed up into backup/layouts-<date>/ with a
 * journal the record lists (`migrated=`). A failure is a warning: the folders are already in place.
 * A drop-in it holds back (Herdr's block placed more than once, #387) is said on every run.
 * Returns migrateHome's `{ done, skipped, journal }` and `held`, or null when it failed.
 */
export function migrateRefs({ modsDir, log = () => {}, warnings = [] }) {
  const home = dirname(resolve(modsDir));
  try {
    const p = migrationPlan(home);
    for (const h of p.held) log(`left: ${h.item} (${h.reason})`);
    if (!pending(p)) {
      const kept = p.left.length ? `; ${p.left.length} reference(s) stay as they are (--adopt takes the mods you kept)` : "";
      log(`rename migration: nothing to migrate${kept}`);
      return { done: [], skipped: p.left, journal: null, held: p.held, stranded: p.stranded };
    }
    if (p.shared.length) log(`shared keys move to am.* when their mod next loads: ${p.shared.map(([o]) => o).join(", ")}`);
    // The journal goes into the record before the first rewrite, so a rollback reverts whatever
    // was rewritten even if the run stops part-way; without a record, nothing is rewritten.
    const onJournal = (dir) => {
      const record = readMarker(modsDir);
      if (!record) throw new Error("there is no ownership record to list the journal in");
      writeMarker(modsDir, { ...record, migrated: [...record.migrated, `backup/${basename(dir)}`] });
    };
    const r = applyMigration(p, { backupDir: join(backupOf(modsDir), backupName(modsDir, "layouts")), onJournal });
    for (const line of r.done) log(line);
    for (const s of r.skipped) log(`left: ${s.item} (${s.reason})`);
    return { ...r, held: p.held, stranded: p.stranded };
  } catch (error) {
    warnings.push(`layouts and keys were not migrated to the new names (${error.message}); the backups so far are in ${backupOf(modsDir)}`);
    return null;
  }
}

/**
 * Reverts, newest journal first, every edit the record's journals list whose mod is no longer in
 * mods/ or whose pack copy `left` this rollback (an edit pointing at a mod the pack still
 * installs stays valid and stays); a journal with nothing
 * left leaves the record's `migrated=` (its backups stay).
 */
export function revertRefs({ modsDir, log = () => {}, warnings = [], left = () => false }) {
  const record = readMarker(modsDir);
  const restored = [];
  // `left(mod)`: the pack's copy of that mod left mods/ in this rollback (a person's own may be back).
  const gone = (edit) => { const mod = editTarget(edit); return !mod || left(mod) || !exists(join(modsDir, mod)); };
  try {
    const still = [];
    for (const path of [...(record?.migrated ?? [])].reverse()) {
      const r = revertMigration(join(stateDirOf(modsDir), path), { due: gone });
      restored.push(...r.restored);
      if (r.remaining) still.unshift(path);
      for (const f of r.restored) log(`restored the old names in ${f}`);
      for (const s of r.skipped) log(`left: ${s.item} (${s.reason})`);
    }
    if (record && still.length !== record.migrated.length) writeMarker(modsDir, { ...record, migrated: still });
  } catch (error) {
    warnings.push(`the rename migration was not reverted (${error.message}); the originals are in ${backupOf(modsDir)}/layouts-*`);
  }
  return { restored };
}

/** Where install.sh links the CLI: $HOME/.local/bin. */
export const binDirOf = (env = process.env) => join(env.HOME || homedir(), ".local", "bin");
/**
 * Whether a run crossed the rename: `before` is oldSidebarHere(modsDir) taken before it, and the
 * sidebar's folder from before the rename (OLD_PACK_NAME) is gone from mods/ now.
 */
export const oldSidebarHere = (modsDir) => exists(join(modsDir, OLD_PACK_NAME)) && !exists(join(modsDir, PACK_NAME));
export const crossedRename = (modsDir, before) => before && !oldSidebarHere(modsDir);

/** Whether `modsDir` is in the app home Herdr runs by default: only then are the open spaces asked for. */
export const liveHome = (modsDir) => dirname(resolve(modsDir)) === join(homedir(), ".config", "herdr-app");

/**
 * The briefing hooks and the CLI link after the folders and references (Group 6b, migrateHooks.mjs
 * syncHooks and relink). `binDir`: the folder holding the CLI link (null: the link is not looked at);
 * `window`: also the open spaces' and the bot panes' folders (`herdr-app ls`, `hc`). A failure is a warning.
 * `crossed`: this run moved the sidebar off its folder from before the rename (crossedRename), so
 * the hooks notice warns even when no settings file was rewritten.
 * Returns `{ hooks, link }` (hooks: syncHooks's result plus `crossed`, or null; link: the line logged or null).
 */
export function moveHooks({ modsDir, log = () => {}, warnings = [], binDir = null, window = false, crossed = false, warnLedgers = true }) {
  let hooks = null;
  let link = null;
  try { hooks = { ...syncHooks({ modsDir, extra: window ? [...openSpaces(), ...botPaneFolders()] : [], log, warnLedgers }), crossed }; } catch (error) {
    const said = `the briefing hooks were not moved (${error.message}); each rewritten settings.local.json has its backup beside it`;
    warnings.push(said);
    log(`warning: ${said}`);
  }
  if (binDir) {
    try {
      link = relink({ binDir, modsDir, owned: new Set(readMarker(modsDir)?.mods ?? []) });
      if (link) log(link);
    } catch (error) { warnings.push(`${join(binDir, CLI_LINK)} was not repointed (${error.message})`); }
  }
  return { hooks, link };
}

/** A keys.json that will not parse stops the run before any folder moves. */
export function preflightKeys(appHome) {
  const path = join(appHome, "keys.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch (error) {
    throw new Error(`${path} is unreadable (${error.message}): nothing was installed`);
  }
}

/**
 * keys.json rewritten as `keys`: written beside it under a fresh name, created exclusively (never
 * through a planted file or link), then renamed over it through layoutSafe.mjs change(), as
 * migrateHome.mjs writes it; a leftover is removed with removePath (never followed).
 */
export function writeKeys(appHome, keys) {
  const path = join(appHome, "keys.json");
  const keysTmp = `${path}.am-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(keysTmp, `${JSON.stringify(keys, null, 2)}\n`, { flag: "wx" });
  try {
    const r = change(appHome, [{ op: "replace", from: keysTmp, to: path }]);
    if (r.refused) throw new Error(r.refused);
  } catch (error) {
    removePath(keysTmp, { force: true });
    throw error;
  }
}

/** Merge free pack shortcuts only after Herdr has initialized its native key file. */
export function mergePackKeys(appHome, log = () => {}) {
  const keysPath = join(appHome, "keys.json");
  // A linked keys.json is the person's own file (dotfiles): left as it is, as parts.mjs dropKeys
  // and migrateHome.mjs leave it, never written through.
  if (isLink(keysPath)) {
    const wanted = Object.entries(PACK_KEYS).flatMap(([section, entries]) => Object.entries(entries).map(([key, action]) => `${key} → ${action} (${section})`));
    log(`keys.json (${keysPath}) is a link, your own file: left as it is; add ${wanted.join(", ")} there yourself.`);
    return 0;
  }
  // Herdr creates its default bindings only when this file is absent. A pack-only
  // file here would suppress terminal paste and every other native shortcut.
  if (!existsSync(keysPath)) {
    log("Open Herdr once, then rerun the installer to add the pack's shortcuts; keys.json was left for Herdr to initialize.");
    return 0;
  }
  const mine = JSON.parse(readFileSync(keysPath, "utf8"));
  let added = 0;
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) {
      const current = mine[section]?.[key];
      if (current === undefined) { (mine[section] ??= {})[key] = action; added += 1; log(`key + ${key} → ${action} (${section})`); }
      else if (current !== action) log(`key = ${key} stays ${current} (${section})`);
    }
  }
  if (added) writeKeys(appHome, mine);
  return added;
}

/**
 * install.sh's part after the folders land: free keys only (after native initialization),
 * the mod manager's catalog.json, the layout (added when absent; replaced only when byte-identical
 * to v0.2.x's or to the last pack's, D8; otherwise kept with a note) and `herdr-app check` on
 * every installed mod. Returns the mods whose check failed.
 */
export function setupHome({ modsDir, tgzDir, record, log = () => {}, herdrApp = "herdr-app" }) {
  const appHome = dirname(resolve(modsDir));
  mergePackKeys(appHome, log);
  // The mod manager's catalog: it reads data/am-mods/catalog.json, then the one in its data folder
  // from before the rename (core.js catalogUrl). Each one there that still holds a URL the pack
  // wrote gets the current one; a URL the person set, a file it can't read or a link stays theirs.
  // With neither, the pack's goes in data/am-mods/. An absolute path whose file is gone is only
  // noted, never rewritten: it may be an unmounted volume or a moved checkout, and core.js
  // falls back to the published index until it is back.
  const catalogs = ["am-mods", renamedFrom(RENAMES, "am-mods")].map((d) => join(appHome, "data", d, "catalog.json"));
  for (const file of catalogs.filter(exists)) {
    let url = null, gone = false;
    try {
      if (isLink(file)) url = "(a link)";
      else {
        url = JSON.parse(readFileSync(file, "utf8"))?.url ?? null;
        gone = typeof url === "string" && url.startsWith("/") && !existsSync(url);
      }
    } catch { url = "(unreadable)"; }
    if (gone) log(`your mod manager catalog ${url} is missing; the mod manager uses the published index until it is back`);
    else if (url && !PACK_CATALOG_URLS.includes(url)) log(`kept your mod manager catalog (${url}) in ${file}`);
    else if (url !== CATALOG_URL) writeFileSync(file, JSON.stringify({ url: CATALOG_URL }, null, 2) + "\n");
  }
  if (!catalogs.some(exists)) {
    mkdirSync(dirname(catalogs[0]), { recursive: true });
    writeFileSync(catalogs[0], JSON.stringify({ url: CATALOG_URL }, null, 2) + "\n");
  }

  placeLayout({ modsDir, tgzDir, record, log });
  return checkMods({ modsDir, mods: toCheck(modsDir, record.mods), log, herdrApp }).failed;
}

/**
 * The pack's layout (D8): added when absent; replaced only when byte-identical to v0.2.x's or to
 * the last pack's; otherwise kept with a note. Records it and keeps the pack's copy as the
 * reference. Returns "added", "replaced", "kept", "same", "removed" (the record says the person
 * uninstalled it: `layout=removed`, left out) or null (the tarball has none).
 */
export function placeLayout({ modsDir, tgzDir, record, log = () => {} }) {
  const appHome = dirname(resolve(modsDir));
  const shipped = join(tgzDir, PACK_LAYOUT);
  const ref = join(stateDirOf(modsDir), "automagik.json");
  const live = join(appHome, PACK_LAYOUT);
  let placed = null;
  if (isFile(shipped)) {
    const body = readFileSync(shipped);
    const had = isFile(live) ? readFileSync(live) : null;
    const lastPack = isFile(ref) ? readFileSync(ref) : null;
    const link = linkedLayout(live);
    if (link) {
      // A link's target is the person's, whatever it holds (#432): kept, even byte-equal to a pack's.
      log(had ? `kept your automagik layout (${live}): ${link}; the pack's is in ${ref}`
        : `left out the automagik layout (${live}): ${link}; the pack's is in ${ref}`);
      placed = "kept";
    } else if (!had && record.layout === "removed") {
      // Uninstalled on its own (the herdr.layout part): an update or a repair never adds it back.
      log(`left out the automagik layout: it was uninstalled (\`am install herdr.layout\` puts it back)`);
      placed = "removed";
    } else if (!had || sha256(had) === V020_LAYOUT_SHA256 || (lastPack && had.equals(lastPack))) {
      placed = "same";
      if (!had || !had.equals(body)) {
        mkdirSync(dirname(live), { recursive: true });
        writeFileSync(live, body);
        log(had ? `replaced the automagik layout (${live}): it was the one an older release shipped` : `added the automagik layout (${live})`);
        placed = had ? "replaced" : "added";
      }
    } else {
      log(`kept your automagik layout (${live}): it differs from the one v0.2 shipped; the pack's is in ${ref}`);
      placed = "kept";
    }
    if (placed !== "removed") record.layout = (!had && !link) || record.layout === "added" ? "added" : "kept";
    writeFileSync(ref, body);
    writeMarker(modsDir, record);
  }
  return placed;
}

/**
 * `herdr-app check` on each of `mods`, its whole output shown on a failure. Returns `{ failed,
 * checked, unavailable }`: the mods whose check failed, whether the check ran at all, and why it
 * could not run (herdr-app not on PATH, or the program could not start or finish: a spawn error,
 * not a mod that failed to load). `checked` false means no mod was judged.
 */
/**
 * The record's mods `herdr-app check` should load: all but the ones switched off (in
 * mods-disabled/ and not in mods/, as a mod that ships off starts). A mod missing from both stays
 * in the list, so its check fails and the setup says so, instead of passing it over.
 */
export const toCheck = (modsDir, mods) => mods.filter((m) => exists(join(modsDir, m)) || !exists(join(offDirOf(modsDir), m)));

export function checkMods({ modsDir, mods, log = () => {}, herdrApp = "herdr-app" }) {
  const failed = [];
  let haveHerdr = true;
  let unavailable = null;
  for (const m of mods) {
    if (!haveHerdr) break;
    try {
      execFileSync(herdrApp, ["check", join(modsDir, m)], { stdio: "pipe", timeout: CHECK_TIMEOUT_MS });
      log(`check passed: ${m}`);
    } catch (error) {
      // A check that ran and said no: the mod does not load (a non-zero exit, its output shown).
      if (typeof error.status === "number") {
        failed.push(m);
        const [first, ...rest] = String(error.stderr || error.stdout || error.message).trim().split("\n");
        log(`check FAILED: ${m}: ${first}`);
        for (const line of rest) log(`    ${line}`);
        continue;
      }
      // The check itself could not run: herdr-app missing, unreadable, killed or timed out. No mod
      // was judged, so an update must not restore on this.
      haveHerdr = false;
      unavailable = error.code === "ENOENT" ? "herdr-app is not on PATH"
        : `the herdr-app check could not run (${String(error.message).split("\n")[0]})`;
      log(`${unavailable}: no mod was checked`);
      break;
    }
  }
  return { failed, checked: haveHerdr && mods.length > 0, unavailable };
}

/**
 * Points the CLI link at the entry the installed pack has: bin/automagik-herdr (it runs the .mjs
 * through bin/run.sh, which finds node 22.7+ or bun where PATH has none) or, in a pack from before
 * it (a rollback), bin/automagik-herdr.mjs. Only a link to one of those two in this pack, or in
 * the sidebar's folder from before the rename (OLD_PACK_NAME: a v0.4.x link the migration didn't
 * move), is ours; one from the old folder moves only onto an entry that is there. A file or a link
 * pointing elsewhere is left alone. A missing link is left alone too, except am's: made at any
 * start while the install record lists the pack (a pack with no record gets none; a link the person removed comes back, by design: the pack owns it while am is absent). Cheap (an lstat, a readlink)
 * and idempotent: the CLI runs it on every start. Returns `{ link, from, to }` when it
 * repointed the link, else null; throws only when the swap itself fails.
 */
export function relinkCli({ modsDir = defaultModsDir(), name = PACK_NAME, binDir = binDirOf() } = {}) {
  const first = relinkNamed({ modsDir, name, binDir, linkName: CLI_LINK });
  // am, the same command under its own name, follows on the same rule; the result is the old link's.
  const am = relinkNamed({ modsDir, name, binDir, linkName: AM_LINK });
  return first ?? am;
}

function relinkNamed({ modsDir, name, binDir, linkName }) {
  if (!binDir) return null;
  const link = join(binDir, linkName);
  const entries = (m) => ["automagik-herdr", "automagik-herdr.mjs"].map((f) => join(resolve(modsDir), m, "bin", f));
  const [wrapper, mjs] = entries(name);
  if (!exists(link)) {
    // am's link, missing on an install from before it: made here, never over a file or a link of
    // the person's (that is the isLink / readlink rule below), never for a pack with no command,
    // and only for a pack the install record lists (as the rollback's relink): no record, no link.
    if (linkName !== AM_LINK || !(isFile(wrapper) || isFile(mjs))) return null;
    if (!(readMarker(modsDir)?.mods ?? []).includes(name)) return null;
    const made = isFile(wrapper) ? wrapper : mjs;
    mkdirSync(binDir, { recursive: true });
    const tmp = join(binDir, `.${linkName}.relink-${process.pid}`);
    removePath(tmp, { force: true });
    symlinkSync(made, tmp);
    try { renameSync(tmp, link); } catch (error) { removePath(tmp, { force: true }); throw error; }
    return null; // quiet: the report is for a link that moved
  }
  if (!isLink(link)) return null;
  const from = readlinkSync(link);
  const now = resolve(dirname(link), from);
  const old = name !== OLD_PACK_NAME && entries(OLD_PACK_NAME).includes(now);
  if (now !== wrapper && now !== mjs && !old) return null;
  const to = isFile(wrapper) ? wrapper : mjs;
  if (now === to || (old && !isFile(to))) return null;
  const tmp = join(binDir, `.${linkName}.relink-${process.pid}`);
  // A leftover tmp link (a killed run, the same pid since) may dangle: unlinked, never followed (#550).
  removePath(tmp, { force: true });
  symlinkSync(to, tmp);
  try { renameSync(tmp, link); } catch (error) { removePath(tmp, { force: true }); throw error; }
  return { link, from, to };
}

/**
 * `{ current, latest, update, disabled, auto }`: latest is the version the signed pointer names, or
 * null (no pack released yet); update from pickUpdate; auto from autoStatus, so the mod decides
 * from one check whether to install on its own. `keys`: the trusted keys (packKeys by default).
 */
export async function checkForUpdate({ fetch = globalThis.fetch, env = process.env, modsDir = defaultModsDir(env), keys, projectDir, hcRun } = {}) {
  const current = installedVersion({ modsDir });
  const auto = autoStatus(modsDir);
  if (updatesOff(env)) return { current, latest: null, update: null, disabled: true, auto };
  // A main bot blocked during a rollback gets the notice on a later tick (#805).
  try {
    const state = stateDirOf(modsDir);
    const restore = JSON.parse(readFileSync(join(state, RESTORE_FILE), "utf8"));
    const note = JSON.parse(readFileSync(join(state, "restore-notified.json"), "utf8"));
    if (typeof restore?.failedVersion === "string" && typeof restore?.version === "string"
      && note?.failedVersion === restore.failedVersion && Array.isArray(note.pendingBots) && note.pendingBots.length > 0) {
      notifyMainBotOfRestore({ modsDir, version: restore.failedVersion, restored: restore.version,
        failed: Array.isArray(restore.failed) ? restore.failed : [restore.mod].filter(Boolean), projectDir, hcRun });
    }
  } catch {}
  const pack = await fetchPointer({ fetch, env, ...(keys ? { keys } : {}) });
  const behind = olderSequence(readMarker(modsDir), pack);
  return { current, latest: pack?.version ?? null, update: behind ? null : pickUpdate(current, pack), disabled: false, auto,
    ...(behind ? { olderSequence: { sequence: pack.sequence, recorded: readMarker(modsDir).sequence } } : {}) };
}

/**
 * Read under the lock: why `update` is no longer one to install, or null. Another run installed it,
 * or a newer one, since the check (never the same release over itself, which would drop the
 * rollback target, and never a downgrade), or the record came through a higher sequence since.
 */
export function overtaken(modsDir, update) {
  const current = installedVersion({ modsDir });
  if (!pickUpdate(current, update)) return { current, why: `${current} is installed now` };
  const record = readMarker(modsDir);
  if (olderSequence(record, update)) return { current, why: `the pointer's sequence ${update.sequence} is below the record's ${record.sequence}` };
  return null;
}

/**
 * True when the signed pointer's sequence is below the one the install record holds (#207 L2): a
 * re-posted older pointer, whatever version it names. install.sh refuses the same; nothing installs it.
 */
export const olderSequence = (record, pack) =>
  Number.isSafeInteger(record?.sequence) && Number.isSafeInteger(pack?.sequence) && pack.sequence < record.sequence;

/**
 * check, then download, verify and apply when there is an update. `{ current, latest, update, installed }`.
 * `expect`: the version the person confirmed (the status bar's dialog). When the latest release
 * is another one by now, nothing is downloaded: `{ ..., installed: null, refused: { expected, latest } }`.
 * `auto`: the mod installing on its own. Under the lock, before any download, the setting and the
 * record are read again: when autoHold says no, or another update or rollback runs, nothing is
 * downloaded: `{ ..., installed: null, held: why }`.
 */
export async function installUpdate({ fetch = globalThis.fetch, env = process.env, modsDir = defaultModsDir(env), keys, log, binDir = null, window = false, expect = null, auto = false, herdrApp = "herdr-app", projectDir, hcRun } = {}) {
  const found = await checkForUpdate({ fetch, env, modsDir, keys, projectDir, hcRun });
  if (!found.update) return { ...found, installed: null };
  if (expect && found.update.version !== expect) return { ...found, installed: null, refused: { expected: expect, latest: found.update.version } };
  let free;
  try { free = takeLock(modsDir); } catch (error) {
    if (auto && error.locked) return { ...found, installed: null, held: error.message };
    throw error;
  }
  try {
    // Another run may have installed it, or a newer one, between the check and the lock: nothing
    // to do then (never the same release over itself, which would drop the rollback target, and
    // never a downgrade).
    const late = overtaken(modsDir, found.update);
    if (late) return { ...found, current: late.current, update: null, installed: null };
    const hold = auto ? autoHold(found.update.version, autoStatus(modsDir)) : null;
    if (hold) return { ...found, auto: autoStatus(modsDir), installed: null, held: hold };
    const done = await downloadAndApply(found, { fetch, modsDir, log, binDir, window, herdrApp, projectDir, hcRun });
    // On its own, an install whose record wasn't written is a failure: the record still names the
    // old version, and the next check would install it again. A restore has rewritten its own.
    if (auto && done.installed?.recorded === false && !done.installed?.restored) {
      throw new Error(`${found.update.version} went in, but the install record could not be written (${markerOf(modsDir)})`);
    }
    return done;
  } finally {
    free();
  }
}

/**
 * Best-effort notice to every project's running main bot, once per failed version. A bot whose
 * pane is blocked when the send is attempted is kept in `pendingBots`, so a later call (or the
 * next check tick) retries it; a notified bot is never told twice for the same version.
 */
export function notifyMainBotOfRestore({ modsDir, version, restored, failed = [], projectDir,
  hcRun = (args) => execFileSync("hc", args, { encoding: "utf8", timeout: 15000 }) }) {
  try {
    const state = stateDirOf(modsDir), file = join(state, "restore-notified.json");
    let notified = null;
    try { notified = JSON.parse(readFileSync(file, "utf8")); } catch {}
    const same = notified?.failedVersion === version;
    let notifiedBots = same && Array.isArray(notified.notifiedBots) ? [...notified.notifiedBots] : [];
    let pendingBots = same && Array.isArray(notified.pendingBots) ? [...notified.pendingBots] : [];
    // Done for this version, and none left to retry.
    if (same && (!Array.isArray(notified.pendingBots) || notified.pendingBots.length === 0)) return { sent: false };
    if (!same) { notifiedBots = []; pendingBots = []; }
    let rows = [];
    try { rows = readAttach(readFileSync(join(state, "attach.jsonl"), "utf8")).rows; } catch {}
    const bindings = foldAttach(rows);
    const dirs = [];
    const add = (dir) => {
      if (typeof dir !== "string" || dir === "") return;
      const resolved = resolve(dir);
      if (!dirs.includes(resolved)) dirs.push(resolved);
    };
    if (projectDir) add(projectDir);
    else {
      for (let dir = process.cwd();;) {
        if (existsSync(join(dir, ".herdr/bots.json"))) { add(dir); break; }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // The sidebar's project registry, then every project the attach ledger names. The registry is
    // an array, or { projects } whose entries are paths or records.
    try {
      const registry = JSON.parse(readFileSync(join(dirname(resolve(modsDir)), "am-sidebar-projects.json"), "utf8"));
      const list = Array.isArray(registry) ? registry : Array.isArray(registry?.projects) ? registry.projects : [];
      for (const item of list) add(typeof item === "string" ? item : item?.path ?? item?.dir ?? item?.key);
    } catch {}
    for (const binding of bindings.byBot.values()) add(binding?.project);
    for (const row of rows) add(row?.project);
    const text = `Automagik Herdr update ${version} failed to load (${failed.join(", ")}) and rolled back to ${restored}; no restart is needed for ${version}.`;
    for (const dir of dirs) {
      let bots;
      try { bots = JSON.parse(readFileSync(join(dir, ".herdr/bots.json"), "utf8")); } catch { continue; }
      const main = bots.bots?.find((b) => b.kind === "main");
      if (!main || notifiedBots.includes(main.id)) continue;
      // The project's own live binding first; ids are shared across a project's worktrees, so
      // hc ls alone can name another checkout's pane.
      let terminal = null;
      let blocked = false;
      const isBlocked = (state) => state?.status?.state === "blocked" || state?.status === "blocked";
      const binding = bindings.byBot.get(main.id);
      if (binding?.project === dir) {
        try {
          const get = JSON.parse(hcRun(["get", binding.terminal, "--json"]));
          if (get.state === "live" && get.created_ms === binding.created_ms) {
            terminal = binding.terminal;
            blocked = isBlocked(get);
          }
        } catch {}
      }
      if (!terminal) {
        try {
          const listed = JSON.parse(hcRun(["ls", "--label", `bot=${main.id}`, "--json"]));
          const terminals = Array.isArray(listed) ? listed : listed.terminals ?? listed.items ?? [];
          const live = terminals.filter((t) => t?.state === "live" && t.address);
          const under = (cwd) => typeof cwd === "string"
            && (resolve(cwd) === dir || resolve(cwd).startsWith(dir === "/" ? "/" : `${dir}/`));
          const chosen = live.find((t) => under(t.cwd)) ?? live[0] ?? null;
          terminal = chosen?.address ?? null;
          blocked = isBlocked(chosen);
        } catch {}
      }
      if (!terminal) continue;
      // Never type into a blocked main pane: keep it pending for the next check tick.
      if (blocked) {
        if (!pendingBots.includes(main.id)) pendingBots.push(main.id);
        continue;
      }
      try {
        hcRun(["send", terminal, text]);
        if (!notifiedBots.includes(main.id)) notifiedBots.push(main.id);
        pendingBots = pendingBots.filter((id) => id !== main.id);
      } catch {
        if (!pendingBots.includes(main.id)) pendingBots.push(main.id);
      }
    }
    pendingBots = pendingBots.filter((id) => !notifiedBots.includes(id));
    if (notifiedBots.length === 0 && pendingBots.length === 0) return { sent: false };
    mkdirSync(state, { recursive: true });
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ failedVersion: version, restoredVersion: restored, notifiedBots, pendingBots,
      botId: notifiedBots[0] ?? null, at: Date.now() }), { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, file);
    return { sent: notifiedBots.length > 0 };
  } catch { return { sent: false }; }
}

/**
 * After an update swaps the pack in: `herdr-app check` on every pack mod that is on (#652). When
 * one fails to load the kept set is restored at once (the same rollback, under the install's lock)
 * and the bad version becomes the rollback skip, so auto-update waits for a newer release. A
 * missing or unrunnable herdr-app keeps the update (`checked: false`); a restore that cannot happen
 * is said in `restoreError`, never thrown, so the update's own callers still answer. A restore's
 * own warnings (a folder it could not remove) ride back in `warnings`. `version` is the release
 * that was just installed, not the record's version: a restore rewrites that.
 */
function checkUpdated({ modsDir, mods, version, log = () => {}, herdrApp = "herdr-app", binDir = null, window = false, projectDir, hcRun }) {
  const list = toCheck(modsDir, mods);
  if (list.length === 0) return { failed: [], checked: true, unavailable: null };
  const result = checkMods({ modsDir, mods: list, log, herdrApp });
  const unavailable = result.unavailable ?? null;
  // A judged failure wins: one mod that does not load is enough to restore, even when a later
  // check could not run. Only a run with no failed mod and no complete check keeps the update.
  if (result.failed.length === 0 && !result.checked) {
    return { failed: [], checked: false, unavailable: unavailable ?? "the herdr-app check did not run" };
  }
  if (result.failed.length === 0) return { ...result, checked: true };
  const set = readSet(modsDir);
  if (!set || set.mods.length === 0) {
    log("could not restore: no previous version kept");
    try { saveRestore(modsDir, { version, error: "could not restore: no previous version kept", unavailable, at: Date.now() }); } catch {}
    return { ...result, checked: true, unavailable, restoreError: "could not restore: no previous version kept" };
  }
  // A kept set from before VERSION files (or one whose .pack has none) still names a version.
  const backVersion = typeof set.version === "string" && set.version !== ""
    ? set.version : readVersion(join(prevSetOf(modsDir), PACK_NAME));
  // Written before the swap: Herdr reloads the restored build at once, possibly before this
  // process answers, and that build says the one notice from it (updater.js `arrive`).
  try {
    saveRestore(modsDir, { version: backVersion, failedVersion: version, mod: result.failed[0],
      failed: [...result.failed], checked: true, unavailable, at: Date.now() });
  } catch (error) { log(`warning: the restore note was not saved (${error.message})`); }
  try {
    const back = rollbackLocked({ modsDir, log, binDir, window, restore: true });
    const restored = typeof back.version === "string" && back.version !== "" ? back.version : backVersion;
    // The restore removed the failed release's folders instead of keeping them (#671): the note
    // says so, so a manual rollback refuses in those words rather than reinstalling them.
    const prevRemoved = !readSet(modsDir);
    // A folder the restore could not remove is the person's to know about: it is logged here and
    // rides in the update's answer (installed.warnings) and in the note the restored build reads.
    const warnings = Array.isArray(back.warnings) ? back.warnings.filter((w) => typeof w === "string" && w !== "") : [];
    for (const warning of warnings) log(`warning: ${warning}`);
    try {
      saveRestore(modsDir, { version: restored, failedVersion: version, mod: result.failed[0],
        failed: [...result.failed], checked: true, unavailable, ...(prevRemoved ? { prevRemoved: true } : {}),
        ...(warnings.length ? { warnings } : {}), at: Date.now() });
    } catch (error) { log(`warning: the restore note was not saved (${error.message})`); }
    notifyMainBotOfRestore({ modsDir, version, restored, failed: result.failed, projectDir, hcRun });
    log(`restored ${restored}: ${result.failed.join(", ")} did not load`);
    return { ...result, checked: true, unavailable, warnings, restored: { version: restored, failedVersion: version, mod: result.failed[0],
      failed: [...result.failed], checked: true, ...(prevRemoved ? { prevRemoved: true } : {}), ...(warnings.length ? { warnings } : {}),
      ...(unavailable ? { unavailable } : {}) } };
  } catch (error) {
    // A kept set that is gone, or names a folder that is gone, is the same answer to the person:
    // there is no previous version to put back. Anything else keeps its own why.
    const why = /no earlier pack kept|nothing to roll back to|not there: nothing rolled back|kept set lists .* which is not there/.test(error.message)
      ? "no previous version kept" : error.message;
    log(`could not restore: ${why}`);
    try { saveRestore(modsDir, { version, error: `could not restore: ${why}`, unavailable, at: Date.now() }); } catch {}
    return { ...result, checked: true, unavailable, restoreError: `could not restore: ${why}` };
  }
}

async function downloadAndApply(found, { fetch, modsDir, log, binDir, window, herdrApp, projectDir, hcRun }) {
  const dir = mkdtempSync(join(tmpdir(), "automagik-herdr-"));
  try {
    const tgzPath = await downloadUpdate(found.update, { fetch, dir });
    const before = oldSidebarHere(modsDir);
    clearNotes(modsDir); // a previous update's notes are not this one's
    const installed = await applyUpdate({ tgzPath, version: found.update.version, sequence: found.update.sequence, modsDir, log });
    // The swap is the point an update becomes live: check it before anything else touches the home.
    const checked = checkUpdated({ modsDir, mods: installed.mods, version: found.update.version, log, herdrApp, binDir, window, projectDir, hcRun });
    installed.check = { failed: checked.failed, checked: checked.checked, ...(checked.unavailable ? { unavailable: checked.unavailable } : {}) };
    // A restore that could not remove what it rolled away from says where it stays (#671): the
    // warning rides with the install's own answer, as the other warnings after a swap do.
    if (checked.warnings?.length) installed.warnings.push(...checked.warnings);
    if (!checked.checked) {
      try {
        saveCheck(modsDir, { version: found.update.version, from: found.current ?? null,
          unavailable: checked.unavailable, at: Date.now() });
      } catch (error) { log(`warning: the check note was not saved (${error.message})`); }
    }
    if (checked.restored) {
      // The kept set is back and its layout and hooks with it: the release's layout and migration
      // belong to a pack that is no longer installed.
      installed.restored = checked.restored;
      return { ...found, installed };
    }
    if (checked.restoreError) installed.restoreError = checked.restoreError;
    // The release's layout, as install.sh --setup places it (D8: one the person edited is kept),
    // so an update shows what the release added to it; then the person's layouts are migrated.
    const tgzDir = join(dir, "layout");
    try {
      mkdirSync(tgzDir);
      await run("tar", ["-xzf", resolve(tgzPath), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
      installed.layout = placeLayout({ modsDir, tgzDir, record: readMarker(modsDir), log });
    } catch (error) { installed.warnings.push(`the automagik layout was not placed (${error.message})`); }
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    heldAfterMigration(modsDir, installed, log);
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, binDir, window, crossed: crossedRename(modsDir, before), warnLedgers: false });
    return { ...found, installed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * install.sh's same-version rerun: checks the installed pack against the release tarball
 * (verifyInstall), reinstalls each missing or damaged folder (applyUpdate's repair: the damaged
 * copy to backup/, the kept set untouched), puts back a missing automagik layout (placeLayout), then
 * runs `herdr-app check` on every pack mod and the rename migration (migrateRefs, with its #387
 * drop-ins). `{ version, repaired, layout, checkFailed, checked, changed, migration }`
 * (`checked` false: herdr-app is not on PATH, so no mod was checked);
 * `changed` is false only when every file matched the release and no folder or layout was put
 * back or rewritten (the layout's reference copy and the record are rewritten as on every install).
 */
export async function repairInstall({ tgzPath, version, modsDir = defaultModsDir(), log = () => {}, herdrApp = "herdr-app", window = false }) {
  preflightKeys(dirname(resolve(modsDir)));
  const found = await verifyInstall({ tgzPath, version, modsDir });
  for (const m of found.missing) log(`missing: mods/${m}`);
  for (const d of found.damaged) {
    log(`differs from the release: mods/${d.mod} (${d.files.slice(0, 5).join(", ")}${d.files.length > 5 ? `, and ${d.files.length - 5} more` : ""})`);
  }
  if (found.layout === "missing" && readMarker(modsDir)?.layout !== "removed") log(`missing: the automagik layout (${join(dirname(resolve(modsDir)), PACK_LAYOUT)})`);
  const repaired = found.repair.length ? await applyUpdate({ tgzPath, version, modsDir, repair: found.repair, log }) : null;
  const tgzDir = mkdtempSync(join(tmpdir(), "automagik-herdr-layout-"));
  try {
    await run("tar", ["-xzf", resolve(tgzPath), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
    const record = readMarker(modsDir);
    const layout = placeLayout({ modsDir, tgzDir, record, log });
    const keysAdded = mergePackKeys(dirname(resolve(modsDir)), log);
    // A mod switched off (in mods-disabled/, not mods/) has no folder here to check.
    const { failed: checkFailed, checked } = checkMods({ modsDir, mods: toCheck(modsDir, record.mods), log, herdrApp });
    const warnings = repaired?.warnings ?? [];
    // The person's layouts too, as on an install: one edited since (or kept) that still places
    // Herdr's workspace-status gets am-status (#387); a second run finds nothing to do.
    const migration = migrateRefs({ modsDir, log, warnings });
    const changed = Boolean(repaired) || layout === "added" || layout === "replaced" || Boolean(migration?.journal) || keysAdded > 0;
    // The hooks too, so a rerun moves those of a project opened (or listed) since the install.
    const hooks = moveHooks({ modsDir, log, warnings, window, warnLedgers: !repaired });
    return { version, repaired: found.repair, layout, checkFailed, checked, changed, migration, hooks, warnings };
  } finally {
    rmSync(tgzDir, { recursive: true, force: true });
  }
}

const USAGE = "usage: node update.mjs check | update [--check] [--json] | apply [--expect <v>] [--auto] | rollback | install --from <tgz> --version <v> [--sequence <n>] [--adopt] [--setup] | repair --from <tgz> --version <v> | pack-out --to <dir> [--layout <file>] [--move <folder>]...  (each takes [--mods <dir>])";
const FLAGS = {
  check: [], apply: ["--expect", "--auto"], rollback: [], update: ["--check", "--json"], install: ["--from", "--version", "--sequence", "--adopt", "--setup"],
  repair: ["--from", "--version"], "pack-out": ["--to", "--layout", "--move"],
};
const VALUED = new Set(["--mods", "--from", "--version", "--expect", "--sequence", "--to", "--layout", "--move"]);
/** Flags given more than once, collected in order. */
const REPEATED = new Set(["--move"]);

/** Strict arguments: an unknown command or flag, or a flag missing its value, is a usage error before anything is read. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const usage = () => Object.assign(new Error(USAGE), { usage: true });
  if (!Object.hasOwn(FLAGS, command)) throw usage();
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag !== "--mods" && !FLAGS[command].includes(flag)) throw usage();
    if (VALUED.has(flag)) {
      const value = rest[++i];
      if (value === undefined || value === "" || value.startsWith("-")) throw usage();
      if (REPEATED.has(flag)) (opts[flag.slice(2)] ??= []).push(value);
      else opts[flag.slice(2)] = value;
    } else opts[flag.slice(2)] = true;
  }
  if ((command === "install" || command === "repair") && !(opts.from && opts.version)) throw usage();
  if (command === "pack-out" && !opts.to) throw usage();
  if (opts.sequence !== undefined && !/^\d{1,15}$/.test(String(opts.sequence))) throw usage();
  return { command, opts };
}

/**
 * install.sh --uninstall's removals, when Node is there (#448, #450): the pack's layout file
 * (`layout`, in layouts/) and its folders (`move`, each in mods/ or mods-disabled/) leave together
 * through layoutSafe.mjs change(), journalled: one that fails undoes the rest, and a layout file
 * in a linked layouts/ (the person's folder) stays (`links: "hold-layouts"`). Each folder goes
 * to `to`/<its name>, in the pack's state folder. install.sh asked the shown layout first, in its
 * own words. Its lines: `removed <path>`, `moved <name>`, `left <path>`.
 */
export function packOut({ modsDir, to, layout = null, move = [] }) {
  const mods = resolve(modsDir), home = dirname(mods), dest = resolve(to);
  const off = join(home, "mods-disabled"), state = join(home, "automagik-herdr");
  const bad = (what) => Object.assign(new Error(`pack-out: ${what}`), { usage: true });
  if (dirname(dest) !== state || !isDir(dest)) throw bad(`--to must be a folder in ${state}`);
  if (layout && (dirname(resolve(layout)) !== join(home, "layouts") || !layout.endsWith(".json"))) throw bad(`--layout must be a .json file in ${join(home, "layouts")}`);
  for (const m of move) {
    if (![mods, off].includes(dirname(resolve(m))) || !/^[a-z0-9-]+$/.test(basename(m))) throw bad(`--move must be a pack folder in ${mods} or ${off}`);
  }
  const ops = [...(layout ? [{ op: "remove", path: resolve(layout) }] : []), ...move.map((m) => ({ op: "move", from: resolve(m), to: join(dest, basename(m)) }))];
  const r = change(home, ops, { modsDir: mods, links: "hold-layouts" });
  if (r.refused) throw new Error(r.refused);
  const lines = [...r.left.map((p) => `left ${p}`)];
  if (layout && !r.left.includes(resolve(layout))) lines.push(`removed ${resolve(layout)}`);
  for (const m of move) if (!r.left.includes(resolve(m))) lines.push(`moved ${basename(m)}`);
  return { text: lines.join("\n") };
}

async function main(argv) {
  const { command, opts } = parseArgs(argv);
  const modsDir = opts.mods ?? defaultModsDir();
  if (command === "pack-out") return packOut({ modsDir, to: opts.to, layout: opts.layout ?? null, move: opts.move ?? [] });
  const log = (line) => process.stderr.write(`${line}\n`);
  // The hooks notice, last and tagged: install.sh prints the `notice: ` lines at the end of its run.
  const notice = (hooks) => { for (const line of hooksNotice(hooks)) log(`notice: ${line}`); };
  // The CLI link and the open spaces belong to this computer's own app home; install.sh links the CLI itself.
  const host = { binDir: binDirOf(), window: liveHome(modsDir) };
  if (command === "check" || (command === "update" && opts.check)) return checkForUpdate({ modsDir });
  if (command === "apply" || command === "update") {
    const r = await installUpdate({ modsDir, log: command === "update" ? log : undefined, expect: opts.expect ?? null, auto: Boolean(opts.auto), ...host });
    // Exit 5: the release went in, herdr-app check failed and the kept set is back (its own notice).
    if (r.installed?.restored) process.exitCode = 5;
    if (command === "update") notice(r.installed?.hooks?.hooks);
    // The mod's notice says whether running Claude bots need a restart for their briefings.
    if (command === "apply") return r.installed ? { ...r, notice: hooksNotice(r.installed.hooks?.hooks) } : r;
    if (opts.json) return r;
    return { text: r.installed ? `Updated ${r.current} → ${r.installed.version}.` : `Up to date (${r.current}; latest ${r.latest ?? "none yet"}).` };
  }
  if (command === "rollback") {
    const r = rollback({ modsDir, log, ...host });
    notice(r.hooks?.hooks);
    if (r.warnings.length) process.exitCode = 4;
    return r;
  }
  if (command === "repair") {
    // Exit 3: a mod's herdr-app check failed; exit 4: a step after a swap did not finish.
    const r = await locked(modsDir, () => repairInstall({ tgzPath: opts.from, version: opts.version, modsDir, log, window: host.window }));
    notice(r.hooks?.hooks);
    if (r.warnings.length) process.exitCode = 4;
    else if (r.checkFailed.length) process.exitCode = 3;
    return r;
  }
  // install.sh: the tarball it downloaded and checked with shasum, through applyUpdate's checks.
  const appHome = dirname(resolve(modsDir));
  if (opts.setup) preflightKeys(appHome);
  const before = oldSidebarHere(modsDir);
  const installed = await locked(modsDir, () => applyUpdate({ tgzPath: opts.from, version: opts.version,
    sequence: opts.sequence === undefined ? null : Number(opts.sequence), modsDir, adopt: Boolean(opts.adopt), log }));
  const crossed = () => crossedRename(modsDir, before);
  // Exit 4: installed, but a step after the swap did not finish (its warning says what and where).
  const done = () => { if (installed.warnings.length) process.exitCode = 4; };
  if (!opts.setup) {
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    heldAfterMigration(modsDir, installed, log);
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, window: host.window, crossed: crossed(), warnLedgers: false });
    notice(installed.hooks?.hooks);
    done();
    return { installed };
  }
  const tgzDir = mkdtempSync(join(tmpdir(), "automagik-herdr-layout-"));
  try {
    await run("tar", ["-xzf", resolve(opts.from), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
    const failed = setupHome({ modsDir, tgzDir, record: readMarker(modsDir), log });
    // After setupHome: the pack's own layout is placed first, so only the person's are migrated.
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    heldAfterMigration(modsDir, installed, log);
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, window: host.window, crossed: crossed(), warnLedgers: false });
    notice(installed.hooks?.hooks);
    done();
    if (failed.length && !process.exitCode) process.exitCode = 3;
    return { installed, checkFailed: failed };
  } finally {
    rmSync(tgzDir, { recursive: true, force: true });
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  try {
    const out = await main(process.argv.slice(2));
    console.log(typeof out?.text === "string" ? out.text : JSON.stringify(out));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(error?.usage ? 2 : 1);
  }
}
