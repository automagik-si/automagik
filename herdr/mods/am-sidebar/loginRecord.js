// The Bot login generation reader (#1509, design note rev 5): one function, resolveLogin(vendor),
// called at launch. ACP writes one record beside its per-vendor pointers; this module reads it and
// the folder it names, and never copies, exports or creates a login. Everything filesystem-shaped
// is injected (`io`), so the rows run on scratch homes and a fake writer with no real login.
//
// Reads only: the record, this vendor's pointer, lstat of the named folder, the pointer's
// .activated marker, and this installation's sequence memory. Never a credential file, never a
// network call. Refusals carry a stable code and one effect-only sentence, no path and no account.
// Apache-2.0.

/** The pointer file's location, as ACP's own children receive it; the entrypoint exports it. */
export const POINTER_VAR = "AUTOMAGIK_BOT_CLI_POINTER";
/** The pilot's marker: set, a launch without a usable pointer and record must refuse. */
export const REQUIRED_VAR = "AUTOMAGIK_NATIVE_WORKER_LOGIN";
export const REQUIRED_VALUE = "required";
/** The only sentence a refusal shows; the code is the machine-readable half. */
export const REFUSAL_REASON = "The Bot login record is missing or out of date; sign in again.";
/** The vendors this reader serves; any other agent's launch is unchanged. */
export const VENDORS = Object.freeze(["claude", "codex"]);
/** The one config variable each vendor reads its login from; the launch sets only that one. */
export const VENDOR_VAR = Object.freeze({ claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" });
/** The vendor's config variable, or null for an agent this reader does not serve. */
export const loginVar = (vendor) => (typeof vendor === "string" && Object.hasOwn(VENDOR_VAR, vendor) ? VENDOR_VAR[vendor] : null);
/** The env words a launch on the resolved folder carries. */
export const loginWords = (vendor, dir) => (loginVar(vendor) ? [`${loginVar(vendor)}=${dir}`] : []);
/** The record field each vendor's folder is named in. */
export const VENDOR_FIELD = Object.freeze({ claude: "configDir", codex: "home" });
/** The one log line a backwards (advisory) sequence must produce, verbatim. */
export const BACKWARDS_LINE = "record sequence went backwards; accepted because the generation matches the pointer";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const refusal = (code) => ({ code, reason: REFUSAL_REASON });

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
 * object, and `io.writeAtomic(path, text)` replaces the sequence memory in one step, mode 0600.
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
  const pointer = typeof env[POINTER_VAR] === "string" ? env[POINTER_VAR].trim() : "";
  const required = env[REQUIRED_VAR] === REQUIRED_VALUE;
  if (!pointer) return required ? refusal("login-required") : { state: "absent" };
  if (!pointer.startsWith("/") || /[\u0000-\u001f\u007f]/.test(pointer)) return refusal("pointer-invalid");

  const current = dirnameOf(pointer);
  const recordPath = joinPath(current, "generation.json");
  const record = readRecord(io, recordPath);
  if (record.code) return refusal(record.code);
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    return refusal("record-version");
  }
  const field = value[vendor];
  if (field === null || field === undefined) return refusal("vendor-null");
  if (typeof field !== "object" || Array.isArray(field)) return refusal("vendor-invalid");
  const generation = field.generation;
  if (typeof generation !== "string" || !UUID_V4.test(generation)) return refusal("generation-invalid");
  const dir = field[VENDOR_FIELD[vendor]];
  if (typeof dir !== "string" || !dir.startsWith("/") || dir === "/" || /[\u0000-\u001f\u007f]/.test(dir)) {
    return refusal("path-invalid");
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) return refusal("sequence-invalid");

  const pointerPath = joinPath(current, vendor);
  const pointerRead = readText(io, pointerPath);
  if (pointerRead.error) {
    const activated = lstatOf(io, `${pointerPath}.activated`);
    return refusal(activated === undefined ? "pointer-missing" : "pointer-missing-activated");
  }
  if (String(pointerRead.text).trim() !== generation) return refusal("generation-mismatch");

  const folder = lstatOf(io, dir);
  if (folder === undefined) return refusal("folder-missing");
  if (folder.isSymbolicLink?.()) return refusal("folder-link");
  if (!folder.isDirectory?.()) return refusal("folder-not-directory");
  if ((Number(folder.mode) & 0o777) !== 0o700) return refusal("folder-mode");

  // The sequence is advisory: a hard check never depends on it, and it never vetoes.
  const memory = memoryPath ? readMemory(io, memoryPath) : undefined;
  const remember = () => {
    if (readOnly || !memoryPath || typeof io.writeAtomic !== "function") return;
    try {
      io.writeAtomic(memoryPath, `${value.sequence}\n`);
    } catch {
      // The number is advisory; a state write that fails must not refuse a good launch.
    }
  };
  if (memory === undefined) {
    log(`record sequence ${value.sequence} accepted`);
    remember();
  } else if (memory > value.sequence) {
    log(BACKWARDS_LINE);
    remember();
  } else {
    remember();
  }
  return { state: "ready", dir, generation, sequence: value.sequence };
}
