// The Bot login generation reader (#1509, design note rev 5): one function, resolveLogin(vendor),
// called at launch. ACP writes the generation record beside its per-vendor pointers and publishes
// its installation's selected root. Everything filesystem-shaped is injected (`io`), so the rows
// run on scratch homes and a fake writer with no real login.
//
// Reads only: the panel's selection and process identity, the generation record, this vendor's
// pointer, folder and marker stats, login-tree names, and this installation's sequence memory.
// Never a credential file or network call. Refusals carry a stable code and one effect-only
// sentence, no path and no account.
// Apache-2.0.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import { POINTER_VAR, VENDORS, loginRequired } from "./loginWords.js";
export * from "./loginWords.js";

/** The only sentence a refusal shows; the code is the machine-readable half. */
const REFUSAL_REASON = "The Bot login record is missing or out of date; sign in again.";
/** The record field each vendor's folder is named in. */
const VENDOR_FIELD = Object.freeze({ claude: "configDir", codex: "home" });
/** The one log line a backwards (advisory) sequence must produce, verbatim. */
export const BACKWARDS_LINE = "record sequence went backwards; accepted because the generation matches the pointer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INSTANCE = /^\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DARWIN_START = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/;

const refusal = (code) => ({ code, reason: REFUSAL_REASON });
export const loginReadIo = {
  read: (path) => readFileSync(path, "utf8"),
  lstat: lstatSync,
  readdir: readdirSync,
  openSelection: openClaim,
  openOwnership: openClaim,
};

/** ACP's config folder inside a vendor home (apps/acp-dsh/src/host/cli-homes.js environment). */
const VENDOR_CONFIG_DIR = Object.freeze({ claude: ".claude", codex: ".codex" });
const SELECTION_LIMIT = 4096;
const retryWait = new Int32Array(new SharedArrayBuffer(4));
const privateEntry = (stat) => process.getuid?.() === stat.uid && (stat.mode & 0o022) === 0;
const regularClaim = (stat) => stat.isFile() && stat.size <= SELECTION_LIMIT && privateEntry(stat);
const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;

function openClaim(path) {
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
}

function privateDirectory(io, path) {
  const stat = io.lstat(path);
  return stat.isDirectory() && privateEntry(stat);
}

/** POSIX dirname for the record and pointer paths (the spec's paths are POSIX). */
function dirnameOf(path) {
  const clean = String(path).replace(/\/+$/, "");
  const at = clean.lastIndexOf("/");
  if (at < 0) return ".";
  return at === 0 ? "/" : clean.slice(0, at);
}

const joinPath = (dir, name) => `${String(dir).replace(/\/+$/, "")}/${name}`;

/** One read of `path` as text; { text } or { error }. Never throws. */
function readText(io, path) {
  try {
    return { text: io.read(path) };
  } catch (error) {
    return { error };
  }
}

/** One lstat; the result or undefined when it does not exist/read. */
function lstatOf(io, path) {
  try {
    return io.lstat(path);
  } catch {
    return undefined;
  }
}

/** The record, with the one immediate re-read a torn or replaced read gets (spec 8b(c)). */
function readRecord(io, recordPath) {
  let last = "absent";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = readText(io, recordPath);
    if (read.error) {
      last = read.error?.code === "ENOENT" ? "absent" : "unreadable";
      continue;
    }
    try {
      const value = JSON.parse(read.text);
      return { value };
    } catch {
      last = "invalid";
    }
  }
  return { code: last === "absent" ? "record-absent" : last === "unreadable" ? "record-unreadable" : "record-invalid" };
}

/**
 * The physical DSH home the panel names its installation by (acp-dsh installationIdentity).
 * `io.realpath` is injectable; a home that cannot be resolved physically still names one.
 */
export function installationIdentity(dshHome, io = {}) {
  const home = typeof dshHome === "string" && dshHome.trim() ? dshHome : "~/.dsh";
  const path = home === "~" ? homedir()
    : /^~[\\/]/.test(home) ? `${homedir()}${sep}${home.slice(2)}` : home;
  try { return (io.realpath ?? realpathSync.native)(path); } catch { return resolve(path); }
}

/** Match ACP's bounded, no-follow read, holding onto the inode and exact bytes. */
function readClaim(io, path, kind) {
  const stat = io.lstat(path);
  if (!regularClaim(stat)) return null;
  const bytes = (io.readClaimBytes ?? readClaimBytes)(path, stat, io[kind] ?? openClaim);
  if (typeof bytes !== "string" || Buffer.byteLength(bytes) > SELECTION_LIMIT) return null;
  try { return { path, stat, bytes, value: JSON.parse(bytes) }; } catch { return null; }
}

function readClaimBytes(path, stat, open) {
  const fd = open(path);
  try {
    const opened = fstatSync(fd);
    if (!regularClaim(opened) || !sameEntry(stat, opened)) return null;
    const bytes = Buffer.alloc(SELECTION_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return length <= SELECTION_LIMIT ? bytes.toString("utf8", 0, length) : null;
  } finally { closeSync(fd); }
}

function readSelectionWithRetry(io, path) {
  for (let retry = 0; ; retry += 1) {
    try { return readClaim(io, path, "openSelection"); } catch (error) {
      if (error?.code !== "EINTR" || retry === 3) return null;
      Atomics.wait(retryWait, 0, 0, 10);
    }
  }
}

/** Match ACP's process-birth records. Also refuse zombies, which still answer signal 0. */
function livePanel(io, { pid, birth }) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || birth?.platform !== (io.platform ?? process.platform)) return false;
  try {
    process.kill(pid, 0);
    if (birth.platform === "darwin") {
      if (typeof birth.start !== "string" || !DARWIN_START.test(birth.start)) return false;
      const output = (io.ps ?? execFileSync)("/bin/ps", ["-p", String(pid), "-o", "state=", "-o", "lstart="], {
        encoding: "utf8", timeout: 2000, maxBuffer: 1024, env: { LC_ALL: "C", TZ: "UTC" },
      });
      const match = /^([A-Za-z]\S*)\s+(.+)$/.exec(output.trim().replace(/\s+/g, " "));
      return !!match && !match[1].startsWith("Z") && match[2] === birth.start;
    }
    if (birth.platform !== "linux" || typeof birth.boot !== "string" || !UUID.test(birth.boot)
      || typeof birth.start !== "string" || !/^(0|[1-9][0-9]{0,30})$/.test(birth.start)) return false;
    if (io.read("/proc/sys/kernel/random/boot_id").trim() !== birth.boot) return false;
    const stat = io.read(`/proc/${pid}/stat`);
    const end = stat.lastIndexOf(")");
    if (!stat.startsWith(`${pid} (`) || end < 0 || stat[end + 1] !== " ") return false;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields.length >= 50 && /^[A-Za-z]$/.test(fields[0])
      && !["Z", "X", "x"].includes(fields[0]) && fields[19] === birth.start;
  } catch { return false; }
}

// A host PID can outlive its plugin. ACP holds the selected file open for exactly
// that plugin's lifetime. The unique inode also disambiguates Darwin births in the same second.
function openPanelSelection(io, value, stat) {
  const { pid, descriptor, birth } = value;
  if (!Number.isInteger(descriptor) || descriptor < 3 || descriptor > 0x7fffffff) return false;
  try {
    if (io.selectionOpen) return io.selectionOpen(value, stat);
    if (birth.platform === "linux") return sameEntry(stat, statSync(`/proc/${pid}/fd/${descriptor}`));
    const output = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", String(descriptor), "-FfaiD"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 4096, env: { LC_ALL: "C" },
    }).split("\n");
    return output.includes(`p${pid}`) && output.includes(`f${descriptor}`) && output.includes("au")
      && output.includes(`i${stat.ino}`)
      && output.some((line) => /^D0x[0-9a-f]+$/i.test(line) && Number(line.slice(1)) === stat.dev);
  } catch { return false; }
}

function panelOwnership(io, root, vendor, selection) {
  try {
    const instances = joinPath(root, "instances");
    const directory = joinPath(instances, vendor);
    if (!privateDirectory(io, root) || !privateDirectory(io, instances) || !privateDirectory(io, directory)) return null;
    const registration = readClaim(io, joinPath(directory, selection.instance), "openOwnership");
    const record = registration?.value;
    // ACP's ownershipAt with the root marker. A legacy or unverified birth cannot vouch
    // for this instance. Compare to the same birth that the selection's live check proves.
    if (record?.format === "app-birth-v1" && record.pid === selection.pid
      && record.nonce === selection.instance && record.marker === "root"
      && record.birth?.platform === selection.birth?.platform
      && record.birth?.start === selection.birth?.start
      && record.birth?.boot === selection.birth?.boot) return registration;
  } catch {}
  return null;
}

function rootIsPrivate(io, acp, root) {
  try {
    for (let dir = root; dir !== acp; dir = dirnameOf(dir)) {
      if (!privateDirectory(io, dir)) return false;
    }
    return privateDirectory(io, acp);
  } catch { return false; }
}

/** Resolve installation evidence independently from the pointer. */
function rootSelection(io, root, vendor, env) {
  if (![env.DSH_HOME, env.AUTOMAGIK_HOME].every((path) => typeof path === "string" && path.trim()
    && !/[\u0000-\u001f\u007f]/.test(path))) return refusal("installation-unknown");
  const acp = joinPath(resolve(env.AUTOMAGIK_HOME), "acp");
  const identity = installationIdentity(env.DSH_HOME, io);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const shared = joinPath(acp, "cli-homes"), isolated = joinPath(acp, `installations/${digest}/cli-homes`);
  if (root !== shared && root !== isolated) return refusal("installation-mismatch");
  const selected = joinPath(acp, "selected");
  const directory = joinPath(selected, digest);
  const directoriesArePrivate = () => privateDirectory(io, selected) && privateDirectory(io, directory);
  const inspect = (path) => {
    const selection = readSelectionWithRetry(io, path);
    const value = selection?.value;
    if (value?.version !== 1 || value.identity !== identity
      || (value.root !== shared && value.root !== isolated)
      || !Array.isArray(value.vendors) || !value.vendors.includes(vendor)
      || !Number.isSafeInteger(value.pid) || value.pid <= 1
      || typeof value.instance !== "string" || !UUID.test(value.instance.slice(String(value.pid).length + 1))
      || !value.instance.startsWith(`${value.pid}-`) || path !== joinPath(directory, `${value.instance}.json`)) return null;
    if (!rootIsPrivate(io, acp, value.root)) return null;
    const registration = panelOwnership(io, value.root, vendor, value);
    if (!registration) return null;
    return { selection, registration, open: livePanel(io, value) && openPanelSelection(io, value, selection.stat) };
  };
  const unchanged = (a, b) => b && sameEntry(a.stat, b.stat) && a.bytes === b.bytes;
  const scan = () => {
    if (!directoriesArePrivate()) return refusal("installation-unknown");
    const matches = [];
    let otherRoot = false;
    for (const entry of io.readdir(directory)) {
      if (!entry.endsWith(".json") || !INSTANCE.test(entry.slice(0, -5))) continue;
      const found = inspect(joinPath(directory, entry));
      if (!found) continue;
      if (found.selection.value.root === root) {
        // A withdrawal can close the descriptor while leaving the record and registration
        // on disk. That record cannot authorize this root.
        if (!found.open) return refusal("installation-unknown");
        matches.push(found);
      } else if (found.open) otherRoot = true;
    }
    if (!matches.length) return refusal(otherRoot ? "installation-mismatch" : "installation-unknown");
    return { matches };
  };
  try {
    const { matches, code } = scan();
    if (code) return refusal(code);
    return { stillSelected: () => {
      try {
        const current = scan().matches;
        return !!current && matches.some(({ selection, registration }) => current.some((found) =>
          found.selection.path === selection.path && unchanged(selection, found.selection)
          && unchanged(registration, found.registration)));
      } catch { return false; }
    } };
  } catch {
    return refusal("installation-unknown");
  }
}

/**
 * A null field is a legacy login (signed in before any generation) only when ACP itself would
 * resolve the pointer as legacy (cli-generations.js generationAt): no pointer file, no
 * .activated marker, no generation homes and nothing retired. Then the login is <root>/<vendor>.
 */
function legacyDir(io, root, vendor) {
  const pointer = joinPath(joinPath(root, "current"), vendor);
  const read = readText(io, pointer);
  if (!read.error || read.error?.code !== "ENOENT") return null;
  for (const marker of [`${pointer}.activated`, joinPath(joinPath(root, "homes"), vendor), joinPath(joinPath(root, "retired"), vendor)]) {
    try { io.lstat(marker); return null; } catch (error) { if (error?.code !== "ENOENT") return null; }
  }
  return joinPath(joinPath(root, vendor), VENDOR_CONFIG_DIR[vendor]);
}

/** This installation's last accepted sequence: a plain number file; absent/invalid is no memory. */
function readMemory(io, memoryPath) {
  const read = readText(io, memoryPath);
  if (read.error) return undefined;
  const text = String(read.text).trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * Resolve the Bot login a launch of `vendor` must use.
 *
 * `io.read(path)` returns text (throws on failure), `io.lstat(path)` returns an fs.Stats-like
 * object, and `io.readdir(path)` lists entry names. `io.writeAtomic(path, text)` replaces the
 * sequence memory in one step, mode 0600.
 * `memoryPath` is am's own state file; `readOnly` (login --check) never writes it. `log` receives
 * the one mandated backwards line and a single line when there is no memory yet.
 *
 * Returns { state: "ready", dir, generation, sequence }, { code, reason }, or
 * { state: "absent" } when the pointer variable is absent and the pilot marker is not set.
 */
export function resolveLogin({ vendor, env = {}, memoryPath, io, log = () => {}, readOnly = false } = {}) {
  if (!VENDORS.includes(vendor)) return { state: "absent" };
  if (!io || typeof io.read !== "function" || typeof io.lstat !== "function") {
    return refusal("reader-unavailable");
  }
  const required = loginRequired(env);
  if (!Object.hasOwn(env, POINTER_VAR)) return required ? refusal("login-required") : { state: "absent" };
  const pointer = env[POINTER_VAR];
  if (typeof pointer !== "string" || /[\u0000-\u001f\u007f]/.test(pointer)
    || !pointer.startsWith("/") || pointer.slice(1).split("/").some((part) => !part || part === "." || part === "..")
    || !VENDORS.includes(pointer.split("/").pop())) return refusal("pointer-invalid");
  const current = dirnameOf(pointer);
  if (current.split("/").pop() !== "current" || current === "/current") return refusal("pointer-invalid");
  const root = dirnameOf(current);
  const selected = rootSelection(io, root, vendor, env);
  if (selected.code) return selected;
  const { stillSelected } = selected;
  try { if (!privateDirectory(io, current)) return refusal("installation-unknown"); }
  catch (error) { if (error?.code !== "ENOENT") return refusal("installation-unknown"); }
  const recordPath = joinPath(current, "generation.json");
  const record = readRecord(io, recordPath);
  if (record.code) return refusal(record.code);
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    return refusal("record-version");
  }
  const field = value[vendor];
  const stillRecorded = () => {
    const again = readRecord(io, recordPath);
    return !again.code && again.value?.version === 1
      && JSON.stringify(again.value[vendor]) === JSON.stringify(field);
  };
  if (field === undefined) return refusal("vendor-null");
  if (field === null) {
    // The panel's own root (verified above) on a login from before any generation: the same
    // account the panel uses, so it launches; anything ACP would not call legacy refuses.
    const dir = legacyDir(io, root, vendor);
    if (dir === null) return refusal("vendor-null");
    return ready(io, { root, dir, generation: "legacy", value, memoryPath, log, readOnly, stillSelected,
      stillCurrent: () => stillRecorded() && legacyDir(io, root, vendor) === dir });
  }
  if (typeof field !== "object" || Array.isArray(field)) return refusal("vendor-invalid");
  const generation = field.generation;
  if (typeof generation !== "string" || !UUID.test(generation)) return refusal("generation-invalid");
  const dir = field[VENDOR_FIELD[vendor]];
  if (typeof dir !== "string" || !dir.startsWith("/") || dir === "/" || /[\u0000-\u001f\u007f]/.test(dir)) {
    return refusal("path-invalid");
  }
  const pointerPath = joinPath(current, vendor);
  const pointerRead = readText(io, pointerPath);
  if (pointerRead.error) {
    const activated = lstatOf(io, `${pointerPath}.activated`);
    return refusal(activated === undefined ? "pointer-missing" : "pointer-missing-activated");
  }
  if (pointerRead.text !== generation) return refusal("generation-mismatch");
  if (dir !== joinPath(root, `homes/${vendor}/${generation}/${VENDOR_CONFIG_DIR[vendor]}`)) return refusal("path-mismatch");
  return ready(io, { root, dir, generation, value, memoryPath, log, readOnly, stillSelected,
    stillCurrent: () => privateDirectory(io, current) && stillRecorded() && readText(io, pointerPath).text === generation });
}

function loginEvidence(io, root, dir) {
  const folder = lstatOf(io, dir);
  if (folder === undefined) return refusal("folder-missing");
  if (folder.isSymbolicLink?.()) return refusal("folder-link");
  if (!folder.isDirectory?.()) return refusal("folder-not-directory");
  if ((Number(folder.mode) & 0o777) !== 0o700 || !privateEntry(folder)) return refusal("folder-mode");
  const home = dirnameOf(dir);
  if (!rootIsPrivate(io, root, home)) return refusal("login-unverified");
  for (const marker of ["paused", "changing"]) {
    try {
      io.lstat(joinPath(home, marker));
      return refusal(`login-${marker}`);
    } catch (error) {
      if (error?.code !== "ENOENT") return refusal("login-unverified");
    }
  }
  // ACP can prove that a recorded login tree stopped and remove it. The reader leaves that to ACP.
  try {
    if (io.readdir(joinPath(home, "login-trees")).length) return refusal("login-unverified");
  } catch (error) {
    if (error?.code !== "ENOENT") return refusal("login-unverified");
  }
  return null;
}

/** The folder's hard checks, then the advisory sequence; the launch's resolved login. */
function ready(io, { root, dir, generation, value, memoryPath, log, readOnly, stillSelected, stillCurrent }) {
  const evidence = loginEvidence(io, root, dir);
  if (evidence) return evidence;
  if (!stillSelected()) return refusal("installation-unknown");
  try { if (!stillCurrent()) return refusal("generation-mismatch"); }
  catch { return refusal("generation-mismatch"); }
  const current = loginEvidence(io, root, dir);
  if (current) return current;

  // The sequence is advisory: a hard check never depends on it, and it never vetoes. An unusable
  // record value is accepted, logged once, and neither stored nor allowed to replace the memory.
  const usableSequence = Number.isSafeInteger(value.sequence) && value.sequence >= 0;
  const sequence = usableSequence ? value.sequence : null;
  if (!usableSequence) {
    log("record sequence is not a usable number; accepted because the hard checks passed");
    return { state: "ready", dir, generation, sequence: null };
  }
  const memory = memoryPath ? readMemory(io, memoryPath) : undefined;
  const remember = () => {
    if (readOnly || !memoryPath || typeof io.writeAtomic !== "function") return;
    try {
      io.writeAtomic(memoryPath, `${sequence}\n`);
    } catch {
      // The number is advisory; a state write that fails must not refuse a good launch.
    }
  };
  if (memory === undefined) {
    log(`record sequence ${sequence} accepted`);
    remember();
  } else if (memory > sequence) {
    log(BACKWARDS_LINE);
    remember();
  } else {
    remember();
  }
  return { state: "ready", dir, generation, sequence };
}
