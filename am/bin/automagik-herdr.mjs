#!/usr/bin/env node
// automagik-herdr: Automagik Herdr from the command line (A11, A15): a project's bots, and
// updates of the installed pack (A14, update.mjs). The bots follow the same rules as the
// sidebar (model.js, launchArgs.js, briefingText.mjs, models.js, briefing.mjs' gathering),
// with herdr-core reached through `hc` directly. Plain node (≥ 24): no `herdr` or `gpui`
// import, no Herdr window.
// Install: ln -s ~/.config/herdr-app/mods/am-sidebar/bin/automagik-herdr ~/.local/bin/automagik-herdr
// (that wrapper runs this file through bin/run.sh, which finds node 22.7+ or bun without node on PATH).
// Apache-2.0.

import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  readSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { hermesPairEnv } from "../hermesPair.js";
import { actionError } from "../actionError.js";
import { coreStatus, inTestRoots } from "../coreSocket.mjs";

import { BOT_LABEL, BOTS_PATH, CHARACTERS, COLOURS, KINDS, MAX_INSTRUCTIONS, OMNI_LOOK, applyBotEdit, checkBots, restartAtOf,
  CATEGORY_ID, PROJECTS_FILE, RANKS, cleanProjectPath, collectProjectMap, crossMemberWarnings, crossMembersOf, defaultLook, descendantsOf, effectiveLead, leadsBackTo, listedProjects, mainBotOf, newBotId, newCategoryId, rateLimitModeOf,
  botsText, parseBots, plannedOf, projectKeyOf, projectOf, squadOf, wakeAutomationName, wakeCron, wakeProblem, withListedProject, writeFolderOf } from "../model.js";
import { UNANSWERED, agentInForeground, attachRefusal, attachWords, detachWords, hcName, isClaude, leadIdOf, leadPane, newest,
  paneLabels, paneOf, parentArgs, placementFrom, relabel, relabelPlan, relabelWarning, relabelWords, rowsOf, spaceOnly, spacePlace,
  freshSpare, roleOf, shellIdle, spareTab, startArgs, startRefusal, unwrapKeep } from "../launchArgs.js";
import { tabSteps, workerSpace, workerTabName } from "../workerTab.js";
import { addressOf, attachKey, attachLine, attachPath, attachRow, closingRow, confirmBindings, foldAttach, heldIn, machinesById, modeProblem, placeOf as placeOfRow, readAttach } from "../attach.js";
import { PANE_ENV_PATH, agentOnMachine, interpreterPath, paneEnvOf } from "../agentPath.mjs";
import { briefingFilePath, installHook, launchBriefingText, screenTail, stableBriefingPath, withExclude } from "../briefingText.mjs";
import { gatherBriefing } from "../briefing.mjs";
import { codexTrustKeptWarning, codexTrustPlan, codexTrustWarning, withCodexTrust, AGENTS, AGY_MODE_DEFAULT, AGY_MODES, AUTO_MODE, AUTO_MODE_NONE, PERMISSION_MODE_DEFAULT, PERMISSION_MODE_WHAT, agentKeyOfArgv, agyGuarded, agyModeArgs, agyModeOf, agyModeProblem, agyModeWarning, agyPermissionPlan, agyRuleProblem, agySandbox, agySettingsArgs, agySettingsDir, agySettingsPlan, autoModeArgs, codexClean, codexCleanNote, codexConfigValue, codexEffortProblem, codexProfileFrom, codexProfileName, codexSettingsFrom, CODEX_DIR_VARS, codexGrantPaths, codexGrantPlan, codexWithheldWarning, codexKeepDirs, codexWhere, codexWhereThere, absPath, cleanPath, configTexts, defaultModel, defaultModelFrom, seatSettingsArgs, tierName, tierProblem, withCodexGrants, choosesSession, continuesAnywhere, briefingHook, briefingLaunch, briefingOwnConfig, briefingWay, configPaths, detectModel, knownModels, knownModelsFrom, agModelsPath, launchRun, modelArgs, modelRefusal, ownPromptIn, ownsSession, permissionModeArgs, permissionModeFrom, permissionModeProblem, permissionModesOf, resolveAgent, resumeAfterTurn, resumesById,
  promptByMessage, sessionIdArgs, shownModel, withAgySettings, withBriefing, withOverrides } from "../models.js";
import { AG_MODELS_TIMEOUT_MS, agModelsSpawnResult, refreshAgModelsSync } from "../modelCache.js";
import { EFFORT_SHAPE, HC_NAME_MAX, LEAD_RANKS, LEAD_SHAPE, LEDGER_FILE, ROLES, WORKER_OF_LABEL, WORKER_ROLE_LABEL, WORKER_TEMPLATE_LABEL, WORKTREES_EXCLUDE,
  GUARD_DIR, KILL_GUARD_DIR, KILL_GUARD_NAME, SESSION_LABEL, TRANSCRIPT_LABEL, baseCandidates, branchNamesTask, branchSlug, guardPathWith,
  LEDGER_MODE, endRow, finishedEnds, launchKey, ledgerLine, ledgerPath, optionLike, paneArgs, readLedger, reapCandidates, reapPath, reapRow,
  prAskDue, prBranchKey, prBranches, prChecksPath, prChecksText, prLikely, prRowsFor, readPrChecks, forgeHost, forgeOf, workerTaskText,
  sessionRow, stableGuardDir, stableKillDir, stableRootOf,
  parseWorktrees, runsTemplate, startRow, swapArm, swapByte,
  taskIdProblem, taskWorkerName, TEMPLATE_SHAPE, codexTemplateRefusal, codexTemplateWarning, templateAgent, workerArgs, workerBranch, workerKillRefusal, workerPlan, workerRole, worktreeFolder,
  workLeft, writesWorktree } from "../workers.js";
import { SESSION_MASK, carriedLabels, maskSession, commandArgv, continueRefusal, contextTokensOf, doomedHelpers, helperArgs, helperCwd, helperPlan, launchChange, ledgerSession, maskedArgv,
  isPaneIdle, pendingDialog, paneCommand, planText as restartText, rateLimitDialog, rateLimitLine, restartAnswer, restartPlan, sharedFresh, claudeSlug, claudeTranscriptPath, paneSession, restartRefusal, sameSessions, sessionFor, sessionId, sharedFolders, wakeWait } from "../restart.js";
import { BORN_SLACK_MS, FIRST_SESSION_MS, PLIST_LABEL, SERVICE_WAIT_S, UNIT_NAME, agyCandidates, agyHistoryPath, codexCandidate, codexHomeOf, codexRolloutId, codexSessionsDir,
  countsLine, discoversSession, dshHomeOf, dshSessionOf, dshSessionsDir, isBareShell, kimiCandidates, kimiHomeOf, kimiIndexPath, launchdNotLoaded, ledgerRivals,
  lastText, pickSession, plistIsOurs, plistKeepsPath, plistPath, plistText, reportLine, reviveOrder, reviveTargets, sameBoot, servicePath, sweptSince, unitIsOurs, unitKeepsPath, unitPath, unitText, uuidV7Ms } from "../revive.js";
import { autoStatus, readAuto, binDirOf, checkForUpdate, defaultModsDir, installUpdate, liveHome, managedPack, readMarker, relinkCli, rollback as rollbackPack, stateDirOf, writeAuto, writeMarker } from "../update.mjs";
import { NO_UPDATE_ENV, PACK_NAME, POCKET_LINK, heldModLine, updatesOff } from "../release.js";
import { MACHINE_NAME, OPT_IN, decodeExec, hcExecArgs, installOn, linkedMachines, meterScope, recordAfter, resultLine, uninstallOn } from "../meterFleet.js";
import { readMeterLane } from "../meterLane.mjs";
import { LOCK_FILE as MACHINES_LOCK, SET_AUTO, STATE_FILE as MACHINES_STATE, entryLine, linkedUpdate, meterResults, parseState, probeOn, stateAfter, stateLines, updateOn } from "../machineUpdates.js";
import { SHARED_RENAMES, renamedFrom } from "../migrate.js";
import { transcriptShape } from "../transcriptFolder.mjs";
import { REMOTE_TEXT_MAX, RemoteFileError, StaleSnapshot, readRemoteText, removeRemoteText, utf8Length, writeRemoteText } from "../remoteFile.js";
import { botHistory, historyLines } from "../inspect.js";
import { CONFIG_VAR, DEFAULT_LOGIN, chooseLogin, loginsPath, parseLogins } from "../logins.js";
import { DocError, docGet } from "../docGet.mjs";
import { isGuardFolder } from "../hcGuard.mjs";
import { isInstalledGuardFolder } from "../hcGuard.mjs";
import { looksLikeGuardFolder } from "../hcGuard.mjs";
import { DSH_TUI, approvedDataRootProblem, doctorBotProxies, doctorDshTui, installDshTui,
  uninstallDshTui, workerProxyTransport } from "../dshTui.mjs";
import { approveProject, approvedProxyEnabled, approvedProxyState, approvedSettingsDir, parseApprovedRecord,
  projectKey, proxyStateFor, recordFileOf } from "../approved.js";
import { hooksNotice } from "../migrateHooks.mjs";
import { SPACE_LABEL, plan as tidyPlan, planText } from "../tidy.js";
import { fixNonVisual, readState, spacesOf } from "./state.mjs";

/**
 * A refusal or a usage mistake: printed on stderr, exit `code`. `detail`: fields a --json run
 * also prints on stdout, beside `error` (the message), for a caller that shows them (#413).
 */
export class CliError extends Error {
  constructor(message, code = 1, detail = null) { super(message); this.code = code; this.detail = detail; }
}

// ---- files and programs ----

/** A file's text, or null when it isn't there. Any other read failure is a CliError. */
export function readText(path) {
  try { return readFileSync(path, "utf8"); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw new CliError(`Can't read ${path}: ${e?.message ?? e}`);
  }
}
const exists = async (path) => { try { accessSync(path); return true; } catch { return false; } };
/** Where a link points (its text, as readlink gives it), or null when `path` is not a link. */
const readLink = (path) => { try { return readlinkSync(path); } catch { return null; } };
const under = (key, rest) => `${key === "/" ? "" : key}/${rest}`;

// At most this many programs at once: `ls --all` over many bots stays a handful of processes.
const MAX_RUNNING = 8;
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= MAX_RUNNING) await new Promise((go) => waiting.push(go));
  running += 1;
  try { return await fn(); } finally { running -= 1; waiting.shift()?.(); }
}

/** Runs a program: stderr falls back to the exec error, while rawStderr is the child's output.
 * Code 127 when it isn't there; killed: true when its timeout ended it. */
export function runProgram(command, args, { cwd, timeout = 15000 } = {}) {
  return slot(() => new Promise((done) => {
    try {
      execFile(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr, rawStderr: stderr });
        done({ code: err.code === "ENOENT" ? 127 : (typeof err.code === "number" ? err.code : 1), stdout: stdout ?? "", stderr: stderr || String(err.message),
          rawStderr: stderr ?? "",
          ...(err.killed ? { killed: true } : {}) });
      });
    } catch (e) { done({ code: 127, stdout: "", stderr: String(e?.message ?? e), rawStderr: "" }); }
  }));
}
const git = async (args, cwd) => { const r = await runProgram("git", args, { cwd }); return r.code === 0 ? r.stdout : null; };

/** Check the project's own filesystem, including linked projects, before adding worker advice. */
async function projectIsGit(project) {
  const args = ["rev-parse", "--is-inside-work-tree"];
  if (project.machine) {
    const r = await remoteIo.exec("git", args, project.machine, { cwd: project.key });
    return r.code === 0 && r.stdout.trim() === "true";
  }
  return (await git(args, project.key))?.trim() === "true";
}

/** The project a folder keys to (DESIGN Decision 15): the walk-up, for the folder a command runs in. */
export const keyOf = (folder) => projectKeyOf(resolvePath(folder), git, exists);

/**
 * The project `--project <dir>` names: the folder itself outside git, never a parent
 * project's (its git main checkout in git). A folder that isn't there is refused.
 */
export async function namedKeyOf(folder) {
  const dir = resolvePath(folder);
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) throw new CliError(`--project: ${dir} is not a folder.`, 2);
  return (await projectOf(dir, git, exists)).own;
}
// The projects this run named, for the attach ledger's one-time import (projectDefining).
const namedKeys = new Set();
const commandKeyOf = async (opts) => {
  const key = await (opts.project !== undefined ? namedKeyOf(opts.project) : keyOf(process.cwd()));
  namedKeys.add(key);
  return key;
};

async function hc(args, { timeout } = {}) {
  const r = await runProgram(hcExecutable(programPath("hc")), args, { timeout });
  if (r.code === 127) throw new CliError("hc (herdr-core) is not on PATH.");
  return r;
}
const parsed = (r, args) => {
  try { return JSON.parse(r.stdout); } catch { throw new CliError(`hc ${args.join(" ")} printed no JSON: ${r.stdout.slice(0, 200)}`); }
};
/** `hc <args> --json`, parsed. A failed call throws: a failure never reads as "no pane". */
async function hcJson(args) {
  const r = await hc([...args, "--json"]);
  if (r.code !== 0) throw new CliError(`hc ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return parsed(r, args);
}
/** hc's exit code for "no such terminal" (hc --skill: 3 not_found). */
export const HC_NOT_FOUND = 3;
const HC_FAILURE_MAX = 300;
/**
 * What a failed hc call said, safe to print: its error's kind and message when it printed one as
 * JSON (hc --skill: `{error: {kind, message, hint}}` on stderr), else its first line; the home
 * folder written as ~, cut to 300 characters.
 */
export function hcFailure(r, homeDir = home()) {
  return formatHcFailure(r, hcFailureMessage(r?.stderr || r?.stdout, homeDir));
}
function hcFailureMessage(output, homeDir = home()) {
  const text = String(output || "").trim();
  let said = text.split("\n")[0];
  try {
    const e = JSON.parse(text)?.error;
    if (e && typeof e === "object") said = [e.kind, e.message].filter((x) => typeof x === "string" && x).join(": ") || said;
  } catch { /* not JSON: its first line */ }
  if (homeDir && homeDir !== "/") said = said.split(homeDir).join("~");
  return said;
}
function formatHcFailure(r, message) {
  return `${message || "no message"}${r?.killed ? " (timed out)" : ""} (exit ${r?.code ?? "?"})`.slice(0, HC_FAILURE_MAX);
}
/**
 * `hc get <t> --json`, or null when hc says there is no such terminal: only its not_found exit
 * (3). Any other failure (the core unreachable, a sandbox that blocks its socket, a timeout) and
 * an answer that isn't JSON throw, so a failed lookup never reads as a missing pane (#1125).
 */
async function hcGet(terminal, { timeout } = {}) {
  const r = await hc(["get", terminal, "--json"], { timeout });
  if (r.code === HC_NOT_FOUND) return null;
  if (r.code !== 0) throw new CliError(`hc get ${terminal} failed: ${hcFailure(r)}`);
  return parsed(r, ["get", terminal]);
}
/**
 * How long an `hc run --bg` that starts a worker or a seat may take (#1262): hc answers a run
 * with a task only after the new terminal reports its first status, and waits 60 s for a program
 * that never does. Above that wait, so such a start still gets hc's own answer.
 * AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS, for the tests only.
 */
const HC_RUN_TIMEOUT_MS = (() => {
  const raw = process.env.AUTOMAGIK_HERDR_HC_RUN_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 90_000;
})();
/**
 * The terminal a timed-out `hc run` started anyway (#1262): hc creates the terminal first and
 * then waits for its first status to deliver a task, so the call can end after the terminal
 * exists. The name is unique among live terminals (the start chose it before the run); null
 * when no live terminal runs under it.
 */
async function runStartedByName(name) {
  if (!name) return null;
  const get = await hcGet(name);
  if (!get || (get.state !== undefined && get.state !== "live")) return null;
  return { address: get.address ?? name, get };
}
/**
 * `hc run --bg` for a start: { address, late, answer }. A call the timeout ended whose terminal
 * hc already made is a start the CLI must record (late: true, its task not delivered), never a
 * failed start; a timeout with no live terminal under `name`, or any other failure, throws.
 */
async function hcStartRun(run, args, name) {
  const guardWhy = launchGuardProblem(args, name);
  if (guardWhy) throw new CliError(guardWhy);
  const r = await run(args, { timeout: HC_RUN_TIMEOUT_MS });
  let late = null;
  if (r.killed) {
    try { late = await runStartedByName(name); } catch (e) {
      throw new CliError(`hc run didn't answer within ${HC_RUN_TIMEOUT_MS / 1000}s, and the terminal it may have started (${name}) can't be looked up: ${e?.message ?? e}`);
    }
  }
  if (!late && r.code !== 0) {
    throw new CliError(r.killed
      ? `hc run didn't answer within ${HC_RUN_TIMEOUT_MS / 1000}s and no live terminal is named ${name}: ${(r.stderr || r.stdout).trim()}`
      : `hc run failed: ${(r.stderr || r.stdout).trim()}`);
  }
  let answer = null;
  let address = late?.address ?? null;
  if (!address) {
    try { answer = JSON.parse(r.stdout); } catch { answer = null; }
    address = answer?.address ?? null;
    if (!address) throw new CliError(`hc run gave no terminal address: ${r.stdout.trim()}`);
  }
  return { address, late: Boolean(late), answer };
}
const local = (address) => typeof address === "string" && !address.includes("/");

function appHome(env = process.env) { return (env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`).replace(/\/+$/, ""); }
/**
 * The am part's installed store (am/lib/self.mjs storeOf): <AM_HOME, else ~/.automagik>/
 * parts/automagik.am. A CLI-only host's hook goes through it (briefingText.mjs installHook).
 */
const amStore = (env = process.env) => `${(env.AM_HOME || `${env.HOME || homedir()}/.automagik`).replace(/\/+$/, "")}/parts/automagik.am`;
const home = () => process.env.HOME || homedir();
/** The agent a launch argv runs: a `sh -c <command>` (a template's) by its command, else by its program. */
const launchAgent = (argv, agents = agentTable()) => (Array.isArray(argv) && /(^|\/)(ba|z|da)?sh$/.test(argv[0] ?? "") && argv[1] === "-c"
  ? templateAgent(argv[2], agents) : agentKeyOfArgv(argv, agents));
/**
 * The Claude login words for a local launch of `argv` (#453, logins.js): read from the app home's
 * claude-logins.json at this launch, only when `argv` runs Claude Code; [] for any other agent,
 * which never reads the record. A record that can't be followed gives login A's words and its
 * warning (pushed on `warnings`), never a refusal.
 */
function claudeLogin(argv, warnings = []) {
  if (launchAgent(argv) !== "claude") return [];
  let chosen;
  try {
    chosen = chooseLogin(appHome(), { read: (p) => readFileSync(p, "utf8"), realpath: realpathSync, isDir: (p) => statSync(p).isDirectory(), home: home() });
  } catch (e) {
    chosen = { words: ["-u", "CLAUDE_CONFIG_DIR"], warning: `claude-logins.json: ${e?.code ?? "error"}; started on the default login` };
  }
  if (chosen.warning) warnings.push(chosen.warning);
  return chosen.words;
}
const modelIo = () => ({ home: home(), appHome: appHome(), read: (p) => { try { return readText(p); } catch { return null; } } });
/** The agents Herdr can start: its shipped table with the app home's programs.json applied. */
const agentTable = () => withOverrides(readText(`${appHome()}/programs.json`));

function checkedHcPath(file) {
  if (!inTestRoots(file) && !isGuardFolder(dirname(file))) {
    throw new CliError(`test guard: ${file} is outside AUTOMAGIK_HERDR_TEST_ROOTS; nothing was run.`);
  }
  return file;
}
function hcExecutable(file) {
  if (file) return checkedHcPath(file);
  if (process.env.AUTOMAGIK_HERDR_TEST_ROOTS) throw new CliError("hc (herdr-core) is not on PATH.");
  return "hc";
}

/**
 * Where `program` runs from: PATH, then two folders a PATH may lack when the sidebar runs this
 * CLI with Herdr's own (~/.local/bin, where hc and Claude Code install, and the folder of the
 * node running this, where an nvm-installed agent such as codex is). Null when none has it.
 */
function programPath(program) {
  if (program.includes("/")) { try { accessSync(program, constants.X_OK); return program; } catch { return null; } }
  const dirs = [...(process.env.PATH ?? "").split(":"), `${home()}/.local/bin`, dirname(process.execPath)];
  for (const dir of dirs) {
    if (!dir) continue;
    try { accessSync(`${dir}/${program}`, constants.X_OK); } catch { continue; }
    return program === "hc" ? checkedHcPath(`${dir}/${program}`) : `${dir}/${program}`;
  }
  return null;
}
const onPath = (program) => programPath(program) !== null;

/**
 * The real hc for the CLI's own trusted calls (system status, machine lists, remote file/exec,
 * docs): the first PATH hc that isn't inside any guard folder. The guard is a guardrail for
 * the bot's direct calls (#624; #628 scopes send/keys/attach), not for the pack's own commands.
 * Skipping every guard folder (the pack's and am's) keeps `automagik-herdr worker` and the
 * remote commands working in a guarded pane, and never treats one guard as the real hc.
 * A guard folder is hcGuard.mjs's isGuardFolder (#643, #721): this copy's own guard folder, or
 * one whose hcGuard.mjs is byte-equal to this copy's, so a planted hcGuard.mjs hides no folder.
 * The `hc kill` shim's folder (#955, `hc-kill`, beside the same hcGuard.mjs) is vouched for by
 * the same byte rule.
 *
 * Version skew (#1728): am and the pack may run different releases, or a pane may still name a
 * previous install. isInstalledGuardFolder also skips their shipped guard and shim entries
 * at recognized install paths. hcKill explains a failure from any guard this CLI reaches.
 */
function realHcPath() {
  const dirs = [...(process.env.PATH ?? "").split(":"), `${home()}/.local/bin`, dirname(process.execPath)];
  for (const dir of dirs) {
    if (!dir || isGuardFolder(dir) || isInstalledGuardFolder(dir)) continue;
    const file = `${dir}/hc`;
    try {
      accessSync(file, constants.X_OK);
    } catch { continue; }
    return checkedHcPath(file);
  }
  return null;
}
async function hcReal(args, { timeout } = {}) {
  const r = await runProgram(hcExecutable(realHcPath()), args, { timeout });
  if (r.code === 127) throw new CliError("hc (herdr-core) is not on PATH.");
  return r;
}
/**
 * End a pane for a checked CLI verb such as restart or worker kill. The pane's guard or shim
 * allows direct kills only from a project's main bot (#955). If an unvouched guard fails the
 * CLI's kill, explain how to resolve the version skew (#1728).
 */
async function hcKill(terminal, { timeout } = {}) {
  const file = realHcPath();
  const r = await runProgram(hcExecutable(file), ["kill", terminal], { timeout });
  if (r.code === 127) throw new CliError("hc (herdr-core) is not on PATH.");
  if (r.code === 0 || !file) return r;
  const dir = dirname(file);
  let real;
  try { real = realpathSync(dir); } catch { return r; }
  const name = basename(real);
  if ((name !== "guard" && name !== KILL_GUARD_NAME) || !looksLikeGuardFolder(real)) return r;
  const folder = dir === real ? dir : `${dir} (${real})`;
  return { ...r, stderr: `the first hc on this pane's PATH is in ${folder}, a guard folder this am cannot vouch for (another version's copy, or one outside the install); update am and the pack to one version, then restart this pane (#1728)` };
}
/** `hc <args> --json` through the real hc, parsed; a failed call throws (as hcJson does). */
async function hcRealJson(args) {
  const r = await hcReal([...args, "--json"]);
  if (r.code !== 0) throw new CliError(`hc ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return parsed(r, args);
}

/**
 * The PATH a pane this CLI starts in folder `cwd` runs with (#56, #213): this one, less what
 * belongs to the caller's folder (entries under its working folder or the pane's, a
 * node_modules/.bin, $VIRTUAL_ENV/bin: a venv or a project's tools aren't frozen into the pane),
 * with the folder of the program's interpreter first when it lacks it (an npm agent's node, a bun
 * script's bun: agentPath.mjs interpreterPath, given the file programPath found), the program's
 * own folder when only programPath found it there, and /usr/bin and /bin last when missing (sh
 * and env, which the pane's command needs). Always passed, as a worker's is: a pane started
 * without one gets herdr-core's PATH, which may have no node (a bare codex, exit 127).
 * { path, note }.
 */
function launchPath(program, cwd = null) {
  const homeDir = home().replace(/\/+$/, "");
  // A folder that is home or above it (/, /Users) isn't the caller's own: nothing is dropped for it.
  const here = [process.cwd(), cwd].filter((d) => typeof d === "string" && d).map((d) => d.replace(/\/+$/, "") || "/")
    .filter((d) => d !== "/" && !`${homeDir}/`.startsWith(`${d}/`));
  const venv = process.env.VIRTUAL_ENV ? `${process.env.VIRTUAL_ENV.replace(/\/+$/, "")}/bin` : null;
  const kept = (process.env.PATH ?? "").split(":").filter((d) => d && d !== venv && !/(^|\/)node_modules\/\.bin\/?$/.test(d)
    && !here.some((h) => d === h || d.startsWith(`${h}/`)));
  const file = program ? programPath(program) : null;
  const runPath = interpreterPath(file ?? program, kept.join(":"));
  const dirs = String(runPath.path ?? "").split(":").filter(Boolean);
  const dir = file?.includes("/") ? dirname(file) : null;
  if (dir && !dirs.includes(dir)) dirs.push(dir);
  for (const d of ["/usr/bin", "/bin"]) if (!dirs.includes(d)) dirs.push(d);
  return { path: dirs.join(":"), note: runPath.note };
}

/**
 * Why a launch's PATH word does not resolve `hc` to the pack's guard shim, or null.
 *
 * The pack puts one of its guard folders (the mod's `guard` or `hc-kill`, or the dsh-tui
 * sandbox's stable copy) at the front of a guarded pane's PATH. The launch is guarded exactly
 * when one of those known folders is on this PATH at all: every guarded launch puts one there
 * (guardPathWith), so a PATH with none is an unguarded launch (an agentless helper, a template
 * that owns its env) and is left as it was. A folder's name is never the signal: an ordinary
 * folder named first is as suspect as one named `guard`.
 *
 * On a guarded PATH this resolves the first executable `hc` the shell would run and requires
 * it to realpath to the known guard's own shim. A different first `hc` (a login startup or a
 * PATH entry ahead of the guard), a guard with no executable shim, a PATH whose first hc can't
 * be resolved (a relative or empty entry ahead of the guard), and a PATH with no `hc` at all
 * refuse the launch instead of starting the agent with its kill guard shadowed (#1133).
 *
 * A linked machine's `--on` start is checked on that machine, so it is left there. Only an hc
 * option before the command's `--` counts: an agent argument or a task word equal to `--on`
 * after it is the command's, never hc's. A launch with no PATH word is unchanged.
 */
export function launchGuardProblem(args, who = null) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const commandAt = list.indexOf("--");
  const options = commandAt < 0 ? list : list.slice(0, commandAt);
  if (options.some((w) => w === "--on" || w.startsWith("--on="))) return null;
  const body = commandAt < 0 ? list : list.slice(commandAt + 1);
  const word = body.find((w) => w.startsWith("PATH="));
  if (!word) return null;
  const dirs = word.slice("PATH=".length).split(":");
  const bare = (p) => String(p).replace(/\/+$/, "") || "/";
  // The folders this copy can call its own: the mod's guard and kill shim, plus the dsh-tui
  // sandbox's stable copies when this host has a data root. Matched by the path as written and,
  // when both exist, by realpath (a symlinked copy of the guard counts; a deleted guard still
  // counts by its written path, so its missing shim is refused rather than read as no guard).
  const known = [];
  const addKnown = (dir) => { if (dir) known.push({ dir: bare(dir), real: realDir(dir) }); };
  addKnown(GUARD_DIR);
  addKnown(KILL_GUARD_DIR);
  try { const root = stableRootOf(); addKnown(stableGuardDir(root)); addKnown(stableKillDir(root)); }
  catch { /* no HOME/XDG_DATA_HOME: this copy has no stable guard */ }
  const knownGuard = (dir) => {
    if (!dir) return null;
    const real = realDir(dir);
    return known.find((g) => g.dir === bare(dir) || (real !== null && g.real === real)) ?? null;
  };
  const guard = dirs.find((d) => knownGuard(d) !== null);
  if (guard === undefined) return null; // no known guard anywhere on this PATH: not a guarded launch
  const shim = join(guard, "hc");
  let shimReal = null;
  try {
    if (statSync(shim).isFile()) { accessSync(shim, constants.X_OK); shimReal = realpathSync(shim); }
  } catch { shimReal = null; }
  if (!shimReal) {
    return `the pack's hc kill shim is missing or not executable at ${shim}; refusing to start ${who ?? "the agent"} without its kill guard (#1133). `
      + "Reinstall the pack, and for the dsh-tui sandbox's stable copy run `am dsh-tui install`.";
  }
  // The first hc the shell would run, resolved independently of the guard's position: a relative
  // or empty entry ahead of it can't be resolved here, so the first hc can't be proved and the
  // launch is refused rather than trusted.
  let first = null;
  for (const dir of dirs) {
    if (!isAbsolute(dir)) {
      return `the launch PATH names ${dir ? `the relative folder ${dir}` : "an empty entry"} before the pack's hc kill shim at ${shim}, `
        + `so the first hc cannot be resolved; refusing to start ${who ?? "the agent"} with an unproved kill guard (#1133). `
        + `Put ${guard} first on PATH, then try again.`;
    }
    const file = join(dir, "hc");
    try {
      if (statSync(file).isFile() && (accessSync(file, constants.X_OK), true)) { first = realpathSync(file); break; }
    } catch { /* the next word */ }
  }
  if (first === null) {
    return `no hc is on the launch PATH, though its guard folder ${guard} is; expected the pack's hc kill shim at ${shim}; `
      + `refusing to start ${who ?? "the agent"} with no kill guard (#1133). Reinstall the pack, then try again.`;
  }
  if (first !== shimReal) {
    return `the first hc on the launch PATH resolves to ${first}, not the pack's hc kill shim at ${shim}; `
      + `refusing to start ${who ?? "the agent"} with its kill guard shadowed (#1133). `
      + `A shell startup or a PATH entry ahead of ${guard} is shadowing it: remove that hc, or put ${guard} first on PATH, then try again.`;
  }
  return null;
}

// ---- the definitions file ----

const EMPTY = () => ({ version: 1, categories: [], bots: [] });

/**
 * A project's definitions: { key, machine: null, dir, text (null: no file), expected, raw,
 * file, warnings }. `dir` is where an edit is written (key unless given): an edit made from a
 * worktree is written in that worktree, reads stay on the key (RFC 0014 Q16, #234). With a
 * `dir` other than the key, the edit starts from dir's file, or the key's where dir has none;
 * `expected` is the text at dir (the write's snapshot), `text` the one the edit started from.
 */
export function loadProject(key, dir = key) {
  const text = readText(under(key === dir ? key : dir, BOTS_PATH));
  if (dir === key || text !== null) return projectFrom(key, null, text, dir);
  return { ...projectFrom(key, null, readText(under(key, BOTS_PATH))), dir, expected: null };
}

function projectFrom(key, machine, text, dir = key) {
  if (text === null) return { key, machine, dir, text, expected: text, raw: EMPTY(), file: EMPTY(), warnings: [] };
  let parsedFile;
  try { parsedFile = parseBots(text); } catch (e) { throw new CliError(`${fileName({ key, machine, dir })}: ${e?.message ?? e}`); }
  return { key, machine, dir, text, expected: text, raw: parsedFile.raw, file: parsedFile.file, warnings: parsedFile.warnings };
}
/** A project's file, named for people: `<dir>/.herdr/bots.json`, `… on <machine>` for a linked one's. */
const fileName = ({ key, machine, dir = key }) => `${under(dir, BOTS_PATH)}${machine ? ` on ${machine}` : ""}`;

// ---- a project on a linked machine (--machine M --project DIR; automagik#206) ----

// herdr-core there: its file ops (remoteFile.js) and one program, as `hc exec --on` runs it.
const remoteIo = {
  hc: hcReal,
  exec: async (command, args, machine, { cwd, timeout } = {}) =>
    decodeExec(await hcReal(["exec", "--json", ...(timeout ? ["--timeout", String(timeout)] : []), "--on", machine, ...(cwd ? ["--cwd", cwd] : []), "--", command, ...args], { timeout: timeout ? (timeout + 10) * 1000 : undefined }), timeout ?? 60),
};

// What hc said: its error's message when it printed one as JSON.
const hcSaid = (text) => { try { return JSON.parse(text)?.error?.message ?? text; } catch { return text; } };

/**
 * The project `--project <dir>` names on `--machine`, by namedKeyOf's rule there (its git
 * main checkout in git, else the folder itself). The folder is an absolute path on that
 * machine and must be there; a machine that can't be reached is refused, never guessed.
 */
export async function remoteKeyOf(opts) {
  const machine = opts.machine;
  if (!MACHINE_NAME.test(machine)) throw new CliError(`--machine: "${machine}" isn't a machine name (hc machine ls).`, 2);
  if (opts.project === undefined) throw new CliError(`--machine needs --project: the project's folder on ${machine}, as an absolute path.`, 2);
  if (!opts.project.startsWith("/")) throw new CliError(`--project: ${opts.project} is a folder on ${machine}, so give it as an absolute path.`, 2);
  const dir = opts.project.replace(/\/+$/, "") || "/";
  const there = await remoteIo.exec("test", ["-d", dir], machine);
  if (there.code === -1) throw new CliError(`${machine} can't be reached: ${hcSaid(there.stderr)}`);
  if (there.code !== 0) throw new CliError(`--project: ${dir} is not a folder on ${machine}.`, 2);
  return (await remoteProjectOf(machine, dir)).own;
}

/** model.js projectOf for a folder on `machine`: { key, own }, asked there through hc. */
async function remoteProjectOf(machine, dir) {
  // A call that got no answer (code -1: hc failed, a timeout) means the machine is away, never
  // "not in git" or "not there".
  const ask = async (command, args, cwd) => {
    const r = await remoteIo.exec(command, args, machine, { cwd });
    if (r.code === -1) throw new CliError(`${machine} can't be reached: ${hcSaid(r.stderr)}`);
    return r;
  };
  const gitThere = async (args, cwd) => { const r = await ask("git", args, cwd); return r.code === 0 ? r.stdout : null; };
  const existsThere = async (path) => (await ask("test", ["-e", path])).code === 0;
  return projectOf(dir, gitThere, existsThere);
}

let machinesOnce = null;
/** The linked machines by core id (attach.js machinesById), asked once per run; hc failing: none. */
const machinesNow = () => (machinesOnce ??= hcReal(["machine", "ls", "--json"]).then((r) => (r.code === 0 ? machinesById(r.stdout) : new Map()), () => new Map()));
/** A linked machine by name: { id, name, connected }, or null. */
async function machineNamed(name) {
  for (const [id, m] of await machinesNow()) if (m.name === name) return { id, ...m };
  return null;
}
/** The machine `name`, refused unless linked and connected now. */
async function connectedMachine(name, what = "nothing was changed") {
  const m = await machineNamed(name);
  if (!m) throw new CliError(`${name} isn't a linked machine (hc machine ls); ${what}.`);
  if (!m.connected) throw new CliError(`${name} isn't connected; ${what}.`);
  return m;
}

/** loadProject for a project on a linked machine, read there through herdr-core. */
export async function loadRemoteProject(key, machine) {
  let text;
  try { text = await readRemoteText(remoteIo, machine, under(key, BOTS_PATH)); } catch (e) {
    if (e instanceof RemoteFileError) throw new CliError(e.message);
    throw e;
  }
  return projectFrom(key, machine, text);
}

/**
 * Validates the whole roster on a linked save. remoteFile.js sends the old and new text in
 * one hc file edit, creates a new file exclusively, or checks before removing it for `raw === null`.
 */
async function writeRemoteBots(project, raw, { preview, confirmUnchanged }) {
  const { key, machine, text: expected } = project;
  const path = under(key, BOTS_PATH);
  if (raw !== null) checkBotsForSave(raw, expected, preview);
  try {
    if (raw === null) await removeRemoteText(remoteIo, machine, path, expected);
    else await writeRemoteText(remoteIo, machine, path, botsText(raw, expected), expected, { confirmUnchanged });
  } catch (e) {
    if (e instanceof StaleSnapshot) throw new CliError(`Not saved: ${fileName(project)} changed since it was read (another edit landed first). Run the command again.`);
    // A write whose answer was lost and that the file doesn't show: said as it is.
    if (e instanceof RemoteFileError && e.kind === "unknown_state") throw new CliError(e.message);
    if (e instanceof RemoteFileError) throw new CliError(`Not saved: ${e.message}`);
    throw e;
  }
}

/**
 * Saves a project's raw file where it is (raw null: deletes it) and, on this computer, lists
 * the project for the sidebar (`list`). The CLI's project list holds this computer's projects
 * only: a linked machine's shows in the sidebar from its open space, or once the sidebar
 * itself has written it.
 */
async function saveProject(project, raw, { list = true, preview, confirmUnchanged } = {}) {
  if (project.machine) return writeRemoteBots(project, raw, { preview, confirmUnchanged });
  writeBotsFile(project.dir, raw, project.expected, fsIo, project.text, preview);
  if (list) listProject(project.key);
  if (project.dir !== project.key) report([worktreeNote(project, await changesIn(project.key, project.dir))]);
}
/**
 * Said after an edit written in a worktree: where it went, what the readers show meanwhile, and,
 * when the main checkout's file was never committed or has local changes, that its pull would
 * stop on it (git won't overwrite an untracked file, nor local changes, with the merged one);
 * when it is deleted in the working tree, that a merge pull restores it with the worktree's
 * version and a rebase pull refuses until it is committed or discarded, unless
 * rebase.autoStash=true stashes the deletion and the stash apply then conflicts (UD); when the
 * deletion is staged, that committing it turns the pull into a modify/delete conflict; when the
 * deletion is committed after the worktree branched, that the pull ends in that conflict too.
 * The wording matches the form's (create.js worktreeNote): only the file each shows may differ.
 */
const worktreeNote = ({ key, dir }, changes = null) => `saved in ${under(dir, BOTS_PATH)} (this worktree); ls, `
  + `whois and the sidebar read ${under(key, BOTS_PATH)} until that change is merged there.`
  + (changes === "untracked" ? ` ${under(key, BOTS_PATH)} isn't committed: commit or remove it before pulling, or the pull stops on it.` : "")
  + (changes === "modified" ? ` ${under(key, BOTS_PATH)} has local changes: commit or discard them before pulling, or the pull stops on it.` : "")
  + (changes === "deleted" ? ` ${under(key, BOTS_PATH)} is deleted: a merge pull brings it back with this worktree's version (a committed deletion would be a modify/delete conflict instead); pull.rebase=true refuses the pull until the deletion is committed or discarded.` : "")
  + (changes === "deleted-autostash" ? ` ${under(key, BOTS_PATH)} is deleted: a merge pull brings it back with this worktree's version (a committed deletion would be a modify/delete conflict instead); pull.rebase=true with rebase.autoStash=true stashes the deletion and lets the pull through, then the stash apply conflicts (UD).` : "")
  + (changes === "staged-deletion" ? ` ${under(key, BOTS_PATH)} has a staged deletion: restore and commit the file, or unstage the deletion, before pulling; committing the deletion ends the pull in a modify/delete conflict.` : "")
  + (changes === "committed-deletion" ? ` ${under(key, BOTS_PATH)} has a committed deletion: a pull that brings this worktree's version ends in a modify/delete conflict; restore and commit the file before pulling, or resolve the conflict after.` : "");
/**
 * What git says about `key`'s .herdr/bots.json: "untracked" when git doesn't know the file,
 * "modified" when it is committed but has local changes, "deleted" when it is committed and
 * deleted in the working tree without that deletion being staged, "deleted-autostash" when that
 * deletion would be stashed for a rebase pull instead (rebase.autoStash=true), "staged-deletion"
 * when the deletion is staged, "committed-deletion" when HEAD has no file, `dir` (the worktree an
 * edit came from) does, and the merge base of HEAD and that worktree had it; null when it is
 * clean or git can't say. A pull that brings a worktree's committed file stops on the first two
 * (#234, #332); an unstaged deletion is restored by a merge pull and refused by a rebase pull
 * instead (#626); a deletion committed after the worktree branched ends in modify/delete too,
 * one before it only adds.
 */
async function changesIn(key, dir = null) {
  // porcelain=v2 keeps the state an explicit field: v1's unstaged " D" loses its leading
  // space to a trimmed stdout, while a v2 record's "1" is its first character (#626).
  const out = (await git(["status", "--porcelain=v2", "--", BOTS_PATH], key)) ?? "";
  if (!out.trim()) return await committedDeletion(key, dir);
  const line = out.split("\n").find((l) => l);
  if (line.startsWith("? ")) return "untracked";
  if (line.startsWith("1 ")) {
    const state = line.split(" ")[1];
    // A staged deletion is not "modified": committing it turns the pull into modify/delete (#665).
    if (state === "D.") return "staged-deletion";
    if (state === ".D") return (await autoStashOn(key)) ? "deleted-autostash" : "deleted";
  }
  return "modified";
}
/** Whether `key` stashes an unstaged deletion for a rebase pull instead of refusing it (#665). */
async function autoStashOn(key) {
  return (await git(["config", "--bool", "--get", "rebase.autoStash"], key))?.trim() === "true";
}
/**
 * #626: a committed deletion leaves `git status` empty, yet a pull that brings the worktree's
 * version of a file the merge base has, and HEAD has deleted, ends in a modify/delete conflict.
 * The merge base, not the path's history, is the test: a deletion committed before the worktree
 * branched leaves no file at the base, and the pull only adds the worktree's file.
 */
async function committedDeletion(key, dir) {
  if (!dir || dir === key) return null;
  if ((await git(["show", `HEAD:${BOTS_PATH}`], key)) !== null) return null;
  if (readText(under(dir, BOTS_PATH)) === null) return null;
  const worktreeHead = (await git(["rev-parse", "HEAD"], dir))?.trim();
  if (!worktreeHead) return null;
  const base = (await git(["merge-base", "HEAD", worktreeHead], key))?.trim();
  if (!base) return null;
  return (await git(["cat-file", "-e", `${base}:${BOTS_PATH}`], key)) !== null ? "committed-deletion" : null;
}

const fsIo = {
  read: readText,
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  create: (path, text) => writeFileSync(path, text, { flag: "wx" }),
  replace: (path, text, mode) => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone already */ } throw e; }
  },
  remove: (path) => unlinkSync(path),
};

/** Shared save validation: hard errors refuse; read warnings remain visible on stderr. */
function checkBotsForSave(raw, before, preview) {
  const errors = checkBots(raw, before);
  if (errors.length) throw new CliError(`Not saved: ${errors.join("; ")}`);
  report(parseBots(JSON.stringify(raw)).warnings.map((w) => `Warning: ${w}`));
  preview?.();
}

/**
 * Writes a project's definitions by bots.js writeBots' rule: the whole raw file must pass
 * checkBots, and the file must still hold `expected`, the text the edit started from (null:
 * no file yet), else nothing is written. A new file gets its `.herdr/` folder first and is
 * created exclusively; an existing one is replaced whole (written beside, then renamed).
 * `raw === null` deletes the file (the project's last bot removed). `before`, for checkBots, is
 * the text the edit started from when that isn't the file written (a worktree's first edit).
 */
export function writeBotsFile(key, raw, expected, io = fsIo, before = expected, preview) {
  if (expected === undefined) throw new Error("writeBotsFile: pass the text the edit started from (null for a new file)");
  const path = under(key, BOTS_PATH);
  if (raw !== null) checkBotsForSave(raw, before, preview);
  let now;
  try { now = io.read(path); } catch (e) { throw new CliError(`Not saved: can't read ${path} again: ${e?.message ?? e}`); }
  if (now !== expected) throw new CliError(`Not saved: ${path} changed since it was read (another edit landed first). Run the command again.`);
  try {
    if (raw === null) return io.remove(path);
    const text = botsText(raw, expected ?? before); // indented as the file is (#230)
    if (expected === null) { io.mkdir(under(key, ".herdr")); io.create(path, text); } else io.replace(path, text);
  } catch (e) {
    if (e?.code === "EEXIST") throw new CliError(`Not saved: ${path} appeared since it was read. Run the command again.`);
    throw new CliError(`Not saved: ${e?.message ?? e}`);
  }
}

// A lock beside the project list: made exclusively (wx) holding its holder's pid and a token,
// so one CLI at a time edits the list, and a holder removes only its own lock. Waited for up
// to LOCK_WAIT ms; one older than LOCK_STALE ms (a CLI killed mid-write) is taken over.
// Without it, two CLIs that read the list at once each write their own copy.
const LOCK_WAIT = 3000;
/**
 * LOCK_STALE from AUTOMAGIK_HERDR_LOCK_STALE_MS (`raw`), for the tests only: 10 s when unset
 * or not a number, else clamped to 100 ms..60 s. Far below, this CLI would take a lock bots-dsh
 * holds (the same protocol on disk, its own 10 s); far above, the refresh timer breaks.
 */
export function staleLimit(raw) {
  const ms = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(100, ms)) : 10_000;
}
const LOCK_STALE = staleLimit(process.env.AUTOMAGIK_HERDR_LOCK_STALE_MS);
// A wait longer than this says so on stderr, once, naming the lock and its holder.
const LOCK_NOTE_AFTER = 3000;
// An async holder (withLockAsync) touches its lock this often, so a hold across slow hc calls
// (15 s each) never reads as stale; a holder that dies stops touching it (#225, #223).
const LOCK_REFRESH = Math.max(10, Math.floor(LOCK_STALE / 3));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const stale = (path) => { try { return Date.now() - statSync(path).mtimeMs > LOCK_STALE; } catch { return false; } };

// A stale lock is moved aside first, so of two waiters only one takes it. Aside, it is checked
// again: a lock made fresh in between goes back (by link, which never replaces a newer one).
function takeOverStale(lock) {
  if (!stale(lock)) return;
  const aside = `${lock}.${process.pid}`;
  try { renameSync(lock, aside); } catch { return; } // another waiter moved it first
  if (!stale(aside)) { try { linkSync(aside, lock); } catch { /* a newer lock is there */ } }
  try { unlinkSync(aside); } catch { /* gone already */ }
}

/**
 * Who holds `lock`, from its token's pid: "pid N", "pid N, no longer running" (taken once
 * stale), or null when the file is gone or names no pid.
 */
function lockHolder(lock) {
  let pid;
  try { pid = Number(readFileSync(lock, "utf8").split(" ")[0]); } catch { return null; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (e) { if (e?.code === "ESRCH") return `pid ${pid}, no longer running`; }
  return `pid ${pid}`;
}

/**
 * One try at `lock` for a waiter (`w`: its token, start, wait, what, noted): true once taken.
 * A wait past LOCK_NOTE_AFTER is said once on stderr, naming `what` (else the lock) and its
 * holder: written with writeSync, so a sync waiter's Atomics.wait never holds the line back.
 * Past the wait it throws, naming `what` beside the lock.
 */
function tryLock(lock, w) {
  try { writeFileSync(lock, w.token, { flag: "wx" }); return true; } catch (e) {
    if (e?.code !== "EEXIST") throw e;
  }
  takeOverStale(lock);
  if (Date.now() > w.start + w.wait) {
    const who = lockHolder(lock);
    throw new Error(`${w.what ? `${w.what} (${lock})` : lock} is held by another am${who ? ` (${who})` : ""}`
      + `${w.noted && w.wait > LOCK_NOTE_AFTER ? ` after ${Math.round(w.wait / 1000)} s` : ""}`);
  }
  if (!w.noted && Date.now() - w.start >= LOCK_NOTE_AFTER) {
    w.noted = true;
    const who = lockHolder(lock) ?? "another am";
    const line = `am: waiting for ${w.what ?? lock} (${lock}), held by ${who}; up to ${Math.round(w.wait / 1000)} s in all.\n`;
    try { writeSync(2, line); } catch { /* stderr closed */ }
  }
  return false;
}
const waiter = (wait, what) => ({ token: `${process.pid} ${randomUUID()}`, start: Date.now(), wait, what, noted: wait <= LOCK_NOTE_AFTER });
const retryIn = () => 5 + Math.floor(Math.random() * 20);
/** Takes `lock`, waiting up to `wait` ms with Atomics.wait: for sync holders only (withLock). */
function takeLock(lock, wait = LOCK_WAIT, what = null) {
  const w = waiter(wait, what);
  while (!tryLock(lock, w)) pause(retryIn());
  return w.token;
}
/**
 * takeLock with timers in place of Atomics.wait, so the event loop runs while it waits: a lock
 * this CLI already holds (a task's name lock while it waits for its worktree's, #552) keeps
 * being refreshed and never goes stale under a long wait.
 */
async function takeLockAsync(lock, wait = LOCK_WAIT, what = null) {
  const w = waiter(wait, what);
  while (!tryLock(lock, w)) await new Promise((resolve) => setTimeout(resolve, retryIn()));
  return w.token;
}
function dropLock(lock, token) {
  try { if (readFileSync(lock, "utf8") === token) unlinkSync(lock); } catch { /* gone already */ }
}
function withLock(lock, fn) {
  const token = takeLock(lock);
  try { return fn(); } finally { dropLock(lock, token); }
}
/**
 * Keeps a held lock fresh: its mtime is set to now every LOCK_REFRESH ms while it still holds
 * this holder's token (a lock taken over is never touched). Returns the stop. The timer is
 * unref'd: it never keeps the CLI running.
 */
function keepFresh(lock, token) {
  const timer = setInterval(() => {
    try { if (readFileSync(lock, "utf8") === token) { const now = new Date(); utimesSync(lock, now, now); } } catch { /* gone */ }
  }, LOCK_REFRESH);
  timer.unref();
  return () => clearInterval(timer);
}
/**
 * withLock for an async `fn`, the lock kept fresh while fn awaits (keepFresh); waits up to
 * `wait` ms for it without holding the event loop (takeLockAsync), a long wait named as
 * `what` on stderr.
 */
async function withLockAsync(lock, fn, { wait = LOCK_WAIT, what = null } = {}) {
  const token = await takeLockAsync(lock, wait, what);
  const stop = keepFresh(lock, token);
  try { return await fn(); } finally { stop(); dropLock(lock, token); }
}

/**
 * Adds a project to the list the sidebar reads beside its own remembered projects
 * (model.js PROJECTS_FILE, in the app home outside mods/, so the write reloads nothing), so a
 * project managed from here shows in the sidebar with no space open on it. Under a lock:
 * read, add, write beside, rename, read again; tried three times until the key is there.
 * No app home (Herdr isn't set up here): nothing is written. A failure only warns: the
 * command's own work is done.
 */
export function listProject(key, dir = appHome()) {
  const path = `${dir}/${PROJECTS_FILE}`;
  const read = () => { try { return readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
  let why = "it was still missing after three writes";
  if (!existsSync(dir)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      withLock(`${path}.lock`, () => {
        const text = read();
        const next = withListedProject(text, key);
        if (next !== text) fsIo.replace(path, next);
      });
      if (listedProjects(read()).includes(key)) return true;
    } catch (e) { why = e?.message ?? String(e); }
  }
  process.stderr.write(`am: couldn't list ${key} in ${path}, so the sidebar shows it only once a space is open on it: ${why}\n`);
  return false;
}

/**
 * Takes keys off the CLI's project list (tidy's registry prune, forget), under listProject's
 * lock. Resolves with the keys it found there and took off (none: the file is unchanged).
 */
export function unlistProjects(keys, dir = appHome()) {
  const path = `${dir}/${PROJECTS_FILE}`;
  return withLock(`${path}.lock`, () => {
    let text;
    try { text = readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return []; throw e; }
    const listed = listedProjects(text);
    const taken = listed.filter((k) => keys.includes(k));
    if (!taken.length) return [];
    const next = `${JSON.stringify(listed.filter((k) => !keys.includes(k)), null, 2)}\n`;
    if (next !== text) fsIo.replace(path, next);
    return taken;
  });
}

/** A bot by id, else by its name (exact, then ignoring case), unique in the project. */
export function findBot(file, ref) {
  if (!ref) throw new CliError("Name a bot (its id or its name).", 2);
  const byId = file.bots.find((b) => b.id === ref);
  if (byId) return byId;
  for (const same of [(b) => b.name === ref, (b) => b.name.toLowerCase() === String(ref).toLowerCase()]) {
    const hits = file.bots.filter(same);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new CliError(`${hits.length} bots are named "${ref}" (${hits.map((b) => b.id).join(", ")}); use the id.`);
  }
  throw new CliError(`No bot "${ref}" in this project.`);
}

/**
 * findBot in a project's file, for a command run from `opts`' folder. When the bot isn't
 * there but is in the other file of a worktree edit (RFC 0014 Q16: edits are written in the
 * worktree, reads stay on the main checkout), the refusal names both files and why.
 */
async function botIn(project, ref, opts) {
  try { return findBot(project.file, ref); } catch (e) {
    if (!(e instanceof CliError) || !e.message.startsWith("No bot ") || project.machine) throw e;
    const editing = project.dir !== project.key;
    const dir = editing ? project.dir : await writeDirOf(opts, project.key).catch(() => project.key);
    if (dir === project.key) throw e;
    let other = null;
    try { other = editing ? loadProject(project.key) : projectFrom(project.key, null, readText(under(dir, BOTS_PATH)), dir); } catch { throw e; }
    let found = null;
    try { found = other.text === null ? null : findBot(other.file, ref); } catch { /* not there either */ }
    if (!found) throw e;
    const main = under(project.key, BOTS_PATH), wt = under(dir, BOTS_PATH);
    throw new CliError(editing
      ? `No bot "${ref}" in ${wt}, this worktree's file, which edits change; ${main} has it. Update this worktree from `
        + `the main checkout's branch first, or run the edit in ${project.key}.`
      : `No bot "${ref}" in ${main}, which this command reads; it is in ${wt} (this worktree) and shows here once that `
        + `change is merged into ${project.key}.`);
  }
}

function findCategory(file, ref) {
  const hit = file.categories.find((c) => c.id === ref) ?? file.categories.find((c) => c.title.toLowerCase() === String(ref).toLowerCase());
  if (!hit) throw new CliError(`No category "${ref}" in this project; add it first: am category add --title "${ref}".`);
  return hit;
}

// ---- the attach ledger (attach.js): which terminal plays which bot ----

/** The attach ledger can't be trusted or read: never mistaken for "hc unavailable". */
export class LedgerRefusal extends CliError {}

/**
 * `hc get <t> --json`; null only when hc answers not_found (exit 3), any other failure throws
 * (no answer within `timeout` ms, hc's 15 s when not given, included).
 */
async function hcLookup(terminal, { timeout, strictNotFound = false } = {}) {
  const r = await hc(["get", terminal, "--json"], { timeout });
  if (r.code === 0) {
    const get = parsed(r, ["get", terminal]);
    if (strictNotFound && (!get || typeof get !== "object" || Array.isArray(get))) throw new CliError(`hc get ${terminal} gave incomplete pane identity; nothing was started.`);
    return get;
  }
  if (r.killed) throw new CliError(`hc get ${terminal} gave no answer in ${(timeout ?? 15_000) / 1000} s`);
  let kind = null;
  try { kind = JSON.parse(r.stderr || r.stdout)?.error?.kind ?? null; } catch { kind = null; }
  if (strictNotFound ? r.code === 3 && kind === "not_found" : r.code === 3 || kind === "not_found") return null;
  throw new CliError(`hc get ${terminal} failed: ${(r.stderr || r.stdout).trim()}`);
}

// The single transport reply supplies both verified terminal and startup-verified core id.
// This caches transport identity only; worker allowance is re-read by the proxy at each spawn.
let workerTransportOnce = null;
const workerTransport = () => (workerTransportOnce ??=
  workerProxyTransport(process.env.HC_SOCKET, process.env.HC_TERMINAL_ID));
let coreOnce = null;
/**
 * This computer's hc core id: `hc server status`'s core.id, "permanent random id, reset only
 * when state is wiped" (hc schema CoreInfo). Asked once per run; a failure throws.
 */
function coreId() {
  coreOnce ??= workerTransport().then(async (transport) => {
    let status = transport;
    if (!status) {
      const r = await coreStatus();
      if (r.none) throw new CliError(`hc server status failed: herdr-core isn't answering on this computer (tried ${r.tried.join(", ") || "no socket"}); nothing was started.`);
      if (r.error !== undefined) throw new CliError(`hc server status failed: ${r.error}`);
      status = r.status;
    }
    const id = status?.core?.id;
    if (typeof id !== "string" || !id) throw new CliError("hc server status gave no core id.");
    return id;
  });
  return coreOnce;
}

/** The ledger's rows, or null when there is no file. A group- or world-writable file is refused. */
export function readAttachFile(path = attachPath(appHome())) {
  const flags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd;
  try { fd = openSync(path, flags); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw new LedgerRefusal(`Can't read ${path}: ${e?.message ?? e}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new LedgerRefusal(`Can't read ${path}: not a regular file`);
    const why = modeProblem(path, st.mode);
    if (why) throw new LedgerRefusal(why);
    let text;
    try { text = readFileSync(fd, "utf8"); } catch (e) { throw new LedgerRefusal(`Can't read ${path}: ${e?.message ?? e}`); }
    return readAttach(text).rows;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Appends rows, one O_APPEND write each, the file made 0600 when new (`flag` "ax": only when absent). */
function appendAttach(path, rows, flag = "a") {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, flag, 0o600);
  try { for (const row of rows) writeSync(fd, attachLine(row)); } finally { closeSync(fd); }
}

/** The ledger's lock, beside it (its folder made first). */
const ledgerLock = (path) => { mkdirSync(dirname(path), { recursive: true }); return `${path}.lock`; };
const asCliError = (e) => (e instanceof CliError ? e : new CliError(e?.message ?? String(e)));

/**
 * Which project defines `botId`: the one `folder` keys to, else one this run named, the
 * current folder's, or a remembered one; null when none does.
 */
async function projectDefining(botId, folder, known = null) {
  const keys = [];
  for (const f of [folder, process.cwd()]) {
    if (typeof f === "string") { try { keys.push(await keyOf(f)); } catch { /* a folder gone */ } }
  }
  for (const k of [...namedKeys, ...rememberedKeys()]) if (!keys.includes(k)) keys.push(k);
  for (const k of keys) {
    try { if (loadProject(k).file.bots.some((b) => b.id === botId)) return k; } catch { /* unreadable: not this one */ }
  }
  // A running seat of a project the sidebar knows (its list, a sibling, a cross-project
  // reference) is imported too, not only the folders this run named or remembers (#223).
  for (const [k, file] of known ?? []) if (file?.bots?.some((b) => b.id === botId)) return k;
  return null;
}

/**
 * The one-time import (Ruling: labels seed the ledger once): with no ledger file yet, every
 * live terminal on this computer carrying `bot=<id>` becomes an attach row (by "import"),
 * one per bot by the old live rule (an agent in front, then the newest), its project the one
 * that defines the bot. The file is created, even empty, so it happens once.
 */
async function importLabels(path, proposed) {
  const found = proposed ?? await labelRows();
  try {
    await withLockAsync(ledgerLock(path), async () => {
      if (existsSync(path)) return; // another CLI imported first
      appendAttach(path, found, "ax");
    });
  } catch (e) { throw asCliError(e); }
}

/** The one-time import's rows (importLabels), worked out and not written. */
async function labelRows() {
  const core = await coreId();
  let own = null;
  try { own = await keyOf(process.cwd()); } catch { /* the import can still use the remembered list */ }
  const known = localProjectsFor(own ? { key: own } : null, appHome(), [...namedKeys]);
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state !== "finished");
  // One terminal hc fails to answer for is left out, never the whole import.
  const gets = (await Promise.all(rows.map((r) => hcLookup(r.address).catch(() => null))))
    .filter((g) => g?.state === "live" && local(g.address) && typeof g.labels?.[BOT_LABEL] === "string" && Number.isSafeInteger(g.created_ms));
  const byBot = new Map();
  for (const g of gets) byBot.set(g.labels[BOT_LABEL], [...(byBot.get(g.labels[BOT_LABEL]) ?? []), g]);
  const found = [];
  for (const [bot, all] of byBot) {
    const agents = all.filter(agentInForeground);
    const pick = newest(agents.length ? agents : all);
    // A label naming no bot defined here (a stale or hand-set one) is left out.
    const project = await projectDefining(bot, pick.foreground?.cwd ?? pick.cwd, known);
    if (project) found.push(attachRow({ event: "attach", bot, project, terminal: pick.address, core, created_ms: pick.created_ms, by: "import" }));
  }
  return found;
}

/** End rows (by "sweep") for bindings hc no longer confirms, under the lock; a failure only warns. */
async function sweep(path, ended) {
  try {
    await withLockAsync(ledgerLock(path), async () => {
      const { byKey } = foldAttach(readAttachFile(path) ?? []);
      const rows = ended.filter(({ binding }) => byKey.get(attachKey(binding))?.bot === binding.bot)
        .map(({ binding, reason }) => closingRow(binding, "end", "sweep", reason));
      if (rows.length) appendAttach(path, rows);
    });
  } catch (e) {
    if (e instanceof LedgerRefusal) throw e;
    report([`couldn't write end rows to ${path}: ${e?.message ?? e}`]);
  }
}

/**
 * The ledger's rows, the one-time import done first when there is no file. With no app home
 * (Herdr not set up here) nothing is imported or made: no rows, until a start or attach.
 * readOnly (the import's dry run, #486): the one-time import's rows as it would write them,
 * and no file made.
 */
async function ledgerRows(path, readOnly = false) {
  const rows = readAttachFile(path);
  if (rows !== null) return rows;
  if (!existsSync(appHome())) return [];
  if (readOnly) return labelRows();
  await importLabels(path);
  return readAttachFile(path) ?? [];
}

let viewOnce = null;
/**
 * The ledger as hc confirms it now: { core, path, live: Map bot -> { binding, get },
 * byTerminal: Map address -> { binding, get } }. Every binding is checked with `hc get`;
 * one hc no longer confirms (finished, gone, or its id reused) is left out, and its end row
 * written. Once per run: commands that write the ledger decide again under its lock.
 * readOnly (the import's dry run, #486, the run's first caller): the same view, with no
 * one-time import written and no end row; the run's later calls get that view too.
 */
export function attachView({ readOnly = false } = {}) {
  viewOnce ??= (async () => {
    const path = attachPath(appHome());
    const rows = await ledgerRows(path, readOnly);
    const core = await coreId();
    const machines = await machinesNow();
    const { byKey } = foldAttach(rows);
    const { live, ended, unknown } = await confirmBindings([...byKey.values()], core, lookup, UNANSWERED, machines);
    if (ended.length && !readOnly) await sweep(path, ended);
    // live: this computer's bindings by bot. liveAt / unknownAt: every binding by place and bot
    // (atKey; a linked machine's place is its core id, and a project's checkouts on two
    // machines share their bots' ids). byTerminal: by hc address ("lab/t8" for a machine's).
    // unknown: a machine's rows whose machine isn't connected (neither live nor ended).
    return { core, path, machines, live: new Map(live.filter((l) => placeOfRow(l.binding) === null).map((l) => [l.binding.bot, l])),
      liveAt: new Map(live.map((l) => [atKey(l.binding.bot, placeOfRow(l.binding)), l])),
      unknownAt: new Map(unknown.map((b) => [atKey(b.bot, placeOfRow(b)), b])),
      byTerminal: new Map(live.map((l) => [addressOf(l.binding, machines), l])) };
  })();
  return viewOnce;
}

/** The view's key for a bot in a place (attach.js placeOf: null, or a machine's core id). */
const atKey = (bot, place) => `${place ?? ""}\n${bot}`;
/** The core id hc gives the machine named `name` now (`machines`, machinesById), or null. */
const coreOfName = (machines, name) => { for (const [id, m] of machines ?? []) if (m.name === name) return id; return null; };
/**
 * A bot's live binding for a project, as the view has it: on this computer, or on the linked
 * machine `project.machine` (its core) and in that project there, never a same-id bot elsewhere.
 * On this computer too (automagik#227, RFC 0014 Q16: a clone carries the same ids): a binding
 * counts for its own project; one with no project (an older row) counts by id alone.
 */
function liveFor(view, botId, project) {
  if (!project?.machine) {
    const l = view.live.get(botId);
    return l && (l.binding.project == null || l.binding.project === project?.key) ? l : null;
  }
  const l = view.liveAt.get(atKey(botId, coreOfName(view.machines, project.machine)));
  return l && l.binding.project === project.key ? l : null;
}
function unknownFor(view, botId, project) {
  if (!project?.machine) return null;
  const b = view.unknownAt.get(atKey(botId, coreOfName(view.machines, project.machine)));
  return b && b.project === project.key ? b : null;
}

// hc get for confirmBindings: a linked machine that stops answering mid-run leaves its row
// unknown (UNANSWERED), never failing the whole view.
const lookup = (args) => (args[1].includes("/") ? hcLookup(args[1]).catch(() => UNANSWERED) : hcLookup(args[1]));

/**
 * Runs `fn` under the ledger's lock with the fold read again: fn({ core, byBot, byKey, holds,
 * write }). `holds(binding)` confirms a binding with hc ({ binding, get } or null; an ended
 * one gets its end row), `write(rows)` appends. Two CLIs never both attach one bot.
 */
async function underLedger(fn) {
  const path = attachPath(appHome());
  await ledgerRows(path);
  const core = await coreId();
  const machines = await machinesNow();
  try {
    return await withLockAsync(ledgerLock(path), async () => {
      const fold = foldAttach(readAttachFile(path) ?? []);
      const { byBot, byKey } = fold;
      // A bot's binding in a place (null: this computer; a linked machine's core id).
      const heldBy = (bot, place) => heldIn(fold, bot, place);
      const ends = [];
      const holds = async (binding) => {
        if (!binding) return null;
        const { live, ended, unknown } = await confirmBindings([binding], core, lookup, UNANSWERED, machines);
        if (live.length) return live[0];
        if (unknown.length) return { binding, get: null };
        ends.push(closingRow(binding, "end", "sweep", ended[0].reason));
        return null;
      };
      const write = (rows) => appendAttach(path, [...ends.splice(0), ...rows]);
      try { return await fn({ core, machines, byBot, byKey, heldBy, holds, write }); } finally { if (ends.length) appendAttach(path, ends.splice(0)); }
    });
  } catch (e) { throw asCliError(e); }
}

/** A binding as whois prints it. */
const whoisOf = ({ binding }) => ({ terminal: binding.terminal, core: binding.core, created_ms: binding.created_ms, bot: binding.bot,
  project: binding.project, since: binding.at });

/** The `hc get` of a bot's attached terminal on this computer, or null. */
async function attachedGet(botId) {
  const held = (await attachView()).live.get(botId);
  return held?.get && local(held.get.address ?? held.binding.terminal) ? { ...held.get, address: held.get.address ?? held.binding.terminal } : null;
}

function localProjectsFor(project, appHomeDir = appHome(), extraKeys = []) {
  if (project?.machine) return null;
  return collectProjectMap({
    project: project?.key ?? null,
    file: project?.file ?? null,
    appHome: appHomeDir,
    extraKeys,
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    listDir: (p) => { try { return readdirSync(p); } catch { return []; } },
  });
}

/**
 * A Codex setting as ls and show report it (#1411): what the bot's live pane runs (detected:
 * a stored value a restart hasn't applied yet isn't what runs), else the bot's own stored value
 * (roster), else the first of `levels` ([source, value] from strongest to weakest: the profile
 * its launch names, then its global config), else `fallback`, else null. `map` turns Codex's id
 * into the roster's word (a service tier: priority is fast).
 */
function shownCodexSetting({ argv, pinned, levels = [], fallback = null, fallbackSource = "default", key, map = (v) => v }) {
  if (Array.isArray(argv)) {
    const detected = codexConfigValue(argv, key);
    if (detected !== null) return { value: map(detected), source: "detected" };
  } else if (pinned) return { value: pinned, source: "roster" };
  for (const [source, value] of levels) {
    if (value !== null && value !== undefined) return { value: map(value), source };
  }
  if (fallback !== null && fallback !== undefined) return { value: map(fallback), source: fallbackSource };
  return { value: null, source: null };
}

/**
 * The bytes at the end of `path` when it is at or under `max` (all of it), else its last
 * `max` bytes with a partial first line dropped (#1556): a transcript can be tens of MB.
 */
function tailTextOf(path, max) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > max ? size - max : 0;
    const chunks = [];
    let pos = start;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      chunks.push(buf.subarray(0, n));
      pos += n;
    }
    let text = Buffer.concat(chunks).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally { closeSync(fd); }
}

/**
 * The context a Claude Code transcript file carries (#1556): its newest assistant usage, or
 * null. The last 2 MiB answer in the common case (an assistant message near the end, so the
 * last one there is the file's last); only a tail with none is widened to 64 MiB.
 */
function contextTokensAt(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const size = st.size;
    const tail = size > 2 * 1024 * 1024 ? tailTextOf(path, 2 * 1024 * 1024) : readFileSync(path, "utf8");
    const found = contextTokensOf(tail);
    if (found !== null || size <= 2 * 1024 * 1024) return found;
    return contextTokensOf(tailTextOf(path, 64 * 1024 * 1024));
  } catch { return null; }
}

/** `path` resolved when it is a `.jsonl` transcript strictly inside `root` (a real folder), else null. */
function transcriptUnder(root, path) {
  if (!transcriptShape(path)) return null;
  try {
    const realRoot = realpathSync(root).replace(/\/+$/, "");
    const real = realpathSync(path);
    return real.startsWith(`${realRoot}/`) && real.endsWith(".jsonl") && statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/**
 * The live Claude Code seat's context (#1556): the newest assistant message's input +
 * cache-read + cache-creation tokens in its session log, or null when it isn't a running
 * Claude seat here, no log can be found, or nothing in it measures. `ledger`: the workers
 * ledger rows (the hook's recorded transcript and session). This computer only: a linked
 * machine's logs live there.
 */
function seatContext(project, bot, live, ledger = workerLedgerRows()) {
  if (project?.machine || !live || resolveAgent(bot?.agent) !== "claude") return null;
  const env = paneLaunchEnv(live)?.get(CONFIG_VAR);
  const configDir = typeof env === "string" && isAbsolute(env) ? env : join(home(), ".claude");
  const root = join(configDir, "projects");
  const known = ledgerSession(ledger, live.address, "claude", live.created_ms);
  for (const candidate of [live.labels?.[TRANSCRIPT_LABEL], known?.transcript]) {
    const real = typeof candidate === "string" ? transcriptUnder(root, candidate) : null;
    if (real) return { tokens: contextTokensAt(real), transcript: real };
  }
  const session = sessionFor("claude", live.labels?.[SESSION_LABEL]) ?? known?.session;
  const cwd = live.foreground?.cwd ?? live.cwd;
  if (!session || typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const defaultLogin = typeof env !== "string" || !isAbsolute(env);
  const real = transcriptUnder(root, defaultLogin ? claudeTranscriptPath(home(), cwd, session)
    : join(configDir, "projects", claudeSlug(cwd), `${session}.jsonl`));
  return real ? { tokens: contextTokensAt(real), transcript: real } : null;
}

/** One bot as ls and show print it. With hc failing, the bot is still shown, its pane unknown.
 * `observation` is a linked machine's live lookup; `heldOverride` is the live binding a read
 * resolved beyond the selected ledger (#1128); `context` is the measured Claude Code context
 * (#1556). Both sides of the merge are kept: a linked machine keeps its own observation, a
 * local show/ls may pass a resolved binding, and a Claude seat may pass its context. */
function describe(project, bot, view, hcError, projects = null, observation = null, heldOverride = undefined, context = null, rateLimit = null) {
  const { file } = project;
  const candidate = observation?.candidate;
  const held = heldOverride !== undefined ? heldOverride
    : project.machine ? (candidate ? { get: candidate.get,
      binding: candidate.binding ?? { terminal: candidate.get.address.split("/")[1], at: null } } : null)
      : !bot.planned && view ? liveFor(view, bot.id, project) : null;
  const live = held?.get ?? null;
  const projectsMap = projects ?? localProjectsFor(project);
  const lead = bot.kind === "member" || bot.leadProject
    ? effectiveLead(file, bot.id, { project: project.key, projects: projectsMap })
    : { lead: "", leadProject: null, leadBot: null, warning: null };
  const leadName = lead.leadBot?.name ?? (!lead.leadProject && lead.lead ? file.bots.find((b) => b.id === lead.lead)?.name ?? null : null);
  const agentKey = bot.agent ? resolveAgent(bot.agent, agentTable()) : null;
  const io = project.machine ? null : modelIo();
  const texts = agentKey && io ? configTexts(io.home, io.read) : {};
  const fallback = bot.agent && !project.machine ? defaultModelFrom(bot.agent, texts) : null;
  // A live/unknown target cannot borrow a stopped roster pin or caller defaults.
  const observedArgv = project.machine && (held || hcError)
    ? (Array.isArray(live?.foreground?.argv) ? live.foreground.argv : []) : live?.foreground?.argv;
  const shown = shownModel({ argv: observedArgv, agentKey: bot.agent, pinned: bot.model, fallback });
  // #1411: the Codex reasoning effort and service tier this bot runs now (its pane's command
  // line), else its own record when it isn't running, else the profile its launch names, else
  // the host's global config, else Codex's own: no effort, the default (standard) tier. A
  // template's own words are on the pane's command line too, so they read as detected.
  const codex = agentKey === "codex";
  const global = codex ? codexSettingsFrom(texts.codexConfig) : null;
  const profileName = codex ? codexProfileName(live?.foreground?.argv) : null;
  const profile = profileName && io ? codexProfileFrom(profileName, io) : null;
  const shownEffort = codex
    ? shownCodexSetting({ argv: observedArgv, pinned: bot.effort, key: "model_reasoning_effort",
      levels: [["profile", profile?.effort], ["global", global?.effort]] })
    : { value: null, source: null };
  const shownTier = codex
    ? shownCodexSetting({ argv: observedArgv, pinned: bot.tier, key: "service_tier", map: tierName, fallback: project.machine ? null : "standard",
      levels: [["profile", profile?.tier], ["global", global?.tier]] })
    : { value: null, source: null };
  // #1413 F1: the Claude Code permission mode this bot runs now, read from its live pane's
  // command line; only when it isn't running does the record say what its next start runs. A
  // live pane whose command line names none has no effective mode to report: the record's mode
  // is not this process's, so claiming it (source "roster") would lie about what runs.
  const permissionModes = permissionModesOf(agentKey);
  const paneArgv = Array.isArray(live?.foreground?.argv) ? live.foreground.argv : null;
  const detectedPermission = paneArgv && permissionModes ? permissionModeFrom(paneArgv) : null;
  const shownPermission = !permissionModes ? { value: null, source: null }
    : paneArgv ? (detectedPermission ? { value: detectedPermission, source: "detected" } : { value: null, source: "live" })
      : bot.permissionMode ? { value: bot.permissionMode, source: "roster" }
        : { value: PERMISSION_MODE_DEFAULT, source: "default" };
  // The workers' Antigravity mode is shown as the default (auto) when their agent is Antigravity.
  const worker = bot.worker && typeof bot.worker === "object" ? { ...bot.worker } : null;
  if (worker && resolveAgent(worker.agent ?? bot.agent) === "antigravity") worker.agyMode = agyModeOf(worker.agyMode);
  let status = "not running";
  // #1557: a running Claude Code seat whose pane tail shows the rate-limit dialog reports the
  // added status word, with the dialog's reset time when it shows one. Its core status stays
  // beside it (`core_status`), so the word is added to the contract, not a replacement.
  const rateLimited = rateLimit && held && agentInForeground(live) ? rateLimit : null;
  if (bot.planned) status = "planned";
  else if (hcError) status = project.machine ? "unknown" : "hc unavailable";
  else if (!held && view && unknownFor(view, bot.id, project)) status = "unknown"; // its machine isn't answering
  else if (held) status = agentInForeground(live) ? (rateLimited ? "rate-limited" : live.status?.state ?? "running") : "no agent in front";
  // #823: the effective permission lists the launch carries: a seat's on the project folder,
  // and a worker default's (its task worktree is added at its launch).
  const seatAgy = bot.agent === "antigravity"
    ? agyPermissionPlan({ bot, scope: "seat", folder: project.key, realpath: realDir, homeDir: home() }) : null;
  const workerAgent = !worker ? resolveAgent(bot.agent) : worker.template ? null : resolveAgent(worker.agent ?? bot.agent);
  // #884 M1/#1046: a review worker is read-only, but it is trusted for its own worktree like any
  // writer; the worktree is only known at launch, so its plan names it as such.
  const workerRoleOf = workerRole(bot).role;
  const workerTrusted = ["<worktree>"];
  const workerAgy = workerAgent === "antigravity"
    ? agyPermissionPlan({ bot, scope: "worker", role: workerRoleOf, folder: null, realpath: realDir, homeDir: home() }) : null;
  // #1413 F1: the `auto mode` line is what the live pane runs too, never the mode a restart
  // would apply; a live command line this pack reads no mode on says exactly that.
  const auto = bot.agent ? autoModeOf(bot, !project.machine) : null;
  const autoMode = auto && permissionModes && paneArgv
    ? { ...auto, args: detectedPermission ? permissionModeArgs("claude", detectedPermission) : [],
      note: detectedPermission ? PERMISSION_MODE_WHAT[detectedPermission]
        : "this pack reads no --permission-mode on its live command line" }
    : auto;
  const out = {
    id: bot.id, name: bot.name, kind: bot.kind, ...placeOf(project),
    lead: lead.lead || null, leadName,
    ...(lead.leadProject ? { leadProject: lead.leadProject } : (bot.leadProject ? { leadProject: bot.leadProject } : {})),
    ...(bot.crossMembers?.length ? { crossMembers: bot.crossMembers } : {}),
    category: bot.kind === "member" && !lead.leadProject && lead.lead === mainBotOf(file)?.id ? (bot.category ?? null) : null,
    planned: bot.planned ?? null, agent: bot.agent ?? null,
    model: shown.model, modelSource: shown.source, pinnedModel: bot.model ?? null,
    effort: shownEffort.value, effortSource: shownEffort.source, pinnedEffort: bot.effort ?? null,
    tier: shownTier.value, tierSource: shownTier.source, pinnedTier: bot.tier ?? null,
    permissionMode: shownPermission.value, permissionModeSource: shownPermission.source, pinnedPermissionMode: bot.permissionMode ?? null,
    agyMode: bot.agent === "antigravity" ? agyModeOf(bot.agyMode) : (typeof bot.agyMode === "string" && bot.agyMode ? bot.agyMode : null),
    terminal: held?.binding.terminal ?? null, status, duplicate: false, since: held?.binding.at ?? null,
    ...(rateLimited ? { core_status: live.status?.state ?? null,
      rate_limited: { question: rateLimited.question ?? null, ...(rateLimited.resets_at ? { resets_at: rateLimited.resets_at } : {}) } } : {}),
    role: bot.role, rank: bot.rank ?? null, code: bot.code !== false, look: bot.look,
    hcProxy: bot.hcProxy === true,
    restartAt: restartAtOf(bot), pinnedRestartAt: bot.restartAt ?? null,
    context_tokens: context && Number.isFinite(context.tokens) ? context.tokens : null,
    autoMode,
    worker,
    ...(seatAgy ? { agyPermissions: { allow: seatAgy.allow, deny: seatAgy.deny, trustedWorkspaces: seatAgy.trustedWorkspaces } } : {}),
    ...(workerAgy ? { workerAgyPermissions: { allow: workerAgy.allow, deny: workerAgy.deny, trustedWorkspaces: workerTrusted } } : {}),
  };
  const crossWarns = bot.crossMembers?.length
    ? crossMemberWarnings(file, bot.id, { project: project.key, projects: projectsMap })
    : [];
  const warning = [lead.warning, ...crossWarns].filter(Boolean).join("; ");
  if (warning) out.warning = warning;
  if (hcError && !bot.planned) out.hcError = hcError;
  return out;
}

/** The view for ls and show: { view, hcError }; a refused ledger still throws. */
async function viewOrError() {
  try { return { view: await attachView(), hcError: null }; } catch (e) {
    if (e instanceof LedgerRefusal || !(e instanceof CliError)) throw e;
    return { view: null, hcError: e.message };
  }
}

/** Read the target, never import or sweep the caller's ledger to discover linked panes.
 * A label is observation only; only an existing, confirmed binding permits replacement.
 * Each call refreshes machine identity and launch-folder ownership on the target.
 */
async function linkedObservation(project, bot) {
  const { machine, key } = project;
  const replyMachines = await hcJson(["machine", "ls"]);
  const targets = replyMachines?.machines?.filter?.((m) => m?.name === machine);
  if (!Array.isArray(targets) || targets.length !== 1 || !targets[0].id
      || replyMachines.machines.filter((m) => m?.id === targets[0].id).length !== 1) {
    throw new CliError(`${machine}'s core identity is missing or ambiguous; nothing was started.`);
  }
  const machines = machinesById(replyMachines);
  const core = coreOfName(machines, machine);
  if (!core || !machines.get(core)?.connected) throw new CliError(`${machine}'s core cannot be confirmed; nothing was started.`);
  const bindings = [...foldAttach(readAttachFile(attachPath(appHome())) ?? []).byKey.values()];
  const binding = bindings.find((b) => b.bot === bot.id && b.project === key && b.core === core && b.machine);
  if (bindings.some((b) => b.bot === bot.id && b.project === key && b.machine === machine && b.core !== core)) {
    throw new CliError(`${machine}'s core changed since the attachment; inspect and attach the intended pane before restarting.`);
  }
  const reply = await hcJson(["ls", "--label", `${BOT_LABEL}=${bot.id}`]);
  if (!Array.isArray(reply) && !Array.isArray(reply?.terminals)) throw new CliError(`hc ls gave no pane list for ${bot.name}; nothing was started.`);
  const addresses = new Set();
  for (const row of rowsOf(reply)) {
    if (typeof row?.address !== "string" || !row.address) throw new CliError(`hc ls gave an incomplete pane address for ${bot.name}; nothing was started.`);
    if (row.address.startsWith(`${machine}/`)) {
      if (!/^[A-Za-z0-9._-]+$/.test(row.address.slice(machine.length + 1))) throw new CliError(`hc ls gave an invalid target address; nothing was started.`);
      addresses.add(row.address);
    }
  }
  const bound = binding ? `${machine}/${binding.terminal}` : null;
  if (bound) addresses.add(bound);
  const candidates = [];
  for (const address of addresses) {
    const get = await checkedPane(address, { strictNotFound: true });
    if (!get) continue; // actual not_found/finished, never a failed lookup
    if (!get.labels || typeof get.labels !== "object" || Array.isArray(get.labels)) throw new CliError(`hc get ${address} gave no label map; nothing was started.`);
    if (address === bound && get.created_ms !== binding.created_ms) throw new CliError(`${address} is another terminal now (its created_ms changed); inspect and attach the intended pane.`);
    if (address !== bound && get.labels[BOT_LABEL] !== bot.id) throw new CliError(`${address} changed its bot label during observation; nothing was started.`);
    if (typeof get.cwd !== "string" || !get.cwd.startsWith("/") || (await remoteIo.exec("test", ["-d", get.cwd], machine)).code !== 0) {
      throw new CliError(`${address}'s launch folder cannot be confirmed; nothing was started.`);
    }
    const owner = await remoteProjectOf(machine, get.cwd);
    const roster = await loadRemoteProject(owner.key, machine);
    if (!roster.file.bots.some((b) => b.id === bot.id)) throw new CliError(`${address}'s project ownership cannot be confirmed; nothing was started.`);
    if (owner.key !== key) {
      if (address === bound) throw new CliError(`${address}'s launch project differs from its attachment; nothing was started.`);
      continue;
    }
    candidates.push({ get, binding: address === bound ? binding : null });
  }
  if (candidates.length > 1) throw new CliError(`${bot.name} has duplicate live labels in ${candidates.map((c) => c.get.address).join(", ")}; inspect those panes before starting or restarting.`,
    1, { refused: "duplicate", duplicate: true });
  return { core, machine, candidate: candidates[0] ?? null };
}

async function describeLinked(project, bot) {
  let observation, error = null;
  try { observation = await linkedObservation(project, bot); } catch (e) {
    if (e instanceof LedgerRefusal) throw e;
    error = e;
  }
  return { ...describe(project, bot, null, error?.message ?? null, null, observation),
    duplicate: error?.detail?.duplicate === true };
}

function linkedRestartHeld(project, bot, observation) {
  const candidate = observation.candidate;
  if (candidate && !candidate.binding) throw new CliError(`${bot.name} already runs in ${candidate.get.address}, without a confirmed caller attachment. Inspect it, then use am attach ${bot.id} ${candidate.get.address} --machine ${project.machine} --project ${project.key} before restarting.`);
  return candidate;
}

async function recheckLinkedRestart(project, bot, initial, opts, tree = false) {
  const current = await linkedObservation(project, bot);
  const held = linkedRestartHeld(project, bot, current);
  if (current.core !== initial.core || (held ? attachKey(held.binding) : null) !== (initial.candidate ? attachKey(initial.candidate.binding) : null)) {
    throw new CliError(`${bot.name}'s target identity changed before restart; nothing was started.`);
  }
  if (held && !tree) await checkLinkedRestartPane(bot, held.get, opts);
  return held;
}

async function checkLinkedRestartPane(bot, old, opts) {
  const helpers = await helpersOf(old.address);
  const helperRefusal = restartRefusal({ name: bot.name, old: { ...old, status: { state: "idle" } }, helpers, force: opts.force, onMachine: true });
  if (helperRefusal) throw new CliError(helperRefusal, 1, { refused: "helpers", terminal: old.address });
  const refusal = restartRefusal({ name: bot.name, old, force: opts.force, onMachine: true });
  if (refusal) throw busyRefusal(refusal, old);
  if (!old.status && !opts.force) throw new CliError(`${old.address} doesn't tell hc whether ${bot.name}'s agent is busy or waiting for an approval, so a restart `
    + `could end it mid-turn. Nothing was restarted. Look at the pane first, then pass --force to restart anyway `
    + `(it sends the pane no keys: it starts a new pane, then ends this one).`);
}

// ---- the briefing hook (briefingText.mjs installHook, as launch.js afterBind uses it) ----

const hookIo = {
  git: (args, cwd) => runProgram("git", args, { cwd }),
  read: async (path) => readText(path),
  write: async (path, text, before, { mode } = {}) => {
    if (readText(path) !== before) throw new Error(`${path} changed while being edited`);
    fsIo.replace(path, text, mode);
  },
  mkdir: async (dir) => { mkdirSync(dir, { recursive: true }); },
};

/**
 * Merges the briefing hook for a Claude bot (the session ledger, the once-only fallback); never throws: { written, warnings }.
 * With no pack under the app home, it names the am part's own entry and runner instead (CLI-only host).
 */
export function writeBriefingHook(bot, folder, appHomeDir = appHome(), options = {}) {
  return installHook(bot.name, folder, appHomeDir, hookIo, { amStore: amStore(), ...options });
}

// ---- the briefing at launch (models.js briefingLaunch): the agent's system prompt ----

// The config file an agent's own prompt lives in (models.js ownPromptIn), or null.
const ownConfigOf = (agentKey) => (agentKey === "codex" ? configPaths(home()).codexConfig
  : agentKey === "hermes" ? (process.env.HERMES_HOME ? `${process.env.HERMES_HOME.replace(/\/+$/, "")}/config.yaml` : configPaths(home()).hermesConfig)
    : null);

/**
 * `argv` (what starts `bot`'s agent `agentKey`) with the bot's launch briefing put in as that
 * agent takes it (a file under the app home for Claude Code, written now, before the agent
 * reads it; text or an environment variable for the others), any older one taken out. An agent
 * with no way, or a command that doesn't run it, starts as it is. Never throws: a file that
 * can't be written, or a codex config that sets its own developer_instructions, means no
 * briefing at launch and a warning. Returns { argv, env, warnings }.
 */
export async function briefedLaunch(project, bot, agentKey, argv, appHomeDir = appHome()) {
  const warnings = [];
  if (agentKey === "hermes" && bot.hermes !== undefined) return { argv, env: {}, warnings };
  const way = briefingWay(agentKey);
  const agents = agentTable();
  if (!way || agentKeyOfArgv(argv, agents) !== agentKey) return { argv, env: {}, warnings };
  const text = launchBriefingText({
    self: bot,
    agent: agentKey,
    guard: agentKey === "dsh-tui" ? true : null,
    file: project.file,
    project: project.key,
    projects: localProjectsFor(project, appHomeDir),
    isGit: await projectIsGit(project),
  });
  let launch = null;
  if (way === "file") {
    const path = briefingFilePath(appHomeDir, project.key, bot.id);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      launch = briefingLaunch(agentKey, { path });
    } catch (e) {
      warnings.push(`${bot.name} starts without its briefing in its system prompt (${path}: ${e?.message ?? e}); its hook gives it once instead.`);
    }
  } else if (ownPromptIn(agentKey, modelIo().read(ownConfigOf(agentKey)))) {
    warnings.push(`${bot.name} starts without its briefing: ${agentKey === "codex"
      ? "codex's config.toml sets developer_instructions, which a -c would replace"
      : "hermes' config.yaml sets a personality or agent.system_prompt, which HERMES_EPHEMERAL_SYSTEM_PROMPT would replace"}.`);
  } else {
    launch = briefingLaunch(agentKey, { text });
  }
  return { argv: withBriefing(agentKey, argv, launch, agents), env: launch?.env ?? {}, warnings };
}

/**
 * Writes an Antigravity launch's permission file (#823): 0600 in a 0700 folder under the pack's
 * app home, never agy's own settings. A failed write refuses the launch: starting without the
 * list would stop the bot at its first prompt. `settings`: models.js agySettingsPlan.
 */
function writeAgySettingsFile(settings, bot) {
  try {
    const dir = dirname(settings.path);
    // Never follow a symlinked folder or file: this file decides what agy may do. A temp in the
    // real folder (created O_EXCL) renamed onto the path replaces a link, never its target.
    let st = null;
    try { st = lstatSync(dir); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    if (st) {
      if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink`);
      if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink`);
    }
    try { if (lstatSync(settings.path).isSymbolicLink()) throw new Error(`${settings.path} is a symlink`); }
    catch (e) { if (e?.code !== "ENOENT") throw e; }
    const tmp = `${settings.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, settings.text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, settings.path);
    chmodSync(settings.path, 0o600);
  } catch (e) {
    throw new CliError(`${bot?.name ?? "The bot"} wasn't started: its Antigravity permission list couldn't be written `
      + `(${settings.path}: ${e?.message ?? e}).`);
  }
}

// ---- arguments ----

const OPTIONS = {
  json: { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  project: { type: "string" }, name: { type: "string" }, agent: { type: "string" }, kind: { type: "string" },
  role: { type: "string" }, instructions: { type: "string" }, "instructions-file": { type: "string" },
  code: { type: "string" },
  lead: { type: "string" }, "lead-project": { type: "string" }, "no-lead-project": { type: "boolean" },
  "old-lead": { type: "string" },
  "cross-member": { type: "string", multiple: true }, "no-cross-members": { type: "boolean" },
  category: { type: "string" }, "no-category": { type: "boolean" },
  character: { type: "string" }, colour: { type: "string" }, color: { type: "string" }, omni: { type: "boolean" },
  model: { type: "string" }, "no-model": { type: "boolean" }, rank: { type: "string" }, "hc-proxy": { type: "string" },
  "restart-at": { type: "string" }, "no-restart-at": { type: "boolean" }, due: { type: "boolean" },
  wake: { type: "string" }, "no-wake": { type: "boolean" },
  "person-features": { type: "string" }, "permission-mode": { type: "string" },
  "agy-mode": { type: "string" }, "worker-agy-mode": { type: "string" },
  "hermes-home": { type: "string" }, "hermes-profile": { type: "string" }, "no-hermes": { type: "boolean" },
  "agy-allow": { type: "string", multiple: true }, "agy-deny": { type: "string", multiple: true },
  "no-agy-permissions": { type: "boolean" },
  "planned-wave": { type: "string" }, "planned-note": { type: "string" }, unplanned: { type: "boolean" },
  space: { type: "string" }, tab: { type: "string" },
  title: { type: "string" }, sub: { type: "string" }, id: { type: "string" },
  check: { type: "boolean" }, rollback: { type: "boolean" }, "retry-skipped": { type: "boolean" }, auto: { type: "string" },
  "worker-agent": { type: "string" }, "worker-model": { type: "string" }, "worker-effort": { type: "string" },
  "worker-template": { type: "string" }, template: { type: "string" },
  branch: { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, effort: { type: "string" }, tier: { type: "string" },
  task: { type: "string" }, bot: { type: "string" }, move: { type: "boolean" },
  queued: { type: "boolean" }, cancel: { type: "boolean" }, "run-queued": { type: "string" },
  fresh: { type: "boolean" }, force: { type: "boolean" }, save: { type: "boolean" }, tree: { type: "boolean" }, "fresh-shared": { type: "boolean" },
  cwd: { type: "string" },
  revive: { type: "boolean" }, boot: { type: "boolean" }, wait: { type: "string" }, "dry-run": { type: "boolean" }, last: { type: "boolean" },
  machine: { type: "string" }, linked: { type: "boolean" }, local: { type: "boolean" },
  "from-hc": { type: "boolean" }, "squad-label": { type: "string" }, apply: { type: "boolean" },
};

export const USAGE = `am: Automagik Herdr's bots and updates from the command line

Usage: am <command> [options]                   (every command takes --json and --project <folder>)
       am <command> --machine M --project <folder there> ...
                                                 ls, show, create, edit, main, rm, category, start,
                                                 restart, attach, detach, whois and history on a linked
                                                 machine (hc machine ls), through hc
       am --version                              the installed pack's version

  ls [--all]                    bots with kind, lead, category, rank, agent, model, pane, status
                               plus planned waves, code opt-outs and Antigravity modes; a seat
                               blocked on Claude Code's rate-limit dialog is 'rate-limited'
                               (with the reset time the dialog shows), never answered
  show <bot>                    one bot in full (--json: the effective effort and tier,
                                and where each comes from)
                                Linked ls/show observe target panes without adopting them.
                                Model/effort/tier come from observed argv; unobserved target
                                defaults are unknown. A stopped bot can show its configured pin.
                                Argv does not prove an interactive in-process model change.
                                Linked start checks existing panes and checks again before run;
                                independent caller hosts are not serialized. Linked restart
                                requires an existing pane to have a confirmed attachment.
  create --name N --agent A [--kind main|member] [--role R]
         [--code true|false]            false omits the worker instruction; default true
         [--person-features on|off]     Claude Code only: keep the prompt suggestions, away
                                       summaries and subagent progress summaries; default off
         [--permission-mode MODE]       Claude Code only: the bot's own --permission-mode
                                       (acceptEdits, auto, bypassPermissions, manual, dontAsk,
                                       plan); default auto, empty on edit clears it
         [--instructions TEXT | --instructions-file F|-] [--lead BOT [--lead-project DIR]] [--category ID]
         [--cross-member BOT@DIR]...   reciprocal cross-project member(s) reporting to this lead
         [--character C --colour K | --omni] [--model M] [--rank R]
         [--effort E] [--tier fast|standard]   Codex: the bot's own reasoning effort (low,
                                       medium, high, xhigh, max, ultra) and tier; empty on
                                       edit clears them
         [--hermes-home DIR --hermes-profile NAME]  pair an existing Hermes Bot Chat
         [--no-hermes]                   remove a pairing (does not delete the Hermes Bot)
         [--agy-mode accept-edits|auto|plan]   Antigravity's --mode; default auto
         [--agy-allow RULE]... [--agy-deny RULE]...
                                       Antigravity permission rules this bot and its workers add
                                       to their launch's own lists (repeatable; never removes a
                                       fixed deny). An empty value clears that list
         [--planned-wave N [--planned-note T]]          prints the new bot's id
         [--wake daily@HH:MM | --no-wake]   daily wake in the owning machine's local time
         [--worker-agent A] [--worker-model M] [--worker-effort E]   its workers' defaults
         [--worker-agy-mode accept-edits|auto|plan]                  (Antigravity's --mode)
         [--hc-proxy on|off]            per-bot Linux proxy; default off. Edit, proxy approve
                                       (review the diff), then restart to apply or roll back
         [--worker-template T]          (an hc template: owns the command, so it wins)
  edit <bot> [the create options] [--code true|false] [--unplanned] [--no-model] [--no-category]
             [--no-lead-project] [--no-cross-members] [--rank=] [--effort=] [--tier=]
             [--restart-at N | --no-restart-at]   a context threshold in tokens (#1556):
                                       a main bot defaults to 250000, a member has none
             [--wake daily@HH:MM | --no-wake]   set or clear the bot's daily wake
             [--permission-mode=] [--worker-agent=] [--worker-model=] [--worker-effort=] [--worker-template=]
             [--agy-mode=auto] [--worker-agy-mode=auto]   (empty: cleared; auto is the default)
             [--person-features on|off]   (Claude Code only; default off)
             [--agy-allow=] [--agy-deny=] [--no-agy-permissions] [--cross-member=]   (empty: cleared)
  Effort and tier (Codex): --effort E and --tier fast|standard store the bot's own reasoning
  effort and service tier; every start, restart and revive passes them as per-launch Codex
  overrides, and the global Codex config is never written. What wins: the bot's record, then
  the hc template it runs, then its Codex profile, then the global config. A --model change
  that names no --tier runs the new model on standard, said explicitly on the launch line, so
  a Fast a profile, a template or the host config still names never applies to it. am show
  --json reports the effective values and their source.
  Permission mode (Claude Code): --permission-mode MODE stores one of Claude Code's own
  --permission-mode names (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan); every
  start, restart and revive passes it, independent of the model, effort and tier, and a value
  Claude Code doesn't accept is refused. --permission-mode= clears it back to the pack's auto
  mode. Another agent has no per-bot permission mode: a value for one is refused, never dropped.
  main <bot> [--old-lead <bot>] [--dry-run]
                                hand over the main role and list the members that follow it
                                --old-lead sets the previous main's lead. --dry-run previews the hand-over.
  rm <bot>
  category ls | add --title T [--sub S] [--id ID] | edit <id> [--title T] [--sub S]
           | rm <id> | order <id>...
  start <bot> [--space ID] [--tab ID]   a new pane on this computer (prints its terminal)
  revive [--dry-run] [--boot] [--wait SECONDS] | revive --last
                                after a restart of this computer: every bot the attach ledger
                                binds here whose pane is gone, or is the bare shell herdr-core
                                keeps in a pane whose program ended, is restarted in its place
                                (restart --tree: same space, tab and folder, resumed where its
                                agent allows, its helpers under it), the main bot first, each
                                bot after its lead. A pane whose agent runs is never touched.
                                dsh-TUI, Antigravity, Codex and Kimi ids are found on disk after
                                launch. With no id of its own, Codex or Kimi starts a new
                                conversation; its folder's latest one is never guessed.
                                Each project's main bot gets one report: who resumed, who is on
                                a new conversation and why, who isn't back and the command that
                                brings it back by hand; it is kept in the app home's
                                automagik-herdr/revive-last.json too, and so is a pass that
                                stopped early; --last shows the last pass and runs nothing.
                                --dry-run prints the plan and touches nothing. --boot is the login service's pass: once
                                per boot, it also takes the bots whose ended pane another
                                command swept since the boot. --wait waits that long for
                                herdr-core first, and prints counts only. This computer's
                                panes only. A bot whose agent was quit comes back too: to
                                keep one down across restarts, detach it (detach <bot>).
  revive service install | uninstall | status
                                the login service that runs revive --boot (Linux: a systemd
                                user unit, written and enabled, never started on the spot;
                                macOS: a launchd agent in your own ~/Library/LaunchAgents,
                                written and left for launchd to load at your next login).
                                install.sh asks before it installs it.
  rate-limit [--all] [--dry-run] [--json]
                                One sweep of #1557: a running Claude Code seat blocked on the
                                rate-limit options dialog is parked or switched by the project's
                                onRateLimit (park, the default, queues am restart <bot> for one
                                minute after the reset it shows, or no wake when it shows none;
                                switch restarts it on another signed-in login whose meter reading
                                is fresh and which holds this conversation's transcript, else
                                parks). One attention item per episode; am ls shows it. It never
                                types into the dialog.
  restart --queued [--project DIR] [--json]   List queued restarts (with a parked seat's wake time).
  restart --cancel <bot> [--project DIR] [--json]   Cancel a queued restart.
  restart --due [--all] [--dry-run] [--json]   Restart from a handoff the seats whose Claude Code
                                context is over their threshold (restartAt; a main bot defaults
                                to 250000 tokens). Each due seat is asked to write its handoff to
                                <app home>/automagik-herdr/handoff/<bot>.md and end its turn; an
                                idle seat restarts from that file now (--fresh --tree), a working
                                or blocked one queues until its next idle. A seat that doesn't
                                write the file in time is reported, not restarted. --dry-run
                                prints the plan and touches nothing; --all covers this CLI's
                                remembered projects. A timer or the login service runs the pass.
  restart <bot> [--fresh] [--agent A] [--model M [--save]] [--tree [--fresh-shared]] [--force] [--cwd DIR]
                                the bot's agent again in its pane's place (same space and tab,
                                same folder, labels kept), launched from its current source
                                (a live hc template's current command, else the definition's
                                agent and model, plus the agent's own resume words), never from
                                the old pane's command: a flag the source no longer names is
                                dropped, with one line naming the flag names only (their values
                                masked). The new pane starts, and the old one ends only
                                once the new one's agent has stayed up (prints the new
                                terminal). It resumes the conversation in that folder
                                by the pane's session id (its agent.session label, or the
                                ledger's row): claude --resume <session>, codex resume
                                <session>, omp --resume=<session>, pi --session <session>,
                                kimi --session=<session>, agy --conversation <session>, hermes
                                --resume <session>; with no id, the folder's latest (codex
                                resume --last, --continue for the rest), unless another bot
                                on that agent runs there: then a new one, and why;
                                --fresh: a new one; --agent/--model: a swap (always new;
                                --save: also into ${BOTS_PATH}). Queues a working or blocked
                                bot until its next idle; the owner answers dialogs.
                                Helpers that would end with it still refuse, unless --force
                                (they end with it) or --tree (they run again under the new pane,
                                one at a time, each in its folder with its command, resumed: by
                                its agent.session or revive.session id, else its folder's latest,
                                refused when another of them shares that folder and agent unless
                                --fresh-shared starts those on a new conversation; a helper
                                unreadable, in a gone folder, with helpers of its own or a session
                                another names refuses before anything starts; the pane and its
                                helpers are waited for until idle first; the old pane ends, its
                                helpers with it, before they run again; one that fails is
                                reported with the hc run line that resumes it by hand, exit 1;
                                one that won't end is said and never run twice). Not from inside
                                the old pane. A bot not running is started.
                                --cwd DIR: the new pane starts in DIR, not the old pane's folder
                                (helpers keep theirs). Claude finds a conversation by folder slug
                                (the path, every non-alphanumeric as "-"): a resume into a DIR of
                                another slug is refused unless --fresh. A Claude bot's briefing
                                hook is written into DIR (.claude/settings.local.json), as start
                                writes it into the project folder.
  attach <bot> <terminal> [--move]   tie a running pane to the bot; a bot attached elsewhere
                                is refused unless --move (its old pane is detached first)
  detach <bot>                  untie the bot from its pane (a removed bot: by its id)
  import --from-hc [--squad-label L] [--apply]
                                a running hc team as bots: each live pane on this computer
                                labelled L= (default: squad) with an hc name and an agent in front
                                becomes a bot of that name, attached to that pane. In each squad
                                the captain (the pane labelled role=captain, else the one whose
                                name or template is the squad's name then -cap or -captain, as
                                web-cap) reports to the main bot and the others to their
                                captain; a member's rank is its role= label when that is a rank,
                                else its name's last word (dev, test, review, fix, pm). Prints
                                the plan and writes nothing, the attach ledger included, unless
                                --apply, which prints it, then creates and attaches. A pane
                                already playing its bot only gets its lost labels back, so a
                                second run changes nothing. Any conflict (a pane playing or
                                labelled for another bot, a bot of that name attached
                                elsewhere, under another lead or of another agent, a squad
                                without one captain) refuses the whole import. Never starts,
                                moves or restarts a pane
  whois <terminal> | whois --bot <bot> | whois --all
                                who plays where, by the attach ledger (--all: every place it holds)
  history <bot>                 what the bot did, by the attach and workers ledgers: its panes,
                                starts, sessions (and the newest transcript) and workers. With
                                --machine M --project <folder there>, the attach, detach and end
                                events this computer recorded for that machine's project
  brief <bot>                   print the bot's briefing with its team's live state, as it is now
  tidy                          what drifted in the window, labels and project list, as a plan;
                                changes nothing (--json: the plan's actions)
  forget <project>              take a project's folder off this CLI's project list; its folder,
                                worktrees, bots and panes stay as they are. ls --all and the
                                sidebar also show the sidebar's own remembered projects, which
                                the sidebar forgets once the bots file is gone: forget says when
                                it remembers this one (--json: sidebar_remembers). start,
                                restart, attach and create already drop an entry whose folder
                                is gone, with a note when the command succeeds
  worker "<task>" (--branch B [--base REF] | --worktree DIR)
         [[--agent A] [--model M] [--effort E] | --template T] [--name N]
         [--role dev|test|review|fix] [--task ID [--lead BOT]]
                                from a bot's pane: start one worker for the task, an hc
                                child of the bot in the task's worktree (prints its terminal);
                                --template runs an hc template, alone; --role defaults from
                                the bot's rank (tester: test, reviewer: review, fixer: fix,
                                else dev). One writer (dev, test, fix) per worktree, any bot;
                                reviewers run alongside. --task: Genie's short id (gl-231);
                                the worker is named <id>-<role>, a --branch must contain the
                                id, and --lead (default: this bot; a reviewer or fixer must
                                pass it) is the task's lead bot. A bot with a worker.swap
                                runs it on about one task in three, by rule. Each call then
                                removes up to 5 ended workers' worktrees made by this command
                                in the launching repository, keeping unknown ownership or work
  worker kill <pane>            from a bot's pane: end a worker it started with am worker once
                                its turn is over. Its worker.of label names the calling bot, which
                                still owns it after its seat restarts. Bot seats (including your own),
                                other bots' workers and workers still working are refused. Only the
                                project's main bot can end a plain hc run child, including after a
                                handoff or restart. The CLI rechecks the ledger and target before
                                kill. hc has no conditional kill.
  reap                          explicitly check all ended workers' created worktrees, across
                                repositories. Remove only with verified ownership and current
                                HEAD pushed or proven merged, including squash merges. Keep
                                unknown ownership, missing checkouts, dirty work or uncertain
                                proof, with a reason. End a finished worker's terminal once its
                                branch's pull request merged or closed; delete a local branch a
                                worker made, merged into the default, with no worktree; name
                                every other worktree of a known project and leave it alone.
                                No broad prune. A worktree only given to a worker (--worktree,
                                a branch's existing one) is never removed
  update [--check | --rollback | --retry-skipped]
                                install the latest release (checksum verified), only report
                                current and latest (--check), or put the replaced pack back;
                                --retry-skipped: install the release this pack rolled back from,
                                clearing that record first (an automatic update still waits for a
                                newer release); an update then runs meter install where you agreed
                                to it (install.sh, or an earlier meter install); nobody asked: nowhere
  update --auto on|off|status   Install updates automatically (on by default): Herdr installs
                                each newer verified release on its own; a version you rolled
                                back is skipped until a newer one is out. Only for a pack
                                install.sh put in place, never a checkout
  meter install [--machine M | --linked | --local]
                                usagemeter, the build the signed meter-lane pointer names (its
                                sha256 checked on each machine, never a downgrade, a pointer
                                older than one already taken refused) in ~/.local/bin on this computer and
                                every connected linked machine (hc machine ls); --machine: that
                                one, e.g. one linked later; --linked: the machines only; --local:
                                this computer only. A machine that fails is a warning. Running
                                it records your yes (--local: this computer only) for updates
  machines [--machine M]        what this computer and every linked machine run (am, the pack,
                                usagemeter), both of its switches (its own pack auto setting,
                                \`am update --auto\`, and the linked updater's, below), and how
                                each one's last update went
  machines update [--machine M | --linked | --local]
                                one update of them all now (Herdr starts one every hour): each
                                connected linked machine runs its own \`am update\` (am, then the
                                pack where one is installed: each signed pointer checked there
                                against that machine's own keys, each tarball against its
                                sha256, never an older one, the replaced one kept for a
                                rollback), then usagemeter as meter install does, where there
                                is one or you agreed to all. The pack takes that machine's
                                automatic path: its own auto setting off, or a release it rolled
                                back, holds it until someone runs \`am update\` there.
                                This computer: am and usagemeter
                                (Herdr installs its pack). A machine that fails says why
  machines --auto on|off|status [--machine M]
                                whether this computer (or M) takes those updates from the linked
                                Herdr: on unless it was switched off; off, nothing is run there.
                                This is the linked updater's switch, not the machine's own pack
                                auto setting (am update --auto off, which holds the pack alone)
  meter uninstall               remove it from the linked machines the pack put it on (the
                                install record says which), only where it is still that version
  dsh-tui install | update      DSH as a Herdr agent: the pinned dsh-TUI ${DSH_TUI.version} in its
                                own \`dsh-tui\` DSH profile, the dsh-tui shim on PATH (Herdr's
                                built-in DSH entry finds it), and dsh-TUI's first-run guide
                                marked done. No dsh on PATH: one honest line, skipped.
  dsh-tui uninstall             dsh-TUI out of the dsh-tui profile and the shim away (sessions,
                                dsh-TUI's state and the profile stay)
  dsh-tui doctor                whether dsh, the dsh-tui profile and the shim are there, and
                                whether the profile is the pinned one, plus each bot's hcProxy
                                working and approved settings and whether its attached proxy
                                answers, and each Antigravity bot's effective permission lists
                                and whether agy's terminal sandbox is there (read-only); off
                                with proxy up warns: rollback unfinished
  proxy approve --project <dir> approve a project's working .herdr/bots.json as the proxy's
                                roster and hcProxy switch: print the diff against the previous
                                approval, then
                                write the record 0600 outside the project. The proxy reads
                                only this record: a working-tree edit warns until approved,
                                and a missing record refuses a proxied pane. Approving is the
                                person's act; the printed diff is the check.
  doc get <name> [--machine M]  a herdr-core doc's value, as one line of JSON on stdout (hc's
                                doc.get through hc connect; read-only, 10 s at most); --machine:
                                that linked machine's doc. Exit 0 with the JSON; 3: no such doc
                                (never written, or deleted); 2: a usage mistake; 1: any other
                                failure (a bad name, hc down, no answer). A message on stderr for
                                every exit but 0: anything but 0 or 3 is a failure. A name is
                                1-128 of A-Z a-z 0-9 . _ -, not . or .. (hc may refuse more).
                                Made for mods: their exec has no stdin to speak hc connect with.
  launch-path <program>         where a launch finds <program> (PATH, ~/.local/bin, this CLI's
                                node folder) and the PATH its pane gets, as one line of JSON:
                                {"program": null, "path": null} when none has it. For the
                                Accounts panel, which runs claude auth status as a launch would.

Antigravity (\`agy\`, 1.5.3): --model takes the ids \`agy models\` lists (a Gemini or Claude
id, e.g. gemini-4-argon-high), never the label its settings.json keeps. The pack caches that
list under <app home>/automagik-herdr/antigravity-models.json, refreshed at most once a run
when it is missing or a day old; agy not installed, signed in or listing nothing keeps the
last cached list and the refusal says when there is none. Every Antigravity launch passes
\`--mode\` (auto, accept-edits or plan): a bot's \`agyMode\` field, else auto; its workers'
\`worker.agyMode\`, else auto. Each launch also writes its own session permission list, 0600
under <app home>/automagik-herdr/agy-settings/, and passes it as \`--settings\`: a narrow allow
list for its scope and the fixed denies --force pushes, hard resets, rm -rf, PR merges,
releases, flag-first gh api writes, roster edits and restarts (am and automagik-herdr), hc
keys/interrupt/exec -- plus the
bot's \`agyPermissions\` additions, never a fixed deny dropped. Where agy can't run --mode auto
it continues in manual mode, so every launch also passes --dangerously-skip-permissions, only
ever beside that file: no prompt, and the deny list still refuses what it names (#955).
Under that flag the allow list does nothing and no classifier runs: whatever the deny list
doesn't name runs unasked (inline code, scripts, sh, curl, ssh, a plain push, a child agent).
The lists are a guardrail against accidents; the boundary is the hc-proxy sandbox. A lead
ends its own worker with \`worker kill <pane>\`: \`hc kill\` is denied to every worker and to
every seat but a main bot's. The file
also lists the launch's own folder in \`trustedWorkspaces\` -- the project folder for a seat, the
worker's worktree for a worker, the helper's folder for a helper, never a parent or the home
folder -- so agy's first-run trust question is already answered on every role, a review worker
(\`--role review\`) and a reviewer seat included. A launch at the home folder leaves
\`trustedWorkspaces\` out instead of writing an empty list, so the person's saved trust list is
never overwritten with []. The pack never passes
--dangerously-skip-permissions and never writes agy's own saved settings, so the rest of its
trust list and saved settings stay the person's. Its first prompt goes through -i, its resume
through --conversation <id> (--fresh starts new).

--rank R sets the pane's role= label, one of: ${RANKS.join(", ")}.
The main bot's pane is role=main, and a bot that leads others is role=captain, whatever their
rank. Start, attach, detach and an edit keep the panes' bot, role, category and squad labels
in step on this computer.

Which pane plays which bot is the attach ledger's answer (<app home>/automagik-herdr/attach.jsonl,
written by start, attach and detach only); the bot label is a display hint, and relabelling a
pane with hc label changes nothing. With HERDR_APP_HOME unset, restart reads the home the
bot's pane was launched with and the project's own app home (<project>/.herdr/app-home) too,
and refuses before starting anything when two app homes both name the bot.

A bot is its id or its name in the project. The project is the one the current folder
keys to (its git main checkout), or --project's. With --machine, --project is an absolute
folder on that machine and the file is read and written there by the same rule (a file
changed since it was read is never overwritten); its panes run there (M/tN). A pane that
reports no status to hc can't say it is waiting for an approval: restart refuses it unless
--force, which still sends it no keys. restart --tree works on this computer and, with
--machine, on that machine (there it needs --force, since it runs at once); a bot whose helpers
end with its pane there is refused until each helper's pane is ended (hc kill M/tN).

When HC_TERMINAL_ID identifies a requesting terminal, new linked starts and all linked
restarts refuse: am cannot verify their return route, including --force/--fresh/swaps/--save
and --tree. A verified already-running start can still return without launching. With no
caller identity, ordinary non-orchestrated linked launches remain available.
For orchestration, launch from the origin HC terminal with hc run --bg --on M, retaining
its real default or explicit HC parent and supplying first-task/report instructions. Use
the returned M/tN address at the origin. Do not guess reverse aliases or target-local
addresses for the origin. Remote exec of local am loses origin provenance; this patch
cannot detect or repair that case and does not promise report delivery for it.

For a code agent: the am skill teaches these commands,
https://github.com/automagik-si/automagik/blob/dev/skills/am/SKILL.md
Install it: npx skills add automagik-si/automagik --skill am
Report what am cannot do: https://github.com/automagik-si/automagik/issues`;

/** `proxy approve`'s own help: the residual is part of the command's contract. */
export const PROXY_USAGE = `usage: am proxy approve --project <dir>

Approve a project's worked roster: reads <dir>'s .herdr/bots.json, prints the diff against the
previous approval (bots added/removed, rank/lead/kind changes), then writes the record
0600 outside the project. The proxy reads only this record; a working-tree roster that
differs warns once naming this command and still starts on the approved one. A missing
record refuses a proxied pane.

Residual: a sandboxed bot can ask an in-team unsandboxed pane to run this command. The
printed diff is the check, and approving is the person's act.
`;

function readInstructions(opts) {
  if (opts.instructions !== undefined && opts["instructions-file"] !== undefined) throw new CliError("Give --instructions or --instructions-file, not both.", 2);
  let text = opts.instructions;
  if (opts["instructions-file"] !== undefined) {
    const f = opts["instructions-file"];
    try { text = readFileSync(f === "-" ? 0 : f, "utf8"); } catch (e) { throw new CliError(`Can't read ${f}: ${e?.message ?? e}`); }
    text = text.replace(/\n$/, "");
  }
  if (text !== undefined && text.length > MAX_INSTRUCTIONS) {
    throw new CliError(`Instructions are ${text.length} characters; the limit is ${MAX_INSTRUCTIONS}. Nothing was saved.`);
  }
  return text;
}

/**
 * The models `agent` may be pinned to (models.js knownModels), cache-first for Antigravity
 * (#793): a pin the cache already lists is used as it is, even when the cache is old, with no
 * `agy models`; a missing cache or an unlisted pin refreshes once in this run (modelCache.js)
 * and reads again. A refresh that fails (agy isn't installed, isn't signed in) keeps the last
 * cached list; with none, the pin is refused and the message says why.
 */
function modelList(agent, pin = null) {
  let list = knownModels(agent, modelIo());
  if (agent !== "antigravity" || !pin || list.includes(pin)) return list;
  if (agModelsLooked) return list;
  agModelsLooked = true;
  try {
    refreshAgModelsSync({
      appHome: appHome(),
      read: (path) => readText(path),
      write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
      rename: (from, to) => renameSync(from, to),
      remove: fsIo.remove,
      exec: (command, args, options) => {
        const file = programPath(command);
        if (!file) throw new Error(`${command} isn't installed`);
        return agModelsSpawnResult(spawnSync(file, args, { encoding: "utf8", timeout: options?.timeout ?? AG_MODELS_TIMEOUT_MS }));
      },
      now: Date.now(),
    });
  } catch { /* no cache and no list: knownModels reads what is there */ }
  return knownModels(agent, modelIo());
}

// Whether this CLI run has already looked at `agy models`: one refresh a run at most.
let agModelsLooked = false;

function checkModel(agent, model, listOf = null) {
  if (!agent) throw new CliError("A model pin needs a coding agent (--agent).", 2);
  if (modelRefusal(agent)) throw new CliError(modelRefusal(agent), 2);
  const list = listOf ? listOf(agent, model) : modelList(agent, model);
  // A linked machine's own list could not be read: its launch is left to judge the pin (#1173).
  if (list === null) return;
  if (!list.includes(model)) {
    throw new CliError(list.length ? `${model} isn't a known ${agent} model. Pick one of: ${list.join(", ")}.`
      : `There is no list of ${agent} models to pin from${agent === "antigravity" ? " (agy models has listed none: agy may not be installed, signed in, or cached yet)" : ""}; leave the model unpinned (the running one is detected).`);
  }
}

/** That machine's home folder (`$HOME`), or null when it gives none (#1173). */
async function homeOn(machine) {
  const r = await remoteIo.exec("sh", ["-c", 'printf %s "$HOME"'], machine, { timeout: AGENT_WAIT_S });
  const home = r.code === 0 ? r.stdout : "";
  // eslint-disable-next-line no-control-regex
  return home.startsWith("/") && !/[\x00-\x1f\x7f]/.test(home) ? home.replace(/\/+$/, "") : null;
}

/**
 * The models `agent` may be pinned to on `machine`, from that machine's own knowledge (#1173):
 * Codex's `~/.codex/models_cache.json` there, Antigravity's pack cache under its app home there,
 * Claude's `~/.claude/settings.json` default there (its static list is the same everywhere, but
 * its settings default is each computer's own). Resolves an array, or null when that machine has
 * no list to read (an older cache, no app home, no settings, a machine that can't answer): the
 * launch there then judges the pin, never this computer's stale cache.
 */
async function modelsOnMachine(machine, key, agent) {
  if (agent !== "claude" && agent !== "codex" && agent !== "antigravity") return null;
  try {
    let text = null;
    if (agent === "antigravity") {
      const paneEnv = await paneEnvOn(machine, key);
      const app = paneEnv.appHome ?? await appHomeOn(machine);
      if (app) text = await readRemoteText(remoteIo, machine, agModelsPath(app));
    } else {
      const home = await homeOn(machine);
      if (!home) return null;
      text = await readRemoteText(remoteIo, machine, agent === "claude"
        ? `${home}/.claude/settings.json` : `${home}/.codex/models_cache.json`);
    }
    // No file there is no list to judge a pin by: never fall back to this computer's knowledge.
    if (text === null) return null;
    const texts = agent === "antigravity" ? { antigravityModels: text }
      : agent === "claude" ? { claudeSettings: text } : { codexModels: text };
    const list = knownModelsFrom(agent, texts);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/**
 * The execution mode a launch of `bot` on `agentKey` passes: auto unless the roster's
 * agyMode names another one; null for every other agent, whose launch line stays unchanged. An
 * unknown roster mode is refused here, one line, before anything starts.
 */
/** agySandbox for this computer, from its own files (read-only): whether agy's --mode auto can run here. */
function hostAgySandbox() {
  return agySandbox({ platform: process.platform,
    read: (path) => { try { return readFileSync(path, "utf8"); } catch (e) { return e?.code === "ENOENT" ? null : undefined; } } });
}

/**
 * A bot's automatic mode as status prints it (#955): { args (the words its launch adds, [] for
 * none), note (what they do, or why there are none), sandbox (Antigravity on this computer only:
 * agySandbox's { state, detail }, so a host whose sandbox can't run says so) }.
 */
function autoModeOf(bot, local = true) {
  const key = resolveAgent(bot.agent ?? "", agentTable());
  if (!key) return null;
  const args = autoModeArgs(key, bot, agentTable()[key]?.run ?? []);
  // #1413: a Claude bot's own permission mode says what its launch does instead of auto's note.
  const chosen = key === "claude" && permissionModesOf(key)?.includes(bot.permissionMode) ? bot.permissionMode : null;
  // Codex's launch mode has no opt-out (#1125): a source's own approval words are left out.
  const note = chosen ? PERMISSION_MODE_WHAT[chosen]
    : args.length ? AUTO_MODE[key].what
      : AUTO_MODE[key] ? "its own run words already pick its approvals" : (AUTO_MODE_NONE[key] ?? "none this pack knows");
  return { args, note, ...(key === "antigravity" && local ? { sandbox: hostAgySandbox() } : {}) };
}

function launchAgyMode(bot, agentKey) {
  if (agentKey !== "antigravity") return null;
  const why = agyModeProblem(bot.agyMode);
  if (why) throw new CliError(`${bot.name}: ${why} Fix it with am edit ${bot.id} --agy-mode <accept-edits|auto|plan>.`);
  return agyModeOf(bot.agyMode);
}

/**
 * The entry create or edit writes: `base` (the stored raw entry, or a new one) with the
 * options given applied and checked against the project. Throws a CliError on a refusal.
 */
export function entryFrom(opts, base, project, { creating, listOf = null }) {
  const { file } = project;
  const entry = JSON.parse(JSON.stringify(base));
  if (opts.name !== undefined) {
    if (!opts.name.trim()) throw new CliError("A bot needs a name.", 2);
    entry.name = opts.name.trim();
  }
  if (!entry.name) throw new CliError("A bot needs a name (--name).", 2);
  const twin = file.bots.find((b) => b.id !== entry.id && b.name.toLowerCase() === entry.name.toLowerCase());
  if (twin) throw new CliError(`${twin.id} is already named "${twin.name}" in this project; names pick bots, so pick another.`);
  if (opts.kind !== undefined) {
    if (!KINDS.includes(opts.kind)) throw new CliError(`--kind is main or member, not "${opts.kind}".`, 2);
    entry.kind = opts.kind;
  }
  const main = mainBotOf(file);
  if (creating && !main && entry.kind !== "main") throw new CliError("The first bot in a project must be its main bot (--kind main).");
  if (entry.kind === "main" && main && main.id !== entry.id) throw new CliError(`This project already has a main bot, ${main.name} (${main.id}).`);
  if (opts.role !== undefined) entry.role = opts.role;
  if (opts.code !== undefined) {
    if (!["true", "false"].includes(opts.code)) throw new CliError("--code is true or false; nothing was saved.", 2);
    entry.code = opts.code === "true";
  }
  entry.role ??= "";
  // Rank (A16): one of RANKS, for the pane's role= label; --rank= clears it (kept empty so
  // applyBotEdit removes the stored one).
  if (opts.rank !== undefined) {
    if (opts.rank !== "" && !RANKS.includes(opts.rank)) throw new CliError(`--rank is one of ${RANKS.join(", ")} (or --rank= to clear), not "${opts.rank}".`, 2);
    entry.rank = opts.rank;
  }
  // #1556: the context threshold this seat restarts at, in tokens. --no-restart-at clears a
  // stored one (a member then has none; a main bot falls back to its default).
  if (opts["restart-at"] !== undefined && opts["no-restart-at"]) {
    throw new CliError("Give --restart-at or --no-restart-at, not both.", 2);
  }
  if (opts["no-restart-at"]) entry.restartAt = "";
  if (opts["restart-at"] !== undefined) {
    const tokens = opts["restart-at"];
    if (!/^[1-9][0-9]*$/.test(tokens) || !Number.isSafeInteger(Number(tokens))) {
      throw new CliError("--restart-at is a positive whole number of tokens (or --no-restart-at to clear).", 2);
    }
    entry.restartAt = Number(tokens);
  }
  if (opts.wake !== undefined) {
    if (opts["no-wake"]) throw new CliError("Choose one of --wake and --no-wake.", 2);
    const problem = wakeProblem(opts.wake);
    if (problem) throw new CliError(`--${problem}`, 2);
    entry.wake = opts.wake;
  } else if (opts["no-wake"]) entry.wake = "";
  // An unrelated edit leaves a hand-written empty wake in the raw roster.
  else if (entry.wake === null || entry.wake === "") delete entry.wake;
  if (opts["hc-proxy"] !== undefined) {
    if (!["on", "off"].includes(opts["hc-proxy"])) {
      throw new CliError("--hc-proxy is on or off; nothing was saved.", 2);
    }
    entry.hcProxy = opts["hc-proxy"] === "on";
  }
  const instructions = readInstructions(opts);
  if (instructions !== undefined) entry.instructions = instructions;
  entry.instructions ??= "";
  if (opts.agent !== undefined) {
    const agents = agentTable();
    const key = resolveAgent(opts.agent, agents);
    if (!key) throw new CliError(`"${opts.agent}" isn't a coding agent Herdr knows. Known: ${Object.keys(agents).join(", ")}.`);
    entry.agent = key;
  }
  // Claude Code's person-at-the-keyboard features (#1558): off by default for a bot seat, and
  // this keeps them for a seat a person talks to all day. Other agents ignore the field.
  if (opts["person-features"] !== undefined) {
    if (!["on", "off"].includes(opts["person-features"])) {
      throw new CliError("--person-features is on or off; nothing was saved.", 2);
    }
    entry.personFeatures = opts["person-features"] === "on";
    if (entry.personFeatures && entry.agent !== "claude") {
      report([`--person-features only applies to Claude Code; ${entry.name} runs ${entry.agent ?? "another agent"} and ignores it.`]);
    }
  }
  const pairFields = ["home", "profile"];
  const pairing = pairFields.some((field) => opts[`hermes-${field}`] !== undefined);
  if (pairing && opts["no-hermes"]) throw new CliError("Give the Hermes pairing or --no-hermes, not both.", 2);
  if (opts["no-hermes"]) entry.hermes = undefined;
  if (pairing) {
    entry.hermes = { ...entry.hermes };
    for (const field of pairFields) if (opts[`hermes-${field}`] !== undefined) entry.hermes[field] = opts[`hermes-${field}`];
  }
  // Planned (A3): a wave and an optional note; --unplanned clears it.
  if (opts.unplanned && opts["planned-wave"] !== undefined) throw new CliError("Give --planned-wave or --unplanned, not both.", 2);
  if (opts.unplanned) delete entry.planned;
  if (opts["planned-wave"] !== undefined) {
    const wave = Number(opts["planned-wave"]);
    if (!Number.isInteger(wave) || wave < 1) throw new CliError("--planned-wave is a positive whole number.", 2);
    entry.planned = plannedOf(entry.planned, wave, opts["planned-note"] ?? entry.planned?.note);
  } else if (opts["planned-note"] !== undefined) {
    if (!entry.planned) throw new CliError("--planned-note goes with --planned-wave.", 2);
    entry.planned = plannedOf(entry.planned, entry.planned.wave, opts["planned-note"]);
  }
  if (!entry.agent && !entry.planned) throw new CliError("A bot needs a coding agent (--agent), unless it is planned.", 2);
  // Model pin (A12): from the agent's list, never free text.
  if (opts.model !== undefined && opts["no-model"]) throw new CliError("Give --model or --no-model, not both.", 2);
  if (opts["no-model"]) delete entry.model;
  if (opts.model !== undefined) { checkModel(entry.agent, opts.model, listOf); entry.model = opts.model; }
  else if (entry.model && opts.agent !== undefined) {
    const list = listOf ? listOf(entry.agent, entry.model) : modelList(entry.agent, entry.model);
    // null: that machine's own list could not be read; the launch there judges the pin (#1173).
    if (list !== null && !list.includes(entry.model)) {
      throw new CliError(`${entry.name} is pinned to ${entry.model}, which ${entry.agent} doesn't list; pass --model or --no-model.`);
    }
  }
  // #1411: a bot's own reasoning effort and service tier (Codex's), passed on every launch as
  // its own overrides. Empty clears. A service tier belongs to the model choice: a --model
  // change that names no --tier runs the new model on Codex's default tier, stored as standard
  // and so said explicitly on the launch line, where a profile's, a template's or the host
  // config's Fast no longer applies to it.
  const modelChanged = (opts.model !== undefined || opts["no-model"]) && (opts.model || undefined) !== base.model;
  const givenEffort = opts.effort !== undefined && opts.effort !== "";
  const givenTier = opts.tier !== undefined && opts.tier !== "";
  if (givenEffort) {
    const why = codexEffortProblem(opts.effort);
    if (why) throw new CliError(`--effort: ${why}.`, 2);
    entry.effort = opts.effort;
  }
  if (givenTier) {
    const why = tierProblem(opts.tier);
    if (why) throw new CliError(`--tier: ${why} (or --tier= to clear).`, 2);
    entry.tier = opts.tier;
  }
  if (opts.effort === "") entry.effort = "";
  if (opts.tier === "") entry.tier = "";
  const storedEffort = entry.effort !== undefined && entry.effort !== "";
  const storedTier = entry.tier !== undefined && entry.tier !== "";
  const codexBot = entry.agent ? resolveAgent(entry.agent, agentTable()) === "codex" : false;
  if ((storedEffort || storedTier) && !codexBot) {
    if (givenEffort || givenTier) {
      throw new CliError(`--effort and --tier are a Codex bot's; ${entry.name} runs ${entry.agent || "no agent"}.`, 2);
    }
    entry.effort = "";
    entry.tier = "";
    report([`${entry.name}: its reasoning effort and service tier were cleared, since they are a Codex bot's and it runs ${entry.agent || "no agent"}.`]);
  } else if (opts.tier === undefined && modelChanged && !creating && codexBot) {
    // An edit that swaps the model names no tier: the new model runs on Codex's default one,
    // stored as standard rather than left out, so the launch passes -c service_tier=default
    // after the template's and the profile's own words and neither can keep Fast on it.
    entry.tier = "standard";
    if (storedTier) report([`${entry.name}: its service tier doesn't carry over to a new model; it runs standard unless --tier fast is passed with --model.`]);
  }
  // #1413: a bot's own Claude Code permission mode (--permission-mode), passed on every launch
  // path and independent of the model, effort and tier. Empty clears it. A value Claude Code
  // doesn't accept, or one on another agent, is refused with the reason and nothing is saved;
  // an agent change that leaves a stale stored one clears it and says so.
  const claudeBot = entry.agent ? resolveAgent(entry.agent, agentTable()) === "claude" : false;
  if (opts["permission-mode"] !== undefined && opts["permission-mode"] !== "") {
    const why = permissionModeProblem(entry.agent ? resolveAgent(entry.agent, agentTable()) : null, opts["permission-mode"]);
    if (why) throw new CliError(`--permission-mode: ${why} (or --permission-mode= to clear).`, 2);
    entry.permissionMode = opts["permission-mode"];
  } else if (opts["permission-mode"] === "") {
    entry.permissionMode = "";
  }
  const storedPermission = entry.permissionMode !== undefined && entry.permissionMode !== "";
  if (storedPermission && !claudeBot) {
    entry.permissionMode = "";
    report([`${entry.name}: its permission mode was cleared, since it is Claude Code's and it runs ${entry.agent || "no agent"}.`]);
  }
  // Antigravity's execution mode: applied at launch (auto unless another is stored), so the
  // default is written as no field at all and auto clears a stored one.
  if (opts["agy-mode"] !== undefined) {
    const why = agyModeProblem(opts["agy-mode"]);
    if (why) throw new CliError(`--agy-mode: ${why}`, 2);
    const mode = agyModeOf(opts["agy-mode"]);
    if (entry.agent !== "antigravity") report(["--agy-mode only applies to Antigravity; this bot's agent will ignore it."]);
    if (mode === AGY_MODE_DEFAULT) delete entry.agyMode; else entry.agyMode = mode;
  }
  // Antigravity's permission additions (#823): repeatable rules that add to the fixed deny rules
  // and the launch's own allow list; one empty value clears that list, and --no-agy-permissions
  // clears both. They only ever add: the fixed denies are added at launch.
  if (opts["no-agy-permissions"] && (opts["agy-allow"] !== undefined || opts["agy-deny"] !== undefined)) {
    throw new CliError("Give --no-agy-permissions or --agy-allow/--agy-deny, not both.", 2);
  }
  if (opts["no-agy-permissions"]) delete entry.agyPermissions;
  if (opts["agy-allow"] !== undefined || opts["agy-deny"] !== undefined) {
    const stored = entry.agyPermissions && typeof entry.agyPermissions === "object" && !Array.isArray(entry.agyPermissions)
      ? entry.agyPermissions : {};
    const pick = (given, kept, flag) => {
      if (given === undefined) return Array.isArray(kept) ? kept.filter((r) => typeof r === "string") : [];
      const rules = given.filter((r) => r.trim() !== "");
      for (const rule of rules) {
        const why = agyRuleProblem(rule);
        if (why) throw new CliError(`${flag}: ${why}`, 2);
      }
      return [...new Set(rules.map((r) => r.trim()))];
    };
    const allow = pick(opts["agy-allow"], stored.allow, "--agy-allow");
    const deny = pick(opts["agy-deny"], stored.deny, "--agy-deny");
    if (allow.length || deny.length) entry.agyPermissions = { allow, deny };
    else delete entry.agyPermissions;
  }
  workerDefaults(opts, entry);
  // Lead (A1): the main bot or another non-planned member in this project, or a non-planned bot
  // in another project (--lead-project), never itself or one of its own.
  if (opts["no-lead-project"] && opts["lead-project"] !== undefined && opts["lead-project"] !== "") {
    throw new CliError("Give --lead-project or --no-lead-project, not both.", 2);
  }
  const clearingLeadProject = Boolean(opts["no-lead-project"] || opts["lead-project"] === "");
  if (clearingLeadProject) {
    delete entry.leadProject;
    if (opts.lead === undefined) delete entry.lead;
  }
  const rawLeadProject = !clearingLeadProject && opts["lead-project"] !== undefined
    ? opts["lead-project"].trim()
    : null;
  if (rawLeadProject !== null) {
    if (!rawLeadProject) {
      delete entry.leadProject;
      if (opts.lead === undefined) delete entry.lead;
    } else {
      const targetDir = project.machine ? cleanProjectPath(rawLeadProject) : cleanProjectPath(resolvePath(rawLeadProject));
      if (!targetDir.startsWith("/")) throw new CliError("--lead-project must be a folder path.", 2);
      if (!project.machine) {
        let isDir = false;
        try { isDir = statSync(targetDir).isDirectory(); } catch { /* not there */ }
        if (!isDir) throw new CliError(`--lead-project: ${targetDir} is not a folder.`, 2);
      }
      if (targetDir === cleanProjectPath(project.key)) {
        delete entry.leadProject;
        if (opts.lead === undefined && !entry.lead) {
          throw new CliError("--lead-project needs --lead (the lead bot's id or name).", 2);
        }
      } else {
        const leadRef = opts.lead !== undefined ? opts.lead : entry.lead;
        if (!leadRef) throw new CliError("--lead-project needs --lead (the lead bot's id or name in that project).", 2);
        if (project.machine) {
          entry.lead = leadRef;
          entry.leadProject = targetDir;
        } else {
          const targetProject = loadProject(targetDir);
          if (targetProject.text === null) throw new CliError(`No ${BOTS_PATH} in ${targetDir}.`);
          let lead;
          try {
            lead = findBot(targetProject.file, leadRef);
          } catch (e) {
            throw new CliError(String(e?.message ?? e).replace("in this project.", `in ${targetDir}.`), e?.code ?? 1);
          }
          if (lead.planned) throw new CliError(`${lead.name} is planned in ${targetDir}, so it can't lead a bot yet.`);
          const projects = localProjectsFor(project, appHome(), [targetDir]) ?? new Map();
          projects.set(targetDir, targetProject.file);
          if (project.key) projects.set(cleanProjectPath(project.key), file);
          if (!creating && leadsBackTo(targetDir, targetProject.file, lead, cleanProjectPath(project.key), entry.id, projects)) {
            throw new CliError(`${lead.name} in ${targetDir} reports to ${entry.name}, so it can't be its lead.`);
          }
          entry.lead = lead.id;
          entry.leadProject = targetDir;
        }
      }
    }
  }
  if ((rawLeadProject === null || !entry.leadProject) && opts.lead !== undefined) {
    delete entry.leadProject;
    if (opts.lead === "") {
      delete entry.lead;
    } else {
      if (entry.kind === "main") throw new CliError("A main bot has no lead.", 2);
      const lead = findBot(file, opts.lead);
      if (lead.id === entry.id) throw new CliError(`${entry.name} can't lead itself.`);
      if (lead.planned) throw new CliError(`${lead.name} is planned, so it can't lead a bot yet.`);
      if (!creating && descendantsOf(file, entry.id).has(lead.id)) throw new CliError(`${lead.name} reports to ${entry.name}, so it can't be its lead.`);
      entry.lead = lead.id;
    }
  }
  if (entry.kind === "main" && !entry.leadProject) delete entry.lead;
  if (!entry.lead) delete entry.leadProject;
  // Reciprocal cross-project members (--cross-member <bot>@<dir>, --no-cross-members).
  if (opts["no-cross-members"] && opts["cross-member"] !== undefined && opts["cross-member"].some((v) => v.trim() !== "")) {
    throw new CliError("Give --cross-member or --no-cross-members, not both.", 2);
  }
  if (opts["no-cross-members"]) {
    delete entry.crossMembers;
    delete entry.members;
  } else if (opts["cross-member"] !== undefined) {
    const specs = opts["cross-member"].map((s) => s.trim()).filter(Boolean);
    if (!specs.length) {
      delete entry.crossMembers;
      delete entry.members;
    } else {
      const nextCross = [];
      const seenCross = new Set();
      for (const spec of specs) {
        const sepIdx = spec.includes("@") ? spec.indexOf("@") : spec.indexOf(":");
        if (sepIdx <= 0 || sepIdx === spec.length - 1) {
          throw new CliError("--cross-member takes <bot>@<dir> (or --cross-member= to clear).", 2);
        }
        const botRef = spec.slice(0, sepIdx).trim();
        const dirRef = spec.slice(sepIdx + 1).trim();
        const targetDir = project.machine ? cleanProjectPath(dirRef) : cleanProjectPath(resolvePath(dirRef));
        if (!targetDir.startsWith("/")) throw new CliError("--cross-member: project must be a folder path.", 2);
        if (targetDir === cleanProjectPath(project.key)) {
          throw new CliError(`--cross-member: ${targetDir} is this project; set --lead on the member instead.`, 2);
        }
        if (project.machine) {
          const key = `${targetDir}\0${botRef}`;
          if (!seenCross.has(key)) {
            seenCross.add(key);
            nextCross.push({ id: botRef, project: targetDir });
          }
        } else {
          let isDir = false;
          try { isDir = statSync(targetDir).isDirectory(); } catch { /* not there */ }
          if (!isDir) throw new CliError(`--cross-member: ${targetDir} is not a folder.`, 2);
          const targetProject = loadProject(targetDir);
          if (targetProject.text === null) throw new CliError(`No ${BOTS_PATH} in ${targetDir}.`);
          let memberBot;
          try {
            memberBot = findBot(targetProject.file, botRef);
          } catch (e) {
            throw new CliError(String(e?.message ?? e).replace("in this project.", `in ${targetDir}.`), e?.code ?? 1);
          }
          if (memberBot.planned) throw new CliError(`${memberBot.name} is planned in ${targetDir}, so it can't be a cross-project member yet.`);
          const key = `${targetDir}\0${memberBot.id}`;
          if (!seenCross.has(key)) {
            seenCross.add(key);
            nextCross.push({ id: memberBot.id, project: targetDir });
          }
        }
      }
      entry.crossMembers = nextCross;
      delete entry.members;
    }
  }
  // Category (A2): only for a bot whose lead is the main bot.
  if (opts.category !== undefined && opts["no-category"]) throw new CliError("Give --category or --no-category, not both.", 2);
  if (opts["no-category"]) delete entry.category;
  if (opts.category !== undefined) {
    const leadsToMain = entry.kind === "member" && !entry.leadProject && (!entry.lead || entry.lead === main?.id);
    if (!leadsToMain) throw new CliError("A category goes only on a member that reports to the main bot.", 2);
    entry.category = findCategory(file, opts.category).id;
  }
  // Look: --omni, or a character and colour (one left out keeps the stored or default one).
  const colour = opts.colour ?? opts.color;
  if (opts.omni && (opts.character !== undefined || colour !== undefined)) throw new CliError("Give --omni or --character/--colour, not both.", 2);
  if (opts.character !== undefined && !CHARACTERS.includes(opts.character)) throw new CliError(`Unknown character "${opts.character}". Characters: ${CHARACTERS.join(", ")}.`, 2);
  if (colour !== undefined && !COLOURS.includes(colour)) throw new CliError(`Unknown colour "${colour}". Colours: ${COLOURS.join(", ")}.`, 2);
  const look = entry.look && typeof entry.look === "object" ? entry.look : defaultLook(entry.id);
  if (opts.omni) entry.look = { ...OMNI_LOOK };
  else entry.look = { character: opts.character ?? look.character, colour: colour ?? look.colour };
  return entry;
}

/**
 * The bot's worker defaults (`worker: { agent?, model?, effort?, template?, agyMode? }`) from
 * --worker-agent, --worker-model, --worker-effort, --worker-template and --worker-agy-mode; an
 * empty value clears that one. A template is an hc template name; it isn't looked up here (edit runs anywhere). The agent is canonical
 * (`claude-code` is stored as `claude`); a model must be on the worker agent's list when it
 * has one (an agent with no list takes any model: workers' models are swap-test data). An
 * Antigravity mode is one of AGY_MODES; auto, the default, clears a stored one.
 */
function workerDefaults(opts, entry) {
  const given = ["agent", "model", "effort", "template", "agy-mode"].filter((k) => opts[`worker-${k}`] !== undefined);
  if (!given.length) return;
  const w = entry.worker && typeof entry.worker === "object" && !Array.isArray(entry.worker) ? { ...entry.worker } : {};
  const agentText = opts["worker-agent"];
  if (agentText === "") delete w.agent;
  else if (agentText !== undefined) {
    const agents = agentTable();
    const key = resolveAgent(agentText, agents);
    if (!key) throw new CliError(`--worker-agent: "${agentText}" isn't a coding agent Herdr knows. Known: ${Object.keys(agents).join(", ")}.`, 2);
    w.agent = key;
  }
  const agyMode = opts["worker-agy-mode"];
  if (agyMode === "") delete w.agyMode;
  else if (agyMode !== undefined) {
    const why = agyModeProblem(agyMode);
    if (why) throw new CliError(`--worker-agy-mode: ${why}`, 2);
    const mode = agyModeOf(agyMode);
    if (mode === AGY_MODE_DEFAULT) delete w.agyMode; else w.agyMode = mode;
  }
  const effort = opts["worker-effort"];
  if (effort === "") delete w.effort;
  else if (effort !== undefined) {
    if (!EFFORT_SHAPE.test(effort)) throw new CliError(`--worker-effort: "${effort}" isn't an effort level (low, medium, high, …).`, 2);
    w.effort = effort;
  }
  const template = opts["worker-template"];
  if (template === "") delete w.template;
  else if (template !== undefined) {
    if (!TEMPLATE_SHAPE.test(template)) throw new CliError(`--worker-template: "${template}" isn't an hc template name (letters, digits, ".", "_" and "-", no dash first).`, 2);
    w.template = template;
  }
  const model = opts["worker-model"];
  if (model === "") delete w.model;
  else if (model !== undefined) {
    if (optionLike(model)) throw new CliError(`--worker-model: "${model}" starts with a dash, so an agent would read it as an option.`, 2);
    const agent = w.agent ?? entry.agent;
    const list = agent ? modelList(agent, model) : [];
    if (list.length && !list.includes(model)) throw new CliError(`--worker-model: ${model} isn't a known ${agent} model. Pick one of: ${list.join(", ")}.`);
    w.model = model;
  }
  // dsh-tui workers take neither (#598): refused here, as workerPlan refuses them at a worker's start.
  const refusal = modelRefusal(w.agent ?? entry.agent);
  if (refusal && (w.model || w.effort)) throw new CliError(`--worker-model / --worker-effort: ${refusal}`, 2);
  entry.worker = w; // empty: applyBotEdit removes it
}

// ---- commands ----

async function projectFor(opts) {
  if (opts.machine !== undefined) return loadRemoteProject(await remoteKeyOf(opts), opts.machine);
  return loadProject(await commandKeyOf(opts));
}

// #1413 F3: a warning the loader raised about a bot's record (a hand-edited permission mode it
// dropped, say) is said on every command that reads the record, not only `am ls` and `am worker`.
// Warn, never refuse: the rest of the record is valid and the launch runs the field's default, so
// refusing would keep an operator from starting the bot they must fix. The sentence is the
// loader's own, once per command; `botId` narrows it to the bot a command is about.
const saidWarnings = new Set();
function warnProject(project, botId = null) {
  for (const w of project?.warnings ?? []) {
    if (botId && !w.startsWith(`${botId}: `)) continue;
    if (saidWarnings.has(w)) continue;
    saidWarnings.add(w);
    report([w]);
  }
}
/**
 * Where this command's edit is written (RFC 0014 Q16, #234): the git top level of the folder
 * it was run in or named with --project (a worktree's own folder), else the project key (a
 * main checkout's top level is its key; outside git the key, as before). A linked machine's:
 * its key, as before.
 */
async function writeDirOf(opts, key) {
  if (opts.machine !== undefined) return key;
  return (await writeFolderOf(resolvePath(opts.project ?? process.cwd()), git)) ?? key;
}
/** projectFor for a command that edits the file: read from, and written to, writeDirOf's folder. */
async function editProjectFor(opts) {
  if (opts.machine !== undefined) return projectFor(opts);
  const key = await commandKeyOf(opts);
  return loadProject(key, await writeDirOf(opts, key));
}
// The commands that take --machine (the definitions ones, and meter's own --machine).
const ON_MACHINE = new Set(["ls", "show", "create", "edit", "main", "rm", "category", "start", "restart", "attach", "detach", "whois", "history", "meter", "doc", "machines", "rate-limit"]);
// A project's place in --json answers: `machine` only for a linked machine's.
const placeOf = (project) => ({ project: project.key, ...(project.machine ? { machine: project.machine } : {}) });

// The sidebar's own remembered projects on this computer: am.* since the rename, else the old
// key. Read only: the sidebar writes them (and forgets one whose bots file is gone).
function sidebarRemembered() {
  try {
    const held = JSON.parse(readText(`${appHome()}/shared.json`) ?? "{}");
    const list = held?.["am.sidebar.projects"] ?? held?.[renamedFrom(SHARED_RENAMES, "am.sidebar.projects")];
    return Array.isArray(list) ? list.filter((p) => typeof p?.key === "string" && !p.machine).map((p) => p.key) : [];
  } catch { return []; /* unreadable: none */ }
}

// The projects the sidebar shows with no space open: its remembered list, then this CLI's.
function rememberedKeys() {
  const keys = sidebarRemembered();
  let listed = [];
  try { listed = listedProjects(readText(`${appHome()}/${PROJECTS_FILE}`)); } catch { /* unreadable: none */ }
  return [...new Set([...keys, ...listed])];
}

/**
 * `forget <project>`: takes the project's folder off this CLI's project list, under the list's
 * lock. Only that entry: no folder, worktree, bots file or terminal is touched. An unknown name
 * is refused, the file unchanged. `ls --all` and the sidebar also show the sidebar's own
 * remembered projects (shared.json), which only the sidebar writes: when it remembers this one
 * too, forget says so (stderr, and `sidebar_remembers` in --json).
 */
async function cmdForget(opts, [ref]) {
  if (!ref) throw new CliError("forget needs a project: its folder, as ls --all prints it.", 2);
  if (opts.project !== undefined) throw new CliError("forget takes the project as its argument, not --project.", 2);
  const key = resolvePath(ref);
  const path = `${appHome()}/${PROJECTS_FILE}`;
  let taken;
  // No app home (Herdr isn't set up here): there is no list, so nothing is on it.
  try { taken = existsSync(appHome()) ? unlistProjects([key]) : []; } catch (e) {
    throw new CliError(`${key} wasn't taken off ${path}: ${String(e?.message ?? e).split("\n")[0]}`, 1, { project: key, forgotten: false });
  }
  const sidebar = sidebarRemembered().includes(key);
  const sidebarLine = `the sidebar remembers it on its own and forgets it once its ${BOTS_PATH} is gone, so ls --all and the sidebar `
    + "still show it until then.";
  if (taken.includes(key)) {
    if (sidebar) process.stderr.write(`am: ${key} is off this CLI's project list, but ${sidebarLine}\n`);
    return opts.json ? { forgotten: key, list: path, sidebar_remembers: sidebar } : `${key} forgotten: off ${path}.`;
  }
  const why = sidebar
    ? `${key} isn't on this CLI's project list (${path}); ${sidebarLine}`
    : `${key} isn't on the project list (${path}); am ls --all shows the projects there.`;
  throw new CliError(why, 1, { project: key, forgotten: false });
}

// ---- daily wakes (#1002) ----

const WAKE_MARKER = /^Scheduled wake \(daily \d\d:\d\d\): /;
const WAKE_SCHEDULER = [
  'b=$(command -v herdr-automations 2>/dev/null) || b="$HOME/.local/bin/herdr-automations"',
  '[ -x "$b" ] || exit 127',
  'payload=$1; shift',
  'if [ -n "$payload" ]; then printf \'%s\' "$payload" | "$b" "$@"; else "$b" "$@" </dev/null; fi',
].join("\n");
const wakeProblemLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const wakeOwner = (project) => project.machine ?? "this computer";

async function schedulerRun(project, args, stdinText) {
  const argv = ["-c", WAKE_SCHEDULER, "sh", stdinText ?? "", ...args];
  try {
    const r = project.machine
      ? await remoteIo.exec("sh", argv, project.machine, { timeout: 30 })
      : await runProgram("sh", argv, { timeout: 30000 });
    return r.killed ? { ...r, code: -1 } : r;
  } catch (e) {
    return { code: -1, stderr: e.message };
  }
}

const wakeFailure = (state, problem) => ({ state, problem });
const wakeRunFailure = (r) => wakeFailure(
  r.code === 127 ? "missing" : r.code === -1 ? "unreachable" : "unreadable",
  r.code === 127 ? "herdr-automations is missing (checked PATH and ~/.local/bin)"
    : wakeProblemLine(hcSaid(r.stderr) || r.stdout) || "herdr-automations did not answer",
);
const wakeJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
};

async function readWakeScheduler(project) {
  const r = await schedulerRun(project, ["ls", "--json"]);
  if (r.code !== 0) return { failure: wakeRunFailure(r) };
  const listing = wakeJson(r.stdout);
  const namedRows = (rows) => Array.isArray(rows) && rows.every((row) => typeof row?.name === "string");
  if (!listing || !["auto", "hc", "herdr"].includes(listing.backend) || typeof listing.config !== "string"
    || typeof listing.paused !== "boolean" || !Number.isInteger(listing.scheduler) || listing.scheduler < 0
    || (listing.targets !== undefined && (!Array.isArray(listing.targets) || !listing.targets.every((target) => typeof target === "string")))
    || !namedRows(listing.automations) || !namedRows(listing.invalid)
    || listing.automations.some(({ disabled, next, last }) => typeof disabled !== "boolean" || typeof next !== "string"
      || (last !== null && (typeof last?.status !== "string" || typeof last?.at !== "string")))) {
    return { failure: wakeFailure("unreadable", "herdr-automations ls --json returned an unreadable listing") };
  }
  return { listing };
}

function wakeCapability(listing) {
  if (listing.backend === "herdr") {
    return wakeFailure("no-bot-targets", "the herdr backend can't wake bots; set backend: hc in " + listing.config);
  }
  if (!listing.targets?.includes("bot")) {
    return wakeFailure("no-bot-targets", "this herdr-automations build can't wake a bot; "
      + "update to the release after 0.12.1-am.1 with backend hc");
  }
  return null;
}

const wakeRepo = ({ repo }) => typeof repo === "string" && repo.startsWith("/") ? repo.replace(/\/+$/, "") || "/" : null;
function wakeEntry(listing, project, id) {
  const name = wakeAutomationName(id, project.key);
  const target = `${BOT_LABEL}:${id}`;
  const owns = (entry) => entry.target === target && wakeRepo(entry) === project.key
    && typeof entry.prompt === "string" && WAKE_MARKER.test(entry.prompt);
  const named = listing.automations.filter((entry) => entry.name === name);
  const invalid = listing.invalid.find((entry) => entry.name === name);
  const [entry] = named;
  const other = listing.automations.filter((row) => row.name !== name && row.target === target);
  const renamed = other.find(owns);
  const conflict = (why) => wakeFailure("conflict", why + `; resolve it in ${listing.config} (automations.yaml)`);
  const blocked = invalid ? conflict(`${name} is invalid${invalid.line ? ` at line ${invalid.line}` : ""}`)
    : named.length > 1 ? conflict(`${name} is listed more than once`)
    : entry && !owns(entry) ? conflict(`${name} fails the wake ownership check `
      + `(repo ${JSON.stringify(entry.repo ?? null)}, target ${JSON.stringify(entry.target ?? null)})`)
    : null;
  return { name, entry, invalid, blocked, other: other.map((row) => row.name),
    renamed: renamed ? conflict(`${renamed.name} is a wake for this bot under a different name`) : null };
}

function wakePayload(project, id, spec) {
  return {
    name: wakeAutomationName(id, project.key), cron: wakeCron(spec), repo: project.key, target: `${BOT_LABEL}:${id}`,
    target_when_busy: "skip", catch_up_minutes: 1380, timeout_minutes: 10,
    prompt: `Scheduled wake (daily ${spec.slice(6)}): check your recurring duties from your instructions and do what is due.`,
  };
}
const wakeMatches = (entry, payload) => entry && Object.entries(payload)
  .every(([key, value]) => (key === "repo" ? wakeRepo(entry) : entry[key]) === value);

function wakeRunnable(project, bot, listing, entry) {
  if (bot.planned) return wakeFailure("planned", `the bot is planned; unplan it with ${wakeEditCommand(project, bot.id, null, "--unplanned")}`);
  if (!listing.scheduler) return wakeFailure("stopped", "the scheduler is stopped; run herdr-automations service install");
  if (listing.paused) return wakeFailure("paused", "the scheduler is paused; run herdr-automations resume");
  if (entry.disabled) return wakeFailure("disabled", `${entry.name} is paused; run herdr-automations resume ${shellWord(entry.name)}`);
  return wakeFailure("active", listing.backend === "auto"
    ? "the config is verified; whether the running service uses hc is unreadable here" : null);
}

function wakeStatus(project, bot, { listing, failure }) {
  const spec = bot.wake;
  const base = { spec, next: null, last: null };
  if (failure) return { status: { ...base, ...failure }, other: [] };
  const found = wakeEntry(listing, project, bot.id);
  const { entry, invalid, blocked, other, renamed } = found;
  if (!blocked && entry?.last) {
    const { status, at, error = null, result = null } = entry.last;
    base.last = { status, at, error, result };
  }
  const problem = (invalid && !entry
    ? wakeFailure("invalid", `${found.name} is invalid in ${listing.config}${invalid.message ? `: ${invalid.message}` : ""}`)
    : blocked)
    ?? wakeCapability(listing)
    ?? (!entry ? renamed ?? wakeFailure("not-scheduled", "there is no matching scheduler entry")
      : !wakeMatches(entry, wakePayload(project, bot.id, spec))
        ? wakeFailure("mismatch", `${entry.name} differs from the roster's wake`)
        : wakeRunnable(project, bot, listing, entry));
  return { status: { ...base, ...problem, next: problem.state === "active" ? entry.next || null : null }, other };
}

const wakeEditCommand = (project, id, spec, flag = spec ? `--wake ${spec}` : "--no-wake") =>
  ["am", "edit", shellWord(id), "--project", shellWord(project.key),
    ...(project.machine ? ["--machine", shellWord(project.machine)] : []), flag].join(" ");

async function reconcileWake(project, id, spec, removingBot) {
  const { listing, failure } = await readWakeScheduler(project);
  if (failure) return failure;
  const { entry, name, blocked, renamed } = wakeEntry(listing, project, id);
  if (blocked) return blocked;
  const capability = wakeCapability(listing);
  if (capability && (spec || !removingBot)) return capability;
  if (spec && !entry && renamed) return renamed;
  if (!spec && !entry) return wakeFailure("not-scheduled", null);

  const payload = spec ? wakePayload(project, id, spec) : null;
  const r = await schedulerRun(project, spec ? ["put", ...(entry ? ["--original", name] : [])] : ["rm", name],
    payload ? JSON.stringify(payload) : undefined);
  const lost = r.code === -1;
  if (!lost) {
    if (r.code === 127) return wakeRunFailure(r);
    const verb = spec ? "put" : "rm";
    if (r.code !== 0) return wakeFailure("unverified", `herdr-automations ${verb} failed: ${wakeProblemLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
    if (spec) {
      const reply = wakeJson(r.stdout);
      if (!reply || (reply.problem !== undefined && typeof reply.problem !== "string")
        || (reply.next !== undefined && (!Array.isArray(reply.next) || !reply.next.every((at) => typeof at === "string")))) {
        return wakeFailure("unverified", "herdr-automations put returned an unreadable reply");
      }
      if (reply.problem) return wakeFailure("unverified", `herdr-automations put refused ${name}: ${wakeProblemLine(reply.problem)}`);
    } else if (r.stdout.trim()) return wakeFailure("unverified", "herdr-automations rm returned unexpected output");
  }

  const after = await readWakeScheduler(project);
  if (after.failure) return wakeFailure(lost ? "unknown" : "unverified",
    `${name} could not be verified: ${after.failure.problem}${lost ? "; the old wake may still fire" : ""}`);
  const saved = wakeEntry(after.listing, project, id);
  if (spec) {
    if (!saved.blocked && wakeMatches(saved.entry, payload)) return wakeCapability(after.listing) ?? { listing: after.listing };
    return wakeFailure("unverified", `${name} does not match the saved wake in ${after.listing.config}`
      + (saved.blocked ? `. ${saved.blocked.problem}` : ""));
  }
  if (saved.blocked) return saved.blocked;
  return saved.entry ? wakeFailure("unverified", `${name} is still present in ${after.listing.config}`)
    : wakeFailure("not-scheduled", null);
}

/** Read the roster before and after mirroring it, with one retry for an intervening edit. */
async function syncWake(project, id, requested, { removingBot = false } = {}) {
  if (project.dir !== project.key) {
    return { spec: requested, scheduled: false, state: "saved-only",
      problem: `wake saved in ${fileName(project)}; it goes live from the main checkout's roster. Run ${wakeEditCommand(project, id, requested)}` };
  }
  const readBot = async () => {
    const owner = project.machine ? await loadRemoteProject(project.key, project.machine) : loadProject(project.key);
    return owner.file.bots.find((bot) => bot.id === id);
  };
  let spec = requested;
  try {
    let bot = await readBot();
    for (let pass = 0; pass < 2; pass += 1) {
      spec = bot?.wake ?? null;
      const result = await reconcileWake(project, id, spec, removingBot);
      bot = await readBot();
      if (spec !== (bot?.wake ?? null)) continue;
      if (result.listing) {
        const { status } = wakeStatus(project, bot, result);
        return { spec, scheduled: true, state: status.state, problem: status.problem };
      }
      return { spec, scheduled: false, ...result };
    }
    return { spec: bot?.wake ?? null, scheduled: false, state: "superseded",
      problem: "the roster changed twice while syncing; check its current wake before retrying" };
  } catch (e) {
    return { spec, scheduled: false, state: "unknown",
      problem: `the owner's roster could not be confirmed: ${wakeProblemLine(e.message)}; the old wake may still fire` };
  }
}

async function saveWake(project, id, opts) {
  if (opts.wake === undefined && !opts["no-wake"]) return {};
  const wake = await syncWake(project, id, opts.wake ?? null);
  if (wake.state === "saved-only") report([wake.problem]);
  else {
    const saved = wake.spec ? `wake ${wake.spec} saved in ${fileName(project)}` : `wake cleared in ${fileName(project)}`;
    if (!wake.scheduled && wake.state !== "not-scheduled") {
      exitAfter.code = 1;
      report([`${saved}; scheduler sync on ${wakeOwner(project)} failed: ${wake.problem}. Rerun ${wakeEditCommand(project, id, wake.spec)}`]);
    } else {
      report([`${saved}; ${wake.scheduled ? "scheduler entry verified" : "scheduler entry absent"} on ${wakeOwner(project)}${wake.problem ? `. Warning: ${wake.problem}` : ""}`]);
    }
  }
  return { wake };
}

async function removeBotWake(project, id) {
  const name = wakeAutomationName(id, project.key);
  const remove = `herdr-automations rm ${shellWord(name)} on ${wakeOwner(project)}`;
  if (project.dir !== project.key) {
    report([`once the deletion reaches ${project.key}, ${remove} removes its wake entry`]);
    return;
  }
  const wake = await syncWake(project, id, null, { removingBot: true });
  if (wake.state === "missing" || wake.state === "not-scheduled" || wake.scheduled) return;
  report([`bot removed from ${fileName(project)}; wake entry ${name} may remain on ${wakeOwner(project)}: ${wake.problem}`
    + (wake.state === "conflict" ? "" : `. Check that it belongs to this bot before running ${remove}`)]);
}

const wakeDisplayTime = (time, linked) => linked ? time : time?.replace(/(T\d\d:\d\d):.*$/, "$1");
// An active wake carries a problem only when the backend is auto.
const wakeNextText = (wake, linked) => wake.next
  ? `next ${wakeDisplayTime(wake.next, linked)}${wake.problem ? " (per the config)" : ""}` : null;
const wakeLastText = (wake, linked, detail = false) => {
  if (!wake.last) return null;
  const oneLine = wakeProblemLine(wake.last.error || wake.last.result);
  const note = detail || oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}…`;
  return `last ${wake.last.status}${detail ? " at" : ""} ${wakeDisplayTime(wake.last.at, linked)}${note ? ` (${note})` : ""}`;
};

function listedWake(project, bot, scheduler) {
  if (!bot.wake) return {};
  return { wake: bot.wake, wakeStatus: wakeStatus(project, bot, scheduler).status };
}

async function cmdLs(opts) {
  let scheduler;
  const schedulerFor = (project) => project.file.bots.some((bot) => bot.wake)
    ? (scheduler ??= readWakeScheduler(project)) : null;
  if (opts.machine !== undefined) {
    if (opts.all) throw new CliError("ls --all lists this computer's projects; give --machine without --all.", 2);
    const project = await projectFor(opts);
    const listing = await schedulerFor(project);
    const bots = [];
    for (const bot of project.file.bots) bots.push({ ...await describeLinked(project, bot), ...listedWake(project, bot, listing) });
    const one = { ...placeOf(project), categories: project.file.categories, warnings: project.warnings, bots };
    return opts.json ? { projects: [one] } : lsLines([one]);
  }
  const keys = [await commandKeyOf(opts)];
  if (opts.all) for (const k of rememberedKeys()) if (!keys.includes(k)) keys.push(k);
  const projects = [];
  const { view, hcError } = await viewOrError();
  for (const key of keys) {
    let project;
    try { project = loadProject(key); } catch (e) { projects.push({ project: key, error: e.message, categories: [], bots: [], warnings: [] }); continue; }
    if (project.text === null && opts.all && key !== keys[0]) continue; // a remembered project whose file is gone
    const listing = await schedulerFor(project);
    const ledger = workerLedgerRows();
    const bots = await Promise.all(project.file.bots.map(async (b) => {
      const held = await readHeld(project, b, view);
      return { ...describe(project, b, view, hcError, null, null, held, seatContext(project, b, held?.get ?? null, ledger),
        await seatRateLimit(project, b, held?.get ?? null)),
        duplicate: await duplicateLabel(project, b, view), ...listedWake(project, b, listing) };
    }));
    // #1557: the open attention items, so one episode shows once here too.
    projects.push({ project: key, categories: project.file.categories, warnings: project.warnings, bots, attention: openAttention(key) });
  }
  if (opts.json) return { projects };
  return lsLines(projects);
}

function lsLines(projects) {
  const lines = [];
  for (const p of projects) {
    lines.push(`${p.project}${p.machine ? ` on ${p.machine}` : ""}${p.error ? `  (${p.error})` : ""}`);
    if (!p.bots.length && !p.error) lines.push("  no bots");
    for (const b of p.bots) {
      const crossLead = b.leadProject ? ` (${b.leadProject})` : "";
      const where = b.kind === "main"
        ? (b.leadProject && b.lead ? `main → ${b.leadName ?? b.lead}${crossLead}` : "main")
        : `→ ${b.leadName ?? "?"}${crossLead}${b.category ? ` [${b.category}]` : ""}`;
      const model = b.model ? `${b.model} (${b.modelSource})` : "-";
      const agy = b.agyMode ? `  agy-mode ${b.agyMode}` : "";
      const perms = b.agyPermissions || b.workerAgyPermissions
        ? `  agy-allow ${(b.agyPermissions ?? b.workerAgyPermissions).allow.length} deny ${(b.agyPermissions ?? b.workerAgyPermissions).deny.length}` : "";
      const resets = b.rate_limited?.resets_at ? ` (resets ${b.rate_limited.resets_at})` : "";
      const status = b.planned ? `planned, wave ${b.planned.wave}`
        : b.terminal ? `${b.status}${resets} in ${p.machine ? `${p.machine}/` : ""}${b.terminal}` : b.status;
      const code = b.code === false ? "  code false" : "";
      const duplicate = b.duplicate ? "  ! duplicate live labels" : "";
      const wake = b.wakeStatus;
      const wakeLine = wake ? ["", `wake ${wake.spec} ${wakeNextText(wake, p.machine) ?? `(${wake.state})`}`,
        wakeLastText(wake, p.machine)].filter((part) => part !== null).join("  ") : "";
      lines.push(`  ${b.id}  ${b.name}${b.rank ? ` (${b.rank})` : ""}  ${where}${code}  ${b.agent ?? "-"}  ${model}${agy}${perms}  ${status}${duplicate}${b.warning ? `  ! ${b.warning}` : ""}${wakeLine}`);
    }
    for (const row of p.attention ?? []) lines.push(`  ! ${row.text}`);
    for (const w of p.warnings ?? []) lines.push(`  ! ${w}`);
    const hcError = p.bots.find((b) => b.hcError)?.hcError;
    if (hcError) lines.push(`  ! panes unknown: ${hcError}`);
  }
  return lines.join("\n");
}

/** A bot's worker defaults (or its swap arm) as one line: `agent codex · model gpt-5.5 · agy mode plan`. */
const workerText = (w) => {
  if (!w) return "";
  const mode = w.agyMode ? [`agy mode ${w.agyMode}`] : [];
  return ["template", "agent", "model", "effort"].filter((k) => typeof w[k] === "string" && w[k])
    .map((k) => `${k} ${w[k]}`).concat(mode).join(" · ");
};

const proxyStateText = (state) => `working ${state.working ? "on" : "off"}; approved `
  + `${state.error ? "unknown" : state.approved === null ? "missing" : state.approved ? "on" : "off"}`
  + `${state.error ? `; ${state.error}` : ""}`;

const proxyWarning = (state) => `WARNING hc proxy: ${state.error}; working switch off; `
  + "starting plain; run am proxy approve";
const reportProxyWarning = (warning) => report([warning]);

function proxyEnabled(state, platform = process.platform, warn = reportProxyWarning) {
  try {
    const enabled = approvedProxyEnabled(state, platform);
    if (platform === "linux" && state.error && !state.working) warn(proxyWarning(state));
    return enabled;
  }
  catch (e) { throw new CliError(e.message); }
}

// Read approval on the target, never from this computer's data root. Only Linux launches
// use the switch, so a linked non-Linux launch needs no approval probe.
async function proxyStateOn(project, bot) {
  const { key, machine } = project;
  let path;
  try {
    const location = await remoteIo.exec("sh", ["-c",
      'CDPATH= cd -- "$1" || exit 1; pwd -P; '
      + 'printf "%s\\n" "${XDG_DATA_HOME:-$HOME/.local/share}/automagik-herdr/approved"',
      "sh", key], machine, { timeout: AGENT_WAIT_S });
    if (location.code !== 0) throw new Error("cannot locate the target's approved roster");
    const [canonical, root, extra] = location.stdout.trimEnd().split("\n");
    if (!canonical?.startsWith("/") || !root?.startsWith("/") || extra !== undefined) {
      throw new Error("the target's approval location is invalid");
    }
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
    // Same canonical key and suffix as approved.js recordFileOf; fixture test pins both.
    path = `${root}/${hash}.json`;
    const mode = await remoteIo.exec("sh", ["-c",
      'if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 3; fi; '
      + '[ -f "$1" ] && [ ! -L "$1" ] || exit 1; stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1"',
      "sh", path], machine, { timeout: AGENT_WAIT_S });
    if (mode.code === 3) return proxyStateFor(bot);
    if (mode.code !== 0 || !/^[0-7]{3,4}\s*$/.test(mode.stdout)
      || (parseInt(mode.stdout, 8) & 0o077) !== 0) {
      throw new Error("the target's approved record is unreadable or not private");
    }
    const text = await readRemoteText(remoteIo, machine, path);
    if (text === null) throw new Error("the target's approved record disappeared");
    return proxyStateFor(bot, parseApprovedRecord(text, canonical).file);
  } catch (e) {
    return proxyStateFor(bot, null,
      `invalid approved record ${path ?? `for project ${key}`}: ${e?.message ?? e}`);
  }
}

async function checkLinkedProxy(project, bot, agent, warn = reportProxyWarning) {
  if (agent !== "dsh-tui") return;
  const target = await remoteIo.exec("uname", ["-s"], project.machine,
    { timeout: AGENT_WAIT_S });
  if (target.code !== 0) {
    const why = String(target.stderr || target.stdout || `exit ${target.code}`)
      .replace(/\s+/g, " ").trim();
    const state = proxyStateFor(bot, null, `cannot check the target platform: ${why}`);
    proxyEnabled(state, "linux", warn);
    return;
  }
  if (!/^Linux(?:\s|$)/.test(target.stdout)) return;
  if (proxyEnabled(await proxyStateOn(project, bot), "linux", warn)) {
    throw new CliError("hc proxy: start this opted-in bot on its own computer; "
      + "linked Linux launches cannot verify the proxy execution path.");
  }
}

async function cmdShow(opts, [ref]) {
  const project = await projectFor(opts);
  const bot = await botIn(project, ref, opts);
  warnProject(project, bot.id);
  const { view, hcError } = project.machine ? {} : await viewOrError();
  const live = !project.machine && !bot.planned && view ? liveFor(view, bot.id, project)?.get ?? null : null;
  const held = project.machine ? null : await readHeld(project, bot, view, { refuseTwins: true });
  const info = { ...(project.machine ? await describeLinked(project, bot)
    : { ...describe(project, bot, view, hcError, null, null, held, seatContext(project, bot, held?.get ?? live),
      await seatRateLimit(project, bot, held?.get ?? live)),
      duplicate: await duplicateLabel(project, bot, view) }), instructions: bot.instructions };
  info.attention = project.machine ? [] : openAttention(project.key).filter((row) => row.botId === bot.id);
  info.hcProxyState = project.machine ? await proxyStateOn(project, bot)
    : approvedProxyState({ project: project.key, bot });
  const wake = bot.wake ? wakeStatus(project, bot, await readWakeScheduler(project)) : null;
  if (wake) Object.assign(info, { wake: bot.wake, wakeStatus: wake.status });
  if (opts.json) return info;
  const crossProjects = info.crossMembers?.length ? localProjectsFor(project) : null;
  return [
    `${info.name} (${info.id})`, `  project      ${info.project}${info.machine ? ` on ${info.machine}` : ""}`, `  kind         ${info.kind}`,
    ...(info.lead ? [`  lead         ${info.leadName ?? info.lead} (${info.lead})${info.leadProject ? ` in ${info.leadProject}` : ""}`] : []),
    ...(info.leadProject && !info.lead ? [`  lead project ${info.leadProject}`] : []),
    ...(info.crossMembers?.length ? [`  cross members ${info.crossMembers.map((m) => {
      const mName = crossProjects?.get(m.project)?.bots?.find((x) => x.id === m.id)?.name;
      return `${mName ? `${mName} (${m.id})` : m.id} in ${m.project}`;
    }).join(", ")}`] : []),
    ...(info.category ? [`  category     ${info.category}`] : []),
    ...(info.planned ? [`  planned      wave ${info.planned.wave}${info.planned.note ? ` · ${info.planned.note}` : ""}`] : []),
    `  agent        ${info.agent ?? "-"}`, `  model        ${info.model ? `${info.model} (${info.modelSource})` : "-"}${info.pinnedModel && info.modelSource !== "pinned" ? `, pinned ${info.pinnedModel}` : ""}`,
    ...(info.effort !== null || info.tier !== null ? [
      `  effort       ${info.effort ? `${info.effort} (${info.effortSource})` : "-"}`,
      `  tier         ${info.tier ? `${info.tier} (${info.tierSource})` : "-"}`,
    ] : []),
    ...(info.permissionMode ? [`  permission   ${info.permissionMode} (${info.permissionModeSource})`]
      : info.permissionModeSource === "live"
        ? [`  permission   not named by its live command line (${info.pinnedPermissionMode
          ? `its record's ${info.pinnedPermissionMode} applies to its next start` : "the pack's auto mode applies to its next start"})`]
        : []),
    ...(info.agyMode ? [`  agy mode     ${info.agyMode}`] : []),
    ...(info.autoMode ? [`  auto mode    ${info.autoMode.args.length ? `${info.autoMode.args.join(" ")} (${info.autoMode.note})` : `none: ${info.autoMode.note}`}`] : []),
    ...(info.autoMode?.sandbox && info.autoMode.sandbox.state !== "available"
      ? [`  agy sandbox  ${info.autoMode.sandbox.state}: ${info.autoMode.sandbox.detail}; --mode auto ${info.autoMode.sandbox.state === "missing" ? "doesn't take" : "may not take"} effect here`] : []),
    ...(info.agyPermissions ? [`  agy trusted  ${(info.agyPermissions.trustedWorkspaces ?? []).join(", ") || "-"}`,
      `  agy allow    ${info.agyPermissions.allow.join(", ") || "-"}`,
      `  agy deny     ${info.agyPermissions.deny.join(", ") || "-"}`] : []),
    ...(info.workerAgyPermissions ? [`  worker agy trusted  ${(info.workerAgyPermissions.trustedWorkspaces ?? []).join(", ") || "-"}`,
      `  worker agy allow  ${info.workerAgyPermissions.allow.join(", ")}`,
      `  worker agy deny   ${info.workerAgyPermissions.deny.join(", ")}`] : []),
    `  status       ${info.status}${info.terminal ? ` in ${info.terminal} (since ${info.since})` : ""}`,
    ...(info.rate_limited ? [`  rate limit   ${info.rate_limited.resets_at ? `until ${info.rate_limited.resets_at}` : "no reset time in the dialog"}`
      + `; waiting on "${info.rate_limited.question}" (Herdr never answers it)`] : []),
    ...(info.attention?.length ? [`  attention    ${info.attention.map((row) => row.text).join("; ")}`] : []),
    `  context      ${info.context_tokens === null ? "-" : `${info.context_tokens} tokens`}`,
    `  restartAt    ${info.restartAt === null ? "-" : `${info.restartAt} tokens${info.pinnedRestartAt ? "" : " (default)"}`}`,
    ...(wake ? [
      `  wake         ${[bot.wake, wake.status.state, wakeNextText(wake.status, project.machine),
        wakeLastText(wake.status, project.machine, true)].filter(Boolean).join(" · ")}`,
      ...(wake.status.problem ? [`  wake note    ${wakeProblemLine(wake.status.problem)}`] : []),
      ...(wake.other.length ? [`  wake note    other automations target this bot: ${wake.other.join(", ")}`] : []),
    ] : []),
    ...(info.duplicate ? ["  warning      duplicate live labels"] : []),
    `  look         ${info.look.character} in ${info.look.colour}`, `  role         ${info.role || "-"}`,
    `  rank         ${info.rank ?? "-"}`, `  code         ${info.code}`,
    `  hc proxy     ${proxyStateText(info.hcProxyState)}`,
    `  worker       ${workerText(info.worker) || "-"}`,
    ...(info.worker?.swap ? [`  swap         ${workerText(info.worker.swap)} (planned swaps: about 1 task in 3)`] : []),
    ...(info.warning ? [`  warning      ${info.warning}`] : []),
    "  instructions", ...(info.instructions ? info.instructions.split("\n").map((l) => `    ${l}`) : ["    -"]),
  ].join("\n");
}

// ---- A16 pane labels (launchArgs.js): this computer's panes only ----

/** The `hc get` of a bot's attached live pane on this computer, as a list (launchArgs relabel's io.rows). */
async function liveRows(botId) {
  const get = await attachedGet(botId);
  return get ? [get] : [];
}
const labelIo = { rows: liveRows, label: async (address, words) => (await hc(["label", address, ...words])).code === 0 };

/**
 * After a write, the live local panes of every bot whose labels the edit changed (rank, lead
 * or category, and a lead's captain status) get them rewritten, by launchArgs.js relabel as
 * the sidebar does. The file is saved already, so a failure only warns. Resolves with the
 * terminals relabelled.
 */
async function relabelAfter(beforeFile, afterRaw) {
  let afterFile;
  try { afterFile = parseBots(JSON.stringify(afterRaw)).file; } catch { return []; }
  const out = await relabel(relabelPlan(beforeFile, afterFile), labelIo);
  const warning = relabelWarning(out);
  if (warning) report([warning]);
  return out.done;
}

function warnCrossLinkAfterSave(project, raw, botId) {
  if (project?.machine) return;
  try {
    const file = parseBots(JSON.stringify(raw)).file;
    const bot = file.bots.find((b) => b.id === botId);
    if (!bot || (!bot.leadProject && !bot.crossMembers?.length)) return;
    const extraKeys = [
      ...(bot.leadProject ? [bot.leadProject] : []),
      ...crossMembersOf(bot).map((m) => m.project),
    ];
    const projects = localProjectsFor({ key: project.key, file }, appHome(), extraKeys);
    const warnings = [];
    if (bot.leadProject) {
      const eff = effectiveLead(file, bot.id, { project: project.key, projects });
      if (eff.warning) warnings.push(`Warning: ${bot.id}: ${eff.warning}`);
    }
    for (const w of crossMemberWarnings(file, bot.id, { project: project.key, projects })) {
      warnings.push(`Warning: ${bot.id}: ${w}`);
    }
    if (warnings.length) report(warnings);
  } catch { /* non-fatal warning */ }
}

async function cmdCreate(opts) {
  const project = await editProjectFor(opts);
  const id = newBotId();
  const entry = entryFrom(opts, { id, kind: mainBotOf(project.file) ? "member" : "main" }, project, { creating: true });
  const raw = applyBotEdit(project.raw, entry);
  await saveProject(project, raw);
  if (opts.project !== undefined && project.dir === project.key) {
    const given = (project.machine ? opts.project : resolvePath(opts.project)).replace(/\/+$/, "") || "/";
    const same = project.dir === given || (!project.machine && (() => {
      try { return realpathSync(project.dir) === realpathSync(given); } catch { return false; }
    })());
    if (!same) report([`saved in ${fileName(project)} (project ${project.key}, resolved from --project ${given}).`]);
  }
  if (!project.machine) {
    if (entry.leadProject) listProject(entry.leadProject);
    for (const m of crossMembersOf(entry)) listProject(m.project);
  }
  warnCrossLinkAfterSave(project, raw, id);
  // A lead that becomes a captain; another machine's panes are left as they are.
  const relabelled = project.machine ? [] : await relabelAfter(project.file, raw);
  const wake = await saveWake(project, id, opts);
  return opts.json ? { id, ...placeOf(project), bot: entry, relabelled, ...wake } : id;
}

async function cmdEdit(opts, [ref]) {
  const project = await editProjectFor(opts);
  const bot = await botIn(project, ref, opts);
  const stored = project.raw.bots.find((b) => b?.id === bot.id);
  const entry = entryFrom(opts, stored, project, { creating: false });
  const raw = applyBotEdit(project.raw, entry);
  await saveProject(project, raw);
  if (!project.machine) {
    if (entry.leadProject) listProject(entry.leadProject);
    for (const m of crossMembersOf(entry)) listProject(m.project);
  }
  warnCrossLinkAfterSave(project, raw, bot.id);
  const relabelled = project.machine ? [] : await relabelAfter(project.file, raw);
  const wake = await saveWake(project, bot.id, opts);
  return opts.json ? { id: bot.id, ...placeOf(project), bot: entry, relabelled, ...wake } : `${entry.name} (${bot.id}) saved.`;
}

const MAIN_USAGE = "usage: am main <bot> [--old-lead <bot>] [--dry-run] [--project DIR] [--machine M] [--json]";
const MAIN_OPTIONS = new Set(["old-lead", "dry-run", "project", "machine", "json"]);

function checkMainArgs(rest, tokens) {
  if (rest.length !== 1 || !rest[0].trim()) throw new CliError(MAIN_USAGE, 2);
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (!MAIN_OPTIONS.has(token.name)) throw new CliError(`--${token.name} isn't an option for main. ${MAIN_USAGE}`, 2);
    if (seen.has(token.name)) throw new CliError(`Give --${token.name} once. ${MAIN_USAGE}`, 2);
    if (token.value !== undefined && !token.value.trim()) throw new CliError(`--${token.name} needs a value. ${MAIN_USAGE}`, 2);
    seen.add(token.name);
  }
}

async function cmdMain(opts, [ref]) {
  const project = await editProjectFor(opts);
  const mains = project.raw.bots.filter((row) => row?.kind === "main");
  if (mains.length !== 1) throw new CliError(`Not saved: ${mains.length} main bots; a project has exactly one.`);
  const [incumbent] = mains;
  const successor = await botIn(project, ref, opts);
  if (successor.id === incumbent.id) throw new CliError(`${successor.name} is already the main bot.`);
  if (successor.planned) throw new CliError(`${successor.name} is planned, so it can't be the main bot yet.`);
  const lead = opts["old-lead"] === undefined ? successor : await botIn(project, opts["old-lead"], opts);
  if (lead.id === incumbent.id) throw new CliError(`${incumbent.name} can't lead itself.`);
  if (lead.planned) throw new CliError(`${lead.name} is planned, so it can't lead a bot yet.`);

  const describe = ({ id, name }) => `${name} (${id})`;
  const explicitLead = lead.id !== successor.id;
  const ownProject = cleanProjectPath(project.key);
  const implicitMembers = [], displacedLinks = [], changes = [];
  // Use the stored rows so legacy cross-members and unrelated settings pass through verbatim.
  const bots = project.raw.bots.map((row) => {
    const promoted = row?.id === successor.id;
    if (!promoted && row !== incumbent) {
      if (row?.kind === "member" && !Object.hasOwn(row, "lead")) implicitMembers.push({ id: row.id, name: row.name });
      return row;
    }
    const leadProject = cleanProjectPath(row.leadProject);
    if (leadProject.startsWith("/") && leadProject !== ownProject && typeof row.lead === "string" && row.lead.trim()) {
      displacedLinks.push({ id: row.id, name: row.name, lead: row.lead, leadProject });
    }
    const next = { ...row, kind: promoted ? "main" : "member" };
    delete next.lead;
    delete next.leadProject;
    if (!promoted && explicitLead) next.lead = lead.id;
    if (promoted || explicitLead) delete next.category;
    changes.push(promoted ? `${describe(row)} becomes the main bot.`
      : `${describe(row)} becomes a member reporting to ${describe(lead)}.`);
    return next;
  });
  const raw = { ...project.raw, bots };
  const preview = () => {
    const lines = [
      ...changes,
      `Members with no stored lead that will follow ${describe(successor)}:`,
      ...(implicitMembers.length ? implicitMembers.map((bot) => `  ${describe(bot)}`) : ["  None."]),
      ...displacedLinks.map((link) => `Displaced external lead: ${describe(link)} → ${link.lead} in ${link.leadProject}. `
        + "Remove the reciprocal entry there manually."),
    ];
    if (opts.json) report(lines);
    else process.stdout.write(unprinted(`${lines.join("\n")}\n`));
  };

  const dryRun = Boolean(opts["dry-run"]);
  let relabelled = [];
  if (dryRun) checkBotsForSave(raw, project.text, preview);
  else {
    await saveProject(project, raw, { preview, confirmUnchanged: true });
    if (!project.machine) relabelled = await relabelAfter(project.file, raw);
  }
  if (opts.json) return { id: successor.id, ...placeOf(project), previousMain: incumbent.id, oldLead: lead.id,
    implicitMembers, displacedLinks, saved: !dryRun, relabelled };
  return dryRun ? null : `Main bot hand-over saved in ${fileName(project)}.`;
}

async function cmdRm(opts, [ref]) {
  const project = await editProjectFor(opts);
  const { file } = project;
  const bot = await botIn(project, ref, opts);
  // Its pane by the ledger, read before the write (the import, on a first run, needs the bot
  // still defined). hc missing or failing only drops the note.
  let holders = [];
  if (!bot.planned && !project.machine) {
    try { const held = (await attachView()).live.get(bot.id); holders = held ? [held.binding.terminal] : []; } catch (e) {
      if (e instanceof LedgerRefusal) throw e;
      holders = [];
    }
  }
  // Every other entry as stored, those parseBots left out included: they are still bots.
  const others = project.raw.bots.filter((b) => b?.id !== bot.id);
  if (bot.kind === "main" && others.length) {
    throw new CliError(`${bot.name} is the main bot and its project still has ${others.length} other bot${others.length > 1 ? "s" : ""}; remove them first.`);
  }
  const team = [...descendantsOf(file, bot.id)].map((id) => file.bots.find((b) => b.id === id)?.name ?? id);
  const leads = others.filter((b) => b?.lead === bot.id).map((b) => b.name ?? b.id);
  if (team.length || leads.length) throw new CliError(`${bot.name} leads ${[...new Set([...leads, ...team])].join(", ")}; give them another lead first (am edit <bot> --lead …).`);
  const raw = JSON.parse(JSON.stringify(project.raw));
  raw.bots = raw.bots.filter((b) => b?.id !== bot.id);
  // Only an empty list deletes the file; anything else must pass checkBots (a file left
  // with members and no main bot is refused, never deleted).
  const last = raw.bots.length === 0;
  // A worktree with no file of its own holds nothing to delete: its edit would only show the key's.
  if (last && project.expected === null) {
    throw new CliError(`${bot.name} is the project's last bot and ${fileName(project)} isn't there, so nothing was removed; `
      + `remove it from ${project.key}.`);
  }
  await saveProject(project, last ? null : raw, { list: false });
  await removeBotWake(project, bot.id);
  if (!last && !project.machine) await relabelAfter(file, raw); // its lead may stop being a captain
  const notes = [];
  if (last) notes.push(`${bot.name} was the project's last bot: ${fileName(project)} was deleted.`);
  if (holders.length) notes.push(`${holders.join(", ")} is still attached to it; detach it with: am detach ${bot.id}`);
  for (const n of notes) process.stderr.write(`am: ${n}\n`);
  return opts.json ? { removed: bot.id, ...placeOf(project), deletedFile: last, attachedTerminals: holders } : `${bot.name} (${bot.id}) removed.`;
}

async function cmdCategory(opts, [verb, ...rest]) {
  // Listing reads the project's file; the other verbs edit, in writeDirOf's folder.
  const project = verb === "ls" || verb === undefined ? await projectFor(opts) : await editProjectFor(opts);
  const raw = JSON.parse(JSON.stringify(project.raw));
  raw.categories = Array.isArray(raw.categories) ? raw.categories : [];
  const save = async () => {
    if (project.text === null) throw new CliError("This project has no bots yet; create its main bot first.");
    await saveProject(project, raw);
  };
  const find = (ref) => {
    const hit = findCategory(project.file, ref);
    return raw.categories.find((c) => c?.id === hit.id);
  };
  if (verb === "ls" || verb === undefined) {
    const list = project.file.categories.map((c) => ({ ...c, bots: project.file.bots.filter((b) => b.category === c.id).map((b) => b.id) }));
    return opts.json ? { ...placeOf(project), categories: list } : list.map((c) => `${c.id}  ${c.title}${c.sub ? ` · ${c.sub}` : ""}  (${c.bots.length} bot${c.bots.length === 1 ? "" : "s"})`).join("\n") || "no categories";
  }
  if (verb === "add") {
    if (!opts.title?.trim()) throw new CliError("A category needs a title (--title).", 2);
    const id = opts.id ?? newCategoryId(opts.title, raw.categories);
    if (!CATEGORY_ID.test(id)) throw new CliError(`--id "${id}" isn't a category id: a lowercase slug (a-z, 0-9, single dashes), as it goes into a pane's category= label.`, 2);
    if (raw.categories.some((c) => c?.id === id)) throw new CliError(`Category ${id} is there already.`);
    const cat = { id, title: opts.title.trim() };
    if (opts.sub?.trim()) cat.sub = opts.sub.trim();
    raw.categories.push(cat);
    await save();
    return opts.json ? { ...placeOf(project), category: cat } : id;
  }
  if (verb === "edit") {
    const cat = find(rest[0]);
    if (opts.title !== undefined) { if (!opts.title.trim()) throw new CliError("A category's title can't be empty.", 2); cat.title = opts.title.trim(); }
    if (opts.sub !== undefined) { if (opts.sub.trim()) cat.sub = opts.sub.trim(); else delete cat.sub; }
    await save();
    return opts.json ? { ...placeOf(project), category: cat } : `${cat.id} saved.`;
  }
  if (verb === "rm") {
    const cat = find(rest[0]);
    const users = project.file.bots.filter((b) => b.category === cat.id).map((b) => b.name);
    if (users.length) throw new CliError(`${users.join(", ")} ${users.length > 1 ? "are" : "is"} in ${cat.id}; move them first (am edit <bot> --category … or --no-category).`);
    raw.categories = raw.categories.filter((c) => c?.id !== cat.id);
    await save();
    return opts.json ? { ...placeOf(project), removed: cat.id } : `${cat.id} removed.`;
  }
  if (verb === "order") {
    if (!rest.length) throw new CliError("Name the categories in their new order.", 2);
    const ids = rest.map((r) => find(r).id);
    if (new Set(ids).size !== ids.length) throw new CliError("A category is named twice.", 2);
    raw.categories = [...ids.map((id) => raw.categories.find((c) => c?.id === id)), ...raw.categories.filter((c) => !ids.includes(c?.id))];
    await save();
    return opts.json ? { ...placeOf(project), categories: raw.categories.map((c) => c.id) } : raw.categories.map((c) => c.id).join(" ");
  }
  throw new CliError(`category ${verb}: unknown; use ls, add, edit, rm or order.`, 2);
}

/**
 * The session ids this run has handled (chosen for a launch, resumed, carried, read from a pane or
 * the ledger): RFC 0021 keeps them in the machine's ledgers and labels, never in output, so
 * everything the CLI prints (report, its answer, an error) shows each as SESSION_MASK (`unprinted`).
 */
const heldIds = new Set();
/** Registers `id` as a session id that is never printed; returns it. */
const holdId = (id) => { if (typeof id === "string" && id.trim().length >= 6) heldIds.add(id.trim()); return id; };
/** `text` with every held session id shown as SESSION_MASK. */
const unprinted = (text) => { let out = String(text); for (const id of heldIds) out = out.split(id).join(SESSION_MASK); return out; };
// Clean the whole message before masking, so truncation can't expose part of a held id.
function printableHcMessage(text) {
  const clean = stripVTControlCharacters(String(text)).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? " " : ""));
  return unprinted(clean.replace(/\s+/g, " ").trim());
}
const report = (warnings) => { for (const w of warnings) process.stderr.write(`am: ${unprinted(w)}\n`); };

function relabelFailureWarning({ terminal, words, result, error }, prefix, warnedRelabels) {
  if (warnedRelabels) {
    // Tidy may request the same changes in a different order, or get a different reason.
    const key = JSON.stringify([terminal, [...words].sort()]);
    if (warnedRelabels.has(key)) return null;
    warnedRelabels.add(key);
    prefix = printableHcMessage(prefix);
  }
  const stderr = result?.rawStderr ?? result?.stderr;
  const output = stderr || (warnedRelabels ? result?.stdout : "");
  const thrown = error?.message ?? error;
  const reason = result
    ? formatHcFailure(result, printableHcMessage(hcFailureMessage(output)))
    : printableHcMessage(warnedRelabels ? hcFailureMessage(thrown) : thrown).slice(0, HC_FAILURE_MAX) || "no message";
  return `${prefix} ${reason}`;
}

async function relabelPane(terminal, words, prefix, warnedRelabels) {
  let result;
  try { result = await hc(["label", terminal, ...words]); }
  catch (error) { return relabelFailureWarning({ terminal, words, error }, prefix, warnedRelabels); }
  return result.code === 0 ? null : relabelFailureWarning({ terminal, words, result }, prefix, warnedRelabels);
}

/**
 * Appends one row to the workers ledger (workers.js) with a single O_APPEND write, the file the
 * owner's alone: made 0600, and narrowed to its owner's bits again before every append (a file
 * made under umask 002 is 0664, and usagemeter refuses a group- or world-writable one; RFC 0021
 * (f) 6). The narrowing never widens a stricter mode, and the open never follows a symlink at
 * the ledger's path (#883: tightenLedgers refuses one too; a Herdr ledger is a plain file).
 * Before its first write in a run, an app home inside a git work tree (a project's) is kept out of git
 * (keepAppHomeOutOfGit): its rows hold session ids. The terminal runs already, so a failure only
 * comes back as a warning; null when written with nothing to say.
 */
export function appendLedger(row, appHomeDir = appHome()) {
  const path = ledgerPath(appHomeDir);
  const notes = [];
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const outOfGit = keepAppHomeOutOfGit(appHomeDir);
    if (outOfGit) notes.push(outOfGit);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), LEDGER_MODE);
    try {
      try {
        const mode = fstatSync(fd).mode & 0o777;
        if ((mode & ~LEDGER_MODE) !== 0) fchmodSync(fd, mode & LEDGER_MODE);
      } catch (e) {
        notes.push(`${path} couldn't be made private (chmod 600: ${e?.message ?? e}); usagemeter won't read a ledger others can write`);
      }
      writeSync(fd, ledgerLine(row));
    } finally { closeSync(fd); }
  } catch (e) {
    notes.push(`${row.event === "pr" ? `${row.branch}'s pull request ${row.pr} isn't in ${LEDGER_FILE}, so usagemeter won't see it`
      : `${row.terminal} runs, but it isn't in ${LEDGER_FILE}, so its usage won't be tied to it`}: ${e?.message ?? e}`);
  }
  return notes.length ? notes.join("; ") : null;
}

/**
 * Appends an end row unless the ledger already ends that launch (one end row per launch key:
 * restart, --tree and the worktree sweep may each see the same terminal end). A warning, or null.
 */
function appendEnd(row) {
  const key = launchKey(row);
  if (key && workerLedgerRows().some((r) => r?.event === "end" && launchKey(r) === key)) return null;
  return appendLedger(row);
}

/** The app homes keepAppHomeOutOfGit has looked at in this run: each is checked once. */
const outOfGitSeen = new Set();
/**
 * Keeps an app home inside a git work tree (a project's `.herdr/app-home`, RFC 0021 delivery 3)
 * out of git: git runs from the work tree's root, every path relative to it. When git doesn't
 * ignore the app home's workers ledger already, the app home's folder is added to that clone's
 * own exclude file (`git rev-parse --git-path info/exclude`), once (withExclude: a line already
 * there adds nothing), never to .gitignore or any tracked file; an app home that is the work
 * tree's root itself gets only its ledger folder (`/automagik-herdr/`), never the whole tree.
 * A ledger git tracks already can't be excluded: an exclude never untracks a file, so its rows
 * (session ids among them) stay in git until it is untracked. The CLI says so and how, and adds
 * the line anyway so the file stays out once untracked. Not in git, or ignored already: nothing.
 * Looked at once per app home per run. Returns one warning line, or null.
 */
export function keepAppHomeOutOfGit(appHomeDir) {
  const dir = String(appHomeDir).replace(/\/+$/, "");
  if (outOfGitSeen.has(dir)) return null;
  outOfGitSeen.add(dir);
  if (!isDir(dir)) return null;
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 15_000 });
  if (top.status !== 0 || !top.stdout.trim()) return null; // not in a work tree
  const root = realDir(top.stdout.trim()) ?? top.stdout.trim();
  const real = realDir(dir) ?? dir;
  if (real !== root && !real.startsWith(`${root}/`)) return null;
  // From the root, so every path below is the root's (a path is read against git's cwd).
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 });
  const rel = real === root ? "" : real.slice(root.length + 1);
  const ledger = `${rel ? `${rel}/` : ""}${LEDGER_FILE}`;
  const line = rel ? `/${rel}/` : `/${LEDGER_FILE.slice(0, LEDGER_FILE.indexOf("/"))}/`;
  const tracked = git(["ls-files", "--error-unmatch", "--", ledger]).status === 0;
  if (!tracked) {
    const ignored = git(["check-ignore", "-q", "--", ledger]);
    if (ignored.status === 0) return null;
    if (ignored.status !== 1) return `git couldn't tell whether ${root} ignores ${dir}: keep it out of your commits (its ledgers hold session ids).`;
  }
  let file = null;
  let added = false;
  let failed = null;
  try {
    const r = git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    file = r.status === 0 ? r.stdout.trim() : null;
    if (!file) throw new Error((r.stderr || "git failed").trim());
    const after = withExclude(readText(file), line);
    if (after !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after);
      added = true;
    }
  } catch (e) { failed = e?.message ?? String(e); }
  if (tracked) {
    return `${ledger} is tracked by git in ${root}, and its rows hold session ids: an exclude can't untrack a file, so it stays `
      + `in git until you run git rm --cached ${ledger} there and commit that`
      + (failed ? `; ${line} couldn't be added to ${file ?? "its git exclude file"} (${failed}).`
        : `; ${line} is in ${file}, so it stays out after that.`);
  }
  if (failed) {
    return `${dir} is in ${root}, which doesn't ignore it, and ${line} couldn't be added to ${file ?? "its git exclude file"} `
      + `(${failed}): keep it out of your commits, its ledgers hold session ids.`;
  }
  if (!added) return `${file} lists ${line}, but git still doesn't ignore ${dir} (a later rule takes it back?): keep it out of your commits.`;
  return `${dir} is in ${root}, which didn't ignore it: added ${line} to ${file}, so its session ids stay out of git.`;
}

/** A terminal's foreground pid from `hc get`, or null (hc failing, or no pid yet). */
async function pidOf(terminal) {
  try { const get = await hcGet(terminal); return get?.foreground?.pid ?? get?.pid ?? null; } catch { return null; }
}
/** A terminal's foreground pid and created_ms from one `hc get`: { pid, createdMs }, each null when hc gave none. */
async function launchOf(terminal) {
  let get = null;
  try { get = await hcGet(terminal); } catch { get = null; }
  return { pid: get?.foreground?.pid ?? get?.pid ?? null, createdMs: Number.isSafeInteger(get?.created_ms) ? get.created_ms : null };
}
/** This computer's hc core id for a ledger row, or null when hc server status can't give it (the row is still written). */
const rowCore = () => coreId().catch(() => null);
/**
 * A seat start row's tags (RFC 0021 (f) 3), from `file` at launch and frozen there: its pane
 * role (roleOf), its effective lead (null for the main bot) and its squad (squadOf).
 */
function seatTags(file, botId) {
  if (!file) return { role: null, lead: null, squad: null };
  return { role: roleOf(file, botId), lead: leadIdOf(file, botId) || null, squad: squadOf(file, botId) };
}
/** A fresh Claude launch's session id, chosen here (RFC 0021 (f) 2): a random UUID. */
const newSessionId = () => holdId(randomUUID());

/**
 * Where Herdr shows a bot started here (DESIGN: the space whose folder keys to the project):
 * the `herdr.space` / `herdr.tab` labels of a live terminal on this computer whose folder
 * keys to the project, while the window (herdr-app ls) shows the project in that space: a
 * caller's tab in another space never takes the bot. Else the window's space on the project, in
 * its selected tab. Null when none does; the pane then has no place in Herdr's window. `seen`:
 * windowSpaces(), read once by the caller; null (no window to ask): the first labelled
 * terminal's place.
 */
async function placementOf(key, seen = null) {
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state === "live" && typeof r.cwd === "string");
  const keys = new Map();
  await Promise.all([...new Set(rows.map((r) => r.cwd))].map(async (cwd) => {
    try { keys.set(cwd, await keyOf(cwd)); } catch { /* a folder gone: not this project */ }
  }));
  const mine = rows.filter((r) => keys.get(r.cwd) === key);
  const shows = (place) => !seen || spacePlace(seen.spaces.filter((s) => s.id === place.space), seen.keys, key) !== null;
  for (const r of mine) {
    // A pane hc can't answer for gives no place here (the window still decides).
    const place = placementFrom([await hcGet(r.address).catch(() => null)].filter(Boolean));
    if (place && shows(place)) return place;
  }
  if (seen) return spacePlace(seen.spaces, seen.keys, key);
  return null;
}

/** `herdr-app ls` as State spaces (spacesOf), or null: no herdr-app, no window. */
async function windowRead() {
  const r = await runProgram("herdr-app", ["ls"]);
  try { return r.code === 0 ? spacesOf(JSON.parse(r.stdout)) : null; } catch { return null; }
}

/** `herdr-app ls` as State spaces (spacesOf) and each folder's key, or null: no herdr-app, no window. */
async function windowSpaces() {
  const spaces = await windowRead();
  if (!spaces) return null;
  const keys = new Map();
  await Promise.all([...new Set(spaces.map((s) => s.folder).filter(Boolean))].map(async (f) => {
    try { keys.set(f, await keyOf(f)); } catch { /* a folder gone: not this project */ }
  }));
  return { spaces, keys };
}

/**
 * Where a start with no --space goes: a project terminal's place (placementOf) while the window
 * still shows that space, else a window space on the project, else a new one (herdr-app do
 * space.new, named after the folder). With no window to ask, the terminal's place, or null.
 * `seen`: windowSpaces(), read once per start and shared with placementOf.
 * Two starts at once can each open one: both then use the first space on the project in the
 * window, and the one that opened another closes it (it holds only its new shell).
 */
async function windowPlace(key, labelled = null, seen = null) {
  if (!seen) return labelled;
  if (labelled && seen.spaces.some((s) => s.id === labelled.space)) return labelled;
  // This ls is the check right before space.new: nothing else runs between them.
  const open = spacePlace(seen.spaces, seen.keys, key);
  if (open) return open;
  const name = key.replace(/\/+$/, "").split("/").pop();
  const r = await runProgram("herdr-app", ["do", "space.new", JSON.stringify({ name, folder: key, machine: "" })]);
  if (r.code !== 0) return null;
  let out = {};
  try { out = JSON.parse(r.stdout) ?? {}; } catch { /* the space is found in ls instead */ }
  const now = await windowSpaces();
  const first = now && spacePlace(now.spaces, now.keys, key);
  const ours = now?.spaces.find((s) => s.id === out.space || s.tabs.some((t) => t.panes.some((p) => p.terminal === out.terminal)));
  if (first && ours && ours.id !== first.space) {
    await runProgram("herdr-app", ["do", "space.close", JSON.stringify({ id: ours.id, confirmed: true })]);
  }
  const place = first || (typeof out.space === "string" ? { space: out.space, tab: null, from: null } : null);
  // The space is this start's: its first tab holds only the shell space.new started, closed
  // once the bot shows in a tab of its own there (launchSeat, closeSpare).
  const spare = ours && place?.space === ours.id ? freshSpare(ours, out.terminal) : null;
  return spare ? { ...place, spare } : place;
}

/**
 * How long a start or worker waits for Herdr to show its new pane before its tab setup is left
 * out (AUTOMAGIK_HERDR_TAB_WAIT_MS; 0 turns the setup off: no wait, no tab moved or closed).
 */
const TAB_WAIT_MS = (() => {
  const raw = process.env.AUTOMAGIK_HERDR_TAB_WAIT_MS;
  const ms = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 5000;
})();
const TAB_STEP_MS = 200;

/**
 * `pgrep <args>` on this computer as pgrep exited: { code, stdout, stderr }, its own; null when
 * it never exited by itself (not run, killed, past its 15 s): what it would have said is unknown.
 */
const pgrepHere = (args) => new Promise((done) => {
  try {
    execFile("pgrep", args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout, stderr });
      done(typeof err.code === "number" ? { code: err.code, stdout: stdout ?? "", stderr: stderr ?? "" } : null);
    });
  } catch { done(null); }
});

/** A terminal id without the machine name a linked machine's may come with (`vm/t5` -> `t5`). */
const bareId = (t) => (typeof t === "string" ? t.slice(t.indexOf("/") + 1) : t);

/**
 * Waits for the window to show `terminal` (a terminal of this computer, or of `machine` in that
 * machine's spaces) in a pane: the window's spaces then, with each tab's `index` (its
 * position, from 1, as tab.move counts) and `terminals` (a machine's as bare ids, bareId), and
 * the space and tab showing it: { spaces, space, tab }. Null when no window answers, or the pane
 * hasn't shown after TAB_WAIT_MS.
 */
async function windowShows(terminal, ms = TAB_WAIT_MS, machine = null) {
  const until = Date.now() + ms;
  const id = machine ? bareId : (t) => t;
  for (;;) {
    const read = await windowRead();
    if (!read) return null;
    const spaces = read.map((s) => ({ ...s, tabs: s.tabs.map((t, i) => ({ ...t, index: i + 1, terminals: t.panes.map((p) => id(p.terminal)),
      count: t.paneCount })) }));
    for (const space of spaces.filter((x) => (machine ? x.machine === machine : !x.machine))) {
      const tab = space.tabs.find((t) => t.terminals.includes(terminal));
      if (tab) return { spaces, space, tab };
    }
    if (Date.now() >= until) return null;
    await later(TAB_STEP_MS);
  }
}

/** `herdr-app do <command> <args>`: null when it ran, else what it said. */
async function windowDo(command, args) {
  const r = await runProgram("herdr-app", ["do", command, JSON.stringify(args)]);
  return r.code === 0 ? null : (r.stderr || r.stdout || `exit ${r.code}`).trim();
}

async function cmdStart(opts, [ref], warnedRelabels) {
  if (opts.tab && !opts.space) throw new CliError("--tab needs --space (the space that tab is in).", 2);
  const project = await projectFor(opts);
  const { file, key } = project;
  if (project.text === null) throw new CliError(`No ${BOTS_PATH} in ${key}.`);
  const bot = await botIn(project, ref, opts);
  warnProject(project, bot.id);
  const why = startRefusal(file, bot.id);
  if (why) throw new CliError(why);
  // launch.js checks the folder Start launches in against the project (attachRefusal on
  // keyOf(projectKey)). Here that folder is `key`, which keyOf already returned, and a key
  // keys to itself, so the check can't refuse: it is left out, not forgotten.
  if (project.machine) return startOnMachine(opts, project, bot);
  // One terminal plays a bot: the one the attach ledger names is reported, never a second
  // start (decided again under the ledger's lock, below, with hc run). A bot that lives in the
  // project's own app home is found by the same resolver every read shares (#1128).
  const view = await attachView();
  // By id alone, whatever the project (the fold binds a bot once per place): a clone's start
  // names the checkout whose pane it is (automagik#227).
  const held = view.live.get(bot.id) ?? await projectHomeHeld(project, bot);
  const elsewhere = held?.binding.project && held.binding.project !== key ? `, for ${held.binding.project}` : "";
  if (held) return opts.json ? { id: bot.id, running: held.binding.terminal } : `${bot.name} is already running in ${held.binding.terminal}${elsewhere}.`;
  const seat = await launchSeat(project, bot, {
    warnedRelabels, place: opts.space ? { space: opts.space, tab: opts.tab ?? null, from: null } : undefined,
  });
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  return opts.json ? seatJson(bot, seat) : seat.terminal;
}

// ---- a bot's pane on a linked machine (automagik#206 part b): start and restart ----

// How long one question to a linked machine may take, in seconds: a login shell runs the person's
// profile, so this bounds it. remoteIo.exec gives hc 10 s over it, so a slow link still brings
// hc's own "timed out" back: ended earlier, hc answers nothing and the machine reads as away.
const AGENT_WAIT_S = 10;

// A start from the sidebar on a Herdr that ends a mod's programs at 30 s (#444): the time that
// limit ends this CLI, ms since the epoch (launch.js machineCli, before its exec, so it counts
// run.sh's node search and node's own startup). Unset (a terminal, a Herdr that takes exec's
// timeout): no deadline. hc's own bound for one call, 15 s, doesn't fit twice in that limit, so
// the calls after the last check get DEADLINE_CALL_MS each: hc run, then at most two more (hc get
// and, with no created_ms, hc kill; or, with no address, hc ls and hc kill), and 1 s for the row
// and the exit: DEADLINE_MARGIN_MS. Checked before a new space is asked for (with
// DEADLINE_PLACE_MS more for windowPlaceOn's calls) and again just before hc run.
const DEADLINE = (() => { const n = Number(process.env.AUTOMAGIK_HERDR_DEADLINE); return Number.isSafeInteger(n) && n > 0 ? n : null; })();
export const DEADLINE_CALL_MS = 5000;
export const DEADLINE_MARGIN_MS = 3 * DEADLINE_CALL_MS + 1000;
export const DEADLINE_PLACE_MS = 4000;
const deadlineLeft = () => (DEADLINE === null ? Infinity : DEADLINE - Date.now());
const callBound = () => (DEADLINE === null ? {} : { timeout: DEADLINE_CALL_MS });
/** A start the deadline stops before it starts anything: why, and the command for a terminal. */
function tooLate(bot, machine, key, need, space = null) {
  const left = Math.max(0, Math.floor(deadlineLeft() / 1000));
  return new CliError(`Only ${left} s of this Herdr's 30 s limit for the sidebar's programs was left, and starting ${bot.name} `
    + `on ${machine} needs ${need / 1000} s to finish once its pane starts, so nothing was started`
    + `${space ? ` (the space it opened, ${space}, stays, with only its shell)` : ""}. `
    + `Start it from a terminal: am start ${shellWord(bot.id)} --project ${shellWord(key)} --machine ${shellWord(machine)}`);
}

const quietOn = (machine, seen) => seen.login === "timed out" ? `${machine}'s login shell didn't answer within ${AGENT_WAIT_S} s`
  : seen.login === false ? `${machine}'s login shell gave no PATH` : null;
const quietWarning = (name, quiet) => (quiet ? [`${quiet}, so ${name} starts with the PATH hc runs programs with there and its user bin folders.`] : []);
const unreachable = (machine, seen) => new CliError(`${machine} can't be reached: ${hcSaid(seen.why)}`);

/** The refusal for a program that isn't on `machine`; `also` (#612): the shipped run, missing too. */
function notInstalledThere(name, program, machine, quiet, also = null) {
  return new CliError(`${name} (${program}) isn't installed on ${machine}, or isn't on the PATH hc runs programs with there, `
    + `its login shell's PATH, ~/.local/bin or ~/.bun/bin${also ? `; its shipped run (${also}) isn't either` : ""}${quiet ? ` (${quiet})` : ""}.`);
}

/** The refusal for a program on `machine` whose #! interpreter a pane there couldn't run. */
function noInterpreterThere(name, seen, machine, quiet) {
  return new CliError(`${name} (${seen.file}) runs under ${seen.interpreter}, which isn't on the PATH a pane on ${machine} gets; `
    + `it would fail with "env: ${seen.interpreter}: No such file or directory". Put ${seen.interpreter} on the PATH of ${machine}'s login shell${quiet ? ` (${quiet})` : ""}.`);
}

/**
 * #1033: on macOS, a herdr-core started over SSH runs outside the desktop GUI session, so
 * `security show-keychain-info` fails and every terminal it starts lacks the login keychain.
 */
function noKeychainThere(machine, detail) {
  const said = detail ? ` (${detail})` : "";
  return new CliError(`herdr-core on ${machine} has no access to the macOS login keychain: "security show-keychain-info" failed${said}, `
    + `typically because an incoming SSH connection started herdr-core outside the desktop GUI (Aqua) session, so any new terminal `
    + `started there would have no Claude Code or gh login. Nothing was started. From a desktop (Aqua) terminal on ${machine} `
    + `(where "security show-keychain-info" exits 0), stop the SSH-born "herdr-core serve" and any SSH-born "herdr-core hold" `
    + `(leave older desktop holders running so existing live terminals stay untouched), remove the SSH-born holder socket, and `
    + `immediately run "hc server status" in the same command line so an incoming SSH reconnect does not start it over SSH again.`);
}

/**
 * #612: `{ run: shipped, tail }` when `command` starts with the table's run (`run`: this
 * computer's programs.json override) whose first word differs from Herdr's shipped run for the
 * same agent key, `tail` the command's words after the override (its model and resume words);
 * null when there is no shipped run to fall back to, or the command isn't built from the table.
 */
function shippedRunFor(agentKey, run, command) {
  const shipped = AGENTS[agentKey]?.run;
  if (!shipped?.length || !run?.length || shipped[0] === run[0]) return null;
  if (command.length < run.length || run.some((word, i) => command[i] !== word)) return null;
  return { run: shipped, tail: command.slice(run.length) };
}

/**
 * The agent `argv` starts, looked for on `machine` under the PATH its pane will get
 * (agentOnMachine: the login shell's, asked once, plus hc's, hc's first when it finds the agent,
 * and the user bin folders; `prepend`'s folders first, a project's pane-env PATH_PREPEND), so a
 * check that passes is a launch that finds it: refused when it
 * isn't there, when the interpreter its #! line names isn't, when a macOS core lacks access to
 * the login keychain (#1033), or when the machine doesn't answer.
 * `shipped` (#612, shippedRunFor): when the table's override isn't there but the shipped run is,
 * that run and `tail` replace the command, with one warning naming the agent and the skipped
 * override's first word; when neither is there the refusal names both. Resolves
 * { path, argv, warnings }: the PATH seatOnMachine starts it with and the command it starts.
 */
async function agentThere(machine, argv, name, prepend = null, shipped = null) {
  const exec = (command, args, opts) => remoteIo.exec(command, args, machine, opts);
  const seen = await agentOnMachine(exec, argv[0], { wait: AGENT_WAIT_S, prepend });
  const quiet = quietOn(machine, seen);
  if (seen.state === "away") throw unreachable(machine, seen);
  if (seen.state === "no-keychain") throw noKeychainThere(machine, seen.detail);
  if (seen.state === "missing" && shipped) {
    const alt = await agentOnMachine(exec, shipped.run[0], { wait: AGENT_WAIT_S, prepend });
    const altQuiet = quietOn(machine, alt);
    if (alt.state === "away") throw unreachable(machine, alt);
    if (alt.state === "no-keychain") throw noKeychainThere(machine, alt.detail);
    if (alt.state === "found") {
      return { path: alt.path, argv: [...shipped.run, ...shipped.tail],
        warnings: [`${name} starts on ${machine} from its shipped run (${shipped.run[0]}), skipping the `
          + `programs.json override here (${argv[0]}), which isn't installed there.`, ...quietWarning(name, altQuiet)] };
    }
    if (alt.state === "no-interpreter") throw noInterpreterThere(name, alt, machine, altQuiet);
    throw notInstalledThere(name, argv[0], machine, altQuiet, shipped.run[0]);
  }
  if (seen.state === "missing") throw notInstalledThere(name, argv[0], machine, quiet);
  if (seen.state === "no-interpreter") throw noInterpreterThere(name, seen, machine, quiet);
  return { path: seen.path, argv, warnings: quietWarning(name, quiet) };
}

/**
 * The hc guard folder beside `automagik-herdr` on `path`, that machine's pane PATH (#624): the
 * pack's or am's `bin/../guard`, with hcGuard.mjs beside it. Resolves `{ dir, why }`: `dir` is
 * null when that machine has no automagik-herdr there, the probe could not run, or the folder
 * a PATH word cannot carry (#643), and `why` says which. A remote dsh-tui seat then gets no
 * guard, and no briefing paragraph claiming one.
 */
const GUARD_PROBE_SH = `PATH=$1; export PATH
p=$(command -v automagik-herdr 2>/dev/null) || exit 4
case $p in /*) ;; *) exit 4 ;; esac
while [ -L "$p" ]; do
  to=$(readlink "$p") || exit 5
  case $to in /*) p=$to ;; *) p=$(dirname "$p")/$to ;; esac
done
dir=$(cd "$(dirname "$p")" && pwd -P) || exit 5
guard=$dir/../\${2:-guard}
[ -x "$guard/hc" ] && [ -f "$dir/../hcGuard.mjs" ] || exit 4
cd "$guard" && pwd -P`;
/** `folder`: `guard` (a dsh-tui seat's full guard) or the `hc kill` shim's (#955, every other agent). */
async function guardThere(machine, path, folder = "guard") {
  if (typeof path !== "string" || !path) return { dir: null, why: "it gave no pane PATH to probe" };
  const r = await remoteIo.exec("sh", ["-c", GUARD_PROBE_SH, "sh", path, ...(folder === "guard" ? [] : [folder])], machine, { timeout: AGENT_WAIT_S });
  if (r.code === -1) {
    return { dir: null, why: `its guard probe could not run there (${hcSaid(r.stderr) || "no answer"})` };
  }
  if (r.code === 4) {
    return { dir: null, why: `no automagik-herdr with ${folder}/hc and hcGuard.mjs beside it was found on its pane PATH` };
  }
  if (r.code !== 0) {
    return { dir: null, why: `its guard probe failed there (${hcSaid(r.stderr) || `exit ${r.code}`})` };
  }
  const dir = r.stdout.trim();
  // A guard folder goes into one PATH word: an absolute path with no control character, space
  // or colon. #643 refuses the rest rather than break the word.
  // eslint-disable-next-line no-control-regex
  if (!dir.startsWith("/") || /[\x00-\x1f\x7f]/.test(dir)) {
    return { dir: null, why: "its guard probe named no usable absolute folder" };
  }
  if (/[ :]/.test(dir)) {
    return { dir: null, why: `the guard folder it found there (${dir}) has a space or a colon, so it cannot go on PATH` };
  }
  return { dir, why: null };
}

/**
 * A project's pane-env on `machine` (agentPath.mjs paneEnvOf: PATH_PREPEND, HERDR_APP_HOME), read
 * there through hc: { prepend, appHome, refused, warnings }. No file: nothing, so the start is as
 * before #582. A file it refuses, or one that can't be read, is one warning, `refused` and nothing
 * else: the start goes on, and briefingHomeOn then uses no app home there at all.
 */
async function paneEnvOn(machine, key) {
  const path = under(key, PANE_ENV_PATH);
  const none = (why) => ({ prepend: null, appHome: null, refused: true,
    warnings: [`${path} on ${machine} was left out (${why}): the pane starts as it would without it.`] });
  let text;
  try { text = await readRemoteText(remoteIo, machine, path); } catch (e) { return none(e?.message ?? String(e)); }
  const env = paneEnvOf(text);
  return env.error ? none(env.error) : { prepend: env.prepend, appHome: env.appHome, refused: false, warnings: [] };
}

/** That machine's default app home, ~/.config/herdr-app by its own $HOME, or null when it gives none. */
async function appHomeOn(machine) {
  const r = await remoteIo.exec("sh", ["-c", 'printf %s "$HOME"'], machine, { timeout: AGENT_WAIT_S });
  const home = r.code === 0 ? r.stdout : "";
  // eslint-disable-next-line no-control-regex
  return home.startsWith("/") && !/[\x00-\x1f\x7f]/.test(home) ? `${home.replace(/\/+$/, "")}/.config/herdr-app` : null;
}

/**
 * The app home on `machine` a launch's private file goes in (#582, #823): pane-env's
 * HERDR_APP_HOME, else that machine's ~/.config/herdr-app, and only while that folder is there
 * already: a start never makes an app home on a linked machine (it may be a shared one). A
 * pane-env that was left out means none at all, never the default. Resolves { dir (null: none),
 * warning (why, null when dir) }.
 */
async function launchHomeOn(machine, bot, paneEnv, purpose) {
  const none = (why) => ({ dir: null, warning: `${bot.name} runs on ${machine} without ${purpose}: ${why}` });
  if (paneEnv.refused) return none(`its ${PANE_ENV_PATH} there was left out, so no app home there is used, not even the default one`);
  const dir = paneEnv.appHome ?? await appHomeOn(machine);
  if (!dir) return none(`${machine} gave no home folder for its app home`);
  if ((await remoteIo.exec("test", ["-d", dir], machine, { timeout: AGENT_WAIT_S })).code !== 0) {
    return none(`its app home there, ${dir}, isn't a folder, and a start never makes one. Install Automagik Herdr on ${machine}, `
      + `or set HERDR_APP_HOME in the project's ${PANE_ENV_PATH} there to an app home that is there`);
  }
  return { dir, warning: null };
}

/** launchHomeOn for the briefing (#582): { dir (null: no briefing file and no hook there), warnings (one when null) }. */
async function briefingHomeOn(machine, bot, paneEnv) {
  const home = await launchHomeOn(machine, bot, paneEnv, "its briefing in its system prompt or per turn");
  if (home.dir) return { dir: home.dir, warnings: [] };
  return { dir: null, warnings: [`${home.warning}. Its role and team still come from ${BOTS_PATH}.`] };
}

// A file of the pack's own on `machine` (a briefing), private as briefedLaunch's (0600 in a 0700
// folder). A new one is made under umask 077 with noclobber, so a file that appeared since the read
// is never replaced; one already there is edited by remoteFile.js's compare-and-swap and set to
// 0600 (no "--": BSD chmod reads it as a file after the mode; the path is absolute). Only ever
// under an app home that is there (briefingHomeOn); remoteFile.js's own create is
// left as it is for bots.json.
const PRIVATE_CREATE_SH = 'umask 077; p=$1; mkdir -p -- "${p%/*}" || exit 1; '
  + 'if [ -e "$p" ] || [ -L "$p" ]; then exit 17; fi; set -C; '
  + '{ : > "$p"; } 2>/dev/null || exit 1; '
  + 'printf "%s" "$2" >| "$p" || { rm -f -- "$p"; exit 1; }';
async function ownFileOn(machine, path, text) {
  if (utf8Length(text) > REMOTE_TEXT_MAX) throw new Error(`over ${REMOTE_TEXT_MAX / 1024} KiB, too large to send there`);
  const before = await readRemoteText(remoteIo, machine, path);
  const said = (r) => hcSaid((r.stderr || r.stdout).trim()) || `exit ${r.code}`;
  if (before === null) {
    const r = await remoteIo.exec("sh", ["-c", PRIVATE_CREATE_SH, "sh", path, text], machine, { timeout: AGENT_WAIT_S });
    if (r.code === 17) throw new Error("it appeared there since it was read");
    if (r.code !== 0) throw new Error(`couldn't create it: ${said(r)}`);
    return;
  }
  if (before !== text) await writeRemoteText(remoteIo, machine, path, text, before);
  const r = await remoteIo.exec("chmod", ["600", path], machine, { timeout: AGENT_WAIT_S });
  if (r.code !== 0) throw new Error(`couldn't make it private (chmod 600): ${said(r)}`);
}

/**
 * briefedLaunch on a linked machine (#582): `argv` with the bot's launch briefing put in as the
 * agent takes it (models.js BRIEFING: its file, its text or its environment), a file written on
 * `machine` through hc under `boxHome`, that machine's app home (briefingHomeOn's; null: no file,
 * that warning said why). An agent whose briefing yields
 * to its own config file (BRIEFING's ownConfig: codex, hermes) starts as it is, since only this
 * computer's config is read. Never throws: { argv, env, warnings }.
 */
async function briefedOn(machine, project, bot, agentKey, argv, boxHome, guard = null) {
  if (agentKey === "hermes" && bot.hermes !== undefined) return { argv, env: {}, warnings: [] };
  const way = briefingWay(agentKey);
  const agents = agentTable();
  if (!way || briefingOwnConfig(agentKey) || agentKeyOfArgv(argv, agents) !== agentKey) return { argv, env: {}, warnings: [] };
  const text = launchBriefingText({ self: bot, agent: agentKey, file: project.file, guard, isGit: await projectIsGit(project) });
  const warnings = [];
  let launch = null;
  if (way === "file") {
    const path = boxHome ? briefingFilePath(boxHome, project.key, bot.id) : null;
    try {
      if (path) {
        await ownFileOn(machine, path, `${text}\n`);
        launch = briefingLaunch(agentKey, { path });
      }
    } catch (e) {
      warnings.push(`${bot.name} starts on ${machine} without its briefing in its system prompt (${path}: ${e?.message ?? e}).`);
    }
  } else {
    launch = briefingLaunch(agentKey, { text });
  }
  return { argv: withBriefing(agentKey, argv, launch, agents), env: launch?.env ?? {}, warnings };
}

// installHook's io on a linked machine: git and the files there, through hc (remoteFile.js).
const hookIoOn = (machine) => ({
  git: (args, cwd) => remoteIo.exec("git", args, machine, { cwd, timeout: AGENT_WAIT_S }),
  read: (path) => readRemoteText(remoteIo, machine, path),
  write: (path, text, before) => writeRemoteText(remoteIo, machine, path, text, before),
  mkdir: async () => {}, // writeRemoteText's create makes the folders there (mkdir -p)
});

/**
 * writeBriefingHook on a linked machine (#582): the per-turn hook in `folder`'s
 * .claude/settings.local.json there, running the briefing entry under `boxHome`, that machine's
 * app home. No entry there (the pack isn't installed on it): nothing written, and noHookThere's
 * warning. Never throws: { written, warnings }.
 */
async function briefingHookOn(machine, bot, folder, boxHome) {
  const io = hookIoOn(machine);
  let entry = null;
  try { entry = boxHome ? await io.read(stableBriefingPath(boxHome)) : null; } catch { entry = null; }
  if (entry === null) return { written: false, warnings: [noHookThere(bot, machine)] };
  return installHook(bot.name, folder, boxHome, io);
}

/**
 * Where a start on `machine` goes in Herdr's window: a space of that machine showing the
 * project (its folder, or one keying to it there), else a new one (space.new on that machine),
 * with its `spare` shell (freshSpare, its terminal as a bare id) for closeSpare once the bot
 * shows there; null with no window to ask.
 */
async function windowPlaceOn(machine, key) {
  const find = async () => {
    const r = await runProgram("herdr-app", ["ls"]);
    let spaces;
    try { spaces = r.code === 0 ? spacesOf(JSON.parse(r.stdout)) : null; } catch { spaces = null; }
    if (!spaces) return { spaces: null, hit: null };
    for (const s of spaces.filter((x) => x.machine === machine && x.folder)) {
      let k = s.folder === key ? key : null;
      if (!k) { try { k = (await remoteProjectOf(machine, s.folder)).key; } catch { k = null; } }
      if (k === key) return { spaces, hit: { space: s.id, tab: s.tabs?.find((t) => t.selected)?.id ?? null, from: null } };
    }
    return { spaces, hit: null };
  };
  const seen = await find();
  if (!seen.spaces) return null;
  if (seen.hit) return seen.hit;
  const name = key.replace(/\/+$/, "").split("/").pop();
  const r = await runProgram("herdr-app", ["do", "space.new", JSON.stringify({ name, folder: key, machine })]);
  if (r.code !== 0) return null;
  let out = {};
  try { out = JSON.parse(r.stdout) ?? {}; } catch { /* found in ls instead */ }
  const now = await find();
  const place = now.hit ?? (typeof out.space === "string" ? { space: out.space, tab: null, from: null } : null);
  // The space is this start's when it is the one found: its shell's tab, as windowPlace's.
  const shell = typeof out.terminal === "string" ? bareId(out.terminal) : null;
  const ours = shell && now.spaces?.find((s) => s.id === place?.space && s.machine === machine
    && (s.id === out.space || s.tabs.some((t) => t.panes.some((p) => bareId(p.terminal) === shell))));
  const spare = ours ? freshSpare(ours, shell, (a, b) => bareId(a) === b) : null;
  return spare ? { ...place, spare } : place;
}

/**
 * A bot's pane on the project's linked machine: `hc run --on` with Start's labels and the PATH
 * agentThere checked the agent under (the project's pane-env PATH_PREPEND first), as /usr/bin/env
 * PATH=<it>, and HERDR_APP_HOME=<pane-env's> when it sets one (hc run has no --env; --no-parent: no
 * lead as its hc parent there yet, and never the calling terminal), placed in the window on that machine's space. `over`: argv, cwd, place (the old
 * pane's, a restart), carry (labels kept), replacing (a restart: no "already running" check
 * and no attach row here; restartOnMachine writes them once the new pane is up). The briefing is
 * the local start's (#582): in the command (briefedOn) and, for an agent that takes it, the
 * per-turn hook in that project there (briefingHookOn), both in that machine's app home. Never
 * sends keys to any pane. Resolves { address, terminal (bare), created_ms, machine, core, argv,
 * labels, place, hookWritten, warnings }, or
 * { running } when the ledger names a pane for the bot by the time its lock is taken.
 */
async function seatOnMachine(project, bot, over = {}) {
  refuseLinkedCaller(project);
  const { file, key, machine } = project;
  if (over.recheck) await over.recheck();
  else {
    const observed = await linkedObservation(project, bot);
    if (observed.candidate) return { running: observed.candidate.get.address };
  }
  await checkLinkedProxy(project, bot, over.agent ?? bot.agent);
  const m = await connectedMachine(machine, "nothing was started");
  const agentKey = over.agent ?? bot.agent;
  const agent = agentTable()[agentKey];
  if (!agent?.run?.length) throw new CliError(`${bot.name}'s coding agent "${agentKey}" isn't one Herdr can start.`);
  // Antigravity's mode: validated even when over.argv (a restart's plan) already carries it.
  const agyMode = launchAgyMode(bot, agentKey);
  if (!over.argv && bot.model) {
    // #1173: the target's own model list, when it has one, not the controller's stale cache.
    const list = await modelsOnMachine(machine, key, bot.agent);
    if (list !== null && !list.includes(bot.model)) {
      throw new CliError(`${bot.name} is pinned to "${bot.model}", which isn't on ${machine}'s ${bot.agent} model list. `
        + `Pick one with am edit ${bot.id} --model <model> --machine ${machine} --project ${key}, or clear it with --no-model.`);
    }
  }
  const paneEnv = await paneEnvOn(machine, key);
  // #823: agy reads its permission list from a file on its own machine, under that machine's
  // app home; with none there the start is refused rather than launched without its list.
  // #1033: plan the path first so `command` and `agentThere` run before `ownFileOn` writes the
  // file on `machine` (a refused non-GUI Mac or missing agent writes nothing there).
  let agySettings = null;
  if (agentKey === "antigravity") {
    const agyHome = await launchHomeOn(machine, bot, paneEnv, "its Antigravity permission list");
    if (!agyHome.dir) throw new CliError(`${agyHome.warning}. Nothing was started.`);
    // #884 Low A: a linked machine's home folder, derived from its own app home (never this
    // computer's home(), and no extra remote exec): ~/.config/herdr-app sits in it.
    const remoteHome = agyHome.dir.endsWith("/.config/herdr-app") ? agyHome.dir.slice(0, -"/.config/herdr-app".length) : null;
    agySettings = agySettingsPlan({ bot, scope: "seat", folder: over.cwd ?? key, settingsDir: agySettingsDir(agyHome.dir),
      homeDir: remoteHome });
  }
  // Herdr's table as this computer has it (programs.json applied): the Mac builds the command.
  // A Start's command runs on a new session whose id Herdr chooses (Claude), as a local start's
  // does (launchSeat; RFC 0026 (e)): the pane's agent.session label is that machine's own record
  // of the seat's session. A command that picks its own session keeps it; a restart's plan
  // (over.argv) brings its own id, in its argv and its carried label.
  // A Codex --add-dir is left for that machine to weigh (codexOn, #1142): only it can resolve it.
  const source = over.argv ?? [...launchRun(agentKey, agent.run, bot, codexWhereThere()), ...agyModeArgs(agentKey, agyMode), ...modelArgs(bot.agent, bot.model),
    ...seatSettingsArgs(agentKey, bot)];
  const chosen = !over.argv && choosesSession(agentKey) && !ownsSession(source) ? newSessionId() : null;
  const command = agyGuarded(agentKey, withAgySettings(agentKey, chosen ? [...source, ...sessionIdArgs(agentKey, chosen)] : source, agySettings?.path));
  // #612: a local absolute override that isn't there falls back to the shipped run when that is.
  const there = await agentThere(machine, command, agent.name ?? agentKey, paneEnv.prepend,
    shippedRunFor(agentKey, agent.run, command));
  if (agySettings) {
    try { await ownFileOn(machine, agySettings.path, agySettings.text); }
    catch (e) {
      throw new CliError(`${bot.name} wasn't started on ${machine}: its Antigravity permission list couldn't be written `
        + `(${agySettings.path}: ${e?.message ?? e}).`);
    }
  }
  // A remote dsh-tui seat gets the guard its own machine has, resolved there (#624); with none,
  // no guard on PATH and no briefing paragraph claiming one, and one warning says what the
  // probe found: no guard, a failed probe, or a folder a PATH word cannot carry (#643).
  // Any other agent gets that machine's `hc kill` shim the same way (#955), and is told when it has none.
  const remote = await guardThere(machine, there.path, agentKey === "dsh-tui" ? "guard" : KILL_GUARD_NAME);
  const remoteGuard = remote?.dir ?? null;
  const guardWarnings = remoteGuard ? []
    : agentKey === "dsh-tui"
      ? [`${bot.name} runs on ${machine} without the hc guard (#624): ${remote?.why ?? "its guard was not found"}; `
        + `its hc calls are not guarded.`]
      : [`${bot.name} runs on ${machine} without the hc kill shim (#955): ${remote?.why ?? "its shim was not found"}; `
        + `nothing there stops its hc kill.`];
  // The briefing there, as a local start has it (#582), in that machine's app home while it is
  // there (briefingHomeOn: asked only when a file or the hook needs one; never made).
  const needsHome = !briefingOwnConfig(agentKey) && (briefingWay(agentKey) === "file" || briefingHook(agentKey));
  const briefingHome = needsHome ? await briefingHomeOn(machine, bot, paneEnv) : { dir: null, warnings: [] };
  const briefed = await briefedOn(machine, project, bot, agentKey, there.argv, briefingHome.dir,
    agentKey === "dsh-tui" ? Boolean(remoteGuard) : null);
  // #1125: a Codex seat there gets the folders that machine derives for its folder, and its own
  // --add-dir words are weighed there too (#1142: resolved on that machine, never this one).
  const codexHere = agentKey === "codex" ? await codexOn(machine, over.cwd ?? key, paneEnv, briefed.argv) : null;
  const argv = codexHere ? withCodexGrants(codexHere.argv, codexHere.dirs) : briefed.argv;
  const codexNotes = [codexHere?.warning, agentKey === "codex" ? codexCleanNote(agent.run, codexWhereThere()) : null].filter(Boolean);
  // The hook goes in before the session starts, so Claude Code reads it at startup.
  const hook = briefingHook(agentKey) && briefingHome.dir ? await briefingHookOn(machine, bot, over.cwd ?? key, briefingHome.dir)
    : { written: false, warnings: [] };
  const env = { ...(paneEnv.appHome ? { HERDR_APP_HOME: paneEnv.appHome } : {}), ...briefed.env, ...hermesPairEnv(bot) };
  const carry = over.carry ?? {};
  const labels = { ...paneLabels(file, bot.id, carry, null), ...carry };
  if (chosen) labels[SESSION_LABEL] = chosen;
  const taken = new Set(rowsOf(await hcJson(["ls"])).map((r) => r?.name).filter(Boolean));
  // A start: that space only, the bot in a tab of its own (as launchSeat).
  if (over.place === undefined && deadlineLeft() < DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS) {
    throw tooLate(bot, machine, key, DEADLINE_MARGIN_MS + DEADLINE_PLACE_MS);
  }
  const place = over.place !== undefined ? over.place : spaceOnly(await windowPlaceOn(machine, key));
  const name = hcName(bot.name, bot.id, taken);
  const args = startArgs({ botId: bot.id, name, cwd: over.cwd ?? key, space: place?.space, tab: place?.tab,
    // No hc parent: hc run's default is the terminal it is started from, and the pane would end with it.
    parent: ["--no-parent"], argv, labels, path: there.path, env, agent: agentKey, guard: remoteGuard });
  args.splice(1, 0, "--on", machine);
  const warnings = [...paneEnv.warnings, ...there.warnings, ...guardWarnings, ...briefingHome.warnings, ...briefed.warnings, ...hook.warnings,
    ...(agySettings?.warnings ?? []), ...codexNotes];
  const run = async () => {
    if (deadlineLeft() < DEADLINE_MARGIN_MS) throw tooLate(bot, machine, key, DEADLINE_MARGIN_MS, place?.spare ? place.space : null);
    const r = await hc(args, callBound());
    // Ended at its bound, hc run may still have started the pane there: looked for by name below.
    if (r.code !== 0 && !r.killed) throw new CliError(`hc run on ${machine} failed: ${hcSaid((r.stderr || r.stdout).trim())}`);
    let address = null;
    try { address = r.killed ? null : JSON.parse(r.stdout).address ?? null; } catch { address = null; }
    if (typeof address !== "string" || !address.includes("/")) {
      // It may run anyway: found by the name it was given (hc ls) and ended, never left beside the bot's pane.
      let stray = null;
      try { stray = rowsOf(parsed(await hc(["ls", "--json"], callBound()), ["ls"])).find((x) => x?.name === name && String(x.address ?? "").startsWith(`${machine}/`))?.address ?? null; } catch { stray = null; }
      const killed = stray ? (await hcKill(stray, callBound())).code === 0 : false;
      const said = r.killed ? `didn't answer within ${(DEADLINE === null ? 15000 : DEADLINE_CALL_MS) / 1000} s` : `gave no terminal address (${r.stdout.trim() || "nothing"})`;
      throw new CliError(`hc run on ${machine} ${said}; `
        + (killed ? `the pane it started (${stray}, named ${name}) was ended.` : `if a pane named ${name} started there, end it with hc kill.`));
    }
    const get = await hcGet(address, callBound()).catch(() => null);
    if (!Number.isSafeInteger(get?.created_ms)) {
      // No created_ms: no row can name it, so it isn't left running beside the bot's pane.
      const killed = (await hcKill(address, callBound())).code === 0;
      throw new CliError(`${address} started, but hc get gave no created_ms, so it could have no attach row; `
        + (killed ? "it was ended." : `it couldn't be ended: end it with hc kill ${address}.`));
    }
    return { address, terminal: address.slice(address.indexOf("/") + 1), created_ms: get.created_ms, machine, core: m.id, argv, labels, place,
      hookWritten: hook.written, warnings };
  };
  if (over.replacing) return underLedger(async () => { await over.recheck(); return run(); });
  const seat = await underLedger(async ({ write }) => {
    const observed = await linkedObservation(project, bot);
    if (observed.core !== m.id) throw new CliError(`${machine}'s core changed before launch; nothing was started.`);
    if (observed.candidate) return { running: observed.candidate.get.address };
    const seat = await run();
    try {
      write([attachRow({ event: "attach", bot: bot.id, project: key, terminal: seat.terminal, core: m.id, created_ms: seat.created_ms, machine, by: "start" })]);
    } catch (e) {
      throw new CliError(`${seat.address} runs, but its attach row wasn't written (${e?.message ?? e}): attach it with `
        + `am attach ${bot.id} ${seat.address} --machine ${machine} --project ${key}`);
    }
    return seat;
  });
  // A space this start made: its spare shell's tab closed once the bot shows there (closeSpare).
  if (!seat.running && place?.spare && TAB_WAIT_MS > 0) {
    // Under a deadline its waits (TAB_WAIT_MS, then four calls) don't fit: the tab stays, said.
    const why = DEADLINE !== null ? `The new space's spare shell tab wasn't closed: this Herdr's 30 s limit for the sidebar's programs leaves no time for it.`
      : await closeSpare(place.spare, seat.terminal, machine);
    if (why) seat.warnings.push(why);
  }
  return seat;
}

const seatOnJson = (bot, seat) => ({ id: bot.id, terminal: seat.terminal, machine: seat.machine,
  argv: maskedArgv(seat.argv, seat.labels?.[SESSION_LABEL] ?? null), labels: maskedLabels(seat.labels),
  space: seat.place?.space ?? null, tab: seat.place?.tab ?? null, hookWritten: seat.hookWritten ?? false, warnings: seat.warnings });

/** The remote seat briefing has no supported cross-origin parent/return registration.
 * Refuse orchestration rather than fabricate a reverse alias or forward a bare caller id.
 * A target-local am invoked through remote exec has already lost that origin provenance;
 * absence of HC_TERMINAL_ID here cannot detect or repair that case.
 */
function refuseLinkedCaller(project) {
  if (!project.machine || !process.env.HC_TERMINAL_ID) return;
  throw new CliError(`Linked am launch cannot verify a return route to the requesting HC terminal; nothing was started or restarted. `
    + `From the origin HC terminal use hc run --bg --on ${project.machine} with its real default or explicit HC parent and explicit first-task/report instructions. `
    + `Use the returned ${project.machine}/tN address at the origin. Remote exec of local am loses origin provenance and is not a supported return-route workaround.`,
  1, { refused: "linked-return-route" });
}

/** start --machine: the bot's pane there (seatOnMachine); one that runs already is reported. */
async function startOnMachine(opts, project, bot) {
  const observed = await linkedObservation(project, bot);
  if (observed.candidate) {
    const at = observed.candidate.get.address;
    return opts.json ? { id: bot.id, running: at.split("/")[1], machine: project.machine } : `${bot.name} is already running in ${at}.`;
  }
  refuseLinkedCaller(project);
  if (opts.space) throw new CliError("--space and --tab are this computer's window places; a start on a linked machine finds its own.", 2);
  const seat = await seatOnMachine(project, bot);
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  report(seat.warnings);
  return opts.json ? seatOnJson(bot, seat) : seat.address;
}

// Execute the existing local tree transaction where the panes and worker ledger live.
// Every argument is positional shell data; no controller path or --machine is forwarded.
async function restartTreeOnMachine(opts, project, bot) {
  // A queue on the holding machine would outlive this controller transaction and leave
  // its attachment on the old pane. The sidebar's explicit helper choice is immediate.
  if (!opts.force) throw new CliError("Restart with its helpers runs immediately; pass --tree --force to restart them on their machine now.", 2);
  if (opts.space) throw new CliError("A restart on a linked machine keeps the old pane's window place.", 2);
  const { machine, key } = project;
  const m = await connectedMachine(machine, "nothing was restarted");
  const observed = await linkedObservation(project, bot);
  const held = linkedRestartHeld(project, bot, observed);
  const paneEnv = await paneEnvOn(machine, key);
  if (paneEnv.refused) throw new CliError(`The project's pane environment on ${machine} could not be read; fix it and retry the restart.`);
  const args = ["restart", bot.id, "--project", key, "--tree", "--json"];
  for (const flag of ["force", "fresh", "fresh-shared", "save"]) if (opts[flag]) args.push(`--${flag}`);
  for (const flag of ["agent", "model"]) if (opts[flag] !== undefined) args.push(`--${flag}`, opts[flag]);
  const script = `
if [ -n "$1" ]; then HERDR_APP_HOME=$1; export HERDR_APP_HOME; fi
PATH="$HOME/.local/bin:$PATH"
if [ -n "$2" ]; then PATH="$2:$PATH"; fi
export PATH
restart_terminal=$3; restart_bot=$4; restart_project=$5
shift 5
unset HC_TERMINAL_ID
if command -v automagik-herdr >/dev/null 2>&1; then restart_cli=automagik-herdr
elif command -v am >/dev/null 2>&1; then restart_cli=am
else
  printf '%s\\n' 'Automagik is missing on this machine; install it there and retry.' >&2
  exit 127
fi
if [ -n "$restart_terminal" ]; then
  "$restart_cli" attach "$restart_bot" "$restart_terminal" --project "$restart_project" --json >/dev/null || exit $?
fi
exec "$restart_cli" "$@"`;
  await recheckLinkedRestart(project, bot, observed, opts, true);
  const result = await remoteIo.exec("sh", ["-c", script, "sh", paneEnv.appHome ?? "", paneEnv.prepend ?? "",
    held?.binding.terminal ?? "", bot.id, key, ...args], machine, { cwd: key, timeout: 540 });
  let out;
  try { out = JSON.parse(result.stdout); } catch { /* a missing CLI or a lost reply */ }
  if (!out || out.error || !out.terminal) {
    if (result.stderr) console.error(result.stderr);
    const message = out?.error ?? (result.code === 127
      ? `Automagik is missing on ${machine}; install it there and retry.`
      : result.code !== -1 && result.stderr.trim() ? actionError(result.stderr, "Restart")
      : `The restart on ${machine} gave no completion result; inspect its panes before retrying.`);
    throw new CliError(message, 1, out?.refused ? { refused: out.refused, terminal: out.terminal } : undefined);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(out.terminal)) throw new CliError(`The restart on ${machine} returned an invalid pane; inspect its panes before retrying.`);
  if (!out.queued) {
    const address = `${machine}/${out.terminal}`;
    const get = await hcGet(address).catch(() => null);
    if (!get || get.state !== "live" || !Number.isSafeInteger(get.created_ms) || get.labels?.[BOT_LABEL] !== bot.id) {
      throw new CliError(`The restart ran on ${machine}, but its replacement pane could not be confirmed; inspect its panes before retrying.`);
    }
    try {
      await underLedger(async ({ machines, heldBy, holds, write }) => {
        const now = heldBy(bot.id, m.id);
        const sameReplacement = now?.terminal === out.terminal && now.created_ms === get.created_ms && now.project === key;
        if (now && (!held || attachKey(now) !== attachKey(held.binding)) && !sameReplacement && await holds(now)) {
          throw new Error(`${bot.name} was attached to ${addressOf(now, machines)} while it restarted`);
        }
        write([...(now ? [closingRow(now, "detach", "start", "moved")] : []),
          attachRow({ event: "attach", bot: bot.id, project: key, terminal: out.terminal, core: m.id,
            created_ms: get.created_ms, machine, by: "start" })]);
      });
    } catch (e) {
      console.error(e);
      throw new CliError(`${bot.name} restarted in ${address}, but its sidebar attachment could not be saved; attach that pane before restarting again.`);
    }
  }
  exitAfter.code = result.code === 0 ? 0 : 1;
  report(out.warnings ?? []);
  if (result.code !== 0 && result.stderr) console.error(result.stderr);
  return opts.json ? { ...out, machine } : `${bot.name}: ${out.queued ? "restart queued in" : "restarted in"} ${machine}/${out.terminal}.`;
}

/**
 * restart --machine without --tree: the controller manages the replacement. Tree restarts
 * use restartTreeOnMachine instead. The old pane must say whether its agent is busy: one that reports no
 * status to hc (Hermes) is refused unless --force, as is a busy one or one with helpers. The new pane starts in the old one's place and
 * folder, resuming as restartPlan says (an agent's own --continue resumes the folder's latest
 * conversation: refused while another bot's same agent runs in that folder there); the old
 * pane is ended (hc kill) only once the new one has kept its agent in front. No keys are sent.
 */
async function restartOnMachine(opts, project, bot, entry, observed) {
  if (opts.space) throw new CliError("--space and --tab are this computer's window places; a restart on a linked machine keeps the old pane's.", 2);
  const { file, key, machine } = project;
  await checkLinkedProxy(project, bot, opts.agent ?? bot.agent, () => {});
  const m = await connectedMachine(machine, "nothing was restarted");
  const held = linkedRestartHeld(project, bot, observed);
  const old = held?.get ?? null;
  if (old) await checkLinkedRestartPane(bot, old, opts);
  const recheck = () => recheckLinkedRestart(project, bot, observed, opts);
  const agentKey = entry?.agent ?? bot.agent;
  const run = agentTable()[agentKey]?.run;
  if (!run?.length) throw new CliError(`${bot.name}'s coding agent "${agentKey}" isn't one Herdr can start.`);
  // The old pane's agent.session label, as restartPlan reads it for the agent.
  const label = old?.labels?.[SESSION_LABEL] ?? null;
  for (const k of ["agent.session", "revive.session"]) holdId(old?.labels?.[k]);
  // The old pane's launch, only to say when it differs from what the source launches now (#597).
  const oldLaunch = old ? paneCommand(old) : null;
  const planned = {
    // #1142: its Codex --add-dir words are weighed there (codexOn): only that machine resolves them.
    bot, run: launchRun(agentKey, run, bot, codexWhereThere()),
    runningAgent: old ? agentKeyOfArgv(unwrapKeep(old.foreground?.argv), agentTable()) : null, session: label,
    fresh: opts.fresh || (!old && !bot.hermes), agent: entry ? entry.agent : undefined, model: entry ? (entry.model ?? "") : undefined,
    // A new conversation there starts on an id chosen here too (RFC 0026 (e)), as cmdRestart's does.
    newSession: newSessionId(),
  };
  let plan = restartPlan(planned);
  let cwd = key;
  const oldCwd = old?.foreground?.cwd ?? old?.cwd ?? null;
  if (oldCwd && oldCwd !== key) { try { if ((await remoteProjectOf(machine, oldCwd)).key === key) cwd = oldCwd; } catch { /* the project's */ } }
  // Each agent spells resume differently (Codex: resume ID, omp: --resume=ID).
  // Use the same validated identity as a local restart, rather than Claude's flag spelling.
  let session = plan.mode === "resume" && !plan.canonicalBot && resumesById(plan.agent) ? sessionFor(plan.agent, label) : null;
  // #598: dsh-tui's id-less -c only once a turn has finished in the old pane (hc's turn counter;
  // missing or unreadable is 0): else a new conversation, and why, in --json's warnings too (F3).
  let turnNote = null;
  if (plan.mode === "resume" && !session && resumeAfterTurn(plan.agent) && !(Number.isSafeInteger(old?.turn) && old.turn >= 1)) {
    const note = noTurnNote(agentTable(), plan.agent, old);
    plan = { ...restartPlan({ ...planned, fresh: true }), note };
    turnNote = `${bot.name} starts on a new conversation: ${note}.`;
  }
  // With no session id, a resume takes the workspace's latest conversation, which may be one
  // someone started there by hand: refused unless --force, and even then while any other live
  // pane on that machine runs the same agent in that folder (bot or not: hc ls, not the ledger).
  if (plan.mode === "resume" && !session && !plan.canonicalBot) {
    if (!opts.force) {
      throw new CliError(`${old.address} carries no session id, so ${plan.agent} would resume the latest conversation in ${cwd}, `
        + `which may not be ${bot.name}'s (one started there by hand, say). Nothing was restarted. Restart with --fresh for a new `
        + `conversation, or pass --force to resume the latest one.`);
    }
    const rows = rowsOf(await hcJson(["ls"])).filter((r) => typeof r?.address === "string" && r.address.startsWith(`${machine}/`)
      && r.address !== old.address && r.state === "live");
    const gets = (await Promise.all(rows.map((r) => hcGet(r.address).catch(() => null)))).filter(Boolean);
    const sharers = gets.filter((g) => (g.foreground?.cwd ?? g.cwd) === cwd && agentKeyOfArgv(unwrapKeep(g.foreground?.argv), agentTable()) === plan.agent)
      .map((g) => ({ address: g.address, name: file.bots.find((b) => b.id === g.labels?.[BOT_LABEL])?.name ?? "a pane" }));
    const refusal = continueRefusal({ name: bot.name, old, cwd, sharers, agent: agentTable()[plan.agent]?.name ?? plan.agent });
    if (refusal) throw new CliError(refusal);
  }
  let seat = await seatOnMachine(project, bot, { agent: plan.agent, argv: plan.argv, cwd, place: old ? placementFrom([old]) : undefined,
    carry: { ...carriedLabels(old), ...(session ?? plan.sessionId ? { [SESSION_LABEL]: session ?? plan.sessionId } : {}) }, replacing: Boolean(old), recheck });
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  const warnings = [...(turnNote ? [turnNote] : []), ...seat.warnings];
  // #597: the replacement is built from bots.json, never the pane's command; when they differ,
  // one line names only flag names, values masked, and a template by name. A linked machine's
  // templates aren't read here, so a template pane is named rather than resolved.
  if (oldLaunch && !entry && (planned.runningAgent === null || planned.runningAgent === plan.agent)) {
    const template = typeof old?.template === "string" && old.template.trim() ? { name: old.template.trim() } : null;
    const changed = launchChange({ name: bot.name, launch: oldLaunch, agent: plan.agent, argv: plan.source, template });
    if (changed) warnings.push(changed);
  }
  report(warnings);
  if (old) {
    let up = await agentUp(seat.address);
    // Codex can't resume the thread at all (#413): one new pane on a new thread, as cmdRestart does.
    const gone = up.state === "ended" ? await endedCause(seat.address) : null;
    if (providerGone(plan, gone)) {
      const thread = plan.resume[0] === "resume" && plan.resume[1] && plan.resume[1] !== "--last" ? plan.resume[1] : null;
      const note = providerGoneNote(thread, seat.address, gone);
      plan = { ...restartPlan({ ...planned, fresh: true }), note };
      session = null;
      warnings.push(`${bot.name} starts on a new conversation: ${note}.`);
      report([warnings.at(-1)]);
      const again = await seatOnMachine(project, bot, { agent: plan.agent, argv: plan.argv, cwd, place: placementFrom([old]), carry: { ...carriedLabels(old), ...(plan.sessionId ? { [SESSION_LABEL]: plan.sessionId } : {}) }, replacing: true, recheck });
      if (again.running) throw new CliError(`${bot.name} is running in ${again.running} now, so no new pane was started; ${old.address} still runs it, untouched.`);
      warnings.push(...again.warnings);
      report(again.warnings);
      seat = again;
      up = await agentUp(seat.address);
    }
    if (up.state !== "live") {
      if (up.state === "ended") {
        throw await exitedBefore(seat.address, `${old.address} still runs ${bot.name}, untouched.`
          + (plan.mode === "resume" ? ` Try am restart ${bot.id} --machine ${machine} --project ${key} --fresh.` : ""));
      }
      const ended = (await hcKill(seat.address)).code === 0;
      throw new CliError(`${seat.address} didn't keep an agent in front within ${RESTART_WAIT_MS / 1000}s${ended ? ", so it was ended" : ` and couldn't be ended (hc kill ${seat.address})`}; `
          + `${old.address} still runs ${bot.name}, untouched.`);
    }
    const created = Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : seat.created_ms;
    let lost;
    try {
      lost = await underLedger(async ({ machines, heldBy, holds, write }) => {
        const now = heldBy(bot.id, m.id);
        const rows = [];
        if (now && attachKey(now) === attachKey(held.binding)) rows.push(closingRow(held.binding, "detach", "start", "moved"));
        else if (now && now.project !== key) return addressOf(now, machines);
        else if (now && (await holds(now))) return addressOf(now, machines);
        rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal: seat.terminal, core: seat.core, created_ms: created, machine, by: "start" }));
        write(rows);
        return undefined;
      });
    } catch (e) {
      await hcKill(seat.address);
      throw new CliError(`${seat.address} was ended and ${old.address} still runs ${bot.name}: the attach ledger wasn't written (${e?.message ?? e}).`);
    }
    if (lost !== undefined) {
      await hcKill(seat.address);
      throw new CliError(`${bot.name} was attached to ${lost} while it restarted, so ${seat.address} was ended and nothing changed.`);
    }
    // The old pane is the one the ledger moved from, never a terminal id reused there since.
    const before = await hcGet(old.address).catch(() => null);
    if (before && before.created_ms !== held.binding.created_ms) {
      const w = `${old.address} is another terminal now (its created_ms changed), so it wasn't ended; ${seat.address} plays ${bot.name}.`;
      warnings.push(w); report([w]);
    } else if (before) {
    const killed = await hcKill(old.address);
    if (killed.code !== 0) { const w = `${old.address} wasn't ended (hc kill: ${hcSaid((killed.stderr || killed.stdout).trim())}); end it with hc kill ${old.address}.`; warnings.push(w); report([w]); }
    }
  }
  let saved = false;
  if (opts.save) {
    const now = await loadRemoteProject(key, machine);
    const stored = now.raw.bots.find((b) => b?.id === bot.id);
    if (stored) { await saveProject(now, applyBotEdit(now.raw, { ...stored, agent: entry.agent, ...(entry.model ? { model: entry.model } : { model: undefined }), effort: entry.effort, tier: entry.tier })); saved = true; }
  }
  if (!opts.json) report([`${bot.name}: ${old ? `${seat.address} replaces ${old.address}, ${restartText(plan, session)}` : `${bot.name} wasn't running; started in ${seat.address}`}${saved ? `; ${BOTS_PATH} now says ${plan.agent}` : ""}.`]);
  return opts.json ? { ...seatOnJson(bot, seat), warnings, replaced: old ? held.binding.terminal : null, mode: old ? plan.mode : "start",
    agent: plan.agent, model: plan.model, session: session ? SESSION_MASK : null, note: plan.note, saved } : seat.address;
}

/**
 * Absolute path `p` as this computer resolves it (#1142), with filesystem semantics: the realpath
 * of its nearest part that is there (the kernel follows each symlink, then each `..` from where
 * it led), then the rest of `p` (no symlink can hide in a part that isn't there). Null when that
 * can't be proved: a part that is a file, a symlink that points nowhere, or a `..` in the rest.
 */
export function canonHere(p) {
  let base = p, rest = "";
  for (;;) {
    try {
      const real = realpathSync.native(base);
      if (rest && !statSync(real).isDirectory()) return null;
      return rest ? `${real === "/" ? "" : real}${rest}` : real;
    } catch (e) {
      if (e?.code !== "ENOENT") return null;
      try { lstatSync(base); return null; } catch { /* not there at all: its parent decides */ }
    }
    if (base === "/") return null;
    const i = base.lastIndexOf("/");
    if (base.slice(i + 1) === "..") return null;
    rest = `${base.slice(i)}${rest}`;
    base = base.slice(0, i) || "/";
  }
}

/**
 * A path's identity on this computer (#1142): "dev:ino" (bigint, exact), symlinks followed, or
 * null when it can't be observed: any stat failure (a missing path, EACCES, a loop) is unknown.
 */
export function idHere(p) {
  try {
    const st = statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** This computer's Codex launch rules (models.js codexWhere): its home folder and app home, resolved here, objects told apart here. */
const localWhere = () => codexWhere({ home: home(), appHome: appHome(), resolve: canonHere, id: idHere });

/**
 * The folders a Codex launch in `cwd` on this computer may write besides it (#1125,
 * models.js codexGrantPlan): `cwd`'s own git dir and its git common dir (a linked worktree's
 * `.git/worktrees/<name>` and its main checkout's .git), herdr-core's state and data folders
 * and the tool caches, from this process's environment, each resolved and observed here (#1142)
 * and only when it is a folder here: { dirs, unproved }. Never fails: a folder git can't answer
 * for just has no git grant.
 */
async function localCodexGrantPlan(cwd) {
  const out = cwd ? await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd) : null;
  const [gitDir, gitCommonDir] = (out ?? "").split("\n").map((l) => l.trim());
  return { ...codexGrantPlan({ where: localWhere(), home: home(), env: process.env, gitDir: gitDir || null, gitCommonDir: gitCommonDir || null, isDir: dirHere }),
    gitDir: gitDir || null, gitCommonDir: gitCommonDir || null };
}

/** codexGrantPlan's isDir here (#1142): true, false when it isn't there (or isn't a folder), null when stat fails otherwise. */
export function dirHere(p) {
  try {
    return statSync(p).isDirectory();
  } catch (e) {
    return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : null;
  }
}

/**
 * The one withheld-folders warning of a Codex launch here (#1142, models.js codexWithheldWarning):
 * its source's own --add-dir words (`run`, weighed as launchRun weighs them) and `plan`'s derived
 * folders, each withheld or passed folder counted once. Null when nothing was withheld.
 */
function localCodexWarning(run, plan) {
  const source = codexClean(run ?? [], localWhere());
  return codexWithheldWarning(new Set([...source.unproved, ...plan.unproved]).size, new Set([...addDirValues(source.argv), ...plan.dirs]).size);
}

// The environment words codexGrantPaths reads, printed on a linked machine one per line as NAME=value
// (printenv per name: never the whole environment), then its git dirs for the launch folder.
const GRANT_VARS = CODEX_DIR_VARS;
const GRANT_PROBE = `for k in ${GRANT_VARS.join(" ")}; do v=$(printenv "$k") && printf '%s=%s\\n' "$k" "$v"; done; `
  + `g=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) && printf 'GIT_DIR=%s\\n' "$g"; `
  + `g=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && printf 'GIT_COMMON_DIR=%s\\n' "$g"; true`;
// Each path argument as that machine resolves it (#1142), with filesystem semantics: path, TAB,
// its canonical form (the nearest part there through cd -P and pwd -P, which follow each symlink
// and then each `..` physically, then the rest; "-" when a part is a file or a dangling link, or a
// `..` falls in the rest), TAB, 1 when the path itself is a folder there.
export const RESOLVE_PROBE = 'for p do b=$p; r=; out=; while :; do '
  + 'if [ -d "$b" ]; then c=$(cd -P "$b" 2>/dev/null && pwd -P) && { out=${c%/}$r; [ -n "$out" ] || out=/; }; break; fi; '
  + 'if [ -e "$b" ] || [ -L "$b" ]; then break; fi; [ "$b" = / ] && break; [ "${b##*/}" = .. ] && break; '
  + 'r=/${b##*/}$r; b=${b%/*}; [ -n "$b" ] || b=/; done; '
  + 'd=0; [ -n "$out" ] && [ -z "$r" ] && d=1; printf "%s\\t%s\\t%s\\n" "$p" "${out:--}" "$d"; done; true';

/** RESOLVE_PROBE's answer as { resolve, isDir } for models.js codexWhere and codexGrants: unknown paths resolve to null. */
export function resolvedThere(stdout) {
  const canon = new Map(), dirs = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    const [path, real, dir] = line.split("\t");
    if (!path || real === undefined) continue;
    const c = real === "-" ? null : cleanPath(real);
    canon.set(path, c);
    if (c && dir === "1") dirs.add(c);
  }
  return { resolve: (p) => canon.get(p) ?? null, isDir: (p) => dirs.has(p) };
}

// Each path's identity on that machine (#1142): the first argument is the home folder, the rest
// the paths to observe. It picks stat -L's GNU (-c) or BSD (-f) form on the home folder first
// ("unsupported" when neither prints dev:ino there), prints ok, then per path its dev:ino, or ?
// when that stat fails or prints anything else: a failed observation is never an identity.
export const IDENTITY_PROBE = 'h=$1; shift; f=; '
  + 'for g in c f; do i=$(stat -L -$g %d:%i "$h" 2>/dev/null) || continue; case $i in *[!0-9:]*|*:*:*) ;; [0-9]*:[0-9]*) f=$g; break;; esac; done; '
  + 'if [ -z "$f" ]; then echo unsupported; exit 0; fi; echo ok; '
  + 'for p do i=$(stat -L -$f %d:%i "$p" 2>/dev/null) || i="?"; '
  + 'case $i in *[!0-9:]*|*:*:*) i="?";; [0-9]*:[0-9]*) ;; *) i="?";; esac; printf "%s\\n" "$i"; done; true';

/** IDENTITY_PROBE's answer for `paths` as `id(p)`: "dev:ino", or null (unsupported, short or malformed output, a failed stat). */
export function idsThere(stdout, paths) {
  const lines = String(stdout ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const known = new Map();
  if (lines[0] === "ok" && lines.length === paths.length + 1) {
    paths.forEach((p, i) => { if (/^\d+:\d+$/.test(lines[i + 1])) known.set(p, lines[i + 1]); });
  }
  return (p) => known.get(p) ?? null;
}

/** The values of a Codex argv's `--add-dir` words, before any `--`. */
const addDirValues = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length && argv[i] !== "--"; i += 1) {
    if (argv[i] === "--add-dir" && i + 1 < argv.length) out.push(argv[++i]);
    else if (argv[i].startsWith("--add-dir=")) out.push(argv[i].slice("--add-dir=".length));
  }
  return out;
};

/**
 * A Codex launch on `machine` (#1125, #1142), resolved there and never against this computer:
 * that machine's home folder and effective app home (`paneEnv`'s HERDR_APP_HOME as launchHomeOn
 * picks it, the shell's, and the default under its home, all protected), its own realpaths for
 * each path weighed, its git dirs for `cwd` and its environment. `argv` loses each `--add-dir`
 * those rules don't allow (all of them when the machine can't be asked); `dirs` are the folders it
 * derives (codexGrants). { argv, dirs, warning }.
 */
async function codexOn(machine, cwd, paneEnv, argv) {
  const blind = { home: null, appHomes: [], canon: () => null };
  const away = (why) => ({ argv: codexKeepDirs(argv, blind).argv, dirs: [],
    warning: `${machine}: Codex's folders couldn't be read there (${why}). ${codexWithheldWarning(1, 0)}` });
  const r = await remoteIo.exec("sh", ["-c", GRANT_PROBE], machine, { cwd });
  if (r.code !== 0) return away(r.code === -1 ? "no answer" : `exit ${r.code}`);
  const env = {};
  for (const line of String(r.stdout ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (!absPath(env.HOME)) return away("no home folder");
  const appHomes = [paneEnv?.appHome, env.HERDR_APP_HOME].filter(Boolean);
  // One inventory (#1142): the paths probed here are the paths codexGrantPlan weighs.
  const inventory = codexGrantPaths({ home: env.HOME, env, gitDir: env.GIT_DIR ?? null, gitCommonDir: env.GIT_COMMON_DIR ?? null });
  // Sent as cleanPath leaves them, `..` included: that machine resolves each (#1142).
  const paths = [...new Set([env.HOME, `${env.HOME}/.config/herdr-app`, ...appHomes, ...inventory.candidates, ...inventory.general, ...addDirValues(argv)]
    .map(cleanPath).filter(Boolean))];
  const there = await remoteIo.exec("sh", ["-c", RESOLVE_PROBE, "sh", ...paths], machine);
  if (there.code !== 0) return away(there.code === -1 ? "no answer" : `exit ${there.code}`);
  const { resolve, isDir: dirThere } = resolvedThere(there.stdout);
  const plain = codexWhere({ home: env.HOME, appHome: appHomes, resolve });
  if (plain.unproved.length) return away(`${plain.unproved.join(" and ")} can't be resolved there`);
  // Identity there (#1142): each folder weighed, the home folder, each app home and each general
  // folder, with every folder above them, observed by that machine's stat (codexDirVerdict).
  const whole = inventory.general.map((g) => plain.canon(g)).filter(Boolean);
  const weighed = [...new Set([...inventory.candidates, ...addDirValues(argv)].map((p) => plain.canon(p)).filter(Boolean))];
  const observed = [...new Set([plain.home, ...plain.appHomes, ...whole, ...weighed].flatMap(chainOf))];
  const ids = await remoteIo.exec("sh", ["-c", IDENTITY_PROBE, "sh", plain.home, ...observed], machine);
  const where = codexWhere({ home: env.HOME, appHome: appHomes, resolve, id: idsThere(ids.code === 0 ? ids.stdout : "", observed) });
  const kept = codexKeepDirs(argv, where);
  const plan = codexGrantPlan({ where, env, isDir: dirThere, paths: inventory });
  const withheld = codexWithheldWarning(new Set([...kept.unproved, ...plan.unproved]).size, new Set([...addDirValues(kept.argv), ...plan.dirs]).size);
  const warnings = [kept.dropped
    ? `${machine}: an --add-dir in Codex's command names the home folder, an app home, a folder above one or a relative path: left out (#1142).` : null,
  withheld ? `${machine}: ${withheld}` : null].filter(Boolean);
  return { argv: kept.argv, dirs: plan.dirs, warning: warnings.length ? warnings.join(" ") : null };
}

/** Canonical `p` and each folder above it, up to the root. */
const chainOf = (p) => {
  const out = [];
  for (let c = p; ; c = c.slice(0, c.lastIndexOf("/")) || "/") { out.push(c); if (c === "/") return out; }
};

/** The agent a bot starts on, from Herdr's table: refused when it isn't one, or isn't installed. */
function startableAgent(bot, agentKey = bot.agent) {
  const agent = agentTable()[agentKey];
  if (!agent?.run?.length) throw new CliError(`${bot.name}'s coding agent "${agentKey}" isn't one Herdr can start.`);
  if (!onPath(agent.run[0])) throw new CliError(`${agent.name} (${agent.run[0]}) isn't installed on this computer.`);
  return agent;
}

// Output never shows a session id (RFC 0021): the argv's --session-id value and the label as ***.
const maskedLabels = (labels) => (labels?.[SESSION_LABEL] ? { ...labels, [SESSION_LABEL]: SESSION_MASK } : labels);
const seatJson = (bot, seat) => ({ id: bot.id, terminal: seat.terminal, parent: seat.parent[0] === "--parent" ? seat.parent[1] : null,
  argv: maskedArgv(seat.argv, seat.session), labels: maskedLabels(seat.labels), space: seat.place?.space ?? null, tab: seat.place?.tab ?? null, hookWritten: seat.hook.written, warnings: seat.hook.warnings });

/**
 * Starts a bot's pane on this computer (Start, and Restart's replacement): the agent and its
 * model pin, the A1 parent, the A16 labels, the place in Herdr's window, the briefing hook, the
 * attach row (by "start", under the ledger's lock) and the seat row. `over` (Restart): `argv`
 * (the whole command, checked by the caller), `agent`, `model`, `cwd`, `place` (undefined:
 * placementOf the project), `carry` (labels kept from the old pane), `replacing` (the old pane's
 * binding: hc run alone, past the "already running" check; the attach rows are restart's, once
 * the new pane has stayed up, and the seat row is left to `logSeat(createdMs)`), `session` (the
 * session the restart's command runs: the id it chose with --session-id, or the one it resumes;
 * Claude's goes on the pane as its agent.session label and in the seat row). A Start of a Claude
 * bot whose command picks no session of its own (ownsSession) runs on a session id chosen here
 * (RFC 0021 (f) 2). A pane of a CLI that
 * runs with HERDR_APP_HOME set also gets it as an env word (#650), as a linked machine's pane
 * gets the project's pane-env one. Resolves { terminal,
 * created_ms, parent, argv, labels, place, hook, logSeat, session }, or { running } when the
 * ledger names another terminal for the bot by the time the lock is taken.
 */
async function launchSeat(project, bot, over = {}) {
  const { file, key } = project;
  const agentKey = over.agent ?? bot.agent;
  const model = over.argv ? (over.model ?? null) : bot.model;
  // A12: a pin that isn't one of the agent's listed models (an old free-text model) is refused.
  if (!over.argv && bot.model && !modelList(bot.agent, bot.model).includes(bot.model)) {
    throw new CliError(`${bot.name} is pinned to "${bot.model}", which isn't a ${bot.agent} model this computer lists. `
      + `Pick one with am edit ${bot.id} --model <model> (the error lists them), or clear it with --no-model.`);
  }
  const agent = startableAgent(bot, agentKey);
  // Antigravity always gets a mode (auto by default); every other agent's argv is unchanged.
  const agyMode = launchAgyMode(bot, agentKey);
  // Where the launch works: a restart's --cwd (its canonical path), else the project folder. The
  // permission file trusts this folder (#884), so it is resolved before the file is planned.
  const cwd = over.cwd ? (realDir(over.cwd) ?? over.cwd) : key;
  // #823: the session's permission list, written private under the app home before the launch;
  // a restart's plan names the same file, so it is written again with the roster as it is now.
  const agySettings = agentKey === "antigravity"
    ? (over.agySettings ?? agySettingsPlan({ bot, scope: "seat", folder: cwd, settingsDir: agySettingsDir(appHome()),
      realpath: realDir, homeDir: home() })) : null;
  if (agySettings) writeAgySettingsFile(agySettings, bot);
  // A1: the effective lead's live terminal as parent, outliving it; the main bot has none.
  const lead = bot.kind === "member" ? effectiveLead(file, bot.id).lead : "";
  const leadGet = lead ? await attachedGet(lead) : null;
  const leadLive = leadGet?.address ?? null;
  const parent = parentArgs(file, bot.id, (id) => (id === lead ? leadLive : null));
  const carry = over.carry ?? {};
  const labels = { ...paneLabels(file, bot.id, carry, lead ? leadPane(await liveRows(lead))?.labels ?? null : null), ...carry }; // A16
  const taken = new Set(rowsOf(await hcJson(["ls"])).map((r) => r?.name).filter(Boolean));
  // A Start's command, on a new session whose id Herdr chooses (Claude), unless it picks its own.
  const source = over.argv ?? [...launchRun(agentKey, agent.run, bot, localWhere()), ...agyModeArgs(agentKey, agyMode), ...modelArgs(bot.agent, bot.model),
    ...seatSettingsArgs(agentKey, bot)];
  const chosen = !over.argv && choosesSession(agentKey) && !ownsSession(source) ? newSessionId() : null;
  const session = over.argv ? (over.session ?? null) : chosen;
  if (session && agentKey === "claude") labels[SESSION_LABEL] = session;
  // The briefing goes into the command itself (start and restart alike), so no hook prints it every turn.
  const seatArgv = chosen ? [...source, ...sessionIdArgs(agentKey, chosen)] : source;
  const briefed = await briefedLaunch(project, bot, agentKey, agyGuarded(agentKey, withAgySettings(agentKey, seatArgv, agySettings?.path)));
  if (agySettings?.warnings?.length) briefed.warnings.push(...agySettings.warnings);
  // #955: a roster that names Antigravity's auto mode on a host that can't run it is told so.
  const modeWarning = agentKey === "antigravity" ? agyModeWarning({ name: bot.name, explicit: bot.agyMode ?? null, sandbox: hostAgySandbox() }) : null;
  if (modeWarning) briefed.warnings.push(modeWarning);
  // #1125: a Codex seat runs the pack's Codex launch mode, with an --add-dir for each folder this
  // launch in `cwd` may write (unless a restart's template plan carries them already); a
  // programs.json run's own approval and sandbox words were left out, and that is said.
  const cleaned = agentKey === "codex" ? codexCleanNote(agent.run, localWhere()) : null;
  if (cleaned) briefed.warnings.push(cleaned);
  const codexPlan = agentKey === "codex" && !over.granted ? await localCodexGrantPlan(cwd) : null;
  const codexWithheld = codexPlan ? localCodexWarning(agent.run, codexPlan) : null;
  if (codexWithheld) briefed.warnings.push(codexWithheld);
  const argv = codexPlan ? withCodexGrants(briefed.argv, codexPlan.dirs) : briefed.argv;
  // As a worker (cmdWorker): the pane gets this PATH, with an npm agent's (#!/usr/bin/env node,
  // like codex) interpreter folder first when it lacks it (#56); start and restart both come
  // here. Always passed (#213): without it the pane has herdr-core's PATH, which may lack node.
  const runPath = launchPath(argv[0], cwd);
  const path = runPath.path;
  // A restart's own place (the old pane's space and tab) stands; a start asks the window too:
  // one herdr-app ls, shared by placementOf (a label whose space doesn't show the project is
  // dropped) and windowPlace (an open space on the project, else a new one). The space only:
  // the bot opens in a tab of its own, never another pane's (start --tab picks one).
  let place = over.place;
  if (place === undefined) {
    const seen = await windowSpaces();
    place = spaceOnly(await windowPlace(key, await placementOf(key, seen), seen));
  }
  // The Claude login this launch uses (#453): read from claude-logins.json now, Claude only.
  const login = over.login?.words ?? claudeLogin(argv, briefed.warnings);
  if (over.login) briefed.warnings.push(...over.login.warnings);
  const proxyOn = agentKey === "dsh-tui" && proxyEnabled(
    approvedProxyState({ project: key, bot }), process.platform,
    (warning) => briefed.warnings.push(warning));
  const env = { ...(process.env.HERDR_APP_HOME ? { HERDR_APP_HOME: appHome() } : {}),
    ...briefed.env, ...hermesPairEnv(bot) };
  const name = hcName(bot.name, bot.id, taken);
  const args = startArgs({ botId: bot.id, name, cwd, space: place?.space, tab: place?.tab, parent, argv, labels, path,
    env, login, agent: agentKey, project: key, sandbox: proxyOn });
  // The hook goes in before the session starts, so Claude Code reads it at startup.
  const hook = agentKey === "claude" ? await writeBriefingHook(bot, cwd) : { written: false, warnings: [] };
  hook.warnings.unshift(...briefed.warnings);
  if (runPath.note) hook.warnings.unshift(runPath.note);
  report(hook.warnings);
  const run = async (ledger) => {
    // #1262: hc waits 60 s for the new terminal's first status, so the run gets its own timeout
    // above that wait; a timeout after hc made the terminal is a start looked up by its name
    // (the attach row is still written), never a failed start.
    const { address, late } = await hcStartRun(hc, args, name);
    if (late) {
      const warning = `${name} started, but hc run didn't answer within ${HC_RUN_TIMEOUT_MS / 1000}s; its start is recorded.`;
      hook.warnings.push(warning);
      report([warning]);
    }
    const get = await hcGet(address).catch(() => null);
    if (ledger) {
      if (!Number.isSafeInteger(get?.created_ms)) {
        throw new CliError(`${address} runs, but hc get gave no created_ms, so it has no attach row: attach it with am attach ${bot.id} ${address}`);
      }
      try { ledger.write([attachRow({ event: "attach", bot: bot.id, project: key, terminal: address, core: ledger.core, created_ms: get.created_ms, by: "start" })]); } catch (e) {
        throw new CliError(`${address} runs, but its attach row wasn't written (${e?.message ?? e}): attach it with am attach ${bot.id} ${address}`);
      }
    }
    return { terminal: address, created_ms: get?.created_ms ?? null, pid: get?.foreground?.pid ?? get?.pid ?? null };
  };
  // Start: under the ledger's lock, still unattached, then hc run and the attach row (by
  // "start"). Restart: hc run alone (the old pane still holds the bot).
  const started = over.replacing ? await run(null) : await underLedger(async ({ core, byBot, holds, write }) => {
    const now = await holds(byBot.get(bot.id));
    if (now) return { running: now.binding.terminal };
    return run({ core, write });
  });
  if (started.running) return { running: started.running };
  const { terminal } = started;
  // Restart writes the seat row only once the pane has proved itself. Its tags come from the
  // file this launch started from, frozen in the row (RFC 0021 (e)).
  const tags = seatTags(file, bot.id);
  const logSeat = async (createdMs = started.created_ms) => {
    const unlogged = appendLedger(startRow({ kind: "seat", terminal, pid: started.pid ?? await pidOf(terminal), botId: bot.id, worktree: cwd,
      project: key, agent: agentKey, model, template: carry[WORKER_TEMPLATE_LABEL] ?? null,
      ...tags, core: await rowCore(), createdMs, session: agentKey === "claude" ? session : null }));
    if (unlogged) { hook.warnings.push(unlogged); report([unlogged]); }
  };
  if (!over.replacing) await logSeat();
  if (place?.spare && TAB_WAIT_MS > 0) {
    const why = await closeSpare(place.spare, terminal);
    if (why) { hook.warnings.push(why); report([why]); }
  }
  listProject(key);
  // An edit that landed while this Start ran: the file read again, its role and category
  // put on the new pane (relabelWords against the labels it started with).
  let words = [];
  try {
    const fresh = loadProject(key).file;
    if (fresh.bots.some((b) => b.id === bot.id && !b.planned)) {
      words = relabelWords(labels, paneLabels(fresh, bot.id), labels);
    }
  } catch { /* the file can't be read now: the labels it started with stand */ }
  if (words.length) {
    const warning = await relabelPane(terminal, words, `${terminal}'s labels ${words.join(" ")} weren't set.`, over.warnedRelabels);
    if (warning) {
      hook.warnings.push(warning);
      report([warning]); // the hook's warnings were printed before hc run
    }
  }
  if (!place) {
    hook.warnings.push(`No open Herdr space shows ${key}, so Herdr gives ${terminal} no pane: it runs, unseen. `
      + `Watch it with hc attach ${terminal}. To give the next start a pane, open a space on ${key} first, or pass --space <id> (herdr-app ls lists the ids).`);
    report(hook.warnings.slice(-1));
  }
  return { terminal, created_ms: started.created_ms, parent, argv, labels, place, hook, logSeat, session };
}

/**
 * The child processes of the shell `get` names (`pgrep -P` its pid, on `machine` through hc
 * for a linked one's): their pids, [] for none, or null when that can't be told (no pid, no
 * pgrep, an error, the machine not answering), and shellIdle then never counts it idle. None
 * only as pgrep itself says it: it exited 1 with nothing on stdout or stderr. Here pgrep runs
 * through pgrepHere, never runProgram, which gives code 1 and its own message on stderr for a
 * pgrep it couldn't run (EACCES) or killed at its timeout as well as for every failed exit.
 */
async function shellChildren(get, machine = null) {
  if (!Number.isSafeInteger(get?.pid) || get.pid <= 0) return null;
  const args = ["-P", String(get.pid)];
  const r = machine ? await remoteIo.exec("pgrep", args, machine) : await pgrepHere(args);
  if (!r) return null;
  const pids = (r.stdout ?? "").split(/\s+/).filter(Boolean);
  if (r.code === 1 && !pids.length && !(r.stderr ?? "").trim()) return [];
  return r.code === 0 && pids.length && pids.every((x) => /^\d+$/.test(x)) ? pids : null;
}

/**
 * Closes the spare shell's tab of a space this start made (windowPlace's or windowPlaceOn's
 * `spare`) once the window shows the bot's pane (`terminal`; on `machine`, a linked one's) in
 * another tab there: never before, so the space always keeps a tab, and only while that tab
 * holds the shell alone with nothing but the shell itself in front and no job of its own
 * running (spareTab, shellIdle, shellChildren). Never `confirmed`: Herdr asks the person only
 * before closing a space's last tab, which this never is. Null, or a warning when it failed.
 */
async function closeSpare(spare, terminal, machine = null) {
  const shown = await windowShows(terminal, TAB_WAIT_MS, machine);
  if (!shown || shown.space.id !== spare.space) return null;
  if (!spareTab(spare, shown.space.tabs, terminal, true)) return null;
  const get = await hcGet(machine ? `${machine}/${spare.terminal}` : spare.terminal).catch(() => null);
  const idle = shellIdle(get, await shellChildren(get, machine));
  const tab = spareTab(spare, shown.space.tabs, terminal, idle);
  if (!tab) return null;
  const why = await windowDo("tab.close", { id: tab });
  return why ? `The new space's spare shell tab (${tab}) wasn't closed: ${why}` : null;
}

// ---- restart: the bot's agent again, in its pane's place ----

/** How long Restart gives the replacement to prove itself before it gives up on it. */
const RESTART_WAIT_MS = Number(process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS) || 30_000;
/**
 * How long the replacement's agent must stay in front, every check, before the old pane ends:
 * an agent is in front at once and only then reads its arguments (claude --resume with a stale
 * id, --continue with no conversation, a swap to an agent that fails at startup exit in 1-3s).
 * An agent that reports its own status to hc (`reported`) has started its session: a shorter
 * settle then.
 */
const RESTART_STABLE_MS = Number(process.env.AUTOMAGIK_HERDR_RESTART_STABLE_MS) || 5000;
const RESTART_SETTLE_MS = Math.min(1500, RESTART_STABLE_MS);
const later = (ms) => new Promise((go) => setTimeout(go, ms));

/**
 * Waits until `terminal` has had an agent in front (Decision 3's live rule) at every check for
 * RESTART_STABLE_MS (RESTART_SETTLE_MS once it reports): { state: "live" | "ended" | "late",
 * get }. "ended": its program exited (a resume that found nothing, say).
 */
async function agentUp(terminal, ms = RESTART_WAIT_MS) {
  const until = Date.now() + ms;
  let since = null;
  for (;;) {
    // A failed lookup (not "no such terminal") is no answer yet: asked again until the deadline,
    // never read as an ended pane (#1125).
    let get;
    try { get = await hcGet(terminal); } catch { get = undefined; }
    if (get === null || get?.state === "finished") return { state: "ended", get };
    if (get === undefined) {
      since = null;
      if (Date.now() >= until) return { state: "late", get: null };
      await later(250);
      continue;
    }
    if (get.state === "live" && agentInForeground(get)) {
      since ??= Date.now();
      if (Date.now() - since >= (get.reported === true ? RESTART_SETTLE_MS : RESTART_STABLE_MS)) return { state: "live", get };
    } else since = null;
    if (Date.now() >= until) return { state: "late", get };
    await later(250);
  }
}

// A line that names a failure: an error word, or a code in brackets as codex gives one
// ("model provider example-proxy is no longer configured (modelProviderNotConfigured)").
const FAILURE_WORD = /\b(error|fatal|failed|failure|panic|denied|invalid|unauthori[sz]ed|refused|cannot|can't|not configured|no longer)\b/i;
const FAILURE_CODE = /\([a-z]+[A-Z][A-Za-z]*\)/; // camelCase only: never "(quit)" or "(default)"
const failureLine = (l) => FAILURE_WORD.test(l) || FAILURE_CODE.test(l);
// A line with nothing to say: box drawing, rules, a bare shell prompt.
const EMPTY_LINE = /^[\s\u2500-\u257f\u2580-\u259f\-_=*•·.:>❯›$%#]*$/;

/**
 * The agent's own last word on a screen (`hc read`'s text), #413: of its last lines with
 * something on them, the last one that names a failure, else the last one; null for none.
 */
export function causeLine(text) {
  const lines = screenTail(text, 40).split("\n").map((l) => l.trim()).filter((l) => l && !EMPTY_LINE.test(l));
  const line = lines.findLast(failureLine) ?? lines.at(-1);
  if (!line) return null;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** The last line `terminal`'s agent left on its screen (causeLine), or null when it can't be read. */
async function endedCause(terminal) {
  try {
    const r = await hc(["read", terminal, "--lines", "40", "--json"]);
    if (r.code !== 0) return null;
    let text = r.stdout;
    try { const j = JSON.parse(r.stdout); text = typeof j?.text === "string" ? j.text : null; } catch { /* plain text */ }
    if (text === null) return null;
    return causeLine(text);
  } catch { return null; }
}

/** Why `terminal` ended before its agent was up: { text, cause }, the text naming the agent's last line (endedCause) when it left one. */
async function exitedWhy(terminal) {
  const cause = await endedCause(terminal);
  return { cause, text: `${terminal} exited before its agent was up${cause ? `; its agent said: "${cause}" (hc read ${terminal} shows the rest)` : ` (hc read ${terminal} says why)`}` };
}

/**
 * restartRefusal's refusal of a busy pane: --json prints `refused` ("working": mid-turn;
 * "helpers": helpers that end with it) and its `terminal`, so a caller can wait for it (#413).
 */
const busyRefusal = (refusal, old) => new CliError(refusal, 1, { refused: old?.status?.state === "working" ? "working" : "helpers", terminal: old.address });

// Codex refusing a thread whose model provider is no longer in its config (#413: threads begun
// on a provider since removed from the config): that thread can't be resumed, only left behind.
// Its own error code only, never a bare "no longer configured" another failure might print.
const PROVIDER_GONE = /\bmodelProviderNotConfigured\b/;

/**
 * Whether a resume that exited (its agent's last line `cause`) is codex unable to resume the
 * thread at all (PROVIDER_GONE: codex's modelProviderNotConfigured), the one failure a restart
 * answers by starting fresh (#413).
 */
const providerGone = (plan, cause) => plan.mode === "resume" && plan.agent === "codex" && PROVIDER_GONE.test(cause ?? "");
/**
 * The note a restart that left such a thread behind carries: that it had one, and what codex said.
 * The thread's id is never printed (RFC 0021): it stays in the old pane's labels and the ledger.
 */
const providerGoneNote = (thread, terminal, cause) =>
  `codex can't resume ${thread ? `its thread (${SESSION_MASK})` : "the folder's latest thread"} (${terminal} said "${cause}"), so it starts on a new one`;

/** A replacement that exited before its agent was up: the refusal; --json prints the cause beside the replacement `terminal`. */
async function exitedBefore(terminal, rest) {
  const { cause, text } = await exitedWhy(terminal);
  return new CliError(`${text}; ${rest}`, 1, { terminal, cause });
}

/** The workers ledger's rows ([] when it can't be read). */
function workerLedgerRows() {
  try { return readLedger(readText(ledgerPath(appHome())) ?? ""); } catch { return []; }
}

/** The workers ledger's last seat row for `botId` in project `key`, as the pane it stood for: { address, created_ms, cwd, labels }, or null. */
function lastSeat(rows, botId, key, agent) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r?.event !== "start" || r.kind !== "seat" || r.botId !== botId || !(r.project == null || r.project === key)) continue;
    if (typeof r.terminal !== "string" || !r.terminal) return null;
    // #1418: a gone pane's template follows the seat only while it runs the same agent.
    const labels = r.agent === agent && typeof r.template === "string" && r.template ? { [WORKER_TEMPLATE_LABEL]: r.template } : {};
    return { address: r.terminal, created_ms: Number.isSafeInteger(r.created_ms) ? r.created_ms : null,
      cwd: typeof r.worktree === "string" ? r.worktree : null, labels };
  }
  return null;
}

/** When a session folder was born: its own birth or first write, whichever is earlier (ms), or null. */
function sessionBorn(dir) {
  const st = statSync(dir);
  if (!st.isDirectory()) return null;
  const born = Math.min(...[st.birthtimeMs, st.mtimeMs].filter((x) => Number.isFinite(x) && x > 0));
  return Number.isFinite(born) ? born : null;
}

/** Whether an agent has left sessions under this home: with none, nothing is looked up and hc is asked nothing more. */
const sessionsOnDisk = () => existsSync(join(dshHomeOf(home(), process.env), "sessions")) || existsSync(agyHistoryPath(home()))
  || existsSync(codexSessionsDir(codexHomeOf(home(), process.env))) || existsSync(kimiIndexPath(kimiHomeOf(home(), process.env)));

// One read per path per pass (recordSessions, or one restart and its helpers): emptied at the
// start of each, so a long-lived queued restart never acts on an old listing.
const sessionDiscovery = new Map();

/** Codex's existing YYYY/MM/DD folders, or null when their listing can't be read. */
function codexFolders(dir) {
  if (!sessionDiscovery.has(dir)) {
    let days = null;
    try {
      days = [];
      for (const y of readdirSync(dir, { withFileTypes: true })) {
        if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
        for (const m of readdirSync(join(dir, y.name), { withFileTypes: true })) {
          if (!m.isDirectory() || !/^(0[1-9]|1[0-2])$/.test(m.name)) continue;
          for (const d of readdirSync(join(dir, y.name, m.name), { withFileTypes: true })) {
            if (d.isDirectory() && /^(0[1-9]|[12]\d|3[01])$/.test(d.name)) days.push(`${y.name}/${m.name}/${d.name}`);
          }
        }
      }
    } catch { days = null; }
    sessionDiscovery.set(dir, days);
  }
  return sessionDiscovery.get(dir);
}

/** A rollout's first line, at most 1 MiB; null when unreadable or longer. */
function codexFirstLine(file) {
  if (!sessionDiscovery.has(file)) {
    let line = null, fd = null;
    try {
      fd = openSync(file, "r");
      if (fstatSync(fd).isFile()) {
        const cap = 1024 * 1024;
        const bytes = Buffer.alloc(cap + 1);
        let used = 0, end = -1;
        while (used < bytes.length) {
          const n = readSync(fd, bytes, used, Math.min(64 * 1024, bytes.length - used), null);
          if (!n) break;
          end = bytes.indexOf(10, used);
          used += n;
          if (end >= 0 && end < used) break;
          end = -1;
        }
        if (end >= 0 || used <= cap) line = bytes.subarray(0, end >= 0 ? end : used).toString("utf8");
      }
    } catch { line = null; }
    finally { if (fd !== null) closeSync(fd); }
    sessionDiscovery.set(file, line);
  }
  return sessionDiscovery.get(file);
}

/** Kimi's whole index, at most 16 MiB; null when unreadable or larger. */
function kimiIndexText(file) {
  if (!sessionDiscovery.has(file)) {
    let text = null;
    try {
      const cap = 16 * 1024 * 1024;
      if (statSync(file).size <= cap) {
        const bytes = readFileSync(file);
        if (bytes.length <= cap) text = bytes.toString("utf8");
      }
    } catch { text = null; }
    sessionDiscovery.set(file, text);
  }
  return sessionDiscovery.get(file);
}

/** hc's live panes on this computer, as hc get answers them ([] when hc can't say): discoveredSession's rivals come from them. */
async function livePanes() {
  try {
    const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state === "live");
    return (await Promise.all(rows.map((r) => hcGet(r.address).catch(() => null)))).filter(Boolean);
  } catch { return null; }
}

/**
 * #939: the session the pane `get` (its address, created_ms and folder) runs on an agent that
 * takes no session id at launch, read from what that agent left under the home: DSH's session
 * folders, Antigravity's prompt history, Codex's session_meta first line, or Kimi's index.
 * Only ids, folders and times are read. revive.js pickSession decides, right or nothing;
 * `ledger`: the workers ledger's rows (the other launches there, and the ids already tied to one). Null when there
 * is none, or it can't be told from another pane's. The id is held: never printed.
 */
function discoveredSession(agentKey, get, ledger, panes) {
  // `panes` (livePanes): null when hc couldn't list them, and then nothing is picked.
  if (!discoversSession(agentKey) || !Number.isSafeInteger(get?.created_ms) || !Array.isArray(panes)) return null;
  const cwd = get.cwd ?? get.foreground?.cwd ?? null;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const folders = [...new Set([cwd, realDir(cwd)].filter(Boolean))];
  let candidates = [];
  try {
    if (agentKey === "dsh-tui") {
      for (const folder of folders) {
        const dir = dshSessionsDir(dshHomeOf(home(), process.env), folder);
        let names = [];
        try { names = readdirSync(dir); } catch { names = []; }
        for (const name of names) {
          const id = dshSessionOf(name);
          let born = null;
          try { born = id ? sessionBorn(join(dir, name)) : null; } catch { born = null; }
          if (born !== null) candidates.push({ id, born });
        }
      }
    } else if (agentKey === "antigravity") candidates = agyCandidates(readText(agyHistoryPath(home())) ?? "", folders);
    else if (agentKey === "codex") {
      const dir = codexSessionsDir(codexHomeOf(home(), process.env));
      const days = codexFolders(dir);
      if (days === null) return null;
      const launch = new Date(get.created_ms);
      launch.setDate(launch.getDate() - 1);
      const since = `${launch.getFullYear()}/${String(launch.getMonth() + 1).padStart(2, "0")}/${String(launch.getDate()).padStart(2, "0")}`;
      for (const day of days) {
        if (day < since) continue;
        const folder = join(dir, day);
        if (!sessionDiscovery.has(folder)) {
          let names = null;
          try { names = readdirSync(folder); } catch { names = null; }
          sessionDiscovery.set(folder, names);
        }
        const names = sessionDiscovery.get(folder);
        if (names === null) return null;
        for (const name of names) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const id = codexRolloutId(name);
          const born = uuidV7Ms(id);
          if (born !== null && (born < get.created_ms - BORN_SLACK_MS || born > get.created_ms + FIRST_SESSION_MS)) continue;
          const first = codexFirstLine(join(folder, name));
          if (first === null) return null;
          const candidate = codexCandidate(first, folders);
          if (candidate === undefined) return null;
          if (candidate) candidates.push(candidate);
        }
      }
    } else if (agentKey === "kimi") {
      const kimiHome = kimiHomeOf(home(), process.env);
      const index = kimiIndexText(kimiIndexPath(kimiHome));
      if (index === null) return null;
      for (const c of kimiCandidates(index, folders, kimiHome)) {
        let dir = null;
        try { dir = lstatSync(c.sessionDir); } catch { dir = null; }
        if (!dir?.isDirectory()) continue;
        const born = sessionBorn(c.sessionDir);
        if (born !== null) candidates.push({ id: c.id, born });
      }
    }
  } catch { return null; }
  const { rivals, claimed } = ledgerRivals(ledger, { terminal: get.address, createdMs: get.created_ms, agentKey, folders });
  // Every other live pane on that agent in the folder is a rival too, whoever started it (as
  // sharersOf counts them): by the program in front, or its launch command (a bare shell hc kept).
  const agents = agentTable();
  const inFolder = (d) => typeof d === "string" && d !== "" && (folders.includes(d) || folders.includes(realDir(d) ?? d));
  for (const p of panes) {
    if (p.address === get.address || !(inFolder(p.cwd) || inFolder(p.foreground?.cwd))) continue;
    if (agentKeyOfArgv(unwrapKeep(p.foreground?.argv), agents) !== agentKey && agentKeyOfArgv(paneCommand(p)?.argv, agents) !== agentKey) continue;
    rivals.push({ terminal: p.address, created_ms: Number.isSafeInteger(p.created_ms) ? p.created_ms : null });
    for (const k of [SESSION_LABEL, "revive.session"]) if (typeof p.labels?.[k] === "string" && p.labels[k]) claimed.add(p.labels[k]);
  }
  const id = sessionFor(agentKey, pickSession({ createdMs: get.created_ms, candidates, claimed, rivals }));
  return id ? holdId(id) : null;
}

/**
 * #939: ties each live dsh-TUI, Antigravity, Codex or Kimi pane of a bot or a worker to the session it started
 * on (discoveredSession), as the briefing hook does for Claude: a session row in the workers
 * ledger and the pane's agent.session label. Once: a pane that has a label, or a session row,
 * is never looked at again, so nothing found later can replace what it holds. Never fails: what
 * it couldn't do is left for the next run. Resolves how many it recorded.
 */
async function recordSessions() {
  let recorded = 0;
  sessionDiscovery.clear();
  if (!sessionsOnDisk()) return recorded;
  try {
    const agents = agentTable();
    const ledger = workerLedgerRows();
    const gets = await livePanes();
    for (const get of gets ?? []) {
      if (!get.labels?.[BOT_LABEL] && !get.labels?.[WORKER_OF_LABEL]) continue;
      const start = ledger.findLast((r) => r?.event === "start" && r.terminal === get.address && r.created_ms === get.created_ms) ?? null;
      // Its agent: the program in front, else its start row's, else its launch command's (a bare shell hc kept).
      const agentKey = agentKeyOfArgv(unwrapKeep(get.foreground?.argv), agents) ?? start?.agent ?? agentKeyOfArgv(paneCommand(get)?.argv, agents) ?? null;
      if (!discoversSession(agentKey)) continue;
      if (get.labels?.[SESSION_LABEL] || get.labels?.["revive.session"] || ledgerSession(ledger, get.address, agentKey, get.created_ms)) continue;
      const found = discoveredSession(agentKey, { ...get, cwd: start?.worktree ?? get.cwd }, ledger, gets);
      if (!found) continue;
      const unlogged = appendLedger(sessionRow({ terminal: get.address, session: found, transcript: null, agent: agentKey,
        core: await rowCore(), createdMs: get.created_ms }));
      if (unlogged) continue;
      ledger.push({ event: "session", terminal: get.address, session: found, agent: agentKey, created_ms: get.created_ms });
      if ((await hc(["label", get.address, `${SESSION_LABEL}=${found}`])).code === 0) recorded += 1;
    }
  } catch { /* hc or a file can't be read now: the next run looks again */ }
  return recorded;
}

/**
 * Who else may own the latest `agentKey` conversation in the folder `cwd` (#328), the panes and
 * bots a restart with no session id must not take it from: [{ address, name, ended }]. Over-
 * counting is safe (the restart then starts fresh and says why), so all three count: the live
 * panes on this computer running that agent there (a bot's, or one started by hand: hc ls), the
 * bound bots there by the attach ledger (`view`), and each other bot any of whose seat rows in the
 * workers ledger (`ledger`) put it there on that agent, its pane since ended or moved or not. `old`:
 * the pane being replaced (never counted); `anywhere`: the agent's id-less resume isn't
 * limited to one folder (models.js continuesAnywhere), so any folder counts.
 */
async function sharersOf({ view, cwd, botId, file, agentKey, ledger = [], old, anywhere = false }) {
  const real = realDir(cwd) ?? cwd;
  const here = (dir) => anywhere || (typeof dir === "string" && dir !== "" && (dir === cwd || (realDir(dir) ?? dir) === real));
  const agents = agentTable();
  // The agent in front, past the keep wrapper (launchArgs.js unwrapKeep) a pane may run it in.
  const runs = (get) => agentInForeground(get) && ((agentKey === "claude" && isClaude(null, get))
    || agentKeyOfArgv(unwrapKeep(get.foreground?.argv), agents) === agentKey);
  const nameOf = (id) => (id ? file.bots.find((b) => b.id === id)?.name ?? `bot ${id}` : null);
  const out = new Map();
  const add = (address, name, ended = false) => { if (address && address !== old?.address && !out.has(address)) out.set(address, { address, name, ended }); };
  for (const { binding, get } of view.live.values()) {
    if (binding.bot !== botId && get && runs(get) && here(get.foreground?.cwd ?? get.cwd)) add(binding.terminal, nameOf(binding.bot));
  }
  let rows = [];
  try { rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state === "live" && r.address !== old?.address && !out.has(r.address)); }
  catch { rows = []; }
  for (const get of (await Promise.all(rows.map((r) => hcGet(r.address).catch(() => null)))).filter(Boolean)) {
    if (get.labels?.[BOT_LABEL] === botId || !runs(get) || !here(get.foreground?.cwd ?? get.cwd)) continue;
    add(get.address, nameOf(get.labels?.[BOT_LABEL]) ?? "a pane");
  }
  // Every seat row counts, not only each bot's last (#341): a bot re-seated in a worktree or a
  // clone still left its conversation here. Each bot is named once, by its latest pane here.
  const seatedHere = new Map();
  for (const r of ledger) {
    if (r?.event === "start" && r.kind === "seat" && typeof r.botId === "string" && r.botId !== botId
      && r.agent === agentKey && here(r.worktree)) seatedHere.set(r.botId, r);
  }
  for (const r of seatedHere.values()) add(r.terminal, nameOf(r.botId), !(view.live.get(r.botId)?.binding.terminal === r.terminal));
  return [...out.values()];
}

/**
 * The attach rows of a restart, under the ledger's lock, once the new pane has stayed up: the
 * old binding detached (by "start", "moved"), then the new terminal attached (by "start").
 * When the ledger no longer names the old binding (another CLI attached or moved the bot
 * meanwhile) nothing is written: { lost: the terminal it names, or null }. With the old pane
 * already ended (its end row written), the new one is attached alone.
 */
async function attachMoved(bot, oldBinding, terminal, created_ms, key) {
  return underLedger(async ({ core, byBot, holds, write }) => {
    const now = byBot.get(bot.id);
    const rows = [];
    if (now && attachKey(now) === attachKey(oldBinding)) rows.push(closingRow(oldBinding, "detach", "start", "moved"));
    else if (now && (await holds(now))) return { lost: now.terminal };
    rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal, core, created_ms, by: "start" }));
    write(rows);
    return { lost: undefined };
  });
}

/** The exit code a command that printed its answer still fails with (a --tree that stopped part way): 0 else. */
const exitAfter = { code: 0 };

/** Why a restart of an agent whose -c needs a finished turn (models.js resumeAfterTurn) starts a new conversation. */
const noTurnNote = (agents, agentKey, old) => `${agents[agentKey]?.name ?? agentKey} has no finished turn in ${old?.address ?? "the old pane"} to continue`;

/** What cmdRestart returns once it has printed its own answer (a bot restarting itself). */
export const PRINTED = Symbol.for("automagik-herdr.printed");

/**
 * The live terminals whose hc parent is `address`, as hc get answers (they may end with it).
 * `strict` (--tree): one hc can't read refuses the restart (CliError), since it couldn't be
 * checked or run again; otherwise it is left out.
 */
async function helpersOf(address, { strict = false } = {}) {
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => r?.parent === address && r.state !== "finished" && r.address);
  const states = await Promise.all(rows.map((r) => hcState(r.address)));
  const unread = states.filter((x) => x.state === "unknown").map((x) => x.why);
  if (strict && unread.length) {
    throw new CliError(`${unread.join("; ")}: --tree can't check ${address}'s ${unread.length === 1 ? "helper" : "helpers"}. Nothing was started.`);
  }
  return states.filter((x) => x.get).map((x) => x.get);
}

/** The workers ledger's last worker start row for `terminal`, or null. */
function workerRowOf(rows, terminal) {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]?.event === "start" && rows[i].kind === "worker" && rows[i].terminal === terminal) return rows[i];
  return null;
}

/** `dir` is a folder that is there now. */
const isDir = (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } };

/**
 * `hc get` of `terminal`: { state: "live" | "finished", get }, { state: "gone" } when hc says
 * there is no such terminal, or { state: "unknown", why } when hc failed otherwise (never read
 * as gone).
 */
async function hcState(terminal) {
  const r = await hc(["get", terminal, "--json"]);
  if (r.code === 0) {
    try { const get = JSON.parse(r.stdout); return { state: get?.state === "finished" ? "finished" : "live", get }; } catch { /* below */ }
    return { state: "unknown", why: `hc get ${terminal} printed no JSON` };
  }
  if (r.code === 3 || /not_found/.test(r.stderr ?? "")) return { state: "gone" };
  return { state: "unknown", why: `hc get ${terminal} failed (${(r.stderr || r.stdout).trim() || `exit ${r.code}`})` };
}

/** How long --tree waits, before anything starts, for the bot's pane and its helpers to be idle, and how often it looks. */
const TREE_TURN_WAIT_MS = Number(process.env.AUTOMAGIK_HERDR_TREE_TURN_WAIT_MS) || 600_000;
const TREE_TURN_POLL_MS = Math.min(2000, Math.max(100, Math.floor(TREE_TURN_WAIT_MS / 10)));

/**
 * --tree, before the bot's new pane starts: refused (unless --force) while the old pane or a helper
 * in `plans` waits for an answer, or has an agent that reports no status to hc, which may be
 * mid-turn (#413; a plain program reports none and passes); else waits (TREE_TURN_WAIT_MS) until the old pane and every
 * helper in `plans` are idle at one look, so no turn ends (and types its note into the old pane)
 * once two panes could hold the bot's session. A helper's note can start the old pane's turn, so
 * all are looked at again each time. Refused (CliError), nothing started, when one is still
 * mid-turn at the end, or hc can't read one. Resolves the plans whose helper still runs (one that
 * ended by itself is said and left out). `force`: no wait.
 */
async function treeIdle(old, plans, say, { force = false, revive = false } = {}) {
  if (force) return plans;
  const until = Date.now() + TREE_TURN_WAIT_MS;
  for (;;) {
    const states = await Promise.all([old.address, ...plans.map((q) => q.replaced)].map((a) => hcState(a)));
    const unread = states.filter((x) => x.state === "unknown").map((x) => x.why);
    if (unread.length) throw new CliError(`${unread.join("; ")}: --tree can't tell whether it is mid-turn. Nothing was started.`);
    const screens = await Promise.all(states.map((s) => s.get ? readScreenText(s.get.address) : null));
    const panes = [{ address: old.address, agent: agentKeyOfArgv(unwrapKeep(old.foreground?.argv), agentTable()) }, ...plans.map((q) => ({ address: q.replaced, agent: q.agent }))]
      .map((p, i) => ({ ...p, live: states[i].state === "live", status: states[i].get?.status?.state, idle: isPaneIdle(states[i].get, screens[i]), dialog: pendingDialog(screens[i]) }))
      // #939, revive only: a bare shell hc kept runs no turn and asks nothing, whatever its ended agent last reported.
      .map((p, i) => (revive && isBareShell(states[i].get) ? { ...p, agent: null, status: undefined, idle: true, dialog: null } : p));
    const asking = panes.filter((p) => p.live && (p.status === "blocked" || p.dialog)).map((p) => p.address);
    if (asking.length) {
      const one = asking.length === 1;
      throw new CliError(`${asking.join(", ")} ${one ? "is" : "are"} waiting for an answer. Nothing was started: answer ${one ? "it" : "them"} first, or pass --force to end ${one ? "it" : "them"}.`);
    }
    const silent = panes.filter((p) => p.agent && p.live && typeof p.status !== "string").map((p) => p.address);
    if (silent.length) {
      const one = silent.length === 1;
      throw new CliError(`${silent.join(", ")} ${one ? "doesn't" : "don't"} tell hc whether ${one ? "it is" : "they are"} busy, so --tree can't tell whether ${one ? "it has" : "they have"} finished. `
        + `Nothing was started. Look at ${one ? "it" : "them"} first, then pass --force to restart anyway.`);
    }
    const busy = panes.filter((p) => p.live && (p.status === "working" || ["idle", "done"].includes(p.status)) && !p.idle).map((p) => p.address);
    if (!busy.length) {
      const live = plans.filter((_, i) => states[i + 1].state === "live");
      for (const q of plans.filter((_, i) => states[i + 1].state !== "live")) say(`${q.replaced} ended by itself before the restart, so it isn't run again.`);
      return live;
    }
    if (Date.now() >= until) {
      throw new CliError(`${busy.join(", ")} ${busy.length === 1 ? "was" : "were"} still mid-turn ${TREE_TURN_WAIT_MS / 1000}s later. Nothing was started: `
        + `restart once ${busy.length === 1 ? "it is" : "they are"} idle, or pass --force to cut ${busy.length === 1 ? "its turn" : "their turns"}.`);
    }
    await later(TREE_TURN_POLL_MS);
  }
}

/**
 * After the old pane ended: waits (bounded) until helper `terminal`, which ends with it, has.
 * One still running is ended (hc kill) and looked at again. { ended: true }, or { ended: false,
 * live, why }: `live` when it still runs (never run a second time then, nor offered by hand),
 * else hc can't say (unknown is never gone).
 */
async function helperEnded(terminal, ms = 5000) {
  const wait = async (limit) => {
    const until = Date.now() + limit;
    for (;;) {
      const now = await hcState(terminal);
      if (now.state === "gone" || now.state === "finished") return { ended: true };
      if (now.state === "unknown") return { ended: false, live: false, why: `${now.why}, so it may still run` };
      if (Date.now() >= until) return null;
      await later(100);
    }
  };
  const first = await wait(ms);
  if (first) return first;
  const k = await hcKill(terminal);
  const second = await wait(k.code === 0 ? ms : 0);
  if (second) return second;
  return { ended: false, live: true, why: `it still runs after its parent ended${k.code === 0 ? ` and ${ms / 1000}s after hc kill ${terminal}` : ` (hc kill ${terminal} failed: ${(k.stderr || k.stdout).trim()})`}` };
}

/** `w` as one shell word. */
const shellWord = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`);

/**
 * How to run helper plan `p` again by hand, as a child of `parent`: the hc run line the restart
 * would have run (its name, folder, labels, the seat's PATH, its command resumed), which runs as
 * pasted into sh, bash or zsh once the session id is put back where the line shows *** (RFC 0021:
 * no session id is printed; the note says where it is kept); then comment lines: its session,
 * and for a worker that its ledger row isn't copied by hand, and a claude-logins.json warning
 * when the line is on the default login because the record can't be followed. { line, notes }.
 */
function byHand(p, parent) {
  const loginWarnings = [];
  const args = helperArgs({ name: p.name, cwd: p.cwd, labels: p.labels, parent, ...helperCommand(p),
    login: claudeLogin(p.argv, loginWarnings) });
  const notes = [p.session ? `# resumes its session by id: put the id where *** stands; hc get ${p.replaced} shows it (its agent.session `
    + "or revive.session label), and so does the workers ledger"
    : "# no session id known: it resumes its folder's latest conversation"];
  // A record that can't be followed: the line carries the default login's words, and says so.
  for (const w of loginWarnings) notes.push(`# ${w}`);
  if (p.worker) notes.push(`# a worker: its workers-ledger row (task ${p.worker.task ?? "none"}) isn't copied, so history won't link the new terminal`);
  return { line: maskSession(["hc", ...args], p.session).map(shellWord).join(" "), notes };
}

/** A --tree helper is another start: resolve its own bot's approved switch afresh too. */
function helperCommand(p, warn = () => {}) {
  const path = launchPath(p.argv[0], p.cwd).path;
  // #955: a helper of any agent but dsh-tui gets the `hc kill` shim first, as a new worker does.
  if (!p.proxyIdentity) return { argv: p.argv, path: guardPathWith(path, p.agent && p.agent !== "dsh-tui" ? KILL_GUARD_DIR : null) };
  const { botId, project } = p.proxyIdentity;
  const bot = loadProject(project).file.bots.find((entry) => entry.id === botId) ?? { id: botId };
  if (!proxyEnabled(approvedProxyState({ project, bot }), process.platform, warn)) {
    return { argv: p.argv, path };
  }
  return { argv: paneArgs(p.argv, p.proxyIdentity),
    path: guardPathWith(path, stableGuardDir(stableRootOf())) };
}

/**
 * Restart --tree's second half (#213), once the bot's new pane is up and the old one has ended
 * (its helpers with it, so nothing types into a pane that shares the bot's session): each helper
 * (`plans`, all checked before anything started), one at a time: seen ended (helperEnded: one
 * still running is ended, and if it won't end it is said and never run twice), then run again as
 * a child of `parent` (the bot's new pane), in its folder, with its name and labels, its command
 * resumed and a seat's PATH, and waited on as the bot's was. A worker's ledger row is copied to
 * its new terminal. A helper that is itself a bot (`binding`) has its binding moved to it
 * (attachMoved) and a seat row. One that fails is reported with the hc run line that resumes it
 * by hand (`by_hand`), and the rest go on. `say` takes the warnings. Resolves [{ name,
 * replaced, terminal, bot, agent, mode, session, up, note, error, by_hand, still_running }].
 */
async function rerunHelpers(plans, parent, say) {
  const out = plans.map((p) => ({ name: p.name, replaced: p.replaced, terminal: null, bot: p.binding?.bot ?? null, agent: p.agent ?? null,
    mode: p.mode ?? null, session: p.session ?? null, up: false, note: p.note ?? null, error: null, cause: null, by_hand: null, still_running: false }));
  for (const [i, p] of plans.entries()) {
    const who = `${p.replaced}${p.name && p.name !== p.replaced ? ` (${p.name})` : ""}`;
    const failed = (why) => {
      let hand;
      try { hand = byHand(p, parent); }
      catch { hand = { line: "# repair approval before restarting this helper", notes: [] }; }
      out[i].error = why;
      out[i].by_hand = hand.line;
      say(`${who} wasn't run again: ${why}. Its conversation is kept; to run it again by hand:\n  ${hand.line}\n  ${hand.notes.join("\n  ")}`);
    };
    const end = await helperEnded(p.replaced);
    // Ended (its parent's kill took it, or its own): a logged launch's end row (RFC 0021 (f) 4).
    if (end.ended && (p.worker || p.binding)) {
      // Keyed as its own start row or binding keyed the launch, so the sweep sees it ended.
      const unlogged = appendEnd(endRow({ kind: p.binding ? "seat" : "worker", terminal: p.replaced,
        core: p.binding?.core ?? p.worker?.core ?? await rowCore(),
        createdMs: p.binding?.created_ms ?? p.worker?.created_ms ?? p.createdMs, reason: "replaced" }));
      if (unlogged) say(unlogged);
    }
    if (!end.ended) {
      out[i].error = end.why;
      out[i].still_running = end.live;
      say(end.live ? `${who} ${end.why}: it holds its session, so it isn't run again (no second pane on one session); end it with hc kill ${p.replaced}, then restart it.`
        : `${who} wasn't run again: ${end.why}; with it possibly running, a second copy would share its session. Check it with hc get ${p.replaced}.`);
      continue;
    }
    const taken = new Set(rowsOf(await hcJson(["ls"])).map((r) => r?.name).filter(Boolean));
    const name = p.name && !taken.has(p.name) ? p.name : null;
    const loginWarnings = [];
    const login = claudeLogin(p.argv, loginWarnings);
    for (const w of loginWarnings) say(`${who}: ${w}`);
    let command;
    try { command = helperCommand(p, say); }
    catch (e) { failed(e.message); continue; }
    // #823: the Antigravity permission file this helper's argv names, written as its start does.
    if (p.agySettings) {
      try { writeAgySettingsFile(p.agySettings, { name: p.name ?? p.replaced }); }
      catch (e) { failed(e.message); continue; }
    }
    const helperRun = helperArgs({ name, cwd: p.cwd, labels: p.labels, parent, ...command, login });
    const guardWhy = launchGuardProblem(helperRun, name ?? p.name);
    if (guardWhy) { failed(guardWhy); continue; }
    const r = await hc(helperRun);
    let address = null;
    try { address = JSON.parse(r.stdout).address ?? null; } catch { address = null; }
    if (r.code !== 0 || !address) { failed(`hc run failed (${(r.stderr || r.stdout).trim()})`); continue; }
    const up = await agentUp(address);
    if (up.state !== "live") {
      if (up.state === "ended") {
        const why = await exitedWhy(address);
        out[i].cause = why.cause;
        failed(why.text);
        continue;
      }
      const killed = (await hcKill(address)).code === 0;
      failed(`${address} didn't keep an agent in front within ${RESTART_WAIT_MS / 1000}s${killed ? ", so it was ended" : ` and couldn't be ended (hc kill ${address})`}`);
      continue;
    }
    out[i].terminal = address;
    out[i].up = true;
    const createdMs = Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : null;
    const core = await rowCore();
    if (p.worker) {
      const w = p.worker;
      // The same worker again: its squad, lead and role as its row froze them (RFC 0021 (e));
      // a row from before squads gets its bot's squad now.
      let squad = w.squad ?? null;
      if (!("squad" in w)) { try { squad = squadOf(loadProject(w.project).file, w.botId); } catch { squad = null; } }
      const unlogged = appendLedger(startRow({ kind: "worker", terminal: address, pid: await pidOf(address), botId: w.botId, task: w.task, branch: w.branch,
        project: w.project, lead: w.lead, worktree: w.worktree, base: w.base, created: false, agent: w.agent, model: w.model, effort: w.effort,
        template: w.template, role: w.role, swap: w.swap, override: w.override, overrideRequested: w.override_requested,
        core, createdMs, squad, session: p.agent === "claude" ? p.session : null }));
      if (unlogged) say(unlogged);
    }
    if (p.binding) {
      const b = p.binding;
      const created = Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : null;
      let moved;
      try {
        if (created === null) throw new CliError(`hc get gave no created_ms for ${address}`);
        moved = await attachMoved({ id: b.bot }, b, address, created, b.project);
      } catch (e) {
        out[i].error = `its attach row wasn't written (${e?.message ?? e})`;
        say(`${who} runs again in ${address}, but bot ${b.bot}'s attach row wasn't written (${e?.message ?? e}): am attach ${b.bot} ${address}.`);
        continue;
      }
      if (moved.lost !== undefined) {
        out[i].error = `bot ${b.bot} was attached to ${moved.lost} meanwhile`;
        say(`bot ${b.bot} was attached to ${moved.lost} while --tree ran, so ${address} isn't attached to it.`);
        continue;
      }
      let tags = seatTags(null, b.bot);
      try { tags = seatTags(loadProject(b.project).file, b.bot); } catch { /* its file can't be read now: no tags */ }
      const unlogged = appendLedger(startRow({ kind: "seat", terminal: address, pid: await pidOf(address), botId: b.bot, worktree: p.cwd, project: b.project,
        agent: p.agent, model: null, template: p.template ?? null, ...tags, core, createdMs, session: p.agent === "claude" ? p.session : null }));
      if (unlogged) say(unlogged);
    }
    // A session id carried onto the new terminal, any harness (RFC 0021 (f) 5): a session row.
    if (p.session && (p.worker || p.binding)) {
      const unrow = appendLedger(sessionRow({ terminal: address, session: p.session, transcript: null, agent: p.agent, core, createdMs }));
      if (unrow) say(unrow);
    }
  }
  return out;
}

/**
 * Restart --tree's first half (#213), before anything starts: the helpers that end with the old
 * pane (`helpers`, hc get answers), each planned (helperPlan: its folder, command, agent and
 * session) and checked, the restart refused (CliError) when one can't be run again, its folder is
 * gone, it has helpers of its own that would end with it (unless `force`: they end, said), the
 * CLI runs inside it, or two runs (the bot's or a helper's) name one session id (one session runs
 * in one pane). One hc can't read was refused by helpersOf already; one mid-turn by restartRefusal. `run`: the bot's own restart ({ who, agent, cwd, session, mode }).
 * Id-less resumes that share a folder and agent with another of them (sharedFolders) are refused,
 * or, with `freshShared`, those helpers start a new conversation; the bot itself never does
 * (restart it with --fresh). Resolves { tree: [plan + { worker, binding }], treeWarnings }.
 */
async function treePlans({ project, bot, old, helpers, view, ledger, agents, knownSession, force, freshShared, run, revive = false }) {
  const doomed = doomedHelpers(helpers);
  const me = process.env.HC_TERMINAL_ID;
  const mine = me && doomed.find((h) => [h.address, h.name].includes(me));
  if (mine) throw new CliError(`This runs in ${mine.address}, one of ${old.address}'s helpers, which --tree ends and runs again: run it from another terminal.`);
  // The old pane ends before its helpers run again (so nothing types into it on the bot's session); this CLI would end with it.
  if (doomed.length && me && [old.address, old.name].includes(me)) {
    throw new CliError(`This runs in ${old.address}, the pane --tree ends before its helpers run again: run restart --tree from another terminal.`);
  }
  const treeWarnings = [];
  // --tree restarts one level: a helper's own helpers that would end with it are refused (or, with --force, said).
  const nested = (await Promise.all(doomed.map(async (h) => doomedHelpers(await helpersOf(h.address, { strict: true })).map((c) => `${c.address} (under ${h.address})`)))).flat();
  if (nested.length) {
    const one = nested.length === 1;
    if (!force) {
      throw new CliError(`--tree restarts ${old.address}'s helpers, not theirs: ${nested.join(", ")} would end with ${one ? "its parent" : "their parents"} `
        + `and not run again. Nothing was started. Let ${one ? "it" : "them"} finish first, or pass --force to end ${one ? "it" : "them"}.`);
    }
    treeWarnings.push(`--force: ${nested.join(", ")} ${one ? "ends" : "end"} with ${one ? "its parent" : "their parents"} and ${one ? "isn't" : "aren't"} run again.`);
  }
  // #1125: the folders each helper may write when it runs Codex again, from the folder it runs in.
  const grantsAt = new Map();
  for (const h of doomed) {
    const cwd = helperCwd({ get: h, worker: workerRowOf(ledger, h.address), realpath: realDir });
    if (cwd && !grantsAt.has(cwd)) grantsAt.set(cwd, await localCodexGrantPlan(cwd));
  }
  const planOf = (h, fresh = null) => {
    const worker = workerRowOf(ledger, h.address);
    // #939, revive only: a helper hc kept as a bare shell names its agent by its launch command.
    const agentKey = agentKeyOfArgv(h.foreground?.argv, agents) ?? worker?.agent
      ?? (revive && isBareShell(h) ? agentKeyOfArgv(paneCommand(h)?.argv, agents) : null) ?? null;
    // A helper that is itself a bot (attached by hand): its binding moves with it.
    const binding = view.byTerminal.get(h.address)?.binding ?? null;
    const proxyIdentity = agentKey === "dsh-tui" && process.platform === "linux" ? {
      botId: binding?.bot ?? worker?.botId ?? h.labels?.[WORKER_OF_LABEL] ?? bot.id,
      project: binding?.project ?? worker?.project ?? project.key, worker: !binding,
    } : null;
    // #823: the bot whose permission list an Antigravity helper gets: the one the pane plays
    // (an attached bot), else its worker row's bot, else the bot being restarted.
    const agyBot = [binding?.bot, worker?.botId].map((id) => project.file.bots.find((b) => b.id === id)).find(Boolean)
      ?? project.file.bots.find((b) => b.id === bot.id) ?? bot;
    for (const k of ["agent.session", "revive.session"]) holdId(h.labels?.[k]);
    holdId(knownSession(h, agentKey)?.session);
    const grantPlan = grantsAt.get(helperCwd({ get: h, worker, realpath: realDir })) ?? null;
    const planned = helperPlan({ get: h, worker, session: knownSession(h, agentKey)?.session ?? null,
      agents, fresh, bot: agyBot, agy: { appHomeDir: appHome(), bot: agyBot, realpath: realDir, homeDir: home() },
      launchAgent: revive && isBareShell(h), grants: grantPlan?.dirs ?? [], where: localWhere() });
    // #1418: an attached helper's native template becomes a label when the seat is rebuilt.
    if (binding && planned.template && !Object.hasOwn(planned.labels, WORKER_TEMPLATE_LABEL)) {
      planned.labels[WORKER_TEMPLATE_LABEL] = planned.template;
    }
    // #1142: a Codex helper run in the launch mode says what its launch withheld; a template
    // worker runs its own command as written and gets nothing of the pack's.
    const templateWorker = Boolean(worker?.template || h.labels?.[WORKER_TEMPLATE_LABEL]);
    const codexWithheld = agentKey === "codex" && !planned.error && !templateWorker && grantPlan
      ? localCodexWarning(worker || h.labels?.[WORKER_OF_LABEL] ? agents.codex?.run : paneCommand(h)?.argv, grantPlan) : null;
    return { ...planned, codexWithheld,
      worker, binding, proxyIdentity,
      createdMs: Number.isSafeInteger(h.created_ms) ? h.created_ms : null };
  };
  let tree = doomed.map((h) => planOf(h));
  for (const p of tree) {
    if (p.warning) treeWarnings.push(p.warning);
    if (p.codexWithheld) treeWarnings.push(`${p.name ?? p.replaced}: ${p.codexWithheld}`);
  }
  const broken = tree.filter((p) => p.error).map((p) => p.error);
  const gone = tree.filter((p) => !p.error && !isDir(p.cwd)).map((p) => `${p.replaced}'s folder ${p.cwd} isn't there`);
  if (broken.length || gone.length) {
    throw new CliError(`${[...broken, ...gone].join("; ")}. Nothing was started. Restart without --tree (--force ends ${old.address}'s helpers with it).`);
  }
  for (const plan of tree) if (plan.proxyIdentity) helperCommand(plan);
  const whoOf = (p) => p.name ?? p.replaced;
  const runs = () => [run, ...tree.map((p) => ({ who: whoOf(p), agent: p.agent, cwd: p.cwd, session: p.session, mode: p.mode }))];
  // Two of them naming one session would run it in two panes at once.
  const twice = sameSessions(runs());
  if (twice.length) {
    throw new CliError(`${twice.map((g) => `${g.who.join(" and ")} would all resume one session (${SESSION_MASK})`).join("; ")}: one session runs in one pane. `
      + `Nothing was started. Fix the agent.session (or revive.session) label of the wrong one, or restart without --tree.`);
  }
  let shared = sharedFolders(runs());
  if (shared.length && freshShared) {
    const helperIdless = new Set(shared.flatMap((g) => g.idless).filter((w) => w !== run.who));
    tree = tree.map((p, i) => (helperIdless.has(whoOf(p)) ? planOf(doomed[i], `no session id, and its folder ${p.cwd} has other ${p.agent} sessions (--fresh-shared)`) : p));
    shared = sharedFolders(runs());
  }
  if (shared.length) {
    const lines = shared.map((g) => `${g.idless.join(", ")} would resume the latest ${g.agent} conversation in ${g.cwd} (no session id), which ${g.who.join(", ")} all use`);
    const botToo = shared.some((g) => g.idless.includes(run.who));
    throw new CliError(`${lines.join("; ")}: one could pick up another's. Nothing was started. Give each an agent.session label, `
      + `${botToo && freshShared ? `or restart ${bot.name} with --fresh too` : `or pass --fresh-shared to start those helpers on a new conversation${botToo ? ` (and --fresh for ${bot.name})` : ""}`}.`);
  }
  return { tree, treeWarnings };
}

// Queue mutations share a lock: cancel, replace and watcher consumption cannot lose rows.
const queuePath = () => join(appHome(), "automagik-herdr", "queued-restarts.json");
function readRestartQueue() {
  const text = readText(queuePath());
  if (text === null) return [];
  try { const rows = JSON.parse(text); if (Array.isArray(rows)) return rows; } catch {}
  throw new CliError(`Can't read ${queuePath()}: invalid restart queue`);
}
async function editRestartQueue(edit) {
  const file = queuePath();
  mkdirSync(dirname(file), { recursive: true });
  return withLockAsync(`${file}.lock`, async () => {
    const rows = readRestartQueue();
    const result = await edit(rows);
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } finally { try { unlinkSync(tmp); } catch {} }
    return result;
  });
}

/** No screen capture is treated as absent, just as pure callers without a capture are. */
async function readScreenText(terminal) {
  const r = await hc(["read", terminal, "--lines", "40", "--json"]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout)?.text ?? null; } catch { return null; }
}

/**
 * The same read with the difference #1557 needs: an unreadable tail is `{ ok: false }`, never
 * an empty screen that a caller could mistake for "the dialog is gone" (which would heal an
 * episode or cancel a queued restart without any evidence).
 */
async function readScreenCapture(terminal) {
  try {
    const r = await hc(["read", terminal, "--lines", "40", "--json"]);
    if (r.code !== 0) return { ok: false };
    const text = JSON.parse(r.stdout)?.text;
    return typeof text === "string" ? { ok: true, text } : { ok: false };
  } catch { return { ok: false }; }
}

/** End a queued watcher only while it is the live pane this queue started (never a reused address). */
async function killQueuedWatcher(watcher) {
  if (!watcher) return;
  const state = await hcState(watcher);
  if (state.state === "live" && state.get?.labels?.["herdr.queued-restart"]) await hcKill(watcher);
}

async function queuedRestarts(opts, ref) {
  const project = opts.project ? (await projectFor(opts)).key : null;
  if (opts.queued) {
    const entries = await editRestartQueue(async (rows) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const e = rows[i];
        const state = await hcState(e.terminal);
        // A dead watcher means this entry can never fire, even while its pane still runs.
        let stale = ["gone", "finished"].includes(state.state) || (state.get && e.created_ms != null && state.get.created_ms !== e.created_ms);
        if (!stale && e.watcher) {
          const wState = await hcState(e.watcher);
          stale = ["gone", "finished"].includes(wState.state);
        }
        if (stale) {
          await killQueuedWatcher(e.watcher);
          rows.splice(i, 1);
        }
      }
      return rows.filter((e) => !project || e.project === project);
    });
    // #1556: a handoff that failed or was dropped is kept in the app home, so the reader that
    // already answers "what is queued" also answers "what didn't happen" after the watcher's pane went away.
    const record = readHandoffFailureRecord();
    const failures = record.rows.filter((f) => !project || f.project === project);
    const failureLine = (f) => `${f.botName} (${f.botId ?? "no id"}): handoff restart ${f.kind} at ${f.at}: ${f.why}`
      + `${f.handoff ? ` (handoff: ${f.handoff})` : ""}`
      + `${f.notified?.sent ? `; the lead was told in ${f.notified.sent}` : f.notified?.unsent ? `; the lead was not told: ${f.notified.unsent}` : ""}.`;
    const skippedLine = (s) => `Skipped handoff failure row ${s.row}: ${s.reason}.`;
    const lines = [
      ...entries.map((e) => `${e.botName} (${e.botId}): queued on ${e.terminal} (${e.reason}`
        + `${e.resets_at ? ` until ${e.resets_at}` : ""}${e.wake_at ? `, wake at ${e.wake_at}` : ""}`
        + `${e.dialog ? `: "${e.dialog.question}" — ${e.dialog.who} must answer` : ""}) since ${e.at}`),
      ...failures.map(failureLine),
      ...record.skipped.map(skippedLine),
    ];
    return opts.json ? { queued: entries, ...(failures.length ? { handoff_failures: failures } : {}),
      ...(record.skipped.length ? { handoff_failures_skipped: record.skipped } : {}) }
      : lines.length ? lines.join("\n") : "No restarts queued.";
  }
  if (!ref) throw new CliError("restart --cancel needs a bot.", 2);
  let bot = null;
  const matches = readRestartQueue().filter((e) => (!project || e.project === project) && [e.botId, e.botName].includes(ref));
  if (matches.length > 1) throw new CliError(`More than one queued bot matches ${ref}; use --project.`, 2);
  if (!matches.length) bot = await botIn(await projectFor(opts), ref, opts);
  const id = matches[0]?.botId ?? bot.id, name = matches[0]?.botName ?? bot.name;
  const entry = await editRestartQueue(async (rows) => {
    const i = rows.findIndex((e) => e.botId === id && (!project || e.project === project));
    if (i < 0) return null;
    const [e] = rows.splice(i, 1);
    await killQueuedWatcher(e.watcher);
    return e;
  });
  return opts.json ? { id, canceled: Boolean(entry), terminal: entry?.terminal ?? null }
    : entry ? `${name}: canceled queued restart for ${entry.terminal}.` : `No restart is queued for ${name}.`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// #1556: the handoff a seat writes before it is restarted from a fresh conversation. The file
// lives under the app home, one per bot, and is emptied just before each request (a stale
// handoff from an earlier pass, or bytes appended since, are never sent).
const HANDOFF_DIR = "automagik-herdr/handoff";
/** How long a seat may take to write its handoff before the pass reports it and leaves it running. */
const HANDOFF_WAIT_MS = Math.max(50, Number(process.env.AUTOMAGIK_HERDR_HANDOFF_WAIT_MS) || 120_000);
/** How often the wait looks at the pane and the file. */
const HANDOFF_POLL_MS = Math.max(10, Math.min(2000, Number(process.env.AUTOMAGIK_HERDR_HANDOFF_POLL_MS) || 500));
/** The longest handoff sent as a conversation's first message; the file keeps the rest. */
const HANDOFF_MAX_CHARS = 64 * 1024;

/** A bot's handoff file under the app home (#1556). */
const handoffPathOf = (botId) => `${appHome()}/${HANDOFF_DIR}/${botId}.md`;

/** What the seat is asked to write (#1556): the handoff's three parts, then end the turn. */
const handoffRequestText = (bot, path) => `Context handoff for ${bot.name} (${bot.id}): your context is over its restart threshold. `
  + `Write your handoff to ${path} now: what is in flight, what waits on whom, and your next three actions. `
  + "Then end your turn; you will be restarted from that file.";

/**
 * Why the handoff at `path` can't be written (#1556), or null. Checked BEFORE the seat is asked:
 * a pass that can't keep the handoff refuses instead of half-restarting. A handoff path that is
 * not a plain file is refused too.
 */
function handoffRefusal(path) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let held = null;
    try { held = lstatSync(path); } catch { /* not there yet */ }
    if (held && !held.isFile()) return `${path} exists and is not a plain file`;
    // Open it appending (making an empty file when it is absent): the same user's write the seat
    // needs, with no temp file to sweep. The file is emptied again just before the request.
    const fd = openSync(path, "a", 0o600);
    closeSync(fd);
    return null;
  } catch (e) { return `${path} can't be written (${e?.message ?? e})`; }
}

/**
 * Whether a handoff at `path` could be written, without creating anything (#1556, --dry-run).
 * The same refusal the real pass gives, checked with lstat/access instead of an append open.
 */
function handoffWritable(path) {
  try {
    let held = null;
    try { held = lstatSync(path); } catch { /* not there yet */ }
    if (held && !held.isFile()) return `${path} exists and is not a plain file`;
    if (held) { accessSync(path, constants.W_OK); return null; }
    let dir = dirname(path);
    for (;;) {
      let st = null;
      try { st = statSync(dir); } catch { /* not there */ }
      if (st) {
        if (!st.isDirectory()) return `${dir} is not a folder`;
        accessSync(dir, constants.W_OK);
        return null;
      }
      const up = dirname(dir);
      if (up === dir) return `${path} can't be written`;
      dir = up;
    }
  } catch (e) { return `${path} can't be written (${e?.message ?? e})`; }
}

/** Empties the handoff just before the ask (#1556): only bytes written after it can be sent. */
function clearHandoff(path) {
  try { const fd = openSync(path, "w", 0o600); closeSync(fd); return null; }
  catch (e) { return `${path} can't be emptied (${e?.message ?? e})`; }
}

/** Whether `path` is a non-empty handoff file written at or after `since` (#1556). */
function handoffReady(path, since) {
  try { const st = statSync(path); return st.isFile() && st.size > 0 && st.mtimeMs >= since; } catch { return false; }
}

/** The handoff's text (#1556), or null when it isn't there or is empty. Cut only in the sent copy. */
function readHandoff(path) {
  const text = readText(path);
  if (text === null || text.trim() === "") return null;
  return text.length > HANDOFF_MAX_CHARS
    ? `${text.slice(0, HANDOFF_MAX_CHARS)}\n\n[handoff cut at ${HANDOFF_MAX_CHARS} characters; read the whole file at ${path}]`
    : text;
}

/**
 * Waits after the request for a handoff NEWER than it while the pane is idle (#1556). One
 * `AUTOMAGIK_HERDR_HANDOFF_WAIT_MS` limit; a pane that ends or a seat that keeps working past
 * it is returned, never restarted. `{ state, get, idle, timedOut }`.
 */
async function waitForHandoff({ terminal, path, since, waitMs = HANDOFF_WAIT_MS, pollMs = HANDOFF_POLL_MS }) {
  const began = Date.now();
  for (;;) {
    const state = await hcState(terminal);
    if (state.state !== "live" || (state.get && state.get.labels && state.get.state === "finished")) {
      return { state: state.state, get: state.get ?? null, idle: false, timedOut: false };
    }
    const screen = state.get?.status?.state !== "blocked" ? await readScreenText(terminal) : null;
    const idle = isPaneIdle(state.get, screen);
    if (idle && handoffReady(path, since)) return { state: "live", get: state.get, idle: true, timedOut: false };
    if (Date.now() - began >= waitMs) return { state: "live", get: state.get, idle, timedOut: true };
    await sleep(Math.max(10, Math.min(pollMs, waitMs - (Date.now() - began))));
  }
}

/**
 * Sends a written handoff as the new conversation's first message (#1556), once its agent is
 * ready (hc's own order: wait, then send; a send to a booting agent can be dropped). Never
 * throws: null, or one warning line naming the file and how to send it by hand.
 */
async function sendHandoffMessage(terminal, handoff, path) {
  let said;
  try {
    await hc(["wait", terminal, "--timeout", String(FIRST_TASK_WAIT_S), "--json"], { timeout: (FIRST_TASK_WAIT_S + 10) * 1000 });
    const r = await hc(["send", terminal, handoff]);
    if (r.code === 0) return null;
    said = hcSaid((r.stderr || r.stdout).trim()).split("\n")[0] || `exit ${r.code}`;
  } catch (e) { said = e?.message ?? String(e); }
  return `${path} wasn't sent to ${terminal} as its first message (hc send: ${said}); the file is still there: send it by hand with hc send ${terminal} "<handoff>".`;
}

const RETRY_QUEUED = Symbol("retry-queued");

// ---- #1556: a handoff restart that failed or was dropped is kept, and its owner/lead told ----

/** The last failed handoff restart per bot, under the app home; `am restart --queued` reads it. */
const HANDOFF_FAILURES_PATH = () => join(appHome(), "automagik-herdr", "handoff-failures.json");
/** How many failed bots the small record keeps; one per bot, newest first. */
const HANDOFF_FAILURES_MAX = 20;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One stored row, normalized for printing and rewriting, or why it cannot be. A non-object row
 * (JSON's null, string, number, array) is skipped, never read through; a row without a usable
 * botName is skipped too; a row with one keeps its name and fills the fields it did not record
 * with placeholders, so the reader never prints `undefined`.
 */
function handoffFailureRow(raw, index) {
  const row = index + 1;
  if (raw === null) return { skipped: { row, reason: "not an object (null)" } };
  if (Array.isArray(raw)) return { skipped: { row, reason: "not an object (array)" } };
  if (typeof raw !== "object") return { skipped: { row, reason: `not an object (${typeof raw})` } };
  if (typeof raw.botName !== "string" || !raw.botName.trim()) return { skipped: { row, reason: "no usable botName" } };
  const text = (value) => typeof value === "string" && value.trim() ? value : null;
  return { row: {
    at: text(raw.at) ?? "(time not recorded)",
    kind: text(raw.kind) ?? "unknown",
    botId: text(raw.botId) ?? (typeof raw.botId === "number" ? String(raw.botId) : null),
    botName: raw.botName,
    project: text(raw.project),
    terminal: text(raw.terminal),
    handoff: text(raw.handoff),
    why: text(raw.why) ?? "(no reason recorded)",
    report: text(raw.report),
    notified: isRecord(raw.notified) ? { sent: text(raw.notified.sent), unsent: text(raw.notified.unsent) } : null,
  } };
}

/** The record's usable rows and the malformed ones it skipped, each with its reason. */
function readHandoffFailureRecord() {
  const text = readText(HANDOFF_FAILURES_PATH());
  if (text === null) return { rows: [], skipped: [] };
  let stored;
  try { stored = JSON.parse(text)?.failures; } catch { return { rows: [], skipped: [] }; }
  if (!Array.isArray(stored)) return { rows: [], skipped: [] };
  const rows = [], skipped = [];
  for (const [index, raw] of stored.entries()) {
    const read = handoffFailureRow(raw, index);
    if (read.row) rows.push(read.row); else skipped.push(read.skipped);
  }
  return { rows, skipped };
}

/** The recorded failures: [{ at, kind, botId, botName, project, terminal, handoff, why, report, notified }]. */
function readHandoffFailures() {
  return readHandoffFailureRecord().rows;
}

/** Keeps `failure` as its bot's only row, newest first, 0600, replaced atomically. */
async function recordHandoffFailure(failure) {
  const file = HANDOFF_FAILURES_PATH();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  await withLockAsync(`${file}.lock`, async () => {
    const rows = [failure, ...readHandoffFailures().filter((row) => row.botId !== failure.botId)].slice(0, HANDOFF_FAILURES_MAX);
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(tmp, unprinted(`${JSON.stringify({ version: 1, failures: rows })}\n`), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } finally { try { unlinkSync(tmp); } catch {} }
  });
}

/** Drops a bot's failure row after a later handoff restart reaches its new conversation. */
async function clearHandoffFailure(botId) {
  const rows = readHandoffFailures();
  if (!rows.some((row) => row.botId === botId)) return;
  const file = HANDOFF_FAILURES_PATH();
  await withLockAsync(`${file}.lock`, async () => {
    const left = readHandoffFailures().filter((row) => row.botId !== botId);
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(tmp, unprinted(`${JSON.stringify({ version: 1, failures: left })}\n`), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } finally { try { unlinkSync(tmp); } catch {} }
  });
}

/**
 * One line to a project's main bot, the pack's existing report path: the same `hc send` `am
 * revive` uses, to the live pane the attach ledger binds. Never throws: { sent, unsent }.
 */
async function reportToMainBot(projectKey, line) {
  let project;
  try { project = loadProject(projectKey); } catch (e) { return { sent: null, unsent: `its project couldn't be read (${e?.message ?? e})` }; }
  const main = mainBotOf(project.file);
  if (!main) return { sent: null, unsent: "the project has no main bot that can be read" };
  let view;
  try { view = await attachView(); } catch (e) { return { sent: null, unsent: `its attach ledger couldn't be read (${e?.message ?? e})` }; }
  const held = liveFor(view, main.id, project);
  if (!held) return { sent: null, unsent: `${main.name} has no pane` };
  const terminal = held.binding.terminal;
  try {
    const state = await hcState(terminal);
    if (state.state !== "live" || state.get?.created_ms !== held.binding.created_ms || !agentInForeground(state.get)) {
      return { sent: null, unsent: `${main.name}'s pane ${terminal} runs no agent` };
    }
    const r = await hc(["send", terminal, line]);
    if (r.code === 0) return { sent: terminal, unsent: null };
    return { sent: null, unsent: `hc send ${terminal} failed (${hcSaid((r.stderr || r.stdout).trim())})` };
  } catch (e) { return { sent: null, unsent: `the report to ${terminal} couldn't be sent (${e?.message ?? e})` }; }
}

/**
 * Persists a handoff restart that failed or was dropped (#1556) and tells the project's main
 * bot through `reportToMainBot` (the revive path) unless `notify` is false (a pass that already
 * reported it to the person running it). `kind`: "timeout", "refused", "helpers", "dropped" or
 * "send". Never throws: a failed record or send must not hide the failure itself.
 */
async function noteHandoffFailure({ botId, botName, project, terminal }, kind, why, handoff, { notify = true } = {}) {
  const said = unprinted(String(why ?? ""));
  const detail = said.startsWith(`${botName}: `) ? said.slice(botName.length + 2) : said;
  const report = `${botName}: a handoff restart failed (${kind}): ${firstSentence(detail)}.`;
  let notified = null;
  if (notify) {
    try { notified = await reportToMainBot(project, report); } catch (e) { notified = { sent: null, unsent: `the report wasn't sent (${e?.message ?? e})` }; }
  }
  try {
    await recordHandoffFailure({ at: new Date().toISOString(), kind, botId, botName, project: project ?? null, terminal: terminal ?? null,
      handoff: handoff ?? null, why: said, report, notified });
  } catch { /* the thrown error and the queue entry already say it */ }
  return { report, notified };
}


async function runQueuedRestart(opts) {
  const queueId = opts["run-queued"];
  const began = Date.now();
  const current = () => readRestartQueue().find((e) => e.id === queueId);
  let entry = current();
  if (!entry) return PRINTED;
  // A parked seat's wake is its reset plus the grace; the default cap must outlast a 7-day
  // window, so a wake beyond it is still honoured (a test can cap the run with the env var).
  const park = entry.options?.rateLimit === true;
  const wake = park && entry.wake_at ? Date.parse(entry.wake_at) : NaN;
  const maxMs = Math.max(1000, Number(process.env.AUTOMAGIK_HERDR_QUEUE_MAX_MS) || 86_400_000,
    Number.isFinite(wake) ? wake - began + 300_000 : 0);
  const helperMaxMs = Math.max(50, Number(process.env.AUTOMAGIK_HERDR_QUEUE_HELPER_WAIT_MS) || 30_000);
  /** How long one parked wait may sleep before looking at the pane again (a cancel, a recovery). */
  const parkPollMs = Math.max(10, envMs("AUTOMAGIK_HERDR_RATE_LIMIT_POLL_MS", 60_000));
  let helperBlockedSince = null;
  // #1556: a queued handoff restart asks for the handoff once its seat is idle, waits for a
  // file newer than the ask, then runs the same --fresh --tree restart and sends the file as
  // the new conversation's first message. A seat that never writes it is left running.
  const handoff = entry.options?.handoff === true;
  const handoffFile = handoff ? handoffPathOf(entry.botId) : null;
  let askedAt = null;
  const drop = () => editRestartQueue((rows) => { const i = rows.findIndex((e) => e.id === queueId); if (i >= 0) rows.splice(i, 1); });
  try {
    for (;;) {
      if (Date.now() - began >= maxMs) {
        if (handoff) {
          await noteHandoffFailure(entry, "dropped", `${entry.botName}: its queued handoff restart waited `
            + `${Math.round(maxMs / 1000)}s without the seat becoming idle, so it was dropped.`, handoffFile);
        }
        return PRINTED;
      }
      const state = await hcState(entry.terminal);
      const moved = Boolean(state.get && entry.created_ms != null && state.get.created_ms !== entry.created_ms);
      if (["gone", "finished"].includes(state.state) || moved) {
        if (handoff) {
          // A detached watcher's stderr dies with its --rm pane: a seat that ends or is reused
          // before the restart must leave the same record — and word to the lead — as every
          // other failed handoff, never a silent return (#1556).
          const why = state.state === "gone"
            ? `${entry.botName}: its pane ${entry.terminal} is gone before the queued handoff restart, so it was dropped and not restarted.`
            : state.state === "finished"
              ? `${entry.botName}: its pane ${entry.terminal} finished before the queued handoff restart, so it was dropped and not restarted.`
              : `${entry.botName}: its pane ${entry.terminal} was reused (created_ms ${entry.created_ms} -> ${state.get.created_ms}) before the queued handoff restart, so it was dropped and not restarted.`;
          await noteHandoffFailure(entry, "dropped", why, handoffFile);
        }
        return PRINTED;
      }
      if (park) {
        // The watcher can always cancel: one readable pane without the dialog is enough
        // evidence that the seat recovered (or that the text was never the dialog), whatever
        // the pane's status says. An unreadable pane is no evidence either way, so it waits.
        const capture = await readScreenCapture(entry.terminal);
        const showing = capture.ok ? rateLimitDialog(capture.text) : null;
        if (capture.ok && !showing) {
          await drop();
          return PRINTED;
        }
        // No reset in the dialog: no wake time was invented, so never restart on a timer. Keep
        // watching only to cancel when the dialog clears.
        if (!entry.wake_at) {
          await sleep(parkPollMs);
          entry = current();
          if (!entry) return PRINTED;
          continue;
        }
        const wakeMs = Date.parse(entry.wake_at);
        if (!Number.isFinite(wakeMs)) {
          // A malformed wake is not a due time: treat it as unknown, never as "now".
          await sleep(parkPollMs);
          entry = current();
          if (!entry) return PRINTED;
          continue;
        }
        const wait = Math.max(0, wakeMs - Date.now());
        if (wait > 0 || !capture.ok) {
          // A pane that can't be read is no evidence of the dialog, so a due wake waits too.
          await sleep(Math.min(wait > 0 ? wait : parkPollMs, parkPollMs));
          entry = current();
          if (!entry) return PRINTED;
          continue;
        }
        // Its wake is due and the dialog is still on the readable pane: replace it now, resuming
        // the conversation. --force is internal (a blocked pane would otherwise queue again);
        // the person asked for a restart. cmdRestart consumes the entry itself, so a cancel that
        // lands first still wins.
        const result = await cmdRestart({ project: entry.project, force: true, json: opts.json, _queuedTarget: entry }, [entry.botId]);
        return result;
      }
      // A blocked pane is never idle: skip the screen read (an hc RPC on every poll).
      const screen = state.get?.status?.state !== "blocked" && state.get ? await readScreenText(entry.terminal) : null;
      const idle = isPaneIdle(state.get, screen);
      // The watcher's own helper check: a live helper is waited out before cmdRestart is asked.
      const helpers = idle ? await helpersOf(entry.terminal, { strict: Boolean(entry.options?.tree) }) : [];
      let helperRefusal = idle
        ? restartRefusal({ name: entry.botName, old: { ...state.get, status: { state: "idle" } }, helpers,
          force: false, tree: entry.options?.tree })
        : null;
      if (idle && !helperRefusal && handoff && askedAt === null) {
        // Emptied before the send: an agent that appends an answer to an earlier handoff, or
        // merely touches the file, can never have that text sent (#1556).
        const why = clearHandoff(handoffFile);
        if (why) {
          await drop();
          throw new CliError(`${entry.botName}: ${why}, so it was not asked and was not restarted; `
            + `the seat still runs in ${entry.terminal}.`, 1, { refused: "handoff", terminal: entry.terminal, handoffKind: "refused" });
        }
        // Stamped BEFORE the send: an agent that writes during the send's own round trip is
        // still answering this request, never a stale handoff from an earlier pass.
        askedAt = Date.now();
        const r = await hc(["send", entry.terminal, handoffRequestText({ name: entry.botName, id: entry.botId }, handoffFile)]);
        if (r.code !== 0) {
          await drop();
          throw new CliError(`${entry.botName}: couldn't be asked for its handoff in ${entry.terminal} (hc send: `
            + `${hcSaid((r.stderr || r.stdout).trim())}); it is still running and was not restarted.`, 1,
          { refused: "handoff", terminal: entry.terminal, handoffKind: "refused" });
        }
        // Look again before the first wait: an agent that writes at once ends its turn in it.
        entry = current();
        if (!entry) return PRINTED;
        continue;
      }
      if (idle && !helperRefusal && handoff && !handoffReady(handoffFile, askedAt)) {
        const waited = Date.now() - askedAt;
        if (waited >= HANDOFF_WAIT_MS) {
          await drop();
          throw new CliError(`${entry.botName}: still running in ${entry.terminal}; it didn't write ${handoffFile} `
            + `within ${Math.round(HANDOFF_WAIT_MS / 1000)}s, so it was not restarted.`, 1,
          { refused: "handoff", terminal: entry.terminal, handoffKind: "timeout" });
        }
        await sleep(Math.max(10, Math.min(HANDOFF_POLL_MS, HANDOFF_WAIT_MS - waited)));
        entry = current();
        if (!entry) return PRINTED;
        continue;
      }
      if (idle && !helperRefusal) {
        // The handoff has to be there and readable BEFORE anything starts: an empty or missing
        // file refuses here, with the seat still running, never a fresh conversation with nothing.
        const handoffText = handoff ? readHandoff(handoffFile) : null;
        if (handoff && !handoffText) {
          await drop();
          throw new CliError(`${entry.botName}: ${handoffFile} is missing or empty, so it was not restarted; `
            + `the seat still runs in ${entry.terminal}.`, 1, { refused: "handoff", terminal: entry.terminal, handoffKind: "refused" });
        }
        const saved = Object.fromEntries(Object.entries(entry.options ?? {}).filter(([, value]) => value !== null));
        const callOpts = { ...saved, "fresh-shared": saved.freshShared, project: entry.project, force: false,
          json: handoff ? true : opts.json, _queuedTarget: entry };
        const result = await cmdRestart(callOpts, [entry.botId]);
        if (result !== RETRY_QUEUED) {
          if (!handoff) return result;
          if (result === PRINTED) {
            // cmdRestart's fire-time look can find the seat no longer its live pane. A person's
            // cancel already removed the entry, so only a surviving entry is a drop (#1556).
            if (current()) {
              const now = await hcState(entry.terminal);
              const moved = Boolean(now.get && entry.created_ms != null && now.get.created_ms !== entry.created_ms);
              const why = ["gone", "finished"].includes(now.state)
                ? `${entry.botName}: its pane ${now.state === "gone" ? "is gone" : "finished"} at the restart, so the queued handoff restart was dropped and it was not restarted.`
                : moved
                  ? `${entry.botName}: its pane was reused (created_ms ${entry.created_ms} -> ${now.get.created_ms}) at the restart, so the queued handoff restart was dropped and it was not restarted.`
                  : `${entry.botName}: its pane ${entry.terminal} is no longer its live seat at the restart, so the queued handoff restart was dropped and it was not restarted.`;
              await noteHandoffFailure(entry, "dropped", why, handoffFile);
            }
            return PRINTED;
          }
          const terminal = typeof result === "object" && result ? result.terminal : null;
          const warning = terminal
            ? await sendHandoffMessage(terminal, handoffText, handoffFile)
            : `${handoffFile} wasn't sent: the restart gave no new terminal; read it by hand.`;
          if (warning) {
            report([warning]);
            await noteHandoffFailure(entry, "send", warning, handoffFile);
          } else {
            await clearHandoffFailure(entry.botId);
          }
          return opts.json ? { ...result, handoff: handoffFile, ...(warning ? { warning } : {}) }
            : `${entry.botName}: restarted from ${handoffFile}${terminal ? ` in ${terminal}` : ""}${warning ? `; ${warning}` : ""}.`;
        }
        // cmdRestart's fire-time check kept it: wait for the helper or the next idle at the slow floor.
        helperRefusal = callOpts._queuedRefusal ?? null;
      }
      const blockedByHelpers = Boolean(helperRefusal);
      if (blockedByHelpers) {
        helperBlockedSince ??= Date.now();
        if (Date.now() - helperBlockedSince >= helperMaxMs) {
          await drop(); // out of the queue before the person hears why
          if (isPaneIdle(state.get, screen)) {
            try { await hc(["send", entry.terminal, `${entry.botName}: queued restart refused — ${helperRefusal}`]); } catch {}
          }
          throw new CliError(helperRefusal, 1, { refused: "helpers", terminal: entry.terminal, handoffKind: "helpers" });
        }
      } else {
        helperBlockedSince = null;
      }
      const start = Date.now();
      // hc wait returns at once for a blocked pane: poll those, and a pane kept for its helpers,
      // at the slower floor instead of spinning the wait at the fast one.
      if (state.get?.status?.state === "working" && !blockedByHelpers) {
        await hc(["wait", entry.terminal, "--timeout", "25", "--json"], { timeout: 30000 });
      }
      const raw = process.env.AUTOMAGIK_HERDR_QUEUE_POLL_MS?.trim();
      const configured = raw ? Number(raw) : NaN;
      const poll = Number.isFinite(configured)
        ? Math.max(1, configured)
        : (state.get?.status?.state === "working" && !blockedByHelpers ? 250 : 2000);
      if (Date.now() - start < poll) await new Promise((done) => setTimeout(done, poll - (Date.now() - start)));
      entry = current();
      if (!entry) return PRINTED;
    }
  } catch (e) {
    // #1556: a detached watcher's stderr dies with its --rm pane, so a failed or dropped
    // handoff is kept under the app home and the project's main bot is told before it exits.
    if (handoff) {
      const kind = e?.detail?.handoffKind ?? (e instanceof CliError ? "refused" : "dropped");
      await noteHandoffFailure(entry, kind, e?.message ?? String(e), handoffFile);
    }
    throw e;
  } finally {
    // Every exit path leaves no stale entry: fired, canceled, expired, or a failed fire.
    await drop();
  }
}

async function queueRestart({ bot, key, old, screen, opts, wanted, plan, recovered }) {
  const rateLimited = opts.rateLimit === true;
  const dialog = rateLimited ? null
    : pendingDialog(screen) ?? (old.status?.state === "blocked" ? { question: "confirmation dialog in pane", who: "the owner" } : null);
  const queueId = randomUUID();
  const entry = await editRestartQueue(async (rows) => {
    const i = rows.findIndex((e) => e.botId === bot.id);
    if (i >= 0) { const [prev] = rows.splice(i, 1); await killQueuedWatcher(prev.watcher); }
    const e = { id: queueId, botId: bot.id, botName: bot.name, project: key, terminal: old.address, created_ms: old.created_ms ?? null,
      reason: opts.handoff ? "due" : rateLimited ? "rate-limited" : dialog ? "blocked" : "working", dialog,
      ...(opts.wakeAt ? { wake_at: opts.wakeAt } : {}), ...(opts.resetsAt ? { resets_at: opts.resetsAt } : {}),
      options: { fresh: Boolean(opts.fresh), agent: opts.agent ?? null,
        model: opts.model ?? null, save: Boolean(opts.save), tree: Boolean(opts.tree), freshShared: Boolean(opts["fresh-shared"]),
        cwd: wanted ?? null, space: opts.space ?? null, tab: opts.tab ?? null, force: Boolean(opts.force),
        ...(rateLimited ? { rateLimit: true } : {}),
        ...(opts.handoff ? { handoff: true, contextTokens: opts.contextTokens ?? null, restartAt: opts.restartAt ?? null } : {}),
        ...(recovered ? { recoveredHome: true } : {}) }, watcher: null, at: new Date().toISOString() };
    // Persist before starting: the detached process may read immediately, then takes this lock.
    const file = queuePath(), tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...rows, e]), { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, file);
    // env -i: herdr-core's environment does not leak into the watcher. Only these explicit
    // values and the queue/agent variables the watcher and its tests need are passed.
    // HC_SOCKET, HC_TERMINAL_ID and HC_TERMINAL_SOCKET are never copied from here: the
    // caller pane's would make the watcher that bot's own pane (#805). The sh in front of
    // env -i adds the two hc gave the watcher's own run instead.
    const watcherEnv = [
      `HOME=${home()}`,
      `HERDR_APP_HOME=${appHome()}`,
      `PATH=${launchPath(process.execPath, key).path}`,
      ...Object.entries(process.env)
        .filter(([k, v]) => v !== undefined && (
          k.startsWith("AUTOMAGIK_HERDR_") ||
          ["USER", "LOGNAME", "TMPDIR", "XDG_RUNTIME_DIR", "HERMES_HOME", "VIRTUAL_ENV"].includes(k)
        ))
        .map(([k, v]) => `${k}=${v}`),
    ];
    const watcherShell = [
      'if [ -n "${HC_SOCKET-}" ]; then set -- "HC_SOCKET=$HC_SOCKET" "$@"; fi',
      'if [ -n "${HC_TERMINAL_ID-}" ]; then set -- "HC_TERMINAL_ID=$HC_TERMINAL_ID" "$@"; fi',
      'exec /usr/bin/env -i "$@"',
    ].join("\n");
    const r = await hc(["run", "--bg", "--json", "--rm", "--no-parent", "--cwd", key, "--label", `herdr.queued-restart=${bot.id}`,
      "--", "/bin/sh", "-c", watcherShell, "sh", ...watcherEnv,
      process.execPath, fileURLToPath(import.meta.url), "restart", bot.id, "--project", key, "--run-queued", queueId]);
    let watcher;
    try { watcher = r.code === 0 ? JSON.parse(r.stdout)?.address : null; } catch {}
    if (!watcher) {
      // Roll back the unpublished entry if hc could not start the watcher.
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file);
      throw new CliError(`Could not queue ${bot.name}'s restart: ${(r.stderr || r.stdout).trim()}`);
    }
    e.watcher = watcher;
    rows.push(e);
    return e;
  });
  if (opts.json) return { id: bot.id, queued: true, terminal: old.address, reason: entry.reason, dialog,
    ...(entry.wake_at ? { wake_at: entry.wake_at } : {}), ...(entry.resets_at ? { resets_at: entry.resets_at } : {}),
    watcher: entry.watcher, mode: plan.mode, agent: plan.agent, model: plan.model };
  if (rateLimited) {
    const until = entry.resets_at ? ` until ${entry.resets_at}` : "";
    return `${bot.name}: rate-limited${until}; parked in ${old.address}, ${parkedWakeText(entry)} `
      + `(am restart --queued lists it; am restart --cancel ${bot.id} cancels it).`;
  }
  if (opts.handoff) {
    return `${bot.name}: handoff restart queued for ${old.address} (context ${opts.contextTokens ?? "?"} over restartAt ${opts.restartAt ?? "?"}); `
      + `it writes its handoff at its next idle, then restarts from ${handoffPathOf(bot.id)} (am restart --queued lists it; am restart --cancel ${bot.id} cancels it).`;
  }
  const why = dialog ? `blocked on dialog "${dialog.question}" — ${dialog.who} must answer it in ${old.address}; Herdr never answers dialogs` : `${bot.name} is working in ${old.address}`;
  return `${bot.name}: restart queued for ${old.address} (${why}); it will restart and resume at its next idle (am restart --queued lists it; am restart --cancel ${bot.id} cancels it; pass --force to restart now).`;
}

/** Whether the pane is idle now (#1556): a live get, its screen and the one restart idle rule. */
async function paneNow(terminal) {
  const state = await hcState(terminal);
  if (state.state !== "live") return { state: state.state, get: state.get ?? null, screen: null, idle: false };
  const screen = state.get?.status?.state !== "blocked" ? await readScreenText(terminal) : null;
  return { state: "live", get: state.get, screen, idle: isPaneIdle(state.get, screen) };
}

/**
 * A handoff restart already queued for `botId` (#1556), which a periodic pass must leave alone.
 * A queue entry whose watcher is gone can never fire, so that entry is dropped here.
 */
async function queuedHandoffFor(botId) {
  const entry = readRestartQueue().find((e) => e.botId === botId && e.options?.handoff === true);
  if (!entry) return null;
  if (entry.watcher) {
    const state = await hcState(entry.watcher);
    if (["gone", "finished"].includes(state.state)) {
      await editRestartQueue((rows) => { const i = rows.findIndex((e) => e.id === entry.id); if (i >= 0) rows.splice(i, 1); });
      return null;
    }
  }
  return entry;
}

// ---- #1557: a Claude Code seat blocked on the rate-limit dialog ----

/** A non-negative millisecond override from the environment, or `fallback`. */
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** Park restarts a seat this long after the reset the dialog shows (one minute). */
const RATE_LIMIT_GRACE_MS = envMs("AUTOMAGIK_HERDR_RATE_LIMIT_GRACE_MS", 60_000);
/** A meter reading this old cannot prove headroom for a switch (the logger writes every 5 minutes). */
const RATE_LIMIT_METER_FRESH_MS = envMs("AUTOMAGIK_HERDR_RATE_LIMIT_METER_FRESH_MS", 10 * 60_000);
const RATE_LIMIT_KIND = "rate-limit";

/**
 * An episode's key: one dialog wait for one project's bot, however many sweeps see it. It is
 * stored on the item (`episode`) so a later item cannot be mistaken for the same episode, and
 * an unreadable sweep leaves the open item untouched instead of closing and reopening it.
 */
const rateLimitEpisodeKey = (project, botId) => `${RATE_LIMIT_KIND}:${project}:${botId}`;
/** How a parked seat's wake is said: its own reset, or plainly that none was invented. */
const parkedWakeText = (row) => (row.wake_at ? `its restart wakes at ${row.wake_at}` : "no reset time was shown, so it has no timed wake");
/** Whether `row` is this episode (the key, with project+bot as the fallback for older items). */
const isEpisode = (row, project, botId) => row.kind === RATE_LIMIT_KIND
  && (row.episode ? row.episode === rateLimitEpisodeKey(project, botId) : row.project === project && row.botId === botId);

/** The attention items file under the app home: one record per episode, never one per sweep. */
const attentionPath = () => join(appHome(), "automagik-herdr", "attention.json");
/** How many items are kept (open ones always included first in the file, oldest may go). */
const ATTENTION_MAX = 200;

/** The recorded attention items, oldest first. A malformed file throws (never read as "none"). */
function readAttention() {
  const text = readText(attentionPath());
  if (text === null) return [];
  let data;
  try { data = JSON.parse(text); } catch { throw new CliError(`Can't read ${attentionPath()}: invalid attention items`); }
  if (!data || !Array.isArray(data.items)) throw new CliError(`Can't read ${attentionPath()}: invalid attention items`);
  return data.items.filter((row) => row && typeof row === "object");
}

/** Open items in a read that must not fail the command that shows them: a broken record is a note. */
function openAttention(project = null) {
  try {
    return readAttention().filter((row) => row.open === true && row.kind === RATE_LIMIT_KIND && (!project || row.project === project));
  } catch (e) {
    report([`${e?.message ?? e}; no attention items are shown.`]);
    return [];
  }
}

/** Mutates the attention items under one lock and writes them 0600, atomically; returns `edit`'s answer. */
async function editAttention(edit) {
  const file = attentionPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return withLockAsync(`${file}.lock`, async () => {
    const items = readAttention();
    const result = await edit(items);
    const kept = items.slice(-ATTENTION_MAX);
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, items: kept }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    } finally { try { unlinkSync(tmp); } catch {} }
    return result;
  });
}

/**
 * One attention item for a bot's rate-limit episode (key `rate-limit:<project>:<bot id>`): the
 * open item for that episode is returned (`created: false`) instead of a second one, however
 * many sweeps see the same dialog. A new item is written only when no open episode exists, so a
 * seat that never recovers stays at one item until a *readable* sweep sees it healthy
 * (healRateLimitAttention) and a later dialog starts a new episode.
 */
async function noteRateLimitAttention({ project, bot, terminal, created_ms = null, text, resetsAt = null }) {
  return editAttention((items) => {
    const open = items.find((row) => row.open === true && isEpisode(row, project, bot.id));
    if (open) return { row: open, created: false };
    const row = { id: randomUUID(), kind: RATE_LIMIT_KIND, episode: rateLimitEpisodeKey(project, bot.id), project, botId: bot.id, botName: bot.name,
      terminal, created_ms, at: new Date().toISOString(), ...(resetsAt ? { resets_at: resetsAt } : {}), text, open: true };
    items.push(row);
    return { row, created: true };
  });
}

/** Closes every open rate-limit item of `botId` (its seat is readably healthy again, or gone). */
async function healRateLimitAttention(project, botId, why) {
  // A sweep over a healthy team must not rewrite the store: only an open episode is looked at.
  if (!readAttention().some((row) => row.open === true && isEpisode(row, project, botId))) return 0;
  return editAttention((items) => {
    let closed = 0;
    for (const row of items) {
      if (row.open !== true || !isEpisode(row, project, botId)) continue;
      row.open = false;
      row.closed_at = new Date().toISOString();
      row.closed_because = why;
      closed += 1;
    }
    return closed;
  });
}

/** How a login is named in an item: "the default login", "login 2". */
const loginNameOf = (id) => (id === DEFAULT_LOGIN ? "the default login" : `login ${id}`);

/** The folder the meter's limits logger writes to (claude-limits.jsonl), as the logger resolves it. */
const meterDir = () => (process.env.METER_STATE_DIR
  || (process.env.AM_HOME && isAbsolute(process.env.AM_HOME) ? join(process.env.AM_HOME, "meter") : join(home(), ".automagik/meter")));

/** A login's account fingerprint as the limits logger writes it (sha256 of its oauth account, 16 hex), or null. */
function accountHashOf(login) {
  const file = login.id === DEFAULT_LOGIN ? join(home(), ".claude.json") : join(login.dir, ".claude.json");
  const text = readText(file);
  if (text === null) return null;
  try {
    const uuid = JSON.parse(text)?.oauthAccount?.accountUuid;
    return typeof uuid === "string" && uuid ? createHash("sha256").update(uuid).digest("hex").slice(0, 16) : null;
  } catch { return null; }
}

/** The last limits reading for `account` in the meter's log, or null. */
function lastLimitReading(account) {
  try {
    const text = tailTextOf(join(meterDir(), "claude-limits.jsonl"), 256 * 1024);
    let found = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row && row.account === account) found = row; } catch { /* a cut line */ }
    }
    return found;
  } catch { return null; }
}

/**
 * Whether a reading proves headroom now: an unexpired `ts` and a known window under 100%; null
 * when there is no fresh reading. The limits logger writes on a change or every 5 minutes, so a
 * reading older than 10 minutes is stale, not proof: a full window can be hit in between.
 */
function headroomOf(row, now = Date.now()) {
  const measured = Date.parse(row?.ts);
  if (!Number.isFinite(measured) || measured > now + 60_000 || now - measured > RATE_LIMIT_METER_FRESH_MS) return null;
  const windows = [row?.five_hour, row?.seven_day].filter((w) => w && typeof w.used_percentage === "number");
  return windows.length ? windows.every((w) => w.used_percentage < 100) : null;
}

/** The transcript a login holds for `session` in `cwd`, as a non-empty file, or null. */
function transcriptAt(login, cwd, session) {
  const file = login.id === DEFAULT_LOGIN ? claudeTranscriptPath(home(), cwd, session)
    : join(login.dir, "projects", claudeSlug(cwd), `${session}.jsonl`);
  try { const st = statSync(file); return st.isFile() && st.size > 0 ? file : null; } catch { return null; }
}

/**
 * The switch a rate-limit dialog gets (#1557): `{ login, why }`, where `login` is a second
 * signed-in Claude login that can resume this seat's conversation now, or null with the
 * sentence to say instead. A login proves itself only through its own account's *fresh*
 * reading in the meter's `claude-limits.jsonl` (every window under 100%) AND the conversation's
 * transcript in that login's store: switching without it would start a fresh conversation (or
 * resume an unrelated one), so the caller parks instead. The login the pane runs is skipped.
 */
function switchLoginFor(live) {
  const currentDir = paneLaunchEnv(live)?.get(CONFIG_VAR);
  const current = typeof currentDir === "string" && isAbsolute(currentDir) ? (realDir(currentDir) ?? currentDir) : null;
  const defaultDir = join(home(), ".claude");
  const defaultReal = realDir(defaultDir) ?? defaultDir;
  let listed = [];
  try {
    const record = parseLogins(readText(loginsPath(appHome())) ?? "");
    if (!record.problem) listed = record.logins;
  } catch { /* no record: the default login alone */ }
  const cwd = live?.foreground?.cwd ?? live?.cwd;
  // The session the restart would resume: the pane's label, else the hook's ledger row (the
  // same order cmdRestart uses), so a seat whose label is gone can still switch.
  const session = sessionFor("claude", paneSession(live, "claude"))
    ?? ledgerSession(workerLedgerRows(), live?.address, "claude", live?.created_ms)?.session ?? null;
  const noHeadroom = { login: null, why: "no second signed-in login with headroom" };
  const reasons = [];
  const seen = new Set();
  for (const login of [{ id: DEFAULT_LOGIN, dir: null }, ...listed]) {
    if (login.id === DEFAULT_LOGIN) {
      // Its seat already runs the default login (no CLAUDE_CONFIG_DIR, or ~/.claude explicitly).
      if (!current || current === defaultReal) continue;
    } else {
      const real = realDir(login.dir) ?? login.dir;
      if (seen.has(real) || (current && real === current)) continue;
      seen.add(real);
    }
    const account = accountHashOf(login);
    if (!account) continue; // not signed in here
    if (headroomOf(lastLimitReading(account)) !== true) continue;
    if (!session || typeof cwd !== "string" || !isAbsolute(cwd)) {
      reasons.push(`${loginNameOf(login.id)} has headroom, but this seat has no Claude session id to resume`);
      continue;
    }
    if (!transcriptAt(login, cwd, session)) {
      reasons.push(`${loginNameOf(login.id)} has headroom, but it has no conversation for this seat to resume`);
      continue;
    }
    return { login: { id: login.id, dir: login.dir, words: login.id === DEFAULT_LOGIN ? ["-u", CONFIG_VAR] : [`${CONFIG_VAR}=${login.dir}`] }, why: null };
  }
  return reasons.length ? { login: null, why: reasons[0] } : noHeadroom;
}

/** The rate-limit dialog a bot's live Claude Code pane is blocked on, or null. Read-only. */
async function seatRateLimit(project, bot, live) {
  if (project?.machine || !live || live.state !== "live" || resolveAgent(bot?.agent) !== "claude") return null;
  // A working agent is taking a turn; the dialog waits for a person, never behind a turn.
  if (live.status?.state === "working") return null;
  return rateLimitDialog(await readScreenText(live.address));
}

/** This bot's parked rate-limit restart, or null; a dead watcher's entry is dropped first. */
async function queuedParkFor(botId) {
  const entry = readRestartQueue().find((e) => e.botId === botId && e.options?.rateLimit === true);
  if (!entry) return null;
  if (entry.watcher) {
    const state = await hcState(entry.watcher);
    if (["gone", "finished"].includes(state.state)) {
      await editRestartQueue((rows) => { const i = rows.findIndex((e) => e.id === entry.id); if (i >= 0) rows.splice(i, 1); });
      return null;
    }
  }
  return entry;
}

/**
 * The `am rate-limit` sweep (#1557), and the same pass a scheduled `am restart --due` runs
 * first: every live Claude Code seat whose pane tail shows the rate-limit dialog is reported,
 * then reacted to by the project's `onRateLimit`. `park` (the default) queues `am restart
 * <bot>` for one minute after the reset the dialog shows; when it shows none, no wake time is
 * invented and the watcher only cancels when the dialog clears. `switch` restarts it now on
 * another signed-in login with fresh headroom and this conversation's transcript, and parks
 * otherwise. One attention item per episode is written; a *readable* seat seen healthy closes
 * it, and an unreadable sweep leaves it open. `dry` only reports. Never types into the dialog.
 */
async function rateLimitPass(opts, keys, dry, { blockedOnly = false } = {}) {
  const out = { rate_limited: [], parked: [], switched: [], attention: [], notes: [] };
  let { view, hcError } = await viewOrError();
  if (hcError) {
    out.notes.push(`hc couldn't list this computer's panes, so no rate-limit dialog was read (${hcError}).`);
    return out;
  }
  for (const key of keys) {
    let project;
    try { project = loadProject(key); } catch (e) { out.notes.push(`${key}: ${e.message}`); continue; }
    if (project.machine) continue;
    const mode = rateLimitModeOf(project.file);
    for (const bot of project.file.bots) {
      if (bot.planned || resolveAgent(bot.agent) !== "claude") continue;
      const held = await readHeld(project, bot, view);
      const live = held?.get ?? null;
      if (!live || live.state !== "live") {
        if (!dry) await healRateLimitAttention(key, bot.id, "its pane ended");
        continue;
      }
      // The sweep never acts on its own pane: a person running it inside a seat would end it.
      if (process.env.HC_TERMINAL_ID && live.address === process.env.HC_TERMINAL_ID) {
        out.notes.push(`${bot.name}: the sweep runs inside its own pane; run it from a timer or another pane.`);
        continue;
      }
      // The scheduled pass looks only at a seat herdr-core reports blocked: that is the modal
      // dialog waiting on a person. The explicit `am rate-limit` sweep reads every seat, but a
      // working seat is taking a turn and its text is output, never the dialog.
      if (blockedOnly && live.status?.state !== "blocked") continue;
      if (live.status?.state === "working") continue;
      const capture = await readScreenCapture(live.address);
      if (!capture.ok) {
        // No evidence either way: the episode stays open (never healed by a blind sweep).
        out.notes.push(`${bot.name}: its pane tail couldn't be read, so its rate-limit episode was left open.`);
        continue;
      }
      const dialog = rateLimitDialog(capture.text);
      if (!dialog) {
        if (!dry) await healRateLimitAttention(key, bot.id, "it recovered");
        continue;
      }
      const seen = { id: bot.id, name: bot.name, project: key, terminal: live.address, question: dialog.question,
        onRateLimit: mode, ...(dialog.resets_at ? { resets_at: dialog.resets_at } : {}) };
      out.rate_limited.push(seen);
      if (dry) { out.notes.push(`${bot.name}: blocked on the rate-limit dialog; would be ${mode === "switch" ? "switched or parked" : "parked"}.`); continue; }
      // `noLogin` is the switch that had no eligible login (the item says why); a switch that
      // failed for another reason parks without that claim.
      let noLogin = false;
      let noLoginWhy = "";
      if (mode === "switch") {
        const choice = switchLoginFor(live);
        if (choice.login) {
          try {
            const r = await cmdRestart({ project: key, force: true, json: true, _login: { words: choice.login.words, warnings: [] } }, [bot.id]);
            const terminal = r && typeof r === "object" ? r.terminal : null;
            const text = rateLimitLine(bot.name, { outcome: `switched to ${loginNameOf(choice.login.id)}`, resetsAt: dialog.resets_at ?? null });
            const noted = await noteRateLimitAttention({ project: key, bot, terminal: terminal ?? live.address, created_ms: live.created_ms, text, resetsAt: dialog.resets_at });
            out.switched.push({ ...seen, login: choice.login.id, terminal: terminal ?? live.address });
            if (noted.created) out.attention.push(noted.row);
            viewOnce = null;
            ({ view } = await viewOrError());
            continue;
          } catch (e) {
            out.notes.push(`${bot.name}: switching to ${loginNameOf(choice.login.id)} failed (${firstSentence(e?.message ?? String(e))}); parking instead.`);
          }
        } else {
          noLogin = true;
          noLoginWhy = choice.why === "no second signed-in login with headroom"
            ? "no second login with headroom" : "a login has headroom, but it cannot resume this conversation";
          out.notes.push(`${bot.name}: ${choice.why}; parking.`);
        }
      }
      const existing = await queuedParkFor(bot.id);
      // Never invent a wake: without the dialog's own reset there is no timed restart, only a
      // watcher that cancels when the dialog clears.
      const wakeAt = dialog.resets_at ? new Date(Date.parse(dialog.resets_at) + RATE_LIMIT_GRACE_MS).toISOString() : null;
      let entry = existing;
      if (!entry) {
        entry = await queueRestart({ bot, key, old: live, screen: capture.text,
          opts: { json: true, force: true, rateLimit: true, ...(wakeAt ? { wakeAt } : {}), ...(dialog.resets_at ? { resetsAt: dialog.resets_at } : {}) },
          wanted: null, plan: { mode: "resume", agent: "claude", model: null } });
      }
      const text = rateLimitLine(bot.name, { outcome: noLogin ? `parked (${noLoginWhy})` : "parked", resetsAt: dialog.resets_at ?? null });
      const noted = await noteRateLimitAttention({ project: key, bot, terminal: live.address, created_ms: live.created_ms, text, resetsAt: dialog.resets_at });
      out.parked.push({ ...seen, ...(entry.wake_at ? { wake_at: entry.wake_at } : {}) });
      if (noted.created) out.attention.push(noted.row);
    }
  }
  return out;
}

/** `am rate-limit [--all] [--dry-run] [--json]`: one sweep of the #1557 detection and reaction. */
async function cmdRateLimit(opts) {
  if (opts.machine !== undefined) throw new CliError("rate-limit reads this computer's pane tails; run it on the machine whose seats it acts on.", 2);
  const keys = [await commandKeyOf(opts)];
  if (opts.all) for (const key of rememberedKeys()) if (!keys.includes(key)) keys.push(key);
  const dry = opts["dry-run"] === true;
  const result = await rateLimitPass(opts, keys, dry);
  if (opts.json) return result;
  const lines = [
    ...result.attention.map((row) => `! ${row.text}`),
    ...result.rate_limited.filter((r) => !result.parked.some((p) => p.id === r.id) && !result.switched.some((p) => p.id === r.id))
      .map((r) => `${r.name} (${r.id}) at ${r.terminal}: blocked on the rate-limit dialog "${r.question}"`
        + `${r.resets_at ? `; resets ${r.resets_at}` : ""}${dry ? " (dry run: nothing was parked or switched)." : "."}`),
    ...result.parked.map((r) => `${r.name}: parked; ${parkedWakeText(r)} (am restart --queued lists it).`),
    ...result.switched.map((r) => `${r.name}: switched to ${loginNameOf(r.login)} in ${r.terminal}.`),
    ...result.notes,
  ];
  return lines.length ? lines.join("\n") : "No seat is blocked on the rate-limit dialog.";
}

/**
 * `am restart --due` (#1556): the seats whose measured Claude Code context is over their
 * `restartAt`, asked for a handoff and restarted from it. An idle seat goes through the pass
 * now; a working or blocked one is queued (the watcher asks, waits and restarts at its next
 * idle). `--dry-run` prints the plan and touches nothing. A seat that doesn't write its
 * handoff in time is left running and named in the report; a pass that can't keep a handoff
 * refuses it before asking. This computer only: a linked machine's logs are there.
 */
async function cmdRestartDue(opts) {
  if (opts.machine !== undefined) {
    throw new CliError("--due measures this computer's Claude Code session logs; run the pass on the machine whose seats it restarts "
      + "(a linked machine's own am).", 2);
  }
  const invalid = ["fresh", "tree", "force", "fresh-shared", "save", "cancel", "queued", "agent", "model", "cwd", "space", "tab"]
    .filter((k) => opts[k] !== undefined && opts[k] !== false);
  if (invalid.length) {
    throw new CliError(`--due restarts from a handoff, fresh, with the seat's helpers: it takes no --${invalid[0]}, `
      + "--all or --dry-run.", 2);
  }
  const dry = opts["dry-run"] === true;
  const keys = [await commandKeyOf(opts)];
  if (opts.all) for (const key of rememberedKeys()) if (!keys.includes(key)) keys.push(key);
  if (dry) return restartDuePass(opts, keys, true);
  // One pass at a time per app home: two timers must not measure the same seat and race its
  // restart (#1556). A second pass says so instead of waiting behind a handoff wait.
  const lock = join(appHome(), "automagik-herdr", "restart-due.lock");
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let token;
  try { token = await takeLockAsync(lock, LOCK_WAIT, "another restart --due pass"); } catch (e) {
    const why = `another restart --due pass is already running, so this pass did nothing (${e?.message ?? e}).`;
    return opts.json ? { due: [], restarted: [], queued: [], failed: [], notes: [why] } : why;
  }
  const stop = keepFresh(lock, token);
  try { return await restartDuePass(opts, keys, false); } finally { stop(); dropLock(lock, token); }
}

/** The measured, acted-on pass behind `cmdRestartDue` (#1556); `dry` only reports it. */
async function restartDuePass(opts, keys, dry) {
  // #1557 first: a seat parked on the rate-limit dialog must not be woken early by this pass,
  // and this is the scheduled sweep that parks or switches one in the first place.
  const rate = await rateLimitPass(opts, keys, dry, { blockedOnly: true });
  const { view, hcError } = await viewOrError();
  if (hcError) throw new CliError(`hc couldn't list this computer's panes, so no seat's context was read (${hcError}); nothing was asked or restarted.`);
  const ledger = workerLedgerRows();
  const notes = [];
  const due = [];
  for (const key of keys) {
    let project;
    try { project = loadProject(key); } catch (e) { notes.push(`${key}: ${e.message}`); continue; }
    for (const bot of project.file.bots) {
      if (bot.planned) continue;
      // A parked seat has its own wake (its reset plus the grace): no scheduled wake-up before it.
      const parked = await queuedParkFor(bot.id);
      if (parked) {
        notes.push(`${bot.name}: parked on the rate-limit dialog; ${parkedWakeText(parked)}; this pass left it alone.`);
        continue;
      }
      const threshold = restartAtOf(bot);
      if (threshold === null) continue;
      const live = view ? liveFor(view, bot.id, project) : null;
      if (!live) continue;
      if (process.env.HC_TERMINAL_ID && live.binding.terminal === process.env.HC_TERMINAL_ID) {
        notes.push(`${bot.name}: the pass runs inside its own pane; run it from a timer or another pane.`);
        continue;
      }
      const context = seatContext(project, bot, live.get, ledger);
      if (!context || !Number.isFinite(context.tokens)) continue;
      if (!(context.tokens > threshold)) continue;
      due.push({ key, project, bot, threshold, tokens: context.tokens, terminal: live.binding.terminal,
        created_ms: live.get?.created_ms ?? live.binding.created_ms ?? null, live: live.get });
    }
  }
  const line = (r) => `${r.bot.name} (${r.bot.id}) at ${r.terminal} in ${r.key}: context ${r.tokens} > restartAt ${r.threshold}`;
  if (dry) {
    const plans = due.map((r) => {
      const path = handoffPathOf(r.bot.id);
      return { ...r, path, refusal: handoffWritable(path) };
    });
    if (opts.json) return { due: plans.map((r) => ({ id: r.bot.id, name: r.bot.name, project: r.key,
      terminal: r.terminal, context_tokens: r.tokens, restart_at: r.threshold, handoff: r.path,
      refused: r.refusal ?? null })), rate_limited: rate.rate_limited, attention: rate.attention, notes: [...rate.notes, ...notes] };
    return [...plans.map((r) => `${line(r)}; ${r.refusal ? `would be refused: ${r.refusal}; it would not be asked and not restarted.`
      : "would be asked for its handoff, then restarted from it."}`), ...rate.rate_limited.map((r) => `${r.name} (${r.id}) at ${r.terminal}: blocked on the rate-limit dialog; the sweep would ${r.onRateLimit === "switch" ? "switch or park" : "park"} it.`),
    ...rate.notes, ...(plans.length || rate.rate_limited.length ? [] : ["No seat is over its context threshold."]), ...notes].join("\n");
  }
  if (!due.length) {
    if (opts.json) return { due: [], restarted: [], queued: [], failed: [], rate_limited: rate.rate_limited,
      parked: rate.parked, switched: rate.switched, attention: rate.attention, notes: [...rate.notes, ...notes] };
    return [...(rate.attention.length ? rate.attention.map((row) => `! ${row.text}`) : []),
      ...rate.parked.map((r) => `${r.name}: parked; ${parkedWakeText(r)}.`),
      ...rate.switched.map((r) => `${r.name}: switched to ${loginNameOf(r.login)}.`),
      ...rate.notes,
      ...(rate.rate_limited.length ? [] : ["No seat is over its context threshold."]), ...notes].join("\n");
  }
  const restarted = [], queued = [], failed = [];
  const say = [];
  for (const r of due) {
    const path = handoffPathOf(r.bot.id);
    const refuse = async (why, kind = "refused") => {
      failed.push({ id: r.bot.id, name: r.bot.name, terminal: r.terminal, error: why });
      say.push(`${r.bot.name}: not restarted: ${why}`);
      report([`${r.bot.name}: not restarted: ${why}`]);
      await noteHandoffFailure({ botId: r.bot.id, botName: r.bot.name, project: r.key, terminal: r.terminal }, kind, why, path, { notify: false });
    };
    // A timer can tick again while this seat's handoff watcher still waits: replacing that
    // entry would kill the watcher every tick and the seat would never restart (#1556).
    const already = await queuedHandoffFor(r.bot.id);
    if (already) {
      const left = `${r.bot.name}: already queued for a handoff restart on ${already.terminal}; this pass left that queue entry `
        + "and its watcher alone.";
      say.push(left);
      if (opts.json) notes.push(left);
      continue;
    }
    const why = handoffRefusal(path);
    if (why) {
      await refuse(`${why}; it was not asked for a handoff and was not restarted.`);
      continue;
    }
    try {
      const now = await paneNow(r.terminal);
      if (now.state !== "live") {
        // The measured seat ended before the ask. A foreground pass tells its person; the record
        // is also kept so `am restart --queued` can answer for it later (#1556).
        const why = `not running in ${r.terminal} any more; nothing was asked or restarted.`;
        say.push(`${r.bot.name}: ${why}`);
        report([`${r.bot.name}: ${why}`]);
        await noteHandoffFailure({ botId: r.bot.id, botName: r.bot.name, project: r.key, terminal: r.terminal }, "dropped", why, path, { notify: false });
        continue;
      }
      if (!now.idle) {
        const entry = await queueRestart({ bot: r.bot, key: r.key, old: now.get, screen: now.screen,
          opts: { ...opts, fresh: true, tree: true, handoff: true, json: true, contextTokens: r.tokens, restartAt: r.threshold },
          wanted: null, plan: { mode: "fresh", agent: r.bot.agent, model: r.bot.model ?? null }, recovered: false });
        queued.push({ id: r.bot.id, name: r.bot.name, terminal: r.terminal, reason: entry.reason, watcher: entry.watcher,
          context_tokens: r.tokens, restart_at: r.threshold, handoff: path });
        say.push(`${line(r)}; queued until its next idle, then asked for its handoff and restarted from it `
          + `(am restart --queued lists it; the handoff is ${path}).`);
        continue;
      }
      // Empty before asking: only what the seat writes for THIS request can be sent (#1556).
      const cleared = clearHandoff(path);
      if (cleared) {
        await refuse(`${cleared}; it was not asked for a handoff and was not restarted.`);
        continue;
      }
      // Ask now, then wait for a file written after the ask and an idle seat.
      const since = Date.now();
      const sent = await hc(["send", r.terminal, handoffRequestText(r.bot, path)]);
      if (sent.code !== 0) throw new CliError(`couldn't ask for its handoff (hc send: ${hcSaid((sent.stderr || sent.stdout).trim())})`);
      const ready = await waitForHandoff({ terminal: r.terminal, path, since });
      if (ready.timedOut) {
        await refuse(`still running in ${r.terminal}; it didn't write ${path} within ${Math.round(HANDOFF_WAIT_MS / 1000)}s, so it was not restarted.`, "timeout");
        continue;
      }
      if (ready.state !== "live") {
        await refuse(`its pane ended (${ready.state}) before it wrote ${path}; nothing was restarted.`, "dropped");
        continue;
      }
      const handoff = readHandoff(path);
      if (!handoff) {
        await refuse(`${path} is empty; it was not restarted and ${r.terminal} still runs it.`);
        continue;
      }
      const result = await cmdRestart({ fresh: true, tree: true, json: true, project: r.key,
        _targetPin: { terminal: r.terminal, created_ms: r.created_ms } }, [r.bot.id]);
      if (result === PRINTED) {
        say.push(`${r.bot.name}: restarted in place from ${path}.`);
        restarted.push({ id: r.bot.id, name: r.bot.name, terminal: null, handoff: path });
        continue;
      }
      if (result && result.queued) {
        // The seat took a turn between the check and the restart: take the plain queue entry
        // back and queue the handoff-aware one instead, so the file is not lost.
        await cmdRestart({ cancel: true, json: true, project: r.key }, [r.bot.id]);
        const again = await paneNow(r.terminal);
        if (again.state !== "live") {
          // The seat ended between the handoff and the queued restart: the written handoff was
          // not queued, so record the drop too (the foreground pass reports it as well, #1556).
          const why = `its pane ended (${again.state}) after the handoff was written, so it was not queued for a handoff restart.`;
          say.push(`${r.bot.name}: ${why}`);
          report([`${r.bot.name}: ${why}`]);
          await noteHandoffFailure({ botId: r.bot.id, botName: r.bot.name, project: r.key, terminal: r.terminal }, "dropped", why, path, { notify: false });
          continue;
        }
        const entry = await queueRestart({ bot: r.bot, key: r.key, old: again.get, screen: again.screen,
          opts: { ...opts, fresh: true, tree: true, handoff: true, json: true, contextTokens: r.tokens, restartAt: r.threshold },
          wanted: null, plan: { mode: "fresh", agent: r.bot.agent, model: r.bot.model ?? null }, recovered: false });
        queued.push({ id: r.bot.id, name: r.bot.name, terminal: r.terminal, reason: entry.reason, watcher: entry.watcher,
          context_tokens: r.tokens, restart_at: r.threshold, handoff: path });
        say.push(`${line(r)}; it took a turn, so it is queued until its next idle and restarted from ${path}.`);
        continue;
      }
      const terminal = result && typeof result === "object" ? result.terminal : null;
      const warning = terminal ? await sendHandoffMessage(terminal, handoff, path) : `${path} wasn't sent: the restart gave no new terminal.`;
      if (warning) {
        report([warning]);
        await noteHandoffFailure({ botId: r.bot.id, botName: r.bot.name, project: r.key, terminal }, "send", warning, path, { notify: false });
      } else {
        await clearHandoffFailure(r.bot.id);
      }
      restarted.push({ id: r.bot.id, name: r.bot.name, terminal, handoff: path, context_tokens: r.tokens, restart_at: r.threshold,
        ...(warning ? { warning } : {}) });
      say.push(`${r.bot.name}: context ${r.tokens} > restartAt ${r.threshold}; restarted from ${path}`
        + `${terminal ? ` in ${terminal}` : ""}${warning ? `; ${warning}` : ""}.`);
    } catch (e) {
      await refuse(e?.message ?? String(e), e?.detail?.handoffKind ?? (e instanceof CliError ? "refused" : "dropped"));
    }
  }
  if (failed.length) exitAfter.code = 1;
  if (opts.json) return { due: due.map((r) => ({ id: r.bot.id, name: r.bot.name, project: r.key, terminal: r.terminal,
    context_tokens: r.tokens, restart_at: r.threshold })), restarted, queued, failed, rate_limited: rate.rate_limited,
    parked: rate.parked, switched: rate.switched, attention: rate.attention, notes: [...rate.notes, ...notes] };
  return [...rate.attention.map((row) => `! ${row.text}`), ...rate.parked.map((r) => `${r.name}: parked; ${parkedWakeText(r)}.`),
    ...rate.switched.map((r) => `${r.name}: switched to ${loginNameOf(r.login)}.`), ...say, ...rate.notes, ...notes].join("\n");
}

// Read only env's launch prefix. A template command or foreground process cannot vouch for
// the app home or login that launched this pane.
function paneLaunchEnv(get) {
  const argv = get?.argv;
  if (!Array.isArray(argv) || argv[0] !== "/usr/bin/env") return null;
  const vars = new Map();
  let index = 1;
  while (argv[index] === "-u" && typeof argv[index + 1] === "string") {
    vars.set(argv[index + 1], null);
    index += 2;
  }
  for (const word of argv.slice(index)) {
    if (typeof word !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break;
    const end = word.indexOf("=");
    vars.set(word.slice(0, end), word.slice(end + 1));
  }
  return vars;
}

const sameHome = (left, right) => (realDir(left) ?? resolvePath(left)) === (realDir(right) ?? resolvePath(right));

async function checkedPane(address, options) {
  const get = await hcLookup(address, options);
  if (!get) return null;
  if (get.address !== address || !["live", "finished"].includes(get.state)
      || (get.state === "live" && !Number.isSafeInteger(get.created_ms))) {
    throw new CliError(`hc get ${address} gave incomplete pane identity; nothing was started.`);
  }
  return get.state === "live" ? get : null;
}

async function labelledPanes(project, bot, bound, carriedBinding = () => null) {
  const reply = await hcJson(["ls", "--label", `${BOT_LABEL}=${bot.id}`]);
  if (!Array.isArray(reply) && !Array.isArray(reply?.terminals)) {
    throw new CliError(`hc ls gave no pane list for ${bot.name}; nothing was started.`);
  }
  const addresses = new Set();
  for (const row of rowsOf(reply)) {
    if (typeof row?.address !== "string" || !row.address) {
      throw new CliError(`hc ls gave an incomplete pane address for ${bot.name}; nothing was started.`);
    }
    if (project.machine ? row.address.startsWith(`${project.machine}/`) : local(row.address)) addresses.add(row.address);
  }
  const gets = await Promise.all([...addresses].map(checkedPane));
  const scoped = await Promise.all(gets.map(async (get) => {
    if (!get) return null;
    if (!get.labels || typeof get.labels !== "object" || Array.isArray(get.labels)) {
      throw new CliError(`hc get ${get.address} gave no label map; nothing was started.`);
    }
    if (get.labels[BOT_LABEL] !== bot.id) return null;
    if (get.address === bound || !get.cwd) return get;
    const recordedProject = carriedBinding(get)?.project;
    if (recordedProject != null) return recordedProject === project.key ? get : null;
    // The launch folder scopes a label. The foreground process can cd without moving its pane.
    if (project.machine) return get.cwd === project.key ? get : null;
    const key = await keyOf(get.cwd);
    if (key === project.key) return get;
    // Only a known different checkout can explain the same label elsewhere. A pane launched
    // with --cwd outside its project can have no roster in that folder.
    return loadProject(key).file.bots.some((entry) => entry.id === bot.id) ? null : get;
  }));
  return scoped.filter(Boolean);
}

async function duplicateLabel(project, bot, view) {
  if (!view || bot.planned) return false;
  const held = liveFor(view, bot.id, project);
  const bound = held ? addressOf(held.binding, view.machines) : null;
  try {
    // Every live pane counts, labelled or not (#1195): a live binding whose display label was
    // dropped (hc label can, and the ledger still proves it) beside a live labelled pane is the
    // same two-live-pane split restart refuses, so the read side calls it duplicate too.
    const panes = new Set((await labelledPanes(project, bot, bound)).map((get) => get.address));
    if (bound) panes.add(bound);
    return panes.size > 1;
  } catch { return false; }
}

/** A project's own app home (RFC 0021 delivery 3): `<project>/.herdr/app-home`. */
const projectAppHomeOf = (key) => under(key, ".herdr/app-home");

/**
 * The bot's binding in one app home's ledger, or null: only this computer's core and this
 * project (or a row that names none, from before rows carried a project) own it (#1128). An
 * unreadable ledger is refused by readAttachFile, never taken for an empty one.
 */
function bindingInHome(home, botId, core, key) {
  const row = heldIn(foldAttach(readAttachFile(attachPath(home)) ?? []), botId);
  if (!row || row.core !== core || !(row.project == null || row.project === key)) return null;
  return row;
}

/**
 * The pane a binding still names (same core, terminal and created_ms), or null when it is gone.
 * This is the one liveness rule every binding read shares (#1128): the hc record is the
 * evidence, and `created_ms` is the terminal's identity, so a finished, vanished or reused
 * terminal reads as stale.
 */
async function bindingPane(row, key) {
  const get = await checkedPane(row.terminal);
  if (get?.created_ms !== row.created_ms) return null;
  if (row.project == null && (!get.cwd || await keyOf(get.cwd) !== key)) return null;
  return get;
}

/**
 * The bot's rows in the app homes a local command may read (#1128): the selected one, and —
 * unless the person selected one with HERDR_APP_HOME — the project's own
 * (`<project>/.herdr/app-home`, RFC 0021 delivery 3), plus any `extraHomes` a caller already
 * carries (a live pane's launch home). Each row comes with the hc get that says whether it is
 * live, by the one rule above.
 */
async function botBindings(project, botId, { requestedHome = appHome(), explicit = Boolean(process.env.HERDR_APP_HOME), extraHomes = [] } = {}) {
  const core = await coreId();
  const homes = [requestedHome];
  const add = (dir) => { if (dir && !homes.some((h) => sameHome(h, dir))) homes.push(dir); };
  if (!explicit) add(projectAppHomeOf(project.key));
  for (const dir of extraHomes) add(dir);
  const rows = [];
  for (const home of homes) {
    const binding = bindingInHome(home, botId, core, project.key);
    if (binding) rows.push({ home, binding, get: await bindingPane(binding, project.key) });
  }
  return { core, homes, rows };
}

/**
 * One bot's binding, resolved the same way by every reader (#1128). The order is the restart's:
 * a live binding over a stale one; the project's own app home when the selected home names
 * nothing live; a pane's own launch home when the same launch is recorded in two homes. Two
 * live bindings on different panes — and two stale ledgers both naming the bot — have no launch
 * record between them: refused, both ledger paths named, before any write.
 * Resolves { home, binding, get, live, rows }: the home that owns the bot, its row (null when
 * no ledger names it), the hc get of a live winner, and every row weighed.
 */
async function resolvedBinding(project, bot, { requestedHome = appHome(), explicit = Boolean(process.env.HERDR_APP_HOME), extraHomes = [] } = {}) {
  const { rows } = await botBindings(project, bot.id, { requestedHome, explicit, extraHomes });
  const live = rows.filter((r) => r.get);
  const panes = new Map();
  for (const row of live) if (!panes.has(attachKey(row.binding))) panes.set(attachKey(row.binding), row);
  if (panes.size > 1) throw appHomeConflict(bot, [...new Set(live.map((r) => r.home))]);
  if (panes.size === 1) {
    const key = [...panes.keys()][0];
    const same = live.filter((r) => attachKey(r.binding) === key);
    if (same.length === 1) return { home: same[0].home, binding: same[0].binding, get: same[0].get, live: true, rows };
    // One live pane recorded in two homes is one binding: its own launch home owns it, then
    // the project's own app home, then the selected home.
    const launch = launchHomeOf(same[0].get);
    const own = projectAppHomeOf(project.key);
    const chosen = same.find((r) => launch && sameHome(r.home, launch))
      ?? same.find((r) => sameHome(r.home, own)) ?? same[0];
    return { home: chosen.home, binding: chosen.binding, get: chosen.get, live: true, rows };
  }
  if (rows.length > 1) throw appHomeConflict(bot, rows.map((r) => r.home));
  if (rows.length === 1) return { home: rows[0].home, binding: rows[0].binding, get: null, live: false, rows };
  return { home: requestedHome, binding: null, get: null, live: false, rows };
}

/**
 * The live binding a read may print from beyond the selected ledger (#1128): the project's own
 * app home, when it has a ledger and the selected home's view found no live binding. Never
 * writes; the full refusal stays restart's, and two stale rows read as no live binding here.
 */
async function projectHomeHeld(project, bot) {
  if (!project || project.machine || Boolean(process.env.HERDR_APP_HOME)) return null;
  if (!existsSync(attachPath(projectAppHomeOf(project.key)))) return null;
  try {
    const resolved = await resolvedBinding(project, bot, { requestedHome: appHome() });
    return resolved.get ? { binding: resolved.binding, get: resolved.get } : null;
  } catch (e) {
    if (e?.detail?.refused === "app-home") return null;
    throw e;
  }
}

/** The live binding ls, show and brief print for `bot`: the selected home's, else the one the
 * project's own app home holds (#1128). With no view (hc unavailable) a read prints none, as
 * before: it never turns a failed hc into a second lookup. `refuseTwins` makes show and whois
 * refuse a second live binding in the project's own app home, as restart does, instead of
 * printing the selected one as the whole truth. `direct` is a binding the caller already read
 * from the view (whois by bare id answers outside a project, where the project filter would
 * hide it). */
async function readHeld(project, bot, view, { refuseTwins = false, direct: chosen = undefined } = {}) {
  if (!view || bot.planned) return null;
  const direct = chosen !== undefined ? chosen : liveFor(view, bot.id, project);
  if (!direct || !project || project.machine || Boolean(process.env.HERDR_APP_HOME)) {
    return direct ?? await projectHomeHeld(project, bot);
  }
  if (!refuseTwins) return direct;
  const { rows } = await botBindings(project, bot.id, { requestedHome: appHome(), explicit: false });
  const other = rows.find((r) => r.get && attachKey(r.binding) !== attachKey(direct.binding));
  if (other) throw appHomeConflict(bot, [appHome(), other.home]);
  return direct;
}

/** The app home a pane's launch word names (#650), when it is a usable absolute path; else null. */
function launchHomeOf(pane) {
  const dir = paneLaunchEnv(pane)?.get("HERDR_APP_HOME");
  if (typeof dir !== "string" || !isAbsolute(dir) || /[\x00-\x1f\x7f]/.test(dir)
      || (process.env.AUTOMAGIK_HERDR_TEST_ROOTS && !inTestRoots(dir))) return null;
  return dir.replace(/\/+$/, "");
}

/**
 * The app homes the bot's ended panes still name (#1128). A finished terminal hc keeps under
 * the bot's label carries the home its launch was given (#650), and the ledger there binds that
 * very launch (core, terminal, created_ms): the launch's own record, retained. One home per
 * launch; two launches naming different homes are ambiguous. [] when hc keeps none (removed, or
 * a reboot took them), so the caller falls back to the ledgers it can derive.
 */
async function endedLaunchHomes(project, bot, core) {
  const reply = await hcJson(["ls", "--all", "--label", `${BOT_LABEL}=${bot.id}`]);
  if (!Array.isArray(reply) && !Array.isArray(reply?.terminals)) {
    throw new CliError(`hc ls gave no pane list for ${bot.name}; nothing was started.`);
  }
  const homes = new Map();
  for (const row of rowsOf(reply)) {
    if (typeof row?.address !== "string" || !local(row.address) || row.state !== "finished") continue;
    const get = await hcLookup(row.address).catch(() => null);
    if (!get || get.state !== "finished" || !Number.isSafeInteger(get.created_ms)) continue;
    if (!get.labels || get.labels[BOT_LABEL] !== bot.id) continue;
    const dir = launchHomeOf(get);
    if (!dir) continue;
    const rowThere = bindingInHome(dir, bot.id, core, project.key);
    if (!rowThere || rowThere.terminal !== row.address || rowThere.created_ms !== get.created_ms) continue;
    homes.set(realDir(dir) ?? dir, dir);
  }
  return [...homes.values()];
}

/** Two app homes both name the bot: never pick one, and never write a third row (#1128). */
function appHomeConflict(bot, homes) {
  return new CliError(`${bot.name} has bindings in two app homes (${homes.map((h) => attachPath(h)).join(", ")}); `
    + `inspect both ledgers before restarting, and set HERDR_APP_HOME to the home that owns it.`,
    1, { refused: "app-home" });
}

/**
 * Which app home a restart on this computer writes in, decided before anything is written
 * (#1128). With HERDR_APP_HOME set, that home is the selection. Without it, the home a pane of
 * this bot was launched with is retained (#650's env word), even one that ended while hc still
 * keeps it; then a live binding wins over a stale one; then the project's own app home
 * (`<project>/.herdr/app-home`, RFC 0021 delivery 3) is used when it names the bot and the
 * selected home does not. A binding is live while hc still gives its terminal with the same
 * `created_ms` (`bindingPane`), the one rule `resolvedBinding` applies for every reader. Two
 * bindings no launch record decides between are refused, never merged: restart writes the one
 * authoritative ledger or nothing at all.
 */
async function restartTarget(project, bot, requestedHome, explicitHome, allowImport = false) {
  const core = await coreId();
  const bindingIn = (dir) => heldIn(foldAttach(readAttachFile(attachPath(dir)) ?? []), bot.id);
  const carriedBinding = (pane) => {
    const dir = launchHomeOf(pane);
    if (dir === null) return null;
    const row = bindingIn(dir);
    return row?.core === core && row.terminal === pane.address && row.created_ms === pane.created_ms ? row : null;
  };
  const selectedPath = attachPath(requestedHome);
  const selectedRows = readAttachFile(selectedPath);
  const selected = heldIn(foldAttach(selectedRows ?? []), bot.id);
  const binding = selected?.core === core && (selected.project == null || selected.project === project.key) ? selected : null;
  let get = binding ? await checkedPane(binding.terminal) : null;
  if (get?.created_ms !== binding?.created_ms) get = null;
  // A legacy row without a project still needs a launch folder in this checkout.
  if (get && binding.project == null && (!get.cwd || await keyOf(get.cwd) !== project.key)) get = null;
  const candidates = await labelledPanes(project, bot, get?.address, carriedBinding);
  if (candidates.length > 1) {
    const panes = candidates.map((p) => p.address).join(", ");
    throw new CliError(`${bot.name} has duplicate live labels in ${panes}; inspect those panes before restarting.`,
      1, { refused: "duplicate", duplicate: true });
  }
  let candidate = candidates[0];
  if (!get && !candidate && /^[A-Za-z0-9._-]+$/.test(process.env.HC_TERMINAL_ID ?? "")) {
    // An attached pane can lose its display label too. The caller's own terminal is useful
    // only when its carried app home still proves this exact bot and launch.
    const caller = await checkedPane(process.env.HC_TERMINAL_ID);
    if (caller && carriedBinding(caller)?.project === project.key) candidate = caller;
  }
  const carried = paneLaunchEnv(candidate)?.get("HERDR_APP_HOME");
  const row = candidate ? carriedBinding(candidate) : null;
  if (get && (!candidate || candidate.address === get.address && candidate.created_ms === get.created_ms)) {
    if (row?.project === project.key && !sameHome(requestedHome, carried)) {
      // The one-time label import can record the same launch in both ledgers. The resolver
      // treats that as one binding, but a restart still refuses to choose an authority here;
      // name both ledgers, as every other app-home refusal does (#1128).
      throw appHomeConflict(bot, [requestedHome, carried]);
    }
    // #1128: a live binding here never licenses a second live binding in the project's own app
    // home (its pane may have lost the label am attach only warns about). The same launch
    // recorded in both ledgers is one pane, not two; a different live pane is a twin.
    if (!explicitHome) {
      const { rows } = await botBindings(project, bot.id, { requestedHome, explicit: false, extraHomes: [carried] });
      const other = rows.find((r) => r.get && attachKey(r.binding) !== attachKey(binding));
      if (other) throw appHomeConflict(bot, [requestedHome, other.home]);
    }
    return { held: { binding, get }, dir: requestedHome };
  }
  // #1128: the selected home's live binding and the labelled pane in another home are two live
  // bindings too, whichever of them lost the label. The branch above catches the orientation
  // where the label is on the selected pane; this is its reverse, and without this check it
  // would fall to the "no matching attachment" error below, naming neither ledger. Same twin
  // check, same refusal.
  if (get && candidate && (candidate.address !== get.address || candidate.created_ms !== get.created_ms)) {
    const { rows } = await botBindings(project, bot.id, { requestedHome, explicit: explicitHome, extraHomes: [carried] });
    const other = rows.find((r) => r.get && attachKey(r.binding) !== attachKey(binding));
    if (other) throw appHomeConflict(bot, [requestedHome, other.home]);
  }
  if (!candidate) {
    if (selected?.core === core && selected.project !== project.key && selected.created_ms === (await checkedPane(selected.terminal))?.created_ms) {
      throw new CliError(`${selected.terminal} has an attachment in the selected app home that doesn't identify this project; nothing was started.`,
        1, { refused: "attachment", terminal: selected.terminal });
    }
    // #1128: no live label to read the home from. Without an explicit selection, retain the
    // home a pane of this bot was launched with (#650's env word), even one that ended: hc keeps
    // it until removed, and its ledger row there proves the launch. Two launches naming
    // different homes are ambiguous.
    if (!explicitHome) {
      const ended = await endedLaunchHomes(project, bot, core);
      if (ended.length > 1) throw appHomeConflict(bot, ended);
      if (ended.length === 1) return { held: null, dir: ended[0] };
    }
    // The selected and the project's own app home, decided by the one resolver every read
    // shares: a live binding beats a stale one, the project home is read when the selected
    // home names nothing live, and two rows with no live pane between them are refused.
    const resolved = await resolvedBinding(project, bot, { requestedHome, explicit: explicitHome });
    if (resolved.binding) {
      return { held: resolved.get ? { binding: resolved.binding, get: resolved.get } : null, dir: resolved.home };
    }
    return { held: null, dir: requestedHome };
  }
  if (!get && row?.project === project.key) {
    if (explicitHome && !sameHome(requestedHome, carried)) {
      throw new CliError(`${candidate.address} belongs to a different HERDR_APP_HOME than the one selected; nothing was started.`,
        1, { refused: "app-home", terminal: candidate.address });
    }
    // The launch home wins over a stale selected row, but never over a second live binding:
    // that is a twin whichever home holds it.
    if (!explicitHome) {
      const { rows } = await botBindings(project, bot.id, { requestedHome, explicit: false, extraHomes: [carried] });
      const other = rows.find((r) => r.get && attachKey(r.binding) !== attachKey(row));
      if (other) throw appHomeConflict(bot, [carried, other.home]);
    }
    return { held: { binding: row, get: candidate }, dir: carried };
  }
  // #1128: a pane launched before #650 carries no app-home word; the project's own app home
  // still proves it, by the row's own terminal identity. Without an explicit selection, read
  // that row rather than refuse, and never write the selected home's ledger for it.
  if (!get && !explicitHome) {
    const other = projectAppHomeOf(project.key);
    if (!sameHome(other, requestedHome)) {
      const rowOther = bindingInHome(other, bot.id, core, project.key);
      if (rowOther && rowOther.terminal === candidate.address && rowOther.created_ms === candidate.created_ms) {
        return { held: { binding: rowOther, get: candidate }, dir: other };
      }
    }
  }
  // A deliberately selected app home still gets its documented one-time import. Never
  // use import to decide which home owns an unbound pane when the caller lost its home.
  if (allowImport && explicitHome && selectedRows === null && (!carried || sameHome(requestedHome, carried))) {
    const proposed = await labelRows();
    const imported = proposed.find((entry) => entry.bot === bot.id);
    if (imported?.project === project.key && imported.core === core
        && imported.terminal === candidate.address && imported.created_ms === candidate.created_ms) {
      await importLabels(selectedPath, proposed);
      return restartTarget(project, bot, requestedHome, explicitHome);
    }
  }
  // #1195, the adoption #1633 left open: a live pane carrying this bot's label is the bot even
  // when no ledger proves that exact launch (the row was lost, written elsewhere, or this command
  // runs in a home that never saw it). Adopt it into the home its launch names, else the
  // project's own app home when that is in use, else the selected home, and restart it; never
  // start a twin beside it.
  const launchHome = launchHomeOf(candidate);
  // Two live panes are a twin even when only one carries the label: a binding in one home and a
  // labelled pane in no ledger have no launch record between them, so refuse and name both.
  if (get && candidate) {
    throw new CliError(`${bot.name} has two live panes: ${get.address} in the selected app home, and ${candidate.address} carrying its label. `
      + "Inspect both, then attach the pane it should run in (or detach the other) before restarting.",
    1, { refused: "app-home", terminal: candidate.address });
  }
  // A selected home that names no live pane still never adopts a launch another home proves:
  // that would make the second authority the resolver refuses to choose between.
  const extraHomes = [launchHome ?? carried, ...(explicitHome ? [projectAppHomeOf(project.key)] : [])];
  const { rows } = await botBindings(project, bot.id, { requestedHome, explicit: explicitHome, extraHomes });
  const other = rows.find((r) => r.get);
  if (other) throw appHomeConflict(bot, [requestedHome, other.home]);
  // An explicit selection that differs from the launch's home is refused, as a proven carried
  // row above is.
  if (launchHome) {
    if (explicitHome && !sameHome(requestedHome, launchHome)) {
      throw new CliError(`${candidate.address} belongs to a different HERDR_APP_HOME than the one selected; nothing was started.`,
        1, { refused: "app-home", terminal: candidate.address });
    }
    return adoptedTarget(project, bot, candidate, core, launchHome);
  }
  const own = projectAppHomeOf(project.key);
  const home = !explicitHome && existsSync(attachPath(own)) ? own : requestedHome;
  return adoptedTarget(project, bot, candidate, core, home);
}

/**
 * The adoption of a live labelled pane no ledger proves (#1195), decided here and written only
 * once the replacement has started (commitAdoption). Every refusal — the login check above all,
 * which runs after this planning step — therefore leaves the ledger untouched: a row written
 * before that check would make the next restart read it as an ordinary held binding, skip the
 * check and launch on the adopted home's other login. The row's identity is the pane's own, so a
 * recheck of the same launch plans the same binding without writing it.
 */
async function adoptedTarget(project, bot, pane, core, home) {
  const path = attachPath(home);
  const fold = foldAttach(readAttachFile(path) ?? []);
  const other = [...fold.byKey.values()].find((b) => b.terminal === pane.address && b.created_ms === pane.created_ms && b.bot !== bot.id);
  if (other) {
    throw new CliError(`${pane.address} is attached to bot ${other.bot} in ${path}; nothing was started.`,
      1, { refused: "attachment", terminal: pane.address });
  }
  const held = heldIn(fold, bot.id);
  // A row no live pane confirms is stale, not authority: the live labelled pane is the bot (the
  // restart's home checks above already refused a second live binding). It is retired at commit,
  // never used to refuse the adoption.
  const stale = held && !(held.terminal === pane.address && held.created_ms === pane.created_ms) ? held : null;
  if (stale && await bindingPane(stale, project.key)) {
    throw new CliError(`${bot.name} is attached to the live pane ${stale.terminal} in ${path}, not ${pane.address}; nothing was started.`,
      1, { refused: "app-home", terminal: pane.address });
  }
  const binding = attachRow({ event: "attach", bot: bot.id, project: project.key, terminal: pane.address, core,
    created_ms: pane.created_ms, by: "import" });
  return { held: { binding, get: pane }, dir: home, adopted: true, adoption: { home, pane, core, binding, stale } };
}

/**
 * The rows an adoption writes, under the adopted home's ledger lock, only once the replacement
 * has stayed up (#1195): the stale row it supersedes is detached, the replacement attached. A
 * binding another CLI wrote meanwhile is refused (lost), never overwritten, and the terminating
 * pane keeps the bot as it was.
 */
async function commitAdoption(bot, adoption, terminal, created_ms, key) {
  const path = attachPath(adoption.home);
  try {
    return await withLockAsync(ledgerLock(path), async () => {
      const fold = foldAttach(readAttachFile(path) ?? []);
      const other = [...fold.byKey.values()].find((b) => b.terminal === adoption.pane.address && b.created_ms === adoption.pane.created_ms && b.bot !== bot.id);
      if (other) {
        throw new CliError(`${adoption.pane.address} is attached to bot ${other.bot} in ${path}; nothing was started.`,
          1, { refused: "attachment", terminal: adoption.pane.address });
      }
      const now = heldIn(fold, bot.id);
      const nowKey = now ? attachKey(now) : null;
      const staleKey = adoption.stale ? attachKey(adoption.stale) : null;
      if (now && nowKey !== attachKey(adoption.binding) && nowKey !== staleKey) {
        if (await bindingPane(now, key)) return { lost: now.terminal };
      }
      const rows = [];
      // The replacement first: the fold supersedes the stale row with it, so a crash between the
      // two writes never leaves the bot unbound. The detach row then records why the old one ended.
      rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal, core: adoption.core, created_ms, by: "start" }));
      if (adoption.stale && nowKey === staleKey) {
        rows.push(closingRow(adoption.stale, "detach", "start", "moved"));
      }
      appendAttach(path, rows);
      return { lost: undefined };
    });
  } catch (e) { throw asCliError(e); }
}

function recoveredLogin(old, argv) {
  const source = paneCommand(old);
  if (launchAgent(argv) !== "claude" || (source && launchAgent(source.argv ?? ["sh", "-c", source.shell]) !== "claude")) return undefined;
  const previous = paneLaunchEnv(old)?.get(CONFIG_VAR);
  const warnings = [];
  const words = claudeLogin(argv, warnings);
  const next = words[0] === "-u" ? null : words[0]?.slice(CONFIG_VAR.length + 1);
  const matches = previous === next || (typeof previous === "string" && isAbsolute(previous) && next && sameHome(previous, next));
  if (previous === undefined || !matches) {
    const why = previous === undefined ? "its launch gives no Claude login" : "the selected Claude login differs from its launch";
    throw new CliError(`${old.address}: ${why} in the recovered app home. Nothing was started. `
      + "Select that app home explicitly to apply an account change.", 1, { refused: "login", terminal: old.address });
  }
  return { words, warnings };
}

/**
 * The Claude login a restart of an adopted pane keeps (#1195): the words its own launch carried,
 * never the adopted app home's selection when the two differ. An adopted pane has no recorded
 * seat to make an Accounts switch an explicit act for it, so keeping its login keeps its memory
 * folder too; a difference is reported, never silent. A launch that proves no login is only safe
 * under the default login: any other is refused rather than guessed.
 */
function adoptedLogin(old, argv, keep) {
  const source = paneCommand(old);
  if (launchAgent(argv) !== "claude" || (source && launchAgent(source.argv ?? ["sh", "-c", source.shell]) !== "claude")) return undefined;
  const previous = paneLaunchEnv(old)?.get(CONFIG_VAR);
  const chosenWarnings = [];
  const chosen = claudeLogin(argv, chosenWarnings);
  if (previous === undefined) {
    if (chosen.join(" ") === ["-u", CONFIG_VAR].join(" ")) return { words: chosen, warnings: chosenWarnings };
    throw new CliError(`${old.address}: its launch proves no Claude login, and the adopted app home selects another. Nothing was started. `
      + "Set HERDR_APP_HOME to the home its session belongs to, or attach it there before restarting.",
    1, { refused: "login", terminal: old.address });
  }
  const words = previous === null ? ["-u", CONFIG_VAR] : [`${CONFIG_VAR}=${previous}`];
  const chosenDir = chosen[0] === "-u" ? null : chosen[0]?.startsWith(`${CONFIG_VAR}=`) ? chosen[0].slice(CONFIG_VAR.length + 1) : undefined;
  const matches = previous === chosenDir || (typeof previous === "string" && isAbsolute(previous) && chosenDir && sameHome(previous, chosenDir));
  if (matches) return { words, warnings: chosenWarnings };
  if (previous !== null && (!isAbsolute(previous) || /[\x00-\x1f\x7f]/.test(previous))) {
    throw new CliError(`${old.address}: its launch names a Claude login this restart can't reuse. Nothing was started. `
      + "Set HERDR_APP_HOME to the home its session belongs to, or attach it there before restarting.",
    1, { refused: "login", terminal: old.address });
  }
  // Kept only when every later restart recovers the adopted home and checks the login again
  // (keep: the home is not the selected one). A restart that would fall back to the selected
  // home cannot promise it, and a second restart would move the bot without a word: refuse.
  if (keep) {
    return { words, warnings: [`${old.address}: kept the Claude login its pane was launched with, not the adopted app home's selection; nothing was switched.`] };
  }
  throw new CliError(`${old.address}: its launch runs on a different Claude login from ${appHome()}'s selection, and this restart can't keep it. `
    + "Nothing was started. Set HERDR_APP_HOME to the app home that selects its login, or attach it there before restarting.",
  1, { refused: "login", terminal: old.address });
}

async function cmdRestart(opts, [ref]) {
  if (opts["run-queued"]) return runQueuedRestart(opts);
  if (opts.due) {
    if (ref) throw new CliError("restart --due takes no bot: it lists every seat over its threshold, or take one with am restart <bot>.", 2);
    return cmdRestartDue(opts);
  }
  if (opts.queued || opts.cancel) return queuedRestarts(opts, ref);
  if (opts.tab && !opts.space) throw new CliError("--tab needs --space (the space that tab is in).", 2);
  const swap = opts.agent !== undefined || opts.model !== undefined;
  if (opts.save && !swap) throw new CliError("--save keeps a swap in the bot's definition; it goes with --agent or --model.", 2);
  if (opts["fresh-shared"] && !opts.tree) throw new CliError("--fresh-shared picks how --tree restarts helpers; it goes with --tree.", 2);
  // --cwd DIR: the folder the new pane starts in (a real path, as Claude Code and hc see it).
  let wanted = null;
  if (opts.cwd !== undefined && opts.machine !== undefined) {
    throw new CliError("--cwd is a folder on this computer; a restart on a linked machine keeps the old pane's.", 2);
  }
  if (opts.cwd !== undefined) {
    const dir = opts.cwd ? realDir(resolvePath(opts.cwd)) : null;
    if (!dir || !isDir(dir)) throw new CliError(`--cwd ${opts.cwd || '""'} isn't a folder on this computer.`, 2);
    wanted = dir;
  }
  const project = await projectFor(opts);
  const { file, key } = project;
  if (project.text === null) throw new CliError(`No ${BOTS_PATH} in ${key}.`);
  const bot = await botIn(project, ref, opts);
  warnProject(project, bot.id);
  const why = startRefusal(file, bot.id);
  if (why) throw new CliError(why);
  // Before swap validation, preparation or a delegated tree transaction.
  refuseLinkedCaller(project);
  if (project.machine && opts.tree) return restartTreeOnMachine(opts, project, bot);
  if (project.machine) {
    // Observe before swap/model validation can refresh a caller-side model cache.
    const observed = await linkedObservation(project, bot);
    linkedRestartHeld(project, bot, observed);
    return restartResolved(opts, project, bot, wanted, swap, observed);
  }
  const explicit = process.env.HERDR_APP_HOME;
  const requested = appHome();
  const target = await restartTarget(project, bot, requested, Boolean(explicit), !opts._queuedTarget);
  const recovered = opts._queuedTarget?.options?.recoveredHome === true || !sameHome(requested, target.dir);
  if (recovered) {
    process.env.HERDR_APP_HOME = target.dir;
    viewOnce = null;
  }
  try {
    return await restartResolved(opts, project, bot, wanted, swap, target, recovered);
  } finally {
    if (recovered) {
      if (explicit === undefined) delete process.env.HERDR_APP_HOME;
      else process.env.HERDR_APP_HOME = explicit;
      viewOnce = null;
    }
  }
}

async function restartResolved(opts, project, bot, wanted, swap, target, recovered) {
  const { file, key } = project;
  // A swap's agent and model are checked as an edit checks them (entryFrom); a new agent
  // without --model drops the old agent's pin. bots.json changes only with --save.
  let entry = null;
  if (swap) {
    const stored = project.raw.bots.find((b) => b?.id === bot.id);
    const target = opts.agent !== undefined ? resolveAgent(opts.agent, agentTable()) : bot.agent;
    const edit = { agent: opts.agent, model: opts.model };
    if (opts.model === undefined && target !== bot.agent) edit["no-model"] = true;
    // #1173: a swap on a linked machine weighs its pin against that machine's list, when it has
    // one; a list that can't be read leaves the pin to the launch there.
    let listOf = null;
    if (project.machine && target) {
      const list = await modelsOnMachine(project.machine, key, target);
      listOf = (agent, pin) => (agent === target ? list : modelList(agent, pin));
    }
    entry = entryFrom(edit, stored, project, { creating: false, listOf });
  } else if (bot.model) {
    const list = project.machine ? await modelsOnMachine(project.machine, key, bot.agent) : modelList(bot.agent, bot.model);
    if (list !== null && !list.includes(bot.model)) {
      throw new CliError(project.machine
        ? `${bot.name} is pinned to "${bot.model}", which isn't on ${project.machine}'s ${bot.agent} model list. `
          + `Pick one with am edit ${bot.id} --model <model>, restart it on one with --model <model>, or clear the pin with --no-model.`
        : `${bot.name} is pinned to "${bot.model}", which isn't a ${bot.agent} model this computer lists. `
          + `Pick one with am edit ${bot.id} --model <model>, restart it on one with --model <model>, or clear the pin with --no-model.`);
    }
  }
  if (project.machine) return restartOnMachine(opts, project, bot, entry, target);
  const view = await attachView({ readOnly: true });
  const held = target.held;
  let old = held?.get ?? null;
  // #1556: a due pass restarts only the pane it measured; a person's restart or another pass
  // may have moved the seat while the handoff was being written.
  const pin = opts._targetPin ?? null;
  if (pin && (!old || old.address !== pin.terminal || (pin.created_ms != null && old.created_ms !== pin.created_ms))) {
    throw new CliError(`${bot.name}: the pane this pass measured (${pin.terminal}) is no longer its live seat, so it was not restarted.`,
      1, { refused: "handoff", terminal: pin.terminal });
  }
  const recheck = async (argv) => {
    const current = await restartTarget(project, bot, appHome(), true);
    if ((current.held ? attachKey(current.held.binding) : null) !== (held ? attachKey(held.binding) : null)) {
      throw new CliError(`${bot.name}'s attachment changed while planning the restart; nothing was started.`);
    }
    if (!current.held) return undefined;
    if (target.adopted) return adoptedLogin(current.held.get, argv, recovered);
    return recovered ? recoveredLogin(current.held.get, argv) : undefined;
  };
  if (opts._queuedTarget && (!old || old.address !== opts._queuedTarget.terminal
    || (opts._queuedTarget.created_ms != null && old.created_ms !== opts._queuedTarget.created_ms))) return PRINTED;
  // attachView caches its first hc get for the whole watcher run: a queued fire must judge the
  // pane's status now, not the state it had when the watcher started.
  if (opts._queuedTarget && old) {
    const now = await hcState(old.address);
    if (now.state !== "live" || !now.get) return PRINTED;
    old = { ...old, ...now.get, address: old.address };
  }
  // #939, revive only: a pane hc kept as a bare shell runs no turn, whatever status its ended
  // agent last reported, and its screen is the shell's: neither can refuse or queue this.
  const bare = Boolean(opts.revive && old && isBareShell(old));
  if (bare) old = { ...old, status: null };
  const screen = old && !bare ? await readScreenText(old.address) : null;
  const helpers = old ? await helpersOf(old.address, { strict: Boolean(opts.tree) }) : [];
  // Helpers remain a refusal even when the parent's turn could otherwise be queued.
  const refusal = old ? restartRefusal({ name: bot.name, old: { ...old, status: { state: "idle" } }, helpers, force: opts.force, tree: opts.tree }) : null;
  if (old && opts._queuedTarget) {
    // The single fire-time check: a helper that appeared, or a pane that turned busy again
    // after the queue was read, is waited for instead of being ended with the pane.
    if (refusal || (!opts.force && !isPaneIdle(old, screen))) {
      if (refusal) opts._queuedRefusal = refusal;
      return RETRY_QUEUED;
    }
  } else if (refusal) {
    throw new CliError(refusal, 1, { refused: "helpers", terminal: old.address });
  }
  const agents = agentTable();
  const ledger = workerLedgerRows();
  const runningAgent = old ? agentKeyOfArgv(old.foreground?.argv, agents) : null;
  // An agent as the restart's lines name it ("Claude", not "Claude Code").
  const agentName = (k) => (k === "claude" ? "Claude" : agents[k]?.name ?? k);
  // The session to resume: the old pane's agent.session label (or a reviver's revive.session),
  // else the ledger's last session row for that terminal (the Claude hook writes them), for
  // every agent that resumes by id.
  // hc's live panes, asked only when a session may have to be found on disk (#939): its rivals.
  sessionDiscovery.clear();
  const panesNow = sessionsOnDisk() && (discoversSession(runningAgent ?? bot.agent) || helpers.length) ? await livePanes() : [];
  const knownSession = (get, agentKey) => {
    const id = paneSession(get, agentKey);
    if (id) return { session: id, transcript: null };
    const row = resumesById(agentKey) ? ledgerSession(ledger, get.address, agentKey, get.created_ms) : null;
    if (row) return row;
    // #939: an agent that takes no id at launch (dsh-TUI, Antigravity, Codex, Kimi) left its session on disk.
    const found = discoveredSession(agentKey, get, ledger, panesNow);
    return found ? { session: found, transcript: null } : null;
  };
  // #939, revive only: the bot's pane is gone whole (a reboot took it). Its last seat row stands
  // in for it: the folder it ran in and the launch its session rows are keyed by.
  const ghost = opts.revive && !old ? lastSeat(ledger, bot.id, key, bot.agent) : null;
  const was = old ?? ghost;
  const known = old ? knownSession(old, runningAgent ?? bot.agent) : ghost ? knownSession(ghost, bot.agent) : null;
  // Every id the old pane carries or the ledger names, whatever the agent: never printed.
  holdId(known?.session);
  for (const k of ["agent.session", "revive.session"]) holdId(old?.labels?.[k]);
  // The old pane's launch and hc template, only to rebuild from the source and to say when they
  // differ from it (#597): a template hc still lists owns the command, with its CURRENT words.
  const oldLaunch = old ? paneCommand(old) : null;
  // #1418: a gone pane can name its template too. Hermes keeps its own restart path.
  const templatePane = old ?? (bot.agent === "hermes" ? null : ghost);
  const oldTemplate = templatePane ? await paneTemplate(templatePane) : null;
  // The folder the replacement starts in: --cwd DIR, else the old pane's folder (#213: a worktree
  // too, where its conversation is), unless it is gone, else the project. Resolved first: the
  // permission file (#884) trusts this folder, not the project, and a symlinked one by realpath.
  const oldCwd = old?.foreground?.cwd ?? old?.cwd ?? ghost?.cwd ?? null;
  const cwd = wanted ?? (oldCwd && isDir(oldCwd) ? (realDir(oldCwd) ?? oldCwd) : key);
  const sourceRun = startableAgent(bot, entry?.agent ?? bot.agent).run;
  // #1125: the folders a Codex seat in `cwd` may write, for a template plan's words (launchSeat
  // adds them to an agent row's, and says what it withheld then).
  const codexPlan = (entry?.agent ?? bot.agent) === "codex" ? await localCodexGrantPlan(cwd) : null;
  const planned = {
    bot, run: launchRun(entry?.agent ?? bot.agent, sourceRun, bot, localWhere()), where: localWhere(),
    runningAgent, session: known?.session ?? null,
    grants: codexPlan?.dirs ?? [],
    fresh: opts.fresh || (!was && !bot.hermes), agent: entry ? entry.agent : undefined, model: entry ? (entry.model ?? "") : undefined,
    template: oldTemplate?.command ? { name: oldTemplate.name, command: oldTemplate.command } : null,
    agy: { appHomeDir: appHome(), folder: cwd, realpath: realDir, homeDir: home() },
    // A new conversation on Claude runs on an id chosen here (RFC 0021 (f) 2); a resume keeps its own.
    newSession: newSessionId(),
  };
  let plan = restartPlan(planned);
  if (old && !opts.force && !isPaneIdle(old, screen)
    && (["working", "blocked"].includes(old.status?.state) || pendingDialog(screen))) {
    await recheck(plan.argv);
    return queueRestart({ bot, key, old, screen, opts, wanted, plan, recovered });
  }
  // --cwd: Claude resumes only within one folder slug (~/.claude/projects/<slug>), by id or --continue.
  const movedFrom = wanted && old && oldCwd ? (realDir(oldCwd) ?? oldCwd) : null;
  const slugMoved = movedFrom && claudeSlug(movedFrom) !== claudeSlug(wanted);
  if (slugMoved && plan.mode === "resume" && plan.agent === "claude") {
    throw new CliError(`Claude keeps ${bot.name}'s conversation under its folder's slug, ${claudeSlug(movedFrom)} (${movedFrom}); ${wanted} is `
      + `${claudeSlug(wanted)}, so a resume there would find nothing. Nothing was started. Restart with --fresh for a new conversation in ${wanted}, `
      + `or pick a folder whose slug is the same.`);
  }
  // A restart with no --space keeps the old pane's place when its labels name one; no labels is
  // no place, never an invitation to open a space (#217): the replacement runs unseen, and says so.
  const place = opts.space ? { space: opts.space, tab: opts.tab ?? null, from: null } : (old ? placementFrom([old]) : undefined);
  let resumeId = plan.mode === "resume" && !plan.canonicalBot && resumesById(plan.agent) ? sessionFor(plan.agent, known?.session) : null;
  // With no id, a resume takes the folder's latest conversation (--continue, codex resume
  // --last), for every agent: beside another bot on that agent there, a new conversation, and
  // why (#328: an omp --continue picked up a teammate's). Alone there, the resume as before.
  let sharedNote = null;
  // #1417, revive only: Codex and Kimi must have a conversation of their own, even alone.
  if (opts.revive && plan.mode === "resume" && !resumeId && !plan.canonicalBot && ["codex", "kimi"].includes(plan.agent)) {
    const note = `no ${agentName(plan.agent)} conversation of its own could be identified for ${was.address}, so its folder's latest one was not guessed`;
    plan = { ...restartPlan({ ...planned, fresh: true }), note };
    sharedNote = note;
  }
  if (plan.mode === "resume" && !resumeId && !plan.canonicalBot) {
    const anywhere = continuesAnywhere(plan.agent);
    const sharers = await sharersOf({ view, cwd, botId: bot.id, file, agentKey: plan.agent, ledger, old, anywhere });
    const note = sharedFresh({ name: bot.name, old: was, cwd, sharers, agent: agentName(plan.agent), words: plan.resume.join(" "), anywhere });
    if (note) { plan = { ...restartPlan({ ...planned, fresh: true }), note }; sharedNote = note; }
  }
  // #598: dsh-tui's id-less -c only once a turn has finished in the old pane (hc's turn counter;
  // missing or unreadable is 0): else a new conversation, and why.
  if (plan.mode === "resume" && !resumeId && resumeAfterTurn(plan.agent) && !(Number.isSafeInteger(old?.turn) && old.turn >= 1)) {
    const note = noTurnNote(agents, plan.agent, was);
    plan = { ...restartPlan({ ...planned, fresh: true }), note };
    sharedNote = note;
  }
  const { tree, treeWarnings } = old && opts.tree
    ? await treePlans({ project, bot, old, helpers, view, ledger, agents, knownSession, force: opts.force, freshShared: opts["fresh-shared"], revive: Boolean(opts.revive),
      run: { who: bot.name, agent: plan.agent, cwd, session: resumeId, mode: plan.mode } })
    : { tree: [], treeWarnings: [] };
  // --tree: the old pane and its helpers idle first (no turn ends once two panes could hold the bot's session).
  let plans = tree;
  const early = [];
  if (tree.length) plans = await treeIdle(old, tree, (w) => early.push(w), { force: opts.force, revive: Boolean(opts.revive) });
  // A resumed session keeps its label on the new pane, so the next restart resumes it too; a
  // template keeps its name in the worker.template label, so the next restart finds it again.
  const carry = { ...carriedLabels(old), ...(resumeId ? { [SESSION_LABEL]: resumeId } : {}),
    ...(plan.template ? { [WORKER_TEMPLATE_LABEL]: plan.template } : {}) };
  // The session the new pane runs, for its label and seat row: the id chosen for a new one, or the resumed one.
  const sessionOfPlan = (p, resumed) => p.sessionId ?? (p.mode === "resume" ? resumed : null);
  // #1557: a switch restarts on another login this sweep chose; a person's restart keeps the
  // selected login (`recheck`), as before.
  const login = opts._login ?? await recheck(plan.argv);
  // A queued restart claims its entry only once every check passed and the seat is about to
  // start: a cancel between the watcher's read and here wins, and nothing is launched.
  if (opts._queuedTarget) {
    const consumed = await editRestartQueue((rows) => {
      const i = rows.findIndex((e) => e.id === opts._queuedTarget.id);
      return i < 0 ? null : rows.splice(i, 1)[0];
    });
    if (!consumed) return PRINTED;
  }
  let seat = await launchSeat(project, bot, { agent: plan.agent, model: plan.model, argv: plan.argv, cwd, place,
    carry: { ...carry, ...(plan.sessionId ? { [SESSION_LABEL]: plan.sessionId } : {}) }, session: sessionOfPlan(plan, resumeId),
    replacing: old ? held.binding : null, granted: plan.granted, login });
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  // A direct restart supersedes a queued one only once it really started: its watcher must not
  // start a second replacement while this one hands the bot over.
  if (!opts._queuedTarget) {
    let queued = false;
    try { queued = readRestartQueue().some((e) => e.botId === bot.id); } catch {}
    if (queued) {
      await editRestartQueue(async (rows) => {
        const i = rows.findIndex((e) => e.botId === bot.id);
        if (i < 0) return null;
        const [e] = rows.splice(i, 1);
        await killQueuedWatcher(e.watcher);
        return e;
      });
    }
  }
  const warnings = seat.hook.warnings;
  const say = (w) => { warnings.push(w); report([w]); };
  // #597: the replacement is built from the bot's source (a live template's current command, or
  // bots.json), never the pane's copy; when they differ, one line names only flag names, values
  // masked, and a template by name.
  if (oldLaunch && !swap && (runningAgent === null || runningAgent === plan.agent)) {
    const changed = launchChange({ name: bot.name, launch: oldLaunch, agent: plan.agent, argv: plan.source, template: oldTemplate,
      usedTemplate: Boolean(plan.template) });
    if (changed) say(changed);
  }
  // The sidebar's Restart shows only --json's warnings: why it didn't resume goes there too
  // (the text answer says it in its own line).
  if (sharedNote) warnings.push(`${bot.name} starts on a new conversation: ${sharedNote}.`);
  // #1125: a Codex seat's template set aside for its agent row, by name and flag names.
  if (plan.templateNote) say(`${bot.name}: ${plan.templateNote}.`);
  // A seat template carried the grants (#1142): its launch's withheld folders are said here, once.
  // Its launch is the template's command and the pack's grants, never the agent row's words (the
  // template's own --add-dir words were proved exact before it was kept): only the grants count.
  const templateWithheld = plan.granted && codexPlan ? localCodexWarning([], codexPlan) : null;
  if (templateWithheld) say(`${bot.name}: ${templateWithheld}`);
  if (movedFrom && movedFrom !== wanted && plan.mode === "resume" && plan.agent !== "claude") {
    say(`${seat.terminal} runs in ${wanted}, not ${movedFrom}: ${plan.agent} finds its last conversation by folder${resumeId ? "" : ", so it may not find it there"}.`);
  }
  if (!wanted && oldCwd && cwd !== oldCwd) say(`${was.address}'s folder ${oldCwd} isn't there now, so ${seat.terminal} runs in ${key}${plan.mode === "resume" ? "; its conversation may not be found there" : ""}.`);
  for (const w of [...treeWarnings, ...early]) say(w);
  let rerun = [];
  let oldEnded = false;
  // The old launch's end row (RFC 0021 (f) 4), written only after hc kill of it succeeded.
  const endOld = async () => {
    const unlogged = appendEnd(endRow({ kind: "seat", terminal: old.address, core: held.binding.core ?? await rowCore(),
      createdMs: held.binding.created_ms ?? old.created_ms, reason: "replaced" }));
    if (unlogged) say(unlogged);
  };
  if (old) {
    // The old pane ends only once the new one has kept its agent up: the space is never left empty.
    let up = await agentUp(seat.terminal);
    // Codex can't resume the thread at all (its model provider is gone, #413): one new pane on a
    // new thread, the old one named in the note; any other failure stays a failure.
    const gone = up.state === "ended" ? await endedCause(seat.terminal) : null;
    if (providerGone(plan, gone)) {
      const note = providerGoneNote(resumeId, seat.terminal, gone);
      plan = { ...restartPlan({ ...planned, fresh: true }), note };
      await recheck(plan.argv);
      resumeId = null;
      say(`${bot.name} starts on a new conversation: ${note}.`);
      const again = await launchSeat(project, bot, { agent: plan.agent, model: plan.model, argv: plan.argv, cwd, place,
        carry: { ...carriedLabels(old), ...(plan.template ? { [WORKER_TEMPLATE_LABEL]: plan.template } : {}),
          ...(plan.sessionId ? { [SESSION_LABEL]: plan.sessionId } : {}) }, session: sessionOfPlan(plan, null), replacing: held.binding,
        granted: plan.granted });
      if (again.running) throw new CliError(`${bot.name} is running in ${again.running} now, so no new pane was started; ${old.address} still runs it, untouched.`);
      for (const w of again.hook.warnings) say(w);
      seat = again;
      up = await agentUp(seat.terminal);
    }
    if (up.state !== "live") {
      // An abandoned replacement is ended (no seat row was written for it); the old pane stays.
      if (up.state === "ended") {
        throw await exitedBefore(seat.terminal, `${old.address} still runs ${bot.name}, untouched.`
          + (plan.mode === "resume" ? ` Try am restart ${bot.id} --fresh.` : ""));
      }
      const ended = (await hcKill(seat.terminal)).code === 0;
      throw new CliError(`${seat.terminal} didn't keep an agent in front within ${RESTART_WAIT_MS / 1000}s${ended ? ", so it was ended" : ` and couldn't be ended (hc kill ${seat.terminal})`}; `
          + `${old.address} still runs ${bot.name}, untouched.`);
    }
    // Up: the ledger moves the bot to the new terminal, under its lock.
    const created = Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : seat.created_ms;
    let moved;
    try {
      if (!Number.isSafeInteger(created)) throw new CliError(`hc get gave no created_ms for ${seat.terminal}`);
      moved = target.adopted
        ? await commitAdoption(bot, target.adoption, seat.terminal, created, key)
        : await attachMoved(bot, held.binding, seat.terminal, created, key);
    } catch (e) {
      await hcKill(seat.terminal);
      throw new CliError(`${seat.terminal} was ended and ${old.address} still runs ${bot.name}: the attach ledger wasn't written (${e?.message ?? e}).`);
    }
    if (moved.lost !== undefined) {
      await hcKill(seat.terminal);
      throw new CliError(`${bot.name} was attached to ${moved.lost} while it restarted, so ${seat.terminal} was ended and nothing changed.`);
    }
    await seat.logSeat(created);
    // A session id carried onto the new pane, any harness (RFC 0021 (f) 5): a session row too.
    if (resumeId) {
      const unlogged = appendLedger(sessionRow({ terminal: seat.terminal, session: resumeId, transcript: known?.transcript ?? null,
        agent: plan.agent, core: await rowCore(), createdMs: created }));
      if (unlogged) say(unlogged);
    }
    // --tree: the old pane ends now, its helpers with it, so nothing types into a pane on the
    // bot's session while the new one runs it; then each helper runs again under the new pane.
    if (plans.length) {
      const k = await hcKill(old.address);
      if (k.code === 0) {
        oldEnded = true;
        await endOld();
        rerun = await rerunHelpers(plans, seat.terminal, say);
      } else {
        const why = `${old.address} wasn't ended (hc kill: ${(k.stderr || k.stdout).trim()}), so its helpers still run under it`;
        say(`${why}; none was run again. End it with hc kill ${old.address}, then restart them.`);
        rerun = plans.map((q) => ({ name: q.name, replaced: q.replaced, terminal: null, bot: q.binding?.bot ?? null, agent: q.agent ?? null, mode: q.mode ?? null,
          session: q.session ?? null, up: false, note: q.note ?? null, error: why, by_hand: null, still_running: true }));
      }
    }
  }
  // #939, revive only: the pane was gone, so nothing held the bot while the new one came up. It
  // must still prove itself: a resume that finds nothing exits at once, and revive then starts
  // a new conversation (the refusal names --fresh, as a replaced pane's does).
  if (ghost) {
    const up = await agentUp(seat.terminal);
    if (up.state === "ended") {
      throw await exitedBefore(seat.terminal, `${bot.name} isn't running.`
        + (plan.mode === "resume" ? ` Try am restart ${bot.id} --fresh.` : ""));
    }
    if (up.state !== "live") {
      const ended = (await hcKill(seat.terminal)).code === 0;
      throw new CliError(`${seat.terminal} didn't keep an agent in front within ${RESTART_WAIT_MS / 1000}s${ended ? ", so it was ended" : ` and couldn't be ended (hc kill ${seat.terminal})`}; `
        + `${bot.name} isn't running.`);
    }
    if (resumeId) {
      const unlogged = appendLedger(sessionRow({ terminal: seat.terminal, session: resumeId, transcript: known?.transcript ?? null,
        agent: plan.agent, core: await rowCore(), createdMs: Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : seat.created_ms }));
      if (unlogged) say(unlogged);
    }
  }
  // A helper --tree couldn't run again: the command fails (the bot did restart; its line says how).
  if (rerun.some((h) => h.error)) exitAfter.code = 1;
  if (plan.mode === "resume" && !resumeId && !plan.canonicalBot) {
    const name = agentName(plan.agent);
    say(`No ${name} session id was known for ${was.address}, so ${seat.terminal} resumes the latest conversation in ${cwd} (${plan.resume.join(" ")}). `
      + `No other bot's ${name} runs there; if it isn't ${bot.name}'s, restart again with --fresh.`);
  }
  let saved = false;
  if (opts.save) {
    // Written where the command runs (writeDirOf: a worktree's own file, #234).
    const now = loadProject(key, await writeDirOf(opts, key));
    const stored = now.raw.bots.find((b) => b?.id === bot.id);
    if (stored) {
      await saveProject(now, applyBotEdit(now.raw, { ...stored, agent: entry.agent, ...(entry.model ? { model: entry.model } : { model: undefined }), effort: entry.effort, tier: entry.tier }), { list: false });
      saved = true;
    } else {
      // A worktree branched before the bot was added: its file has no entry to change.
      say(`--save: ${fileName(now)}, this worktree's file, has no ${bot.name} (${bot.id}), so ${plan.agent} wasn't saved; `
        + `update this worktree from the main checkout's branch, or restart with --save in ${key}.`);
    }
  }
  const what = old ? `${seat.terminal} replaces ${old.address}, ${restartText(plan, resumeId)}`
    : ghost ? `its pane ${ghost.address} was gone; started in ${seat.terminal}, ${restartText(plan, resumeId)}`
      : `${bot.name} wasn't running; started in ${seat.terminal}${swap ? ` on ${plan.agent}` : ""}`;
  // One line per helper --tree ran again (its new terminal), after the bot's.
  const helperLine = (h, i) => `${bot.name}'s helper ${h.name ?? h.replaced}: ${h.terminal
    ? `${h.terminal} replaces ${h.replaced}, ${restartText({ ...h, resume: plans[i].resume ?? [] }, h.session)}${h.up ? "" : " (not up: see above)"}`
    : `${h.replaced} wasn't run again (${h.still_running ? "it still runs" : h.by_hand ? "its hc run line is above" : "see above"})`}.`;
  const answer = () => {
    if (!opts.json) report([`${bot.name}: ${what}${saved ? `; ${BOTS_PATH} now says ${plan.agent}${plan.model ? ` (${plan.model})` : ""}` : ""}.`, ...rerun.map(helperLine)]);
    // The session ids themselves stay in the ledger: --json shows *** where one is known (RFC 0021).
    return opts.json ? { ...seatJson(bot, seat), replaced: old?.address ?? null, mode: was ? plan.mode : "start", agent: plan.agent, model: plan.model,
      session: resumeId ? SESSION_MASK : null, note: plan.note, saved, warnings,
      ...(opts.tree ? { helpers: rerun.map((h) => ({ ...h, session: h.session ? SESSION_MASK : null })) } : {}) } : seat.terminal;
  };
  if (!old || oldEnded || (opts.tree && plans.length)) return answer();
  // A bot restarting itself runs this inside the pane the kill ends: everything is written and
  // printed first, then the kill, the last thing it does.
  if (process.env.HC_TERMINAL_ID && [old.address, old.name].includes(process.env.HC_TERMINAL_ID)) {
    const out = answer();
    // Flushed (a pipe's write can be asynchronous) before the kill takes this process with it.
    await new Promise((done) => process.stdout.write(unprinted(opts.json ? `${JSON.stringify(out, null, 2)}\n` : `${out}\n`), done));
    await new Promise((done) => process.stderr.write("", done));
    // The end row only once the kill succeeded: this process usually ends with the pane first,
    // and then the old launch has none (usagemeter's snapshot ends it instead).
    if ((await hcKill(old.address)).code === 0) await endOld();
    return PRINTED;
  }
  const killed = await hcKill(old.address);
  if (killed.code !== 0) say(`${old.address} wasn't ended (hc kill: ${(killed.stderr || killed.stdout).trim()}); end it with hc kill ${old.address}.`);
  else await endOld();
  return answer();
}

const BOT_ID_SHAPE = /^b-[a-z2-7]{10}$/;

/** Where a holder plays, for a refusal: `t7 (since 2026-11-02T10:00:00.000Z)`. */
const heldAt = (b) => `${b.machine ? `${b.machine}/` : ""}${b.terminal} (since ${b.at})`;

/**
 * Where a terminal named on the command line runs: { machine, core, address, bare }. A
 * "<machine>/tN" (or a bare id with --machine) is on that linked machine, which must be the
 * project's and be connected; `core` is then its core id, else null (this computer's).
 */
async function terminalPlace(terminal, project) {
  const slash = terminal.indexOf("/");
  const named = slash >= 0 ? terminal.slice(0, slash) : null;
  const bare = slash >= 0 ? terminal.slice(slash + 1) : terminal;
  if (!/^[A-Za-z0-9._-]+$/.test(bare) || bare.startsWith("-")) throw new CliError(`"${terminal}" isn't a terminal; name one like t7 or ${project.machine ?? "machine"}/t7.`, 2);
  if (named && named !== project.machine) {
    throw new CliError(`${terminal} is on ${named}; name the bot's project there: --machine ${named} --project <its folder there>.`, 2);
  }
  const machine = project.machine ?? null;
  if (!machine) return { machine: null, core: null, address: bare, bare };
  const m = await connectedMachine(machine, "nothing was attached");
  return { machine, core: m.id, address: `${machine}/${bare}`, bare };
}

/** Why a Claude bot on a linked machine has no briefing hook yet (automagik#206 part b2). */
const noHookThere = (bot, machine) => `${bot.name} runs on ${machine} without its per-turn briefing: the hook needs Automagik Herdr `
  + `installed on ${machine}, which comes next (am machine install ${machine}). Its role and team still come from ${BOTS_PATH}.`;

async function cmdAttach(opts, [ref, terminal], warnedRelabels) {
  if (!terminal) throw new CliError("attach needs a bot and a terminal: am attach <bot> <terminal> [--move].", 2);
  if (terminal.startsWith("-")) throw new CliError(`"${terminal}" isn't a terminal; name one like t7.`, 2);
  const project = await projectFor(opts);
  const { file, key } = project;
  const at = await terminalPlace(terminal, project);
  const bot = await botIn(project, ref, opts);
  if (bot.planned) throw new CliError(`${bot.name} is planned (wave ${bot.planned.wave}); clear "planned" before attaching it.`);
  const get = await hcGet(at.address);
  if (!get || get.state !== "live") throw new CliError(`${at.address} isn't a live terminal.`);
  const address = get.address ?? at.address;
  // The row's terminal is hc's id, never the name typed ("mypane"): whois asks by id.
  const bareId = address.includes("/") ? address.slice(address.indexOf("/") + 1) : address;
  if (at.machine && !address.startsWith(`${at.machine}/`)) throw new CliError(`hc get ${at.address} answered for ${address}; nothing was attached.`);
  if (!Number.isSafeInteger(get.created_ms)) throw new CliError(`hc get ${address} gave no created_ms; nothing was attached.`);
  const nameOf = (id) => { const n = file.bots.find((b) => b.id === id)?.name; return n ? `${n} (${id})` : `bot ${id}`; };
  const playsAnother = (b) => new CliError(`${address} already plays ${nameOf(b.bot)}, since ${b.at}; nothing was attached. `
    + `Detach that bot first: am detach ${b.bot}`);
  // Another bot's pane is refused first, by this run's view (and again under the lock).
  const seen = (await attachView()).byTerminal.get(address)?.binding;
  if (seen && seen.bot !== bot.id && seen.created_ms === get.created_ms) throw playsAnother(seen);
  // #1128: the same resolver every read uses. When the project's own app home already names
  // this bot, attaching here would write the second authority the restart fix refuses to
  // create: name the home that owns it instead.
  if (!at.machine && existsSync(attachPath(projectAppHomeOf(project.key)))) {
    const resolved = await resolvedBinding(project, bot, { requestedHome: appHome() });
    if (resolved.binding && !sameHome(resolved.home, appHome())) {
      throw new CliError(`${bot.name} (${bot.id}) is attached in ${attachPath(resolved.home)}; nothing was attached. `
        + `Set HERDR_APP_HOME=${resolved.home} to attach or detach it there.`);
    }
  }
  // Claude by its report, its foreground, or a wrapper whose argv runs claude (models.js).
  const claude = isClaude({ report: { app: get.status?.app } }, get) || agentKeyOfArgv(get.foreground?.argv) === "claude";
  let sessionFolder = get.foreground?.cwd ?? get.cwd ?? null;
  if (claude) {
    if (!get.foreground?.cwd) throw new CliError(`Can't read where ${address}'s Claude session runs (hc get ${address}); nothing was attached.`);
    sessionFolder = get.foreground.cwd;
    const sessionKey = at.machine ? (await remoteProjectOf(at.machine, sessionFolder)).key : await keyOf(sessionFolder);
    const refusal = attachRefusal({ botName: bot.name, projectKey: key, sessionFolder, sessionKey });
    if (refusal) throw new CliError(refusal);
  }
  // The ledger decides, under its lock: the terminal held by another bot is refused, and so is
  // the bot held by another terminal unless --move, which writes its detach (moved) first.
  const decided = await underLedger(async ({ core, machines, heldBy, byKey, holds, write }) => {
    const here = await holds(byKey.get(attachKey({ core: at.core ?? core, terminal: bareId, created_ms: get.created_ms })));
    if (here && here.binding.bot !== bot.id) throw playsAnother(here.binding);
    if (here) return { already: true, movedFrom: null };
    const mine = await holds(heldBy(bot.id, at.core));
    if (mine && !opts.move) {
      throw new CliError(`${bot.name} (${bot.id}) is attached to ${heldAt(mine.binding)}; nothing was attached. `
        + `Move it with: am attach ${bot.id} ${address} --move (or detach it first).`);
    }
    const rows = mine ? [closingRow(mine.binding, "detach", "attach", "moved")] : [];
    rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal: bareId, core: at.core ?? core, created_ms: get.created_ms,
      machine: at.machine, by: "attach" }));
    write(rows);
    return { already: false, movedFrom: mine ? addressOf(mine.binding, machines) : null };
  });
  const warnings = [];
  const label = async (t, words) => {
    if (!words.length) return;
    const message = `the ledger has it, but hc label ${t} ${words.join(" ")} failed:`;
    if (warnedRelabels) {
      const warning = await relabelPane(t, words, message, warnedRelabels);
      if (warning) warnings.push(warning);
      return;
    }
    const r = await hc(["label", t, ...words]);
    if (r.code !== 0) warnings.push(`${message} ${(r.stderr || r.stdout).trim()}`);
  };
  // The labels follow as a display hint: off the old pane, then bot, role, category and a
  // squad copied from the lead (A16) on this one. A label failure only warns.
  if (decided.movedFrom) {
    const old = await hcGet(decided.movedFrom).catch(() => null);
    if (old?.state === "live") await label(decided.movedFrom, detachWords(old.labels ?? {}));
  }
  const have = get.labels ?? {};
  if (have[BOT_LABEL] !== bot.id) await label(address, [`${BOT_LABEL}=${bot.id}`]);
  const lead = leadIdOf(file, bot.id);
  let leadRows = [];
  try { leadRows = lead ? await liveRows(lead) : []; } catch { leadRows = []; }
  await label(address, attachWords(file, bot.id, { ...have, [BOT_LABEL]: bot.id }, leadRows));
  const hook = claude && !at.machine ? await writeBriefingHook(bot, sessionFolder) : { written: false, warnings: [] };
  if (claude && at.machine) hook.warnings.push(noHookThere(bot, at.machine));
  hook.warnings.unshift(...warnings);
  // The workers ledger's seat rows are this computer's (restart's session lookup).
  if (!decided.already && !at.machine) {
    const argv = get.foreground?.argv;
    const seatAgent = agentKeyOfArgv(argv, agentTable()) ?? (claude ? "claude" : bot.agent ?? null);
    const unlogged = appendLedger(startRow({ kind: "seat", terminal: address, pid: get.foreground?.pid ?? get.pid ?? null, botId: bot.id,
      worktree: sessionFolder, project: key, agent: seatAgent, model: detectModel(argv, seatAgent), template: paneTemplateName(get), ...seatTags(file, bot.id),
      core: await rowCore(), createdMs: get.created_ms }));
    if (unlogged) hook.warnings.push(unlogged);
  }
  if (hook.written) hook.warnings.push(`${bot.name}'s briefing hook was added while its Claude session was running. If its next prompt brings no briefing, restart the bot: am restart ${bot.id} (or the bot row's Restart).`);
  report(hook.warnings);
  if (!project.machine) listProject(key);
  const movedFrom = decided.movedFrom ? [decided.movedFrom] : [];
  // A linked machine's terminal goes as its bare id beside `machine`, as the ledger holds it.
  if (opts.json) return { id: bot.id, terminal: at.machine ? bareId : address, ...(at.machine ? { machine: at.machine } : {}),
    already: decided.already, movedFrom, hookWritten: hook.written, warnings: hook.warnings };
  if (decided.already) return `${bot.name} is already ${address}.`;
  return `${bot.name} is now ${address}${movedFrom.length ? ` (moved from ${movedFrom[0]})` : ""}.`;
}

async function cmdDetach(opts, [ref]) {
  // A bare id needs no definition: a bot removed with rm can still be detached.
  const bareId = BOT_ID_SHAPE.test(ref ?? "");
  let bot = null;
  try { bot = findBot((await projectFor(opts)).file, ref); } catch (e) { if (!bareId || !(e instanceof CliError)) throw e; }
  const id = bot?.id ?? ref;
  const name = bot?.name ?? `bot ${id}`;
  const place = opts.machine !== undefined ? (await connectedMachine(opts.machine, "nothing was detached")).id : null;
  const key = opts.machine !== undefined && bot ? (await projectFor(opts)).key : null;
  const held = await underLedger(async ({ machines, heldBy, holds, write }) => {
    const mine = await holds(heldBy(id, place));
    if (mine && key && mine.binding.project !== key) return null;
    if (!mine) return null;
    write([closingRow(mine.binding, "detach", "detach")]);
    return { address: addressOf(mine.binding, machines), binding: mine.binding };
  });
  const from = held?.address ?? null;
  // The labels, a display hint, come off the detached pane and any other local pane carrying
  // them. A16: role= and category= go with bot=; squad= only when this pack copied it there.
  // The row is written already: a failure here only warns.
  const cleared = [];
  try {
    // --machine: that machine's pane only; this computer's panes carrying the id are another bot.
    const { addresses, gets } = place ? { addresses: [], gets: [] } : await paneOf(id, hcJson, { localOnly: true });
    for (const t of new Set([...(from ? [from] : []), ...addresses])) {
      const have = gets.find((g) => g?.address === t)?.labels ?? (await hcGet(t).catch(() => null))?.labels ?? {};
      if (have[BOT_LABEL] !== id) continue;
      const words = detachWords(have);
      const r = await hc(["label", t, ...words]);
      if (r.code !== 0) report([`${name} is detached, but hc label ${t} ${words.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`]);
      else cleared.push(t);
    }
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    report([`${name} is detached${from ? ` from ${from}` : ""}, but its labels weren't cleared: ${e.message}`]);
  }
  const detached = held ? [held.binding.terminal] : [];
  const machine = held?.binding.machine ?? null;
  return opts.json ? { id, defined: Boolean(bot), detached, ...(machine ? { machine } : {}), labelsCleared: cleared }
    : from ? `${name} detached from ${from}.` : `${name} has no pane on this computer.`;
}

// ---- import (#232): a running hc team as bots ----

// The squad's captain by its hc name or template, when no seat of the squad is labelled
// role=captain: the squad's name, a separator, then cap or captain (web-cap, web_captain), so
// escape-cap is no captain of web, and a bare "cap" none at all (#486).
const CAPTAIN_NAME = /^(.+)[-_.](cap|captain)$/i;
// A member's rank by its name's last word, when its pane's role= label is not a rank.
const RANK_WORDS = { dev: "dev", test: "tester", tester: "tester", qa: "tester", review: "reviewer", reviewer: "reviewer",
  fix: "fixer", fixer: "fixer", pm: "pm", int: "integrator", integrator: "integrator" };
const byTerminal = (a, b) => a.terminal.localeCompare(b.terminal, undefined, { numeric: true });

/** How a seat is its squad's captain by name (#486): "name", "template" or null; never a seat whose role= is another rank. */
function captainByName(squad, seat) {
  const role = seat.get.labels?.role;
  if (RANKS.includes(role) && role !== "captain") return null;
  const of = (n) => typeof n === "string" && CAPTAIN_NAME.exec(n.trim())?.[1].toLowerCase() === squad.toLowerCase();
  return of(seat.name) ? "name" : of(seat.get.template) ? "template" : null;
}

function seatRank(get, name) {
  const role = get.labels?.role;
  if (RANKS.includes(role) && role !== "captain") return role;
  return RANK_WORDS[name.toLowerCase().split(/[-_.]/).pop()] ?? null;
}

/**
 * The import's plan (#232): { seats, skipped, conflicts, raw }, from this computer's live panes
 * labelled `label`=. A seat is one with an hc name and an agent in front: "already" (it plays the
 * bot of its name, by the attach ledger), "attach" (that bot is defined and attached nowhere, as
 * a run cut short before its attaches leaves it) or "create" (then attach). Captains first, every
 * new bot is checked as create checks it against the file as the plan grows it; `raw` is that
 * file. Nothing is written here; readOnly (the dry run, #486) keeps the ledger view from
 * writing too (attachView).
 */
async function importPlan(project, label, { readOnly = false } = {}) {
  const { file } = project;
  const main = mainBotOf(file);
  const conflicts = [];
  const skipped = [];
  if (!main) {
    conflicts.push(`${under(project.key, BOTS_PATH)} has no main bot; the import makes captains and members under it. `
      + "Create it first: am create --name N --agent A");
  }
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state !== "finished");
  const gets = (await Promise.all(rows.map(async (r) => {
    const g = await hcLookup(r.address);
    return g ? { ...g, address: g.address ?? r.address, name: g.name ?? r.name ?? null } : null;
  }))).filter((g) => g?.state === "live" && local(g.address) && typeof g.labels?.[label] === "string" && g.labels[label].trim());
  const view = await attachView({ readOnly });
  const agents = agentTable();
  const botName = (id) => { const b = file.bots.find((x) => x.id === id); return b ? `${b.name} (${b.id})` : `bot ${id}`; };
  const seats = [];
  for (const get of gets) {
    const terminal = get.address;
    const name = typeof get.name === "string" && get.name.trim() && get.name !== terminal ? get.name.trim() : null;
    const seat = { squad: get.labels[label].trim(), terminal, name, agent: null, rank: null, captain: false, action: "create", id: null, get };
    const named = name ? file.bots.find((b) => b.name.toLowerCase() === name.toLowerCase()) ?? null : null;
    const at = `${terminal}${name ? ` (${name})` : ""}`;
    const held = view.byTerminal.get(terminal)?.binding ?? null;
    if (held) {
      if (named && held.bot === named.id) {
        // Its labels as attach sets them (#486): lost ones come back by attaching again, which
        // writes no ledger row for a pane that already plays its bot.
        const have = get.labels ?? {};
        const lead = leadIdOf(file, named.id);
        let leadRows = [];
        try { leadRows = lead ? await liveRows(lead) : []; } catch { leadRows = []; }
        const relabel = [...(have[BOT_LABEL] !== named.id ? [`${BOT_LABEL}=${named.id}`] : []),
          ...attachWords(file, named.id, { ...have, [BOT_LABEL]: named.id }, leadRows)];
        seats.push({ ...seat, action: "already", id: named.id, bot: named, relabel });
        continue;
      }
      conflicts.push(`${at} already plays ${botName(held.bot)}; the import never takes another bot's pane. Detach that bot `
        + `first, or take ${label}= off the pane (hc label ${terminal} ${label}=).`);
      continue;
    }
    if (get.labels[WORKER_OF_LABEL]) { skipped.push({ terminal, name, why: "a worker (worker.of), not a seat" }); continue; }
    if (!name) { skipped.push({ terminal, name, why: "no hc name to name its bot by" }); continue; }
    const claude = isClaude({ report: { app: get.status?.app } }, get) || agentKeyOfArgv(get.foreground?.argv) === "claude";
    const agent = agentKeyOfArgv(get.foreground?.argv, agents) ?? (claude ? "claude" : null);
    if (!agent) { skipped.push({ terminal, name, why: "no coding agent in front" }); continue; }
    const tagged = get.labels[BOT_LABEL];
    if (tagged && tagged !== named?.id && file.bots.some((b) => b.id === tagged)) {
      conflicts.push(`${at} is labelled ${BOT_LABEL}=${tagged}, ${botName(tagged)}; the import never takes another bot's pane.`);
      continue;
    }
    if (claude) {
      const cwd = get.foreground?.cwd;
      if (!cwd) { conflicts.push(`Can't read where ${at}'s Claude session runs (hc get ${terminal}).`); continue; }
      const refusal = attachRefusal({ botName: name, projectKey: project.key, sessionFolder: cwd, sessionKey: await keyOf(cwd) });
      if (refusal) { conflicts.push(`${at}: ${refusal}`); continue; }
    }
    if (named) {
      const there = liveFor(view, named.id, project);
      if (there) {
        conflicts.push(`${botName(named.id)} already plays ${there.binding.terminal}, not ${terminal}; the import never moves a bot. `
          + `Detach it first (am detach ${named.id}), or give the seat another hc name.`);
        continue;
      }
      if (named.kind === "main" || named.planned) {
        conflicts.push(`${at}: ${botName(named.id)} is ${named.kind === "main" ? "the main bot" : "planned"}, so the import can't make it a squad's seat.`);
        continue;
      }
      if (named.agent && named.agent !== agent) {
        conflicts.push(`${at} runs ${agent}, and ${botName(named.id)} is defined with agent ${named.agent}; the import never attaches `
          + `a bot to another agent's pane. Edit it first (am edit ${named.id} --agent ${agent}), or give the seat another hc name.`);
        continue;
      }
      seats.push({ ...seat, agent, action: "attach", id: named.id, bot: named });
      continue;
    }
    seats.push({ ...seat, agent });
  }
  const byName = new Map();
  for (const s of seats) byName.set(s.name.toLowerCase(), [...(byName.get(s.name.toLowerCase()) ?? []), s.terminal]);
  for (const [n, ts] of byName) if (ts.length > 1) conflicts.push(`${ts.join(", ")} share the hc name "${n}"; names pick bots, so rename all but one.`);
  // Each squad: its one captain first, then its members by terminal.
  const ordered = [];
  const squads = new Map();
  for (const s of seats) squads.set(s.squad, [...(squads.get(s.squad) ?? []), s]);
  for (const squad of [...squads.keys()].sort()) {
    const all = squads.get(squad).sort(byTerminal);
    const labelled = all.filter((s) => s.get.labels?.role === "captain");
    const caps = labelled.length ? labelled : all.filter((s) => captainByName(squad, s));
    const by = labelled.length ? "role" : caps.length === 1 ? captainByName(squad, caps[0]) : null;
    if (caps.length !== 1) {
      conflicts.push(caps.length
        ? `Squad ${squad} has ${caps.length} captains (${caps.map((s) => `${s.terminal} ${s.name}`).join(", ")}); keep role=captain on one: hc label <terminal> role=captain.`
        : `Squad ${squad} has no captain: label one pane role=captain (hc label <terminal> role=captain), or name it ${squad}-cap.`);
      continue;
    }
    for (const s of [caps[0], ...all.filter((x) => x !== caps[0])]) {
      s.captain = s === caps[0];
      s.captainBy = s.captain ? by : null;
      s.lead = s.captain ? main : null;
      s.rank = s.captain ? "captain" : seatRank(s.get, s.name);
      if (!s.captain) s.leadSeat = caps[0];
      ordered.push(s);
    }
  }
  if (!main) return { seats: ordered, skipped, conflicts, raw: project.raw };
  // A defined bot is attached only where the plan would have put it: same lead.
  let raw = project.raw;
  let grown = file;
  for (const s of ordered) {
    const leadId = s.captain ? main.id : s.leadSeat.id;
    if (s.action === "attach") {
      const has = s.bot.lead ?? main.id;
      if (!leadId || has !== leadId) {
        conflicts.push(`${s.terminal} (${s.name}): ${botName(s.bot.id)} is defined with lead ${botName(has)}, and the import would `
          + `make it ${s.captain ? `the ${s.squad} captain, under ${botName(main.id)}` : `report to ${s.leadSeat.name}`}. Edit it first.`);
      }
      continue;
    }
    if (s.action !== "create") continue;
    if (!leadId) continue; // its captain is refused above
    const id = newBotId();
    try {
      const entry = entryFrom({ name: s.name, agent: s.agent, rank: s.rank ?? undefined, lead: s.captain ? undefined : leadId,
        role: s.captain ? `Captain of the ${s.squad} squad` : `Member of the ${s.squad} squad` }, { id, kind: "member" }, { file: grown }, { creating: true });
      raw = applyBotEdit(raw, entry);
      grown = parseBots(JSON.stringify(raw)).file;
      s.id = id;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      conflicts.push(`${s.terminal} (${s.name}): ${e.message}`);
    }
  }
  return { seats: ordered, skipped, conflicts, raw };
}

/** A seat as the plan prints it; a new bot's id only once it is made. captainBy: "role", "name", "template" or null. */
const seatOut = (s, made) => ({ squad: s.squad, terminal: s.terminal, name: s.name, action: s.action, captain: s.captain, captainBy: s.captainBy ?? null,
  lead: s.captain ? (s.lead?.name ?? null) : s.leadSeat.name, rank: s.action === "create" ? s.rank : (s.bot.rank ?? null),
  agent: s.agent ?? s.bot?.agent ?? null, id: s.action === "create" && !made ? null : s.id, relabel: s.relabel ?? [] });
/** A seat --apply attaches: every one but a seat already playing its bot with all its labels (#486). */
const importTodo = (s) => s.action !== "already" || s.relabel.length > 0;
const CAPTAIN_BY = { role: " by role=captain", name: " by name", template: " by template" };

function importText(plan, { key, label, apply }) {
  const lines = [`Import of the panes labelled ${label}= into ${key}${apply ? "" : " (dry run: nothing is changed)"}:`];
  if (!plan.seats.length && !plan.skipped.length && !plan.conflicts.length) lines.push(`  No live pane on this computer is labelled ${label}=.`);
  let squad = null;
  for (const s of plan.seats) {
    if (s.squad !== squad) { squad = s.squad; lines.push(`  squad ${squad}`); }
    const who = s.captain ? `captain${CAPTAIN_BY[s.captainBy] ?? ""}, reports to ${s.lead?.name ?? "the main bot"}` : `member, lead ${s.leadSeat.name}${s.rank ? `, rank ${s.rank}` : ""}`;
    lines.push(`    ${s.terminal}  ${s.action === "already" ? `${s.name} (${s.id}) already plays it: ${s.relabel.length ? `its lost labels go back (${s.relabel.join(" ")})` : "nothing to do"}`
      : s.action === "attach" ? `attach ${s.name} (${s.id}), defined already`
        : `create ${s.name} (${who}, ${s.agent}), then attach`}`);
  }
  for (const k of plan.skipped) lines.push(`  skipped ${k.terminal}${k.name ? ` (${k.name})` : ""}: ${k.why}`);
  for (const c of plan.conflicts) lines.push(`  conflict: ${c}`);
  const todo = plan.seats.filter(importTodo).length;
  if (plan.conflicts.length) lines.push(`Nothing was changed: ${plan.conflicts.length} conflict(s) refuse the import.`);
  else if (!todo) lines.push("Nothing to do: every seat already plays its bot.");
  else if (!apply) lines.push(`Run it with --apply: ${todo} seat(s) to import.`);
  return lines.join("\n");
}

async function cmdImport(opts) {
  if (!opts["from-hc"]) throw new CliError("import needs its source: am import --from-hc [--squad-label L] [--apply].", 2);
  const label = opts["squad-label"] ?? "squad";
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new CliError(`--squad-label: "${label}" isn't an hc label key.`, 2);
  const project = await editProjectFor(opts);
  if (project.dir !== project.key) {
    throw new CliError(`Run the import in ${project.key}: attach reads ${under(project.key, BOTS_PATH)}, and from this worktree the bots `
      + `would go to ${under(project.dir, BOTS_PATH)}. Nothing was changed.`);
  }
  const plan = await importPlan(project, label, { readOnly: !opts.apply });
  const apply = Boolean(opts.apply) && !plan.conflicts.length;
  const todo = plan.seats.filter(importTodo);
  const out = { project: project.key, squadLabel: label, dryRun: !opts.apply, seats: plan.seats.map((s) => seatOut(s, false)),
    skipped: plan.skipped, conflicts: plan.conflicts, attached: [], stopped: null };
  if (plan.conflicts.length) {
    exitAfter.code = 1;
    report([`import refused, nothing was changed: ${plan.conflicts.length} conflict(s).`]);
  }
  if (!opts.json) process.stdout.write(`${importText(plan, { key: project.key, label, apply: Boolean(opts.apply) })}\n`);
  if (apply && todo.length) {
    // One write for every new bot, then one attach per seat, captains first: attach checks
    // again under the ledger's lock and never moves a bot (no --move).
    if (todo.some((s) => s.action === "create")) {
      await saveProject(project, plan.raw);
      await relabelAfter(project.file, plan.raw);
    }
    for (const s of todo) {
      try {
        const r = await cmdAttach({ project: opts.project, json: true }, [s.id, s.terminal]);
        out.attached.push({ id: s.id, name: s.name, terminal: s.terminal, created: s.action === "create", already: r.already, warnings: r.warnings });
        const now = s.action === "already" ? "is" : "is now";
        if (!opts.json) process.stdout.write(`  ${s.name} (${s.id}) ${now} ${s.terminal}${s.action === "create" ? ", created" : s.action === "already" ? ", its labels back" : ""}.\n`);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        out.stopped = { terminal: s.terminal, name: s.name, error: e.message };
        exitAfter.code = 1;
        report([`import stopped at ${s.terminal} (${s.name}): ${e.message} The bots made so far are saved; run the import again to attach the rest.`]);
        break;
      }
    }
    out.seats = plan.seats.map((s) => seatOut(s, true));
    await tidyQuietly();
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return PRINTED;
}

async function cmdWhois(opts, [terminal]) {
  if (opts.all) {
    if (terminal !== undefined || opts.bot !== undefined) throw new CliError("whois --all takes no terminal and no --bot.", 2);
    if (opts.machine !== undefined) throw new CliError("whois --all lists every place the ledger holds; --machine goes with one terminal or --bot.", 2);
    const view = await attachView();
    const row = (binding, state) => ({ ...whoisOf({ binding }), address: addressOf(binding, view.machines),
      machine: view.machines.get(binding.core)?.name ?? binding.machine ?? null, state });
    const bindings = [
      ...[...view.liveAt.values()].map(({ binding }) => row(binding, "live")),
      ...[...view.unknownAt.values()].map((binding) => row(binding, "unknown")),
    ].sort((a, b) => `${a.address}\n${a.bot}`.localeCompare(`${b.address}\n${b.bot}`));
    if (opts.json) return { core: view.core, bindings };
    return bindings.map((b) => `${b.address} ${b.state === "live" ? "plays" : "last played"} ${b.bot} `
      + `(${b.project ?? "no project"}) since ${b.since}${b.state === "unknown" ? " (machine away)" : ""}`).join("\n") || "No bot is attached.";
  }
  if ((opts.bot === undefined) === (terminal === undefined)) {
    throw new CliError("whois needs a terminal or --bot <id>: am whois <terminal> | whois --bot <id>.", 2);
  }
  if (opts.bot !== undefined) {
    const bare = BOT_ID_SHAPE.test(opts.bot) || opts.bot.startsWith("session-");
    // The project is the one --project names or the folder keys to; a bare id still answers
    // outside one, as it always has, but the project's app home is only readable with it.
    let project = null;
    try { project = await projectFor(opts); } catch (e) { if (!bare) throw e; }
    const id = bare ? opts.bot : findBot(project.file, opts.bot).id;
    // --machine: the bot's binding on that linked machine (its core), else this computer's.
    const there = opts.machine !== undefined ? await connectedMachine(opts.machine, "nothing to answer") : null;
    const view = await attachView();
    // #1128: the same resolver start and restart read, so a live binding in the project's own
    // app home answers here too, over a stale row in the selected one, and a two-live split
    // refuses rather than showing one. A bare id outside a project still answers from the
    // view's own row, which the project filter would hide.
    const held = there ? view.liveAt.get(atKey(id, there.id)) ?? null
      : await readHeld(project, { id }, view, { refuseTwins: true, direct: view.live.get(id) ?? null });
    const out = held ? whoisOf(held) : { terminal: null, core: there ? there.id : view.core, created_ms: null, bot: id, project: null, since: null };
    if (opts.json) return out;
    return held ? `${id} plays in ${addressOf(held.binding, view.machines)} (${out.project}) since ${out.since}.` : `${id} is attached to no terminal.`;
  }
  if (terminal.startsWith("-")) throw new CliError(`"${terminal}" isn't a terminal; name one like t7.`, 2);
  // A linked machine's terminal, "<machine>/tN": the answer keeps whois' shape, its terminal
  // the bare id and its core that machine's, as the ledger holds them; never the address.
  // A bare id with --machine is that machine's.
  if (opts.machine !== undefined && !terminal.includes("/")) terminal = `${opts.machine}/${terminal}`;
  const slash = terminal.indexOf("/");
  const there = slash >= 0 ? await connectedMachine(terminal.slice(0, slash), "nothing to answer") : null;
  const view = await attachView();
  const get = await hcLookup(terminal);
  const address = get?.address ?? terminal;
  const held = view.byTerminal.get(address);
  const out = held ? whoisOf(held)
    : { terminal: there ? address.slice(address.indexOf("/") + 1) : address, core: there ? there.id : view.core, created_ms: get?.created_ms ?? null, bot: null };
  if (opts.json) return out;
  return held ? `${address} plays ${out.bot} (${out.project}) since ${out.since}.` : `${address} plays no bot.`;
}

/** `value` with every string in it rid of each id in `ids` (shown as SESSION_MASK), objects and arrays walked. */
function scrubIds(value, ids) {
  if (!ids.size) return value;
  if (typeof value === "string") { let out = value; for (const id of ids) out = out.split(id).join(SESSION_MASK); return out; }
  if (Array.isArray(value)) return value.map((x) => scrubIds(x, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubIds(v, ids)]));
  return value;
}

async function cmdHistory(opts, [ref]) {
  const machine = opts.machine;
  // Resolve the linked project even for a bare id so machine and project errors are reported.
  const project = machine === undefined ? null : await projectFor(opts);
  // A bare id needs no definition (as detach): a removed bot's history is still there.
  const bareId = BOT_ID_SHAPE.test(ref ?? "");
  let bot = null;
  try { bot = findBot((project ?? await projectFor(opts)).file, ref); } catch (e) { if (!bareId || !(e instanceof CliError)) throw e; }
  const id = bot?.id ?? ref;
  const core = project ? (await machineNamed(machine))?.id : null;
  if (project && !core) throw new CliError(`${machine} isn't a linked machine (hc machine ls).`);
  const attachRows = (readAttachFile() ?? []).filter((r) => project
    ? r.machine && r.core === core && r.project === project.key
    : !r.machine);
  // Worker ledger terminals belong to this computer.
  const ledgerRows = project ? [] : workerLedgerRows();
  // RFC 0021: no session id is printed, in --json or text: every id the ledger holds is shown as
  // *** wherever it appears (its rows, the timeline, a transcript path named after it).
  const ids = new Set(ledgerRows.map((r) => holdId(r?.session)).filter((x) => typeof x === "string" && x.length >= 4));
  const h = scrubIds(botHistory({ attachRows, ledgerRows, botId: id }), ids);
  if (opts.json) return { id, name: bot?.name ?? null, ...(project ? { machine } : {}), ...h };
  const { timeline, workers, transcript } = historyLines(h);
  const empty = project ? `nothing recorded by this computer for ${machine}` : "nothing recorded on this computer";
  return [
    `${bot?.name ?? `bot ${id}`} (${id})${project ? ` on ${machine}` : ""}`,
    "  what happened", ...(timeline.length ? timeline.map((e) => `    ${e.text}`) : [`    ${empty}`]),
    ...(workers.length ? ["  workers", ...workers.map((w) => `    ${w}`)] : []),
    ...(transcript ? [`  transcript   ${transcript}`] : []),
  ].join("\n");
}

async function cmdBrief(opts, [ref]) {
  const project = await projectFor(opts);
  const bot = await botIn(project, ref, opts);
  if (bot.planned) {
    if (opts.json) return { id: bot.id, briefing: null, reason: "planned bots get no briefing" };
    process.stderr.write(`am: ${bot.name} is planned; planned bots get no briefing.\n`);
    return "";
  }
  // briefing.mjs' own gathering; a failed hc call reads as "no answer" (unreachable), as
  // it does in the hook, so the briefing still prints.
  const ask = async (args) => { try { return await hcJson(args); } catch (e) { if (e instanceof CliError) return UNANSWERED; throw e; } };
  // The panes by the attach ledger, as this run's view confirms them; with hc failing, every
  // pane reads as unreachable, as a failed call does in the hook.
  const { view } = await viewOrError();
  const locate = async (id) => {
    if (!view) return { get: null, duplicate: false, addresses: [], gets: [], unreachable: true };
    // #1128: the same resolver the other reads use; a bot that lives in the project's own app
    // home is found there, never from a stale row in the selected one. A failed hc call still
    // reads as "no answer" here, as it does in the hook.
    let held = view.live.get(id);
    if (!held) { try { held = await projectHomeHeld(project, { id }); } catch { held = null; } }
    if (!held) return { get: null, duplicate: false, addresses: [], gets: [] };
    const get = { ...held.get, address: held.get?.address ?? held.binding.terminal };
    return { get, duplicate: false, addresses: [get.address], gets: [get] };
  };
  const self = await locate(bot.id);
  const text = await gatherBriefing({
    file: project.file,
    bot,
    address: self.get?.address ?? null,
    ask,
    locate,
    isGit: await projectIsGit(project),
    project: project.key,
    projects: localProjectsFor(project),
  });
  return opts.json ? { id: bot.id, briefing: text } : text;
}

// ---- workers: a bot's one worker per task ----

/**
 * The folders that may hold the calling pane's project, most telling first: its foreground's
 * folder (where the agent works now), the folders of the other terminals in its Herdr space
 * (one space = one project; the sidebar's own rule, from hc alone so no window is needed),
 * its launch folder, this command's folder, then the remembered projects. Fallbacks only: callingBot
 * asks the attach binding's project first, and keeps the hints whose bots file defines the bot.
 */
async function botProjectHints(me, address) {
  const hints = [me.foreground?.cwd];
  const space = me.labels?.[SPACE_LABEL];
  if (space) {
    try {
      const peers = rowsOf(await hcJson(["ls", "--label", `${SPACE_LABEL}=${space}`]));
      hints.push(...peers.filter((r) => local(r?.address) && r.address !== address && r.state === "live").map((r) => r.cwd));
    } catch { /* hc ls failing: the space gives no hint */ }
  }
  hints.push(me.cwd, process.cwd());
  return [...hints.filter((h) => typeof h === "string" && h.startsWith("/")), ...rememberedKeys()];
}

/**
 * The projects among `folders` whose bots file defines `botId`, in the folders' order, each
 * once: [{ key, project, bot }]. A folder gone, outside any project or with a bots file that
 * doesn't parse is skipped (another project's broken file never blocks this bot).
 */
async function projectsDefining(botId, folders) {
  const seen = new Set();
  const found = [];
  for (const folder of folders) {
    let key;
    try { key = await keyOf(folder); } catch { continue; }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let project;
    try { project = loadProject(key); } catch { continue; }
    const bot = project.file.bots.find((b) => b.id === botId);
    if (bot) found.push({ key, project, bot });
  }
  return { found, looked: [...seen] };
}

/** A project (by key) as { key, project, bot } when its bots file defines `botId`, else null. */
function definedIn(key, botId, { strict = false } = {}) {
  let project;
  try { project = loadProject(key); } catch (e) { if (strict) throw e; return null; }
  const bot = project.file.bots.find((b) => b.id === botId);
  return bot ? { key, project, bot } : null;
}

/**
 * The bot whose pane runs this command: { me (hc get), bot, project }. Anyone else is refused.
 * The bot is the attach ledger's binding of the pane, never its label. Its project is the one
 * whose bots file defines it: `--project` when that one does; else the project the binding
 * names (attach.js: the bot's main checkout) when it does; else the one project among the
 * fallbacks (botProjectHints) that does. Two fallbacks defining it are refused, never chosen between.
 */
async function callingBot(opts) {
  const self = process.env.HC_TERMINAL_ID;
  if (!self) throw new CliError("Only a bot starts workers, from its own pane: HC_TERMINAL_ID isn't set here, so this isn't a bot's pane.");
  // Three answers, told apart (#1125): no such terminal (hc's not_found), a lookup that failed (the
  // core unreachable, a sandbox blocking hc's socket or folders), and an answer that isn't JSON.
  let me;
  try { me = await hcGet(self); } catch (e) {
    throw new CliError(`hc couldn't look up this pane (${self}), so it can't be checked as a bot's: ${e?.message ?? e}. `
      + "Nothing was started. In a Codex pane, hc needs the sandbox's network access and herdr-core's state and data "
      + "folders (the pack's Codex launch gives both, #1125); restart the bot if it predates that.");
  }
  if (!me) throw new CliError(`${self} isn't a terminal hc knows (hc get: not found); start workers from a bot's pane.`);
  const address = me.address ?? self;
  // Named before the ledger is read: its one-time label import looks in a --project too.
  const named = opts.project !== undefined ? await namedKeyOf(opts.project) : null;
  if (named) namedKeys.add(named);
  // Which bot this pane plays is the attach ledger's answer, never its label.
  const binding = (await attachView()).byTerminal.get(address)?.binding;
  const botId = binding?.bot;
  if (!botId) throw new CliError(await unboundRefusal(me, address));
  // The named project as namedKeyOf keys it (never a parent's); its bots file must parse.
  let hit = named ? definedIn(named, botId, { strict: true }) : null;
  if (!hit && !named && typeof binding.project === "string") hit = definedIn(binding.project, botId);
  if (!hit) {
    const hints = [...(typeof binding.project === "string" ? [binding.project] : []), ...await botProjectHints(me, address)];
    const { found, looked } = await projectsDefining(botId, hints);
    const defining = found.filter((f) => f.key !== named);
    if (named) {
      const which = defining.length ? `it's defined in ${defining.map((f) => f.key).join(" and ")}` : "no project here defines it";
      throw new CliError(`--project ${named} doesn't define bot ${botId}, which ${address} plays (${under(named, BOTS_PATH)}); ${which}. `
        + "A bot starts workers only in its own project.");
    }
    if (defining.length > 1) {
      throw new CliError(`${address} plays bot ${botId}, which ${defining.length} projects define: ${defining.map((f) => f.key).join(", ")}. `
        + "Pick its project with --project <folder>.");
    }
    if (!defining.length) {
      throw new CliError(`${address} plays bot ${botId}, which no project here defines (looked in ${looked.join(", ") || "none"}). `
        + "A bot starts workers only in its own project.");
    }
    hit = defining[0];
  }
  if (hit.bot.planned) throw new CliError(`${hit.bot.name} is planned; a planned bot starts no workers.`);
  return { me: { ...me, address }, bot: hit.bot, project: hit.project };
}

/**
 * Why a pane the attach ledger ties no bot to can't start workers. A pane still carrying a
 * `bot` label from before the ledger (its one-time import found no project defining that bot
 * from the pane's folder, or ran before) is told how to tie it: attach, from its project; a
 * Claude session outside the project can't be attached (attachRefusal), so start it there.
 */
async function unboundRefusal(me, address) {
  const base = `${address} isn't a bot's pane (the attach ledger ties no bot to it).`;
  const labelled = me.labels?.[BOT_LABEL];
  if (typeof labelled !== "string" || !labelled) return `${base} Only a bot starts workers.`;
  const { found } = await projectsDefining(labelled, await botProjectHints(me, address));
  const key = found.length === 1 ? found[0].key : "<its project>";
  return `${base} Its ${BOT_LABEL}=${labelled} label is from before the ledger, which no longer reads labels. `
    + `Tie it: am attach ${labelled} ${address} --project ${key}. A Claude session must run in that project to be `
    + `attached; if it doesn't, start the bot there: am start ${labelled} --project ${key}.`;
}

const realDir = (p) => { try { return realpathSync(p); } catch { return null; } };
/** A path as the file system spells it (realpathSync.native: on a case-insensitive disk, the folder's own case). */
const nativeDir = (p) => { try { return realpathSync.native(p); } catch { return null; } };

/** --worktree: an existing worktree of the bot's project, not its main checkout, on a branch. */
async function givenWorktree(path, key, bot) {
  const dir = realDir(resolvePath(path));
  let isDir = false;
  try { isDir = Boolean(dir) && statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) throw new CliError(`--worktree: ${resolvePath(path)} is not a folder.`, 2);
  const top = (await git(["rev-parse", "--show-toplevel"], dir))?.trim();
  if (!top) throw new CliError(`--worktree: ${dir} isn't in a git worktree.`);
  const owner = (await projectOf(top, git, exists)).key;
  if (owner !== key) throw new CliError(`${top} is a worktree of ${owner}, not of ${bot.name}'s project ${key}. A bot starts workers only in its own project.`);
  if (top === key) throw new CliError(`${top} is the project's main checkout; a worker works in a task worktree (--branch makes one).`);
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], top))?.trim();
  if (!branch) throw new CliError(`${top} has no branch checked out (a detached HEAD); a worker's task is its branch.`);
  return { worktree: top, branch, created: false, base: null };
}

/**
 * --branch: the worktree already on that branch, or the folder a new one gets,
 * `<main checkout>/.claude/worktrees/<slug>`, as { pending: true } (makeBranchWorktree makes
 * it). Makes nothing: every refusal here comes before the worktree, the hook or hc run.
 */
async function branchPlace(branch, base, key, warnings) {
  const ok = !branch.startsWith("-") && (await runProgram("git", ["check-ref-format", "--branch", branch], { cwd: key })).code === 0;
  if (!ok) throw new CliError(`--branch: "${branch}" isn't a valid branch name.`, 2);
  const listed = await git(["worktree", "list", "--porcelain"], key);
  if (listed === null) throw new CliError(`${key} isn't a git project, so there is no worktree for --branch; pass --worktree.`);
  const hit = parseWorktrees(listed).find((w) => w.branch === branch);
  if (hit) {
    if (realDir(hit.path) === key) throw new CliError(`${branch} is checked out in the main checkout ${key}; a worker never works there. Pass --worktree, or use another branch.`);
    if (base) warnings.push(`${branch} has a worktree already, so --base ${base} was not used.`);
    return { worktree: realDir(hit.path) ?? hit.path, branch, created: false, base: null };
  }
  const path = worktreeFolder(key, branch);
  const same = parseWorktrees(listed).find((w) => (realDir(w.path) ?? w.path) === (realDir(path) ?? path));
  if (same) {
    throw new CliError(`Branch ${branch} uses the same folder as branch ${same.branch ?? "(a detached HEAD)"}: ${path}. `
      + "Pick another branch name, or pass --worktree to work in that one.");
  }
  if (existsSync(path)) throw new CliError(`${path} is there already, but not as a worktree on ${branch}. Move it, or pass --worktree.`);
  return { worktree: path, branch, created: false, base: null, pending: true };
}

/**
 * Makes branchPlace's pending worktree (`place.worktree`, on `place.branch`). A new branch
 * starts from --base, else origin's own branch of that name, else origin/HEAD's branch, else
 * dev, else main, after a fetch. Only `git worktree add` runs: the main checkout's HEAD is
 * never touched. The new branch tracks nothing unless it continues origin's branch of the same name.
 */
async function makeBranchWorktree(place, base, key, warnings) {
  const { worktree: path, branch } = place;
  const unexcluded = await excludeWorktrees(key);
  if (unexcluded) warnings.push(unexcluded);
  const has = async (ref) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], key)) !== null;
  let args;
  let from = null;
  if (await has(`refs/heads/${branch}`)) {
    if (base) warnings.push(`${branch} exists already, so --base ${base} was not used.`);
    args = ["worktree", "add", path, branch];
  } else {
    if ((await git(["remote"], key))?.split("\n").includes("origin")) {
      const f = await runProgram("git", ["fetch", "--quiet", "origin"], { cwd: key, timeout: 60_000 });
      if (f.code !== 0) warnings.push(`git fetch origin failed, so the base may be behind: ${(f.stderr || f.stdout).trim().split("\n")[0]}`);
    }
    const originHead = (await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], key))?.trim() || null;
    const candidates = base ? [base] : [`origin/${branch}`, ...baseCandidates(null, originHead)];
    for (const ref of candidates) if (await has(ref)) { from = ref; break; }
    if (!from) throw new CliError(base ? `--base: ${base} isn't a commit in ${key}.` : `${key} has no origin/HEAD, dev or main to start ${branch} from; pass --base.`);
    // Only origin's own branch of that name becomes the upstream. Any other start (origin/dev)
    // would, by git's branch.autoSetupMerge, make a plain `git pull` merge it and a plain
    // `git push` (push.default=upstream) push to it; the worker's first push sets its own.
    const track = from === `origin/${branch}` ? "--track" : "--no-track";
    args = ["worktree", "add", track, "-b", branch, path, from];
  }
  const r = await runProgram("git", args, { cwd: key, timeout: 60_000 });
  if (r.code !== 0) throw new CliError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return { worktree: realDir(path) ?? path, branch, created: true, base: from };
}

/** `path` is still a folder and one of `key`'s worktrees (git worktree list); false when git can't say. */
async function stillWorktree(path, key) {
  const real = realDir(path);
  if (!real || !isDir(real)) return false;
  const listed = await git(["worktree", "list", "--porcelain"], key);
  return listed !== null && parseWorktrees(listed).some((w) => (realDir(w.path) ?? w.path) === real);
}

/**
 * Keeps the task worktrees out of the main checkout's `git add -A`: WORKTREES_EXCLUDE in the
 * clone's own exclude file, as the briefing hook's settings file is. A warning, or null.
 */
async function excludeWorktrees(key) {
  let path = null;
  try {
    path = (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], key))?.trim() || null;
    if (!path) throw new Error("git gave no exclude path");
    const before = readText(path);
    const after = withExclude(before, WORKTREES_EXCLUDE);
    if (after === null) return null;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await hookIo.write(path, after, before);
    return null;
  } catch (e) {
    return `Couldn't add ${WORKTREES_EXCLUDE} to ${path ?? "the git exclude file"} (${e?.message ?? e}); keep .claude/worktrees out of the main checkout's commits.`;
  }
}

/**
 * WORKER_LOCK_WAIT from AUTOMAGIK_HERDR_WORKER_WAIT_MS (`raw`), for the tests only: 75 s when
 * unset or not a number, else clamped to 100 ms..75 s, so it never lengthens a real call's wait.
 */
export function workerWait(raw) {
  const ms = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(ms) ? Math.min(75_000, Math.max(100, ms)) : 75_000;
}
/**
 * How long a worker call waits for its locks in all (saying so after LOCK_NOTE_AFTER): a task's
 * name lock, then its worktree's, from one deadline. On the common path a call that waited stays
 * under a bot shell tool's 120 s limit: 75 s, then hc ls (15 s), the worker check's hc gets
 * (WORKER_GET_TIMEOUT, at once) and hc run (15 s). That is not a bound: more rows than one batch
 * of gets, the git calls under the lock (15 s each), a fetch and git worktree add (60 s each)
 * when the waiter makes the worktree itself, and pidOf and the tab setup after it can each run to
 * their own timeouts. A hold that outlasts the wait refuses the waiting call, with the holder
 * named, and nothing made.
 */
const WORKER_LOCK_WAIT = workerWait(process.env.AUTOMAGIK_HERDR_WORKER_WAIT_MS);
/** How long the worker check waits for each `hc get` of a live terminal in the worktree. */
const WORKER_GET_TIMEOUT = 5000;
/**
 * The lock a worker's check and start run under: one per worktree, named by a hash of the
 * worktree's real path, in `lockDir`. Local: it orders the CLIs on this computer only.
 */
export function worktreeLock(lockDir, worktree) {
  const real = nativeDir(worktree) ?? resolvePath(worktree);
  return `${lockDir}/worktree-${createHash("sha256").update(real).digest("hex").slice(0, 16)}.lock`;
}
/**
 * The lock a task's worker takes before its worktree's (#538): one per terminal name
 * (`<id>-<role>`), in `lockDir`. Two calls for one task on two branches take two worktree
 * locks, so without it both pass the name check before either hc run, and the second makes its
 * worktree and hook before hc refuses the name. Always taken first, never while a worktree lock
 * is held, so the two never wait on each other.
 */
export function taskLock(lockDir, name) {
  return `${lockDir}/task-${createHash("sha256").update(name).digest("hex").slice(0, 16)}.lock`;
}

/**
 * The live workers in `worktree` (a real path), of any bot: from `ls` (`hc ls`), the live
 * terminals on this computer whose cwd is that folder as a real path and that carry a
 * worker.of label, as { address, labels }. Labels come from the row, else from `hc get`, all
 * at once, each within WORKER_GET_TIMEOUT. A terminal hc says is gone is left out; one hc
 * doesn't answer for is refused (fails closed): it may be a writer.
 * Workers on other machines aren't seen (their cwd isn't a folder here).
 */
async function workersIn(worktree, ls) {
  const here = nativeDir(worktree) ?? worktree;
  const rows = rowsOf(ls).filter((r) => {
    if (!local(r?.address) || (r.state !== undefined && r.state !== "live") || typeof r.cwd !== "string") return false;
    const cwd = r.cwd.startsWith("~/") ? `${home()}${r.cwd.slice(1)}` : r.cwd;
    return (nativeDir(cwd) ?? cwd) === here;
  });
  const found = await Promise.all(rows.map(async (r) => {
    if (r.labels && typeof r.labels === "object") return { address: r.address, labels: r.labels };
    try {
      return { address: r.address, labels: (await hcLookup(r.address, { timeout: WORKER_GET_TIMEOUT }))?.labels };
    } catch (e) {
      throw new CliError(`${r.address} is live in ${worktree}, but whether it's a worker can't be told: ${e?.message ?? e}. Not started. `
        + `Try again, or check it with hc get ${r.address}.`);
    }
  }));
  return found.filter((w) => w.labels?.[WORKER_OF_LABEL]);
}

/** What `hc templates --json` lists: { list: [{ name, command }], why }; list null when it gives none. */
async function hcTemplates() {
  const r = await hc(["templates", "--json"]);
  let list = null;
  try { list = r.code === 0 ? JSON.parse(r.stdout).templates : null; } catch { list = null; }
  return { list: Array.isArray(list) ? list : null, why: (r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}` };
}

/**
 * The agent an hc template runs, from its command in `hc templates`: { runs: an agent key, or
 * undefined when no known agent is in the command; command: that command }. A template hc doesn't list, or no list at
 * all, is refused here, before any worktree is made: `hc run` runs an unlisted name as a
 * program (`--template rm` would run rm).
 */
async function templateRuns(template, agents) {
  const { list, why } = await hcTemplates();
  if (!list) {
    throw new CliError(`hc templates gave no list (${why}), `
      + `so ${template} can't be checked as a template; hc run would start an unlisted name as a program. Not started.`);
  }
  const hit = list.find((x) => x?.name === template);
  if (!hit) {
    const names = list.map((x) => x?.name).filter(Boolean);
    throw new CliError(`hc has no template ${template}${names.length ? `. Its templates: ${names.join(", ")}` : ""}.`);
  }
  return { runs: templateAgent(hit.command, agents) ?? undefined, command: typeof hit.command === "string" ? hit.command : null };
}

/** The template name hc gave the pane, or the label a restart leaves on it (#1418). */
function paneTemplateName(get) {
  const own = typeof get?.template === "string" && get.template.trim() ? get.template.trim() : null;
  const labeled = get?.labels?.[WORKER_TEMPLATE_LABEL];
  return own ?? (typeof labeled === "string" && labeled.trim() ? labeled.trim() : null);
}

/**
 * The hc template an old pane was started from: `get.template`, else the worker.template label a
 * Restart through a template leaves on its new pane (so the next restart finds it again), with
 * the template's CURRENT command when hc still lists it: { name, command }. { name } when hc
 * doesn't list it (or gives no list): the restart falls back to the agent row, and its line
 * names the template (#597 review F1). Null when the pane names none.
 */
async function paneTemplate(get) {
  const name = paneTemplateName(get);
  if (!name) return null;
  const { list } = await hcTemplates();
  const hit = list?.find((x) => x?.name === name);
  const command = typeof hit?.command === "string" && hit.command.trim() ? hit.command : null;
  return command ? { name, command } : { name };
}

/**
 * Planned swaps: whether bot `botId`'s task `taskId` in project `key` runs the bot's other
 * arm (worker.swap). The first byte of sha256(`${botId}:${key}:${taskId}`), mod 3, is 0:
 * about one task in three, the same answer for every worker of that bot on that task.
 */
export const swapTask = (botId, key, taskId) => swapByte(createHash("sha256").update(`${botId}:${key}:${taskId}`).digest()[0]);

/**
 * The commit a worker's worktree started from: the base ref this command made it from, as a
 * SHA; else the branch's oldest reflog entry (where it was created here: Genie's worktree
 * from a fresh-fetched base); null when git keeps neither.
 */
async function baseCommit(place, key) {
  if (place.created && place.base) {
    const sha = (await git(["rev-parse", "--verify", "--quiet", `${place.base}^{commit}`], key))?.trim();
    if (sha) return sha;
  }
  const log = await git(["reflog", "show", "--format=%H", `refs/heads/${place.branch}`], key);
  return log?.trim().split("\n").filter(Boolean).at(-1) ?? null;
}

/**
 * A new worker's tab, once the window shows its pane (`terminal`): renamed `name` and moved
 * after the tab of its bot's pane (`botTerminal`) when both are in one space (workerTab.js
 * tabSteps, the setup a sidebar click gives a worker). Never focused: the person's focus
 * stays where it is. Null, or a warning when the pane didn't show in time or a step failed.
 */
async function workerTabSetup(terminal, botTerminal, name) {
  const shown = await windowShows(terminal);
  if (!shown) return `Herdr hadn't shown ${terminal} after ${TAB_WAIT_MS / 1000}s, so its tab isn't named or moved beside its bot's.`;
  const space = shown.spaces.find((s) => !s.machine && s.tabs.some((t) => t.terminals.includes(botTerminal)));
  const botTab = space?.tabs.find((t) => t.terminals.includes(botTerminal)) ?? null;
  const steps = tabSteps({ space: space?.id ?? null, tab: botTab?.id ?? null, name }, { tab: shown.tab.id }, shown.spaces);
  for (const [command, args] of steps) {
    const why = await windowDo(command, args);
    if (why) return `${terminal}'s tab: ${command} failed: ${why}`;
  }
  return null;
}

// ---- worktree cleanup (#567) ----

/** A worker call's sweep removes at most this many worktrees, and starts no new check after this long. */
const REAP_MAX = 5;
const REAP_BUDGET_MS = 20_000;
/** How long the sweep waits for gh's list of a branch's pull requests. */
const GH_TIMEOUT = 5000;
/**
 * How long one git worktree remove may take (a large tree). Not cut to the budget left: a remove
 * stopped halfway leaves a half-deleted tree, which then reads as uncommitted changes. So a worker
 * call's sweep usually takes up to about REAP_BUDGET_MS, and at worst one check's program calls
 * (15 s each, gh 5 s) and one remove (this) past it.
 */
const REMOVE_TIMEOUT = 120_000;
/**
 * How long ago every terminal of a candidate must have finished (hc's finished_ms) before it is
 * looked at. Restart --tree ends a bot's workers with its old pane and runs them again in the
 * same worktrees, without the worktree lock, one at a time once the new pane is up (about 1 min
 * at worst: hc run, agentUp's 30 s and a get). Each helper takes at worst about 2 min (helperEnded's
 * get, hc ls, hc run, agentUp's 30 s plus a get, a kill, pidOf: 15 s calls), so the k-th is run
 * again at worst about 1 + 2k min after it ended: 15 min covers 7 helpers at their worst (a
 * short-limit Herdr caps --tree at 2). Longer only costs disk while it waits.
 */
const REAP_SETTLE_MS = 15 * 60_000;
/** A worker call's sweep skips a kept worktree whose reason hasn't changed in this long (reap still checks it). */
const REAP_QUIET_MS = 24 * 60 * 60 * 1000;

/** The cleanup file's rows ([] when it can't be read). */
function reapRows() {
  try { return readLedger(readText(reapPath(appHome())) ?? ""); } catch { return []; }
}
/** Appends a cleanup row; a warning, or null. */
function appendReap(row) {
  const path = reapPath(appHome());
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a", 0o600);
    try { writeSync(fd, ledgerLine(row)); } finally { closeSync(fd); }
    return null;
  } catch (e) {
    return `couldn't record the cleanup of ${row.worktree} in ${path}: ${e?.message ?? e}`;
  }
}
/** hc's terminals from `hc ls [--all] --json`, or null when hc failed or printed no list. */
async function hcTerminals(all) {
  const r = await hc(["ls", ...(all ? ["--all"] : []), "--json"]);
  if (r.code !== 0) return null;
  try { const list = JSON.parse(r.stdout)?.terminals; return Array.isArray(list) ? list : null; } catch { return null; }
}
/** The local terminals among `terms` that haven't finished and whose cwd is `dir` or inside it (both as the disk spells them). */
function liveIn(terms, dir) {
  const here = nativeDir(dir) ?? dir;
  return terms.filter((t) => {
    if (!local(t?.address) || t.state === "finished" || typeof t.cwd !== "string") return false;
    const cwd = t.cwd.startsWith("~/") ? `${home()}${t.cwd.slice(1)}` : t.cwd;
    const real = nativeDir(cwd) ?? cwd;
    return real === here || real.startsWith(`${here}/`);
  });
}
/**
 * Whether every terminal in `names` that `terms` (hc ls --all) still lists finished at least
 * REAP_SETTLE_MS ago, by hc get's finished_ms. One hc no longer has counts as settled; one hc
 * can't date doesn't (fails closed). Each answer hc gave is kept in `gets` by address, for the
 * sweep's end rows.
 */
async function settled(names, terms, gets = new Map()) {
  const listed = names.filter((t) => terms.some((x) => x?.address === t));
  const ends = await Promise.all(listed.map(async (t) => {
    const r = await hc(["get", t, "--json"]);
    if (r.code !== 0) return r.code === 3 || /not_found/.test(r.stderr ?? "") ? 0 : null;
    try {
      const get = JSON.parse(r.stdout);
      if (get && typeof get === "object") gets.set(t, get);
      const ms = get?.finished_ms;
      return Number.isSafeInteger(ms) ? ms : null;
    } catch { return null; }
  }));
  return ends.every((ms) => ms !== null && Date.now() - ms >= REAP_SETTLE_MS);
}
const firstLine = (r) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n")[0];

/** The forge tool a project's remote names, or the one installed (gh first) when the host is unknown. */
const forgeByProject = new Map();
async function forgeOn(cwd) {
  const project = resolvePath(cwd);
  if (forgeByProject.has(project)) return forgeByProject.get(project);
  const remote = (await git(["remote", "get-url", "origin"], project))?.trim()
    || (await git(["remote", "get-url", "upstream"], project))?.trim() || null;
  const named = forgeOf(remote);
  // A named forge is never swapped for the other tool: a GitLab host asked of gh is no answer.
  // An unknown remote host prefers glab (the non-GitHub forge); a local path or no remote prefers
  // gh, so a plain repository keeps the tool it always used.
  const tool = named ?? (forgeHost(remote)
    ? (programPath("glab") ? "glab" : programPath("gh") ? "gh" : null)
    : (programPath("gh") ? "gh" : programPath("glab") ? "glab" : null));
  forgeByProject.set(project, tool);
  return tool;
}

/** The states both forges' list calls use, as the cleanup and its rows read them (gh's words). */
const FORGE_STATES = { open: "OPEN", opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "OPEN" };

/** One of gh's or glab's pull request objects as the cleanup and a `pr` row read it, or null. */
function normalizedPr(item) {
  const state = FORGE_STATES[String(item?.state ?? "").toLowerCase()] ?? null;
  const number = Number.isSafeInteger(item?.number) ? item.number
    : Number.isSafeInteger(item?.iid) ? item.iid : null;
  if (!state || !number) return null;
  return { number, state, createdAt: item.createdAt ?? item.created_at ?? null,
    mergedAt: item.mergedAt ?? item.merged_at ?? null, closedAt: item.closedAt ?? item.closed_at ?? null,
    baseRefName: item.baseRefName ?? item.target_branch ?? null,
    headRefOid: item.headRefOid ?? item.sha ?? item.diff_refs?.head_sha ?? null };
}

/**
 * The branch's pull requests as the project's forge lists them ([{ number, state, createdAt,
 * mergedAt, closedAt, baseRefName, headRefOid }]), or null when that forge is missing or fails.
 * The remote's host picks the tool (#1278 cause 3): gh for GitHub, glab for GitLab, never one
 * asked for the other. Only what the cleanup's check and a `pr` row need is asked for: never a
 * title, an author, a text or an address.
 */
async function pullRequestsOf(branch, cwd, { cleanup = false, forge = null } = {}) {
  const tool = forge ?? await forgeOn(cwd);
  if (!tool || !branch || !programPath(tool)) return null;
  if (tool === "glab") {
    const r = await runProgram(programPath("glab"),
      ["mr", "list", "--source-branch", branch, "--all", "--output", "json"],
      { cwd, timeout: GH_TIMEOUT });
    if (r.code !== 0) return null;
    try {
      const list = JSON.parse(r.stdout);
      return Array.isArray(list) ? list.map(normalizedPr).filter(Boolean) : null;
    } catch { return null; }
  }
  const fields = "number,state,createdAt,mergedAt,closedAt,baseRefName"
    + (cleanup ? ",headRefOid" : "");
  const r = await runProgram(programPath("gh"),
    ["pr", "list", "--head", branch, "--state", "all", "--json", fields, "--limit", "20"],
    { cwd, timeout: GH_TIMEOUT });
  if (r.code !== 0) return null;
  try { const list = JSON.parse(r.stdout); return Array.isArray(list) ? list.map(normalizedPr).filter(Boolean) : null; } catch { return null; }
}

// ---- pull requests (#899): the sweep's `pr` rows ----

/** A worker call's sweep asks gh for at most this many branches' pull requests; reap asks for every one that is due. */
const PR_ASK_MAX = 3;

/**
 * The branches of `project` git shows a push of: one a remote has a branch of the same name
 * for (its remote-tracking ref, kept until a prune), or whose upstream is a branch of its own
 * name (git push -u, gh pr create; kept as long as the branch). A Set, or null when git can't
 * say. A branch made from origin's dev has dev as its upstream: that is no push of it.
 */
async function pushedBranches(project) {
  const refs = await git(["for-each-ref", "--format=%(refname)%09%(upstream)", "refs/heads", "refs/remotes"], project);
  if (refs === null) return null;
  const tracked = (ref) => /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref ?? "")?.[1] ?? null;
  const out = new Set();
  for (const line of refs.split("\n")) {
    const [ref, upstream] = line.split("\t");
    const there = tracked(ref);
    if (there) out.add(there);
    if (ref.startsWith("refs/heads/") && tracked(upstream) === ref.slice(11)) out.add(ref.slice(11));
  }
  return out;
}

/**
 * The author date of `branch`'s first commit in `project` (git's ISO text), or null when git
 * can't tell: the oldest commit on the branch that is neither in `base` (the commit the
 * worker's worktree started from, from its start row) nor on the branch its pull request
 * targets as origin has it (`target`: a rebase on that branch, or a merge of it, brings its
 * commits in, and they are not the worker's). Null when git knows neither commit, when the
 * branch is gone, and when every commit of it is on the target now (a merge that kept them):
 * the sweep then keeps what an earlier row recorded.
 */
async function firstCommitAt(project, branch, base, target) {
  const not = [];
  for (const ref of [/^[0-9a-f]{7,64}$/.test(base ?? "") ? base : null, target ? `refs/remotes/origin/${target}` : null]) {
    if (ref && await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], project)) not.push(ref);
  }
  if (!not.length) return null;
  const log = await git(["log", "--reverse", "--format=%aI", `refs/heads/${branch}`, "--not", ...not], project);
  return log?.split("\n").find(Boolean) ?? null;
}

/**
 * The sweep's `pr` rows (#899, workers.js): asks gh for the pull requests of the worker
 * branches the ledger still follows (prBranches) and appends a row for each one that is new or
 * whose state or times changed. `asked`: what gh already answered in this sweep, by branch
 * (reapOne's check of a worktree with commits on no remote): used as it is, for any worker
 * branch, with no second call. Any other branch is asked only when it is due (prAskDue; a
 * branch git shows no push of, rarely), the likely ones first; `every` (reap) also asks for
 * each likely one now. A worker call asks at most PR_ASK_MAX times, and nothing is asked once
 * `budget` ms have passed since `start`. When each branch was asked is kept in the app home
 * (pr-checks.json), so a later sweep goes on with the next ones. gh missing: nothing is done.
 * Says nothing unless a row couldn't be written.
 */
async function recordPullRequests({ asked, start, budget, every, lines }) {
  const rows = workerLedgerRows();
  const now = Date.now();
  const branches = prBranches(rows, now);
  const file = prChecksPath(appHome());
  let checked = new Map();
  try { checked = readPrChecks(readText(file) ?? ""); } catch { /* asked again: nothing is lost */ }
  const pushedIn = new Map();
  const due = [];
  for (const w of branches) {
    const key = prBranchKey(w);
    if (asked.has(key)) { due.push({ w, key, rank: 0, at: 0 }); continue; }
    if (!w.followed || !isDir(w.project)) continue;
    // Whether it was pushed only matters for a branch with no pull request recorded yet.
    if (!w.recorded && !pushedIn.has(w.project)) pushedIn.set(w.project, await pushedBranches(w.project));
    const pushed = !w.recorded && (pushedIn.get(w.project)?.has(w.branch) ?? false);
    const at = prAskDue(w, { pushed, checked: checked.get(key) ?? null, now });
    if (at <= now || (every && prLikely(w, pushed))) due.push({ w, key, rank: prLikely(w, pushed) ? 1 : 2, at });
  }
  if (!due.length) return;
  due.sort((a, b) => a.rank - b.rank || a.at - b.at);
  const core = await rowCore();
  let calls = 0;
  for (const { w, key } of due) {
    let list = asked.get(key) ?? null;
    if (!asked.has(key)) {
      if ((!every && calls >= PR_ASK_MAX) || Date.now() - start > budget) break;
      calls += 1;
      list = await pullRequestsOf(w.branch, w.project);
    }
    // A failed answer counts as asked too: a gh that is signed out isn't run again by every call.
    checked.set(key, Date.now());
    if (!list?.length) continue;
    const firsts = new Map();
    const found = [];
    for (const item of list) {
      const target = typeof item?.baseRefName === "string" ? item.baseRefName : "";
      if (!firsts.has(target)) firsts.set(target, await firstCommitAt(w.project, w.branch, w.base, target));
      found.push({ ...item, firstCommitAt: firsts.get(target) });
    }
    for (const row of prRowsFor({ project: w.project, branch: w.branch, task: w.task, list: found, rows, core })) {
      const unlogged = appendLedger(row);
      if (unlogged) lines.push(unlogged);
    }
  }
  // Written in place, under the sweep's lock (one writer): a write cut short reads as no file,
  // and the same branches are then asked again sooner. Nothing is lost.
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, prChecksText(checked, branches.filter((w) => w.followed)), { mode: 0o600 });
  } catch { /* asked again sooner */ }
}

/** A canonical repository identity, never a walk-up guess for missing or relative ownership. */
async function reapRepository(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !isDir(path)) return null;
  const common = (await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"], path))?.trim();
  return common ? nativeDir(common) : null;
}

/** Canonicalize ledger owners for conflict detection without changing the stored rows. */
async function ownedReapCandidates(rows) {
  const projects = [...new Set(rows.filter((r) => r?.event === "start").map((r) => r.project))];
  const owners = new Map(await Promise.all(projects
    .map(async (p) => [p, await reapRepository(p)])));
  return { owners, candidates: reapCandidates(rows, reapRows(), (p) => owners.get(p) ?? null) };
}

/** Ledger owner, launching scope and the actual checkout must all name one repository. */
async function reapOwnership(c, project = null) {
  const owner = await reapRepository(c.project);
  if (!owner) return "workers ledger has no unambiguous repository owner";
  if (project !== null && await reapRepository(project) !== owner) {
    return "worktree belongs to another launching repository";
  }
  if (await reapRepository(c.worktree) !== owner) {
    return "can't verify worktree repository ownership";
  }
  const listed = await git(["worktree", "list", "--porcelain"], c.project);
  const real = nativeDir(c.worktree);
  if (listed === null || !real || !parseWorktrees(listed).some((w) => nativeDir(w.path) === real)) {
    return "worktree is not registered in its recorded repository";
  }
  return null;
}

/** A path's spelling without trailing slashes: a missing checkout is compared as recorded. */
const withoutTrailingSlash = (p) => String(p ?? "").replace(/\/+$/, "");

/**
 * A candidate whose checkout is missing, as a cleanup outcome: "gone" once its recorded
 * repository's `git worktree list` no longer names it (#1143), so the cleanup file stops
 * carrying it as kept forever. Null in every other case: no unambiguous owner, an unreadable
 * repository, or a registration still there (a folder removed by hand keeps its record; only
 * `git worktree prune` or `remove` may drop it, never this cleanup). Reads git's list only:
 * no remove, no prune.
 */
async function goneCheckout(c) {
  if (!c.project) return null;
  const listed = await git(["worktree", "list", "--porcelain"], c.project);
  if (listed === null) return null;
  return parseWorktrees(listed).some((w) => withoutTrailingSlash(w.path) === withoutTrailingSlash(c.worktree))
    ? null : { result: "gone", why: null };
}

/**
 * The paths git lists as ignored under `dir` (`!! ` lines), for the cleanup to name before it
 * removes a clean checkout that holds them (#1143), or null when git can't say.
 */
async function ignoredPaths(dir) {
  const r = await runProgram("git", ["status", "--porcelain", "--ignored", "--untracked-files=normal"], { cwd: dir });
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
}

/**
 * One candidate, under its worktree's lock: checked for ownership, live terminals and work,
 * then rechecked after preservation proof. git worktree remove (no --force) also removes
 * its registration; no broad prune. Any unreadable proof keeps it. `asked` caches gh's answer
 * for the sweep's separate PR rows. Returns waiting, kept, failed or removed.
 */
async function reapOne(c, asked = new Map(), project = null) {
  const path = c.worktree;
  const forge = await forgeOn(c.project);
  const ownership = await reapOwnership(c, project);
  if (ownership) return { result: "kept", why: ownership };
  const ownerAtStart = await reapRepository(c.project);
  const realAtStart = nativeDir(path);
  const now = await hcTerminals(false);
  if (!now) return { result: "waiting" };
  if (liveIn(now, path).length) return { result: "waiting" };
  const main = c.project;
  const head = (await git(["rev-parse", "--verify", "HEAD"], path))?.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head ?? "")) return { result: "kept", why: "can't read HEAD" };
  const status = await runProgram("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: path });
  if (status.code !== 0) return { result: "kept", why: `git status failed: ${firstLine(status)}` };
  const changes = status.stdout.split("\n").filter(Boolean).length;
  let unpushed = 0;
  let prs = null;
  let branch = null;
  if (!changes) {
    const count = await runProgram("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: path });
    unpushed = Number(count.stdout.trim());
    if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim())
      || !Number.isSafeInteger(unpushed)) {
      return { result: "kept", why: `git rev-list failed: ${firstLine(count)}` };
    }
    branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], path))?.trim() || null;
    if (unpushed > 0 && branch && branch === c.branch) {
      prs = await pullRequestsOf(branch, main, { cleanup: true, forge });
      if (c.project) asked.set(prBranchKey({ project: c.project, branch }), prs);
    }
  }
  const why = workLeft({ changes, unpushed, prs, head, branch, expected: c.branch, forge: forge ?? "gh" });
  if (why) return { result: "kept", why };
  // Re-read the ledger and repository after proof: a newer owner, commit or branch
  // must not inherit the earlier snapshot's permission to remove this checkout.
  const fresh = (await ownedReapCandidates(workerLedgerRows())).candidates
    .find((x) => x.worktree === path);
  if (!fresh || fresh.branch !== c.branch || !fresh.project
    || JSON.stringify(fresh.terminals) !== JSON.stringify(c.terminals)) {
    return { result: "kept", why: "workers ledger changed during cleanup" };
  }
  const finalOwner = await reapOwnership(fresh, project);
  if (finalOwner || !ownerAtStart || await reapRepository(fresh.project) !== ownerAtStart
    || nativeDir(path) !== realAtStart) {
    return { result: "kept", why: finalOwner ?? "repository owner changed during cleanup" };
  }
  const finalHead = (await git(["rev-parse", "--verify", "HEAD"], path))?.trim();
  const finalBranch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], path))?.trim();
  if (finalHead !== head || finalBranch !== branch) {
    return { result: "kept", why: "HEAD or branch changed during cleanup" };
  }
  const finalStatus = await git(["status", "--porcelain", "--untracked-files=normal"], path);
  if (finalStatus === null || finalStatus.trim()) {
    return { result: "kept",
      why: finalStatus === null ? "git status failed" : "uncommitted changes" };
  }
  const finalCount = (await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path))
    ?.trim();
  const finalProof = /^\d+$/.test(finalCount ?? "")
    ? workLeft({ changes: 0, unpushed: Number(finalCount), prs, head, branch, expected: c.branch, forge: forge ?? "gh" })
    : "can't prove HEAD is pushed or merged";
  if (finalProof) return { result: "kept", why: finalProof };
  // Looked at once more just before the remove: a pane started in it without the worktree lock
  // (a hand-made one, hc run) since the first look. No --force: git itself refuses a tree that
  // has gained changes since the status above.
  const last = await hcTerminals(false);
  if (!last || liveIn(last, path).length) return { result: "waiting" };
  // #1143: `git worktree remove` deletes git-ignored files too (build output, local env files).
  // Name them before the remove, so a cleanup that loses them is never silent; an unreadable
  // list keeps the checkout, because the sweep cannot say what it would remove.
  const ignored = await ignoredPaths(path);
  if (ignored === null) return { result: "kept", why: "can't list the files git ignores" };
  const rm = await runProgram("git", ["worktree", "remove", path], { cwd: main, timeout: REMOVE_TIMEOUT });
  if (rm.code !== 0) return { result: "failed", why: `git worktree remove failed: ${firstLine(rm)}` };
  const ignoredNote = ignored.length ? `git-ignored files removed too: ${ignored.slice(0, 5).join(", ")}`
    + `${ignored.length > 5 ? ` and ${ignored.length - 5} more` : ""}` : null;
  return { result: "removed", why: ignoredNote };
}

/** The newest pull request in a forge's list, by creation time and number, or null. */
function newestPr(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => (Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0)
    || (a.number ?? 0) - (b.number ?? 0)).at(-1);
}

/**
 * #1278 cause 1: end the terminals of finished workers whose branch's newest pull request is
 * merged or closed, and write their end row. A worker's turn is over (hc says not `working`)
 * and hc still lists it live; it is its bot's worker (`worker.of`, no `bot` label), its launch
 * key matches the start row, and the request closed at least REAP_SETTLE_MS ago, so a bot
 * still handling the merge is never cut off. A worker mid-turn is left alone. `every` (reap)
 * asks every worker; a worker call asks at most PR_ASK_MAX. Never throws into the sweep.
 */
async function endMergedWorkers({ terms, rows, every, start, budget, lines, out }) {
  const ended = new Set();
  let asked = 0;
  const starts = rows.filter((r) => r?.event === "start" && r.kind === "worker" && r.branch
    && typeof r.project === "string" && r.project && r.terminal && Number.isSafeInteger(r.created_ms))
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  for (const row of starts) {
    if (Date.now() - start > budget) break;
    if (!every && asked >= PR_ASK_MAX) break;
    const key = launchKey(row);
    if (!key || ended.has(key)) continue;
    const listed = terms.find((t) => t?.address === row.terminal);
    const listedState = typeof listed?.status === "string" ? listed.status : listed?.status?.state;
    if (!listed || listed.state === "finished" || listedState === "working" || listedState === "blocked") continue;
    let get = null;
    try {
      const r = await hc(["get", row.terminal, "--json"]);
      if (r.code === 0) get = JSON.parse(r.stdout);
    } catch { get = null; }
    if (!get || get.created_ms !== row.created_ms || get.state !== "live") continue;
    if (get.status?.state !== "idle" && get.status?.state !== "done") continue;
    if (get.labels?.bot || !get.labels?.[WORKER_OF_LABEL]) continue;
    const prs = await pullRequestsOf(row.branch, row.project, { cleanup: true });
    if (!every) asked += 1;
    const pr = newestPr(prs);
    if (!pr || (pr.state !== "MERGED" && pr.state !== "CLOSED")) continue;
    const closedAt = Date.parse(pr.state === "MERGED" ? pr.mergedAt : pr.closedAt);
    if (!Number.isSafeInteger(closedAt) || Date.now() - closedAt < REAP_SETTLE_MS) continue;
    let kill = null;
    try { kill = await hcKill(row.terminal); } catch (e) {
      lines.push(`couldn't end ${row.terminal}: ${e?.message ?? e}`);
      continue;
    }
    if (kill.code !== 0) {
      lines.push(`couldn't end ${row.terminal}: hc kill failed: ${firstLine(kill)}`);
      continue;
    }
    ended.add(key);
    const unlogged = appendEnd(endRow({ kind: "worker", terminal: row.terminal, core: row.core ?? await rowCore(),
      createdMs: row.created_ms, reason: "finished", hcReason: get.reason, exitCode: get.exit_code, signal: get.signal }));
    if (unlogged) lines.push(unlogged);
    out.ended.push(row.terminal);
    lines.push(`ended ${row.terminal}: its branch's pull request ${pr.state.toLowerCase()}`);
  }
}

/** A project's default branch name: origin's HEAD, else dev, main or master, else the checkout's. */
async function defaultBranchOf(project) {
  const head = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], project))?.trim();
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["dev", "main", "master"]) {
    if (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], project) !== null) return name;
  }
  return (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], project))?.trim() ?? null;
}

/** The ref a merged check uses for `name` in `project`: its local branch, else origin's, else HEAD. */
async function defaultRef(project, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    if (await git(["rev-parse", "--verify", "--quiet", ref], project) !== null) return ref;
  }
  return "HEAD";
}

/** The projects a sweep looks at: the launching one, else every project the ledger or list names. */
function knownProjects(ledger, project) {
  if (project !== null) return [project];
  const out = new Set();
  for (const r of ledger) {
    if (r?.event === "start" && typeof r.project === "string" && isDir(r.project)) out.add(r.project);
  }
  let remembered = [];
  try { remembered = listedProjects(readText(`${appHome()}/${PROJECTS_FILE}`) ?? ""); } catch { /* the ledger's projects stand */ }
  for (const key of remembered) if (isDir(key)) out.add(key);
  return [...out];
}

/**
 * #1278 cause 4: delete a local branch a worker made, merged into the project's default branch,
 * with no worktree and no live worker. Only a branch a start row says this pack created; the
 * merged check is `git merge-base --is-ancestor`, so an unmerged or diverged branch is kept. The
 * ref is deleted with `update-ref -d <ref> <sha>`, which refuses a branch that moved since the
 * check (never -D). A worker call takes at most BRANCH_MAX per project; reap takes every one.
 */
const BRANCH_MAX = 50;
async function sweepBranches({ ledger, terms, project, every, lines, out }) {
  const cap = every ? Infinity : BRANCH_MAX;
  const liveBranches = new Set(ledger.filter((r) => r?.event === "start" && r.branch
    && terms.some((t) => t?.address === r.terminal && t.state !== "finished")).map((r) => `${r.project}\n${r.branch}`));
  for (const key of knownProjects(ledger, project)) {
    const mine = ledger.filter((r) => r?.event === "start" && r.kind === "worker" && r.created === true
      && r.project === key && r.branch);
    if (!mine.length) continue;
    const branches = [...new Set(mine.map((r) => r.branch))];
    const defaultName = await defaultBranchOf(key);
    if (!defaultName) continue;
    const defRef = await defaultRef(key, defaultName);
    const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], key))?.trim() ?? null;
    const listed = await git(["worktree", "list", "--porcelain"], key);
    const checkedOut = new Set(listed === null ? [] : parseWorktrees(listed).map((w) => w.branch).filter(Boolean));
    let removed = 0;
    for (const branch of branches.sort()) {
      if (removed >= cap) break;
      if (!branch || branch === defaultName || branch === current) continue;
      if (checkedOut.has(branch) || liveBranches.has(`${key}\n${branch}`)) continue;
      const ref = `refs/heads/${branch}`;
      const sha = (await git(["rev-parse", "--verify", "--quiet", ref], key))?.trim();
      if (!sha) continue;
      if (await git(["merge-base", "--is-ancestor", ref, defRef], key) === null) continue;
      // A worktree made while this sweep ran, or a checkout moved onto it, is never broken:
      // both are read again just before the ref goes.
      const nowListed = await git(["worktree", "list", "--porcelain"], key);
      if (nowListed === null || parseWorktrees(nowListed).some((w) => w.branch === branch)) continue;
      const nowCurrent = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], key))?.trim();
      if (!nowCurrent || nowCurrent === branch) continue;
      const del = await runProgram("git", ["update-ref", "-d", ref, sha], { cwd: key });
      if (del.code !== 0) { lines.push(`couldn't remove branch ${branch}: ${firstLine(del)}`); continue; }
      removed += 1;
      out.branches.push(branch);
      lines.push(`removed branch ${branch}: merged into ${defaultName}`);
    }
  }
}

/**
 * #1278 cause 2: name every worktree of a known project that no worker start row created, so a
 * sweep either removes a worktree or says why it kept it. These are never removed: a review
 * worktree, a subagent's or a person's own is not proof the pack made it.
 */
async function listUnownedWorktrees({ ledger, project, candidates, lines, out }) {
  const accounted = new Set(candidates.map((c) => nativeDir(c.worktree) ?? c.worktree));
  for (const c of [...out.removed, ...out.gone]) accounted.add(nativeDir(c) ?? c);
  for (const key of knownProjects(ledger, project)) {
    const listed = await git(["worktree", "list", "--porcelain"], key);
    if (listed === null) continue;
    const main = nativeDir(key) ?? key;
    for (const w of parseWorktrees(listed)) {
      const real = nativeDir(w.path) ?? w.path;
      if (real === main || accounted.has(real) || !isDir(real)) continue;
      accounted.add(real);
      const why = "not created by a worker (no start row); left alone";
      out.unowned.push({ worktree: w.path, why });
      lines.push(`kept ${w.path}: ${why}`);
    }
  }
}

/**
 * The sweep (#567): every worktree a worker call made (reapCandidates) whose start rows'
 * terminals have all ended, finished or gone in `hc ls --all`, killed or done alike, and in
 * which no live local terminal works, is removed unless it holds work (reapOne), once those
 * terminals finished REAP_SETTLE_MS ago. Newest first. A worktree only given to a worker is never
 * a candidate. One sweep at a time (a held lock: none now); a worktree whose worker lock is held
 * is left for later. At most `max` removals, and no new check once `budget` ms have passed.
 * hc failing skips the sweep. Each new outcome is a row in the cleanup file and a line.
 * `every` (reap): a line for every kept or failed one, even unchanged; without it (a worker
 * call), a kept one whose reason hasn't changed in REAP_QUIET_MS is skipped.
 * #1278 adds three passes to that sweep: a finished worker's terminal is ended once its
 * branch's newest pull request merged or closed (endMergedWorkers), a local branch a worker
 * made and merged is deleted with no worktree left (sweepBranches), and with `every` (reap)
 * every worktree of a known project no worker row created is named and kept
 * (listUnownedWorktrees). The same sweep, under the same lock and budget, records the worker
 * branches' pull requests in the workers ledger (#899, recordPullRequests), whether or not a
 * worktree is left to remove. A missing checkout its repository no longer lists is recorded
 * gone (#1143), with no git write, and never looked at again. A removed one names the
 * git-ignored files it took with it.
 * Never throws: { removed, gone, kept, failed, ended, unowned, branches, waiting, more, lines }.
 */
async function reapWorktrees({ max = REAP_MAX, budget = REAP_BUDGET_MS,
  every = false, project = null } = {}) {
  const out = { removed: [], gone: [], kept: [], failed: [], ended: [], unowned: [], branches: [], waiting: 0, more: 0, lines: [] };
  try {
    const ledger = workerLedgerRows();
    const workers = ledger.filter((r) => r?.event === "start" && r.kind === "worker" && r.branch);
    const owned = await ownedReapCandidates(ledger);
    const launching = project !== null ? await reapRepository(project) : null;
    // Completion observation remains global. Only deletion eligibility is scoped
    // to the launching repository; explicit reap deliberately considers every repo.
    const candidates = owned.candidates;
    const eligible = new Set(project === null ? candidates : candidates.filter((c) =>
      launching && c.project && owned.owners.get(c.project) === launching));
    if (!candidates.length && !workers.length && !prBranches(ledger).some((w) => w.followed)) return out;
    const lockDir = dirname(ledgerPath(appHome()));
    mkdirSync(lockDir, { recursive: true });
    let token;
    const lock = `${lockDir}/worker-reap.lock`;
    try { token = await takeLockAsync(lock, 0); } catch { return out; }
    const stop = keepFresh(lock, token);
    try {
      const terms = (candidates.length || workers.length) ? await hcTerminals(true) : [];
      if (!terms) { out.lines.push("worktree cleanup skipped: hc ls --all failed"); return out; }
      const start = Date.now();
      // A finished worker's terminal, ended once its branch's pull request merged or closed (#1278).
      await endMergedWorkers({ terms, rows: ledger, every, start, budget, lines: out.lines, out });
      // The finished workers' terminals hc answered for: their end rows, after the loop.
      const gets = new Map();
      // What gh answered for a candidate's branch: its pull requests' rows, after the loop.
      const asked = new Map();
      for (const c of candidates) {
        const cleanup = eligible.has(c) && !(!every && c.last?.result === "kept"
          && Date.now() - Date.parse(c.last.at) > REAP_QUIET_MS);
        const live = c.terminals.some((t) => terms.some((x) =>
          x?.address === t && x.state !== "finished"));
        if (live) { if (cleanup) out.waiting += 1; continue; }
        if (Date.now() - start > budget) { if (cleanup) out.more += 1; continue; }
        // This read and the end rows it feeds do not authorize removal. Foreign,
        // unknown-owner and quiet candidates still get their completion observed.
        const ready = await settled(c.terminals, terms, gets);
        if (!cleanup) continue;
        if (out.removed.length >= max) { out.more += 1; continue; }
        const path = c.worktree;
        let done;
        if (!ready) {
          done = { result: "waiting" };
        } else if (!isDir(path)) {
          // A missing checkout cannot prove its actual repository. Keep its registration; a
          // repository-wide prune could remove unrelated records. A repository that no longer
          // lists it at all has forgotten it: said gone, never kept forever (#1143).
          done = await goneCheckout(c) ?? { result: "kept", why: "can't verify missing worktree repository ownership" };
        } else if (liveIn(terms, path).length) {
          done = { result: "waiting" };
        } else {
          try {
            done = await withLockAsync(worktreeLock(lockDir, path),
              () => reapOne(c, asked, project), { wait: 0 });
          } catch { done = { result: "waiting" }; }
        }
        if (done.result === "waiting") { out.waiting += 1; continue; }
        const changed = c.last?.result !== done.result || c.last?.why !== (done.why ?? null);
        if (changed) { const unrecorded = appendReap(reapRow({ worktree: path, ...done })); if (unrecorded) out.lines.push(unrecorded); }
        if (done.result === "removed") {
          out.removed.push(path);
          out.lines.push(`removed ${path}: its workers ended${done.why ? ` (${done.why})` : ""}`);
        }
        if (done.result === "gone") { out.gone.push(path); out.lines.push(`gone ${path}: its repository no longer lists it`); }
        if (done.result === "kept") out.kept.push({ worktree: path, why: done.why });
        if (done.result === "failed") out.failed.push({ worktree: path, why: done.why });
        if ((done.result === "kept" || done.result === "failed") && (changed || every)) {
          out.lines.push(`${done.result === "kept" ? "kept" : "couldn't remove"} ${path}: ${done.why}`);
        }
      }
      // RFC 0021 (f) 4: a worker launch the sweep found finished gets its end row, once.
      if (gets.size) {
        const core = await rowCore();
        for (const row of core ? finishedEnds(workerLedgerRows(), gets, core) : []) {
          const unlogged = appendLedger(row);
          if (unlogged) out.lines.push(unlogged);
        }
      }
      // #1278 causes 2 and 4: every worktree of a known project is seen (an uncreated one is
      // named, never removed), and a worker's merged branch with no worktree is deleted.
      if (every) await listUnownedWorktrees({ ledger, project, candidates, lines: out.lines, out });
      await sweepBranches({ ledger, terms, project, every, lines: out.lines, out });
      try { await recordPullRequests({ asked, start, budget, every, lines: out.lines }); } catch (e) {
        out.lines.push(`pull requests not recorded: ${e?.message ?? e}`);
      }
      if (out.more) out.lines.push(`${out.more} more finished ${out.more === 1 ? "worker's worktree" : "workers' worktrees"} left for the next cleanup (am reap)`);
    } finally { stop(); dropLock(lock, token); }
  } catch (e) {
    out.lines.push(`worktree cleanup failed: ${e?.message ?? e}`);
  }
  return out;
}

async function cmdReap(opts, rest) {
  if (rest.length) throw new CliError("reap takes no arguments.", 2);
  const r = await reapWorktrees({ max: Infinity, budget: Infinity, every: true });
  const { lines, ...out } = r;
  if (opts.json) { report(lines.filter((l) => !l.startsWith("removed ") && !l.startsWith("gone ")
    && !l.startsWith("kept ") && !l.startsWith("ended ") && !l.startsWith("couldn't remove "))); return out; }
  return lines.length ? lines.join("\n") : "No finished worker's worktree to remove.";
}

/**
 * `worker kill <pane>` (#955): ends one worker the calling bot started, and nothing else. The
 * caller is the bot the attach ledger binds this pane to (callingBot, from HC_TERMINAL_ID); the
 * target must carry that bot's `worker.of` label and be no bot's seat (workers.js
 * workerKillRefusal), and not mid-turn. `hc kill` itself is for a project's main bot only (the
 * hc guard and Antigravity's deny list refuse it to every other seat and to workers), so this is
 * how a lead ends a worker that has finished. On this computer only.
 */
async function cmdWorkerKill(opts, panes) {
  if (panes.length !== 1 || optionLike(panes[0])) throw new CliError("worker kill takes one terminal: am worker kill <pane>.", 2);
  const [pane] = panes;
  if (pane.includes("/")) throw new CliError(`worker kill ends a worker on this computer only; ${pane} names another machine. Nothing was ended.`);
  const { me, bot } = await callingBot(opts);
  const self = me.address ?? process.env.HC_TERMINAL_ID;
  const target = await hcGet(pane);
  const address = target ? (target.address ?? pane) : pane;
  const view = await attachView();
  const bound = target ? Boolean(view.byTerminal.get(address)?.binding?.bot) : false;
  const why = workerKillRefusal({ target: target ? { ...target, address } : null, botId: bot.id, self, bound });
  if (why) throw new CliError(`${why === "that isn't a terminal hc knows" ? `${pane} isn't a terminal hc knows` : why}. Nothing was ended.`);

  let current = target;
  if (!target.state || target.state === "live") {
    // Read the ledger again without importing, sweeping or locking it. The first view is cached.
    try {
      const { byKey } = foldAttach(readAttachFile(view.path) ?? []);
      const callerKey = attachKey(view.byTerminal.get(self).binding);
      const caller = byKey.get(callerKey);
      if (caller?.bot !== bot.id || addressOf(caller, view.machines) !== self) {
        throw new CliError(`The attach ledger no longer binds ${self} to ${bot.name}`);
      }
      if (byKey.has(attachKey({ core: view.core, terminal: address, created_ms: target.created_ms }))) {
        throw new CliError(`The attach ledger now binds ${address} to a bot`);
      }
      current = await hcGet(address);
    } catch (e) {
      throw new CliError(`Couldn't recheck ${address}: ${e?.message ?? e}. Nothing was ended.`);
    }
    if (!Number.isSafeInteger(target.created_ms) || current?.address !== address
        || current.created_ms !== target.created_ms || typeof current.state !== "string" || !current.state) {
      throw new CliError(`${address} could not be confirmed as the same terminal. Nothing was ended.`);
    }
    const changed = workerKillRefusal({ target: current, botId: bot.id, self });
    if (changed) throw new CliError(`${changed}. Nothing was ended.`);
  }
  if (current.state !== "live") {
    return opts.json ? { terminal: address, ended: false, state: current.state } : `${address} has already ended (${current.state}).`;
  }
  // The real hc (in a sandbox, the proxy's socket, which ends only the caller's own worker):
  // the pane's guard refuses a member's own `hc kill`, and this verb is the checked way around it.
  const r = await hcKill(address);
  if (r.code !== 0) throw new CliError(`hc kill ${address} failed: ${hcSaid((r.stderr || r.stdout).trim())}`);
  return opts.json ? { terminal: address, ended: true, branch: target.labels?.branch ?? null } : `${address} ended (${bot.name}'s worker${target.labels?.branch ? ` on ${target.labels.branch}` : ""}).`;
}

/** How long a worker that takes its task as a message may take to say it is ready, in seconds (hc wait's check-in). */
const FIRST_TASK_WAIT_S = 30;
/**
 * Sends `task` as the first message of the worker pane `address`, for an agent that takes no
 * first prompt on its command line (models.js promptByMessage: kimi, #1032). hc's own order for
 * a plain launch: wait until the agent is ready, then send (a send to a booting agent can be
 * dropped). The wait ends when the agent first reports idle; one that reports no status is
 * given FIRST_TASK_WAIT_S, and the send follows either way. hc refuses the send to a pane that
 * waits for an answer (a sign-in, a trust question) or has ended. `run`: hc or hcReal, the one
 * that started the pane. Never throws: null, or the warning when the task did not go in (the
 * pane is left as it is, to be read and sent to by hand).
 */
async function sendFirstTask(address, task, run) {
  let said;
  try {
    await run(["wait", address, "--timeout", String(FIRST_TASK_WAIT_S), "--json"], { timeout: (FIRST_TASK_WAIT_S + 10) * 1000 });
    const r = await run(["send", address, task]);
    if (r.code === 0) return null;
    said = hcSaid((r.stderr || r.stdout).trim()).split("\n")[0] || `exit ${r.code}`;
  } catch (e) { said = e?.message ?? String(e); }
  return `${address} started without its task (hc send: ${said}): this agent takes its task as its first message, and it was not sent. `
    + `Read the pane (hc read ${address}), answer what it asks, then send the task: hc send ${address} "<task>".`;
}

async function cmdWorker(opts, rest) {
  // `worker kill <pane>`: a task call always names --branch or --worktree, so the two never mix.
  if (rest[0] === "kill" && opts.branch === undefined && opts.worktree === undefined) return cmdWorkerKill(opts, rest.slice(1));
  const task = rest.join(" ").trim();
  if (!task) throw new CliError('worker needs the task text: am worker "<task>" --branch <name>.', 2);
  // #1278 cause 5: the worker is sent back with a clean worktree, so the sweep never has to
  // keep its worktree for uncommitted changes.
  const prompt = workerTaskText(task);
  if (optionLike(task)) throw new CliError("The task text can't start with a dash; the agent would read it as an option.", 2);
  if ((opts.branch === undefined) === (opts.worktree === undefined)) throw new CliError("Give --branch or --worktree (one of them).", 2);
  if (opts.base !== undefined && opts.branch === undefined) throw new CliError("--base goes with --branch.", 2);
  if (opts.template === "") throw new CliError("--template needs a name: --template <name> (hc templates lists them).", 2);
  if (opts.role !== undefined && !ROLES.includes(opts.role)) throw new CliError(`--role is one of ${ROLES.join(", ")}, not "${opts.role}".`, 2);
  const given = { template: opts.template, agent: opts.agent, model: opts.model, effort: opts.effort };
  const alongside = ["agent", "model", "effort"].filter((k) => given[k] !== undefined);
  if (given.template !== undefined && alongside.length) {
    throw new CliError(`A template owns its command: --template goes alone, without --${alongside.join(", --")}.`, 2);
  }
  // The task contract (Genie R1-17): --task is Genie's short id; the worker is named after it.
  const taskId = opts.task;
  if (taskId !== undefined) {
    const why = taskIdProblem(taskId);
    if (why) throw new CliError(why, 2);
    if (opts.name !== undefined) throw new CliError(`--name goes without --task: a task's worker is named ${taskId}-<role>.`, 2);
    if (opts.branch !== undefined && !branchNamesTask(opts.branch, taskId)) {
      throw new CliError(`--branch ${opts.branch} doesn't contain the task id ${taskId}; a task's branch names it (fix/${taskId}-login).`, 2);
    }
  }
  if (opts.lead !== undefined && !LEAD_SHAPE.test(opts.lead)) {
    throw new CliError(`--lead: "${opts.lead}" isn't a bot id (b- plus 10 base32 characters) or a Genie session (session-<uuid>).`, 2);
  }
  const { me, bot, project } = await callingBot(opts);
  // The bots file's warnings about this bot (model.js names it first: a bad worker field dropped,
  // a retired agent), on stderr at once, so a refused call shows them too; --json lists them.
  const fileWarnings = project.warnings.filter((w) => w.startsWith(`${bot.id}: `));
  report(fileWarnings);
  const { role, error: roleError } = workerRole(bot, opts.role);
  if (roleError) throw new CliError(roleError, 2);
  if (taskId !== undefined && opts.lead === undefined && LEAD_RANKS.includes(bot.rank)) throw new CliError("pass --lead <the task's lead bot>", 2);
  const lead = opts.lead ?? bot.id;
  const taskName = taskId !== undefined ? taskWorkerName(taskId, role) : null;
  if (taskName && taskName.length > HC_NAME_MAX) {
    throw new CliError(`${taskName} is longer than hc's ${HC_NAME_MAX}-character terminal names; a task's worker is named exactly <id>-<role>.`, 2);
  }
  const agents = agentTable();
  const warnings = [];
  // Planned swaps (owner, council #4): on a task the rule picks, the bot's worker.swap replaces
  // its worker defaults, and a per-task --agent, --model or --effort is recorded, not used.
  // Never for a template worker; off a swap task, a per-task pick is an override.
  let pick = given;
  let swap = false;
  let overrideRequested = null;
  const arm = taskId !== undefined && !runsTemplate(bot, given) && swapTask(bot.id, project.key, taskId) ? swapArm(bot) : null;
  if (arm?.agent && !resolveAgent(arm.agent, agents)) {
    warnings.push(`${bot.name}'s worker swap agent "${arm.agent}" isn't one Herdr knows; this swap task runs without it.`);
    delete arm.agent;
  }
  if (arm && Object.keys(arm).length) {
    swap = true;
    pick = { ...arm };
    if (alongside.length) {
      overrideRequested = Object.fromEntries(alongside.map((k) => [k, given[k]]));
      warnings.push(`${taskId} is one of ${bot.name}'s planned swap tasks, so it runs ${workerText(arm)}; `
        + `${alongside.map((k) => `--${k} ${given[k]}`).join(", ")} recorded, not used.`);
    }
  }
  const override = !swap && Object.values(given).some((v) => v !== undefined);
  const plan = workerPlan(bot, pick, agents, localWhere());
  if (plan.error) throw new CliError(plan.error, 2);
  warnings.push(...plan.warnings);
  // The agent that runs: the plan's, or the one a template's command names (null: can't tell).
  let runs = plan.agent;
  // A Claude template runs its own command under the login words (#453): hc's template form takes
  // no environment. One that can't take its task as a last argument is refused, as unrunnable.
  let templateArgv = null;
  let templateCommand = null;
  if (plan.template) {
    const t = await templateRuns(plan.template, agents);
    runs = t.runs;
    templateCommand = t.command?.trim() ? t.command : null;
    // #1125: a worker template owns its command (the owner's exception, bypass included): never
    // rewritten or refused here; one that runs Codex without --no-daemon is named, with the fix.
    // #1142: one whose Codex run puts an option after its -- would run without it: refused first.
    const lost = templateCommand ? codexTemplateRefusal(plan.template, templateCommand, agents) : null;
    if (lost) throw new CliError(lost);
    const noDaemon = templateCommand ? codexTemplateWarning(plan.template, templateCommand, agents) : null;
    if (noDaemon) warnings.push(noDaemon);
    if (runs === "claude") {
      templateArgv = t.command?.trim() ? commandArgv({ shell: t.command }, [task]) : null;
      if (!templateArgv) {
        throw new CliError(`Template ${plan.template} runs Claude, but ${t.command?.trim() ? "its command ends in a separator or a comment, so it can't take the task"
          : "hc gave no command for it"}; it can't be started on the chosen Claude login. Not started.`);
      }
    }
  } else {
    if (!onPath(plan.argv[0])) throw new CliError(`${agents[plan.agent].name} (${plan.argv[0]}) isn't installed on this computer.`);
    const list = plan.model ? modelList(plan.agent, plan.model) : [];
    if (list.length && !list.includes(plan.model)) warnings.push(`${plan.model} isn't on ${plan.agent}'s model list; started with it anyway.`);
  }
  // Where it works: --worktree's, the branch's worktree, or the folder a new one gets (made
  // below, once the check passes). Nothing is made yet.
  let place = opts.worktree !== undefined ? await givenWorktree(opts.worktree, project.key, bot)
    : await branchPlace(opts.branch, opts.base, project.key, warnings);
  // One writer (dev, test, fix) per worktree, whatever its bot; reviewers run alongside, but
  // one bot runs one reviewer per branch. A worker with no role label counts as a writer.
  // Checked and started under one lock per worktree, so two calls at once can't both pass. The
  // check comes first: a refused call (hc ls failing included) makes no worktree and no hook.
  const lockDir = ledgerPath(appHome()).replace(/\/[^/]*$/, "");
  try { mkdirSync(lockDir, { recursive: true }); } catch (e) { throw new CliError(`Can't make ${lockDir}: ${e?.message ?? e}`); }
  const planned = realDir(place.worktree) ?? place.worktree;
  // The bot's space, no tab: Herdr opens the worker in a tab of its own there, at hc run. The
  // window is asked first (workerSpace): a label naming a space it no longer has is left out.
  const window = await windowRead();
  const space = workerSpace(placementFrom([me])?.space ?? null, window, me.address);
  let worktree = planned;
  let base = null;
  // A new Claude worker runs on a session id chosen here (RFC 0021 (f) 2), passed with
  // --session-id, labelled and in its start row; a template's own command is left as it is.
  const session = !plan.template && choosesSession(plan.agent) && !ownsSession(plan.argv) ? newSessionId() : null;
  const launchArgv = session ? [...plan.argv, ...sessionIdArgs(plan.agent, session)] : plan.argv;
  // The argv the worker runs, set once its worktree is known (a Codex worker's grants come from it).
  let workerArgv = launchArgv;
  // Held across a fetch and git worktree add (60 s each) and the hc calls, so a second call on
  // this worktree waits for the first's start rather than failing; kept fresh while held. A
  // task's worker takes its name's lock first (taskLock), so a second call for the task on
  // another branch waits too, then is refused by the name check with nothing made (#538).
  const deadline = Date.now() + WORKER_LOCK_WAIT;
  const inWorktree = () => withLockAsync(worktreeLock(lockDir, planned), async () => {
    const ls = await hcJson(["ls"]);
    // A task's worker is named exactly <id>-<role>: a live holder of that name is refused, never suffixed.
    // This computer's terminals only (hc names are unique per core), as workersIn sees them.
    const holder = taskName && rowsOf(ls).find((r) => r?.name === taskName && local(r.address)
      && (r.state === undefined || r.state === "live"));
    if (holder) {
      throw new CliError(`${taskName} is taken by a live terminal: ${holder.address}. A task's worker is named exactly <id>-<role>, `
        + `never suffixed. Check it (hc read ${holder.address}) or end it (hc kill ${holder.address}) before starting another.`);
    }
    const live = await workersIn(worktree, ls);
    const nameOf = (id) => project.file.bots.find((b) => b.id === id)?.name ?? id;
    const writing = role !== "review" && live.find((w) => writesWorktree(w.labels));
    const reviewing = role === "review" && live.find((w) => w.labels[WORKER_OF_LABEL] === bot.id
      && workerBranch(w.labels) === place.branch && w.labels[WORKER_ROLE_LABEL] === "review");
    const hit = writing || reviewing;
    if (hit) {
      const what = writing ? `${place.worktree} already has a live writer: ${hit.address} (${nameOf(hit.labels[WORKER_OF_LABEL])}'s `
        + `${hit.labels[WORKER_ROLE_LABEL] ?? "worker, no role label"}). One writer per worktree.`
        : `${bot.name} already has a live review worker on ${place.branch}: ${hit.address}.`;
      throw new CliError(`${what} Check it (hc read ${hit.address}) or end it (hc kill ${hit.address}) before starting another.`);
    }
    if (place.pending) {
      // Looked for again under the lock: a call that held it before this one may have made it.
      const found = [];
      const now = await branchPlace(opts.branch, opts.base, project.key, found);
      if (now.pending) place = await makeBranchWorktree(now, opts.base, project.key, warnings);
      else { place = now; warnings.push(...found); }
    } else if (!(await stillWorktree(place.worktree, project.key))) {
      // Removed while this call waited for the lock (a sweep's cleanup, #567): never started in
      // what is left, since a hook's folder would make it a plain folder whose git is the main
      // checkout's. A branch's own folder is made again; anything else is refused.
      const gone = `${place.worktree} is no longer a worktree of ${project.key}: it was removed while this call waited for its lock.`;
      if (opts.worktree !== undefined) throw new CliError(`${gone} Not started; pass --branch ${place.branch} to make it again.`);
      const now = await branchPlace(opts.branch, opts.base, project.key, []);
      if (!now.pending || now.worktree !== planned) throw new CliError(`${gone} Not started; run the worker call again.`);
      place = await makeBranchWorktree(now, opts.base, project.key, warnings);
    }
    worktree = realDir(place.worktree) ?? place.worktree;
    // #884 Low C: --cwd, the launch words and the settings file name all take the resolved
    // worktree, so a symlinked folder is the same path everywhere.
    place = { ...place, worktree };
    base = await baseCommit(place, project.key);
    // Only the actual proxy transport can authorize skipping the PATH guard. Caller-added flags
    // and working roster edits cannot do so; the same socket still checks terminal.run.
    const transport = await workerTransport();
    const proxied = transport && transport.terminal === me.address;
    // #823: an Antigravity worker's permission file, written before it starts; a template that
    // runs agy is rebuilt with `--settings` (hc's template form takes no extra words), or runs
    // without the list with a plain warning when its command can't take them. H1: for a proxied
    // start the proxy writes the file from the approved snapshot under the data root, which the
    // sandbox binds read-only; this pane only names that path and never writes it.
    const settingsDir = proxied ? approvedSettingsDir() : agySettingsDir(appHome());
    let agySettings = null;
    if (plan.agent === "antigravity" || (plan.template && runs === "antigravity")) {
      agySettings = agySettingsPlan({ bot, scope: "worker", role, folder: worktree, settingsDir, realpath: realDir,
        homeDir: home() });
      if (agySettings?.warnings.length) warnings.push(...agySettings.warnings);
      if (agySettings && !proxied) writeAgySettingsFile(agySettings, bot);
      // #955: a roster that names Antigravity's auto mode for its workers on a host that can't run it is told so.
      const modeWarning = plan.agent === "antigravity"
        ? agyModeWarning({ name: `${bot.name}'s worker`, explicit: bot.worker?.agyMode ?? null, sandbox: hostAgySandbox() }) : null;
      if (modeWarning) warnings.push(modeWarning);
      if (plan.template && runs === "antigravity") {
        const built = templateCommand
          ? commandArgv({ shell: templateCommand }, [...agySettingsArgs("antigravity", agySettings?.path), task]) : null;
        if (built) templateArgv = built;
        else warnings.push(`${bot.name}'s template ${plan.template} ${templateCommand
          ? "ends in a separator or a comment, so its Antigravity permission list can't be added" : "gave no command, so its Antigravity permission list can't be added"}; it runs without one.`);
      }
    }
    // A Claude worker gets the per-turn hook in its worktree: it prints no briefing there (the
    // worker is no bot), but it ties the Claude session to the terminal (briefing.mjs).
    if (runs === undefined) {
      warnings.push(`Can't tell which agent template ${plan.template} runs, so no session hook was written in ${place.worktree}; `
        + `if it runs Claude, the ${place.branch} worker's session won't be linked to usage.`);
    } else if (runs === "claude") {
      const lost = `The ${place.branch} worker's Claude session won't be linked to usage`;
      warnings.push(...(await writeBriefingHook(bot, place.worktree, appHome(), { lost })).warnings);
    }
    // An npm agent (#!/usr/bin/env node) gets its interpreter's folder on PATH when the pane lacks it.
    const runPath = plan.template ? null : launchPath(plan.argv[0], place.worktree);
    if (runPath?.note) warnings.push(runPath.note);
    const taken = new Set(rowsOf(ls).map((r) => r?.name).filter(Boolean));
    const name = taskName ?? hcName(opts.name ?? branchSlug(place.branch), bot.id, taken);
    // #1125: a Codex worker may write its worktree's own git dir and git common dir (the main
    // checkout's .git), herdr-core's folders and the tool caches, resolved from the worktree it runs in.
    // Through the actual hc proxy (#631) it gets the mode words alone: the proxy starts only the
    // approved argv, which names no per-launch folder, and that contract stays as it is.
    const grantless = plan.agent === "codex" && proxied;
    if (grantless) {
      warnings.push(`${bot.name}'s Codex worker starts through the hc proxy, so it runs Codex's launch mode without its extra `
        + `folders (git dirs, herdr-core's, tool caches; #1125): the proxy starts only the approved command. A write there `
        + `goes to Codex's reviewer, and the proxy's own sandbox may still refuse it.`);
    }
    const codexPlan = plan.agent === "codex" && !grantless ? await localCodexGrantPlan(place.worktree) : null;
    // #1142: what the launch withheld, said once; a template worker runs its own command and gets nothing of the pack's.
    const codexWithheld = codexPlan && !plan.template ? localCodexWarning(agents.codex?.run, codexPlan) : null;
    if (codexWithheld) warnings.push(codexWithheld);
    workerArgv = codexPlan ? withCodexGrants(launchArgv, codexPlan.dirs) : launchArgv;
    // #1420: worker starts alone get a per-launch trust word, after checking the person's settings.
    // The proxy and templates keep their commands; no config is written and no prompt is answered.
    if (plan.template && runs === "codex") {
      warnings.push(codexTrustKeptWarning(`${bot.name}'s Codex worker`, `template ${plan.template} owns its command`));
    } else if (plan.agent === "codex" && proxied && !plan.template) {
      warnings.push(codexTrustKeptWarning(`${bot.name}'s Codex worker`, "proxy"));
    } else if (plan.agent === "codex" && !proxied && !plan.template && codexPlan) {
      const codexHome = process.env.CODEX_HOME || join(home(), ".codex");
      const configs = isAbsolute(codexHome)
        ? ["/etc/codex/config.toml", "/etc/codex/managed_config.toml", join(codexHome, "config.toml")].map((path) => {
          try { return { text: readFileSync(path, "utf8") }; } catch (error) { return { error }; }
        }) : [{ error: { code: "EINVAL" } }];
      // The common dir's parent, and the project's main checkout too (a git dir kept elsewhere): one more only withholds.
      const roots = codexPlan.gitCommonDir ? [...new Set([realDir(dirname(codexPlan.gitCommonDir)) ?? dirname(codexPlan.gitCommonDir),
        realDir(project.key) ?? project.key].filter(Boolean))] : null;
      const trust = codexTrustPlan({ folder: place.worktree, roots, configs, run: agents.codex?.run, home: home(), realpath: realDir });
      if (trust.args.length) workerArgv = withCodexTrust(workerArgv, place.worktree);
      else warnings.push(codexTrustWarning(`${bot.name}'s Codex worker`, trust.withheld));
    }
    const args = workerArgs({ botId: bot.id, branch: place.branch, role, name, cwd: place.worktree, parent: me.address, space,
      agent: plan.agent, model: plan.model, effort: plan.effort, agyMode: plan.agyMode, argv: workerArgv, session, task: prompt, template: plan.template,
      templateArgv,
      login: claudeLogin(templateArgv ?? plan.argv ?? [], warnings),
      path: runPath?.path ?? process.env.PATH, taskId, project: project.key, lead,
      agySettingsPath: agySettings && !templateArgv ? agySettings.path : null,
      // #955: the proxy matches a worker's `hc kill` shim as the stable folder's copy.
      ...(proxied ? { killGuard: stableKillDir(stableRootOf()) } : {}),
      sandbox: plan.agent === "dsh-tui" && proxyEnabled(
        approvedProxyState({ project: project.key, bot }), process.platform,
        (warning) => warnings.push(warning)) });
    // #1262: hc answers a run with a task only once the new terminal reports its first status,
    // waiting 60 s for a program that never does; the run gets its own timeout above that wait.
    // One the timeout still ends after hc made the terminal is a start whose task didn't go in,
    // never a failed start: the row below is written from the terminal looked up by its name.
    const started = await hcStartRun(proxied ? hcReal : hc, args, name);
    const { address } = started;
    if (started.late) {
      warnings.push(plan.template
        ? `${name} started, but its task wasn't delivered: hc run didn't answer within ${HC_RUN_TIMEOUT_MS / 1000}s, `
          + `and hc types a template's task only after its terminal reports a status. Send it: hc send ${address} "<task>".`
        : `${name} started, but hc run didn't answer within ${HC_RUN_TIMEOUT_MS / 1000}s; its start is recorded.`);
    } else if (plan.template && started.answer?.first_message?.sent === false) {
      const why = String(started.answer.first_message.reason ?? "").trim();
      warnings.push(`${name} started, but its task wasn't delivered: hc never saw its terminal report a status${why ? ` (${why})` : ""}. `
        + `Send it: hc send ${address} "<task>".`);
    }
    return { address, name, proxied };
  }, { wait: Math.max(0, deadline - Date.now()), what: `the worker lock on ${place.worktree}` });
  const started = await (taskName ? withLockAsync(taskLock(lockDir, taskName), inWorktree,
    { wait: WORKER_LOCK_WAIT, what: `the task name ${taskName}` }) : inWorktree())
    .catch((e) => { throw e instanceof CliError ? e : new CliError(e?.message ?? String(e)); });
  const terminal = started.address;
  // The ledger row first, as launchSeat writes its rows before anything waits on the window.
  const { pid, createdMs } = await launchOf(terminal);
  const unlogged = appendLedger(startRow({ kind: "worker", terminal, pid, botId: bot.id, task: taskId, branch: place.branch,
    project: project.key, lead, worktree, base, created: place.created, agent: plan.agent, model: plan.model, effort: plan.effort,
    template: plan.template, role, swap, override, overrideRequested, core: await rowCore(), createdMs, squad: squadOf(project.file, bot.id),
    session }));
  if (unlogged) warnings.push(unlogged);
  // An agent that takes no first prompt on its command line (kimi, #1032) started bare: its task
  // goes in as its first message, through the hc that started it, outside the worktree's lock.
  if (!plan.template && promptByMessage(plan.agent)) {
    const why = await sendFirstTask(terminal, prompt, started.proxied ? hcReal : hc);
    if (why) warnings.push(why);
  }
  // Herdr shows a labelled worker at once, so the sidebar's tab setup (workerTab.js) never
  // runs for it: its tab is named and moved after the bot's tab here, as a click would.
  if (space && window && TAB_WAIT_MS > 0) {
    const why = await workerTabSetup(terminal, me.address, workerTabName({ branch: place.branch, name: started.name }));
    if (why) warnings.push(why);
  }
  // The worktrees earlier workers made, once they have all ended (#567): after this worker
  // started, outside its locks, capped, and never failing the call.
  warnings.push(...(await reapWorktrees({ project: project.key })).lines);
  report(warnings);
  const out = { terminal, bot: bot.id, role, parent: me.address, worktree: place.worktree, branch: place.branch, created: place.created,
    base: place.base, template: plan.template, agent: plan.agent, model: plan.model, effort: plan.effort, agyMode: plan.agyMode, pid,
    argv: maskedArgv(workerArgv, session),
    warnings: [...fileWarnings, ...warnings],
    task: taskId ?? null, project: project.key, lead, baseCommit: base, swap, override, override_requested: overrideRequested };
  if (opts.json) return out;
  const how = place.created ? `new, from ${place.base ?? place.branch}` : "existing";
  const what = plan.template ? [`  template  ${plan.template}${runs ? ` (runs ${runs})` : ""}`]
    : [`  agent     ${plan.agent}`, `  model     ${plan.model ?? "(the agent's default)"}`,
      `  effort    ${plan.effort ?? "(the agent's default)"}`,
      ...(plan.agyMode ? [`  agy mode  ${plan.agyMode}`] : [])];
  const contract = taskId !== undefined ? [`  task      ${taskId} (lead ${lead})`] : [];
  const swapped = swap ? [`  swap      yes: ${bot.name}'s planned swap task`] : [];
  return [terminal, `  role      ${role}`, ...contract, `  worktree  ${place.worktree}`, `  branch    ${place.branch} (${how})`, ...what,
    ...swapped,
    `End it once the task merges: am worker kill ${terminal}`].join("\n");
}

// ---- updates (A14) ----

/** The hooks notice (migrateHooks.mjs hooksNotice) on lines of its own after the summary, or "". */
const hooksLines = (hooks) => { const lines = hooksNotice(hooks); return lines.length ? `\n${lines.join("\n")}` : ""; };
/** Each mod an install held for a layout (update.mjs `held`, #420, #432) on a line of its own, or "". */
const heldLines = (installed) => (installed.held ?? []).map((h) => `\n${heldModLine(h, installed.version)}`).join("");

/**
 * `update`: install the latest release, `--check` only reports, `--rollback` swaps the kept
 * pack back, `--retry-skipped` clears the rollback skip for the release it installs. `io` is
 * injected by the tests (fetch, env, modsDir, binDir); the pack is the installed one under
 * $HERDR_APP_HOME/mods, never this checkout (update.mjs). The CLI link (~/.local/bin) and the
 * open spaces are looked at only for this computer's own pack: with `io.modsDir`, only `io.binDir`.
 * `linkedUpdate(env)`: the linked-machine cycle (#1505) asks for the automatic path, so the same
 * `installUpdate` hold applies to the machine's own setting and its rollback skip.
 */
export async function cmdUpdate(opts, _rest = [], io = {}) {
  if (opts.auto !== undefined) {
    if (opts["retry-skipped"]) throw new CliError("Give --retry-skipped with am update, not --auto.", 2);
    return autoSetting(opts, io);
  }
  if (opts.check && opts.rollback) throw new CliError("Give --check or --rollback, not both.", 2);
  if (opts["retry-skipped"] && (opts.check || opts.rollback)) {
    throw new CliError("Give --retry-skipped only when installing an update, not with --check or --rollback.", 2);
  }
  const host = io.modsDir ? { binDir: io.binDir ?? null, window: false }
    : { binDir: io.binDir ?? binDirOf(io.env ?? process.env), window: liveHome(`${appHome(io.env ?? process.env)}/mods`) };
  const where = { ...(io.env ? { env: io.env } : {}), ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.keys ? { keys: io.keys } : {}), ...(io.modsDir ? { modsDir: io.modsDir } : {}), ...host,
    // `--retry-skipped` is the person's explicit retry even beside the cycle's variable.
    ...(opts["retry-skipped"] ? { retrySkipped: true } : {}), ...(linkedUpdate(io.env ?? process.env) && !opts["retry-skipped"] ? { auto: true } : {}) };
  const failed = (what, e) => new CliError(`${what}: ${String(e?.message ?? e).split("\n")[0]}`);
  // The pack just swapped (or one an older CLI installed) may name its CLI otherwise
  // (bin/automagik-herdr, or only the .mjs before it): the ~/.local/bin link follows, so a
  // rollback never leaves it dangling. Idempotent, never fatal; `--check` changes nothing.
  // `from`: where the link pointed before a rollback, whose own relink (update.mjs moveHooks) may
  // already have moved it: either way the move is reported. The link is host.binDir's: with an
  // injected io.modsDir only io.binDir, never this computer's ~/.local/bin.
  const relink = (from = null) => {
    const { binDir } = host;
    try {
      let r = relinkCli({ modsDir: io.modsDir ?? defaultModsDir(io.env ?? process.env), binDir });
      if (!r && from && binDir) {
        const link = join(binDir, "automagik-herdr");
        const to = readLink(link);
        if (to && to !== from) r = { link, from, to };
      }
      return { relinked: r, note: r ? ` ${r.link} now points at ${r.to}.` : "" };
    } catch (e) {
      return { relinked: null, note: ` The automagik-herdr link was not repointed (${String(e?.message ?? e).split("\n")[0]}): run install.sh again.` };
    }
  };
  if (opts.rollback) {
    const before = host.binDir ? readLink(join(host.binDir, "automagik-herdr")) : null;
    let r;
    try { r = rollbackPack({ ...(io.modsDir ? { modsDir: io.modsDir } : {}), ...host }); } catch (e) { throw failed("Nothing rolled back", e); }
    const { relinked, note } = relink(before);
    const warned = r.warnings?.length ? ` Warning: ${r.warnings.join("; ")}.` : "";
    return opts.json ? { rolledBack: r, relinked } : `Rolled back to Automagik Herdr ${r.version ?? "(no VERSION)"} at ${r.pack}. Herdr reloads its mods on its own.${r.from && readAuto(io.modsDir ?? defaultModsDir(io.env ?? process.env)).on ? ` Updates installed automatically skip ${r.from} and wait for a newer release.` : ""}${warned}${note}${hooksLines(r.hooks?.hooks)}`;
  }
  let r;
  try { r = opts.check ? await checkForUpdate(where) : await installUpdate(where); } catch (e) {
    throw failed(opts.check ? "Couldn't check for updates" : "Not updated", e);
  }
  const { relinked, note } = opts.check ? { relinked: null, note: "" } : relink();
  const meter = r.installed && !r.installed.restored && !r.installed.restoreError ? await meterAfterUpdate(io) : null;
  if (opts.json) return opts.check ? r : { ...r, relinked, ...(meter ? { meter: meter.results } : {}) };
  const current = r.current ?? "not installed";
  if (r.disabled) return `Automagik Herdr ${current} is installed. Updates are off (${NO_UPDATE_ENV}=1).${note}`;
  if (r.installed?.restored) {
    const restore = r.installed.restored;
    const mods = (restore.failed?.length ? restore.failed : [restore.mod]).filter(Boolean).join(", ");
    const stopped = restore.unavailable ? `; ${restore.unavailable}` : "";
    const removed = restore.prevRemoved ? " The failed pack was removed, so `am update --rollback` has nothing to go back to." : "";
    const warnings = Array.isArray(restore.warnings) ? restore.warnings.filter((w) => typeof w === "string" && w !== "") : [];
    const warned = warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";
    return `Automagik Herdr ${restore.failedVersion ?? r.installed.version} failed to load (${mods} failed herdr-app check${stopped}): `
      + `the previous version ${restore.version} is back.${removed}${warned} The bad version is held back; a newer release installs on its own.${note}`;
  }
  if (r.installed?.restoreError) {
    return `Automagik Herdr ${r.installed.version} failed to load, and ${r.installed.restoreError}. `
      + `It is still installed; auto-update waits for a newer release.${note}`;
  }
  if (r.installed) {
    return `Updated Automagik Herdr ${current} → ${r.installed.version}. The replaced pack is kept: \`am update --rollback\` puts it back. Herdr reloads its mods on its own.${note}${hooksLines(r.installed.hooks?.hooks)}${heldLines(r.installed)}${meter.lines.map((l) => `\n${l}`).join("")}`;
  }
  // The linked-machine cycle's automatic path (#1505): the machine's own setting or its skip held it.
  if (r.held) return `Automagik Herdr ${current} is installed; ${r.update?.version ?? "the release"} was left alone (${r.held}). Run \`am update\` there to install it by hand.`;
  if (r.update) return `Automagik Herdr ${current} is installed; ${r.update.version} is out (${r.update.page}). Run \`am update\` to install it.`;
  return `Automagik Herdr ${current} is installed; the latest release is ${r.latest ?? "none yet"}. Up to date.${note}`;
}

/** `update --auto on|off|status`: the pack's own setting (update.mjs writeAuto), and whether it applies here. */
function autoSetting(opts, io) {
  if (opts.check || opts.rollback) throw new CliError("Give --auto alone, without --check or --rollback.", 2);
  if (!["on", "off", "status"].includes(opts.auto)) throw new CliError("--auto takes on, off or status.", 2);
  const env = io.env ?? process.env;
  const modsDir = io.modsDir ?? defaultModsDir(env);
  let s;
  try { s = opts.auto === "status" ? autoStatus(modsDir) : { ...writeAuto(modsDir, { on: opts.auto === "on" }), ...managedPack(modsDir) }; } catch (e) {
    throw new CliError(`The setting was not saved: ${String(e?.message ?? e).split("\n")[0]}`);
  }
  if (opts.json) return { ...s, checks: !updatesOff(env) };
  const lines = [`Install updates automatically: ${s.on ? "on" : "off"}.`];
  if (!s.managed) lines.push(`It doesn't apply to this pack (${s.why}): updates stay a notice and \`am update\`.`);
  else if (s.on && s.skip) lines.push(`${s.skip} was rolled back here: it waits for a release newer than ${s.skip}.`);
  if (updatesOff(env)) lines.push(`Update checks are off (${NO_UPDATE_ENV}=1), so nothing is installed.`);
  return lines.join("\n");
}

// ---- tidy (sidebar-rules Group 2) ----

const tidyIo = () => ({ run: runProgram, home: home(), appHome: appHome(), prune: (keys) => unlistProjects(keys),
  // Read the file again after a command writes it, without importing labels or ending rows.
  ledger: async () => {
    const rows = readAttachFile();
    if (rows === null) return null;
    const known = [...new Set(rows.filter((row) => row.machine == null).map((row) => row.bot))];
    const { byBot } = foldAttach(rows);
    if (!byBot.size) return { bindings: [], known };
    const core = await coreId();
    return { bindings: [...byBot.values()].filter((row) => row.core === core), known };
  } });

/** `tidy`: the plan (tidy.js), read from hc, herdr-app, git and the files; it changes nothing. */
async function cmdTidy(opts) {
  let state;
  try { state = await readState(tidyIo(), { window: true }); } catch (e) { throw new CliError(`Can't plan: ${e?.message ?? e}`); }
  const actions = tidyPlan(state, { now: Date.now(), home: home(), appHome: appHome() });
  return opts.json ? actions : planText(actions);
}

/**
 * After start, attach and create: the plan's non-visual fixes only; a failure only warns. A
 * prune's note only when the command succeeded: a failed one's last stderr line stays its own
 * error (the sidebar shows that line, restart.js restartAnswer).
 */
async function tidyQuietly(warnedRelabels) {
  const warnings = [];
  const onRelabelFailure = warnedRelabels ? (failure) => {
    const { terminal, words } = failure;
    const warning = relabelFailureWarning(failure, `tidy: ${terminal}'s labels ${words.join(" ")} weren't set:`, warnedRelabels);
    if (warning) warnings.push(warning);
  } : undefined;
  try {
    const io = tidyIo();
    const actions = tidyPlan(await readState(io, { window: false }), { now: Date.now(), home: io.home, appHome: io.appHome });
    report(await fixNonVisual(actions.filter((a) => !a.visual), io, { notes: exitAfter.code === 0, onRelabelFailure }));
  } catch (e) { report([`tidy: ${e?.message ?? e}`]); }
  report(warnings);
  return warnings;
}
const TIDIES = new Set(["start", "restart", "attach", "create"]);

// ---- revive (#939): the bots come back after a restart of this computer ----

/** When this computer started, in ms: now less its uptime. AUTOMAGIK_HERDR_BOOT_MS: a test's own. */
const bootTime = () => (Number(process.env.AUTOMAGIK_HERDR_BOOT_MS) || Math.round(Date.now() - uptime() * 1000));
/** How long one bot's restart may take, its helpers' turns included (restart's own waits are shorter). */
const REVIVE_RESTART_MS = Number(process.env.AUTOMAGIK_HERDR_REVIVE_RESTART_MS) || 900_000;
/** The boot's pass looks twice, this far apart, and acts on the second look: herdr-core puts panes back after a delay of its own. */
const REVIVE_SETTLE_MS = process.env.AUTOMAGIK_HERDR_REVIVE_SETTLE_MS !== undefined ? Number(process.env.AUTOMAGIK_HERDR_REVIVE_SETTLE_MS) || 0 : 20_000;
const reviveStampPath = () => join(appHome(), "automagik-herdr", "revive-boot.json");
const reviveReportPath = () => join(appHome(), "automagik-herdr", "revive-last.json");
const REVIVE_USAGE = "usage: am revive [--dry-run] [--boot] [--wait SECONDS] [--json] | revive --last [--json] | revive service install|uninstall|status";

/** Waits until herdr-core answers (`hc server status`), up to `seconds`; a CliError when it doesn't. */
async function coreUp(seconds) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    let why;
    try {
      // Each poll asks the socket straight (never hc, which would start a core), bound as the
      // old hc call was: 10 s each, so the last poll still reports why, not a cut-short wait.
      const r = await coreStatus(process.env, { timeoutMs: 10_000 });
      if (Object.hasOwn(r, "status")) return;
      why = r.none ? `core is not running (no socket answers: ${r.tried.join(", ") || "no socket"})` : r.error;
    } catch (e) { why = e?.message ?? String(e); }
    if (Date.now() >= until) throw new CliError(`herdr-core isn't answering${seconds ? ` ${seconds}s on` : ""} (${why.split("\n")[0]}). Nothing was started.`);
    await later(Math.min(2000, Math.max(100, until - Date.now())));
  }
}

/** This CLI again, as a program of its own: each bot's restart reads hc and the ledgers afresh. */
const runSelf = (args) => runProgram(process.execPath, [fileURLToPath(import.meta.url), ...args], { timeout: REVIVE_RESTART_MS });

/** A refusal's first sentence, for the report: what happened, without the advice after it. */
const firstSentence = (text) => { const t = String(text ?? "").trim().replace(/^(?:am|automagik-herdr): /, ""); const m = /^(.*?[.!?])(\s|$)/.exec(t); return (m ? m[1] : t).replace(/[.!?]$/, ""); };

/**
 * One bot back through `restart --tree --revive` (cmdRestart: in its pane's space, tab and
 * folder, resumed where its agent allows, its helpers under it), and once more with --fresh when
 * the refusal says a new conversation is the way. Resolves { outcome: "resumed" | "fresh" |
 * "failed" | "running", why, terminal, helpers }.
 */
async function reviveOne(target, bot) {
  const args = ["restart", bot.id, "--project", target.project, "--tree", "--revive", "--json"];
  const read = (r) => { let out = null; try { out = JSON.parse(r.stdout); } catch { out = null; } return { code: r.code, out, err: r.stderr, killed: r.killed === true }; };
  const helpersOfAnswer = (out) => (Array.isArray(out?.helpers) ? out.helpers : []).map((h) => ({ name: h.name ?? h.replaced, bot: h.bot ?? null,
    outcome: !h.up ? "failed" : h.mode === "resume" ? "resumed" : "fresh", why: !h.up ? firstSentence(h.error) : h.note ?? null }));
  const done = (out, why = null) => ({ outcome: out.mode === "resume" ? "resumed" : "fresh", terminal: out.terminal,
    why: out.mode === "resume" ? null : why ?? out.note ?? (target.pane === "gone" ? "its pane was gone and no conversation of its own was on record" : "no reason given"),
    helpers: helpersOfAnswer(out) });
  // A refusal's --json carries `error` (and may name the pane that failed): never read as an answer.
  const back = (r) => Boolean(r.out && !r.out.error && r.out.terminal);
  const first = read(await runSelf(args));
  if (back(first)) return done(first.out);
  if (first.out?.running) return { outcome: "running", terminal: first.out.running, why: null, helpers: [] };
  if (first.killed) return { outcome: "failed", terminal: null, why: `its restart gave no answer in ${REVIVE_RESTART_MS / 1000}s`, helpers: [] };
  const refusal = restartAnswer({ code: first.code || 1, out: first.out, err: first.err });
  if (!refusal.freshable) return { outcome: "failed", terminal: null, why: firstSentence(refusal.refused), helpers: [] };
  const again = read(await runSelf([...args, "--fresh"]));
  if (back(again)) return done(again.out, `its conversation couldn't be resumed (${firstSentence(refusal.refused)})`);
  if (again.out?.running) return { outcome: "running", terminal: again.out.running, why: null, helpers: [] };
  return { outcome: "failed", terminal: null, helpers: [],
    why: firstSentence(restartAnswer({ code: again.code || 1, out: again.out, err: again.err }).refused) };
}

/**
 * `revive` (#939): every bot the attach ledger binds on this computer whose pane is gone or is a
 * bare shell (what herdr-core leaves of a program a reboot ended) is restarted in its place, its
 * helpers under it, and each project's main bot gets one report. --boot: the login service's
 * pass, once per boot, also taking the bindings a sweep ended since the boot. --dry-run: the
 * plan, nothing touched. --wait S: waits that long for herdr-core first.
 */
async function cmdRevive(opts, [verb, sub, ...more]) {
  if (opts.last) return reviveLast(opts, verb);
  if (verb === "service") return reviveService(opts, sub, more);
  if (verb) throw new CliError(REVIVE_USAGE, 2);
  const wait = opts.wait === undefined ? 0 : Number(opts.wait);
  if (!Number.isFinite(wait) || wait < 0 || wait > 86_400) throw new CliError("--wait takes seconds, 0 to 86400.", 2);
  const dry = Boolean(opts["dry-run"]);
  const bootMs = bootTime();
  // Before herdr-core is asked: a second boot pass while it is down says so and keeps the record as it is.
  if (opts.boot && !dry) {
    let ran = null;
    try { ran = JSON.parse(readFileSync(reviveStampPath(), "utf8"))?.boot_ms ?? null; } catch { ran = null; }
    if (sameBoot(ran, bootMs)) return opts.json ? { ran: false, reason: "already ran for this boot" } : "revive already ran for this boot; run am revive to look again.";
  }
  const projects = new Map();
  if (dry) return revivePass(opts, { wait, dry, bootMs, projects });
  // #1419: a pass that stops early is recorded too (never stamped), and its error stands.
  try { return await revivePass(opts, { wait, dry, bootMs, projects }); } catch (e) { keepStopped(e, opts, bootMs, projects); throw e; }
}

/** cmdRevive's pass, from herdr-core's wait to the reports; `projects` is cmdRevive's, so a pass that stops early is recorded with what it knew. */
async function revivePass(opts, { wait, dry, bootMs, projects }) {
  await coreUp(wait);
  const core = await coreId();
  const look = async () => {
    // The ledger as it stands, never the one-time import: with no ledger there is nothing to bring back.
    const rows = readAttachFile(attachPath(appHome())) ?? [];
    const isBot = (b) => !b.machine && b.core === core && b.bot.startsWith("b-");
    const bindings = [...foldAttach(rows).byKey.values()].filter(isBot);
    const states = new Map(await Promise.all(bindings.map(async (b) => [b.terminal, await hcState(b.terminal)])));
    const swept = opts.boot ? sweptSince(rows, bootMs, core).filter(isBot) : [];
    return { states, ...reviveTargets({ bindings, states, swept }) };
  };
  let seen = await look();
  if (opts.boot && !dry && REVIVE_SETTLE_MS > 0 && seen.targets.length) { await later(REVIVE_SETTLE_MS); seen = await look(); }
  const { states, skipped } = seen;
  // Sessions first, while each pane still stands: a dsh-TUI, Antigravity, Codex or Kimi pane gets its id recorded.
  if (!dry) await recordSessions();
  const me = process.env.HC_TERMINAL_ID ?? null;
  const projectOfKey = (key) => {
    if (!projects.has(key)) {
      let loaded = null;
      try { loaded = key ? loadProject(key) : null; } catch { loaded = null; }
      projects.set(key, { key, file: loaded?.text ? loaded.file : null, warnings: loaded?.warnings ?? [], results: [] });
    }
    return projects.get(key);
  };
  const botOf = (t) => projectOfKey(t.project).file?.bots.find((b) => b.id === t.bot) ?? null;
  const nameOf = (t) => botOf(t)?.name ?? t.bot;
  const leadOf = (t) => { const f = projectOfKey(t.project).file; try { return f && botOf(t)?.kind === "member" ? effectiveLead(f, t.bot).lead || null : null; } catch { return null; } };
  const isMain = (t) => { const f = projectOfKey(t.project).file; return Boolean(f && mainBotOf(f)?.id === t.bot); };
  const ordered = reviveOrder(seen.targets, { leadOf, isMain });
  // A bot whose pane ends with another target's pane comes back with it (--tree), never twice.
  const byTerminal = new Map(ordered.filter((t) => t.pane === "shell").map((t) => [t.terminal, t]));
  const parentTarget = (t) => { const g = states.get(t.terminal)?.get; return t.pane === "shell" && g?.parent && g.die_with_parent !== false ? byTerminal.get(g.parent) ?? null : null; };
  const plan = ordered.map((t) => {
    const bot = botOf(t);
    const why = !t.project ? "its attach row names no project" : !projectOfKey(t.project).file ? `${t.project} has no ${BOTS_PATH} that can be read`
      : !bot ? `${BOTS_PATH} no longer defines it` : bot.planned ? "it is planned, not started"
        : me && [t.terminal, states.get(t.terminal)?.get?.name].includes(me) ? "revive runs inside its pane; run it from another terminal" : null;
    return { ...t, name: nameOf(t), bot: t.bot, def: bot, refuse: why, via: parentTarget(t) };
  });
  // #1413 F3: a record warning about a bot being brought back is said once, as start and restart do.
  for (const p of plan) if (p.def) warnProject(projectOfKey(p.project), p.bot);
  // #1128: a bot whose recorded pane is gone may still run in another app home — a pane that
  // carries its label, or a live binding in the project's own home the label was lost from.
  // Never start a twin: that live binding is named and left alone.
  for (const p of plan) {
    if (p.refuse || p.pane !== "gone" || !p.def || !p.project) continue;
    try {
      const live = (await labelledPanes(projectOfKey(p.project), p.def, null, () => null))
        .filter((g) => !(g.address === p.terminal && g.created_ms === p.created_ms));
      if (live.length) p.refuse = `a live pane carries its label (${live.map((g) => g.address).join(", ")}), so it was left running, not started again`;
      else {
        const own = await projectHomeHeld(projectOfKey(p.project), p.def);
        if (own && !(own.binding.terminal === p.terminal && own.binding.created_ms === p.created_ms)) {
          p.refuse = `a live binding in ${attachPath(projectAppHomeOf(p.project))} still names it, so it was left running, not started again`;
        }
      }
    } catch (e) {
      p.refuse = `its live panes couldn't be checked (${stoppedReason(e)}), so nothing was started`;
    }
  }
  for (const s of skipped) projectOfKey(s.project).results.push({ name: nameOf(s), bot: s.bot, outcome: "skipped", why: s.why, terminal: s.terminal, helpers: [] });
  if (dry) {
    const lines = plan.map((p) => `${p.name} (${p.bot}) in ${p.project ?? "no project"}: ${p.refuse ? `left alone, ${p.refuse}`
      : p.via ? `comes back with ${p.via.bot}, under its pane` : `would restart; its pane ${p.terminal} ${p.pane === "shell" ? "is a bare shell" : "is gone"}`}`);
    for (const s of skipped) lines.push(`${nameOf(s)} (${s.bot}) in ${s.project ?? "no project"}: left alone, ${s.why}`);
    return opts.json ? { dry: true, boot_ms: bootMs, targets: plan.map((p) => ({ bot: p.bot, name: p.name, project: p.project, terminal: p.terminal, pane: p.pane,
      action: p.refuse ? "skip" : p.via ? "with-parent" : "restart", why: p.refuse ?? null })), skipped }
      : lines.length ? lines.join("\n") : "Every bot the ledger names runs its agent: nothing to bring back.";
  }
  const helped = new Map();
  for (const p of plan) {
    const results = projectOfKey(p.project).results;
    if (p.refuse) { results.push({ name: p.name, bot: p.bot, outcome: p.def ? "skipped" : "failed", why: p.refuse, terminal: null, helpers: [] }); continue; }
    if (p.via) continue; // its parent's --tree brings it back; said there
    const r = await reviveOne(p, p.def);
    for (const h of r.helpers) if (h.bot) helped.set(`${p.project}\n${h.bot}`, h);
    if (r.outcome !== "running") results.push({ name: p.name, bot: p.bot, ...r });
  }
  // A bot that was to come back under its parent, and didn't (the parent failed, or --tree left it out): said as not back.
  for (const p of plan.filter((x) => x.via && !x.refuse)) {
    if (!helped.has(`${p.project}\n${p.bot}`)) {
      projectOfKey(p.project).results.push({ name: p.name, bot: p.bot, outcome: "failed", terminal: null, helpers: [],
        why: `it was to come back under ${nameOf(p.via)}, which didn't bring it` });
    }
  }
  // One report per project, to its main bot's pane as the ledger names it now.
  const fold = foldAttach(readAttachFile(attachPath(appHome())) ?? []);
  const out = [];
  for (const proj of projects.values()) {
    const line = reportLine(proj.key ?? "(no project)", proj.results);
    proj.report = line;
    if (!line) continue;
    const main = proj.file ? mainBotOf(proj.file) : null;
    // #1419: this core's binding, and the pane it was bound to: a reused terminal is another's pane.
    const binding = main ? [...fold.byKey.values()].find((b) => !b.machine && b.core === core && b.bot === main.id && (b.project == null || b.project === proj.key)) ?? null : null;
    let sent = null, unsent = null;
    if (!binding) unsent = main ? `${main.name} has no pane` : "the project has no main bot that can be read";
    else {
      try {
        const live = await hcState(binding.terminal);
        if (live.state !== "live" || live.get?.created_ms !== binding.created_ms || !agentInForeground(live.get)) unsent = `${main.name}'s pane ${binding.terminal} runs no agent`;
        else {
          const r = await hc(["send", binding.terminal, line]);
          if (r.code === 0) sent = binding.terminal;
          else unsent = `hc send ${binding.terminal} failed (${(r.stderr || r.stdout).trim().split("\n")[0]})`;
        }
      } catch (e) { unsent = `the report to ${binding.terminal} couldn't be sent (${stoppedReason(e)})`; }
    }
    out.push({ project: proj.key, report: line, sent, unsent, results: proj.results });
  }
  const failed = out.some((p) => p.results.some((r) => r.outcome === "failed" || r.helpers.some((h) => h.outcome === "failed")));
  // What happened, kept for the owner (0600; it holds no session id), and the boot's stamp.
  try {
    mkdirSync(dirname(reviveReportPath()), { recursive: true });
    writeFileSync(reviveReportPath(), unprinted(`${JSON.stringify({ at: new Date().toISOString(), boot_ms: bootMs, boot: Boolean(opts.boot), projects: out }, null, 2)}\n`), { mode: 0o600 });
    if (opts.boot) writeFileSync(reviveStampPath(), `${JSON.stringify({ boot_ms: bootMs, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch (e) { report([`revive: its record wasn't written (${opts.boot ? e?.code ?? "an error" : e?.message ?? e}).`]); }
  if (failed) exitAfter.code = 1;
  if (opts.json) return { ran: true, boot_ms: bootMs, projects: out };
  if (!out.length) return "Every bot the ledger names runs its agent: nothing to bring back.";
  // The login service's output goes to the user journal: counts only, no folder, no name.
  if (opts.boot) return countsLine(out);
  return out.map((p) => `${p.report}\n  ${p.sent ? `Sent to the main bot (${p.sent}).` : `Not sent: ${p.unsent}. It is kept in ${reviveReportPath()}.`}`).join("\n");
}

/** Why a pass or a send stopped, for the record: a refusal's first line, else an error's code; never a stack. */
const stoppedReason = (e) => (e instanceof CliError ? unprinted(String(e.message).split("\n")[0]) : typeof e?.code === "string" ? e.code : "an unexpected error");

/**
 * #1419: a pass that stopped early, kept in revive-last.json with `stopped: { at, boot, reason }`.
 * The record already there for this boot is kept under it (a report not sent yet is never lost);
 * else the projects the pass knew, none of them sent. Never throws: the pass's own error stands.
 */
function keepStopped(e, opts, bootMs, projects) {
  try {
    let base = null;
    try { base = JSON.parse(readFileSync(reviveReportPath(), "utf8")); } catch { base = null; }
    if (!base || typeof base !== "object" || !sameBoot(base.boot_ms, bootMs)) {
      base = { boot_ms: bootMs, projects: [...projects.values()].map((p) => ({ project: p.key, report: p.report ?? reportLine(p.key ?? "(no project)", p.results),
        sent: null, unsent: "the pass stopped early", results: p.results })) };
    }
    const stopped = { at: new Date().toISOString(), boot: Boolean(opts.boot), reason: stoppedReason(e) };
    mkdirSync(dirname(reviveReportPath()), { recursive: true });
    writeFileSync(reviveReportPath(), unprinted(`${JSON.stringify({ ...base, stopped }, null, 2)}\n`), { mode: 0o600 });
    chmodSync(reviveReportPath(), 0o600);
  } catch { /* the pass's own error is what the caller sees */ }
}

/** `revive --last`: the last pass as kept in the app home (revive.js lastText); runs nothing, asks hc nothing. */
function reviveLast(opts, verb) {
  if (verb || opts.boot || opts["dry-run"] || opts.wait !== undefined) throw new CliError(REVIVE_USAGE, 2);
  const path = reviveReportPath();
  let record = null;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    if (e?.code !== "ENOENT") throw new CliError(e instanceof SyntaxError ? `The revive record isn't valid JSON (${path}).` : `The revive record can't be read (${path}, ${e?.code ?? "an error"}).`);
  }
  return opts.json ? { path, record } : lastText(record, path);
}

/**
 * `revive service install|uninstall|status`: the login service that runs `revive --boot` after a
 * restart of this computer. Linux: a systemd user unit (revive.js unitText). macOS: a launchd
 * agent in the person's own `~/Library/LaunchAgents` (revive.js plistText), never bootstrapped
 * here (RunAtLoad would run the pass now and restart bots under the person's hands). Neither is
 * ever started on the spot. Only a file this pack wrote is replaced or removed; any other
 * system is refused, naming the systems that have one.
 */
async function reviveService(opts, verb, more = []) {
  if (!["install", "uninstall", "status"].includes(verb) || more.length) throw new CliError(REVIVE_USAGE, 2);
  const os = await serviceOs();
  if (os === "Linux") return reviveSystemd(opts, verb);
  if (os === "Darwin") return reviveLaunchd(opts, verb);
  throw new CliError(`The revive login service is built for Linux (a systemd user unit) and macOS (a launchd agent), not for ${os}: `
    + "nothing was written or removed. Run am revive by hand after a restart of this computer.");
}

/**
 * Which login service this computer takes: `uname -s`, the same name install.sh reads. A test
 * fakes `uname` on PATH, so both the installer and this command see one system.
 */
async function serviceOs() {
  const r = await runProgram("uname", ["-s"], { timeout: 10_000 });
  const name = r.code === 0 ? r.stdout.trim() : "";
  if (name) return name;
  return process.platform === "darwin" ? "Darwin" : process.platform === "linux" ? "Linux" : process.platform;
}

/** The command as people run it (the link install.sh makes, which an update keeps), else the wrapper beside this file. */
function reviveRunner() {
  const link = join(binDirOf(), "automagik-herdr");
  return existsSync(link) ? link : join(dirname(fileURLToPath(import.meta.url)), "automagik-herdr");
}

/** The PATH a login service keeps (#1418): the caller's, without a pane's guard folders or a project's bins. */
function reviveKeptPath() {
  // A pane's guard folders (this copy's, am's, or an older version's) never become the boot pass's.
  const guardWord = (dir) => isGuardFolder(dir) || looksLikeGuardFolder(dir);
  return servicePath(process.env.PATH ?? "", { binDir: binDirOf(), venv: process.env.VIRTUAL_ENV ?? null, drop: guardWord });
}

/** The service's environment: the kept PATH, and the app home when it isn't the default. */
const reviveServiceEnv = (keptPath) => ({ ...(process.env.HERDR_APP_HOME ? { HERDR_APP_HOME: appHome() } : {}), PATH: keptPath });

/** `revive service ...` on Linux: the systemd user unit in ~/.config/systemd/user. */
async function reviveSystemd(opts, verb) {
  const unit = unitPath(home());
  const text = readText(unit);
  const systemctl = (args) => runProgram("systemctl", ["--user", ...args], { timeout: 20_000 });
  const said = (r) => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;
  if (verb === "status") {
    const enabled = text !== null ? (await systemctl(["is-enabled", UNIT_NAME])).code === 0 : false;
    const out = { path: unit, installed: text !== null, ours: unitIsOurs(text), enabled,
      ...(text !== null ? { path_kept: unitKeepsPath(text) } : {}) };
    return opts.json ? out : !out.installed ? `The revive login service isn't installed (${unit}).`
      : `${unit}: ${out.ours ? "Automagik Herdr's" : "not one Automagik Herdr wrote"}, ${enabled ? "enabled" : "not enabled"}.`
        + (out.ours && !out.path_kept ? " It keeps no PATH, so after a restart it may start other agent programs than your terminal does: rerun am revive service install." : "");
  }
  if (text !== null && !unitIsOurs(text)) throw new CliError(`${unit} is there and isn't one Automagik Herdr wrote, so it was left as it is.`);
  const notes = [];
  if (verb === "uninstall") {
    if (text === null) return opts.json ? { path: unit, removed: false, notes } : `The revive login service isn't installed (${unit}).`;
    const off = await systemctl(["disable", UNIT_NAME]);
    if (off.code !== 0) notes.push(`systemctl --user disable ${UNIT_NAME} failed (${said(off)}).`);
    unlinkSync(unit);
    await systemctl(["daemon-reload"]);
    return opts.json ? { path: unit, removed: true, notes } : [`Removed the revive login service (${unit}).`, ...notes].join("\n");
  }
  const runner = reviveRunner();
  const keptPath = reviveKeptPath();
  const unitBody = unitText({ runner, env: reviveServiceEnv(keptPath), wait: SERVICE_WAIT_S });
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, unitBody, { mode: 0o644 });
  const reload = await systemctl(["daemon-reload"]);
  const on = reload.code === 0 ? await systemctl(["enable", UNIT_NAME]) : reload;
  if (on.code !== 0) notes.push(`The unit is written but not enabled (systemctl --user: ${said(on)}); enable it with: systemctl --user daemon-reload && systemctl --user enable ${UNIT_NAME}`);
  notes.push("It runs at your next login after a restart of this computer. For bots that come back before anyone logs in: loginctl enable-linger.");
  notes.push("The unit keeps this PATH to find the agents and hc; rerunning am revive service install refreshes it.");
  return opts.json ? { path: unit, installed: true, enabled: on.code === 0, runner, kept_path: keptPath, notes }
    : [`Installed the revive login service (${unit}): after a restart it runs ${runner} revive --boot.`, ...notes].join("\n");
}

/**
 * `revive service ...` on macOS: a LaunchAgent in the person's own LaunchAgents (#939). Installing
 * writes the plist only: launchd loads it at the next login, and a bootstrap here would run the
 * pass now (RunAtLoad). Uninstalling asks launchd first, even when the plist is already gone, and
 * reads only exit 113 or launchctl's exact "Could not find service" as not loaded: any other
 * failure is a refusal that leaves the file and names the bootout command, so launchd never keeps
 * a label whose plist is gone and a second run can still boot out one an earlier run left.
 */
async function reviveLaunchd(opts, verb) {
  const plist = plistPath(home());
  const text = readText(plist);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const launchctl = (args) => runProgram("launchctl", args, { timeout: 20_000 });
  const said = (r) => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;
  const present = text !== null;
  const ours = plistIsOurs(text);
  if (verb === "status") {
    const enabled = present && ours;
    const out = { path: plist, label: PLIST_LABEL, installed: present, ours, enabled,
      ...(present ? { path_kept: plistKeepsPath(text) } : {}) };
    return opts.json ? out : !present ? `The revive login service isn't installed (${plist}).`
      : `${plist}: ${ours ? "Automagik Herdr's, runs at your next login" : "not one Automagik Herdr wrote"}.`
        + (ours && !out.path_kept ? " It keeps no PATH, so after a restart it may start other agent programs than your terminal does: rerun am revive service install." : "");
  }
  if (present && !ours) throw new CliError(`${plist} is there and isn't one Automagik Herdr wrote, so it was left as it is.`);
  const notes = [];
  if (verb === "uninstall") {
    // launchd is asked first, even when the plist is already gone: a run that removed the file
    // while launchd still held the label leaves an orphan, and only launchd can say. Only exit
    // 113 or launchctl's exact "Could not find service" means not loaded; any other failure is a
    // refusal, because taking the plist away then could orphan a job launchd still holds.
    const held = await launchctl(["print", `${domain}/${PLIST_LABEL}`]);
    const notLoaded = launchdNotLoaded(held);
    if (held.code === 127 && !held.killed) {
      const state = present ? `and ${plist} was left in place (removing it now could orphan the job)`
        : `and there is no plist at ${plist} (a label launchd still holds could not be checked)`;
      throw new CliError(`launchctl isn't here, so whether launchd holds ${PLIST_LABEL} can't be read, ${state}. `
        + `Run launchctl bootout ${domain}/${PLIST_LABEL}, then am revive service uninstall again.`);
    }
    if (held.code !== 0 && !notLoaded) {
      const why = held.killed ? "it timed out" : `it failed (${said(held)})`;
      const state = present ? `${plist} was left in place: removing it now could orphan the job`
        : `no plist is at ${plist}: a label launchd still holds was not ruled out`;
      throw new CliError(`launchctl couldn't say whether launchd holds ${PLIST_LABEL}: ${why}, so ${state}. `
        + `Run launchctl bootout ${domain}/${PLIST_LABEL}, then am revive service uninstall again.`);
    }
    const loaded = !notLoaded;
    if (!present) {
      if (!loaded) return opts.json ? { path: plist, label: PLIST_LABEL, removed: false, loaded: false, notes } : `The revive login service isn't installed (${plist}).`;
      // The plist is gone but launchd still holds the label (an earlier run removed it too early):
      // boot it out, so a second run is the way back instead of "isn't installed" and an orphan.
      const off = await launchctl(["bootout", `${domain}/${PLIST_LABEL}`]);
      if (off.code !== 0) {
        throw new CliError(`launchd still holds ${PLIST_LABEL} and its bootout failed (${said(off)}), so nothing was removed. `
          + `Run launchctl bootout ${domain}/${PLIST_LABEL}, then am revive service uninstall again.`);
      }
      return opts.json ? { path: plist, label: PLIST_LABEL, removed: false, loaded: true, booted_out: true, notes }
        : `The plist is gone (${plist}), but launchd still held ${PLIST_LABEL}: booted it out, so no orphaned label is left.`;
    }
    if (loaded) {
      const off = await launchctl(["bootout", `${domain}/${PLIST_LABEL}`]);
      if (off.code !== 0) {
        throw new CliError(`launchd still holds ${PLIST_LABEL} and its bootout failed (${said(off)}), so ${plist} was left in place: removing it now would orphan the job. `
          + `Run launchctl bootout ${domain}/${PLIST_LABEL}, then am revive service uninstall again.`);
      }
    }
    unlinkSync(plist);
    return opts.json ? { path: plist, label: PLIST_LABEL, removed: true, loaded, notes } : [`Removed the revive login service (${plist}).`, ...notes].join("\n");
  }
  // Install: the file is what launchd loads at the next login, never a bootstrap (RunAtLoad would
  // run the pass now). A plist already there and ours is replaced; anyone else's was refused above.
  const runner = reviveRunner();
  const keptPath = reviveKeptPath();
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, plistText({ runner, env: reviveServiceEnv(keptPath), wait: SERVICE_WAIT_S }), { mode: 0o644 });
  notes.push("launchd loads it at your next login after a restart of this computer, and it is not started now.");
  notes.push("The agent keeps this PATH to find the agents and hc; rerunning am revive service install refreshes it.");
  return opts.json ? { path: plist, label: PLIST_LABEL, installed: true, enabled: true, runner, kept_path: keptPath, notes }
    : [`Installed the revive login service (${plist}): after a restart it runs ${runner} revive --boot.`, ...notes].join("\n");
}

// ---- usagemeter on every linked machine (meterFleet.js) ----

const hcProgram = () => realHcPath();
/** meterFleet.js's runner: on a linked machine through `hc exec`, else here from the home folder. */
const meterRun = (argv, { on, timeout }) => (on
  ? runProgram(hcExecutable(hcProgram()), hcExecArgs(on, argv, timeout), { timeout: (timeout + 15) * 1000 }).then((r) => decodeExec(r, timeout))
  : runProgram(argv[0], argv.slice(1), { cwd: home(), timeout: timeout * 1000 }));

/** The linked machines (`{ name, connected }`), or `{ why }` when hc can't say. */
async function meterMachines() {
  if (!hcProgram()) return { why: "hc (herdr-core) is not on PATH" };
  const r = await runProgram(hcProgram(), ["machine", "ls", "--json"], { timeout: 20000 });
  if (r.code !== 0) return { why: `hc machine ls failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}` };
  return { machines: linkedMachines(r.stdout) };
}

/**
 * The install record after `results` (only a v2 one install.sh wrote; none: nothing is noted), the
 * scope an explicit `meter install` agreed to (`scope`: all, or local; never narrower than all), and
 * the meter-lane pointer's `sequence` it took (never lowered).
 */
function noteMeter(modsDir, results, scope = null, sequence = null) {
  const record = readMarker(modsDir);
  if (!record || record.v1) return;
  const usagemeterScope = scope === "all" || (scope === "local" && record.usagemeterScope !== "all") ? scope : record.usagemeterScope;
  const here = results.find((r) => r.machine === null);
  const usagemeter = here?.status === "installed" ? here.version : ["newer", "link", "unknown"].includes(here?.status) ? null : record.usagemeter;
  const usagemeterOn = recordAfter(record.usagemeterOn, results);
  const usagemeterSequence = Number.isSafeInteger(sequence) && !(record.usagemeterSequence > sequence) ? sequence : record.usagemeterSequence;
  if (usagemeter === record.usagemeter && usagemeterScope === record.usagemeterScope && usagemeterSequence === record.usagemeterSequence
    && JSON.stringify(usagemeterOn) === JSON.stringify(record.usagemeterOn)) return;
  writeMarker(modsDir, { ...record, usagemeter, usagemeterSequence, usagemeterOn, usagemeterScope });
}

/**
 * `meter install` / `meter uninstall`. One machine at a time; a machine that fails is a warning
 * line, and the command still succeeds (but `--machine M` failing exits 1).
 */
export async function cmdMeter(opts, [verb, ...rest], io = {}) {
  const modsDir = io.modsDir ?? defaultModsDir(process.env);
  if (rest.length) throw new CliError(`meter ${verb} takes no arguments (got ${rest.join(" ")}).`, 2);
  const results = [], notes = [];
  let lane = null;
  if (verb === "install") {
    if ([opts.machine !== undefined, opts.linked, opts.local].filter(Boolean).length > 1) throw new CliError("Give one of --machine, --linked and --local.", 2);
    // The signed pointer, read and checked here once, before any machine is asked anything: a
    // refusal (its signature, its fields, a sequence older than the record's) changes nothing.
    try {
      lane = await readMeterLane({ env: process.env, recorded: readMarker(modsDir)?.usagemeterSequence ?? null });
    } catch (e) { throw new CliError(`usagemeter: ${e?.message ?? e}.`); }
    if (opts.machine === undefined && !opts.linked) results.push(await installOn(meterRun, null, lane));
    if (!opts.local) {
      const found = await meterMachines();
      if (found.why) {
        if (opts.machine !== undefined) throw new CliError(`usagemeter on ${opts.machine}: ${found.why}.`);
        notes.push(`usagemeter on linked machines: skipped (${found.why}).`);
      }
      let list = found.machines ?? [];
      if (opts.machine !== undefined) {
        list = list.filter((m) => m.name === opts.machine);
        if (!list.length) throw new CliError(`No linked machine "${opts.machine}" (hc machine ls).`, 2);
      }
      for (const m of list) results.push(m.connected ? await installOn(meterRun, m.name, lane) : { machine: m.name, status: "disconnected" });
    }
  } else if (verb === "uninstall") {
    if (opts.machine !== undefined || opts.linked || opts.local) throw new CliError("meter uninstall takes no --machine, --linked or --local.", 2);
    const owned = readMarker(modsDir)?.usagemeterOn ?? {};
    const names = Object.keys(owned);
    const pocket = join(modsDir, POCKET_LINK);
    const found = names.length && !existsSync(pocket) ? await meterMachines() : {};
    for (const name of names) {
      const m = found.machines?.find((k) => k.name === name);
      if (existsSync(pocket)) results.push({ machine: name, status: "kept", why: `Pocket Link (${pocket}) runs it too` });
      else if (found.why) results.push({ machine: name, status: "kept", why: found.why });
      else if (!m?.connected) results.push({ machine: name, status: "kept", why: m ? "the machine is not connected" : "no such linked machine any more" });
      else results.push(await uninstallOn(meterRun, name, owned[name]));
    }
  } else {
    throw new CliError(`meter needs install or uninstall${verb ? `, not "${verb}"` : ""}.`, 2);
  }
  // An explicit `meter install` is the person's yes (install.sh's own run passes --linked
  // and records its scope itself; `update` asks only within the scope already agreed).
  const agreed = verb === "install" && !opts.linked && opts.machine === undefined ? (opts.local ? "local" : "all") : null;
  try { noteMeter(modsDir, results, agreed, lane?.pointer.sequence ?? null); } catch (e) { notes.push(`usagemeter: the install record could not note it (${e?.message ?? e}).`); }
  if (opts.machine !== undefined && results.some((r) => r.status === "failed" || r.status === "disconnected")) {
    throw new CliError(results.map(resultLine).join("\n").replace(/^Warning: /, ""));
  }
  if (opts.json) return { results, notes };
  return [...results.map(resultLine), ...notes].join("\n")
    || (verb === "install" ? "usagemeter: no connected linked machine (hc machine ls)." : "usagemeter: no linked machine has the pack's usagemeter.");
}

// ---- every linked machine follows the lanes (machineUpdates.js, #954) ----

/** `machines --auto on|off|status [--machine M]`: the machine's own switch, read or written there. */
async function machinesAuto(opts) {
  if (!["on", "off", "status"].includes(opts.auto)) throw new CliError("--auto takes on, off or status.", 2);
  if (opts.linked || opts.local) throw new CliError("machines --auto takes --machine M, or nothing for this computer.", 2);
  const machine = opts.machine ?? null;
  if (machine !== null) await connectedMachine(machine, opts.auto === "status" ? "nothing was read" : "nothing was changed");
  let on;
  if (opts.auto === "status") {
    const p = await probeOn(meterRun, machine);
    if (p.why) throw new CliError(`The setting was not read${machine ? ` on ${machine}` : ""}: ${p.why}`);
    on = p.auto;
  } else {
    const r = await meterRun(["sh", "-c", SET_AUTO, "sh", opts.auto], { on: machine, timeout: 30 });
    if (r.code !== 0) throw new CliError(`The setting was not saved${machine ? ` on ${machine}` : ""}: ${(r.stderr || `exit ${r.code}`).trim().split("\n").pop()}`);
    on = opts.auto === "on";
  }
  if (opts.json) return { machine, on };
  return `Updates from the Herdr ${machine ?? "this computer"} is linked into: ${on ? "on" : "off"}.${on ? "" : " Nothing is updated there until `am machines --auto on`."}`;
}

/**
 * `machines`: the record of what this computer and each linked machine run and how its last
 * update went; `machines update`: one cycle now (machineUpdates.js updateOn, one machine at a
 * time, one cycle at a time); `machines --auto`: a machine's own switch. `io` is the tests'
 * (env, modsDir). The record and the lock live in the app home's automagik-herdr folder; with no
 * app home (Herdr is not set up here) a cycle still runs and nothing is kept.
 */
export async function cmdMachines(opts, [verb, ...rest] = [], io = {}) {
  const env = io.env ?? process.env;
  const modsDir = io.modsDir ?? defaultModsDir(env);
  if (rest.length || (verb !== undefined && verb !== "update")) throw new CliError(`machines takes update or nothing${verb ? `, not "${[verb, ...rest].join(" ")}"` : ""}.`, 2);
  if (opts.auto !== undefined) {
    if (verb) throw new CliError("Give --auto alone, without update.", 2);
    return machinesAuto(opts);
  }
  if ([opts.machine !== undefined, opts.linked, opts.local].filter(Boolean).length > 1) throw new CliError("Give one of --machine, --linked and --local.", 2);
  const stateDir = stateDirOf(modsDir);
  const file = join(stateDir, MACHINES_STATE);
  const readState = () => { try { return parseState(readFileSync(file, "utf8")); } catch { return parseState(""); } };
  if (verb === undefined) {
    if (opts.linked || opts.local) throw new CliError("--linked and --local go with machines update.", 2);
    const state = readState();
    const found = await meterMachines();
    let linked = (found.machines ?? []).map((m) => m.name);
    if (opts.machine !== undefined) {
      if (!state.machines[opts.machine] && !linked.includes(opts.machine)) throw new CliError(`No linked machine "${opts.machine}" (hc machine ls).`, 2);
      linked = [opts.machine];
      state.here = null;
      state.machines = state.machines[opts.machine] ? { [opts.machine]: state.machines[opts.machine] } : {};
    }
    if (opts.json) return { ...state, linked };
    return stateLines(state, linked).join("\n") || "No machine has been checked yet: am machines update.";
  }
  if (updatesOff(env)) {
    if (opts.json) return { disabled: true, entries: [], notes: [] };
    return `Update checks are off (${NO_UPDATE_ENV}=1): nothing was updated anywhere.`;
  }
  const cycle = async () => {
    const notes = [];
    const record = readMarker(modsDir);
    const scope = meterScope(record);
    // The meter-lane pointer: read and checked here once, and only if some machine's usagemeter follows it.
    let lane = null;
    const laneOnce = () => (lane ??= readMeterLane({ env: process.env, recorded: record?.usagemeterSequence ?? null })
      .catch((e) => ({ why: String(e?.message ?? e).split("\n")[0] })));
    const found = opts.local ? { machines: [] } : await meterMachines();
    if (found.why) {
      if (opts.machine !== undefined) throw new CliError(`${opts.machine}: ${found.why}.`);
      notes.push(`Linked machines: skipped (${found.why}).`);
    }
    let list = found.machines ?? [];
    if (opts.machine !== undefined) {
      list = list.filter((m) => m.name === opts.machine);
      if (!list.length) throw new CliError(`No linked machine "${opts.machine}" (hc machine ls).`, 2);
    }
    const entries = [];
    if (opts.machine === undefined && !opts.linked) entries.push(await updateOn(meterRun, null, { lane: laneOnce, scope }));
    for (const m of list) {
      entries.push(m.connected ? await updateOn(meterRun, m.name, { lane: laneOnce, scope })
        : { machine: m.name, at: new Date().toISOString(), result: "disconnected", steps: [], why: [] });
    }
    const taken = lane ? await lane : null;
    try { noteMeter(modsDir, meterResults(entries), null, taken?.pointer?.sequence ?? null); } catch (e) { notes.push(`usagemeter: the install record could not note it (${e?.message ?? e}).`); }
    return { entries, notes, linked: found.machines && opts.machine === undefined && !opts.local ? found.machines.map((m) => m.name) : null };
  };
  let done;
  if (!existsSync(dirname(stateDir))) {
    done = await cycle();
    done.notes.push(`No Herdr app home here (${dirname(stateDir)}): the result is not kept.`);
  } else {
    mkdirSync(stateDir, { recursive: true });
    const run = async () => {
      const out = await cycle();
      const next = stateAfter(readState(), out.entries, { at: new Date().toISOString(), linked: out.linked });
      const tmp = `${file}.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, file);
      return out;
    };
    try {
      done = await withLockAsync(join(stateDir, MACHINES_LOCK), run, { wait: 0, what: "the machines' update" });
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`Not updated: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  if (opts.machine !== undefined && done.entries.some((e) => e.result === "failed" || e.result === "disconnected")) {
    throw new CliError(done.entries.map(entryLine).join("\n"));
  }
  if (opts.json) return { entries: done.entries, notes: done.notes };
  return [...done.entries.map(entryLine), ...done.notes].join("\n");
}

/**
 * `dsh-tui install|update|uninstall|doctor` (#561): DSH as a Herdr agent, in its own `dsh-tui`
 * profile, through the pinned dsh-TUI and the `dsh-tui` shim. `update` is the same idempotent
 * install (a newer pin in a later pack replaces it). Local only: the profile is this computer's.
 */
export async function cmdDshTui(opts, [verb, ...rest], io = {}) {
  if (rest.length) throw new CliError(`dsh-tui ${verb ?? ""} takes no arguments (got ${rest.join(" ")}).`, 2);
  if (!["install", "update", "uninstall", "doctor"].includes(verb)) throw new CliError(`dsh-tui needs install, update, uninstall or doctor${verb ? `, not "${verb}"` : ""}.`, 2);
  const env = io.env ?? process.env;
  if (verb === "doctor") {
    let roster = [];
    let projectKey = typeof opts?.project === "string" ? resolvePath(opts.project) : null;
    let projectFile = null;
    let app = null;
    let rosterError = null;
    try {
      const project = io.project ?? await projectFor(opts);
      roster = project.file.bots;
      projectKey = project.key;
      projectFile = project.file;
    } catch (e) {
      rosterError = String(e?.message ?? e).replace(/\s+/g, " ");
    }
    const r = doctorDshTui({ env, forbiddenRoots: io.forbiddenRoots, project: projectKey, getuid: io.getuid });
    r.bots = [];
    if (rosterError !== null) {
      r.checks.push({ check: "roster", ok: false,
        detail: rosterError, fix: "repair the project roster" });
      r.code = 1;
    } else {
      try {
        const approval = approvedProxyState({ project: projectKey, bot: { id: "" }, env });
        if (approval.error) r.checks.push({ check: "approved-roster", ok: true, warning: true,
          detail: approval.error, fix: "am proxy approve (review the diff)" });
        app = env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app");
        let attachRows = [];
        try { attachRows = readAttachFile(attachPath(app)) ?? []; } catch { attachRows = []; }
        const bindings = foldAttach(attachRows).byBot;
        r.bots = await doctorBotProxies({ bots: roster, project: projectKey,
          bindings, env });
      } catch (e) {
        r.checks.push({ check: "roster", ok: false,
          detail: String(e?.message ?? e).replace(/\s+/g, " "), fix: "repair the project roster" });
        r.code = 1;
      }
    }
    const byId = new Map(roster.map((b) => [b.id, b]));
    const projects = projectKey && projectFile && roster.some((b) => b.leadProject || b.crossMembers?.length)
      ? collectProjectMap({
        project: projectKey,
        file: projectFile,
        appHome: app,
        readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
        listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
      })
      : null;
    // #823: whether agy's terminal sandbox, and so --mode, can work on this host, from local
    // evidence only; a host with no Antigravity bot or worker needs no row.
    const agyBots = roster.filter((b) => b.agent === "antigravity" || resolveAgent(b.worker?.agent ?? "") === "antigravity");
    if (agyBots.length) {
      const read = (path) => {
        try { return readFileSync(path, "utf8"); } catch (e) { return e?.code === "ENOENT" ? null : undefined; }
      };
      const sandbox = agySandbox({ platform: process.platform, read });
      r.checks.push({ check: "agy-sandbox", ok: true, warning: sandbox.state === "missing",
        detail: sandbox.state === "available" ? `${sandbox.detail}: Antigravity's --mode takes effect`
          : sandbox.state === "missing"
            ? `${sandbox.detail}, so agy's terminal sandbox is unavailable and --mode auto is not available here `
              + "(agy continues in its default mode and says so only in print mode): "
              + "the launch runs without prompts on --dangerously-skip-permissions, under its deny list"
            : `Antigravity's terminal sandbox is unverified (${sandbox.detail}), so whether --mode takes effect is unknown` });
    }
    for (const bot of r.bots) {
      const state = bot.hcProxyState;
      const needsApproval = state.working && state.approved !== true;
      const ok = !bot.applicable || (!needsApproval
        && (state.approved !== true || !bot.terminal || bot.up));
      const agent = byId.get(bot.id);
      const agy = agent?.agent === "antigravity" ? `agy mode ${agyModeOf(agent.agyMode)}; ` : "";
      // The effective allow and deny lists each Antigravity launch of this bot carries: its
      // seat's, and its worker defaults' (a task's worktree is added to a worker's at launch).
      const seatAgy = agent?.agent === "antigravity" && projectKey
        ? agyPermissionPlan({ bot: agent, scope: "seat", folder: projectKey, realpath: realDir, homeDir: home() }) : null;
      const workerAgent = agent && !agent.worker?.template ? resolveAgent(agent.worker?.agent ?? agent.agent) : null;
      const workerRoleOf = agent ? workerRole(agent).role : null;
      const workerAgy = workerAgent === "antigravity"
        ? agyPermissionPlan({ bot: agent, scope: "worker", role: workerRoleOf, folder: null, realpath: realDir,
          homeDir: home() }) : null;
      // #884 M1/#1046: a review worker is read-only, but its own worktree is trusted like any
      // writer's; the worktree is only known at launch, so the plan names it as such.
      const workerTrusted = ["<worktree>"];
      if (seatAgy) bot.agyPermissions = { allow: seatAgy.allow, deny: seatAgy.deny, trustedWorkspaces: seatAgy.trustedWorkspaces };
      if (workerAgy) bot.workerAgyPermissions = { allow: workerAgy.allow, deny: workerAgy.deny, trustedWorkspaces: workerTrusted };
      const perms = [
        seatAgy ? `agy trusted ${seatAgy.trustedWorkspaces.join(", ") || "-"}; agy allow ${seatAgy.allow.join(", ")}; `
          + `agy deny ${seatAgy.deny.join(", ")}` : "",
        workerAgy ? `worker agy trusted ${workerTrusted.join(", ") || "-"}; worker agy allow ${workerAgy.allow.join(", ")}; `
          + `worker agy deny ${workerAgy.deny.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      // The lists are a guardrail against accidents, never the boundary: say so wherever they print.
      const guardrail = perms ? "these lists are a guardrail against accidents, not a security boundary: "
        + "a rule matches word prefixes only (a force refspec with + attached, combined short flags like -fu, "
        + "and a reset reaching --hard after other words aren't caught); a review launch's git subcommands "
        + "take every argument, so some write; allowing node, bun or git with any arguments lets a determined "
        + "agent do anything" : "";
      r.checks.push({ check: `hc-proxy:${bot.id}`, ok, warning: bot.warning === true,
        detail: `${bot.name}: ${agy}${perms ? `${perms}; ${guardrail}; ` : ""}hcProxy ${proxyStateText(state)}; ${bot.detail}`,
        ...(seatAgy ? { agyPermissions: { allow: seatAgy.allow, deny: seatAgy.deny, trustedWorkspaces: seatAgy.trustedWorkspaces } } : {}),
        ...(workerAgy ? { workerAgyPermissions: { allow: workerAgy.allow, deny: workerAgy.deny, trustedWorkspaces: workerTrusted } } : {}),
        fix: needsApproval ? "am proxy approve (review the diff), then restart"
          : !ok || bot.warning ? `am restart ${bot.id}` : null });
      if (!ok) r.code = 1;
      if (agent?.leadProject && projectFile) {
        const eff = effectiveLead(projectFile, bot.id, { project: projectKey, projects });
        bot.lead = eff.lead || agent.lead;
        bot.leadProject = eff.leadProject ?? agent.leadProject;
        if (eff.warning) bot.leadWarning = eff.warning;
        r.checks.push({
          check: `lead:${bot.id}`,
          ok: !eff.warning,
          detail: eff.warning ?? `${bot.name}: lead ${eff.leadBot?.name ?? eff.lead} (${eff.lead}) in ${eff.leadProject}`,
          fix: eff.warning ? `am edit ${bot.id} --lead <bot> --lead-project <dir>` : null,
        });
        if (eff.warning) r.code = 1;
      }
      if (agent?.crossMembers?.length && projectFile) {
        const warns = crossMemberWarnings(projectFile, bot.id, { project: projectKey, projects });
        for (const w of warns) {
          r.checks.push({
            check: `cross-member:${bot.id}`,
            ok: false,
            detail: `${bot.name}: ${w}`,
            fix: `am edit <member> --project <dir> --lead ${bot.id} --lead-project ${projectKey}`,
          });
          r.code = 1;
        }
      }
    }
    exitAfter.code = r.code;
    return opts.json ? r : r.checks.map((c) => `${!c.ok ? "FAIL" : c.warning ? "WARN" : "ok  "} ${c.check}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`).join("\n");
  }
  // A test's own publish time: the registry is never reached for a file:// run or a unit test.
  const published = Object.hasOwn(env, "AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED")
    ? (env.AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED || null) : undefined;
  const r = verb === "uninstall"
    ? uninstallDshTui({ env, exec: io.exec, forbiddenRoots: io.forbiddenRoots })
    : await installDshTui({ env, exec: io.exec, forbiddenRoots: io.forbiddenRoots, ...(published === undefined ? {} : { publishedAt: published }) });
  exitAfter.code = r.status === "failed" ? 1 : 0;
  const lines = r.lines?.length ? r.lines : [r.detail];
  return opts.json ? r : lines.join("\n");
}

/**
 * After `update` installed a pack: that pack's own `meter install` (the build the signed meter-lane
 * pointer names now, checked with that pack's keys), as install.sh's scope says. Lines to print;
 * never throws.
 */
export async function meterAfterUpdate(io) {
  const modsDir = io.modsDir ?? defaultModsDir(io.env ?? process.env);
  const scope = meterScope(readMarker(modsDir));
  if (scope === "none") return { lines: ["usagemeter: skipped (install.sh --no-usagemeter)."], results: [] };
  // Nobody asked (an older install.sh recorded no --no-usagemeter): nowhere, and how to opt in.
  if (!scope) return { lines: [OPT_IN], results: [] };
  const args = ["meter", "install", "--json", ...(scope === "local" ? ["--local"] : [])];
  let r;
  if (io.meter) r = await io.meter(args);
  else if (io.modsDir) return { lines: [], results: [] };
  else r = await runProgram(process.execPath, [join(modsDir, PACK_NAME, "bin", "automagik-herdr.mjs"), ...args], { timeout: 30 * 60 * 1000 });
  try {
    const out = JSON.parse(r.stdout);
    return { lines: [...out.results.map(resultLine), ...(out.notes ?? [])], results: out.results };
  } catch {
    return { lines: [`Warning: usagemeter was not checked: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop()}. Run \`am meter install\` to retry.`], results: [] };
  }
}

/**
 * `proxy approve --project <dir>` (#631 PR C1): the one writer of a project's approved roster
 * record. It reads the project's working .herdr/bots.json, prints the diff from the previous
 * approval, then writes the record 0600 under the data root, outside the project. `--project`
 * is mandatory: the record is keyed by the project's canonical main-checkout realpath.
 */
export async function cmdProxy(opts, [verb, ...rest], { forbiddenRoots } = {}) {
  if (verb !== "approve") {
    const extra = verb ? `, not "${verb}"` : "";
    throw new CliError(`proxy needs approve${extra}: proxy approve --project <dir>.`, 2);
  }
  if (rest.length) {
    throw new CliError(`proxy approve takes no argument after --project `
      + `(got ${rest.join(" ")}).`, 2);
  }
  if (opts.project === undefined)
    throw new CliError("proxy approve needs --project <dir>: the project to approve.", 2);
  const project = await namedKeyOf(opts.project);
  const unsafe = approvedDataRootProblem({ env: process.env, project, appHome: appHome(),
    forbiddenRoots });
  if (unsafe) throw new CliError(unsafe);
  const countOf = (record) => JSON.parse(record.roster).bots.length;
  let result;
  try {
    result = approveProject({
      project,
      beforeWrite: ({ diff, record, previous, note }) => {
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({
            project, key: projectKey(project), record: recordFileOf(project),
            approvedAt: record.approvedAt, approvedBy: record.approvedBy,
            bots: countOf(record), previous, note, diff,
          }, null, 2)}\n`);
          return;
        }
        process.stdout.write(`approved ${countOf(record)} bots for ${project}\n`);
        if (note) process.stdout.write(`note: ${note}\n`);
        if (diff.length) for (const line of diff) process.stdout.write(`${line}\n`);
        else process.stdout.write("no roster changes from the previous approval\n");
      },
    });
  } catch (e) {
    throw new CliError(`proxy approve: ${e?.message ?? e}`);
  }
  if (opts.json) return PRINTED;
  process.stdout.write(`record: ${result.path} (0600)\n`);
  return PRINTED;
}

/**
 * `doc get <name> [--machine M]`: a herdr-core doc's value as JSON on stdout (docGet.mjs: doc.get
 * through hc connect, read-only), for a mod that can only exec a program. Exit 3 when the doc is
 * not there, 2 for a usage mistake, 1 for any other failure.
 */
export async function cmdDoc(opts, [verb, name, ...rest]) {
  if (verb !== "get") throw new CliError(`doc needs get${verb ? `, not "${verb}"` : ""}: doc get <name> [--machine M].`, 2);
  if (name === undefined) throw new CliError("doc get needs a doc name.", 2);
  if (rest.length) throw new CliError(`doc get takes one name (got ${[name, ...rest].join(" ")}).`, 2);
  let value;
  try {
    value = await docGet(name, { machine: opts.machine, hc: hcExecutable(realHcPath()) });
  } catch (e) {
    if (e instanceof DocError) throw new CliError(e.message, e.code);
    throw e;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return PRINTED;
}

/**
 * `launch-path <program>` (#453): { program, path }: the file a launch of `program` runs
 * (programPath) and the PATH its pane gets (launchPath), both null when it isn't found. The
 * Accounts panel runs `claude auth status` from there, so it finds claude the way launches do.
 */
export async function cmdLaunchPath(_opts, [program, ...rest]) {
  if (!program || program.startsWith("-") || rest.length) throw new CliError("launch-path takes one program name.", 2);
  const file = programPath(program);
  process.stdout.write(`${JSON.stringify({ program: file, path: file ? launchPath(program).path : null })}\n`);
  return PRINTED;
}

const COMMANDS = { ls: cmdLs, show: cmdShow, create: cmdCreate, edit: cmdEdit, main: cmdMain, rm: cmdRm, category: cmdCategory,
  start: cmdStart, restart: cmdRestart, attach: cmdAttach, detach: cmdDetach, import: cmdImport, whois: cmdWhois, history: cmdHistory, brief: cmdBrief, update: cmdUpdate,
  tidy: cmdTidy, forget: cmdForget, worker: cmdWorker, reap: cmdReap, meter: cmdMeter, machines: cmdMachines, "dsh-tui": cmdDshTui, doc: cmdDoc,
  proxy: cmdProxy, "launch-path": cmdLaunchPath, revive: cmdRevive, "rate-limit": cmdRateLimit };
const NEEDS_BOT = new Set(["show", "edit", "rm", "start", "restart", "attach", "detach", "history", "brief"]);

/** Runs one command line; resolves with the exit code. Output goes to stdout, problems to stderr. */
export async function main(argv = process.argv.slice(2), io = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    process.stderr.write(`am: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values: opts, positionals, tokens } = parsed;
  const [command, ...rest] = positionals;
  if (command !== "main") {
    if (opts["old-lead"] !== undefined) { report(["--old-lead is only for main."]); return 2; }
    io.repairCliLinks?.();
  }
  // The pack this command belongs to (its VERSION file; 0.0.0 for a checkout never released).
  if (opts.version && !command) {
    let version = "0.0.0";
    try { version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim() || version; } catch { /* no VERSION file */ }
    process.stdout.write(opts.json ? `${JSON.stringify({ version })}\n` : `am ${version}\n`);
    return 0;
  }
  if (opts.help && command === "proxy") { process.stdout.write(`${PROXY_USAGE}\n`); return 0; }
  if ((opts.help && command !== "main") || !command || command === "help") {
    process.stdout.write(`${USAGE}\n`); return command || opts.help ? 0 : 2;
  }
  const run = COMMANDS[command];
  if (!run) { process.stderr.write(`am: unknown command "${command}"\n\n${USAGE}\n`); return 2; }
  try {
    if (command === "main") checkMainArgs(rest, tokens);
    if (NEEDS_BOT.has(command) && !rest[0] && !(command === "restart" && (opts.queued || opts["run-queued"] || opts.due))) throw new CliError(`${command} needs a bot (its id or name).`, 2);
    if (opts.machine !== undefined && !ON_MACHINE.has(command)) {
      throw new CliError(`${command} works on this computer only for now; --machine goes with ls, show, create, edit, main, rm, category, start, restart, attach, detach, whois, history, meter, machines and doc.`, 2);
    }
    exitAfter.code = 0;
    // Tidy is this computer's window and labels: never after a command on a linked machine.
    const tidy = TIDIES.has(command) && opts.machine === undefined;
    const warnedRelabels = tidy && (command === "start" || command === "attach") ? new Set() : undefined;
    const out = command === "proxy" ? await run(opts, rest, io) : await run(opts, rest, warnedRelabels);
    if (out === PRINTED) return exitAfter.code;
    const tidyBeforeJson = warnedRelabels !== undefined && opts.json;
    if (tidyBeforeJson) {
      const warnings = await tidyQuietly(warnedRelabels);
      if (warnings.length) (out.warnings ??= []).push(...warnings);
    }
    if (opts.json) process.stdout.write(unprinted(`${JSON.stringify(out, null, 2)}\n`));
    else if (out) process.stdout.write(unprinted(`${out}\n`));
    if (tidy) {
      if (!tidyBeforeJson) await tidyQuietly(warnedRelabels);
      await recordSessions();
    }
    return exitAfter.code;
  } catch (e) {
    const botAction = command === "start" || command === "restart";
    if (botAction) {
      try {
        const dir = join(appHome(), "automagik-herdr");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, "actions.log"), unprinted(`${new Date().toISOString()} ${command}: ${e?.stack ?? e}\n`), { mode: 0o600 });
      } catch { /* A log that cannot be written must not hide the original failure. */ }
    }
    const message = e instanceof CliError ? e.message : botAction
      ? actionError(e, command === "start" ? "Start" : "Restart") : `${e?.stack ?? e}`;
    process.stderr.write(unprinted(`am: ${message}\n`));
    if (opts.json && e instanceof CliError && (e.detail || command === "main")) {
      process.stdout.write(unprinted(`${JSON.stringify({ error: message, ...e.detail }, null, 2)}\n`));
    }
    return e instanceof CliError ? e.code : 1;
  }
}

// Run as a program (also through the ~/.local/bin symlink, hence the realpath), not on import.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (import.meta.url === invoked) {
  // An update made by an older CLI (0.3.4 and before) left the link on the .mjs, which needs node
  // on PATH. Repair those links on startup outside main, whose preview and refusals are read-only.
  process.exitCode = await main(undefined, { repairCliLinks: () => {
    try { relinkCli(); } catch { /* the link stays; `automagik-herdr update` reports why */ }
  } });
}
