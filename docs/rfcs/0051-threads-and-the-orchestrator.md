# RFC 0051: Threads and the Orchestrator

| Field | Value |
|---|---|
| Status | Proposed (depends on RFC 0050, #2176) |
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
wishes. The host resolves the caller from the Bot's own chat, its group Session or a
delegation Session it runs in. The opener owns the thread. Lookup searches only the
caller's threads that it may access. It checks for an ID match first, then a unique
exact title. Duplicate exact titles return `thread/ambiguous` with the matching IDs
from that same set in ID order. Other Bots' threads and unknown threads return
`thread/not-found`. Owner and chief UI visibility follows RFC 0050. That visibility
gives no broader Bot tool lookup or stop scope.

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
shows recent transcript entries as `[said] …` or `[tool] name`. In a delegation,
the result, summary and last lines stay within the origin caller's carried read
scope and the current reader's scope. Withhold content when that intersection
cannot be proven. A `bot-dm` read uses the recorded requests and replies. Reading
never wakes a Session.

**`message_thread`** steers at the next step with `now` or adds a follow-up after
current work with `queue`. Helpers and wishes receive Bot-authored instructions in
their Session. A member delegation opens new work for the same Session and appends the
exchange ID. On a member delegation, every Bot follow-up checks the caller's
current Orchestrator role and `task-start` grant before delivery, including queued
delivery and reopen. The refusal is `thread/no-role` or `thread/no-grant`.
Losing either still allows `read_thread`, `list_threads` and `stop_thread` under
their usual access rules. A `bot-dm` uses the same joined-request rules as
`message_bot`.
The reply is one of:

- `Delivered to thread "${title}" while it works: it reads your message at its next step. Its result comes back to you as a message.`
- `Queued in thread "${title}": it reads your message after its current work.`
- `Reopened thread "${title}" with your message (round ${n}). Its result comes back to you as a message; do not wait or poll.`

**`stop_thread`** cancels live work in a Session, then the turn end records `stopped`.
If the thread is open and idle, it records `stopped` directly. A `bot-dm` abandons the
associated work exchange. When a member delegation is stopped with a reason, the reason
is delivered to that Session only while it can still receive messages. It returns
`Stopped thread "${title}" (${id}).` An already ended thread returns `thread/ended`.

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
| `thread/ambiguous` | `More than one thread is titled "t". Use one of these IDs: …` |
| `thread/ended` | `Thread "t" has already ended (status).` |

### Helper compatibility

`start_task` keeps its inputs, approval card, and byte-for-byte success and
refusal texts in the plugin release that introduces the thread tools. The alias
ends in the following plugin release. It invokes the same helper path as
`delegate` and is hidden wherever `delegate` is visible. It remains a shell
launcher. `delegate` is available with
Terminal off, and its helper branch checks the calling Bot's Terminal switch before
admission. A helper may run on an agent CLI route whose tools run outside DSH's sandbox.
A managed member Session instead runs under that member's switches and within the
caller's effective ceiling.

The helper path keeps the existing admission checks, including permission and route
checks, and runs on the caller's model by default. The internal `rt.startTask` method
continues to return a Session ID for plugins. It can take optional
`thread: { kind: 'helper' | 'wish' }`. Default to `wish` for callers holding Genie and
`helper` otherwise. `message_bot` keeps its conversational behavior and directs
Orchestrator Bots to `delegate` for work that should run on its own.

## A member's Session and the caller's ceiling

A member delegation creates a fresh root DSH Session in the member's folder, with the
member's model, identity, instructions, reviewed skill snapshot, role prompts and tools.
A durable `state.tasks` binding records the member, opener, origin group if any, parent
task if any, and the admission proof. The Session index restores `taskOwners` with
the member's ID and `thread: true` from that binding and cross-checks any display record.
Prompt, tool registration, scheduling, permission guards and resume resolve the Session
as the member. A missing or inconsistent binding holds work, including on startup
and ACP replay. A thread row supplies display and reporting metadata.

The host applies the existing `message_bot` target checks for self, private, unavailable
and upstream Bots. For a direct or inherited group origin, both opener and worker must
be current members. Their roles and positions grant no exemption. The host binds the
caller's existing read scope to the delegation before sending the first brief. That
scope still applies through retained views, follow-up, nested work and restart. All
reads also honor the worker's current scope and any narrower scope of the current turn
or viewer. The parent transcript and the member's other conversations retain their
existing read rules.

For a group-origin delegation, the Session uses the narrower of the member's own allowed
level and the existing effective permission ceiling of the originating group call.
Use the authenticated calling Session and its live effective level, current group
restrictions, and any inherited task or delegation ceiling. Keep the original opener
ceiling as an upper bound. A group's saved preset alone, the caller's saved Bot level,
and the member's ordinary chat level each omit part of the decision. A role grant, a
wider group setting, or a wider member setting confers no wider access. Apply the
existing route and CLI guards to the resulting level before any brief runs.

Persist the provenance and ceiling through the existing task-permission machinery
before dispatch, independently of the report's destination. Save each narrower
effective level as a cap before continuing work or detaching lineage. A later
wider room, caller, member or parent setting never restores authority removed by
that cap. Nested work inherits the parent's narrowed cap and the origin ceiling.
Reapply the saved cap and current narrower bounds before restart, replay and
reopen, including a round started by the person. If the host cannot prove, persist
and apply the bound, it holds execution. The saved task lineage and the
effective-level check govern authority after rehydration.
[Existing task-permission mechanisms](../../apps/bots-dsh/src/host/permissions.js)

### Reviewed skill pins

At the first brief, the host snapshots the member's reviewed skills from its
validated own or group Session under the worker rule. Persist the names, pinned
hashes and first brief's message ID with the task binding. A validated root with
no pins to supply records an explicit empty snapshot. Retry, resume, reopen and
ACP replay use the same pins. Caller-only and later-added skills stay out.
Removing or revising an assignment stops future loads of the affected pin.
Existing load blocks, worker masks, membership checks and revision and hash
checks apply at load and replay. Missing or stale snapshot provenance holds the
Session. The member's ordinary chat catalog supplies no replacement.
[RFC 0049](0049-skills-for-bots.md#workers-inherit)

### Membership and deletion

Removing the opener or member from the origin group, deleting that group, or
deleting either Bot holds the delegation and descendants that inherit its binding.
The host rechecks membership and saved lineage before new turns and tool steps,
queued or immediate delivery, `message_thread`, a person reopen, and a report or
wake to the group. Persist the hold before dropping the group Session or other
live link, so a retained Session, retry or restart cannot bypass it. Keep the
narrower cap with `capTasks` and use `reapplyTasks` for the bound work. Room and
Bot deletion keep the existing cap-and-reapply behavior. The delegation keeps
its origin and member identity. Its result has no private-chat fallback.

Membership removal already pauses new schedules for the removed member and drops
its group Session. Hold new work and release of results at admission boundaries.
Whether the host should immediately cancel work already admitted is open below.

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
`state.threadsMigrated = 1` marks a completed conversion. Save the copied records
and marker together. A retry preserves already present thread records and the
pre-migration backup. It maps the original Session ID, opener, title, status,
timestamps, progress and summary, starts at round one, and derives depth from legacy
task lineage. Genie tasks become wishes, using the migrated role or its legacy
mapping. Use `reportRoomId ?? roomId` to place the thread, using the opener's group
Session when available, otherwise its chat. Legacy rows whose opener is gone still
appear under Tasks.

`state.tasks` keeps the permission lineage of helpers and wishes and the durable
binding of member delegations. Existing safe pruning rules apply. Evicting a display
row leaves any task binding that the Session or a descendant still needs. One writer
changes thread status and mirrors it into any matching task record, whose readers
use status in permission decisions. The channel serves
`roster.threads` for the new views alongside `roster.tasks` for Genie and older
clients. Thread UI, tools and reporting read the thread record.

`message_bot` records a `bot-dm` thread when an exchange outside a group owes a reply.
A joined request reuses its thread. Group posts and `reply_to: "user"` or `"none"`
create no thread. Closing the active exchange records `done` with a summary,
abandoning it records `stopped`, and deleting a participant records `failed`.
An admitted `message_thread` follow-up after close keeps `x:<first exchangeId>`,
appends its new exchange ID and increments the round. A join while the exchange
is active reuses the exchange and round. An older exchange event cannot close the
new round. `call-handoff` is reserved for a later Voice delivery.

## Rounds and reporting

The Session event listener updates progress and last activity. The first terminal
event for a round records its result and ends that round. Messaging an ended thread
reopens it with the next round number. A message from the person in the pane or the
full conversation is a person round. Track origin explicitly for the send route
and recognize native user input at turn start without treating host-delivered
instructions as the person's input. Person rounds update status, summary and end time
and answer in the thread. They send no parent report and wake no parent Bot.

A Bot-started round returns one result to the parent conversation while report
admission holds. Group work returns to its original group. Helpers and wishes
deliver `thread-done` with the thread ID and the legacy `taskSessionId`. Member
delegations and Bot DMs keep their `reply` envelope and add `threadId` from the
associated exchange. Work completion and the turn-end reporter agree on one result
per round. Session-backed reports use the durable `thread-report` wake intent keyed
by `thread:<id>:<round>`. A migrated task's round one keeps its legacy
`task-report` kind and `task:<id>` key, including when the old intent is already
pending or has completed. It never writes `thread:<id>:1`. Bot DMs have no Session
wake key and use exchange deduplication. Replay checks current report admission and
deduplicates any outstanding delivery.

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

On the native path, the tab kind is `botthread`, with resource address
`dsh-resource://botthread/thread/<id>` (the ID is URL-encoded). Opening the tab
selects the parent conversation and closes the plugin drawer. The resource
retains the root Session by string ID and releases it on close or loss of
access. A Session provider binds `sidebar.chat.conversation` to that Session.
The header shows the title, member and state, with Stop, Open full and Back to
anchor. A `bot-dm` thread shows the stored exchanges by ID and an Open chat link.
The pane displays those exchanges read-only.

**Composer check, 2026-11-28.** The installed Automagik 3.178.0 bundle identifies DSH
as `0.2.2-rc.2`. Its installed `@deepseek-ai/dsh-client-ui-subagent` package is also
`0.2.2-rc.2`. In its `lib/client.js`, `SidebarChatTab` supplies a Session reference
to `sidebar.chat.conversation`. `ConversationSlotPanel` invokes
`conversation.content` with `variant: 'embedded'`. The installed
`@deepseek-ai/dsh-client-ui-conversation` declares `conversation.composer` and
`conversation.composer.bar` in that factory and renders the stock composer bar.
The subagent composer's read-only replacement selects only `one-shot` and `unknown`
subagent addresses. The installed subagent plugin declares the embedded slot as a
child of its own `sidebar.right.pane.tab` registration. The offline probe covered
that plugin's Session reference, the embedded factory call and the composer selector
with a root Session and the two read-only modes. Composition inside a bots-dsh
`botthread` tab remains unverified.

**`composer: unverified`.** A read-only accessibility check found the ordinary
message field. No Cordis inspector was exposed there, and the installed
`cordis_inspect_query` tool requires an Agent-backed Session. Both live checks
remain pending. Group 5 ships the drawer unless its PR records live proof in an
isolated GUI: run `client` `Slots.listSubTree` for `sidebar.chat.conversation`
and `factory:conversation.content` with a root Session open in the bots-dsh
`botthread` tab. Verify that the composer can send and that retaining the root
Session obeys the access and admission rules below.

The fallback opens a `BotPanel` view named `'thread'` in
`src/client/browser-pane.js`. It opens the drawer over the selected parent
conversation and preserves the anchor and controls. Its composer posts to
`thread-say`. Thread cards and result links target the stable thread ID through
the app's open action on either path. The DSH tab kind and resource address are
reserved on the drawer path and become public when native support ships.

### Person access and turn admission

The authenticated person must be allowed to see the parent Bot and, for group
work, the origin group under RFC 0050. The host also checks the person's current
authority for the requested read or write. In a multiuser instance, use the
verified caller principal carried by the existing channel or DSH prompt path.
The effective read scope intersects that principal's scope with the carried
origin scope and member scope. Enforce this on the host before retaining,
opening or replaying the Session and when serving retained content. A thread
or retained Session ID supplies no authority. If access to the conversation
is lost, clear its retained content and release the resource.
[RFC 0038](0038-cloud-multiuser-caller-principal.md)

The authenticated channel adds two writes. `thread-say { threadId, text }`
sends to a Session-backed thread as the person with `when: 'now'`.
`thread-stop { threadId }` stops the work. Both enforce current access and return
`{ ok: true, text }` on success or `{ ok: false, code }` on refusal. Missing or
inaccessible threads use `thread/not-found`.

At turn start, native pane input and Open full input pass the same host checks
as `thread-say`: authenticated person access, current membership, saved caller
read scope and a reapplied effective permission bound. Recheck queued input at
admission too. A failed check holds the turn before work starts and makes the
composer read-only for a viewer who can still see the thread. Only admitted
input reopens an ended thread, as a person round. The membership hold still
allows an otherwise authorized stop. It prevents delivery of a stop reason into
a held Session.

## Contracts introduced

| Surface | Compatibility |
|---|---|
| `state.threads` (Thread v1), `state.threadsMigrated = 1` | Populate additively from `state.tasks`. Keep task authority and older task records usable. The marker is written with the converted records. A repeat adoption leaves converted and newer records in place. |
| `roster.threads`, `taskOwners.thread: true` | Keep `roster.tasks` for older clients. Restore the in-memory ownership marker from the durable delegation binding. A display record alone conveys no authority. |
| `thread-report`, `thread:<id>:<round>` | Session-backed reports deduplicate by round. Keep support for legacy `task-report` intents and `task:<id>` keys, including migrated round one. Bot DMs keep exchange deduplication. |
| `thread-done`, `threadId` on `reply` | Readers still accept `task-done` and keep `taskSessionId` on the task result. Ordinary replies retain their shape and accept the optional ID. |
| `thread-say`, `thread-stop` | Add authenticated routes. Existing routes and clients keep their inputs. The native composer shares the send route's admission rules. |
| `botthread`, `dsh-resource://botthread/thread/<id>` | Reserved until the native path ships. The drawer path keeps the same thread IDs and in-app links. |
| `delegate`, `list_threads`, `read_thread`, `message_thread`, `stop_thread`, `thread/*` | Add the tool IDs and refusal codes above. Keep `start_task` and its texts for the release that introduces them. `message_bot` keeps its existing inputs and replies. |
| `rt.startTask` option `thread` | Existing plugin calls keep their inputs and Session ID result. The optional kind selects a helper or wish. |

## Threat model

- **Member Session.** A Bot may try to move group work into a wider member
  Session, or regain scope after a permission change, restart or eviction.
  Authenticate the caller, bind the member and origin before dispatch, and
  keep the saved caps, read scope and skill pins through every nested run and
  replay. Treat a missing or inconsistent binding as a hold.
- **Thread reads and writes.** A caller may supply another Bot's ID or an
  ambiguous title, or keep a pane open past a membership change. Filter lookup
  and progress by current authority and carried read scope. Authenticate the
  person on every write and enforce the same rules for the native composer
  and for Open full. Recheck authority at the turn or replay boundary.
- **Reports and reopened rounds.** An old wake intent or exchange may be
  replayed after the origin changes. Recheck origin and membership before
  releasing a result, deduplicate by the original key or exchange, and mark
  input as person-authored only from the authenticated person path.

## Delivery and acceptance

1. Add the thread model, idempotent migration, status writer, routes and durable reports.
2. Run delegation Sessions as the member and surface Bot DMs. Exercise a wider
   member in a restrictive group, nested work, restart, reopen and ACP replay.
   Lower the room, caller or member bound and then raise it. Remove either
   participant, delete the room and delete either Bot. Verify that the hold and
   narrower cap survive restart, that new work and group reports stay held, and
   that a missing binding prevents a turn or tool step. Exercise failed save and
   apply before the first brief. Prove the member's prompt, tool switches, schedule
   restrictions and skill pins still apply after revision, removal and replay.
   Verify a Bot DM follow-up after close keeps the original ID.
3. Add the tools and compatibility alias. Exercise an Orchestrator member with another
   role, a Terminal-off caller delegating to a member versus a helper, role and
   grant loss between queue and delivery, scoped ID and title lookup, and unchanged
   `start_task` success and refusal text and approval card.
4. Add rows, result links, the pane and locale strings. In a live installed build, show
   one working delegation and its composer, one parent report and a person round that
   answers only in the thread. Revoke access while the pane is open and check the
   pane, Open full and host route against the same hold. Verify that a Genie wish
   appears once and older task state still loads.

All implementation deliveries are plugin-lane changes. Voice handoff creation and
team-leader stop scope, group routing and any replacement of task permission lineage
are separate decisions.

## Rollback

Before each shipping delivery, keep a coherent pre-upgrade checkpoint of team
state, Sessions and wake/exchange records. Keep the backup-first role migration
backup and each later checkpoint under distinct names. A retry must leave the
last usable checkpoint intact. Verify the restore in a scratch profile before
using it on the live team.

| Delivery | Rollback |
|---|---|
| Thread model and migration | Stop dispatch before downgrade and retain the upgraded state and Session archive. A pre-thread runtime ignores the additive thread map, marker and view for behavior and still reads its compatible `state.tasks`. Restore the matching checkpoint if it would encounter pending thread-format intents. Preserve legacy wake receipts so restored tasks do not report twice. |
| Member Sessions and Bot DMs | Hold delegated Sessions and their queued work before moving to a runtime that cannot enforce their durable bindings. Restore the matching prior checkpoint for execution. Keep newer delegation transcripts and exchange history in the upgraded archive with their original access restrictions. A downgrade cannot resume a delegation as an ordinary member chat. |
| Tools and alias | Restore the prior host tool set with its matching client. Keep the task lineage and existing compatibility path. Pending W2-only calls stay held while their tool is unavailable. |
| Client surfaces | Restore a compatible client bundle. It can use the existing task view during a client-only rollback while the host retains thread state and reports. Keep the thread IDs and anchors for a return to the newer client. |

## Open questions

1. **Must membership loss immediately cancel work that has already passed
   admission?** Recommended for W2: hold all new steps, sends and reports on
   revocation, and leave the behavior of already admitted operations to the
   existing cancellation path. An immediate cancel policy would also signal
   a running turn or external tool at the time revocation is observed. Fable's
   decision is pending before final acceptance. The restart and admission
   hold applies under either answer.

## Links

- [RFC 0050 proposal (#2176)](https://github.com/automagik-si/automagik/pull/2176)
- [RFC 0037, role capabilities](0037-roles-not-types.md#contracts-introduced)
- [RFC 0038, authenticated caller principal](0038-cloud-multiuser-caller-principal.md)
- [RFC 0048, prior Solver and task grant contract](0048-the-solver.md)
- [RFC 0049, reviewed worker skills](0049-skills-for-bots.md#workers-inherit)
