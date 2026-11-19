// Restart over plain data: what a bot's replacement pane runs (resume the conversation, a
// fresh one, or a swap to another agent or model), why a restart is refused, and the labels
// the replacement carries over from the old pane. The CLI's `restart` runs it with hc; the
// sidebar's Restart runs the CLI. Pure: no `herdr`, so `node --test` runs it. Apache-2.0.

import { agentKeyOfArgv, agyGuarded, agyModeArgs, agyModeProblem, agySettingsArgs, agySettingsDir, agySettingsPlan, canResume, codexClean, effortArgs, launchRun,
  modelArgs, ownsSession, resumeArgs, resumesById, seatSettingsArgs, sessionIdArgs, withCodexGrants, withoutAgySettings, withoutBriefing, withoutResume } from "./models.js";
import { SQUAD_LABEL, SQUAD_MARK } from "./launchArgs.js";
import { ENV, WORKER_AGY_MODE_LABEL, WORKER_EFFORT_LABEL, WORKER_MODEL_LABEL, WORKER_OF_LABEL, WORKER_ROLE_LABEL, WORKER_TEMPLATE_LABEL, codexCommandCheck,
  codexTemplateRefusal, codexTemplateWarning, templateAgent } from "./workers.js";
import { CONFIG_VAR, envWords } from "./logins.js";
import { hermesPairRun } from "./hermesPair.js";
import { actionError } from "./actionError.js";
import { isPromptLine, pendingDialog, screenLines } from "./dialog.js";

/** The prompt and dialog helpers stay available from here, their old home (#805, #1414). */
export { isPromptLine, pendingDialog };

/** The pane label the briefing hook sets to the Claude session a terminal runs (workers.js SESSION_LABEL). */
const SESSION = "agent.session";

// A Claude session id is a UUID; anything else (a value starting with "-" would read as a
// flag) is not passed to --resume.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `s` trimmed when it is a session id Restart may resume (UUID-shaped), else null. */
export const sessionId = (s) => (typeof s === "string" && UUID.test(s.trim()) ? s.trim() : null);
// Another agent's session id or name (Hermes: "by ID or title"): one word, never a flag.
const SESSION_WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The session id `agentKey` would resume from the label `s`: Claude's a UUID, another's one safe word; else null. */
export const sessionFor = (agentKey, s) => (agentKey === "claude" ? sessionId(s)
  : typeof s === "string" && SESSION_WORD.test(s.trim()) ? s.trim() : null);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const base = (p) => String(p ?? "").split("/").pop();
// What a reused shell command gets after it, so the resume words arrive as real arguments.
const ARGS = ' "$@"';
/** `realpath(path)`'s canonical answer when it gives one, else `path` (a throw keeps it too). */
const realPathOf = (realpath, path) => {
  if (typeof realpath !== "function" || typeof path !== "string") return path;
  try {
    const real = realpath(path);
    return typeof real === "string" && real.trim() ? real : path;
  } catch { return path; }
};

/**
 * The command an hc pane was started with (`get.argv`, hc get's launch argv), ready to be run
 * again: { shell } for a `sh -c <command>` (an hc template, which hc runs that way, or a
 * replacement of one: its ` "$@"` and arguments dropped), else { argv } (this pack's
 * `/usr/bin/env [-u NAME…] PATH=… [NAME=value…]` prefix dropped whole: the CLI puts its own on,
 * a briefing variable and the Claude login words included, launchArgs.js startArgs; logins.js).
 * A template worker on a Claude login has `/usr/bin/env <login words> sh -c …` with no PATH,
 * dropped the same way. Null when hc gave none.
 */
export function paneCommand(get) {
  let argv = Array.isArray(get?.argv) && get.argv.length && get.argv.every((w) => typeof w === "string") ? [...get.argv] : null;
  if (!argv) return null;
  if (argv[0] === ENV) {
    const unset = argv[1] === "-u" && argv[2] === CONFIG_VAR;
    let i = unset ? 3 : 1;
    if (unset || argv[i]?.startsWith("PATH=") || argv[i]?.startsWith(`${CONFIG_VAR}=`)) {
      while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i += 1;
      if (i < argv.length) argv = argv.slice(i);
    }
  }
  if (SHELLS.has(base(argv[0])) && argv[1] === "-c" && typeof argv[2] === "string" && argv[2].trim()) {
    const cmd = argv[2];
    return { shell: argv.length > 3 && cmd.endsWith(ARGS) ? cmd.slice(0, -ARGS.length) : cmd };
  }
  return { argv };
}

/** `cmd` with its quoted text ('…', "…", a backslash-escaped character) blanked out: what sh reads as syntax. */
const unquoted = (cmd) => cmd.replace(/\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g, (q) => (q[0] === "\\" ? "__" : "''"));
/**
 * Whether words can go after shell command `cmd` as its last command's arguments: not when it
 * ends in a separator (`;`, `&`, `|`, which would make them a command of their own) or has a
 * comment (`#` after a blank, which would swallow them), each outside quotes (a quoted `"issue
 * #12"` is an argument, not a comment). One that already passes "$@" on takes them as they are.
 */
export const takesWords = (cmd) => cmd.includes(ARGS.trim()) || !(/[;&|]\s*$/.test(unquoted(cmd)) || /(^|\s)#/.test(unquoted(cmd)));

/**
 * `command` (paneCommand) with `words` after it: argv for hc run; null when a shell command
 * can't take them (takesWords). A command that passes "$@" on itself gets no second one.
 */
export function commandArgv(command, words = []) {
  if (command.shell === undefined) return [...command.argv, ...words];
  if (!words.length) return ["sh", "-c", command.shell];
  if (!takesWords(command.shell)) return null;
  return ["sh", "-c", command.shell.includes(ARGS.trim()) ? command.shell : `${command.shell}${ARGS}`, "sh", ...words];
}

/**
 * `args` without a trailing first prompt (a last word with a blank in it that no option takes
 * as its value: `omp --model=k "fix the bug"`), so a resume doesn't send it again. A prompt
 * without a blank can't be told from an argument and stays.
 */
export function withoutPrompt(args) {
  const words = [...args];
  const last = words.at(-1), before = words.at(-2);
  if (words.length > 1 && typeof last === "string" && /\s/.test(last) && !(before?.startsWith("-") && !before.includes("="))) words.pop();
  return words;
}

/**
 * What the replacement runs, rebuilt from the bot's current source (#597): never the old pane's
 * command. `bot`: { agent, model } as stored; `run`: the target agent's `run` (Herdr's table,
 * programs.json applied); `runningAgent`: the agent key the old pane's foreground runs
 * (agentKeyOfArgv), null when unknown or when nothing runs; `session`: the old pane's session id
 * (its agent.session label, or the ledger's); `fresh`, `agent`, `model`: the options (undefined:
 * not given); `template`: the hc template the old pane ran and hc still lists, with its CURRENT
 * command ({ name, command }), or null; `agy`: { appHomeDir, folder, realpath, homeDir } when
 * this launch may write the Antigravity permission list (#823), null for a caller that writes
 * it itself (a linked machine's start). `realpath` is the caller's `(path) => string`
 * (fs.realpathSync): a symlinked folder is trusted and written by its canonical path (#884).
 * `homeDir` is the person's home folder, never trusted (#884 Low A). A template owns its
 * command (#213): the replacement runs that command, never the pane's copy of it, with the
 * agent's own resume words when it resumes.
 * An --agent or --model is a swap, always fresh: a conversation doesn't cross agents, and the
 * command is the agent table's. Otherwise the command is the template's, or the agent row, its
 * Antigravity mode (agyModeArgs: --mode, auto by default), its permission list (--settings,
 * #823), the model pin and the agent's own resume words for `session` (resumeArgs), so a flag
 * the pane once had but the source no longer names is dropped. Returns { mode: "resume" |
 * "fresh" | "swap", agent, model, resume (the resume words, [] for a new conversation), argv,
 * source (the agent row with no resume words, for launchChange), template (the template's name,
 * null when the agent row ran), agySettings (the file to write first, or null), sessionId, note }
 * (`note`: why a resume wasn't possible, else null).
 * `newSession` (RFC 0021 (f) 2): the id the CLI chose for a new conversation. A fresh or swap
 * plan on an agent Herdr chooses ids for (Claude) starts on it (`--session-id`, sessionIdArgs)
 * and returns it as `sessionId`, unless its command picks a session of its own (ownsSession: a
 * person's --session-id, --resume or --continue wins) or is a template command that can't take
 * words; a resume never gets one (it keeps its session). Else `sessionId` is null.
 * A Codex seat (#1125: a bot runs the pack's Codex launch mode, never a template's bypass) keeps
 * its template only when the template's command names no approval or sandbox flag of its own (nor
 * an `--add-dir` `where` doesn't allow: models.js codexWhere) and provably forwards words to Codex
 * as options (codexCommandCheck `forwards`, #1142: no `--` in its Codex run, no earlier "$@"),
 * and takes words after it: the mode words it lacks and an `--add-dir` for each
 * of `grants` (the folders this launch may write, models.js codexGrants) go after it through
 * "$@", as resume words do, and `granted` is true. Any other Codex template is set aside for the
 * agent row, and `templateNote` names it and its flags (never a value). Else `templateNote` is
 * null and `granted` false (the caller adds the grants to the agent row's mode words).
 */
export function restartPlan({ bot, run, runningAgent = null, session = null, fresh = false, agent, model, template = null,
  agy = null, newSession = null, grants = [], where = null }) {
  if (bot.agent === "hermes" && bot.hermes !== undefined) {
    if (fresh || (agent !== undefined && agent !== "hermes") || model || template) throw new Error("This Hermes bot is paired; unpair it before a fresh session, agent/model swap or template launch.");
    const argv = hermesPairRun(run, bot);
    return { mode: "resume", agent: "hermes", model: null, resume: ["--continue", "Bot Chat"], argv,
      source: argv, template: null, agySettings: null, sessionId: null, canonicalBot: true, note: "paired Bot Chat, resolved by exact title" };
  }
  const swap = agent !== undefined || model !== undefined;
  const key = agent ?? bot.agent;
  // A new agent without --model starts on its own default: the old pin belongs to the old agent.
  const pin = model !== undefined ? (model || null) : key === bot.agent ? (bot.model ?? null) : null;
  // Antigravity always gets its mode (auto unless the roster names one); [] for every other agent.
  const modeWords = agyModeArgs(key, bot.agyMode ?? null);
  const settings = agy && key === "antigravity"
    ? agySettingsPlan({ bot, scope: "seat", folder: agy.folder ?? "", settingsDir: agySettingsDir(agy.appHomeDir),
      realpath: agy.realpath ?? null, homeDir: agy.homeDir ?? null }) : null;
  const settingsWords = agySettingsArgs(key, settings?.path);
  // #1411: the bot's own reasoning effort and service tier (Codex's), after its own words so
  // they win over a profile, and after a template's own words so the roster wins there too. A
  // stored tier goes with the model it was picked for: a restart's model swap (the one path that
  // changes the model with no tier option) runs the new model on Codex's default tier, said
  // explicitly as standard, so neither the record's Fast nor a profile's can stay on it.
  const storedModel = typeof bot.model === "string" && bot.model ? bot.model : null;
  const modelSwitch = model !== undefined && (model || null) !== storedModel;
  // A Codex seat's own record carries the tier; a bot changing agent (or one that was never
  // Codex's) has none of its own, so it keeps inheriting as before.
  const seatSwap = modelSwitch && bot.agent === "codex" && key === "codex";
  const seatWords = seatSettingsArgs(key, seatSwap ? { ...bot, tier: "standard" } : bot);
  // The source a pane's launch is compared with names no settings file: that one is this
  // launch's own, never a change a restart should report.
  const source = [...run, ...modeWords, ...modelArgs(key, pin), ...seatWords];
  // A template owns its command only when it runs the bot's own agent, whatever the pane's
  // foreground says (unknown included): a template for another agent, a swap or a pane on
  // another agent starts from the agent row (the template would cross them).
  let tpl = !swap && (!runningAgent || runningAgent === key) && typeof template?.command === "string" && template.command.trim()
    && templateAgent(template.command) === key ? template : null;
  // #1125: a Codex seat's template, read (never rewritten): kept with the mode words it lacks and
  // the grants after it, or set aside for the agent row, by name.
  let codexWords = [], templateNote = null;
  const check = tpl && key === "codex" ? codexCommandCheck(tpl.command, undefined, where) : null;
  if (check) {
    if (check.conflicts.length || !check.forwards || !takesWords(tpl.command)) {
      const why = check.conflicts.length ? `names ${check.conflicts.join(", ")}`
        : check.lost.length ? `puts ${check.lost.join(", ")} after its --, where Codex reads them as prompt text`
          : "can't pass the pack's Codex words to Codex as options";
      templateNote = `its template ${tpl.name} ${why}, so it started from its agent row in Codex's launch mode (#1125)`;
      tpl = null;
    } else codexWords = [...check.missing, ...grants.flatMap((d) => ["--add-dir", d])];
  }
  const granted = Boolean(check && tpl);
  // A template command can't take resume words (it ends in a separator or a comment): start it
  // fresh and say why, as a helper does.
  const blocked = "its template's command ends in a separator or a comment, so it can't take resume words";
  const plan = (mode, extra = [], note = null) => {
    if (!tpl) return { mode, agent: key, model: pin, resume: extra, argv: [...run, ...modeWords, ...settingsWords, ...extra, ...modelArgs(key, pin), ...seatWords],
      source, template: null, agySettings: settings, note, templateNote, granted: false };
    const words = [...codexWords, ...settingsWords, ...extra, ...seatWords];
    const argv = commandArgv({ shell: tpl.command }, words);
    if (argv) return { mode, agent: key, model: null, resume: extra, argv, source, template: tpl.name, agySettings: settings, note, templateNote, granted };
    // Nothing past the template's own command: neither the permission list nor resume words.
    if (words.length) {
      return { mode: "fresh", agent: key, model: null, resume: [], argv: commandArgv({ shell: tpl.command }), source, template: tpl.name,
        agySettings: null, note: settingsWords.length ? `${blocked}; the Antigravity permission list can't be added either` : blocked, templateNote, granted: false };
    }
    return { mode, agent: key, model: null, resume: [], argv: commandArgv({ shell: tpl.command }), source, template: tpl.name, agySettings: null, note,
      templateNote, granted: false };
  };
  // A new conversation: on the CLI's chosen id when the command takes one and picks none itself.
  const started = (mode, note = null) => {
    const words = sessionIdArgs(key, newSession);
    const takes = words.length && !ownsSession(tpl ? tpl.command : source) && (!tpl || commandArgv({ shell: tpl.command }, words));
    return takes ? { ...plan(mode, words, note), resume: [], sessionId: newSession } : { ...plan(mode, [], note), sessionId: null };
  };
  if (swap) return started("swap");
  if (runningAgent && runningAgent !== key) return started("fresh", `its pane runs ${runningAgent}, not ${key}, and a conversation doesn't cross agents`);
  if (fresh) return started("fresh");
  if (!canResume(key)) return started("fresh", `${key} has no resume this pack knows`);
  // The id goes to every agent that resumes by one (models.js resumesById), never only Claude.
  const id = resumesById(key) ? sessionFor(key, session) : null;
  return { ...plan("resume", resumeArgs(key, id)), sessionId: null };
}

const sameWords = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

/** What a value in a launch is replaced with in a line: never the value itself. */
const MASK = "***";
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * The flags known to take no value, per agent: the word after one is a flag of its own. Any other
 * flag takes the next word as its value, and a value is masked whatever it looks like (D1's
 * fail-closed rule). When an agent isn't listed, every flag is taken to have a value. The resume
 * aliases are here though a restart strips them before a line is compared.
 */
const NO_VALUE = Object.fromEntries(Object.entries({
  claude: ["-c", "--continue", "--dangerously-skip-permissions"],
  codex: ["--yolo", "--approve-for-me"],
  hermes: ["--tui", "--yolo"],
  omp: ["--auto-approve", "-c", "--continue"],
  pi: ["-c", "--continue"],
  kimi: ["-c", "--continue"],
  antigravity: ["-c", "--continue", "--dangerously-skip-permissions"],
  "dsh-tui": ["-c", "--continue"],
}).map(([key, flags]) => [key, new Set(flags)]));

/**
 * A launch's own words as { key, text, value } tokens, for launchChange (#597 review F2, D1):
 * a flag by name with its value masked (`--model=***`), an inline value (`--k=v`), a separate
 * value folded in and masked whatever it looks like (`--k v`, `--k -v`, `--k --v`), a short flag
 * with its value joined on cut to its first two characters (`-kV` is `-k=***`), an env assignment
 * as `NAME=***`, and a bare word (a program, a prompt, a positional argument) left out. Only the
 * flags in NO_VALUE print without consuming the next word: any other flag's next word is its
 * value, so nothing in value position reaches a line. `--` ends the options.
 */
function launchTokens(words, agent = null) {
  const list = Array.isArray(words) ? words.map(String) : [];
  const known = NO_VALUE[agent] ?? new Set();
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const w = list[i];
    if (w === "--") break;
    if (w.startsWith("-") && w !== "-") {
      const eq = w.indexOf("=");
      if (eq > 0) { out.push({ key: w.slice(0, eq), text: `${w.slice(0, eq)}=${MASK}`, value: w.slice(eq + 1) }); continue; }
      // A short flag with its value joined on: `-kV`, `-kSECRET`.
      if (!w.startsWith("--") && w.length > 2) { out.push({ key: w.slice(0, 2), text: `${w.slice(0, 2)}=${MASK}`, value: w.slice(2) }); continue; }
      // A known boolean prints by name and takes no value; a flag after it is a flag.
      if (known.has(w)) { out.push({ key: w, text: w, value: "" }); continue; }
      // Value position: whatever follows is this flag's value, masked however it looks.
      const next = i + 1 < list.length && list[i + 1] !== "--" ? list[i + 1] : undefined;
      out.push({ key: w, text: next === undefined ? w : `${w}=${MASK}`, value: next ?? "" });
      if (next !== undefined) i += 1;
      continue;
    }
    const assign = ASSIGN.exec(w);
    if (assign) out.push({ key: assign[1], text: `${assign[1]}=${MASK}`, value: assign[2] });
  }
  return out;
}

/**
 * How two launches' named words differ, values masked: `drops --proxy=***, -m=***`, `adds
 * --effort=***`, `changes --model=***`. A flag both sides carry with the same value isn't
 * named; a bare value is never printed.
 */
export function launchDiff(oldWords, newWords, agent = null) {
  const olds = launchTokens(oldWords, agent);
  const news = launchTokens(newWords, agent);
  const by = (tokens) => { const m = new Map(); for (const t of tokens) m.set(t.key, [...(m.get(t.key) ?? []), t]); return m; };
  const oldBy = by(olds), newBy = by(news);
  const values = (ts) => ts.map((t) => t.value).sort();
  const same = (a, b) => sameWords(values(a), values(b));
  const dropped = [...oldBy].filter(([k]) => !newBy.has(k)).map(([, ts]) => ts[0].text);
  const added = [...newBy].filter(([k]) => !oldBy.has(k)).map(([, ts]) => ts[0].text);
  const changed = [...oldBy].filter(([k, ts]) => newBy.has(k) && !same(ts, newBy.get(k))).map(([, ts]) => ts[0].text);
  const parts = [];
  if (dropped.length) parts.push(`drops ${dropped.join(", ")}`);
  if (added.length) parts.push(`adds ${added.join(", ")}`);
  if (changed.length) parts.push(`changes ${changed.join(", ")}`);
  return parts.join("; ");
}

/**
 * The command an old pane's hc get ran (`launch`, paneCommand), as the source's launch compares:
 * its briefing and first prompt out, and its old resume words dropped (a restart computes those
 * from the session, #597). Null when hc gave no command, when it is a shell line (a template:
 * nothing to compare word for word), or when it runs another agent.
 */
export function paneLaunch(launch, agentKey) {
  if (!launch || launch.shell !== undefined || agentKeyOfArgv(launch.argv) !== agentKey) return null;
  return withoutPrompt(withoutResume(agentKey, withoutAgySettings(agentKey, withoutBriefing(agentKey, launch.argv))));
}

/**
 * One line naming how the old pane's command (`launch`, paneCommand of its hc get) differs from
 * what the bot's source launches now, or null when they agree (#597). Only flag names are named,
 * their values masked (#597 review F2); `template` (the template the pane ran, { name, command }
 * when hc still lists it, else { name }) is named, never its command text. `usedTemplate`: the
 * restart is running that template, so a matching command is no difference; when it isn't (the
 * template runs another agent, say), its name is the difference (D2). `argv`: the agent row with
 * no resume words, for a pane whose source isn't a template.
 */
export function launchChange({ name, launch, agent, argv, template = null, usedTemplate = false }) {
  if (!launch) return null;
  if (template) {
    if (usedTemplate && template.command && launch.shell !== undefined && launch.shell === template.command) return null;
    if (usedTemplate && template.command) {
      return `${name}: its pane's command differs from template ${template.name}'s current command: restarting through the template.`;
    }
    return `${name}: its pane's template ${template.name} differs from its source now: restarting from the source, not the pane's command.`;
  }
  if (launch.shell !== undefined) {
    return `${name}: its pane's command (a shell command) differs from its source now: restarting from the source, not the pane's command.`;
  }
  const pane = paneLaunch(launch, agent);
  if (pane && sameWords(pane, argv)) return null;
  const diff = launchDiff(pane ?? launch.argv, argv, agent);
  const said = diff ? ` (${diff})` : "";
  return `${name}: its pane's command differs from its source now${said}: restarting from the source, not the pane's command.`;
}

/**
 * The folder name Claude Code keeps a folder's conversations under (~/.claude/projects/<slug>):
 * the path with every character that isn't a letter or digit made "-". Two folders with one
 * slug share their conversations, so a session resumes in either.
 */
export const claudeSlug = (folder) => String(folder ?? "").replace(/[^A-Za-z0-9]/g, "-");

/** Where Claude Code keeps `session`'s log for a pane launched in `cwd` (#1556), as a path. */
export const claudeTranscriptPath = (home, cwd, session) =>
  `${String(home ?? "").replace(/\/+$/, "")}/.claude/projects/${claudeSlug(cwd)}/${session}.jsonl`;

/**
 * The context a Claude Code session's next request carries (#1556): input + cache-read +
 * cache-creation tokens of the NEWEST assistant message in the session log's JSONL text.
 * Later assistant messages win; a line that isn't JSON, isn't an assistant message or carries
 * no usable usage is skipped. Null when the text holds no such message: nothing is measured,
 * never zero.
 */
export function contextTokensOf(text) {
  const lines = String(text ?? "").split("\n");
  let tokens = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (row?.type !== "assistant") continue;
    const usage = row?.message?.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const parts = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
      .map((k) => usage[k])
      .filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (!parts.length) continue;
    tokens = parts.reduce((sum, n) => sum + n, 0);
  }
  return tokens;
}

/** The old pane's Claude session id (its agent.session label, UUID-shaped), or null. */
export const sessionOf = (get) => sessionId(get?.labels?.[SESSION]);

/**
 * A pane's session id for agent `agentKey`: its agent.session label, else the revive.session
 * label a reviver keeps on hc panes (with revive.agent, when set, naming that agent), else null.
 */
export function paneSession(get, agentKey) {
  const labels = get?.labels ?? {};
  const own = sessionFor(agentKey, labels[SESSION]);
  if (own) return own;
  if (labels["revive.agent"] && labels["revive.agent"] !== agentKey) return null;
  return sessionFor(agentKey, labels["revive.session"]);
}

/**
 * The last `agentKey` session the workers ledger ties to `terminal` (its session rows, workers.js
 * readLedger): { session, transcript }, or null. For a pane whose label is missing. A row
 * names its agent (`agent`), else it is Claude's (the briefing hook, Claude's only, writes
 * them); its id passes as sessionFor passes a label: Claude's a UUID, another's one safe word.
 * hc reuses an address once its pane is gone, so a row from an earlier pane there never
 * counts: one stamped (`at`) before `created_ms` (the pane's, from hc get), or, with no
 * created_ms known, one older than a later start row for that terminal.
 */
export function ledgerSession(rows, terminal, agentKey = "claude", created_ms = null) {
  const born = Number.isSafeInteger(created_ms) ? created_ms : null;
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i -= 1) {
    const r = rows[i];
    // A start row naming its session (RFC 0021: the id Herdr chose, or resumed) is that launch's first one.
    if (r?.event === "start" && r.terminal === terminal && (born === null || r.created_ms === born || !Number.isSafeInteger(r.created_ms))) {
      const own = (r.agent ?? "claude") === agentKey && (born === null || r.created_ms === born) ? sessionFor(agentKey, r.session) : null;
      if (own) return { session: own, transcript: null };
      if (born === null) return null;
    }
    if (r?.event !== "session" || r.terminal !== terminal || (r.agent ?? "claude") !== agentKey) continue;
    if (born !== null && typeof r.at === "string" && Date.parse(r.at) < born) return null;
    const session = sessionFor(agentKey, r.session);
    if (session) return { session, transcript: typeof r.transcript === "string" ? r.transcript : null };
  }
  return null;
}

/**
 * Why Restart won't resume with claude --continue, or null: it takes the folder's latest
 * conversation, which may be a teammate's when another bot's Claude pane runs in that folder.
 * `sharers`: those panes as { address, name }. A linked machine's restart refuses so; a local
 * one starts fresh instead and says why (sharedFresh).
 */
export function continueRefusal({ name, old, cwd, sharers = [], agent = "Claude" }) {
  if (!sharers.length) return null;
  const who = sharers.map((x) => `${x.name} (${x.address})`).join(", ");
  return `${name} has no recorded ${agent} session (${old.address} has no agent.session label and the ledger has no session row for it), `
    + `and ${who} also ${sharers.length === 1 ? "runs" : "run"} ${agent} in ${cwd}, so --continue could resume theirs. Nothing was started; `
    + `restart with --fresh for a new conversation.`;
}

/**
 * Why Restart starts `name` on a new conversation instead of resuming the latest one in `cwd`
 * (#328), or null: no session id is known for the old pane, and `sharers` (other bots or panes
 * on `agent` in that folder, { address, name, ended }: `ended`, known only by its seat row)
 * could own that latest one. `words`: the resume it skips (--continue, resume --last);
 * `agent`: the agent's name; `anywhere`: that resume isn't limited to the folder
 * (models.js continuesAnywhere), so `sharers` run that agent anywhere.
 */
export function sharedFresh({ name, old, cwd, sharers = [], agent, words, anywhere = false }) {
  if (!sharers.length) return null;
  const who = sharers.map((x) => `${x.name} (${x.address}${x.ended ? ", ended" : ""})`).join(", ");
  const verb = sharers.some((x) => x.ended) ? "ran" : sharers.length === 1 ? "runs" : "run";
  return `no ${agent} session id is known for ${old.address}, and ${who} also ${verb} ${agent}${anywhere ? "" : ` in ${cwd}`}, `
    + `so ${words} could resume theirs instead of ${name}'s${anywhere ? ` (${agent}'s ${words} isn't limited to one folder)` : ""}`;
}

/** The helpers (hc get answers) that end with their parent's pane: live, die_with_parent. */
export const doomedHelpers = (helpers = []) => helpers.filter((h) => h?.state === "live" && h.die_with_parent !== false && h.address);

/** A turn still running: its spinner or interrupt hint, never an idle prompt. */
const MID_TURN_SCREEN = /\b(?:esc to interrupt|ctrl\+c to interrupt|ctrl\+b to run in background)\b|(?:working|running|thinking)(?:[.…]+)?\s*\(\d+\s*(?:s|sec|m|min)\b/i;

/** Missing captures retain the historic status-only behavior. */
export function hasAgentPrompt(screenText) {
  if (screenText == null || String(screenText).trim() === "") return true;
  const screen = screenLines(screenText);
  const lines = screen.slice(-12);
  if (pendingDialog(screenText) || MID_TURN_SCREEN.test(screen.join("\n"))) return false;
  return lines.some(isPromptLine);
}

/** A harness may report working while its background shell runs at an empty prompt. */
export function hasBackgroundShellAtIdlePrompt(screenText) {
  if (typeof screenText !== "string" || !screenText.trim() || pendingDialog(screenText)) return false;
  const screen = screenLines(screenText);
  const tail = screen.slice(-12).join("\n");
  // The spinner can be many lines above the prompt (todos in between): scan the whole screen.
  if (MID_TURN_SCREEN.test(screen.join("\n"))) return false;
  return /^\s*(?:[│┃|⌸]\s*)?[>❯›](?:\s*[│┃|⛶])?\s*$/m.test(tail)
    && /\b(\d+\s+(background\s+(task|shell|command)s?|shells?|bashes)|background\s+(shell|task|command)|running in the background)\b/i.test(tail);
}

/** The single restart idle rule, including panes that still have background work. */
export function isPaneIdle(get, screenText = null) {
  if (!get || get.state === "finished" || get.status?.state === "blocked" || pendingDialog(screenText)) return false;
  if (["idle", "done"].includes(get.status?.state)) return hasAgentPrompt(screenText);
  return get.status?.state === "working" && hasBackgroundShellAtIdlePrompt(screenText);
}

/**
 * Why a restart of `old` (hc get of the bot's live pane) is refused, or null. `name`: the
 * bot's name; `helpers`: hc get answers of the live terminals whose parent is the old pane.
 * A pane mid-turn would have the turn cut in half; a helper hc ends with its parent
 * (die_with_parent, as a worker is) would end with it. --tree (`tree`) restarts those helpers
 * under the new pane (one mid-turn is waited for before anything starts: the CLI's treeIdle).
 * --force (`force`) overrides all. `onMachine`: the pane is on a linked machine, where --tree is
 * run by the CLI on the machine holding the pane, using its existing local tree restart.
 */
export function restartRefusal({ name, old, helpers = [], force = false, tree = false, onMachine = false, screen = null }) {
  if (force) return null;
  if (old?.status?.state === "working" && !isPaneIdle(old, screen)) {
    return `${name} is working in ${old.address}; restarting now would cut its turn in half. Wait until it is idle, or pass --force.`;
  }
  const doomed = doomedHelpers(helpers);
  if (tree) return null;
  if (doomed.length) {
    const one = doomed.length === 1;
    if (onMachine) {
      return `${old.address} has ${one ? "a helper that ends" : "helpers that end"} with it: ${doomed.map((h) => h.address).join(", ")}. `
        + "Choose Restart with its helpers (--tree runs on their machine), or End helpers and restart (--force).";
    }
    return `${old.address} has ${one ? "a helper that ends" : "helpers that end"} with it: ${doomed.map((h) => h.address).join(", ")}. `
      + `Let ${one ? "it" : "them"} finish, pass --tree to restart ${one ? "it" : "them"} too (resumed, under the new pane), `
      + `or pass --force to end ${one ? "it" : "them"} with the pane.`;
  }
  return null;
}

/**
 * What Restart --tree runs again for one helper that ends with the bot's pane (#213): `get`, its
 * hc get; `worker`, the workers ledger's start row for its terminal (null: not a worker);
 * `session`, its known session id; `agents`, Herdr's table; `agy`: { appHomeDir, bot,
 * realpath, homeDir } when an Antigravity helper's permission list (#823) may be written here
 * (the bot it serves), null when the caller doesn't write one. `realpath` is the caller's
 * `(path) => string` (fs.realpathSync): the helper's folder is resolved to its canonical path
 * first (#884). `homeDir` is the person's home folder, never trusted (#884 Low A). `bot` is the
 * bot a rebuilt worker's command comes from: its automatic mode is the definition's (#946, #955).
 * A worker's command is rebuilt from its row (its task, the last word hc was given, isn't sent
 * twice) unless a template owns it;
 * any other helper's is its own launch command (paneCommand). Codex (#1125): only a template
 * worker (its worker.template label, or its ledger row's template) keeps its command as it is,
 * the owner's template exception, with a warning when it lacks --no-daemon, never with the pack's
 * folders, and refused when it puts a Codex option after its `--` (#1142). Any other Codex
 * helper runs the pack's Codex launch mode: a rebuilt worker or an argv command gets the mode
 * words (its own approval and sandbox words left out, named in `warning`) and an `--add-dir` for
 * each of `grants` (the folders this launch may write, from helperCwd's folder); a shell command
 * that names no approval or sandbox flag of its own (nor an --add-dir `where`, models.js
 * codexWhere, doesn't allow) and provably forwards words to Codex as options (codexCommandCheck
 * `forwards`) gets the mode words it lacks and the grants through "$@"; any other is refused by name.
 * Returns { name, replaced, cwd, labels, agent, template (#1418), session, mode: "resume" | "fresh",
 * resume, argv, agySettings (the file to write first, or null), note, warning }, or
 * { name, replaced, error } when there is nothing to run.
 */
export function helperPlan({ get, worker = null, session = null, agents, fresh = null, agy = null, bot = null, launchAgent = false, grants = [],
  where = null }) {
  const name = typeof get?.name === "string" && get.name ? get.name : null;
  const replaced = get?.address ?? null;
  const cwd = helperCwd({ get, worker, realpath: agy?.realpath });
  const labels = { ...(get?.labels ?? {}) };
  // `launchAgent` (#939, revive: the pane is a bare shell hc kept): its agent by its launch command.
  const agent = agentKeyOfArgv(get?.foreground?.argv, agents) ?? (worker?.agent && agents[worker.agent] ? worker.agent : null)
    ?? (launchAgent ? agentKeyOfArgv(paneCommand(get)?.argv, agents) : null);
  const template = worker?.template ?? labels[WORKER_TEMPLATE_LABEL] ?? get?.template ?? null;
  const isWorker = Boolean(worker || labels[WORKER_OF_LABEL]);
  // #1125: the owner's template exception reaches only a template worker the pack started.
  const templateWorker = isWorker && Boolean(worker?.template || labels[WORKER_TEMPLATE_LABEL]);
  let command = null;
  let warning = null;
  let codexWords = [];
  if (!template && isWorker && agent && agents[agent]?.run?.length) {
    const model = worker?.model ?? labels[WORKER_MODEL_LABEL] ?? null;
    const effort = worker?.effort ?? labels[WORKER_EFFORT_LABEL] ?? null;
    // Its Antigravity mode from the pane's label (a worker writes one only when not auto); an
    // unknown label is refused, never passed to agy.
    const agyMode = labels[WORKER_AGY_MODE_LABEL] ?? null;
    const modeWhy = agent === "antigravity" ? agyModeProblem(agyMode) : null;
    if (modeWhy) return { name, replaced, error: `${name ?? replaced} can't be run again: ${modeWhy}` };
    command = { argv: withCodexGrants([...launchRun(agent, agents[agent].run, { ...bot, hermes: undefined }, where ?? agy?.homeDir ?? null),
      ...agyModeArgs(agent, agyMode), ...modelArgs(agent, model), ...effortArgs(agent, effort)], grants) };
  } else {
    const launch = paneCommand(get);
    const check = launch?.shell !== undefined ? codexCommandCheck(launch.shell, agents, where) : null;
    const who = name ?? replaced;
    if (check && templateWorker) {
      // The owner's exception keeps the template's command as written, never with the pack's
      // folders; one that puts a Codex option after its -- is refused, never run (#1142).
      const refusal = codexTemplateRefusal(template, launch.shell, agents);
      if (refusal) return { name, replaced, error: `${who} can't be run again: ${refusal}` };
      command = launch;
      warning = codexTemplateWarning(template, launch.shell, agents);
    } else if (check) {
      if (check.conflicts.length) return { name, replaced, error: `${who} can't be run again: its command runs Codex with ${check.conflicts.join(", ")}, and a helper that isn't a template worker runs in Codex's launch mode (#1125)` };
      if (!check.forwards || !takesWords(launch.shell)) {
        const why = check.lost.length ? `puts ${check.lost.join(", ")} after its --, where Codex reads them as prompt text`
          : "can't pass the pack's Codex words to Codex as options";
        return { name, replaced, error: `${who} can't be run again: its command runs Codex but ${why} (#1125)` };
      }
      command = launch;
      codexWords = [...check.missing, ...grants.flatMap((d) => ["--add-dir", d])];
    } else if (launch?.shell !== undefined) {
      // #1142: a Codex pane whose shell command runs Codex where the pack can't read it (inside an
      // if, a group, behind exec -a ...) can't be given the launch mode: refused, never run as written.
      // A template worker keeps the owner's exception: its command runs as written.
      if (agent === "codex" && !templateWorker) {
        return { name, replaced, error: `${who} can't be run again: it runs Codex, but its command runs it in a form this pack can't read, `
          + "so it can't be given Codex's launch mode (#1125)" };
      }
      command = launch;
    }
    else if (launch && agent && agentKeyOfArgv(launch.argv, agents) === agent) {
      const own = withoutPrompt(withoutResume(agent, launch.argv));
      if (agent === "codex") {
        const { dropped } = codexClean(own, where ?? agy?.homeDir ?? null);
        if (dropped.length) warning = `${name ?? replaced}'s command named ${dropped.join(", ")}: left out; it runs in Codex's launch mode (#1125).`;
        command = { argv: withCodexGrants(launchRun("codex", own, bot, where ?? agy?.homeDir ?? null), grants) };
      } else command = { argv: own };
    }
  }
  if (!command || !cwd) {
    return { name, replaced, error: `${replaced} can't be run again: hc gave ${cwd ? "no command this pack can reuse" : "no folder"} for it` };
  }
  // A command that a person's own launch gave may carry an older permission file; this one names
  // the file for this launch (or none).
  if (command.shell === undefined) command = { argv: withoutAgySettings(agent, command.argv) };
  let settings = agy?.bot && agent === "antigravity"
    ? agySettingsPlan({ bot: agy.bot, scope: isWorker ? "worker" : "helper",
      role: worker?.role ?? labels[WORKER_ROLE_LABEL] ?? "dev", folder: cwd, settingsDir: agySettingsDir(agy.appHomeDir),
      realpath: agy.realpath ?? null, homeDir: agy.homeDir ?? null })
    : null;
  const settingsWords = agySettingsArgs(agent, settings?.path);
  const id = agent ? sessionFor(agent, session) : null;
  let resume = fresh ? null : agent && canResume(agent) ? resumeArgs(agent, id) : null;
  let note = fresh ?? (resume ? null : agent ? `${agent} has no resume this pack knows` : "its agent isn't one this pack knows");
  let argv = commandArgv(command, [...codexWords, ...settingsWords, ...(resume ?? [])]);
  if (!argv) {
    resume = null;
    note = `its command ends in a separator or a comment, so it can't take resume words${settingsWords.length ? ` or its Antigravity permission list` : ""}`;
    settings = null;
    argv = commandArgv(command);
  }
  // #955: with no permission file (no bot to write one for, or a command that takes no words),
  // an Antigravity helper never runs on skip-permissions.
  argv = agyGuarded(agent, argv);
  return { name, replaced, cwd, labels, agent, template, session: resume && resumesById(agent) ? id : null, mode: resume ? "resume" : "fresh",
    resume: resume ?? [], argv, agySettings: settings, note, warning };
}

/**
 * The folder Restart --tree runs a helper in again (helperPlan's `cwd`): a worker's worktree first
 * (the ledger's), then the pane's folder, then its program's, resolved to its canonical path when
 * the caller gave a realpath (a symlinked folder, #884). Null when none is known.
 */
export function helperCwd({ get, worker = null, realpath = null }) {
  return realPathOf(realpath, worker?.worktree ?? get?.cwd ?? get?.foreground?.cwd ?? null);
}

/**
 * `hc run` arguments for a helper Restart --tree runs again: in the background, its name (null:
 * hc picks), folder and labels, a child of the bot's new pane, its PATH as a seat's (`path`).
 * `login`: a Claude helper's login words (logins.js chooseLogin), before its argv or its `sh -c`.
 */
export function helperArgs({ name, cwd, labels = {}, parent, argv, path = null, login = [] }) {
  const args = ["run", "--bg", "--json"];
  if (name) args.push("--name", name);
  args.push("--cwd", cwd);
  for (const [k, v] of Object.entries(labels)) if (typeof v === "string" && v) args.push("--label", `${k}=${v}`);
  const env = envWords(path ? [`PATH=${path}`] : [], login);
  return [...args, "--parent", parent, "--", ...(env.length ? [ENV, ...env] : []), ...argv];
}

/**
 * The restarts --tree would make that may pick up each other's conversation: a resume by its
 * folder's latest (no session id: codex resume --last, --continue) of an agent another of
 * `runs` also runs in that folder. `runs`: [{ who, agent, cwd, session, mode }], the bot's
 * first. Returns [{ agent, cwd, who: [every run there], idless: [the id-less resumes] }].
 */
export function sharedFolders(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (!r.agent || !r.cwd) continue;
    const k = `${r.agent}\u0000${r.cwd}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].filter((g) => g.length > 1)
    .map((g) => ({ agent: g[0].agent, cwd: g[0].cwd, who: g.map((r) => r.who), idless: g.filter((r) => r.mode === "resume" && !r.session).map((r) => r.who) }))
    .filter((g) => g.idless.length);
}

/** The session ids more than one of `runs` ({ who, session }) would resume: [{ session, who: [...] }]. */
export function sameSessions(runs) {
  const by = new Map();
  for (const r of runs) if (r.session) by.set(r.session, [...(by.get(r.session) ?? []), r.who]);
  return [...by].filter(([, who]) => who.length > 1).map(([session, who]) => ({ session, who }));
}

/**
 * The labels the replacement carries beyond paneLabels: a squad on the old pane (anyone's,
 * not only one this pack copied) and its mark, so the restart moves the pane, not its squad.
 */
export function carriedLabels(old) {
  const have = old?.labels ?? {};
  const out = {};
  if (have[SQUAD_LABEL]) out[SQUAD_LABEL] = have[SQUAD_LABEL];
  if (have[SQUAD_MARK]) out[SQUAD_MARK] = have[SQUAD_MARK];
  return out;
}

/** What a session id is shown as in any output (RFC 0021: session ids stay in the machine's ledgers). */
export const SESSION_MASK = "***";
/** `words` with every occurrence of session id `id` shown as SESSION_MASK (no id: as they are). */
export const maskSession = (words, id) => (typeof id === "string" && id ? words.map((w) => String(w).split(id).join(SESSION_MASK)) : [...words]);
/**
 * `argv` as output shows it: the value after --session-id (or in --session-id=<id>), and `id`
 * wherever it appears (a resumed session), as SESSION_MASK.
 */
export function maskedArgv(argv, id = null) {
  if (!Array.isArray(argv)) return argv ?? null;
  const out = maskSession(argv, id);
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === "--session-id" && i + 1 < out.length) out[i + 1] = SESSION_MASK;
    else if (String(out[i]).startsWith("--session-id=")) out[i] = `--session-id=${SESSION_MASK}`;
  }
  return out;
}

/** One line for the owner: what the replacement does with the conversation. The session id itself is never shown. */
export function planText(plan, session) {
  if (plan.canonicalBot) return "resuming its paired Hermes Bot Chat (exact profile and title)";
  if (plan.mode === "swap") return `on ${plan.agent}${plan.model ? ` (${plan.model})` : ""}, a new conversation`;
  if (plan.mode === "fresh") return plan.note ? `a new conversation (${plan.note})` : "a new conversation";
  if (plan.agent === "claude") return session ? "resuming its session by id" : "resuming the latest conversation in its folder (--continue)";
  return session ? `resuming its session by id (${maskSession(plan.resume, session).join(" ")})` : `resuming its last conversation (${plan.resume.join(" ")})`;
}

// ---- the sidebar's Restart: the CLI, as launch.js runCli runs it ----

/**
 * The CLI arguments the sidebar's Restart passes to launch.js runCli (which adds --json and
 * this app home): `agent`: Restart on… (a swap); `force`: past a working pane or its helpers;
 * `fresh`: a new conversation.
 */
export function restartArgs({ botId, projectKey, agent = null, force = false, fresh = false, tree = false, machine = null }) {
  return ["restart", botId, "--project", projectKey, ...(machine ? ["--machine", machine] : []),
    ...(agent ? ["--agent", agent] : []), ...(force ? ["--force"] : []), ...(fresh ? ["--fresh"] : []), ...(tree ? ["--tree"] : [])];
}

/**
 * What runCli's answer ({ code, out, err }) to restartArgs means: { terminal, replaced,
 * warnings } on success, else { refused, forceable, freshable } (the refusal is one --force
 * overrides, or one a new conversation, --fresh, avoids).
 */
export function restartAnswer(r) {
  if (r?.out?.refused === "helpers" || (r?.code !== 0 && /has (?:a helper that ends|helpers that end) with it:/.test(r?.err ?? ""))) {
    return { refused: "Its helpers would end with it; choose whether to restart them or end them.", helpers: true, forceable: false, freshable: false };
  }
  if (r?.code === 0 && r.out?.queued) return { terminal: r.out.terminal, replaced: null, queued: true,
    reason: r.out.reason ?? null, dialog: r.out.dialog ?? null, warnings: [] };
  // A tree restart can replace the lead and then fail to bring back a helper. Do not
  // offer to restart the lead again: show exactly which helper needs attention.
  if (r?.out?.terminal && !r.out.error && (r.code === 0 || Array.isArray(r.out.helpers))) {
    const warnings = [...(Array.isArray(r.out.warnings) ? r.out.warnings : [])];
    for (const helper of r.out.helpers ?? []) if (helper.error) {
      warnings.push(actionError(`${helper.name ?? helper.replaced}: ${helper.error}`, "Helper restart"));
    }
    return { terminal: r.out.terminal, replaced: r.out.replaced ?? null, warnings };
  }
  if (r?.code === 0 && r.out?.running) return { refused: `It is already running in ${r.out.running}.`, forceable: false, freshable: false };
  // Not run, or ended by Herdr (launch.js machineCli, #444): neither --force nor --fresh is the answer.
  if (r?.asIs) return { refused: actionError(r.err, "Restart"), forceable: false, freshable: false };
  // The CLI's refusal is its last stderr line (warnings come before it).
  const raw = String(r?.err ?? "");
  return { refused: actionError(raw, "Restart"), forceable: /pass --force/.test(raw), freshable: /--fresh\b/.test(raw) };
}

// ---- Claude Code's rate-limit dialog (#1557): detect it in the pane tail, never answer it ----

/**
 * A limit statement a Claude Code seat shows when its account is out of usage. Deliberately
 * narrow: a mid-turn retry line ("rate limited, retrying in 30s") is a condition, not the
 * dialog the owner must answer.
 */
const RATE_LIMIT_CUE = /\b(?:rate[\s-]?limit(?:ed)?|usage limit|limit reached|reached (?:your|the) (?:usage\s+|rate\s+)?limit|hit (?:your|the) (?:usage\s+|rate\s+)?limit|out of usage|quota (?:reached|exhausted|exceeded))\b/i;
/** The dialog's reset or retry words: what makes the cue a wait, not a passing error line. */
const RATE_LIMIT_RESET_WORDS = /\b(?:resets?|reset at|try again|available again|unlimited again|wait until|comes back|continue in)\b/i;
/**
 * One of the dialog's numbered options, with its selection cursor when the line carries one.
 * The cursor is the dialog's own shape: a markdown list is numbered too, so the numbers alone
 * are never enough (the review's false positive was an ordinary report with a 1./2./3. list).
 */
const RATE_LIMIT_OPTION = /^[\s│┃|]*([❯›])?\s*(\d+)[.)]\s+(\S.*)$/;
const RATE_LIMIT_FOOTER = /\b(?:press enter|enter to (?:confirm|continue|select)|esc to (?:cancel|close|exit)|↑↓|up\/down to|select an option|choose an option)\b/i;
/** A fenced code block, a patch hunk or a `>` quote: text a person is reading, not a modal. */
const RATE_LIMIT_FENCE = /^\s*(?:```|~~~)/;
const RATE_LIMIT_PATCH = /^\s*(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|(?:\+\+\+|---) [ab]\/)/;
const RATE_LIMIT_QUOTE = /^\s*>\s/;

/** The visible tail's lines, ANSI-free, blank lines kept (a dialog's blank lines are its shape). */
const tailLines = (text, keep = 40) => typeof text === "string"
  ? text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").slice(-keep) : [];

const DURATION_UNITS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000 };

/** A "2 hours 10 minutes" / "5m" duration in milliseconds, or null. */
export function durationMs(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let total = 0, found = false;
  for (const m of text.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi)) {
    const unit = DURATION_UNITS[m[2].toLowerCase()];
    if (!unit) continue;
    total += Number(m[1]) * unit;
    found = true;
  }
  return found ? total : null;
}

/**
 * A clock time in a dialog's words as the next local instant, or null: `3:00 PM`, `15:00`, `5pm`.
 * `dayOffset` is the day the dialog itself names (`tomorrow` 1, `today` 0): it is applied even
 * when the clock time would still be ahead today, so "tomorrow at 9:00" never lands today.
 */
function clockTime(segment, now, { dayOffset = null } = {}) {
  const m = /(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s|$|\()/i.exec(segment);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? null : Number(m[2]);
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");
  if (minute === null && !meridiem) return null; // "resets at 5" is not a time to guess
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (minute !== null && (minute > 59 || hour > 23)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, minute ?? 0, 0, 0);
  if (dayOffset !== null) at.setDate(at.getDate() + dayOffset);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * The reset instant a rate-limit dialog names, as an ISO string, or null when it names none.
 * Understood, in this order: an ISO 8601 timestamp; a duration after "resets/try again/… in";
 * a clock time after "resets/try again/… at"; a clock time with a meridiem anywhere in the
 * reset sentence; "tomorrow"/"today"/"tonight" choose the day a clock time lands on. A past
 * ISO timestamp proves nothing about the next reset, so it is unknown (null): it must never
 * wake a restart immediately. Nothing is guessed: a bare number, a date without a time or a
 * duration with no unit leaves it null (the caller omits the time, and the wake with it).
 */
export function resetTimeFrom(text, now = Date.now()) {
  const tail = tailLines(text, 40).join("\n");
  const sentinel = /\b(?:resets?|reset at|try again|available again|unlimited again|comes back|continue in)\b/i;
  // 1. An explicit timestamp is unambiguous, unless it is already past: then it is unknown,
  // never a reset that fires a restart now.
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(tail);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return t > now ? new Date(t).toISOString() : null;
  }
  // 2. A duration: "resets in 2 hours 10 minutes", "try again in 5m".
  const duration = /(?:resets?|reset at|try again|available again|unlimited again|comes back|continue)[^.\n]{0,40}?\bin\s+([^.();\n]{1,60})/i.exec(tail);
  if (duration) {
    const ms = durationMs(duration[1]);
    if (ms !== null && ms > 0) return new Date(now + ms).toISOString();
  }
  // 3. A clock time in the same line as the reset words, on the day the line names.
  for (const line of tailLines(text, 40)) {
    if (!sentinel.test(line)) continue;
    const dayOffset = /\btomorrow\b/i.test(line) ? 1 : /\b(?:today|tonight)\b/i.test(line) ? 0 : null;
    const after = /(?:resets?|reset at|try again|available again|unlimited again|comes back)\b[^.\n]{0,30}?\bat\s+([^.\n]{1,40})/i.exec(line);
    const segment = after ? after[1] : line;
    const at = clockTime(segment, now, { dayOffset });
    if (at) return at.toISOString();
  }
  return null;
}

/**
 * The rate-limit dialog a Claude Code pane is blocked on, from its tail (`hc read`'s text,
 * ANSI allowed), or null. The test is the dialog's own shape, never a word search: a run of at
 * least two consecutive numbered options must end the visible tail (only a footer may follow),
 * the options must start at 1 and be consecutive, one of them must carry the selection cursor
 * (`❯`/`›`), and the limit cue must be the dialog's own line: one of the three non-empty lines
 * directly above the choices (the modal's limit line and its reset line), with no other prose
 * between it and them. A limit sentence in a report or in scrollback ten lines up is therefore
 * not a cue. A permission/selection question is rejected explicitly with pendingDialog()'s own
 * evidence; the footer both Claude Code dialogs may show is not a question, so the options/limit
 * shape decides it. A quoted, fenced or patched transcript is not the live dialog, and a patch
 * stays text however far its hunk header sits above the dialog. `resets_at` is the dialog's own
 * ISO time when it shows one, absent when it shows none (never guessed). Detection is read-only:
 * nothing here types into the pane or answers the dialog.
 */
export function rateLimitDialog(screenText, now = Date.now()) {
  if (typeof screenText !== "string" || !screenText.trim()) return null;
  // A screen with a prompt, confirmation or permission question is the owner's dialog: the
  // limit rule must never label it rate-limited (the cue may belong to a sentence above it).
  // The one shared case is the footer both Claude Code dialogs show: it is only a footer, so
  // the options/limit shape below decides. A permission question or choice still wins here.
  const pending = pendingDialog(screenText);
  if (pending && !pending.footer) return null;
  const lines = tailLines(screenText, 40);
  const visible = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.trim() !== "");
  // The options end the dialog: after them only a footer (never prose, never an idle prompt).
  let last = visible.length - 1;
  while (last >= 0 && RATE_LIMIT_FOOTER.test(visible[last].line)) last -= 1;
  if (last < 0 || !RATE_LIMIT_OPTION.test(visible[last].line)) return null;
  let first = last;
  while (first > 0 && RATE_LIMIT_OPTION.test(visible[first - 1].line)) first -= 1;
  const block = visible.slice(first, last + 1);
  if (block.length < 2) return null;
  const numbered = block.map(({ line }) => RATE_LIMIT_OPTION.exec(line));
  // The dialog numbers its choices from 1, in order: a numbered section of a report does not
  // have to, and never carries the cursor below.
  if (numbered[0][2] !== "1" || numbered.some((m, i) => Number(m[2]) !== i + 1)) return null;
  if (!numbered.some((m) => m[1])) return null;
  // The limit statement belongs to this dialog, not to scrollback or a report above the options:
  // it has to be one of the three non-empty lines directly above the choices (the modal's own
  // limit/reset header). A sentence ten lines up is not the dialog's line.
  let cueAt = -1;
  for (let i = first - 1, seen = 0; i >= 0 && seen < 3; i -= 1, seen += 1) {
    if (RATE_LIMIT_CUE.test(visible[i].line)) { cueAt = i; break; }
  }
  if (cueAt < 0) return null;
  // Only the dialog's own limit/reset words may sit between the cue and the choices. A report's
  // "Findings:" or a permission question there means the cue belongs to something else.
  for (let i = cueAt + 1; i < first; i += 1) {
    if (!RATE_LIMIT_CUE.test(visible[i].line) && !RATE_LIMIT_RESET_WORDS.test(visible[i].line)) return null;
  }
  // A quote or a pasted transcript is text, not the modal: the block must not sit inside an
  // open fenced code block, and no unified-diff marker may sit anywhere in the visible tail.
  // The marker's distance from the cue never decides: a hunk header can be many context lines
  // above the dialog, so the whole visible tail is scanned.
  if (visible.slice(0, last + 1).filter(({ line }) => RATE_LIMIT_FENCE.test(line)).length % 2 === 1) return null;
  for (let i = 0; i <= last; i += 1) if (RATE_LIMIT_PATCH.test(visible[i].line)) return null;
  // A `>` quote is adjacent evidence: the cue is at most three visible lines above the choices,
  // so a window above it covers every quoted form this rule can see.
  for (let i = Math.max(0, cueAt - 5); i <= last; i += 1) if (RATE_LIMIT_QUOTE.test(visible[i].line)) return null;
  const dialog = visible.slice(cueAt, last + 1).map(({ line }) => line);
  if (!dialog.some((line) => RATE_LIMIT_RESET_WORDS.test(line))) return null;
  const question = visible[cueAt].line.trim().replace(/\s+/g, " ").slice(0, 200);
  const resetsAt = resetTimeFrom(dialog.join("\n"), now);
  return { question, ...(resetsAt ? { resets_at: resetsAt } : {}) };
}

/** An ISO instant in the person's own clock as "YYYY-MM-DD HH:MM", or an empty string when it is not one. */
const localMinute = (iso) => {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/** `<bot> is rate-limited until <time>; <outcome>`, or without the time when the dialog names none. */
export function rateLimitLine(botName, { outcome = "parked", resetsAt = null } = {}) {
  const at = resetsAt ? localMinute(resetsAt) : "";
  return `${botName} is rate-limited${at ? ` until ${at}` : ""}; ${outcome}`;
}

/** How long a parked entry still has to wait (ms): 0 when `wakeAt` is due or absent, never negative. */
export function wakeWait(wakeAt, now = Date.now()) {
  if (typeof wakeAt !== "string" || !wakeAt) return 0;
  const at = Date.parse(wakeAt);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}
