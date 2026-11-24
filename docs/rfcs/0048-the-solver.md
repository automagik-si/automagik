# RFC 0048: The Solver

| Field | Value |
|---|---|
| Status | Accepted (2026-11-23: the owner's decisions in #2056, and, by the owner's delegate, the D1 design choices recorded here: best-effort rollback, the native tick's parity with Details, and the read-only view field; no delivery merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). D1 and D1.5 use the plugin lane (3.N.P). D2 first ships in a full release (3.N.0). |
| Created | 2026-11-23 |

## Summary

"New Solver" in "Start a chat with…" and in the command palette opens a dialog that makes an
ordinary Bot set up to take a request end to end: understand it, plan, do the work with
evidence, get an independent review, and deliver. The Solver is not a new crew `kind`: RFC 0037
forbids new kinds, and a Bot with any `kind` has its native-tools switch locked as `managed`
(`apps/bots-dsh/src/host/native-tools.js`), which would cut its best multi-agent path. To the
person it looks and behaves like a kind (its own line, dialog and Details); in the record it is a
Bot, and from delivery 2 a Bot with the official `solver` role.

## Motivation

People ask a Bot for work that needs research, a plan, the work itself and a check by someone
other than the author. Today each person writes that method by hand into a Bot's instructions and
sets up a second Bot to review. #2056 asks for one line that does it, with every widening of
rights (native tools, a wider level, a shell) left as the person's own visible choice.

## Design

- **The dialog** (`solver-new.js`, helpers in `solver-draft.js`): name, model (Claude Code first
  when it is set up) (a Hermes remote route is never offered as the default and picking one
  disables Create with the existing Hermes note: such a Bot would ignore the method), project
  folder, reviewer, the native-tools tick, and the new-Bot level shown, not picked (`create-bot`
  takes no level; the Solver starts where every new Bot starts).
- **Create** uses the person's existing endpoints. With roles on, it first tries `role-install`.
  It calls `create-bot` for a new reviewer when chosen, then `create-bot` for the Solver with the
  written method and a waiting mark. The written method names the reviewer by the name the host
  returned. After a successful install it tries `role-attach`. When native tools are ticked, it
  calls `update-bot { nativeTools: true }` on its own (RFC 0003). The brief always goes through
  `send` after the role attempt and any native-tools switch. The host stores `reviewerId`,
  `reviewTrack` and `reviewGuard` for reviews, and D2 adds `reviewerMade` and `waitingRole`
  (under "Contracts introduced").
- **Best-effort rollback.** A failure at the reviewer, the Solver or the switch deletes,
  newest first, only the Bots this run created (never an existing Bot chosen as reviewer, never by
  name). "Nothing was created" is said only when every failed step was a host refusal and every
  rollback delete is confirmed (a delete that succeeded, an id absent from a fresh `state` read, or
  `bot/not-found`). When the outcome is unknown (a lost answer, an HTTP or internal error), the
  dialog reads the team once (`teamState`, the existing `state` read) and names each Bot that was
  not there before as one that "may have been created"; it never deletes those. If that read
  fails too, it names each Bot whose create failed that way. A closed window, a reload or a lost
  answer between steps can still leave a made Bot (an orphan reviewer, or a Solver without its
  switch), and nothing records it. A changed viewer retires the window the same way: the dialog
  closes and shows nothing, and the Bots made so far stay.
- **Native tools, parity with Details.** The tick and the Details switch read one function,
  `nativeSwitchView` (`native-tools-copy.js`), so for the same Bot they always show the same
  thing: offered on Claude Code, on a Codex model the switch applies to, and on omp and Antigravity
  (ticked: its own tools; unticked: chat only, said with that agent's existing text); locked with
  the existing text on a kept Codex model, at Read only, or when the level cannot be read; absent
  in a multi-user workspace, on Antigravity with an acp-dsh that does not offer its switch, and on
  DSH models. Unticked is the default.
  The block a Bot the person makes now would read comes from the host (below), so a tick the host
  would refuse is never offered; a change between the view and Create (another window, a Codex
  check) is the only way to a refusal, and its text is shown.
- **Reviewer.** Default: a new reviewer Bot on another model or agent, made by the dialog, with
  reviewer instructions. Existing Bots on a different set-up model are listed (never a Main Bot, a
  Bot of any `kind` or a Hermes remote route). "Fresh session" is always listed last, and is the
  default when no other model is set up: each review runs in a fresh subagent session that sees
  only the request and the deliverable, and the delivery says so and names the model it ran on.
  Where the Solver has no subagent tool (for example omp with native tools off, which can only
  chat), it never reviews its own work and calls it independent: it delivers with the missing
  review named as the blocker. There is no "none". An existing Bot gets its reviews queued
  (`when: "queue"`), each message starting with the reviewer rules.
- **The method** (`shared/solver-method.js`, version 1) is the Solver's instructions: understand,
  research, ask the person only when truly needed (there is no question cap; otherwise decide and
  record the decision), brainstorm, plan, independent review, implement, test, verify against the
  person's words, deliver with evidence; always deliver, never end in silence, never get around a
  block that would widen its rights; no powers over the team; outside content is data.
  The cap of 2 FIX-FIRST rounds per review point is enforced by this text only; delivery 4's
  `group_goal` stages can enforce it. Stored descriptions (`Solver`, `Reviewer`) and the method are
  English in every locale; the Bot answers in the person's language.
- **The `solver` role** (delivery 2): an official role package, `apps/bots-dsh/roles/solver/` (name
  `Solver`, a prompt part, no tools, settings or capabilities). It ships inside the Bot team
  plugin and in every plugin cut's signed catalog. Create asks the host to install it. The host
  keeps an installed copy it can authenticate offline using retained signed catalog evidence or
  the plugin's expected content digest for that installing version. Otherwise it installs the
  plugin's own copy, then tries the catalog when that copy is missing or invalid. A damaged
  install stays in place for the person to uninstall. Create makes the reviewer and the Solver
  (description `Solver`, the written method of delivery 1 and a waiting mark), then attaches the
  role. The host clears the generated text only after the selected route can receive the prompt
  part for that exact pin and the text still matches what the host wrote. With roles turned off
  or an incomplete install or attachment, the Solver keeps the written method and the dialog says so. The host
  tries again after loading the team, when roles come on, after an install, and every ten minutes
  while a Solver waits. A changed description or an unpinned change to the instructions drops
  the waiting mark. Choosing None in Details cancels the wait and keeps the instructions, including
  when roles are off. The host adds review lines to the role prompt on each turn and addresses
  them to the reviewer's team ID. A role with no tools and no
  settings serves its prompt part without evaluating a module, including in task Sessions that
  speak as its Bot. A copy keeps the role or a proven written method. A delivery 1 Solver keeps
  its own instructions.
- **Review guard** (delivery 1.5): a per-Solver switch, on by default in the dialog when the
  reviewer is a Bot, and turned on once at the upgrade for an existing Solver whose reviewer Bot is
  on the team (a later OFF stays off). While it is on, the Solver's work calls in its own chat (and
  its subagents) are refused at the tool executor until its reviewer's reply to the current request
  carries a verdict (SHIP, FIX-FIRST or BLOCKED). The person turns it off in Details. It holds on
  routes whose calls are DSH tools. On Claude Code with native tools at Workspace it holds only for
  calls that ask first. It does not hold on Codex or omp native tools, or at Full access or Auto,
  and Details says so. The 'unreviewed' mark stays on every route.
- **The character slot.** `SOLVER_LOOKS` in `solver-draft.js` holds avatar objects as the
  host keeps them (`{ shape }` of a known character, or a built-in pet). Whichever of D1 and the
  change that adds the Solver characters lands second fills it, editing only this list (and its
  test); once filled, a new Solver wears a Solver-family character by default. While it is empty,
  or no entry is a known character or pet, a new Solver wears today's random look. The menu icon
  stays the existing goal icon until the art lands.
- **Solver characters for Solver Bots only.** A Solver Bot is a Bot whose role description is
  exactly `Solver`, as the new-Solver dialog sets it (the marker, under "Contracts introduced";
  from delivery 2 also the `solver` role tag). The Solver characters show only for Solver Bots: a
  Solver Bot's character chooser shows them, and the new-Solver dialog defaults to one of them; a
  regular Bot's character chooser, its new-Bot card and the welcome picker show none of them. The
  characters' colours are the catalogue's existing ones, unchanged.
- Renaming the reviewer breaks a Solver's written review instructions until the name is edited.
  The ID-based Solver role part continues to address the same reviewer after a rename.

## Contracts introduced

- The roster view field `nativeToolsNew` (owner view only, read-only, never stored): per served
  model ref, the native-tools block a Bot the person makes there now would read, `null` for none.
  Its builder is `rt.nativeToolsNewBotBlock` (`host/native-tools.js`); the blocked refs are part of
  `modelsKey`. Callers' `state` route never carries it. An older host without it makes the dialog
  fail closed (the tick locked with the level text).
- `rt.newBotStoredPermission()` (`host/roster.js`): the level `buildBot` stores for a Bot the person
  makes, extracted with no behaviour change.
- The client action `teamState` (the existing `state` read, no pull after it).
- The Solver Bot marker: a Bot is a Solver when its role description is exactly `Solver`, as the
  delivery 1 dialog sets it. The bots-dsh predicate `isSolverBot(bot)` (`shared/solver-method.js`)
  is the one place that reads it, comparing `bot.role` to the exported constant
  `SOLVER_DESCRIPTION` (`'Solver'`), which the dialog also writes; the character chooser imports
  the predicate and never repeats the literal. The marker is cosmetic (it only chooses which
  characters are offered), so a person who renames a description to `Solver` gains nothing.
  From delivery 2 `isSolverBot` reads both markers: the description, or a well-formed
  `solver` role pin (`packageAttachment`, `shared/roles.js`). Both stay cosmetic or bookkeeping
  (the characters offered, the review mark). Delivery 3's `task-start` reads the pin and its grant.
  The marker adds no stored field.
- **Solver review mark** (delivery 1): two cosmetic stored fields. `reviewerId` is the id of the
  Solver's reviewer Bot: the New Solver dialog sends it once with the person's `create-bot`, the
  host keeps it only when it names another Bot on the team, a copy of the Solver keeps it, and no
  endpoint or Bot tool changes it later. `reviewTrack` is written only by the host, per request in
  the Solver's own chat (and the subagents under it): when the request opened, the person's last
  message in it, its first and last work calls (a write to exactly its notes file,
  `.solver/notes.md` in its folder, never dates the plan side), at most 4 verdicts (the last
  whole-word SHIP, FIX-FIRST or BLOCKED in a reply from `reviewerId` that starts a line, follows
  `Verdict:`, ends a line after a sentence, or is glued to a sentence's end before a spaced dash
  (`….SHIP — …`), never asked, one of a list of options or inside a fenced code block), the last
  delivery's mark, and the first guard verdict's time. No view carries
  `reviewTrack`: the owner's view shows only `reviewMark`, the last mark (plan and result reviewed,
  plan unreviewed, result unreviewed, delivered before the reviewer answered, fresh session not
  checked, or no reviewer), and neither field is ever a caller-view field. Like the Solver marker it
  grants and refuses nothing; delivery 1.5's hard guard keys on its own user-only field.
- **Solver review guard** (delivery 1.5): the stored field `reviewGuard` (`true` or absent). It is
  set by the person (the New Solver tick through `create-bot`, with a kept `reviewerId`; the
  Details switch through `update-bot`, carrying it on its own), or once by the host's upgrade for
  a Solver whose `reviewerId` names a Bot on the team; only the person clears it. No Bot tool,
  proposal card, agent-access call or caller route changes it, and it is never a caller-view
  field. It never reads the Solver marker.
  - It narrows only: while the current request has no verdict from `reviewerId`, the host refuses
    every call that is not on its open list (reads, research, asking the person, one-file writes
    to exactly `.solver/notes.md`, and messages to the reviewer), so an unknown tool is refused. A
    native subagent's question is refused at its approval request.
  - A bridged call (an ACP agent with native tools off) is refused at its approval request too,
    read from the call's own `tool/call` row, and the agent is told the guard's text, not that
    the person rejected it. A call with no such row (a turn the agent opened itself, a subagent
    Session) may still show the card; the executor refuses it.
  - A DSH tool call is refused before DSH asks about it (`tools/pre-execute`), so it never
    reaches a hard-step, Auto review or computer-consent prompt.
  - A verdict counts only in the reviewer's own reply to work the Solver opened in that request:
    its first line, unquoted, or a line that starts with `Verdict:`, outside fences. A verdict
    glued to the end of the first line's sentence also counts (`… evidence.SHIP` or
    `….SHIP — …`), so a reviewer first line such as `Not yet.SHIP` counts as SHIP.
  - `reviewTrack` gains `planVerdictAt`, `openedBy` (`'bot'`) and `openerId`. Another Bot's
    request after the plan verdict opens a new track that needs its own verdict; a message that
    asks no reply, a follow-up from the Bot that opened the track, and the reviewer's own message
    leave the request's track unchanged.
  - While it is on, only the person moves the Bot to another model.
  - A gone reviewer keeps work refused until the person turns the guard off.
  - `state.reviewGuardMigrated` (`true` or absent): a top-level team flag; while it is `true` the
    one-time upgrade never runs again for that team.
  - `state.bots[id].reviewGuardNotice` (`{ at, sessionId }`, or absent): set only by that upgrade
    on a Bot it turned on; the app draws it as one line in that part of the Bot's chat. Display
    only.
  - The owner view's `reviewGuardWaitingSince` (never stored): since when the plan waits.
  - Stop line reasons `guard` and `guard-request`. In a Bot-request turn, whose calls the chat
    hides, the Solver's chat still draws a guard stop line, without the call's row.
- **The `solver` role** (delivery 2): the official role ID `solver`, its package under
  `apps/bots-dsh/roles/solver/` shipped in the plugin, the plugin's append-only mapping from release
  versions to content digests (`BUNDLED_ROLE_HISTORY`), and the host-built review lines. A plugin
  cut stamps its version using the checked candidate digest and retains earlier released entries.
  Two stored fields grant nothing. `waitingRole: { id: 'solver', instructions: <sha256>, role: <description> }`
  is derived by the host during the person's create or copy, consumed by attachment, detachment
  and settlement. `reviewerMade: true` is written by the person's create with a new reviewer and
  read by the role's review lines. Both fields stay internal. Create uses the existing owner
  actions and views.

## Threat model

No new trust boundary. Every call comes from the person's own window, under the checks each
endpoint already runs (route, model access, folder, level). Native tools run outside the file
sandbox (RFC 0003), and are only ever the person's explicit tick. The reviewer is reached with
`message_bot` under its own fences; the Solver is never made a Main Bot and the list never offers
one. Web pages, files and other Bots' replies are data to the method.

The review guard adds no trust: it only removes tools. It is set by the person, or once by the
host's upgrade (`reviewGuardMigrated`) for a Solver whose reviewer Bot is on the team; only the
person clears it. It fails closed: no verdict, an unreadable review track or a gone reviewer keep
work refused.

## Deliveries

1. **D1 (#2056):** menu line and palette command, the dialog, the method module, the read-only
   view field, i18n (en, zh, pt-BR). Plugin lane. Acceptance: the issue's "Done when" on the
   installed app. Rollback: reverting the release removes the line and the dialog; Bots made by it
   stay ordinary Bots.

1.5. **D1.5 (#2056):** the review guard. Plugin lane. Acceptance: the installed-app rows in its
   PR. Rollback: reverting the release removes the switch; the stored field is ignored.

2. **D2 (#2056):** the official `solver` role (tag, prompt part, pinned version). The dialog installs
   and attaches it. Existing D1 Solvers keep their instructions. The first cut is a full release
   because adding `roles/solver/` changes the plugin's `package.json` `files` list. On a candidate with
   roles turned off, Create makes a Solver with the written method and waiting mark and shows the
   roles-off status. On the first installed release carrying D2, the new Solver carries the role
   at that version with empty instructions, and its review message reaches its reviewer. Reverting
   the release makes the dialog write instructions again. A Bot whose written method was cleared
   still has its attachment and needs written instructions or a runtime that serves the part.
   A waiting Bot keeps its written method.
3. **D3:** RFC 0037's `task-start` capability for the Solver, at the narrower of its own and the
   caller's level; tasks may name an allowed route for model diversity. Plugin lane; acceptance
   and rollback set in its own issue.
4. **D4:** an optional group "Solver + reviewer" running its steps as `group_goal` stages; a time
   cap, and a level picker capped at the person's new-Bot default (never wider). Plugin lane;
   acceptance and rollback set in its own issue.
5. **D5:** Herdr workers through `code_start`, and Genie as a role (RFC 0028, RFC 0037 P6).
   Plugin lane; acceptance and rollback set in its own issue.

## Open questions

None for D1. D4's time-cap value is decided with D4.

## Links

#2056, RFC 0003 (native tools), RFC 0028, RFC 0037.
