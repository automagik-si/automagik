// The agents' default models on a linked machine (#2097): read there through herdr-core's exec,
// never from this computer's home, so a bot's card shows the default of the machine its pane
// runs on. Pure: the script, its parser and when to run it; launch.js runs it, main.js keeps the
// answer per machine. Apache-2.0.

import { defaultModelFrom } from "./models.js";
import { modelAgent } from "./rows.js";

// The files models.js defaultModelFrom reads, under the machine's own $HOME.
export const MODEL_FILES = {
  claude: ".claude/settings.json",
  codex: ".codex/config.toml",
  antigravity: ".gemini/antigravity-cli/settings.json",
};

// The top-level "model" of a JSON file, found there so only that value crosses the link (the
// rest of the file never leaves the machine): a scanner that skips strings and counts depth, and
// prints the last top-level "model" whose value is a string, as its JSON literal. A file past
// 64 KiB is cut first (a config is far smaller).
const JSON_MODEL = String.raw`{ n = length($0); i = 1
while (i <= n) { c = substr($0, i, 1)
if (c == "\"") { j = i + 1
while (j <= n) { d = substr($0, j, 1); if (d == "\\") j += 2; else if (d == "\"") break; else j++ }
t = substr($0, i, j - i + 1); i = j + 1
if (depth == 1) { if (prev == ":" && key == "\"model\"") found = t; last = t; prev = "s" }
continue }
if (c == "{" || c == "[") { if (depth == 1) prev = "v"; depth++ }
else if (c == "}" || c == "]") { depth--; if (depth == 1) prev = "v" }
else if (depth == 1 && c == ":") { key = (prev == "s") ? last : ""; if (key == "\"model\"") found = ""; prev = ":" }
else if (depth == 1 && c !~ /[ \t\r]/) prev = c
i++ } }
END { if (found != "") print p found }`;

// The top-level `model = …` lines of a TOML file (before the first [table]), and nothing else.
const TOML_MODEL = String.raw`/^[ \t]*\[/ { exit } /^[ \t]*model[ \t]*=/ { print p $0 }`;

// One shell line there: each agent's model as one `@@am-model <agent> <value>` line (none when
// the file or key is missing), then an end line so a cut-short answer is told from a whole one.
const fileOf = (agent) => `"$HOME/${MODEL_FILES[agent]}"`;
const probeOf = (agent, prog) =>
  `f=${fileOf(agent)}; if [ -f "$f" ] && [ -r "$f" ]; then head -c 65536 -- "$f" | awk -v p='@@am-model ${agent} ' '${prog}'; fi; `;
export const MODEL_PROBE = probeOf("claude", JSON_MODEL) + probeOf("codex", TOML_MODEL)
  + probeOf("antigravity", JSON_MODEL) + `printf '@@am-model end\\n'`;

/**
 * The defaults MODEL_PROBE printed, as rows.js modelDefaultsFrom's: { claude, codex, antigravity }
 * (a model, or null where none). Null when the run failed or its answer is not whole: the
 * machine's defaults are then unknown, and a row shows no model. The values go through
 * models.js defaultModelFrom, so a remote default is held to the same rules as a local one.
 */
export function parseModelProbe(r) {
  if (!r || r.code !== 0 || typeof r.stdout !== "string") return null;
  const got = { claude: [], codex: [], antigravity: [] };
  let ended = false;
  for (const line of r.stdout.split("\n")) {
    if (line === "") continue;
    if (line === "@@am-model end") { ended = true; break; }
    const m = /^@@am-model (claude|codex|antigravity) (.*)$/.exec(line);
    if (!m) return null;
    got[m[1]].push(m[2]);
  }
  if (!ended) return null;
  const json = (lines) => (lines.length ? `{"model":${lines.at(-1)}}` : null);
  return {
    claude: defaultModelFrom("claude", { claudeSettings: json(got.claude) }),
    codex: defaultModelFrom("codex", { codexConfig: got.codex.join("\n") }),
    antigravity: defaultModelFrom("antigravity", { antigravitySettings: json(got.antigravity) }),
  };
}

// How often a connected machine is read again while nothing else asks: its defaults change only
// when someone picks another model there. A machine that connects, or first gets a bot with a
// file default, is read at once (dueRemoteProbes).
export const REMOTE_MODEL_EVERY_MS = 60_000;

/**
 * The linked machines whose defaults a row may show: connected, with a project (not drawn from
 * an earlier run while away) holding a bot of an agent with a file default.
 */
export function remoteModelMachines(bots = [], machines = []) {
  const want = new Set();
  for (const q of bots ?? []) {
    if (!q.machine || q.stale || !(q.file?.bots ?? []).some((b) => modelAgent(b.agent))) continue;
    if ((machines ?? []).some((m) => m.name === q.machine && m.state === "connected")) want.add(q.machine);
  }
  return want;
}

/**
 * The machines of `want` to read now: one never read since it joined `want` (no entry in
 * `lastAt`), or last read `every` ms ago or more (or at a time past `now`: the clock moved back).
 */
export function dueRemoteProbes(want, lastAt, now, every = REMOTE_MODEL_EVERY_MS) {
  return [...want].filter((m) => {
    const at = lastAt.get(m);
    return at === undefined || now < at || now - at >= every;
  });
}
