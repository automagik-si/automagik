// The briefing hook for a Claude bot (DESIGN Approach "Group 3", Decision 9, A1, A3).
// Claude Code runs it on UserPromptSubmit from the per-person hook Start and Attach write
// in the session's .claude/settings.local.json; whatever it prints reaches the agent as
// context. Never every turn: a bot Start or Restart launched has its briefing in its system
// prompt (--append-system-prompt-file, models.js), so the hook prints nothing for it; a pane it
// couldn't launch so (Attach on a running pane, a bot started before this pack, a resumed
// conversation whose recorded system prompt predates the file) gets it once, on its first turn,
// and again only when the launch text changes or Claude compacted the conversation
// (briefingText.mjs shouldBrief; what it printed is kept per terminal under the app home). Plain node, outside Herdr: it imports no `herdr` or `gpui`, only the pack's pure
// modules. Fail-open: it prints nothing and exits 0 unless the attach ledger (attach.js) ties
// HC_TERMINAL_ID's terminal to a bot defined in the project $CLAUDE_PROJECT_DIR keys to; on an
// error it prints one stderr line and still exits 0. It only reads the ledger (the CLI alone
// writes it); before the CLI's first run has made one, the `bot` label stands in.
// It also ties a Claude session to its terminal for usagemeter, bot or worker alike: when the
// hook's stdin names a session_id the terminal's agent.session label doesn't hold yet, it
// appends a session row to the workers ledger and sets the label (once per change). Beside it
// goes agent.transcript, the hook's transcript_path, only when it is inside Claude's own
// transcript folder (transcriptFolder.mjs); a pane labelled before that gets it at its next
// prompt, with no second row. That part never fails the hook and never changes the briefing.
// Apache-2.0.

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync, writeSync }
  from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOT_LABEL, BOTS_PATH, collectProjectMap, effectiveLead, parseBots, projectKeyOf } from "./model.js";
import { UNANSWERED, paneOf, rowsOf, unwrapKeep, waitsOnPermission } from "./launchArgs.js";
import { attachKey, attachPath, confirmBindings, foldAttach, modeProblem, readAttach, verdictOf } from "./attach.js";
import { botOfBriefingFile, briefDecision, briefedPath, briefingText, directMembers, latestReport, launchBriefingText, textHash }
  from "./briefingText.mjs";
import { briefingFileOf, resumedSessionOf } from "./models.js";
import { LEDGER_MODE, SESSION_LABEL, TRANSCRIPT_LABEL, ledgerLine, ledgerPath, readLedger, sessionChange, sessionRow }
  from "./workers.js";
import { transcriptRealPath } from "./transcriptFolder.mjs";

// About two seconds in all (the hook's limit is ten seconds): no hc call waits more than 1.5 s,
// none starts after the 2 s budget, a call that runs out (or fails) counts as unreachable,
// and a last guard ends the process silently at 2.4 s. One away machine can't hold the prompt.
// The clock starts when the script runs as the hook, not when another program imports it.
// HERDR_BRIEFING_TIME_SCALE (a whole number, 1 to 10) multiplies all three: the tests' slow
// fakes run on loaded machines. It only ever lengthens them; unset, the times are as above.
export const BUDGET_MS = 2000;
export const CALL_MS = 1500;
export const GUARD_MS = 2400;
export const timeScale = (raw) => (/^([1-9]|10)$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim()) : 1);
let until = Infinity;
let callMs = CALL_MS;

const MAX_HELPERS = 30;
let hcMissing = false;

// A program's run: { err, stdout, stderr } (err null when it exited 0), or UNANSWERED when it
// ran out of time.
function exec(command, args, cwd) {
  const timeout = Math.min(callMs, until - Date.now());
  if (timeout <= 0) return Promise.resolve(UNANSWERED);
  return new Promise((resolve) => {
    try {
      execFile(command, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err.killed || err.signal === "SIGTERM")) return resolve(UNANSWERED);
        if (err?.code === "ENOENT" && command === "hc") hcMissing = true;
        resolve({ err, stdout, stderr });
      });
    } catch (err) { resolve({ err, stdout: "", stderr: "" }); }
  });
}
// A program's stdout; null when it failed or is missing; UNANSWERED when it ran out of time.
async function run(command, args, cwd) {
  const r = await exec(command, args, cwd);
  return r === UNANSWERED ? r : r.err ? null : r.stdout;
}
// Whether a failed hc run is hc's own not_found (exit 3, or error.kind in its JSON), as the
// CLI's hcLookup reads it: the one failure that says "no such terminal".
function notFound({ err, stdout, stderr }) {
  if (err.code === 3) return true;
  try { return JSON.parse(stderr || stdout)?.error?.kind === "not_found"; } catch { return false; }
}
// `hc <args> --json`, parsed (launchArgs.js paneOf's `ask`): null only when hc answers
// not_found (or is missing); any other failure, or no JSON, is UNANSWERED, as a run out of time
// is: a failed read never reads as "no pane" (#345), the same as the CLI's `brief`.
async function hcJson(args) {
  const r = await exec("hc", [...args, "--json"]);
  if (r === UNANSWERED) return r;
  if (r.err) return hcMissing || notFound(r) ? null : UNANSWERED;
  try { return JSON.parse(r.stdout); } catch { return UNANSWERED; }
}

const git = async (args, cwd) => { const out = await run("git", args, cwd); return out === UNANSWERED ? null : out; };
/** Whether a guard folder is on this pane's PATH: its hc entry has ../hcGuard.mjs beside it. */
const guardOnPath = (path) => String(path ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, "..", "hcGuard.mjs")));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

/**
 * The briefing of `bot` in `file`, gathered through `ask` (launchArgs.js paneOf's contract:
 * parsed `hc … --json`, null on failure, UNANSWERED when out of time). `address` is the bot's
 * own live terminal, whose unlabelled children are its helpers (null: no helpers counted).
 * Shared with the CLI's `am brief`.
 */
export async function gatherBriefing({ file, bot, address, ask, locate = (id) => paneOf(id, ask), guard = null, isGit = true, project = null, projects = null }) {
  const team = directMembers(file, bot.id, { project, projects });
  const eff = bot.kind === "member" || bot.leadProject
    ? effectiveLead(file, bot.id, { project, projects })
    : { lead: "", leadProject: null, leadBot: null, warning: null };
  const leadBot = eff.leadBot ?? (eff.lead && !eff.leadProject ? file.bots.find((b) => b.id === eff.lead) : null);

  // One `hc ls` for the helpers (its rows carry parent and status), one label query per
  // team bot; `hc get` only for the bot panes found and the children no query named.
  const [all, panes, leadPane] = await Promise.all([
    address ? ask(["ls"]) : null,
    Promise.all(team.map((m) => locate(m.id))),
    leadBot ? locate(leadBot.id) : null,
  ]);
  const known = new Set([...panes, leadPane].flatMap((p) => p?.addresses ?? []));
  const [members, helpers] = await Promise.all([
    Promise.all(team.map(async (m, i) => {
      const p = panes[i];
      if (p.unreachable) return { bot: m, unreachable: true };
      if (!p.get) return { bot: m };
      return { bot: m, terminal: p.get.address, status: p.get.status?.state, permission: waitsOnPermission(p.get.status), report: await latestReport(p.get, ask) };
    })),
    helpersOf(all, address, known, ask),
  ]);
  const lead = leadBot
    ? { bot: leadBot, terminal: leadPane?.get?.address ?? "", status: leadPane?.get?.status?.state, permission: waitsOnPermission(leadPane?.get?.status), unreachable: Boolean(leadPane?.unreachable) }
    : undefined;
  return briefingText({ self: bot, file, members, lead, helpers, guard, isGit });
}

/**
 * The attach ledger under `appHome`, read only, through `ask`: null when there is no file
 * yet; a group- or world-writable one throws. Resolves { botAt(get), locate(botId) }:
 * botAt is the bot a terminal's `hc get` plays (null: none), locate a bot's pane in
 * paneOf's shape, each binding confirmed with `hc get` (live, the same created_ms) on demand.
 */
export async function ledgerOf(appHome, ask) {
  const path = attachPath(appHome);
  let st;
  try { st = statSync(path); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; }
  const why = modeProblem(path, st.mode);
  if (why) throw new Error(why);
  const { byBot, byKey } = foldAttach(readAttach(readFileSync(path, "utf8")).rows);
  const status = await ask(["server", "status"]);
  const core = status && status !== UNANSWERED ? status.core?.id : null;
  if (typeof core !== "string" || !core) throw new Error("hc server status gave no core id");
  const none = { get: null, duplicate: false, addresses: [], gets: [] };
  return {
    botAt: (get) => {
      const b = get && typeof get === "object" ? byKey.get(attachKey({ core, terminal: get.address, created_ms: get.created_ms })) : null;
      return b && verdictOf(b, get) === "live" ? b.bot : null;
    },
    locate: async (botId) => {
      const b = byBot.get(botId);
      if (!b) return none;
      const { live, unknown } = await confirmBindings([b], core, ask, UNANSWERED);
      if (unknown.length) return { ...none, addresses: [b.terminal], unreachable: true };
      if (!live.length) return none;
      const get = { ...live[0].get, address: live[0].get.address ?? b.terminal };
      return { get, duplicate: false, addresses: [get.address], gets: [get] };
    },
  };
}

// `me`: the pending `hc get` of HC_TERMINAL_ID, `input` the hook's parsed stdin, both shared
// with joinSession. Resolves { text, record } (record: what to keep once the text is out), or null.
async function main(mePending, inputPending, appHome) {
  const self = process.env.HC_TERMINAL_ID;
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (!self || !dir) return null;
  const [me, key] = await Promise.all([mePending, projectKeyOf(dir, git, exists)]);
  if (hcMissing) throw new Error("hc is not on PATH");
  if (!me || me === UNANSWERED) return null;
  const terminal = me.address ?? self;
  const argv = unwrapKeep(me.foreground?.argv);
  const started = briefingFileOf(argv);
  const ledger = await ledgerOf(appHome, hcJson);
  const botId = ledger ? ledger.botAt({ ...me, address: terminal }) : me.labels?.[BOT_LABEL];
  if (!botId) return null;
  // Started with this bot's own briefing file: its text is what the system prompt was given.
  // A file gone since (deleted) says nothing about that text: the pane counts as not started with it.
  const own = Boolean(started) && botOfBriefingFile(started) === botId;
  const startedHash = own ? launchedHash(started) : null;
  const covered = startedHash !== null;
  const input = await inputPending;
  const session = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
  const paneKey = `${terminal}@${me.created_ms ?? 0}`;
  // Resumed: the command resumes this very conversation. Claude Code keeps a resumed
  // conversation's id (`--fork-session` makes a new one, with the old record): another id is a
  // new conversation since (/clear), with a new prompt. --continue names no id, so the one it
  // resumed is the first this pane saw.
  const was = covered ? resumedSessionOf("claude", argv) : undefined;
  const forked = Array.isArray(argv) && argv.includes("--fork-session");
  const resumed = was === undefined ? false : forked || session === null ? true
    : was !== null ? was === session : firstSession(appHome, paneKey, session) === session;
  const recordKey = session ?? paneKey;
  const seen = readSeen(appHome, recordKey);
  // A new conversation started with the file needs no bots.json read: nothing prints.
  if (covered && !resumed && seen?.hash === startedHash) return null;
  const { file } = parseBots(await readFile(`${key === "/" ? "" : key}/${BOTS_PATH}`, "utf8"));
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot || bot.planned) return null;
  const projects = collectProjectMap({
    project: key,
    file,
    appHome,
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    listDir: (p) => { try { return readdirSync(p); } catch { return []; } },
  });
  const transcript = typeof input.transcript_path === "string" ? transcriptRealPath(input.transcript_path, "claude", homedir()) : null;
  const scan = seen && transcript ? compactedSince(transcript, seen.offset) : { compacted: false, size: seen?.offset ?? 0 };
  const guard = guardOnPath(process.env.PATH);
  const gitTree = await run("git", ["rev-parse", "--is-inside-work-tree"], key);
  const isGit = gitTree !== UNANSWERED
    ? gitTree?.trim() === "true"
    : typeof seen?.isGit === "boolean"
      ? seen.isGit
      : [startedHash, seen?.hash].includes(textHash(launchBriefingText({ self: bot, file, guard, isGit: true, project: key, projects })));
  const now = textHash(launchBriefingText({ self: bot, file, guard, isGit, project: key, projects }));
  const decision = briefDecision({ covered, started: startedHash, resumed, seen: seen?.hash ?? null, now, compacted: scan.compacted });
  const offset = () => (transcript ? sizeOf(transcript) : 0);
  const record = () => writeSeen(appHome, recordKey, { hash: decision.hash ?? seen?.hash, offset: offset(), isGit });
  if (!decision.print) {
    if (decision.hash !== null || (seen && transcript && scan.size !== seen.offset)) record();
    return null;
  }
  const text = await gatherBriefing({ file, bot, address: terminal, ask: hcJson, guard, isGit, project: key, projects, ...(ledger ? { locate: ledger.locate } : {}) });
  return { text, record };
}

// The first conversation a pane's hook saw (recorded on its first call, under its own key), or
// `session` when it can't be read or kept: then each conversation counts as the first.
function firstSession(appHome, paneKey, session) {
  const key = `pane-${paneKey}`;
  try {
    const kept = JSON.parse(readFileSync(briefedPath(appHome, key), "utf8"))?.session;
    if (typeof kept === "string" && kept) return kept;
  } catch { /* none yet */ }
  writeSeen(appHome, key, { session });
  return session;
}

// The hash of the launch text in a briefing file (as briefedLaunch wrote it), null when unreadable.
function launchedHash(path) {
  try { return textHash(readFileSync(path, "utf8").replace(/\n$/, "")); } catch { return null; }
}

// ---- which launch text each conversation has (never a print every turn) ----

/** What a conversation's record holds: { hash, offset, isGit? }, or null. */
export function readSeen(appHome, key) {
  try {
    const seen = JSON.parse(readFileSync(briefedPath(appHome, key), "utf8"));
    if (!seen || typeof seen !== "object" || typeof seen.hash !== "string") return null;
    const out = { ...seen, offset: Number(seen.offset) || 0 };
    if (typeof out.isGit !== "boolean") delete out.isGit;
    return out;
  } catch { return null; }
}
/** Records `seen` for a conversation, replacing the file whole; a failure means the next turn prints again. */
export function writeSeen(appHome, key, seen) {
  try {
    const path = briefedPath(appHome, key);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(seen)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* fail open: the briefing comes again next turn */ }
}
const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };

/** Claude Code's mark of a compaction in its transcript (one JSON line per entry). */
export const COMPACT_MARK = '"subtype":"compact_boundary"';
const SCAN_CHUNK = 1 << 20;
const SCAN_MAX = 64 * SCAN_CHUNK;

/**
 * Whether the transcript at `path` gained a compaction past byte `offset` (a shorter file: it
 * was rewritten, which counts as one). Reads only what is new, its last SCAN_MAX bytes at most.
 * Resolves { compacted, size }; unreadable: { compacted: false, size: offset }.
 */
export function compactedSince(path, offset) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size < offset) return { compacted: true, size };
    const mark = Buffer.from(COMPACT_MARK);
    const chunk = Buffer.alloc(SCAN_CHUNK);
    let at = Math.max(offset, size - SCAN_MAX);
    // The last bytes of the window before, so a mark across two reads is still found.
    let tail = Buffer.alloc(0);
    while (at < size) {
      const n = readSync(fd, chunk, 0, Math.min(SCAN_CHUNK, size - at), at);
      if (n <= 0) break;
      const window = Buffer.concat([tail, chunk.subarray(0, n)]);
      if (window.includes(mark)) return { compacted: true, size };
      tail = Buffer.from(window.subarray(Math.max(0, window.length - (mark.length - 1))));
      at += n;
    }
    return { compacted: false, size };
  } catch { return { compacted: false, size: offset }; } finally { if (fd !== null) try { closeSync(fd); } catch {} }
}

/**
 * Its children (`hc ls` rows whose parent is its terminal), never one
 * that carries a bot label. A row the team's label queries above named is a bot; any other
 * child (a helper, or a bot of another team or project) is asked with `hc get` for its
 * labels, at most MAX_HELPERS of them, and one that gives no answer is left out. A permission
 * wait takes both state and kind from that child's get; otherwise status stays the row's word.
 */
async function helpersOf(all, address, known, ask) {
  if (!address || !all || all === UNANSWERED) return [];
  const kids = rowsOf(all).filter((r) => r?.parent === address && r.address && r.state !== "finished" && !known.has(r.address)).slice(0, MAX_HELPERS);
  const gets = await Promise.all(kids.map((r) => ask(["get", r.address])));
  return kids.flatMap((r, i) => {
    if (!gets[i] || typeof gets[i] !== "object" || gets[i].labels?.[BOT_LABEL]) return [];
    return [waitsOnPermission(gets[i].status)
      ? { status: "blocked", permission: true }
      : { status: typeof r.status === "string" ? r.status : r.status?.state, permission: false }];
  });
}

// The hook's stdin (Claude Code's JSON, with session_id and transcript_path), or "" when
// none comes within `ms` (a caller that never closes stdin can't hold the hook). Claude Code
// closes it at once, so INPUT_MS is never scaled: it only bounds such a caller.
// When the time is up, what is already in the pipe is still read first: on a starved machine
// the timer can come due before the event loop has polled stdin once (timers run before the
// poll), and Claude Code's JSON, sitting there since the start, would be dropped. setImmediate
// runs after the next poll, so only a caller that really sent nothing in `ms` gets "".
// Once some of it has come, the rest is waited for until stdin ends: a JSON bigger than the pipe
// buffer (64 KB, a large pasted prompt) comes in several reads, and on a starved machine the
// window can close between them; read cut short, it would not parse. `limit` bounds a caller
// that writes but never closes: the entry point clears its guard once main is done, and the
// session join still waits for the input. Then what came is taken as it is (a cut JSON object
// never parses). An input over INPUT_CAP is no input: "", so a cut one is never parsed.
const INPUT_MS = 300;
const INPUT_CAP = 1_000_000;
function readInput(ms, limit) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      clearTimeout(limitTimer);
      process.stdin.removeAllListeners("data");
      process.stdin.destroy();
      resolve(result);
    };
    const windowTimer = setTimeout(() => setImmediate(() => { if (text === "") done(text); }), ms);
    const limitTimer = setTimeout(() => done(text), limit);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { text += d; if (text.length > INPUT_CAP) done(""); });
    process.stdin.on("end", () => done(text));
    process.stdin.on("error", () => done(text));
  });
}

const TAIL_BYTES = 65_536;

/** The session `terminal`'s last session row names, from the ledger's tail (open as `fd`), or null. */
function lastSessionOf(fd, terminal) {
  const size = fstatSync(fd).size;
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, size - length);
  // A first line cut by the tail is not JSON: readLedger skips it.
  const rows = readLedger(buf.toString("utf8")).filter((r) => r.event === "session" && r.terminal === terminal);
  return rows.at(-1)?.session ?? null;
}

/**
 * Ties the Claude session in the hook's `input` to terminal `me` (its `hc get`) once per
 * change: a session row appended to the ledger under `appHome`, then the agent.session label
 * set (a failed label is tried again next turn; the row is written once, never lost: a session
 * the terminal's last row already names is not appended again). The agent.transcript label
 * (the hook's transcript_path, once Claude's folder under `home` holds its real path) goes in
 * the same `hc label` call whenever it is missing or differs: a known session gets it with no
 * row. Never rejects; resolves with whether the session was new.
 */
export async function joinSession(self, me, input, appHome, home = homedir()) {
  try {
    if (!me || me === UNANSWERED) return false;
    const change = sessionChange(me, input, (path) => transcriptRealPath(path, "claude", home));
    if (!change) return false;
    const terminal = me.address ?? self;
    if (change.fresh) {
      const path = ledgerPath(appHome);
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      // Once per session: when the terminal's last session row already names it (the entry point's
      // first attempt joined, then failed; or a label that did not stick), no second row. The read
      // and the append are one synchronous step, so two attempts in one hook cannot both append.
      // The owner's alone (RFC 0021 (f) 6): made 0600, and set so again on every append.
      const fd = openSync(path, "a+", LEDGER_MODE);
      const row = sessionRow({ terminal, session: change.session, transcript: change.transcript });
      try {
        try { fchmodSync(fd, LEDGER_MODE); } catch { /* not ours: the row still goes in */ }
        if (lastSessionOf(fd, terminal) !== change.session) writeSync(fd, ledgerLine(row));
      } finally { closeSync(fd); }
    }
    const labels = [
      ...(change.fresh ? [`${SESSION_LABEL}=${change.session}`] : []),
      ...(change.label === null ? [] : [`${TRANSCRIPT_LABEL}=${change.label}`]),
    ];
    await run("hc", ["label", terminal, ...labels]);
    return change.fresh;
  } catch { return false; }
}

// The app home this script is installed in (<app home>/mods/am-sidebar/briefing.mjs).
const appHomeOf = () => process.env.HERDR_APP_HOME || fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");

// Run as the hook (node briefing.mjs), not when the CLI imports gatherBriefing.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (import.meta.url === invoked) {
  const scale = timeScale(process.env.HERDR_BRIEFING_TIME_SCALE);
  until = Date.now() + BUDGET_MS * scale;
  callMs = CALL_MS * scale;
  const guard = setTimeout(() => process.exit(0), GUARD_MS * scale);
  guard.unref();
  const self = process.env.HC_TERMINAL_ID;
  const me = self ? hcJson(["get", self]) : Promise.resolve(null);
  const raw = self ? readInput(INPUT_MS, GUARD_MS * scale) : Promise.resolve("");
  const input = raw.then((text) => { try { const x = JSON.parse(text); return x && typeof x === "object" ? x : {}; } catch { return {}; } });
  const joined = self ? Promise.all([me, raw]).then(([get, text]) => joinSession(self, get, text, appHomeOf()), () => false)
    : Promise.resolve(false);
  try {
    const out = await main(me, input, appHomeOf());
    // Past this point the block is on its way: the guard must not cut the write short.
    clearTimeout(guard);
    if (out?.text) {
      process.stdout.write(`${out.text}\n`);
      out.record();
    }
  } catch (e) {
    // Fail open: no briefing this turn and exit 0, with one line on stderr as a trace.
    clearTimeout(guard);
    process.stderr.write(`am briefing: ${String(e?.message ?? e).split("\n")[0]}\n`);
  }
  await joined;
  process.exitCode = 0;
}
