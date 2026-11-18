// The deny-by-default hc guard for pack-started dsh-tui panes (automagik#624, stopgap C).
//
// A GUARDRAIL, NOT A BOUNDARY. This wrapper sits first on the pane PATH only because the pack
// put it there (launchArgs.js startArgs and workers.js workerArgs, dsh-tui only). It refuses the
// ordinary `hc exec` / bare `run` / file writes / machine and server commands with one line
// naming #624, #628 and #631, and passes the allowed calls to the real hc unchanged. It is bypassable
// by design: an absolute path to the real hc, a raw socket client, or `hc connect` skips it.
// The hard boundary is the sandboxed socket mask plus the per-pane filtering proxy (#624),
// tracked in #631; #628 is the full send/keys/attach scope. Labels and .herdr/bots.json are
// writable by the bot; the team check is a
// guardrail over that data, never a boundary. Apache-2.0.
//
// `hc kill` is for the seat of a project's main bot only (#955): a member's seat and every
// worker are refused, and end their own workers with `automagik-herdr worker kill <pane>`.
// Every other agent's pane gets the kill shim instead (`hc-kill/hc`, runKillGuard below): that
// one rule and nothing else, every other hc call passed to the real hc untouched.
//
// The caller comes from the attach ledger (attach.js), the authority: a worker pane has no
// ledger row, so its `worker.of` label names its bot and its cwd's project is the team's
// project. The target is resolved with the real hc: `hc ls` rows carry no labels, `hc get`
// does, as the pack's workersIn does. The team is model.js's graph: the caller's lead chain
// (effectiveLead), the declared lead chain it names (`bot.lead`, a planned lead included),
// its members (descendantsOf), the project's main bot (mainBotOf), its own workers
// (worker.of = the caller's bot) and the shared tester/reviewer/fixer ranks (RANKS). A pm, integrator
// or fixer bot the project lists may also send to any bot the project lists (planned entries
// included); that rank is the bots.json entry's, never the pane's role= label or an
// environment variable, and one of its workers inherits nothing. A captain bot may also send
// to another listed captain; both ranks come from bots.json, and workers inherit nothing.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readApprovedRecord } from "./approved.js";
import { attachPath, foldAttach, modeProblem, readAttach } from "./attach.js";
import { cleanProjectPath, crossMembersOf, descendantsOf, effectiveLead, inferProjectOf, mainBotOf, parseBots, projectEntriesOf, projectFileOf, RANKS } from "./model.js";
import { ENV, KILL_GUARD_NAME, WORKER_OF_LABEL, isKillGuardWord } from "./workers.js";

/** The commands a sandboxed bot may call unchanged. */
export const ALLOWED_VERBS = new Set([
  "send", "read", "ls", "get", "wait", "put", "label", "kill", "rm", "events", "schema", "templates",
]);
/** Doc-only forms that touch no core (and `hc send --help` and friends for an allowed command). */
const DOC_ONLY = new Set(["--help", "-h", "--version", "--skill"]);
/** The `operation` of `hc run`: the one worker start the pack emits. */
const WORKER_LABELS = new Set([
  WORKER_OF_LABEL, "task", "task.project", "task.lead", "branch", "worker.role", "herdr.space",
]);
/** The shared verdict ranks: targets with one of these bots.json ranks are reachable. */
export const SHARED_ROLES = ["tester", "reviewer", "fixer"].filter((role) => RANKS.includes(role));
/**
 * The shared coordination roles: a caller whose bots.json entry has one of these ranks may
 * send to any bot the project lists. The rank is bots.json's, never the pane's role= label.
 */
export const SHARED_SEND_RANKS = ["pm", "integrator", "fixer"].filter((role) => RANKS.includes(role));
/** This module's own file: a guard copy must be byte-equal to it (#643). */
const SELF_MODULE = fileURLToPath(import.meta.url);
/** The guard's own folder, beside this module; the pane PATH word must start with it. */
export const GUARD_DIR = join(dirname(SELF_MODULE), "guard");
/** The executable this module backs; PATH scans skip its real path. */
const SELF_ENTRY = join(GUARD_DIR, "hc");
/**
 * The environment marker a guard sets on the hc it runs when that hc looks like a guard it
 * cannot vouch for. A guard that starts with it set stops at once (#643): the marker only
 * stops re-entry, and a marker with no guard behind it is refused, never allowed.
 */
export const REENTRY_ENV = "AM_HC_GUARD_REENTRY";

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const say = (line) => process.stderr.write(`${line}\n`);
const refused = (reason, code = 2) => {
  say(`hc guard: refused ${oneLine(reason)} (#624; the full send/keys/attach scope is #628): this wrapper is a guardrail, not a boundary; the hard boundary is #631.`);
  return code;
};
const failedClosed = (reason = "the real hc could not be run") => {
  say(`hc guard: failed closed (#624; the full send/keys/attach scope is #628): ${oneLine(reason)}; this wrapper is a guardrail, not a boundary (#631).`);
  return 1;
};

/** The hc guard: `argv` as the pane's shell gave it, `env` the pane's environment. Returns the exit code. */
export async function runGuard(argv, env = process.env) {
  try {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const verb = args[0] ?? "";
    if (reentry(env)) return refused("a re-entry: the guard already ran for this call");
    if (docOnly(args)) {
      const real = findRealHc(env);
      return real ? passthrough(real, args, env) : failedClosed("the real hc is not on PATH");
    }
    if (!verb || verb.startsWith("-")) return refused("hc without a command");
    if (!ALLOWED_VERBS.has(verb) && verb !== "run") return refused(verb === "file" ? `file ${args[1] ?? ""}` : verb);
    const on = onWord(args);
    if (on.present && verb !== "send") return refused(`${verb} with --on`);
    const targets = verb === "events"
      ? optionValues(args, EVENTS_TARGET_OPTIONS)
      : TARGETED_VERBS.has(verb) ? [firstPositional(args, TARGET_VALUE_OPTIONS[verb])].filter(Boolean) : [];
    if (verb !== "send" && targets.some((target) => target.includes("/"))) return refused(`${verb} with a machine target`);
    const terminal = terminalOf(env);
    if (!terminal) return refused("a command without HC_TERMINAL_ID");
    const real = findRealHc(env);
    if (!real) return failedClosed("the real hc is not on PATH");
    if (verb === "run") {
      const why = runProblem(args, env, terminal);
      if (why) return refused(`run: ${why}`);
      return passthrough(real, args, env);
    }
    if (verb === "send") {
      const why = sendProblem(real, args, env, terminal, on);
      if (why) return refused(`send: ${why}`);
      return passthrough(real, args, env);
    }
    if (verb === "label") {
      const why = labelProblem(real, args, env, terminal, on);
      if (why) return refused(`label: ${why}`);
      return passthrough(real, args, env);
    }
    if (verb === "kill") {
      const why = killProblem(real, env, terminal);
      if (why) return refused(`kill: ${why}`);
      return passthrough(real, args, env);
    }
    return passthrough(real, args, env);
  } catch (e) {
    return failedClosed(e?.message ?? e);
  }
}

function docOnly(args) {
  if (args.length === 1 && DOC_ONLY.has(args[0])) return true;
  return args.length === 2 && ALLOWED_VERBS.has(args[0]) && (args[1] === "--help" || args[1] === "-h");
}

function terminalOf(env) {
  return typeof env.HC_TERMINAL_ID === "string" ? env.HC_TERMINAL_ID.trim() : "";
}

// ---- the kill shim: the one rule every other agent's pane gets (#955) ----

/** The kill shim's own folder, beside this module (workers.js KILL_GUARD_DIR). */
export const KILL_GUARD_DIR = join(dirname(SELF_MODULE), KILL_GUARD_NAME);

/** The command of an hc call: its first word that is no option (`hc --json kill` is a kill). */
export const hcVerbOf = (args) => (Array.isArray(args) ? args.map(String).find((word) => !word.startsWith("-")) ?? "" : "");

const killRefused = (reason) => {
  say(`hc kill shim: refused ${oneLine(reason)} (#955). This shim is a guardrail on the pane's PATH, not a boundary.`);
  return 2;
};
const killFailed = (reason) => {
  say(`hc kill shim: ${oneLine(reason)} (#955).`);
  return 1;
};

/**
 * The `hc kill` shim for a pane of any agent other than dsh-tui (Claude Code, Codex,
 * Antigravity and the rest): `argv` as the pane's shell gave it. A call whose command is
 * `kill`, in any flag order (`hc kill --json t1`, `hc --json kill t1`), is checked by the
 * guard's own rule (killProblem: the seat of a `kind: "main"` bot only) and refused to every
 * worker and every other seat, with the verb that ends a bot's own worker. Every other call,
 * `hc kill --help` included, goes to the real hc with the same words, stdio and exit code; the
 * shim reads nothing for it. A kill it cannot check (no HC_TERMINAL_ID, an unreadable ledger)
 * is refused; a call it cannot pass on says so and exits 127. It stops the honest path only:
 * the real hc by its full path, a raw socket or `hc connect` skips it.
 */
export async function runKillGuard(argv, env = process.env) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let real = null;
  try { real = hcPastGuards(env); } catch { /* reported below */ }
  if (!real) {
    say("hc kill shim: the real hc is not on PATH (#955).");
    return 127;
  }
  const asksHelp = args.includes("--help") || args.includes("-h");
  if (hcVerbOf(args) !== "kill" || asksHelp) return passthrough(real, args, env, { plain: true });
  try {
    const terminal = terminalOf(env);
    if (!terminal) return killRefused("kill: a call without HC_TERMINAL_ID cannot be checked");
    const why = killProblem(real, env, terminal);
    if (why) return killRefused(`kill: ${why}`);
  } catch (e) {
    return killRefused(`kill: the caller could not be checked (${oneLine(e?.message ?? e)})`);
  }
  return passthrough(real, args, env, { plain: true });
}

/**
 * The real hc for the kill shim: the first executable `hc` on PATH outside every folder that
 * looks like a guard (an hcGuard.mjs beside it), of this version or another. The shim guards
 * one command, so it never hands a call to another guard and never sets the re-entry marker.
 */
function hcPastGuards(env) {
  const self = new Set([realOrNull(join(KILL_GUARD_DIR, "hc")), realOrNull(SELF_ENTRY), realOrNull(process.argv[1])].filter(Boolean));
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir || looksLikeGuardFolder(dir)) continue;
    const candidate = join(dir, "hc");
    if (!executable(candidate)) continue;
    const real = realOrNull(candidate);
    if (!real || self.has(real)) continue;
    return real;
  }
  return null;
}

/** A guard already ran for this call (#643): the marker stops re-entry, never allows. */
const reentry = (env) => typeof env?.[REENTRY_ENV] === "string" && env[REENTRY_ENV] !== "";

/** `--on <machine>` or `--on=<machine>` anywhere after the command. */
function onWord(args) {
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--on") return { present: true, value: args[i + 1] ?? null };
    if (args[i].startsWith("--on=")) return { present: true, value: args[i].slice(5) };
  }
  return { present: false, value: null };
}

const executable = (path) => {
  try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
};
const realOrNull = (path) => { try { return realpathSync(path); } catch { return null; } };
const SELF_BYTES = (() => { try { return readFileSync(SELF_MODULE); } catch { return null; } })();
const SELF_GUARD_DIR = realOrNull(GUARD_DIR);
/**
 * A guard folder this copy can vouch for (#643): its real path is this module's own guard
 * folder, or the hcGuard.mjs beside its `hc` entry is byte-equal to this module (the installed
 * am copy). A planted hcGuard.mjs no longer makes a folder a guard. The one byte-equal rule
 * (#721): the guard uses it here, and the CLI imports it for realHcPath, so the two cannot drift.
 */
export function isGuardFolder(dir) {
  if (typeof dir !== "string" || dir === "") return false;
  const real = realOrNull(dir);
  if (!real) return false;
  if (SELF_GUARD_DIR && real === SELF_GUARD_DIR) return true;
  let bytes;
  try { bytes = readFileSync(join(dir, "..", "hcGuard.mjs")); } catch { return false; }
  return SELF_BYTES !== null && bytes.equals(SELF_BYTES);
}
/** A folder the loose rule would call a guard, which isGuardFolder cannot vouch for (#643). */
const looksLikeGuardFolder = (dir) => typeof dir === "string" && dir !== ""
  && existsSync(join(dir, "..", "hcGuard.mjs"));
/**
 * The env for `real`: the re-entry marker only when that hc looks like a guard this guard
 * cannot vouch for. A stray hcGuard.mjs beside an ordinary real hc also sets it, and the
 * panes that hc starts inherit it; their guards then refuse (a denial that needs write access
 * there), never allow. It is not a boundary.
 */
function spawnEnv(real, env) {
  const dir = dirname(real);
  return looksLikeGuardFolder(dir) && !isGuardFolder(dir) ? { ...env, [REENTRY_ENV]: "1" } : env;
}

/** The real hc: the first executable `hc` on PATH that is not any guard folder's own entry. */
function findRealHc(env) {
  const self = new Set([realOrNull(SELF_ENTRY), realOrNull(process.argv[1])].filter(Boolean));
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir || isGuardFolder(dir)) continue;
    const candidate = join(dir, "hc");
    if (!executable(candidate)) continue;
    const real = realOrNull(candidate);
    if (!real || self.has(real)) continue;
    return real;
  }
  return null;
}

/**
 * Run the real hc with the pane's stdio and return its exit code (a signal is re-raised).
 * `plain`: the kill shim's call, with the pane's environment as it is and its own failure line.
 */
function passthrough(real, args, env, { plain = false } = {}) {
  const r = spawnSync(real, args, { env: plain ? env : spawnEnv(real, env), stdio: "inherit" });
  if (r.error) {
    const why = `the real hc at ${real} did not run: ${r.error.message}`;
    return plain ? killFailed(why) : failedClosed(why);
  }
  if (typeof r.status === "number") return r.status;
  if (r.signal) {
    try { process.kill(process.pid, r.signal); } catch { /* the caller sees a failure */ }
  }
  return 1;
}

/** `hc <args> --json` through the real hc, parsed; null when it failed or printed no JSON. */
function hcJson(real, args, env) {
  const r = spawnSync(real, [...args, "--json"], { env: spawnEnv(real, env), encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return null;
  const text = String(r.stdout ?? "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* a line after noise */ }
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    try { return JSON.parse(line); } catch { /* next */ }
  }
  return null;
}

const rowsOf = (ls) => (Array.isArray(ls?.terminals) ? ls.terminals : Array.isArray(ls) ? ls : []);

// ---- caller: the attach ledger is the authority; a worker pane's worker.of is the fallback ----

const appHome = (env) => (env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app")).replace(/\/+$/, "");

function foldOf(env) {
  const path = attachPath(appHome(env));
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return foldAttach([]);
    throw e;
  }
  const why = modeProblem(path, st.mode);
  if (why) throw new Error(why);
  return foldAttach(readAttach(readFileSync(path, "utf8")).rows);
}

/** The newest this-computer binding of `terminal`, or null. */
function boundCaller(env, terminal) {
  let best = null;
  for (const binding of foldOf(env).byKey.values()) {
    if (binding.terminal !== terminal || binding.machine) continue;
    if (!best || (binding.created_ms ?? 0) > (best.created_ms ?? 0)) best = binding;
  }
  return best && typeof best.bot === "string" ? { bot: best.bot, project: typeof best.project === "string" ? best.project : null, worker: false } : null;
}

/** The project a folder belongs to: a worktree's main checkout, else the nearest .herdr/bots.json. */
function projectOfFolder(folder) {
  if (typeof folder !== "string" || !folder) return null;
  let at = realOrNull(folder);
  if (!at) return null;
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const inWorktree = at.lastIndexOf(marker);
  if (inWorktree > 0) {
    const project = at.slice(0, inWorktree);
    if (existsSync(join(project, ".herdr", "bots.json"))) return project;
  }
  for (;;) {
    if (existsSync(join(at, ".herdr", "bots.json"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The caller of this call: { bot, project, worker } or a refusal string. A ledger-bound bot
 * pane wins; a pane without a binding must carry a worker.of label (a worker pane), and its
 * project is the main checkout above its worktree, else the nearest .herdr/bots.json above its cwd.
 */
function callerOf(real, env, terminal) {
  const bound = boundCaller(env, terminal);
  if (bound) return { ...bound, project: bound.project ?? null };
  const get = hcJson(real, ["get", terminal], env);
  const of = get && typeof get === "object" && get.labels && typeof get.labels === "object" ? get.labels[WORKER_OF_LABEL] : null;
  if (typeof of !== "string" || !of) return "the caller is neither bound in the attach ledger nor a worker pane";
  return { bot: of, project: projectOfFolder(get.cwd), worker: true };
}

function readBots(project) {
  if (typeof project !== "string" || !project) return null;
  try { return parseBots(readFileSync(join(project, ".herdr", "bots.json"), "utf8")).file; } catch { return null; }
}

/**
 * Loads approved snapshots (`approved.js` `readApprovedRecord`, verified `0600`) for any other
 * projects named by `file` (`leadProject` or `crossMembers`) or `extraKeys`. Never reads another
 * project's live writable `.herdr/bots.json`; an missing, unapproved, or non-0600 snapshot is
 * omitted so cross-project checks fail closed.
 */
export function loadApprovedProjectsFor(project, file, env = process.env, extraKeys = []) {
  const ownClean = cleanProjectPath(project);
  if (!ownClean || !file || !Array.isArray(file.bots)) return null;
  const candidates = new Set();
  for (const b of file.bots) {
    if (typeof b?.leadProject === "string" && b.leadProject) {
      candidates.add(cleanProjectPath(b.leadProject));
    }
    for (const m of crossMembersOf(b)) {
      candidates.add(m.project);
    }
  }
  for (const k of extraKeys ?? []) {
    if (typeof k === "string" && k) candidates.add(cleanProjectPath(k));
  }
  const ownReal = realOrNull(ownClean);
  const map = new Map([[ownClean, file]]);
  if (ownReal && ownReal !== ownClean) map.set(ownReal, file);
  let loadedOther = false;
  for (const cand of candidates) {
    if (!cand || cand === ownClean || (ownReal && (cand === ownReal || realOrNull(cand) === ownReal))) continue;
    try {
      const approved = readApprovedRecord({ project: cand, env });
      if (approved?.file) {
        map.set(cand, approved.file);
        if (approved.record?.project) map.set(cleanProjectPath(approved.record.project), approved.file);
        loadedOther = true;
      }
    } catch {
      // Unapproved, missing, not 0600, symlink, or corrupt: fail closed by omitting it.
    }
  }
  return loadedOther ? map : null;
}

/**
 * The declared lead chain of a bot within its own project: its `lead`, then that bot's `lead`,
 * while each id is listed in the project's bots.json (planned entries included), cycle-safe.
 * effectiveLead falls back to the main bot at a planned lead; this is the declared path, so a
 * guarded captain reaches a planned Orchestrator without changing the tree's rule. Cross-project
 * leads never widen via declaredLeads.
 */
function declaredLeads(file, botId) {
  const out = [];
  const seen = new Set([botId]);
  let curBot = file?.bots?.find((b) => b.id === botId);
  while (curBot) {
    if (curBot.leadProject) break;
    const nextId = curBot.lead;
    if (typeof nextId !== "string" || !nextId || seen.has(nextId)) break;
    const def = file?.bots?.find((b) => b.id === nextId);
    if (!def) break;
    seen.add(def.id);
    out.push(def.id);
    curBot = def;
  }
  return out;
}

/**
 * The bots the caller may address: both same-project lead chains, same-project members, main,
 * own workers (and its bot for a worker), plus — for a non-worker caller with verified projects —
 * the direct cross-project lead <-> member link only (never the lead's upward chain or the other
 * project's main bot, and never the member's team or workers). Exported for the per-pane hc proxy
 * (#631), which reads the same graph from its start-time approved snapshot.
 */
export function teamOf(file, caller, options = {}, maybeOptions = {}) {
  const opts = typeof options === "boolean" ? maybeOptions : (options ?? {});
  const callerBot = typeof caller === "string" ? caller : caller?.bot;
  const callerWorker = typeof options === "boolean" ? options : Boolean(caller?.worker);
  const project = opts?.project ?? (typeof caller === "object" ? caller?.project : null) ?? null;
  const projects = opts?.projects ?? (typeof caller === "object" ? caller?.projects : null)
    ?? loadApprovedProjectsFor(project, file, opts?.env ?? process.env, opts?.extraKeys ?? []);
  const verifiedProjects = projects ?? new Map();
  const ownProject = inferProjectOf(file, callerBot, project, projects);
  const allowed = new Set();
  const main = mainBotOf(file);
  if (main) allowed.add(main.id);
  let curBotId = callerBot;
  const seen = new Set([curBotId]);
  while (curBotId) {
    const eff = effectiveLead(file, curBotId, { project: ownProject || null });
    if (!eff.lead || eff.leadProject || seen.has(eff.lead)) break;
    seen.add(eff.lead);
    allowed.add(eff.lead);
    curBotId = eff.lead;
  }
  for (const id of declaredLeads(file, callerBot)) allowed.add(id);
  for (const id of descendantsOf(file, callerBot)) allowed.add(id);
  if (callerWorker) {
    allowed.add(callerBot);
    return allowed;
  }
  if (ownProject && projects) {
    const selfEff = effectiveLead(file, callerBot, { project: ownProject, projects: verifiedProjects });
    if (selfEff.lead && selfEff.leadProject && selfEff.leadProject !== ownProject) {
      allowed.add(selfEff.lead);
    }
    for (const [otherKey, otherFile] of projectEntriesOf(verifiedProjects)) {
      if (!otherKey || otherKey === ownProject) continue;
      for (const b of otherFile.bots ?? []) {
        if (!b?.id || b.planned || !b.leadProject) continue;
        if (cleanProjectPath(b.leadProject) !== ownProject || b.lead !== callerBot) continue;
        const eff = effectiveLead(otherFile, b.id, { project: otherKey, projects: verifiedProjects });
        if (eff.lead === callerBot && eff.leadProject === ownProject) {
          allowed.add(b.id);
        }
      }
    }
  }
  return allowed;
}

/** Shared send rules for the guard and proxy; these never widen the team graph for reads. */
export function sharedSendAllowed(file, caller, labels) {
  const self = file.bots.find((bot) => bot.id === caller.bot);
  const target = typeof labels.bot === "string"
    ? file.bots.find((bot) => bot.id === labels.bot) : null;
  if (target && !caller.worker && self) {
    if (SHARED_SEND_RANKS.includes(self.rank)) return true;
    if (self.rank === "captain" && target.rank === "captain") return true;
  }
  // Keep the existing reviewer/fixer label path; tester access requires a roster rank.
  if (labels.role === "reviewer" || labels.role === "fixer") return true;
  return Boolean(target && SHARED_ROLES.includes(target.rank));
}

// ---- send: resolve the target with hc, then check its labels and the team graph ----

const SEND_VALUE_OPTIONS = new Set(["--if", "--timeout", "--on"]);
/** The first positional target of a verb and the options that take a value before it. */
const TARGET_VALUE_OPTIONS = {
  read: new Set(["--lines"]),
  get: new Set(),
  wait: new Set(["--children", "--output", "--timeout"]),
  put: new Set(),
  label: new Set(),
  kill: new Set(),
  rm: new Set(),
};
const TARGETED_VERBS = new Set(Object.keys(TARGET_VALUE_OPTIONS));
/** `hc events` names its terminal through option values, not a positional. */
const EVENTS_TARGET_OPTIONS = ["--terminal", "--children-of"];

/** The values of the named options (`--name value` or `--name=value`), in order. */
function optionValues(args, names) {
  const out = [];
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i];
    for (const name of names) {
      if (word === name) {
        if (typeof args[i + 1] === "string") out.push(args[i + 1]);
        i += 1;
        break;
      }
      if (word.startsWith(`${name}=`)) {
        out.push(word.slice(name.length + 1));
        break;
      }
    }
  }
  return out;
}

/** The first positional word after the options, or null (`--` starts the positionals). */
function firstPositional(args, valueOptions = new Set()) {
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--") return args[i + 1] ?? null;
    if (valueOptions.has(word)) { i += 1; continue; }
    if (word.startsWith("-") && word !== "-") continue;
    return word;
  }
  return null;
}

/** The positional words of `hc send`, with its options and their values skipped. */
function sendPositionals(args) {
  const out = [];
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--") { out.push(...args.slice(i + 1)); break; }
    if (SEND_VALUE_OPTIONS.has(word)) { i += 1; continue; }
    if (word.startsWith("-") && word !== "-") continue;
    out.push(word);
  }
  return out;
}

/** The target's hc get answer: an address or name through ls, then get for the labels. */
function targetOf(real, word, on, env) {
  let address = word;
  if (on && !address.includes("/")) address = `${on}/${address}`;
  if (!address.includes("/")) {
    const rows = rowsOf(hcJson(real, ["ls"], env));
    const hit = rows.find((r) => r?.address === address) ?? rows.find((r) => r?.name === address);
    if (hit?.address) address = hit.address;
  }
  const get = hcJson(real, ["get", address], env);
  if (!get || typeof get !== "object" || get.error || !get.labels || typeof get.labels !== "object") return null;
  return { address, get, labels: get.labels };
}

function sendProblem(real, args, env, terminal, on) {
  const words = sendPositionals(args);
  const target = words[0];
  if (!target) return "no target";
  const caller = callerOf(real, env, terminal);
  if (typeof caller === "string") return caller;
  const file = readBots(caller.project);
  if (!file) return "the caller's project has no readable .herdr/bots.json";
  const self = file.bots.find((b) => b.id === caller.bot);
  if (!self) return "the caller is not a bot in the project's .herdr/bots.json";
  const hit = targetOf(real, target, on.value, env);
  if (!hit) return "the target is not resolvable with hc";
  const { labels } = hit;
  const targetProject = projectOfFolder(hit.get?.cwd);
  const crossTarget = Boolean(
    targetProject && caller.project && realOrNull(targetProject) !== realOrNull(caller.project),
  );
  if (crossTarget && caller.worker) return "the target is not in the caller's team";
  const allowed = teamOf(file, caller, {
    project: caller.project,
    env,
    extraKeys: targetProject ? [targetProject] : [],
  });
  if (typeof labels.bot === "string" && allowed.has(labels.bot)) {
    if (!crossTarget) return null;
    const ownClean = cleanProjectPath(caller.project);
    const targetClean = cleanProjectPath(targetProject);
    const verified = loadApprovedProjectsFor(caller.project, file, env, [targetProject]);
    if (!verified) return "the target is not in the caller's team";
    const selfEff = effectiveLead(file, caller.bot, { project: ownClean, projects: verified });
    const isDirectLead = selfEff.lead === labels.bot && selfEff.leadProject === targetClean;
    const targetFile = projectFileOf(verified, targetClean);
    const targetEff = targetFile
      ? effectiveLead(targetFile, labels.bot, { project: targetClean, projects: verified })
      : null;
    const isDirectMember = Boolean(
      targetEff && targetEff.lead === caller.bot && targetEff.leadProject === ownClean,
    );
    return isDirectLead || isDirectMember ? null : "the target is not in the caller's team";
  }
  if (crossTarget) return "the target is not in the caller's team";
  if (labels[WORKER_OF_LABEL] === caller.bot) return null;
  if (sharedSendAllowed(file, caller, labels)) return null;
  return "the target is not in the caller's team";
}

/** label is own-workers only: the target's parent must be the caller's own pane. */
function labelProblem(real, args, env, terminal, on) {
  const target = firstPositional(args, TARGET_VALUE_OPTIONS.label);
  if (!target) return "no target";
  const caller = callerOf(real, env, terminal);
  if (typeof caller === "string") return caller;
  const hit = targetOf(real, target, on.value, env);
  if (!hit) return "the target is not resolvable with hc";
  if (hit.get.parent !== terminal) return "the target is not the caller's own worker";
  return null;
}

// ---- kill: a project's main bot only (#955, the owner's rule) ----

/**
 * `hc kill` is for the seat of a project's main bot (`kind: "main"` in bots.json) and no one
 * else: a member's seat, a lead that isn't the main bot, and every worker are refused, whatever
 * the target. The kind is the bots.json entry's, read through the attach ledger's binding of the
 * caller's pane, never a label. A bot ends a worker it started with `automagik-herdr worker
 * kill <pane>`, which checks the worker is its own. `hc --json kill` and any other flag before
 * the command never get here: the guard refuses a call whose first word is an option.
 */
function killProblem(real, env, terminal) {
  const caller = callerOf(real, env, terminal);
  if (typeof caller === "string") return caller;
  const own = "end a worker you started with am worker kill <pane>";
  if (caller.worker) return `hc kill is for a project's main bot only, never a worker; ${own}`;
  const file = readBots(caller.project);
  const bot = file?.bots?.find((row) => row.id === caller.bot) ?? null;
  if (!bot) return "the caller's bot is not in its project's bots.json";
  if (bot.kind !== "main") return `hc kill is for a project's main bot only; ${own}`;
  return null;
}

// ---- run: exactly the worker start workers.js emits for dsh-tui ----

/** Canonical `cwd` under the project's .claude/worktrees/; false for a link or a path outside it. */
function underWorktrees(cwd, project) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  const realCwd = realOrNull(cwd);
  const realProject = realOrNull(project);
  if (!realCwd || !realProject) return false;
  const root = realOrNull(join(realProject, ".claude", "worktrees"));
  if (!root) return false;
  return realCwd !== root && realCwd.startsWith(`${root}${sep}`);
}

/** Why `args` is not the worker shape, or null. */
function runProblem(args, env, terminal) {
  let bg = false, seenJson = false, cwd = null, parent = null, seenName = false, dashes = false;
  const labels = new Map();
  let i = 1;
  for (; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--") { dashes = true; i += 1; break; }
    if (word === "--bg") {
      if (bg) return "--bg twice";
      bg = true;
      continue;
    }
    if (word === "--json") {
      if (seenJson) return "--json twice";
      seenJson = true;
      continue;
    }
    const value = args[i + 1];
    if (word === "--name") {
      if (seenName) return "--name twice";
      if (typeof value !== "string") return "--name without a value";
      seenName = true;
      i += 1;
      continue;
    }
    if (word === "--cwd") {
      if (cwd !== null) return "--cwd twice";
      if (typeof value !== "string") return "--cwd without a value";
      cwd = value;
      i += 1;
      continue;
    }
    if (word === "--parent") {
      if (parent !== null) return "--parent twice";
      if (typeof value !== "string") return "--parent without a value";
      parent = value;
      i += 1;
      continue;
    }
    if (word === "--label") {
      if (typeof value !== "string" || !value.includes("=")) return "--label without K=V";
      const eq = value.indexOf("=");
      const key = value.slice(0, eq);
      if (labels.has(key)) return `--label ${key} twice`;
      labels.set(key, value.slice(eq + 1));
      i += 1;
      continue;
    }
    return `${word} is not the worker shape`;
  }
  if (!dashes) return "no -- before the program";
  if (!bg) return "not --bg";
  if (cwd === null) return "no --cwd";
  if (parent === null) return "no --parent";
  if (parent !== terminal) return "--parent is not the caller's pane";
  if (labels.get(WORKER_OF_LABEL) === undefined) return `no --label ${WORKER_OF_LABEL}=<caller's bot>`;
  for (const key of labels.keys()) if (!WORKER_LABELS.has(key)) return `--label ${key} is not the worker shape`;
  const caller = boundCaller(env, terminal);
  if (!caller) return "only a bot pane the attach ledger binds starts a worker";
  if (labels.get(WORKER_OF_LABEL) !== caller.bot) return `${WORKER_OF_LABEL} is not the caller's bot`;
  if (!underWorktrees(cwd, caller.project)) return "--cwd is not under the caller's project .claude/worktrees/";
  const rest = args.slice(i);
  if (rest[0] !== ENV) return `the program is not ${ENV}`;
  if (!rest[1] || !rest[1].startsWith("PATH=")) return "no PATH word after the program";
  const first = rest[1].slice("PATH=".length).split(delimiter)[0];
  if (!isGuardFolder(first) || isKillGuardWord(first)) return "the PATH word does not start with a guard";
  if (rest[2] !== "dsh-tui") return "the program is not dsh-tui";
  if (rest.length !== 5 || rest[3] !== "--" || typeof rest[4] !== "string") return "the task is not the one -- <task> word";
  return null;
}
