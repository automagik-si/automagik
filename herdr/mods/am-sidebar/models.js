// Coding agents and their models (A12): how each agent is started, which model a running
// one uses (read from its foreground command line), its own configured default, a short
// list of models a bot may be pinned to, and the flag that passes a pin at Start.
// Pure: no `herdr`, `gpui-kit`, `gpui-base` or `fs`; files are read through an injected
// `read(path) => string | null`, so `node --test` runs it and the CLI and the mod share it.
// Apache-2.0.
import { LEGACY_AGENTS } from "./retired.js";
import { hermesPairRun } from "./hermesPair.js";

/**
 * The agents people start, keyed as Herdr's shipped programs table keys them (the table in
 * the Herdr binary, 2026-11-01: the entries with a `run`), plus `omp` (Oh My Pi, which this
 * host's templates start). `run` is how Herdr starts each one; `match` other process names.
 * `programs.json` in the app home may override `run` or add entries (see withOverrides).
 */
export const AGENTS = Object.freeze({
  claude: { name: "Claude Code", run: ["claude"], match: ["claude-code"] },
  codex: { name: "Codex", run: ["codex"] },
  pi: { name: "Pi", run: ["pi"] },
  omp: { name: "Oh My Pi", run: ["omp"] },
  opencode: { name: "OpenCode", run: ["opencode"] },
  cursor: { name: "Cursor", run: ["cursor-agent"], match: ["cursor-agent"] },
  copilot: { name: "Copilot", run: ["copilot"], match: ["github-copilot"] },
  amp: { name: "Amp", run: ["amp"] },
  grok: { name: "Grok", run: ["grok"] },
  // agy takes permission flags (--dangerously-skip-permissions, --mode accept-edits|auto|plan,
  // --sandbox). Its --mode auto is not available where its terminal sandbox or the account
  // lacks it, and agy then continues in manual mode (#955), so this pack passes --mode
  // (agyModeArgs) and --dangerously-skip-permissions (AUTO_MODE), the second only beside a
  // --settings file whose deny list agy still enforces (agyGuarded). It never writes agy's own
  // settings, so its saved trust list and settings stay the person's.
  antigravity: { name: "Antigravity", run: ["agy"], match: ["agy"] },
  kimi: { name: "Kimi", run: ["kimi"] },
  kiro: { name: "Kiro", run: ["kiro-cli"], match: ["kiro-cli"] },
  hermes: { name: "Hermes", run: ["hermes"] },
  qoder: { name: "Qoder", run: ["qodercli"], match: ["qodercli"] },
  crush: { name: "Crush", run: ["crush"] },
  // DSH in a pane (#598), through the dsh-tui command (the installer's shim, dshTui.mjs), which
  // picks its own DSH profile: this pack names only the command. Interactive only (DSH 0.2.2-rc.1:
  // `dsh-tui run` and `-p` exit 3, ADAPTER_UNAVAILABLE), and never with a permission, add-dir or
  // approval flag: the profile on that machine sets its sandbox, and dsh-tui would read such a
  // flag as prompt text. Its permission presets gate only the filesystem sandbox and the approval
  // policy: network is unrestricted by design (the lead's ruling, as on the Mac), so the usual
  // rules hold: no secret printed, no external post or production access without the owner.
  "dsh-tui": { name: "dsh-TUI", run: ["dsh-tui"] },
});

// Agents whose model and effort come from elsewhere, never a launch flag (#598): a --model or
// --effort for one (a bot's pin, a worker's, a bot's worker defaults) is refused with this line,
// where any other agent with no such flag has it left out with a warning.
const FIXED_MODEL = {
  "dsh-tui": "dsh-TUI takes no --model or --effort: its DSH profile on the machine it runs on sets both.",
};
/** Why `agentKey` takes no --model or --effort (FIXED_MODEL), or null when it may. */
export const modelRefusal = (agentKey) => FIXED_MODEL[agentKey] ?? null;

/**
 * Agents that are gone, mapped to the one that replaces them (retired.js, the pack's one list):
 * a bot or a typed --agent naming `gemini` runs Antigravity (`agy`). Herdr's own table still
 * lists gemini; the bot form leaves these keys out of its picker.
 */
export { LEGACY_AGENTS };

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * AGENTS with an app home's `programs.json` text applied (null: none): an entry there with
 * a `run` list overrides that agent's `run` or adds an agent, as Herdr's knownAgents() does.
 * A text that doesn't parse changes nothing.
 */
export function withOverrides(programsText) {
  const out = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, { ...v }]));
  let programs = null;
  try { programs = programsText ? JSON.parse(programsText)?.programs : null; } catch { programs = null; }
  if (!isObject(programs)) return out;
  for (const [key, p] of Object.entries(programs)) {
    if (!isObject(p)) continue;
    const run = Array.isArray(p.run) && p.run.length && p.run.every((w) => typeof w === "string") ? p.run : null;
    if (out[key]) { if (run) out[key].run = run; if (typeof p.name === "string") out[key].name = p.name; }
    else if (run) out[key] = { name: typeof p.name === "string" ? p.name : key, run, ...(Array.isArray(p.match) ? { match: p.match } : {}) };
  }
  return out;
}

// Programs that run another program named in their arguments (Herdr's "interpreters").
const INTERPRETERS = new Set(["node", "bun", "bunx", "deno", "python", "python3", "npx", "pnpm", "yarn", "uv", "uvx",
  "ruby", "bundle", "env", "sudo", "nice", "time", "watch", "nodemon"]);
const base = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");

// The index of the agent's own executable in `words`: past any interpreter and its flags. env's
// `-u NAME` (`--unset NAME`) takes the next word, so `env -u CLAUDE_CONFIG_DIR PATH=… claude`
// (a launch on the default Claude login, logins.js) runs claude, not CLAUDE_CONFIG_DIR.
function programAt(words) {
  let i = 0;
  while (i < words.length && INTERPRETERS.has(base(words[i]))) {
    const env = base(words[i]) === "env";
    i += 1;
    while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
      i += env && (words[i] === "-u" || words[i] === "--unset") ? 2 : 1;
    }
  }
  return i;
}

/**
 * The agent's own arguments in a foreground argv: past any interpreter (`bun …/omp`,
 * `node …/codex.js`, `env K=V claude`) and its flags. Returns { program, args }, `program`
 * the basename of the agent's executable (".js"/".mjs"/".cjs" dropped).
 */
export function agentArgv(argv) {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  const i = programAt(words);
  if (i >= words.length) return { program: words.length ? base(words[0]) : "", args: [] };
  return { program: base(words[i]).replace(/\.(m|c)?js$/, ""), args: words.slice(i + 1) };
}

/** The agent key a foreground argv runs, by `run[0]`, key or `match` in `agents`, or null. */
export function agentKeyOfArgv(argv, agents = AGENTS) {
  const { program } = agentArgv(argv);
  if (!program) return null;
  for (const [key, a] of Object.entries(agents)) {
    if (key === program || base(a.run?.[0]) === program || (a.match ?? []).includes(program)) return key;
  }
  return null;
}

// Each agent's model flags, read from `<agent> --help` on this host (2026-11-01: Claude Code
// 2.1.316, codex, omp, pi; 2026-11-09: agy 1.5.3, whose Go parser takes -model as --model). Agents not installed here have none listed, so their
// model is never guessed: detectModel and modelArgs give null / [] for them.
const FLAGS = {
  claude: { long: ["--model"] },
  codex: { long: ["--model"], short: ["-m"], config: ["-c", "--config"] },
  antigravity: { long: ["--model", "-model"] },
  pi: { long: ["--model"] },
  omp: { long: ["--model"] },
};

const unquote = (v) => String(v).trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * The model a running agent was started with, read from its foreground argv (A12), or
 * null when the command line names none (the agent then runs its own default). The last
 * flag wins, as each agent's own parser has it. Exact flags only: `--fallback-model`,
 * `--models` or codex's `-c model_provider=…` are not the model.
 */
export function detectModel(argv, agentKey) {
  const { program, args } = agentArgv(argv);
  const key = FLAGS[agentKey] ? agentKey : agentKeyOfArgv(argv);
  const flags = FLAGS[key];
  if (!flags || !program) return null;
  let model = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--") break;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : null;
    if ((flags.long ?? []).includes(name) || (flags.short ?? []).includes(name)) {
      const v = inline ?? args[i + 1];
      if (inline === null) i += 1;
      if (typeof v === "string" && v !== "" && !v.startsWith("-")) model = unquote(v);
    } else if ((flags.short ?? []).some((s) => a.startsWith(s) && a.length > s.length && !a.startsWith("--"))) {
      model = unquote(a.slice(2)); // -mgpt-x
    } else if ((flags.config ?? []).includes(name)) {
      const v = inline ?? args[i + 1];
      if (inline === null) i += 1;
      const m = /^\s*model\s*=\s*(.+)$/.exec(v ?? "");
      if (m) model = unquote(m[1]);
    }
  }
  return model;
}

// Top-level `model = "…"` of a TOML text: before the first [section] (profiles carry their own).
function tomlTopModel(text) {
  for (const line of String(text).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*model\s*=\s*(["'])(.*?)\1\s*(#.*)?$/.exec(line);
    if (m) return m[2];
  }
  return null;
}

/**
 * The agents' own config files this module reads, by name, under a home folder. A caller
 * whose file reads are async (the mod's readTextFile) reads these first and passes the
 * texts to defaultModelFrom / knownModelsFrom.
 */
export function configPaths(home) {
  return {
    claudeSettings: `${home}/.claude/settings.json`,
    codexConfig: `${home}/.codex/config.toml`,
    codexModels: `${home}/.codex/models_cache.json`,
    hermesConfig: `${home}/.hermes/config.yaml`,
    antigravitySettings: `${home}/.gemini/antigravity-cli/settings.json`,
  };
}

// Every config text (null when missing) through a synchronous `read(path)`.
function textsOf(home, read) {
  const out = {};
  for (const [name, path] of Object.entries(configPaths(home))) {
    try { out[name] = read(path) ?? null; } catch { out[name] = null; }
  }
  return out;
}

const parseJson = (t) => { try { return typeof t === "string" && t ? JSON.parse(t) : null; } catch { return null; } };

/**
 * The model an agent runs when its command line names none: its own configured default,
 * when that is one cheap local file (Claude Code: `~/.claude/settings.json` `model`; Codex:
 * `~/.codex/config.toml` top-level `model`; Antigravity: `~/.gemini/antigravity-cli/settings.json`
 * `model`, the label `/model` saved). Null for every other agent, or when the file or key is missing.
 * `texts`: configPaths' names mapped to each file's text (null or absent: no file).
 */
export function defaultModelFrom(agentKey, texts = {}) {
  if (agentKey === "claude") {
    const m = parseJson(texts.claudeSettings)?.model;
    return typeof m === "string" && m ? m : null;
  }
  if (agentKey === "codex") return typeof texts.codexConfig === "string" ? tomlTopModel(texts.codexConfig) : null;
  if (agentKey === "antigravity") {
    const m = parseJson(texts.antigravitySettings)?.model;
    return typeof m === "string" && m ? m : null;
  }
  return null;
}

/** defaultModelFrom over a synchronous `read(path) => string | null` under `home` (the CLI). */
export function defaultModel(agentKey, { home, read }) {
  return defaultModelFrom(agentKey, textsOf(home, read));
}

// Claude Code: the aliases `claude --help` names ("an alias for the latest model (e.g.
// 'sonnet' or 'opus')") and the current model ids of the Claude 5 family (2026-11-01).
const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** Where the cache lives under an app home; the folder holds the pack's ledgers too. */
export const AG_MODELS_FILE = "automagik-herdr/antigravity-models.json";
// A list longer than this is not `agy models` (a corrupted file or a noisy program): refused.
const MAX_MODELS = 200;
// A model id the cache may keep: one word, never an option (it goes to --model).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** `~`-free path of the cache under `appHome` (a trailing slash is not doubled). */
export const agModelsPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${AG_MODELS_FILE}`;

/**
 * The models in `agy models`' stdout: one `id<TAB>label` line each (a run of spaces between the
 * two reads the same; a line with no separator, or an id that isn't one word, is skipped).
 * Duplicates keep the first; at most MAX_MODELS.
 */
export function parseAgModelsOutput(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\S+)(?:\t+| {2,})(.+?)\s*$/.exec(line);
    if (!m) continue;
    const id = m[1];
    if (!MODEL_ID.test(id) || out.some((x) => x.id === id)) continue;
    out.push({ id, label: m[2].trim() });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** The cache text for `models` listed at `at` (a Date.now() number or an ISO string). */
export function agModelsCacheText(models, at = Date.now()) {
  const when = typeof at === "string" ? at : new Date(at).toISOString();
  const kept = (Array.isArray(models) ? models : []).filter((m) => typeof m?.id === "string" && MODEL_ID.test(m.id))
    .slice(0, MAX_MODELS).map((m) => ({ id: m.id, label: typeof m.label === "string" ? m.label : "" }));
  return `${JSON.stringify({ version: 1, source: "agy models", at: when, models: kept }, null, 2)}\n`;
}

/**
 * A cache text as { at, models: [{ id, label }] }, or null when it isn't the pack's cache (not
 * JSON, no models, a model id that isn't one word). An older file with bare strings still reads.
 */
export function parseAgModelsCache(text) {
  const data = parseJson(text);
  if (!data || typeof data !== "object" || !Array.isArray(data.models)) return null;
  const models = [];
  for (const m of data.models) {
    const id = typeof m === "string" ? m : m?.id;
    if (typeof id !== "string" || !MODEL_ID.test(id) || models.some((x) => x.id === id)) continue;
    models.push({ id, label: typeof m?.label === "string" ? m.label : "" });
    if (models.length >= MAX_MODELS) break;
  }
  if (!models.length) return null;
  const at = typeof data.at === "string" && Number.isFinite(Date.parse(data.at)) ? data.at : null;
  return { at, models };
}

/**
 * The models a bot running `agentKey` may be pinned to (A12: picked from a list, never
 * typed). Claude Code: CLAUDE_MODELS above. Codex: the slugs in its own model cache,
 * `~/.codex/models_cache.json` `.models[].slug`, which Codex refreshes itself. Antigravity:
 * the ids the pack's cache holds from `agy models` (the format above; its settings keep a label
 * `--model` may not take), plus that cache's labels for the picker. Any other agent: plus its
 * configured default (defaultModelFrom). Others: empty (no pin offered).
 * `texts` as for defaultModelFrom; Antigravity's `antigravityModels` text is the cache's.
 */
export function knownModelsFrom(agentKey, texts = {}) {
  const out = [];
  const add = (m) => { if (typeof m === "string" && m && !out.includes(m)) out.push(m); };
  if (agentKey === "claude") CLAUDE_MODELS.forEach(add);
  if (agentKey === "codex") {
    const cache = parseJson(texts.codexModels);
    for (const m of Array.isArray(cache?.models) ? cache.models : []) add(m?.slug ?? m?.id);
  }
  if (agentKey === "antigravity") for (const m of parseAgModelsCache(texts.antigravityModels)?.models ?? []) add(m.id);
  else add(defaultModelFrom(agentKey, texts));
  return out;
}

/**
 * knownModelsFrom over a synchronous `read(path)` under `home`, plus the pack's Antigravity
 * model cache under `appHome`. No reader: the static list (Claude's), and no Antigravity list.
 */
export function knownModels(agentKey, { home, read, appHome } = {}) {
  const texts = read && home ? textsOf(home, read) : {};
  if (read && appHome) {
    try { texts.antigravityModels = read(agModelsPath(appHome)) ?? null; } catch { texts.antigravityModels = null; }
  }
  return knownModelsFrom(agentKey, texts);
}

/** The arguments that start `agentKey` on `model` (A12), [] when there is no pin or no known flag. */
export function modelArgs(agentKey, model) {
  if (!model) return [];
  if (agentKey === "omp") return [`--model=${model}`]; // omp's help spells it --model=<value>
  const flags = FLAGS[agentKey];
  if (!flags) return [];
  return [flags.long?.[0] ?? flags.short[0], model];
}

/**
 * The model a bot's row shows (A12): for a running bot (`argv`: its pane's foreground), what
 * runs: the model its command line names, else the agent's own default (a pin it wasn't
 * started with doesn't run). For a bot that isn't running: its pin, else the default.
 * Returns { model, source: "detected" | "pinned" | "default" } or { model: null, source: null }.
 */
export function shownModel({ argv, agentKey, pinned, fallback }) {
  if (argv) {
    const detected = detectModel(argv, agentKey);
    if (detected) return { model: detected, source: "detected" };
  } else if (pinned) return { model: pinned, source: "pinned" };
  if (fallback) return { model: fallback, source: "default" };
  return { model: null, source: null };
}

/**
 * The agent key a name stands for in `agents` (a key, an executable or a `match` name, so
 * `claude-code` is `claude`), or null. What a person types for --agent goes through this. A
 * retired name (LEGACY_AGENTS) that `agents` doesn't list stands for its replacement.
 */
export function resolveAgent(name, agents = AGENTS) {
  if (typeof name !== "string" || !name.trim()) return null;
  if (agents[name]) return name;
  const found = agentKeyOfArgv([name], agents);
  if (found) return found;
  const next = LEGACY_AGENTS[name.trim()];
  return next && agents[next] ? next : null;
}

// Each agent's reasoning-effort flag, read from `<agent> --help` on this host (2026-11-02:
// Claude Code 2.1.316 `--effort <level>`; codex's config key `model_reasoning_effort`
// through `-c`; pi `--thinking <level>`; omp `--thinking=<value>`; 2026-11-09: agy 1.5.3
// `--effort` (low|medium|high|xhigh|max)).
const EFFORT = {
  claude: (level) => ["--effort", level],
  codex: (level) => ["-c", `model_reasoning_effort=${level}`],
  pi: (level) => ["--thinking", level],
  omp: (level) => [`--thinking=${level}`],
  antigravity: (level) => ["--effort", level],
};

/** True when `agentKey` has an effort flag effortArgs knows. */
export const hasEffortFlag = (agentKey) => Boolean(EFFORT[agentKey]);

/** The arguments that start `agentKey` at reasoning `effort`, [] when none is given or known. */
export function effortArgs(agentKey, effort) {
  if (!effort || !EFFORT[agentKey]) return [];
  return EFFORT[agentKey](effort);
}

// agy 1.5.3's execution mode (`--mode accept-edits|auto|plan`): the pack names one on every
// Antigravity launch, auto unless the roster's agyMode says otherwise, so a bot doesn't stop at
// its first command. Where agy can't run that mode it continues in manual mode, so the launch
// also carries --dangerously-skip-permissions (AUTO_MODE, #955). agy's own settings (its trust
// list included) stay the person's: the mode goes on the launch line only.
export const AGY_MODES = Object.freeze(["accept-edits", "auto", "plan"]);
/** The mode an Antigravity launch gets when the roster names none. */
export const AGY_MODE_DEFAULT = "auto";

/** `mode` when it names a launch, else AGY_MODE_DEFAULT (absent and empty included). */
export const agyModeOf = (mode) => (mode === undefined || mode === null || mode === "" ? AGY_MODE_DEFAULT : mode);
/** Why `mode` can't be passed to agy's --mode, or null (absent: the default). One line. */
export const agyModeProblem = (mode) => (AGY_MODES.includes(agyModeOf(mode)) ? null
  : `Antigravity mode ${JSON.stringify(mode)} isn't one of ${AGY_MODES.join(", ")}.`);

/**
 * The arguments that set `agentKey`'s execution mode: `--mode <mode>` for Antigravity, []
 * for every other agent, so its launch line stays byte-identical.
 */
export function agyModeArgs(agentKey, mode = null) {
  return agentKey === "antigravity" ? ["--mode", agyModeOf(mode)] : [];
}

// ---- Each agent's automatic mode (#955, #946) ----
//
// The pack starts every bot and worker in its agent's automatic mode, so an unattended pane
// never stops at an approval prompt only a person can answer. The flags come from the definition
// (launchRun), never from an old pane's command. herdr/README.md has the same table.

// Codex's auto mode (codex-cli 0.167.0 `--approve-for-me`): an approval request goes to Codex's
// own reviewer instead of a person, and the workspace-write sandbox stays. `--disable hooks`
// (the same as `-c features.hooks=false`) turns its hooks off at launch (#1045): a hook in
// ~/.codex/hooks.json or the worktree's .codex/hooks.json that is new or changed would otherwise
// stop TUI startup at "Hooks need review" for a person to answer, and the pack never passes
// --dangerously-bypass-hook-trust (it would run an untrusted hook's commands in a worktree).
// The pack puts both on every Codex launch it makes, so an unattended bot or worker never stops
// at an approval prompt or a hook review only a person can answer (#946).
export const CODEX_AUTO_ARGS = Object.freeze(["--approve-for-me", "--disable", "hooks"]);

// One Codex launch mode on every machine (#1125, the owner's ruling of 10 and 12 Nov): every
// Codex seat and every worker the pack starts with --agent codex runs the auto mode above with
// the workspace-write sandbox on, never --dangerously-bypass-approvals-and-sandbox. Two more
// words make it usable there. `--no-daemon`: hc --skill says Codex must run with it (templates
// included), or its commands run in Codex's shared background server, outside hc and with the
// environment of whichever pane started that server (HC_TERMINAL_ID included). The sandbox's
// own `network_access`: on, so hc's socket and GitHub (gh, git's transport) answer. The folders
// it may write besides its working folder are derived per launch (codexGrants, withCodexGrants).
// A bot's `codexAuto: false` no longer opts out (model.js warns), and the source's own approval
// and sandbox words are left out by name (codexClean). An hc worker template owns its command,
// bypass included: the owner's exception for template workers (#1125), never a seat's.
export const CODEX_NETWORK = "sandbox_workspace_write.network_access=true";
export const CODEX_MODE_ARGS = Object.freeze([...CODEX_AUTO_ARGS, "--no-daemon", "-c", CODEX_NETWORK]);

/** Whether a launch of `agentKey` passes Codex's launch mode: every Codex seat and worker the pack builds (#1125: no opt-out). */
export const codexAutoOn = (agentKey) => agentKey === "codex";

/** The words Codex's launch mode adds, [] for every other agent. */
export const codexAutoArgs = (agentKey) => (codexAutoOn(agentKey) ? [...CODEX_MODE_ARGS] : []);

// The words a Codex source may carry that pick its approvals or its sandbox, or run its commands
// outside the pane (checked against codex-cli 0.167.0 on 2026-11-12). Codex refuses
// --approve-for-me beside -a, -s or the bypass flag; a `-c default_permissions=…` overrides it
// (the effective sandbox becomes danger-full-access), so those keys go too.
const CODEX_PACK_WORDS = new Set(["--approve-for-me", "--no-daemon"]);
const CODEX_BYPASS = new Set(["--dangerously-bypass-approvals-and-sandbox", "--yolo"]);
const CODEX_VALUED = [["-a", "--ask-for-approval"], ["-s", "--sandbox"], [null, "--remote"], [null, "--remote-auth-token-env"]];
const CODEX_CONFIG_KEYS = ["sandbox_mode", "approval_policy", "approvals_reviewer", "sandbox_workspace_write",
  "default_permissions", "permission_profile", "permissions"];
// Codex's other flags that take a value: the word after one is never read as a flag here.
const CODEX_TAKES_VALUE = new Set(["-m", "--model", "-p", "--profile", "-C", "--cd", "-i", "--image", "--enable", "--disable",
  "--local-provider", "--add-dir"]);
// #1142: every Codex option of known arity, as the pack lists Codex 0.167's: these take a value,
// these take none. Anything else is of unknown arity.
const CODEX_VALUE_FLAGS = new Set([...CODEX_TAKES_VALUE, "-c", "--config", ...CODEX_VALUED.flat().filter(Boolean)]);
const CODEX_PLAIN_FLAGS = new Set(["--approve-for-me", "--no-daemon", "--oss", "--search"]);

/**
 * A Codex word's arity (#1142): "flag" (takes no value), "value" (its value is the next word),
 * "joined" (its value is in it: --model=x, -mx), or null (a subcommand, a prompt, an unknown flag).
 */
export function codexOptionArity(w) {
  if (CODEX_PLAIN_FLAGS.has(w)) return "flag";
  if (CODEX_VALUE_FLAGS.has(w)) return "value";
  if (w.startsWith("--")) return w.includes("=") && CODEX_VALUE_FLAGS.has(w.slice(0, w.indexOf("="))) ? "joined" : null;
  return /^-[A-Za-z]./.test(w) && CODEX_VALUE_FLAGS.has(w.slice(0, 2)) ? "joined" : null;
}

/**
 * The environment words that place a Codex launch's folders (#1142): one list for the linked
 * probe (codexOn), the folders derived from them (codexGrantPaths) and the shell forms a template
 * may not set (codexForwards, with PATH and every CODEX_, XDG_, npm_config_ and BUN_INSTALL word).
 */
export const CODEX_DIR_VARS = ["HOME", "HERDR_APP_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "GOPATH",
  "GOMODCACHE", "GOCACHE", "npm_config_cache", "NPM_CONFIG_CACHE", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"];
/** Whether a shell assignment to `name` could move a Codex launch's folders or its program (#1142). */
export const codexDirVar = (name) => CODEX_DIR_VARS.includes(name) || name === "PATH" || /^(XDG_|CODEX_|npm_config_|BUN_INSTALL)/i.test(name);

// TOML's one-letter basic-string escapes (\xHH, \uXXXX and \UXXXXXXXX are read apart).
const TOML_ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };

/**
 * A basic string's text with its escapes decoded (TOML 1.1's \xHH included). An escape TOML
 * lacks reads as its letter (toward dropping).
 */
const tomlBasic = (body) => body.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (m, e) => {
  if (e.length === 1) return TOML_ESCAPES[e] ?? e;
  const cp = parseInt(e.slice(1), 16);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});

/**
 * A trimmed TOML key part unquoted: a basic string "…" with its escapes decoded (tomlBasic), a
 * literal string '…' as it is, a bare key as written.
 */
function tomlKeyPart(part) {
  if (part.length >= 2 && part[0] === "'" && part.endsWith("'")) return part.slice(1, -1);
  if (!(part.length >= 2 && part[0] === "\"" && part.endsWith("\""))) return part;
  return tomlBasic(part.slice(1, -1));
}

/**
 * A config text's key parts as TOML reads them: the dotted key before the first `=` outside
 * quotes, split on the dots outside quotes, each part trimmed, then unquoted (tomlKeyPart).
 * When a quote doesn't close, the parts finished before it (none when the first quote is open).
 */
function tomlKeyParts(text) {
  const parts = [];
  let start = 0, quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === "\"" && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "." || ch === "=") {
      parts.push(text.slice(start, i));
      start = i + 1;
      if (ch === "=") return parts.map((p) => tomlKeyPart(p.trim()));
    }
  }
  if (!quote) parts.push(text.slice(start));
  return parts.map((p) => tomlKeyPart(p.trim()));
}

/**
 * A config text's key parts read raw, the one reading of a key whose first quote doesn't close:
 * the text before its first `=`, trimmed, one outer quote off, split on every dot, each part
 * trimmed. A key opening with a double quote is a basic string's text, its escapes decoded
 * (tomlBasic) before the split; one opening with a single quote is literal, as written.
 */
function rawKeyParts(text) {
  const raw = text.split("=")[0].trim();
  const body = raw.replace(/^["']|["']$/g, "");
  return (raw[0] === "\"" ? tomlBasic(body) : body).split(".").map((p) => p.trim());
}

/**
 * The name a config key is left out by, from one reading's parts, or null (#1125): a key
 * CODEX_CONFIG_KEYS lists, or any key under one, by that key; a listed key under a profile
 * (`profiles.<name>.<key>`, which `--profile <name>` applies) as `profiles.*.<key>`, never the
 * profile's name; `profiles` or one profile whole (a table that can hold any listed key, its
 * narrowness unproved) as `profiles`.
 */
function codexConfigName(parts) {
  if (CODEX_CONFIG_KEYS.includes(parts[0])) return parts[0];
  if (parts[0] !== "profiles") return null;
  if (parts.length < 3) return "profiles";
  return CODEX_CONFIG_KEYS.includes(parts[2]) ? `profiles.*.${parts[2]}` : null;
}

/**
 * `-c`/`--config`'s key=value at `words[i]` in any form: { name, text, span } (span: words it
 * takes; name: what it is left out by, codexConfigName, or null), or null. The key is matched by
 * its meaning, never its spelling (#1125: config keys written in another valid TOML spelling were
 * kept), in two readings: TOML's (tomlKeyParts) and the raw one (rawKeyParts), which alone reads
 * a key whose first quote doesn't close. A name from either drops the word. Codex's own reading
 * (split on every dot, each part trimmed) needs none of its own: a key that starts with no quote
 * is read so by the raw one too (a closing quote off), and one that starts with a quote has no
 * bare first part for Codex.
 */
function codexConfigAt(words, i) {
  const w = words[i];
  let text = null, span = 1;
  if (w === "-c" || w === "--config") { text = words[i + 1] ?? ""; span = 2; }
  else if (w.startsWith("--config=")) text = w.slice("--config=".length);
  else if (w.startsWith("-c")) text = w.slice(w[2] === "=" ? 3 : 2);
  if (text === null) return null;
  const name = [tomlKeyParts(text), rawKeyParts(text)].map(codexConfigName).find(Boolean) ?? null;
  return { name, text, span };
}

/** The approval or sandbox flag at `w` in any form (`-a x`, `-ax`, `-a=x`, `--sandbox=x`): { flag (as written, no value), next }, or null. */
function codexValuedAt(w) {
  for (const [short, long] of CODEX_VALUED) {
    if (w === long || (short && w === short)) return { flag: w, next: true };
    if (w.startsWith(`${long}=`)) return { flag: long, next: false };
    if (short && w.startsWith(short) && w.length > 2) return { flag: short, next: false };
  }
  return null;
}

/** Whether `dir` is the filesystem root, `home` or a folder above it: a grant that wide is never passed. */
export const homeWide = (dir, home) => {
  const d = String(dir ?? "").replace(/\/+$/, "") || "/";
  const h = typeof home === "string" && home ? home.replace(/\/+$/, "") : null;
  return d === "/" || (h !== null && (d === h || h.startsWith(`${d}/`)));
};

/** `p` as one absolute path, its `.` and `..` segments resolved and no trailing slash; null when it isn't absolute. */
export function absPath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || /[\x00-\x1f\x7f]/.test(p)) return null;
  const out = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * `p` as one absolute path without its empty and `.` segments or a trailing slash, its `..`
 * segments KEPT (#1142): what a `..` names depends on the symlinks before it, so only the
 * filesystem where the path is used can say (`link/..` is the parent of the link's target, not
 * the folder holding the link). Null when it isn't absolute.
 */
export function cleanPath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || /[\x00-\x1f\x7f]/.test(p)) return null;
  return `/${p.split("/").filter((s) => s && s !== ".").join("/")}`;
}

/** Whether absolute `p` has a `..` segment. */
const hasParent = (p) => p.split("/").includes("..");

/** Whether canonical `a` is canonical `b` or inside it. */
const within = (a, b) => a === b || b === "/" || a.startsWith(`${b}/`);

/**
 * Where a Codex launch runs, for its folder rules (#1125, #1142): `{ home, appHomes, canon }`,
 * each root canonical there. `canon(p)`: an absolute path as that machine resolves it, or null
 * when its narrowness can't be proved (not absolute, or `resolve` couldn't tell). `resolve` answers
 * for the launch's own machine with filesystem semantics: it gets the path as cleanPath leaves it,
 * `..` included, and gives its realpath through the nearest folder that is there (symlinks
 * followed, then each `..`). Without one, paths compare as written (cleanPath), and one with a
 * `..` proves nothing (null). `appHome`: the launch's effective app home (one path or several);
 * the default one under `home` is always protected too.
 */
export function codexWhere({ home = null, appHome = null, resolve = null, id = null } = {}) {
  const resolved = (p) => {
    const a = cleanPath(p);
    if (!a) return null;
    if (!resolve) return hasParent(a) ? null : a;
    let r = null;
    try { r = cleanPath(resolve(a)); } catch { return null; }
    return r && !hasParent(r) ? r : null;
  };
  // #1142: a protected root that is given but can't be resolved there (empty, relative, not
  // answered, a resolver error) is never dropped or guessed: `unproved` names it, and then `canon`
  // proves nothing and codexDirAllowed allows nothing (no --add-dir, no derived folder).
  const given = (p) => typeof p === "string";
  const unproved = [];
  const h = given(home) ? resolved(home) : null;
  if (given(home) && !h) unproved.push("its home folder (HOME)");
  const appHomes = [];
  for (const a of [...(Array.isArray(appHome) ? appHome : [appHome]).filter(given), ...(given(home) ? [`${home}/.config/herdr-app`] : [])]) {
    const c = resolved(a);
    if (c) { if (!appHomes.includes(c)) appHomes.push(c); } else if (!unproved.includes("an app home")) unproved.push("an app home");
  }
  // `spelled`: the home folder as the launch spells it, the form its paths were derived and resolved from.
  // `id`: the launch machine's identity observation (idHere, idsThere): "dev:ino" of a path, symlinks followed, or null.
  return { home: h, spelled: given(home) ? home : null, appHomes, canon: unproved.length ? () => null : resolved,
    id: typeof id === "function" ? id : null, unproved };
}

/**
 * Whether a Codex launch may be granted canonical `dir` under `where` (codexWhere): "ok",
 * "refused" (a rule proves it protected: the root, the home folder or a folder above it, an app
 * home, a folder inside one or above one, a whole general folder or above one), or "unproved" (an
 * observation it needs failed: it is withheld). Paths first, then (#1142) the launch machine's
 * identity observations (`where.id`): `dir` and every folder above it, the home folder and every
 * folder above it, and each app home and every folder above it must all be observed, and none may
 * make `dir` the home folder or above it, an app home or above one, or a folder inside one. Any
 * failed observation withholds: `dir`'s own only `dir`; the home folder's or an app home's (an
 * absent default app home included) every folder. A general folder (or a folder above it) that
 * can be observed refuses `dir` by identity too; one that can't (an absent optional cache, say)
 * is not granted itself and withholds nothing. A where without observations never grants, except
 * codexWhereThere's (deferred: the destination weighs those words). This is not a proof against a
 * bind mount that shows a folder inside an app home under another path (a known limit, #1151).
 */
export function codexDirVerdict(dir, where = {}, general = []) {
  if (typeof dir !== "string" || !dir.startsWith("/") || dir === "/") return "refused";
  if (where.unproved?.length) return "unproved";
  if (where.home && within(where.home, dir)) return "refused";
  if ((where.appHomes ?? []).some((app) => within(dir, app) || within(app, dir))) return "refused";
  // #1142: a derived folder at or above a whole general folder (`general`, canonical) is no narrow grant.
  if (general.some((g) => within(g, dir))) return "refused";
  if (where.deferred) return "ok";
  return typeof where.id === "function" && where.home ? idVerdict(dir, where, general) : "unproved";
}

/** codexDirVerdict's "ok": whether `dir` may be granted. */
export const codexDirAllowed = (dir, where = {}, general = []) => codexDirVerdict(dir, where, general) === "ok";

/** Canonical `p` and each folder above it, up to the root. */
const chain = (p) => {
  const out = [];
  for (let c = p; ; c = c.slice(0, c.lastIndexOf("/")) || "/") { out.push(c); if (c === "/") return out; }
};

const DEV_INO = /^\d+:\d+$/;

/** codexDirVerdict's identity walk (#1142): every observation it needs, or "unproved". */
function idVerdict(dir, where, general) {
  const id = (p) => {
    let v = null;
    try { v = where.id(p); } catch { v = null; }
    return typeof v === "string" && DEV_INO.test(v) ? v : null;
  };
  const walk = (p) => chain(p).map(id);
  const homeUp = walk(where.home);
  const appUps = (where.appHomes ?? []).map(walk);
  if (homeUp.includes(null) || appUps.some((up) => up.includes(null))) return "unproved";
  const mine = walk(dir);
  if (mine.includes(null)) return "unproved";
  const self = mine[0];
  if (homeUp.includes(self)) return "refused";
  if (appUps.some((up) => up.includes(self) || mine.includes(up[0]))) return "refused";
  if (general.some((g) => chain(g).some((p) => id(p) === self))) return "refused";
  return "ok";
}

/**
 * The one warning a Codex launch gives when folders it would pass were withheld (#1142):
 * `withheld` folders it couldn't prove outside the app home, `granted` folders it still passes
 * (counted once each). Null when nothing was withheld.
 */
export function codexWithheldWarning(withheld, granted) {
  if (!(withheld > 0)) return null;
  const tail = "writes outside permitted locations may require automatic review or fail. See #1151.";
  return granted > 0
    ? `Codex extra folders withheld: the pack cannot prove ${withheld} of them are outside the Herdr app home and passes no grant for those; ${tail}`
    : `Codex extra folders withheld: the pack cannot prove they are outside the Herdr app home. It passes no additional folder grants; ${tail}`;
}

/** `where` as codexWhere gives it, from one: a codexWhere result, a home folder (compared as written), or nothing. */
const whereOf = (where) => (where && typeof where === "object" && typeof where.canon === "function" ? where
  : codexWhere({ home: typeof where === "string" ? where : null }));

/**
 * The rules for a launch built here to run on another machine (seatOnMachine, #1142): every
 * absolute `--add-dir` stays as cleanPath leaves it, `..` included, because only that machine can
 * resolve it; codexOn weighs each there and passes that machine's canonical value.
 */
export const codexWhereThere = () => ({ home: null, appHomes: [], canon: cleanPath, deferred: true });

/**
 * An `--add-dir` value under `where` (#1142): { c, verdict }: its canonical form there (the value
 * a launch passes) and codexDirVerdict's answer. A relative value is refused; one that can't be
 * resolved there (a dangling link, an error) is unproved.
 */
const weighDir = (value, where) => {
  if (cleanPath(value) === null) return { c: null, verdict: "refused" };
  const c = where.canon(value);
  return c === null ? { c: cleanPath(value), verdict: "unproved" } : { c, verdict: codexDirVerdict(c, where) };
};

/**
 * A Codex argv's `--add-dir` words (before any `--`) under `where`: each one `where` allows is
 * passed as its canonical value there, the one the rules checked (#1142: so a `link/..` can't
 * be checked as one folder and reach Codex as another); each other one is left out: { argv,
 * dropped } (dropped: true when one went). For a launch whose folders are known only where it
 * runs (a linked machine: seatOnMachine), after the argv is built.
 */
export function codexKeepDirs(argv, where) {
  const w = whereOf(where);
  const words = Array.isArray(argv) ? argv.map(String) : [];
  const out = [], unproved = [];
  let dropped = false;
  for (let i = 0; i < words.length; i += 1) {
    const x = words[i];
    if (x === "--") { out.push(...words.slice(i)); break; }
    const value = x === "--add-dir" ? words[i + 1] : x.startsWith("--add-dir=") ? x.slice("--add-dir=".length) : undefined;
    if (value === undefined) { out.push(x); continue; }
    const { c, verdict } = weighDir(value, w);
    if (verdict !== "ok") {
      if (verdict === "unproved") { if (!unproved.includes(c)) unproved.push(c); } else dropped = true;
      if (x === "--add-dir") i += 1;
      continue;
    }
    if (x === "--add-dir") { out.push(x, c); i += 1; } else out.push(`--add-dir=${c}`);
  }
  return { argv: out, dropped, unproved };
}

/**
 * Whether each `--add-dir` in Codex words `args` (before any `--`) is already the canonical value
 * `where` allows, byte for byte (#1142): a template's text is never rewritten, so a value it
 * passes is the one checked only when it is written that way.
 */
export function codexDirsExact(args, where) {
  const words = ["codex", ...(Array.isArray(args) ? args.map(String) : [])];
  const cut = words.indexOf("--");
  const options = cut < 0 ? words : words.slice(0, cut);
  const kept = codexKeepDirs(options, where);
  return !kept.dropped && !kept.unproved.length && kept.argv.length === options.length && kept.argv.every((w, i) => w === options[i]);
}

/**
 * A Codex source's words (`run`, Herdr's table with programs.json applied) without the ones that
 * pick its approvals or sandbox: bypass and --yolo, -a/--ask-for-approval and -s/--sandbox in
 * their separate, joined and `=` forms, -c/--config for the keys CODEX_CONFIG_KEYS names (and
 * any key under one, and under a profile; or a profile whole: codexConfigName), --remote
 * (another app server: outside the pane, #1125), and an --add-dir
 * `where` doesn't allow (codexWhere, codexDirAllowed: canonical where the launch runs, so a dot,
 * parent or symlink alias of the home folder or the app home goes too, as does a relative one:
 * its narrowness can't be proved, #1142); one it allows is passed as that canonical value, the
 * one checked. `where` may also be a home folder, compared as written.
 * The pack's own --approve-for-me, --no-daemon and network word go quietly (launchRun puts them
 * back once). Every other word stays as it is, after a `--` too.
 * Returns { argv, dropped, unproved } (`dropped`: the flags left out, by name, `-c sandbox_mode`,
 * `-c profiles.*.sandbox_mode` or `-c profiles` style: never a value or a profile's name;
 * `unproved`: the --add-dir folders withheld because an observation they
 * need failed, #1142, which the launch's one withheld warning counts instead).
 */
export function codexClean(run, where = null) {
  const at = whereOf(where);
  const words = Array.isArray(run) ? run.map(String) : [];
  const argv = [], dropped = [], unproved = [];
  const drop = (name) => { if (!dropped.includes(name)) dropped.push(name); };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") { argv.push(...words.slice(i)); break; }
    if (CODEX_PACK_WORDS.has(w)) continue;
    if (CODEX_BYPASS.has(w)) { drop(w); continue; }
    const valued = codexValuedAt(w);
    if (valued) { drop(valued.flag); if (valued.next) i += 1; continue; }
    const config = codexConfigAt(words, i);
    if (config) {
      // The pack's own network word goes quietly, as --approve-for-me does: launchRun adds it once.
      if (config.text.trim() === CODEX_NETWORK) { i += config.span - 1; continue; }
      // Any other spelling of that word is a config key like the rest: dropped and named (launchRun
      // still adds the exact one).
      if (config.name) drop(`-c ${config.name}`);
      else argv.push(...words.slice(i, i + config.span));
      i += config.span - 1;
      continue;
    }
    const addDir = w === "--add-dir" ? words[i + 1] : w.startsWith("--add-dir=") ? w.slice("--add-dir=".length) : undefined;
    if (addDir !== undefined) {
      const { c, verdict } = weighDir(addDir, at);
      if (verdict !== "ok") {
        if (verdict === "unproved") { if (!unproved.includes(c)) unproved.push(c); } else drop("--add-dir");
        if (w === "--add-dir") i += 1;
        continue;
      }
      if (w === "--add-dir") { argv.push(w, c); i += 1; } else argv.push(`--add-dir=${c}`);
      continue;
    }
    argv.push(w);
    if (CODEX_TAKES_VALUE.has(w) && i + 1 < words.length) argv.push(words[++i]);
  }
  return { argv, dropped, unproved };
}

/** One line naming what codexClean left out of `run` (flag names only), or null when nothing. */
export function codexCleanNote(run, where = null, source = "programs.json's Codex command") {
  const { dropped } = codexClean(run, whereOf(where));
  return dropped.length ? `${source} names ${dropped.join(", ")}: left out. Every Codex seat and worker runs in auto mode `
    + "(--approve-for-me) with its sandbox on (#1125)." : null;
}

/**
 * The paths codexGrants weighs for a launch, as written (cleanPath: a `..` kept for the
 * filesystem to resolve, #1142), before any is resolved:
 * { candidates, general }. `candidates`, in order: `gitDir`, the launch checkout's own git dir (a
 * linked worktree's `.git/worktrees/<name>`, which Codex keeps read-only even beside its common
 * dir), and `gitCommonDir`, its git common dir (its own .git, or the main checkout's); then
 * herdr-core's state and data folders (XDG_STATE_HOME, XDG_DATA_HOME, else under `home`), which hc
 * needs to reach its core; then the tool caches a build writes: Go's module and build caches
 * (GOMODCACHE, GOCACHE, else GOPATH's), npm's (npm_config_cache), pnpm's store and cache, and Bun's
 * install cache (BUN_INSTALL_CACHE_DIR, BUN_INSTALL). `general`: the folders never granted whole
 * (each XDG folder, ~/.local, GOPATH and Bun's own). `env` is the launch's environment.
 */
export function codexGrantPaths({ home = null, env = {}, gitDir = null, gitCommonDir = null }) {
  const h = cleanPath(home);
  const abs = (p) => cleanPath(p);
  const at = (base, rest) => (base ? cleanPath(`${base}/${rest}`) : null);
  const xdg = (name, fallback) => abs(env[name]) ?? at(h, fallback);
  const state = xdg("XDG_STATE_HOME", ".local/state"), data = xdg("XDG_DATA_HOME", ".local/share");
  const cache = xdg("XDG_CACHE_HOME", ".cache"), config = xdg("XDG_CONFIG_HOME", ".config");
  const gopath = abs(String(env.GOPATH ?? "").split(":")[0]) ?? at(h, "go");
  const bun = abs(env.BUN_INSTALL) ?? at(h, ".bun");
  const general = [state, data, cache, config, at(h, ".local"), gopath, bun].filter(Boolean);
  const candidates = [abs(gitDir), abs(gitCommonDir), at(state, "herdr-core"), at(data, "herdr-core"),
    abs(env.GOMODCACHE) ?? at(gopath, "pkg/mod"), abs(env.GOCACHE) ?? at(cache, "go-build"),
    abs(env.npm_config_cache) ?? abs(env.NPM_CONFIG_CACHE) ?? at(h, ".npm"),
    at(data, "pnpm/store"), at(cache, "pnpm"),
    abs(env.BUN_INSTALL_CACHE_DIR) ?? at(bun, "install/cache")].filter(Boolean);
  return { candidates, general };
}

/**
 * The folders a Codex launch may write besides its working folder (#1125): codexGrantPaths'
 * candidates, each made canonical where the launch runs (`where`, codexWhere: a dot, parent or
 * symlink alias resolved there, #1142), kept only when it is a folder there (`isDir`, asked with
 * the canonical path), codexDirAllowed (never the root, the home folder or above it, never an app
 * home, inside one or above one) and not a whole general folder (canonical too). `where`: a
 * codexWhere result; without one, `home` and `appHome` build it with paths compared as written.
 * Pure: `where.canon` and `isDir` answer for the launch's machine.
 */
export function codexGrants(opts) {
  return codexGrantPlan(opts).dirs;
}

/**
 * codexGrants with what it withheld: { dirs, unproved }. One inventory (#1142): `paths`, the
 * codexGrantPaths result the resolver was asked about (codexOn passes the one it probed), else one
 * built from `home` as the launch spells it, else from where.spelled (codexWhere keeps the home as
 * given): never rebuilt from the canonical home, whose paths a resolver may not have been asked about.
 * Each candidate is judged on its own (codexDirVerdict): one that isn't a folder there is not
 * granted; one that can't be resolved there, or whose observations fail, is withheld and named in
 * `unproved` (counted by the launch's warning); the others are granted. A general folder that can't
 * be resolved there (absent behind a dangling link, say) keeps no candidate out by its path and
 * withholds nothing; the candidates under it can't be resolved either.
 */
export function codexGrantPlan({ where = null, home = null, appHome = null, env = {}, gitDir = null, gitCommonDir = null, isDir = () => false,
  paths = null }) {
  const w = where ?? codexWhere({ home, appHome });
  const { candidates, general } = paths ?? codexGrantPaths({ home: home ?? w.spelled ?? w.home, env, gitDir, gitCommonDir });
  const whole = general.map((g) => w.canon(g)).filter(Boolean);
  const out = [], unproved = [];
  const withhold = (d) => { if (d && !unproved.includes(d)) unproved.push(d); };
  for (const raw of candidates) {
    const dir = w.canon(raw);
    if (dir === null) { withhold(cleanPath(raw)); continue; }
    if (out.includes(dir)) continue;
    // isDir: true (a folder), false (not there, or not a folder: nothing to grant), anything else
    // or a throw: it couldn't be observed, so the candidate is withheld and counted.
    let there = null;
    try { there = isDir(dir); } catch { there = null; }
    if (there === false) continue;
    if (there !== true) { withhold(dir); continue; }
    const verdict = codexDirVerdict(dir, w, whole);
    if (verdict === "ok") out.push(dir);
    else if (verdict === "unproved") withhold(dir);
  }
  return { dirs: out, unproved };
}

/**
 * `argv` with an `--add-dir <dir>` for each of `dirs` right after the pack's Codex mode words
 * (CODEX_MODE_ARGS, as launchRun puts them), so they land before any subcommand (`resume`) and
 * the task. An argv without those words (a template's command, another agent) is returned as it is.
 */
export function withCodexGrants(argv, dirs = []) {
  const words = Array.isArray(argv) ? [...argv] : [];
  const n = CODEX_MODE_ARGS.length;
  const at = words.findIndex((_, i) => CODEX_MODE_ARGS.every((m, k) => words[i + k] === m));
  if (at < 0 || !dirs.length) return words;
  return [...words.slice(0, at + n), ...dirs.flatMap((d) => ["--add-dir", d]), ...words.slice(at + n)];
}

/** agy's flag that answers every permission request itself; its --settings deny list still holds. */
export const AGY_SKIP_PERMISSIONS = "--dangerously-skip-permissions";

/**
 * The automatic mode of each agent that has one this pack passes: `args` (the words added after
 * the agent's run), `own` (the flags by which a run already picks its approvals: a programs.json
 * override naming one is left as the person wrote it), `what` (one line for status and doctor).
 * Checked against claude 2.1.322, codex-cli 0.167.0 and agy 1.5.4 on 2026-11-10.
 * Antigravity is the one agent that gets a skip-all flag, on the owner's word (#955): agy's
 * `--mode auto` falls back to manual mode where its sandbox or the account lacks it, while
 * `--dangerously-skip-permissions` still refuses a command its --settings deny list names
 * (AGY_FIXED_DENY), so the flag only ever goes beside that file (agyGuarded).
 */
export const AUTO_MODE = Object.freeze({
  claude: Object.freeze({ args: Object.freeze(["--permission-mode", "auto"]),
    own: Object.freeze(["--permission-mode", "--dangerously-skip-permissions"]),
    what: "Claude Code's auto mode: its classifier answers permission requests" }),
  codex: Object.freeze({ args: CODEX_MODE_ARGS,
    own: Object.freeze(["--approve-for-me", "-a", "--ask-for-approval", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]),
    what: "Codex's auto mode: its reviewer answers approval requests, inside the workspace-write sandbox with network on, "
      + "outside Codex's shared server (--no-daemon), with hooks off" }),
  antigravity: Object.freeze({ args: Object.freeze([AGY_SKIP_PERMISSIONS]),
    own: Object.freeze([AGY_SKIP_PERMISSIONS]),
    what: "no permission prompts; the launch's deny list still refuses what it names" }),
});

/**
 * Why an agent gets no automatic-mode flag from this pack. No skip-all-approvals flag (`--yolo`,
 * `--auto-approve` and the like) is passed for any of them: that needs the owner's word first
 * (#955). "not checked" means the agent is on none of the hosts the flags were read on, so the
 * pack adds nothing it has not seen that agent's own help name.
 */
export const AUTO_MODE_NONE = Object.freeze({
  pi: "not checked: Pi isn't installed where the flags were read",
  omp: "omp 18.14.2 has only skip-all flags (--auto-approve, --approval-mode=yolo)",
  opencode: "not checked: OpenCode isn't installed where the flags were read",
  cursor: "not checked: Cursor's CLI isn't installed where the flags were read",
  copilot: "not checked: Copilot's CLI isn't installed where the flags were read",
  amp: "not checked: Amp isn't installed where the flags were read",
  grok: "not checked: Grok's CLI isn't installed where the flags were read",
  kimi: "not checked: Kimi isn't installed where the flags were read",
  kiro: "not checked: Kiro's CLI isn't installed where the flags were read",
  hermes: "Hermes 0.22.5 has only a skip-all flag (--yolo)",
  qoder: "not checked: Qoder's CLI isn't installed where the flags were read",
  crush: "not checked: Crush isn't installed where the flags were read",
  "dsh-tui": "its DSH profile on the machine it runs on sets the approval policy; dsh-tui takes no such flag",
});

/** Whether `run` already names one of `flags` (as a word or `--flag=value`), before any `--`. */
function runNames(run, flags) {
  for (const w of Array.isArray(run) ? run.map(String) : []) {
    if (w === "--") return false;
    if (flags.some((flag) => w === flag || w.startsWith(`${flag}=`))) return true;
  }
  return false;
}

/**
 * The words `agentKey`'s automatic mode adds to `run` for `bot`: AUTO_MODE's, [] for an agent
 * with none and for a run that already picks its own approvals (a programs.json override).
 * Codex always gets its launch mode (#1125): launchRun leaves the source's own approval and
 * sandbox words out instead.
 */
export function autoModeArgs(agentKey, bot = null, run = []) {
  const mode = AUTO_MODE[agentKey];
  if (agentKey === "codex") return codexAutoArgs(agentKey);
  if (!mode || runNames(run, mode.own)) return [];
  return [...mode.args];
}

/**
 * The words `agentKey` starts with: the given run (Herdr's table, programs.json applied) and the
 * flags this pack adds for that agent's automatic mode. They are added here, so a bot's start,
 * its restart and its workers all take them from the definition, never from an old pane's command.
 * A Codex run loses its own approval and sandbox words first (codexClean, #1125; `where`, the
 * launch's codexWhere when the caller knows it, also stops an --add-dir of the home folder or an
 * app home, by any alias); the mode words go before a `--` in it, so they stay options.
 */
export function launchRun(agentKey, run, bot, where = null) {
  if (agentKey !== "codex") {
    const words = agentKey === "hermes" ? hermesPairRun(run, bot) : run;
    return [...words, ...autoModeArgs(agentKey, bot, run)];
  }
  const { argv } = codexClean(run, where);
  const cut = argv.indexOf("--");
  return cut < 0 ? [...argv, ...CODEX_MODE_ARGS] : [...argv.slice(0, cut), ...CODEX_MODE_ARGS, ...argv.slice(cut)];
}

/**
 * `argv` (a launch) as it may run: an Antigravity launch with no `--settings` file loses
 * `--dangerously-skip-permissions`, since the deny list in that file is the one thing the flag
 * leaves standing. Any other agent's argv, or one that doesn't run agy directly (a shell
 * template owns its command), is returned as it is.
 */
export function agyGuarded(agentKey, argv) {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  if (agentKey !== "antigravity" || agentKeyOfArgv(words) !== agentKey) return words;
  const end = words.indexOf("--");
  const head = end < 0 ? words : words.slice(0, end);
  const settings = head.findIndex((w) => w === "--settings" || w.startsWith("--settings="));
  const named = settings >= 0 && (head[settings].length > "--settings=".length || (head[settings] === "--settings" && Boolean(head[settings + 1])));
  if (named) return words;
  return [...head.filter((w) => w !== AGY_SKIP_PERMISSIONS), ...(end < 0 ? [] : words.slice(end))];
}

/**
 * The line a launch says when the roster itself names Antigravity's `auto` mode and this host
 * can't run it, or null. agy prints its own warning only in print mode ("--mode auto is not
 * available ..."); an interactive pane shows nothing and continues in its default mode, so the
 * launcher says it. `explicit`: the roster's own value (a bot's `agyMode`, a worker's), absent
 * for the default; `sandbox`: agySandbox's answer for the host the launch runs on.
 */
export function agyModeWarning({ name = "the bot", explicit = null, sandbox = null } = {}) {
  if (explicit !== "auto" || sandbox?.state !== "missing") return null;
  return `${name}: Antigravity's --mode auto is not available on this host (${sandbox.detail}); agy continues in its default mode `
    + `and says so only in print mode. The launch still runs without prompts (${AGY_SKIP_PERMISSIONS}), under its deny list.`;
}

// ---- Antigravity's per-launch permission list (--settings, #823) ----
//
// agy 1.5.3 reads a permission list from a session's --settings file, never saving it: the file
// is a JSON settings object whose `permissions.allow` and `permissions.deny` are arrays of rules.
// A rule is `command(<the words it starts with>)` (a prefix match on the argv) or
// `write_file(<an absolute folder>)` (the files inside it). A deny rule wins over an allow rule.
// agy replaces its saved list field by field, so every launch carries both arrays in full.

/**
 * The rules every Antigravity launch carries; a roster adds rules and can never drop one.
 *
 * This list is a guardrail against accidents, not a security boundary. Every launch runs on
 * --dangerously-skip-permissions (#955), so whatever no rule here names runs with no prompt and
 * no classifier: inline code (python3 -c, node -e, bash -c), scripts, sh, env, curl, ssh, a
 * plain push, a child agent, a write to the launch's own settings file. A rule matches whole
 * words from the start of each part of a command line and takes no wildcard, so a reordered
 * command, an absolute path, a wrapper or an interpreter call goes around it. Not caught at
 * all: a force refspec whose `+` is attached to the ref (`git push origin +main`), combined
 * short flags (`git push -fu`), a `--flag=value` spelling, a force flag after a ref the list
 * doesn't name, `gh api <endpoint> -X ...` (only the flag-first forms are listed), and a reset
 * that reaches `--hard` after other words (`git reset HEAD~1 --hard`). The real boundary is the
 * sandbox (hcProxy). The list covers the common ways a bot would lose work or land something it
 * shouldn't.
 */
export const AGY_FIXED_DENY = Object.freeze([
  "command(git push --force)",
  "command(git push --force-with-lease)",
  "command(git push -f)",
  "command(git push origin --force)",
  "command(git push origin -f)",
  "command(git push --mirror)",
  "command(git push --delete)",
  "command(git reset --hard)",
  "command(git branch -D)",
  "command(git clean)",
  "command(git rebase)",
  "command(git stash)",
  "command(git checkout --)",
  "command(git -C)",
  "command(rm -rf)",
  "command(gh pr merge)",
  "command(gh release)",
  // #955: every launch runs with no permission prompt, so what used to stop at one is named
  // here. gh api's writing forms, flag first only (`gh api <endpoint> -X PUT` is not caught):
  "command(gh api -X)",
  "command(gh api --method)",
  "command(gh api -f)",
  "command(gh api -F)",
  // the roster and other bots' seats:
  "command(automagik-herdr edit)",
  "command(automagik-herdr restart)",
  "command(automagik-herdr rm)",
  "command(automagik-herdr create)",
  // am runs the same CLI (am/bin/am.mjs), so the same four verbs under its name:
  "command(am edit)",
  "command(am restart)",
  "command(am rm)",
  "command(am create)",
  // and another pane's keys and commands (its life is AGY_KILL_DENY's, by the bot's kind):
  "command(hc keys)",
  "command(hc interrupt)",
  "command(hc exec)",
  // More spellings of the same accidents (#998 review). A rule is whole words from the start of
  // the command, with no wildcard (checked on agy 1.5.4: `command(echo * two)` doesn't match
  // `echo one two`, and `--flag` doesn't match `--flag=value`), so each form is listed: a force
  // flag after -u or after a protected branch name, the other ways to write rm -rf, a forced
  // branch delete, git's own config and git-dir overrides, and a checkout or restore that
  // throws work away. A force flag after any other ref is still not caught.
  "command(git push -u --force)",
  "command(git push -u -f)",
  "command(git push -u --force-with-lease)",
  "command(git push --set-upstream --force)",
  "command(git push origin --force-with-lease)",
  ...["main", "dev", "master", "HEAD"].flatMap((ref) => ["--force", "-f", "--force-with-lease"]
    .map((flag) => `command(git push origin ${ref} ${flag})`)),
  "command(git branch --delete --force)",
  "command(git branch --delete -f)",
  "command(git branch -d --force)",
  "command(git branch -d -f)",
  "command(rm -fr)",
  "command(rm -r -f)",
  "command(rm -f -r)",
  "command(rm -Rf)",
  "command(rm -fR)",
  "command(rm -R -f)",
  "command(rm --recursive)",
  "command(git -c)",
  "command(git --git-dir)",
  "command(git restore .)",
  "command(git checkout -f)",
  "command(git checkout --force)",
]);

/**
 * `hc kill` is for the seat of a project's main bot only (the owner's rule, #955): every worker,
 * and every seat whose bot is not `kind: "main"` in the roster, carries these two rules; a main
 * bot's seat does not. The second names the usual flag-before-verb spelling; another global
 * flag before `kill` is not caught (a rule is whole words, no wildcard). A bot ends a worker it
 * started with `automagik-herdr worker kill <pane>`.
 */
export const AGY_KILL_DENY = Object.freeze(["command(hc kill)", "command(hc --json kill)"]);

/** Whether a launch of `bot` in `scope` may run `hc kill` itself: a main bot's seat, nothing else. */
export const mayHcKill = (bot, scope = "seat") => scope === "seat" && bot?.kind === "main";

/** The rule types agy 1.5.3 takes: a command prefix, or a folder its files are written under. */
export const AGY_RULE_TYPES = Object.freeze(["command", "write_file"]);

/** Why `rule` can't go in a permission list, or null. One line. */
export function agyRuleProblem(rule) {
  if (typeof rule !== "string" || !rule.trim()) return "a rule is text such as command(git) or write_file(/folder)";
  const text = rule.trim();
  if (/[\n\r]/.test(text)) return `${JSON.stringify(text)} has a line break`;
  const m = /^([a-z_]+)\(([\s\S]*)\)$/.exec(text);
  if (!m) return `${JSON.stringify(text)} isn't a rule (command(...) or write_file(...))`;
  const [, type, inner] = m;
  if (!AGY_RULE_TYPES.includes(type)) return `${JSON.stringify(text)}: unknown rule type ${type} (${AGY_RULE_TYPES.join(" or ")})`;
  if (!inner.trim()) return `${JSON.stringify(text)}: ${type === "write_file" ? "no folder" : "no command"}`;
  if (type === "write_file") {
    if (!inner.trim().startsWith("/")) return `${JSON.stringify(text)}: write_file takes an absolute folder`;
    if (inner.includes(")")) return `${JSON.stringify(text)}: a folder can't hold ")" in a rule`;
  }
  return null;
}

/** A roster `agyPermissions` value as { allow, deny, problems }: only the rules that pass, deduped. */
export function normalizeAgyPermissions(value) {
  if (!isObject(value)) return { allow: [], deny: [], problems: ["agyPermissions is not an object with allow and deny lists"] };
  const problems = [];
  const out = { allow: [], deny: [] };
  for (const key of Object.keys(value)) if (!["allow", "deny"].includes(key)) problems.push(`agyPermissions ${key} isn't allow or deny; ignored`);
  for (const key of ["allow", "deny"]) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { problems.push(`agyPermissions ${key} is not a list of rules`); continue; }
    for (const rule of list) {
      const why = agyRuleProblem(rule);
      if (why) { problems.push(why); continue; }
      const text = rule.trim();
      if (!out[key].includes(text)) out[key].push(text);
    }
  }
  return { ...out, problems };
}

// The read-only gh verbs a bot needs to read its task's pull request, checks and issues. No
// release verb is here: the fixed deny `command(gh release)` wins over every one of them, so an
// allow could never take effect.
const AGY_GH_READ = ["gh pr view", "gh pr list", "gh pr diff", "gh pr checks", "gh pr status", "gh issue view",
  "gh issue list", "gh issue status", "gh repo view", "gh run list", "gh run view", "gh workflow list",
  "gh workflow view", "gh label list", "gh search repos", "gh search prs", "gh search issues"];
// The PR-writing verbs a writer needs to open and update its own PR; a read-only launch gets none.
// `gh pr merge` stays out of both: the fixed deny names it.
const AGY_GH_WRITE = ["gh pr create", "gh pr edit", "gh pr comment"];

// The repository's own gates (AGENTS.md, the pack's gate): checks and tests that don't write.
const AGY_GATES = ["node --test", "node --check", "bun test", "node scripts/privacy-check.mjs", "node scripts/am-copies.mjs",
  "node scripts/version.mjs", "node scripts/entries.mjs", "node scripts/parts.mjs", "node scripts/catalog.mjs",
  "node scripts/lane.ts", "node scripts/test-guard.mjs", "node ../scripts/privacy-check.mjs", "node ../scripts/am-copies.mjs"];

// The 24 plain read-only shell tools every Antigravity seat and worker gets by default (#840).
// On GNU/Linux, `sed -n` runs a program (GNU `e` command) and writes (`w` command, `-i`),
// `rg --pre` runs a program, `sort --compress-program` runs one, and `sort -o` and `uniq IN OUT`
// write files: those four stay on writing roles only (alongside `mkdir` and `chmod`, where `node`
// is already allowed) and out of `AGY_SHELL_READ` / `AGY_READ_ALLOW`. Shell launchers and
// wrappers (`bash`, `sh`, `env`, `xargs`, `find`, `awk`, `tee`, plain `sed`) are never in any
// default list.
export const AGY_SHELL_READ = Object.freeze([
  "ls", "cat", "head", "tail", "grep", "wc", "diff", "pwd", "echo", "cut", "tr", "jq", "printf",
  "basename", "dirname", "true", "which", "stat", "realpath", "readlink", "date", "nl", "comm",
  "column",
]);

// A seat or worker that writes: the shell tools the task needs (`mkdir`, `chmod`, `rg`, `sort`,
// `uniq` and `sed -n` only when the role writes, since writers already have `node`), and the
// gates to prove it.
export const AGY_WRITE_ALLOW = Object.freeze(["hc", "git", "node", "bun", "mkdir", "chmod",
  "rg", "sort", "uniq", "sed -n", ...AGY_SHELL_READ, ...AGY_GH_READ, ...AGY_GH_WRITE,
  ...AGY_GATES].map((v) => `command(${v})`));
// A read-only seat (rank reviewer) or worker (role review): the read/send hc subcommands (`hc ls`,
// `hc get`, `hc read`, `hc wait`, `hc send` — never bare `hc`, so `hc run` and `hc exec` are not
// allowed on read-only roles), the 24 read-only shell tools, the test checks and a short list of
// git subcommands and gh reads. A subcommand is allowed with every argument it is given, so some
// can write (`git diff --output=file`): like the whole list, this is a guardrail, not a boundary.
export const AGY_READ_ALLOW = Object.freeze(["hc ls", "hc get", "hc read", "hc wait", "hc send",
  ...AGY_SHELL_READ, "git log", "git diff", "git show", "git status", "git rev-parse",
  "git ls-files", "git blame", "git describe", "git merge-base", "git rev-list", "git cat-file",
  ...AGY_GH_READ, "node --test", "node --check", "bun test"].map((v) => `command(${v})`));

/**
 * `folder` as a launch's canonical folder (#879, #884): the caller's injected `realpath` when
 * it gives one (the CLI passes `fs.realpathSync`), else the folder as it is. Pure: `realpath`
 * is a callback, never an `fs` import. A callback that throws (ENOENT on a synthetic test path)
 * or answers a non-path keeps the folder as given.
 */
function agyResolvedFolder(folder, realpath) {
  if (typeof folder !== "string" || typeof realpath !== "function") return folder;
  const path = folder.trim();
  if (!path.startsWith("/")) return folder;
  try {
    const real = realpath(path);
    if (typeof real === "string" && real.trim().startsWith("/")) return real.trim().replace(/\/+$/, "");
  } catch { /* the folder as given */ }
  return folder;
}

/** `path` as a trust-list entry: trimmed, trailing slashes stripped, and resolved by the injected
 * `realpath` when that gives an absolute answer; "" for the root or nothing usable (#879). */
function agyCanonicalPath(path, realpath) {
  const clean = path.trim().replace(/\/+$/, "");
  if (!clean || typeof realpath !== "function") return clean;
  try {
    const real = realpath(clean);
    if (typeof real === "string" && real.trim().startsWith("/")) return real.trim().replace(/\/+$/, "");
  } catch { /* a synthetic test path: the path as given */ }
  return clean;
}

/**
 * The folders a launch's `--settings` file lists in `trustedWorkspaces` (#879, #1046). agy trusts
 * a folder by exact path, so a launch would stop at its first-run question, "Do you trust the
 * contents of this project?". Every launch with a valid folder lists that launch's own folder,
 * whatever its scope or role: the project folder for a seat, the worker's worktree for a worker
 * (a review worker included) and the helper's folder for a helper. `realpath` (optional): a
 * `(path) => string` callback that resolves the folder to its canonical path, so a symlinked
 * folder is trusted by the folder it really is; null, or a callback that throws, keeps it as
 * given. `homeDir` (optional): the person's home folder, normalized and resolved the same way; a
 * folder that resolves to it lists nothing, so the home folder is never trusted, and a launch at
 * the home folder omits `trustedWorkspaces` instead of writing an empty list. Only `folder`
 * itself is listed, never a parent folder; anything but a trimmed absolute path (the root
 * included, a line-broken one, a non-string) lists nothing. The pack never writes agy's saved
 * settings.
 */
export function agyTrustedWorkspaces(folder, realpath = null, homeDir = null) {
  if (typeof folder !== "string") return [];
  const path = folder.trim();
  if (!path.startsWith("/") || !path.replace(/\/+$/, "") || /[\n\r\0]/.test(folder)) return [];
  const clean = agyCanonicalPath(path, realpath);
  if (!clean) return [];
  if (typeof homeDir === "string" && homeDir.trim() && !/[\n\r\0]/.test(homeDir)
    && clean === agyCanonicalPath(homeDir, realpath)) return [];
  return [clean];
}

/**
 * The effective allow and deny rules of an Antigravity launch: the defaults its scope and role
 * need, plus the roster's own additions (a bot's `agyPermissions` reaches its workers too).
 * `scope`: "seat" (a bot) or "worker"; `role`: a worker's role (models.js callers pass
 * workers.js's ROLES: only "review" is read-only); `folder`: the project or worktree that
 * `write_file` opens to a writer and that every launch's settings file trusts (#879, #1046);
 * `realpath` (optional): a `(path) => string` callback that resolves `folder` to its canonical
 * path for both the `write_file` rule and `trustedWorkspaces`, so a symlinked folder is named
 * by the folder it really is. `homeDir` (optional): the person's home folder; a folder that
 * resolves to it lists nothing (agyTrustedWorkspaces). A read-only launch (a review worker, a
 * reviewer seat) keeps the read-only `allow` list: no `write_file`, no writer shell tools. It is
 * still trusted for its own folder (#1046), so an unattended `--role review` worker never stops
 * at agy's trust question; its read-only brief, not the allow list, is what bounds it, and the
 * hc-proxy sandbox is the real boundary. The fixed deny rules are always there; nothing drops
 * them. `hc kill` is denied (AGY_KILL_DENY) to every worker and to every seat but a main bot's
 * (`bot.kind === "main"`). These lists are a guardrail against accidents, not a security
 * boundary: a rule matches word prefixes only, and allowing `node`, `bun` or `git` with any
 * arguments lets a determined agent do anything.
 * Returns { allow, deny, trustedWorkspaces, warnings }.
 */
export function agyPermissionPlan({ bot, scope = "seat", role = null, folder = null, realpath = null, homeDir = null }) {
  const readOnly = scope === "worker" ? role === "review" : bot?.rank === "reviewer";
  const trustedWorkspaces = agyTrustedWorkspaces(folder, realpath, homeDir);
  const allow = [...(readOnly ? AGY_READ_ALLOW : AGY_WRITE_ALLOW)];
  const warnings = [];
  if (!readOnly && typeof folder === "string" && folder) {
    const resolved = agyResolvedFolder(folder, realpath);
    const why = agyRuleProblem(`write_file(${resolved})`);
    if (why) warnings.push(`${bot?.name ?? bot?.id ?? "the bot"}: ${why}`);
    else allow.push(`write_file(${resolved})`);
  }
  const roster = bot?.agyPermissions === undefined ? { allow: [], deny: [], problems: [] } : normalizeAgyPermissions(bot.agyPermissions);
  allow.push(...roster.allow);
  for (const why of roster.problems) warnings.push(`${bot?.name ?? bot?.id ?? "the bot"}: ${why}`);
  const deny = [...AGY_FIXED_DENY, ...(mayHcKill(bot, scope) ? [] : AGY_KILL_DENY), ...roster.deny];
  return { allow: [...new Set(allow)], deny: [...new Set(deny)], trustedWorkspaces, warnings };
}

// A stable, path-free tag for a folder in a settings file's name: FNV-1a, 8 hex characters.
function agyFolderTag(folder) {
  let h = 0x811c9dc5;
  for (const ch of String(folder)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The folder a launch's permission file goes in, under an app home (`<app home>`). */
export function agySettingsDir(appHomeDir) {
  return `${String(appHomeDir).replace(/\/+$/, "")}/automagik-herdr/agy-settings`;
}

/**
 * The per-launch settings file of `botId`'s launch under the settings folder `dir` (agySettingsDir
 * for a local launch, the proxy's private folder otherwise), deterministic from the approved data
 * an approved-worker plan has too (the bot id, the role and the worktree), so the plan and the
 * argv it approves name the same file. `scope`: "seat", "worker" (whose role and worktree tag the
 * name), or "helper" (a tree helper that is no worker, tagged by its folder so it never rewrites
 * the bot's own seat file).
 */
export function agySettingsFile(dir, botId, scope = "seat", role = null, folder = null) {
  const root = String(dir).replace(/\/+$/, "");
  const safeRole = /^[a-z][a-z0-9-]{0,31}$/.test(String(role ?? "")) ? role : "dev";
  const tail = scope === "worker" ? `worker-${safeRole}${folder ? `-${agyFolderTag(folder)}` : ""}`
    : scope === "seat" ? "seat" : `${String(scope).replace(/[^a-z0-9-]/g, "") || "helper"}${folder ? `-${agyFolderTag(folder)}` : ""}`;
  return `${root}/${botId}-${tail}.json`;
}

/**
 * The settings file an Antigravity launch of `bot` gets: { path, text, allow, deny,
 * trustedWorkspaces, warnings }, or null for a bot with no id. `settingsDir` is the folder it
 * goes in (agySettingsDir under the app home; the proxy's own folder under the data root for an
 * approved worker). `realpath` and `homeDir` (optional) are agyPermissionPlan's: the folder's
 * canonical path, and the home folder that is never trusted. `text` is the JSON agy reads from
 * `--settings`: permissions.allow and permissions.deny, both arrays in full (agy replaces its
 * saved lists field by field), and, only when there is one, trustedWorkspaces, the launch's own
 * folder (agy trusts folders by exact path, #879). Every launch with a valid folder lists it, a
 * review launch included (#1046), so agy asks no first-run trust question. A launch at the home
 * folder, or with no valid folder at all, omits the key entirely, so a person's saved trust list
 * is never overwritten with [].
 */
export function agySettingsPlan({ bot, scope = "seat", role = null, folder = null, settingsDir, realpath = null, homeDir = null }) {
  if (!bot?.id || !settingsDir) return null;
  const plan = agyPermissionPlan({ bot, scope, role, folder, realpath, homeDir });
  const path = agySettingsFile(settingsDir, bot.id, scope, role, folder);
  const settings = { permissions: { allow: plan.allow, deny: plan.deny },
    ...(plan.trustedWorkspaces.length ? { trustedWorkspaces: plan.trustedWorkspaces } : {}) };
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  return { path, text, allow: plan.allow, deny: plan.deny, trustedWorkspaces: plan.trustedWorkspaces, warnings: plan.warnings };
}

/** The words that hand `agentKey` a permission list from `path`: ["--settings", path], or []. */
export function agySettingsArgs(agentKey, path) {
  return agentKey === "antigravity" && path ? ["--settings", path] : [];
}

/** `args` without the --settings words an earlier Antigravity launch left in a command line. */
export function withoutAgySettings(agentKey, args) {
  const words = Array.isArray(args) ? args.map(String) : [];
  if (agentKey !== "antigravity") return words;
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") { out.push(...words.slice(i)); break; }
    if (w === "--settings") { i += 1; continue; }
    if (w.startsWith("--settings=")) continue;
    out.push(w);
  }
  return out;
}

/**
 * `argv` (an Antigravity launch) with `--settings <path>` right after its program, any older
 * settings words taken out. Any other agent's argv, or one that doesn't run agy (a shell
 * template), is returned as it is.
 */
export function withAgySettings(agentKey, argv, path) {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  if (agentKey !== "antigravity" || !path || agentKeyOfArgv(words) !== agentKey) return words;
  const at = programAt(words);
  const rest = withoutAgySettings(agentKey, words.slice(at + 1));
  return [...words.slice(0, at + 1), "--settings", path, ...rest];
}

/**
 * Whether agy's terminal sandbox, and so `--mode`, can work on this host, from local evidence
 * only: injected `platform` and `read(path) => string | null | undefined` (null: the file isn't
 * there, undefined: it couldn't be read). Linux: unprivileged user namespaces restricted when
 * max_user_namespaces is 0, unprivileged_userns_clone is 0 or apparmor_restrict_unprivileged_userns
 * is 1; every control unreadable is evidence too. macOS: the Seatbelt tool agy's sandbox uses,
 * /usr/bin/sandbox-exec. Returns { state: "available" | "missing" | "unknown", detail }.
 */
export function agySandbox({ platform = process.platform, read = () => null } = {}) {
  const view = (path) => {
    try { return read(path); } catch { return undefined; }
  };
  if (platform === "linux") {
    const controls = [
      ["/proc/sys/user/max_user_namespaces", "0", "max_user_namespaces is 0"],
      ["/proc/sys/kernel/unprivileged_userns_clone", "0", "unprivileged_userns_clone is 0"],
      ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "1", "apparmor_restrict_unprivileged_userns is 1"],
    ];
    let readable = 0, unreadable = 0;
    for (const [path, restricted, said] of controls) {
      const text = view(path);
      if (typeof text === "string") {
        readable += 1;
        if (text.trim() === restricted) return { state: "missing", detail: `unprivileged user namespaces are restricted (${said})` };
      } else if (text === undefined) unreadable += 1;
    }
    if (readable === 0) return { state: "missing", detail: "the unprivileged user namespace controls are unreadable" };
    if (unreadable) return { state: "unknown", detail: `some unprivileged user namespace controls are unreadable (${unreadable} of ${controls.length})` };
    return { state: "available", detail: "unprivileged user namespaces are not restricted" };
  }
  if (platform === "darwin") {
    const tool = view("/usr/bin/sandbox-exec");
    if (typeof tool === "string") return { state: "available", detail: "the Seatbelt sandbox tool is there (/usr/bin/sandbox-exec)" };
    if (tool === null) return { state: "missing", detail: "the Seatbelt sandbox tool is missing (/usr/bin/sandbox-exec)" };
    return { state: "unknown", detail: "the Seatbelt sandbox tool could not be read (/usr/bin/sandbox-exec)" };
  }
  return { state: "unknown", detail: `this platform (${platform}) isn't one agy's terminal sandbox is known on` };
}

// How each agent takes a first prompt that starts an interactive session. Most read a bare
// trailing argument; agy 1.5.3 only through `-i` / `--prompt-interactive` (a stray trailing
// argument is an error).
// kimi takes none on its command line (#1032). Read on 2026-11-10 from kimi 2.5.0
// (@moonshot-ai/kimi-code; `kimi --version` prints 2.5.0), its --help: `Usage: kimi [options]
// [command]`, and any other word is a command name: `unknown command '<word>'. See 'kimi
// --help'.`, exit 1. Its one prompt option, `-p, --prompt <prompt>  Run one prompt
// non-interactively and print the response.`, is a one-shot print mode: it ends after the answer
// and refuses --yolo, --auto and --plan (`Cannot combine --prompt with --auto.`), and a worker
// must stay interactive. So kimi starts bare, and its task is its first message, sent once it
// says it is ready (it reports its status to hc; the CLI's worker verb: hc wait, then hc send).
const PROMPT = {
  antigravity: (task) => ["-i", task],
  "dsh-tui": (task) => ["--", plainPrompt(task)],
  kimi: () => [],
};

// dsh-tui's first prompt (a worker's task, a bot's briefing) goes after `--`, which DSH drops
// before it parses the next word: text that starts with "-" (`--resume=x`, `-c`) would be read
// as that option (#591 review N4). Such text gets a plain label in front; any other goes as it is.
const PROMPT_LABEL = "Prompt:";
/** `text` as a first prompt that never starts with "-": PROMPT_LABEL in front when it would. */
export const plainPrompt = (text) => (/^\s*-/.test(String(text)) ? `${PROMPT_LABEL} ${text}` : String(text));

/** The arguments that hand `agentKey` its first prompt `task`: the bare task unless PROMPT says otherwise. */
export function promptArgs(agentKey, task) {
  return PROMPT[agentKey] ? PROMPT[agentKey](task) : [task];
}

/**
 * Whether `agentKey` takes no first prompt on its command line (promptArgs gives it no word:
 * kimi), so whoever starts it sends the task as its first message instead.
 */
export const promptByMessage = (agentKey) => promptArgs(agentKey, "x").length === 0;

// How each agent picks up where it left off, for Restart: the words after its `run`. Each
// was read from that agent's own --help on 2026-11-03 (claude, codex resume, pi, omp, kimi,
// agy, hermes) and again on 2026-11-04 (omp 18.14.2 `-r, --resume=<value>` by ID prefix;
// codex-cli 0.166.0 `resume [SESSION_ID]` / `--last`; pi 1.5.0 `--session <path|id>`; kimi
// 2.5.0 `-S, --session [id]`; 2026-11-09: agy 1.5.3 `--conversation` by ID, `-c`/`--continue`
// the latest; hermes wasn't runnable then).
// Each resumes a known session by id, else (--continue, resume --last) the latest one, in its
// folder for most (codex resume --last filters by folder unless --all; agy's help says only "the
// most recent conversation"), which may be another bot's: so with no id and another bot on that
// agent in the folder, Restart starts fresh instead (#328). codex resume
// is a subcommand, which still goes after `run` (its top-level options come before it). An
// agent missing here has no resume this pack knows: Restart starts it fresh.
const RESUME = {
  claude: (session) => (session ? ["--resume", session] : ["--continue"]),
  codex: (session) => ["resume", session ?? "--last"],
  pi: (session) => (session ? ["--session", session] : ["--continue"]),
  omp: (session) => (session ? [`--resume=${session}`] : ["--continue"]),
  kimi: (session) => (session ? [`--session=${session}`] : ["--continue"]),
  antigravity: (session) => (session ? ["--conversation", session] : ["--continue"]),
  hermes: (session) => (session ? ["--resume", session] : ["--continue"]),
  // dsh-tui 0.19.0 (the DSH lane, #598): --resume <id>, else -c, the folder's last session.
  "dsh-tui": (session) => (session ? ["--resume", session] : ["-c"]),
};

// The agents whose id-less resume needs a turn finished in the old pane first (#598): dsh-tui's
// -c before any turn has ended there would pick up a session that isn't this pane's, or none.
// Restart reads the old pane's hc turn counter; a missing one counts as none: a new conversation.
const RESUME_AFTER_TURN = new Set(["dsh-tui"]);
/** True when `agentKey`'s id-less resume needs a finished turn in the old pane (RESUME_AFTER_TURN). */
export const resumeAfterTurn = (agentKey) => RESUME_AFTER_TURN.has(agentKey);

// The agents whose id-less resume isn't limited to the folder (agy 1.5.3: "Continue the most
// recent conversation"): any other bot on that agent, wherever it runs, may own that one.
const CONTINUES_ANYWHERE = new Set(["antigravity"]);
/** True when `agentKey`'s id-less resume may take a conversation from any folder (CONTINUES_ANYWHERE). */
export const continuesAnywhere = (agentKey) => CONTINUES_ANYWHERE.has(agentKey);

/** True when Restart can resume `agentKey`'s conversation (RESUME lists it). */
export const canResume = (agentKey) => Boolean(RESUME[agentKey]);

/** True when `agentKey` resumes a known session by its id (its RESUME entry takes one: every agent RESUME lists). */
export const resumesById = (agentKey) => typeof RESUME[agentKey] === "function" && RESUME[agentKey].length > 0;

/**
 * The words that resume `agentKey`'s last conversation, appended to its `run`: `session` is a
 * known session id (the pane's agent.session label), null when none is known. Null when the
 * agent has no resume (Restart then starts it fresh, and says so).
 */
export function resumeArgs(agentKey, session = null) {
  // Never a value that reads as a flag (the CLI passes only UUIDs; restart.js sessionId).
  const s = typeof session === "string" && session.trim() && !session.trim().startsWith("-") && resumesById(agentKey) ? session.trim() : null;
  return RESUME[agentKey] ? RESUME[agentKey](s) : null;
}

// The agents whose new session's id Herdr chooses at launch (RFC 0021 (f) 2), and the words
// that pass it: Claude Code 2.1.319 `--session-id <uuid>` ("Use a specific session ID for the
// conversation (must be a valid UUID)", read from `claude --help` on 2026-11-09). Claude refuses
// it beside --continue or --resume (unless --fork-session), so it goes only on a fresh launch.
const SESSION_ID = {
  claude: (id) => ["--session-id", id],
};

/** True when Herdr chooses the session id of a fresh `agentKey` launch (SESSION_ID lists it). */
export const choosesSession = (agentKey) => Boolean(SESSION_ID[agentKey]);

/** The words that start `agentKey` on the new session `id`: [] for an agent Herdr doesn't choose ids for. */
export const sessionIdArgs = (agentKey, id) => (SESSION_ID[agentKey] && typeof id === "string" && id ? SESSION_ID[agentKey](id) : []);

// A Claude command line's own session words: a resume, a continue, or a session id of its own.
const CLAUDE_SESSION_WORD = /^(?:--resume|-r|--continue|-c|--session-id|--fork-session)(?:=|$)/;

/**
 * Whether a command already picks its own Claude session: its argv (or, for a template, its
 * shell command's words) holds --resume, -r, --continue, -c, --session-id or --fork-session.
 * Such a launch gets no id from Herdr: a person's own words win.
 */
export function ownsSession(command) {
  const words = Array.isArray(command) ? command.map(String) : String(command ?? "").split(/[\s'"]+/);
  return words.some((w) => CLAUDE_SESSION_WORD.test(w));
}

// The words an earlier resume left in a command line, per agent, so a reused command doesn't
// resume twice: `flags` stand alone, `valued` take the next word (or `=value`), `inline` only
// take `=value` (omp's --resume picks a session when bare), `optional` take `=value` or the next
// word unless it is a flag (kimi's -S, --session [id]). codex's is the `resume` subcommand with
// its --last or session id. -c is --continue (codex's is --config).
const RESUMED = {
  claude: { flags: ["--continue", "-c"], valued: ["--resume", "-r", "--session-id"] },
  omp: { flags: ["--continue", "-c", "--resume", "-r"], inline: ["--resume", "-r", "--restore"] },
  pi: { flags: ["--continue", "-c", "--resume", "-r"], valued: ["--session"] },
  kimi: { flags: ["--continue", "-c"], optional: ["--session", "-S"] },
  antigravity: { flags: ["--continue", "-c"], valued: ["--conversation", "-conversation"] },
  hermes: { flags: ["--continue"] },
  "dsh-tui": { flags: ["-c", "--continue"], valued: ["--resume"] },
};

/**
 * `args` (a command line) without the words that resumed a conversation (RESUMED; codex's
 * `resume --last` / `resume <id>`), for a restart that reuses the command and adds its own.
 */
export function withoutResume(agentKey, args) {
  const words = Array.isArray(args) ? args.map(String) : [];
  if (agentKey === "codex") {
    const i = words.indexOf("resume");
    if (i < 0) return words;
    const next = words[i + 1];
    const drop = next !== undefined && (next === "--last" || !next.startsWith("-")) ? 2 : 1;
    return [...words.slice(0, i), ...words.slice(i + drop)];
  }
  const r = RESUMED[agentKey];
  if (!r) return words;
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") { out.push(...words.slice(i)); break; }
    const eq = w.startsWith("-") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (eq > 0 && ((r.valued ?? []).includes(name) || (r.inline ?? []).includes(name) || (r.optional ?? []).includes(name))) continue;
    if (eq < 0 && (r.valued ?? []).includes(w)) { i += 1; continue; }
    if (eq < 0 && (r.optional ?? []).includes(w)) { if (i + 1 < words.length && !words[i + 1].startsWith("-")) i += 1; continue; }
    if (eq < 0 && (r.flags ?? []).includes(w)) continue;
    out.push(w);
  }
  return out;
}

// How each agent takes a bot's briefing at launch, as an addition to its own system prompt,
// so no hook has to print it on every turn. Each was read on 2026-11-04 from the agent itself:
// Claude Code 2.1.318 `--append-system-prompt-file <path>` (its parser takes it; a missing file
// is an error, even interactive), codex 0.166.0 `-c developer_instructions=<TOML string>`
// (`codex debug prompt-input` shows it as a developer message), omp 18.14.2
// `--append-system-prompt=<text or file>`, grok 1.0.70 `--rules <text>` ("extra rules to append
// to the system prompt"), pi 1.5.0 `--append-system-prompt <text>` ("text or file contents"),
// hermes 0.22.5's HERMES_EPHEMERAL_SYSTEM_PROMPT (its CLI reads it at start and adds it at every
// API call, never saving it). Hermes' variable REPLACES the owner's own overlay (its config's
// display.personality, else agent.system_prompt), and a codex -c replaces a developer_instructions
// in config.toml: the CLI skips both then (ownPromptIn), so an owner's own prompt is never lost. `file` takes the briefing's
// path, `text` its text, `env` names variables; `ours` tells this pack's own words apart from a
// person's. `hook`: it also takes the per-turn hook (Claude Code's UserPromptSubmit in the
// project's .claude/settings.local.json); `ownConfig`: its briefing yields to a prompt its own config
// file may set, which only this computer's is read for, so a linked machine's start leaves it out
// (#582). An agent missing here gets no briefing at launch (agy, cursor-agent, opencode and kimi
// have no flag that appends).
export const BRIEFING_MARK = "<herdr-bot>";
/** The folder, under an app home, that holds the briefings `file` agents are started with. */
export const BRIEFINGS_DIR = "automagik-herdr/briefings";
const ourText = (v) => String(v).startsWith(BRIEFING_MARK);
const ourFile = (v) => String(v).includes(`/${BRIEFINGS_DIR}/`);
const BRIEFING = {
  claude: { file: (path) => ["--append-system-prompt-file", path], names: ["--append-system-prompt-file"], ours: ourFile, hook: true },
  codex: {
    text: (t) => ["-c", `developer_instructions=${tomlString(t)}`], names: ["-c", "--config"],
    ours: (v) => /^developer_instructions\s*=/.test(String(v)) && String(v).includes(BRIEFING_MARK), ownConfig: true,
  },
  omp: { text: (t) => [`--append-system-prompt=${t}`], names: ["--append-system-prompt"], ours: ourText },
  pi: { text: (t) => ["--append-system-prompt", t], names: ["--append-system-prompt"], ours: ourText },
  grok: { text: (t) => ["--rules", t], names: ["--rules"], ours: ourText },
  hermes: { env: (t) => ({ HERMES_EPHEMERAL_SYSTEM_PROMPT: t }), ownConfig: true },
  // dsh-tui has no system-prompt flag and no hook (#598): the briefing is its first prompt, the
  // last words of its command after `--` (plainPrompt), on every launch, a resumed one too.
  "dsh-tui": {
    prompt: (t) => {
      const name = String(t).match(/^You are (.+), (?:this project's main bot|a team member) \(bot [^)]+\)\.$/m)?.[1];
      return ["--", plainPrompt(name ? `${name} - ${t}` : t)];
    },
    ours: (v) => ourText(String(v).replace(/^Prompt: /, "").replace(/^.* - (?=<herdr-bot>)/, "")),
  },
};

/**
 * `text` as a TOML basic string: JSON's escapes are TOML's, but TOML also wants U+007F escaped
 * and has no lone surrogates (a value codex can't parse would reach it as the raw literal).
 */
export function tomlString(text) {
  const whole = String(text).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
  return JSON.stringify(whole).replace(/\x7f/g, "\\u007f");
}

/**
 * Whether an agent's own config text (configPaths: codex's config.toml, hermes' config.yaml) sets
 * the prompt this pack's briefing would replace: codex's top-level developer_instructions, hermes'
 * display.personality or agent.system_prompt with a value. A key read loosely errs toward true:
 * the briefing is then left out with a warning, never the owner's prompt.
 */
export function ownPromptIn(agentKey, text) {
  const t = typeof text === "string" ? text : "";
  if (agentKey === "codex") return /^\s*developer_instructions\s*=/m.test(t);
  if (agentKey === "hermes") return hermesPromptIn(t);
  return false;
}

// Hermes' display.personality or agent.system_prompt with a value: inline (not "", '', null or
// ~), or on the lines below the key, more indented (a plain or block scalar). Unsure reads as set.
function hermesPromptIn(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([ \t]*)(system_prompt|personality)[ \t]*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[3].replace(/(^|[ \t])#.*$/, "").trim();
    if (inline && !/^(""|''|null|~|Null|NULL)$/.test(inline)) return true;
    if (inline) continue;
    const next = lines.slice(i + 1).find((l) => l.trim() && !/^[ \t]*#/.test(l));
    if (next !== undefined && /^[ \t]*/.exec(next)[0].length > m[1].length) return true;
  }
  return false;
}

/** How `agentKey` takes a briefing at launch: "file", "text", "env", "prompt" (its first prompt, last), or null when it has no way. */
export function briefingWay(agentKey) {
  const b = BRIEFING[agentKey];
  return b?.file ? "file" : b?.text ? "text" : b?.env ? "env" : b?.prompt ? "prompt" : null;
}

/** Whether `agentKey` takes the per-turn briefing hook (BRIEFING's `hook`). */
export const briefingHook = (agentKey) => Boolean(BRIEFING[agentKey]?.hook);
/** Whether `agentKey`'s briefing yields to a prompt in its own config file (BRIEFING's `ownConfig`). */
export const briefingOwnConfig = (agentKey) => Boolean(BRIEFING[agentKey]?.ownConfig);

/**
 * What starts `agentKey` with its briefing: { args, env }, `path` the briefing file (for a
 * "file" agent; null: it couldn't be written, so nothing), `text` the briefing itself. Null
 * when the agent has no way, or what it needs is missing.
 */
export function briefingLaunch(agentKey, { path = null, text = null } = {}) {
  const b = BRIEFING[agentKey];
  if (b?.file) return path ? { args: b.file(path), env: {} } : null;
  if (!text) return null;
  if (b?.text) return { args: b.text(text), env: {} };
  if (b?.env) return { args: [], env: b.env(text) };
  if (b?.prompt) return { args: b.prompt(text), env: {} };
  return null;
}

/** `args` without the briefing words this pack put in for `agentKey` (a person's own stay). */
export function withoutBriefing(agentKey, args) {
  const words = Array.isArray(args) ? args.map(String) : [];
  const b = BRIEFING[agentKey];
  // A "prompt" agent's briefing is `-- <it>`, last; a first prompt of a person's own stays.
  if (b?.prompt) {
    const i = words.indexOf("--");
    return i >= 0 && i + 1 < words.length && b.ours(words[i + 1]) ? [...words.slice(0, i), ...words.slice(i + 2)] : words;
  }
  if (!b?.names) return words;
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") { out.push(...words.slice(i)); break; }
    if (b.names.includes(w) && i + 1 < words.length && b.ours(words[i + 1])) { i += 1; continue; }
    const eq = w.indexOf("=");
    if (eq > 0 && b.names.includes(w.slice(0, eq)) && b.ours(w.slice(eq + 1))) continue;
    out.push(w);
  }
  return out;
}

/**
 * `argv` (a whole command) with `launch` (briefingLaunch) put in right after the agent's own
 * executable, before any subcommand (codex's `resume` takes its -c there), and any briefing it
 * already carried taken out. A "prompt" agent's goes last instead (its first prompt), unless the
 * command already carries a first prompt of its own. A command that doesn't run `agentKey` (a
 * shell line) is left as it is.
 */
export function withBriefing(agentKey, argv, launch, agents = AGENTS) {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  if (agentKeyOfArgv(words, agents) !== agentKey) return words;
  const at = programAt(words);
  const rest = withoutBriefing(agentKey, words.slice(at + 1));
  if (BRIEFING[agentKey]?.prompt) return [...words.slice(0, at + 1), ...rest, ...(rest.includes("--") ? [] : launch?.args ?? [])];
  return [...words.slice(0, at + 1), ...(launch?.args ?? []), ...rest];
}

/** The briefing file of this pack's that a Claude Code `argv` was started with (its last such flag), or null. */
export function briefingFileOf(argv) {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  if (agentKeyOfArgv(words) !== "claude") return null;
  const { args } = agentArgv(words);
  const name = BRIEFING.claude.names[0];
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--") break;
    const value = args[i] === name ? args[i + 1] : args[i].startsWith(`${name}=`) ? args[i].slice(name.length + 1) : null;
    if (value != null) found = ourFile(value) ? value : null;
  }
  return found;
}

/**
 * The conversation a Claude Code `argv` resumes: its id (`--resume <id>`, `-r <id>`,
 * `--resume=<id>`), null for one with no id (`--continue`, `-c`, a bare --resume), undefined
 * when it resumes none.
 */
export function resumedSessionOf(agentKey, argv) {
  if (agentKey !== "claude") return resumesConversation(agentKey, argv) ? null : undefined;
  const { args } = agentArgv(argv);
  let found;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    if (w === "--") break;
    if (w === "--continue" || w === "-c") found ??= null;
    else if (w === "--resume" || w === "-r") { const v = args[i + 1]; found = v && !v.startsWith("-") ? v : null; }
    else if (w.startsWith("--resume=")) found = w.slice(9) || null;
  }
  return found;
}

/** True when `argv` resumes an earlier conversation of `agentKey` (the words RESUMED knows). */
export function resumesConversation(agentKey, argv) {
  const { args } = agentArgv(argv);
  return withoutResume(agentKey, args).length !== args.length;
}

/**
 * `args` (a command line) without the flags that name `agentKey`'s model (FLAGS: `--model X`,
 * `--model=X`, codex's `-m X`, `-mX` and `-c model=X`), so a bot's pin can replace them.
 */
export function withoutModel(agentKey, args) {
  const words = Array.isArray(args) ? args.map(String) : [];
  const flags = FLAGS[agentKey];
  if (!flags) return words;
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") { out.push(...words.slice(i)); break; }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if ((flags.long ?? []).includes(name) || (flags.short ?? []).includes(name)) { if (eq < 0) i += 1; continue; }
    if ((flags.short ?? []).some((f) => w.startsWith(f) && w.length > f.length && !w.startsWith("--"))) continue;
    if ((flags.config ?? []).includes(name)) {
      const v = eq > 0 ? w.slice(eq + 1) : words[i + 1];
      if (typeof v === "string" && /^model\s*=/.test(v.trim())) { if (eq < 0) i += 1; continue; }
    }
    out.push(w);
  }
  return out;
}
