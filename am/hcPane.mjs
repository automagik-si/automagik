#!/usr/bin/env node
// The per-pane helper for the hc proxy (#631 PR B): one helper per pane, started as the pane's
// program by startArgs/workerArgs for a dsh-tui agent. It starts the proxy *before* DSH, and so
// before the pane can create a sandbox, then runs the real pane command as its child. The proxy
// is in this process and closes when the child ends, so the helper is the whole per-pane
// lifecycle: no service, no second process to reap.
//
// The caller is resolved here, outside the sandbox: the pack passes --bot and --project, and
// the proxy still checks the pane's own label. A worker's project is mandatory: it is the main
// checkout the pack resolved (its lead seat's project), never the worktree the worker owns.
// The proxy reads that project's approved roster before DSH starts; a sandbox cannot write the
// record (the data root is bound read-only). The pane gets DSH_SANDBOX_MASK=1,
// AM_HC_REAL_SOCKET and AM_HC_PROXY_SOCKET; the mask wrapper binds the proxy at the real path
// and hides the real socket folder.
//
// Fail closed: if the proxy cannot start (the pin, the caller, the roster, the socket folder),
// the pane's command is never started, so no sandbox exists and hc cannot auto-start a core.
//
// Apache-2.0.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executionPathProblem, sandboxRootOf, sandboxState } from "./dshTui.mjs";
import { projectOfFolder, startProxy } from "./hcProxy.mjs";

/** Every line this helper prints starts with this. */
export const MSG_PREFIX = "hc-pane: ";

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

const USAGE = `usage: hcPane.mjs [--bot <id> [--project <dir>] [--worker]] [--app-home <dir>] -- <command...>
  --bot        the bot this pane plays (the pack passes it; the proxy checks the pane's label)
  --project    the project folder whose approved roster the proxy reads (default: the one
               above the current folder; a worker must pass its main checkout)
  --worker     the pane is a worker (worker.of), not a bot seat
  --app-home   the app home holding automagik-herdr/attach.jsonl (default: HERDR_APP_HOME,
               else ~/.config/herdr-app)
  HC_TERMINAL_ID and HC_TERMINAL_SOCKET are set by hc inside the pane.`;

/** Parse the helper's own words: flags, then the command after the first `--`. */
export function parseArgs(argv) {
  const out = { bot: null, project: null, worker: false, appHome: null, command: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "--") { out.command = argv.slice(i + 1); return out; }
    if (word === "--help" || word === "-h") { out.help = true; continue; }
    if (word === "--worker") { out.worker = true; continue; }
    if (word === "--bot" || word === "--project" || word === "--app-home") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${word} needs a value`);
      if (word === "--bot") out.bot = value;
      else if (word === "--project") out.project = value;
      else out.appHome = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${word}`);
  }
  return out;
}

/** The environment the pane's command gets: the three mask names and the bound socket. */
export function paneEnv(env, upstream, proxySocket) {
  return {
    ...env,
    DSH_SANDBOX_MASK: "1",
    AM_HC_REAL_SOCKET: upstream,
    AM_HC_PROXY_SOCKET: proxySocket,
    // hc inside the sandbox must look at the path the wrapper binds the proxy onto, never at
    // the path it would otherwise derive and possibly auto-start a core on.
    HC_SOCKET: upstream,
  };
}

/**
 * Run one pane: start the proxy, then the command as its child. Resolves with the child's exit
 * code (or 1 for a signal); throws before starting the child when the proxy refuses.
 */
export async function runPane(argv = process.argv.slice(2), env = process.env, io = {}) {
  const spawnChild = io.spawn ?? spawn;
  const args = parseArgs(argv);
  if (args.help) {
    (io.stdout ?? process.stdout).write(`${USAGE}\n`);
    return 0;
  }
  if (!args.command.length) throw new Error("no command after --");
  const terminal = String(env.HC_TERMINAL_ID ?? "");
  const upstream = String(env.HC_TERMINAL_SOCKET ?? "");
  if (!terminal) throw new Error("HC_TERMINAL_ID is not set: this is not an hc terminal");
  if (!upstream || !isAbsolute(upstream)) throw new Error("HC_TERMINAL_SOCKET is not an absolute socket path");
  // A worker's cwd is its worktree and it owns that worktree's .herdr/bots.json: the approved
  // record is the lead seat's project, which the pack resolved outside the sandbox. Never fall
  // back to the current folder for a worker.
  const project = args.project
    ?? (args.bot && !args.worker ? projectOfFolder(process.cwd()) : null);
  if (args.bot && !project) {
    throw new Error(args.worker
      ? "--project is required for a worker: the project's main checkout, never the worktree"
      : "--project is required (or the current folder must be inside a project)");
  }
  if (!args.bot && (args.worker || args.project)) throw new Error("--worker and --project need --bot");
  const caller = args.bot ? { bot: args.bot, project: resolve(project), worker: args.worker } : undefined;
  // The stable runner's baked node, the profile, the shim and the dsh it executes must still be
  // usable and outside the writable trees before any proxy or child exists.
  const executionProblem = executionPathProblem({ stableRoot: sandboxRootOf(env), env, project: caller?.project ?? process.cwd(), forbiddenRoots: io.forbiddenRoots });
  if (executionProblem) throw new Error(`the dsh-tui profile's sandbox is not usable (${oneLine(executionProblem)})`);
  // Without the profile's sandbox row the pane would run unsandboxed while we set the switch:
  // the real socket would stay reachable. Refuse before any proxy or child exists.
  const sandbox = sandboxState(env, { forbiddenRoots: io.forbiddenRoots });
  if (!sandbox.current || !sandbox.row.ok) {
    throw new Error(`the dsh-tui profile's sandbox row is not current (${oneLine(sandbox.row.message ?? "the row does not match")}); run am dsh-tui install`);
  }

  const proxy = await (io.startProxy ?? startProxy)({
    terminal,
    upstream,
    appHome: args.appHome ?? undefined,
    env,
    forbiddenRoots: io.forbiddenRoots,
    ...(caller ? { caller, bound: !caller.worker } : {}),
    log: (event) => {
      if (event.ev === "server_error" || event.ev === "error" || event.ev === "roster_unapproved") {
        (io.stderr ?? process.stderr).write(`${MSG_PREFIX}${oneLine(event.message ?? event.ev)}\n`);
      }
    },
  });
  const childEnv = paneEnv(env, upstream, proxy.socket);
  let child;
  let proxyLost = false;
  const stop = (signal) => {
    try { child?.kill(signal); } catch { /* already gone */ }
  };
  const lost = (error) => {
    if (proxyLost) return;
    proxyLost = true;
    (io.stderr ?? process.stderr).write(
      `${MSG_PREFIX}${oneLine(error?.message ?? "the proxy stopped")}; ending the pane\n`);
    stop("SIGTERM");
  };
  proxy.server.on("error", lost);
  proxy.server.on("close", lost);
  if (!proxy.server.listening) {
    await proxy.close().catch(() => {});
    throw new Error("the proxy is not listening; the pane was not started");
  }
  try {
    child = spawnChild(args.command[0], args.command.slice(1), { stdio: "inherit", env: childEnv });
  } catch (e) {
    proxy.server.off("error", lost);
    proxy.server.off("close", lost);
    await proxy.close().catch(() => {});
    throw new Error(`cannot start ${args.command[0]}: ${oneLine(e?.message ?? e)}`);
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = async (code, signal) => {
      if (done) return;
      done = true;
      for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signalName, stop);
      proxy.server.off("error", lost);
      proxy.server.off("close", lost);
      await proxy.close().catch(() => {});
      resolvePromise(proxyLost || signal ? 1 : code ?? 0);
    };
    child.on("error", async (e) => {
      (io.stderr ?? process.stderr).write(`${MSG_PREFIX}cannot run ${args.command[0]}: ${oneLine(e?.message ?? e)}\n`);
      await finish(127, null);
    });
    child.on("exit", (code, signal) => { finish(code, signal).catch(() => resolvePromise(1)); });
  });
}

/** Run the helper as a program; exit with its code and print one clear line on a refusal. */
async function main() {
  try {
    const code = await runPane();
    process.exitCode = code;
  } catch (e) {
    process.stderr.write(`${MSG_PREFIX}${oneLine(e?.message ?? e)}; the pane was not started\n`);
    process.exitCode = 1;
  }
}

/** Whether this file is the program Node started, comparing real paths (a symlink is the same file). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) main();
