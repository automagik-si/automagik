// am's own part, automagik.am (RFC 0012, "The am part"): where it lives, how it updates from the
// signed am-lane, how it rolls back, the links it owns and the briefing entry it writes.
//
//   <AM_HOME, else ~/.automagik>/parts/automagik.am/
//     <version>/      a whole verified extract of automagik-am-<version>.tgz (or the folder
//                     `am self install` ran from); only `current` and `previous` are kept
//     current, previous   links to a <version>/ (or <version>-<hex>/ when that version is already
//                     linked: a reinstall never pulls a folder out from under a link), each
//                     swapped by one rename
//     .lock           held while am installs, updates, rolls back or uninstalls itself
//     record.json     { current, previous, seen }: each { version, sequence, signed, source,
//                     sha256, installed, part (its part.json) }; `seen` the highest sequence taken
//   ~/.local/bin/am                -> parts/automagik.am/current/bin/am
//   ~/.local/bin/automagik-herdr   -> parts/automagik.am/current/bin/automagik-herdr, taken only
//                     when it is missing or points into the pack (the pack leaves a link that
//                     points elsewhere alone); handed back to the pack's on uninstall
//   <HERDR_APP_HOME>/automagik-herdr/briefing.mjs   a link to parts/automagik.am/current/
//                     briefingEntry.mjs (it tries am's briefing first, then the sidebar's). A link,
//                     not a copy: the pack's guard lets the sidebar switch off only once the entry
//                     point resolves into am's parts store, and the pack leaves such a link alone.
//                     It replaces the pack's plain copy; anyone else's link is left alone.
//
// am-lane is read from https://github.com/automagik-dev/automagik/releases/download/am-lane/. For
// tests only: AM_RELEASE_URL, a file:// folder (files at <url>/download/<tag>/<file>), and with a
// file:// one only, AM_TRUSTED_KEYS (am-keys.json's shape, a test's own keys): never honoured for
// a GitHub URL. Apache-2.0.

import * as fs from "node:fs";
import * as paths from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, openSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  rmdirSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// removePath: rmSync that unlinks a link (live or dangling) and never follows it (#550).
import { removePath } from "../layoutSafe.mjs";
import { classify, installState, liveInstallLock, packEntries as packEntriesAt, PENDING, recordAt, sameRealPath, storeProblem } from "../amInstallState.js";
import { hookDoctorLine } from "../briefingText.mjs";
import { LANE_RELEASE, PART, POINTER, RELEASES, REPOSITORY, SIGNATURE, VERSION, sequenceOf, verifyPointer } from "./lane.mjs";

/** This am's own folder (the extract it runs from). */
export const OWN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const homeOf = (env) => env.HOME || homedir();
export const amHomeOf = (env = process.env) => (env.AM_HOME || join(homeOf(env), ".automagik")).replace(/\/+$/, "");
export const storeOf = (env = process.env) => join(amHomeOf(env), "parts", PART);
export const binDirOf = (env = process.env) => join(homeOf(env), ".local", "bin");
export const appHomeOf = (env = process.env) => (env.HERDR_APP_HOME || join(homeOf(env), ".config", "herdr-app")).replace(/\/+$/, "");

const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const linkOf = (path) => { try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null; } catch { return null; } };
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
const absolute = (link, target) => resolve(dirname(link), target);

/** The keys this am trusts for am-lane: its own am-keys.json. */
export const ownKeys = (dir = OWN_DIR) => readJson(join(dir, "am-keys.json"))?.keys ?? [];

/** Where am-lane and the releases are read from, and the keys checked: { releases, keys, file }. */
export function sourceOf(env = process.env, keys = ownKeys()) {
  const url = env.AM_RELEASE_URL;
  if (!url) return { releases: RELEASES, keys, file: false };
  const file = url.startsWith("file://");
  if (!file && !url.startsWith(`${REPOSITORY}/`)) throw new Error(`AM_RELEASE_URL must be a file:// folder or ${REPOSITORY}/…; not ${url}`);
  // A test's own keys: honoured for a file:// folder only, never for a GitHub URL.
  const override = file && env.AM_TRUSTED_KEYS ? JSON.parse(env.AM_TRUSTED_KEYS).keys : null;
  return { releases: url.replace(/\/+$/, ""), keys: override ?? keys, file };
}

/** The bytes at `url`, or null when there are none (a 404, a missing file). */
async function fetchBytes(url, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (url.startsWith("file://")) {
    try { return readFileSync(fileURLToPath(url)); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  const response = await fetch(url, { headers: { "user-agent": "am" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The newest am as am-lane's signed pointer names it, or null when nothing is posted yet. */
export async function readLane({ env = process.env, keys = ownKeys(), fetch } = {}) {
  const { releases, keys: trusted } = sourceOf(env, keys);
  const base = `${releases}/download/${LANE_RELEASE}`;
  const bytes = await fetchBytes(`${base}/${POINTER}`, { fetch });
  if (bytes === null) return null;
  const sig = await fetchBytes(`${base}/${SIGNATURE}`, { fetch });
  if (sig === null) throw new Error(`am lane: ${SIGNATURE} is missing: refusing the pointer`);
  return verifyPointer(bytes, sig.toString("utf8"), trusted);
}

/** The record (record.json), with empty slots when there is none. */
export function readRecord(store) {
  const r = readJson(join(store, "record.json"));
  return { current: r?.current ?? null, previous: r?.previous ?? null, seen: Number.isSafeInteger(r?.seen) ? r.seen : null, entry: r?.entry };
}

function writeRecord(store, record) {
  writeRecordText(store, `${JSON.stringify({ schemaVersion: 1, id: PART, ...record }, null, 2)}\n`);
}

function writeRecordText(store, text) {
  const tmp = join(store, `.record-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, join(store, "record.json"));
  } finally { rmSync(tmp, { force: true }); }
}

const LOCK = ".lock";

function requireStore(store, linked) {
  let checked = store;
  if (!linked) {
    // Local launchers keep their configured paths, even when the am home lives elsewhere.
    const parts = dirname(store);
    const home = dirname(parts);
    try {
      const st = lstatSync(home);
      if (st.uid !== process.getuid()) throw signedError("broken", `${home}: belongs to uid ${st.uid}, expected ${process.getuid()}`);
      checked = join(realpathSync(home), basename(parts), basename(store));
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const problem = storeProblem(checked, fs, paths);
  if (problem) throw signedError("broken", `${problem.path}: ${problem.why}`);
}

function processStart(pid) {
  if (process.platform === "linux") {
    const stat = readText(`/proc/${pid}/stat`);
    // The command name can contain spaces and parentheses. Field 3 follows the last ')'.
    return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 2_000, killSignal: "SIGKILL" }).trim();
  } catch { return null; }
}

/** Move a complete owner directory into place so other reclaimers never see a new empty one. */
function lockReclaim(reclaim, busy) {
  try {
    const st = lstatSync(reclaim);
    if (!st.isDirectory() || st.uid !== process.getuid()) throw busy();
    const names = readdirSync(reclaim);
    const owner = names.length === 1 && /^owner-[a-z0-9]+\.json$/.test(names[0]) ? join(reclaim, names[0]) : null;
    if (names.length && !owner) throw busy();
    const info = owner ? JSON.parse(readFileSync(owner, "utf8")) : null;
    if (owner && (!Number.isSafeInteger(info?.pid) || info.pid <= 0)) throw busy();
    // A live reclaimer may be paused between checking the stale inode and renaming it.
    const held = liveInstallLock(info, st.mtimeMs, Infinity);
    const start = held?.pid && typeof info.start === "string" && info.start ? processStart(held.pid) : null;
    if (held && (!start || start === info.start)) throw busy(held.pid);
    // The filename belongs to this owner only. Removing it cannot remove a newer owner.
    if (owner) rmSync(owner, { force: true });
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const start = processStart(process.pid);
  if (!start) throw new Error("cannot identify the am process reclaiming the store lock");
  const token = JSON.stringify({ pid: process.pid, start });
  const staged = mkdtempSync(`${reclaim}-`);
  const ownerName = `owner-${randomBytes(8).toString("hex")}.json`;
  const owner = join(reclaim, ownerName);
  try {
    writeFileSync(join(staged, ownerName), token);
    renameSync(staged, reclaim);
  } catch (e) {
    if (["ENOTEMPTY", "EEXIST"].includes(e.code)) throw busy();
    throw e;
  } finally { rmSync(staged, { recursive: true, force: true }); }
  const held = () => readText(owner) === token;
  return { held, release() {
    if (!held()) return;
    rmSync(owner, { force: true });
    try { rmdirSync(reclaim); } catch (e) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes(e.code)) throw e; }
  } };
}

/**
 * Takes the store's lock (an exclusive create), so one am installs, updates, rolls back or
 * uninstalls itself at a time; returns its release. A lock whose process is gone, or that is over
 * ten minutes old, is taken over; a live one is refused.
 */
export function lockStore(store, { linked = false } = {}) {
  requireStore(store, linked);
  mkdirSync(store, { recursive: true });
  requireStore(store, linked);
  const path = join(store, LOCK);
  const token = JSON.stringify({ pid: process.pid, at: Date.now(), token: randomBytes(8).toString("hex") });
  const busy = (pid) => Object.assign(new Error(`another am${pid ? ` (pid ${pid})` : ""} is installing or updating am: try again once it is done`), { state: "busy" });
  const reclaim = `${path}-reclaim`;
  for (let tries = 0; tries < 3; tries++) {
    let fd;
    try { fd = openSync(path, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; }
    if (fd !== undefined) {
      try { writeSync(fd, token); } finally { closeSync(fd); }
      return () => { if (readText(path) === token) rmSync(path, { force: true }); };
    }
    let before;
    try { before = lstatSync(path); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    const held = liveInstallLock(readJson(path), before.mtimeMs);
    if (held) throw busy(held.pid);
    // Only one reclaimer moves the stale inode. A new lock created in its place is left alone.
    const reclaimer = lockReclaim(reclaim, busy);
    try {
      const found = lstatSync(path);
      if (found.ino !== before.ino || found.dev !== before.dev || found.mtimeMs !== before.mtimeMs) continue;
      if (!reclaimer.held()) throw busy();
      const aside = `${path}-${randomBytes(8).toString("hex")}`;
      renameSync(path, aside);
      removePath(aside, { force: true });
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    finally { reclaimer.release(); }
  }
  throw busy();
}

const sequenceOrNull = (version) => (VERSION.test(version) ? sequenceOf(version) : null);
const dirOf = (entry) => entry?.dir ?? entry?.version;

function lockLocalStore(store, env) {
  const release = lockStore(store);
  const marker = join(store, PENDING);
  try {
    if (exists(marker)) {
      const record = recordAt(join(store, "record.json"), fs);
      if (record.state !== "ok") throw new Error("invalid install record");
      verifyLauncher(store, env, record.current);
      rmSync(marker);
    }
    return release;
  } catch {
    release();
    throw new Error("am launcher verification pending. Retry `am machines install --machine <this machine>` from the controller.");
  }
}

/** Points the link `name` in `store` at `target` (a folder name in it) by one rename. */
function swapLink(store, name, target) {
  const tmp = join(store, `.${name}-${randomBytes(4).toString("hex")}`);
  symlinkSync(target, tmp);
  try { renameSync(tmp, join(store, name)); } finally { removePath(tmp, { force: true }); }
}

/** What is wrong with an am extract in `dir`: empty when it is one, of `version` when given. */
export function extractProblems(dir, version) {
  const out = [];
  const part = readJson(join(dir, "part.json"));
  if (part?.id !== PART) out.push(`part.json is not ${PART}'s`);
  const v = readText(join(dir, "VERSION"))?.trim();
  if (!v) out.push("it has no VERSION");
  else if (version && v !== version) out.push(`its VERSION is ${v}, not ${version}`);
  for (const f of ["bin/am", "bin/am.mjs", "bin/automagik-herdr", "bin/automagik-herdr.mjs", "bin/run.sh", "briefing.mjs", "briefingEntry.mjs"]) {
    if (!existsSync(join(dir, f))) out.push(`${f} is missing`);
  }
  return out;
}

/**
 * Installs the am extract in `dir` as current, holding the store's lock (placeExtract).
 */
export function installExtract(dir, options = {}) {
  const env = options.env ?? process.env;
  const release = lockLocalStore(storeOf(env), env);
  try { return placeExtract(dir, options); } finally { release(); }
}

/**
 * Installs the am extract in `dir` as current, the store's lock already held: copies it into the
 * store as <version>/ (unless it is a folder of the store already), keeps the one it replaces as
 * previous, prunes the rest, records it, links and links the briefing entry. A version already
 * linked (a reinstall) goes into a fresh <version>-<hex>/, so `current` always names a whole
 * folder. With no pointer's `sequence` (am self install), the version's own is recorded, so an
 * older signed pointer is refused after it too. Returns { version, from, links, entry }.
 */
function placeExtract(dir, { env = process.env, sequence = null, signed = false, source, sha256 = null, now = () => new Date() } = {}) {
  const problems = extractProblems(dir);
  if (problems.length) throw new Error(`not an am to install (${dir}): ${problems.join("; ")}`);
  const version = readText(join(dir, "VERSION")).trim();
  const store = storeOf(env);
  mkdirSync(store, { recursive: true });
  const record = readRecord(store);
  const from = record.current?.version ?? null;
  const real = realpathSync(dir);
  const linked = new Set(["current", "previous"].map((n) => linkOf(join(store, n))).filter(Boolean));
  let name;
  if (dirname(real) === realpathSync(store) && !basename(real).startsWith(".")) {
    name = basename(real); // a folder of the store already (am self install run from it)
  } else {
    name = linked.has(version) ? `${version}-${randomBytes(3).toString("hex")}` : version;
    // An update's extract is already staged in the store: it moves in; any other folder is copied.
    const staged = dirname(real) === realpathSync(store) && basename(real).startsWith(".staging-");
    const staging = staged ? dir : mkdtempSync(join(store, ".staging-"));
    if (!staged) cpSync(dir, staging, { recursive: true, verbatimSymlinks: true });
    chmodSync(staging, 0o755);
    removePath(join(store, name), { recursive: true, force: true }); // a stray folder (or link) no link names
    renameSync(staging, join(store, name));
  }
  const seq = sequence ?? sequenceOrNull(version);
  const entry = {
    version, dir: name, sequence: seq, signed, source: source ?? dir, sha256, installed: now().toISOString(),
    part: readJson(join(store, name, "part.json")),
  };
  const previous = from && from !== version ? record.current : record.previous?.version === version ? null : record.previous;
  if (previous) swapLink(store, "previous", dirOf(previous));
  else removePath(join(store, "previous"), { force: true });
  swapLink(store, "current", name);
  const seen = [record.seen, seq].filter(Number.isSafeInteger);
  writeRecord(store, { current: entry, previous, seen: seen.length ? Math.max(...seen) : null, entry: record.entry });
  prune(store);
  return { version, from, links: linkCommands(env), entry: record.entry === false ? null : writeEntry(env) };
}

/** Removes every folder in the store but current's and previous's (and stray staging). */
export function prune(store, { linked = false } = {}) {
  requireStore(store, linked);
  const keep = new Set(["record.json", "current", "previous", LOCK, `${LOCK}-reclaim`, PENDING]);
  for (const name of ["current", "previous"]) { const to = linkOf(join(store, name)); if (to) keep.add(to); }
  for (const name of readdirSync(store)) if (!keep.has(name)) removePath(join(store, name), { recursive: true, force: true });
}

/** The pack's CLI entries a ~/.local/bin/automagik-herdr link may point at (install.sh's). */
const packEntries = (env) => packEntriesAt(appHomeOf(env), join);

/**
 * Links ~/.local/bin/am and ~/.local/bin/automagik-herdr to the current am. Either is taken only
 * when it is missing, already am's, or one of the pack's own links (install.sh links the pack's
 * CLI under both names); a file there, or a link elsewhere, is left alone and reported. Returns one line per link.
 */
export function linkCommands(env = process.env, linked = () => {}) {
  const bin = binDirOf(env);
  const store = storeOf(env);
  mkdirSync(bin, { recursive: true });
  const ours = (to) => inside(to, store);
  const pack = new Set(packEntries(env));
  const one = (name, takes) => {
    const link = join(bin, name);
    const want = join(store, "current", "bin", name);
    const to = linkOf(link);
    if (to !== null && absolute(link, to) === want) {
      try { if (sameRealPath(link, want, fs)) return { link, state: "linked" }; } catch { /* replace an unusable link */ }
    }
    if (exists(link) && (to === null || !takes(absolute(link, to)))) {
      return { link, state: "left", detail: to === null ? "a file, not a link" : `it points at ${to}` };
    }
    const tmp = join(bin, `.${name}-${randomBytes(4).toString("hex")}`);
    symlinkSync(want, tmp);
    try { renameSync(tmp, link); } finally { removePath(tmp, { force: true }); }
    linked(link);
    return { link, state: to === null ? "created" : "moved", detail: to ?? undefined };
  };
  const takes = (to) => ours(to) || pack.has(to);
  return [one("am", takes), one("automagik-herdr", takes)];
}

/** The briefing hooks' entry point under Herdr's app home, and what am links it to. */
const entryOf = (env) => ({ path: join(appHomeOf(env), "automagik-herdr", "briefing.mjs"), want: join(storeOf(env), "current", "briefingEntry.mjs") });

/**
 * Links <app home>/automagik-herdr/briefing.mjs to am's copy of the entry (through `current`, so an
 * update or rollback needs no relink), when Herdr's app home exists. The pack's plain copy is
 * replaced; a link that is not am's, or a folder, is left alone and reported.
 */
export function writeEntry(env = process.env) {
  const appHome = appHomeOf(env);
  try { if (!statSync(appHome).isDirectory()) return { state: "no-app-home" }; } catch { return { state: "no-app-home" }; }
  const { path, want } = entryOf(env);
  const dir = dirname(path);
  if (linkOf(dir) !== null) return { path, state: "left", detail: `${dir} is a link` };
  const to = linkOf(path);
  if (to !== null && absolute(path, to) === want) return { path, state: "linked" };
  if (to !== null && !inside(absolute(path, to), storeOf(env))) return { path, state: "left", detail: `it points at ${to}` };
  if (to === null && exists(path) && !lstatSync(path).isFile()) return { path, state: "left", detail: "not a file" };
  const replaced = to === null && exists(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.briefing-${randomBytes(4).toString("hex")}.mjs`);
  symlinkSync(want, tmp);
  renameSync(tmp, path);
  return { path, state: replaced ? "linked (replaced the pack's copy)" : "linked" };
}

/** Hands the entry point back: the installed pack's own copy in place of am's link, else no file. */
function unlinkEntry(env) {
  const { path } = entryOf(env);
  const to = linkOf(path);
  if (to === null || !inside(absolute(path, to), storeOf(env))) return null;
  const source = ["am-sidebar", "spaces-agents"].map((m) => join(appHomeOf(env), "mods", m, "briefingEntry.mjs")).find((p) => existsSync(p));
  if (!source) { removePath(path, { force: true }); return { link: path, state: "removed" }; }
  const tmp = join(dirname(path), `.briefing-${randomBytes(4).toString("hex")}.mjs`);
  writeFileSync(tmp, readFileSync(source));
  renameSync(tmp, path);
  return { link: path, state: "handed back", detail: source };
}

/**
 * am's half of an uninstall: ~/.local/bin/am and automagik-herdr go back to the pack's
 * entry when a pack is installed (else they go). The store stays, unless `purge`.
 */
export function uninstallSelf({ env = process.env, purge = false } = {}) {
  const bin = binDirOf(env);
  const store = storeOf(env);
  const release = existsSync(store) ? lockLocalStore(store, env) : () => {};
  try { return unplace({ env, purge, bin, store }); } finally { release(); }
}

function unplace({ env, purge, bin, store }) {
  const lines = [];
  for (const name of ["am", "automagik-herdr"]) {
    const link = join(bin, name);
    const to = linkOf(link);
    if (to === null || !inside(absolute(link, to), store)) continue;
    const back = packEntries(env).find((p) => existsSync(p)) ?? null;
    if (back) {
      const tmp = join(bin, `.${name}-${randomBytes(4).toString("hex")}`);
      symlinkSync(back, tmp);
      renameSync(tmp, link);
      lines.push({ link, state: "handed back", detail: back });
    } else {
      removePath(link, { force: true });
      lines.push({ link, state: "removed" });
    }
  }
  const entry = unlinkEntry(env);
  if (entry) lines.push(entry);
  if (purge) removePath(store, { recursive: true, force: true });
  return { links: lines, purged: purge };
}

/** Swaps current and previous; returns { from, to }. */
export function rollbackSelf({ env = process.env } = {}) {
  const store = storeOf(env);
  const release = lockLocalStore(store, env);
  try {
    const record = readRecord(store);
    if (!record.previous || !existsSync(join(store, dirOf(record.previous)))) throw new Error("am has no previous version to roll back to");
    swapLink(store, "current", dirOf(record.previous));
    swapLink(store, "previous", dirOf(record.current));
    writeRecord(store, { current: record.previous, previous: record.current, seen: record.seen, entry: record.entry });
    return { from: record.current.version, to: record.previous.version, links: linkCommands(env), entry: record.entry === false ? null : writeEntry(env) };
  } finally { release(); }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What is wrong with a tarball's entries (`tar -tzf`'s names, `tar -tvzf`'s lines): empty when all is well. */
export function unsafeEntries(names, lines) {
  if (names.length === 0) return ["the tarball is empty"];
  if (names.length !== lines.length) return ["the tarball's listing does not add up (a name with a line break?)"];
  const problems = [];
  names.forEach((name, i) => {
    const type = lines[i][0];
    if (name.startsWith("/")) problems.push(`${name}: an absolute path`);
    else if (name.split("/").includes("..")) problems.push(`${name}: a .. segment`);
    else if ((type !== "-" && type !== "d") || lines[i].includes(" link to ") || lines[i].includes(" -> ")) problems.push(`${name}: not a plain file or folder`);
  });
  return problems;
}

const tarList = (tgz, flags) => execFileSync("tar", [flags, tgz], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);

const signedError = (state, message) => Object.assign(new Error(message), { state });

/** A linked bootstrap installs only the archive that passes this am's own keys. */
export function installSigned(folder, { env = process.env } = {}) {
  const store = storeOf(env);
  const made = [];
  for (const base of [store, binDirOf(env)]) {
    for (let dir = base; !exists(dir); dir = dirname(dir)) made.push(dir);
  }
  try {
    const release = lockStore(store, { linked: true });
    try { return verifyAndPlaceSigned(folder, store, env); } finally { release(); }
  } catch (e) {
    for (const dir of made) { try { rmdirSync(dir); } catch { /* in use or never made */ } }
    throw e;
  }
}

function verifyAndPlaceSigned(folder, store, env) {
  const state = installState({ home: homeOf(env), amHome: amHomeOf(env), appHome: appHomeOf(env) }, fs, paths);
  const before = classify(state);
  if (before.action === "refuse") throw signedError("broken", before.why);
  const { record } = state;
  let pointer, bytes;
  try {
    pointer = verifyPointer(readFileSync(join(folder, POINTER)), readFileSync(join(folder, SIGNATURE), "utf8"), ownKeys());
    if (before.state !== "installed" && pointer.sequence < (record.seen ?? 0)) throw new Error(`am lane: sequence ${pointer.sequence} is older than the newest this machine took (${record.seen})`);
    bytes = readFileSync(join(folder, pointer.tarball.name));
    if (bytes.length !== pointer.tarball.size || sha256(bytes) !== pointer.tarball.sha256) throw new Error(`${pointer.tarball.name} does not match the signed pointer (sha256 or size)`);
  } catch (e) { throw signedError("refused", e.message); }
  if (before.state === "installed") {
    return { part: PART, ok: true, changed: false, state: before.version === pointer.version ? "current" : "installed",
      version: before.version, sequence: record.current.sequence, sha256: record.current.sha256 };
  }
  const work = mkdtempSync(join(store, ".signed-"));
  let result;
  try {
    const archive = join(work, pointer.tarball.name);
    writeFileSync(archive, bytes);
    const unsafe = unsafeEntries(tarList(archive, "-tzf"), tarList(archive, "-tvzf"));
    if (unsafe.length) throw signedError("refused", `${archive}: ${unsafe.join("; ")}`);
    const staging = join(work, "extract");
    mkdirSync(staging, { mode: 0o755 });
    execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: ["ignore", "ignore", "pipe"] });
    const problems = extractProblems(staging, pointer.version);
    if (problems.length) throw signedError("refused", `${pointer.tarball.name}: ${problems.join("; ")}`);
    result = placeSigned(staging, store, env, pointer, state);
    return result;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); }
    catch (e) { if (result) result.cleanup ??= `am installed; cleanup: ${e.message}`; }
  }
}

function verifyLauncher(store, env, entry) {
  const current = join(store, "current");
  const tree = join(store, dirOf(entry));
  if (!lstatSync(tree).isDirectory() || linkOf(current) === null || !sameRealPath(current, tree, fs)) {
    throw new Error(`${current} did not link to ${tree}`);
  }
  for (const name of ["am", "automagik-herdr"]) {
    const path = join(binDirOf(env), name);
    const want = join(current, "bin", name);
    if (linkOf(path) === null || !sameRealPath(path, want, fs)) throw new Error(`${path} did not link to ${want}`);
    fs.accessSync(path, fs.constants.X_OK);
  }
  const cmd = join(binDirOf(env), "am");
  const got = execFileSync(cmd, ["--version"], { env, timeout: 10_000, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (got.trim() !== `am ${entry.version}`) throw new Error(`${cmd} --version did not print am ${entry.version}`);
}

function savedTreeMatches(store, slot) {
  const tree = join(store, dirOf(slot));
  try { return lstatSync(tree).isDirectory() && extractProblems(tree, slot.version).length === 0; }
  catch { return false; }
}

/** The successful launcher check commits the swap. The old trees stay until then. */
function placeSigned(staging, store, env, pointer, snapshot) {
  const { version, sequence, tarball } = pointer;
  const { record, current, previous, am, alias, pending } = snapshot;
  const name = exists(join(store, version)) ? `${version}-${randomBytes(8).toString("hex")}` : version;
  const placed = join(store, name);
  const legacy = pending && !Object.hasOwn(pending, "current");
  const saved = pending && !legacy ? pending : { current: record.current ?? null, previous: record.previous ?? null };
  let rollback = [saved.current, saved.previous];
  let cleanup;
  if (legacy) {
    // An empty marker cannot tell whether record.current was ever verified.
    if (saved.current) {
      try { verifyLauncher(store, env, saved.current); }
      catch { cleanup = `am ${saved.current.version} failed launcher verification and was not kept for rollback`; }
    }
    rollback = [saved.previous, cleanup ? null : saved.current];
  }
  const uncertain = pending && !legacy && rollback.some((slot) => slot && !savedTreeMatches(store, slot));
  const nextPrevious = uncertain ? record.previous ?? null : rollback.find((slot) => slot && slot.version !== version) ?? null;
  if (uncertain && nextPrevious && !savedTreeMatches(store, nextPrevious)) {
    throw signedError("broken", `recorded rollback tree ${dirOf(nextPrevious)} is missing or does not match am ${nextPrevious.version}`);
  }
  const next = { version, dir: name, sequence, signed: true, source: LANE_RELEASE, sha256: tarball.sha256,
    installed: new Date().toISOString(), part: readJson(join(staging, "part.json")) };
  const changed = new Set();
  const marker = join(store, PENDING);
  // Flush the marker and its directory before publishing any of the new install.
  const syncStore = () => {
    const fd = openSync(store, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    if (!pending) {
      const stagedMarker = join(dirname(staging), PENDING);
      writeFileSync(stagedMarker, JSON.stringify(saved), { flag: "wx", mode: 0o600, flush: true });
      renameSync(stagedMarker, marker);
      changed.add(marker);
      syncStore();
    }
    renameSync(staging, placed);
    changed.add(placed);
    if (nextPrevious) swapLink(store, "previous", dirOf(nextPrevious));
    else removePath(previous.path, { force: true });
    changed.add(previous.path);
    swapLink(store, "current", name);
    changed.add(current.path);
    writeRecord(store, { current: next, previous: nextPrevious, seen: Math.max(record.seen ?? 0, sequence), entry: false });
    changed.add(record.path);
    linkCommands(env, (path) => changed.add(path));
    verifyLauncher(store, env, next);
    syncStore();
    rmSync(marker);
  } catch (e) {
    const errors = [];
    const restore = (path, fn) => { try { fn(); } catch (error) { errors.push(`${path}: ${error.message}`); } };
    for (const link of [current, previous, am, alias]) {
      if (!changed.has(link.path)) continue;
      restore(link.path, () => link.target === undefined ? removePath(link.path, { force: true }) : swapLink(dirname(link.path), basename(link.path), link.target));
    }
    if (changed.has(record.path)) restore(record.path, () => record.text === undefined ? rmSync(record.path, { force: true }) : writeRecordText(store, record.text));
    if (!errors.length && changed.has(placed)) restore(placed, () => rmSync(placed, { recursive: true, force: true }));
    if (!errors.length && changed.has(marker)) restore(marker, () => rmSync(marker, { force: true }));
    throw signedError("broken", `${e.message}; ${errors.length ? `could not restore ${errors.join("; ")}` : `restored ${[current.path, previous.path, record.path, am.path, alias.path].join(", ")}`}`);
  }
  const result = { part: PART, ok: true, changed: true, state: "installed", version, sequence, sha256: tarball.sha256 };
  if (cleanup) result.cleanup = cleanup;
  if (!uncertain) {
    try { prune(store, { linked: true }); }
    catch (e) { result.cleanup = [cleanup, `am installed; cleanup: ${e.message}`].filter(Boolean).join("; "); }
  }
  return result;
}

/**
 * Updates am from am-lane: refuses a pointer older than one this machine took (`seen`), does
 * nothing when current, downloads the tarball from the pointer's release, checks it against the
 * pointer's sha256 and size and its entries, extracts it beside the installed copy and swaps.
 * `check`: only reports. Returns { state: none|current|available|updated, from, to, detail }.
 */
export async function updateSelf({ env = process.env, keys = ownKeys(), fetch, check = false } = {}) {
  const store = storeOf(env);
  let release;
  try {
    if (!check && exists(join(store, PENDING))) release = lockLocalStore(store, env);
    const record = readRecord(store);
    const from = record.current?.version ?? null;
    const pointer = await readLane({ env, keys, fetch });
    if (!pointer) return { state: "none", from, to: null, detail: "nothing is posted on am-lane yet" };
    if (record.seen !== null && pointer.sequence < record.seen) {
      throw new Error(`am lane: it names ${pointer.version} (sequence ${pointer.sequence}), older than the newest this machine took (sequence ${record.seen}): refusing it`);
    }
    if (record.current?.sequence === pointer.sequence && existsSync(join(store, "current"))) return { state: "current", from, to: pointer.version };
    if (check) return { state: "available", from, to: pointer.version };
    // Reconcile under lock even when the marker appeared while reading the lane.
    release ??= lockLocalStore(store, env);
    return await fetchAndPlace({ env, keys, fetch, store, pointer });
  } finally { release?.(); }
}

async function fetchAndPlace({ env, keys, fetch, store, pointer }) {
  const record = readRecord(store);
  const from = record.current?.version ?? null;
  if (record.seen !== null && pointer.sequence < record.seen) {
    throw new Error(`am lane: it names ${pointer.version} (sequence ${pointer.sequence}), older than the newest this machine took (sequence ${record.seen}): refusing it`);
  }
  if (record.current?.sequence === pointer.sequence && existsSync(join(store, "current"))) return { state: "current", from, to: pointer.version };
  const { releases } = sourceOf(env, keys);
  const bytes = await fetchBytes(`${releases}/download/${pointer.tag}/${pointer.tarball.name}`, { fetch, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (bytes === null) throw new Error(`${pointer.tarball.name} is not on ${pointer.tag}`);
  const got = sha256(bytes);
  if (got !== pointer.tarball.sha256 || bytes.byteLength !== pointer.tarball.size) {
    throw new Error(`${pointer.tarball.name} does not match the signed pointer (sha256 ${got}, expected ${pointer.tarball.sha256}): refusing it`);
  }
  mkdirSync(store, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "am-update-"));
  try {
    const tgz = join(work, pointer.tarball.name);
    writeFileSync(tgz, bytes);
    const unsafe = unsafeEntries(tarList(tgz, "-tzf"), tarList(tgz, "-tvzf"));
    if (unsafe.length) throw new Error(`${pointer.tarball.name}: ${unsafe.join("; ")}: refusing it`);
    const staging = mkdtempSync(join(store, ".staging-"));
    execFileSync("tar", ["-xzf", tgz, "-C", staging], { stdio: ["ignore", "ignore", "pipe"] });
    const problems = extractProblems(staging, pointer.version);
    if (problems.length) { rmSync(staging, { recursive: true, force: true }); throw new Error(`${pointer.tarball.name}: ${problems.join("; ")}: refusing it`); }
    const done = placeExtract(staging, { env, sequence: pointer.sequence, signed: true, source: LANE_RELEASE, sha256: got });
    return { state: "updated", from, to: pointer.version, links: done.links, entry: done.entry };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A project's settings.local.json, read only (installHook writes its briefing hook): { file, text }
 * (text null when the file isn't there) or { file, readError } when it can't be read.
 */
function projectSettings(project) {
  const file = join(project, ".claude", "settings.local.json");
  try { return { file, text: readFileSync(file, "utf8"), readError: null }; } catch (e) {
    return e.code === "ENOENT" ? { file, text: null, readError: null } : { file, text: null, readError: e.message };
  }
}
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * am's doctor lines ({ part, check, ok, detail, fix }) and its exit code: 0 healthy, 1 broken.
 * `project`: the folder whose briefing hook it reports (default: the current one).
 */
export function doctorSelf({ env = process.env, project = process.cwd() } = {}) {
  const store = storeOf(env);
  const record = readRecord(store);
  const line = (check, ok, detail, fix) => ({ part: PART, check, ok, detail, ...(ok ? {} : { fix }) });
  const lines = [line("restart-path", true, "In a Herdr bot pane, restart the session with am restart <bot>, never /restart.")];
  const current = join(store, "current");
  const problems = existsSync(current) ? extractProblems(current, record.current?.version) : ["it is not installed"];
  lines.push(line("installed", problems.length === 0, problems.length ? problems.join("; ") : `${record.current?.version} in ${realpathSync(current)}`,
    "am self install, from an am extract"));
  for (const name of ["am", "automagik-herdr"]) {
    const link = join(binDirOf(env), name);
    const to = linkOf(link);
    const want = join(store, "current", "bin", name);
    const ok = to !== null && absolute(link, to) === want;
    lines.push(line(`link ${name}`, ok, ok ? `${link} -> ${to}` : to ? `${link} points at ${to}` : exists(link) ? `${link} is a file` : `${link} is missing`,
      `am self install (a ${name} that is not am's is left alone: remove it first)`));
  }
  if (record.entry === false) lines.push(line("briefing entry", true, "a linked install writes no stable entry"));
  else if (existsSync(appHomeOf(env))) {
    const { path, want } = entryOf(env);
    const to = linkOf(path);
    const ok = to !== null && absolute(path, to) === want && existsSync(want);
    lines.push(line("briefing entry", ok, ok ? `${path} -> ${to}` : to ? `${path} points at ${to}` : exists(path) ? `${path} is the pack's copy, not am's link` : `${path} is missing`,
      "am self install"));
  }
  // Which briefing this project's hook runs (installHook writes .claude/settings.local.json): the
  // pack's stable or direct entry, am's own entry on a CLI-only host, or none, said plainly when
  // neither is installed. The hook command itself is what the person's Claude Code runs.
  // hookDoctorLine is the pack doctor's too, so the two say it the same way; a settings file that
  // can't be read is that project's state, reported without failing am's doctor.
  const hook = hookDoctorLine({ ...projectSettings(project), appHome: appHomeOf(env), amStore: store, isFile });
  lines.push(line("briefing hook", hook.ok, hook.detail, hook.repair === "am" ? "am self install" : "reinstall the pack"));
  const keys = ownKeys(existsSync(current) ? current : OWN_DIR);
  // Not a fault of this machine: until a release ships am's key, am only cannot update itself.
  lines.push(line("am-lane keys", true, keys.length ? keys.map((k) => k.keyId).join(", ") : "am-keys.json lists no key yet: am cannot update itself until a release ships one"));
  return { lines, code: lines.every((l) => l.ok) ? 0 : 1 };
}
