# RFC 0014: Shared Bot registry

| Field | Value |
|---|---|
| Status | In delivery (delivery 1: #260; universal-Bot amendment: #666, #670, #674, #684; 2-9 unconfirmed; every question answered) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), desktop (3.N), herdr (3.N.P, [RFC 0011](0011-monorepo-parts-and-releases.md)) |
| Created | 2026-11-03 |

## Summary

The Bot team (DSH, `apps/bots-dsh`) and the Automagik Herdr pack (`herdr/`) keep Bots in two
places today, with two id shapes and two pet systems. This RFC proposes one Bot registry both
read and write: a `bots.json` version 2 in `~/.automagik/bots/` for Bots that belong to no
project, and in `<repo>/.automagik/bots/` for a project's Bots. It covers writes that never
overwrite each other, global Bots in Herdr, the desktop app's move to `~/.automagik/bots` (D6),
one pet folder, Bots on other machines, and the deliveries. The owner made Herdr's Bots the main
team: Automagik shows the ones the person picks, and chatting with one talks to its live Herdr
agent. RFC 0013's delivery 8 (shared Bots in the switch) waits on it.

## Motivation

The owner decided one registry and one way to register a Bot (D1), one main Bot per repo (D2),
DSH's global Bots as the level above the repo main Bots (D3), one pet system (D4, D11) and one
home (D5, D6). RFC 0013 ("Shared state") lists what the two modes need from this RFC. Today:

- The desktop app's team lives in `~/.automagik/desktop/bots` (`apps/desktop/src/dsh.js:707`,
  `AUTOMAGIK_BOTS_HOME`); a Bot team installed in the person's own dsh lives in
  `~/.automagik/bots` (`apps/bots-dsh/src/host/folders.js:23`). The split is on purpose:
  "neither sees the other's Bots or Sessions" (`dsh.js:11`).
- DSH keeps each Bot in `state.json`, written whole by one host at a time
  (`home-lock.js`). A Bot's id is the Session id of its first chat, `session-<uuid>` when DSH made it
  (`agents.js:381`), and never changes; `bot.sessionId` is the current Session
  (`store.js:402`).
- Herdr keeps a project's Bots in `<project>/.herdr/bots.json`, version 1 (`model.js:13`), with
  ids `b-` plus 10 base32 characters (`model.js:35`, refused otherwise at `:272`). It writes only
  if the file still holds the text the edit started from (`bots.js:275`,
  `automagik-herdr.mjs:184`). It reads other machines' files through herdr-core (`bots.js:41`).
- Pets: DSH reads `<team home>/pets` (`pets.js:68`); `automagik-pets bake` writes there
  (`apps/automagik-pets/README.md`). Herdr still draws its own vector characters.

Issues it links: #206 (Bots on linked machines), #226 (no workspace-level Bot), #227 (two
checkouts claim one pane), #230 (2-space JSON), #234 (edits on the main checkout block pulls).

## Decided and proposed

Decided by the owner (handoff `bot-system-unification.md`): D1 one registry, home
`~/.automagik/bots`, a repo may keep a committable copy at `<repo>/.automagik/bots/`, replacing
`.herdr/bots.json`; D2 one main Bot per repo; D3 global Bots above repo main Bots; D4 one pet
system, Codex-pet compatible, Herdr renders pets; D5 the home is `~/.automagik/bots` on every
platform; D6 the desktop app's home merges into it, the owner starts from scratch, migration is
optional and offered to others; D11 bake on demand into `~/.automagik/bots/pets/`; D27 one
registry RFC before the shared-Bot step.

Decided by the owner on this RFC (2026-11-03, relayed by t2x5):

- **Q1: A, one file per Bot.** A project with a repo file keeps its Bots only there.
- **Q2: the repo file.** `<repo>/.automagik/bots/bots.json`, version 2, `pets/` beside it.
  Today's `.herdr/bots.json` is converted.
- **Q3: ids.** Both id shapes are accepted forever. One `newBotId()` mints `b-`: Herdr uses it
  now, DSH after the check of places that take a Bot id for a Session id.
- **Q5: the pose map** as written in Q5.
- **Q4: `main` as proposed.** In the home file, a team Main Bot; in a repo file, the project's
  one main Bot.
- **Q6: one shared lock.** The CLI's helper; the mod writes through the CLI, DSH through the
  registry module.
- **Q8: the migration.** Copy, never move; offered once; everything but `workspace/`.
- **Q9: the registry home.** Registry and pets at `~/.automagik/bots` now.
- **Q12, changed: "Remote Bots in the list now".** Automagik lists, and chats with, Bots on the
  person's other machines too, not only this computer (see "Other machines").
- **Q13: as proposed.** `automagik-pets frames <id>`; builtin pets copied into the shared folder.
- **Q14: one model field per app** until ACP.
- **Q15: as proposed.** `registry.js` plus a byte-equal copy, checked by both gates.
- **Q16: as proposed.** Panes matched by project and id; edits saved in the worktree they came
  from.
- **Q18: Automagik-only.** Ids outside the pattern stay in Automagik.
- **Q19 (D29): Orca's way, hold drafts.** The transcript file, found through our own briefing
  hook's `transcript_path`, is the source of truth; hc gives status and does the sends (a
  bracketed paste, then Enter as its own write). A half-typed terminal draft is never wiped: the
  message is held, with Send now. Not Orca's hook format or server, not ACP.
- **D30: two chat backends, like Orca.** Herdr's code Bots use the live model: the chat is a
  projection of the one terminal agent, from the transcript tail, then hooks, then screen text
  as the last fallback. Input and approvals go in as terminal keys. Show-terminal is always
  available; "user won't even know". Automagik's work Bots use structured DSH (ACP) sessions.
- **D31: vendor Orca's MIT code with attribution.** Its transcript decoders, the paste and
  Enter sequence, the approval key map and the types. Not its hook format or server.
- **D32: where the projection lives.** JavaScript in `herdr/`, next to Pocket Link; the
  Automagik window imports the same module; the phone (Kotlin) only renders. RFC 0015, "Live
  chat projection" (t2ws), designs it; this RFC does not.
- **Q7, reframed.** The owner: "the real team is on herdr, the automagik one not yet really
  exist... i will want to expose some orchestrators, so that i can talk to them from within the
  friendlier interface, and switch to code when i want". Herdr's Bots are the real team. The
  main path is Herdr Bots exposed in Automagik; the handling of a clashing home stays, for
  other people.
- **Picked Bots only.** The Bots shown in Automagik are the ones the person picks ("Show in
  Automagik"). Workers and helpers stay in Herdr: D29 (chosen option text; see the D29 clarification in the log).
- **One conversation.** Chatting with an exposed Bot in Automagik talks to the same live Herdr
  agent: one conversation, seen from both windows, and Code shows the same session as a
  terminal.
- **Q10: as recommended.** A Bot removed elsewhere is hidden; its chats are kept; Restore and
  Delete.
- **Q11: as recommended.** Global Bots sit above every project; their briefing shows each
  project's main Bot and its status; messages do not fan out.
- **Q17: ask first per project.** Bots taken in from a project then get the team's default
  level.

Agreed between the two orchestrators (t259, t22n): the order of the pack's reads (delivery 2).
The owner has decided every question; none is open.

Everything else in Design is this RFC's proposal.

## Design

### Two files, one format

- **The home file**, `~/.automagik/bots/bots.json` (`$AUTOMAGIK_HOME/bots`), holds global Bots
  (no folder) and Bots whose folder is in no project with its own file.
- **A repo file**, `<project>/.automagik/bots/bots.json`, holds that project's Bots. The project
  key is Herdr's: the main checkout (`model.js` `projectOf`). A repo opts in by having the file.
- **The legacy file**, `<project>/.herdr/bots.json`, is converted (decided, Q2). Until delivery 4
  converts it, it stays version 1, read and written in place; nothing writes version 2 there.

Each Bot lives in exactly one file, with no copies to keep in step (Q1, decided: A).

The home file is in the registry home, `$AUTOMAGIK_HOME/bots`, always, whatever
`AUTOMAGIK_BOTS_HOME` says. So the desktop app and Herdr share Bots before the home move, and
still do if a person keeps two team homes (Q9).

### Schema, version 2

Top level: `version: 2`; `bots[]`; in a repo file, the optional `name` (the project's display
name) and Herdr's `categories[]`; in the home file, `projects[]`, the `{ folder, machine? }` of
each project with a repo file that either app has opened, so DSH can find them (Q12); and
`shown[]`, the person's picks: `{ project, machine?, bots: [id] }`, where an entry for a project
records the person's yes for it (`project: null` for global Bots, which need no yes). `shown[]`
is never read from a repo file.

Per Bot:

| Field | Meaning | From DSH today | From Herdr v1 |
|---|---|---|---|
| `id` | opaque, never rewritten (Q3) | `id` | `id` |
| `name`, `role`, `instructions` | text | same | same |
| `identity` | the Bot's character: `omni`, `genie`, a user's own slug (D4) | `kind` | none |
| `main` | repo file: the project's main Bot (exactly one, D2). Home file: a team Main Bot | `mainBotIds` | `kind: "main"` |
| `pet` | `{ source: "builtin" \| "team", id }` | `avatar.pet` | `look` → `<character>-<colour>`, `team` |
| `folder`, `machine` | home file only; `machine` is an `hc machine` name, absent for this computer | `workDir` | the project key |
| `agent`, `model`, `worker` (including `worker.agentHome`), `rank`, `lead`, `category`, `planned` | Herdr's seat and team fields | ignored | same |
| `dsh` | `{ model, effort, color }`, DSH's chat route and ink (Q14) | same | ignored |

DSH's ids are the ids of Sessions it made (`roster.js:203`, `createSession` at `:109`, which
takes DSH's `sessionController.create`). DSH mints `session-<uuid>` today, as every Session folder
on disk shows, but DSH does not promise that shape. A Session a host plugin hands over keeps the
host's id: the Unfold Bot adopts the root Session `unfold-root` by default
(`unfold-session-dsh/index.js:43`, `unfold-bot-dsh/src/host/unfold.js:81`). So DSH exports only
Bots whose id matches the contract pattern. A host-pinned Bot (`sessionPinned`) or any other id
stays in DSH alone, with one warning in its log (Q18).

`kind` is read only from each app's own legacy source (`.herdr/bots.json` v1, `state.json`),
never from a version 2 file.

Never in either file: memory, rooms, schedules, secrets, Sessions (`sessionId`, segments),
photos, permission levels, capabilities, browser grants or partitions. These stay in DSH's
`state.json` and folders, keyed by the same id, and in Herdr's app home.

### Writes under one lock

Every writer follows Herdr's rule today: keep the text the edit started from; just before
writing, read the file again; if it differs, save nothing. Then write a temporary file beside it
and rename it into place. A new file is created exclusively.

That compare alone is not enough. Herdr's in-app writer, `writeTextFile(path, text, expected)`
(`bots.js:285`), shares no lock with a Node writer, so DSH and Herdr can both pass the compare
from the same text, and the later rename drops the earlier edit. So every writer also holds one
lock, `bots.json.lock` beside the file, across the compare and the rename. The lock is the CLI's
existing helper (`automagik-herdr.mjs:204-238`): an exclusive create holding a pid and a token,
waited for up to 3 s, taken over when older than 10 s, and removed only by its holder. Today it
guards only the CLI's project list; `writeBotsFile` (`:184-200`) takes no lock. Delivery 2 wraps
the bots.json writes in it. The registry module carries the same helper, so DSH takes the same
lock. The mod cannot: Herdr's file API has no exclusive create, and the mod has no `fs`. So the
mod's writes go through the CLI. It can already do that: `runCli` (`launch.js:19-22`) runs
`automagik-herdr ... --json` through the pack's launcher, and the form uses it for history
(`create.js:414`) (Q6). Until delivery 2 does this, the race stays as it is today between the
form and the CLI.

- A write changes only the Bots and fields the person changed. Unknown fields and other Bots are
  kept as parsed, so DSH never drops Herdr's `rank` and Herdr never drops `dsh`.
- The indentation the file was found with is kept; a new file uses two spaces (#230).
- Herdr's form says "changed since this form opened", as now. DSH's own writes (a rename, a new
  Bot) redo the edit on the fresh text, up to three times, then notify.

DSH reads the files at load and when they change. It shows its own Bots and the Bots the person
picked in `shown[]` (see "Herdr Bots in Automagik"). A Bot nobody picked is not shown, and a
project nobody said yes to adds no Bots. For DSH's own Bots, definitions in the file win over
`state.json`; a Bot gone from the file is hidden, its chats kept, with Restore and Delete
(decided, Q10). `state.lock` keeps governing `state.json` only.

### Global Bots in Herdr

Global Bots are the home file's Bots with no folder (D3). Herdr lists them above the projects
(#226). One can be started in the team workspace (`<team home>/workspace`, DSH's folder for Bots
without one). Its briefing lists each project's main Bot with its status (Q11). RFC 0013 is
unchanged: a global Bot with a live pane is focused, otherwise Code opens on no space (D27).

### Herdr Bots in Automagik

This is the main path (decided, Q7): Herdr's Bots are the team, and Automagik shows the ones
the person picks, to talk to them in the friendlier window and switch to Code at will.

- **Picking.** "Show in Automagik" is a toggle on a Bot, in Herdr's Bot menu and in Automagik's
  list of a project's Bots. The first pick in a project asks once for that project (decided,
  Q17): "Show Bots from `<project>` in Automagik? Their instructions are used there." Picks and
  the yes go in the home file's `shown[]`, never in a repo file. Workers, helpers and unpicked
  Bots stay in Herdr only: D29 (chosen option text; see the D29 clarification in the log).
- **One conversation** (D29, D30). An exposed Bot has no DSH Session. Its chat in Automagik is a
  projection of its live Herdr agent, and Code shows the same session as a terminal; show
  terminal is always there. A Bot with no live pane gets its agent started first (D27). Input
  and approvals go in as terminal keys: when the agent asks for approval, the person can answer
  in Automagik, which sends the mapped keys. The projection, its decoders, the key map and how
  sends are paced are RFC 0015's (D31, D32), not this RFC's.
- **Drafts in the terminal** (Q19). A half-typed draft in the terminal is never wiped: Automagik
  holds the message and offers Send now.
- **Level.** A Bot taken in from a project gets the team's default level (decided, Q17). An
  exposed Bot's tools run inside its Herdr agent, under that agent's own settings, as in Code
  today; the team level governs what DSH itself does for the Bot.
- **Kept apart from DSH's team.** Exposed Bots are never written to `state.json`. They join no
  group chat and get no DSH memory in this RFC.

### The home move (D6)

What changes: the desktop app sets `AUTOMAGIK_BOTS_HOME` to `<automagik home>/bots`
(`~/.automagik/bots`) instead of `<automagik home>/desktop/bots` (`dsh.js:707`,
`dsh.test.js:18`, the comment at `dsh.js:9`). What does not: the app's `DSH_HOME`
(`~/.automagik/desktop/dsh`), so every Session stays where it is; plugin ids (`omni-ui`,
`omni-ai`), routes (`/api/omni-ui`), browser-storage prefixes (`omni-ui:`), the files inside the
team home (README "Data and backups"), and the per-Bot browser partitions in Electron's data.

The team workspace needs care. `<team home>/workspace` is the folder of every Bot without one of
its own, and their Sessions were started there. The bots-dsh README says it is untested whether
dsh finds a Session whose folder moved. So the move does not copy `workspace/`: the moved team
keeps working in `~/.automagik/desktop/bots/workspace` (Q8). A fresh team uses
`~/.automagik/bots/workspace`.

At the first start of a new app:

`state.json` below is the team file at the root of a team home (`apps/bots-dsh/index.js:85`).
`~/.automagik/bots` may already be a team home: a Bot team installed in the person's own dsh
uses it by default (`folders.js:23`).

1. No old team and no `state.json` in `~/.automagik/bots`: the app starts there. The owner's case
   (D6).
2. An old team, and no `state.json` in `~/.automagik/bots` (its `bots.json` and `pets/`
   may already be there from delivery 3): the app offers "Bring my Bots" once. Yes copies the
   old folder (never moves it) except `workspace/`, adds its `pets/` without replacing a pet of
   the same id, leaves `bots.json` alone, checks the copy, then writes `MOVED.json` (`to`, `at`,
   app version) in the old folder. No starts fresh. Either way the old folder is left as it
   was (Q8).
3. A `state.json` in `~/.automagik/bots`, from the person's own dsh, whether or not an old app
   team exists: the app does not move there, and the two teams are never merged (Q7). One home
   cannot serve two hosts: the second to load only reads (`home-lock.js:1-3`), and each host's
   Sessions are in its own DSH home.

Rollback: an older app reads `~/.automagik/desktop/bots`, still as it was when copied. What it
cannot undo: changes made after the move are only in the new home; the registry files stay, and
older apps ignore them.

### Pets in one system

One folder: `~/.automagik/bots/pets/` (D11). DSH's team pet source reads it from delivery 3, and
still lists `<team home>/pets` while the two differ. A look `{ character, colour }` is the pet
`<character>-<colour>`, baked on demand by `automagik-pets bake`; Herdr draws its
`frames/<row>-<n>.png` and keeps the vector character until the bake lands. Poses come from
`STATE_ROWS` and `EVENT_ROWS` in `apps/bots-dsh/src/client/pet.js` (Q5). Committed custom pets go
in `<repo>/.automagik/bots/pets/`. Pets not made by the bake, such as builtin `genie-clay` and
codex-pets.net pets, are Q13.

### Other machines

Automagik lists, and chats with, Bots on the person's other machines too (decided, Q12): every
machine `hc machine ls` shows connected (on the owner's setup: five machines).

- **Where they come from.** A repo file on a linked machine lives on that machine. Herdr already
  reads it through herdr-core (`bots.js:41`) and remembers the project with its machine
  (`rememberProject(key, machine)`, `bots.js:114`); those projects go in the home file's
  `projects[]` with their `machine`. DSH reads the same files with `hc file read --on <machine>`,
  and picks in `shown[]` carry the `machine`.
- **Chat.** As on this computer (RFC 0015): the pane is `<machine>/tN`, input goes through hc,
  and the agent's transcript is read with `hc file read --on <machine>`.
- **What waits for #206** (remote Bots: configure, start, inspect). Starting a remote Bot that
  has no live pane, editing its definition, and inspecting its ledger rows. Until #206 lands, a
  remote Bot without a pane is listed with "start it from that machine", and its definition is
  read-only in both apps.
- **Offline.** A machine that does not answer within Herdr's call timeout is offline. Its Bots
  stay in the list, greyed, with "`<machine>` is offline, last seen `<time>`", from the last
  good read (as Herdr does today, `bots.js:150`). Their chat shows the conversation as last read;
  the composer keeps the draft and says it cannot send until the machine is back. Nothing is
  queued to send later.

The home file is on this computer; a Bot there may name a `machine` for its folder. RFC 0013's
main reads `folder` and `machine` to pick the space; an id DSH cannot find opens the app with
nothing selected, as 0013 already says.

## Contracts introduced

- **`~/.automagik/bots/bots.json`** (`$AUTOMAGIK_HOME/bots`), version 2. New.
- **`<repo>/.automagik/bots/bots.json`**, version 2, and `<repo>/.automagik/bots/pets/`. New.
  `.herdr/bots.json` stays version 1, read and written in place; packs older than delivery 2
  do not see a version 2 file.
- **Bot ids**: `^(b-[a-z2-7]{10}|session-[0-9a-f-]{36})$` in both apps. Herdr's `ID_SHAPE`
  widens (`model.js:35`, `:153`, `:272`). Existing ids are never rewritten.
- **The desktop app's team home**: `~/.automagik/desktop/bots` becomes `~/.automagik/bots`
  (delivery 6), except where Q7 keeps it. The team's home is a public contract (AGENTS.md:14,
  "Plugin ids, routes, storage prefixes and the team's home"), so this RFC changes it on
  purpose: AGENTS.md:14 gains the rule for the move, and README.md:30 ("From 3.12 the team's
  home ...") changes with it. Plugin ids, routes, storage prefixes and DSH_HOME do not change.
- **`MOVED.json`** in the old desktop home. New.
- **`shown[]`** in the home file and the "Show in Automagik" toggle in both apps. New.
- **DSH runs `hc` and `automagik-herdr`** for exposed Bots' chats (delivery 9). New.
- **`~/.automagik/bots/pets/<id>/`**: the shared pet folder (D11), now also read by Herdr.

## Threat model

A repo file arrives with a clone, so its text is untrusted. Herdr already feeds a repo's
`instructions` to its main Bot's briefing; this RFC adds DSH as a reader.

- **What Herdr starts.** A repo file's `agent`, `model`, `worker.agent` and `worker.template`
  choose the program Herdr starts and its arguments (`automagik-herdr.mjs:1115-1152`). This is
  so today with `.herdr/bots.json`. The controls: the agent must be in Herdr's closed table
  (`models.js:14`, refused otherwise by `startableAgent`); worker fields may not start with a
  dash, and `worker.template` must match `TEMPLATE_SHAPE` (`model.js:72`, `:83-93`); the CLI's
  start refuses a seat model pin the agent does not list (A12, `automagik-herdr.mjs:1138`).
  **Known gap:** the parser does not refuse a seat `model` that starts with a dash
  (`model.js:170`, unlike the worker fields at `:88`), and `modelArgs` puts it after `--model`
  (`models.js:229-235`). t2x5 files it as an issue.
- **Fields a repo file cannot set.** `folder`, `machine` and `dsh` (DSH's model, effort and ink)
  are read from the home file only; in a repo file they are ignored. The schema has no level,
  capability, grant or secret field.
- **Pet ids** are checked as one path segment (`cleanPetId`, `pets.js:27`) before any path is
  made from them.
- **Instructions become a prompt.** A repo Bot's `instructions` are used in Automagik once it
  is shown there. Herdr lists every repo it opens in `projects[]`, so that list is only an
  offer: Automagik shows a project's Bots only after the person says yes for that project and
  picks them (decided, Q17). The yes is kept in the home file's `shown[]`, never in a repo file
  that could vouch for itself.
- **Level.** A Bot taken in gets the team's default level, as any new Bot does (`roster.js:222`;
  decided, Q17). If that default is Full access, it applies to such a Bot too.
- **Sending to a pane.** The DSH host sends to a Herdr pane only what the person typed or chose
  in that Bot's chat, an approval included; it never answers a prompt on its own. No DSH tool
  is given `hc`.
- **The chat projection** (RFC 0015 details each):
  1. Transcript rows render as text or sanitized markdown only: no raw HTML, and no remote image
     loads by itself.
  2. A `transcript_path` from a hook payload is accepted only inside the agent's own transcript
     folders (such as `~/.claude/projects`, `~/.codex/sessions`), on this computer and through
     `hc file read --on`. So no `~/.ssh` file ever reaches a chat.
  3. The per-project yes is keyed by machine and project.
  4. The pasted message is sanitized: `ESC[200~`, `ESC[201~` and every other control sequence are
     stripped before the bracketed paste.
- `identity` from a repo file sets the look only: Omni's or Unfold's tools come from DSH's own
  `kind`, never from the file (Q17).
- The home file is the person's own, like `state.json`: no new boundary. A remote machine's file
  is reached only through an `hc` machine link the person made.

Undo: delete the file, or revert the delivery; `state.json` keeps every DSH Bot.

## Failure modes

- A file that does not parse: the app shows its last good read with a warning and writes nothing
  until it parses (Herdr does this today).
- Windows refuses a rename over an open file: retry for up to a second, then not saved.
- A machine that is away: its Bots show stale, as Herdr does today (`bots.js:150`).
- A bake fails: the vector character stays; DSH falls back to `genie-clay` as now.

## Deliveries

1. **The registry module** (plugin). Parse, check and write-if-unchanged for version 2, readers
   for v1 and `state.json`, one `newBotId()`, in `apps/bots-dsh/src/shared/registry.js`. Nothing
   uses it yet. *Check:* unit tests on fixtures: Herdr's v1 test files, a `state.json`, unknown
   fields kept, a stale write refused. *Rollback:* revert; nothing reads it.
2. **Herdr reads version 2** (herdr). A byte-equal copy of the module (checked in the gate);
   `botsFileOf(key)`: the repo file, else `.herdr/bots.json`; `projectOf`'s walk-up finds both;
   the briefing hook follows; `session-` ids accepted; global Bots listed read-only; the mod's
   writes go through the CLI under the lock (Q6). Its one new write: a project with a repo file
   (v2 or legacy) that Herdr opens is added to the home file's `projects[]`, so DSH can offer it
   (nothing is shown without a yes; see Threat model). The CLI's lock helper now wraps
   `writeBotsFile`.
   *Check:* the herdr gate; a v2-only project shows its Bots and briefs its main Bot; a v1
   project is unchanged; the mod reads `~/.automagik/bots/bots.json`, which is outside any
   project and outside Herdr's app home (`bots.js:5` says Herdr's own file writes stay in its
   home); the CLI writes it; a form edit and a CLI edit started from the same text leave one
   saved and one refused. *Rollback:* a later pack that reverts it (the pointer never
   downgrades); v2 files stay and v1 projects never changed.
3. **DSH shares its Bots** (plugin). At its first load bots-dsh writes every Bot the home file
   lacks whose id matches the pattern (Q18), then writes definitions on each change. It reads the
   home file and the listed repo files (v2 or legacy) on this computer and, through
   `hc file read --on`, on the linked machines (Q12), shows the Bots picked in `shown[]`
   with DSH's side of the toggle and the per-project ask, and reads pets from the registry home.
   A picked Bot shows with Code to reach it; its chat is delivery 9. First it checks that the
   views that list Bots (sidebar, mentions, groups, usage) take a Bot that is not in
   `state.json`. DSH keeps writing every definition field of its own Bots to `state.json` as
   well; exposed Bots are never written there. *Check:* a Bot picked in Herdr shows in DSH; a
   Bot on a linked machine shows with its machine, and greys out with "offline" when that
   machine stops answering; a project nobody said yes to adds no Bots; a DSH rename shows in Herdr; two writers racing lose
   nothing. *Rollback:* revert. It holds because `state.json` still has every DSH Bot with
   current definitions; edits made in Herdr after the last DSH save are not in it, and the files
   stay. Exposed Bots were never in `state.json`, so the older plugin does not show them.
4. **Herdr writes version 2** (herdr). New projects get the repo file; a legacy file is
   converted (decided, Q2) the first time Herdr writes that project's Bots (write new, then
   delete old); global Bots are created and started in
   Herdr. A converted project has no `.herdr/bots.json`, so a pack older than delivery 2 shows no
   Bots there until it updates through the herdr lane. *Check:* the gate; a converted project
   keeps its ids and panes. *Rollback:* a reverting pack; converted projects stay version 2,
   which delivery 2 still reads.
5. **Pets in Herdr** (herdr, after `automagik-pets` installs to `~/.automagik/bin`). Draw the
   `pet`, bake on demand, the pose map. *Check:* `herdr-app check am-sidebar`; a DSH look shows
   on the same Bot's row. *Rollback:* a reverting pack; vector characters return.
6. **The home move** (desktop). `AUTOMAGIK_BOTS_HOME`, the first-start offer, `MOVED.json`, and
   Q7's rule. *Check:* a fresh install uses `~/.automagik/bots`; "Bring my Bots" opens the old
   team with its chats; No leaves the old folder untouched. *Rollback:* as in "The home move".
7. **Other machines: edit and start** (herdr, after #206). Writes to a linked machine's repo
   file with the same rule, and starts a remote Bot that has no pane. *Check:* an edit from this
   computer lands there; a stale one is refused; Automagik starts a remote Bot (chatting with it
   is delivery 9's check, once both have shipped).
   *Rollback:* a reverting pack; that machine's files go read-only again, and remote Bots without
   a pane wait to be started there.
8. **Show in Automagik, in Herdr** (herdr). The toggle in the Bot menu and the per-project ask,
   writing `shown[]` through the CLI under the lock. Worker panes get no toggle: D29 (chosen option text; see the D29 clarification in the log). The
   briefing hook (`briefing.mjs`) passes the agent's `transcript_path` on, for RFC 0015's
   projection. *Check:* the gate; a pick in Herdr shows the Bot in DSH and unpicking hides it;
   the hook's output names the transcript of the pane's agent. *Rollback:* a reverting
   pack; the picks stay in the home file and DSH's toggle still works.
9. **One conversation** (plugin, after deliveries 3 and 8 and RFC 0015's projection module). The
   Automagik window imports RFC 0015's module (D32) for an exposed Bot's chat, starting the agent
   when it has no pane. *Check:* a message sent from Automagik is answered in the terminal and
   both windows show the same turns; a message typed in the terminal shows in Automagik; a
   terminal draft is never wiped; an approval answered in Automagik lands in the terminal; the
   same holds for a live pane on a linked machine. *Rollback:* revert; picked Bots show
   without a chat, and Code still reaches them.

RFC 0013's delivery 8 can start after deliveries 1-3.

## Amendments

### Universal Bots: one Bot, one DSH Session, two faces (2026-11-07)

Owner decision D4 (2026-11-07, relayed by t3q1; wish `pocket-four-tabs`, Group 0a): a
project's orchestrator is one Bot. It is defined once in this registry, runs as Claude Code
through DSH's ACP route, and shows as a DSH chat in work mode and in Herdr in code mode. Pocket
shows it once. The dsh-tui question this raised was spiked before this text was written:
[dsh-tui-resume-spike.md](../research/dsh-tui-resume-spike.md).

**The field.** Per Bot, `universal`, a boolean.

- Default: `true` for a repo file's `main` Bot (the project's one main Bot, D2), `false` for
  every other Bot, the home file's included.
- `universal: false` on a main Bot opts it out; `universal: true` makes any other Bot universal.
- A reader that predates the field keeps it as an unknown field (Q15) and treats the Bot as it
  does today.

**The runtime.** A universal Bot runs as one DSH Session on the `acp-claude` route
([RFC 0003](0003-model-routes-and-acp.md): `@agentclientprotocol/claude-agent-acp` over the
person's own `claude` CLI), served by the desktop app's DSH host (`DSH_HOME` is
`~/.automagik/desktop/dsh`, `apps/desktop/src/dsh.js:771`).

- It gets DSH's tool set and DSH's approvals, as RFC 0003's Amendments give every ACP Session.
- Its model and effort are `dsh.model` and `dsh.effort`. Herdr's `agent`, `model` and `worker`
  fields do not start anything for it: Herdr starts no Claude pane for a universal Bot.
- The Session is the Bot's only runtime. Nothing else runs Claude Code for that Bot, so there
  is never a second conversation to keep in step.
- It still needs the project's yes (Q17, `shown[]`): without it the Session is not started and
  the Bot stays in Herdr, as an unpicked Bot does today. Being universal is never that yes.

**The faces.** [RFC 0013](0013-work-code-switch.md)'s mode picks which face is in front. Both
faces show the same Session.

- **DSH face (work).** The bots-dsh chat of that Session, in the Automagik window, and on the
  phone as `dsh:<botId>` (`herdr/mods/pocket-link/bridge/dsh-source.mjs:1-4`).
- **Herdr face (code).** A Herdr pane on the Bot's folder that shows the same DSH Session. It is
  never a projected Claude pane (RFC 0015) and never a second runtime. DSH lets one process
  write a Session at a time (the spike), so while the desktop host serves the Session the pane
  is a read-and-type view of it: it reads the Session through the host and sends through the
  host. `dsh-tui --resume <id>` takes the Session over only when the desktop host is not
  holding it (a handoff, not a shared pane). Wish Group 6 builds the view.

**What this supersedes, for universal Bots only.**

- `:77-85`: Q19's "not ACP" and D30's live model. A universal Bot's chat is its DSH Session, not
  a projection of a terminal agent. Its input and approvals go through DSH (the adapter's
  `canUseTool`, then DSH's approval service), not terminal keys.
- `:215-217`: "An exposed Bot has no DSH Session", and Code showing the agent as a terminal. A
  universal Bot has exactly one DSH Session, and Code shows that Session.

What does not change:

- D30, Q19 and "One conversation" hold for every Bot that is not universal. Workers, helpers
  and every other Herdr code Bot stay live terminal agents, projected by RFC 0015.
- Q14's per-app model fields hold for those Bots.
- The lines above are left as written, so these citations keep their numbers.

The identity check (one Bot id in both apps, wish Group 2) and the faces (wish Group 6) build
on this amendment.

## Open questions

No open questions. The owner answered all nineteen (see Decided); they stay below as the record.

1. **What is a repo's "committable copy" (D1)?** *Decided:* A, one file per Bot. A home Bot whose
   folder later gets a repo file stays at home until the person moves it.
2. **Repo path and version.** *Decided:* `<repo>/.automagik/bots/bots.json`, `version: 2`,
   `pets/` beside it; today's `.herdr/bots.json` is converted.
3. **Id shapes and the mint.** *Decided:* accept both shapes forever; one `newBotId()` that
   mints `b-`; Herdr uses it now, DSH after the check of every place that takes a Bot id for a
   Session id (such as `chatOf` at `store.js:413`).
4. **`main` and `identity`.** *Decided, as proposed:* in the home file `main` means a team Main
   Bot, in a repo file the project's one main Bot.
5. **The pose map.** *Decided:* working→running, idle→idle, needs-you→waving once
   then waiting, done→review, failed→failed, asleep→sleep strip, jumping as a one-shot event.
6. **How the Herdr mod takes the lock.** *Decided:* one shared lock, the CLI's helper
   (`automagik-herdr.mjs:204-238`); the mod writes through the CLI, DSH through the registry
   module.
7. **`~/.automagik/bots` is already another dsh's team home.** *Decided, reframed:* the main path
   is Herdr Bots exposed in Automagik (see Decided). For other people the clash handling stays:
   a Bot team installed in their own dsh lives there (`folders.js:23`), two hosts on one home
   leave the second read-only (`home-lock.js:1-3`), so the app keeps its team in its old home,
   says why once, and still shares Bots and pets through the registry home (Q9).
8. **The migration offer.** *Decided:* copy, never move; offered once; everything but
   `workspace/` (the moved team keeps its old workspace folder; the old folder stays until the
   person deletes it).
9. **The registry home apart from the team home.** *Decided:* registry and pets at
   `~/.automagik/bots` now, so sharing does not wait for the move.
10. **A Bot removed in Herdr.** *Decided, as recommended:* DSH hides it and keeps its chats and
    memory, with Restore and Delete; nothing is archived without the person.
11. **Global Bots (#226).** *Decided, as recommended:* no membership field yet: every global Bot
    is above every project; its briefing shows each project's main Bot and status; messages do
    not fan out.
12. **Which repo files DSH reads, and other machines.** *Decided, changed:* "Remote Bots in the
    list now". DSH reads the home file's `projects[]` on this computer and on every linked
    machine, and chats with remote Bots too; editing and starting them waits for #206 (delivery
    7). An entry whose file is gone is dropped by the next reader that finds it gone (Herdr's
    #229 has the same gap).
13. **Pets the bake cannot make** (`genie-clay`, market pets). *Decided, as proposed:* `automagik-pets
    frames <id>` cuts Herdr's frames from any v1 or v2 spritesheet; builtin pets are copied into
    the shared folder.
14. **One model field or one per app?** *Decided:* per app: Herdr's `agent`, `model` and
    `worker`, DSH's `dsh.model` and `dsh.effort`, until RFC 0003's ACP route makes one possible.
15. **Where the module lives.** *Decided, as proposed:* `apps/bots-dsh/src/shared/registry.js`, with a
    byte-equal copy in `herdr/mods/am-sidebar/` that both gates check; a schema change ships
    plugin first, then herdr, and readers keep unknown fields.
16. **Clones and the main checkout (#227, #234).** *Decided, as proposed:* a pane is matched by project
    and id; edits from a worktree are written in that worktree, reads stay on the main checkout.
17. **Trust in a repo file.** *Decided:* ask first per project; Bots taken in then get the team's
    default level. `identity` never grants a plugin's tools (Threat model).
18. **Ids DSH did not mint as `session-<uuid>`.** Host-pinned Bots (Unfold's `unfold-root`) and
    any id outside the pattern. *Decided:* they stay Automagik-only and are not exported.
19. **How Automagik talks to the live agent.** *Decided* (D29 Q19, with D30-D32): Orca's way,
    with drafts held; see Decided. The owner asked to "check how orca does it". Orca
    (`stablyai/orca` at `e1dfc022`, MIT) shows a terminal agent as chat from its transcript file
    first, then hooks, then screen text. It types into the same terminal: a bracketed paste,
    then Enter as a separate write. Approvals are answered with keys. Unlike our rule, it clears
    any half-typed terminal draft first. The research is in
    `~/.config/herdr-app/handoffs/bot-chat-backend/orca-research-2026-11-03.md`. RFC 0015 designs
    the mechanism.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: none.
- Merged changes that cite this RFC: #236, #253, #257, #259, #260, #272, #273, #282, #309, #321, #407, #508, #523, #666, #670, #674, #684, #847 (last merged 2026-11-09).

## Links

- Handoff: `~/.config/herdr-app/handoffs/bot-system-unification.md` (D1-D6, D11, D27, D29-D32;
  "Agreed between orchestrators"; "Headless bake design");
  `bot-chat-backend/orca-research-2026-11-03.md`.
- RFCs: [0013](0013-work-code-switch.md) "Shared state" and delivery 8; 0015 "Live chat
  projection" (t2ws, not yet written);
  [0011](0011-monorepo-parts-and-releases.md) lanes and the herdr pointer;
  [0003](0003-model-routes-and-acp.md) model routes; [0010](0010-desktop-sandbox.md).
- Code: `apps/desktop/src/dsh.js:707`; `apps/bots-dsh/src/host/{folders,home-lock,roster,store,pets}.js`;
  `apps/bots-dsh/src/client/pet.js`; `herdr/mods/am-sidebar/{model,bots,create,briefing}.js`,
  `bin/automagik-herdr.mjs`; `apps/automagik-pets/`.
- Issues: #206, #226, #227, #230, #234.
