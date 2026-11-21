---
title: "RFCs"
type: moc
created: 2026-11-01
updated: 2026-11-21
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
| [0009](0009-keystore-phone-key.md) | The phone's Pocket Link key wrapped by Android Keystore | Draft | — |
| [0010](0010-app-lock.md) | Optional app lock | Draft | — |

Monorepo RFCs that change Pocket's contract, privacy or permissions (they live in the monorepo's
[docs/rfcs](../../../../docs/rfcs/)):

| RFC | Title | Status | Pocket's part |
|---|---|---|---|
| [0003](../../../../docs/rfcs/0003-model-routes-and-acp.md) | Model routes and ACP | In delivery | Sign-in amendment: Pocket refuses a pasted Claude sign-in code before anything records it, as the team's send endpoints do |
| [0011](../../../../docs/rfcs/0011-monorepo-parts-and-releases.md) | Monorepo parts and releases | Accepted | The `pocket` lane: one version for every part (versionCode from the root `package.json`), the APK and `latest.json` on each release that rebuilds Pocket and, from stable releases only, the rolling `pocket-lane` that installed phones read; the app ID, the signing key and `latest.json`'s place and fields change only with an RFC ("Pocket") |
| [0012](../../../../docs/rfcs/0012-am-cli-and-parts.md) | am, the one command, and its parts | In delivery; amended 2026-11-21 (#1007, approved by the owner's delegate) | Pocket Link becomes its own part, owned by Pocket (decided by the owner's delegate on 2026-11-21): `pocket.link`, in am's tarball, installed and paired by `am pocket pair`; Pocket itself installs nothing on a computer, its `am doctor` entry reports that (delivery 8, the `apps/*` parts) |
| [0014](../../../../docs/rfcs/0014-shared-bot-registry.md) | Shared Bot registry | In delivery | Universal-Bot amendment: a project's orchestrator is one Bot; the phone shows it once, as the DSH chat `dsh:<botId>`, with approvals through DSH |
| [0015](../../../../docs/rfcs/0015-live-chat-projection.md) | Live chat projection: an agent terminal as a chat, Pocket Link's chat route | In delivery; amended 2026-11-07 (writes), 2026-11-19 (RFC 0036) and 2026-11-20 (RFC 0033) | Delivery 5: the Chat tab; transcripts reach the phone, in memory only ([privacy](../privacy.md)) |
| [0015, amendment](../../../../docs/rfcs/0015-live-chat-projection.md#amendments) | Writes on DSH chats: send, interrupt and approve from the phone | Accepted (2026-11-07) | `dshWrite` in the chat `hello`; first answer wins: the phone shows a receipt when the computer answered first, and the computer's dialog closes when the phone did (its receipt there waits on RFC 0015's open question 4); the per-project yes still gates project Bots; global Bots (Main Bot included) writable under the same limits; allow for session stays on the computer; privacy.md changes with the pocket PR |
| [0017](../../../../docs/rfcs/0017-usagemeter-crate.md) | usagemeter crate | In delivery | This repository keeps the `herdr-meter` doc contract the phone reads (`Spend.kt` for the numbers, `SpaceFeed.kt` for the `space` block), the doc at `schema_version` 2; its schema and fixtures under `meter/schema`, with Pocket's tests on them, are delivery 3 (open) |
| [0022](../../../../docs/rfcs/0022-desktop-chat-view.md) | Desktop chat view | In delivery | One rendering contract for the desktop and the phone: Pocket's `ChatRenderTest.kt` must read a byte-equal copy of `herdr/test/fixtures/chat-render-cases.json` in the pocket patch after the fixture lands (phase 1) (markup as text, link targets, ANSI removed, a tagged row's provenance); the later revision changes nothing else in Pocket |
| [0025](../../../../docs/rfcs/0025-cloud-economics.md) | Cloud economics | Accepted | A Pocket tap is never an approval of a Cloud money grant: creating or raising one needs the Owner's passkey step-up |
| [0028](../../../../docs/rfcs/0028-code-workers.md) | Code workers | Accepted | The durable worker-report log (`wake.jsonl`) is read only by the team's host: Pocket never reads it |
| [0031](../../../../docs/rfcs/0031-auto-permission-level.md) | Auto permission level | In delivery | Auto covers every turn of the Bot's own chat, prompts sent from Pocket included: any message that reaches the chat can lead to a step Auto's judge allows |
| [0033](../../../../docs/rfcs/0033-attachments-from-pocket.md) | Attachments from Pocket | Accepted. Delivery 0 writes the images contract into RFC 0015 and delivery 4a writes the documents contract there. Pocket images are delivery 3 and Pocket documents are delivery 4d. | Picker, upload, attachment rows; privacy.md changes with the pocket delivery |
| [0034](../../../../docs/rfcs/0034-vault-plugin-bitwarden-first.md) | Vault plugin, Bitwarden first | Accepted | From Pocket a person may approve a Bot's use of a secret; the vault is never unlocked from the phone (a host-side Settings action) |
| [0036](../../../../docs/rfcs/0036-bot-management-from-pocket.md) | Bot management from Pocket: memory, schedules, settings | In delivery (accepted 2026-11-19; amends RFC 0015) | In the chat of a project Bot the computer shows (never a global Bot or the Main Bot, which keep RFC 0015's chat writes only): its memory, not for a private Bot (read, add, edit; delivery 1), its scheduled tasks (list, pause, resume, rename; delivery 2), its name and model, the level read-only (delivery 3). Each on its own short-lived Pocket Link connection, negotiated in the chat `hello`; privacy.md changes with each pocket delivery |
| [0046](../../../../docs/rfcs/0046-pocket-link-without-herdr-app.md) | Pocket Link without herdr-app: Pocket's own part, installed and paired by `am` | Accepted (2026-11-21, by the owner's delegate: the direction and its six questions, each the recommended option) | Pocket's RFC, kept with the monorepo's numbers: the bridge and chat ship as byte copies in am's signed tarball; `am pocket pair` prints the QR code; `am pocket link status\|on\|off\|forget\|reset`; the service names, state folder and pairing link stay; the dialog drives am's copy while herdr-app stays; the phone's pairing hint names `am pocket pair`. No change to `latest.json`, `pocket-lane`, the app ID or the signing key |

Back to the [docs home](../_index.md).
