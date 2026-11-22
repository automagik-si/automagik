// Chosen login homes for new workers (#1208): `am worker --agent-home DIR` and a bot's
// `worker.agentHome` start one Claude or Codex worker on a login folder the person picks
// (CLAUDE_CONFIG_DIR, CODEX_HOME). The CLI's pure part: the folder check, the credential
// variables such a launch unsets, its launch words, the one proof that a pane is such a launch
// (its argv's signature), and the repository settings that would pick another account. The
// roster's own pieces (the field's shape, which agents take it) are model.js's, which the hc
// proxy and the roster read. Pure (model.js only), so `node --test` runs it; model.js and
// workers.js never import it, so the modules the desktop and the guard copy stay as they were.
// Apache-2.0.

import { AGENT_HOME_VARS, agentHomeAgent, agentHomePathProblem, hasWorkerHome } from "./model.js";

export { AGENT_HOME_VARS, agentHomeAgent, agentHomePathProblem, hasWorkerHome };

/**
 * The credential and provider variables a chosen launch unsets, in this order, so a key in
 * herdr-core's or the pane's environment can't outrank the chosen folder's sign-in.
 */
export const AGENT_HOME_UNSETS = Object.freeze({
  claude: Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]),
  codex: Object.freeze(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]),
});
/** Claude's secure-storage folder, set beside CLAUDE_CONFIG_DIR (as apps/acp-dsh's cli-homes.js does). */
export const CLAUDE_STORAGE_VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
/** The per-launch id every chosen launch carries in its argv (a v4 UUID). */
export const LAUNCH_VAR = "AUTOMAGIK_AGENT_HOME_LAUNCH";
/** Where `env` runs from in every pack launch (workers.js ENV). */
const ENV_PATH = "/usr/bin/env";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Whether `id` is a launch id as a chosen launch writes one. */
export const agentHomeLaunchId = (id) => typeof id === "string" && UUID_V4.test(id);

/**
 * The folder one chosen launch of `agent` runs on: { home } (its real path), or { error } with the
 * reason. It must be an existing directory owned by `uid` with mode exactly 0700 (no setuid,
 * setgid or sticky bit either). Claude's default folder (`defaultClaude`, ~/.claude) and anything
 * resolving to it are refused: setting CLAUDE_CONFIG_DIR there names another, empty login
 * (logins.js formProblem), and the default login needs no flag. `io`: { realpath, stat, uid,
 * defaultClaude }, injected so this stays pure.
 */
export function agentHomeFor(agent, dir, { realpath, stat, uid, defaultClaude } = {}) {
  if (!agentHomeAgent(agent)) return { error: `only Claude and Codex take a chosen home (${agent ?? "no agent"} keeps its own login)` };
  const shape = agentHomePathProblem(dir);
  if (shape) return { error: `${JSON.stringify(String(dir ?? ""))} ${shape}` };
  let home = null, info = null;
  try { home = realpath(dir); info = stat(home); } catch { /* not there, or not readable */ }
  if (!info?.isDirectory?.()) return { error: `${JSON.stringify(dir)} is not a folder` };
  const realShape = agentHomePathProblem(home);
  if (realShape) return { error: `${JSON.stringify(dir)} resolves to ${JSON.stringify(home)}, which ${realShape}` };
  if (agent === "claude" && typeof defaultClaude === "string" && defaultClaude) {
    let defaultReal = defaultClaude;
    try { defaultReal = realpath(defaultClaude); } catch { /* the default may not exist */ }
    if (home === defaultReal || home === defaultClaude) return { error: `${JSON.stringify(dir)} is Claude's default login folder; omit --agent-home for the default login` };
  }
  if (info.uid !== uid) return { error: `${JSON.stringify(home)} must be owned by the current user` };
  const mode = info.mode & 0o7777;
  if (mode !== 0o700) return { error: `${JSON.stringify(home)} is mode ${mode.toString(8).padStart(4, "0")}; a login home must be 0700` };
  return { home };
}

const sameWords = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * Why a chosen launch of `agent` can't run its configured command: the run Herdr's table gives it
 * (programs.json applied) must be exactly the shipped one, so no word before the task comes from
 * a user override (an env prefix, a --settings file, a provider or profile). Null when it is.
 */
export function agentHomeRunProblem(agent, configured, shipped) {
  return sameWords(configured, shipped) ? null : `--agent-home runs ${agent}'s shipped command; programs.json overrides it here`;
}

/**
 * The login words of a chosen launch, in logins.js envWords' form: each unset first (env takes
 * options before assignments), then the vendor's folder (and Claude's secure-storage folder),
 * then the launch id. envWords puts the PATH word between the unsets and the assignments.
 */
export function chosenHomeWords(agent, home, launch) {
  return [...AGENT_HOME_UNSETS[agent].flatMap((key) => ["-u", key]), `${AGENT_HOME_VARS[agent]}=${home}`,
    ...(agent === "claude" ? [`${CLAUDE_STORAGE_VAR}=${home}`] : []), `${LAUNCH_VAR}=${launch}`];
}

// hc's keep wrapper (hc run --keep, launchArgs.js unwrapKeep), inlined: launchArgs.js imports workers.js.
const KEEP_WRAPPER = '"$@"; exec "${SHELL:-sh}" -i';
const SHELLS = new Set(["sh", "zsh", "bash", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
const unwrapKeep = (argv) => (Array.isArray(argv) && argv.length >= 5 && SHELLS.has(String(argv[0]).split("/").pop().replace(/^-/, ""))
  && argv[1] === "-c" && argv[2] === KEEP_WRAPPER ? argv.slice(4) : argv);

/**
 * { agent, home, launch } when `argv` (a pane's launch argv, hc get's `argv`) is a chosen launch:
 * exactly `/usr/bin/env -u V1 … -u Vn PATH=… <VENDOR>=<home> [CLAUDE_SECURESTORAGE_CONFIG_DIR=<home>]
 * AUTOMAGIK_AGENT_HOME_LAUNCH=<uuid> <agent> …`, with the agent's whole unset list in its order.
 * Anything else is null (an ordinary launch): no other pack launch writes that unset run, and a
 * Claude Accounts login is `CLAUDE_CONFIG_DIR=<dir>` alone.
 */
export function chosenHomeOfArgv(argv) {
  const words = unwrapKeep(argv);
  if (!Array.isArray(words) || words[0] !== ENV_PATH) return null;
  for (const [agent, key] of Object.entries(AGENT_HOME_VARS)) {
    const pathAt = 1 + AGENT_HOME_UNSETS[agent].length * 2;
    const vendor = `${key}=`;
    if (typeof words[pathAt] !== "string" || !words[pathAt].startsWith("PATH=")
        || typeof words[pathAt + 1] !== "string" || !words[pathAt + 1].startsWith(vendor)) continue;
    const home = words[pathAt + 1].slice(vendor.length);
    const launchAt = pathAt + (agent === "claude" ? 3 : 2);
    const marker = `${LAUNCH_VAR}=`;
    if (agentHomePathProblem(home) || typeof words[launchAt] !== "string" || !words[launchAt].startsWith(marker)) continue;
    const launch = words[launchAt].slice(marker.length);
    if (!agentHomeLaunchId(launch) || words[launchAt + 1] !== agent) continue;
    const prefix = [...words.slice(1, pathAt), ...words.slice(pathAt + 1, launchAt + 1)];
    if (sameWords(prefix, chosenHomeWords(agent, home, launch))) return { agent, home, launch };
  }
  return null;
}

// ---- repository settings that would pick another account ----

/** The worktree files read before a chosen launch, for each agent (relative to the worktree). */
export const agentHomeSettingsFiles = Object.freeze({
  claude: Object.freeze([".claude/settings.json", ".claude/settings.local.json"]),
  codex: Object.freeze([".codex/config.toml"]),
});
/** Claude settings `env` keys that would replace the chosen folder or its sign-in. */
const CLAUDE_SETTINGS_ENV = Object.freeze([...AGENT_HOME_UNSETS.claude, AGENT_HOME_VARS.claude, CLAUDE_STORAGE_VAR]);
/** Codex config keys that pick a provider, a profile or a login method: refused wherever they appear as a token. */
const CODEX_SETTINGS_KEY = /(^|[\s."'[{,])(model_provider|model_providers|profile|profiles|preferred_auth_method|forced_login_method|chatgpt_base_url)(?=["'\s.=\]},]|$)/m;

/**
 * `text` (TOML) with its comments taken out and its basic strings' escapes decoded, so a key
 * written `"model_provider"` reads as the key it is and a `#` inside a string stays the
 * string's. Null when a string never ends (input Codex itself would refuse, and this can't read).
 */
function tomlWithoutComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const escape = (at) => {
    const c = text[at + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
    if (Object.hasOwn(simple, c)) return { text: simple[c], next: at + 2 };
    const width = c === "u" ? 4 : c === "U" ? 8 : c === "x" ? 2 : 0;
    const hex = width ? text.slice(at + 2, at + 2 + width) : "";
    if (width && /^[0-9a-fA-F]+$/.test(hex) && hex.length === width) {
      const code = Number.parseInt(hex, 16);
      return { text: code <= 0x10ffff ? String.fromCodePoint(code) : "", next: at + 2 + width };
    }
    return { text: c ?? "", next: at + 2 };
  };
  while (i < n) {
    const c = text[i];
    if (c === "#") { while (i < n && text[i] !== "\n") i += 1; continue; }
    const triple = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : null;
    if (triple) {
      out += triple;
      let j = i + 3;
      for (;;) {
        if (j >= n) return null;
        if (triple === '"""' && text[j] === "\\") {
          // A line-ending backslash trims the newline and the whitespace after it.
          if (/^\\[ \t]*\r?\n/.test(text.slice(j, j + 64))) { j += 1; while (j < n && /\s/.test(text[j])) j += 1; continue; }
          const e = escape(j);
          out += e.text;
          j = e.next;
          continue;
        }
        if (text.startsWith(triple, j)) break;
        out += text[j];
        j += 1;
      }
      let end = j + 3;
      for (let extra = 0; extra < 2 && text[end] === triple[0]; extra += 1) { out += text[end]; end += 1; }
      out += triple;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      let j = i + 1;
      for (;;) {
        if (j >= n || text[j] === "\n") return null;
        if (text[j] === c) break;
        if (c === '"' && text[j] === "\\") { const e = escape(j); out += e.text; j = e.next; continue; }
        out += text[j];
        j += 1;
      }
      out += c;
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Why a worktree settings file's `text` would pick another account for a chosen launch of
 * `agent`, or null: safe to print, never a value. Claude (`.claude/settings.json`,
 * `.claude/settings.local.json`): invalid JSON, not an object, an `apiKeyHelper`, or an `env`
 * naming a credential variable, CLAUDE_CONFIG_DIR or its secure-storage folder. Codex
 * (`.codex/config.toml`): any provider, profile or login-method key name as a token, bare or
 * quoted, in a key, a dotted path, a table header or an inline table (ambiguous text is refused).
 */
export function agentHomeSettingsProblem(agent, text) {
  if (agent === "codex") {
    const plain = tomlWithoutComments(String(text));
    if (plain === null) return "has a string that never ends";
    const hit = CODEX_SETTINGS_KEY.exec(plain);
    return hit ? `sets ${hit[2]}` : null;
  }
  let settings;
  try { settings = JSON.parse(text); } catch { return "isn't valid JSON"; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "isn't a JSON object";
  if (Object.hasOwn(settings, "apiKeyHelper")) return "sets apiKeyHelper";
  const env = settings.env;
  if (env !== null && typeof env === "object") {
    const key = CLAUDE_SETTINGS_ENV.find((k) => Object.hasOwn(env, k));
    if (key) return `sets env ${key}`;
  }
  return null;
}
