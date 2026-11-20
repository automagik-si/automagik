---
title: "Decisions"
type: moc
created: 2026-11-01
updated: 2026-11-20
tags: [moc, decisions]
---
# Decisions

Single choices with one reason, kept as notes. Bigger changes are [RFCs](../rfcs/README.md).
Write one from [`_Templates/decision.md`](../_Templates/decision.md).

| Decision | Status | PR |
|---|---|---|
| [Alerts are native Android notifications, in the app too](native-notifications.md) | Implemented | automagik-dev/automagik-pocket#17 |
| [Answering from the lock screen starts off](lock-screen-answers-off.md) | Implemented | automagik-dev/automagik-pocket#19 |
| [Updates install silently, and notifications say so](updates-install-silently.md) | Implemented | |
| [Pocket Link keeps its state outside the mod folder](pocket-link-state-outside-mod.md) | Implemented | automagik-dev/automagik-pocket#34 |
| [Pocket Link public-status.json contract (schema 1)](pocket-link-public-status.md) | Accepted | automagik-dev/automagik-pocket#39 |
| [Offer Always allow for agent permission prompts](always-allow-permission-prompts.md) | Accepted | automagik-dev/automagik-pocket#41 |
| [The phone finds a space's Space Row project itself](space-row-project-key-on-phone.md) | Accepted | automagik-dev/automagik-pocket#45 |
| [Teams tab v1: home tab, Room cache, Genie bundled at build time](teams-v1.md) | Accepted | automagik-dev/automagik#242 |
| [Pocket Link doesn't install the usage meter](pocket-link-no-meter-installer.md) | Implemented | automagik-dev/automagik-pocket#53 |
| [Four tabs: Home, Team, Code, Settings](four-tabs.md) | Implemented | automagik-dev/automagik#664 |
| [Team: one bubble per project, keyed by registry bot id](team-bubbles.md) | Implemented | automagik-dev/automagik#674 |
| [A DSH chat reconnects by itself; the phone needs no dedupe flag](dsh-chat-resume.md) | Implemented | |
| [Home counts the Bots' chats with the terminals](home-bot-chats.md) | Implemented | |
| [A card that closed while the phone was away comes back as a receipt](chat-receipts-on-reconnect.md) | Implemented | |
| [One shared debug signing key for Pocket PR builds](shared-debug-signing-key.md) | Accepted | |
| [Bot memory opens on its own connection](bot-memory.md) | Implemented | |
| [Bot schedules open on their own connection](bot-schedules.md) | Implemented | |
| [Bot settings open from the chat identity pill](bot-settings.md) | Implemented | |
| [Groups have their own heading, outside Needs you](group-chats.md) | Implemented | |

Back to the [docs home](../_index.md).
