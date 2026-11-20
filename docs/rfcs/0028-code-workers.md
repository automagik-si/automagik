# RFC 0028: Code workers: a DSH Bot delegates to agents in Herdr

| Field | Value |
|---|---|
| Status | Accepted (approved by the owner's delegate on 2026-11-19; Q1-Q4 answered with this RFC's own recommendations, see Answers; owner's direction 2026-11-10; no delivery merged; delivery 1 waits for delivery 0, the grant, upstream) |
| Milestone | none (ships outside the five milestones) |
| Lanes | herdr-core (the scoped grant), plugin (3.N.P) for each Automagik delivery |
| Created | 2026-11-10 |
| Replaces | RFC 0006's Workers section |
| Amends | RFC 0022 (a second, host-side path beside delivery H; its rejection stands) |

> Approved by the owner's delegate on 2026-11-19, while the owner is away; the owner may amend on return.

## Summary

A DSH Bot can hand coding work to agents in Herdr, called **Code workers**, the way a person
running a squad with `hc` does today. The Bot starts a worker with a task, ends its turn, and is
woken when the worker finishes, blocks or fails. It can then read the worker's reply, send it a
follow-up or stop it. The person watches every worker live in Code and answers its approvals
there.

The Bot never runs `hc` itself. Five tools in the Bot team's host process do it, through a grant
that reaches only terminals the Bot started. RFC 0022's delivery H stays as written: a Bot's
shell still finds no `hc`, no core socket and no ssh keys.

This is the owner's answer of 2026-11-10 ("Both"): keep RFC 0022's view of Chat, and also let
any DSH Bot delegate to Herdr workers under a scoped permission.

## Motivation

- The owner wants the friendly chat to be where work is asked for, while the real coding runs in
  Herdr, "the same way we do". Today only Herdr's own bots delegate. They are Claude panes
  that start helpers with `hc run` and get notes back (herdr/.genie/brainstorms/herdr-bots).
  A DSH Bot has no way to do it.
- RFC 0006 named the need (a `herdr` subagents provider) in five bullets and never designed it.
  `hc` has since grown what a design needs: labels as filters on `ls` and `events`,
  `wait --children`, `send --if` and `send --wait`, and `hc connect` (the API over stdio).
- RFC 0022 delivery H closes the reach a Bot's shell has to `hc`, for good reason: core has no
  auth, so any process that reaches it can type into any terminal. Delegation must not reopen
  that. It needs its own narrow path.
- Three outside projects tried this (Links). Only one delegates from DSH into Herdr. It teaches
  the model to run `hc` from its bash tool, which is exactly the reach delivery H removes. We
  take its loop (start, end the turn, wake on the report) and put it behind tools instead.

## Words

The word "Code" now names three things. This RFC fixes them:

| Word | Meaning | Where |
|---|---|---|
| **Code** | The coding product: herdr-app, opened from the sidebar's Code card | RFC 0013 |
| **Code mode** | The chat view's switch to xterm on the same terminal | RFC 0022 |
| **Code worker** | A terminal a Bot started with a task, through this RFC's tools | this RFC |

The person-facing words are "Code" and "worker". "Herdr" does not appear in the UI.

## Design

### Who may delegate

- A Bot setting, **Code workers**, off by default for every Bot. The owner turns it on in the
  Bot's settings. Turning it off stops nothing that runs, but the tools refuse new starts.
- Only the owner changes the setting. A Bot cannot turn it on for itself or another Bot, the
  same rule as `deny_tools`.
- A Bot with the setting on gets the five tools below. A Bot with it off never sees them.

### The tools

All five run in the host. None takes a shell string from the model.

| Tool | Does | Refuses |
|---|---|---|
| `code_start` | Starts a worker: a template or agent from an allowlist, a task, a folder, a short name | a folder outside the Bot's allowed folders, an unknown template, the caps below |
| `code_send` | Types a follow-up into one of the Bot's workers (`hc send --if idle`) | a worker that is working or blocked, a terminal the Bot did not start |
| `code_read` | Returns a worker's last reply, or its screen and history | a terminal the Bot did not start |
| `code_list` | The Bot's workers with status, folder and elapsed time | nothing |
| `code_stop` | Ends a worker (`hc kill`), keeps its record for reading | a terminal the Bot did not start |

There is no wait tool. A Bot ends its turn after `code_start` and is woken (below). This also
avoids the bash tool's 60-second limit that the outside bridge works around with a loop.

`code_start` runs `hc run --bg --no-notify` with these labels, which the grant enforces:

- `automagik.bot=<botId>` (RFC 0006's contract, kept).
- `automagik.worker=<workerId>`, a random id the host keeps in the Bot's store.
- `agent.session` and `agent.transcript` when the template sets them (RFC 0015 delivery 2), so a
  reply is read from the transcript, not the screen.

Workers go in the Bot's space, `automagik:<botId>`, never focused or raised, so nothing moves on
the person's screen.

### The grant (herdr-core)

The host talks to core through one grant, built from #628 (scope send, keys and attach to a
team) and #631 (the filtering proxy). The grant allows exactly:

- `run`, and only with the label `automagik.bot=<botId>` forced on, never `--on` (until delivery
  5), never `--parent` on a terminal outside the grant.
- `get`, `read`, `send`, `keys`, `wait`, `interrupt`, `kill`, `events` and `ls`, only on
  terminals carrying that label.
- Nothing else: no `exec`, no `file`, no `machine`, no `attach`, no other terminal.

Only the host process holds the grant's credential. Bots' shells keep delivery H's masks. Chat's
seat and every terminal a person started stay outside every Bot's grant, so RFC 0022's rejected
design (a Bot between the owner and Chat) stays impossible, not only discouraged.

Until the grant exists upstream, nothing in this RFC ships (delivery 1 waits for delivery 0).

### Waking the Bot

The host follows `hc events --label automagik.bot=<botId>` for each Bot with workers. When a
worker's turn ends, it blocks, it errors or it exits:

1. The host notes a wake intent in the Bot team's durable wake log (`<home>/wake.jsonl`, which
   notes task and group reports before they are delivered) before anything else. That log is
   on its own branch, not yet on dev; delivery 1 waits for it.
2. It reads the worker's last reply: the transcript when the terminal has one, else `hc read`.
3. It queues one message into the Bot's Session: the worker's name, status, elapsed time and
   reply, marked as a worker report.
4. It clears the intent once the Session accepted the message.

A crash between 1 and 4 resends on restart, once, by the intent's id. Reports from several
workers that end close together arrive as one message. A Bot that is busy reads it at its next
step, like a message from another Bot.

### A report is data

- A worker's reply reaches the Bot framed as a tool result from a named worker, never as the
  person's words or a system message.
- An `<hc>` tag, or any text claiming to be the person, inside a report is quoted, not obeyed
  (RFC 0022 Decided 8, applied to reports).
- Text the Bot sends a worker is typed as the Bot's words. The worker's template tells it that
  its task comes from a Bot, on the person's behalf.

### Approvals

- A worker's approval dialog shows in the chat on the worker's card: what it asks, with
  **Open in Code** to answer it in the real terminal.
- The Bot never answers a worker's approval. `code_send` refuses a blocked worker, and the grant
  gives the host no `send --force`. A Bot cannot raise its own reach through its workers.
- After herdr-core#122 (a conditional key call), the card gets Allow once and Deny, with RFC
  0015's race rule: the first answer wins, the other side closes with a receipt (delivery 4).
- A worker's permission level is never above its Bot's. A Bot at Read only, Workspace or Auto
  review gets workers in their agent's ask mode. Only a Bot at Full access may start a worker
  that skips approvals, and only from a template the owner marked for it.

### In the chat and the sidebar

- **A worker card** in the Bot's chat, one per `code_start`: name, agent, folder, status with
  elapsed time, and Watch (opens the worker in Code mode or Code) and Stop. It updates in place
  and is never a new message per change. Failures are loud, routine turns are quiet.
- **The sidebar** shows a working pill with a timer on the Bot's row while any of its workers
  works, and the Code card counts running workers. The mockup this RFC was drafted with is
  outside the repository.
- Workers do not get rows of their own. They stay in Code, as D29 decided ("Workers and helpers
  stay in Herdr").

### Caps and cleanup

- At most 3 running workers per Bot and 6 per team by default, settable by the owner. A start
  past a cap is refused with the running workers named.
- A finished worker's terminal is removed after its report is accepted and 24 hours pass, or at
  `code_stop`. The record (task, status, last reply) stays in the Bot's store.
- When a worker runs in a git repository, `code_start` may ask for a worktree. The host makes it
  under the repository's worktree folder and removes it at cleanup only when it has no
  uncommitted changes and no unpushed commits.
- Each `hc run` start is metered under RFC 0021's attribution, with the Bot as the actor.

## What does not change

- RFC 0022: Chat's seat, the view, Code mode and delivery H are unchanged. Its rejected design
  stays rejected: no Bot reaches Chat's seat.
- RFC 0014 and D29: Herdr's own bots, their helpers and their briefing hook are unchanged.
- Bot-to-Bot work (`message_bot`, tasks, group reports) is unchanged and stays the way one Bot
  asks another.

## Contracts introduced

- Bot setting `codeWorkers` (boolean, default off) and the caps `codeWorkers.perBot` and
  `codeWorkers.perTeam`. Compatibility: new.
- Tool names `code_start`, `code_send`, `code_read`, `code_list`, `code_stop`.
- Terminal label `automagik.worker=<workerId>`, beside RFC 0006's `automagik.bot`.
- Space prefix `automagik:` (RFC 0006's contract, kept).
- A worker report message kind in the Bot's Session.
- The herdr-core grant scope (label-scoped run and terminal calls), filed upstream.

## Threat model

| Threat | Mitigation |
|---|---|
| A Bot reaches terminals it did not start, or Chat's seat | The grant is label-scoped in core, not in the plugin; Bots' shells stay masked (delivery H) |
| Prompt injection through a worker's reply | The reply is framed as data from a named worker; tags and claimed person-text are quoted |
| A Bot raises its own reach through a worker | No `send --force` in the grant; worker level never above the Bot's; the owner answers approvals |
| Runaway starts | Per-Bot and per-team caps; starts metered; the setting is off by default and owner-only |
| Work leaks to another machine | No `--on` until delivery 5 |
| Lost wake-ups across restarts | The durable wake log notes the intent before the report, and resends it once |
| A worktree with work in it is deleted | Removed only with no uncommitted changes and no unpushed commits |

## Deliveries

Each is one PR on one lane. The order is 0, 1, 2, 3, 4, 5.

0. **The grant** (herdr-core, filed upstream from #628 and #631). *Check:* with the grant, `run`
   without the label, `exec`, and a send to an unlabelled terminal are refused, and a labelled
   run, read, send and kill work.
1. **The tools and the wake loop** (plugin, behind the setting). `code_start`, `code_send`,
   `code_read`, `code_list` and `code_stop`, and the report through the durable wake log.
   Needs delivery 0 and the durable wake log on dev.
   *Check:* a Bot starts a worker in a temporary core session, ends its turn, and is woken with
   its reply; a crash between intent and acceptance resends once; every refusal in the tools
   table is tested.
2. **The worker card and the sidebar pill** (plugin). *Check:* the card updates in place
   through working, blocked and done; Open in Code and Stop act on the right worker.
3. **Caps, cleanup and worktrees** (plugin). *Check:* the fourth start for one Bot is refused;
   cleanup keeps a worktree with uncommitted changes.
4. **Approvals from the chat** (plugin, after herdr-core#122). *Check:* answering in the chat
   and in Code at once leaves one answer and one receipt.
5. **Workers on linked machines** (plugin and herdr-core, after #206 and delivery H's link
   scoping). *Check:* `--on` works only for machines the owner allowed for that Bot.

## Answers (2026-11-19)

Approved by the owner's delegate on 2026-11-19. Every open question had a recommendation, and
each is answered with it, restated; the questions below stay as they were asked.

1. **Q1, the Main Bot's default:** off, like every Bot, with a one-time offer in the Main Bot's
   chat the first time the owner asks for coding work.
2. **Q2, the worker's agent:** Herdr templates from an owner-kept allowlist, Claude Code first.
   Not the Bot's own model route, because the worker is a full coding agent.
3. **Q3, the card:** our own chat row first, through RFC 0023's chat tail slot; a subagents
   provider hook is asked of DSH later.
4. **Q4, default caps:** 3 running workers per Bot and 6 per team, settable by the owner (Caps
   and cleanup).

## Open questions

Answered on 2026-11-19 (Answers, above); kept as asked.

1. **The Main Bot's default.** Recommended: off like every Bot, with a one-time offer in the Main
   Bot's chat the first time the owner asks for coding work.
2. **The worker's agent.** Recommended: Herdr templates from an owner-kept allowlist, Claude Code
   first. Not the Bot's own model route, because the worker is a full coding agent.
3. **A DSH-native subagent card** (RFC 0006's provider) versus our own chat row. Recommended:
   our own row first, through RFC 0023's chat tail slot; ask DSH for a subagents provider hook
   later.
4. **Default caps.** Recommended: 3 per Bot and 6 per team, matching the shared Mac's limit on
   busy processes.

## Links

- RFC 0006 (Workers), RFC 0013 (Code), RFC 0014 (D29), RFC 0015 (race rule, transcripts),
  RFC 0021 (metering), RFC 0022 (delivery H, Decided 6 and 8), RFC 0023 (tail slot).
- herdr-core#122, #206, #628, #631.
- Prior art, read and not run:
  [Hariketsu/dsh-herdr-bridge](https://github.com/Hariketsu/dsh-herdr-bridge) (MIT): the loop
  of starting helpers, ending the turn and waking on the report; approvals answerable from both
  sides. [mitkox/dsh-herdr](https://github.com/mitkox/dsh-herdr) (Apache-2.0): Herdr's status
  protocol and the blocked-state rules.
  [kilbertert/dsh-herdr](https://github.com/kilbertert/dsh-herdr) (MIT): a Herdr terminal
  inside DSH's page. [block/buzz](https://github.com/block/buzz) (Apache-2.0): a worker reports
  back to whoever gave it the work; the working pill with a timer.
