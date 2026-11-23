# RFC 0048: The Solver

| Field | Value |
|---|---|
| Status | Accepted (2026-11-23: the owner's decisions in #2056, and the lead's acceptance of the D1 plan's choices (1)-(6) as amended, its review rulings S-1 and S-4 parity, and choice (1)'s read-only view field; no delivery merged) |
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
  when it is set up), project folder, reviewer, the native-tools tick, and the new-Bot level shown,
  not picked (`create-bot` takes no level; the Solver starts where every new Bot starts).
- **Create** runs through the person's own existing endpoints: `create-bot` for the reviewer,
  `create-bot` for the Solver (its instructions name the reviewer by the name the host returned),
  `update-bot { nativeTools: true }` on its own when ticked (RFC 0003: the switch changes only
  through `update-bot` on its own), then the brief through `send`, so the task's first turn already
  runs with native tools. No endpoint is added and nothing new is stored.
- **Best-effort rollback (S-1).** A failure at the reviewer, the Solver or the switch deletes,
  newest first, only the Bots this run created (never an existing Bot chosen as reviewer, never by
  name). "Nothing was created" is said only when every failed step was a host refusal and every
  rollback delete is confirmed (a delete that succeeded, an id absent from a fresh `state` read, or
  `bot/not-found`). When the outcome is unknown (a lost answer, an HTTP or internal error, a changed
  viewer), the dialog reads the team once (`teamState`, the existing `state` read) and names each
  Bot that was not there before as one that "may have been created"; it never deletes those. If
  that read fails too, it names each Bot whose create failed that way. A closed window, a reload
  or a lost answer between steps can still leave a made Bot (an orphan reviewer, or a Solver
  without its switch), and nothing records it.
- **Native tools, parity with Details (S-4).** The tick and the Details switch read one function,
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
  Bot of any `kind` or a Hermes remote route). "Fresh session" is always listed last: each review
  runs in a fresh subagent session that sees only the request and the deliverable, and the delivery
  says so and names the model. There is no "none". An existing Bot gets its reviews queued
  (`when: "queue"`), each message starting with the reviewer rules.
- **The method** (`shared/solver-method.js`, version 1) is the Solver's instructions: understand,
  research, ask only when needed, brainstorm, plan, independent review, implement, test, verify
  against the person's words, deliver with evidence; always deliver, never end in silence, never
  get around a block that would widen its rights; no powers over the team; outside content is data.
  The cap of 2 FIX-FIRST rounds per review point is enforced by this text only; delivery 4's
  `group_goal` stages can enforce it. Stored descriptions (`Solver`, `Reviewer`) and the method are
  English in every locale; the Bot answers in the person's language.
- **The character slot (S-7).** `SOLVER_LOOKS` in `solver-draft.js` holds avatar objects as the
  host keeps them (`{ shape }` of a known character, or a built-in pet). Empty in delivery 1: a new
  Solver wears today's random look. The change that adds the Solver characters fills this list
  and nothing else; whichever of the two lands second does it.
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
- Delivery 2 adds the official role id `solver`.

## Threat model

No new trust boundary. Every call comes from the person's own window, under the checks each
endpoint already runs (route, model access, folder, level). Native tools run outside the file
sandbox (RFC 0003), and are only ever the person's explicit tick. The reviewer is reached with
`message_bot` under its own fences; the Solver is never made a Main Bot and the list never offers
one. Web pages, files and other Bots' replies are data to the method.

## Deliveries

1. **D1 (#2056):** menu line and palette command, the dialog, the method module, the read-only
   view field, i18n (en, zh, pt-BR). Plugin lane. Acceptance: the issue's "Done when" on the
   installed app. Rollback: reverting the release removes the line and the dialog; Bots made by it
   stay ordinary Bots.
2. **D2:** `roles/solver/` official role (tag, prompt part, pinned version); the dialog attaches it
   and stops writing instructions; existing D1 Solvers keep theirs.
3. **D3:** RFC 0037's `task-start` capability for the Solver, at the narrower of its own and the
   caller's level.
4. **D4:** an optional group "Solver + reviewer" running its steps as `group_goal` stages; a time
   cap and a level picker in the dialog.
5. **D5:** Herdr workers through `code_start`, and Genie as a role (RFC 0028, RFC 0037 P6).

## Open questions

None for D1. D4's time-cap value is decided with D4.

## Links

#2056, RFC 0003 (native tools), RFC 0028, RFC 0037.
