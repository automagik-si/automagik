---
title: "Pocket Link doesn't install the usage meter"
type: decision
status: Implemented
created: 2026-11-03
updated: 2026-11-03
pr: "automagik-dev/automagik-pocket#53"
tags: [decisions, pocket-link, desktop, usage-meter, security]
---
# Pocket Link doesn't install the usage meter

The Automagik Herdr pack is the one installer of [usagemeter](https://github.com/automagik-dev/usagemeter).
Pocket Link's bridge neither installs nor runs it; the phone keeps reading the `herdr-meter` doc.

## Decision

- Owner, 2026-11-03: one installer, the Automagik Herdr pack (pinned, hash-checked).
- Reason, from the pairing security review of 2026-11-03: `serve` always started the meter. Every
  10 minutes it installed usagemeter's latest GitHub release on this computer and on every machine
  in `hc machine ls` through `hc exec` and `curl`. Each download was checked only against that same
  release's `SHA256SUMS`, without an opt-in, and the setup text didn't mention it.
- This supersedes the Pocket Link half of [RFC 0005](../rfcs/0005-usage-meter.md)'s "Current
  state" and the installer added in automagik-dev/automagik-pocket#44.

## Current state

- Removed: `bridge/meter.mjs`, its tests, the `meter` command, `meter` in `status`, and the
  dialog's failing-meter lines. Existing `meter.json` files in state directories are preserved.
- Left alone: a `~/.local/bin/usagemeter` that an older bridge installed. The pack updates it.
- The phone reads `herdr-meter` as before; no Android change
  ([Using: Spend](../guides/using.md#spend)).

## Open questions

1. Machines that only an older bridge kept up to date stop getting meter updates until the pack is
   installed there. Does the pack cover every machine in `hc machine ls`? Owner.

## Related

- [RFC 0005](../rfcs/0005-usage-meter.md)
- [Pocket Link README](../../../../herdr/mods/pocket-link/README.md)
