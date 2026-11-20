# RFC 0036: Bot management from Pocket

| Field | Value |
|---|---|
| Status | Accepted (2026-11-19, approved by the owner's delegate: Q1 by the approval, Q2-Q6 the most conservative option, the RFC recommending none, in Decided D1-D6; amends RFC 0015; no delivery merged) |
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
| Settings: name and model; level shown (D2) | Reuse the host's checks via `updateBot`, with separate writes for the two allowlisted fields, name and model. Pocket makes no direct level write (D2). Every settings reply, a refusal included, returns the Bot's current name, model, level and effective settings visible to this phone: a model write can clear Auto before the model is applied, so the level can change even when the write fails (`apps/bots-dsh/src/host/channel.js:636-638`, `apps/bots-dsh/src/host/roster.js:569-570`, `apps/bots-dsh/src/host/roster.js:713-715`). |

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

- **Pocket Link to bots-dsh.** The bridge requests management in socket `hello` alongside
  `write: 1`. The host returns the capability and the management methods it supports only
  after opt-in. A peer that omits `write: 1` still gets `protocol: 1, readOnly: true`. A peer
  that requests existing writes alone keeps its existing write methods and receives a
  `read-only` refusal for management. A new bridge on an old host gets no management capability
  (`apps/bots-dsh/src/host/pocket-socket.js:198-204`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:165-169`).
- **Pocket to Pocket Link.** Advertise only the management methods requested by this phone and
  supported by the bridge and the host. The bridge shares one DSH source across phones, so a
  socket-wide capability cannot grant management to every phone. Track opt-in per phone chat
  connection. Older phones keep their existing chat behavior. A new phone paired with an old
  bridge or plugin stays read-only for management and hides its controls. Renegotiate on
  reconnect and refuse calls if the socket loses support
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
the bridge to end access. Revocation ends management access within 2 seconds. A change already
applied on the computer remains there.

- Every call needs a live paired `herdr-pocket/chat/1` connection and a Bot currently listed
  and `shown` by DSH. Pairing gives no project `shown[]` consent. The bridge checks the target,
  derives `phone` from the authenticated paired key and forwards it to the owner-only socket.
  The host checks the Bot binding, visibility and operation at execution. The phone can manage
  the Bot with its chat closed, through this bridge and socket path alone
  (`apps/bots-dsh/src/host/pocket-chat.js:282-289`, `apps/bots-dsh/src/host/pocket-chat.js:561-565`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:265-291`).
- Count limits across connections by paired key. Propose sharing the existing 20 writes per
  minute per phone, with one management write in flight per phone and Bot and bounded reads and
  replies. The bridge's forget and 2-second checks must invalidate any queued work on the shared
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
  `permissionRev` and `autoStamp` (`apps/bots-dsh/src/host/roster.js:570`). A model write can
  clear Auto first, under RFC 0031's rules, even when the model change then fails
  (`apps/bots-dsh/src/host/roster.js:713-715`); every settings reply carries the level that
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
3. **Settings.** Reconcile #1567 (model), #1441 (channel) and #1510 before coding. Check name
   and model changes, the level shown read-only, and the level returned after a model write that
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
{"id":1,"method":"hello","params":{"write":1,"manage":1}}
{"id":1,"result":{"protocol":1,"readOnly":false,"write":1,"methods":["hello","list","subscribe","unsubscribe","backfill","send","interrupt","answer"],"dedupe":"log","manage":1,"manageMethods":["manage-open","manage-close","memory-read","memory-edit","memory-add"]}}
{"id":2,"method":"manage-open","params":{"grant":"g1","phone":"paired-key"}}
{"id":2,"result":{"grant":"g1"}}
{"id":3,"method":"memory-read","params":{"grant":"g1","terminal":"dsh:worker"}}
{"id":3,"result":{"ok":true,"state":"read","memory":{"terminal":"dsh:worker","entries":[],"size":0,"limit":8000,"truncated":false}}}
{"id":4,"method":"memory-add","params":{"grant":"g1","terminal":"dsh:worker","text":"Use the staging fixture."}}
{"id":4,"result":{"ok":true,"state":"saved","entry":{"id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the staging fixture.","topic":null,"added":"2026-11-19","until":null,"pinned":false,"expired":false},"memory":{"terminal":"dsh:worker","entries":[{"id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the staging fixture.","topic":null,"added":"2026-11-19","until":null,"pinned":false,"expired":false}],"size":24,"limit":8000,"truncated":false}}}
{"id":5,"method":"memory-edit","params":{"grant":"g1","terminal":"dsh:worker","id":"a1b2","rev":"649c4d43fea4d9f9","text":"Use the current fixture."}}
{"id":6,"method":"manage-close","params":{"grant":"g1"}}
{"id":6,"result":{}}
{"id":5,"result":{"ok":false,"state":"refused","reason":"revoked","applied":true}}
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
| New bridge, old host | Hello has no `manage`. The bridge advertises no management. |
| New bridge, new host | Both hello flags and a writable source with memory enable management. Otherwise the bridge advertises no management. |
| Old phone or old bridge | Chat continues and no management methods are negotiated. |

For the Pocket Link PR, the phone sends chat hello with any subset of
`manage: ['memory.read', 'memory.edit', 'memory.add']`. The bridge replies with the
intersection of the phone's request, the bridge's methods and the host's `manageMethods`.
It maps socket names such as `memory-read` to `memory.read`. A phone that requests
`['memory.read']` gets only `['memory.read']` when all peers support it. If the phone asks
for read, edit and add and the host offers only read and add, the reply is
`['memory.read', 'memory.add']`. The bridge forwards only negotiated methods.

Open and close exist only on the owner socket. The bridge opens one grant on hello per
phone chat connection using the authenticated phone key. It closes the grant when the
connection ends, on forget or when the 2-second check revokes the phone. If the close
is not acknowledged within the 2-second revocation deadline, the bridge destroys the
socket. It drops a reply if its phone connection is no longer live and renegotiates on
reconnect.

## Open questions

None. See Decided for D1 to D6.

## Links

- #1182 (planning), #1180 (group chat), #1181 (attachments).
- [RFC 0015 — Live chat projection](0015-live-chat-projection.md#threat-model-grows-who-can-call-the-engine-and-what-it-can-send).
- [RFC 0031 — Auto permission level](0031-auto-permission-level.md).
- [RFC 0033 — Attachments from Pocket](0033-attachments-from-pocket.md#contracts-introduced).
- [RFC 0011 — Monorepo parts and releases](0011-monorepo-parts-and-releases.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md).
