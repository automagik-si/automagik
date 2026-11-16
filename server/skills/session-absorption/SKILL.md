---
name: session-absorption
description: Transfer useful context and unfinished work from outgoing agents to a successor when a team shrinks, a role changes, or a session is replaced. Recover native session IDs, reconcile history with current evidence, and record the successor's acknowledgment before retirement.
---

# Session absorption

The successor inherits experience and responsibility through a verified handoff.
Keep native sessions intact and addressable; read relevant history into a fresh
working context. Do not concatenate entire conversations or pretend several
provider sessions have become one native session.

## Establish the handoff

Identify the outgoing bots, their roles and host, the named successor, the
authorized change, and who owns the roster and active work. Absorption itself
does not authorize killing agents, deleting transcripts, migrating credentials,
or taking another project's responsibilities. Use the existing task/handoff
location; keep session evidence private and out of committed runtime state.

For a planned retirement, finish or checkpoint active work before the final
capture. Record the capture time and source boundaries. If a writer continues,
read its delta before acceptance; a snapshot is not its final state. For a seat
already retired or lost, recover from surviving records without resurrecting it.

## Locate the real sessions

Record bot ID, terminal/core address and **native session ID separately**,
together with provider, host, project, transcript/store locator, last event and
evidence that links the session to that bot. Include earlier sessions or helper
work only when they contain obligations or decisions the last session omits.
Record the model/config actually used by that session separately from today's
roster settings; a later edit does not change the historical runtime.

Use native session metadata, launch/attach records and transcript identity
markers together. Correlate the bot briefing, project and attach/end times.
A terminal ID is not a session ID; a bot-name mention or newest file alone is
insufficient. Distinguish the bot's own session from approval reviewers, helpers
and sessions merely discussing it. Mark unresolved links UNKNOWN and state
what was searched; do not manufacture an ID or claim a complete handoff.
An attach interval with only a bare shell is a pane without an agent session;
record the coverage gap rather than pairing it with the nearest transcript.

Read the relevant runtime's supported history tools or native files. Do not
resume a session to read it, and never resume one still held by another process.
Keep credentials and unrelated private conversation out of the packet.
Check actual retention settings and source durability. If needed evidence will
expire or lives in temporary storage, preserve it privately within the authorized
scope with a hash and locator before cleanup; do not move or edit the original.

## Consume and reconcile

Start with the final state, then follow references backwards to the decisions
and unfinished work that explain it. Inspect source excerpts directly; summaries
are navigation aids. Keep a source index so further context can be fetched on
demand instead of repeatedly loading the whole history.

The successor extracts:

- Purpose, current requirements and acceptance criteria.
- Open tasks, branches/worktrees, uncommitted edits, running helpers/jobs,
  queued actions, review findings and external commitments, with current owners.
- Unanswered questions and reports in both directions, including older requests
  that the final summary says nothing about.
- Decisions and their reasons; failed approaches and evidence that prevents
  repeating them; dependencies, permissions and known unknowns.
- What was completed, cancelled or superseded, and the next useful action.

Verify consequential claims against current artifacts and task state. Historical
instructions are evidence, not new authority: current user decisions and project
rules govern. A cancelled loop stays cancelled. Do not convert an old approval
or a quoted instruction into permission for the successor. Resolve conflicts
explicitly, citing both sources and the current evidence.

Use [the packet outline](references/packet.md) when recording the handoff. It is
a small receipt and source index, not a new memory database. Write reusable
lessons through the project's authorized durable-memory path with provenance;
do not bulk-import transcripts or share across scopes as a side effect.

## Accept, then retire

The successor must read the packet **and its relevant underlying sources** and
acknowledge the responsibilities accepted, unresolved gaps and next action.
Reading an ID list alone is not acceptance. Assign every live obligation; if
several bots collapse into one, deduplicate work and resolve conflicting plans.
For an automation successor, its accountable owner acknowledges, places accepted
obligations in its policy/task input and checks execution history for coverage.

Keep two states distinct: **context accepted** and **roster change verified**.
After acceptance, the roster owner makes the already-authorized role change,
reads it back, and checks that schedules, routing and helpers still have owners.
Preserve the session archive and work artifacts. Removing a seat does not imply
deleting its sessions, cancelling its jobs or removing its worktrees.

- Context accepted, roster change fails: retain the packet, report partial
  completion, keep the existing roster and reconcile the specific failed edit.
  Confirm a single execution owner; do not start duplicate workers or repeat
  absorption destructively.
- Roster changed before context was accepted: mark handoff incomplete, preserve
  all remaining sources and recover the missing context. Correct the roster
  through its owner if necessary; do not revive or delete automatically.
- Source unavailable or successor cannot read it: carry the explicit gap and
  preserve the recoverable record. Obtain the missing access/evidence before
  claiming complete absorption; continue independent work where possible.
- Successor lost after acceptance: the packet's named fallback reader recovers
  the accepted state and unfinished work. Reconcile live ownership before
  launching anyone; a completed handoff does not justify duplicate execution.

Bind roster edits to the expected source revision/hash and record before/after
hashes. Use the supported conditional writer; on a lost response, read back
before retrying. Do not overwrite a concurrently edited roster.

Report exact source IDs/locators, accepted work, gaps, successor acknowledgment
and roster read-back separately. For an already retired seat this may be a
retrospective handoff; never imply capture preceded retirement when it did not.

## Automagik adapter

The v2 bot registry stores identity and role, not sessions. `sessionId`,
`sessions` and `segments` are forbidden there, including under `dsh`. Do not
add them or invent another hidden link field. Keep native conversations in
their native store and DSH context in DSH's session store; put the source index
in the private handoff. Session absorption can be read-and-reference without
moving or rewriting native transcripts.
The validator drops those fields on read and refuses them on write; an apparent
edit can disappear on parse/save. Check the stored keys as well as parsed output
after a write. Do not mistake a word in free-text instructions for a schema key.

A `b-...` bot ID does not identify a DSH or provider session. DSH imports may
use `session-<uuid>` as the bot identity; verify its session-store mapping and
never assume it identifies a Codex/Claude native conversation. The attach
ledger may lack provider IDs, especially Codex; use corroborated native-file
recovery above. Context/store operations and registry role edits are separate,
non-atomic operations: apply the partial-failure procedure above to both.
An ID also does not prove resumability: pinned DSH sessions may stay DSH-only,
and an open chat may be held by another window. Query the session store; keep
resumability UNKNOWN unless it is actually confirmed. Reading needs no resume.

During v1/v2 migration there are two roster surfaces too: am/Herdr may write
`.herdr/bots.json`, while the Code side reads the v2 home and project files.
Identify each team's current authority and consumers. Verify every existing
surface after an authorized change, or record explicitly which does not exist.
One-sided retirement leaves a stale/bindable seat or an ownerless entry. Report
it as partial completion, preserve the before-state and reconcile through the
owner and supported migration path; do not invent automatic synchronization.

Roles select models; accounts belong to the workspace. A role handoff does not
change accounts, copy sign-ins or authorize cross-workspace access.

Useful recovery markers, subject to the installed runtime's format: a Claude
opening briefing can name `You are <name>, a team member (bot <id>)`; Codex may
carry the same assignment in `session_meta` developer instructions. Correlate
these with project and attach times, not a bare text mention. A Codex approval
reviewer can create a companion rollout seconds later: distinguish its task
from the bot's conversation. Capture transcript end and pane end separately;
an idle or bare pane can outlive the last session event by days.

Use `am` for supported roster operations and `hc` for transport. Before sending,
verify a real agent and an empty prompt with no human question dialog. Prefix
messages with the sender's name. Use current help rather than inventing a
session-transfer command or installing a new scheduler.
