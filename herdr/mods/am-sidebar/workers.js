// Bot workers: a bot writes no code; for each task it starts one worker, an hc child of its
// pane, in the task's worktree (`automagik-herdr worker`). This file holds the plain-data
// parts: which agent, model and effort (or hc template) a worker runs, its `hc run` arguments, the task
// worktree's folder and the git answers about worktrees, and the rows of the workers ledger
// usagemeter reads. Pure: no `herdr`, `gpui-*` or `fs`, so `node --test`, the CLI and the
// briefing hook share it. Apache-2.0.

import { AGENTS, AGY_MODE_DEFAULT, CODEX_NETWORK, agyModeArgs, agyModeOf, agyModeProblem, agyGuarded, agySettingsArgs, codexClean, codexCleanNote, codexDirVar, codexDirsExact, codexOptionArity, effortArgs,
  hasEffortFlag, launchRun, modelArgs, modelRefusal, promptArgs, resolveAgent } from "./models.js";
import { TEMPLATE_SHAPE } from "./model.js";
import { envWords } from "./logins.js";

export { TEMPLATE_SHAPE };

/** A Windows drive-letter path (`C:/x`, `C:\x`): `new URL` would read `C:` as a scheme. */
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;
/** A URL scheme (`file:`, `http:`), as opposed to a bare path. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * `path`'s folder plus `/<name>`; a bare path loses its query/hash first. A drive-letter path
 * written with backslashes comes back with backslashes only, never a mix of both separators
 * (#694); off a drive letter a backslash stays as it is.
 */
function guardDirUnder(path, name = "guard") {
  const file = path.replace(/[?#].*$/, "");
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const dir = `${cut === -1 ? "." : file.slice(0, cut)}/${name}`;
  return DRIVE_LETTER.test(file) && file.includes("\\") ? dir.split("/").join("\\") : dir;
}

/**
 * The guard folder beside a mod file, from `import.meta.url`. Node gives a `file:` URL; Herdr's
 * mod runtime gives a bare path with its `?v=1` cache buster, which `new URL` cannot take as a
 * base. A Windows drive-letter path is bare too: `new URL` would read `C:` as a scheme and drop
 * the drive. A file: pathname that does not decode (a lone `%`) falls back to the undecoded
 * pathname, never the raw `file:` string. A bare path is stripped of its query/hash, then its
 * folder gets `/guard`; never throws. `name`: another folder beside the mod file (`hc-kill`).
 */
export function guardDirOf(metaUrl, name = "guard") {
  const raw = String(metaUrl);
  if (DRIVE_LETTER.test(raw) || !SCHEME.test(raw)) return guardDirUnder(raw, name);
  let pathname;
  try {
    pathname = new URL(`./${name}/`, raw).pathname;
  } catch {
    // Not a URL this Node can read (say a relative path): the bare-path rule is all that is left.
    return guardDirUnder(raw, name);
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A lone `%` is not an escape: keep the pathname the parser gave.
  }
  return pathname.replace(/\/+$/, "");
}

/**
 * The deny-by-default hc guard's folder (automagik#624, `guard/hc`): put first on a dsh-tui
 * pane's PATH only, by startArgs and workerArgs. A guardrail, never a boundary: an absolute
 * hc path, a raw socket or `hc connect` skips it; #628 is the full send/keys/attach scope; #631 is the hard boundary.
 */
export const GUARD_DIR = guardDirOf(import.meta.url);

/** The kill shim's folder name, beside the mod's files as `guard` is. */
export const KILL_GUARD_NAME = "hc-kill";
/**
 * The `hc kill` shim's folder (#955, `hc-kill/hc`, hcGuard.mjs runKillGuard): put first on the
 * PATH of every pane the pack starts for an agent other than dsh-tui (which keeps the full
 * guard). It refuses `hc kill` to every worker and to every seat that is not its project's
 * main bot, and passes every other hc call to the real hc untouched. A guardrail, never a
 * boundary: an absolute hc path, a raw socket or `hc connect` skips it.
 */
export const KILL_GUARD_DIR = guardDirOf(import.meta.url, KILL_GUARD_NAME);
/** The pack folder a pane of `agent` gets first on its PATH: the full guard, the kill shim, or none (no agent named). */
export const paneGuardOf = (agent) => (agent === "dsh-tui" ? GUARD_DIR : agent ? KILL_GUARD_DIR : null);
/** Whether a PATH word is a kill shim's folder, by its name (the full guard's is `guard`). */
export const isKillGuardWord = (dir) => typeof dir === "string" && /(^|\/)hc-kill\/*$/.test(dir);

/**
 * `path` with `guard` first; a guard folder already on the PATH is moved to the front, never
 * repeated. A null guard leaves the path exactly as it is. A pane has one of the pack's two
 * folders, and the stricter one wins:
 * - the kill shim onto a PATH that already holds the full guard beside it (a Claude or Codex
 *   worker started from a dsh-tui bot's pane inherits that pane's PATH): the PATH is left as
 *   it is. The worker keeps the full guard it had before the shim existed, which limits its
 *   send, label and run calls to the team and holds the same kill rule;
 * - the full guard onto a PATH that holds the shim (a dsh-tui worker of a Claude bot): the
 *   shim is taken out.
 */
export function guardPathWith(path, guard) {
  if (!guard || !path) return path;
  const words = String(path).split(":");
  if (isKillGuardWord(guard)) {
    const full = guard.replace(/hc-kill\/*$/, "guard");
    if (words.includes(full) || (guard === KILL_GUARD_DIR && words.includes(GUARD_DIR))) return path;
    return [guard, ...words.filter((dir) => dir !== guard)].join(":");
  }
  const drop = guard === GUARD_DIR ? [GUARD_DIR, KILL_GUARD_DIR] : [guard, guard.replace(/guard\/*$/, KILL_GUARD_NAME)];
  return [guard, ...words.filter((dir) => !drop.includes(dir))].join(":");
}

/**
 * `path` with this pack's guard folder first for a dsh-tui pane; any other agent's path
 * unchanged (byte for byte, so a non-dsh-tui start stays as it was).
 */
export function guardPath(path, agent) {
  return agent === "dsh-tui" ? guardPathWith(path, GUARD_DIR) : path;
}

/**
 * The per-pane helper and the launcher that finds its Node (#631 PR B), beside this module.
 * The helper starts the hc proxy before DSH, so the sandbox the pane later creates never sees
 * an unsnapshotted roster or attach ledger. am carries byte-equal copies of both (am-copies).
 */
export const dataHomeOf = (env = process.env) =>
  env.XDG_DATA_HOME || (env.HOME ? `${env.HOME}/.local/share` : "");
/** The pack's data root: the stable execution folder and the approved rosters both live here. */
export const dataRootOf = (env = process.env) => {
  const dataHome = dataHomeOf(env);
  if (!dataHome) throw new Error("HOME or XDG_DATA_HOME is required for the pack's data root");
  return `${dataHome}/automagik-herdr`;
};
export const stableRootOf = (env = process.env) => `${dataRootOf(env)}/dsh-sandbox`;
export const stableGuardDir = (root) => `${root}/guard`;
/** The kill shim in the stable folder: what a sandboxed bot's worker of another agent gets (the proxy matches it). */
export const stableKillDir = (root) => `${root}/${KILL_GUARD_NAME}`;
export const stableHelper = (root) => `${root}/hcPane.mjs`;
export const stableRunner = (root) => `${root}/bin/run.sh`;
/** The saved per-bot opt-in. Environment variables never enable another bot's proxy. */
export const hcProxyEnabled = (bot, platform = process.platform) =>
  platform === "linux" && bot?.hcProxy === true;

/**
 * The pane command for a dsh-tui pane: `/bin/sh <run.sh> <hcPane.mjs> --bot <id> [--project
 * <dir>] [--worker] -- <the agent's own argv>`. The helper starts the proxy, then runs the argv
 * as its child; `run.sh` is the pack's Node finder (the core's PATH may have no node).
 */
export function paneArgs(argv, { botId, project = null, worker = false, stableRoot = null } = {}) {
  if (typeof botId !== "string" || !botId) throw new Error("paneArgs needs the pane's bot id");
  stableRoot ??= stableRootOf();
  return ["/bin/sh", stableRunner(stableRoot), stableHelper(stableRoot), "--bot", botId,
    ...(project ? ["--project", project] : []), ...(worker ? ["--worker"] : []), "--", ...argv];
}

// The usage-tagging contract: usagemeter reads the workers ledger first (its start, session and
// end rows, below; RFC 0021) and these labels only as a second witness, seen at a sync: a worker
// terminal carries `worker.of=<botId>`, `branch=<branch>` and `worker.role=<role>`, and its cwd
// is the task worktree. Started with Genie's task id (`--task`), it also carries `task=<id>`,
// `task.project=<main checkout>` and `task.lead=<lead bot>`; usagemeter joins on (project, task).
// A worker started before the task contract has no `branch` label: its `task` label is the
// branch (workerBranch reads either). The ledger outranks a label whenever they disagree.
export const WORKER_OF_LABEL = "worker.of";
export const TASK_LABEL = "task";
export const TASK_PROJECT_LABEL = "task.project";
export const TASK_LEAD_LABEL = "task.lead";
export const BRANCH_LABEL = "branch";
/** What a worker does in its worktree: one of ROLES. */
export const WORKER_ROLE_LABEL = "worker.role";
export const WORKER_MODEL_LABEL = "worker.model";
export const WORKER_EFFORT_LABEL = "worker.effort";
/** The Antigravity execution mode a worker runs (`--mode`): written only when it isn't auto. */
export const WORKER_AGY_MODE_LABEL = "worker.agyMode";
/** The hc template a worker runs (`--template`, or the bot's `worker.template`). */
export const WORKER_TEMPLATE_LABEL = "worker.template";
/** The Claude session a terminal runs, set by the briefing hook when it changes. */
export const SESSION_LABEL = "agent.session";
/** The pane label the briefing hook sets to the session's transcript path (RFC 0015 delivery 2). */
export const TRANSCRIPT_LABEL = "agent.transcript";

/** A worker's roles. Dev, test and fix write to the worktree; review never does. */
export const ROLES = ["dev", "test", "review", "fix"];
export const WRITER_ROLES = ["dev", "test", "fix"];
const ROLE_OF_RANK = { tester: "test", reviewer: "review", fixer: "fix" };

/**
 * A worker's role: `given` (--role) when it is one of ROLES, else from the bot's rank
 * (tester: test, reviewer: review, fixer: fix, any other rank or none: dev). { role } or { error }.
 */
export function workerRole(bot, given) {
  if (given === undefined || given === null) return { role: ROLE_OF_RANK[bot?.rank] ?? "dev" };
  if (ROLES.includes(given)) return { role: given };
  return { error: `--role is one of ${ROLES.join(", ")}, not "${given}".` };
}

/**
 * Whether a live worker's labels make it a writer: a writer role, or no role label at all
 * (a worker started before roles holds its worktree until it ends).
 */
export const writesWorktree = (labels) => labels?.[WORKER_ROLE_LABEL] !== "review";

/** Genie's short task id (gh-1415, gl-231, gn-42); the internal `t_…` key is refused apart. */
export const TASK_SHAPE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** A lead: a bot id (`b-` plus 10 base32 characters) or a Genie session (`session-<uuid>`). */
export const LEAD_SHAPE = /^(?:b-[a-z2-7]{10}|session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The ranks whose task workers name their lead: the task belongs to another bot. */
export const LEAD_RANKS = ["reviewer", "fixer"];
/** hc's terminal names: 1-32 of a-z 0-9 - _ (`hc run --name`). */
export const HC_NAME_MAX = 32;

/** Why `--task <id>` can't be used, or null. */
export function taskIdProblem(taskId) {
  if (typeof taskId !== "string") return "--task needs Genie's short task id (gn-N, gh-N or gl-N).";
  if (taskId.startsWith("t_")) return "internal Genie id; pass the short id gn-N, gh-N or gl-N";
  if (!TASK_SHAPE.test(taskId)) {
    return `--task: "${taskId}" isn't a short task id (a-z, 0-9 and "-", at most 41, no dash first: gn-42, gh-1415, gl-231).`;
  }
  return null;
}

/**
 * Whether `branch` names task `taskId` as a whole token: preceded by its start, "/", "-" or
 * "_", and followed by its end, "/", "-" or "_" (fix/gl-231-login names gl-231, not gl-23).
 */
export function branchNamesTask(branch, taskId) {
  if (typeof branch !== "string" || typeof taskId !== "string" || !taskId) return false;
  for (let at = branch.indexOf(taskId); at >= 0; at = branch.indexOf(taskId, at + 1)) {
    const before = at === 0 ? "" : branch[at - 1];
    const after = branch[at + taskId.length] ?? "";
    if ((before === "" || "/-_".includes(before)) && (after === "" || "/-_".includes(after))) return true;
  }
  return false;
}

/** A task worker's terminal name: exactly `<id>-<role>`, never suffixed. */
export const taskWorkerName = (taskId, role) => `${taskId}-${role}`;

/** A worker's branch from its labels: `branch`, else (started before the task contract) `task`. */
export const workerBranch = (labels) => labels?.[BRANCH_LABEL] || labels?.[TASK_LABEL] || null;
/** A worker's Genie task id: `task` beside a `branch` label (without one, `task` is the old branch). */
export const workerTaskId = (labels) => (labels?.[BRANCH_LABEL] ? labels?.[TASK_LABEL] || null : null);

/**
 * Whether a task runs its bot's other arm (planned swaps): `byte` is the first byte of
 * sha256(`${botId}:${projectKey}:${taskId}`), computed by the caller (no `node:` import
 * here). One task in three, by rule, the same for every worker of that bot on that task.
 */
export const swapByte = (byte) => Number.isInteger(byte) && byte % 3 === 0;

/** A bot's swap arm (`worker.swap`: { agent?, model?, effort? }) as a workerPlan pick, or null. */
export function swapArm(bot) {
  const w = bot?.worker;
  const swap = w && typeof w === "object" && w.swap && typeof w.swap === "object" && !Array.isArray(w.swap) ? w.swap : null;
  if (!swap) return null;
  const arm = {};
  for (const k of ["agent", "model", "effort"]) if (typeof swap[k] === "string" && swap[k]) arm[k] = swap[k];
  return Object.keys(arm).length ? arm : null;
}

/**
 * Whether a worker with this `pick` runs an hc template: a per-task template, or the bot's
 * default template with no per-task agent, model or effort. A template worker never swaps.
 */
export function runsTemplate(bot, pick = {}) {
  if (pick.template) return true;
  const defaults = bot?.worker && typeof bot.worker === "object" ? bot.worker : {};
  return Boolean(defaults.template) && !["agent", "model", "effort"].some((k) => pick[k]);
}

/** A value the agent would read as an option (a model, a task text starting with a dash). */
export const optionLike = (value) => typeof value === "string" && value.trimStart().startsWith("-");

/** An effort level as the agents spell them (low, medium, high, xhigh, max, …). */
export const EFFORT_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a worker runs: the per-task `pick` ({ template, agent, model, effort }, each optional)
 * over the bot's `worker` defaults, over the bot's own agent. A template owns its command, so
 * it runs alone: a pick naming a template and an agent, model or effort is refused; a default
 * template wins over default agent, model and effort (with a warning); and any per-task agent,
 * model or effort sets a default template aside. A bot's default model is for its default
 * worker agent: a task that picks another agent runs that agent's own default model unless it
 * names one. The bot's own model pin is its seat's, never its workers'. An Antigravity worker
 * always gets `--mode` (the bot's `worker.agyMode`, auto by default; an unknown one is refused).
 * A model or effort the agent has no flag for is left out with a warning. `agents`: the table
 * Herdr starts from. A Codex worker runs the pack's Codex launch mode (#1125); its source's own
 * approval and sandbox words are left out with a warning naming them (`where`: the launch's
 * models.js codexWhere, so an --add-dir of the home folder or an app home goes too, by any alias).
 * Returns { template, agent, model, effort, agyMode, argv, warnings } (template null, or agent,
 * model, effort, agyMode and argv null) or { error }.
 */
export function workerPlan(bot, pick = {}, agents = AGENTS, where = null) {
  const warnings = [];
  const defaults = bot?.worker && typeof bot.worker === "object" ? bot.worker : {};
  const picked = ["agent", "model", "effort"].filter((k) => pick[k]);
  const asTemplate = (template) => (TEMPLATE_SHAPE.test(template) ? { template, agent: null, model: null, effort: null, agyMode: null, argv: null, warnings }
    : { error: `"${template}" isn't an hc template name (letters, digits, ".", "_" and "-", no dash first).` });
  if (pick.template) {
    if (picked.length) return { error: `A template owns its command: --template goes alone, without --${picked.join(", --")}.` };
    return asTemplate(pick.template);
  }
  if (defaults.template && !picked.length) {
    const shadowed = ["agent", "model", "effort"].filter((k) => defaults[k]);
    if (shadowed.length) warnings.push(`${bot.name}'s worker template ${defaults.template} owns its command; its worker ${shadowed.join(", ")} default${shadowed.length > 1 ? "s are" : " is"} ignored.`);
    return asTemplate(defaults.template);
  }
  let fallback = bot?.agent ?? null;
  if (defaults.agent) {
    const key = resolveAgent(defaults.agent, agents);
    if (key) fallback = key;
    else warnings.push(`${bot.name}'s worker agent "${defaults.agent}" isn't one Herdr knows; its own agent ${fallback} is used.`);
  }
  let agent = fallback;
  if (pick.agent) {
    agent = resolveAgent(pick.agent, agents);
    if (!agent) return { error: `"${pick.agent}" isn't a coding agent Herdr knows. Known: ${Object.keys(agents).join(", ")}.` };
  }
  if (!agent || !agents[agent]?.run?.length) return { error: `${bot?.name ?? "This bot"} has no coding agent for its workers; pass --agent.` };
  // The bot's worker agyMode reaches only an Antigravity worker; an unknown one is refused by
  // name, never replaced with the default behind the person's back.
  const agyModeWhy = agent === "antigravity" ? agyModeProblem(defaults.agyMode) : null;
  if (agyModeWhy) {
    const fix = bot?.id ? ` Fix it with am edit ${bot.id} --worker-agy-mode <accept-edits|auto|plan>.` : "";
    return { error: `${bot?.name ?? "This bot"}'s workers: ${agyModeWhy}${fix}` };
  }
  const agyMode = agent === "antigravity" ? agyModeOf(defaults.agyMode) : null;
  // An agent whose model and effort its own setup decides (dsh-tui, #598): a model or effort
  // asked for, or set in the bot's worker defaults for it, is refused, never left out unsaid.
  // Defaults count only when they are that agent's (the bot's own agent), as the model default
  // does: a Claude captain's worker effort never stops its dsh-tui worker (#600 review F4).
  const refusal = modelRefusal(agent);
  if (refusal && (pick.model || pick.effort || (agent === fallback && (defaults.effort || defaults.model)))) return { error: refusal };
  let model = pick.model || null;
  if (!model && defaults.model) {
    if (agent === fallback) model = defaults.model;
    else warnings.push(`${bot.name}'s worker model ${defaults.model} is for ${fallback}; ${agent} runs its own default.`);
  }
  if (model && optionLike(model)) return { error: `"${model}" isn't a model: it starts with a dash, so ${agent} would read it as an option.` };
  let effort = pick.effort || (defaults.effort && (agent === fallback || !refusal) ? defaults.effort : null) || null;
  if (!pick.effort && defaults.effort && agent !== fallback && refusal) {
    warnings.push(`${bot.name}'s worker effort ${defaults.effort} is for ${fallback}; ${agent} runs its own default.`);
  }
  if (effort && !EFFORT_SHAPE.test(effort)) return { error: `"${effort}" isn't an effort level (low, medium, high, …).` };
  if (model && !modelArgs(agent, model).length) {
    warnings.push(`${agents[agent].name} has no model flag this pack knows; model ${model} left out.`);
    model = null;
  }
  if (effort && !hasEffortFlag(agent)) {
    warnings.push(`${agents[agent].name} has no effort flag; effort ${effort} left out.`);
    effort = null;
  }
  const cleaned = agent === "codex" ? codexCleanNote(agents[agent].run, where) : null;
  if (cleaned) warnings.push(cleaned);
  // A task worker is not its lead's persistent Hermes Bot Chat.
  const argv = [...launchRun(agent, agents[agent].run, { ...bot, hermes: undefined }, where), ...agyModeArgs(agent, agyMode), ...modelArgs(agent, model),
    ...effortArgs(agent, effort)];
  return { template: null, agent, model, effort, agyMode, argv, warnings };
}

/**
 * Why the bot `botId`, calling from its own pane `self`, may not end the terminal `target`
 * (its `hc get`), or null when it may (#955: `hc kill` is denied to an Antigravity launch, so
 * `worker kill` is how a lead ends a worker it started). Only a worker of the caller's own bot:
 * its `worker.of` label names that bot, it is no bot's seat (`bound`: the attach ledger ties it
 * to a bot; a `bot` label counts too), it is never the caller's own pane, and it is not mid-turn
 * (hc's status says `working`): a finished turn only. One line.
 */
export function workerKillRefusal({ target, botId, self = null, bound = false }) {
  const address = target?.address ?? null;
  if (!target || !address) return "that isn't a terminal hc knows";
  if (self && address === self) return `${address} is your own pane; worker kill ends only a worker you started`;
  const labels = target.labels ?? {};
  if (bound || labels.bot) return `${address} is a bot's pane, not a worker; worker kill ends only a worker you started`;
  const owner = labels[WORKER_OF_LABEL] ?? null;
  if (!owner) return `${address} isn't a worker (it has no ${WORKER_OF_LABEL} label); worker kill ends only a worker you started`;
  if (!botId || owner !== botId) return `${address} is another bot's worker; worker kill ends only a worker you started`;
  // A worker mid-turn is not ended from here: its work would be lost. The project's main bot can.
  if (target.state !== "finished" && target.status?.state === "working") {
    return `${address} is still working; worker kill ends a worker that has finished its turn (hc wait ${address}), and only the project's main bot ends one mid-turn`;
  }
  return null;
}

/**
 * `hc run` arguments for a worker: in the background, a child of the bot's pane, in the
 * task worktree, with the usage labels and no `bot` label (a worker is never a bot, so the
 * sidebar folds it under its bot as a helper). The task text is the agent's last argument
 * (behind `-i` for agy: models.js promptArgs, by `agent`; none at all for kimi, whose task the
 * CLI sends as its first message, #1032), after `--`, never part of a shell string. An agent runs as `/usr/bin/env PATH=<path> <argv>`
 * (env by its full path, so nothing hangs on core's PATH), so it gets the calling pane's PATH,
 * not herdr-core's (a bun script like omp needs ~/.bun/bin). A
 * `template` runs in hc's documented template form, `<template> <task>` after the options,
 * with no `--` (neither starts with a dash: both are refused before): it sets its own command.
 * `login`: a Claude worker's login words (logins.js chooseLogin), after PATH. A Claude template
 * can't take them through hc's template form, so it runs its own command instead
 * (`templateArgv`, `sh -c '<command> "$@"' sh <task>`, as Restart re-runs a template) under
 * `/usr/bin/env <login words>`, its template label kept. `agyMode`: an Antigravity worker's
 * execution mode (auto by default), written in the `worker.agyMode` label only when it isn't
 * auto, so Restart --tree runs it with the same mode. `agySettingsPath`: the permission file an
 * Antigravity worker reads (`--settings`, models.js agySettings*), so its task argv carries it;
 * null for every other agent, whose task argv is as it was. `agent` `dsh-tui`: the pack's
 * deny-by-default hc guard folder goes first on the worker PATH (GUARD_DIR); a guardrail, not a
 * boundary (#624, #628, #631). `sandbox`: a dsh-tui worker runs behind the per-pane hc proxy
 * (hcPane.mjs) before DSH starts; `project` is the main checkout the proxy snapshots (omitted:
 * the helper finds the project above the worktree). `session`: the Claude session id the worker's
 * argv starts it on (`--session-id`), set as its agent.session label too. Any other agent gets
 * the `hc kill` shim's folder first instead (KILL_GUARD_DIR, #955); `killGuard` names another
 * copy of it (the stable folder's, for a worker the hc proxy approves), null for none.
 */
export function workerArgs({ botId, branch, role, name, cwd, parent, agent, model, effort, agyMode, argv, task, template, path,
  taskId, project, lead, space, login = [], templateArgv = null, sandbox = false, stableRoot = null, session = null,
  agySettingsPath = null, killGuard = undefined }) {
  const args = ["run", "--bg", "--json"];
  if (name) args.push("--name", name);
  args.push("--cwd", cwd, "--label", `${WORKER_OF_LABEL}=${botId}`);
  if (taskId) {
    args.push("--label", `${TASK_LABEL}=${taskId}`, "--label", `${TASK_PROJECT_LABEL}=${project}`);
    if (lead) args.push("--label", `${TASK_LEAD_LABEL}=${lead}`);
  }
  args.push("--label", `${BRANCH_LABEL}=${branch}`);
  if (role) args.push("--label", `${WORKER_ROLE_LABEL}=${role}`);
  // The session id Herdr chose for a new Claude worker (RFC 0021 (f) 2; its argv carries --session-id).
  if (session) args.push("--label", `${SESSION_LABEL}=${session}`);
  // The bot's Herdr space and no tab: the worker opens in a tab of its own there.
  if (space) args.push("--label", `herdr.space=${space}`);
  if (template && templateArgv) {
    return [...args, "--label", `${WORKER_TEMPLATE_LABEL}=${template}`, "--parent", parent, "--", ENV, ...envWords([], login), ...templateArgv];
  }
  if (template) return [...args, "--label", `${WORKER_TEMPLATE_LABEL}=${template}`, "--parent", parent, template, task];
  if (model) args.push("--label", `${WORKER_MODEL_LABEL}=${model}`);
  if (effort) args.push("--label", `${WORKER_EFFORT_LABEL}=${effort}`);
  if (agyMode && agyMode !== AGY_MODE_DEFAULT) args.push("--label", `${WORKER_AGY_MODE_LABEL}=${agyMode}`);
  const sandboxRoot = sandbox === true && agent === "dsh-tui" ? (stableRoot ?? stableRootOf()) : null;
  const guard = sandboxRoot ? stableGuardDir(sandboxRoot)
    : agent === "dsh-tui" ? GUARD_DIR : agent ? (killGuard === undefined ? KILL_GUARD_DIR : killGuard) : null;
  const vars = envWords(path ? [`PATH=${guardPathWith(path, guard)}`] : [], login);
  const env = vars.length ? [ENV, ...vars] : [];
  // #955: an Antigravity worker with no permission file never runs on skip-permissions.
  const taskArgv = [...agyGuarded(agent, [...argv, ...agySettingsArgs(agent, agySettingsPath)]), ...promptArgs(agent, task)];
  const launchArgv = sandboxRoot ? paneArgs(taskArgv, { botId, project: project ?? null, worker: true, stableRoot: sandboxRoot }) : taskArgv;
  return [...args, "--parent", parent, "--", ...env, ...launchArgv];
}

/** A program path's own name (`/bin/sh` is `sh`). */
const shellBase = (p) => String(p ?? "").split("/").pop();

// The shells whose `-c` carries a script a template's command may be wrapped in.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

// The characters that end a simple command in a shell command string.
const SEPARATORS = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A shell command string's simple commands: each a word list, split on ; & | ( ) < > and
 * newlines outside quotes. Quotes group a word and are dropped, a backslash escapes the next
 * character. Never throws on an unclosed quote.
 */
function shellCommands(text) {
  const commands = [];
  let words = [], word = "", quote = null, has = false;
  const endWord = () => { if (has) { words.push(word); word = ""; has = false; } };
  const endCommand = () => { endWord(); if (words.length) { commands.push(words); words = []; } };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < text.length) { word += text[++i]; has = true; continue; }
      word += ch; has = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { word += text[++i]; has = true; continue; }
    if (SEPARATORS.has(ch)) { endCommand(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch; has = true;
  }
  endCommand();
  return commands;
}

/**
 * The programs a command string runs: for each simple command, its first word after env
 * assignments and the wrappers env, exec and nohup; a shell's `-c` script is followed the same
 * way, a few levels deep. A word in argument position is never a program.
 */
function commandRuns(text, depth = 0) {
  const out = [];
  const commands = shellCommands(text);
  commands.forEach((words, n) => {
    let i = 0;
    for (;;) {
      while (i < words.length && ASSIGNMENT.test(words[i])) i += 1;
      const name = shellBase(words[i]);
      if (name === "env") {
        i += 1;
        while (i < words.length) {
          if (words[i] === "-u" || words[i] === "--unset") { i += 2; continue; }
          if (words[i].startsWith("-") || ASSIGNMENT.test(words[i])) { i += 1; continue; }
          break;
        }
        continue;
      }
      if (name === "exec" || name === "nohup") { i += 1; continue; }
      if (SHELLS.has(name) && words[i + 1] === "-c" && typeof words[i + 2] === "string") {
        if (depth < 4) out.push(...commandRuns(words[i + 2], depth + 1));
        i = words.length;
        break;
      }
      break;
    }
    // `last`: the command string's last simple command, at its top level (where "$@" lands).
    if (i < words.length) out.push({ program: shellBase(words[i]), args: words.slice(i + 1), last: depth === 0 && n === commands.length - 1 });
  });
  return out;
}

/** The programs a command string runs (commandRuns), in order. */
const commandPrograms = (text) => commandRuns(text).map((r) => r.program);

/** The agent key `program` names (a key, an agent's run[0] or a match name), or null. */
function agentOfProgram(program, agents) {
  for (const [key, agent] of Object.entries(agents)) {
    if (key === program || shellBase(agent?.run?.[0]) === program || (agent?.match ?? []).includes(program)) return key;
  }
  return null;
}

/**
 * The agent an hc template's command runs: the one agent its simple commands' programs name,
 * after env assignments and the wrappers env, exec and nohup, a shell's `-c` script followed the
 * same way (`sh -c "omp --auto-approve"`, also behind env assignments). A word in argument
 * position never counts (`echo omp` names nothing), and more than one agent fails closed (null),
 * so the restart falls back to the source rather than adopt another agent's command.
 */
export function templateAgent(command, agents = AGENTS) {
  const found = new Set();
  for (const program of commandPrograms(String(command ?? ""))) {
    const key = agentOfProgram(program, agents);
    if (key) found.add(key);
  }
  return found.size === 1 ? [...found][0] : null;
}

// The Codex options a template could mean for its launch: when one comes after the run's `--`,
// Codex reads it as prompt text, never as the option (#1142).
const CODEX_LOST_OPTIONS = new Set(["--approve-for-me", "--no-daemon", "--disable", "--enable", "-c", "--config", "--add-dir",
  "-a", "--ask-for-approval", "-s", "--sandbox", "--remote", "--dangerously-bypass-approvals-and-sandbox", "--yolo",
  "-p", "--profile"]);
const optionName = (w) => (w.startsWith("--") ? w.split("=")[0] : w.startsWith("-c") || w.startsWith("-a") || w.startsWith("-s") ? w.slice(0, 2) : w);
// A positional-parameter expansion in a shell command ($@, $*, ${@…}, ${*…}): where the words after a command go.
const POSITIONAL = /\$(?:[@*]|\{[@*])/g;
const isPositional = (w) => /^\$(?:[@*]|\{[@*]\})$/.test(w);

// #1142, codexForwards: the words commandArgv passes a shell command land where its "$@" is (it
// appends one when the command has none). A literal word is unquoted letters, digits and
// `_@%+=:,./-`, '…', or "…" without $, ` or a backslash; its decoded value is what counts.
const QUOTED_ARGS = '"$@"';
const LITERAL = /^(?:[A-Za-z0-9_@%+=:,./-]|'[^']*'|"[^"$`\\]*")+/;
const WORD_END = /[ \t;\n&]/;
const NAME_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const decoded = (raw) => raw.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double);

/**
 * Whether shell command `command`, run the way commandArgv runs it, provably hands the words
 * after it to Codex as options (#1142). It is matched against one shape, never interpreted:
 * setup commands, each only literal assignments (NAME=word ...) or `export` of them, joined by
 * `;`, `&&` or a newline, then one Codex run: literal assignments, an optional `exec`, an unquoted
 * word naming Codex and literal words, with exactly one "$@" among them (the command's own, or
 * the one commandArgv appends) and no `--` (decoded: a quoted '--' ends Codex's options too).
 * An assignment and `export` (a POSIX special built-in, found before any function) only set
 * variables: no code runs and the positional parameters stay as passed. Every word is literal,
 * so no expansion can move, drop or end the words; "$@" is the only one. Anything else (set,
 * shift, eval, ., source, a function, an alias, cd or any other program before Codex, a
 * conditional, a pipe, a subshell, a group, `&`, a redirection, a substitution, $*, an unquoted
 * $@, "${@}", a variable or ~ in a word, a glob, a comment) proves nothing. Nor does an assignment
 * to a word that places the launch's folders or program (models.js codexDirVar: HOME, PATH, XDG_*,
 * CODEX_*, the cache words), or a Codex word that isn't an option of known arity with its value in
 * place (models.js codexOptionArity: a subcommand, a prompt, an unknown flag, a flag whose value
 * would be a forwarded word). This proves where the words land against Codex's flags as the pack
 * lists them, not Codex's own parser.
 */
export function codexForwards(command, agents = AGENTS) {
  const text = String(command ?? "");
  const effective = (text.includes(QUOTED_ARGS) ? text : `${text} ${QUOTED_ARGS}`).replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  const commands = [[]];
  const ends = (n) => n === effective.length || WORD_END.test(effective[n]);
  for (let i = 0; i < effective.length;) {
    const ch = effective[i];
    if (ch === " " || ch === "\t") { i += 1; continue; }
    if (ch === ";" || ch === "\n") { commands.push([]); i += 1; continue; }
    if (effective.startsWith("&&", i)) { commands.push([]); i += 2; continue; }
    if (effective.startsWith(QUOTED_ARGS, i) && ends(i + QUOTED_ARGS.length)) {
      commands.at(-1).push({ args: true });
      i += QUOTED_ARGS.length;
      continue;
    }
    const m = LITERAL.exec(effective.slice(i));
    if (!m || !ends(i + m[0].length)) return false;
    commands.at(-1).push({ raw: m[0], value: decoded(m[0]) });
    i += m[0].length;
  }
  if (commands.some((c) => c.length === 0)) return false;
  // #1142: an assignment that could move the launch's folders or its program (HOME, PATH, XDG_*, a
  // cache word...; models.js codexDirVar) proves nothing: the folders were weighed for the pane's own.
  const assignment = (w) => !w.args && NAME_ASSIGNMENT.test(w.raw) && !codexDirVar(w.raw.slice(0, w.raw.indexOf("=")));
  const setup = commands.slice(0, -1).every((c) => {
    const words = c[0].raw === "export" ? c.slice(1) : c;
    return words.length > 0 && words.every(assignment);
  });
  if (!setup) return false;
  const run = commands.at(-1);
  let i = 0;
  while (i < run.length && assignment(run[i])) i += 1;
  if (run[i] && !run[i].args && run[i].raw === "exec") i += 1;
  const program = run[i];
  if (!program || program.args || program.raw !== program.value || agentOfProgram(shellBase(program.value), agents) !== "codex") return false;
  const words = run.slice(i + 1);
  if (commands.flat().filter((w) => w.args).length !== 1 || !words.some((w) => w.args) || !words.every((w) => w.args || w.value !== "--")) return false;
  // #1142: every Codex word around "$@" is an option of known arity with its value in place, so
  // none can take a forwarded word as its value or turn the rest into a subcommand's or a prompt.
  let pending = false;
  for (const w of words) {
    if (w.args) { if (pending) return false; continue; }
    if (pending) { if (w.value.startsWith("-")) return false; pending = false; continue; }
    const arity = codexOptionArity(w.value);
    if (arity === null) return false;
    pending = arity === "value";
  }
  return !pending;
}

/**
 * What a shell command that runs Codex (an hc template's, a helper's) says about the pack's
 * Codex launch mode (#1125), read from its words, never changed: null when it runs no Codex
 * (or another agent too). Only a Codex run's words before its `--` are options (#1142).
 * `conflicts`: the flags among them that pick Codex's approvals or sandbox, or an `--add-dir`
 * `where` doesn't allow (models.js codexClean, by name: bypass, -a, -s, the -c keys, --remote,
 * --add-dir) or that isn't written as the canonical value it is checked as (codexDirsExact,
 * #1142: the text is never rewritten); `missing`: the pack mode words they lack, in the order the mode has them
 * (`--approve-for-me`, `--disable hooks`, `--no-daemon`, network on); `lost`: Codex options
 * written after a run's `--`, by name (prompt text to Codex); `forwards`: words after the
 * command provably reach Codex as options: Codex runs once, as the top-level last simple
 * command, with no `--`, the command expands no positional parameter ($@, $*) except as that
 * run's own word (an earlier "$@" takes them all, and commandArgv then adds none), and the
 * whole command has the one shape codexForwards proves (#1142: set --, shift and the rest don't).
 */
export function codexCommandCheck(command, agents = AGENTS, where = null) {
  const text = String(command ?? "");
  if (templateAgent(text, agents) !== "codex") return null;
  const runs = commandRuns(text).filter((r) => agentOfProgram(r.program, agents) === "codex");
  const split = (args) => { const cut = args.indexOf("--"); return cut < 0 ? [args, []] : [args.slice(0, cut), args.slice(cut + 1)]; };
  const options = runs.map((r) => split(r.args)[0]);
  const all = (test) => options.length > 0 && options.every((a) => test(a));
  const pair = (args, flag, value) => args.some((w, i) => (w === flag && args[i + 1] === value) || w === `${flag}=${value}`);
  const config = (args, value) => pair(args, "-c", value) || pair(args, "--config", value) || args.includes(`-c${value}`);
  const missing = [];
  if (!all((a) => a.includes("--approve-for-me"))) missing.push("--approve-for-me");
  if (!all((a) => pair(a, "--disable", "hooks") || config(a, "features.hooks=false"))) missing.push("--disable", "hooks");
  if (!all((a) => a.includes("--no-daemon"))) missing.push("--no-daemon");
  if (!all((a) => config(a, CODEX_NETWORK))) missing.push("-c", CODEX_NETWORK);
  const inexact = options.some((a) => !codexDirsExact(a, where)) ? ["--add-dir"] : [];
  const conflicts = [...new Set([...options.flatMap((a) => codexClean(["codex", ...a], where).dropped), ...inexact])];
  const lost = [...new Set(runs.flatMap((r) => split(r.args)[1].map(optionName).filter((n) => CODEX_LOST_OPTIONS.has(n))))];
  const only = runs.length === 1 && runs[0].last ? runs[0] : null;
  const expansions = (text.match(POSITIONAL) ?? []).length;
  const forwards = Boolean(only) && !only.args.includes("--") && expansions === only.args.filter(isPositional).length
    && codexForwards(text, agents);
  return { conflicts, missing, lost, forwards, single: runs.length === 1 && runs[0].last };
}

/**
 * Why a worker template whose Codex run puts a Codex option after its `--` is not started
 * (#1142, the lead's condition): Codex would read that option as prompt text, so the launch the
 * template means can't be proved. Null when none does. The owner's template exception keeps every
 * other template as written (never rewritten, rerouted or stripped).
 */
export function codexTemplateRefusal(template, command, agents = AGENTS) {
  const check = codexCommandCheck(command, agents);
  if (!check?.lost.length) return null;
  return `Template ${template} runs Codex with ${check.lost.join(", ")} after its --, where Codex reads ${check.lost.length > 1 ? "them" : "it"} `
    + `as prompt text, not as options, so the launch it means can't be proved: not started (#1142). Put those options before -- `
    + `in that template's file (hc templates lists it).`;
}

/**
 * The warning for a worker template whose command runs Codex without --no-daemon among its
 * options (#1125): hc says Codex must run with it, or its commands run outside hc. The owner's
 * template exception keeps the command as it is (never rewritten, rerouted or refused): this
 * names the fix.
 */
export function codexTemplateWarning(template, command, agents = AGENTS) {
  const check = codexCommandCheck(command, agents);
  if (!check || !check.missing.includes("--no-daemon")) return null;
  return `Template ${template} runs Codex without --no-daemon, so its commands may run in Codex's shared server, outside hc `
    + `(hc --skill). Add --no-daemon to the codex command in that template's file (hc templates lists it).`;
}

/** The env program agent workers start under, by its full path (macOS and Linux both have it). */
export const ENV = "/usr/bin/env";

/** A branch name as a folder name: lowercase, `/` and other marks as `-`. */
export function branchSlug(branch) {
  return String(branch).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64) || "task";
}

/** The exclude line that keeps task worktrees out of the main checkout's `git add -A`. */
export const WORKTREES_EXCLUDE = "/.claude/worktrees/";

/** Where a new task worktree goes: `<main checkout>/.claude/worktrees/<slug>`. */
export const worktreeFolder = (mainCheckout, branch) => `${mainCheckout === "/" ? "" : mainCheckout.replace(/\/+$/, "")}/.claude/worktrees/${branchSlug(branch)}`;

/** `git worktree list --porcelain` as [{ path, branch (short name, or null), detached, bare }]. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? null;
    out.push({ path, branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : ref,
      detached: lines.includes("detached"), bare: lines.includes("bare") });
  }
  return out;
}

/**
 * The refs a new task branch may start from, in order: `--base` alone when given; else
 * origin/HEAD's branch, then dev, then main, then master (each as origin's, then local). The caller takes
 * the first that git verifies.
 */
export function baseCandidates(given, originHead) {
  if (given) return [given];
  const out = [];
  if (originHead) out.push(originHead);
  for (const name of ["dev", "main", "master"]) out.push(`origin/${name}`, name);
  return [...new Set(out)];
}

// ---- the workers ledger: <app home>/automagik-herdr/workers.jsonl ----
//
// Append-only, one JSON object per line, each line one O_APPEND write, the file the owner's
// alone (0600: usagemeter refuses a group- or world-writable one). Rows outlive the terminals:
// usagemeter joins its usage to bots and tasks through them. Every field added since the first
// rows is additive: a reader that doesn't know one ignores it, and an old row without it still
// reads (RFC 0021: `valid_from` is then the row's `at`, and it has no end).

export const LEDGER_FILE = "automagik-herdr/workers.jsonl";
export const ledgerPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${LEDGER_FILE}`;
/** The workers ledger's mode, on creation and on every append (RFC 0021 (f) 6). */
export const LEDGER_MODE = 0o600;
const stamp = (at) => new Date(at ?? Date.now()).toISOString();
const orNull = (x) => (x === undefined || x === "" ? null : x);
const msOrNull = (x) => (Number.isSafeInteger(x) ? x : null);

/**
 * A start row: a worker (`kind: "worker"`, `worktree` its cwd as a real path) or a bot seat
 * (`kind: "seat"`, from start, restart, attach and --tree; `worktree` its folder). `task`:
 * Genie's task id (`--task`), else null; rows written before the task contract hold the branch
 * there, with no `branch` key. `branch`: the worker's branch. `project`: the main checkout
 * (usagemeter joins on project and task); `lead`: a worker's task lead, a seat's effective lead
 * (null for the main bot); `base`: the commit the worktree started from; `created`: this command
 * made the worktree. `swap`: the task ran the bot's other arm (planned swaps); `override`: the
 * bot picked the agent, model, effort or template itself; `override_requested`: on a swap task,
 * the { agent?, model?, effort? } it asked for and didn't get, else null. `pid` is the
 * terminal's foreground pid when hc gave one. `template`: the hc template a worker runs (its
 * agent, model and effort are then null), else null. `role`: a worker's role (ROLES), a seat's
 * pane role at launch (launchArgs.js roleOf: main, captain or a rank), else null.
 * RFC 0021: `core` (this computer's hc core id) and `created_ms` (the terminal's, from hc get)
 * key the launch with `terminal`, since hc reuses terminal ids; `squad` (model.js squadOf, frozen
 * here at launch); `session`: the Claude session the launch runs (the id Herdr chose with
 * --session-id, or the one it resumed), else null. A seat's worker fields are null or false.
 */
export function startRow({ kind, terminal, pid, botId, task, branch, project, lead, worktree, base, created, agent, model, effort,
  template, role, swap, override, overrideRequested, core, createdMs, squad, session, at }) {
  const requested = overrideRequested && Object.keys(overrideRequested).length ? { ...overrideRequested } : null;
  return { event: "start", kind, terminal, pid: Number.isInteger(pid) ? pid : null, botId, task: orNull(task),
    worktree: orNull(worktree), agent: orNull(agent), model: orNull(model), effort: orNull(effort), template: orNull(template),
    role: orNull(role), branch: orNull(branch), project: orNull(project), lead: orNull(lead), base: orNull(base),
    created: created === true, swap: swap === true, override: override === true, override_requested: requested,
    core: orNull(core), created_ms: msOrNull(createdMs), squad: orNull(squad), session: orNull(session), at: stamp(at) };
}

/**
 * A session row: the session (and its transcript) a terminal now runs. `agent`: the harness
 * (absent or null: Claude's, as the briefing hook's rows always were); `core` and `created_ms`
 * key the launch when the writer knows them, else they are left out.
 */
export function sessionRow({ terminal, session, transcript, agent, core, createdMs, at }) {
  return { event: "session", terminal, session, transcript: orNull(transcript),
    ...(agent && agent !== "claude" ? { agent } : {}),
    ...(core ? { core } : {}), ...(Number.isSafeInteger(createdMs) ? { created_ms: createdMs } : {}), at: stamp(at) };
}

/** Why a launch ended in the ledger's eyes: the CLI replaced its terminal, or a sweep found it finished. */
export const END_REASONS = ["replaced", "finished"];

/** An end reason or a signal name as usagemeter reads one (hc.rs end_word): letters, digits, `_` and `-`, at most 32. */
const END_WORD = /^[A-Za-z0-9_-]{1,32}$/;
const endWord = (x) => typeof x === "string" && END_WORD.test(x);

/**
 * An end row (RFC 0021 (f) 4): the launch keyed by (`core`, `terminal`, `created_ms`) ended at
 * `at`. Written only once the terminal really ended: after the CLI's hc kill of it succeeded
 * (`replaced`), or when the worktree sweep found it finished (`finished`, `at` its finished_ms).
 * How the terminal itself ended, when hc said (#899): `hc_reason` is hc's own word (`exited`,
 * `killed`, `stopped_by_restart` and its others), `exit_code` and `signal` what hc gave with it; a second,
 * durable source for usagemeter once hc has forgotten the terminal. `exit_code` and `signal`
 * are written only beside an `hc_reason` usagemeter can read (END_WORD): it counts a status
 * with no reason as a failed run, and a kill or a restart is not one. A row hc said nothing
 * for has none of the three keys, as every row before them.
 */
export function endRow({ kind, terminal, core, createdMs, reason, hcReason, exitCode, signal, at }) {
  const how = endWord(hcReason) ? { hc_reason: hcReason,
    ...(Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {}),
    ...(Number.isSafeInteger(signal) || endWord(signal) ? { signal } : {}) } : {};
  return { event: "end", kind: orNull(kind), terminal, core: orNull(core), created_ms: msOrNull(createdMs), reason, ...how, at: stamp(at) };
}

/** A launch's key in the ledger: `core`, `terminal` and `created_ms`, or null when one is missing. */
export const launchKey = (r) => (typeof r?.core === "string" && r.core && typeof r.terminal === "string" && r.terminal
  && Number.isSafeInteger(r.created_ms) ? `${r.core}\n${r.terminal}\n${r.created_ms}` : null);

/**
 * The end rows a sweep writes (`kind` worker, reason finished): for each worker start row on
 * this computer (`core`) whose terminal `gets` (hc get answers by address) shows finished, with
 * the same created_ms (a reused id is another terminal), and whose launch has no end row yet.
 * A start row with no created_ms or core (written before RFC 0021) never gets one. Each row
 * copies how hc says the terminal ended (its `reason`, `exit_code` and `signal`, endRow).
 */
export function finishedEnds(rows, gets, core, at = null) {
  const ended = new Set(rows.filter((r) => r?.event === "end").map(launchKey).filter(Boolean));
  const out = [];
  for (const r of rows) {
    if (r?.event !== "start" || r.kind !== "worker" || r.core !== core) continue;
    const key = launchKey(r);
    const get = gets.get?.(r.terminal) ?? null;
    if (!key || ended.has(key) || !get || get.created_ms !== r.created_ms || !Number.isSafeInteger(get.finished_ms)) continue;
    ended.add(key);
    out.push(endRow({ kind: "worker", terminal: r.terminal, core, createdMs: r.created_ms, reason: "finished",
      hcReason: get.reason, exitCode: get.exit_code, signal: get.signal, at: at ?? get.finished_ms }));
  }
  return out;
}

// ---- pull requests (#899): `event: "pr"` rows in the workers ledger ----
//
// usagemeter's time to a pull request reads them (ledger.rs parse_pr): one row each time the
// worktree sweep sees a worker branch's pull request for the first time, or sees its state or
// one of its times change. The newest row of a (project, branch, pr) is the one that counts.
// A row holds the pull request's number, state and times and nothing else of it: never its
// title, author, text, commit or address.

/** A pull request's states in a `pr` row (gh's OPEN, MERGED and CLOSED). */
export const PR_STATES = ["open", "merged", "closed"];
/** usagemeter's bounds on a `pr` row's project and branch, in bytes, and on a task tag (ledger.rs). */
const PR_PROJECT_BYTES = 1024;
const PR_BRANCH_BYTES = 255;
const PR_TASK_CHARS = 64;
const PR_TASK_JSON_BYTES = 96;
/** A control character, as Rust's char::is_control has it (Cc). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A string's length in UTF-8 bytes (no Buffer or TextEncoder here: Herdr's mod runtime loads this file too). */
const bytes = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
const prText = (s, max) => typeof s === "string" && s !== "" && bytes(s) <= max && !CONTROL.test(s);
const prTask = (t) => typeof t === "string" && t !== "" && [...t].length <= PR_TASK_CHARS
  && bytes(JSON.stringify(t)) - 2 <= PR_TASK_JSON_BYTES && !CONTROL.test(t) && !/[;:]/.test(t);
/** The years a `pr` row's time may be in: usagemeter refuses a row holding one outside them. */
const PR_TIME_FROM = Date.UTC(2000, 0, 1);
const PR_TIME_TO = Date.UTC(2100, 0, 1);
/** A time (ISO text, as gh and git print it, or ms) as a row holds it, or null when it is none or can't be read. */
export function prTime(x) {
  const ms = typeof x === "number" ? x : typeof x === "string" && x ? Date.parse(x) : x instanceof Date ? x.getTime() : NaN;
  return Number.isFinite(ms) && ms >= PR_TIME_FROM && ms < PR_TIME_TO ? new Date(ms).toISOString() : null;
}

/**
 * A `pr` row, or null when usagemeter would refuse it: `project` (the main checkout) and
 * `branch` are named, within its bounds and hold no control character; `pr` is the pull
 * request's number; `state` is one of PR_STATES, in any case (gh's is upper); a merged one says
 * when. `firstCommitAt`: the author date of the branch's first commit, read from git by the
 * sweep; `openedAt`, `mergedAt`, `closedAt`: gh's createdAt, mergedAt and closedAt. A time
 * that is missing or can't be read is null. `task` (Genie's task id) is left out when not
 * given or not a tag usagemeter keeps; `core` when not known.
 */
export function prRow({ project, branch, task, pr, state, firstCommitAt, openedAt, mergedAt, closedAt, core, at }) {
  const is = typeof state === "string" ? state.toLowerCase() : null;
  if (!prText(project, PR_PROJECT_BYTES) || !prText(branch, PR_BRANCH_BYTES) || !Number.isSafeInteger(pr) || pr <= 0
    || !PR_STATES.includes(is)) return null;
  const merged = prTime(mergedAt);
  if (is === "merged" && !merged) return null;
  return { event: "pr", project, branch, ...(prTask(task) ? { task } : {}), pr, state: is,
    first_commit_at: prTime(firstCommitAt), opened_at: prTime(openedAt), merged_at: merged, closed_at: prTime(closedAt),
    ...(typeof core === "string" && core ? { core } : {}), at: stamp(at) };
}

const branchKey = (project, branch) => `${project}\n${branch}`;
/** A worker branch's key in the sweep's own lists: its project and its name. */
export const prBranchKey = (r) => branchKey(r.project, r.branch);
/** The `pr` rows among `rows` a reader can key: a project, a branch and a number. */
const prRowsOf = (rows) => rows.filter((r) => r?.event === "pr" && typeof r.project === "string" && r.project
  && typeof r.branch === "string" && r.branch && Number.isSafeInteger(r.pr));
/** What a `pr` row says of its pull request, beyond which one it is. */
const PR_FACTS = ["first_commit_at", "opened_at", "merged_at", "closed_at"];

/**
 * The `pr` rows to append for one worker branch, from gh's list of its pull requests (`list`:
 * [{ number, state, createdAt, mergedAt, closedAt, firstCommitAt }], the last one the sweep's
 * own reading of git for that pull request). One row per pull request the ledger (`rows`) has
 * no row for, or whose newest row there says another state or another time; none when nothing
 * changed. The first commit is git's while git can still tell, and never later than the pull
 * request's opening (the branch's commits are then another pull request's: a name used again);
 * else the one a row already recorded: a branch deleted since keeps what was read in time.
 */
export function prRowsFor({ project, branch, task, list, rows, core, at }) {
  const newest = new Map();
  for (const r of prRowsOf(rows)) if (r.project === project && r.branch === branch) newest.set(r.pr, r);
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object" || seen.has(item.number)) continue;
    seen.add(item.number);
    const last = newest.get(item.number) ?? null;
    const opened = prTime(item.createdAt);
    const first = prTime(item.firstCommitAt);
    const row = prRow({ project, branch, task, pr: item.number, state: item.state,
      firstCommitAt: first && (!opened || first <= opened) ? first : prTime(last?.first_commit_at),
      openedAt: opened, mergedAt: item.mergedAt, closedAt: item.closedAt, core, at });
    if (!row) continue;
    if (last && last.state === row.state && PR_FACTS.every((k) => prTime(last[k]) === row[k])) continue;
    out.push(row);
  }
  return out;
}

/** How long after its last worker start or `pr` row a branch's pull requests are still followed. */
export const PR_WATCH_MS = 30 * 24 * 60 * 60 * 1000;
/** A branch git shows no push of is asked about for this long after its last worker start. */
export const PR_QUIET_WATCH_MS = 3 * 24 * 60 * 60 * 1000;
/** A branch likely to have news is asked about again after a quarter of its idle time, within these. */
export const PR_ASK_MIN_MS = 10 * 60 * 1000;
export const PR_ASK_MAX_MS = 6 * 60 * 60 * 1000;
/** A branch git shows no push of is first asked about this long after its last worker start, then this often. */
export const PR_QUIET_FIRST_MS = 60 * 60 * 1000;
export const PR_QUIET_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The worker branches of the ledger's `rows`: each (project, branch) a worker start row names
 * (a row from before the task contract holds the branch in `task`), as { project, branch, task,
 * base, started, last, open, recorded, followed }, the most recently active first. `task`: its
 * newest start row's task id; `base`: the commit its worktree started from (the newest row that
 * made the worktree, else the newest that names one); `started`: its newest start row's time;
 * `last`: that or its newest `pr` row's, the later; `open`: a pull request of it is open;
 * `recorded`: it has a `pr` row. `followed`: a sweep still asks gh for its pull requests: a
 * branch with no `pr` row, one with a pull request still open, and one a worker started on
 * again after its pull requests all merged or closed (it may open another); never one whose
 * pull requests all ended with no worker since, nor one idle for PR_WATCH_MS.
 */
export function prBranches(rows, now = Date.now()) {
  const by = new Map();
  for (const r of rows) {
    if (r?.event !== "start" || r.kind !== "worker" || typeof r.project !== "string" || !r.project) continue;
    const named = "branch" in r;
    const branch = named ? r.branch : r.task;
    if (typeof branch !== "string" || !branch) continue;
    const key = branchKey(r.project, branch);
    const w = by.get(key) ?? { project: r.project, branch, task: null, base: null, made: false, started: 0, last: 0, open: false, recorded: false, followed: false };
    by.set(key, w);
    const at = Date.parse(r.at);
    if (Number.isFinite(at) && at >= w.started) w.started = at;
    if (named) w.task = typeof r.task === "string" && r.task ? r.task : w.task;
    if (typeof r.base === "string" && r.base && (r.created === true || !w.made)) { w.base = r.base; w.made = w.made || r.created === true; }
  }
  const prs = new Map();
  for (const r of prRowsOf(rows)) {
    const key = prBranchKey(r);
    if (!by.has(key)) continue;
    if (!prs.has(key)) prs.set(key, new Map());
    prs.get(key).set(r.pr, r);
  }
  const out = [];
  for (const [key, { made, ...w }] of by) {
    const newest = [...(prs.get(key)?.values() ?? [])];
    const ended = Math.max(0, ...newest.map((r) => Date.parse(r.at)).filter(Number.isFinite));
    w.recorded = newest.length > 0;
    w.open = newest.some((r) => r.state === "open");
    w.last = Math.max(w.started, ended);
    w.followed = !(w.recorded && !w.open && w.started <= ended) && now - w.last <= PR_WATCH_MS;
    out.push(w);
  }
  return out.sort((a, b) => b.last - a.last);
}
/** The worker branches a sweep still follows (prBranches' `followed` ones). */
export const prWatch = (rows, now = Date.now()) => prBranches(rows, now).filter((w) => w.followed);

/**
 * Whether a followed branch (prWatch's `w`) is likely to have news: a pull request of it is
 * open, or git shows it was pushed (`pushed`) and the ledger has no pull request of it yet.
 */
export const prLikely = (w, pushed) => w.open || (pushed === true && !w.recorded);

/**
 * When gh is next asked for a followed branch's pull requests, in ms (Infinity: not again).
 * `checked`: when it was last asked (null: never). One likely to have news (prLikely) is asked
 * a quarter of the time it has been idle after it was last asked or last active, the later,
 * from PR_ASK_MIN_MS to PR_ASK_MAX_MS: often while its work is fresh, a few times a day once it
 * rests. Any other (a branch git shows no
 * push of, or one whose pull requests all ended) is asked PR_QUIET_FIRST_MS after its last
 * worker start, then every PR_QUIET_EVERY_MS, for PR_QUIET_WATCH_MS.
 */
export function prAskDue(w, { pushed = false, checked = null, now = Date.now() } = {}) {
  const asked = Number.isFinite(checked) ? Math.min(checked, now) : null;
  const idle = Math.max(0, now - w.last);
  if (prLikely(w, pushed)) return Math.max(asked ?? 0, w.last) + Math.min(Math.max(idle / 4, PR_ASK_MIN_MS), PR_ASK_MAX_MS);
  if (now - w.started > PR_QUIET_WATCH_MS) return Infinity;
  return asked === null || asked < w.started ? w.started + PR_QUIET_FIRST_MS : asked + PR_QUIET_EVERY_MS;
}

/** When the sweep last asked gh for each followed branch's pull requests: <app home>/automagik-herdr/pr-checks.json. */
export const PR_CHECKS_FILE = "automagik-herdr/pr-checks.json";
export const prChecksPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${PR_CHECKS_FILE}`;
/** That file's text as a Map of prBranchKey to ms; empty for a file that is missing or not this shape. */
export function readPrChecks(text) {
  const out = new Map();
  let file = null;
  try { file = JSON.parse(text); } catch { return out; }
  if (file?.v !== 1 || !Array.isArray(file.checked)) return out;
  for (const c of file.checked) {
    if (typeof c?.project === "string" && typeof c.branch === "string" && Number.isSafeInteger(c.at)) out.set(prBranchKey(c), c.at);
  }
  return out;
}
/** That file's text for `checked` (readPrChecks' Map), keeping only the branches still followed (`watched`). */
export function prChecksText(checked, watched) {
  const rows = watched.filter((w) => checked.has(prBranchKey(w))).map((w) => ({ project: w.project, branch: w.branch, at: checked.get(prBranchKey(w)) }));
  return `${JSON.stringify({ v: 1, checked: rows })}\n`;
}

/** One ledger line. */
export const ledgerLine = (row) => `${JSON.stringify(row)}\n`;

/** A ledger's rows; a line that isn't a JSON object (a torn write) is skipped. */
export function readLedger(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row); } catch { /* skipped */ }
  }
  return rows;
}

// ---- worktree cleanup (#567): <app home>/automagik-herdr/worker-reap.jsonl ----
//
// A worker's created worktree is removed once its workers have ended. What the sweep did with
// each one is kept in a file of its own, never in the workers ledger (its readers and shapes
// stay as they are): { worktree, result: "removed" | "kept" | "failed" | "gone", why, at }.

export const REAP_FILE = "automagik-herdr/worker-reap.jsonl";
export const reapPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${REAP_FILE}`;

/** A cleanup row: what the sweep did with `worktree`, and why (null when there is nothing to say). */
export const reapRow = ({ worktree, result, why, at }) => ({ worktree, result, why: orNull(why), at: stamp(at) });

/**
 * The worktrees a sweep looks at, from the workers ledger's `rows` and the cleanup file's
 * `reaps`: each path a worker start row says this command made (`created: true`), as
 * { worktree, project, branch, terminals, last }, newest created first. `branch`: the worker's
 * branch (a row from before the task contract has no `branch` key and holds it in `task`).
 * `terminals`: every start row's terminal on that path since its newest created row (a
 * restart's new pane, a later worker given the same worktree), all of which must have ended.
 * `last`: the newest cleanup row for it since then ({ result, why, at }), else null. A path
 * already removed or gone is left out; one only ever given (`created: false`: --worktree, a
 * branch's existing worktree) is never in the list.
 * `ownerOf`: a caller's canonical repository identity for each project. Missing or conflicting
 * ownership in a later start row makes `project` null, so the caller retains that worktree.
 */
export function reapCandidates(rows, reaps = [], ownerOf = (project) => orNull(project)) {
  const by = new Map();
  for (const r of rows) {
    if (r?.event !== "start" || typeof r.worktree !== "string" || !r.worktree) continue;
    if (r.kind === "worker" && r.created === true) {
      const branch = orNull("branch" in r ? r.branch : r.task);
      by.delete(r.worktree);
      const owner = ownerOf(r.project);
      by.set(r.worktree, { worktree: r.worktree, project: owner ? orNull(r.project) : null,
        owner, branch, terminals: [], since: String(r.at ?? ""), last: null });
    }
    const c = by.get(r.worktree);
    // A later row with missing or conflicting ownership makes removal unsafe.
    if (c && (!c.owner || ownerOf(r.project) !== c.owner)) c.project = null;
    if (c && typeof r.terminal === "string" && r.terminal) c.terminals.push(r.terminal);
  }
  for (const r of reaps) {
    const c = typeof r?.worktree === "string" ? by.get(r.worktree) : null;
    if (c && String(r.at ?? "") >= c.since) c.last = { result: r.result, why: r.why ?? null, at: r.at ?? null };
  }
  return [...by.values()].filter((c) => c.last?.result !== "removed" && c.last?.result !== "gone")
    .reverse().map(({ since, owner, ...c }) => c);
}

/**
 * Why a worktree with no live worker is kept, or null when it may go: `changes`, the lines of
 * `git status --porcelain`; `unpushed`, the commits on no remote branch; `branch`, the branch
 * checked out (null: a detached HEAD); `expected`, the worker's branch from the ledger; `prs`,
 * the branch's pull requests as gh lists them ([{ state, headRefOid }]), or null on failure.
 * `head`: the exact current commit. A worktree no longer on the worker's branch is kept
 * (the folder may be another tree now); a
 * detached HEAD with commits on no remote is kept whatever its branch's pull requests say. Commits
 * on no remote keep it unless a MERGED pull request names that exact head (a squash merge
 * leaves its commits on no remote once the branch is deleted). CLOSED or an older merge is
 * no proof that the current work is preserved.
 */
export function workLeft({ changes, unpushed, prs = null, head = null,
  branch = null, expected = null }) {
  if (changes > 0) return "uncommitted changes";
  if (!branch) {
    return unpushed > 0 ? `HEAD is detached with ${unpushed} ${unpushed === 1 ? "commit" : "commits"} on no remote`
      : `HEAD is detached, not on the worker's branch ${expected ?? "(none recorded)"}`;
  }
  if (!expected) return `on ${branch}, and the workers ledger names no branch for it`;
  if (branch !== expected) return `on ${branch}, not the worker's branch ${expected}`;
  if (!Number.isSafeInteger(unpushed) || unpushed < 0) {
    return "can't prove HEAD is pushed or merged";
  }
  if (unpushed > 0) {
    if (/^[0-9a-f]{40,64}$/.test(head ?? "") && Array.isArray(prs)
      && prs.some((p) => p?.state === "MERGED" && p.headRefOid === head)) return null;
    const commits = `${unpushed} ${unpushed === 1 ? "commit" : "commits"} on no remote`;
    if (prs === null) return `${commits}; gh couldn't prove ${branch}'s current HEAD is merged`;
    if (!prs.length) return `${commits}; ${branch} has no pull request`;
    return `${commits}; no merged pull request proves ${branch}'s current HEAD is preserved`;
  }
  return null;
}

/**
 * What the briefing hook does about a Claude session: `get` is `hc get` of its terminal,
 * `input` the hook's stdin text, `resolve(path)` the transcript folder rule: a real path when
 * the path passes, else null (none given: no path passes). Null when there is nothing to do;
 * else { session, transcript, fresh, label }: `fresh` when SESSION_LABEL doesn't hold the
 * session yet (label it, append a row); `label` the TRANSCRIPT_LABEL value to set (the hook's
 * transcript_path as given, once the rule passes it, when the label is missing or differs; ""
 * removes a new session's stale one) or null to leave it. The row's `transcript` is the
 * hook's path as given, as before.
 */
export function sessionChange(get, input, resolve = () => null) {
  let data = null;
  try { data = typeof input === "string" && input.trim() ? JSON.parse(input) : null; } catch { data = null; }
  const session = data?.session_id;
  if (typeof session !== "string" || !session.trim() || !get || typeof get !== "object") return null;
  const transcript = typeof data.transcript_path === "string" ? data.transcript_path : null;
  const fresh = get.labels?.[SESSION_LABEL] !== session;
  const had = get.labels?.[TRANSCRIPT_LABEL];
  const real = transcript === null ? null : resolve(transcript);
  const ok = typeof real === "string" && real !== "";
  const label = ok ? (had === transcript ? null : transcript) : (fresh && had ? "" : null);
  if (!fresh && label === null) return null;
  return { session, transcript, fresh, label };
}
