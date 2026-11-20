# RFC 0040: Group chats in Pocket

| Field | Value |
|---|---|
| Status | Accepted, in delivery (2026-11-20, approved by the owner's delegate: Q1-Q7 answered with this RFC's recommendations, see Decided; amends RFC 0015, which records the amendment; deliveries 1-3 under way, none merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), herdr (Pocket Link), pocket |
| Created | 2026-11-20 |

> Approved by Guga's delegation while the owner is away (20/11); the owner may amend on return.

## Summary

List the team's group chats in Pocket, open one, read it live, send text into it and answer its
members' approvals from a paired phone, with the race the computer already has: the first answer
wins. The phone always learns how its card closed; the computer shows no receipt (Q7). The phone
may also stop a group's work, with the desktop's effects (Q3). Every part is
negotiated under the existing `herdr-pocket/chat/1` route and the bots-dsh socket's protocol 1,
as RFC 0015's DSH writes and RFC 0033's attachments were, so older phones, bridges and plugins
keep working unchanged. This amends RFC 0015, whose limits keep a phone's send to "the Bot's
current chat Session, never a group, task, archived or subagent Session".

## Motivation

#1180 (owner ruling, 2026-11-12: keep Pocket and add what upstream DS Bot's phone app has) asks
to list and open the team's group chats on the phone, read them, send into them, and answer
approvals with the computer's race. Today:

- The DSH source serves each live Bot's own current chat only: "No group, task or archived
  Sessions" (`apps/bots-dsh/src/host/pocket-chat.js:15-19`). `ownBots` lists `rt.state.bots`
  with `rt.chatOf(bot.id)` and nothing else (`apps/bots-dsh/src/host/pocket-chat.js:1074-1096`).
- RFC 0015's limits refuse a send into a group Session
  (`docs/rfcs/0015-live-chat-projection.md:685-686`).
- A member's approval in a group Session reaches Pocket's race and is passed on untouched:
  `raceApproval` calls `next()` for any Session that is not a Bot's current own chat
  (`apps/bots-dsh/src/host/pocket-chat.js:917-919`, `chatOwner` at `:1167-1170`). `approvals.js`
  then holds it for the computer's group chat (`apps/bots-dsh/src/host/approvals.js:1-3`,
  `:99-193`).
- `say()`, the one writer of a group's lines, already calls a phone hook for every record,
  `rt.roomLineAdded?.(room, record)` ("the phone link hears every line the chat will draw
  (mobile.js)"), but nothing defines it and `mobile.js` is not in this tree
  (`apps/bots-dsh/src/host/groups.js:280-293`). It is the upstream phone app's seam, left
  unused when the plugin was vendored.

The issue's route idea, a capability list like upstream's versioned handshake, is already how
this route grows: `chat/1`'s `hello` carries capabilities (`dshWrite`, `manage`,
`attachments`), and a capability under `chat/1` was preferred to a `chat/2` for writes and for
attachments (`docs/rfcs/0015-live-chat-projection.md:705-712`, `:838`). This RFC adds one more.

## What a group chat is today

- A group (a "room") is `state.rooms[id]` in the team's `state.json`: `{id, name, members,
  admin, mode, notice, createdAt, createdBy}` and, later, `sessionId`, `sessions`, `log`, `seq`,
  `seen`, `workDir`, `memberDirs`, `permission`, `goal`, `paused`
  (`apps/bots-dsh/src/host/roster.js:1184-1223`, `apps/bots-dsh/src/host/store.js:693-711`).
  `room.id` is the id of the group's first DSH Session and never changes; `room.sessionId` is
  its current part, which moves when the group's Session gets a fresh part
  (`apps/bots-dsh/src/host/parts.js:1676-1687`). The group's Session never calls a model for its
  own turn; auxiliary calls (titles) and Omni's calls for the room (image readings) still do
  (`apps/bots-dsh/src/host/groups.js:2026-2032`).
- Each member answers in its own group Session, `room.sessions[botId]`, titled
  "*member* · *room*", made in the group's folder when it has one (`room.workDir`, else the
  member's own, `apps/bots-dsh/src/host/folders.js:65-70`) and under the group's permission when
  it sets one, which then replaces the Bot's own level there
  (`apps/bots-dsh/src/host/groups.js:384-463`, `apps/bots-dsh/src/host/permissions.js:248-253`).
  Clearing a group's folder clears `memberDirs` at once, but a member turn already running
  finishes where it began (`apps/bots-dsh/src/host/roster.js:1312-1316`). The book keeps a
  `folder` notice only for a group folder found unusable (`apps/bots-dsh/src/host/groups.js:372-377`),
  so a folder that worked and was cleared leaves no trace there. A
  member asking to widen its folder raises an ordinary approval before the override is saved
  (`apps/bots-dsh/src/host/folders.js:210-218`).
- The transcript is the append-only ledger book `group-<roomId>`
  (`<team home>/ledger/group-<roomId>.jsonl`), written by `say()`. Each `say()` record has an
  integer `seq`; the round and anchor records appended beside them have none
  (`apps/bots-dsh/src/host/groups.js:1492`, `:1548`). `rt.ledger.range(book, from, to)` returns
  the records with an integer `seq` in `[from, to]`, both ends included
  (`apps/bots-dsh/src/host/books.js:153`). A team from before the ledger imports its old lines on
  first open, and only lines `ensureRoomLog` has numbered (`apps/bots-dsh/src/host/groups.js:210-246`).
  `room.log` keeps the last 60 lines for the members' turns (`:34`).
- Removing a member drops its group Session and its approvals but leaves its lines in the book
  (`apps/bots-dsh/src/host/roster.js:1284-1304`, `apps/bots-dsh/src/host/store.js:794-818`).
  Deleting a Bot takes it out of every group's members, which can leave a group with none
  (`apps/bots-dsh/src/host/roster.js:1484-1491`). A Main Bot posts into any group without being
  a member (`post_to_group`, `apps/bots-dsh/src/host/tools.js:775`).
- `rowOf` turns a record into the row the desktop chat draws
  (`apps/bots-dsh/src/host/groups.js:296-321`): a person's message becomes `kind: 'user'`, a
  member's reply has no `kind`, a notice names the member it is about (`about`), a goal notice
  carries the goal's own fields, and a member's wait is recorded as `kind: 'approval'`, a marker
  with no request id (`:1166`). Records can carry `images`, `files` and `uploads`, and their
  `text` is the caption joined with the host's image readings and file lines (`:1356-1370`); an
  image reading can name the image, its digest and its path on the computer
  (`apps/bots-dsh/src/host/images.js:135`, `:164`).
  The desktop's `group-rows` leaves out `session: true` records because it draws those from the
  group's own Session (`:327-342`).
- The person's message goes to the group's current Session as a queued prompt (`sendUser`,
  `apps/bots-dsh/src/host/channel.js:1355-1369`). A running round drains it from the inbox into
  the book (`drainRoomInbox`, `apps/bots-dsh/src/host/groups.js:941-969`): it then exists only
  as the book's `User` line, not as a message in the Session's log. A greeting round, a round
  that is finishing, a message with images or with a chat reference waits for the next round
  instead (`joinRound`, `:1248-1274`). A message also unpauses an idle group and wakes an idle
  goal (`:957-959`, `apps/bots-dsh/src/host/goals.js:654-663`).
- A chat reference is DSH's session mention, plain text `@[label](dsh-session:<payload>)`, the
  payload the base64url of the Session id's JSON (`apps/bots-dsh/src/client/at-menu.js:63-65`). DSH turns it into a read-only snapshot of that
  Session, and the group attaches the snapshot to the message for the members who answer it
  (`apps/bots-dsh/src/host/turns.js:134-141`, `:971-972`). The desktop menu offers the team's
  Bot chats and conversations outside the team (`apps/bots-dsh/src/client/at-menu.js:40-60`).
- Stop is `stop-room-work`: the round stops, then each member's turn and its subagents
  (`apps/bots-dsh/src/host/groups.js:1878-1924`). In `finally`, even when nothing ran or a step
  failed, the desktop calls `goalUserStopped`, which marks an active goal idle, bumps its
  revision and saves (`apps/bots-dsh/src/host/channel.js:845-850`,
  `apps/bots-dsh/src/host/goals.js:643-650`).
- `rt.roomActive(id)` is true while a round runs or finishes
  (`apps/bots-dsh/src/host/groups.js:1235`). Member turns, subagents and part switches can
  outlive it; the desktop reads them from `roomWorkView` (`apps/bots-dsh/src/host/turns.js:618-641`).
- Approvals in a member's group Session are `approvals.js` entries with `roomId`
  (`apps/bots-dsh/src/host/approvals.js:99-193`). A subagent under a member gets an entry with
  the same `roomId`, `child: true` and `ownerSessionId`, and emits neither `open` nor `settled`
  (`:203-238`). `settle` deletes the entry and emits `{id, outcome, decidedBy, at, why?}`, with
  no room, member or device (`:142-147`). A signal abort settles `cancelled` by `dsh`
  (`:191-192`); a member removed or its Session retired settles `cancelled` by `system`
  (`:254-258`). `answerApproval(id, 'allow' | 'reject', client)` returns nothing and throws
  `bot/stale` once the entry is gone (`:243-251`). The desktop endpoint takes `client` from the
  request body (`apps/bots-dsh/src/host/channel.js:835-837`), so `decidedBy: 'pocket'` alone
  does not prove a phone answered.
- Before any entry exists, the team's lookups are allowed (`approvals.js:100`), Auto's judge can
  decide (`apps/bots-dsh/src/host/auto-judge.js:484-498`; RFC 0031 keeps group Sessions out of
  its marks, `docs/rfcs/0031-auto-permission-level.md:108-111`), and accepted RFC 0039 adds a
  person's grant that answers before an entry opens, recorded `decidedBy: 'grant'`
  (`docs/rfcs/0039-person-scoped-approval-grants.md:53-65`; person-grant matching is not
  implemented here yet).
- Question, view and settings cards are refused in group Sessions
  (`apps/bots-dsh/src/host/tools.js:862`, `:900`, `:941`). That covers those three team tools;
  it does not prove no other provider can raise a question there. This RFC serves approvals only
  and leaves any other request on the computer.
- A group's line also reaches IM chats bound to the group (`apps/bots-dsh/src/host/im/index.js:1039-1045`).
- Rooms are not in the home registry or its `shown[]`: that consent covers Bots only
  (`apps/bots-dsh/src/host/shown.js:1-14`). An unreadable home file serves the last good read
  (`:15-18`, `:75-82`).

## Design

### Which groups a phone may open (Q2)

`groupEligible(room)` is one predicate, evaluated fresh from `rt.state` and the shown reader
each time it is used (below). Under Q2's decided answer it holds when all of these do:

1. the group has at least one current member;
2. every current member, and every Bot named by a record of its book (`botId` or `about`), is
   a Bot of the team now and is global or shown, by the same rule as a Bot chat: `shown` is
   called on the place-enriched Bot `ownBots` builds (`apps/bots-dsh/src/host/pocket-chat.js:1074-1096`,
   `apps/bots-dsh/src/host/shown.js:122-130`), never on a raw roster Bot, whose missing
   `project` would read as global; its last-good read and `placeUnknown` refusal apply. A Bot no
   longer on the team counts as not shown;
3. the group never had a folder or permission of its own. From delivery 1, the host sets a
   durable mark on the room (`room.scoped: true`, never cleared) whenever a group folder, a
   member folder override or a group permission takes effect; clearing the setting keeps the
   mark. On upgrade, before any update can erase the evidence, delivery 1 marks every room that
   already has a group folder, a member folder override or a group permission. For a group
   whose override was cleared before that upgrade nothing remains: it is judged by `room.workDir`,
   `room.memberDirs` and `room.permission` unset and no `folder` notice in its book, and its
   history from that time may show, a residual risk Q2 names;
4. now, at each check: every live member Session runs in its Bot's own folder, and its effective
   preset, read from DSH (`service.current(session)`,
   `apps/bots-dsh/src/host/permissions.js:962-966`), is within its Bot's own level. The host's
   last apply is not enough: DSH can change a live preset itself (it moves Auto to Full access,
   `apps/bots-dsh/src/host/permissions.js:104-106`), and clearing a group permission deletes the
   field before each member's own level is applied, which can fail (`:905-910`). A pending or
   failed apply, an unreadable preset, a comparison that cannot be proven, or a turn still
   running elsewhere keeps the group unavailable until it settles.

Before the first eligibility decision or book read of a group, `list` included, the host runs one
operation that numbers and imports a legacy room (`ensureRoomLog`, then the book's import,
`apps/bots-dsh/src/host/groups.js:210-246`) and reconciles the numbered legacy lines with any
book that already exists (an older host can open the book first, through memory review,
`apps/bots-dsh/src/host/memory-review.js:255-265`, and an existing book skips the importer,
`apps/bots-dsh/src/host/books.js:65`). Every recoverable speaker goes into the index; when
conflicting records leave the history uncertain, the group stays unavailable. The index is
then updated inside `say()` before any listener sees the new line.

A group that is not eligible is not listed, cannot be subscribed, and refuses writes
`not-shown`.

### Room addressing

- A group's terminal is `dsh:room:<roomId>`, with `roomId` the stable `room.id`. The prefix
  `dsh:room:` is reserved and parsed before any Bot routing on every layer: the socket's
  `subscribe` and write methods, the management methods (refused `invalid` before any Bot
  lookup; today `terminal.slice(4)` would look up a Bot named `room:<id>`,
  `apps/bots-dsh/src/host/pocket-socket.js:275-283`), the bridge's `isDsh` routing
  (`herdr/mods/pocket-link/bridge/dsh-source.mjs:1190-1203`) and Pocket's `Chat.isDsh` and
  `ChatSettings.isBot` (`apps/pocket/android/app/src/main/java/ai/namastex/automagik/ChatSettings.kt:60`).
- A room renamed keeps its terminal: the next `list` and a `status` event carry the new title.
  A room deleted, or one that stops being eligible, ends every watch on it with `gone`.

### Socket (bots-dsh, `<team home>/pocket/chat.sock`)

- **Hello.** The bridge sends a write hello and, if its reply is writable, a management hello, and
  every hello revokes management grants and can clear subscriptions on an attachment change
  (`herdr/mods/pocket-link/bridge/dsh-source.mjs:373-392`,
  `apps/bots-dsh/src/host/pocket-socket.js:435-451`). A bridge that wants groups adds `groups: 1`
  to both, and the final reply decides. The socket answers `groups: 1` only when the reply is
  writable and the group source is installed. Groups are one capability of the socket
  connection, the bridge's; a phone's own hello never renegotiates the socket.
- **Authority, per call.** Every group operation (list rows, subscribe, backfill, each live
  event, send, interrupt, answer) checks, at that moment: the connection's hello answered
  `groups: 1`; the team is still the one that answered that hello, `rt.sameTeam(gen)` with
  `gen = rt.teamGeneration()` captured when the socket answered `groups: 1`
  (`apps/bots-dsh/src/host/store.js:557-562`: a lock lost and claimed again is a new term, so
  `holdsLock()` alone is not enough). A mismatch, with or without an open watch, ends the
  connection's group offer: every group watch ends `gone`, queued rows and replies are dropped,
  the room caches (receipts, speakers, send memory) of that generation are dropped, and the
  socket closes the connection so the bridge must hello again; `rt.readOnly() === undefined`, as management does
  (`apps/bots-dsh/src/host/pocket-chat.js:1110-1117`) and as the desktop refuses mutations in a
  read-only team (`apps/bots-dsh/src/host/channel.js:514-519`); and `groupEligible(room)`. The
  same check runs again just before queued rows or a reply are released.
  Writes also need the paired phone the socket already checks (`pocket-socket.js:540`). A lost
  lock, a read-only team, a room deleted or ineligible, or a later hello without `groups: 1`
  ends every group watch with `gone` (`reason: 'not-shown' | 'unavailable' | 'deleted'`) and
  refuses the call. An operation already past its last check runs to its end (see Stop).
- **Invalidation.** A watched group is checked again on every roster save that touches it
  (members, admin, folder, rename, delete), on every event before it is sent, and every 2 s
  while watched (the source's `STATE_POLL_MS`), so a silent phone loses access within 2 s of a
  `shown[]` change.
- **List.** Only on a connection with `groups: 1`, `list` adds one row per eligible group:
  `{terminal: 'dsh:room:<roomId>', machine: null, agent: 'dsh', chat: 'group', title,
  members: [{name, registryId}], status, approvals, shown: true}`, `registryId` a Herdr `b-` id
  or null. A connection without `groups: 1` gets today's list, byte for byte.
- **Status.** One derivation for list, snapshot and live `status` events, in this order:
  `blocked` (`kind: 'permission'`) while any approval of the group waits, direct or a
  subagent's; `working` while `rt.roomActive(roomId)` or `roomWorkView()` has an entry for the
  room; `idle` otherwise. `approvals` is the number the phone can answer (below); a `blocked`
  group with `approvals: 0` waits on the computer. The source emits `status` when the derived
  value changes: on `rt.onApproval` events, on its 2 s poll while watched, and after each line.
  A paused group and a part switch read as `working` while `roomWorkView` lists them.
- **Subscribe, snapshot and cursor.** `subscribe {terminal: 'dsh:room:<roomId>', channel,
  after?}`. With the room numbered and imported (above), the source registers its live listener first, then reads the book up to a boundary
  `B = room.seq`, and queues every live record with `seq > B` behind the snapshot, in `seq`
  order. The snapshot carries the newest rows up to `B` under RFC 0015's page caps, the open
  approvals (`approvals: [...]`) and the group's `settled` receipts. A row id is
  `dsh:room:<roomId>:<seq>`. `after` names such an id: a cursor of another room, one above `B`,
  one that is not a row id, or one whose missed rows exceed one page gets `reset: true` and the
  newest page. `backfill {before}` returns rows with `seq < before`, exclusive.
- **Live lines.** bots-dsh defines `rt.roomLineAdded` once: it only queues the record for each
  watching channel and never throws (each listener in its own `try`), since `say()` calls it
  before it updates `room.log` and outside the guard of its other listeners
  (`apps/bots-dsh/src/host/groups.js:280-293`). The group source detaches from it and from
  `rt.onApproval` on teardown.
- **Row projection.** The phone gets an allowlisted row per record with an integer `seq`, never
  `rowOf`'s desktop shape:
  - a person's message: `{id, kind: 'text', role: 'user', text, time, via?}`;
  - a member's or Main Bot's message: `{id, kind: 'text', role: 'assistant', text, time, name,
    registryId}`;
  - a member event (`working`, `done`, `stopped`, `cut`, `resumed`, `lookup`,
    `permission-stop`) and a notice (`failed`, `missed`, `admin-passed`, `paused`, `folder`,
    `goal`): `{id, kind: 'status', msg, time, name?, registryId?}`, `msg` one line built by the
    host; a notice's `name` is the member it is about, never shown as its speaker. A goal
    notice carries only its line, none of the goal's other fields;
  - a historical wait (`kind: 'approval'` in the book) is a display-only `status` row ("*name*
    waited for approval"). Only a live approval, by its UUID, is ever an `approval` row.
  - `session: true` records are rows like any other: the book holds each message once, and the
    phone does not follow the group's own Session.
  - Never `images`, `files`, `uploads`, attachment ids or other goal fields, and never the
    host's image readings or file lines folded into a record's `text`. From delivery 1 on, a
    record that carries images or files also keeps its sender's own words as `caption`; the
    phone gets that caption plus a count ("2 images, 1 file on the computer"). An older record
    with images or files, whose caption cannot be told apart from the readings, gets the count
    alone. For a long post the host stored as a file (`attachLong`,
    `apps/bots-dsh/src/host/delivery.js:363-372`), delivery 1 keeps the sender's own excerpt
    before the host's note and file line are added; the phone gets that excerpt with
    `cut: true` and the count. An older long post without a separate excerpt gets the count
    alone.
  - Each row is cut to RFC 0015's limits (64 KiB of UTF-8 for `text`, 8 KiB for a preview) in
    the host, before serialization, on the snapshot, backfill and live paths alike; the bridge's
    `cutRow` (`herdr/mods/pocket-link/bridge/chat.mjs:92-96`) stays a second guard.
- **send {channel, text, id}.** On a group channel: the same cleaner, 32 KiB cap and sign-in-code
  refusal as a Bot chat; text only, a send with `uploads` refused `unsupported`; a text holding
  `dsh-session:` refused `invalid` (a chat reference is never resolved from the phone in this
  delivery; ordinary `@Name` mentions are kept). Then the desktop's path: a queued prompt on
  `rt.sessionOfRoom(room)` resolved at send time. The request id is `pocket-<h>-<id>`, `<h>` a
  short hash of the paired phone's key, so two phones' equal `id`s never meet; the socket passes
  that key to the handle (today it passes only `by`,
  `apps/bots-dsh/src/host/pocket-socket.js:551-553`). `sent` means the group's Session took the
  message into its queue; which round answers it is not promised (a greeting or finishing round
  defers it, `joinRound`). Each accepted send is remembered by team generation, room (`room.id`,
  not the part), phone and `id`, the last 64 per group in memory, and the plugin records the
  phone's request id on the book's `User` line, whichever path the message takes (queued or
  drained).
- **First send and retry.** A group send carries `retry: true` when the phone resends after
  "Maybe not sent"; a first send does not. Both bridge dispatchers and the socket handler pass
  `retry` through unchanged (today they rebuild the payload,
  `herdr/mods/pocket-link/bridge/chat.mjs:369`, `dsh-source.mjs:1195`). At first admission the
  host keeps the group Session id the message went to beside the room, phone and request id, so
  a retry after a part move still finds its attempt.
  - A first send whose id is already remembered or in the book answers the earlier result and
    is not prompted again; otherwise it is prompted.
  - A retry with that evidence answers the earlier result. A retry without it (a restart lost the
    memory and the message has not reached the book, or never was accepted) answers `unknown`
    and prompts nothing. The phone then offers "Send as new", which warns at the button that the
    group may get the message twice and sends it with a fresh `id`, as a first send.
- **interrupt {channel}.** Only with Q3 answered yes; see Stop.
- **answer {channel, row, choice}.** See the race.

### The race in a group

`approvals.js` holds a direct group approval until `entry.answer` runs once; whichever client
calls it first wins (`apps/bots-dsh/src/host/approvals.js:142-147`, `:185-193`). The phone is one
more such client; Pocket's own-chat `hold()` is not used for groups.

- **Which approvals (Q5).** `phoneAnswerable(entry, room)` is one predicate for listing,
  counting, snapshots and answering: `entry.roomId === room.id`, `entry.child !== true`,
  answerable, `room.members` includes `entry.botId`, `room.sessions[entry.botId] ===
  entry.sessionId` and `rt.groupOwners.get(entry.sessionId)` names this room and member, and
  `groupEligible(room)`, and the entry is not a member's request to work in a wider folder
  (`apps/bots-dsh/src/host/folders.js:210-218`; delivery 1 marks that request so its entry says
  so, instead of matching its text). It is checked again just before `answerApproval` runs. A
  subagent's ask (`child: true`) and a folder request are never phone cards: they count toward
  `blocked` only. Only an entry admitted as a phone card ever produces a phone close event or a
  receipt in `settled`: a folder request or a child ask settled on the computer reaches the
  phone as a status change alone.
- **Only what policy left.** The phone sees only an entry that exists and waits for a person.
  A call the team's lookups, Auto or a grant answered never opened an entry: no card, no
  receipt. The phone never makes a grant, never allows for a session, never sends `text`. A
  desktop grant action (RFC 0039) answers through the same `entry.answer` and so races the phone
  under the same single winner.
- **Binding.** The group source subscribes to `rt.onApproval` at start, seeds its map from
  `approvalsView()` (entries opened before it started), and keeps `id -> {roomId, botId, tool,
  reason, detail}` from `open`. A `settled` event it cannot map is ignored.
- **Choices.** `choice` is `allow` or `deny`; anything else, and any `text`, is refused
  `invalid`. The host translates `deny` to `answerApproval`'s `reject`
  (`apps/bots-dsh/src/host/approvals.js:11`, `:243-251`).
- **Who won.** Before calling `answerApproval(id, allow | reject, 'pocket')`, the socket handler marks
  the id with the bridge's `by` (the paired phone's name) and the phone's key. `settle` emits
  synchronously inside that call, so the `settled` listener sees the mark only when this call
  won. A `decidedBy: 'pocket'` without the mark is another client claiming `pocket` and reads
  as the computer.
- **Receipt.** One receipt per settled id, made once at settlement and bound to its room:
  `{id, by: 'phone', name, outcome, at}` when a phone's marked call won (`name` that phone's),
  `{id, by: 'computer', outcome, at}` for any other winner, and `{id, by: null, outcome:
  'withdrawn', at}` for `cancelled`, whoever settled it (`dsh` for an abort, `system` for a member
  removed), checked first. `allowed-once` → `allow`, `rejected` → `deny`. Every watching phone
  sees that same receipt, the losing phone included.
- **Kept.** The last 16 receipts per group, memory only, for at most 32 groups (least recently
  settled dropped first), dropped with the room. A phone whose answer came second
  (`bot/stale`) gets `settled` with the receipt while it is kept and the group is still
  eligible for it; after it is dropped, or after a restart, `settled` comes with no receipt and
  the card closes as "Closed while you were away", with no winner or outcome claimed (RFC
  0015's rule).
- **Cards.** A snapshot carries `approvals: [...]`, every phone-answerable entry. An
  `approval` event carries one row keyed by its id, open or closed; closing one never touches
  another. An open card row is `{id, kind: 'approval', open: true, answerable: true, choices:
  ['allow', 'deny'], name, registryId, tool, reason, summary}`, `reason` and `summary` (from
  `entry.detail`) each cut at 8 KiB, so two members' asks can be told apart; Pocket draws only
  the choices a row carries (`apps/pocket/android/app/src/main/java/ai/namastex/automagik/Chat.kt:535`).
  A closed card is the same id with `open: false`, `answerable: false` and `receipt`.

bots-dsh never answers on its own and never delays the computer: the phone's card is an extra
view of the same pending entry.

### Stop (Q3)

If Q3 is answered yes, `interrupt {channel}` on a group does what the desktop's
`stop-room-work` does, effects included: `stopRoomWork(roomId)` stops the round, each member's
turn and their subagents, and `goalUserStopped(roomId)` then parks an active goal (idle,
revision bumped, saved) even when nothing was running or a step failed. The stop is committed
when the handler passes its last authority check and calls `stopRoomWork`; from there it runs
to its end even if the phone disconnects or is removed. One not yet past that check is refused.
The reply is `sent` when the stop ran, `failed` with the first error when a step failed (the
others still stopped). The existing limit applies: one interrupt per chat every 5 s.

### Bridge (`herdr-pocket/chat/1`)

- The bridge adds `groups: 1` to both socket hellos and keeps the final reply's answer.
- A phone asks with `groups: 1` in its `hello`; the answer carries `groups: true` only when the
  socket offered groups. The grant belongs to that phone connection. `chat.list` passes the
  client to the DSH source (`list()` takes none today,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:1190-1193`) and drops `dsh:room:` rows for a
  connection without `groups: true`. `chat.subscribe` on a `dsh:room:` terminal from such a
  connection is refused `not_found`, whether or not it listed first
  (`herdr/mods/pocket-link/bridge/chat.mjs:352-358`).
- A group watch is text-only at all three layers: the bridge never asks attachments or
  documents for it (`dsh-source.mjs:1045-1053` takes them from the phone-wide offer today), the
  socket refuses `attachments: 1` on a group subscribe, and the bridge refuses sends with
  `uploads` and thumbnail reads on it.
- The bridge keeps an `approvals` map per group watch, keyed by id, not the one `sub.approval`
  (`dsh-source.mjs:492`).
- `chat.subscribe`, `chat.backfill`, `chat.send`, `chat.interrupt` and `chat.answer` on a group
  relay as they do for `dsh:` chats, with the same per-phone limits: 20 writes a minute, one
  write in flight per phone and chat, one interrupt per chat every 5 s, 16 requests in flight.
- On `gone` for a group, the bridge drops the channel's queued, undelivered events and pending
  replies before it sends `gone` (today a `gone` lets queued events drain,
  `herdr/mods/pocket-link/bridge/chat.mjs:426-447`).
- A phone's group grant is bound to the socket connection and team home it was negotiated on
  (the bridge's `this.team`, `herdr/mods/pocket-link/bridge/dsh-source.mjs:394`). A socket
  reconnect, a hello that no longer offers groups, or a change of team home ends every group
  watch with `gone` and drops the grant: until that phone sends a fresh hello, its `chat.list`
  has no groups and a group subscribe or write is refused, even when the new team also offers
  groups. The binding is checked on list, subscribe, every write and just before queued events
  or replies are released.

### Pocket (Android)

- Home and Team list the groups from a machine whose bridge answered `groups: true`, under their
  own heading, with the members' names and the group's status; a blocked group shows its
  `approvals` count, or "Waiting on the computer" when that is 0.
- Opening one reuses the DSH chat pane: each row carries its speaker's name, the composer sends
  text, and every open approval is its own card keyed by id (`State.approvals`, not the single
  `approval` the pane holds today, `apps/pocket/android/app/src/main/java/ai/namastex/automagik/Chat.kt:184-253`);
  reconnect reconciles each id against `approvals` and `settled`. The stop button shows only if
  Q3 is yes.
- A group pane has no Memory, Schedules, Settings, attachment picker or thumbnails:
  `ChatSettings.isBot` and the `showMemory`/`showSchedules` tests exclude `dsh:room:`
  (`ChatScreen.kt:193-195`, `ChatSettings.kt:60`). No group settings, members, mode, goal or
  folder on the phone.
- On `gone` the pane clears its rows, cards and composer text for that group.
- Group rows are never written to the persistent Teams cache.

## Contracts introduced

- Socket hello: `groups: 1` both ways, on a writable connection only, in both of the bridge's
  hellos; the final reply decides.
- Socket `list` rows with `chat: 'group'`, `terminal: 'dsh:room:<roomId>'`, `members`,
  `approvals`; group row ids `dsh:room:<roomId>:<seq>`; the group row projection above;
  `subscribe` snapshot field `approvals: [...]`; `send`, `answer` and, with Q3, `interrupt`
  accept group channels; a group send's `retry: true` and its result `unknown`; open and closed
  approval card rows with `choices`, `answerable` and `receipt`.
- The reserved terminal prefix `dsh:room:` on every layer.
- `herdr-pocket/chat/1` hello: `groups: 1` from the phone, `groups: true` from the bridge.
- `rt.roomLineAdded` gets its first implementation (the group source's queue-only fan-out).
- The book's `User` line gains the phone's request id when the message came from a phone, and a
  record with images or files, or a long post stored as a file, gains `caption`, its sender's
  own words (the excerpt, for a long post).
- A room gains `scoped: true`, set when a group folder, member folder or group permission takes
  effect and never cleared.
- A folder-widening approval request carries a mark its `approvals.js` entry keeps.

### Compatibility

| Peers | Result |
|---|---|
| Old bridge, new host | No `groups: 1` in its hello: today's list and methods. |
| New bridge, old host | No `groups: 1` answered: the bridge never answers `groups: true`. |
| Old phone, new bridge and host | It sends no `groups: 1`: no group rows, and a direct `chat.subscribe` on a room is refused. |
| New phone, old bridge | No `groups: true`: no Groups heading. |
| Two phones on one bridge, one with `groups: true` | Each connection gets its own list and grant. |
| Read-only socket, lock lost, read-only team | No groups; open group watches end `gone`. |
| Groups with attachments, documents or management negotiated | Those stay on Bot chats; a group watch is text-only and refuses management. |
| Team home changed or lock lost and reclaimed | Group watches end `gone`; the phone needs a fresh hello for groups. |

## Threat model

Grows RFC 0015's stolen-phone clause. A stolen paired phone can also:

- read the whole transcript of every eligible group, its earlier lines included (with Q2's
  residual risk: lines from a folder or permission override cleared before delivery 1);
- post into it. A post starts or joins a round in which several Bots run and spend, unpauses an
  idle group and wakes an idle goal. A post can ask the admin or a Main Bot to use the group
  tools they already have (`update_group` changes members, mode and admin,
  `apps/bots-dsh/src/host/tools.js:692-695`), and members' replies reach IM chats bound to the
  group;
- if Q3 is yes, stop a group's work, which also parks its goal;
- allow or deny its members' tool calls one at a time.

It cannot directly change a group's members, mode, goal, folder or permission, allow for a
session or make a grant, send a file or a chat reference into a group, open a group with a
member or speaker it may not see, touch a group that has or (as far as the host can tell, Q2) had its
own folder or permission, or approve a member's request to work in a wider folder. The existing limits
bound it (20 writes a minute per phone across its chats, one write in flight per chat, one
interrupt per chat every 5 s); removing the phone in Pocket Link ends access within 2 seconds.

Lifetimes, for the privacy notice: an open group pane keeps its rows, cards and receipts in
memory until it is left; Home and Team read the group list (names, members' names, status,
approval count) on short-lived connections every 30 s and keep it in memory between reads
(`apps/pocket/android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:1512-1525`);
none of it is written to the phone's storage or the Teams cache. A message or answer the phone
sends is recorded on the computer as the desktop's would be, with the phone's request id on the
group's line and the phone's name with an answer it won.

## Deliveries

0. **Approval.** Done: approved by the owner's delegate on 2026-11-20, Q1-Q7 answered with
   this RFC's recommendations (Decided). RFC 0015 records the amendment (its section "RFC 0040
   (group chats in Pocket)"): its wire (group terminals, `approvals[]`, the `groups` hello), its reconnect rules
   (room cursors), its send results (`retry`, `unknown`, Send as new), its receipt rules
   (several cards per chat, the receipt binding above), its limits bullet and its stolen-phone
   clause.
1. **Plugin (3.N.P).** The group source in bots-dsh behind `groups: 1`. Tests beside
   `pocket-chat` and `pocket-socket`, on socket fixtures: eligibility (an unshown member, an
   unshown former speaker, a deleted Bot, an empty group, a group folder, a past `folder`
   notice, a group permission each hide it; a project Bot read through `ownBots`, never raw;
   an untouched legacy room listed first, with an unshown speaker in its unnumbered log);
   withdrawing a `shown[]` yes while the phone is silent and while a backfill is in flight;
   a line during subscribe; an over-budget missed page (`reset`); a throwing listener that does
   not interrupt the round; the projection (no `images`/`uploads`, a historical wait is not
   actionable, `session: true` lines once); a direct ask and a child ask under the same member;
   the race both ways, two phones racing each other, `deny` settling the named id as
   `rejected` with two cards open, a body claiming `client: 'pocket'`, a second answer,
   `cancelled` by `dsh` and by `system`, more than 16 settlements and a late answer after
   eviction; a folder request never a card, and its desktop denial never a phone receipt, live
   or on reconnect; a valid folder set and cleared during a pending approval, and a member that
   keeps the old level after a group permission is cleared, and a member whose last apply
   succeeded but whose effective preset DSH now reports wider, each keeping the group
   unavailable; a room upgraded with an active override and cleared before its first list;
   a lock lost and reclaimed with no open watch, then a list and a direct subscribe; a partly
   filled legacy book beside an untouched one; a file-backed long post showing only its
   excerpt; send dedupe across a drain, a part move and a
   restart, equal ids from two phones, a first send and a retry with and without evidence, a
   retry through the phone-facing bridge after a part move and lost host memory; an
   image with a real-shaped storage path never reaching the phone on snapshot, backfill or live
   rows; `dsh-session:` and `uploads` refused; a lost lock, a lock lost and reclaimed between
   polls, and a read-only team; old-bridge hello unchanged. Rollback: withdraw `groups: 1`.
2. **Pocket Link (herdr lane).** `groups` negotiation, per-connection listing and subscribe
   refusal, text-only group watches, the per-id approval map, dropping queued events on `gone`;
   a `bridge/groups.test.mjs` with two phones holding opposite hello results, a direct subscribe
   from the older one, a mixed old/new socket, a replacement team that also offers groups, and
   one phone that negotiated groups, documents and management with a Bot and a room open, each
   operation checked against both targets. Rollback: stop asking for groups.
3. **Pocket.** The Groups heading, the group pane with several cards keyed by id and receipts,
   no management or attachment controls on a group, nothing in the Teams cache, the privacy
   lines, a decision note; Retry sends `retry: true`, and `unknown` offers "Send as new" with
   its warning; `ChatClient` and view-model tests (two cards, Deny on one, one closed,
   reconnect, more than 16 settlements, `unknown` then Send as new). Then the installed check on the desktop and a paired phone: a
   group listed, read live, a message that starts a round, two approvals open at once, one
   answered on the phone and one on the computer, and (Q3) a stop. This delivery closes #1180.

## Decided

Approved by the owner's delegate on 2026-11-20 (the note under the table), with every
recommendation below. The options not taken are listed with each answer; taking one needs a
later amendment.

1. **Amend RFC 0015 for groups?** Decided: yes, within this RFC's limits (Q2-Q7). Not taken:
   keep groups on the computer.
2. **What consent lets a phone open a group?** The `shown[]` yes is per Bot. A group's book also
   holds former members' lines, members' replies quoting them and notices about them; its
   members may work in a folder the group sets (now or before), and a group permission replaces
   each member's own level there. Decided: `groupEligible` above (at least one member; every
   current member and every Bot named in the book global or shown, a Bot no longer on the team
   counting as not shown; never a group folder, member folder or group permission, by a durable
   mark from delivery 1 on and by the best evidence before it; every live member Session now in
   its Bot's own folder and level). A group with a folder or permission of its own stays on the
   computer, its history included. Residual risk: a group whose folder or permission override
   was cleared before delivery 1's upgrade leaves no trace, and its history from that time may
   show. Not taken: (a) the current members alone authorize the whole room, its history
   and its folder (shows lines of Bots the person never showed, and project work under a global
   Bot); (b) any group with one shown member; (c) a per-group yes in the home file's `shown[]`
   (the cleanest consent, but a Herdr and registry change; a later RFC if the decided rule proves
   too narrow); (c') that per-group yes only for groups from before delivery 1, closing the
   residual risk at the cost of hiding every existing group until the person says yes; (d) a history boundary that hides lines from before the group became eligible
   (no such mark exists today, and replies still quote what came before).
3. **Stop from the phone?** Stop on the desktop also parks an active goal, even when nothing ran
   or a step failed, and stops members' subagents. Decided: yes, with exactly the desktop's
   effects (see Stop), so a phone stop never wakes the admin through the stop-notice round. Not
   taken: (a) send and answer only, no Stop in this delivery; (b) a Stop that leaves the goal
   alone (the admin would wake again, which the desktop's comment calls out,
   `apps/bots-dsh/src/host/channel.js:838`).
4. **Attachments into a group?** Decided: not now; group watches are text-only at every
   layer, and a later amendment can add them under RFC 0033's rules. Not taken: images in group
   sends from the start.
5. **Which approvals?** Decided: the members' own group-Session approvals only
   (`phoneAnswerable`). A subagent's or a task's approval, and a member's request to work in a
   wider folder (asked before the override that would hide the group is saved), stay on the
   computer; the group shows `blocked` with "Waiting on the computer". Not taken: every approval
   tied to a member; folder requests on the phone too.
6. **How is it negotiated?** Decided: a `groups` capability under `chat/1` and protocol 1, the
   precedent of RFC 0015's writes and RFC 0033. Not taken: a `chat/2` versioned handshake, the
   issue's idea taken literally, which would need every peer to speak both versions.
7. **What does the computer show when the phone answers first?** Today the desktop's group card
   simply disappears when its entry settles (`apps/bots-dsh/src/client/member-status.js:134-147`);
   RFC 0015 lets the computer's dialog close without a receipt until a display path is proven
   (`docs/rfcs/0015-live-chat-projection.md:636-643`). Decided: the same here; the phone's
   receipt and the settled entry are the record, and the Summary does not promise a computer
   receipt. Not taken: a line in the computer's group chat, "Answered on the phone (*name*):
   Allow, 14:02", which would add a desktop delivery and its test.

## Open questions

None. See Decided for questions 1 to 7.

## Links

- #1180 (this request), #1182 and [RFC 0036](0036-bot-management-from-pocket.md) (management,
  which asked to align its negotiation with this plan), #1181 and
  [RFC 0033](0033-attachments-from-pocket.md) (attachments).
- [RFC 0015 — Live chat projection](0015-live-chat-projection.md#rfc-0015-live-chat-projection-writes-on-dshbotid-chats).
- [RFC 0031 — Auto permission level](0031-auto-permission-level.md),
  [RFC 0039 — Scoped approval grants](0039-person-scoped-approval-grants.md).
- [RFC 0011 — Monorepo parts and releases](0011-monorepo-parts-and-releases.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md).
