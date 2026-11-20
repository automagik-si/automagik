// The Claude login checks shared by the Accounts panel and the read on a linked machine.

export const LOGINS_FILE = "claude-logins.json";
export const CONFIG_VAR = "CLAUDE_CONFIG_DIR";
export const DEFAULT_LOGIN = "default";
/** The words a launch on login A gets: the variable unset, never set to ~/.claude. */
export const DEFAULT_WORDS = Object.freeze(["-u", CONFIG_VAR]);
/** Variables that outrank a sign-in when Herdr has them (section 5): their names only, never a value. */
export const CREDENTIAL_VARS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]);

/** How long one check (a folder, `claude auth status`, the variables) may take: well under Herdr's 30 s exec cap. */
export const PROBE_MS = 10_000;
const LATE = Object.freeze({ late: true });

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const shown = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
const trim = (p) => String(p).replace(/\/+$/, "");

export const loginsPath = (appHome) => `${trim(appHome)}/${LOGINS_FILE}`;
/** The words a launch on login `l` gets ({ id, dir }). */
export const loginWords = (l) => (l.id === DEFAULT_LOGIN ? [...DEFAULT_WORDS] : [`${CONFIG_VAR}=${l.dir}`]);
/** The record's text as { use, logins }, or { problem }: the CLI's parseLogins, same words. */
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

/** The form rule's part that needs no file system (the CLI's formProblem, same words). */
export function shapeProblem(dir, home) {
  if (typeof dir !== "string" || !dir) return "has no folder";
  if (!dir.startsWith("/") || dir.includes("~")) return `folder ${shown(dir)} is not an absolute path`;
  if (dir === "/" || dir.endsWith("/") || dir.split("/").slice(1).some((p) => p === "" || p === "." || p === "..")) {
    return `folder ${shown(dir)} is not in the form launches use`;
  }
  if (home && dir === `${trim(home)}/.claude`) return `folder ${shown(dir)} is the default login's own folder`;
  return null;
}

// `sh -c FOLDER_SCRIPT sh <dir>`: the form rule's file-system part, and the two linked files
// (section 4). One word per line: missing, symlink, notdir, or ok after any `unlinked <file>`.
export const FOLDER_SCRIPT = [
  'd=$1',
  '[ -e "$d" ] || { echo missing; exit 0; }',
  '[ -L "$d" ] && { echo symlink; exit 0; }',
  'p=${d%/*}; [ -n "$p" ] || p=/',
  'r=$(cd -- "$p" 2>/dev/null && pwd -P) || { echo missing; exit 0; }',
  '[ "$r" = "$p" ] || { echo symlink; exit 0; }',
  '[ -d "$d" ] || { echo notdir; exit 0; }',
  'for f in settings.json CLAUDE.md; do if [ -e "$d/$f" ] && [ ! -L "$d/$f" ]; then echo "unlinked $f"; fi; done',
  'echo ok',
].join("\n");
const FOLDER_WORDS = { missing: "does not exist", symlink: "goes through a symlink", notdir: "is not a folder" };

// `sh -c AUTH_SCRIPT sh <login words…>`: `claude auth status` when the CLI can't say where a launch
// finds claude (no sidebar mod): this app's PATH and ~/.local/bin. 127: no claude there.
export const AUTH_SCRIPT = 'PATH="$PATH:$HOME/.local/bin"; command -v claude >/dev/null 2>&1 || exit 127; exec /usr/bin/env "$@" claude auth status';
// `sh -c PRESENT_SCRIPT sh <names…>`: the names set in this app's environment, never a value.
export const PRESENT_SCRIPT = 'for n; do printenv -- "$n" >/dev/null && printf "%s\\n" "$n"; done; exit 0';

/**
 * `exec` bounded by `ms`: Herdr's own `timeout`, and a race whatever Herdr does with it. The
 * answer, LATE when none came in time, or null when exec threw.
 */
export async function bounded(exec, command, args, ms = PROBE_MS) {
  let timer;
  const late = new Promise((go) => { timer = setTimeout(() => go(LATE), ms); });
  try {
    return await Promise.race([Promise.resolve().then(() => exec(command, args, { timeout: ms })).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What `claude auth status` said, as { state: "in" | "out" | "nobin" | "unread" | "late", email,
 * configDirectory, authMethod }: four fields, the rest of its output dropped and never kept.
 * Signed out only when its JSON says `loggedIn: false`; an exit 1 with no such JSON (a crash, a
 * bad config) is unread, never signed out.
 */
export function readStatus(r) {
  return statusOf(r).status;
}

function statusOf(r) {
  const unconfirmed = (state) => ({ status: { state }, signedIn: false });
  if (r?.late) return unconfirmed("late");
  if (r?.code === 127) return unconfirmed("nobin");
  let data = null;
  try { data = JSON.parse(String(r?.stdout ?? "")); } catch {}
  if (!data || typeof data !== "object" || Array.isArray(data)) return unconfirmed("unread");
  const pick = (k) => (typeof data[k] === "string" && data[k] ? data[k] : null);
  const fields = { email: pick("email"), configDirectory: pick("configDirectory"), authMethod: pick("authMethod") };
  if (data.loggedIn === false && (r.code === 0 || r.code === 1)) return { status: { state: "out", ...fields }, signedIn: false };
  if (r.code !== 0) return unconfirmed("unread");
  return { status: { state: "in", ...fields }, signedIn: data.loggedIn === true };
}

/**
 * The command that asks `claude auth status` of login `l` as a launch on it would run claude:
 * `where` is the CLI's `launch-path claude` ({ program, path }), so claude is the file a launch
 * runs, with the PATH its pane gets and the login's own words in env's order (options first, an
 * assignment last). `where.args`: the rest of the launcher's run list, before claude's own words.
 * Without `where` (no sidebar mod), AUTH_SCRIPT. Null: no claude to run.
 */
export function authCommand(l, where) {
  if (where === undefined || where === null) return ["sh", ["-c", AUTH_SCRIPT, "sh", ...loginWords(l)]];
  if (!where.program) return null;
  const words = l.id === DEFAULT_LOGIN ? [...DEFAULT_WORDS, `PATH=${where.path}`] : [`PATH=${where.path}`, `${CONFIG_VAR}=${l.dir}`];
  return ["/usr/bin/env", [...words, where.program, ...(where.args ?? []), "auth", "status"]];
}

/** `claude auth status` of login `l` (readStatus's shape), bounded; `where` as authCommand takes it. */
export async function askStatus(l, io) {
  return (await askStatusWithSignIn(l, io)).status;
}

async function askStatusWithSignIn(l, { exec, where, ms = PROBE_MS }) {
  const cmd = authCommand(l, where);
  return statusOf(cmd ? await bounded(exec, cmd[0], cmd[1], ms) : { code: 127 });
}

/** The one email field of a `.claude.json` (its account record), or null; nothing else is kept. */
export function accountEmail(text) {
  try {
    const e = JSON.parse(String(text ?? ""))?.oauthAccount?.emailAddress;
    return typeof e === "string" && e.includes("@") ? e : null;
  } catch {
    return null;
  }
}

/**
 * The record as the panel reads it: { text: the snapshot a write must replace (null: no file),
 * use, logins, problem: why the CLI can't follow it, or null }. No file is login A, no problem.
 */
export async function readRecord(appHome, readTextFile) {
  let text;
  try { text = await readTextFile(loginsPath(appHome)); } catch (e) {
    return { text: undefined, use: DEFAULT_LOGIN, logins: [], problem: `can't be read (${e?.code ?? "error"})` };
  }
  if (text === null || text === undefined) return { text: null, use: DEFAULT_LOGIN, logins: [], problem: null };
  const r = parseLogins(text);
  if (r.problem) return { text, use: DEFAULT_LOGIN, logins: [], problem: r.problem };
  if (r.use !== DEFAULT_LOGIN && !r.logins.some((l) => l.id === r.use)) {
    return { text, use: r.use, logins: r.logins, problem: `use names ${ID_SHAPE.test(r.use) ? r.use : "a login"} that it doesn't list` };
  }
  return { text, use: r.use, logins: r.logins, problem: null };
}

/**
 * One login, looked at: { id, dir, problem: its folder's form problem or null, unlinked: the
 * linked files that are files of their own, status (readStatus), signedIn, email }. `io`: { exec, home,
 * readTextFile, where, ms }. A folder with a problem is never asked about its sign-in. Each
 * check is bounded (PROBE_MS): one that doesn't answer is said, never waited on.
 */
export async function probeLogin(login, { exec, home, readTextFile, where, ms = PROBE_MS }) {
  const out = { id: login.id, dir: login.dir, problem: null, code: null, unlinked: [], status: { state: "unread" }, signedIn: false, email: null };
  if (login.id !== DEFAULT_LOGIN) {
    const shape = shapeProblem(login.dir, home);
    if (shape) return { ...out, problem: shape, code: "bad-folder" };
    const r = await bounded(exec, "sh", ["-c", FOLDER_SCRIPT, "sh", login.dir], ms);
    if (r?.late) return { ...out, problem: `folder ${shown(login.dir)} couldn't be checked in ${ms / 1000} s`, code: "timeout" };
    const lines = String(r?.stdout ?? "").split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (r?.code !== 0 || !last) return { ...out, problem: `folder ${shown(login.dir)} couldn't be checked`, code: "bad-folder" };
    if (FOLDER_WORDS[last]) return { ...out, problem: `folder ${shown(login.dir)} ${FOLDER_WORDS[last]}`, code: "bad-folder" };
    out.unlinked = lines.filter((l) => l.startsWith("unlinked ")).map((l) => l.slice(9));
  }
  const { status, signedIn } = await askStatusWithSignIn(login, { exec, where, ms });
  out.status = status;
  out.signedIn = signedIn;
  out.email = out.status.email;
  if (!out.email && out.status.state === "in") {
    const file = login.id === DEFAULT_LOGIN ? `${trim(home)}/.claude.json` : `${login.dir}/.claude.json`;
    out.email = accountEmail(await readTextFile(file).catch(() => null));
  }
  return out;
}

/** The credential variables set in this app's environment (names), or null when that can't be read. */
export async function presentVars(exec, ms = PROBE_MS) {
  const r = await bounded(exec, "sh", ["-c", PRESENT_SCRIPT, "sh", ...CREDENTIAL_VARS], ms);
  if (r?.code !== 0) return null;
  return String(r.stdout ?? "").split("\n").filter((n) => CREDENTIAL_VARS.includes(n));
}

// `sh -c REAL_SCRIPT sh <dir>`: the folder's real path, as the form rule compares it.
export const REAL_SCRIPT = 'cd -- "$1" 2>/dev/null && pwd -P';

/**
 * Which login a pane was launched on, from its launch argv (hc get's `argv`, never the process
 * in front), by value (section 3): { id } for a listed folder or `-u CLAUDE_CONFIG_DIR` (login A),
 * { unknown: dir } for a folder no login lists, { why } when it can't be told. Only env's own
 * options and assignments are read, so a `CLAUDE_CONFIG_DIR=` inside a template's command never
 * counts; an assignment wins over an unset, as env applies them.
 */
export function paneLogin(argv, logins) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((w) => typeof w === "string")) return { why: "hc gave no launch argv" };
  const untracked = { why: "started before logins were tracked" };
  if (argv[0].split("/").pop() !== "env") return untracked;
  let i = 1;
  let unset = false;
  for (; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === "-u" || w === "--unset") { unset ||= argv[i + 1] === CONFIG_VAR; i += 1; } else if (w === `-u${CONFIG_VAR}` || w === `--unset=${CONFIG_VAR}` || w === "-i") unset = true;
    else if (!/^(-u.|--unset=)/.test(w)) break;
  }
  let dir = null;
  for (; i < argv.length && ASSIGN.test(argv[i]); i += 1) if (argv[i].startsWith(`${CONFIG_VAR}=`)) dir = argv[i].slice(CONFIG_VAR.length + 1);
  // As text the form rule would take it: no doubled or trailing slash (a link: matchReal).
  if (dir !== null && dir.startsWith("/")) dir = dir.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  if (dir !== null) {
    const l = logins.find((x) => x.dir === dir);
    return l ? { id: l.id } : { unknown: dir };
  }
  return unset ? { id: DEFAULT_LOGIN } : untracked;
}

/** The same probe without login words, as a start from another machine runs it. */
export function bareCommand(where) {
  if (where == null) return ["sh", ["-c", AUTH_SCRIPT, "sh"]];
  if (!where.program) return null;
  return ["/usr/bin/env", [`PATH=${where.path}`, where.program, "auth", "status"]];
}

export async function askBare({ exec, where, ms = PROBE_MS }) {
  const cmd = bareCommand(where);
  return cmd ? readStatus(await bounded(exec, cmd[0], cmd[1], ms)) : { state: "nobin" };
}

export function slotState(probe, { vars, home }) {
  if (probe.code) return probe.code;
  if (probe.status.state === "late") return "timeout";
  if (probe.status.state === "out") return "not-signed-in";
  if (probe.status.state !== "in" || !probe.email || vars === null) return "failed";
  if (!probe.status.email && probe.signedIn !== true) return "failed";
  const folder = probe.id === DEFAULT_LOGIN ? `${trim(home)}/.claude` : probe.dir;
  const { authMethod, configDirectory } = probe.status;
  if (vars.some((name) => CREDENTIAL_VARS.includes(name)) || (authMethod && authMethod !== "claude.ai")
    || (configDirectory && trim(configDirectory) !== folder)) return "override";
  return "eligible";
}

export function slotStates(probes, io) {
  const counts = new Map();
  const slots = probes.map((probe) => {
    const email = probe.status.state === "in" && (probe.status.email || probe.signedIn === true) ? probe.email?.toLowerCase() ?? null : null;
    if (email) counts.set(email, (counts.get(email) ?? 0) + 1);
    const dir = probe.id !== DEFAULT_LOGIN && !shapeProblem(probe.dir, io.home) ? probe.dir : null;
    return { id: probe.id, dir, email, state: slotState(probe, io) };
  });
  for (const slot of slots) {
    if (counts.get(slot.email) > 1 && ["eligible", "override"].includes(slot.state)) slot.state = "ambiguous";
  }
  return slots;
}
