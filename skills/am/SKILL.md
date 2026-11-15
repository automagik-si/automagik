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

`am restart`:

- A Bot that is working or blocked is queued until it is next idle. `am restart --queued` lists the
  queue, and `am restart --cancel <bot>` takes a Bot off it.
- It does not run from inside the pane it restarts. If you are the Bot, ask the person to run it.
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

## Workers

A Bot starts a worker from its own pane. Nothing else can.

```sh
am worker "<task>" --branch <branch>      # in the branch's worktree, made if there is none
am worker "<task>" --worktree <folder>    # in a worktree that already exists
am worker kill <terminal>                 # end a worker you started, once its turn is over
```

- `am worker` prints the worker's terminal. Keep it: `am worker kill` takes it.
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

The Herdr pack's installer (`herdr/install.sh`, the Herdr README's install line) links `am` and
`automagik-herdr` into `~/.local/bin`. That `am` runs the Bot, worker and revive commands on this page; `am self` and `am rollback
automagik.am` need am's own part.

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

Every update is checked against its signature and checksum, and am never installs an older
version. `am update --auto on|off|status` sets whether Herdr installs new releases by itself (on
by default).

## Help

- `am help`: am's own commands, then every Bot command with its flags.
- `hc --help`, and `hc <command> --help` for one command.
