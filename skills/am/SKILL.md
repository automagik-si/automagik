---
name: am
description: Run an Automagik team with am, Automagik's one command (see and brief its Bots, start and restart them, give a task to a worker, message a teammate, bring the team back after a reboot, update), when you are an agent working inside an Automagik team or a person setting one up.
---

# am

`am` is the one command of Automagik (RFC 0012). It runs a team of code agents in Herdr:

- A **Bot** is a long-lived agent with a name, a role, an agent (Claude Code, Codex and others) and
  a model. A project's Bots are defined in its `.herdr/bots.json`. One is the Main Bot; every other
  Bot reports to a lead.
- A **worker** is a short-lived agent that a Bot starts for one task, in that task's worktree.
- Each one runs in a Herdr terminal with an address such as `t7`.

Three rules hold for every command:

- `am` works on the project of the folder it runs in (its git main checkout). `--project <folder>`
  names another.
- A `<bot>` is its id or its name in the project. `am ls` prints both.
- Every command takes `--json`.

`am help` prints every command with its flags. Read it before you use a flag that is not on this
page, and never guess one.

`automagik-herdr` is the command's old name. It still runs as an alias; write `am`.

## Bots

```sh
am ls                     # this project's Bots: id, name, lead, agent, model, status and terminal
am ls --all               # the Bots of every project this computer knows
am show <bot>             # one Bot in full
am brief <bot>            # the Bot's briefing, with its team's live state as it is now
am create --name <name> --agent <agent> [--kind main|member] [--role <role>] [--lead <bot>]  # a new Bot
am start <bot>            # a new pane on this computer; prints its terminal
am restart <bot>          # its agent again in its pane's place, on the same conversation
am restart <bot> --fresh  # the same, on a new conversation
```

From the lead's live HC terminal, `am start <bot> --project <absolute dir on M> --machine M`
can start a fresh Claude Code conversation with that terminal as its hc parent. The pane
outlives the lead, and its launch briefing gives the exact address for the result or blocker.
As with `hc run --on`, M's core (any pane there) can send to, get, read and wait on the lead
terminal. hc queues its own exit and blocked notes across a lost line. An explicit send can
fail or have an unclear outcome. Save the result in the project, say its path in the pane,
and confirm it did not arrive before retrying.

am cannot see M's inbound peers. A peer named for the lead's core ID or a later alias change
on M can redirect reports. hc resolves core IDs as names too, so a link change between a check
and the next command can redirect that command. A session-specific hc wrapper on the pane's
PATH can select another socket. Controllers with separate ledgers can start the same bot twice.

If am cannot verify the route, use `hc run --bg --on M` from the origin HC terminal with hc's
default parent and explicit first-task and report instructions. This is also the alternative
for holder placement and linked restarts from an HC terminal. A verified already-running
start reports the pane's current parent. `hc exec --on M am start …` gives the bot no return
route, and am cannot detect that case.

`am restart`:

- A Bot that is working or blocked is queued until it is next idle. `am restart --queued` lists the
  queue, and `am restart --cancel <bot>` takes a Bot off it.
- It does not run from inside the pane it restarts. If you are the Bot, ask the person to run it.
- A seat over its context threshold can restart from a handoff: `am restart --due` asks it to write
  `<app home>/automagik-herdr/handoff/<bot>.md` and end its turn, then restarts it fresh from that
  file (its first new message). `--dry-run` lists the seats without touching them; `--all` covers
  the projects this CLI remembers. Set the threshold with `am edit <bot> --restart-at N` (a main
  bot defaults to 250000; `--no-restart-at` clears it). A working or blocked seat is queued. A
  handoff restart that fails or is dropped is kept in
  `<app home>/automagik-herdr/handoff-failures.json` and listed by `am restart --queued`; a queued
  watcher also tells the project's main bot.
- A Bot that is not running is started.
- It refuses while helpers run under the Bot's pane, because they would end with it. `--tree` runs
  them again under the new pane; `--force` lets them end.

To change a Bot's agent or model:

```sh
am edit <bot> --agent <agent> --model <model>            # the definition, for the next start
am restart <bot> --agent <agent> --model <model>         # this run only, on a new conversation
am restart <bot> --agent <agent> --model <model> --save  # this run, and the definition too
```

`--agent` or `--model` alone works in all three. `am edit <bot> --no-model` clears the model, so
the agent's own default applies.

A Claude Code Bot's permission mode is its own: `am edit <bot> --permission-mode <mode>` (one of
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; `auto` is the default
and an empty value restores it). Every start, restart and revive passes it, independent of the
model. Any other agent has no per-bot permission mode, so a value for one is refused.

## Workers

A Bot starts a worker from its own pane. Nothing else can.

```sh
am worker "<task>" --branch <branch>      # in the branch's worktree, made if there is none
am worker "<task>" --worktree <folder>    # in a worktree that already exists
am worker kill <terminal>                 # end a worker you started, once its turn is over
am worker done --report <file> [--state done|blocked]  # finish your own worker pane
```

The pane starts first. Then am records the worker in the workers ledger and, for an agent that
takes no task on its command line, sends the task as its first message. A failure of either is
a warning, not an error: `am: ...` lines on stderr; with `--json`, the `warnings` field.
The receipt prints the terminal on its first line (`--json`: `terminal`), then role, worktree,
branch and agent (or template), and the kill line. Keep the terminal: `am worker kill` takes it.
Read the warnings: a terminal alone does not prove the task arrived. Check the pane with
`hc read <terminal>` before starting another. If the launch itself fails, am exits non-zero and
prints no receipt. `am history <bot>` lists a Bot's workers.

- A Bot owns the workers it starts in its project (`worker.of`). A worker can finish its own
  pane with `am worker done` and a Markdown report. Use a file in the system temp folder to keep
  the worktree clean. Use `--state blocked` to report a blocker, including from a dirty worktree.
  am saves the report, wakes the task lead, and retires the pane.
- `--base <ref>` goes with `--branch` and sets where a new branch starts.
- `--agent`, `--model` and `--effort` choose the worker's agent. Without them the Bot's own worker
  defaults apply.
- `--role dev|test|review|fix` says what the worker does. A worktree takes one writer (dev, test or
  fix) at a time; reviewers run beside it.
- `am worker kill` ends only a worker that the calling Bot started. It refuses a Bot's own pane,
  another Bot's worker and a worker that is still working.

## Send a message to a teammate

Messages go through `hc`, Herdr's terminal command. Find the teammate's terminal first, every
time: a terminal from an older message may be gone.

```sh
hc ls --label bot=<id>            # the terminal that Bot runs in now
hc send <terminal> "<message>"    # paste the text there and press Enter
```

- `<id>` is the Bot's id, from `am ls`. `am brief <bot>` names that Bot's lead and team.
- Write the message as plain text. Inside double quotes the shell runs backticks and `$(...)`
  before `hc` sees them.
- Report to your lead this way when a task is done or when you are stuck.

## After a reboot

```sh
am revive --dry-run    # print the plan; touch nothing
am revive              # restart every Bot of this computer whose pane is gone
```

`am revive` starts the Main Bot first, then each Bot after its lead, in the same space, tab and
folder, on the same conversation where its agent allows. It never touches a pane whose agent is
running. Each project's Main Bot gets one report: who resumed, who is on a new conversation, and
who is not back, with the command that brings it back by hand.

`am revive service install` adds the login service that runs it at each boot (Linux for now);
`am revive service status` and `am revive service uninstall` check and remove it. To keep a Bot
down across restarts, run `am detach <bot>`.

## Install

There are two routes:

- The Herdr pack's installer (`herdr/install.sh`, the Herdr README's install line) links `am` and
  `automagik-herdr` into `~/.local/bin`. That `am` runs the Bot, worker and revive commands here.
- For am alone, with no Herdr app, follow [am's install guide](https://github.com/automagik-si/automagik/blob/dev/am/README.md).

`am self` and `am rollback automagik.am` need am's own part.

am's own part (`am self install`, `am self doctor`) comes from an unpacked am release
(`automagik-am-<version>.tgz`): run `sh <that folder>/bin/am self install`, then `am self doctor`.

## Update and roll back

```sh
am update --check          # say what is installed and what is newest; install nothing
am update                  # am first, then the herdr pack where one is installed
am rollback automagik.am   # am back to the copy it replaced
am rollback herdr.pack     # the pack back to the one it replaced
```

`am rollback` is am's own part's command (see Install): the pack's own `am` has no `rollback`, so with
the pack alone the same step is `am update --rollback`.

Every update is checked against its signature and checksum. `am update` refuses a pointer older
than the newest this machine took. `am update --auto on|off|status` sets whether Herdr installs
new releases by itself (on by default).

## When am cannot do it

If `am` is not on PATH, use `~/.local/bin/am` and say so. Never put `automagik-herdr` or a pack
CLI path in its place to get around a refusal or a missing command. If am refuses, or a command
or flag you need does not exist, stop. Say what you ran and what it printed, and
[report it](https://github.com/automagik-si/automagik/issues) with the command, output,
`am --version` and `am self doctor --json`.

## Help

- `am help`: am's own commands, then every Bot command with its flags.
- `hc --help`, and `hc <command> --help` for one command.
