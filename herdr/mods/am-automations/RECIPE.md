# am-automations

Scheduled agent prompts, as a side panel: a prompt, a cron line and a repo — every weekday at 09:00
an agent starts in a fresh worktree and works. The panel is where you find what ran while you were
away, start one now, pause them all, or write a new one with its next runs previewed. An automation
may also be a plain command the scheduler runs itself, with no agent and no model (#938). It needs
the `herdr-automations` scheduler, a separate program: `install.sh` installs the build this mod
pins (#220); the pack's own updater does not.

**It ships switched off**, footer tab included (#220): a fresh install puts it in
`<app home>/mods-disabled/am-automations`, where Herdr does not load it. To turn it on, open the
**Mods** panel, find *Automagik Automations* and switch it on; the footer's **Automations** tab then
appears. Without the scheduler the panel says what is missing and shows the command that installs
it (the pinned release, hash-checked, into `~/.local/bin`), with **Copy** and **Install**; only a
click on Install runs it. An
install that already has the mod keeps its state through updates, on or off (`OFF_BY_DEFAULT` in
`am-sidebar/release.js`; `am install herdr.am-automations` also switches it on).

Our fork of `DnzzL/herdr-automations` (MIT, kept verbatim in `LICENSE-upstream`, credited in
`NOTICE`): the pack owns this copy, upstream's two files are otherwise unchanged apart from this
mod's title and a fork header. The panel draws and asks; the Go scheduler `herdr-automations`
launches the runs and keeps the files — that binary is installed separately and is not part of the
pack.

## What you see

A card filling its block (`rounded(10)`, 1 px `border`, `background`), three parts top to bottom:
a 42 px header — "Automations", "Active" / "All paused", a switch, and `+`; while the scheduler
binary is missing, a `blocked`-tinted block with one line ("Missing the scheduler: herdr-automations
is not on PATH or in ~/.local/bin."), the install command, **Copy** and a solid **Install**; a
`blocked`-tinted banner with a solid **Start** button while no scheduler holds the lock; a
`blocked`-tinted line while the backend is `herdr`; and a scrolling body in one of
three views. The footer's Automations tab opens the panel as a popup, which is as tall as its
content up to 0.6 of the window, so the body is a flex item that takes its rows' height, with a
scrollbar beside it (am-sidebar's bot-form shape, #239): built with `overflow_y_scrollbar` it
measured 0 there and the popup showed the header alone (#938). In a layout block it fills.

- **List**: `INBOX` (finished runs not yet seen, with "Mark all read" and "Nothing new."), then
  `AUTOMATIONS` — per entry a dot, the name, `▶`, its schedule and next run, and "agent · model ·
  workspace · permissions" (a command: "command · <its words> · tells <bot>"); entries that did
  not load follow on an `ansi1` tint with the message. An inbox row's second line is the run's
  result line or error, else its duration.
- **Detail**: name, `Run now` / `Pause` / `Edit` / `Delete` (delete asks once), schedule, next, repo,
  where it runs, agent, permissions, the prompt, and `HISTORY` per run with status, the result line,
  error or duration, and when. A command shows "Runs: a command, as you, no model" (short enough
  for the panel's width), its folder, env names, timeout and the bot it tells, the command in mono,
  and `LAST RESULT`: status and exit code, the result line, the last lines of stderr when it
  failed, and what became of the report to its bot.
- **Form**: name, schedule pills over a cron field, repo with `Choose…`, "runs in" (new worktree,
  repo root, existing space), an "after a run" close switch (worktree and repo root only), agent
  pills (installed agents plus hc templates), model, `PERMISSIONS`, prompt, timeout, MCP config, and
  `Next: …` previewed live; `Cancel` / `Save`. A prompt naming a terminal address gets a
  `blocked`-coloured line under it.
- **Form, runs as** (#498): with a scheduler that names targets, `RUNS AS` pills — `New session`
  (today), `A bot`, `A worker of a bot`. Picking either target asks for the project's folder
  (still `REPO`, because its `.herdr/bots.json` names the bots), then a `BOT` picker of that
  project's roster by name with `Reload`; a bot target also asks `WHEN THE BOT IS BUSY` —
  `Queue it` (the default) or `Skip this run`. The agent, model, permissions, "runs in" and
  "after a run" fields go: the bot's own launch supplies them. A `blocked` line says when the
  chosen bot left the roster or is only planned, and Save refuses until another is picked.
- **Form, command kind** (#938): `RUNS` pills, `Agent prompt` / `Command (no model)`. A command
  shows `COMMAND` (the program and its arguments on one line), a note ("No shell reads this line …
  It runs as you … Exit 0 is done; any other exit, or the timeout, is failed."), `WORKING FOLDER`
  with `Choose…`, `ENV` (`KEY=value` words), `TELL A BOT`, and the timeout; repo, runs in, after a
  run, agent, model, permissions, prompt and MCP config are not drawn.
- **PERMISSIONS** (#498): pills for the mode the run starts the agent in — `As saved: <mode>` (an
  existing entry), `Automatic (<flag>)` (codex and claude), `Agent default` — a line "Runs <mode>:
  <agent> <args>", and a field for more words to the agent (`agent_args` past the permission flags;
  quote a word with a space). pi and any agent without a known automatic mode get "<agent> has no
  known automatic mode: it runs with its own default." A template shows its command's mode instead,
  "<template>: <mode>. The template's command brings its own flags; the panel adds none."
  An entry saved with a retired agent (`gemini`) shows it as a dimmed `gemini (retired)` pill, picked;
  the value is kept and saved back unchanged, and no other form offers it.

## How it behaves

- **Finding the scheduler**: `herdr-automations version` on PATH, then
  `~/.local/bin/herdr-automations`; the answer also says whether it is ours (`-am.` in the version).
  Neither answers: the repair block shows `repairCommand()` for this machine's `uname -m` and
  `uname -s` (`SCHEDULER` in `scheduler.js` pins our `herdr-automations-v<version>` release and its
  four sha256s, two darwin and two Linux, from its `checksums.txt`, checked by
  `herdr/scripts/scheduler-pin.mjs`; `install.sh` installs the same build from the same pins), and
  every 30 s refresh looks again, so a scheduler installed meanwhile is picked up. Copy writes the
  command to the clipboard; **Install** runs exactly that command (`sh -c`), once per click (it
  removes its own scratch folder, worked or not), and a
  failure keeps the block and says why. Nothing runs without a click, and the panel never installs
  a login service by itself (only **Start**, pressed by you, runs `service install`).
- **Readiness**: `ls --json` answering is the check. No scheduler pid: the "Scheduler stopped"
  banner with **Start**. `backend: herdr` (or none in the file): a line saying runs open in the
  Herdr TUI, not in this app, naming the `automations.yaml` to set `backend: hc` in; the panel
  never edits that file.
- Every read and write goes through the CLI (`ls --json`, `history --json`, `put [--dry-run]`,
  `rm`, `seen`, `run --bg`, `pause|resume`, `service install`); the panel never edits
  `automations.yaml` or `history.jsonl` itself. Config and state folders are watched to know when to
  ask again, plus a 30 s timer for next-run times and the scheduler's state.
- **Dot colours**: `working` while a run of it is live, `blocked` while it waits on you, `ansi1` when
  the last run failed or was missed, `dim` when paused, else `idle`; a run's terminal is found by the
  label `automation=<name>`.
- **Inbox**: clicking a finished run marks it seen and focuses its terminal if still live, else opens
  the automation.
- **Permissions** (#498, owner ruling 2026-11-06): a new automation starts on `Automatic`, the
  flags in `modes.js` `AUTO_ARGS` (codex `--dangerously-bypass-approvals-and-sandbox`, claude
  `--dangerously-skip-permissions`: an unattended run must be able to work); `Agent default` saves
  no permission flag. An existing entry opens on `As saved` and goes back exactly as it came:
  nothing is migrated or rewritten on load or on an edit that leaves the mode and args alone. Its
  saved args are kept exactly only while its agent is the saved one: switching to another agent drops
  every permission flag from the words that carry over and lands on `Agent default`, never on
  `Automatic`; switching back brings `As saved` back. A template run is given no flags (the
  scheduler passes none to a template anyway).
- **Put changes only the keys it is sent** (v0.12.0; up to v0.11.3 it replaced the whole entry,
  #501). A sent key with an empty value is removed, a key not sent is kept. So `agent_args` always
  goes, `[]` for none (leaving it out would keep the old flags after `Agent default`), and the form
  still sends back `catch_up_minutes`, `disabled` (a paused entry stays paused) and `workflow`.
- **A new automation by `put` alone gets the form's flags** (#938), from the scheduler build after
  0.12.1-am.1 only: the pinned 0.12.1-am.1 (`scheduler.js`) does not have it, so until the pin
  moves a bot must send `agent_args` itself or its Codex run stays sandboxed. That later build's
  `put` applies the automatic mode (`AUTO_ARGS` in `modes.js`; `config.DefaultAgentArgs` in the scheduler) to a new
  automation whose request has no `agent_args` key, so one a bot writes runs with the access the
  same one made here has. The form always sends the key, so nothing changes for it. The two tables
  are held equal through `test/fixtures/automation-put-parity.json`: the panel's test checks the
  form's payload, the scheduler's `main_test.go` that the real `put` writes the same file for both.
- **A run's status is the scheduler's** (#938): the panel shows `status` from `history --json` as
  it is and derives none of its own (the row's dot while a run is live is the terminal's state, a
  different thing). A wrong `done` or `failed` is fixed in `herdr/scheduler/internal/host`.
- **Closing a run's workspace** (#498): the scheduler closes a fresh run's workspace once the run
  is `done` when its entry says `close_workspace: on-success` (v0.12.0; failed and blocked runs
  stay open; refused with `workspace: existing`, so a workspace you already had is never closed).
  Our build (`herdr/scheduler/`, released as `herdr-automations-v<version>`) carries the field
  through `ls --json` and `put`, so the form sets it with "Close the space after a successful run":
  shown for new worktree and repo-root runs only, on by default for a new automation (D2), and set
  from what `ls --json` reports for an existing one (`never` or `on-success`). Switching it off
  sends `close_workspace: never`. The panel knows our build by its `version` output containing
  `-am.`; with an upstream `herdr-automations` the switch is replaced by one line saying our build
  is needed, and the key is never sent, so a hand-written `close_workspace` (and `session`) survives
  an edit there. Hand-writing it in `automations.yaml` still works: `on-success` or `never`.
- **Command kind** (#938): offered only when the scheduler's `ls --json` names it (`kinds` holds
  `command`); any other build gets one line, "This scheduler build runs agent prompts only. A newer
  herdr-automations also runs a plain command, with no model.", and the keys are never sent. The
  command line and `ENV` split on spaces, with `"…"` and `'…'` keeping theirs; no shell reads
  either. A word in `ENV` that is not `KEY=value` is said under the form and nothing is sent. A
  command is saved with every agent and space key empty (put removes them: the scheduler refuses a
  command that names one), and an entry switched back to a prompt sends `command: null` and an
  empty `notify`. The scheduler runs the program as you, with no sandbox, and decides the status
  from its exit code; the panel only shows what `history --json` reports (`result`, `exit_code`,
  `stderr`, `notified`). A running command has no terminal: its dot is `working` while its last
  record says `running`.
- **Targets** (#498): `target: <kind>:<bot id>` sends the prompt to a bot instead of a new session.
  `bot:<id>` resolves the bot's live terminal through the pack's own checks: `hc ls --label
  bot=<id>` supplies candidates, each `hc get` says live, still labelled with that id, an agent in
  front (a shell is a bot that quit), and in this project's folder; two live candidates are refused,
  never guessed between. It starts a stopped bot with `am start <id> --project <repo>`, waits up to
  2 min for its terminal, then pastes the prompt with `hc send`; the run is `done` when the bot
  takes it. `worker:<id>` starts `am worker "<prompt>" --worktree <dir> --project <repo>` with
  `HC_TERMINAL_ID` set to the bot's pane, so the worker inherits the bot's worker launch and
  permissions, then waits for its turn and ends it through the checked `am worker kill <pane>
  --json` (the finished terminal stays as the run's address, so the history still points at where
  it ran). A bot that is gone from the roster, planned, on another machine, or unreachable is a
  `failed` run whose line names it; it never falls back to a fresh agent. `target_when_busy: skip`
  records a busy bot's run `skipped`, keeping the pane and target it resolved. Our build names
  `targets` in `ls --json` only when its backend can run one (`hc`, or `auto`); without it the form
  offers no runs-as. An older build has no `Target` field, so its `ls` cannot show a hand-written
  target, it ignores the key and runs a fresh session, and a panel save (which sends no target key)
  leaves the key in place. After a target save the panel reads the entry back and fails the save if
  the build claimed `targets` but dropped the key.
- **Address warning** (#498): a prompt holding an hc address (`t3q1`, `build-box/t9`: a `t`, a
  digit, then letters and digits) is warned about on every preview and on Save, "… is a terminal
  address; it changes on restart. Name the bot instead"; it is saved all the same. A name given with
  `hc --name` is not caught, and a branch shaped like one (`feat/t3q1`) is warned about too, by design.
- **Form** re-runs `put --dry-run` on every keystroke or pill (last answer wins), so the previewed
  next runs are the server's; `Save` runs `put` (with `--original` when editing).
- **Toasts**: a run that turns `failed` or `missed` after the panel started posts a notification;
  clicking it focuses the run's terminal when live.
- `bash: put` gets its JSON through `sh -c 'printf %s "$json" | "$bin" put …'` because `exec` has no
  stdin; `run` is always `--bg` so the 30 s exec limit never truncates a run.

## Built from

`mods/am-automations/main.js`, `agents.js` (which agents the form offers, never a retired one),
`modes.js` (permission flags read as a mode, the automatic flags, the address check, a command's
env line; pure),
`scheduler.js` (the scheduler release pin and its repair command; pure, so the pin check reads it),
`targets.js` (a target parsed, named and its roster warning; pure),
`retired.js` (the retired agents: a byte-equal copy of am-sidebar's, the pack's one list),
`automations.svg` (a clock, 24×24 stroke), `mod.json`
(`place: "none"`, title "Automations"), `LICENSE` (this pack's Apache-2.0) and `LICENSE-upstream`
(DnzzL's MIT, verbatim). Herdr API: `exec`, `hc`, `home`, `theme`, `terminals`, `spaces`, `run`,
`notify`, `pickFolder`, `watchFolder`, `knownAgents`; `InputState`, `TextareaState`.

Programs: `herdr-automations` (the scheduler; `install.sh` installs it and, when you say yes, its
login service), `hc` templates, `sh`, `uname`, `am` (`ls --json` for a project's bots, on the
scheduler's side `start` and `worker` for a target), and the agents a run starts (`claude`, `codex`,
`pi`); **Install** runs the repair command's `curl`, `shasum` or `sha256sum`, `chmod` and `mv`.

## Watch out

- **It runs programs**: `herdr-automations` on every action, `hc templates` for the form,
  `am ls --json --project` for a project's bots when a target is chosen, and it starts agents. It reaches no network and writes no file itself, except when you click
  **Install**: that one command downloads the pinned scheduler from this repository's release and
  writes `~/.local/bin/herdr-automations` once its sha256 matches. `exec`'s 30 s limit applies to
  it: on a slow link it fails and says so, and the copied command in a terminal has no limit.
- **A command automation runs a program as you** (#938): the scheduler starts it on its schedule
  with your network and files, no sandbox, and its result line is pasted into the named bot's
  terminal. Whoever can write `automations.yaml` (this form included) decides what runs.
- The pinned scheduler release (`SCHEDULER`, `0.12.1-am.1`) does not run commands; the form offers
  the kind once a build that names it is installed.
- Without the scheduler binary the panel shows the repair block instead of the list. `install.sh`
  provisions it (#220); shipping it as an RFC 0012 part (installed by `am install` and the pack's
  updater) comes later. A new scheduler release means updating `SCHEDULER` (version and all four
  sha256s) by hand; `install.sh` reads them from the pack, so it needs no change.
- `exec` has no stdin and a 30 s limit: both are worked around (shell printf, `--bg`), and a very
  slow `ls`/`history` would show as an error rather than a hang.
- The fork means upstream changes arrive by hand; `LICENSE-upstream` and the NOTICE entry must stay.

## Done when

`herdr-app check mods/am-automations` passes; with the scheduler installed the panel lists the automations
the CLI lists; `+` saves a new one with its next three runs previewed; `▶` opens a run in a new space;
the switch writes `paused: true` and the header reads "All paused".
