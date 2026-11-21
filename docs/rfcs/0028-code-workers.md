# RFC 0028: Code workers: a DSH Bot delegates to agents in Herdr

| Field | Value |
|---|---|
| Status | Accepted (approved by the owner's delegate on 2026-11-19; Q1-Q4 answered with this RFC's own recommendations, see Answers; owner's direction 2026-11-10; amended 2026-11-19: the durable wake log defined as delivery 0b, amendment approved by the owner's delegate on 2026-11-19; delivery 0b merged (#1827); amended 2026-11-20: reports are not batched on DSH rc.2, one message each in order, approved by the owner's delegate on 2026-11-20; delivery 1 waits for delivery 0, the grant, upstream; amended 2026-11-21: a second worker kind, `lead`, writing in RFC 0030's Q8 answer (approved 2026-11-19); Q5 (leads per Bot) and Q6 (held sends) answered with their recommendations, approved by the owner's delegate on 2026-11-21) |
| Milestone | none (ships outside the five milestones) |
| Lanes | herdr-core (the scoped grant), plugin (3.N.P) for each Automagik delivery |
| Created | 2026-11-10 |
| Replaces | RFC 0006's Workers section |
| Amends | RFC 0022 (a second, host-side path beside delivery H; its rejection stands) |

> Approved by the owner's delegate on 2026-11-19, while the owner is away; the owner may amend on return.
> The durable wake log (Design, and delivery 0b) is an amendment approved by the owner's delegate on
> 2026-11-19.
> Lead workers (Design, and delivery 1b) are written here on 2026-11-21. Their four rules are RFC
> 0030's Q8 answer, approved by the owner's delegate on 2026-11-19 ("RFC 0028 gains a worker kind
> `lead`"). What that answer left open, Q5 and Q6, was answered with their recommendations,
> approved by the owner's delegate on 2026-11-21 (Answers (2026-11-21)).

## Summary

A DSH Bot can hand coding work to agents in Herdr, called **Code workers**, the way a person
running a squad with `hc` does today. The Bot starts a worker with a task, ends its turn, and is
woken when the worker finishes, blocks or fails. It can then read the worker's reply, send it a
follow-up or stop it. The person watches every worker live in Code and answers its approvals
there.

A second kind of worker, a **lead**, is a long-lived seat such as a Genie's orchestrator (RFC
0030). Its events wake no one: it reaches its Bot through RFC 0030's mailbox (Lead workers).

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
| **Lead worker** | A Code worker of the kind `lead`: a long-lived seat a Bot keeps, such as a Genie's orchestrator | this RFC (Lead workers), from RFC 0030's Q8 |

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
| `code_send` | Types a follow-up into one of the Bot's workers (`hc send --if idle`); for a lead that is working, holds the text and sends it when that turn ends (Lead workers) | a worker of the kind `worker` that is working or blocked, a lead that is blocked, a terminal the Bot did not start |
| `code_read` | Returns a worker's last reply, or its screen and history | a terminal the Bot did not start |
| `code_list` | The Bot's workers with status, folder and elapsed time | nothing |
| `code_stop` | Ends a worker (`hc kill`), keeps its record for reading | a terminal the Bot did not start |

There is no wait tool. A Bot ends its turn after `code_start` and is woken (below); a lead's
events wake no one (Lead workers). This also avoids the bash tool's 60-second limit that the
outside bridge works around with a loop.

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

Until the grant exists upstream, nothing in this RFC that reaches core ships (delivery 1 waits
for delivery 0). The durable wake log (delivery 0b) does not reach core and may ship first.

### Waking the Bot

The host follows `hc events --label automagik.bot=<botId>` for each Bot with workers. When a
worker's turn ends, it blocks, it errors or it exits (a worker of the kind `worker`; a lead's
events wake no one, and only a mailbox row admitted by RFC 0030's follower wakes the Bot for it,
Lead workers):

1. The host notes a wake intent in the Bot team's durable wake log (`wake.jsonl`, below) before
   anything else, naming the worker, its event and the event's transcript position; the reply
   read in step 2 is added to it before step 3. Delivery 1 waits for that log (delivery 0b).
2. It reads the worker's last reply: the transcript when the terminal has one, else `hc read`.
3. It queues one message into the Bot's Session: the worker's name, status, elapsed time and
   reply, marked as a worker report.
4. It clears the intent once the Session accepted the message.

A crash between 1 and 4 resends on restart by the intent's id, and the Bot takes the report up
once. Reports from several workers that end close together arrive as separate messages, in the
order they ended, each closing its own intent; a Bot reads them one turn after another, like
messages from another Bot (Several reports at once, below).

### The durable wake log

Amendment approved by the owner's delegate on 2026-11-19. The earlier text put this log on a
branch of its own; this amendment defines it, and it ships as delivery 0b, on the plugin lane.

**What it is for.** Between the moment the host decides that a report goes to a Bot and the
moment a turn of the Bot's Session takes it up, a crash must not lose the report, and a restart
must not make the Bot take it up twice. Today `inflight.json` (resume.js) notes a delivery once
`rt.deliver` is called, but that file is written in place, coalesced and never fsynced, and the
producers save the source as finished before the report is on its way: a task's turn end sets
`task.status` and starts `rt.save()` before it builds the report (agents.js), and a group round
saves before `reportRound`, which can close the delegated work before it delivers (groups.js).
A kill in between leaves a finished task or round whose report never arrives.

**Where.** `wake.jsonl` in the Bot team's home (`join(rt.home, 'wake.jsonl')`, the home the
plugin already uses, beside `inflight.json` and `state.json`), created owner-only (0600), with
the folder fsynced after the file is first made. One file per team, appended to, one JSON record
per line, like `ledger/<book>.jsonl` and `memory/journal.jsonl`. No existing plugin id, route,
storage prefix or file in the team's home is renamed or moved.

**What is recorded.** Every line has `v: 1`, `id` (the report's id), `at` (ms) and one `event`:

| `event` | Written | Other fields |
|---|---|---|
| `intent` | by the producer, when it decides a report goes to a Bot, before it saves anything that marks the source finished (task status, the round, the closed work) | `kind` (`task-report` and `group-report` first; `worker-report` with delivery 1; RFC 0030's mailbox rows with its delivery 3), `botId`, `key` (the source's completion key: the task's Session, the group post's id and round, the worker and its event), `roomId` (the room the report is about, for its header), `returnRoomId` (the group whose Session it goes back to; none for the Bot's own chat), and, when known at that moment, the report (header role and note, text, `taskSessionId`, `work`, `replyTo`) and the Session it is first sent to |
| `prepared` | when the report was not known at `intent` (a worker's reply is read after the intent) | the report and the Session it is first sent to; or `unread: true` when the reply cannot be read any more |
| `attempt` | before each resend | `sessionId`: the Session it is sent to |
| `sent` | once DSH made the message | `messageId`: DSH's id of that message |
| `moved` | before a part switch hands the waiting message to the part that replaced the Session (parts.js) | `sessionId`: the new Session |
| `done` | when the report is finished with | `how`: `taken` (a turn took it up), `discarded` (the person stopped the Bot or withdrew the message), `gone` (the Bot was deleted) |
| `dropped` | when an open report is given up | `reason`: `stale` or `attempts` |

The report's `id` is the delivery's `exchangeId`, so the Session's log, `inflight.json` and the
wake log name one report the same way. A producer that reaches the same completion again (a
restart's own pass over a cut task, a round finished twice) finds the open or closed report by
its `key` and makes no second one. The text is the report as delivered, with today's caps (a
task's `TASK_REPORT_MAX`); images and files go by reference, never as bytes. A worker report's
`intent` names the event's transcript position, so the reply of that event, not a later one, is
what `prepared` reads.

Every record but `done` (`taken`) and `done` (`gone`) is written and fsynced before the host goes
on; the `intent` synchronously, in the same step that decides the report. Those two may be written
without waiting, because the next start can tell both again from the Session's log and the
roster; `done` (`taken`) is written only after DSH flushed the Session that holds the
`user/message` (`ctx.sessions.flush`), and only after the producer's own change is saved (below).
Records are appended one at a time, behind the same queue that rewrites the file; after a write
cut short, the next record starts on a new line. While the host is stopping it writes
nothing, as `inflight.json` does today, so a clean shutdown's cancelling of an inbox never closes
a report.

**One owner for a report's resend.** A report sent through the wake log is still noted in
`inflight.json` (so `rt.unreadOf` keeps counting it), but marked as the wake log's, and the
resume pass never resends a marked note, at this start or a later one. The wake log alone decides
whether that report goes out again. A note that is not marked belongs to the resume pass, and
while one exists the wake log never resends its id: that is how a report whose `intent` could not
be written stays with today's path and has one owner.

**At start, and when this host takes the lock over.** Only a loaded host that holds the team's
lock (`rt.holdsLock()`) reads, writes, rewrites or replays the log, and it checks the lock again
after each await before it writes or sends. A host that only reads the team does none of this. A
resume pass that failed or was stopped does not hold the replay back, since the two no longer
share a report. The pass covers only the reports the log held when this ownership began; a report
made since is this run's own. A report whose records include one of a later `v` is left alone:
this host cannot tell its state. Each check waits until that Session's agent is idle, so a
message DSH already claimed for a step (after a plugin reload, DSH went on) has reached its
`user/message` first. A worker report with no `prepared` gets one first: the reply at the
`intent`'s transcript position, else `unread`. For each other open report (an `intent` with no
`done` or `dropped`), in this order:

1. Its Bot is gone: `done` (`gone`).
2. A Session it was sent or moved to holds its `user/message` (read from the end of that
   Session's log back to the report's `at`, so the search is whole, not a fixed window): `done`
   (`taken`).
3. That Session's inbox still holds it (DSH keeps an inbox in the Session's log across a hard
   stop): nothing is sent again, and the host wakes that agent the way parts.js wakes a part with
   kept input, so the turn that takes it up runs and closes it.
4. A Session it went to exists but its log cannot be read: it stays open for the next start,
   with no record. A Session that no longer exists counts as not holding it.
5. Its `at` is more than 7 days old: `dropped` (`stale`). Expiry decides only a resend; a report
   found by steps 2 and 3 is closed or woken first.
6. It has two `attempt` records already: `dropped` (`attempts`), so a report that crashes the host
   cannot loop.
7. Otherwise it is sent again, `attempt` first, with the restart header: "DeepSeek Harness
   restarted before this report could reach you" (`task-done` has it today; delivery 0b adds the
   same for `report`, and delivery 1 for a worker report). It goes to the current Session of
   `returnRoomId` for that Bot, or to the Bot's own chat when that group or Session is gone,
   never to `roomId`'s Session unless the two are the same room. A worker report with `unread`
   says that the worker's reply could not be read.

What a turn took up is in the Session's log, and what still waits is in its inbox, so a report
that steps 2 and 3 do not find never reached the Bot, and sending it again cannot make the Bot
read it twice. The guarantee is bounded, and the RFC says so: a report is delivered late but
delivered, unless it is older than 7 days, or its first send and both resends are each cut by a
crash before the message was in the Session's inbox. Each drop writes one diagnostics line, and
removes the report's `inflight.json` note and settles its `work` so nothing waits for it (the
delivery plan picks the handoffs.js path, since `closeWork` may already have removed the child).
The same clean-up follows `done` (`discarded`) and `done` (`gone`). It is idempotent and runs again
at every start for each closed report that still has a note or a wait, so a crash between the
record and the clean-up only delays it.

A report's `intent` with no `sent` and no note at all, marked or not (its first send may not have
happened, or its note was lost in a coalesced `inflight.json` write), is treated as not sent. The replay runs
after the resume pass, so anything that pass sent is already in a Session's inbox or log, and
steps 2 and 3 find it.

When the `intent` is on disk but the producer's own save is not (a kill between the two), the
replay finishes the producer's change from the `intent` (the task gets the outcome its report
states, the delegated work is closed as the report closes it) and saves it before it writes the
report's `done`. A closed report keeps its `key` in a record with no text for 7 days, so a
producer that reaches the same completion again still finds it.

**Moves and withdrawals while the host runs.** parts.js writes `moved`, fsynced, before it
forwards a wake log message to the part that replaces its Session, and the new copy keeps the
`exchangeId`. A message the person stopped or withdrew gets `done` (`discarded`), fsynced. DSH
records a withdrawal and a shutdown's cancelling of an inbox the same way, so a kill between
DSH's record and that line cannot be told from a shutdown: such a report comes back once, marked
as resent. That is a residual this amendment accepts over losing a report.

**Several reports at once (amended 2026-11-20).** Each report goes into its Session as its own
message, in the order the reports were produced, exactly as task and group reports go today
(`followup`, one turn reads one report). Reports are not batched into one turn. Delivery 0b-2
tried it on DSH 0.2.2-rc.2 and found no safe way: DSH has no operation that admits several
messages into one turn atomically (a synchronous inbox-insertion listener can put other input
between them), and claiming several reports in one step changes what Stop, a clearing Stop and
withdrawing a queued message do to the ones still waiting, and can put a report behind later
input. Batching waits for a DSH operation that admits a set of messages at one turn boundary,
as one unit (asked of DSH outside this repository); delivery 1 decides then whether worker
reports use it. Amendment approved by the owner's delegate on 2026-11-20.

**As built in delivery 0b (#1827).** Where the code is narrower or more exact than the text
above: a group report's key is the post id alone (a post reports in one round); `moved` is best
effort (a failed write gives a diagnostics line and the forward goes on, and the replay also
searches the Bot's current Session and retained parts); `sent` is written once the message is in
the inbox; every close first finishes and saves the producer's change, and a receipt read from a
live Session counts only after its flush returns true; an unknown `kind` or event at `v: 1` is
left alone like a later `v`; an unreadable file turns intents off for that run; the team import
copies `wake.jsonl` but not rewrite leftovers; a message DSH claimed but did not record stays open
until the next start; the refusal covers every Bot's file tools and `apply_patch`, and searches
that name the file, while a folder walk over the team home is refused only with a private Bot
(the same exposure as `inflight.json`). Known residuals: a report removed by the sign-in guard and
cut by a crash before its `discarded` record can come back once; a clock rollback can hide a
receipt in an unrecorded retired part and give one resend.

**Retention.** A report is eligible for sending for 7 days after its `at`; expiry is checked
before any send, at start, and once an hour while the host holds the lock. The host rewrites the
file with only open reports, each with all of its records, plus a text-free record (`id`, `key`,
how it closed) for each report closed in the last 7 days, after the start pass, once a day while
it holds the lock, and whenever the file passes 1 MiB: the new file is written and fsynced, renamed
over the old one, and the folder fsynced where the system allows it; when the rename fails, it
goes on appending to the old file. A line that does not parse was never a record and is left out
of the rewrite; the records of a report that has one of a later `v` are copied as they are, and
that report is left to a host that reads that `v`. A report's text therefore stays on disk for
at most about 8 days while the host runs; time it is off, or a rewrite that fails, can delay
that. Deleting a Bot writes `done` (`gone`) for its open reports.

**Who reads it.** The team's host is the only supported reader. No route serves it, and the
client, Pocket and other plugins never read it. The file and the rewrite's new file are refused to
every Bot's file and search tools whatever the roster, not only through private-bots.js
`sharedFiles` (which applies only while a private Bot exists). Diagnostics lines name the Bot,
the kind and the id, never the text. A Bot's shell running as the same account can still read the
file, as it can `state.json` and `inflight.json` (private-bots.js says its shell checks are not
isolation). No delivery closes that today; it is a residual risk this amendment keeps, recorded
in the threat model.

**When it fails.**

- An `intent` that cannot be written or fsynced (a full disk, a read-only home): a host that
  holds the lock still delivers the report as today, through an unmarked `inflight.json` note
  that the resume pass owns, with one diagnostics warning. Only that report loses this log's
  guarantee; the log never holds a first send back.
- An `attempt` that cannot be written: that resend is not sent, and the report stays open.
- A line cut by a kill, or any line that does not parse, is not a record and is skipped, as in a
  ledger book. A file that cannot be read at all is left as it is, nothing in it is replayed, and
  a diagnostics line says so.

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

### Lead workers

Amendment of 2026-11-21. It writes in RFC 0030's Q8 answer, approved by the owner's delegate on
2026-11-19. Every worker above is of the kind `worker`. RFC 0030 needs a second kind for a seat
that runs for days, the Genie's hidden orchestrator, because a worker's cleanup and its wake on
every turn end do not fit it. That kind is `lead`. Everything above holds for a lead, except
these four rules from Q8:

- **Long-lived.** The automatic cleanup (Caps and cleanup) never removes a lead's terminal while
  its Bot exists. `code_stop` still ends a lead, as it ends a worker.
- **Outside the per-Bot cap.** A lead is not counted in the running workers per Bot. The per-team
  cap still counts it. It is one terminal under the Bot's grant and is metered like any start.
- **Its events never wake the Bot.** A worker's turn end, block, error or exit queues a report
  into the Bot's Session (Waking the Bot). A lead's do not. Only a mailbox row that RFC 0030's
  follower admits wakes the Bot for a lead, through the durable wake log, after the follower's
  checks (RFC 0030, The Genie's two seats and the mailbox). A lead that blocks, errors or exits
  shows it on its worker card and in `code_list` (delivery 2).
- **A send while it works is held, not refused.** If the lead is working, `code_send` does not
  refuse: the host holds the text, and when that turn ends it sends the text with
  `hc send --if idle`. `hc send --wait` is not this: it waits for the turn the send itself starts.

Q5 and Q6 (answered 2026-11-21) add:

- **One running lead per Bot.** A second `code_start` of the kind `lead` while the Bot's lead runs
  is refused, naming the one that runs (Q5).
- **Held sends (Q6).** Texts held for a lead are kept in order, at most 5 per lead; a sixth is
  refused, naming the five. Each is sent at the next idle, one per turn: the next one only after
  the turn the previous send started ends. Held texts are kept in the Bot's store, owner-only and
  never logged, and are sent after a host restart. `code_stop` drops them and says how many.
  `code_send` answers `held` with the text's place in line.

What stays as it is: a lead starts with `code_start` from the owner's allowlist of templates (Q2),
with the same labels (`automagik.bot`, `automagik.worker`), so the grant reaches a lead exactly as
it reaches a worker and never reaches the lead's own children. `code_send` to a blocked lead is
refused, as for a worker: the Bot never answers an approval (Approvals). A lead's permission
level follows Approvals.

Q8 left two choices open: how many leads a Bot may run (Q5), and what the host does with several
sends during one turn, a host restart while a text is held, and `code_stop` while a text is held
(Q6). Both are answered (Answers (2026-11-21)) and written in above.

### Caps and cleanup

- At most 3 running workers per Bot and 6 per team by default, settable by the owner. A start
  past a cap is refused with the running workers named. The per-Bot cap does not count leads
  (Lead workers).
- A finished worker's terminal is removed after its report is accepted and 24 hours pass, or at
  `code_stop`. A lead's terminal is not removed automatically; `code_stop` still ends it (Lead
  workers). The record (task, status, last reply) stays in the Bot's store.
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
- The worker kind (`worker`, `lead`) in `code_start`'s input and in `code_list`, and `held` with the
  text's place in line in `code_send`'s answer for a lead (amendment of 2026-11-21, Q6).
  Compatibility: new; a worker without a kind is a `worker`.
- Terminal label `automagik.worker=<workerId>`, beside RFC 0006's `automagik.bot`.
- Space prefix `automagik:` (RFC 0006's contract, kept).
- A worker report message kind in the Bot's Session.
- The durable wake log `wake.jsonl` in the team's home, records `v: 1` (`intent`, `prepared`,
  `attempt`, `sent`, `moved`, `done`, `dropped`), and the wake log's mark on its notes in
  `inflight.json`.
  Compatibility: new; an older host skips a record of a later `v` and never rewrites that file.
- The herdr-core grant scope (label-scoped run and terminal calls), filed upstream.

## Threat model

| Threat | Mitigation |
|---|---|
| A Bot reaches terminals it did not start, or Chat's seat | The grant is label-scoped in core, not in the plugin; Bots' shells stay masked (delivery H) |
| Prompt injection through a worker's reply | The reply is framed as data from a named worker; tags and claimed person-text are quoted |
| A Bot raises its own reach through a worker | No `send --force` in the grant; worker level never above the Bot's; the owner answers approvals |
| Runaway starts | Per-Bot and per-team caps; starts metered; the setting is off by default and owner-only |
| Work leaks to another machine | No `--on` until delivery 5 |
| Lost wake-ups across restarts | The durable wake log notes the intent, fsynced, before the producer marks its source finished, and resends it by its id |
| A report read twice | One owner per report (the resume pass skips the wake log's notes); a resend only when no Session it went to took it up or still holds it in its inbox |
| The log leaks a private Bot's report | Host-only reader, 0600, refused to every Bot's file tools; text out of diagnostics; closed reports leave at the next rewrite. Residual: a Bot's shell under the same account can read it, as it can `state.json` |
| A worktree with work in it is deleted | Removed only with no uncommitted changes and no unpushed commits |

## Deliveries

Each is one PR on one lane. The order is 0, 0b, 1, 1b, 2, 3, 4, 5. Deliveries 0 and 0b may ship in
either order; delivery 1 needs both.

- **0. The grant** (herdr-core, filed upstream from #628 and #631). *Check:* with the grant, `run`
  without the label, `exec`, and a send to an unlabelled terminal are refused, and a labelled
  run, read, send and kill work.
- **0b. The durable wake log** (plugin; amendment of 2026-11-19). `wake.jsonl` as defined
  above, with today's task and group reports as its first users (agents.js and both
  `reportRound` calls in groups.js). *Check:* a kill after the intent and before a turn takes the
  report up delivers it at the next start, and the Bot reads it once; a report still in the
  Session's inbox after a hard stop is not sent again, and the idle Bot is woken to read it; two reports for one Session
  and a second restart before either is taken still give one of each; a report a turn took up is
  never resent, and the resume pass never resends a wake note; a group report posted to one group
  from another goes back to the group it came from; a failed intent write still delivers; the
  file is refused to a Bot's file tools with no private Bot on the team. Merged as #1827. The
  batching it once planned as a second part (0b-2) is not built (Several reports at once).
- **1. The tools and the wake loop** (plugin, behind the setting). `code_start`, `code_send`,
  `code_read`, `code_list` and `code_stop`, and the report through the durable wake log.
  Needs deliveries 0 and 0b on dev.
  *Check:* a Bot starts a worker in a temporary core session, ends its turn, and is woken with
  its reply; a crash between intent and acceptance delivers the report once; every refusal in the tools
  table for the kind `worker` is tested (a lead's are delivery 1b's).
- **1b. Lead workers** (plugin, after delivery 1; amendment of 2026-11-21). The kind in
  `code_start` and `code_list`; no wake on a lead's events; the held send. RFC 0030's delivery 3b
  needs it, with deliveries 0 and 1. *Check:* a lead's turn end, block and exit queue no report
  into the Session while a worker's still do; a second running lead for the Bot is refused; a
  `code_send` while the lead works answers `held` with its place and is typed after that turn
  ends, with `--if idle`, one per turn, in order, also across a host restart; a sixth held text
  and a send to a blocked lead are refused; `code_stop` drops the held texts and says how many.
  Delivery 3 adds the cap and cleanup checks for leads.
- **2. The worker card and the sidebar pill** (plugin). *Check:* the card updates in place
  through working, blocked and done; Open in Code and Stop act on the right worker.
- **3. Caps, cleanup and worktrees** (plugin). *Check:* the fourth start for one Bot is refused;
  cleanup keeps a worktree with uncommitted changes; a lead is not counted in the per-Bot cap and
  is counted in the per-team cap; cleanup removes a finished worker and leaves a lead.
- **4. Approvals from the chat** (plugin, after herdr-core#122). *Check:* answering in the chat
  and in Code at once leaves one answer and one receipt.
- **5. Workers on linked machines** (plugin and herdr-core, after #206 and delivery H's link
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

## Answers (2026-11-21)

Approved by the owner's delegate on 2026-11-21, each with its recommendation (a), restated:

5. **Q5, leads per Bot:** one running lead per Bot; a second start is refused, naming the one that
   runs.
6. **Q6, held sends:** kept in order, at most 5 per lead (a sixth refused, naming the five), each
   sent at the next idle, one per turn; kept in the Bot's store (owner-only, never logged) and
   sent after a restart; `code_stop` drops them and says how many; `code_send` answers `held`
   with the text's place in line.

## Open questions

Q1-Q4 were answered on 2026-11-19 and Q5-Q6 on 2026-11-21 (Answers, above); all are kept as
asked.

1. **The Main Bot's default.** Recommended: off like every Bot, with a one-time offer in the Main
   Bot's chat the first time the owner asks for coding work.
2. **The worker's agent.** Recommended: Herdr templates from an owner-kept allowlist, Claude Code
   first. Not the Bot's own model route, because the worker is a full coding agent.
3. **A DSH-native subagent card** (RFC 0006's provider) versus our own chat row. Recommended:
   our own row first, through RFC 0023's chat tail slot; ask DSH for a subagents provider hook
   later.
4. **Default caps.** Recommended: 3 per Bot and 6 per team, matching the shared Mac's limit on
   busy processes.
5. **How many leads a Bot may run.** RFC 0030's Q8 puts a lead outside the per-Bot cap, which
   leaves no per-Bot limit (the per-team cap still counts it). (a, recommended) One running lead
   per Bot: a Genie has one orchestrator, and a second start is refused naming the one that runs.
   (b) One per Bot and folder, for a Bot that leads several projects. (c) An owner-settable
   number, default 1.
6. **Sends held for a lead.** Q8 says a send while the lead works is held and sent when the turn
   ends. It does not say: (i) several sends during one turn; (ii) a host restart while a text is
   held; (iii) `code_stop` while a text is held; (iv) what `code_send` answers. (a, recommended)
   Sends are kept in order, at most 5 per lead (a sixth is refused, naming the five), and each is
   sent at the next idle, one per turn; held texts are kept in the Bot's store (owner-only, never
   logged) and sent after a restart; `code_stop` drops them and says how many; `code_send`
   answers `held` with the text's place in line. (b) One held text at a time, the next send while
   one is held refused; nothing kept across a restart. (c) Join all texts held during one turn
   into one send.

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
