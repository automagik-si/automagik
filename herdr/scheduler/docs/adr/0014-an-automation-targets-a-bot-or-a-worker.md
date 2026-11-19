# ADR 0014 — an automation targets a bot, or a worker of a bot

**Status**: accepted · **Date**: 2026-11-19 · adds a kind of run to ADR 0013's list

## Context

A prompt run opens a session of its own: a fresh worktree, a new agent, a
terminal the run owns. That is right for a chore with no home. It is wrong for
a chore that belongs to a bot which is already running: an automation that was
meant to brief the Housekeeper started a second Codex instead, left its
terminal open, and the bot was never told. The prompt named a terminal address,
which had changed; the run looked successful and did the wrong thing.

The owner's words: "instead of triggering the bot, it created a new session,
that's a bug. we need to be able to associate an automation with a bot or a
worker."

The scheduler already knows how to reach a bot: a bot's terminal carries the
`bot=<id>` label, `hc ls --label` finds it, and `hc send` pastes a line into it.
The pack already knows how to start a worker under a bot: `am worker`, called
from the bot's own pane, applies the bot's worker defaults, template and
permissions, nests the worker under the bot, and keeps its ledger. Neither was
wired to an automation's schedule.

## Decision

A prompt automation may name a **target**: who receives its prompt instead of
a session of the run's own. It is stored as one key, by the bot's stable id.

```yaml
- name: housekeeping
  cron: "0 9 * * *"
  repo: ~/Projects/house            # the project whose .herdr/bots.json names the bot
  target: bot:b-6jrz4bmxml          # the bot's own terminal
  target_when_busy: queue           # queue (default) or skip
  prompt: |
    Tidy the house.

- name: review-queue
  cron: "0 10 * * *"
  repo: ~/Projects/house
  target: worker:b-6jrz4bmxml       # a worker of that bot, for this run only
  prompt: |
    Review the queue.
```

### The target is an id, never an address

`target` is `<kind>:<bot id>`, where kind is `bot` or `worker` and the id is
`b-` and ten lowercase base32 characters — the shape `.herdr/bots.json` gives
a bot (`model.js`'s `ID_SHAPE`). A name is a label the person may change; an
address changes on every restart. An entry whose target is not that shape does
not load, with a diagnostic that says so. The project is the automation's
existing `repo`, and the roster is the nearest `.herdr/bots.json` at or above
it.

### What a bot target does

1. It looks for the bot's live terminal on this computer (`hc ls --label
   bot=<id>`).
2. When there is none, it starts the bot with the pack's own `am start <id>
   --project <project>` and waits for a terminal carrying the label, up to two
   minutes. A start that leaves no such terminal fails the run; it never falls
   back to a fresh agent.
3. It hands the prompt over with `hc send`, exactly as one bot messages
   another. The run is `done` once the bot accepts it; the bot works on its own
   turn afterwards, and the run's history points at the bot's terminal.
4. A busy bot is answered by `target_when_busy`: `queue` (the default) pastes
   the prompt for the bot's next turn; `skip` drops the occurrence and records
   it `skipped`, the same as an overlapping run. A skipped run is not a failure.
   A bot blocked on a dialog refuses the paste, and the run fails with `hc
   send`'s own line: an unattended run never answers somebody's dialog.

### What a worker target does

It does the same first two steps for the bot (a worker needs its parent pane),
then:

1. It makes the run's fresh worktree, as `workspace: worktree` would.
2. It runs the pack's `am worker "<prompt>" --worktree <dir> --project
   <project> --json` with `HC_TERMINAL_ID` set to the bot's terminal. The pack
   therefore starts the worker exactly as the bot would: the bot's worker
   agent, model, effort, template and permission words, its `worker.of` and
   branch labels, its ledger row, and its tab nested after the bot's.
3. It waits for the worker's turn, as it waits for any agent run, and ends the
   worker (and removes its terminal) when the run ends, whether it worked or
   failed. A worker target runs alongside its bot and so has no busy rule.

### Another machine

A target is resolved on the computer the scheduler runs on. A bot defined in a
project on a linked machine has no roster here, and a pane on another machine
(`machine/t7`) is never sent to: the run fails with a line naming the machine,
and nothing is started. Reaching a linked machine from a schedule is a
different feature with its own credentials and its own consent; it is not
implied by naming a bot.

### Gone or renamed

The id is the contract. A bot renamed in `bots.json` keeps its id and is still
a target; the new name is what the panel shows. A bot that left the roster, or
one still `planned`, fails the run with a line that names the id, the roster
file and what to do; a deleted bot is never "replaced" by a fresh agent under
its old name. An unreachable target is a `failed` run whose error is that
line: the panel's inbox and history show it, and the run's terminal column
points at the bot's (or worker's) terminal when there was one.

### Backwards compatibility

An entry with no target behaves exactly as today: same defaults, same session,
same status, same panel form. A build that predates targets does not read the
key, so:

- `ls --json` names the target kinds a build runs in `targets` (`["bot",
  "worker"]`). The panel offers the "runs as" choice only when it reads them,
  so it never writes a target to a build that would drop it.
- A file carrying a target, opened in the panel against a build without
  `targets`, shows the target read-only and refuses to save the entry rather
  than rewriting it without the key.

A target requires `backend: hc` (or `auto` resolving to it): bots live in
herdr-core. Under `backend: herdr` it is a load diagnostic, and a target entry
that still names a workspace, agent, template, model, args or notify is refused
the same way — the bot's own launch supplies all of it.
