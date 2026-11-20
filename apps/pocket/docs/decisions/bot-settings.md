---
title: "Bot settings open from the chat identity pill"
type: decision
status: Implemented
created: 2026-11-20
updated: 2026-11-20
tags: [decisions, chat, bots, privacy]
---
# Bot settings open from the chat identity pill

Tap the Bot's name and status in chat to open Settings. The pill uses the space the chat
bar already gives it, leaving room for Memory, Schedules and Interrupt on narrow phones.
See `android/app/src/main/java/ai/namastex/automagik/ChatScreen.kt:255`.

The dialog opens its own connection and requests only the settings methods. Pocket needs
the read grant to offer either write, so it can check an unanswered write on that connection.
The dialog releases its connection and clears its data when it closes. See
`android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:1810`.

The dialog shows the level as read-only text. It uses the level the computer returns after
a model change, including whether Auto turned off. See
`android/app/src/main/java/ai/namastex/automagik/ChatSettings.kt:132`.

## Related

- [RFC 0036](../../../../docs/rfcs/0036-bot-management-from-pocket.md)
- [Privacy](../privacy.md)
