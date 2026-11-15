// DSH as a Herdr agent: dsh-TUI, pinned, in its own `dsh-tui` DSH profile, behind the `dsh-tui` shim
// Herdr's built-in program table starts (#561). Node only, like update.mjs: Herdr never loads
// this file; the CLI and the pack's doctor read it.
//
// What this never does: write the `desktop` profile, DSH's credentials or Desktop's settings;
// ship a key (the BWS launcher stays out of the pack); or pick a model. dsh-TUI's own sign-in
// works (`/model` -> DeepSeek Account, or `/auth`), and a key already in DSH's credential store
// or DEEPSEEK_API_KEY works; this installer writes neither. Sessions go to ~/.dsh; DSH Desktop
// shows them after a quit and reopen, never live.
//
// The pin is exact and carries the registry integrity: dsh's plugin add (`pnpm add --save-exact`)
// writes that version, and the profile's lockfile must record DSH_TUI.integrity. pnpm 11's
// minimumReleaseAge (1440 minutes by default) refuses a version published hours ago, so its
// automatic exclusion must name exactly `@deepseek-harness-tui/dsh-tui@0.19.0`, never the bare
// package. Once the version has aged past the profile's threshold, install/update removes that
// exact entry again; uninstall removes it too.
//
// The profile is `dsh-tui`, the one the package itself creates (bin/dsh-tui.js PROFILE and its
// own `dsh plugin --profile dsh-tui add`). Never `tui`: that name can be a profile initialized
// from the web template, which boots the web app, and the web app rejects --resume/-c/-p. The
// shim runs the long `--profile dsh-tui` form because the built-in Herdr entry only checks that
// its first word, `dsh-tui`, resolves on PATH.
//
// The shim adds no separator of its own: dsh's launcher takes its own flags first, then the first
// token it does not recognize starts the app's arguments. `--resume <id>`, `-c` and `--continue`
// work; `--backend` is the package launcher's mapping and is not supported through the shim (dsh
// passes it to the app, which reads it as prompt text). DSH's Commander drops a bare `--`, so a
// literal `-- <text>` whose text starts with a flag does not protect it (`-- --resume=<id>`
// resumes instead of sending text).
//
// Apache-2.0.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync,
  writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import net from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRow, installRow } from "./bin/dsh-sandbox.mjs";
import { approvedProxyState, approvedRootOf } from "./approved.js";
import { PROJECTS_FILE, listedProjects } from "./model.js";
import { LEDGER_FILE, dataRootOf, stableRootOf } from "./workers.js";
import { removePath } from "./layoutSafe.mjs";

/** The one version this pack installs, and the npm registry's integrity for its tarball. */
export const DSH_TUI = Object.freeze({
  package: "@deepseek-harness-tui/dsh-tui",
  version: "0.19.0",
  integrity: "sha512-4TAPhsTqfL+oG1H39Fbj13tfaVVGnwV9N33dV8Acn/YBoZT/YgXwF+ZnbhvRi0l55bNc6X6loKkngxrNL8NX3w==",
});
/** dsh-TUI's own DSH profile (bin/dsh-tui.js PROFILE). Never `desktop`, and never a `tui` profile a web template may own. */
export const PROFILE = "dsh-tui";
/** The command Herdr's built-in `dsh-tui` program entry looks for on PATH (#335). */
export const SHIM = "dsh-tui";
export const PIN = `${DSH_TUI.package}@${DSH_TUI.version}`;
/** pnpm 11's default minimumReleaseAge, in minutes (pnpm.io/11.x/settings). */
export const RELEASE_AGE_MINUTES = 1440;
export const SHIM_MARK = "# Automagik Herdr's dsh-tui shim";
export const SHIM_TEXT = `#!/bin/sh
${SHIM_MARK} (installed by \`am dsh-tui install\`).
# The profile is dsh-TUI's own; "tui" can be a web-template profile that rejects --resume/-c/-p.
# No separator of its own: dsh starts the app's arguments at the first token it does not
# recognize, so --resume <id>, -c and --continue arrive the way dsh-TUI's own launcher passes
# them. --backend is launcher-only (not supported here); a bare -- is dropped by dsh, so
# -- <text> does not protect text that itself starts with a flag.
# Optional provider keys set outside DSH: source a readable regular file you own with mode 0600
# or stricter (no group/other read or write), in a folder you own that is not group- or
# world-writable, with valid shell. Anything else is skipped with one fixed line; the shell's own
# error (which can quote the file) is discarded. This shim never contains or writes a secret; the
# installer creates no such file. Checking and sourcing are separate opens, so a folder another
# user can write would allow a swap: it is refused too.
env_file="\${DSH_HOME:-\$HOME/.dsh}/deepseek.env"
if [ -e "\$env_file" ] || [ -h "\$env_file" ]; then
  env_dir="\$(dirname "\$env_file")"
  safe_dir="\$(find "\$env_dir" -prune -type d -user "\$(id -u)" ! -perm -020 ! -perm -002 -print 2>/dev/null)"
  safe_file="\$(find "\$env_file" -prune -type f -user "\$(id -u)" ! -perm -002 ! -perm -020 ! -perm -004 ! -perm -040 -print 2>/dev/null)"
  if [ -n "\$safe_dir" ] && [ -n "\$safe_file" ] && [ -r "\$env_file" ] && /bin/sh -n "\$env_file" 2>/dev/null; then
    set -a
    . "\$env_file" 2>/dev/null
    set +a
  else
    echo "dsh-tui: skipped the provider env file: it must be a readable regular file you own with mode 0600 or stricter, in a folder you own that is not group- or world-writable, with valid shell." >&2
  fi
fi
if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh-tui: DSH (dsh) is not on PATH. Install DSH Desktop or 'npm install -g @deepseek-ai/dsh'." >&2
  exit 127
fi
exec dsh --profile dsh-tui "$@"
`;
/** The ownership record the installer leaves in the dsh-tui profile (never pnpm's files). */
export const RECORD_FILE = ".automagik-herdr-dsh-tui.json";
/** dsh-TUI's own data dir (`lib/types/utils/paths.js` DATA_DIR) and first-run guide state. */
export const TUI_DATA_DIR = ".dsh-tui";
export const ONBOARDING_FILE = "onboarding.json";
/** The guide revision dsh-TUI 0.19.0 writes (`lib/types/onboardingPrefs.js` ONBOARDING_VERSION). */
export const ONBOARDING_VERSION = 1;
/** The one honest line a machine with no DSH gets, and nothing else. */
export const SKIP = "DSH is not installed (no dsh on PATH): skipped dsh-TUI. Install DSH Desktop or `npm install -g @deepseek-ai/dsh`, then run `am dsh-tui install`.";

const read = (path) => {
  try { return readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; }
};
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, "$2");
const lastLine = (text) => String(text ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
const executable = (path) => {
  try { if (!statSync(path).isFile()) return false; accessSync(path, constants.X_OK); return true; } catch { return false; }
};
/** Whether anything, a dangling link included, is at `path` (readFileSync would call a dangling link absent). */
const present = (path) => {
  try { lstatSync(path); return true; } catch { return false; }
};

/** The person's login shell, or /bin/sh; an absolute, running one only. */
export function loginShellOf(env = process.env) {
  const shell = env.SHELL;
  return typeof shell === "string" && isAbsolute(shell) && executable(shell) ? shell : "/bin/sh";
}
/** The file a person edits to change their PATH, for the shell Herdr panes start in. */
export function shellConfigOf(shell, platform = process.platform) {
  const name = basename(String(shell ?? ""));
  if (name === "zsh") return "~/.zshrc";
  if (name === "fish") return "~/.config/fish/config.fish";
  if (name === "bash") return platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  return "~/.profile";
}
/**
 * The PATH Herdr panes actually get: an interactive login shell's, the way herdr-core starts a
 * program (#453's launchPath starts from this CLI's, which is not the pane's). The shell's startup
 * files may print anything, so the answer is read between markers. No answer (too slow, a broken
 * shell): this process's PATH, and `login: false` says so.
 */
export function panePathOf({ env = process.env, timeout = 5000 } = {}) {
  const shell = loginShellOf(env);
  const marker = `__AM_HDR_PATH_${process.pid}_${randomBytes(3).toString("hex")}__`;
  let stdout = "";
  try {
    const r = spawnSync(shell, ["-ilc", `printf '${marker}'; printenv PATH; printf ':${marker}'`],
      { env, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    stdout = r.stdout ?? "";
  } catch { /* no answer */ }
  const start = stdout.indexOf(marker), end = stdout.lastIndexOf(`:${marker}`);
  // printenv ends the value with a newline; a PATH entry with one never matches a folder.
  const raw = start >= 0 && end > start ? stdout.slice(start + marker.length, end) : "";
  const path = raw.replace(/\r?\n$/, "");
  return { shell, config: shellConfigOf(shell), path: path || String(env.PATH ?? ""), login: Boolean(path) };
}

/** DSH's home: $DSH_HOME, else ~/.dsh (the store DSH Desktop and the CLI share). */
export const dshHomeOf = (env = process.env) => resolve(env.DSH_HOME?.trim() ? env.DSH_HOME.trim() : join(env.HOME || homedir(), ".dsh"));
/** The dsh-tui profile: the only profile this installer writes, and never the reserved desktop one. */
export function profileDirOf(dshHome) {
  if (PROFILE === "desktop") throw new Error("refusing to install dsh-TUI into the desktop profile");
  const dir = join(dshHome, "profiles", PROFILE);
  if (dir === join(dshHome, "profiles", "desktop")) throw new Error("refusing to install dsh-TUI into the desktop profile");
  return dir;
}
export const binDirOf = (env = process.env) => join(env.HOME || homedir(), ".local", "bin");
export const shimPathOf = (env = process.env) => join(binDirOf(env), SHIM);

/** The app home a pack install uses, without the trailing slash. */
const appHomeFor = (env = process.env) => (env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app")).replace(/\/+$/, "");

/** The most symlinks one path may resolve through before it is refused. */
export const MAX_SYMLINK_DEPTH = 32;
/**
 * Real path, resolving the nearest existing ancestor and appending the rest for a missing child.
 * A symlink at the final component is followed even when its target is missing (realpathSync
 * would call the link absent and return the link itself); a loop or a chain over
 * MAX_SYMLINK_DEPTH is refused, never resolved.
 */
export const realOrAbs = (path, depth = 0, seen = new Set()) => {
  const abs = resolve(path);
  let info = null;
  try { info = lstatSync(abs); } catch { /* missing: resolve its existing ancestor */ }
  if (info?.isSymbolicLink()) {
    if (depth >= MAX_SYMLINK_DEPTH)
      throw new Error(`more than ${MAX_SYMLINK_DEPTH} symlinks resolving ${abs}`);
    if (seen.has(abs)) throw new Error(`symlink loop resolving ${abs}`);
    seen.add(abs);
    return realOrAbs(resolve(dirname(abs), readlinkSync(abs)), depth + 1, seen);
  }
  try { return realpathSync(abs); } catch { /* missing: resolve its existing ancestor */ }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realOrAbs(parent, depth, seen), basename(abs));
};
/** Whether `child` is `parent` or beneath it, by real/resolved path. */
const insidePath = (child, parent) => {
  const at = realOrAbs(child), root = realOrAbs(parent);
  const rel = relative(root, at);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Why a stable execution root is unsafe, or null. It must be outside the project, the app home,
 * the pane temp folder and the runtime folder: a bot that can write it could replace the helper
 * or runner that the core starts outside the sandbox.
 */
export function defaultForbiddenRoots(env = process.env, project = process.cwd(), appHome = appHomeFor(env)) {
  return [
    ["the project", project],
    ["the app home", appHome],
    ["the temp folder", env.TMPDIR || tmpdir()],
    ["the literal temp folder", "/tmp"],
    ...(env.XDG_RUNTIME_DIR ? [["the runtime folder", env.XDG_RUNTIME_DIR]] : []),
  ];
}

export function unsafePathProblem(path, label, { project = process.cwd(), env = process.env, appHome = appHomeFor(env), forbiddenRoots = undefined } = {}) {
  const roots = forbiddenRoots ?? defaultForbiddenRoots(env, project, appHome);
  for (const [why, parent] of roots) {
    if (parent && insidePath(path, parent)) return `${label} ${path} is inside ${why}; refusing`;
  }
  return null;
}
/** The stable root's own refusal (the label the rows name). */
export const stableRootProblem = (root, opts) => unsafePathProblem(root, "the stable execution root", opts);

/**
 * Why the approved data root cannot be trusted, or null. The data root holds both the stable
 * execution folder and the approved rosters, so one read-only sandbox bind covers both: it must
 * be outside the project, the app home, the temp folder and the runtime folder, and the stable
 * root must stay beneath it. Use the same forbidden roots as the stable execution check.
 */
export function approvedDataRootProblem({ env = process.env, project = process.cwd(),
  appHome = appHomeFor(env), forbiddenRoots = undefined } = {}) {
  const root = dataRootOf(env);
  const stable = stableRootOf(env);
  const records = approvedRootOf(env);
  if (!isAbsolute(root)) return `the approved data root ${root} is not absolute; refusing`;
  if (!insidePath(stable, root) || realOrAbs(stable) === realOrAbs(root)) {
    return `the stable execution root ${stable} is not beneath the approved data root ${root}`;
  }
  if (!insidePath(records, root) || realOrAbs(records) === realOrAbs(root)) {
    return `the approved roster folder ${records} is not beneath the data root ${root}`;
  }
  const roots = forbiddenRoots ?? defaultForbiddenRoots(env, project, appHome);
  for (const [why, parent] of roots) {
    if (parent && insidePath(root, parent)) {
      return `the approved data root ${root} is inside ${why}; refusing`;
    }
  }
  return null;
}
/** Every node/bun run.sh could pick: PATH words, the nvm versions, Homebrew and ~/.bun. */
export function nodeCandidates(env = process.env, path = env.PATH || "") {
  const out = new Set();
  for (const dir of String(path).split(delimiter)) {
    if (!dir) continue;
    out.add(join(dir, "node"));
    out.add(join(dir, "bun"));
  }
  const home = env.HOME || "";
  if (home) {
    const nvm = join(home, ".nvm", "versions", "node");
    try { for (const version of readdirSync(nvm)) out.add(join(nvm, version, "bin", "node")); } catch { /* none */ }
    out.add(join(home, ".bun", "bin", "bun"));
  }
  out.add("/opt/homebrew/bin/node");
  out.add("/usr/local/bin/node");
  return [...out].filter((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
}

/** Check the stable root, the DSH profile, the installed shim and every node run.sh could run. */
export function executionPathProblem({ stableRoot, env = process.env, project = process.cwd(), node = process.execPath, bakedNode = undefined, forbiddenRoots = undefined } = {}) {
  const paths = [
    [stableRoot, "the stable execution root"],
    [sandboxProfileOf(dshHomeOf(env)), "the DSH profile"],
    [shimPathOf(env), "the dsh-tui shim"],
  ];
  for (const [path, label] of paths) {
    const problem = unsafePathProblem(path, label, { project, env, forbiddenRoots });
    if (problem) return problem;
  }
  const dsh = findDsh(env);
  if (dsh) {
    const problem = unsafePathProblem(dsh, "the dsh the shim executes", { project, env, forbiddenRoots });
    if (problem) return problem;
  }
  const baked = bakedNode === undefined ? bakedNodeOf(stableRoot) : bakedNode;
  if (!baked) return `the stable runner ${join(stableRoot, STABLE_RUNNER)} has no baked node; run am dsh-tui install again`;
  const missing = bakedNodeProblem(baked);
  if (missing) return missing;
  if (bakedNode === undefined) {
    try {
      if (!readFileSync(join(stableRoot, STABLE_RUNNER)).equals(Buffer.from(stableRunnerText(baked)))) {
        return `the stable runner ${join(stableRoot, STABLE_RUNNER)} does not match its baked node; run am dsh-tui install again`;
      }
    } catch {
      return `the stable runner ${join(stableRoot, STABLE_RUNNER)} cannot be read; run am dsh-tui install again`;
    }
  }
  for (const candidate of [baked, node, ...nodeCandidates(env)]) {
    const problem = unsafePathProblem(candidate, "the node that runs the helper", { project, env, forbiddenRoots });
    if (problem) return problem;
  }
  if (env.NVM_DIR) {
    const problem = unsafePathProblem(env.NVM_DIR, "NVM_DIR", { project, env, forbiddenRoots });
    if (problem) return problem;
  }
  for (const dir of String(env.AUTOMAGIK_HERDR_RUNTIME_DIRS || "").split(":")) {
    if (!dir) continue;
    const problem = unsafePathProblem(dir, "AUTOMAGIK_HERDR_RUNTIME_DIRS", { project, env, forbiddenRoots });
    if (problem) return problem;
  }
  return null;
}

/** The stable folder the pack copies the DSH sandbox runner wrapper into (#631 PR B). *//** The stable folder the pack copies the DSH sandbox runner wrapper into (#631 PR B). */
export const SANDBOX_DIR = "automagik-herdr/dsh-sandbox";
export const SANDBOX_WRAPPER = "hc-socket-mask.mjs";
export const sandboxRootOf = (env = process.env) => stableRootOf(env);
export const sandboxWrapperOf = (env = process.env) => join(sandboxRootOf(env), SANDBOX_WRAPPER);
/** The wrapper beside this module, in the pack release (or its am copy). */
export const packWrapperOf = () => fileURLToPath(new URL("./bin/hc-socket-mask.mjs", import.meta.url));
/** This module's own folder: the pack mod when the pack's CLI runs the installer. */
export const packRootOf = () => dirname(dirname(packWrapperOf()));
/** Only the pack's mod folder (or its stable copy) has the pane helper and runner. */
export const sandboxCapable = (root = packRootOf()) => ["am-sidebar", "dsh-sandbox"].includes(basename(root))
  && existsSync(join(root, "hcPane.mjs")) && existsSync(join(root, "bin", "run.sh"));

/** Every file an unsandboxed worker start can reach, copied byte-equal to the stable folder. */
export const STABLE_FILES = Object.freeze([
  "hcPane.mjs", "hcProxy.mjs", "approved.js", "dshTui.mjs", "workers.js", "models.js", "model.js",
  "hermesPair.js", "actionError.js",
  "logins.js", "attach.js", "hcGuard.mjs", "restart.js", "launchArgs.js", "layoutSafe.mjs", "release.js", "retired.js",
  "bin/dsh-sandbox.mjs", "bin/run.sh",
]);

/** The folders copied whole: the hc guard and the `hc kill` shim (#955), each an `hc` entry over hcGuard.mjs. */
export const STABLE_FOLDERS = Object.freeze(["guard", "hc-kill"]);

/** Whether every stable file is byte-equal to the pack's copy (a stale copy is never run). */
export function stableFilesCurrent(source, stable) {
  try {
    for (const file of STABLE_FILES) {
      if (file === STABLE_RUNNER) continue;
      if (!readFileSync(join(source, file)).equals(readFileSync(join(stable, file)))) return false;
    }
    const baked = bakedNodeOf(stable);
    if (!baked) return false;
    if (!readFileSync(join(stable, STABLE_RUNNER)).equals(Buffer.from(stableRunnerText(baked)))) return false;
    for (const folder of STABLE_FOLDERS) {
      const guardSource = join(source, folder), guardStable = join(stable, folder);
      const names = readdirSync(guardSource);
      if (names.length !== readdirSync(guardStable).length) return false;
      for (const name of names) {
        if (!readFileSync(join(guardSource, name)).equals(readFileSync(join(guardStable, name)))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The installed pack's mod folder, if it is there; else this module's own folder. */
export function packSourceOf(env = process.env) {
  const appHome = (env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app")).replace(/\/+$/, "");
  const installed = join(appHome, "mods", "am-sidebar");
  return existsSync(join(installed, "hcPane.mjs")) ? installed : packRootOf();
}

/** The stable runner: one absolute node, baked at install; no PATH, NVM_DIR or env search. */
export const STABLE_RUNNER = "bin/run.sh";
const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
export function stableRunnerText(node) {
  return `#!/bin/sh\n# Generated by dsh-tui install: one absolute node, no PATH/NVM/env search.\n# am-node: ${node}\nexec ${shellQuote(node)} "$@"\n`;
}
/** The node baked into a stable runner, or null. */
export function bakedNodeOf(stableRoot) {
  try {
    const match = readFileSync(join(stableRoot, STABLE_RUNNER), "utf8").match(/^# am-node: (.+)$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Why the baked node cannot run, or null: it must still be an executable file. */
export function bakedNodeProblem(node) {
  try {
    const stat = statSync(node);
    if (!stat.isFile()) throw new Error("not a file");
    accessSync(node, constants.X_OK);
    return null;
  } catch {
    return `the baked node ${node} is gone; run am dsh-tui install again`;
  }
}

/** Copy the stable execution set from `source` to `stable`, keeping modes; returns changed paths. */
function copyStable(source, stable, node) {
  if (resolve(source) === resolve(stable)) return [];
  const changed = [];
  for (const file of STABLE_FILES) {
    const from = join(source, file), to = join(stable, file);
    const want = file === STABLE_RUNNER ? Buffer.from(stableRunnerText(node)) : readFileSync(from);
    let have = null;
    try { have = readFileSync(to); } catch { /* first copy */ }
    if (!have || !want.equals(have)) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      if (file === STABLE_RUNNER) writeFileSync(to, want, { mode: 0o755 });
      else {
        copyFileSync(from, to);
        chmodSync(to, statSync(from).mode & 0o777);
      }
      changed.push(to);
    }
  }
  for (const folder of STABLE_FOLDERS) {
    const guardFrom = join(source, folder);
    const guardTo = join(stable, folder);
    if (!existsSync(guardFrom) || resolve(guardFrom) === resolve(guardTo)) continue;
    mkdirSync(guardTo, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(guardFrom)) {
      const from = join(guardFrom, name), to = join(guardTo, name);
      const want = readFileSync(from);
      let have = null;
      try { have = readFileSync(to); } catch { /* first copy */ }
      if (!have || !want.equals(have)) {
        copyFileSync(from, to);
        chmodSync(to, statSync(from).mode & 0o777);
        changed.push(to);
      }
    }
  }
  return changed;
}
/** The dsh-tui profile's patch file, where the sandbox row lives. */
export const sandboxProfileOf = (dshHome) => join(profileDirOf(dshHome), "cordis.patch.yml");

/**
 * Copy the wrapper byte-equal from the pack to its stable path and install the managed sandbox
 * row in the dsh-tui profile. The wrapper is what DSH runs for a sandboxed command; the row
 * names it and its failure signature. Throws before writing a half result; an unchanged copy
 * and an already-current row are no-ops.
 */
export function installSandboxRow({ env = process.env, project = null, forbiddenRoots = undefined } = {}) {
  const wrapper = sandboxWrapperOf(env);
  const profile = sandboxProfileOf(dshHomeOf(env));
  const source = packWrapperOf();
  const packRoot = packRootOf();
  const stableRoot = sandboxRootOf(env);
  if (!sandboxCapable(packRoot)) return { changed: false, skipped: true, wrapper, profile, packRoot, stableRoot };
  const cwd = process.cwd();
  const cwdProject = existsSync(join(cwd, ".herdr", "bots.json")) || existsSync(join(cwd, ".git")) ? cwd : null;
  const where = project ?? cwdProject;
  const unsafe = executionPathProblem({ stableRoot, project: where, env, node: process.execPath,
    bakedNode: process.execPath, forbiddenRoots });
  if (unsafe) throw new Error(unsafe);
  let changed = false;
  const copied = copyStable(packRoot, stableRoot, process.execPath);
  changed = copied.length > 0;
  try {
    const want = readFileSync(source);
    const have = existsSync(wrapper) ? readFileSync(wrapper) : null;
    if (!have || !want.equals(have)) {
      mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
      copyFileSync(source, wrapper);
      changed = true;
    }
    chmodSync(wrapper, 0o755);
  } catch (e) {
    throw new Error(`cannot copy the sandbox wrapper to ${wrapper}: ${e?.message ?? e}`);
  }
  try {
    const row = installRow({ profile, wrapper, packRoot: stableRoot });
    return { changed: changed || row.changed, wrapper, profile, packRoot: stableRoot, stableRoot, backup: row.backup };
  } catch (e) {
    throw new Error(`cannot install the sandbox row in ${profile}: ${e?.message ?? e}`);
  }
}

/** The stable wrapper and the managed row, read-only (doctor and the tests). */
export function sandboxState(env = process.env, { forbiddenRoots = undefined } = {}) {
  const wrapper = sandboxWrapperOf(env);
  const profile = sandboxProfileOf(dshHomeOf(env));
  const stableRoot = sandboxRootOf(env);
  const packRoot = packRootOf();
  const capable = sandboxCapable(stableRoot) && sandboxCapable(packRoot)
    && executionPathProblem({ stableRoot, env, project: process.cwd(), forbiddenRoots }) === null;
  let current = false;
  try {
    current = existsSync(wrapper) && readFileSync(packWrapperOf()).equals(readFileSync(wrapper))
      && stableFilesCurrent(packSourceOf(env), stableRoot);
  } catch { current = false; }
  let row;
  try { row = checkRow({ profile, wrapper, packRoot: capable ? stableRoot : null }); } catch (e) { row = { ok: false, message: e?.message ?? String(e) }; }
  return { wrapper, profile, packRoot, stableRoot, capable, current, row };
}

/** `dsh` on PATH, as an absolute file, or null. No program runs (the doctor reads only). */
export function findDsh(env = process.env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, "dsh");
    if (executable(file)) return file;
  }
  return null;
}

/** The exec line the released `tui`-profile shim carried; still this installer's, so install replaces it. */
const LEGACY_SHIM_EXEC = 'exec dsh --profile tui -- "$@"';

/** Whether a file at the shim's path is this installer's, by its marker and its exec line. */
export function shimIsOurs(text) {
  if (typeof text !== "string" || !text.includes(SHIM_MARK)) return false;
  const lines = text.split(/\r?\n/);
  return lines.includes(`exec dsh --profile ${PROFILE} "$@"`) || lines.includes(LEGACY_SHIM_EXEC);
}

function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode });
  renameSync(temp, path);
}

/** JSON at `path`, or null (unreadable or not JSON). */
function json(path) {
  const text = read(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The dsh-tui profile's record of the dsh-TUI this installer added, or null (the person's own).
 * Keyed on the package and the version recorded at install time, never the current pin: a
 * record from an older release is still this installer's after a pin bump.
 */
export function ownershipOf(profile) {
  const record = json(join(profile, RECORD_FILE));
  return record?.package === DSH_TUI.package && typeof record.version === "string" && /^\d+\.\d+\.\d+/.test(record.version)
    ? record : null;
}

/** Forget the installer's ownership record in `profile` (the dsh-tui profile only). */
function dropRecord(profile) {
  removePath(join(profile, RECORD_FILE), { force: true });
}

/** The exact exclusions in a profile's pnpm-workspace.yaml, read-only. */
export function releaseAgeEntries(text) {
  if (typeof text !== "string") return [];
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:/.test(line));
  if (start < 0) return [];
  const inline = /^minimumReleaseAgeExclude:\s*\[(.*)\]\s*$/.exec(lines[start]);
  if (inline) return inline[1].split(",").map((v) => unquote(v)).filter(Boolean);
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s+-\s+(.*)$/.exec(lines[i]);
    if (!item) { if (/^\s*$/.test(lines[i])) continue; break; }
    entries.push(unquote(item[1]));
  }
  return entries;
}

/** A release-age entry's package name (`@scope/name@1.2.3` and `name` both give the name). */
export function packageOfEntry(entry) {
  const at = String(entry).indexOf("@", 1);
  return at > 0 ? entry.slice(0, at) : entry;
}

/** The profile's minimumReleaseAge in minutes; pnpm 11's default when it sets none. */
export function minimumReleaseAge(text) {
  const m = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(String(text ?? ""));
  return m ? Number(m[1]) : RELEASE_AGE_MINUTES;
}

/**
 * A pnpm-workspace.yaml whose exclusions for our package are exactly `keep` (an exact version, or
 * [] once it has aged out). Other packages' entries, and everything else in the file, stay.
 */
export function scopeReleaseAge(text, keep) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:/.test(line));
  const current = releaseAgeEntries(text);
  const ours = current.filter((entry) => packageOfEntry(entry) === DSH_TUI.package);
  const same = ours.length === keep.length && ours.every((entry, i) => entry === keep[i]);
  if (same) return { text, changed: false };
  if (start < 0) {
    if (keep.length === 0) return { text, changed: false };
    const block = `minimumReleaseAgeExclude:\n${keep.map((entry) => `  - '${entry}'`).join("\n")}`;
    return { text: `${String(text ?? "").replace(/\n?$/, "\n")}${block}\n`, changed: true };
  }
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end]) && lines[end].trim() !== "") end++;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const kept = current.filter((entry) => packageOfEntry(entry) !== DSH_TUI.package);
  const all = [...kept, ...keep];
  const block = all.length ? ["minimumReleaseAgeExclude:", ...all.map((entry) => `  - '${entry}'`)] : ["minimumReleaseAgeExclude: []"];
  return { text: [...before, ...block, ...after].join("\n"), changed: true };
}

/** The integrity pnpm's lockfile records for `pkg@version`, or null. */
export function lockIntegrity(text, pkg = DSH_TUI.package, version = DSH_TUI.version) {
  const key = `'${pkg}@${version}':`;
  let from = 0;
  while (true) {
    const at = String(text ?? "").indexOf(key, from);
    if (at < 0) return null;
    const block = String(text).slice(at + key.length).split(/\n\s*\n/)[0];
    const m = /resolution: \{integrity: ([^}]+)\}/.exec(block);
    if (m) return m[1].trim();
    from = at + key.length;
  }
}

/** The dsh-tui profile's state: what is pinned, recorded and installed. Read-only. */
export function profileState(dshHome) {
  const dir = profileDirOf(dshHome);
  const pkg = json(join(dir, "package.json"));
  const lock = read(join(dir, "pnpm-lock.yaml")) ?? "";
  const installed = json(join(dir, "node_modules", ...DSH_TUI.package.split("/"), "package.json"));
  return {
    dir,
    exists: existsSync(dir),
    pin: typeof pkg?.dependencies?.[DSH_TUI.package] === "string" ? pkg.dependencies[DSH_TUI.package] : null,
    integrity: lockIntegrity(lock),
    installed: typeof installed?.version === "string" ? installed.version : null,
    workspace: read(join(dir, "pnpm-workspace.yaml")),
  };
}

/** The files this installer must leave alone, as path -> a digest (or null when absent). */
const DESKTOP_FILES = Object.freeze([
  ".credentials.yaml",
  "profiles/desktop/package.json",
  "profiles/desktop/cordis.yml",
  "profiles/desktop/cordis.patch.yml",
  "profiles/desktop/pnpm-workspace.yaml",
  "profiles/desktop/pnpm-lock.yaml",
]);
export function desktopFingerprint(dshHome) {
  return Object.fromEntries(DESKTOP_FILES.map((file) => {
    const text = read(join(dshHome, file));
    return [file, text === null ? null : createHash("sha256").update(text).digest("hex")];
  }));
}
const desktopChanged = (before, after) => DESKTOP_FILES.filter((file) => before[file] !== after[file]);

/** A registry publish time for the pin, or null when the registry cannot be read. */
export async function registryPublishedAt({ pkg = DSH_TUI.package, version = DSH_TUI.version, fetch = globalThis.fetch, timeout = 5000 } = {}) {
  if (typeof fetch !== "function") return null;
  const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F").replace("@", "%40")}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const packument = await res.json();
    return typeof packument?.time?.[version] === "string" ? packument.time[version] : null;
  } catch { return null; }
}

/** Runs `dsh args...`: `{ code, stdout, stderr, missing }`, like parts.mjs's runCommand. */
export function runDsh(dsh, args, { env, cwd, timeout = 600_000 } = {}) {
  const r = spawnSync(dsh, args, { cwd, env, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: r.error?.code === "ENOENT" };
}

const tempCwd = () => mkdtempSync(join(tmpdir(), "am-dsh-tui-"));
const withTemp = (fn) => {
  const cwd = tempCwd();
  try { return fn(cwd); } finally { removePath(cwd, { recursive: true, force: true }); }
};

/** Whether `binDir` is on PATH, for the shim Herdr's built-in entry looks up. */
const onPath = (env, dir) => String(env.PATH ?? "").split(delimiter).includes(dir);

/**
 * `dsh-tui install` (and `update`, which is the same idempotent add): DSH into the dsh-tui
 * profile only, the shim, and the guide's one setting. `{ status, changed, lines, detail }`, never
 * throws for a missing DSH; a failed dsh/pnpm step is `status: "failed"`.
 */
export async function installDshTui(options = {}) {
  const { env = process.env, exec = runDsh, now = () => Date.now() } = options;
  const dsh = findDsh(env);
  if (!dsh) return { status: "skipped", changed: false, detail: SKIP, lines: [SKIP] };
  const dshHome = dshHomeOf(env);
  const profile = profileDirOf(dshHome);
  const binDir = binDirOf(env);
  const shim = join(binDir, SHIM);
  const priorShim = read(shim);
  const shimPresent = present(shim);
  if (shimPresent && !shimIsOurs(priorShim)) {
    return { status: "failed", changed: false, detail: `${shim} exists and is not this installer's${priorShim === null ? " (a dangling link or unreadable file)" : ""}: left alone. Remove it, or make it exec dsh --profile ${PROFILE} "$@", then run this again.`, lines: [] };
  }
  const before = profileState(dshHome);
  const ownedBefore = ownershipOf(profile);
  const recordBefore = read(join(profile, RECORD_FILE));
  // Ownership is the package and the exact version recorded at install time, never the current
  // pin: a pack-owned 0.18.0 is still the pack's after the constant moves to 0.19.0. A record
  // whose pin has moved is no longer ours and is dropped.
  const staleRecord = ownedBefore !== null && before.pin !== null && before.pin !== ownedBefore.version;
  if (staleRecord) dropRecord(profile);
  const owns = before.pin === null || (ownedBefore !== null && before.pin === ownedBefore.version);
  // A pin this installer did not record is the person's: never run `plugin add` over it (pnpm
  // would rewrite their lockfile). Skip the step and say how to hand it over, even when it is
  // already the pinned version. A stale record was already dropped above.
  if (before.pin !== null && !owns) {
    const same = before.pin === DSH_TUI.version ? "" : `, not ${DSH_TUI.version}`;
    return { status: "skipped", changed: staleRecord, detail: `the ${PROFILE} profile already pins ${DSH_TUI.package} ${before.pin}${same}, which this installer did not add: left it and its lockfile unchanged. To let the pack manage it, remove it first (\`dsh plugin --profile ${PROFILE} remove ${DSH_TUI.package}\`) and run this again.`, lines: [] };
  }
  const desktopBefore = desktopFingerprint(dshHome);
  let result;
  try {
    result = withTemp((cwd) => exec(dsh, ["plugin", "--profile", PROFILE, "add", PIN, "--save-exact"], { cwd, env: { ...env, DSH_HOME: dshHome } }));
  } catch (e) {
    return { status: "failed", changed: false, detail: `dsh plugin --profile ${PROFILE} add ${PIN} could not run: ${e?.message ?? e}`, lines: [] };
  }
  if (result.code !== 0) {
    return { status: "failed", changed: false, detail: `dsh plugin --profile ${PROFILE} add ${PIN} failed: ${lastLine(result.stderr || result.stdout) || `exit ${result.code}`}`, lines: [] };
  }
  const undo = () => {
    try { withTemp((cwd) => exec(dsh, ["plugin", "--profile", PROFILE, "remove", DSH_TUI.package], { cwd, env: { ...env, DSH_HOME: dshHome } })); } catch { /* the report says what is wrong */ }
  };
  const state = profileState(dshHome);
  if (state.pin !== DSH_TUI.version || state.installed !== DSH_TUI.version) {
    undo();
    return { status: "failed", changed: false, detail: `the ${PROFILE} profile did not land on ${PIN}: package.json pins ${state.pin ?? "nothing"} and node_modules has ${state.installed ?? "nothing"}; removed what was added.`, lines: [] };
  }
  if (state.integrity !== DSH_TUI.integrity) {
    undo();
    return { status: "failed", changed: false, detail: `the ${PROFILE} profile's lockfile records ${state.integrity ?? "no integrity"} for ${PIN}, not the pinned ${DSH_TUI.integrity}; removed what was added.`, lines: [] };
  }
  const changedDesktop = desktopChanged(desktopBefore, desktopFingerprint(dshHome));
  if (changedDesktop.length) {
    return { status: "failed", changed: false, detail: `the install changed ${changedDesktop.join(", ")} under ${dshHome}; this installer never writes the desktop profile, its settings or DSH's credentials, so check them.`, lines: [] };
  }

  // #631 PR B: the dsh-tui profile's sandbox row names the pack's runner wrapper, copied
  // byte-equal to a stable path. A failure here undoes the plugin add: a pane that sets
  // DSH_SANDBOX_MASK must never run against a profile without the row.
  let sandbox;
  try {
    sandbox = installSandboxRow({ env, forbiddenRoots: options.forbiddenRoots });
  } catch (e) {
    undo();
    return { status: "failed", changed: false, detail: `${e?.message ?? e}; removed what was added.`, lines: [] };
  }

  // The record follows the version this install set, so a later uninstall still knows it is ours.
  const recordText = `${JSON.stringify({ package: DSH_TUI.package, version: DSH_TUI.version, integrity: DSH_TUI.integrity }, null, 2)}\n`;
  const recordChanged = owns && recordBefore !== recordText;
  if (recordChanged) writeAtomic(join(profile, RECORD_FILE), recordText, 0o600);
  let workspace = state.workspace ?? "";
  const published = "publishedAt" in options ? options.publishedAt : await registryPublishedAt();
  const aged = typeof published === "string" && Number.isFinite(Date.parse(published))
    && (now() - Date.parse(published)) / 60000 >= minimumReleaseAge(workspace);
  const kept = aged ? [] : [PIN];
  const had = releaseAgeEntries(workspace).filter((entry) => packageOfEntry(entry) === DSH_TUI.package);
  const scoped = owns ? scopeReleaseAge(workspace, kept) : { text: workspace, changed: false };
  if (scoped.changed) {
    writeAtomic(join(profile, "pnpm-workspace.yaml"), scoped.text, 0o644);
    workspace = scoped.text;
  }

  // dsh-TUI's first-run guide state (~/.dsh-tui, its DATA_DIR): write the exact record its own
  // `markOnboardingDone` writes (`{ completed: true, version: ONBOARDING_VERSION }`, from
  // lib/types/onboardingPrefs.js) so a fresh Herdr pane never blocks on the wizard. Only when
  // there is none: a person completing the guide writes this file itself, and /setup opens it.
  const guide = join(env.HOME || homedir(), TUI_DATA_DIR, ONBOARDING_FILE);
  const guideBefore = read(guide);
  if (guideBefore === null) {
    writeAtomic(guide, `${JSON.stringify({ completed: true, version: ONBOARDING_VERSION }, null, 2)}\n`, 0o600);
  }

  if (priorShim !== SHIM_TEXT) writeAtomic(shim, SHIM_TEXT, 0o755);

  const lines = [
    before.pin === DSH_TUI.version && before.integrity === DSH_TUI.integrity
      ? `dsh-TUI ${DSH_TUI.version} is already installed in the ${PROFILE} profile (${profile}).`
      : `DSH at ${dsh}: installed dsh-TUI ${DSH_TUI.version} in the ${PROFILE} profile (${profile}).`,
    `The ${SHIM} shim is at ${shim}${onPath(env, binDir) ? "" : `; add ${binDir} to PATH so Herdr's built-in menu entry finds it`}.`,
    sandbox.skipped
      ? "The dsh-tui profile's sandbox row was left to the pack's own dsh-tui install (this copy is not the pack's mod folder)."
      : `The ${PROFILE} profile's sandbox row names ${sandbox.wrapper} `
        + "and the data folder it keeps read-only.",
    guideBefore === null
      ? `Marked dsh-TUI's first-run guide done (${guide}; open it later with /setup).`
      : "Kept dsh-TUI's first-run guide state (a completed guide writes that file).",
    "Sign in inside dsh-TUI with /model (DeepSeek Account) or /auth; a key already in DSH's credential store or DEEPSEEK_API_KEY works too. No key is stored by this installer.",
    `Sessions go to ${dshHome}; DSH Desktop shows them after you quit and reopen it (no live refresh).`,
    "The desktop profile, its settings and DSH's credentials are untouched.",
  ];
  if (had.length && !aged && owns) lines.splice(2, 0, `The ${PROFILE} profile excludes ${PIN} from pnpm's release-age gate (exact version only).`);
  if (aged && had.includes(PIN) && owns) lines.splice(2, 0, `Removed the release-age exception for ${PIN}: it is older than the profile's minimumReleaseAge now.`);
  return { status: "installed", changed: before.pin !== DSH_TUI.version || before.integrity !== DSH_TUI.integrity || priorShim !== SHIM_TEXT || scoped.changed || guideBefore === null || recordChanged || staleRecord || sandbox.changed, lines, detail: lines[0] };
}

/**
 * `dsh-tui uninstall`: the plugin out of the dsh-tui profile, the exact release-age entry, and the
 * shim (only when it is ours). Sessions, dsh-TUI's own state and the profile stay.
 */
export function uninstallDshTui(options = {}) {
  const { env = process.env, exec = runDsh } = options;
  const dsh = findDsh(env);
  const dshHome = dshHomeOf(env);
  const profile = profileDirOf(dshHome);
  const state = profileState(dshHome);
  const shim = shimPathOf(env);
  const shimPresent = present(shim);
  const shimText = read(shim);
  const record = ownershipOf(profile);
  const owns = record !== null && state.pin === record.version;
  const lines = [];
  let failed = false;
  let changed = false;
  const desktopBefore = desktopFingerprint(dshHome);

  if (state.pin === null && !shimPresent) {
    if (record) { dropRecord(profile); changed = true; }
    return { status: "absent", changed, detail: "dsh-TUI is not installed; nothing to remove.", lines: ["dsh-TUI is not installed; nothing to remove."] };
  }
  if (state.pin !== null) {
    if (!owns) {
      lines.push(`Left ${DSH_TUI.package} in the ${PROFILE} profile (${state.pin}): this installer did not add it.`);
      if (record) { dropRecord(profile); changed = true; }
    } else if (!dsh) {
      failed = true;
      lines.push(`dsh is not on PATH, so ${DSH_TUI.package} could not be removed from the ${PROFILE} profile; install DSH and run this again.`);
    } else {
      let result;
      try {
        result = withTemp((cwd) => exec(dsh, ["plugin", "--profile", PROFILE, "remove", DSH_TUI.package], { cwd, env: { ...env, DSH_HOME: dshHome } }));
      } catch (e) {
        result = { code: 1, stdout: "", stderr: e?.message ?? String(e) };
      }
      if (result.code !== 0) {
        failed = true;
        lines.push(`dsh plugin --profile ${PROFILE} remove ${DSH_TUI.package} failed: ${lastLine(result.stderr || result.stdout) || `exit ${result.code}`}`);
      } else {
        lines.push(`Removed ${DSH_TUI.package} from the ${PROFILE} profile.`);
        changed = true;
        dropRecord(profile);
      }
    }
  } else {
    lines.push(`The ${PROFILE} profile does not have ${DSH_TUI.package}.`);
    if (record) { dropRecord(profile); changed = true; }
  }

  // The release-age entry is ours only when the pin was: a person's own install keeps its entry.
  if (owns) {
    const workspace = read(join(profile, "pnpm-workspace.yaml"));
    if (workspace !== null) {
      const ours = releaseAgeEntries(workspace).filter((entry) => packageOfEntry(entry) === DSH_TUI.package);
      if (ours.length) {
        const scoped = scopeReleaseAge(workspace, []);
        if (scoped.changed) {
          writeAtomic(join(profile, "pnpm-workspace.yaml"), scoped.text, 0o644);
          changed = true;
          lines.push(`Removed the ${PROFILE} profile's release-age exception for ${DSH_TUI.package}.`);
        }
      }
    }
  }

  if (!shimPresent) lines.push(`No ${SHIM} shim at ${shim}.`);
  else if (shimText === null) lines.push(`Left ${shim}: it exists but is unreadable (a dangling link or a file this user cannot read).`);
  else if (!shimIsOurs(shimText)) lines.push(`Left ${shim}: it is not this installer's.`);
  else {
    removePath(shim, { force: true });
    changed = true;
    lines.push(`Removed the ${SHIM} shim (${shim}).`);
  }

  const changedDesktop = desktopChanged(desktopBefore, desktopFingerprint(dshHome));
  if (changedDesktop.length) {
    failed = true;
    lines.push(`The uninstall changed ${changedDesktop.join(", ")} under ${dshHome}; this installer never writes the desktop profile, its settings or DSH's credentials, so check them.`);
  }
  lines.push(`Kept: DSH sessions (${dshHome}), dsh-TUI's own state (~/${TUI_DATA_DIR}) and the ${PROFILE} profile.`);
  lines.push("Kept the dsh-tui profile's sandbox row and its stable wrapper: without the pack's pane switch the wrapper is a pass-through, and the next install reuses both.");
  return { status: failed ? "failed" : changed ? "removed" : "absent", changed, detail: lines[0], lines };
}

/** Recognize the actual worker transport, never a switch or an env marker supplied by a pane. */
export function workerProxyTransport(socketPath, terminal, timeoutMs = 750) {
  if (typeof terminal !== "string" || !terminal.trim()
    || !socketPath || !isAbsolute(socketPath)) return Promise.resolve(false);
  return new Promise((done) => {
    const socket = net.connect(socketPath);
    let buffer = "", finished = false;
    const finish = (isProxy) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      done(isProxy);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "proxy.workerTransport", params: {} })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 4096) { finish(false); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        const valid = reply.id === 1 && !reply.error && reply.result?.v === 1
          && reply.result?.terminal === terminal
          && typeof reply.result?.core?.id === "string" && reply.result.core.id.length > 0;
        finish(valid ? reply.result : false);
      } catch { finish(false); }
    });
  });
}

/** Probe only an existing per-pane proxy. Never invoke hc or discover a real core socket. */
function proxyAnswers(socketPath, binding, bot, timeoutMs) {
  return new Promise((done) => {
    const socket = net.connect(socketPath);
    let buffer = "", finished = false;
    const finish = (up) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      done(up);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "terminal.get", params: { terminal: binding.terminal } })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 65536) { finish(false); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        finish(reply.id === 1 && !reply.error && reply.result?.state === "live"
          && reply.result?.labels?.bot === bot.id
          && reply.result?.created_ms === binding.created_ms);
      } catch { finish(false); }
    });
  });
}

/** Settings and observed proxy health for the current project's bots; read-only and bounded. */
export async function doctorBotProxies({ bots, project, bindings, env = process.env,
  timeoutMs = 750 }) {
  return Promise.all(bots.map(async (bot) => {
    const binding = bindings.get(bot.id);
    const applicable = process.platform === "linux" && bot.agent === "dsh-tui";
    const row = { id: bot.id, name: bot.name, hcProxy: bot.hcProxy === true, applicable,
      hcProxyState: approvedProxyState({ project, bot, env }),
      terminal: binding?.project === project ? binding.terminal : null, up: false };
    if (!row.terminal) return { ...row, detail: "no attached local pane" };
    if (!isAbsolute(env.XDG_RUNTIME_DIR ?? "") || !/^t[0-9a-z]+$/.test(row.terminal)) {
      return { ...row, detail: "proxy runtime path is unavailable" };
    }
    const socket = join(env.XDG_RUNTIME_DIR, "automagik-hc-proxy", row.terminal, "hc.sock");
    try {
      if (!lstatSync(socket).isSocket()) return { ...row, detail: "proxy path is not a socket" };
      row.up = await proxyAnswers(socket, binding, bot, timeoutMs);
    } catch { /* absent or unreadable: down, never fall back to the real socket */ }
    return { ...row, warning: row.up && !row.hcProxy,
      detail: row.up ? (!row.hcProxy ? "proxy is up; rollback not finished" : "proxy is up")
        : "proxy is down or not responding" };
  }));
}

const ATTACH_LEDGER_FILE = "automagik-herdr/attach.jsonl";
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function readSafeLedgerForDoctor(path, uid) {
  const flags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd;
  try { fd = openSync(path, flags); } catch { return ""; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink?.()) return "";
    if (uid !== null && typeof st.uid === "number" && st.uid !== uid) return "";
    return readFileSync(fd, "utf8");
  } catch {
    return "";
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Read-only inspection of Herdr ledgers (`automagik-herdr/workers.jsonl` and `attach.jsonl`)
 * under the app home, the current project's `.herdr/app-home` (when `project` is given), and
 * known project app homes (#839). Never mutates files.
 */
export function doctorLedgers({ env = process.env, project = null, getuid = process.getuid, stat = lstatSync } = {}) {
  const appHome = env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config", "herdr-app");
  const uid = typeof getuid === "function" ? getuid() : null;
  const homes = [resolve(appHome)];
  const projects = new Set();
  if (typeof project === "string" && isAbsolute(project) && resolve(project) !== "/") projects.add(project);
  try {
    const shared = JSON.parse(readFileSync(join(appHome, "shared.json"), "utf8"));
    for (const key of ["am.sidebar.projects", "spaces-agents.projects"]) {
      const list = shared && typeof shared === "object" && Object.hasOwn(shared, key) ? shared[key] : null;
      for (const p of Array.isArray(list) ? list : []) {
        if (typeof p?.key === "string" && !p.machine) projects.add(p.key);
      }
    }
  } catch { /* none */ }
  for (const name of [PROJECTS_FILE, "spaces-agents-projects.json"]) {
    try {
      for (const k of listedProjects(readFileSync(join(appHome, name), "utf8"))) projects.add(k);
    } catch { /* none */ }
  }
  for (const rel of [LEDGER_FILE, ATTACH_LEDGER_FILE]) {
    const text = readSafeLedgerForDoctor(join(appHome, rel), uid);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.project === "string") projects.add(row.project);
      if (typeof row?.worktree === "string") {
        projects.add(row.worktree);
        const marker = "/.claude/worktrees/";
        const at = row.worktree.indexOf(marker);
        if (at > 0) projects.add(row.worktree.slice(0, at));
      }
    }
  }
  for (const p of projects) {
    if (typeof p === "string" && isAbsolute(p) && resolve(p) !== "/") {
      homes.push(join(p, ".herdr", "app-home"));
    }
  }
  const seenResolved = new Set();
  const seenCanonical = new Set();
  const problems = [];
  const chmodFiles = [];
  let present = 0;
  for (const home of homes) {
    for (const rel of [LEDGER_FILE, ATTACH_LEDGER_FILE]) {
      const file = join(home, rel);
      const abs = resolve(file);
      if (seenResolved.has(abs)) continue;
      seenResolved.add(abs);
      let st;
      try { st = stat(file); } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
        problems.push(`${file} could not be inspected (${e?.message ?? e})`);
        continue;
      }
      if (!st) continue;
      let realParent = null;
      try { realParent = realpathSync(dirname(file)); } catch { realParent = null; }
      const canonical = realParent ? join(realParent, basename(file)) : abs;
      if (seenCanonical.has(canonical)) continue;
      seenCanonical.add(canonical);
      present += 1;
      if (st.isSymbolicLink() || !st.isFile()) {
        const kind = st.isSymbolicLink() ? "a symlink" : "not a regular file";
        problems.push(`${file} is ${kind} (Herdr ledgers must be plain 0600 files)`);
        continue;
      }
      const mode = st.mode & 0o777;
      const oct = `0${mode.toString(8).padStart(3, "0")}`;
      if (uid !== null && typeof st.uid === "number" && st.uid !== uid) {
        problems.push(`${file} is owned by uid ${st.uid}, not ${uid} (mode ${oct})`);
        continue;
      }
      if ((mode & 0o177) !== 0) {
        problems.push(`${file} is mode ${oct}, wider than 0600`);
        chmodFiles.push(file);
      }
    }
  }
  if (problems.length) {
    return {
      ok: false,
      detail: problems.join("; "),
      fix: chmodFiles.length ? `chmod 600 ${chmodFiles.map(shQuote).join(" ")}` : null,
    };
  }
  return {
    ok: true,
    detail: present ? `${present} ledger(s) mode 0600 and owned by current user` : "no ledger files yet",
    fix: null,
  };
}

/**
 * `dsh-tui doctor`: whether dsh, the dsh-tui profile and the shim exist, and whether the profile is
 * the pinned one. Read-only. `{ code, checks }`: 0 healthy or installed, 1 broken, 2 not
 * installed or no dsh (not applicable).
 */
export function doctorDshTui({ env = process.env, panePath, forbiddenRoots = undefined, project = null, getuid = process.getuid, stat = lstatSync } = {}) {
  const checks = [];
  const add = (check, ok, detail, fix = null) => checks.push({ check, ok, detail, fix: ok ? null : fix });
  const shell = loginShellOf(env);
  const pane = panePath ? { shell, config: shellConfigOf(shell), login: true, ...panePath } : panePathOf({ env });
  const dsh = findDsh({ ...env, PATH: pane.path });
  const dshHome = dshHomeOf(env);
  const state = profileState(dshHome);
  const record = ownershipOf(state.dir);
  const owned = record !== null && state.pin === record.version;
  const shim = shimPathOf(env);
  const shimPresent = present(shim);
  const shimText = read(shim);
  const ours = shimText !== null && shimIsOurs(shimText);
  const pinned = state.pin === DSH_TUI.version && state.integrity === DSH_TUI.integrity && state.installed === DSH_TUI.version;
  const installed = state.pin !== null || shimPresent;
  const installLine = "am dsh-tui install";

  const processDsh = dsh ?? findDsh(env);
  add("dsh", Boolean(dsh) || !installed,
    dsh ? dsh
      : processDsh ? `${processDsh} is on this process's PATH, not on the PATH Herdr panes get (${pane.login ? `login shell ${pane.shell}` : "no login shell answer"}); add ${dirname(processDsh)} to ${pane.config}`
        : `not found on the PATH Herdr panes get (${pane.login ? `login shell ${pane.shell}` : "no login shell answer; this process's PATH"}): dsh-TUI is skipped`,
    processDsh && !dsh ? `echo 'export PATH="${dirname(processDsh)}:$PATH"' >> ${pane.config}` : "install DSH Desktop or `npm install -g @deepseek-ai/dsh`");

  if (!state.exists) add("dsh-tui-profile", !ours, `not installed: ${state.dir} is missing`, installLine);
  else if (state.pin === null) add("dsh-tui-profile", !ours, `not installed: ${state.dir}/package.json does not list ${DSH_TUI.package}`, installLine);
  else if (state.pin !== DSH_TUI.version || state.installed !== DSH_TUI.version) add("dsh-tui-profile", false, `${state.dir} pins ${state.pin}, but node_modules has ${state.installed ?? "nothing"}; the pin is ${DSH_TUI.version}`, installLine);
  else if (state.integrity !== DSH_TUI.integrity) add("dsh-tui-profile", false, `${state.dir}'s lockfile records ${state.integrity ?? "no integrity"}, not the pinned ${DSH_TUI.integrity}`, installLine);
  else add("dsh-tui-profile", true, `${state.dir}: ${PIN}, integrity ok${owned ? " (added by this installer)" : " (not added by this installer; uninstall leaves it)"}`);

  if (!shimPresent) add("dsh-tui-shim", state.pin === null, `not installed: ${shim} is missing`, installLine);
  else if (shimText === null) add("dsh-tui-shim", false, `${shim} exists but is unreadable (a dangling link?)`, `rm ${shim} && ${installLine}`);
  else if (!ours) add("dsh-tui-shim", false, `${shim} exists and is not this installer's`, `rm ${shim} && ${installLine}`);
  else if (!executable(shim)) add("dsh-tui-shim", false, `${shim} is not executable`, `chmod 755 ${shim}`);
  else if (shimText.split(/\r?\n/).includes(LEGACY_SHIM_EXEC)) add("dsh-tui-shim", false, `${shim} is the earlier release's shim (${LEGACY_SHIM_EXEC}); the ${PROFILE} profile needs the current one`, installLine);
  else add("dsh-tui-shim", true, `${shim} (exec dsh --profile ${PROFILE} "$@")`);

  const binDir = binDirOf(env);
  const onPanePath = String(pane.path ?? "").split(delimiter).includes(binDir);
  // A PATH that lacks ~/.local/bin is a note while nothing is installed (the opt-in was not
  // taken), not a broken install: exit 2, never 1. Installed, it is a real break.
  checks.push({
    check: "dsh-tui-path",
    ok: onPanePath || !installed,
    detail: `${binDir} is ${onPanePath ? "" : "not "}on the PATH Herdr panes get (${pane.login ? `login shell ${pane.shell}` : "this process; no login shell answer"})${onPanePath ? "" : "; Herdr's + menu checks its own PATH too, so restart Herdr after adding it"}`,
    fix: onPanePath ? null : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${pane.config}`,
  });

  const guide = read(join(env.HOME || homedir(), TUI_DATA_DIR, ONBOARDING_FILE));
  add("dsh-tui-guide", true, guide === null ? "not marked: the first-run guide opens once (/setup opens it later)" : "marked done");

  const sandbox = sandboxState(env, { forbiddenRoots });
  if (process.platform === "linux") {
    const capable = sandboxCapable(packRootOf());
    const problem = executionPathProblem({ stableRoot: sandbox.stableRoot, env,
      project: process.cwd(), forbiddenRoots });
    add("dsh-hc-proxy", !capable || !installed || (!problem && sandbox.current && sandbox.row.ok),
      !capable ? "not applicable: this copy is not the pack's mod folder"
        : !installed ? "not installed; the per-bot hcProxy switch defaults off"
        : problem ?? (!sandbox.current ? "the stable proxy execution copy is stale"
          : !sandbox.row.ok ? sandbox.row.message
            : "the stable proxy execution copy is current; hcProxy defaults off per bot"),
      installLine);
  }
  const sandboxOk = !sandbox.capable || (sandbox.current && sandbox.row.ok);
  add("dsh-sandbox", sandboxOk || !installed,
    !sandbox.capable ? "not applicable: this copy is not the pack's mod folder"
        : !installed ? "not installed: the dsh-tui profile is not set up"
          : sandbox.current && sandbox.row.ok
            ? `${sandbox.profile}: the sandbox row matches ${sandbox.wrapper} and its data folder`
            : sandbox.row.ok ? `the sandbox wrapper ${sandbox.wrapper} differs from the pack's`
              : sandbox.row.message,
    installLine);

  const ledgers = doctorLedgers({ env, project, getuid, stat });
  add("herdr-ledgers", ledgers.ok, ledgers.detail, ledgers.fix);

  const broken = checks.some((check) => !check.ok);
  const healthy = pinned && ours && sandboxOk;
  return { code: broken ? 1 : healthy ? 0 : 2, checks };
}

/** The three presences `am doctor herdr.pack` reports, without running anything. */
export function dshTuiPresence({ env = process.env } = {}) {
  const dshHome = dshHomeOf(env);
  const state = profileState(dshHome);
  const record = ownershipOf(state.dir);
  const owned = record !== null && state.pin === record.version;
  const shim = shimPathOf(env);
  const shimText = read(shim);
  return {
    dsh: findDsh(env),
    profile: state.pin !== null,
    profileDir: state.dir,
    pinned: state.pin === DSH_TUI.version && state.integrity === DSH_TUI.integrity && state.installed === DSH_TUI.version,
    owned,
    shim,
    shimExists: present(shim),
    shimOurs: shimText !== null && shimIsOurs(shimText),
    shimLegacy: shimText !== null && shimText.split(/\r?\n/).includes(LEGACY_SHIM_EXEC),
    guide: existsSync(join(env.HOME || homedir(), TUI_DATA_DIR, ONBOARDING_FILE)),
  };
}
