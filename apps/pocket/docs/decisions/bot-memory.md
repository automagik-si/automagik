---
title: "Bot memory opens on its own connection"
type: decision
status: Implemented
created: 2026-11-19
updated: 2026-11-19
tags: [decisions, chat, bots, privacy]
---
# Bot memory opens on its own connection

## Decision

Open Memory from the Bot chat's bar on a short-lived connection to Pocket Link. The grant lasts
as long as the dialog does. Memory works when the Bot's chat is disconnected or fails to open,
and opening a chat by itself holds no memory grant.

## Not taken

- Use the chat's connection. Its lifetime follows the chat, and it may be unavailable when the
  person opens Memory.
- Add a Memory action to the Bot row. RFC 0036 allows this entry point, which would let the
  phone manage a Bot's memory without opening its chat. Leave it for a later pull request.

## Current state

- The bar opens the dialog in [ChatScreen.kt](../../android/app/src/main/java/ai/namastex/automagik/ChatScreen.kt)
  (`ChatScreen.kt:186`). The dialog owns its grant in
  [PocketViewModel.kt](../../android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt)
  (`PocketViewModel.kt:1335`).

## Related

- [RFC 0036](../../../../docs/rfcs/0036-bot-management-from-pocket.md)
- [Privacy](../privacy.md)
