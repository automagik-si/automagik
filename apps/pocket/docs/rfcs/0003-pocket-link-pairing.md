---
rfc: "0003"
title: "Pocket Link: pair with Herdr desktop over iroh, no SSH"
status: Implemented
created: 2026-11-01
pr: "automagik-dev/automagik-pocket#4"
---
# RFC 0003 — Pocket Link: pair with Herdr desktop over iroh, no SSH

## Summary

The phone pairs with Herdr desktop by scanning a QR code from the Pocket Link desktop mod. After
that it reaches the computer's herdr-core over iroh: dialled by public key, direct when possible,
otherwise through n0's public relays, end-to-end encrypted either way. No SSH, password or open
port. SSH stays as the other way to connect.

## Motivation

Recorded after the fact from automagik-dev/automagik-pocket#4. Its stated goal: pair "like a TV pairs with a streaming account.
No SSH, no password, no open port."

## Current state

Phone (`android/app/src/main/java/ai/namastex/automagik/`):

- Pairing link `herdr-pocket://pair?v=1&n=<desktop>&c=<code>&t=<ticket>`, parsed at
  `IrohLink.kt:27-46`. Only `v=1`, a valid `endpoint…` ticket and a 16-64 character code pass. The
  desktop name loses control characters and is cut to 60 characters (`:42`).
- The phone's iroh key: generated once, kept in no-backup storage (`IrohLink.kt:63-64`).
- ALPNs: `herdr-pocket/pair/1` to pair, `herdr-pocket/1` for sessions (`IrohLink.kt:55-56`). A
  session sends `{"session": …}` and then speaks the herdr-core protocol through the same
  `CoreClient` as SSH (`IrohLink.kt:97`).
- Pairing sends the code and the phone's make and model (`IrohLink.kt:83`,
  `PocketViewModel.kt:254`).
- QR scanning: bundled ZXing scanner (`android/app/build.gradle.kts:190`). Deep links open the app
  through the `herdr-pocket://pair` intent filter (`AndroidManifest.xml:15`) and show the computer’s
  key fingerprint and whether its key is already saved. Confirming an external link saves the
  pairing. A new computer waits for **Connect** in Settings → Machines (`MainActivity.kt:314`,
  `PocketViewModel.kt:360`).
- iroh library: `android/app/build.gradle.kts:63`. ABIs kept: arm64-v8a, armeabi-v7a, x86_64
  (`:27`); native libraries compressed (`:45`).

Desktop (`herdr/mods/pocket-link/bridge/bridge.mjs`):

- A code lasts 10 minutes by default (1 to 60 allowed) (`:158-163`) and works once.
- One phone key gets 3 wrong tries, then is refused without counting; only a flood, 1000 wrong
  tries in all, ends the code (`bridge/pairing.mjs:7-13`). With no live code, a pairing connection
  is closed before anything is read. Closing the dialog ends the code (`bridge.mjs cancel`,
  `main.js:108`).
- Before pairing, a connection from an unvalidated source address gets a QUIC retry. Then it
  has 10 s for its handshake and first line; at most 16 are in that phase, 4 from one address (an
  IPv4 address, an IPv6 /64, or the key a relayed peer claims), and 64 open in all
  (`bridge/guard.mjs:8-14`).
- Residual risk, accepted by the owner 2026-11-03: a flood through a relay with a new key per
  connection, or stalled handshakes, can fill the pending slots and refuse a paired phone's new
  sessions while it lasts. Open sessions are unaffected. Remedy: reset the desktop key
  ([#48](https://github.com/automagik-dev/automagik-pocket/issues/48)).
- Removing a phone ends its open session (`:98`).

## Design

```
desktop mod ──QR: ticket + one-time code──▶ phone
phone ──iroh, ALPN herdr-pocket/pair/1: {code, device}──▶ bridge ──▶ paired list
phone ──iroh, ALPN herdr-pocket/1: {session}──▶ bridge ──▶ hc connect ──▶ herdr-core
```

Paired desktops sit in the machine list next to SSH machines.

## Decisions

- Owner, 2026-10-31: pair with Herdr desktop over iroh through the Pocket Link mod, with no SSH,
  password or open port (PR automagik-dev/automagik-pocket#4).
- Owner, 2026-10-31: scan QR codes with the bundled ZXing scanner. Reason in the PR: it works
  without Google Play services, and Google's code scanner couldn't download its module on the
  emulator (PR automagik-dev/automagik-pocket#4).
- Owner, 2026-10-31: ship only arm64-v8a, armeabi-v7a and x86_64 and compress the native
  libraries. Reason in the PR: the APK went from 73 MB to 40 MB (PR automagik-dev/automagik-pocket#4).

## Alternatives considered

SSH remains supported. No other transport was written down as considered.

## Amendment, 2026-11-19 (#246)

GitHub issue #246 is the source of this change. On 2026-11-19 the owner decided to start #246 and
take the recommended option. The worker chose the specific dialog and connection behavior below.
That choice awaits the owner’s review (Open question 4).

Phone source paths below are under `android/app/src/main/java/ai/namastex/automagik/`.

- The external link confirmation shows the same fingerprint format as the desktop, the first 12
  hexadecimal characters of its key in groups of four. Pocket recognizes a saved computer by its
  full key and shows the saved name. For a new computer it labels the link’s name as the computer’s
  own claim (`IrohLink.kt:29`, `IrohLink.kt:63`, `PairScreens.kt:39`). Android resolves the ticket
  away from the main thread and offers only the latest link. A ticket that can’t be read is refused
  before confirmation (`PocketViewModel.kt:343`). Display names lose control, format and line
  separator characters, and are trimmed and limited to 60 (`IrohLink.kt:32`, `PocketViewModel.kt:387`).
- **Pair** saves the computer. A new computer opens a session when the person taps **Connect**.
  An already saved computer keeps its existing connection or retry state. In-app QR scans and
  pasted links still pair and connect at once (`MainActivity.kt:314`, `PocketViewModel.kt:360`,
  `PocketViewModel.kt:380`). Settings → Machines shows the fingerprint on a paired card when
  its key prefix is available (`Screens.kt:127`). The link format, ALPNs and bridge protocol stay
  as documented above.

Alternatives considered for #246

- B. Wait for **Connect** after an in-app scan or paste too. The person starts those routes in
  the app’s pairing dialog, and #246 covers links opened from outside the app. The paste field
  can still prefill from the clipboard (`PairScreens.kt:17`).
- C. Put the fingerprint on the desktop pairing card as well. That would make comparison easier
  and would require a separate Herdr pack change and desktop verification.
- D. Remove the `BROWSABLE` intent filter. This would break opening **Copy link** from another app.
- E. Persist an unconfirmed flag for each new computer. Automatic retries and Watch resume use
  existing connection state, so a new computer has no session to resume (`PocketViewModel.kt:416`,
  `PocketViewModel.kt:500`).

## Open questions

1. Why iroh rather than another way through NAT? No reason was written. — the owner.
2. The scheme and ALPNs still say `herdr-pocket`. Rename them with the desktop mod, or keep them
   as a stable protocol name? — the owner.
3. automagik-dev/automagik-pocket#4 lists "connecting paired machines automatically at launch" as not done. Still wanted? —
   the owner.
4. Owner to confirm the #246 choice for external links, including the dialog and the separate
   **Connect** action for new computers.

## Related

- automagik-dev/automagik-pocket#4
- Desktop mod: [`herdr/mods/pocket-link/`](../../../../herdr/mods/pocket-link/README.md)
- [Privacy](../privacy.md)
