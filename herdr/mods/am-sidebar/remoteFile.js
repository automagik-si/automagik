// A text file on another machine (automagik#206: a linked machine's .herdr/bots.json), read and
// written through herdr-core with the rule a local edit follows: the write lands only while the
// file still holds the text the edit started from (null: there was no file), else nothing is
// written and the caller is told the snapshot is stale.
//
//   read     hc file read --on M <path>: the text; not_found is "no file" (null), any other
//            answer (the machine away, unknown, too old) throws, so a failure never reads as
//            "no file yet" and a create never replaces a file that is there.
//   replace  hc file edit --on M --old <the whole text read> --new <the whole new text>: the
//            core makes the edit only when the old text is in the file exactly once, so a file
//            changed since the read is refused there, not here (a file holding the old text
//            once and more besides would be the old JSON with text around it, not a bots file).
//   create   a shell there (exec on M): the folder made, then the file opened with noclobber
//            (O_EXCL), so a file that appeared since the read is never replaced; a write that
//            fails after that open removes the file it made.
//   after    an edit or create whose answer was lost may have landed there. herdr-core has no
//            timeout kind: a link that drops mid-call answers `unavailable`, as does the machine
//            away, so that, a timeout, no readable answer or Herdr's exec rejecting all count
//            as lost (only an unknown machine, a needed update or a bad call can't have written): the file is read again, and one that holds the new
//            text is a success. A caller can also opt to recognize the original text as unchanged.
//            Otherwise the state there is unknown, and the caller is told to check
//            the file before retrying (a retried create would add the bot twice).
//   remove   a shell there: the file removed only while it still holds the text read.
//
// Pure: `io` is { hc(args), exec(command, args, machine) }, each resolving { code, stdout,
// stderr } (exec may reject when the machine can't be reached). The sidebar passes Herdr's hc
// and exec, the CLI its own. Apache-2.0.

/**
 * The most text one argument may carry, in UTF-8 bytes: the old and new text travel as
 * arguments, and Linux refuses any one over 128 KiB (MAX_ARG_STRLEN).
 */
export const REMOTE_TEXT_MAX = 96 * 1024;

/** A string's length in UTF-8 bytes (no Buffer or TextEncoder: Herdr loads this file too). */
export function utf8Length(text) {
  let n = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
const tooLarge = (path, machine) => new RemoteFileError(
  `${path} would be over ${REMOTE_TEXT_MAX / 1024} KiB, too large to send to ${machine} in one write; make the file smaller (its instructions, most likely)`, "too_large");

/**
 * A failure reaching or using the file there; `kind` is herdr-core's error kind when it gave
 * one, "unknown_state" when a write may or may not have landed (the message starts "State
 * unknown:").
 */
export class RemoteFileError extends Error {
  constructor(message, kind = "unknown") { super(message); this.kind = kind; }
}
/** The file changed (or appeared, or went) since it was read: nothing was written. */
export class StaleSnapshot extends RemoteFileError {
  constructor(message) { super(`stale snapshot: ${message}`, "stale"); }
}

// herdr-core's error, from what it printed (stderr, else stdout): { kind, message }.
function errorOf(r) {
  for (const text of [r?.stderr, r?.stdout]) {
    try {
      const e = JSON.parse(String(text ?? "").trim())?.error;
      if (e && typeof e === "object") return { kind: typeof e.kind === "string" ? e.kind : "unknown", message: String(e.message ?? e.kind ?? "failed") };
    } catch { /* not JSON */ }
  }
  const said = String(r?.stderr || r?.stdout || "").trim().split("\n")[0];
  return { kind: "unknown", message: said || `exit ${r?.code}` };
}

const away = (machine, why) => new RemoteFileError(`${machine} can't be reached: ${why}`, "unavailable");
// herdr-core's refusals that come before anything is written there (not `unavailable`: a link
// that drops mid-call says that too).
const NOT_SENT = new Set(["machine_unknown", "needs_update", "invalid_params"]);

/** The file's text on `machine`, or null when there is no such file. Throws RemoteFileError. */
export async function readRemoteText(io, machine, path) {
  let r;
  try { r = await io.hc(["file", "read", "--json", "--on", machine, path]); } catch (e) { throw away(machine, e?.message ?? e); }
  if (r.code !== 0) {
    const e = errorOf(r);
    if (e.kind === "not_found") return null;
    throw new RemoteFileError(`${machine}: can't read ${path}: ${e.message}`, e.kind);
  }
  let answer;
  try { answer = JSON.parse(r.stdout); } catch { throw new RemoteFileError(`${machine}: hc file read printed no JSON for ${path}`); }
  if (typeof answer?.text !== "string") throw new RemoteFileError(`${machine}: hc file read gave no text for ${path}`);
  // Read whole or not at all: a file past hc's cap comes back cut short.
  if (Number.isInteger(answer.lines) && Number.isInteger(answer.last) && answer.last < answer.lines) {
    throw new RemoteFileError(`${machine}: ${path} is too large to read whole`, "too_large");
  }
  return answer.text;
}

// One shell line there. Its exit codes: 0 done, 17 the snapshot is stale, anything else failed.
const STALE = 17;
async function shell(io, machine, script, args) {
  let r;
  try { r = await io.exec("sh", ["-c", script, "sh", ...args], machine); } catch (e) { throw away(machine, e?.message ?? e); }
  return r;
}

// Make the folder, then create the file only if it isn't there (noclobber opens it O_EXCL).
// The open (noclobber: O_EXCL) and the write apart, so a write that fails removes only the file
// this line made, and a file someone else made is never touched.
const CREATE_SH = 'p=$1; d=${p%/*}; [ -n "$d" ] || d=/; mkdir -p -- "$d" || exit 1; '
  + 'if [ -e "$p" ] || [ -L "$p" ]; then exit 17; fi; set -C; '
  + '{ : > "$p"; } 2>/dev/null || { if [ -e "$p" ]; then exit 17; fi; exit 1; }; '
  + 'printf "%s" "$2" >| "$p" || { rm -f -- "$p"; exit 1; }';
// Remove the file only while it holds $2 (the `x` keeps trailing newlines through $(...)).
const REMOVE_SH = '[ -f "$1" ] || exit 17; now=$(cat -- "$1"; printf x) || exit 1; '
  + '[ "$now" = "${2}x" ] || exit 17; rm -f -- "$1"';

/**
 * Writes `text` as the file on `machine` while it still holds `expected` (null: while there is
 * none). Rejects StaleSnapshot when it doesn't (nothing written), RemoteFileError on any other
 * failure. Resolves null.
 */
export async function writeRemoteText(io, machine, path, text, expected, { confirmUnchanged = false } = {}) {
  if (expected === undefined) throw new Error("writeRemoteText: pass the text the edit started from (null for a new file)");
  if (typeof text !== "string") throw new Error("writeRemoteText: the text to write is a string");
  if (utf8Length(expected ?? "") > REMOTE_TEXT_MAX || utf8Length(text) > REMOTE_TEXT_MAX) throw tooLarge(path, machine);
  // An empty file has nothing for the core to find; it isn't a bots file either.
  if (expected === "") throw new RemoteFileError(`${path} on ${machine} is empty; fix it by hand first`, "empty");
  let failure;
  if (expected === null) {
    // Herdr's exec rejecting may be a link dropped mid-call: read back like any lost answer.
    const r = await shell(io, machine, CREATE_SH, [path, text]).catch((e) => ({ code: -1, thrown: e }));
    if (r.code === 0) return null;
    if (r.code === STALE) throw new StaleSnapshot(`${path} appeared on ${machine} since it was read`);
    const e = r.thrown ? { kind: "unavailable", message: r.thrown.message } : errorOf(r);
    failure = new RemoteFileError(`${machine}: couldn't create ${path}: ${e.message}`, e.kind);
    // The script's own failure (exit 1, the file it made removed) or a refusal: not written.
    if (r.code > 0 || NOT_SENT.has(e.kind)) throw failure;
  } else {
    let r;
    try { r = await io.hc(["file", "edit", "--json", "--on", machine, `--old=${expected}`, `--new=${text}`, path]); } catch (e) { throw away(machine, e?.message ?? e); }
    if (r.code === 0) return null;
    const e = errorOf(r);
    if (e.kind === "edit_failed") throw new StaleSnapshot(`${path} on ${machine} changed since it was read`);
    if (e.kind === "not_found") throw new StaleSnapshot(`${path} on ${machine} is gone since it was read`);
    failure = new RemoteFileError(`${machine}: couldn't write ${path}: ${e.message}`, e.kind);
    if (NOT_SENT.has(e.kind)) throw failure;
  }
  // The answer was lost: it may have landed. The file says.
  let now;
  try { now = await readRemoteText(io, machine, path); } catch { now = undefined; }
  if (now === text) return null;
  if (confirmUnchanged && now === expected) {
    throw new RemoteFileError(`${failure.message}; read-back found the original text`, "unchanged");
  }
  throw new RemoteFileError(`State unknown: ${failure.message}. The write may or may not have landed; `
    + `check ${path} on ${machine} before trying again.`, "unknown_state");
}

/** Removes the file on `machine` while it still holds `expected`. Rejects as writeRemoteText. */
export async function removeRemoteText(io, machine, path, expected) {
  if (typeof expected !== "string") throw new Error("removeRemoteText: pass the text read");
  if (utf8Length(expected) > REMOTE_TEXT_MAX) throw tooLarge(path, machine);
  const r = await shell(io, machine, REMOVE_SH, [path, expected]);
  if (r.code === STALE) throw new StaleSnapshot(`${path} on ${machine} changed since it was read`);
  if (r.code !== 0) throw new RemoteFileError(`${machine}: couldn't remove ${path}: ${errorOf(r).message}`);
  return null;
}
