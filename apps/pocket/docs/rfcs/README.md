---
title: "RFCs"
type: moc
created: 2026-11-01
updated: 2026-11-07
tags: [moc, rfcs]
---
# RFCs

Proposals for changes that others rely on. How to write one: [RFC 0000](0000-rfc-process.md).

## In short

- **Write one** for a contract (update feed, pairing, wire protocol, signing key, app ID), privacy
  or permissions, a new component, or reversing a decision. Not for fixes, refactors or docs.
- **Start** from [`_Templates/rfc.md`](../_Templates/rfc.md), take the next number, add a row
  below, open a pull request into `dev`.
- **Status:** Draft → Accepted (dated owner line) → Implemented (merged), or Superseded /
  Withdrawn.

## Index

| RFC | Title | Status | PR |
|---|---|---|---|
| [0000](0000-rfc-process.md) | How this repo proposes and records changes | Draft | automagik-dev/automagik-pocket#21 |
| [0001](0001-identity.md) | Identity: Automagik name and colours, app ID, repo home | Implemented | automagik-dev/automagik-pocket#14, automagik-dev/automagik-pocket#15, automagik-dev/automagik-pocket#16 |
| [0002](0002-release-and-update-channel.md) | Release and update channel: v0.N.0 per merge to dev, latest.json | Implemented | automagik-dev/automagik-pocket#6, automagik-dev/automagik-pocket#18 |
| [0003](0003-pocket-link-pairing.md) | Pocket Link: pair with Herdr desktop over iroh, no SSH | Implemented | automagik-dev/automagik-pocket#4 |
| [0004](0004-monorepo.md) | One repo: android/ and desktop/pocket-link/ | Implemented | automagik-dev/automagik-pocket#20 |
| [0005](0005-usage-meter.md) | Usage meter: token usage per machine as ae/1 rows, a summary doc in herdr-core | Draft | — |
| [0007](0007-watch-after-reboot.md) | Watch in background comes back after a phone restart (RECEIVE_BOOT_COMPLETED) | Accepted | automagik-dev/automagik-pocket#38 |
| [0008](0008-drop-ssh.md) | Drop SSH: Pocket Link (QR pairing) is the only way to connect | Accepted | automagik-dev/automagik-pocket#46 |

Monorepo RFCs that change Pocket's contract, privacy or permissions (they live in the monorepo's
[docs/rfcs](../../../../docs/rfcs/)):

| RFC | Title | Status | Pocket's part |
|---|---|---|---|
| [0015](../../../../docs/rfcs/0015-live-chat-projection.md) | Live chat projection: an agent terminal as a chat, Pocket Link's chat route | Accepted | Delivery 5: the Chat tab; transcripts reach the phone, in memory only ([privacy](../privacy.md)) |
| [0015, amendment](../../../../docs/rfcs/0015-live-chat-projection.md#amendments) | Writes on DSH chats: send, interrupt and approve from the phone | Accepted (2026-11-07) | `dshWrite` in the chat `hello`; first answer wins, the other card closes with a receipt; the per-project yes still gates project Bots; global Bots (Main Bot included) writable under the same limits; allow for session stays on the computer; privacy.md changes with the pocket PR |
| [0033](../../../../docs/rfcs/0033-attachments-from-pocket.md) | Attachments from Pocket | Queued | Picker, upload, attachment rows; privacy.md changes with the pocket delivery |

Back to the [docs home](../_index.md).
