# Meter status line

Automagik Meter's Claude Code status line, and the limits logger it runs behind. Both are local
tools: no release ships them (`scripts/lane.ts`, `NEVER_SHIPPED`).

```
🤖 Meter Captain  🧠 Opus 5.5 ⚡high  ┃  📁 my-app  ┃  💬 ▰▰▰▰▱▱▱▱▱▱ 400k/1M  ┃  Quota 5h ▰▰▰▰▰ 94%  Left 16m  Resets 59m  ┃  Quota 7d ▰▰▱▱▱ 31%  Resets 4d2h
```

Each segment is left out when its field is missing. Separators and labels are dim; green under
70%, yellow from 70%, red from 90%. `NO_COLOR` turns colour off. Narrower than one line
(`COLUMNS`, which Claude Code sets), the quota moves to a second line.

- `🤖`: the bot this Herdr pane plays, only in a Herdr pane (`HC_TERMINAL_ID` set):
  `am whois --json <terminal>`, run as `/bin/sh ~/.local/bin/automagik-herdr`, the alias file for `am` (the
  launcher finds its own node, so a bare PATH is fine), then the bot's name in
  `<project>/.herdr/bots.json`. whois gets 1.5 s, then SIGKILL; the answer, a miss included, is
  cached 10 minutes per terminal in the Meter state folder (`statusline-bots.json`). Only expired
  entries are dropped, so every live pane keeps its own (past 512 live terminals, the oldest go).
- `🧠` and `⚡`: the model and `effort.level`
  ([statusline](https://code.claude.com/docs/en/statusline)); Claude Code sends no effort when the
  model has no effort setting, and then no effort word is shown.
- `📁`: the folder the session is in.
- `💬`: a 10-cell bar of the context window used, then the tokens used and the window size.
  The bar fills against the context window; its colour is measured against the auto-compact
  window, found where Claude Code takes it
  ([model-config](https://code.claude.com/docs/en/model-config), "Set the auto-compact window"),
  first match winning:
  1. `DISABLE_AUTO_COMPACT` or `DISABLE_COMPACT` set, or `autoCompactEnabled: false` in the
     highest settings file naming it: auto-compact is off.
  2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, when it is a usable size (`200000`, `200k`, `1M`; held to
     100k-1M as Claude Code holds it). An unusable value is ignored, as Claude Code ignores it.
  3. The first of the project's `.claude/settings.local.json`, its `.claude/settings.json` and the
     user `settings.json` (`CLAUDE_CONFIG_DIR` or `~/.claude`) that names a window:
     `modelSettings["<model id>"].autoCompactWindow`, else the top-level `autoCompactWindow` of that
     file. `"auto"` (the model's tuned window) or anything not a number: no window.

  With no window (off, `"auto"`, or none set) the colour is measured against the context window;
  no default is guessed. The window is capped at the context window, as Claude Code caps it. A
  one-launch `--autocompact` flag and managed settings are invisible to a status line.
- `Quota 5h` / `Quota 7d`: a 5-cell bar and the `rate_limits` used %, then `Resets`, the time until
  the window resets. Claude Code drops a window once it resets, and sends none before the
  session's first reply.
- `Left`, in red: when the window runs out at the current rate, shown only when that comes before
  the reset. The rate comes from the limits log's readings of the same window (same `resets_at`);
  only the log's last 256 KiB is read. Each session logs the value it last saw, so a resumed
  session logs a stale lower one with a fresh time, and sessions side by side alternate between
  neighbouring values. Used % never falls within a window, so the used % at a time is the highest
  reading up to it. The rate is the rise over the time the log covers in the lookback (1 h for 5h,
  6 h for 7d): only spans between consecutive readings at most 15 minutes apart (the logger
  writes at least every 5 minutes while a session runs). A longer span is idle and counts neither
  its time nor a rise across it, and the first 5 minutes after it are left out too (a resumed
  session's stale first reading lands there). Under 15 minutes or a quarter of the lookback
  covered (15 minutes for 5h, 90 for 7d), or a measured rise of nothing, shows no `Left`. With no reading of the window in the lookback at all, the rate is the
  used % over the time since the window started.

| File | What it is |
| - | - |
| `automagik-statusline.mjs` | The status line: stdin JSON in, one line out. Node, no dependencies, never throws. |
| `claude-limits-statusline.mjs` | The limits logger (imported from the copy the owner ran; since #313 it runs the command's argv directly, no second shell): appends `rate_limits` readings to `claude-limits.jsonl`, then runs the command after `--` with the same stdin. |

## State folder

Both use the meter's own state folder, by usagemeter's rule: `METER_STATE_DIR` when set, else
`<AM_HOME>/meter` when `AM_HOME` is an absolute path, else `~/.automagik/meter`. It holds
`claude-limits.jsonl`, `claude-limits.last.json` and the bot cache `statusline-bots.json`.

Before usagemeter moved its store (RFC 0017), the folder was `~/Library/Application
Support/automagik` on macOS and `$XDG_STATE_HOME/automagik` (else `~/.local/state/automagik`)
elsewhere. Without `METER_STATE_DIR`:

- The status line reads a `claude-limits.jsonl` still left in the old folder as well, so no reading
  is lost at the move.
- The logger moves its two files out of the old folder once, on its next reading, when the new
  folder has none: a hard link, then the old name removed, never over a file already there (the
  meter's own rule). The meter's first sync moves the same two files; whichever runs first moves
  them, and nothing of the logger's is left for the other. A move cut short after the link (both
  names on one file) is read once and finished by the next reading.
- When the link cannot be made (the old folder on another filesystem), the logger keeps writing
  the old folder and starts no log in the new one. The meter's first sync then moves both files
  with its own verified copy, finds nothing left to warn about, and the logger follows them. No
  step by hand is needed.
- The logger keeps the new folder at 0700, as the meter does: one already there with a looser mode
  is tightened. The old folder's mode is never changed (on macOS it is the desktop app's data
  folder too).
- Nothing else in the old folder is touched: the store is the meter's to move. The old bot cache is
  left there; the status line builds a new one.

## Install

Claude Code runs the command with a minimal PATH, so name node by an absolute path. On a host
where node lives under nvm, a stable symlink (`~/.local/bin/node`) keeps the line working across
upgrades of the symlink's target.

```sh
install -m 755 meter/statusline/automagik-statusline.mjs meter/statusline/claude-limits-statusline.mjs ~/.local/bin/
```

```json
"statusLine": {
  "type": "command",
  "command": "/ABSOLUTE/node ~/.local/bin/claude-limits-statusline.mjs -- /ABSOLUTE/node ~/.local/bin/automagik-statusline.mjs"
}
```

Without the logger: `"/ABSOLUTE/node ~/.local/bin/automagik-statusline.mjs"`.

## Test

```sh
node --test 'meter/statusline/test/*.test.mjs'
```
