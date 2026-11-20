---
title: "Bot schedules open on their own connection"
type: decision
status: Implemented
created: 2026-11-20
updated: 2026-11-20
tags: [decisions, chat, bots, privacy]
---
# Bot schedules open on their own connection

## Decision

Open Schedules from the Bot chat bar. Memory and Schedules each have a dialog and a short-lived
connection, so each grant covers only the methods and lifetime of the family the person opens.
Pocket discovers the schedule offer when the dialog opens. Pocket requires a grant for the
family's read method (`memory.read` or `schedule.list`) before using its write grants, so it
can check an unconfirmed write on that connection.

## Not taken

- A shared Manage dialog would ask for both grants together.
- A Bot-row entry can be added later under RFC 0036. The chat bar provides the entry point for this delivery.

## Related

- [RFC 0036](../../../../docs/rfcs/0036-bot-management-from-pocket.md)
- [Privacy](../privacy.md)
