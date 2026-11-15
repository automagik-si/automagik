// Restart over plain data: what a bot's replacement pane runs (resume the conversation, a
// fresh one, or a swap to another agent or model), why a restart is refused, and the labels
// the replacement carries over from the old pane. The CLI's `restart` runs it with hc; the
// sidebar's Restart runs the CLI. Pure: no `herdr`, so `node --test` runs it. Apache-2.0.

import { agentKeyOfArgv, agyGuarded, agyModeArgs, agyModeProblem, agySettingsArgs, agySettingsDir, agySettingsPlan, canResume, codexClean, effortArgs, launchRun,
  modelArgs, ownsSession, resumeArgs, resumesById, sessionIdArgs, withCodexGrants, withoutAgySettings, withoutBriefing, withoutResume } from "./models.js";
import { SQUAD_LABEL, SQUAD_MARK } from "./launchArgs.js";
import { ENV, WORKER_AGY_MODE_LABEL, WORKER_EFFORT_LABEL, WORKER_MODEL_LABEL, WORKER_OF_LABEL, WORKER_ROLE_LABEL, WORKER_TEMPLATE_LABEL, codexCommandCheck,
  codexTemplateRefusal, codexTemplateWarning, templateAgent } from "./workers.js";
import { CONFIG_VAR, envWords } from "./logins.js";
import { hermesPairRun } from "./hermesPair.js";
import { actionError } from "./actionError.js";

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
  // The source a pane's launch is compared with names no settings file: that one is this
  // launch's own, never a change a restart should report.
  const source = [...run, ...modeWords, ...modelArgs(key, pin)];
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
    if (!tpl) return { mode, agent: key, model: pin, resume: extra, argv: [...run, ...modeWords, ...settingsWords, ...extra, ...modelArgs(key, pin)],
      source, template: null, agySettings: settings, note, templateNote, granted: false };
    const words = [...codexWords, ...settingsWords, ...extra];
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

// Only the visible tail matters: old scrollback is not a current prompt or dialog.
const screenLines = (text) => typeof text === "string" ? text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").slice(-40) : [];

/** A turn still running: its spinner or interrupt hint, never an idle prompt. */
const MID_TURN_SCREEN = /\b(?:esc to interrupt|ctrl\+c to interrupt|ctrl\+b to run in background)\b|(?:working|running|thinking)(?:[.…]+)?\s*\(\d+\s*(?:s|sec|m|min)\b/i;

const CONFIRM_FOOTER = /\[y\/n\]|\(y\/n\)|enter to confirm|esc to cancel/i;
const NUMBERED_DIALOG_CHOICE = /^\s*(?:[>❯›]\s*\d+[.)]\s+|\d+[.)]\s+(?:yes\b|no\b|allow\b|deny\b|proceed\b|cancel\b|skip\b))/i;
const DIALOG_HEADER = /\?|^\s*(?:choose|select|pick|allow|run|do you|would you|are you sure)\b/i;
const DIALOG_QUESTION = /(?:run this command\?|do you want to (?:proceed|make this edit|create|delete|run|execute|allow|overwrite)\b.*\?|would you like to run the following command\?|do you trust the contents of\b.*\?|requesting permission for:|^\s*allow\s+[^\n?]+\?|\d+\/\d+ answered.*(?:select|confirm))/i;

/** A prompt glyph, unboxed or inside a frame: `> `, `│ > │`, `⌸ ❯ … ⛶`, `› Ask …`, omp's `╰─`. */
export function isPromptLine(line) {
  if (typeof line !== "string" || NUMBERED_DIALOG_CHOICE.test(line) || CONFIRM_FOOTER.test(line)) return false;
  if (/^\s*╰─(?!─)/.test(line)) return true;
  const bare = line.replace(/^[\s│┃|⌸]+|[\s│┃|⛶]+$/g, "");
  if (/^(?:[>❯›$%](?:\s.*)?|.*[>❯›$%])$/.test(bare)) return true;
  return /^\s*[│┃|⌸].*[│┃|⛶]\s*$/.test(line)
    && (/[>❯›$%]/.test(line) || /\b(?:ask|type|enter|message|prompt|try)\b/i.test(line));
}

/** A visible permission or selection dialog belongs to the owner, never Herdr. */
export function pendingDialog(screenText) {
  const lines = screenLines(screenText).slice(-15).filter((line) => line.trim() !== "");
  const isDialogLine = (line) => DIALOG_QUESTION.test(line) || CONFIRM_FOOTER.test(line) || NUMBERED_DIALOG_CHOICE.test(line);
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (isPromptLine(lines[i])) { p = i; break; }
  // A prompt with only footer lines below it is idle: reply text above it is scrollback, not a
  // live dialog (a real dialog hides the input line or sits below scrollback prompts).
  if (p >= 0 && lines.length - 1 - p <= 5 && !lines.slice(p + 1).some(isDialogLine)) return null;
  // No prompt at the bottom: scan the visible tail (a prompt there made this scrollback).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (DIALOG_QUESTION.test(lines[i])) return { question: lines[i].trim().slice(0, 200), who: "the owner" };
    if (!isDialogLine(lines[i])) continue;
    // A choice belongs to a dialog only with no idle prompt below it (we would have returned).
    for (let j = i - 1, seen = 0; j >= 0 && seen < 6; j -= 1) {
      if (lines[j].trim() === "") continue;
      seen += 1;
      if (DIALOG_HEADER.test(lines[j])) return { question: lines[j].trim().slice(0, 200), who: "the owner" };
    }
    if (CONFIRM_FOOTER.test(lines[i])) return { question: lines[i].trim().slice(0, 200), who: "the owner" };
  }
  return null;
}

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
 * `forwards`) gets the mode words it lacks and the grants through "$@"; any other is refused by name. Returns { name, replaced, cwd,
 * labels, agent, session, mode: "resume" | "fresh", resume, argv, agySettings (the file to write
 * first, or null), note, warning }, or { name, replaced, error } when there is nothing to run.
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
  return { name, replaced, cwd, labels, agent, session: resume && resumesById(agent) ? id : null, mode: resume ? "resume" : "fresh",
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
