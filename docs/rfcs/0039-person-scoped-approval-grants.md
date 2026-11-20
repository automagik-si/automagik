# RFC 0039: Scoped approval grants the person makes

| Field | Value |
|---|---|
| Status | In delivery (approved by the owner's delegate on 2026-11-20, #1718; questions 1-5 answered with this RFC's own recommendations, see Answers; merged: delivery 2 (#1815), delivery 3's task end (#1859); the 2026-11-20 amendment narrows delivery 3 for part moves and a Bot's deletion; owed: delivery 3's group Sessions and delivery 4) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P) |
| Created | 2026-11-19 |

## Summary

On an approval card the person can allow one exact step once, as today, or allow that same exact
step again for the rest of the task. Such a grant is made only by the person, binds the Bot, the
working folder, the tool, the reason and the arguments the card showed, lives in memory until its
task or chat part ends, and never covers a step RFC 0031's never-auto list sends to the person.
Each use still answers DSH with one `allowed-once`. This RFC answers the #136 design note's
questions 1, 2, 3 and 5, and the dsh bridge's `allow_always` fallback, each with a recommended
option. It builds on [RFC 0031](0031-auto-permission-level.md) and #1740 and widens nothing
either forbids.

## Motivation

#1718 is part (b) of #136: a grant should name what it authorises, so the person approves a
narrower thing than "this tool, generally". Today no tool-approval grant is kept at all: allow is
`allowed-once`, reject is `rejected` (`apps/bots-dsh/src/host/approvals.js`, `OUTCOMES`), and
DSH's own vocabulary has no other grant. So the same step asked ten times in one task, a test run
or a build in a loop, is ten cards (#136 P1).

RFC 0031 (accepted 2026-11-19) decided part of #136: only the person makes anything more
permissive (D7), the never-auto list reaches the person at every asking level and before every
judge (D6 and its amendment), and Auto's own grants are one execution, bound to call id, tool,
cleaned arguments, reason, route and revision, held in memory. Those parts are on dev
(`auto-judge.js` `grants`, `hardToUndo`; `test/auto-judge.test.js`). #1740 stopped sending a
one-time allow as an ACP agent's `allow_always`. What no accepted RFC decides is whether the
person may make a grant that outlives one call, how far "approve all" reaches, how long a grant
lasts, and what happens to an approval left pending when its session ends.

## Design

### What a grant is

- **Made by the person, from a card.** A card whose ask can be granted shows a third button,
  "Allow this step for this task" (in a Bot's own chat, "for this chat"), beside "Reject" and
  "Allow once". The window calls one endpoint, `grant-approval { id }`, which records the grant
  and then answers that ask `allowed-once`. No Bot, tool, default, group, inheritance, schedule
  or older app makes a grant (D7); a team tool calling the endpoint gets an error.
- **Exactly what the card showed.** An ask can be granted only when the card shows its whole
  target: the ask already has a `capabilityKey` (Bot, working folder, tool, full reason and one
  fully shown target, `turns.js` `capabilityOfArgs`). The grant binds that key, the cleaned
  arguments of the live call (the fingerprint Auto's grants use), the owner it lives under (the
  task, the chat part or the group Session), the route and the Bot's `permissionRev`. No prefix,
  pattern, folder-wide or tool-wide grant: those would allow more than the card said.
- **Checked in the host, before a card exists.** The Bot team's `approval/request` listener
  looks for a matching grant after the team lookups and before it opens a pending entry. A match
  needs every bound field equal and the owner still alive; anything else opens an ordinary card.
  The card itself never decides.
- **Never for a never-auto step.** Before a grant is read, the live call goes through RFC
  0031's `hardToUndo` with its own context, at every level. A match never answers a recursive
  delete, force push, remote branch delete, hard reset or clean, infrastructure destroy,
  database drop, file-tool delete, Bot or group delete, secret read, external message, shared
  push or delete outside the Bot's folder (the full list and its later additions). Such an ask
  shows no grant button, and a grant never matches one.
- **One answer per call.** A matched grant answers that one request `allowed-once`, so DSH's
  ledger keeps its request/decision pair. The decision record names `decidedBy: 'grant'` and the
  grant's id; `rt.autoAudit` gets a row with code `person-grant` (never argument text).
- **Under Auto.** A grant is read only where the request would otherwise reach the person: after
  the never-auto list and after Auto's judge, never in place of a judge refusal.
- **Seen and revoked.** The Bot's details list its live grants (tool, the shown target, its
  owner, uses so far), each with "Stop allowing"; the Live rail counts them.

### When a grant ends

A grant is dropped, and the next identical ask opens a card, when any of these happens: its task
ends (done, failed, stopped or cancelled), its chat part ends or the chat moves to a new part, its
group Session leaves the group or the group ends, the Bot is deleted, the Bot's `permissionRev`
moves (a level, route, Auto or deny-list save), the person stops it, the host loses the team's
lock, or the host restarts. Grants are never written to disk.

### A pending approval whose session ends

Every pending ask is answered `cancelled` by `system` when its session ends, for every owner
kind, as group Sessions already are (`cancelApprovals`). The person is told: the card is replaced
by "This step was withdrawn: its task ended", and a task card in the parent's chat says the task
ended with an approval unanswered. An answer that arrives afterwards gets "This approval is no
longer open" (`bot/stale`) and grants nothing.

A chat that moves to a new part and a deleted Bot are the exception (Amendment, 2026-11-20): their
pending asks are cancelled by DSH when it archives the ended Session, as today, and a late answer
gets `bot/stale`, but they are not relabelled `system` and get no withdrawn line.

### The dsh bridge's `allow_always` fallback

`apps/acp-dsh/src/host/acp.js` answers the ACP agent's own question for a bridged `mcp__dsh__*`
call with `allow_once`, else `allow_always` (`onPermission`, :884-885), and so does
`answerSkippedMcp` for a fork's bridge call (:845). The person's dialog is the bridge's own
`approval/request` (RFC 0003, "One dialog per call"), so no call runs on that answer. But an
`allow_always` lets the agent record a standing rule nobody approved, and under Claude Code's own
mode that rule stops the agent asking, which keeps `agentAsked` false (`adapter.js`) and sends
later bridged calls to the team judge instead of the person. This RFC narrows both places to
`allow_once`, else `cancelled`, as #1740 did for the mirror.

## Contracts introduced

| Contract | Rule for existing installs |
|---|---|
| The window's endpoint `grant-approval { id }` | New. An older Bot team has none; the window shows no grant button. |
| A pending approval's `grantable` field in the state answer | New, absent means not grantable. |
| Decision record `decidedBy: 'grant'` with `grantId`; audit code `person-grant` | New values in existing records. Readers that do not know them read an ordinary allow. |
| `rt.grantsView()` (live grants, no argument text beyond the shown target) | New; nothing persisted, no storage key. |
| acp-dsh's answer to a bridged call's ACP question | `allow_once`, else `cancelled`; never `allow_always`. |

There is nothing to migrate: no tool-approval grant was ever stored (#136 design note, 1.3).
Lists that are not tool-approval grants stay as they are and are out of scope: computer use's
per-app "Always" (`computer/index.js`), browser slides and secret scopes. Standing rules an agent
recorded before #1740 live in that agent's own settings and are not touched.

## Threat model

- **Who makes a grant.** Whatever can answer a card today; the endpoint adds no new route to the
  window. A grant only repeats, within one owner, an allow the person gave for the exact same
  step, so it multiplies a click, never its reach.
- **What a matched grant can run.** The same tool with the same cleaned arguments, in the same
  folder, for the same Bot, route and revision. A wider call, another argument, another task,
  another Bot or a call after any revocation opens a card. Files the step changes may make the
  next identical command do something else (a test script the Bot edited): a grant is offered on
  a shell command only with that sentence on the button's confirmation.
- **What it can never run.** The never-auto list, at every level, checked on the live call.
- **Undo.** "Stop allowing", any level save, ending the task, or a restart. Steps already run are
  not undone. Removing the plugin leaves no grant.

## Deliveries

1. **This RFC.** Docs only. Acceptance: its file and its index row. Rollback: remove both.
2. **The bridge answers once.** acp-dsh, plugin lane. `onPermission`'s bridge branch and
   `answerSkippedMcp` pick `allow_once`, else `cancelled`. Acceptance: a bridged question that
   offers only `allow_always` gets `cancelled` and the call's own `approval/request` is unchanged;
   one offering `allow_once` still gets it. The two assertions that pin the fallback change and
   are named in the PR: `test/codex-mcp-permission.test.js:120-128` and
   `test/session-state-bounded.test.js:79`. Rollback: an older acp-dsh answers `allow_always`
   again; rules an agent recorded meanwhile stay in its settings.
3. **A pending approval ends with its session.** bots-dsh, plugin lane. Acceptance (as amended on
   2026-11-20): tests where a task ends and where a group Session leaves (a member removed, the group
   deleted, a deleted Bot's seats, a seat DSH can no longer open) with an ask pending: each is
   `cancelled` by `system`, the person sees the withdrawn line, the parent's task card says so for a
   task, and a late answer gets `bot/stale`; where a chat moves to a new part and where a Bot is
   deleted, the ask is cancelled by DSH's archive (decision `dsh`) and a late answer gets
   `bot/stale`, with no withdrawn line. Delivered in two parts: the task end (#1859) and the group
   Sessions. Rollback: the older per-owner behaviour.
4. **Grants for one task or chat part.** bots-dsh, plugin lane. The endpoint, the button, the
   host check, the end rules, the audit row and the revoke list. Acceptance, each a test: a
   granted step asked again in the same task runs with no card and DSH sees one `allowed-once`
   per call; the same tool with other arguments, a wider target, another task, another Bot,
   another route, after a level or deny-list save, after the task ends, after "Stop allowing" and
   after a host restart each open a card; a never-auto step with a matching key opens a card and
   shows no grant button; a team tool calling `grant-approval` is refused; an ask with no
   `capabilityKey` shows no grant button. Rollback: an older plugin has no grants and asks the
   person each time; nothing was stored.

Not scheduled: grants that outlive their task (Q1's (b)), timers (Q3's (b)), approve-all across
Bots (Q2's (b) and (c)), and DSH's own card in a Bot's chat showing the
button (a change to DSH; until then the button is on the Bot team's cards and the Live rail).

## Open questions

1. **#136 Q1: may the person make a lasting or permanent grant, and which capabilities never?**
   (a) *Only for the task or chat part, in memory* (the design above). (b) *Also "always for this
   Bot"*: the same exact-step grant saved on the Bot, listed and revocable, dropped on any
   `permissionRev` move. (c) *Tool-wide or pattern grants.* Recommended: (a), made by the person
   only, never a Main Bot. (b) can follow once the audit shows which steps repeat across tasks;
   (c) is rejected, since it allows more than the card showed. Never grantable under any option:
   the whole never-auto list (RFC 0031 D6 and its amendment), any ask whose target the card
   cannot show in full, and anything that changes a level, the Auto mark or a deny list.
2. **#136 Q2: may "approve all" cross Bots?** (a) *No*: a shared card groups only asks with the same
   `capabilityKey`, which includes the Bot, and each ask is still answered once; a grant made
   from it covers that Bot only. (b) *One capability across Bots.* (c) *Anything pending.*
   Recommended: (a), as dev already groups. (b) would let one click allow a step for a Bot whose
   folder, route and level the person did not look at.
3. **#136 Q3: timed grants against task end and restart.** (a) *No timer*: a grant ends with its owner
   and never survives a restart. (b) *A timer (30 minutes) as a further bound*, never past its
   task. (c) *A timer that survives a restart*, which means storing grants. Recommended: (a). A
   task is the unit the person approved inside; (b) can be added later as an extra limit, (c)
   needs Q1 (b)'s storage and is rejected with it.
4. **#136 Q5: a pending approval when its session ends.** (a) *Cancelled, and the person told.*
   (b) *Rejected*, which tells the agent the person said no when they did not. (c) *Kept
   answerable until the request dies*, an answer to a call nothing will run. Recommended: (a), and
   a grant whose owner ended is dropped with it.
5. **The bridge's `allow_always` fallback.** (a) *`allow_once`, else `cancelled`* (delivery 2).
   (b) *Keep it*: no call runs on that answer, since the bridge's own dialog decides. (c) *Refuse
   with `reject_once`*: the bridge's own dialog has already asked, so a refusal here would contradict
   the person's allow. Recommended: (a); it is D7's "nothing becomes more permissive by itself"
   and the same rule #1740 applied to the mirror.

## Answers (2026-11-20)

The owner's delegate approved this RFC on 2026-11-20 (issue #1718) and answered every open
question with this RFC's own recommendation. Each answer restates that recommendation; the
questions above stay as they were asked.

1. **#136 Q1:** (a). A person's grant lasts only for its task or chat part and is held in memory;
   only the person makes one, never a Main Bot or any other Bot. "Always for this Bot" (b) is
   not scheduled; tool-wide and pattern grants (c) are rejected. Never grantable: the whole
   never-auto list (RFC 0031 D6 and its amendment), any ask whose target the card cannot show in
   full, and anything that changes a level, the Auto mark or a deny list.
2. **#136 Q2:** (a). "Approve all" never crosses Bots: a shared card groups only asks with the
   same `capabilityKey`, each ask is still answered once, and a grant made from it covers that
   Bot only.
3. **#136 Q3:** (a). No timer: a grant ends with its owner and never survives a host restart.
4. **#136 Q5:** (a). A pending approval whose session ends is answered `cancelled` by `system`,
   for every owner kind, and the person is told; a grant whose owner ended is dropped with it.
5. **The bridge's `allow_always` fallback:** (a). The bridge answers the agent's question with
   `allow_once`, else `cancelled`, never `allow_always` (delivery 2).

## Amendment (2026-11-20, #1718): part moves and a Bot's deletion in delivery 3

Approved by the coordinator on 2026-11-20 for #1718. Delivery 3 keeps `cancelled` by `system`, the
withdrawn line and `bot/stale` for a task's end and for a group Session that leaves. For a chat that
moves to a new part and for a deleted Bot it keeps today's cancellation: DSH answers the pending ask
`cancelled` when the team archives the ended Session (decision `dsh`), and a late answer already gets
`bot/stale`. Only the `system` decision, the reason and the withdrawn line are missing there.

Why: five reviewed designs could not prove, for these two ends, that a row names an owner that really
ended, without new cancellations:
- withdrawing before the team's archive cancels asks DSH's archive would leave pending (an archived or
  unknown Session id, a failed durable write, a descendant DSH does not reach);
- labelling inside a window the team holds cannot tell DSH's archive stop from a person's Stop, a
  timeout or another queued archive;
- reading the team's state at DSH's own stop cannot tell a durable end from one an in-flight
  transition will undo (a Session adoption awaiting its save, a shell-hold leave, a recovery pass);
- marking the end at the committed sites leaves a mark that can describe an earlier opening of a
  Session reopened since, and three of those sites archive after a failed save.

Group Sessions are different: the team cancels their asks itself, synchronously, when it drops the
seat, so the reason and the line can be added there. Grants (delivery 4) are unaffected: they are held
in memory and dropped on any doubt about their owner, which needs no such proof.

A later RFC may bring the line to part moves and Bot deletion once the move, adoption and reopen paths
record their end durably.

## Links

- #1718 (this), #136 and its design note (questions 1-6), #1740 (slice B), #1263 (the approval
  surface).
- [RFC 0031](0031-auto-permission-level.md) (D6, D7, Auto's grants), [RFC 0003](0003-model-routes-and-acp.md)
  ("One dialog per call").
