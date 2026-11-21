// The Bot login generation reader (#1509, design note rev 5): one function, resolveLogin(vendor),
// called at launch. ACP writes one record beside its per-vendor pointers; this module reads it and
// the folder it names, and never copies, exports or creates a login. Everything filesystem-shaped
// is injected (`io`), so the rows run on scratch homes and a fake writer with no real login.
//
// Reads only: the record, this vendor's pointer, folder and marker stats, login-tree names, and this
// installation's sequence memory. Never a credential file, never a
// network call. Refusals carry a stable code and one effect-only sentence, no path and no account.
// Apache-2.0.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { POINTER_VAR, VENDORS, loginRequired } from "./loginWords.js";
export * from "./loginWords.js";

/** The only sentence a refusal shows; the code is the machine-readable half. */
const REFUSAL_REASON = "The Bot login record is missing or out of date; sign in again.";
/** The record field each vendor's folder is named in. */
const VENDOR_FIELD = Object.freeze({ claude: "configDir", codex: "home" });
/** The one log line a backwards (advisory) sequence must produce, verbatim. */
export const BACKWARDS_LINE = "record sequence went backwards; accepted because the generation matches the pointer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const refusal = (code) => ({ code, reason: REFUSAL_REASON });
export const loginReadIo = {
  read: (path) => readFileSync(path, "utf8"),
  lstat: lstatSync,
  readdir: readdirSync,
  openClaim: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)),
};

/** ACP's config folder inside a vendor home (apps/acp-dsh/src/host/cli-homes.js environment). */
const VENDOR_CONFIG_DIR = Object.freeze({ claude: ".claude", codex: ".codex" });
const CLAIM_LIMIT = 4096;
const retryWait = new Int32Array(new SharedArrayBuffer(4));
const regularClaim = (stat) => stat.isFile() && stat.size <= CLAIM_LIMIT;

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

/** Match ACP's installation claim read, including its descriptor and byte limit. */
function readClaim(io, path) {
  if (!regularClaim(io.lstat(path))) return null;
  const fd = (io.openClaim ?? loginReadIo.openClaim)(path);
  try {
    if (!regularClaim(fstatSync(fd))) return null;
    const bytes = Buffer.alloc(CLAIM_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > CLAIM_LIMIT) return null;
    let claim;
    try { claim = JSON.parse(bytes.toString("utf8", 0, length)); } catch { return null; }
    return claim?.version === 1 && typeof claim.identity === "string" && isAbsolute(claim.identity)
      && !claim.identity.includes("\0") ? claim.identity : null;
  } finally { closeSync(fd); }
}

/** Undefined means absent, null means unusable, as in ACP's root selection. */
function claimIdentity(io, path) {
  for (let retry = 0; ; retry += 1) {
    try { return readClaim(io, path); } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (retry === 3) return null;
      Atomics.wait(retryWait, 0, 0, 10);
    }
  }
}

/**
 * The panel's sign-in root for this DSH home, decided at launch as acp-dsh's installationCliHome
 * decides it (#1769), read-only: the shared <acp>/cli-homes when its claim names this DSH home,
 * else <acp>/installations/<digest>/cli-homes. The panel has started and published its claim by
 * the time a worker launches, so an absent claim here is no longer the panel's to take: refused.
 */
export function panelRoot(acpHome, dshHome, io) {
  const shared = joinPath(acpHome, "cli-homes");
  const identity = installationIdentity(dshHome, io);
  const claimed = claimIdentity(io, joinPath(shared, "installation.json"));
  if (claimed === undefined) return null;
  if (claimed === identity) return shared;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return joinPath(joinPath(joinPath(acpHome, "installations"), digest), "cli-homes");
}

/** The ACP home a cli-homes root lives in: <acp>/cli-homes or <acp>/installations/<d>/cli-homes. */
function acpHomeOf(root) {
  if (root.split("/").pop() !== "cli-homes") return null;
  const parent = dirnameOf(root);
  const grand = dirnameOf(parent);
  return grand.split("/").pop() === "installations" && /^[a-f0-9]{32}$/.test(parent.split("/").pop())
    ? dirnameOf(grand) : parent;
}

/**
 * Whether the pointer's root is the panel's own. With DSH_HOME (the entrypoint exports it beside
 * the pointer) the decision is retaken now and any difference refuses. Without it the pointer is
 * the one ACP put in its own Bot's env; with the pilot marker that cannot be told apart, so it
 * refuses. Returns null when verified, or the refusal.
 */
function rootProblem(root, env, required, io) {
  const acp = acpHomeOf(root);
  if (Object.hasOwn(env, "AUTOMAGIK_HOME") && acp !== joinPath(resolve(env.AUTOMAGIK_HOME || "/data"), "acp")) {
    return refusal("installation-mismatch");
  }
  const dshHome = typeof env.DSH_HOME === "string" ? env.DSH_HOME : "";
  if (!dshHome.trim()) return required ? refusal("installation-unknown") : null;
  if (!acp || panelRoot(acp, dshHome, io) !== root) return refusal("installation-mismatch");
  return null;
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
  const problem = rootProblem(root, env, required, io);
  if (problem) return problem;
  const recordPath = joinPath(current, "generation.json");
  const record = readRecord(io, recordPath);
  if (record.code) return refusal(record.code);
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    return refusal("record-version");
  }
  const field = value[vendor];
  if (field === undefined) return refusal("vendor-null");
  if (field === null) {
    // The panel's own root (verified above) on a login from before any generation: the same
    // account the panel uses, so it launches; anything ACP would not call legacy refuses.
    const dir = legacyDir(io, root, vendor);
    if (dir === null) return refusal("vendor-null");
    return ready(io, { dir, generation: "legacy", value, memoryPath, log, readOnly });
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
  return ready(io, { dir, generation, value, memoryPath, log, readOnly });
}

/** The folder's hard checks, then the advisory sequence; the launch's resolved login. */
function ready(io, { dir, generation, value, memoryPath, log, readOnly }) {
  // The sequence is advisory: an unusable record value is "no usable memory", never a refusal.
  const usableSequence = Number.isSafeInteger(value.sequence) && value.sequence >= 0;
  const sequence = usableSequence ? value.sequence : null;
  const folder = lstatOf(io, dir);
  if (folder === undefined) return refusal("folder-missing");
  if (folder.isSymbolicLink?.()) return refusal("folder-link");
  if (!folder.isDirectory?.()) return refusal("folder-not-directory");
  if ((Number(folder.mode) & 0o777) !== 0o700) return refusal("folder-mode");
  const home = dirnameOf(dir);
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

  // The sequence is advisory: a hard check never depends on it, and it never vetoes. An unusable
  // record value is accepted, logged once, and neither stored nor allowed to replace the memory.
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
