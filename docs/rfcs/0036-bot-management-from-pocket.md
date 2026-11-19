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

## Open questions

None. See Decided for D1 to D6.

## Links

- #1182 (planning), #1180 (group chat), #1181 (attachments).
- [RFC 0015 — Live chat projection](0015-live-chat-projection.md#threat-model-grows-who-can-call-the-engine-and-what-it-can-send).
- [RFC 0031 — Auto permission level](0031-auto-permission-level.md).
- [RFC 0033 — Attachments from Pocket](0033-attachments-from-pocket.md#contracts-introduced).
- [RFC 0011 — Monorepo parts and releases](0011-monorepo-parts-and-releases.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md).
