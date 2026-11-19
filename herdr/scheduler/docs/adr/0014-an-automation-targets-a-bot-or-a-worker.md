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

1. It resolves the bot's live terminal on this computer by its `bot=<id>` label:
   `hc ls --label bot=<id>` only supplies candidates; each candidate is then read
   with `hc get`. It counts only when that answer is live, still carries
   `bot=<id>`, has an agent in the foreground (a shell in front is a bot that
   quit), and its folder belongs to this automation's project (the nearest
   `.herdr/bots.json` above it is the project's). A duplicate id in another
   project's roster is not this project's bot. More than one such pane is refused
   with a line naming them: a schedule never guesses which twin to message.
   These are the pane facts the pack's Start path checks, but this is not the
   pack's resolver: the pack resolves which terminal plays which bot through the
   attach ledger, where the `bot` label is only a display hint. The scheduler
   does not read that ledger, so a stale label can still pass this step; the
   last paragraph of this section says what that leaves open.
2. When there is none, it starts the bot with the pack's own `am start <id>
   --project <project>` and waits for a terminal carrying the label, up to two
   minutes. A start that leaves no such terminal fails the run; it never falls
   back to a fresh agent.
3. Immediately before it hands the prompt over with `hc send`, it reads that
   pane once more and refuses anything but the terminal it resolved: still
   live, still carrying `bot=<id>`, still with an agent in front, and the same
   `created_ms`. Herdr reuses terminal ids, so a different `created_ms` is a
   different terminal; a shell in front means the agent quit; a changed label
   means the pane was relabelled. Any difference refuses the send, fails the run
   with a line naming the pane and what changed, and sends nothing. The run is
   `done` once the bot accepts it; the bot works on its own turn afterwards, and
   the run's history points at the bot's terminal.
4. A busy bot is answered by `target_when_busy`: `queue` (the default) pastes
   the prompt for the bot's next turn; `skip` drops the occurrence and records
   it `skipped`, the same as an overlapping run. A skipped run is not a failure,
   and it keeps the pane and target already resolved in its history row. A bot
   blocked on a dialog refuses the paste, and the run fails with `hc send`'s own
   line: an unattended run never answers somebody's dialog.

What the confirming read does not see is a stale `bot=<id>` label already in
place when the run resolves: if the attach ledger has moved the bot to another
terminal and the old pane still carries the label (a failed or skipped `hc
label`, or a hand-set one), both the resolution and the confirming read accept
it. Honouring the ledger means reading and confirming it here — its core,
machine and `created_ms` — which is a design change, not part of this fix. Until
then the pack's own paths are the authority: `am show <id>` names the terminal
the ledger binds, so a person who suspects a stale label can compare and clear
it with `hc label`/`am attach` before the next run.

What the confirming read also cannot close is the instant between that read and
`hc send`'s paste: `hc send` takes an address, not the expected identity, so a
change exactly inside that instant can still land. Closing it takes a send verb
that verifies the pane atomically; this ADR records the gap rather than claiming
it away.

### What a worker target does

It does the same first two steps for the bot (a worker needs its parent pane),
then:

1. It makes the run's fresh worktree, as `workspace: worktree` would.
2. It runs the pack's `am worker "<prompt>" --worktree <dir> --project
   <project> --json` with `HC_TERMINAL_ID` set to the bot's terminal. The pack
   therefore starts the worker exactly as the bot would: the bot's worker
   agent, model, effort, template and permission words, its `worker.of` and
   branch labels, its ledger row, and its tab nested after the bot's.
3. It waits for the worker's turn, as it waits for any agent run, and then ends
   the worker through the pack's checked `am worker kill <pane> --json` with the
   bot's pane as the `HC_TERMINAL_ID` caller. That verb confirms the worker is
   the calling bot's own, is no bot's seat and is not mid-turn; `hc kill` has no
   such guard. So the worker is ended when its turn has finished, whether the
   turn worked, failed or exited — but it is not ended while hc still reports
   `working`. The finished terminal stays, so the run's saved `PaneID` still
   names where the worker ran. A worker target runs alongside its bot and so has
   no busy rule.

The timeout is therefore the one case where the run ends and the worker does
not. If `timeout_minutes` passes while the worker is still mid-turn, the run
fails with `the agent was still working after <timeout>` and the deferred
`am worker kill` refuses the still-working worker by design: its work would be
lost. The worker stays, nested under its bot, and the only record is one
scheduler log line (`could not end the run's worker <pane> through am worker
kill: <pane> is still working; worker kill ends a worker that has finished its
turn ...; the worker stays until it is ended`). A person seeing that run in the
panel should expect the worker still in the sidebar under that bot: open it to
see what it is doing, and once its turn ends, end it from the bot's terminal
with `am worker kill <pane>`. Ending it mid-turn is left to the project's main
bot (`hc kill <pane>`); the scheduler never takes that shortcut for a run.

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
file and what to do (`clear planned there, or pick a bot that is not planned`);
a deleted bot is never "replaced" by a fresh agent under its old name. An
unreachable target is a `failed` run whose error is that line: the panel's
inbox and history show it, and the run's terminal column points at the bot's
(or worker's) terminal when there was one.

### Alternatives rejected

- **A terminal address** (`t3q1`, `machine/t9`): an address changes on every
  restart, and an old one can belong to a stranger's pane. The address shape is
  refused by the loader, and the panel warns when a prompt names one.
- **A bot name**: a name is a label a person edits, can repeat, and can change
  without the schedule noticing. The id is stable across renames and restarts.
- **A project-level target** (just the `repo`, no bot): a project has many bots
  and workers, and no single receiver to name; `repo` already selects the
  project the roster comes from.
- **A `kind` and an `id` in two keys, or an object** (`target: {kind, id}`):
  both can hold half a target and need every reader, writer and validator to
  agree about the other half. One scalar has one value to read, write and
  preview, and the kind stays visible beside the id.
- **`am send` instead of `hc send`**: the pack has no checked send verb;
  `hc send` is the primitive one bot already uses to message another. If a
  checked verb replaces it, the target should use it.
- **A fresh session inheriting the bot's launch**: that is still a second agent
  with no shared turn and no ledger row, which is the bug this ADR fixes.
- **A session target** (`session`): a Herdr session is a container of
  terminals, not one receiver, and `session` is already the scheduler's backend
  session key. A target names one pane.

### Backwards compatibility

An entry with no target behaves exactly as today: same defaults, same session,
same status, same panel form. A build that predates targets has no `Target`
field in its `ls --json` and no `targets` key, so:

- It does not read `target`: the entry still loads and runs as an ordinary
  fresh session. It ignores the field and keeps working.
- A panel talking to that build cannot see the target either, so it shows an
  ordinary fresh-session entry. An edit it saves carries no target key, and the
  scheduler's `put` replaces only the keys it is given, so the hand-written
  `target` line survives that edit. It is not shown read-only, because that
  build cannot report it.
- Our build names the target kinds it runs in `targets` (`["bot", "worker"]`),
  and only when its backend can run one (`hc`, or `auto`): under `backend:
  herdr` it names none, and the panel offers none there.
- After a target save, the panel reads the entry back. A build that claims
  `targets` but drops the key fails the save with a line saying so, instead of
  looking like a successful save.

A target requires `backend: hc` (or `auto` resolving to it): bots live in
herdr-core. Under `backend: herdr` it is a load diagnostic, and a target entry
that still names a workspace, workspace_id, session, agent, template, model,
mcp_config, agent_args, notify or close_workspace is refused the same way — the
bot's own launch supplies all of it. `target_when_busy` without a target is
refused too, never silently ignored.
