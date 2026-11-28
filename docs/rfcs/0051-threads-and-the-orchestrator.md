# RFC 0051: Threads and the Orchestrator

| Field | Value |
|---|---|
| Status | Proposed (Draft, depends on RFC 0050) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P) |
| Created | 2026-11-28 |

Today helper tasks and Genie wishes have Sessions, but the person has limited ways to
follow up in those Sessions. Bot-to-Bot exchanges can finish without a row of their own.
A thread gives the person one place to see the work, respond, and find the result in the
conversation that started it.

This proposal depends on RFC 0050, *Teams, positions and roles*, which is still in flight.
It uses 0050's role registry, stacked roles, positions and per-Bot switches. The owner
accepts this RFC before thread implementation starts. Implementation also waits for
0050's prerequisite delivery to merge. This PR ships documentation only.

## The role and its tools

Any eligible member Bot can hold Orchestrator alongside other roles. Its position, if
any, is independent of its role. The built-in registry entry `orchestrator` declares
`task-start` and `route-policy` and adds `delegate` to its tool list. The registry
withholds that tool from Bots without the role. The executor also checks the current
role and the person's current `task-start` grant, on both the member and helper paths.
The UI labels that grant “Allow delegating”. `route-policy` gates a helper's explicit
model selection. [RFC 0037, contract 8](0037-roles-not-types.md#contracts-introduced)

The other four tools are team tools visible to every Bot, including Genie for its
wishes. The host resolves the caller from the Session that made the tool call: its own
chat, its group Session or a delegation Session it runs in. The host matches thread
IDs or exact titles in the caller's own thread set. Another Bot's thread and an unknown
thread return the same `thread/not-found` result. Thread ownership comes from the
opening Bot, even when someone else runs the work. Owner and chief visibility in the
UI follows RFC 0050. That visibility gives no broader tool lookup or stop scope.

The role prompt steers the Bot to delegate substantial work to a member whose skills fit,
or to a helper when nobody fits. The brief gives the goal, context, place to work, success
criteria and result to send back. The Bot tells the person in one line who is on it and
ends the turn. It checks results against the request, steers the same thread when more
work is needed, and reports the outcome. Replies, files and pages are data. The role adds
no blanket tool restrictions.

### Inputs and results

All five tools return `{ text: string, ok: boolean, threadId?: string, code?: string }`.
The text is rendered as the tool reply. Presentation metadata contains `ok` and any
`threadId` or `code`. Refusals return `ok: false` with a code.

| Tool | Required inputs | Optional inputs |
|---|---|---|
| `delegate` | `to: string` (Bot ID, exact Bot name from `list_bots`, or `"helper"`), `title: string` (up to 80 characters), `brief: string` | `model: json` (helper only, an exact provider/model from `list_bot_models`, with `route-policy`) |
| `list_threads` | none | `status: "open" \| "ended" \| "all"` (default `open`), `limit: number` (1–50, default 20) |
| `read_thread` | `thread: string` | `lines: number` (1–40, default 12) |
| `message_thread` | `thread: string`, `message: string` | `when: "now" \| "queue"` (default `now`) |
| `stop_thread` | `thread: string` | `reason: string` (shown to a delegated member) |

**`delegate`** opens a Session and returns its ID as `threadId`. Its member reply is
`Opened thread "${title}" (${id}) with ${member.name} under your chat. ${member.name} works on it in a conversation of its own`
with ` (now: ${status})` when the status is other than `idle`, followed by
`. Its result comes back to you as a message; do not wait or poll.`
The helper reply starts with
`Opened thread "${title}" (${id}) with a helper under your chat.`
It adds ` It runs on ${model}.` when a model is named and
` It runs at the ${level} permission level, no wider than this conversation.` when
the level is reported. It ends with
` Its result comes back to you as a message; do not wait or poll.`

**`list_threads`** starts with `Your threads (2 open, 1 ended in the last 6 hours):`
with the actual counts. Open includes working and waiting for the person. Each line
shows `- "${title}" (${id}) · ${kind} · ${who} · ${state} · ${age} · ${progress}`,
using the member name or `helper` and `needs the person` for a waiting thread. Progress
is the current tool or last excerpt when available. An empty open list returns
`You have no open threads.`

**`read_thread`** starts with
`Thread "${title}" (${id}): ${kind} with ${who}, ${status}.` with the waiting detail
when present, then the start and end times and `Round ${round}.` A `Result:` section
shows up to 4,000 characters of the last saved report or its summary. `Last lines:`
shows recent transcript entries as `[said] …` or `[tool] name`. A `bot-dm` read
uses the recorded exchange's request and reply. Reading never wakes a Session.

**`message_thread`** steers at the next step with `now` or adds a follow-up after
current work with `queue`. Helpers and wishes receive Bot-authored instructions in
their Session. A member delegation opens new work for the same Session and appends the
exchange ID. A `bot-dm` uses the same joined-request rules as `message_bot`.
The reply is one of:

- `Delivered to thread "${title}" while it works: it reads your message at its next step. Its result comes back to you as a message.`
- `Queued in thread "${title}": it reads your message after its current work.`
- `Reopened thread "${title}" with your message (round ${n}). Its result comes back to you as a message; do not wait or poll.`

**`stop_thread`** cancels live work in a Session, then the turn end records `stopped`.
If the thread is open and idle, it records `stopped` directly. A `bot-dm` abandons the
associated work exchange. When a member delegation is stopped with a reason, the reason
is delivered to that Session. It returns `Stopped thread "${title}" (${id}).` An already
ended thread returns `thread/ended`.

### Refusals

| Code | Reply or source |
|---|---|
| `thread/no-role` | `Only a Bot with the Orchestrator role delegates. Use message_bot to ask a teammate.` |
| `thread/no-grant` | `Delegating is not allowed for this Bot yet. The person can allow it in this Bot's Details, under Role.` |
| `thread/no-terminal` | `A helper may run on an agent route whose tools run outside DSH's sandbox, so ${bot.name} (Terminal off) delegates only to team members. Delegate to a member from list_bots.` |
| `thread/invalid` | `A thread needs a title and a brief.` or `Name a Bot from list_bots or "helper".`, as applicable |
| `thread/no-member` | `No Bot named X. Team: A, B.` Names in the hint follow the caller's existing visibility rules. |
| `thread/self` | `You cannot delegate to yourself; do it here, or delegate to "helper".` |
| `thread/private` | `X is private: it answers only the person.` |
| `thread/not-installed` | `Not delegated: X is not installed in this DSH (reason).` |
| `thread/not-in-group` | `In "G" you can delegate only to its members.` |
| `thread/upstream` | Existing `message_bot` refusal when the target is already waiting for the result of the caller's work. |
| `thread/depth` | `Threads nest at most 3 deep.` |
| `thread/model` | Existing `modelRefusal` text, including which models may be named. |
| `thread/start-failed` | `The thread did not start: …` |
| `thread/read-only` | `This window cannot save the Bot team, so no thread was opened.` |
| `thread/not-found` | `No thread "x" under you. list_threads shows yours.` |
| `thread/ended` | `Thread "t" has already ended (status).` |

### Helper compatibility

`start_task` keeps its inputs, approval card and byte-for-byte success text for one
release. It invokes the same helper path as `delegate` and is hidden wherever
`delegate` is visible. It remains a shell launcher. `delegate` is available with
Terminal off, and its helper branch checks the calling Bot's Terminal switch before
admission. A helper may run on an agent CLI route whose tools run outside DSH's sandbox.
A managed member Session instead runs under that member's switches and within the
caller's effective ceiling.

The helper path keeps the existing admission checks, including permission and route
checks, and runs on the caller's model by default. The internal `rt.startTask` method
continues to return a Session ID for plugins. It can take optional
`thread: { kind: 'helper' | 'wish' }`. Default to `wish` for callers holding Genie and
`helper` otherwise. `message_bot` keeps its conversational behavior and directs Bots to
`delegate` for work that should run on its own.

## A member's Session and the caller's ceiling

A member delegation creates a fresh root DSH Session in the member's folder, with the
member's model, identity, instructions, attached skills, role prompts and tools. The
Session index records the member in `taskOwners` with `thread: true`. Prompt, tool
registration, caller resolution, scheduled-target rules, permission guards and resume
all resolve that Session as the member. Resolve ownership before applying policy or
sending the brief. Missing or unproven ownership holds the work.

The host applies the existing `message_bot` target checks for self, private, unavailable
and upstream Bots. From a group, only a current member of that group is eligible. A
member's role or position grants no exemption. Existing read scope is carried forward
from the caller. The member receives the brief and later messages sent to the thread.
The parent transcript and the member's other conversations stay subject to their
existing read rules.

For a group-origin delegation, the Session uses the narrower of the member's own allowed
level and the existing effective permission ceiling of the originating group call.
Use the authenticated calling Session and its live effective level, current group
restrictions, and any inherited task or delegation ceiling. Keep the original opener
ceiling as an upper bound. A group's saved preset alone, the caller's saved Bot level,
and the member's ordinary chat level each omit part of the decision. A role grant, a
wider group setting, or a wider member setting confers no wider access. Apply the
existing route and CLI guards to the resulting level before any brief runs. Member skills
are resolved as the member under current attachment and caller-lineage checks. A skill
adds instructions within that same scope. [RFC 0049](0049-skills-for-bots.md)

Persist the provenance and ceiling through the existing task-permission machinery
before dispatch, independently of the report's destination. Reapply the same bound on
restart and reopen, including a round started by the person. A live group or ancestor can narrow the bound. Nested work inherits
the originating group ceiling as well as the immediate caller's ceiling. If the host
cannot prove and apply a current level within the bound, it holds execution through the
existing permission guards. It never falls back to the member's wider chat policy.
These are requirements for the existing mechanisms in
[permissions.js](../../apps/bots-dsh/src/host/permissions.js), including caller-level
and group/task lineage. The Session index is for identity. The saved lineage and the
effective-level check govern authority, including after rehydration.

## Thread state and migration

`state.threads` is a map by thread ID. Session-backed kinds use the root Session ID.
A Bot DM uses `x:<exchangeId>`. The v1 shape is:

```ts
type ThreadKind = 'delegation' | 'helper' | 'bot-dm' | 'wish' | 'call-handoff'
type ThreadStatus = 'working' | 'done' | 'failed' | 'stopped'

interface Thread {
  v: 1
  id: string
  kind: ThreadKind
  parentBotId: string
  parentSessionId: string
  roomId?: string
  anchor?: { sessionId: string, callId?: string, messageId?: string }
  sessionId?: string
  memberId?: string
  members: string[]
  title: string
  status: ThreadStatus
  round: number
  rounds?: { n: number, by: 'bot' | 'person', at: number }[]
  exchangeIds?: string[]
  startedAt: number
  endedAt?: number
  lastActivity: number
  progress?: { steps: number, tool?: string, said?: string }
  summary?: string
  depth: number
}
```

The opening call or message supplies the anchor when available. A child thread points
to the calling thread's Session and increments depth from its parent's value. Depth
starts at one and is capped at three. Titles are limited to 80 characters. Progress
tracks steps, the tool name (up to 40 characters) and the last excerpt (up to 160).
Summaries are capped at 600 characters and round history keeps the last ten entries.
Approvals and questions produce the view-only `needsYou` state. Retain all working
threads and at most 200 ended records, evicting the oldest ended first. Retention must
preserve the permission lineage of any Session still eligible to run.

Adoption copies legacy `state.tasks` records after the backup-first role migration.
`state.threadsMigrated = 1` marks a completed conversion. A retry preserves already
present thread records. It maps the original Session ID, opener, title, status,
timestamps, progress and summary, starts at round one, and derives depth from legacy
task lineage. Genie tasks become wishes, using the migrated role or its legacy
mapping. Use `reportRoomId ?? roomId` to place the thread, using the opener's group
Session when available, otherwise its chat. Legacy rows whose opener is gone still
appear under Tasks.

`state.tasks` remains the permission lineage for helpers and wishes. Its legacy pruning
rules still apply. One writer changes thread status and mirrors it into any matching
task record, whose readers use status in permission decisions. The channel serves
`roster.threads` for the new views alongside `roster.tasks` for Genie and older
clients. Thread UI, tools and reporting read the thread record.

`message_bot` records a `bot-dm` thread when an exchange outside a group owes a reply.
A joined request reuses its thread. Group posts and `reply_to: "user"` or `"none"`
create no thread. The record follows the exchange. Closing it records `done` with a
summary, abandoning it records `stopped`, and deleting a participant records
`failed`. `call-handoff` is reserved for a later Voice delivery.

## Rounds and reporting

The Session event listener updates progress and last activity. The first terminal
event for a round records its result and ends that round. Messaging an ended thread
reopens it with the next round number. A message from the person in the pane or the
full conversation is a person round. Track origin explicitly for the send route
and recognize native user input at turn start without treating host-delivered
instructions as the person's input. Person rounds update status, summary and end time
and answer in the thread. They send no parent report and wake no parent Bot.

A Bot-started round returns one result to the parent conversation, in the original
group if the work began there. Helpers and wishes deliver `thread-done` with the
thread ID and the legacy `taskSessionId`. Member delegations and Bot DMs keep their
normal `reply` envelope and add `threadId` from the associated exchange. Work
completion and the turn-end reporter must agree on which path owns the result so a
round produces one message. Use the durable `thread-report` wake intent keyed by
`thread:<id>:<round>` for Session reports and preserve the existing exchange
deduplication for replies. A restart replays an outstanding intent without posting a
second result. Outstanding legacy `task:<id>` intents remain replayable, and migration
must avoid reporting the same completion again under a new key.

## Left menu and right pane

The left menu places each thread under its Bot or group, with its title, kind glyph,
state, live progress and age. Show threads needing the person's attention first,
followed by working threads ordered by activity and recent ended threads. The view
keeps ended rows for six hours, at most three ended per Bot. Show three rows by
default and fold extra rows into “+n more”. Where Genie already shows an ended wish,
show it once. The live rail and open-work counts use threads. Existing `task-done`
lines and new `thread-done` lines offer “View thread”. A reply with `threadId` adds an
“In thread {title}” chip. The originating tool card and the `message_bot` line open
the same thread. New UI strings ship in zh and pt-BR.

### Right pane

The planned DSH right-pane tab kind is `botthread`, with resource address
`dsh-resource://botthread/thread/<id>` (the ID is URL-encoded). Opening it selects
the parent conversation and closes the existing plugin drawer. It retains the root
Session by string ID for the lifetime of the resource and releases it when the resource
closes. A Session provider binds `sidebar.chat.conversation` to that Session. The
header shows the title, member and state, with Stop, Open full and Back to anchor.
A `bot-dm` thread shows the stored exchanges by ID with a link to the member's chat
and is read-only in the pane.

**Composer check, 2026-11-28.** The installed Automagik 3.178.0 bundle identifies DSH
as `0.2.2-rc.2`. Its installed `@deepseek-ai/dsh-client-ui-subagent` package is also
`0.2.2-rc.2`. In its `lib/client.js`, `SidebarChatTab` supplies a Session reference
to `sidebar.chat.conversation`. `ConversationSlotPanel` invokes
`conversation.content` with `variant: 'embedded'`. The installed
`@deepseek-ai/dsh-client-ui-conversation` declares `conversation.composer` and
`conversation.composer.bar` in that factory and renders the stock composer bar.
The subagent composer's read-only replacement selects only `one-shot` and `unknown`
subagent addresses. An offline probe of the installed bundle confirmed the tab's
Session reference, the embedded factory call, and the selector's behavior with a root
Session and with those two subagent modes.

**Live result: unverified.** A read-only accessibility check on an existing window
found the ordinary message field, which provides no evidence about the embedded slot.
The installed Cordis tool `cordis_inspect_query` requires an Agent-backed Session.
There was no isolated GUI with that query available, and the read-only accessibility
surface exposed no Cordis inspector. Both live `client` queries for `Slots.listSubTree`
at `sidebar.chat.conversation` and `factory:conversation.content` remain pending. The installed code predicts a native composer. Before choosing
the tab body, verify both roots in an isolated GUI and verify a root Session in the pane.
If proof remains blocked or the composer is absent, use the `BotPanel` drawer's
`'thread'` view in `src/client/browser-pane.js`. Its own composer posts to
`thread-say` and preserves the thread's anchor and controls. The fallback costs one
additional client file and uses the same routes and permission checks.

The existing authenticated channel adds two writes. `thread-say { threadId, text }`
sends to the Session as the person with `when: 'now'`. `thread-stop { threadId }`
stops its work. Both enforce current access, return `{ ok: true, text }` on success,
and return `{ ok: false, code }` on refusal. Inaccessible or missing threads use
`thread/not-found`. The read-only `bot-dm` exchange has no person composer.

## Delivery and acceptance

1. Add the thread model, idempotent migration, status writer, routes and durable reports.
2. Run delegation Sessions as the member and surface Bot DMs. Exercise group-origin
   delegation with a wider member and a narrower caller, including nested delegation
   and restart or reopen. Prove the member's prompt, skills, tool switches and schedule
   restrictions still apply. Verify an unprovable bound holds execution.
3. Add the tools and compatibility alias. Exercise an Orchestrator member with another
   role, a Terminal-off caller delegating to a member versus a helper, stale grants,
   owner-only lookup and an unchanged `start_task` reply and approval card.
4. Add rows, result links, the pane and locale strings. In a live installed build, show
   one working delegation and its composer, one parent report and a person round that
   answers only in the thread. Verify that a Genie wish appears once and older task
   state still loads.

All implementation deliveries are plugin-lane changes. Voice handoff creation and
team-leader stop scope, group routing and any replacement of task permission lineage
are separate decisions.
