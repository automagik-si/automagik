// Revive over plain data (#939): which bots a reboot left without their agent, the order they
// come back in, the session an agent that takes no id at launch (dsh-TUI, Antigravity, Codex, Kimi) left on
// disk for a pane, the one report the project's main bot gets, and the login service's files
// with the caller's PATH kept: a systemd user unit, a launchd agent on macOS (#1418).
// The CLI's `revive` runs it with hc and the files. Pure: no `herdr`, no `node:` import, so
// `node --test` runs it. Apache-2.0.

import { unwrapKeep } from "./launchArgs.js";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const base = (p) => String(p ?? "").split("/").pop();

/**
 * A pane hc still runs with nothing but a shell in front: what `hc run --keep` leaves in place
 * of a program a reboot ended. A login shell's `-zsh` counts, and so does a pane hc names no
 * program for. Never a finished pane, never one with an agent or any other program in front.
 */
export function isBareShell(get) {
  if (!get || get.state !== "live") return false;
  const argv0 = unwrapKeep(get.foreground?.argv)?.[0];
  if (argv0 === undefined || argv0 === null || argv0 === "") return true;
  return SHELLS.has(base(argv0).replace(/^-/, ""));
}

// ---- the session a pane's agent left on disk ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A session id found on disk: a UUID, or Kimi's session_<uuid>. */
const sessionShape = (id) => typeof id === "string" && (UUID.test(id) || (id.startsWith("session_") && UUID.test(id.slice(8))));

/** The agents whose session id is found on disk after the launch: none takes one at launch. */
export const DISCOVERED = Object.freeze(["dsh-tui", "antigravity", "codex", "kimi"]);
export const discoversSession = (agentKey) => DISCOVERED.includes(agentKey);

/**
 * DSH keeps a folder's sessions in `<dsh home>/sessions/--<folder, "/" as "-">--/`, one folder
 * per session named by its id (`<uuid>`, or `session-<uuid>` in older ones). `dshHome`: DSH's
 * own home ($DSH_HOME, else ~/.dsh: dshHomeOf).
 */
export const dshSessionsDir = (dshHome, cwd) =>
  `${String(dshHome).replace(/\/+$/, "")}/sessions/--${String(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
/** DSH's home: $DSH_HOME when it is an absolute path, else `<home>/.dsh`. */
export const dshHomeOf = (home, env = {}) => (typeof env.DSH_HOME === "string" && env.DSH_HOME.startsWith("/") ? env.DSH_HOME
  : `${String(home).replace(/\/+$/, "")}/.dsh`);

/** The session id a DSH session folder's name holds, or null. */
export function dshSessionOf(name) {
  const id = String(name ?? "").replace(/^session-/, "");
  return UUID.test(id) ? id : null;
}

/** Antigravity's prompt history: one JSON line per prompt, { timestamp (ms), workspace, conversationId }. */
export const agyHistoryPath = (home) => `${String(home).replace(/\/+$/, "")}/.gemini/antigravity-cli/history.jsonl`;

/**
 * The conversations Antigravity's history ties to folder `cwd` (or one of `folders`, its other
 * spellings): [{ id, born, touched }], the first and the last prompt's time. Only the three
 * fields are read: a prompt's text never leaves the line.
 */
export function agyCandidates(historyText, folders) {
  const here = new Set((Array.isArray(folders) ? folders : [folders]).filter((f) => typeof f === "string" && f));
  const by = new Map();
  for (const line of String(historyText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { row = null; }
    const id = row?.conversationId;
    if (typeof id !== "string" || !UUID.test(id) || !here.has(row.workspace) || !Number.isFinite(row.timestamp)) continue;
    const at = row.timestamp < 1e12 ? row.timestamp * 1000 : row.timestamp;
    const c = by.get(id) ?? { id, born: at, touched: at };
    c.born = Math.min(c.born, at);
    c.touched = Math.max(c.touched, at);
    by.set(id, c);
  }
  return [...by.values()];
}

/** Codex's home: $CODEX_HOME when it is an absolute path, else <home>/.codex. */
export const codexHomeOf = (home, env = {}) => (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.startsWith("/") ? env.CODEX_HOME
  : `${String(home).replace(/\/+$/, "")}/.codex`);
/** The root of Codex's dated rollout folders. */
export const codexSessionsDir = (codexHome) => `${String(codexHome).replace(/\/+$/, "")}/sessions`;

/** The creation time in a version-7 UUID (ms), or null for any other id. */
export const uuidV7Ms = (id) => (typeof id === "string" && UUID.test(id) && id[14] === "7" && /[89ab]/i.test(id[19])
  ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : null);

/** The UUID at the end of a Codex rollout's file name, or null. */
export function codexRolloutId(fileName) {
  const id = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(String(fileName ?? ""))?.[1];
  return id ?? null;
}

/** A rollout's session_meta: { id, born }, null for another folder, undefined when unreadable. */
export function codexCandidate(firstLine, folders) {
  let row = null;
  try { row = JSON.parse(firstLine); } catch { return undefined; }
  const id = row?.payload?.id;
  if (row?.type !== "session_meta" || typeof id !== "string" || !UUID.test(id)) return undefined;
  const here = new Set(Array.isArray(folders) ? folders : [folders]);
  if (!here.has(row.payload.cwd)) return null;
  const at = Date.parse(row.payload.timestamp);
  return { id, born: uuidV7Ms(id) ?? (Number.isFinite(at) ? at : Date.parse(row.timestamp)) };
}

/** Kimi's home: $KIMI_CODE_HOME when it is an absolute path, else <home>/.kimi-code. */
export const kimiHomeOf = (home, env = {}) => (typeof env.KIMI_CODE_HOME === "string" && env.KIMI_CODE_HOME.startsWith("/") ? env.KIMI_CODE_HOME
  : `${String(home).replace(/\/+$/, "")}/.kimi-code`);
/** Kimi's append-only session index. */
export const kimiIndexPath = (kimiHome) => `${String(kimiHome).replace(/\/+$/, "")}/session_index.jsonl`;

/** Kimi's last index row per id, in these folders and strictly under its own sessions root. */
export function kimiCandidates(indexText, folders, kimiHome) {
  const here = new Set(Array.isArray(folders) ? folders : [folders]);
  const by = new Map();
  for (const line of String(indexText ?? "").split("\n")) {
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    const id = row?.sessionId;
    if (typeof id !== "string" || !id.startsWith("session_") || !UUID.test(id.slice(8))) continue;
    if (row.deleted === true) by.delete(id);
    else by.set(id, row);
  }
  const normalized = (p) => (typeof p === "string" && p.startsWith("/") && !p.split("/").includes("..")
    ? `/${p.split("/").filter((s) => s && s !== ".").join("/")}` : null);
  const root = normalized(`${String(kimiHome).replace(/\/+$/, "")}/sessions`);
  const out = [];
  for (const [id, row] of by) {
    const sessionDir = normalized(row.sessionDir);
    if (here.has(row.workDir) && root && sessionDir?.startsWith(`${root}/`)) out.push({ id, sessionDir });
  }
  return out;
}

/** How far before a pane's created_ms its session may be stamped (clocks, a slow stat). */
export const BORN_SLACK_MS = 2000;
/** How soon after its start a pane's own session must be born (Codex's id dates its launch). */
export const FIRST_SESSION_MS = 120_000;

/**
 * The session a pane started at `createdMs` runs, from what its agent left on disk, or null:
 * right or nothing, since a wrong one would resume another's conversation (#328). Anyone can
 * leave a session in that folder with no pane this pack knows (a person's own terminal, DSH
 * Desktop), so only the pane's first conversation is ever taken, and only when nothing else
 * could be it. `candidates`: that agent's sessions in the pane's folder, [{ id, born }] (ms);
 * `claimed`: the ids another terminal's label or ledger row holds; `rivals`: the other panes and
 * launches of that agent in that folder (hc's live panes, and the ledger's launches not known to
 * have ended before this one), [{ created_ms }].
 * The pick: the one session born between the pane's start and FIRST_SESSION_MS after it. Two
 * born then, none, or a rival that started between FIRST_SESSION_MS before the pane and that
 * birth (or at a time not known): null. A session born later (a new conversation started inside
 * the pane, or anyone's) is never taken.
 */
export function pickSession({ createdMs, candidates = [], claimed = new Set(), rivals = [] }) {
  if (!Number.isSafeInteger(createdMs)) return null;
  const mine = candidates.filter((c) => sessionShape(c?.id) && !claimed.has(c.id) && Number.isFinite(c.born)
    && c.born >= createdMs - BORN_SLACK_MS && c.born <= createdMs + FIRST_SESSION_MS);
  if (mine.length !== 1) return null;
  const first = mine[0];
  const near = rivals.some((r) => !Number.isSafeInteger(r?.created_ms)
    || (r.created_ms >= createdMs - FIRST_SESSION_MS && r.created_ms <= first.born + BORN_SLACK_MS));
  return near ? null : first.id;
}

/**
 * pickSession's `rivals` and `claimed` from the workers ledger's rows, for the launch on
 * `terminal` at `createdMs` of `agentKey` in `folders` (the folder's spellings): the other start
 * rows of that agent there with no end row stamped before this launch, and every session id a
 * row ties to another launch.
 */
export function ledgerRivals(rows, { terminal, createdMs, agentKey, folders }) {
  const here = new Set(folders);
  const key = (r) => `${r.terminal}\n${r.created_ms ?? ""}`;
  const own = `${terminal}\n${createdMs}`;
  const endedAt = new Map();
  for (const r of rows ?? []) if (r?.event === "end" && typeof r.at === "string") endedAt.set(key(r), Date.parse(r.at));
  const rivals = [];
  const claimed = new Set();
  for (const r of rows ?? []) {
    if (typeof r?.session === "string" && r.session && (r.event === "start" || r.event === "session")
      && !(r.terminal === terminal && (r.created_ms === undefined || r.created_ms === createdMs))) claimed.add(r.session);
    if (r?.event !== "start" || r.agent !== agentKey || !here.has(r.worktree) || key(r) === own) continue;
    const end = endedAt.get(key(r));
    if (Number.isFinite(end) && end < createdMs) continue;
    rivals.push({ terminal: r.terminal, created_ms: Number.isSafeInteger(r.created_ms) ? r.created_ms : null });
  }
  return { rivals, claimed };
}

// ---- who comes back ----

/**
 * The bots to bring back, from the attach ledger as hc answers now. `bindings`: this computer's
 * bindings (the ledger's fold); `states`: Map terminal -> { state: "live" | "finished" | "gone" |
 * "unknown", get }; `swept`: the bindings a sweep ended since the boot (rows by "sweep" stamped
 * at or after it, their bot not bound since), counted only for the boot's own pass.
 * Resolves { targets: [{ bot, project, terminal, created_ms, pane: "shell" | "gone" }],
 * skipped: [{ bot, project, terminal, why }] }: a pane with a program in front (its agent, or
 * anything a person runs there) is left out silently; one hc can't read is skipped and said.
 */
export function reviveTargets({ bindings = [], states = new Map(), swept = [] }) {
  const targets = [];
  const skipped = [];
  const seen = new Set();
  const take = (b, pane) => {
    const k = `${b.project ?? ""}\n${b.bot}`;
    if (seen.has(k)) return;
    seen.add(k);
    targets.push({ bot: b.bot, project: b.project ?? null, terminal: b.terminal, created_ms: b.created_ms, pane });
  };
  for (const b of bindings) {
    const s = states.get(b.terminal) ?? { state: "unknown", why: `hc gave no answer for ${b.terminal}` };
    if (s.state === "unknown") { skipped.push({ bot: b.bot, project: b.project ?? null, terminal: b.terminal, why: s.why ?? "hc can't read its pane" }); continue; }
    if (s.state !== "live" || s.get?.created_ms !== b.created_ms) { take(b, "gone"); continue; }
    if (isBareShell(s.get)) take(b, "shell");
    else seen.add(`${b.project ?? ""}\n${b.bot}`); // it runs: an older swept row of it never counts
  }
  for (const b of swept) take(b, "gone");
  return { targets, skipped };
}

/**
 * The bindings a sweep ended at or after `bootMs` whose bot the ledger doesn't bind now (`rows`:
 * the attach ledger's, in file order; this computer's only): the panes a reboot took whole,
 * swept by a command that ran before the revive pass did.
 */
export function sweptSince(rows, bootMs, core) {
  const last = new Map();
  for (const r of rows ?? []) {
    if (!r || r.machine || r.core !== core) continue;
    last.set(`${r.project ?? ""}\n${r.bot}`, r);
  }
  return [...last.values()].filter((r) => r.event === "end" && r.by === "sweep" && Date.parse(r.at) >= bootMs);
}

/**
 * `targets` in the order they come back: the main bot, then each bot after its lead (a member's
 * pane is started under its lead's), per project. `leadOf(target)`: its lead's bot id, "" or
 * null for none; `isMain(target)`.
 */
export function reviveOrder(targets, { leadOf = () => null, isMain = () => false } = {}) {
  const left = [...targets].sort((a, b) => Number(isMain(b)) - Number(isMain(a)));
  const out = [];
  const waiting = (t) => left.some((o) => o !== t && o.project === t.project && o.bot === leadOf(t));
  while (left.length) {
    let i = left.findIndex((t) => !waiting(t));
    if (i < 0) i = 0; // a lead cycle: as they stand
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// ---- the report ----

/** The command that brings `botId` back by hand. No session id: restart finds it itself. */
export const byHandCommand = (botId, project) => `am restart ${botId} --project ${project} --tree`;
/** How a bot is kept down across restarts of the computer: said in every report. */
export const KEEP_DOWN = "To keep a bot down across restarts of this computer: am detach <bot>.";

/** The boot pass's own line (its output goes to the user journal): counts only, never a path or a name. */
export function countsLine(projects) {
  const all = projects.flatMap((p) => p.results ?? []);
  const n = (o) => all.filter((r) => r.outcome === o).length;
  return `revive: ${n("resumed")} resumed, ${n("fresh")} on a new conversation, ${n("failed")} not back, ${n("skipped")} left alone, in ${projects.length} `
    + `project${projects.length === 1 ? "" : "s"}; the report is in the app home, automagik-herdr/revive-last.json.`;
}

const list = (items) => items.join("; ");

/**
 * The one report a project's main bot gets, one line (hc send types it as one message):
 * `results`: [{ name, bot, outcome: "resumed" | "fresh" | "failed" | "skipped", why, terminal,
 * helpers: [{ name, outcome, why }] }]. Null when nothing came back and nothing failed.
 */
export function reportLine(project, results) {
  const of = (o) => results.filter((r) => r.outcome === o);
  const helpers = results.flatMap((r) => (r.helpers ?? []).map((h) => ({ ...h, of: r.name })));
  const resumed = of("resumed"), fresh = of("fresh"), failed = of("failed"), skipped = of("skipped");
  if (!resumed.length && !fresh.length && !failed.length && !skipped.length) return null;
  const at = (r) => (r.terminal ? ` (${r.terminal})` : "");
  const parts = [`Revive after a restart of this computer, project ${project}.`];
  if (resumed.length) parts.push(`Resumed where they were: ${list(resumed.map((r) => `${r.name}${at(r)}`))}.`);
  if (fresh.length) parts.push(`Back on a new conversation: ${list(fresh.map((r) => `${r.name}${at(r)}, ${r.why ?? "no reason given"}`))}.`);
  const helped = (o) => helpers.filter((h) => h.outcome === o);
  if (helped("resumed").length) parts.push(`Helpers resumed: ${list(helped("resumed").map((h) => `${h.name} (under ${h.of})`))}.`);
  if (helped("fresh").length) parts.push(`Helpers on a new conversation: ${list(helped("fresh").map((h) => `${h.name} (under ${h.of}), ${h.why ?? "no reason given"}`))}.`);
  if (helped("failed").length) parts.push(`Helpers not back: ${list(helped("failed").map((h) => `${h.name} (under ${h.of}), ${h.why ?? "no reason given"}`))}.`);
  if (failed.length) {
    parts.push(`Not back: ${list(failed.map((r) => `${r.name}, ${r.why ?? "no reason given"}; by hand: ${byHandCommand(r.bot, project)}`))}.`);
  }
  if (skipped.length) parts.push(`Left alone: ${list(skipped.map((r) => `${r.name}, ${r.why}`))}.`);
  parts.push(KEEP_DOWN);
  return parts.join(" ").replace(/\s*\n\s*/g, " ");
}

/**
 * `revive --last` (#1419): the record revive-last.json keeps, as text. `record`: { at, boot_ms, boot,
 * projects: [{ project, report, sent, unsent }], stopped?: { at, boot, reason } } or null (none);
 * `path`: where it is kept. An older record has no `boot`: then neither the boot nor by hand is said.
 */
export function lastText(record, path) {
  if (!record) return `No revive pass is on record on this computer (${path}). To see whether the login service that runs it after a restart is installed: am revive service status.`;
  const stopped = record.stopped ?? null;
  const at = record.at ?? stopped?.at ?? "an unknown time";
  const boot = typeof record.at === "string" ? record.boot : stopped?.boot;
  const lines = [`Last revive pass: ${at}${boot === true ? ", the login service's pass (--boot)" : boot === false ? ", run by hand" : ""}.`];
  for (const p of record.projects ?? []) {
    lines.push(p.report ?? `Project ${p.project ?? "(no project)"}: no report.`);
    lines.push(`  ${p.sent ? `Sent to the main bot (${p.sent}).` : `Not sent: ${p.unsent ?? "no reason given"}.`}`);
  }
  if (stopped) lines.push(`A pass stopped early (${stopped.at ?? "an unknown time"}${stopped.boot === true ? ", --boot" : ""}): ${stopped.reason ?? "no reason given"}.`);
  else if (!record.projects?.length) lines.push("Nothing to bring back: every bot the ledger named ran its agent.");
  return lines.join("\n");
}

// ---- the login service ----

export const UNIT_NAME = "automagik-herdr-revive.service";
/** The systemd user unit's path under the home (XDG_CONFIG_HOME is not followed: systemd reads this one). */
export const unitPath = (home) => `${String(home).replace(/\/+$/, "")}/.config/systemd/user/${UNIT_NAME}`;
/** The first line that says the unit is this pack's: only such a file is replaced or removed. */
export const UNIT_MARK = "# Automagik Herdr: brings the bots back after a restart of this computer (automagik-herdr revive).";
/** How long the service waits for herdr-core before it gives up, in seconds. */
export const SERVICE_WAIT_S = 600;

/** The caller's PATH kept for login (#1418), without pane guards or project-local bins. */
export function servicePath(path, { binDir, venv = null, drop = () => false } = {}) {
  const dirs = new Set();
  const venvBin = venv ? `${venv.replace(/\/+$/, "")}/bin` : null;
  for (const dir of path.split(":")) {
    if (!dir.startsWith("/") || /[\x00-\x1f\x7f-\x9f]/.test(dir)) continue;
    const clean = dir.replace(/\/+$/, "");
    if (drop(dir) || /\/node_modules\/\.bin$/.test(clean) || clean === venvBin) continue;
    dirs.add(dir);
  }
  for (const dir of [binDir, "/usr/bin", "/bin"]) if (dir) dirs.add(dir);
  return [...dirs].join(":");
}

/** `w` inside a systemd ExecStart: quoted, `%` and `$` doubled, `\` and `"` escaped. */
const unitWord = (w) => `"${String(w).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** Environment= expands `%` specifiers, but leaves `$` literal. */
const envWord = (w) => `"${String(w).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

/**
 * The systemd user unit: once per login, after the session is up, `<runner> revive --boot
 * --wait <s>` (the CLI's launcher, bin/run.sh, which finds Node itself). The CLI waits for
 * herdr-core, so the unit names no core unit. `env`: the kept PATH (#1418) and HERDR_APP_HOME
 * when it isn't the default.
 */
export function unitText({ runner, env = {}, wait = SERVICE_WAIT_S }) {
  const vars = Object.entries(env).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => `Environment=${envWord(`${k}=${v}`)}`);
  return [UNIT_MARK, "[Unit]", "Description=Automagik Herdr: bring the bots back after a restart", "",
    "[Service]", "Type=oneshot", ...vars,
    `ExecStart=${unitWord(runner)} revive --boot --wait ${wait}`,
    // No start timeout: the pass bounds its own waits (herdr-core, each bot's restart), and
    // systemd ending it part way would leave no report and no stamp.
    "TimeoutStartSec=infinity", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

/** Whether `text` (a unit file's) is one this pack wrote. */
export const unitIsOurs = (text) => typeof text === "string" && text.startsWith(`${UNIT_MARK}\n`);

/** Whether the unit keeps the PATH it was installed with (#1418). */
export const unitKeepsPath = (text) => typeof text === "string" && /^Environment="PATH=/m.test(text);

/** Two boot times (ms) are one boot: os.uptime() jitters by a second or so. */
export const sameBoot = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 60_000;

// ---- the login service on macOS (launchd, #939) ----

/** The job's label: launchd's name for it, and the plist's file name under LaunchAgents. */
export const PLIST_LABEL = "dev.herdr.automagik-herdr-revive";
/** The plist's path: the person's own launch agents folder, never a system-wide path. */
export const plistPath = (home) => `${String(home).replace(/\/+$/, "")}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
/** The XML declaration a plist opens with (a declaration may not follow a comment). */
export const PLIST_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
/** The plist's second line, after the declaration: only a file that starts so is replaced or removed. */
export const PLIST_MARK = "<!-- Automagik Herdr: brings the bots back after a restart of this computer (am revive). -->";

/** Whether `text` (a plist's) is one this pack wrote. */
export const plistIsOurs = (text) => typeof text === "string" && text.startsWith(`${PLIST_DECL}\n${PLIST_MARK}\n`);

/** Whether the plist keeps the PATH it was installed with (#1418). */
export const plistKeepsPath = (text) => typeof text === "string" && text.includes("<key>PATH</key>");

/**
 * Whether a `launchctl print` answer says the job is not loaded: exit 113 (launchd's own
 * not-found) or the exact "Could not find service" words. Every other failure — usage (64),
 * EPERM, an I/O error, a timeout — is "can't tell", never "not loaded": a plist removed on such
 * an answer can leave a label launchd still holds (#939).
 */
export const launchdNotLoaded = (r) => r?.code === 113
  || /^Could not find service\b/m.test(`${r?.stderr ?? ""}\n${r?.stdout ?? ""}`);

/** `w` as XML text: the five characters a plist string may not carry as they are. */
const xml = (w) => String(w).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The launchd agent: once per login, `<runner> revive --boot --wait <s>` (the CLI's launcher,
 * bin/run.sh, which finds Node itself). RunAtLoad and never KeepAlive: it runs once, and the
 * file is loaded at the next login without starting anything now. `env`: the kept PATH (#1418)
 * and HERDR_APP_HOME when it isn't the default.
 */
export function plistText({ runner, env = {}, wait = SERVICE_WAIT_S }) {
  const vars = Object.entries(env).filter(([, v]) => typeof v === "string" && v);
  const args = [runner, "revive", "--boot", "--wait", String(wait)];
  return [PLIST_DECL, PLIST_MARK, '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${PLIST_LABEL}</string>`,
    "  <key>ProgramArguments</key><array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><false/>",
    ...(vars.length ? ["  <key>EnvironmentVariables</key><dict>", ...vars.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`), "  </dict>"] : []),
    "</dict></plist>", ""].join("\n");
}
