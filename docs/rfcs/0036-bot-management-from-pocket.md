# RFC 0036: Bot management from Pocket

| Field | Value |
|---|---|
| Status | Approved (amends RFC 0015) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), herdr (Pocket Link), pocket |
| Created | 2026-11-19 |

> Approved by Guga's delegation while the owner is away (19/11); the owner may amend on return.

## Summary

Manage a listed, visible DSH Bot from a paired phone. In order, Pocket reads, edits and adds
memory, lists, pauses, resumes and edits scheduled tasks, then changes the Bot's name, model
and an owner-approved permission level. Each applied write returns the affected state in the
same reply. RFC 0015 currently keeps Bot settings and permission levels on the computer. This
RFC amends that rule.

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
| Memory: read, edit, add | Reuse the host's entry validation and mutation logic. Read and return only the selected Bot's approved memory scopes and entries. Omit `places` (all Bot and room names), unrelated scopes and summaries that combine them. The desktop panel returns that broader view today (`apps/bots-dsh/src/host/memory.js:1418-1444`, `apps/bots-dsh/src/host/memory.js:1501-1515`, `apps/bots-dsh/src/host/channel.js:852-862`). |
| Schedules: list, pause or resume, edit | Check task ownership against the selected Bot's current host binding. Add host pause/resume and edit endpoints using `service.edit`, as the internal pause already does. The host currently lists, creates and deletes, and its list spreads catalog entries for all known owners. Return an allowlisted list for this Bot and, after a write, the affected task's new state and timing. Prompt access and the editable fields are decided in Q4 and Q6 (`apps/bots-dsh/src/host/schedules.js:279`, `apps/bots-dsh/src/host/schedules.js:430-472`). |
| Settings: name, model, permission level | Reuse the host's checks via `updateBot`, with separate writes for the three allowlisted fields. Return the Bot's current name, model and effective settings visible to this phone. If a level was saved but failed to reach every Session, return the saved level and an explicit partial-application result for the phone to show. The host currently retains that failure and throws it after the update (`apps/bots-dsh/src/host/channel.js:636-638`, `apps/bots-dsh/src/host/roster.js:686-736`, `apps/bots-dsh/src/host/roster.js:830-831`). |

Build each write reply from the resulting host state. Pocket applies it directly with zero
follow-up reads from the phone or bridge. A refused write reports the refusal. A stale edit is
refused if its base entry, task or permission state changed on the desktop. After a lost reply,
the outcome is unknown to the phone. Reconcile it before permitting a retry of a write that
could be applied twice. Specify the stale-state and retry contracts before the relevant delivery.

## Contracts introduced

The management capability is additive under `herdr-pocket/chat/1` and local socket protocol 1.
`manage: 1` is its name. Align the version, capability and method intersection at both
handshakes with RFC 0033 (#1181) and the group-chat plan (#1180). Management is independent of
groups and attachments. The shared negotiation format and exact method names are specified
before delivery 1.

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

This RFC replaces the stolen-phone clause in RFC 0015
(`docs/rfcs/0015-live-chat-projection.md:743-750`): a stolen paired phone keeps its existing chat
authority and could also read or modify the approved memory and scheduled tasks of an eligible
Bot and change settings the owner enables, including any approved level transitions. Memory
text can be sensitive. Changing scheduled instructions or the Bot's permission level can also
affect what later runs on the computer. Remove the phone in Pocket Link or stop the bridge to
end access. Revocation ends management access within 2 seconds. A change already applied on the
computer remains there.

- Every call needs a live paired `herdr-pocket/chat/1` connection and a Bot currently listed
  and `shown` by DSH. Pairing gives no project `shown[]` consent. The bridge checks the target,
  derives `phone` from the authenticated paired key and forwards it to the owner-only socket.
  The host checks the Bot binding, visibility and operation at execution. The phone can manage
  the Bot with its chat closed, through this bridge and socket path alone
  (`apps/bots-dsh/src/host/pocket-chat.js:282-289`, `apps/bots-dsh/src/host/pocket-chat.js:561-565`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:265-291`).
- Count limits across connections by paired key. Share the existing 20 writes per
  minute per phone, with one management write in flight per phone and Bot and bounded reads and
  replies. The bridge's forget and 2-second checks must invalidate any queued work on the shared
  socket and stop undelivered replies for that phone. The host must reject revoked work before
  mutation. Specify that revocation mechanism and read and payload caps before coding
  (`apps/bots-dsh/src/host/pocket-socket.js:54-74`, `herdr/mods/pocket-link/bridge/bridge.mjs:196-217`).
- Keep management data in phone memory while its view is open and out of logs and disk caches.
  Document the data sent both ways, phone retention, desktop persistence and revocation in
  Pocket's privacy notice with the corresponding app delivery (`apps/pocket/AGENTS.md:41-46`).

## Deliveries

0. **Review.** Review the operations, source references and decided questions.
   Implementation follows the approved amendment to RFC 0015.
1. **Memory.** Check authorized read, edit and add with the new state in the write reply, and
   refusal of other scopes or revoked phones. Withdraw the methods to roll back remote access.
   Completed edits remain on the computer.
2. **Schedules.** Check list isolation and the task's state after pause, resume and edit.
   Withdraw the methods to roll back remote access. Saved schedule changes remain.
3. **Settings.** Reconcile #1567 (model), #1441 (channel) and #1510 before coding. Check name,
   model and approved level changes, including the saved level with partial application. Withdraw
   the methods to roll back remote access. The computer keeps its last saved settings.

Each feature ships as separate plugin, Pocket Link and Pocket PRs in that order, gated until
the peers support it. Extend existing `pocket-chat`, `memory`, `schedules`,
`roster`, `permission-change-failure`, bridge `dsh-source` and `chat`, and Android `ChatClientTest`
coverage as applicable. Check older peers, revocation and zero follow-up reads after each write.
For each feature, record the tested SHA, phone action and resulting value on the paired phone and
installed desktop. No installed-app verification was performed for this RFC.

## Decided questions

The six questions this RFC asked are decided. Q1 is the approval itself: the 19/11 delegation
approved the RFC 0015 amendment as written, for the reason the body gives (pairing, a Bot listed
and `shown`, the bridge's key-derived phone, the host's execution checks, and revocation within
2 seconds). Q2-Q6 take the answer the body already fixes; no question is open.

1. **The RFC 0015 amendment.** **Decided: approved as written.** This RFC replaces the
   stolen-phone clause in RFC 0015 with the threat model above: a stolen paired phone keeps its
   existing chat authority and gains only the approved memory, schedule and settings operations,
   gated by a live paired connection, a Bot listed and `shown`, the bridge's checks and the
   host's binding, visibility and operation checks; removing the phone or stopping the bridge
   ends access within 2 seconds, and a change already applied on the computer remains. The
   reason is the one the body gives: the phone has no other path to the Bot, and every call is
   checked at execution.
2. **Which level changes may Pocket offer?** **Decided: only the level transitions the owner has
   enabled for that Bot.** Pocket cannot raise the level, grant Full access or enable Auto on its
   own. Auto keeps RFC 0031's window confirmation with `permissionRev`; this RFC adds no remote
   equivalent, so a level change the owner has not approved is refused.
3. **Which memory scopes may the phone read or edit?** **Decided: only the selected Bot's
   approved memory scopes and entries.** `places` (all Bot and room names), unrelated scopes and
   summaries that combine them are omitted, as the body requires.
4. **May Pocket show or change the scheduled prompt text?** **Decided: yes, through the task edit
   the host already validates.** The phone shows and changes the prompt only as part of that
   edit, inside the task's allowlist; it adds no separate prompt read or write.
5. **Are global Bots, including the Main Bot, eligible?** **Decided: yes.** A global Bot,
   including the Main Bot, is eligible exactly as any other Bot that is currently listed and
   `shown` by DSH; pairing gives no project `shown[]` consent, and the same bridge and host
   checks apply. RFC 0015's global-Bot chat grant is unchanged.
6. **Which schedule fields may Pocket edit, and what are the timing and recurrence rules?**
   **Decided: the fields the host's edit endpoint already accepts for a task the Bot owns** —
   its title, prompt and timing, including recurrence — plus pause and resume through the same
   service. Timing and recurrence follow the host's existing schedule rules, the phone adds
   none, and the reply returns the affected task's new state and timing.

## Links

- #1182 (planning), #1180 (group chat), #1181 (attachments).
- [RFC 0015 — Live chat projection](0015-live-chat-projection.md#threat-model-grows-who-can-call-the-engine-and-what-it-can-send).
- [RFC 0031 — Auto permission level](0031-auto-permission-level.md).
- [RFC 0033 — Attachments from Pocket](0033-attachments-from-pocket.md#contracts-introduced).
- [RFC 0011 — Monorepo parts and releases](0011-monorepo-parts-and-releases.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md).
