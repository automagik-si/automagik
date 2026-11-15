// The briefing hook's fixed entry point (Group 6b). The pack copies this file to
// <app home>/automagik-herdr/briefing.mjs, outside mods/, and every Claude bot's and worker's
// hook runs that copy; the am part (RFC 0012) puts a link there to its own copy instead, so the
// app home is the folder the hook named (argv[1]), never this file's real place. It
// runs the first briefing.mjs it can: am's (<AM_HOME, else ~/.automagik>/parts/automagik.am/
// current/) when its VERSION is at least the installed sidebar's, then the sidebar folder's
// (mods/am-sidebar, else mods/spaces-agents), and am's last when it is older: an am that stopped
// updating never shadows a newer pack's briefing (t259's review). So a
// hook survives the sidebar being switched off, the folder's rename and a rollback across it. A
// copy that is missing, or whose import throws, is passed over for the next one: a broken am never
// silences a briefing. So that the next one starts clean, the hook's stdin (Claude Code's JSON) is
// read once here and replayed to each attempt, and each attempt's stdout is held and printed only
// when its import succeeds: a failed attempt prints nothing, whatever it wrote before it threw.
// Nor does it change what this conversation's records say it has seen (under
// <app home>/automagik-herdr/briefed/, BRIEFED_DIR): this hook's own records (its session_id's,
// and this terminal's pane records) are read before an attempt and put back byte for byte after
// it fails, or removed when they were not there before. The next copy then decides as the turn
// began: it prints the briefing a failed attempt dropped, and nothing when it was seen already.
// Other panes' records are never touched.
// am's copy lives outside the app home, so it is told the app home (HERDR_APP_HOME, when unset)
// that a sidebar copy finds from its own place. briefing.mjs runs only as the program node
// started, so the script becomes argv[1] before it is imported (env and exit code stay this
// process's). Fail-open like briefing.mjs: none found, nothing printed, exit 0. The installer, the
// updater and am replace the copy; edits to it are lost. Apache-2.0.

import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

// node resolves a link to its target for import.meta.url, but argv[1] keeps the path the hook ran.
const appHome = dirname(dirname(process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url)));
const amHome = process.env.AM_HOME || join(homedir(), ".automagik");
const copies = [
  { path: join(amHome, "parts", "automagik.am", "current", "briefing.mjs"), am: true },
  ...["am-sidebar", "spaces-agents"].map((m) => ({ path: join(appHome, "mods", m, "briefing.mjs"), am: false })),
];
const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

/** A copy's VERSION as [major, minor, patch], or null when it has none it can read. */
const versionOf = (script) => {
  try {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(readFileSync(join(dirname(script), "VERSION"), "utf8").trim());
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
};
/** Whether `a` is at least `b`: an unknown sidebar version never outranks am, an unknown am's always loses. */
const atLeast = (a, b) => {
  if (!b) return true;
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
const sidebar = copies.slice(1).find((c) => existsSync(c.path));
if (sidebar && existsSync(copies[0].path) && !atLeast(versionOf(copies[0].path), versionOf(sidebar.path))) copies.push(copies.shift());

// The hook's stdin, all of it, as briefing.mjs reads it: none from a terminal, at most 300 ms for a
// caller that never closes it (Claude Code closes it at once), at most 1 MB.
const tty = Boolean(process.stdin.isTTY);
const input = tty ? Buffer.alloc(0) : await new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  let timer = null;
  const done = () => { clearTimeout(timer); process.stdin.removeAllListeners("data"); process.stdin.destroy(); resolve(Buffer.concat(chunks)); };
  timer = setTimeout(done, 300);
  process.stdin.on("data", (d) => { chunks.push(d); size += d.length; if (size > 1_000_000) done(); });
  process.stdin.on("end", done);
  process.stdin.on("error", done);
});

/** A fresh stdin for one attempt: the same bytes, then the end. */
function replay() {
  const stream = new Readable({ read() { this.push(input); this.push(null); } });
  stream.isTTY = tty;
  return stream;
}

// This hook's own records, as briefing.mjs names them (briefedPath): its conversation's
// (<session_id>.json) and this terminal's pane records (<terminal>@<created>.json when the hook
// has no session_id, pane-<terminal>@<created>.json), every character outside [A-Za-z0-9._-] an _.
const recordName = (key) => String(key).replace(/[^A-Za-z0-9._-]/g, "_");
const session = (() => {
  try { const x = JSON.parse(input.toString("utf8")); return typeof x?.session_id === "string" && x.session_id ? x.session_id : null; }
  catch { return null; }
})();
const terminal = process.env.HC_TERMINAL_ID ? recordName(process.env.HC_TERMINAL_ID) : null;
function ownRecords(dir) {
  const names = session ? [`${recordName(session)}.json`] : [];
  if (!terminal) return names;
  let all = [];
  try { all = readdirSync(dir); } catch { /* none yet */ }
  const prefixes = session ? [`pane-${terminal}_`] : [`${terminal}_`, `pane-${terminal}_`];
  return names.concat(all.filter((n) => n.endsWith(".json") && prefixes.some((p) => n.startsWith(p))));
}
/** This hook's records as they are now: name → bytes, null for one not there. */
function keep() {
  const dir = join(process.env.HERDR_APP_HOME || appHome, "automagik-herdr", "briefed");
  const kept = new Map();
  for (const name of ownRecords(dir)) {
    try { kept.set(name, readFileSync(join(dir, name))); } catch { kept.set(name, null); }
  }
  return { dir, kept };
}
/** Puts this hook's records back as `keep` found them (whole files, tmp then rename, like writeSeen). */
function putBack({ dir, kept }) {
  for (const name of new Set([...kept.keys(), ...ownRecords(dir)])) {
    const path = join(dir, name), tmp = `${path}.${process.pid}.tmp`, was = kept.get(name) ?? null;
    try {
      rmSync(tmp, { force: true });
      if (was === null) { rmSync(path, { force: true }); continue; }
      let now = null;
      try { now = readFileSync(path); } catch { /* gone */ }
      if (now?.equals(was)) continue;
      writeFileSync(tmp, was, { mode: 0o600 });
      renameSync(tmp, path);
    } catch { /* fail open: at worst the briefing comes again next turn */ }
  }
}

const write = process.stdout.write;
for (const copy of copies) {
  let target;
  try { target = realpathSync(copy.path); } catch { continue; }
  const before = process.env.HERDR_APP_HOME;
  if (copy.am && !before) process.env.HERDR_APP_HOME = appHome;
  process.argv[1] = target;
  Object.defineProperty(process, "stdin", { value: replay(), configurable: true, writable: true });
  const held = [];
  process.stdout.write = (chunk, encoding, callback) => {
    held.push(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  let ok = false;
  const kept = keep();
  try {
    await import(pathToFileURL(target).href);
    ok = true;
  } catch (e) {
    process.stderr.write(`am briefing: ${firstLine(e)}\n`);
    putBack(kept);
    if (copy.am && !before) delete process.env.HERDR_APP_HOME;
    process.exitCode = 0;
  } finally {
    process.stdout.write = write;
  }
  if (ok) {
    if (held.length) process.stdout.write(Buffer.concat(held));
    break;
  }
}
