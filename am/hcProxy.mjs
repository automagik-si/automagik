#!/usr/bin/env node
// The per-pane hc proxy (#631). Plain-mode JSON-RPC only: one message per line, one upstream
// connection per downstream client connection, one Unix socket per pane. It refuses `hello`,
// so framed mode (and terminal.attach) is never reachable through it.
//
// The per-pane helper (hcPane.mjs) starts it before DSH, and so before the sandbox exists; the
// helper passes the caller the pack resolved outside the sandbox. The helper and the proxy are
// one process: it ends with the pane, and there is no service to run.
//
// The policy is deny-by-default and is built once at start. A proxied pane (the helper's
// explicit caller) reads the project's approved roster, a record outside the project written
// only by `automagik-herdr proxy approve`; a working-tree roster that differs warns once and
// the approved one stays in force, and a missing record refuses the pane. The by-hand path
// (no explicit caller) keeps the attach ledger and the working `.herdr/bots.json` reads. A
// roster change needs a pane restart (a new proxy is started with the new pane). Worker starts
// re-read and verify that approval at spawn time; they never inherit a cached allowance. The caller is
// the pane this proxy serves, fixed at start, and every forwarded request has its
// `params.caller` overwritten with it. Targets are resolved with one short upstream
// `terminal.get`, checked, and forwarded by resolved address, so a rename between the check
// and the call cannot redirect it.
//
// Fail closed: a dead upstream is a JSON-RPC error, never a fallback. The upstream core must
// answer `server.status` with HC_PIN or the proxy refuses to start. A pane whose proxy cannot
// start is not started at all (hcPane.mjs), so `hc` cannot auto-start a core inside the sandbox.
//
// Apache-2.0.

import net from "node:net";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { approvedSettingsDir, readApprovedRecord, sha256Of } from "./approved.js";
import { attachPath, foldAttach, modeProblem, readAttach } from "./attach.js";
import { parseBots } from "./model.js";
import { AGY_MODE_DEFAULT, agySettingsArgs, agySettingsPlan, choosesSession, promptByMessage, sessionIdArgs } from "./models.js";
import { commandArgv, sessionId } from "./restart.js";
import { approvedDataRootProblem, executionPathProblem, shimPathOf } from "./dshTui.mjs";
import { sharedSendAllowed, teamOf } from "./hcGuard.mjs";
import { ENV, guardPathWith, stableGuardDir, stableHelper, stableKillDir, stableRootOf, stableRunner, templateAgent, workerArgs, workerPlan, WORKER_OF_LABEL } from "./workers.js";

/** The one core version this proxy speaks (the box's herdr-core, hc 0.1.14). */
export const HC_PIN = "0.1.14";
/** The dedicated runtime folder, under $XDG_RUNTIME_DIR and outside any writable cwd. */
export const SOCKET_FOLDER = "automagik-hc-proxy";
/** The stable pane helper/runner a worker start may name; dsh-tui install writes them. */
export const stablePaths = (env) => {
  const root = stableRootOf(env);
  return { root, guard: stableGuardDir(root), helper: stableHelper(root), runner: stableRunner(root) };
};
/** The most lines one terminal.read may ask for (the reply cap is the hard stop). */
export const MAX_READ_LINES = 5000;
/** A core reply line larger than this is refused with a clear error, never buffered. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** A client request line larger than this is refused: the proxy never buffers it. */
export const MAX_REQUEST_BYTES = 256 * 1024;
/** A Unix socket path must fit in Linux's 108-byte sun_path, including its NUL. */
export const MAX_SOCKET_PATH = 107;
/** The platform's own sun_path bound: macOS accepts 104 bytes, Linux 107. */
export const SOCKET_PATH_LIMITS = Object.freeze({ linux: 107, darwin: 104 });
/** The socket-path byte limit for `platform` (an unknown platform takes Linux's bound). */
export const socketPathLimit = (platform = process.platform) => SOCKET_PATH_LIMITS[platform] ?? MAX_SOCKET_PATH;
/** The most client connections one pane socket accepts at once. */
export const MAX_CONNECTIONS = 16;
/** A connection with no request in flight is closed after this long. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** A forwarded call other than a wait is answered with an error after this long. */
export const FORWARD_TIMEOUT_MS = 30 * 1000;
/** A policy or startup call is short; a long terminal.wait is the client's own connection. */
const CONTROL_TIMEOUT_MS = 15000;
/** The identity variables hc's CLI puts in a run's `env`; nothing else belongs in the worker shape. */
const IDENTITY_VARS = new Set(["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM"]);
/** The labels the pack's worker start sets (hcGuard's WORKER_LABELS). */
const WORKER_LABELS = new Set([WORKER_OF_LABEL, "task", "task.project", "task.lead", "branch", "worker.role", "herdr.space"]);
/** The methods that carry a caller; the proxy overwrites it on every one. */
const CALLER_METHODS = new Set([
  "terminal.get", "terminal.read", "terminal.wait", "terminal.send",
  "terminal.kill", "terminal.rm", "terminal.run",
]);
const ALLOWED = new Set(["terminal.list", "terminal.label", "templates.list", "proxy.workerTransport", ...CALLER_METHODS]);
const OWN_WORKER_METHODS = new Set(["terminal.kill", "terminal.rm", "terminal.label"]);
const TEAM_METHODS = new Set(["terminal.get", "terminal.read", "terminal.wait", "terminal.send"]);
/** The exact parameters each method may forward; anything else is an unknown parameter. */
export const METHOD_PARAMS = new Map([
  ["terminal.list", new Set(["all", "labels"])],
  ["templates.list", new Set()],
  ["proxy.workerTransport", new Set()],
  ["terminal.get", new Set(["terminal", "caller"])],
  ["terminal.read", new Set(["terminal", "lines", "caller"])],
  ["terminal.wait", new Set(["terminal", "children", "output", "timeout", "caller"])],
  ["terminal.send", new Set(["terminal", "text", "wait", "force", "if", "timeout", "caller"])],
  ["terminal.kill", new Set(["terminal", "caller"])],
  ["terminal.rm", new Set(["terminal", "caller"])],
  ["terminal.label", new Set(["terminal", "labels"])],
  ["terminal.run", new Set([
    "argv", "name", "cwd", "env", "labels", "parent", "no_parent", "no_notify", "outlive_parent",
    "die_with_parent", "rm", "keep", "wait", "timeout", "caller",
  ])],
]);

/** The first parameter a method may not forward, or null. */
function unknownParam(params, method) {
  const allowed = METHOD_PARAMS.get(method);
  if (!allowed) return null;
  for (const key of Object.keys(params)) if (!allowed.has(key)) return key;
  return null;
}

/** `promise`, rejected with a clear error after `ms`; disabled for a non-positive timeout. */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      const error = new Error(`did not answer within ${ms} ms`);
      error.timeout = true;
      rejectPromise(error);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const realOrNull = (path) => {
  try { return realpathSync(path); } catch { return null; }
};

/** Whether `child` is `parent` or beneath it, by real path (false when either is gone). */
function insideReal(child, parent) {
  const at = realOrNull(child);
  const root = realOrNull(parent);
  if (!at || !root) return false;
  return at === root || at.startsWith(`${root}${sep}`);
}

/** Whether `child` is `parent` or beneath it, by resolved path even when it does not exist. */
function insideLexical(child, parent) {
  const at = resolve(child);
  const root = resolve(parent);
  const rel = relative(root, at);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether two paths are the same real path (false when either is gone). */
function sameReal(a, b) {
  const at = realOrNull(a);
  const root = realOrNull(b);
  return Boolean(at && root && at === root);
}

/** The app home hcGuard and the ledger use. */
export const appHome = (env) => (env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app")).replace(/\/+$/, "");

/** The project a folder belongs to, as hcGuard's callerOf reads it. */
export function projectOfFolder(folder) {
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

/** The newest this-computer binding of `terminal` in the snapshot fold, or null. */
function boundCaller(fold, terminal) {
  let best = null;
  for (const binding of fold.byKey.values()) {
    if (binding.terminal !== terminal || binding.machine) continue;
    if (!best || (binding.created_ms ?? 0) > (best.created_ms ?? 0)) best = binding;
  }
  return best && typeof best.bot === "string"
    ? { bot: best.bot, project: typeof best.project === "string" ? best.project : null, worker: false }
    : null;
}

/** The ledger read once, at start: a later row in the writable app home changes nothing. */
function ledgerSnapshot(appHomeDir) {
  const path = attachPath(appHomeDir);
  let text = "";
  try {
    const info = statSync(path);
    const why = modeProblem(path, info.mode);
    if (why) throw new Error(why);
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
  return foldAttach(readAttach(text).rows);
}

/** A JSON-RPC error with the proxy's fixed prefix. */
const refusal = (id, why, kind = "refused") => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code: -32000, message: `hc-proxy: ${oneLine(why)}`, data: { kind } },
});

/** The real path of `name` on the given PATH words, or null; follows links and checks X_OK. */
function resolveOnPath(name, words) {
  for (const dir of words) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true)) return realpathSync(candidate);
    } catch { /* next word */ }
  }
  return null;
}

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

/** Read at each worker request, pinned to this pane's approval digest and approval stamp. */
function workerApproval(snapshot) {
  if (!snapshot.approval) throw new Error("worker allowance needs an approved snapshot");
  const approved = readApprovedRecord({ project: snapshot.caller.project, env: snapshot.approvalEnv });
  for (const key of ["sha256", "approvedAt", "approvedBy"]) {
    if (approved.record[key] !== snapshot.approval[key]) {
      throw new Error(`worker allowance approval ${key} changed; restart the pane after approval`);
    }
  }
  const bot = approved.file.bots.find((row) => row.id === snapshot.caller.bot);
  if (!bot) throw new Error("worker allowance caller is absent from the approved snapshot");
  return bot;
}

/** Rebuild through the CLI's builder; the request contributes only task text and checked metadata. */
function approvedWorkerProblem(p, snapshot, bot, templates) {
  if (!bot.worker?.template && !bot.worker?.agent) {
    return "worker allowance has no worker.template or worker.agent in the approved snapshot";
  }
  const plan = workerPlan(bot);
  if (plan.error) return `approved worker: ${plan.error}`;
  if (p.env !== undefined) {
    if (!isObject(p.env)) return "approved worker env is refused; expected a terminal env object";
    for (const [key, value] of Object.entries(p.env)) {
      if (!IDENTITY_VARS.has(key) || typeof value !== "string"
        || !/^[A-Za-z0-9._+-]{1,64}$/.test(value)) {
        return `approved worker env ${key} override is refused; only bounded terminal variables are allowed`;
      }
    }
  }
  // An agent that takes its task as its first message (models.js promptByMessage: kimi, #1032)
  // starts with no task word: its argv is the approved command alone, and may end in one of its
  // options. Nothing of the request is read as a task then; the exact match below still holds.
  const taskByMessage = !plan.template && promptByMessage(plan.agent);
  const task = taskByMessage ? "" : Array.isArray(p.argv) ? p.argv.at(-1) : null;
  if (!taskByMessage && (typeof task !== "string" || /^\s*-/.test(task) || task.includes("\0"))) {
    return "approved worker task must be one text word that is not an option";
  }
  const labels = p.labels;
  const role = labels["worker.role"] ?? "dev";
  // H1 (#823 review): the permission list of an approved worker is written by the proxy itself,
  // from the approved snapshot, in the data root the sandbox binds read-only. The pane names the
  // path, but it can neither plant nor edit the file: a working-roster edit never reaches an
  // approved start. The path is deterministic from the approved data (the bot, its role and the
  // worktree), so the plan and the argv name the same file.
  let agySettings = null;
  // #884: a symlinked worktree is trusted and written by its canonical path, as every local
  // launch does (models.js agyTrustedWorkspaces/agyPermissionPlan take the injected realpath).
  const agySettingsFor = () => agySettingsPlan({ bot, scope: "worker", role, folder: realOrNull(p.cwd) ?? p.cwd,
    settingsDir: approvedSettingsDir(snapshot.approvalEnv ?? process.env), realpath: realOrNull,
    homeDir: homedir() });
  let templateArgv = null;
  let login = [];
  if (plan.template) {
    const template = templates.find((row) => row?.name === plan.template);
    if (!template || typeof template.command !== "string" || !template.command.trim()) {
      return `approved worker template ${plan.template} is not available from the core`;
    }
    const runs = templateAgent(template.command);
    if (runs === "claude") {
      templateArgv = commandArgv({ shell: template.command }, [task]);
      if (!templateArgv) return `approved worker template ${plan.template} cannot take a task`;
      login = ["-u", "CLAUDE_CONFIG_DIR"];
    } else if (runs === "antigravity") {
      agySettings = agySettingsFor();
      templateArgv = commandArgv({ shell: template.command }, [...agySettingsArgs("antigravity", agySettings?.path), task]);
      if (!templateArgv) return `approved worker template ${plan.template} cannot take a task and its permission list`;
    }
  } else if (plan.agent === "claude") {
    login = ["-u", "CLAUDE_CONFIG_DIR"];
  } else if (plan.agent === "antigravity") {
    agySettings = agySettingsFor();
  }
  // A chosen Antigravity mode is a worker label; auto is the default, so it has none (workers.js
  // workerArgs writes the label only when it isn't auto), and the label must name the approved mode.
  const agyModeLabel = plan.agyMode && plan.agyMode !== AGY_MODE_DEFAULT ? plan.agyMode : null;
  for (const [key, value] of [["worker.template", plan.template],
    ["worker.model", plan.model], ["worker.effort", plan.effort], ["worker.agyMode", agyModeLabel]]) {
    if ((labels[key] ?? null) !== value) return `approved worker label ${key} does not match approval`;
  }
  // RFC 0021 (f) 2: a new Claude worker runs on the session id its CLI chose, as its
  // agent.session label (a UUID) and exactly `--session-id <that id>` after the approved argv;
  // never on a template or another agent.
  const session = labels["agent.session"] ?? null;
  if (session !== null && (plan.template || !choosesSession(plan.agent) || sessionId(session) !== session)) {
    return "approved worker label agent.session does not match approval";
  }
  const args = workerArgs({ botId: snapshot.caller.bot, branch: labels.branch,
    role: labels["worker.role"], name: p.name, cwd: p.cwd, parent: snapshot.terminal,
    agent: plan.agent, model: plan.model, effort: plan.effort, agyMode: plan.agyMode,
    argv: session ? [...plan.argv, ...sessionIdArgs(plan.agent, session)] : plan.argv, session,
    task, template: plan.template, templateArgv, login, path: snapshot.path,
    taskId: labels.task, project: snapshot.caller.project, lead: labels["task.lead"],
    space: labels["herdr.space"], agySettingsPath: agySettings?.path ?? null,
    // #955: the worker's `hc kill` shim is the stable folder's copy, as the CLI names it for a proxied pane.
    killGuard: stableKillDir(snapshot.stableRoot) });
  const expected = plan.template && !templateArgv ? args.slice(-2)
    : args.slice(args.indexOf("--") + 1);
  if (!Array.isArray(p.argv) || p.argv.length !== expected.length
    || p.argv.some((word, index) => word !== expected[index])) {
    const named = plan.template ? `template ${plan.template}` : `agent ${plan.agent}`;
    return `approved worker argv refused: does not match approved ${named} exactly`;
  }
  // The argv matched the approved plan: now the proxy writes the file it promised, from the
  // approved roster, fail closed (an approved worker never starts without its list).
  if (agySettings) {
    try { writeApprovedAgySettings(agySettings); }
    catch (e) {
      return `approved worker: its Antigravity permission list couldn't be written `
        + `(${agySettings.path}: ${oneLine(e?.message ?? e)})`;
    }
  }
  return null;
}

/** The proxy's own write of an approved worker's permission file: 0600 in a 0700 folder under
 * the data root (read-only to the sandbox), atomically, from the approved snapshot's entry. */
function writeApprovedAgySettings(plan) {
  const dir = dirname(plan.path);
  // Never follow a symlinked folder or file: this file decides what the approved worker's agy
  // may do. A temp in the real folder (created O_EXCL) renamed onto the path replaces a link,
  // never its target.
  let st = null;
  try { st = lstatSync(dir); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink`);
    if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink`);
  }
  try { if (lstatSync(plan.path).isSymbolicLink()) throw new Error(`${plan.path} is a symlink`); }
  catch (e) { if (e?.code !== "ENOENT") throw e; }
  const tmp = `${plan.path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, plan.text, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, plan.path);
  chmodSync(plan.path, 0o600);
}

/**
 * Why `params` is not an approved worker start, or null. A named template/agent is rebuilt
 * through workerArgs and matched exactly. Otherwise this is hcGuard's dsh-tui shape: the
 * argv check ported to the RPC params the CLI sends: the program, its PATH guard word, the one
 * task word, the parent, the worktree cwd, the worker labels, and the identity-only env. It
 * accepts only the per-pane helper shape
 * `[/usr/bin/env, PATH=..., /bin/sh, <pack>/bin/run.sh, <pack>/hcPane.mjs, --bot, <caller>,
 * --project, <caller project>, --worker, --, dsh-tui, --, <task>]`. The plain five-word shape is
 * refused: a proxied pane can unset AM_HC_PROXY before its own worker start, and a plain worker
 * would have no proxy of its own, so its sandbox would reach the real core one hop later. The
 * pack's own guard is allowed even inside the app home, where the installed pack lives; any
 * other copy is not.
 */
export function runProblem(params, snapshot, templates = []) {
  const p = isObject(params) ? params : {};
  if (p.on !== undefined && p.on !== null) return "on is not the worker shape";
  if (p.line !== undefined && p.line !== null) return "line is not the worker shape";
  if (!snapshot.bound) return "only a bot pane the attach ledger binds starts a worker";
  if (p.no_parent === true) return "no_parent is not the worker shape";
  if (p.outlive_parent === true) return "outlive_parent is not the worker shape";
  if (p.no_notify === true) return "no_notify is not the worker shape";
  if (p.rm === true) return "rm is not the worker shape";
  if (p.keep === true) return "keep is not the worker shape";
  if (p.wait === true) return "wait is not the worker shape";
  if (p.die_with_parent !== true) return "die_with_parent is not true";
  if (p.timeout !== undefined && p.timeout !== null) return "timeout is not the worker shape";
  if (p.name !== undefined && p.name !== null && typeof p.name !== "string") return "name is not text";
  if (p.parent !== snapshot.terminal) return "parent is not the caller's pane";
  if (typeof p.cwd !== "string" || !isAbsolute(p.cwd)) return "cwd is not absolute";
  if (!underWorktrees(p.cwd, snapshot.caller.project)) return "cwd is not under the caller's project .claude/worktrees/";
  let bot = null;
  if (snapshot.approval) {
    try { bot = workerApproval(snapshot); }
    catch (e) { return `approved worker refused: ${oneLine(e.message)}`; }
  }
  const namedWorker = bot?.worker?.template || (bot?.worker?.agent && bot.worker.agent !== "dsh-tui");
  const workerLabels = namedWorker
    ? new Set([...WORKER_LABELS, "worker.template", "worker.model", "worker.effort", "worker.agyMode", "agent.session"]) : WORKER_LABELS;
  const labels = p.labels;
  if (!isObject(labels)) return "labels are not the worker shape";
  if (labels[WORKER_OF_LABEL] !== snapshot.caller.bot) return `${WORKER_OF_LABEL} is not the caller's bot`;
  for (const [key, value] of Object.entries(labels)) {
    if (!workerLabels.has(key)) return `label ${key} is not the worker shape`;
    if (typeof value !== "string") return `label ${key} is not text`;
  }
  if (namedWorker) return approvedWorkerProblem(p, snapshot, bot, templates);
  if (p.env !== undefined) {
    if (!isObject(p.env)) return "env is not the worker shape";
    for (const [key, value] of Object.entries(p.env)) {
      if (!IDENTITY_VARS.has(key)) return `env ${key} is not the worker shape`;
      if (typeof value !== "string") return `env ${key} is not text`;
    }
  }
  const argv = p.argv;
  if (!Array.isArray(argv) || argv.length !== 14) return "argv is not the helper worker shape";
  if (argv[0] !== ENV) return `the program is not ${ENV}`;
  if (typeof argv[1] !== "string" || !argv[1].startsWith("PATH=")) return "no PATH word after the program";
  if (typeof snapshot.path !== "string" || !snapshot.path) return "the proxy has no recorded pane PATH";
  const expectedPath = `PATH=${guardPathWith(snapshot.path, stableGuardDir(snapshot.stableRoot))}`;
  if (argv[1] !== expectedPath) return "the PATH is not the pack's own";
  const words = argv[1].slice("PATH=".length).split(delimiter);
  for (const word of words) if (!word || !isAbsolute(word)) return "a PATH word is not an absolute folder";
  const program = resolveOnPath("dsh-tui", words);
  if (!program) return "dsh-tui is not on the worker PATH";
  // Only the installed shim, by real path: a dsh-tui planted anywhere else on the PATH
  // (a temp or runtime folder, an extra grant) must never be started outside the sandbox.
  if (!sameReal(program, snapshot.shim)) return "dsh-tui is not the installed shim";
  if (insideReal(program, snapshot.caller.project)) return "dsh-tui is inside the writable project";
  if (snapshot.appHome && insideReal(program, snapshot.appHome)) return "dsh-tui is inside the writable app home";
  // The sandboxed worker's own helper wrapper (#631 PR B), exactly as workerArgs builds it:
  // [/usr/bin/env, PATH=..., /bin/sh, <pack>/bin/run.sh, <pack>/hcPane.mjs, --bot, <caller>,
  //  --project, <caller project>, --worker, --, dsh-tui, --, <task>].
  if (argv[2] !== "/bin/sh") return "the helper program is not /bin/sh";
  if (argv[3] !== stableRunner(snapshot.stableRoot)) return "the helper runner is not the stable copy";
  if (argv[4] !== stableHelper(snapshot.stableRoot)) return "the helper is not the stable copy";
  if (argv[5] !== "--bot" || argv[6] !== snapshot.caller.bot) return "--bot is not the caller's bot";
  if (argv[7] !== "--project" || !sameReal(argv[8], snapshot.caller.project)) return "--project is not the caller's project";
  if (argv[9] !== "--worker") return "--worker is missing";
  if (argv[10] !== "--") return "no -- before the helper's command";
  if (argv[11] !== "dsh-tui") return "the helper's program is not dsh-tui";
  if (argv[12] !== "--") return "no -- before the task";
  if (typeof argv[13] !== "string") return "the task is not the one -- <task> word";
  return null;
}

/**
 * The caller the per-pane helper passes at start: the pack works it out outside the sandbox
 * (hcPane.mjs), so the proxy can snapshot the roster before DSH starts and before any sandbox
 * exists. Returns { bot, project, worker }; the terminal's own labels are checked against it.
 */
export function explicitCaller(value) {
  if (!isObject(value)) throw new Error("the caller must be an object");
  const bot = typeof value.bot === "string" ? value.bot.trim() : "";
  const project = typeof value.project === "string" ? value.project : "";
  if (!bot) throw new Error("the caller has no bot id");
  if (!project || !isAbsolute(project)) throw new Error("the caller's project must be an absolute folder");
  let real;
  try {
    real = realpathSync(project);
    if (!statSync(real).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Error(`the caller's project ${project} is not a folder`);
  }
  return { bot, project: real, worker: value.worker === true };
}

/**
 * The proxy's frozen policy for one pane: { terminal, upstream, snapshot: { caller, file,
 * team, ... } }. The snapshot is plain data; no getter reads the writable tree again.
 */
export function policyOf({ terminal, upstream, caller, file, bound, appHome, path, shim, stableRoot, approval, approvalEnv, coreId, projects }) {
  const env = approvalEnv ?? process.env;
  return {
    terminal, upstream, caller, file, bound, appHome, path, shim, stableRoot, approval, approvalEnv, coreId,
    team: teamOf(file, caller, { project: caller?.project, projects, env }),
  };
}

/** Whether `record` is one of the caller's own workers, by its label (hcGuard's send rule). */
function isOwnWorker(record, caller) {
  return typeof record?.labels?.[WORKER_OF_LABEL] === "string" && record.labels[WORKER_OF_LABEL] === caller.bot;
}

/** Whether `record` is the caller's own worker for kill/rm/label: its child or its bot's worker. */
function isOwnWorkerTarget(record, policy) {
  if (policy.caller.worker) return false;
  if (record?.parent === policy.terminal) return true;
  return isOwnWorker(record, policy.caller);
}

/** The team check for get/read/wait: the caller itself, its team graph, or its own workers. */
function teamAllowed(record, policy) {
  if (record?.address === policy.terminal) return true;
  if (isOwnWorker(record, policy.caller)) return true;
  const bot = record?.labels?.bot;
  return typeof bot === "string" && policy.team.has(bot);
}

/** The send check: hcGuard.sendProblem's rules, over the snapshot. */
function sendAllowed(record, policy) {
  const labels = isObject(record?.labels) ? record.labels : {};
  if (isOwnWorker(record, policy.caller)) return true;
  if (typeof labels.bot === "string" && policy.team.has(labels.bot)) return true;
  return sharedSendAllowed(policy.file, policy.caller, labels);
}

/** One short upstream call: connect, send one request, read one reply, close. */
export function upstreamCall(socketPath, method, params, timeoutMs = CONTROL_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    let done = false;
    let buffer = Buffer.alloc(0);
    let timer = null;
    const socket = net.connect(socketPath);
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    timer = setTimeout(() => finish(rejectPromise, new Error(`${method} did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const at = buffer.indexOf(10);
      if (at < 0) {
        if (buffer.length > MAX_REPLY_BYTES) finish(rejectPromise, new Error(`${method} reply is over the ${MAX_REPLY_BYTES}-byte cap`));
        return;
      }
      if (at > MAX_REPLY_BYTES) {
        finish(rejectPromise, new Error(`${method} reply is over the ${MAX_REPLY_BYTES}-byte cap`));
        return;
      }
      const line = buffer.subarray(0, at).toString("utf8");
      try { finish(resolvePromise, JSON.parse(line)); } catch { finish(rejectPromise, new Error(`${method} answered with invalid JSON`)); }
    });
    socket.on("error", (e) => finish(rejectPromise, e));
    socket.on("close", () => finish(rejectPromise, new Error(`${method}: the core closed the connection`)));
  });
}

/** Newline framing over one socket, one line at a time, with a hard line cap. */
class LineReader {
  constructor(socket, maxLine, onLine) {
    this.socket = socket;
    this.maxLine = maxLine;
    this.onLine = onLine;
    this.buffer = Buffer.alloc(0);
    this.paused = false;
    this.stopped = false;
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", () => this.stop());
    socket.on("close", () => this.stop());
  }

  push(chunk) {
    if (this.stopped) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.drain();
  }

  drain() {
    if (this.paused || this.stopped) return;
    for (;;) {
      const at = this.buffer.indexOf(10);
      if (at < 0) {
        if (this.buffer.length > this.maxLine) this.overflow();
        return;
      }
      if (at > this.maxLine) {
        this.overflow();
        return;
      }
      const line = this.buffer.subarray(0, at);
      this.buffer = this.buffer.subarray(at + 1);
      if (!line.length) continue;
      this.paused = true;
      this.socket.pause();
      this.onLine(line);
      return;
    }
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.socket.resume();
    this.drain();
  }

  stop() {
    this.stopped = true;
  }

  overflow() {
    this.stopped = true;
    this.socket.pause();
    try { this.socket.write(`${JSON.stringify(refusal(null, "the request line is over the proxy cap"))}\n`); } catch { /* closing */ }
    this.socket.end();
  }
}

/** The replies of one persistent upstream connection, one line at a time. */
class ReplyReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", (e) => this.fail(e.message));
    socket.on("close", () => this.fail("the core closed the connection"));
  }

  push(chunk) {
    if (this.failure) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.flush();
  }

  next(maxBytes = MAX_REPLY_BYTES) {
    if (this.failure) return Promise.reject(new Error(this.failure));
    return new Promise((resolvePromise, rejectPromise) => {
      this.waiters.push({ resolve: resolvePromise, reject: rejectPromise, maxBytes, limit: false });
      this.flush();
    });
  }

  flush() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      const at = this.buffer.indexOf(10);
      if (at < 0) {
        if (this.buffer.length > waiter.maxBytes) {
          this.waiters.shift();
          const error = new Error(`over the ${waiter.maxBytes}-byte reply cap`);
          error.limit = true;
          waiter.reject(error);
        }
        return;
      }
      if (at > waiter.maxBytes) {
        this.waiters.shift();
        const error = new Error(`over the ${waiter.maxBytes}-byte reply cap`);
        error.limit = true;
        waiter.reject(error);
        continue;
      }
      const line = this.buffer.subarray(0, at).toString("utf8");
      this.buffer = this.buffer.subarray(at + 1);
      this.waiters.shift();
      waiter.resolve(line);
    }
  }

  fail(message) {
    if (this.failure) return;
    this.failure = message;
    while (this.waiters.length) this.waiters.shift().reject(new Error(message));
  }
}

/** The root the pane's socket lives under, with the 0700 checks. */
function socketPathFor(env, terminal, project, appHomeDir) {
  const runtime = env.XDG_RUNTIME_DIR;
  if (typeof runtime !== "string" || !runtime || !isAbsolute(runtime)) {
    throw new Error("XDG_RUNTIME_DIR must be set to an absolute path");
  }
  const runtimeReal = realOrNull(runtime);
  if (!runtimeReal || !statSync(runtimeReal).isDirectory()) throw new Error(`XDG_RUNTIME_DIR ${runtime} is not a folder`);
  const projectReal = realOrNull(project);
  if (projectReal && (runtimeReal === projectReal || runtimeReal.startsWith(`${projectReal}${sep}`))) {
    throw new Error(`XDG_RUNTIME_DIR ${runtime} is inside the writable project ${project}; the proxy socket must live outside it`);
  }
  const appReal = realOrNull(appHomeDir);
  if (appReal && (runtimeReal === appReal || runtimeReal.startsWith(`${appReal}${sep}`))) {
    throw new Error(`XDG_RUNTIME_DIR ${runtime} is inside the app home ${appHomeDir}; the proxy socket must live outside it`);
  }
  return join(runtimeReal, SOCKET_FOLDER, terminal, "hc.sock");
}

/** Create the 0700 socket folder (never under the worktree) and return the socket path. */
function prepareSocket(path) {
  const base = dirname(path);
  const root = dirname(base);
  for (const dir of [root, base]) {
    try {
      const info = lstatSync(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a plain folder`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
      chmodSync(dir, 0o700);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }
  try {
    const info = lstatSync(path);
    if (!info.isSocket()) throw new Error(`${path} exists and is not a socket`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${path} is not owned by this user`);
    unlinkSync(path);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  return path;
}

/** Whether a line is a notification (no id). */
const hasId = (request) => Object.hasOwn(request, "id") && request.id !== undefined;

/** Why the method is refused, for the JSON-RPC error. */
function methodRefusal(method) {
  if (method === "hello") return "hello is not allowed: this proxy carries plain mode only, so framed mode and attach are unreachable";
  if (method === "terminal.attach") return "terminal.attach is not allowed: it needs framed mode, which this proxy refuses";
  return `${method} is not allowed by the proxy allow-list`;
}

/**
 * Start one pane's proxy. Resolves once the socket is listening; every check before that is a
 * refusal to start (the pin, the caller, the approved roster, the socket folder).
 */
export async function startProxy(options = {}) {
  const env = options.env ?? process.env;
  const terminal = String(options.terminal ?? "");
  const upstream = String(options.upstream ?? "");
  const log = options.log ?? (() => {});
  if (!/^t[0-9a-z]+$/.test(terminal)) throw new Error("--terminal must be an hc terminal id (t7, t1b)");
  if (!upstream || !isAbsolute(upstream)) throw new Error("--upstream must be an absolute socket path");
  const home = options.appHome ?? appHome(env);
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : IDLE_TIMEOUT_MS;
  const forwardTimeoutMs = Number.isFinite(options.forwardTimeoutMs) ? options.forwardTimeoutMs : FORWARD_TIMEOUT_MS;
  const explicit = options.caller === undefined || options.caller === null ? null : explicitCaller(options.caller);

  // 1. The core pin: fail closed before any socket exists.
  const status = await upstreamCall(upstream, "server.status", {});
  if (status.error) throw new Error(`server.status failed: ${oneLine(status.error.message)}`);
  const version = status.result?.version;
  if (version !== HC_PIN) throw new Error(`the upstream core is ${version ?? "unknown"}, not the pinned ${HC_PIN}; refusing to start`);
  log({ ev: "pin", version });

  // 2. The caller: the pane's own record. A proxied pane (the helper's explicit caller) reads
  // only the approved roster; the by-hand path keeps the ledger and the working file.
  const callerReply = await upstreamCall(upstream, "terminal.get", { terminal });
  if (callerReply.error) throw new Error(`the caller ${terminal} is not a live terminal: ${oneLine(callerReply.error.message)}`);
  const callerRecord = callerReply.result;
  if (!isObject(callerRecord)) throw new Error(`terminal.get ${terminal} returned no record`);
  let caller;
  let bound;
  if (explicit) {
    // The helper (hcPane.mjs) resolved the caller outside the sandbox; the pane's own labels
    // must still agree, so a helper started for another bot on this terminal is refused.
    const labels = isObject(callerRecord.labels) ? callerRecord.labels : {};
    if (explicit.worker) {
      if (labels[WORKER_OF_LABEL] !== explicit.bot) throw new Error(`the caller ${terminal} is not a worker of ${explicit.bot}`);
      bound = false;
    } else {
      if (labels.bot !== explicit.bot) throw new Error(`the caller ${terminal} does not carry the bot label ${explicit.bot}`);
      bound = options.bound !== false;
    }
    caller = explicit;
  } else {
    // The by-hand path only: an explicit caller never opens the ledger (C1/G2).
    const fold = ledgerSnapshot(home);
    const ledgerBound = boundCaller(fold, terminal);
    if (ledgerBound) {
      if (!ledgerBound.project) throw new Error(`the attach ledger binds ${terminal} but names no project`);
      caller = ledgerBound;
      bound = true;
    } else {
      const of = isObject(callerRecord.labels) ? callerRecord.labels[WORKER_OF_LABEL] : null;
      if (typeof of !== "string" || !of) throw new Error(`the caller ${terminal} is neither bound in the attach ledger nor a worker pane`);
      caller = { bot: of, project: projectOfFolder(callerRecord.cwd), worker: true };
      if (!caller.project) throw new Error(`the worker caller ${terminal} has no project above its cwd`);
      bound = false;
    }
  }
  // The stable root's own check first (it names literal /tmp too), then the data root: the
  // sandbox binds that parent read-only once, so a data root inside a writable tree is refused
  // before its record could be trusted.
  const stableRoot = stableRootOf(env);
  const unsafe = executionPathProblem({ stableRoot, project: caller.project, env,
    node: process.execPath, forbiddenRoots: options.forbiddenRoots });
  if (unsafe) throw new Error(unsafe);
  const botsPath = join(caller.project, ".herdr", "bots.json");
  let file;
  let rosterPath;
  let approval;
  if (explicit) {
    const dataWhy = approvedDataRootProblem({ env, project: caller.project, appHome: home,
      forbiddenRoots: options.forbiddenRoots });
    if (dataWhy) throw new Error(dataWhy);
    let approved;
    try {
      approved = readApprovedRecord({ project: caller.project, env });
    } catch (e) {
      throw new Error(`the approved roster is not usable: ${oneLine(e.message)}`);
    }
    approval = Object.fromEntries(["sha256", "approvedAt", "approvedBy"]
      .map((key) => [key, approved.record[key]]));
    file = approved.file;
    rosterPath = approved.path;
    let working = null;
    try {
      // Compare only a regular file: a symlink or a FIFO planted in the writable project is
      // never opened here, and counts as different.
      const info = lstatSync(botsPath);
      if (info.isFile() && !info.isSymbolicLink()) working = readFileSync(botsPath, "utf8");
    } catch { /* missing or unreadable: it differs */ }
    if (working === null || sha256Of(working) !== approved.record.sha256) {
      log({ ev: "roster_unapproved",
        message: `the working-tree roster ${botsPath} differs from the approved one; `
          + "the approved roster is in force. Run "
          + `\`am proxy approve --project ${caller.project}\` to approve it.` });
    }
  } else {
    try {
      ({ file } = parseBots(readFileSync(botsPath, "utf8")));
    } catch (e) {
      throw new Error(`cannot read the roster ${botsPath}: ${oneLine(e.message)}`);
    }
    rosterPath = botsPath;
  }
  if (!file.bots.some((bot) => bot.id === caller.bot)) {
    const hint = explicit
      ? `; run \`am proxy approve --project ${caller.project}\`` : "";
    throw new Error(`the caller ${terminal}'s bot ${caller.bot} `
      + `is not in the roster ${rosterPath}${hint}`);
  }
  // The PATH the proxy records is the one hcPane started it with, outside the sandbox. Every
  // word must be outside the trees a sandboxed bot can write; a worker start may only repeat it.
  const panePath = typeof env.PATH === "string" ? env.PATH : "";
  if (!panePath) throw new Error("the pane PATH is not set; the proxy cannot pin the worker PATH");
  const tempRoot = env.TMPDIR || tmpdir();
  const forbidden = [
    { root: caller.project, why: "the writable project" },
    { root: home, why: "the writable app home" },
    { root: tempRoot, why: "the temp folder" },
    ...(env.XDG_RUNTIME_DIR ? [{ root: env.XDG_RUNTIME_DIR, why: "the runtime folder" }] : []),
  ];
  for (const word of panePath.split(delimiter)) {
    if (!word || !isAbsolute(word)) throw new Error(`the pane PATH word ${word || "(empty)"} is not an absolute folder`);
    if (sameReal(word, stableGuardDir(stableRoot))) continue;
    const real = realOrNull(word);
    for (const { root, why } of forbidden) {
      if (real ? insideReal(real, root) : insideLexical(word, root)) {
        throw new Error(`the pane PATH word ${word} is inside ${why}; refusing to start the proxy`);
      }
    }
  }
  const snapshot = { terminal, upstream, caller, file, bound: Boolean(bound), appHome: home, path: panePath, shim: shimPathOf(env), stableRoot,
    coreId: status.result?.core?.id, approval, approvalEnv: { HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME } };
  const policy = policyOf(snapshot);
  log({ ev: "snapshot", caller: caller.bot, project: caller.project, worker: caller.worker, bots: file.bots.length });

  // 3. The socket folder: 0700, outside the writable project and the app home.
  const socketPath = socketPathFor(env, terminal, caller.project, home);
  const pathBytes = Buffer.byteLength(socketPath);
  const pathLimit = socketPathLimit(options.platform ?? process.platform);
  if (pathBytes > pathLimit) {
    throw new Error(`socket path is ${pathBytes} bytes, over the ${pathLimit}-byte limit`);
  }
  prepareSocket(socketPath);
  const sessions = new Set();
  const server = net.createServer((client) => {
    if (sessions.size >= MAX_CONNECTIONS) {
      client.write(`${JSON.stringify(refusal(null, `too many connections (${MAX_CONNECTIONS} max)`, "limit"))}\n`);
      client.end();
      return;
    }
    const session = new Session({ client, policy, log, idleTimeoutMs, forwardTimeoutMs, onClose: () => sessions.delete(session) });
    sessions.add(session);
    session.start();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (e) => rejectPromise(e);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch (e) {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    try { unlinkSync(socketPath); } catch { /* gone */ }
    throw e;
  }
  log({ ev: "listening", socket: socketPath, upstream });
  server.on("error", (e) => log({ ev: "server_error", message: oneLine(e.message) }));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const session of sessions) session.close();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  };
  return { socket: socketPath, server, policy, snapshot, close };
}

/** One downstream client: its own upstream, serial requests, caller overwrite and policy. */
class Session {
  constructor({ client, policy, log, idleTimeoutMs, forwardTimeoutMs, onClose }) {
    this.client = client;
    this.policy = policy;
    this.log = log;
    this.onClose = onClose;
    this.idleTimeoutMs = idleTimeoutMs;
    this.forwardTimeoutMs = forwardTimeoutMs;
    this.idleTimer = null;
    this.upstream = null;
    this.reader = null;
    this.dead = null;
    this.closed = false;
    this.readerIn = new LineReader(client, MAX_REQUEST_BYTES, (line) => {
      this.clearIdle();
      this.handle(line)
        .catch((e) => this.log({ ev: "error", message: oneLine(e?.message ?? e) }))
        .finally(() => {
          this.armIdle();
          this.readerIn.resume();
        });
    });
    this.armIdle();
  }

  start() {
    this.client.on("close", () => this.close());
    this.client.on("error", () => this.close());
  }

  /** Close a connection that has had no request in flight for the idle timeout. */
  armIdle() {
    this.clearIdle();
    if (!(this.idleTimeoutMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.log({ ev: "idle_close" });
      this.close();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.readerIn.stop();
    try { this.client.destroy(); } catch { /* gone */ }
    try { this.upstream?.destroy(); } catch { /* gone */ }
    this.onClose();
  }

  async ensureUpstream() {
    if (this.dead) throw new Error(this.dead);
    if (this.upstream) return this.upstream;
    const socket = net.connect(this.policy.upstream);
    this.reader = new ReplyReader(socket);
    await new Promise((resolvePromise, rejectPromise) => {
      const onConnect = () => {
        socket.off("error", onError);
        socket.off("close", onClose);
        resolvePromise();
      };
      const onError = (e) => {
        socket.off("connect", onConnect);
        socket.off("close", onClose);
        rejectPromise(e);
      };
      const onClose = () => rejectPromise(new Error("the core closed the connection"));
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    }).catch((e) => {
      this.dead = `upstream unavailable: ${oneLine(e.message)}`;
      socket.destroy();
      throw new Error(this.dead);
    });
    socket.on("close", () => {
      this.dead ??= "upstream unavailable: the core closed the connection";
    });
    socket.on("error", (e) => {
      this.dead ??= `upstream unavailable: ${oneLine(e.message)}`;
    });
    this.upstream = socket;
    return socket;
  }

  writeError(id, why, kind = "refused") {
    this.writeLine(`${JSON.stringify(refusal(id, why, kind))}\n`).catch(() => {});
  }

  /** Write one line, waiting for the client to drain when its buffer is full. */
  async writeLine(line) {
    if (this.client.destroyed) return;
    if (this.client.write(line)) return;
    await new Promise((resolvePromise) => {
      const done = () => {
        this.client.off("drain", done);
        this.client.off("close", done);
        resolvePromise();
      };
      this.client.once("drain", done);
      this.client.once("close", done);
    });
  }

  async handle(line) {
    let request;
    try {
      request = JSON.parse(line.toString("utf8"));
    } catch {
      this.log({ ev: "refused", why: "parse" });
      this.writeError(null, "the request is not JSON", "invalid");
      return;
    }
    if (!isObject(request) || typeof request.method !== "string") {
      this.writeError(isObject(request) ? request.id : null, "the message is not a JSON-RPC request", "invalid");
      return;
    }
    const method = request.method;
    const id = hasId(request) ? request.id : null;
    const reply = (why, kind) => {
      if (hasId(request)) this.writeError(id, why, kind);
      this.log({ ev: "refused", method, why });
    };
    if (!ALLOWED.has(method)) {
      reply(methodRefusal(method));
      return;
    }
    const params = isObject(request.params) ? { ...request.params } : {};
    const unknown = unknownParam(params, method);
    if (unknown) {
      reply(`${method}: unknown parameter ${unknown}`);
      return;
    }
    if (CALLER_METHODS.has(method)) params.caller = this.policy.terminal;

    if (method === "proxy.workerTransport") {
      if (!this.policy.approval || !this.policy.bound) {
        reply("proxy.workerTransport: only an approved bot pane has a worker transport");
        return;
      }
      if (hasId(request)) this.client.write(`${JSON.stringify({ jsonrpc: "2.0", id,
        result: { v: 1, terminal: this.policy.terminal, core: { id: this.policy.coreId } } })}\n`);
      return;
    }
    if (method === "terminal.list") {
      await this.forward(request, method, params);
      return;
    }
    if (method === "templates.list" || method === "terminal.run") {
      let templates = [];
      try {
        // By-hand proxies retain their helper-only shape. New allowances need explicit approval.
        const bot = this.policy.approval ? workerApproval(this.policy) : null;
        const name = bot?.worker?.template;
        if (method === "templates.list" && (!name || !this.policy.bound)) {
          reply("templates.list: only a bound bot with an approved worker template may list it");
          return;
        }
        if (name) {
          const result = await upstreamCall(this.policy.upstream, "templates.list", {});
          if (result.error || !Array.isArray(result.result?.templates)) {
            throw new Error("approved worker templates are unavailable from the core");
          }
          templates = result.result.templates.filter((row) => row?.name === name);
        }
        if (method === "templates.list") {
          // Recheck after the asynchronous metadata read too; never return a stale allowance.
          workerApproval(this.policy);
          if (hasId(request)) this.client.write(`${JSON.stringify({ jsonrpc: "2.0", id,
            result: { templates } })}\n`);
          return;
        }
      } catch (e) {
        reply(`${method}: approved worker refused: ${oneLine(e.message)}`);
        return;
      }
      const why = runProblem(params, this.policy, templates);
      if (why) {
        reply(`terminal.run: ${why}`);
        return;
      }
      // runProblem above already required parent and worker.of to equal this pane and bot:
      // identity is checked, never rewritten.
      await this.forward(request, method, params);
      return;
    }
    if (method === "terminal.wait" && params.children === true) {
      // --children waits on the caller's own children; no target can widen it.
      delete params.terminal;
      await this.forward(request, method, params);
      return;
    }
    if (typeof params.terminal !== "string" || !params.terminal) {
      reply(`${method}: no terminal target`);
      return;
    }
    if (params.terminal.includes("/")) {
      reply(`${method}: a linked-machine target (machine/tN) is not allowed`);
      return;
    }
    if (method === "terminal.read" && params.lines !== undefined) {
      if (typeof params.lines !== "number" || !Number.isInteger(params.lines) || params.lines < 0) {
        reply("terminal.read: lines is not a whole number");
        return;
      }
      if (params.lines > MAX_READ_LINES) {
        reply(`terminal.read: ${params.lines} lines is over the ${MAX_READ_LINES}-line cap; ask for fewer lines`, "limit");
        return;
      }
    }
    let record;
    try {
      const answer = await upstreamCall(this.policy.upstream, "terminal.get", { terminal: params.terminal });
      if (answer.error || !isObject(answer.result) || typeof answer.result.address !== "string") {
        const kind = answer.error?.data?.kind ?? "not_found";
        reply(`${method}: the target ${params.terminal} could not be resolved (${kind})`);
        return;
      }
      record = answer.result;
    } catch (e) {
      reply(`${method}: ${oneLine(e.message)}`, "unavailable");
      return;
    }
    if (record.address.includes("/")) {
      reply(`${method}: a linked-machine target (machine/tN) is not allowed`);
      return;
    }
    let why = null;
    if (OWN_WORKER_METHODS.has(method)) {
      if (!isOwnWorkerTarget(record, this.policy)) why = "the target is not the caller's own worker";
    } else if (method === "terminal.send") {
      if (!sendAllowed(record, this.policy)) why = "the target is not in the caller's team";
    } else if (TEAM_METHODS.has(method)) {
      if (!teamAllowed(record, this.policy)) why = "the target is not in the caller's team";
    }
    if (why) {
      reply(`${method}: ${why}`);
      return;
    }
    params.terminal = record.address;
    await this.forward(request, method, params);
  }

  /** Forward one request on the client's own upstream and write its reply line back. */
  async forward(request, method, params) {
    const id = hasId(request) ? request.id : null;
    const forwarded = { jsonrpc: "2.0", method, params };
    if (hasId(request)) forwarded.id = id;
    let socket;
    try {
      socket = await this.ensureUpstream();
    } catch (e) {
      if (hasId(request)) this.writeError(id, oneLine(e.message), "unavailable");
      return;
    }
    if (!socket.write(`${JSON.stringify(forwarded)}\n`)) {
      await new Promise((resolvePromise) => {
        const done = () => {
          socket.off("drain", done);
          socket.off("close", done);
          resolvePromise();
        };
        socket.once("drain", done);
        socket.once("close", done);
      });
    }
    if (!hasId(request)) return;
    const waits = method === "terminal.wait" || (method === "terminal.send" && params.wait === true);
    let line;
    try {
      const reply = this.reader.next();
      line = waits ? await reply : await withTimeout(reply, this.forwardTimeoutMs);
    } catch (e) {
      const why = e?.limit
        ? `${method}: ${oneLine(e.message)}`
        : e?.timeout
          ? `${method}: ${oneLine(e.message)}`
          : `${method}: upstream unavailable: ${oneLine(e.message)}`;
      this.writeError(id, why, e?.limit ? "limit" : "unavailable");
      // The upstream line is desynced (or gone): answer, then close this connection only.
      try { this.upstream?.destroy(); } catch { /* gone */ }
      this.readerIn.stop();
      this.client.end();
      return;
    }
    await this.writeLine(`${line}\n`);
  }
}

/** The CLI's usage. */
const USAGE = `usage: hcProxy.mjs --terminal <tN> --upstream <socket> [--app-home <dir>]
  --terminal   the pane's hc terminal id, fixed for this proxy (required)
  --upstream   the real herdr-core socket (required; the proxy never guesses it)
  --app-home   the app home holding automagik-herdr/attach.jsonl (default: HERDR_APP_HOME,
               else ~/.config/herdr-app)
  XDG_RUNTIME_DIR must name the 0700 folder the per-pane socket lives under.`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "--help" || word === "-h") { out.help = true; continue; }
    if (!word.startsWith("--")) throw new Error(`unknown argument ${word}`);
    const key = word.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

/** Run the proxy until a signal; used when this file is the executable. */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!args.terminal || args.terminal === true) throw new Error("--terminal is required");
  if (!args.upstream || args.upstream === true) throw new Error("--upstream is required");
  const proxy = await startProxy({
    terminal: String(args.terminal),
    upstream: String(args.upstream),
    appHome: typeof args["app-home"] === "string" ? args["app-home"] : undefined,
    env,
    log: (event) => process.stderr.write(`hc-proxy ${JSON.stringify(event)}\n`),
    forbiddenRoots: options.forbiddenRoots,
  });
  const stop = () => {
    proxy.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise(() => {});
}

const invoked = process.argv[1] ? pathToFileURL(realOrNull(resolve(process.argv[1])) ?? resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().then((code) => {
    if (typeof code === "number") process.exitCode = code;
  }).catch((e) => {
    process.stderr.write(`hc-proxy: ${oneLine(e?.message ?? e)}\n`);
    process.exitCode = 1;
  });
}
