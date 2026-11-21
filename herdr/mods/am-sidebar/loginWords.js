// Pure Bot login words shared by the mod, CLI and proxy. Apache-2.0.

// The pack's generated Claude launch settings: the only --settings the login policy allows.
import { CLAUDE_PERSON_SETTINGS } from "./models.js";

/** The pointer file's location, as ACP's own children receive it; the entrypoint exports it. */
export const POINTER_VAR = "AUTOMAGIK_BOT_CLI_POINTER";
/** The pilot's marker: set, a launch without a usable pointer and record must refuse. */
export const REQUIRED_VAR = "AUTOMAGIK_NATIVE_WORKER_LOGIN";
/** The vendors this reader serves; any other agent's launch is unchanged. */
export const VENDORS = Object.freeze(["claude", "codex"]);
/** The one config variable each vendor reads its login from; the launch sets only that one. */
const VENDOR_VAR = Object.freeze({ claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" });
/** The vendor's config variable, or null for an agent this reader does not serve. */
const loginVar = (vendor) => (typeof vendor === "string" && Object.hasOwn(VENDOR_VAR, vendor) ? VENDOR_VAR[vendor] : null);
// The reader's launch words: the vendor's config variable at the record's folder (Claude's
// secure-storage folder rides with it, as ACP launches it), and ACP's masked credential and
// provider overrides unset. The am launch and the hc proxy's approved argv use the same words.
const BOT_LOGIN_VARS = {
  claude: [VENDOR_VAR.claude, "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  codex: [VENDOR_VAR.codex],
};
const BOT_AUTH_OVERRIDES = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
};
const botLoginOptions = (vendor) => BOT_AUTH_OVERRIDES[vendor].flatMap((name) => ["-u", name]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const assignmentName = (word) => word.slice(0, word.indexOf("="));
const executableVendor = (word) => {
  const program = word?.split("/").pop();
  return program === "claude-code" ? "claude" : loginVar(program) ? program : null;
};

/** The same launch words are used by am and by the proxy's approved argv rebuild. */
export function botLoginWords(vendor, dir) {
  return [...botLoginOptions(vendor), ...BOT_LOGIN_VARS[vendor].map((name) => `${name}=${dir}`)];
}

/** The executable's index after a complete recorded reader prefix, or -1. */
export function botLoginCommandIndex(argv) {
  let at = 1;
  while (argv[at] === "-u" && at + 1 < argv.length) at += 2;
  const masks = argv.slice(1, at);
  const start = at;
  while (at < argv.length && assignment.test(argv[at])) at += 1;
  const vendor = executableVendor(argv[at]);
  if (!vendor) return -1;
  const expected = botLoginOptions(vendor);
  // Older Claude panes have the same mask up to the Foundry addition.
  if (masks.length !== expected.length && !(vendor === "claude" && masks.length === expected.length - 2)) return -1;
  if (!masks.every((word, i) => word === expected[i])) return -1;
  const names = BOT_LOGIN_VARS[vendor];
  const dir = argv[at - names.length]?.slice(names[0].length + 1);
  return at - start >= names.length && dir?.startsWith("/")
    && names.every((name, i) => argv[at - names.length + i] === `${name}=${dir}`)
    && !argv.slice(start, at - names.length).some((word) => protectedNames.has(assignmentName(word))) ? at : -1;
}

const protectedNames = new Set([...Object.values(BOT_LOGIN_VARS).flat(), ...Object.values(BOT_AUTH_OVERRIDES).flat()]);
const protectedVars = [...protectedNames].join("|");
const protectedAssignment = new RegExp(`\\b(?:${protectedVars})(?:\\+)?=`);
const shellUnsetsLogin = new RegExp(`\\b(?:unset(?:[ \\t]+-[fv]+)*|export[ \\t]+-[fnpx]*n[fnpx]*)[ \\t]+(?:${protectedVars})\\b`);
const envUnsetsLogin = new RegExp(`\\benv(?:[ \\t]+-v)*[ \\t]+(?:-v*u[ \\t]*|--unset[ \\t=]+)(?:${protectedVars})\\b`);
const envClearsLogin = /\benv(?:[ \t]+-v)*[ \t]+(?:-[iv]*i[iv]*|--ignore-environment)\b/;

/** A command that changes the selected environment after the launch's env prefix. */
export function loginOverride(command) {
  return protectedAssignment.test(command) || shellUnsetsLogin.test(command)
    || envUnsetsLogin.test(command) || envClearsLogin.test(command);
}

export const loginRequired = (env) => env[REQUIRED_VAR] === "required";
export const loginPolicyActive = (env) => Object.hasOwn(env, POINTER_VAR) || loginRequired(env);
export const loginPolicyEnv = (env) => Object.fromEntries(
  [POINTER_VAR, REQUIRED_VAR, "DSH_HOME", "AUTOMAGIK_HOME"].filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
/**
 * The policy a DSH seat or worker is started with, so its hc proxy snapshot is the caller's and
 * never the core's: an absent pointer is forwarded as an empty one (the child then refuses
 * pointer-invalid, as the caller refused) instead of letting the core's own pointer through.
 */
export const loginPolicyForward = (env) => loginPolicyActive(env)
  ? { ...loginPolicyEnv(env), [POINTER_VAR]: env[POINTER_VAR] ?? "" } : {};
export const loginPolicyWords = (env) => Object.entries(loginPolicyForward(env)).map(([name, value]) => `${name}=${value}`);


export const DIRECT_LOGIN_PROBLEM = Object.freeze({
  code: "launch-not-direct",
  reason: "Under the Bot login policy only a direct Claude or Codex command can start; run the agent directly.",
});

/**
 * The launch past a leading `env NAME=value…` (the form am's own launches and #1490's revive
 * use): plain assignments only, none of them a login, credential or provider variable; any env
 * option (-i, -u, -S…) keeps the whole argv, which then is not direct. Null for no argv.
 */
function directArgv(argv) {
  if (!Array.isArray(argv) || !argv.every((word) => typeof word === "string")) return null;
  if (!/(^|\/)env$/.test(argv[0] ?? "")) return argv;
  let i = 1;
  while (i < argv.length && assignment.test(argv[i])) {
    if (protectedNames.has(assignmentName(argv[i]))) return argv;
    i += 1;
  }
  return argv.slice(i);
}

/** A vendor executable must be the first word (past directArgv's env), with no shell or interpreter in front of it. */
export function directLoginVendor(argv) {
  return executableVendor(directArgv(argv)?.[0]);
}

const SETTINGS_LOGIN_PROBLEM = Object.freeze({
  code: "settings-overrides-login",
  reason: "Under the Bot login policy use the pack's generated Claude launch settings.",
});

function claudeSettingsProblem(argv) {
  for (let i = 1; i < argv.length && argv[i] !== "--"; i += 1) {
    const word = argv[i];
    if (word === "--settings" && argv[++i] !== CLAUDE_PERSON_SETTINGS) return SETTINGS_LOGIN_PROBLEM;
    if (word.startsWith("--settings=") && word.slice("--settings=".length) !== CLAUDE_PERSON_SETTINGS) return SETTINGS_LOGIN_PROBLEM;
  }
  return null;
}

/** Pass through a shipped non-vendor command. Opaque commands cannot prove which login they use. */
export function loginLaunchProblem(argv, agent, shippedRun) {
  const command = directArgv(argv);
  const program = command?.[0];
  const vendor = executableVendor(program);
  if (vendor) {
    if (loginVar(agent) && vendor !== agent) return DIRECT_LOGIN_PROBLEM;
    return vendor === "claude" ? claudeSettingsProblem(command) : null;
  }
  return !loginVar(agent) && program && program === shippedRun?.[0] ? null : DIRECT_LOGIN_PROBLEM;
}

/** Record the effective home when the reader supplied the launch's Codex login. */
export const loginLaunchHome = (env, login) => login?.vendor === "codex" ? { ...env, CODEX_HOME: login.dir } : env;
