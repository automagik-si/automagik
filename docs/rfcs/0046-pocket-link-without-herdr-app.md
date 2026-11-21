# RFC 0046: Pocket Link without herdr-app: Pocket's own part, installed and paired by `am`

| Field | Value |
|---|---|
| Status | Accepted (direction decided by the owner's delegate on 2026-11-21: [RFC 0030](0030-code-mode-in-the-app.md), Decisions (2026-11-21), 4; its six questions decided by the owner's delegate on 2026-11-21, each the recommended option, see Decided; nothing built) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). Deliveries: herdr (3.N.P) carrying am's byte copies, then pocket (3.N.P) for the phone's text |
| Created | 2026-11-21 |
| Owner | Pocket ([apps/pocket/AGENTS.md](../../apps/pocket/AGENTS.md): Pocket Link belongs to Pocket) |
| Amends | [RFC 0012](0012-am-cli-and-parts.md) (Pocket Link's part, delivery 8): see its Amendment (2026-11-21, #1007) |

> Accepted by the owner's delegate on 2026-11-21 while the owner is away; the owner may amend on
> return.

## Summary

Pocket Link stops being a herdr-app mod. Its bridge already runs as a login service and needs only
Node and herdr-core; what needs herdr-app today is the dialog that installs it, turns it on and
shows the pairing code. This RFC moves those steps to `am`: a part `pocket.link`, owned by Pocket,
whose files ship inside am's signed tarball as byte copies of `herdr/mods/pocket-link/`. A person
runs `am pocket pair` in a terminal and scans the QR code it prints; `am pocket link
status|on|off|forget|reset` covers the rest of the dialog. herdr-app stays in Automagik's install
until this ships (RFC 0030 Q20, unchanged).

## Motivation

- RFC 0030 retires the pack and draws Code in the Automagik app. herdr-app leaves Automagik's
  install only once Pocket Link runs without it (Q20, `0030-code-mode-in-the-app.md:780-783`), and
  Pocket was asked to answer how (Q11, `:862-864`). The owner's delegate chose RFC 0012's proposal
  (Decisions (2026-11-21), 4, `:812-817`).
- No release ships Pocket Link and nothing updates it: a person copies the folder by hand and
  re-runs npm (`herdr/mods/pocket-link/README.md:25`). Through `am`, it arrives signed and updates
  with am.

## Current state

- **The dialog is the only installer.** Install is a copy into `~/.config/herdr-app/mods/`, then
  ⌘⌥P (`herdr/mods/pocket-link/README.md:13-15`). `main.js` imports from `herdr`
  (`herdr/mods/pocket-link/main.js:11`), runs `npm ci --omit=dev` in `bridge/`
  (`main.js:206-216`), and calls the bridge's `install` for Turn on and `stop` for Turn off
  (`main.js:189-190`, `:293`).
- **The bridge needs no herdr-app.** `bridge/bridge.mjs` is a plain Node CLI with every verb the
  dialog uses: `serve`, `pair`, `status`, `cancel`, `copied`, `start`, `stop`, `forget`, `reset`,
  `install`, `uninstall` (`bridge.mjs:380-428`). It reaches terminals through `hc connect`
  (`bridge.mjs:71-75`, `:112`), imports only its own folder, `../chat/` and two npm packages,
  `@number0/iroh` and `qrcode` (`bridge.mjs:18-29`, `bridge/package.json`).
- **The login service.** A LaunchAgent `dev.herdr.pocket-link` or a systemd user unit
  `herdr-pocket-link.service`, whose command is the Node that ran `install` and that copy's
  `bridge.mjs serve` (`bridge.mjs:42`, `:341-378`).
- **State lives outside the mod.** `${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link/`
  (a `-<hash>` suffix for another `HERDR_APP_HOME`; `POCKET_LINK_STATE_DIR` overrides it): the
  computer's key, the paired phones, the code and the log (`bridge/state.mjs:4-8`, `:24-27`).
  The pack's footer reads its `public-status.json` (`herdr/mods/am-footer/main.js:10-23`).
- **The pairing contract** is the link `herdr-pocket://pair?v=1&n=…&c=…&t=…`, a 128-bit code with
  a 1-60 minute expiry (`bridge.mjs:315-329`; Pocket RFC 0003).
- **What already keeps it apart.** The pack never installs, updates or writes Pocket Link
  (`herdr/scripts/parts.mjs:133`, `:283`; `herdr/mods/am-sidebar/parts.mjs:24`); RFC 0012 proposed
  its own part, Pocket-owned, and `am pocket pair` (`0012-am-cli-and-parts.md:277-280`, delivery 8).
- **The phone's text** tells a person to open Herdr and press ⌘⌥P
  (`apps/pocket/android/app/src/main/java/ai/namastex/automagik/PairScreens.kt:25`).

## Design

### The part

| Field | Value |
|---|---|
| `id` | `pocket.link` (proposed; Pocket's to confirm) |
| `kind` | `binary`, like `automagik.am` |
| `os` | `macos`, `linux` (systemd). Windows is not applicable (exit 2) until RFC 0016's guest |
| `set` | none: Pocket installs nothing on a computer by itself (Decided 4) |
| `requires` | Node 20.3+ and npm (the bridge's floor; am's own floor, 22.7, already covers Node), and a reachable herdr-core |
| `writes` | `~/.automagik/parts/pocket.link/**`, `~/Library/LaunchAgents/dev.herdr.pocket-link.plist`, `~/.config/systemd/user/herdr-pocket-link.service`, the state folder above |

- **Where the bytes come from** (Decided 1). `scripts/am-copies.mjs` copies Pocket Link's shipped
  files (`bridge/*.mjs` but tests, `bridge/package.json`, `bridge/package-lock.json`, `chat/` but
  tests, `LICENSE`) to `am/pocket-link/`. Pocket Link stays the source, as the pack stays the source
  of the CLI; nobody edits the copy. They ship in `automagik-am-<v>.tgz` and are as signed as am.
- **Where they go.** `am` keeps each version in its parts store,
  `<AM_HOME>/parts/pocket.link/<version>/`, with `current` and `previous` links (RFC 0012's store,
  already used by `automagik.am`). The login service runs `current/bridge/bridge.mjs serve`.
- **Packages** (Decided 2). `npm ci --omit=dev --no-audit --no-fund` in that version's `bridge/`,
  from the committed lockfile, as the dialog does today. A version whose lockfile equals the
  previous one's reuses its `node_modules`.
- **Names kept.** The service label and unit, the state folder, the pairing link and every bridge
  verb stay as they are, so pairings made in the dialog keep working and the footer keeps reading
  the same file. Nothing in the phone's contract changes.

### The commands

| Command | Does |
|---|---|
| `am pocket pair [--minutes N]` | Installs `pocket.link` if missing (npm, about 25 MB, said before it starts), installs and starts the login service, then prints the QR code in the terminal and the link under it. Waits until a new phone appears in `status` or the code expires; Ctrl-C ends the code (`cancel`). |
| `am pocket link status` | The bridge's `status`: running, the computer's fingerprint, the paired phones with theirs. |
| `am pocket link on` / `off` | `install` / `stop`, as Turn on and Turn off. |
| `am pocket link forget <id>` | `forget`, through the running bridge as today. |
| `am pocket link reset` | `reset`, after a confirmation that names its effect: every phone unpaired. |
| `am install` / `uninstall` / `doctor pocket.link` | RFC 0012's entries. Uninstall stops and removes the service and the store, and keeps the state folder (the pairings) unless `--purge`. |

- **Who may pair** (Decided 3). A pairing gives a phone everything a terminal running `hc` has
  (`README.md`, "What it does on your computer"). `am pocket pair` refuses inside a Herdr terminal
  or a DSH tool call, by D35's test for an unsigned-source prompt (RFC 0012, Threat model), and
  needs a TTY; `--json` never prints the code. Today's dialog needs a click in herdr-app.
- **Updates.** When am updates itself and its `pocket-link/` copy differs from the installed
  `current`, am stops the bridge (`stop`, which the README says must come before the files change),
  stages the new version, runs npm when the lockfile changed, swaps `current` and starts it again.
  A failed start puts `previous` back. The hourly linked updater never installs `pocket.link`.
- **Doctor lines**: `node`, `npm`, `packages` (the `node_modules` matches the lockfile), `service`
  (the file exists and runs `current`), `running`, `state` (0700).

### The dialog and the mod while herdr-app stays

- One bridge per computer. When `pocket.link` is installed, the dialog drives that copy (its
  `BRIDGE` becomes `current/bridge/bridge.mjs`) and says Pocket Link is managed by `am`; its own
  Install the bridge step goes away (Decided 5).
- `am pocket pair` on a computer whose service still runs the mod's copy takes the service over
  (it rewrites the one service file); the mod folder is left alone, since herdr-app owns it.

## Deliveries

1. **`am pocket` and the part** (herdr patch carrying am). The byte copies, `am pocket pair|link`,
   the part's entries, update and doctor. *Check:* with fake `launchctl`, `systemctl`, `npm` and
   `hc` first on PATH and a temp HOME: pair installs, starts and prints a code; a state folder from
   the mod is reused and its phones listed; an update stops, swaps and restarts, and a failed start
   rolls back; refusal inside a Herdr pane env; uninstall keeps the state folder. *Rollback:*
   revert; a running service keeps its stored files and the dialog can still stop it.
2. **The dialog defers to `am`** (herdr). Decided 5's dialog change, and Pocket Link's README
   Install and Update rewritten around `am pocket pair`. *Check:* `pocket-link`'s CI job; the
   dialog drives am's copy when it exists.
3. **The phone's text** (pocket). The pairing hint names `am pocket pair`, and Herdr's dialog while
   it exists. *Check:* the GitHub APK build and both flavor gates.

RFC 0011's Pocket row then says that Pocket Link ships inside am's tarball (delivery 1's PR).
herdr-app's removal from the install (RFC 0013 delivery 7, re-scoped by RFC 0030) can follow once
1 and 2 are in a stable release; it is not this RFC's.

## Threat model

- **Pairing.** The bridge's `pair` verb can already be run by any code of the same user; `am pocket
  pair` adds no reach. Decided 3 only keeps `am` from being the easy path for a Bot.
- **Bytes.** Pocket Link's code comes from am's signed tarball (am-lane, `AM_LANE_KEY`); its two
  npm packages come from the registry, pinned by the lockfile's integrity hashes, as today.
- **Unchanged:** the guard, the 128-bit codes, the paired-key check, the state folder's modes and
  one writer for `devices.json`.

## Decided (owner's delegate, 2026-11-21)

Each question this RFC put, decided by the owner's delegate, 2026-11-21, recommended option. The
options not taken are under Alternatives considered. The owner may amend on return.

1. **Where the bytes come from.** Byte copies of Pocket Link's shipped files in am's tarball,
   signed with am; decided by the owner's delegate, 2026-11-21, recommended option.
2. **npm packages.** `npm ci` from the committed lockfile on the computer, as today; decided by the
   owner's delegate, 2026-11-21, recommended option.
3. **Who may pair.** `am pocket pair` is refused inside a Herdr terminal or a DSH tool call, runs
   on a TTY only, and never prints the code in `--json`; decided by the owner's delegate,
   2026-11-21, recommended option.
4. **Default set.** `pocket.link` is in no set: `am pocket pair` or `am install pocket.link`
   installs it; decided by the owner's delegate, 2026-11-21, recommended option.
5. **The dialog while herdr-app stays.** It drives am's copy when one is installed; decided by the
   owner's delegate, 2026-11-21, recommended option.
6. **The phone's spaces without herdr-app.** Not this RFC's: herdr-app's removal checks that the
   phone still shows terminals without herdr-app's doc in herdr-core (`PocketViewModel.kt:841`,
   `HostReads.kt:96`), as it does for a linked machine with no layout; decided by the owner's
   delegate, 2026-11-21, recommended option.

## Alternatives considered

1. Its own release asset with its own signed pointer: a new key, which only the owner makes. A
   pinned git commit fetched by am: an unsigned source, which needs a yes every time.
2. `node_modules` built per OS and architecture into the tarball: about 25 MB more per target in
   every release.
3. Pairing allowed anywhere, as the bridge's own verb is.
4. `pocket.link` in the `code` set, so every Code machine runs a bridge.
5. A dialog that refuses to act and names `am pocket`; a dialog that keeps its own copy, so two
   copies would fight over one service.
6. The phone's handling of a missing herdr-app doc as a fourth delivery here.

## Links

- RFCs: [0030](0030-code-mode-in-the-app.md) (Q11, Q20, Decisions (2026-11-21), 4),
  [0012](0012-am-cli-and-parts.md) (parts, `am pocket`, its Amendment (2026-11-21, #1007)),
  [0011](0011-monorepo-parts-and-releases.md) (the Pocket row), [0013](0013-work-code-switch.md)
  (delivery 7), [0016](0016-windows-wslc.md) (Windows).
- Pocket: [RFC 0003](../../apps/pocket/docs/rfcs/0003-pocket-link-pairing.md) (pairing),
  [Pocket Link's README](../../herdr/mods/pocket-link/README.md).
- Issue: #1007.
