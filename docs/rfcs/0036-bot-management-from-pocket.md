# RFC 0036: Bot management from Pocket

| Field | Value |
|---|---|
| Status | In delivery (accepted 2026-11-19 by the owner's delegate, see Decided D1-D6; amends RFC 0015). Delivery 1 merged in #1780, #1789 and #1802. Delivery 2 merged in #1793, #1801 and #1832. |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), herdr (Pocket Link), pocket |
| Created | 2026-11-19 |

> Approved by Guga's delegation while the owner is away (19/11); the owner may amend on return.

## Summary

Manage a listed, shown project Bot of DSH from a paired phone. In order, Pocket reads, edits and
adds the Bot's own memory when the Bot is not private, lists its scheduled tasks and pauses,
resumes and renames them, then changes the Bot's name and model and shows its permission level.
Each applied write returns the affected state in the same reply. This amends RFC 0015, which
kept Bot settings and permission levels on the computer: approved by the owner's delegate on
2026-11-19, within the limits in Decided.

## Motivation

#1182 asks for a plan to manage Bots from Pocket. The DSH socket's current phone writes are
`send`, `interrupt` and `answer`, each bound to a subscribed chat. The management operations
target a Bot and can run with its chat closed (`apps/bots-dsh/src/host/pocket-socket.js:11-18`,
`apps/bots-dsh/src/host/pocket-socket.js:29-37`).

### Upstream reference

The local vendor snapshot `abfe3341ffa393d668be5cc6a643170c5f3d44cf` maps DS Bot v0.3.6's `ds-bot/`
to `apps/bots-dsh/`. Its commit message names Fei2411/DS-Bot at
`a66cc737cfb6c3d8a2597e748cded6cab1206dd3`, also recorded in `apps/bots-dsh/.upstream-sha` and
`apps/bots-dsh/VENDORED.md:76-80`. The tree contains:

- `abfe3341f:apps/bots-dsh/src/host/mobile.js:16-46` and `abfe3341f:apps/bots-dsh/src/host/mobile.js:401-411`
  advertise a version and capabilities and dispatch direct memory edits and adds.
- `abfe3341f:apps/bots-dsh/src/host/phone.js:58-70` forwards shared Bot endpoints and can include a
  requested `state` result when a successful call changes the team revision.
- `abfe3341f:apps/bots-dsh/test/mobile.test.js:135-153` and `abfe3341f:apps/bots-dsh/test/mobile.test.js:277-293`
  cover the handshake and direct memory edits, including the changed entries in the reply.

The same snapshot's shared host routes include `update-bot`, `memory-view` and schedule list,
create and delete (`abfe3341f:apps/bots-dsh/src/host/channel.js:347-349`,
`abfe3341f:apps/bots-dsh/src/host/channel.js:540-555`). The snapshot is absent from `dev` ancestry
and the three files are absent from the `dev` tree. The source SHA is corroborated by local
records. The original upstream commit and phone client are unavailable in this checkout, so the
client's exact calls and behavior remain unverified.

## Design

| Operation, in delivery order | Host work and phone reply |
|---|---|
| Memory: read, edit, add | Reuse the host's entry validation and mutation logic. Read and return only the selected Bot's own entries, and only for a Bot that is not private (D3). Omit `places` (all Bot and room names), unrelated scopes and summaries that combine them. The desktop panel returns that broader view today (`apps/bots-dsh/src/host/memory.js:1418-1444`, `apps/bots-dsh/src/host/memory.js:1501-1515`, `apps/bots-dsh/src/host/channel.js:852-862`). |
| Schedules: list, pause or resume, rename | Check task ownership against the selected Bot's current host binding. Add host pause/resume and rename endpoints using `service.edit`, as the internal pause already does. The host currently lists, creates and deletes, and its list spreads catalog entries for all known owners. Return an allowlisted list for this Bot with each task's title, state and timing and no prompt text (D4) and, after a write, the affected task's new title, state and timing. The phone reads timing but changes only the title and the paused state (D6) (`apps/bots-dsh/src/host/schedules.js:279`, `apps/bots-dsh/src/host/schedules.js:469-509`). |
| Settings: name and model; level shown (D2) | Reuse the host's checks via `updateBot`, with separate writes for the two allowlisted fields, name and model. Pocket makes no direct level write (D2). Every settings reply, a refusal included, returns the Bot's current name, model, level and effective settings visible to this phone: a model write can clear Auto before the model is applied, so the level can change even when the write fails (`apps/bots-dsh/src/host/channel.js:666-669`, `apps/bots-dsh/src/host/roster.js:619-620`, `apps/bots-dsh/src/host/roster.js:781-788`). |

Build each write reply from the resulting host state. Pocket applies it directly with zero
follow-up reads from the phone or bridge. A refused write reports the refusal. A stale edit is
refused if its base memory entry, task, name or model changed on the desktop. After a lost reply,
the outcome is unknown to the phone. Reconcile it before permitting a retry of a write that
could be applied twice. Specify the stale-state and retry contracts before the relevant delivery.

## Contracts introduced

Propose an additive management capability under `herdr-pocket/chat/1` and local socket protocol
1. `manage: 1` is a candidate name. Align the version, capability and method intersection at
both handshakes with RFC 0033 (#1181) and the group-chat plan (#1180). Management is independent
of groups and attachments. The shared negotiation format and exact method names remain open.

- **Pocket Link to bots-dsh.** The bridge sends its write hello, then a management hello
  with `write: 1, manage: 1` if the first reply is writable. It uses the socket after the
  hello exchange completes. The host returns the capability and the management methods it
  supports only after opt-in. A peer that omits `write: 1` still gets `protocol: 1, readOnly: true`. A peer
  that requests existing writes alone keeps its existing write methods and receives a
  `read-only` refusal for management. A new bridge on an old host gets no management capability
  (`apps/bots-dsh/src/host/pocket-socket.js:198-204`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:165-169`).
- **Pocket to Pocket Link.** Advertise only the management methods requested by this phone and
  supported by the bridge and the host. The bridge shares one DSH source across phones, so a
  socket-wide capability cannot grant management to every phone. Track opt-in per phone chat
  connection. Older phones keep their existing chat behavior. A new phone paired with an old
  bridge or plugin stays read-only for management and hides its controls. A grant can reopen
  after a socket reconnect only in the same team home and for a method still supported by the host
  (`herdr/mods/pocket-link/bridge/bridge.mjs:143`, `herdr/mods/pocket-link/bridge/chat.mjs:169-178`).

## Threat model

Replacement for the stolen-phone clause in RFC 0015 (`docs/rfcs/0015-live-chat-projection.md`,
the bullet "A stolen paired phone, before and after"), approved on 2026-11-19 (D1): a stolen
paired phone keeps its existing chat authority. For an eligible Bot (D5) it can also list its
scheduled tasks with their title, state and timing and pause, resume or rename them (D6), and
change its name and model; when that Bot is not private, it can read, edit and add the Bot's
own memory (D3). It makes no direct level write (D2), cannot read a task's prompt through these
methods or change its timing, recurrence, prompt or target (D4, D6), and cannot manage a global
Bot (D5). Memory text can be sensitive. Resuming a task or changing the model, which can clear
Auto, can also affect what later runs on the computer. Remove the phone in Pocket Link or stop
the bridge to end access. Revocation ends management access within 2 seconds while the bridge's
timers run on schedule. A change already applied on the computer remains there.

- Every call needs a live paired `herdr-pocket/chat/1` connection and a Bot currently listed
  and `shown` by DSH. Pairing gives no project `shown[]` consent. The bridge checks the target,
  derives `phone` from the authenticated paired key and sends it to the owner-only socket
  when opening the grant.
  The host checks the Bot binding, visibility and operation at execution. The phone can manage
  the Bot with its chat closed, through this bridge and socket path alone
  (`apps/bots-dsh/src/host/pocket-chat.js:282-289`, `apps/bots-dsh/src/host/pocket-chat.js:561-565`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:265-291`).
- Count limits across connections by paired key. Propose sharing the existing 20 writes per
  minute per phone, with one management write in flight per phone and Bot and bounded reads and
  replies. The bridge's forget and 1-second checks must invalidate any queued work on the shared
  socket and stop undelivered replies for that phone. The host must reject revoked work before
  mutation. Specify that revocation mechanism and read and payload caps before coding
  (`apps/bots-dsh/src/host/pocket-socket.js:54-74`, `herdr/mods/pocket-link/bridge/bridge.mjs:196-217`).
- Keep management data in phone memory while its view is open and out of logs and disk caches.
  Document the data sent both ways, phone retention, desktop persistence and revocation in
  Pocket's privacy notice with the corresponding app delivery (`apps/pocket/AGENTS.md:41-46`).

## Decided

Approved by the owner's delegate on 2026-11-19 (the note under the table). The RFC named no
recommended option for any of its questions: D1 follows from the approval, and D2 to D6 take
the most conservative option. The options not taken are listed with each answer; taking one
needs a later amendment.

- **D1 (question 1).** Approved: RFC 0015's rule that a phone cannot change a Bot's settings or
  its level is replaced by this RFC's Threat model, within D2 to D6. RFC 0015 records the
  amendment.
- **D2 (question 2).** No direct level write from Pocket. The phone shows the Bot's level,
  read-only: it never sets a level, grants Full access or turns Auto on. RFC 0031's window
  confirmation with `permissionRev` stands, and `updateBot` already refuses `permissionAuto`,
  `permissionRev` and `autoStamp` (`apps/bots-dsh/src/host/roster.js:620`). A model write can
  clear Auto first, under RFC 0031's rules, even when the model change then fails
  (`apps/bots-dsh/src/host/roster.js:781-788`); every settings reply carries the level that
  results. Not taken: lowering only; any change.
- **D3 (question 3).** Memory: only the selected Bot's own entries (`bot:<id>`), and only for a
  Bot that is not private (`apps/bots-dsh/src/host/private-bots.js:33`). No private Bot's memory,
  no team or group memory, no other Bot's entries, no `places` and no summary that combines
  them. Not taken: team memory read-only; the group memory of the Bot's rooms; a private Bot's
  own memory.
- **D4 (question 4).** Pocket neither shows nor changes a task's prompt text through
  management: the host leaves the prompt out of every schedule list and schedule write reply
  (the desktop's list spreads the whole catalog entry,
  `apps/bots-dsh/src/host/schedules.js:482`). Chat transcripts the phone already reads under
  RFC 0015 are unchanged. Not taken: show it read-only; show and edit it.
- **D5 (question 5).** Global Bots, the Main Bot included, are not eligible for management: a
  decision of this RFC, since DSH shows global Bots to the phone today. A Bot is eligible when
  DSH lists it (`apps/bots-dsh/src/host/pocket-chat.js:282-289`) with a known project and its
  id is in the `shown[]` entry for that project and machine
  (`apps/bots-dsh/src/host/shown.js:102-109`); a Bot whose place cannot be read is never
  eligible. Global Bots keep RFC 0015's chat writes (send, interrupt, answer) unchanged. Not
  taken: include global Bots, as RFC 0015 did for chat writes.
- **D6 (question 6).** Pocket may pause or resume a task and change its title, under the host's
  title rules (trimmed, not empty, at most `MAX_TITLE` characters,
  `apps/bots-dsh/src/host/schedules.js:494-497`). It reads timing and recurrence but never
  changes them, the prompt or the target: those stay on the computer, so no timing or
  recurrence rule applies to the phone. Not taken: timing under the desktop's create rules
  (`selectorOf`, `apps/bots-dsh/src/host/schedules.js:58-82`); every field.

The stale-state and retry contracts, the revocation mechanism, the read and payload caps, and
the negotiation format and method names stay with their deliveries: each is specified before
the delivery that needs it (Design, Contracts introduced, Threat model).

## Deliveries

0. **Proposal review.** Done: approved by the owner's delegate on 2026-11-19, with the answers
   in Decided. This is the approval, not a merged delivery: the RFC moves to In delivery when
   delivery 1 merges.
1. **Memory.** Check authorized read, edit and add of the Bot's own memory with the new state in
   the write reply, and refusal of other scopes, private Bots, global Bots or revoked phones.
   Withdraw the methods to roll back remote access. Completed edits remain on the computer.
2. **Schedules.** Check list isolation, no prompt text in the list or write replies, and the
   task's title, state and timing after pause, resume and rename. Withdraw the methods to roll
   back remote access. Saved schedule changes remain.
3. **Settings.** #1567 was closed by the owner's roles decision (RFC 0037); #1441 is superseded by #1771, which settings do not touch; #1510's card saves through the same desktop endpoint, which a phone write does not use.
   Check name and model changes, the level shown read-only, and the level returned after a model write that
   clears Auto, whether the model change succeeds or fails. Withdraw the methods to roll back
   remote access. The computer keeps its last saved settings.

Each feature ships as separate plugin, Pocket Link and Pocket PRs in that order, gated until the
peers support it. Extend existing `pocket-chat`, `memory`, `schedules`,
`roster`, `permission-change-failure`, bridge `dsh-source` and `chat`, and Android `ChatClientTest`
coverage as applicable. Check older peers, revocation and zero follow-up reads after each write.
For each feature, record the tested SHA, phone action and resulting value on the paired phone and
installed desktop. No installed-app verification was performed for this draft.

## Delivery 1: memory contract

These are the implementer's proposals. D1 to D6 did not pick these details.

The owner socket keeps protocol 1 and its current line format. A writable source with memory
management adds `manage: 1` and `manageMethods` when hello asks for both `write: 1` and
`manage: 1`. The `methods` list stays the same. A bridge may manage a Bot with its chat closed.

```jsonl
{"id":1,"method":"hello","params":{"write":1}}
{"id":1,"result":{"protocol":1,"readOnly":false,"write":1,"methods":["hello","list","subscribe","unsubscribe","backfill","send","interrupt","answer"],"dedupe":"log"}}
{"id":2,"method":"hello","params":{"write":1,"manage":1}}
{"id":2,"result":{"protocol":1,"readOnly":false,"write":1,"methods":["hello","list","subscribe","unsubscribe","backfill","send","interrupt","answer"],"dedupe":"log","manage":1,"manageMethods":["manage-open","manage-close","memory-read","memory-edit","memory-add"]}}
{"id":3,"method":"manage-open","params":{"grant":"g1","phone":"paired-key"}}
{"id":3,"result":{"grant":"g1"}}
{"id":4,"method":"memory-read","params":{"grant":"g1","terminal":"dsh:worker"}}
{"id":4,"result":{"ok":true,"state":"read","memory":{"terminal":"dsh:worker","entries":[],"size":0,"limit":8000,"truncated":false}}}
{"id":5,"method":"memory-add","params":{"grant":"g1","terminal":"dsh:worker","text":"Use the staging fixture."}}
{"id":5,"result":{"ok":true,"state":"saved","entry":{"id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the staging fixture.","topic":null,"added":"2026-11-19","until":null,"pinned":false,"expired":false},"memory":{"terminal":"dsh:worker","entries":[{"id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the staging fixture.","topic":null,"added":"2026-11-19","until":null,"pinned":false,"expired":false}],"size":24,"limit":8000,"truncated":false}}}
{"id":6,"method":"memory-edit","params":{"grant":"g1","terminal":"dsh:worker","id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the current fixture."}}
{"id":7,"method":"manage-close","params":{"grant":"g1"}}
{"id":7,"result":{}}
{"id":6,"result":{"ok":false,"state":"refused","reason":"revoked","applied":true}}
```

Read returns `{ok:true, state:'read', memory}`. Add and edit return
`{ok:true, state:'saved'|'unchanged', entry, memory}`. Memory contains `terminal`, `entries`,
`size`, `limit` and `truncated`. Each entry has `id`, `rev`, `text`, `topic`, `added`,
`until`, `pinned` and `expired`. It comes only from the selected Bot's own scope.

An entry's wire id is its stored id if it matches `/^[A-Za-z0-9_-]{1,32}$/`. Otherwise it is
`x` plus the first 16 hex digits of the SHA-256 of the stored id. Edit uses the same mapping
and keeps the stored id. The revision is the first 16 hex digits of the SHA-256 of the UTF-8
`JSON.stringify([fileName, rawLine])`. Edit needs both id and revision. An absent id is
`gone`. A present id with no matching revision is `stale`. Multiple matches are `ambiguous`.
These replies carry current memory. Edit keeps the entry's pin, expiry and added date and
sets `by: 'user'` and `source: 'pocket'` when it changes the text. The same canonical edit text
or an add of text already present returns `unchanged` and writes no journal row.

Without negotiation every management method except close returns the existing `read-only`
error. Close always returns an empty result. Open needs no host authority and returns the
grant id. Its errors use the error envelope. A bad grant or phone key returns
`invalid_params`. An open id returns `invalid_params` with `grant in use`. A seventeenth
open grant on one connection returns `too_many`.

Memory refusals use `{ok:false, state:'refused', reason}` in the result envelope. Check in
this order.

1. An unknown or closed grant returns `revoked`.
2. Bad fields return `invalid`. A grant matches `/^[A-Za-z0-9._:-]{1,64}$/`. The terminal
   names a `dsh:<botId>`. Text is a string of at most 4 KiB in UTF-8. Edit requires a valid
   wire id and 16 lowercase hex digits for the revision.
3. One memory call per phone and Bot may be in flight. Another returns `busy`.
4. The phone key counts across connections. Reads get 60 per minute. Writes share chat's
   20 per minute. Past either cap the reason is `rate`.
5. The job refreshes the shell choice. It needs the team's lock and a writable host with
   memory on. Failure returns `unavailable`.
6. A Bot must still be the team's own Bot with a current Session. Otherwise it is
   `not-found`. Use one fresh home file read for its binding and shown pick. A failed read,
   duplicate Bot rows or a malformed machine gives `not-shown`. A row with a folder sets
   the project and machine. With no row, use the Bot's runtime project. No project gives
   `global`. An absent pick for that project, machine and Bot gives `not-shown`. A private
   Bot gives `private`.
7. Load only the Bot's own scope. A linked or non-regular file, or an unsafe directory,
   gives `unavailable`. Check sizes before loading. More than 64 Markdown files or more
   than 2 MiB gives `too-large`. A write also checks the resulting scope's 2 MiB cap.
8. Apply the operation's selector and entry rules. `invalid` may carry the memory entry
   rule's message about the supplied text, which has a 300-character limit.

The whole reply line, including the envelope and the affected entry, has a 1 MiB UTF-8
cap. Reserve room for the affected entry, then include up to 4,000 entries that fit.
Set `truncated: true` when entries are left out.

A request holds the grant it started with. Closing the grant, another hello, closing the
connection or starting server shutdown revokes it permanently. Reopening an id makes a
new grant. Check the grant, lock and Bot consent in the job, just before accepting a write
and just before replying. The Unix host accepts a write by renaming its temporary pending
file in the same synchronous turn as that check. A refusal before the rename leaves no
accepted write. If a check fails after acceptance, the change stays accepted and the
refusal carries `applied:true` with no memory.

A failure in the steps or journal after acceptance returns
`{ok:false, state:'unknown', reason:'pending'}`. Memory recovery finishes it. A confirmed
write whose projection fails returns `{ok:true, state:'saved', entry:null, memory:null}`.
This is the only saved reply that needs a read. After a lost or unknown reply the phone
must never resend the write on its own. It calls `memory-read` and shows the resulting
state. Only a fresh user action sends another write. Writes have no durable receipts.
Durable receipts keyed by phone, Bot, operation and fingerprint were considered.

| Peer | Result |
|---|---|
| Old bridge, new host | A hello without `write: 1` gets the old read-only answer. A hello with only `write: 1` keeps the old chat write answer. |
| New bridge, old host | The management hello reply has no `manage`. The bridge advertises no management. |
| New bridge, new host | Both hello flags and a writable source with memory enable management. Otherwise the bridge advertises no management. |
| Old phone or old bridge | Chat continues and no management methods are negotiated. |

For the Pocket Link PR, the phone sends chat hello with any subset of
`manage: ['memory.read', 'memory.edit', 'memory.add']`. The bridge replies with the
intersection of the phone's request, the bridge's methods and the host's `manageMethods`.
It maps socket names such as `memory-read` to `memory.read`. A phone that requests
`['memory.read']` gets only `['memory.read']` when all peers support it. If the phone asks
for read, edit and add and the host offers only read and add, the reply is
`['memory.read', 'memory.add']`. The hello reply includes the intersection only after the
host acknowledges the grant opened for that phone connection. If the open fails, the
phone gets the ordinary chat hello. The bridge forwards only negotiated methods. A phone
that asks for edit or add should ask for read too so it can reconcile an unknown outcome.

Open and close exist only on the owner socket. The bridge opens one grant at the phone's
hello using the authenticated phone key. It closes the grant when the connection ends.
Control-socket forget ends the connection immediately, and a 1-second poll checks for
file-based forget. If the close has no empty result ack within 500 ms, the bridge destroys
that socket. A queued memory reply can go out only while the phone connection is still live.
A switch to another team home requires a fresh phone hello before any more memory calls.
The connection's 16-request transport limit returns a JSON-RPC `busy` error before the
memory refusal checks.

## Delivery 2: schedules contract

The owner socket keeps protocol 1 and the same chat methods and grant rules as Delivery 1.
A writable Session controller can negotiate management when hello asks for both `write: 1`
and `manage: 1` and the host offers at least one management family. The reply lists
`manage-open` and `manage-close`, the enabled memory methods, and the schedule methods the
host can serve. A host-wide DSH schedule service adds `schedule-list`. Without that service
the hello reply is unchanged. Each connection can call the methods in its own hello reply.
An unlisted method returns the existing `read-only` error. Close always returns an empty result.

On a host that can serve writable Pocket chat, each attached host-wide schedule service starts
with reads only. The host sends a probe edit for a fresh `schedule-probe-` UUID with a signal
already aborted. The service must reject with the exact abort reason before looking up the
task. This writes no task and emits no change. When the probe passes, the next hello also
offers `schedule-pause`, `schedule-resume` and `schedule-rename`. A failed probe leaves that
service read only and logs one warning. A replacement service is probed again. If an edit
returns a saved task without checking the signal, the host reports that save and withdraws
schedule writes for the rest of the process. Already negotiated writes then get `unavailable`
when they run or reach admission. The contract requires the DSH engine floor. A version-exempt
service that checks cancellation at entry but lacks revision checks or the second check on
resume is unsupported.

| Socket method | Parameters beside `grant` and `terminal` |
|---|---|
| `schedule-list` | Optional `id` |
| `schedule-pause` | `id`, `rev` |
| `schedule-resume` | `id`, `rev` |
| `schedule-rename` | `id`, `rev`, `title` |

The terminal is `dsh:<botId>` with a non-empty Bot id. No chat subscription is needed.
An eligible Bot must have a current own-chat Session and a fresh home-file binding that
shows it for its project and machine. Private project Bots are eligible. Tasks must target
a Session the Bot owns in its own chat, including an earlier part. Group Sessions, a Bot's
group parts and tasks that open a new Session are outside this scope.

Read returns `{ok:true, state:'read', schedules:{terminal,tasks,truncated}}`. When the caller
gives an id, the result also carries `task`, the selected task even if it falls outside the
list cap, or `null` if the Bot has no task with that id. Each task has `id`, `rev`, `title`,
`state` and `timing`. State is `scheduled` or `overdue` while active, `paused` while paused
and `finished` when ended. Timing has the stored `kind` and `at` (DSH's `scheduledAt`
verbatim). An active task shows its next occurrence, a paused task keeps its stored instant,
and an ended task shows its last one. Timing adds only the fields of that kind.

| Kind | Extra timing fields |
|---|---|
| `after` | `afterSeconds` |
| `every` | `everySeconds` |
| `daily` | `time`, `timeZone` |
| `weekly` | `time`, `timeZone`, `weekdays` |
| `cron` | `expression`, `timeZone` |
| `rrule` | `rrule` |
| `at` or an unknown kind | None |

A cron expression or RRULE over 1 KiB UTF-8 becomes `null` and adds `ruleTooLong: true`
to timing. The wire id is the stored id if it matches
`/^schedule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`.
Every other stored id is `x` plus the first 16 lowercase hex digits of its SHA-256.
Requests accept only these two forms. The revision is the first 16 lowercase hex digits
of the SHA-256 of the UTF-8 `JSON.stringify([storedId, updatedAt ?? null, title, status, timing])`.

After negotiation, the host checks the grant (`revoked`), then the fields (`invalid`),
then the shared management slot (`busy`) and rate limits (`rate`), in that order. Rename
needs a string of at most 4 KiB UTF-8 on input. The job refreshes the host's shell choice and
checks eligibility before reading the catalog. A missing host-wide service, an unavailable
write capability, a broken team lock or a read-only host gives `unavailable`. A missing Bot
or current Session gives `not-found`. A binding that cannot be read or a pick that does
not show the Bot gives `not-shown`. A Bot without a project gives `global`.

For a selected read or a write, multiple own tasks with the same wire id give `ambiguous`.
A write to an absent task gives `gone`. A write with an old revision gives `stale` with the
current task. If the revision matches, pause and resume on a finished task give `ended`
with the current task. Pausing a paused task, resuming an active task (overdue included), or
renaming to the current title after trimming returns `{ok:true, state:'unchanged', task}`
without sending an edit. Rename trims the title and requires 1 to 120 characters. A blank
title gets `invalid` with “Give the task a name” and a long title gets `invalid` with
“Keep the name under 120 characters”. DSH input errors become `invalid`. When DSH reports
that a task has no future occurrence, the only additional text is
“This task has no future occurrence.”

The host sends the stored id and the catalog's `updatedAt` (or `null` for an older row) as
`expectedUpdatedAt`. The patch is `{active:false}`, `{active:true}` or `{title}`, depending
on the operation. DSH checks the signal after waiting for its write queue and again after checking
a resume target. At those checks the host synchronously confirms that the grant is still
open, the same service still accepts writes, the host still has the lock and is writable,
the Bot is still eligible, and the captured Session still belongs to its own chat. A failed
check refuses the edit before the store write begins. Close, a new hello, disconnect and
shutdown abort writes still waiting, including in target validation. DSH compares the stored
revision before changing anything. On a conflict or a missing row, the host reads the catalog
again once and replies `stale` with the current task if it still belongs to the Bot, or `gone`.

The saved reply is `{ok:true, state:'saved', task}`, projected from the entry DSH committed.
A resumed `after` can return as `at`. Write replies carry only the affected task. Before sending
a job reply the host checks the grant and eligibility again and checks that each projected
task's captured Session still belongs to the Bot. It drops any list item that no longer
belongs. A single task that no longer belongs gives `gone`. After a confirmed save, any such
refusal also has `applied:true` and carries no task data.

Once the store write begins, the edit can still land. A write whose result cannot be confirmed
returns `{ok:false, state:'unknown', reason:'pending'}` without task data, even if authority
has since been lost. The host keeps the management slot until the edit settles, even if the
phone disconnects. After a lost or unknown reply the phone must not resend on its own. It calls
`schedule-list {id}` with its grant and terminal. It keeps the outcome unknown on `busy`,
`rate`, `unavailable` or `unknown` and allows a fresh user action only after a successful
`read` with that id. An older revision can still yield `stale` on the next write.

Schedule reads share the 60-per-minute limit per phone with memory reads. Schedule writes
share the 20-per-minute limit per phone with chat and memory writes. A schedule job shares
the management slot per phone and terminal with memory, across connections. Each list returns
at most 500 tasks and sets `truncated:true` when the cap leaves tasks out. Every task-bearing
reply fits one 1 MiB UTF-8 JSON line, including the escaped request id, envelope and newline.
The list reserves room for the selected task first. Separately from the wire cap, each catalog
read materializes and sorts all tasks on the DSH host.

The schedule management handler does not send prompts, target Session ids, or titles from
another Bot in its replies, and it logs failures without task data or DSH error text. A committed
edit still makes DSH queue its own task-updated notice with the title and task id to the involved
live Sessions, like a desktop edit. DSH may log a Session id if that notice fails. Pocket chat
already filters these injected notices.

| Peer | Result |
|---|---|
| Old bridge, new host | A hello without management keeps the old chat answer. |
| New bridge, old host | The host may advertise memory only, or no management on an older host. |
| Memory-capable bridge, new host | The bridge may already ask for `manage: 1`. The phone sees only the methods that the phone, bridge and host all support. |
| New phone, bridge and host | The phone can use each schedule method supported by all three. |
| Old phone or bridge | Chat keeps working. The phone gets no schedule methods. |

For the Pocket Link PR, the phone names are `schedule.list`, `schedule.pause`,
`schedule.resume` and `schedule.rename`. The bridge maps them to the socket methods and
advertises and forwards their per-method intersection with the phone's request and the
host's `manageMethods`. The plugin change can be tested with the installed app for
regressions and refusals, under the app lock with a backup and byte-equal restore, and
with scratch DSH for successful edits. The tested SHA, paired-phone action and the
resulting values on the phone and desktop belong to the Pocket Link and Pocket PRs.

## Delivery 3: settings contract

These are the implementer's proposals. D1 to D6 did not pick these details.

The owner socket keeps protocol 1, the chat methods and the grant rules of Delivery 1. A
writable Session controller whose host has the team store, the model catalog and the Bot
update adds `settings-read`, `settings-name` and `settings-model` to `manageMethods`, after the
schedule methods, when hello asks for both `write: 1` and `manage: 1`. The three come together
or not at all. A host with settings and no other management family still lists `manage-open`
and `manage-close` first. Without them the hello reply is unchanged. An unlisted method returns
the existing `read-only` error. No socket method writes a level, an effort, a role or any other
Bot field.

| Socket method | Parameters beside `grant` and `terminal` |
|---|---|
| `settings-read` | none |
| `settings-name` | `rev`, `name` |
| `settings-model` | `rev`, `model` |

Other parameters are ignored. The host passes exactly `{ id, name }` or `{ id, model }` to its
Bot update, as the person (no Bot actor). The terminal is `dsh:<botId>` with a non-empty Bot id.
No chat subscription is needed. Eligibility is Delivery 2's: a current own-chat Session and a
fresh home-file binding that shows the Bot for its project and machine. Private project Bots
are eligible: the Threat model limits only memory by privacy. Global Bots are not (D5).

```jsonl
{"id":8,"method":"settings-read","params":{"grant":"g1","terminal":"dsh:b-aaaaaaaaaa"}}
{"id":8,"result":{"ok":true,"state":"read","settings":{"terminal":"dsh:b-aaaaaaaaaa","rev":"3f9c0a1b2c3d4e5f","name":"Worker","model":{"saved":"deepseek/v4","label":"V4","applied":"deepseek/v4","running":"deepseek/v4","effort":null,"runningEffort":null},"level":{"saved":"workspace-write","inherited":false,"auto":true},"editable":{"name":true,"model":true}},"models":{"entries":[{"id":"deepseek/v4","label":"V4","provider":"DeepSeek"},{"id":"deepseek/v5","label":"V5","provider":"DeepSeek"}],"truncated":false}}}
{"id":9,"method":"settings-model","params":{"grant":"g1","terminal":"dsh:b-aaaaaaaaaa","rev":"3f9c0a1b2c3d4e5f","model":"deepseek/v5"}}
{"id":9,"result":{"ok":false,"state":"refused","reason":"not-applied","message":"The computer could not switch the Bot to that model, so it stays on its current one.","settings":{"terminal":"dsh:b-aaaaaaaaaa","rev":"7a0b1c2d3e4f5a6b","name":"Worker","model":{"saved":"deepseek/v4","label":"V4","applied":"deepseek/v4","running":"deepseek/v4","effort":null,"runningEffort":null},"level":{"saved":"workspace-write","inherited":false,"auto":false},"editable":{"name":true,"model":true}},"models":{"entries":[{"id":"deepseek/v4","label":"V4","provider":"DeepSeek"},{"id":"deepseek/v5","label":"V5","provider":"DeepSeek"}],"truncated":false}}}
```

### Settings

`settings` has exactly these fields. Absent values are `null`.

| Field | Meaning |
|---|---|
| `terminal` | The request's terminal. |
| `rev` | The revision below. |
| `name` | The Bot's name as the computer shows it. |
| `model.saved` | The model the Bot is set to (its record), or `null`. |
| `model.label` | That model's catalog name, or for a Bot whose plugin owns its model menu the entry that answers now; at most 200 characters; `null` when unknown. |
| `model.applied` | The model the host last applied to the Bot's Sessions, or `null`. |
| `model.running` | The model the Bot's own chat runs now as the desktop reads it, or `null` when it cannot be read without opening anything (Session not loaded, a pick or route switch under way, a host-owned menu). It can differ from `saved`: the composer can move the chat on its own. |
| `model.effort` | The saved thinking level id, or `null` (the model's default). Read-only. |
| `model.runningEffort` | The thinking level the own chat runs now, or `null`. |
| `level.saved` | `read-only`, `workspace-write`, `danger-full-access`, `auto` (a legacy saved Auto) or `custom` (any other preset; its name never leaves the host); for a Bot with no level of its own, DSH's default preset mapped the same way; `null` when none can be read. |
| `level.inherited` | `true` when the Bot has no level of its own and follows DSH's default. |
| `level.auto` | Whether Auto is on (saved `workspace-write` with an Auto mark, as the desktop's picker shows it). |
| `level.fallback` | Present, `"workspace-write"`, when a saved Auto runs as that level here. |
| `level.notOffered` | Present, `true`, when DSH no longer offers the saved level. |
| `level.runs` | Present when DSH reports the level the Bot's own chat runs now, mapped like `saved`. |
| `editable.name`, `editable.model` | Whether this phone can change each now. |
| `editable.reason` | Present when either is `false`: `greeting` (the Bot holds its first greeting), `host-model` (its plugin owns the model menu), `shell` (held for a shell choice), `changing` (a model pick or route switch is under way), `no-model` (no current model). |

No role, instructions, folder, deny list, shell, privacy flag, browser grant, Auto judge,
other Bot's data or host error text is sent.

`rev` is the first 16 lowercase hex digits of the SHA-256 of the UTF-8
`JSON.stringify([botId, name, model, effort, permission, permissionAuto, permissionRev])`, taken
from the Bot's record: `model`, `effort`, `permission` and `permissionAuto` `null` when absent,
`permissionRev` `0` when absent. Any desktop change of the name, the saved model or effort, the
level or Auto makes an older `rev` stale; `permissionRev` is a counter, so a level that changes
and changes back is stale too. A change and change-back is current again only when every hashed
field, `permissionRev` included, is back to the value the phone saw; a desktop model pick runs
the Auto clearing, which moves `permissionRev` even with no Auto mark, so a model picked and
picked back on the desktop is stale.

### Models

The host builds `models` only from the catalog snapshot it already holds in memory, and never lists models for a phone. With no snapshot, `settings.read` returns `models: {entries: [], truncated: false}`, and `settings.model` is refused with `unavailable`, with no mutation.

`models` lists the choices for this Bot: `{entries, truncated}`, each entry
`{id, label, provider}` (`id` the exact catalog ref; `label` the model's name, at most 200
characters; `provider` the provider's name, at most 80). It is empty when `editable.model` is
`false`. A catalog entry is listed only when all of these hold, and a model write is accepted
only for an entry that would be listed:

- its ref is accepted by the field check below;
- it is on the same harness as the Bot's current model (the saved model, else the applied one):
  the same route, and the same agent inside ACP;
- the route policy allows its route for the Bot's kind;
- it does not need a key, a sign-in or an account confirmation, is not a ChatGPT or Claude
  plan route that the host would move to that plan's agent, and is not a superseded Claude
  model the desktop menu hides;
- it does not break the shell boundary (a Bot without a shell never gets an agent whose own
  tools run commands).

At most 200 entries, in catalog order. Every settings-bearing reply carries `models`; the phone
replaces its list from each one. The list is read from the last snapshot the host holds,
whatever its age, without saving anything; a write is checked against the same snapshot, and
DSH checks the exact model when it is selected. A key, sign-in or route change on the computer
drops the snapshot, and the list stays empty until the desktop lists models again. (Amended
2026-11-20: a 10 s limit left the phone with no list almost always, because the desktop lists
models only when it needs them.)

### Replies

A read returns `{ok:true, state:'read', settings, models}`. A write returns
`{ok:true, state:'saved'|'unchanged', settings, models}`. `unchanged` (a name equal to the
current one after trimming and the 40-character cut, or a model equal to the saved one) calls
nothing: no Auto change, no `permissionRev` move.

Refusals are `{ok:false, state:'refused', reason, ...}` in the result envelope. After
negotiation the checks run in this order.

| # | Reason | When | Carries |
|---|---|---|---|
| 1 | `revoked` | Unknown or closed grant. | nothing |
| 2 | `invalid` | Bad fields: grant and terminal as in Delivery 1; `rev` 16 lowercase hex digits; `name` a string of at most 4 KiB UTF-8; `model` a string of 3 to 512 bytes UTF-8 with no control character and a `/` that is neither first nor last. | nothing |
| 3 | `busy` | Another management call for this phone and Bot is in flight (shared with memory and schedules, across connections). | nothing |
| 4 | `rate` | Reads: 60 a minute per phone, shared with memory and schedule reads. Writes: 20 a minute per phone, shared with chat, memory and schedule writes. | nothing |
| 5 | `unavailable` | No team lock, a read-only host, or the host's update or catalog missing; also a host failure before the write was admitted (nothing changed). | nothing |
| 5 | `not-found` | No such Bot of this team, or no current own-chat Session. | nothing |
| 5 | `not-shown` | The binding cannot be read, or the pick does not show the Bot. | nothing |
| 5 | `global` | The Bot has no project. | nothing |
| 6 | `stale` | A write whose `rev` is not the current one. | `settings`, `models` |
| 7 | `unchanged` (ok) | See above. | `settings`, `models` |
| 8 | `computer` | The Bot holds its first greeting (name and model); its plugin owns its model menu, it is held for a shell choice, or it has no current model (model). The change stays on the computer. | `settings`, `models` |
| 9 | `changing` | A model write while a model pick or route switch for this Bot is under way on the computer. | `settings`, `models` |
| 10 | `invalid` + `message` | A name the host's name rules refuse: empty after trimming, taken, held for a Bot being made, or against the name rule. `message` is the rule's text about the supplied name, at most 300 characters. | `message`, `settings`, `models` |
| 11 | `unknown-model` | A syntactically valid ref (`<provider>/<model>`) that no catalog entry has exactly, e.g. `deepseek/none`. A bare id or display name fails field validation and gets `invalid` with no settings. | `settings`, `models` |
| 12 | `model-not-allowed` | The entry exists but would not be listed for this Bot (Models), or its agent is off, installing, signed out or waiting for the person's account confirmation. | `settings`, `models` |
| 13 | `not-applied` + `message` | The write was admitted and DSH turned the model selection down. The model stays as it was; a model write can clear Auto first (RFC 0031, D2), and `settings.level` shows the result. `message` is fixed: "The computer could not switch the Bot to that model, so it stays on its current one." | `message`, `settings`, `models` |
| 14 | `too-large` | The reply would pass the line cap with no model entries. | nothing |

Admission. The host checks 6 to 10 against the record; for a model write it then reads the
held snapshot again, checks authority, the record and `rev` again, and checks 11 and 12. Then it calls
the Bot update, which does its own waits (the update's checks, the agent's access check, and an
Auto change already under way). Just before the first change to the Bot, in the same synchronous turn as
that change, it checks again: the grant is open, the Bot is still eligible (5), the record is
the same object, the `rev` still matches, and 8 and 9 still hold. If any check fails, nothing
changed, and the reply is the reason from this table. A model write that clears Auto is
checked again right before Auto is cleared. A phone write never switches a route, never opens
a new conversation, never picks a host plugin's model and never releases a held greeting: those
stay on the computer. Catalog reads during a phone write save nothing and lift no other Bot's
block, so no other Bot starts. A refusal by the update before admission changed nothing: it is
reason 10, 11 or 12 when those rules explain it, else `model-not-allowed` for a model write and
`computer` for a name write. Any other failure before admission is `unavailable`.

After admission the change can land. If authority is lost before the reply, the reply is
`{ok:false, state:'refused', reason, applied:true}` with `revoked`, `not-found`, `not-shown`,
`global` or `unavailable`, and no settings. A failure after admission that is not reason 13 (a
save that failed, a name whose chat title could not follow) returns
`{ok:false, state:'unknown', reason:'pending', settings, models}`: `settings` is what the
computer shows now, which may not yet be saved to disk. Without authority it carries no
settings. The host logs `pocket settings: unavailable` with no name, model or host text.

Every reply that carries `settings` is projected from the Bot's live record after the operation
settled, under a final check of the grant and eligibility in the same turn as the socket write.
The phone applies `settings` and `models` from each such reply with zero follow-up reads. After a
lost or `unknown` reply the phone never resends on its own: it shows the settings the reply
carried, or calls `settings-read` when it carried none, and only a fresh user action writes
again; that write carries the `rev` it last saw, so a change in between is `stale`.

Every reply line, including the escaped request id, the envelope and the newline, fits 1 MiB
UTF-8. The host reserves room for `settings` first, then adds whole model entries while they
fit, up to 200, and sets `truncated: true` when it leaves any out.

Each saved write adds one Diagnostics note on the computer, "Pocket changed the Bot's name" or
"Pocket changed the Bot's model", with the Bot id and no names or refs.

| Peer | Result |
|---|---|
| Old bridge, new host | A hello without `manage: 1` is unchanged. A memory or schedule bridge keeps only the management methods it knows, so it ignores the settings methods; a host with settings only gives such a bridge no management. |
| New bridge, old host | No `settings-*` in `manageMethods`; the bridge advertises no settings method. |
| New phone, bridge and host | The phone gets each settings method all three support, writes only with `settings.read`. |
| Old phone | Chat and its negotiated memory and schedule methods keep working; no settings method is advertised. |

For the Pocket Link PR, the phone names are `settings.read`, `settings.name` and
`settings.model`. The bridge maps them to the socket names and advertises the per-method
intersection of the phone's request, its own list and the host's `manageMethods`, under one
more rule: the family counts only with `settings.read`. A phone that does not get
`settings.read` gets neither write, so every unknown outcome can be reconciled. The bridge
forwards only negotiated methods, sends a queued settings reply only while the phone connection
is live, and its 16-request transport limit returns a JSON-RPC `busy` error before these checks.

Withdrawing the three methods rolls back remote access. The computer keeps its last saved
settings, an Auto cleared by a phone model write included.

## Open questions

None. See Decided for D1 to D6.

## Links

- #1182 (planning), #1180 (group chat), #1181 (attachments).
- [RFC 0015 — Live chat projection](0015-live-chat-projection.md#threat-model-grows-who-can-call-the-engine-and-what-it-can-send).
- [RFC 0031 — Auto permission level](0031-auto-permission-level.md).
- [RFC 0033 — Attachments from Pocket](0033-attachments-from-pocket.md#contracts-introduced).
- [RFC 0011 — Monorepo parts and releases](0011-monorepo-parts-and-releases.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md).
