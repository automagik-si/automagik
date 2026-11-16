# Absorption packet

Keep this in the existing private task/handoff location, not the bot registry.
Include only fields needed for the actual transfer; unknowns remain explicit.

## Change and ownership

- Task/change ID, authorized scope, outgoing roles, successor, roster owner.
- Capture UTC time; planned or retrospective; current writer/job status.
- Runtime/model actually used, versus the current saved roster configuration.
- Fallback reader if the successor is lost; authoritative roster and all consumers.
- States: captured / successor accepted / roster verified (each with evidence).

## Sources

| Bot and role | Provider and host/project | Native session ID | Source locator and evidence of identity | Last event / captured boundary |
| --- | --- | --- | --- | --- |

For active append-only sources, record the captured offset/event and subsequent
delta. For a fixed transcript or checkpoint, a hash can bind the reviewed source.
List relevant earlier/helper sessions separately and explain their relevance.
Record source retention/durability and any private preserved copy/hash.
Do not copy secrets or full transcripts into this packet.

## Useful context

- Current objective and acceptance evidence.
- Decisions, reasons and superseded/cancelled plans, with source locations.
- Failed attempts and lessons worth preserving.
- Open work: artifact/worktree/branch or task ID, current status, accepted owner,
  next action; preserve uncommitted work and outstanding reviews.
- Jobs, schedules, helpers, routes and external commitments requiring an owner.
- Unanswered incoming and outgoing questions/reports, including older sessions.
- Conflicts resolved against current evidence; remaining unknowns.

## Successor acknowledgment

Name the successor, time and sources actually read. State what it accepts,
what it rejects as stale, unresolved gaps, and its next action. Acknowledge each
outgoing role when combining several. Record the authorized memory reference
for reusable lessons, or say the write is pending.
For an automation successor, name its accountable owner, the policy/task input
updated with the inherited obligation, and evidence of execution coverage.

## Roster and recovery receipt

Record the owner-applied change and read-back, surviving source locations, and
coverage of jobs/routes. If only one side completed, name that side, the single
execution owner, the outstanding repair and who can perform it. No transcript
deletion, credential copying or automatic agent resurrection is implied.
Bind each roster edit to before/after hashes and read back every existing
consumer (including both v1 and v2 during Automagik migration). If a surface is
absent, record that explicitly. A lost reply calls for a read-back, not a replay.
