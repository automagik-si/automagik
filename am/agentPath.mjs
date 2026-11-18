// The PATH an agent (a worker or a bot's seat) starts with, made able to run its own interpreter.
//
// An npm agent such as codex is a `#!/usr/bin/env node` script: nvm and Homebrew link
// `<prefix>/bin/codex` to `<prefix>/lib/node_modules/<pkg>/bin/codex.js`, next to
// `<prefix>/bin/node`. A pane whose PATH reaches the agent (or a link to it) but not node
// starts it into `env: node: No such file or directory`. interpreterPath reads the agent's
// shebang and, when its `env` interpreter (node or bun) isn't on the PATH the worker gets,
// puts the folder of one it finds first. It never removes anything from PATH and never
// changes it when the interpreter is already there. Only absolute folders that are safe,
// holding a safe interpreter file, are run or put on PATH: real paths whose every folder up
// to / is owned by this user or root and not world-writable (a root sticky /tmp passes). Not loaded by Herdr (node: imports); the CLI and the tests share it. Apache-2.0.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const executable = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
/** PATH's folders the CLI can judge: absolute ones (a relative one depends on the worker's cwd). */
const dirsOf = (path) => String(path ?? "").split(":").filter((d) => d && isAbsolute(d));
const UID = typeof process.getuid === "function" ? process.getuid() : null;

/**
 * Whether `p` resolves (through every link) to a file or folder that no one but this user or
 * root can swap: it and every folder above it, up to `/`, are owned by this user or root and
 * aren't world-writable, except a root-owned sticky folder (/tmp, /private/tmp), whose
 * entries only their owners can rename or remove.
 */
export function safe(p) {
  let at;
  try { at = realpathSync(p); } catch { return false; }
  for (;;) {
    let st;
    try { st = statSync(at); } catch { return false; }
    const owner = UID === null || st.uid === UID || st.uid === 0;
    const rootSticky = st.isDirectory() && st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (!owner || ((st.mode & 0o002) !== 0 && !rootSticky)) return false;
    const up = dirname(at);
    if (up === at) return true;
    at = up;
  }
}

/** The file `program` names: itself when it has a slash, else the first executable on `path`. */
export function whichOn(program, path) {
  if (program.includes("/")) return isAbsolute(program) && executable(program) ? program : null;
  for (const dir of dirsOf(path)) if (executable(join(dir, program))) return join(dir, program);
  return null;
}

/** env's options that take the next word as their argument (`-u NAME`, `-C dir`, `-P path`). */
const ENV_ARG_OPTIONS = new Set(["-u", "-C", "-P", "--unset", "--chdir"]);

/**
 * The interpreter a script's first line runs through `env`: `node` for `#!/usr/bin/env node`
 * (and `env -S node --flag`, `env -i VAR=x node`, `env -u NAME node`, a CRLF line), else null
 * (a binary, a direct `#!/bin/sh`).
 */
export function envInterpreter(firstLine) {
  const m = /^#!\s*(\S+)(.*)$/.exec(String(firstLine ?? "").replace(/\r$/, ""));
  if (!m || basename(m[1]) !== "env") return null;
  const words = m[2].trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (ENV_ARG_OPTIONS.has(word)) { i++; continue; }
    if (!word || word.startsWith("-") || word.includes("=")) continue;
    return word;
  }
  return null;
}

function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0];
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The folders to look in beside the agent: the folder of every hop of its link chain (the PATH
 * hit, each link's target, the real file), then `<prefix>/bin` when the real file sits under
 * `<prefix>/lib/node_modules/` (npm's global layout, which nvm and Homebrew both use). None
 * for a relative `file`.
 */
export function besideDirs(file) {
  if (!isAbsolute(file)) return [];
  const dirs = [];
  let at = file;
  for (let hop = 0; hop < 40; hop++) {
    dirs.push(dirname(at));
    let st;
    try { st = lstatSync(at); } catch { break; }
    if (!st.isSymbolicLink()) break;
    try { at = resolve(dirname(at), readlinkSync(at)); } catch { break; }
  }
  try {
    const real = realpathSync(file);
    dirs.push(dirname(real));
    const i = real.lastIndexOf("/lib/node_modules/");
    if (i > 0) dirs.push(join(real.slice(0, i), "bin"));
  } catch { /* a dangling link: the hops above */ }
  return [...new Set(dirs)];
}

/**
 * [major, minor, patch] from `<dir>/<name> --version` (v24.1.0 or 1.2.3), or null when it
 * doesn't run. Nothing is run unless the folder is absolute and safe and so is the file.
 */
function versionIn(dir, name) {
  const p = join(dir, name);
  if (!isAbsolute(dir) || !safe(dir) || !safe(p) || !executable(p)) return null;
  try {
    const out = execFileSync(p, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(out.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  } catch { return null; }
}
const newEnough = (v) => v && (v[0] > 22 || (v[0] === 22 && v[1] >= 7));
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** nvm's folder: $NVM_DIR, else $HOME/.nvm; null when the one that applies is relative. */
function nvmDir(env) {
  const dir = env.NVM_DIR ? env.NVM_DIR : env.HOME ? join(env.HOME, ".nvm") : null;
  return dir && isAbsolute(dir) ? dir : null;
}

/** run.sh's order past PATH: nvm's newest node 22.7+, then the Homebrew folders' (22.7+). */
function runtimeNodeDir(env) {
  let best = null;
  const nvm = nvmDir(env);
  let versions = [];
  try { if (nvm) versions = readdirSync(join(nvm, "versions/node")); } catch { /* no nvm */ }
  for (const v of versions) {
    const dir = join(nvm, "versions/node", v, "bin");
    const got = versionIn(dir, "node");
    if (newEnough(got) && (!best || newer(got, best.v) > 0)) best = { dir, v: got };
  }
  if (best) return best.dir;
  for (const dir of (env.AUTOMAGIK_HERDR_RUNTIME_DIRS ?? "/opt/homebrew/bin:/usr/local/bin").split(":")) {
    if (dir && isAbsolute(dir) && newEnough(versionIn(dir, "node"))) return dir;
  }
  return null;
}

/**
 * The PATH to start `program` with: `path` itself, or `path` with the folder of the agent's
 * interpreter put first when its `#!/usr/bin/env node|bun` line names one `path` lacks.
 * Looked for beside the agent first (any version that runs: the node that installed it),
 * then as bin/run.sh does: nvm's newest node 22.7+, Homebrew's 22.7+; for bun, ~/.bun/bin.
 * `note` is one line for the person (null when PATH is unchanged and nothing is missing).
 */
export function interpreterPath(program, path, env = process.env) {
  const same = { path, note: null };
  const file = program ? whichOn(program, path) : null;
  if (!file) return same;
  let real;
  try { real = realpathSync(file); } catch { return same; }
  const interp = envInterpreter(firstLine(real));
  if (interp !== "node" && interp !== "bun") return same;
  if (whichOn(interp, path)) return same;
  let dir = besideDirs(file).find((d) => versionIn(d, interp));
  if (!dir && interp === "node") dir = runtimeNodeDir(env);
  if (!dir && interp === "bun" && env.HOME) dir = [join(env.HOME, ".bun/bin")].find((d) => versionIn(d, "bun"));
  const name = basename(program);
  if (!dir) {
    return { path, note: `${name} runs under ${interp} (its #!/usr/bin/env ${interp} line), which isn't on PATH or beside it; `
      + `it may fail with "env: ${interp}: No such file or directory".` };
  }
  return { path: path ? `${dir}:${path}` : dir,
    note: `${name} runs under ${interp}, which isn't on its PATH: ${dir} put first on it.` };
}

// ---- an agent on a linked machine (#425) ----
//
// herdr-core there may run as a service (a systemd --user unit, launchd) whose PATH never saw the
// person's ~/.profile, and hc run has no --env. So the machine's login shell is asked for its
// PATH once; the check and the pane both use the PATH made from it, the pane through
// /usr/bin/env PATH=<it> as a local start does. An absolute path alone wouldn't do: codex is
// often a #!/usr/bin/env node script, and an agent runs git and its tools from PATH too.

/**
 * Run as `sh -c LOGIN_PATH_SH sh <command>`: <command> through the login shell ($SHELL, else
 * passwd's, else sh), no stdin and no stderr, its last 64 KiB of stdout kept (a profile may
 * print anything). The bound is hc exec's --timeout, which ends everything it started.
 */
export const LOGIN_PATH_SH = `s=\${SHELL:-}
[ -x "$s" ] || s=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
[ -x "$s" ] || s=/bin/sh
"$s" -lc "$1" </dev/null 2>/dev/null | tail -c 65536`;

/**
 * The command for LOGIN_PATH_SH: the same words in sh, bash, zsh and fish, and $PATH read from
 * the environment, so fish's list comes back joined by colons. A shell that can't run it says
 * nothing between the markers, and that is only "no answer".
 */
export const loginPathAsk = (marker) => `printf %s ${marker}-from; /usr/bin/env printenv PATH; printf %s ${marker}-to`;

/**
 * The PATH between this call's markers in what a login shell printed, its relative entries
 * (they would follow the pane's cwd) dropped; null when there is none or it isn't one line.
 * The last marker counts, since a profile prints before the command runs. This is text: it
 * only ever goes on as one argv word.
 */
export function loginPathOf(text, marker) {
  const out = String(text ?? "");
  const from = out.lastIndexOf(`${marker}-from`);
  const to = out.indexOf(`${marker}-to`, from);
  if (from < 0 || to < 0) return null;
  const value = out.slice(from + marker.length + 5, to).replace(/\n$/, "");
  // eslint-disable-next-line no-control-regex
  if (value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const dirs = [...new Set(value.split(":").filter((d) => d.startsWith("/")))];
  return dirs.length ? dirs.join(":") : null;
}

/**
 * Run as `sh -c AGENT_PATH_SH sh <agent> <login PATH or nothing> [<folders first>]`. On macOS
 * (`uname -s` = Darwin), checks `security show-keychain-info` first (`command -v security`, else
 * `/usr/bin/security`) and exits 4 with its first error line when it exits non-zero (#1033: an
 * SSH-born herdr-core has no login keychain access).
 * The PATH a
 * pane there gets: the folders first (a project's pane-env PATH_PREPEND, #582; none: nothing), then the login shell's, then what hc's own PATH adds (nothing that works today is lost), or the
 * other way round when hc's own PATH finds the agent as a file, so a machine that works keeps
 * the same agent and interpreter (#436); then the user bin folders that exist (a profile that
 * didn't answer, or doesn't add them), /usr/bin and /bin, and last the folders of the agent's
 * real file (npm's <prefix>/bin holds its node). Prints that PATH, the agent's absolute file and
 * its first line; exit 3 when no such file. The words are data here: none is ever evaluated.
 */
export const AGENT_PATH_SH = `if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  sec=$(command -v security 2>/dev/null); [ -x "$sec" ] || sec=/usr/bin/security
  if [ -x "$sec" ]; then
    err=$("$sec" show-keychain-info 2>&1) || { printf '%s\\n' "$err" | head -n 1; exit 4; }
  fi
fi
agent=$1 path= first=$2 rest=$PATH pre=$3
case $(command -v "$agent" 2>/dev/null) in /*) first=$PATH rest=$2 ;; esac
add() {
  case $1 in /*) ;; *) return ;; esac
  case ":$path:" in *":$1:"*) ;; *) path=\${path:+$path:}$1 ;; esac
}
set -f; IFS=:
for d in $pre $first $rest; do add "$d"; done
unset IFS; set +f
for d in "$HOME/.local/bin" "$HOME/.bun/bin" /usr/bin /bin; do [ -d "$d" ] && add "$d"; done
PATH=$path; export PATH
file=$(command -v "$agent") || exit 3
case $file in /*) ;; *) exit 3 ;; esac
real=$(readlink -f "$file" 2>/dev/null) && [ -n "$real" ] || real=$file
add "\${real%/*}"
case $real in */lib/node_modules/*) d=\${real%/lib/node_modules/*}/bin; [ -d "$d" ] && add "$d" ;; esac
printf '%s\\n%s\\n%s\\n' "$path" "$file" "$(head -c 256 "$real" 2>/dev/null | head -n 1)"`;

/**
 * Finds `program` on a linked machine, as a pane there will (`prepend`: colon-separated absolute
 * folders put first, paneEnvOf's; null: none): `exec(command, args, { timeout })`
 * runs one program there (hc exec) and resolves { code, stdout, stderr }, code -1 for no answer.
 * Resolves { state: "found", path, file, login } (path: the PATH to start it with; login: whether
 * the login shell answered, "timed out" when it was too slow), { state: "no-keychain", detail, login }
 * (macOS `security show-keychain-info` failed, #1033), { state: "missing", login },
 * { state: "no-interpreter", file, interpreter, login } (its #!/usr/bin/env program isn't on that
 * PATH, so env would fail in the pane) or { state: "away", why }. A login shell that is slow, broken
 * or silent is not a failure: the rest still answers. A machine that doesn't answer is.
 */
export async function agentOnMachine(exec, program, { wait = 10, prepend = null } = {}) {
  const marker = `am-path-${randomBytes(8).toString("hex")}`;
  const asked = await exec("sh", ["-c", LOGIN_PATH_SH, "sh", loginPathAsk(marker)], { timeout: wait });
  const timedOut = asked.code === -1 && /^timed out/.test(asked.stderr ?? "");
  // decodeExec's -1 with no words is a program ended by a signal (a profile that kills its shell): the machine answered.
  if (asked.code === -1 && !timedOut && asked.stderr) return { state: "away", why: asked.stderr };
  const path = loginPathOf(asked.stdout, marker);
  const login = path !== null ? true : timedOut ? "timed out" : false;
  const seen = await exec("sh", ["-c", AGENT_PATH_SH, "sh", program, path ?? "", ...(prepend ? [prepend] : [])], { timeout: wait });
  if (seen.code === -1) return { state: "away", why: seen.stderr };
  if (seen.code === 4) return { state: "no-keychain", detail: seen.stdout.trim(), login };
  if (seen.code !== 0) return { state: "missing", login };
  const [runPath, file, first] = seen.stdout.split("\n");
  const interpreter = envInterpreter(first);
  if (interpreter) {
    const r = await exec("/usr/bin/env", [`PATH=${runPath}`, "sh", "-c", 'command -v "$1"', "sh", interpreter], { timeout: wait });
    if (r.code === -1) return { state: "away", why: r.stderr };
    if (r.code !== 0) return { state: "no-interpreter", file, interpreter, login };
  }
  return { state: "found", path: runPath, file, login };
}

// ---- a project's pane environment on a linked machine (#582) ----

/** The file, under a project's folder on that machine: KEY=value lines, read there through hc. */
export const PANE_ENV_PATH = ".herdr/pane-env";
const PANE_ENV_KEYS = ["PATH_PREPEND", "HERDR_APP_HOME"];
const folder = (d) => d.replace(/\/+$/, "") || "/";
const shown = (text) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/**
 * A pane-env file's text: { prepend, appHome, error }. Its lines are KEY=value, the KEY one of
 * PATH_PREPEND (colon-separated absolute folders, put first on the pane's PATH) and HERDR_APP_HOME
 * (one absolute folder: the app home the pane and its briefing use there); blank lines and
 * # comments are skipped. Anything else (another key, a key twice, a relative or empty folder, a
 * folder with a space at its start or end, a control character, a line that isn't KEY=value)
 * refuses the whole file: { prepend: null,
 * appHome: null, error: "line N: why" }, and the start goes on as it would without it. No file
 * (null) is { prepend: null, appHome: null, error: null }. The values are data: never evaluated.
 */
export function paneEnvOf(text) {
  const got = {};
  const lines = typeof text === "string" ? text.split("\n") : [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, "");
    const refuse = (why) => ({ prepend: null, appHome: null, error: `line ${i + 1}: ${why}` });
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(line)) return refuse("a control character");
    const eq = line.indexOf("=");
    if (eq < 1) return refuse(`"${shown(line)}" isn't KEY=value`);
    const key = line.slice(0, eq), value = line.slice(eq + 1);
    if (!PANE_ENV_KEYS.includes(key)) return refuse(`${shown(key)} isn't a key pane-env takes (${PANE_ENV_KEYS.join(", ")})`);
    if (key in got) return refuse(`${key} is set twice`);
    const dirs = key === "PATH_PREPEND" ? value.split(":") : [value];
    const padded = dirs.find((d) => d !== d.trim());
    if (padded !== undefined) return refuse(`${key}: "${shown(padded)}" has a space at its start or end`);
    const bad = dirs.find((d) => !d.startsWith("/"));
    if (bad !== undefined) return refuse(`${key}: "${shown(bad)}" isn't an absolute folder`);
    got[key] = [...new Set(dirs.map(folder))].join(":");
  }
  return { prepend: got.PATH_PREPEND ?? null, appHome: got.HERDR_APP_HOME ?? null, error: null };
}
