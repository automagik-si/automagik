// The agents' default-model config files on a linked machine (#2097): read there through
// herdr-core's exec, never from this computer's home, so a bot's card shows the default of the
// machine its pane runs on. Pure: the script and its parser; launch.js runs it, main.js keeps
// the answer per machine. Apache-2.0.

// One shell line there: each file under $HOME framed by a header line, then an end line so a
// cut-short answer is told from a whole one. A file past 64 KiB is cut (a config is far smaller).
export const MODEL_FILES = {
  claudeSettings: ".claude/settings.json",
  codexConfig: ".codex/config.toml",
  antigravitySettings: ".gemini/antigravity-cli/settings.json",
};
export const MODEL_PROBE = `for p in ${Object.entries(MODEL_FILES).map(([k, v]) => `${k}:${v}`).join(" ")}; do n=\${p%%:*}; f="$HOME/\${p#*:}"; `
  + `if [ -f "$f" ] && [ -r "$f" ]; then printf '@@am-model %s ok\\n' "$n"; head -c 65536 -- "$f"; printf '\\n'; `
  + `else printf '@@am-model %s none\\n' "$n"; fi; done; printf '@@am-model end ok\\n'`;

/**
 * The texts MODEL_PROBE printed: { claudeSettings, codexConfig, antigravitySettings } (a text,
 * or null for a file not there). Null when the run failed or its answer is not whole: the
 * machine's defaults are then unknown, and a row shows no model.
 */
export function parseModelProbe(r) {
  if (!r || r.code !== 0 || typeof r.stdout !== "string") return null;
  const out = {};
  let name = null, lines = [], ended = false;
  const close = () => { if (name) out[name] = lines === null ? null : lines.join("\n"); };
  for (const line of r.stdout.split("\n")) {
    const m = /^@@am-model (\w+) (ok|none)$/.exec(line);
    if (m) {
      close();
      if (m[1] === "end") { ended = true; name = null; break; }
      if (!Object.hasOwn(MODEL_FILES, m[1])) return null;
      name = m[1]; lines = m[2] === "ok" ? [] : null;
    } else if (name && lines) lines.push(line);
  }
  if (!ended) return null;
  return Object.fromEntries(Object.keys(MODEL_FILES).map((k) => [k, out[k] ?? null]));
}
