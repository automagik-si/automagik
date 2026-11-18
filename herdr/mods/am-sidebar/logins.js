// Claude logins signed in on this computer (#453, am-quota/docs/local-logins.md): which one a
// new Claude launch uses. The record is `<app home>/claude-logins.json`, written only by the
// Accounts panel; the CLI reads it at each local Claude launch and never writes it. Login A
// (the default `~/.claude`) is chosen by launching with CLAUDE_CONFIG_DIR unset, another login
// by setting it to that login's folder. Nothing here reads, copies or writes a credential.
// Pure: files are read through an injected `io`, so `node --test` runs it. Apache-2.0.

export const LOGINS_FILE = "claude-logins.json";
export const CONFIG_VAR = "CLAUDE_CONFIG_DIR";
export const DEFAULT_LOGIN = "default";

/** The vendor config-directory variable this pack can point at a login home, by agent (#1208). */
export const AGENT_HOME_VARS = Object.freeze({ claude: CONFIG_VAR, codex: "CODEX_HOME" });

/** The variable `--agent-home` sets for `agent`, or null when this pack knows none. */
export const agentHomeVar = (agent) => (typeof agent === "string" && Object.hasOwn(AGENT_HOME_VARS, agent) ? AGENT_HOME_VARS[agent] : null);

/**
 * Why `dir` is not an `--agent-home` folder: absolute, no control character, not the filesystem
 * root, an existing directory, and private to its owner (mode 0700, never group or other bits).
 * Null when it is. `isDir` and `mode` are injected so this stays pure; `mode` is required, so a
 * caller cannot accept a folder without checking its permissions. Nothing here chmods.
 */
export function agentHomeProblem(dir, { isDir, mode } = {}) {
  if (typeof dir !== "string" || !dir) return "has no folder";
  if (!dir.startsWith("/")) return `folder ${shown(dir)} is not an absolute path`;
  if (/[\u0000-\u001f\u007f]/.test(dir)) return `folder ${shown(dir)} has a control character`;
  if (dir === "/") return `folder ${shown(dir)} is not a login home`;
  if (typeof isDir !== "function" || typeof mode !== "function") return "cannot be checked as a private folder";
  let folder = false;
  try { folder = isDir(dir); } catch { folder = false; }
  if (!folder) return `folder ${shown(dir)} is not a folder`;
  let bits;
  try { bits = mode(dir); } catch { return `folder ${shown(dir)} cannot be checked for its mode`; }
  const permissions = Number(bits) & 0o777;
  if (permissions !== 0o700) {
    return `folder ${shown(dir)} is mode ${permissions.toString(8).padStart(4, "0")}; a login home must be 0700 (owner-only)`;
  }
  return null;
}

/** The env words that point `agent`'s launch at `dir`; [] when `agent` has no such variable (agentHomeVar). */
export function agentHomeWords(agent, dir) {
  const name = agentHomeVar(agent);
  return name ? [`${name}=${dir}`] : [];
}

/**
 * `--agent-home` checked for one launch: { words } with the single env assignment when `dir` is
 * an absolute existing 0700 folder and `agent` has a vendor config variable, else { error } with
 * the reason. The caller refuses on `error`; no launch runs on a fallback home.
 */
export function agentHomeFor(agent, dir, { isDir, mode } = {}) {
  const problem = agentHomeProblem(dir, { isDir, mode });
  if (problem) return { error: problem };
  const name = agentHomeVar(agent);
  if (!name) {
    return { error: `agent ${agent ?? "(unknown)"} has no vendor config folder this pack can set `
      + `(Claude: ${AGENT_HOME_VARS.claude}, Codex: ${AGENT_HOME_VARS.codex})` };
  }
  return { words: [`${name}=${dir}`] };
}

/** The record's path in app home `appHome`: its top level, never a mod's own folder. */
export const loginsPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${LOGINS_FILE}`;

/** The words that start a Claude launch on login A: the variable unset, never set to ~/.claude. */
export const DEFAULT_WORDS = Object.freeze(["-u", CONFIG_VAR]);

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// A path's words as they may appear in a warning: printable, at most 200 characters.
const shown = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

/**
 * Why `dir` is not a login folder in the form the sign-in and every launch pass (the form
 * rule): absolute, no `~`, no trailing slash, no `.`/`..`/empty part, no symlinked part (its
 * real path is itself), a folder, and not the default `<home>/.claude` (a set variable there
 * names a third, empty login). Null when it is.
 */
export function formProblem(dir, { realpath, isDir, home } = {}) {
  if (typeof dir !== "string" || !dir) return "has no folder";
  if (!dir.startsWith("/") || dir.includes("~")) return `folder ${shown(dir)} is not an absolute path`;
  if (dir === "/" || dir.endsWith("/") || dir.split("/").slice(1).some((p) => p === "" || p === "." || p === "..")) {
    return `folder ${shown(dir)} is not in the form launches use`;
  }
  if (home && dir === `${String(home).replace(/\/+$/, "")}/.claude`) return `folder ${shown(dir)} is the default login's own folder`;
  let real;
  try { real = realpath(dir); } catch { return `folder ${shown(dir)} does not exist`; }
  if (real !== dir) return `folder ${shown(dir)} goes through a symlink`;
  let folder = false;
  try { folder = isDir(dir); } catch { folder = false; }
  return folder ? null : `folder ${shown(dir)} is not a folder`;
}

/**
 * The record's text read as { use, logins: [{ id, dir }] }, or { problem } when it is not a
 * record this CLI can follow (corrupt, the wrong shape, an id twice).
 */
export function parseLogins(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { problem: "is not valid JSON" }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { problem: "is not a record" };
  const { use, logins } = data;
  if (typeof use !== "string" || !use) return { problem: "has no use" };
  if (!Array.isArray(logins)) return { problem: "has no logins list" };
  const seen = new Set();
  for (const l of logins) {
    if (!l || typeof l !== "object" || !ID_SHAPE.test(l.id ?? "") || l.id === DEFAULT_LOGIN || typeof l.dir !== "string") {
      return { problem: "has a login entry this CLI can't read" };
    }
    if (seen.has(l.id)) return { problem: `lists login ${l.id} twice` };
    seen.add(l.id);
  }
  return { use, logins: logins.map((l) => ({ id: l.id, dir: l.dir })) };
}

/** The warning a launch prints when the record can't be followed. */
export const loginWarning = (problem) => `${LOGINS_FILE}: ${problem}; started on the default login`;

/**
 * The login a new Claude launch uses, from the record in `appHome`: { id, dir, words, warning }.
 * `words` go on the launch's `/usr/bin/env` (envWords); `warning` is null unless the record was
 * there and couldn't be followed, and then the launch is on login A (never refused). `io`:
 * { read(path) => text (throws, code ENOENT for none), realpath, isDir, home }.
 */
export function chooseLogin(appHome, io) {
  const fallback = (problem) => ({ id: DEFAULT_LOGIN, dir: null, words: [...DEFAULT_WORDS], warning: problem ? loginWarning(problem) : null });
  let text;
  try { text = io.read(loginsPath(appHome)); } catch (e) {
    return fallback(e?.code === "ENOENT" ? null : `can't be read (${e?.code ?? "error"})`);
  }
  const record = parseLogins(text);
  if (record.problem) return fallback(record.problem);
  if (record.use === DEFAULT_LOGIN) return fallback(null);
  const login = record.logins.find((l) => l.id === record.use);
  if (!login) return fallback(`use names ${ID_SHAPE.test(record.use) ? record.use : "a login"} that it doesn't list`);
  const problem = formProblem(login.dir, io);
  if (problem) return fallback(`login ${login.id}'s ${problem}`);
  return { id: login.id, dir: login.dir, words: [`${CONFIG_VAR}=${login.dir}`], warning: null };
}

/**
 * `/usr/bin/env`'s words for a launch: `vars` (NAME=value: PATH first, then any other) with the
 * login words in their place: an unset (`-u NAME`) first, as env takes options before
 * assignments; an assignment last. [] when there is nothing to put on.
 */
export function envWords(vars = [], login = []) {
  const options = [], assignments = [];
  for (let i = 0; i < login.length; i += 1) {
    if (login[i] === "-u") { options.push("-u", login[i + 1]); i += 1; } else assignments.push(login[i]);
  }
  return [...options, ...vars, ...assignments];
}
