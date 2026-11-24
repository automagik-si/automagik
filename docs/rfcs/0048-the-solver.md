# RFC 0048: The Solver

| Field | Value |
|---|---|
| Status | Accepted (2026-11-23: the owner's decisions in #2056, and, by the owner's delegate, the D1 design choices recorded here: best-effort rollback, the native tick's parity with Details, and the read-only view field; no delivery merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). Deliveries: plugin (3.N.P), bots-dsh and its pt-BR strings |
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
- **Create** runs through the person's own existing endpoints: `create-bot` for the reviewer,
  `create-bot` for the Solver (its instructions name the reviewer by the name the host returned),
  `update-bot { nativeTools: true }` on its own when ticked (RFC 0003: the switch changes only
  through `update-bot` on its own), then, when ticked, the brief the person typed goes through
  `send` after the switch, so the task's first turn already runs with native tools (unticked, it
  goes with `create-bot`). No endpoint is added; the only new stored fields are the Solver review
  mark's `reviewerId` and `reviewTrack` (under "Contracts introduced").
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
  thing: offered on Claude Code, on a Codex model the switch applies to, and on omp (ticked: its own
  tools; unticked: chat only, said with the existing omp text); locked with the existing text on a
  kept Codex model, at Read only, or when the level cannot be read; absent in a multi-user
  workspace, on Antigravity until its switch lands, and on DSH models. Unticked is the default.
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
- Renaming the reviewer later breaks the Solver's reviews until its instructions are edited.

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
  Delivery 2's official `solver` role replaces it, and `isSolverBot` then reads both (the role tag
  or the description), so a delivery 1 Solver keeps its characters. The marker adds no stored field.
- **Solver review mark** (delivery 1): two cosmetic stored fields. `reviewerId` is the id of the
  Solver's reviewer Bot: the New Solver dialog sends it once with the person's `create-bot`, the
  host keeps it only when it names another Bot on the team, a copy of the Solver keeps it, and no
  endpoint or Bot tool changes it later. `reviewTrack` is written only by the host, per request in
  the Solver's own chat (and the subagents under it): when the request opened, the person's last
  message in it, its first and last work calls (a write to exactly its notes file,
  `.solver/notes.md` in its folder, never dates the plan side), at most 4 verdicts (the last
  whole-word SHIP, FIX-FIRST or BLOCKED in a reply from `reviewerId` that starts a line, follows
  `Verdict:` or ends a line after a sentence, never asked, one of a list of options or inside a
  fenced code block), the last delivery's mark, and the first guard verdict's time. No view carries
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
  - A verdict counts only in the reviewer's own reply to work the Solver opened in that request:
    its first line, unquoted, or a line that starts with `Verdict:`, outside fences.
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
  - Stop line reasons `guard` and `guard-request`.
- Delivery 2 adds the official role id `solver`.

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

2. **D2:** `roles/solver/` official role (tag, prompt part, pinned version); the dialog attaches it
   and stops writing instructions; existing D1 Solvers keep theirs. Plugin lane, with a cut that
   carries the role. Check: a new Solver carries the `solver` tag and no written instructions; a
   D1 Solver keeps its own. Rollback: the dialog writes instructions again; attached roles stay.
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
