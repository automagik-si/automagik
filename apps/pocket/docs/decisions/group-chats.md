---
title: "Groups have their own heading, outside Needs you"
type: decision
status: Implemented
created: 2026-11-20
updated: 2026-11-20
tags: [decisions, chat, groups, privacy]
---
# Groups have their own heading, outside Needs you

Home and Team list group chats under Groups, outside Needs you, the tab badge and the deck.
A blocked group with zero phone-answerable approvals says "Waiting on the computer" because
only the computer can act on those approvals. See
`android/app/src/main/java/ai/namastex/automagik/Cockpit.kt:91` and
`android/app/src/main/java/ai/namastex/automagik/ChatGroups.kt:20`.

The group pane stacks each open approval as its own card keyed by id. On reconnect, it checks
each id against the open cards and the computer's settled outcomes. The group list stays in
memory, outside the Teams cache. See
`android/app/src/main/java/ai/namastex/automagik/ChatScreen.kt:240` and
`android/app/src/main/java/ai/namastex/automagik/ChatGroups.kt:4`.

## Related

- [RFC 0040](../../../../docs/rfcs/0040-group-chats-in-pocket.md)
- [Privacy](../privacy.md)
