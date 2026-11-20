# RFC 0013: The work and code switch

| Field | Value |
|---|---|
| Status | In delivery (deliveries 1-6: #211, #237, #238, #259, #265, #272; 7 (one install) and 8 (shared Bots) open; owner's answers in: D27 and Decided; D27 replaced by the owner 2026-11-10, #1007, designed in [RFC 0030](0030-code-mode-in-the-app.md), accepted 2026-11-19: deliveries 7 and 8 re-scoped there) |
| Milestone | none (ships outside the five milestones) |
| Lanes | desktop (3.N), plugin (3.N.P), herdr (3.N.P, [RFC 0011](0011-monorepo-parts-and-releases.md)) |
| Created | 2026-11-03 |

## Summary

Automagik is one product with two windows. Work is the app as it is today: DSH and the Bot
team. Code is herdr-app, used exactly as today with its mods. Nothing in Herdr is rebuilt; this
RFC only glues the two together. A Work / Code switch in Automagik brings the real herdr-app
window forward, on the space for the current Bot's folder. A button in Herdr brings the person
back. One install sets up DSH, herdr-app and the Automagik Herdr pack, and herdr-app is kept on
its latest release. Both modes read one Bot registry and one pet system. The owner's answers are
D27 and the Decided section (2026-11-03).

**D27 is replaced** (owner, 2026-11-10, issue #1007): Code moves inside the Automagik app, which
draws the coding team and its herdr-core terminals itself, and the pack's mods become DSH plugins.
[RFC 0030](0030-code-mode-in-the-app.md) designs it and says which of D27's text is replaced, which
narrow sense is kept (Herdr's spaces, tabs, splits and layouts are not rebuilt), and how
deliveries 7 and 8 are re-scoped. Deliveries 1-6 stand until RFC 0030's Code mode ships.

## Motivation

The owner wants one Automagik for work and code (D7, D12; "start the switch", 2026-11-03). Today
people switch between the two apps by hand. Nothing carries the Bot or the folder across.
Nothing tells them Herdr is missing, out of date, or has an agent that needs them.

He first asked for one window with both modes in it. A spike tried that
(`spike/code-mode-in-wrapper`, see Alternatives). One window works only by rebuilding Herdr's
UI inside the wrapper. D27 rejects any rebuild: two windows, one product, glue only.

## Design

### Where the switch lives

On macOS the app has no title bar. DSH's page fills the window, and the traffic lights sit in
the Bot sidebar's top row (`frame.js`; `sidebar.js:392`, `.bt-side-top`). So the switch goes in
that row, the same place on every OS. It is part of the Bot team plugin. It shows only when the
app's preload exposes `omniDesktop.herdr`, the same feature check as `desktop-update.js:85`. DSH
in a browser, or an older app, shows no switch.

The switch is two segments, Work and Code. Work is lit while this window is in front. The Code
segment carries Herdr's state:

| State | How it is known | What Code shows | A click does |
|---|---|---|---|
| Not set up | no herdr-app, or no pack | "Set up" | runs the code set's install (delivery 7) |
| Update due | the feed has a newer herdr-app | "Update" dot | offers the update; yes updates, then opens; no opens the installed one |
| Closed | herdr-app found, `status` exits 2 ("no Herdr window") | plain | starts Herdr, then opens |
| Open | `status` exits 0 | a count of agents that need the person, from `ls` | opens |

The state is read when the window gains focus and when the person hovers the switch. There is
no timer. The switch moves only on a click, and there is no keyboard shortcut (D27). Nothing
switches on its own. Automagik stays open behind Herdr; it never hides.

### Launch and focus protocol

It runs in Electron's main process (`apps/desktop`), never in the Bot team server. RFC 0010's
server fence will confine DSH, and the launch must not come from inside it.

The page sends a Bot id and nothing else. The preload sends it only during a real click
(`navigator.userActivation.isActive`). That only stops calls with no click at all; see the
Threat model. Main
accepts it only from DSH's page, the same check as the update channel. Main looks up the Bot's
folder and machine itself: in the Bot team's state today, in the shared registry once it exists.
A Bot id that main cannot find opens Herdr with no space picked. Every call to herdr-app is
`execFile` with an argv array, never a shell, with a 10 s limit.

1. **Find.** The path the installer recorded for the code set (delivery 7). Before that, in
   order: the `AUTOMAGIK_HERDR_APP` override; herdr's own install path for the OS (see
   Cross-OS); then `herdr-app` on PATH. An app started from Finder has no `~/.local/bin` on its
   PATH, so the install paths come first.
2. **Latest.** The installed `--version` is compared with herdrdev's feed
   (`https://releases.herdr.dev/app/latest.json`). When the feed is newer, the switch offers the
   update. On yes it updates before code mode opens: through herdr-app's own `app.update` when
   the window is open, else from the feed's file for the OS, checked against the feed's sha256.
   On no, or with no network, it opens the installed one (offline adds a note). Terminals keep
   running in herdr-core through an update.
3. **Start or raise.** On macOS through LaunchServices (`open -a <Herdr.app>`): it starts or
   raises the app, and Herdr is not a child of Automagik. On Linux and Windows, the bare binary,
   detached, which "opens or raises the window" (herdr-app skill). herdr-app has no raise
   command. Where the OS refuses to raise it, the switch says "Herdr is open in another window".
4. **Wait.** `status` until it exits 0, for up to 10 s. Exit 2 means no window yet.
5. **Pick the space.** `ls`, then the space whose `folder` is the Bot's folder (`workDir`,
   `roster.js:200`) on the Bot's machine. Spaces on every machine count, remote ones too (D27).
   A Bot's machine is this computer unless the registry names another. A match gets
   `space.select --id`. Two matches: the active one, else the first. No match: `space.new --name
   <folder name> --folder <folder> --machine <machine>`. A Bot with no folder (a global Bot,
   D3) gets code mode with no space picked: Herdr comes forward as it was.
6. **The Bot's agent.** Once both apps share Bot ids (the registry RFC, delivery 8):
   `automagik-herdr whois --bot <id> --json` names the Bot's pane, and `agent.focus` shows it.
   A Bot with no pane in its space gets its agent started (D27), through Herdr's own `start
   <bot> --space <id>`. That keeps Herdr's labels, attach ledger and briefing. The pack starts
   agents on this computer today; remote starts come as soon as it supports them. Until the
   registry lands, the space is the target and nothing starts.

RFC 0006 names mirrored spaces after Bots. This RFC matches by folder, because the folder is
what `ls` returns and what a person's own spaces already carry.

**The way back.** The Automagik Herdr pack gets a Work button (in `am-footer`). It opens
`automagik://open` with the OS's link opener (`open`, `xdg-open`, `start`). Once Bot ids are
shared (delivery 8), it opens `automagik://open?bot=<id>` for the Bot attached to the focused
pane, and the app selects that Bot. The app registers `automagik://` and keeps `omni://` as an
alias (D27): both open the same way, and `omni://connect` is unchanged (`deeplink.js`,
`main.js:101-131`).

### One install

One install sets up the whole environment: DSH, herdr-app and the Automagik Herdr pack (D27).
It runs through the `am` and parts plan (RFC 0012, not yet written): the code set (`part.json`,
`set: ["code"]`) installs herdr-app and the pack. The pack is checked against our signed
manifest, herdr-app against the sha256 in herdrdev's feed. `am doctor` feeds the switch's state.
There is no Homebrew card. The herdr-app it installs is `dev.herdr.app`, from herdrdev, which
updates itself; updates follow step 2.

Until that installer ships, the switch shows only where herdr-app is already set up. The update
check (step 2) does not wait for it.

### Shared state

The registry RFC, written before delivery 8 (D27), decides the format. This section lists what
the switch needs from it. The switch itself writes nothing: main reads a Bot's folder and
machine, and passes them to herdr-app.

What the registry RFC must give the two modes:

- **One place for Bot definitions** that both the Bot team and the Herdr pack read and write,
  including a repo's committed copy. Today the pack reads `<repo>/.herdr/bots.json`
  (`model.js:13`), and the handoff's proposal is `<repo>/.automagik/bots/bots.json`.
- **Writes that never overwrite each other.** Both sides write only if the file is unchanged
  since they read it.
- **One Bot id in both apps.** Ids are opaque and never rewritten. Today the Bot team uses
  `session-<uuid>` and the pack `b-` + 10 base32 characters.
- **A folder and a machine per Bot,** which main reads for step 5.
- **Definitions only in a repo:** never memory, rooms, schedules, secrets or browser partitions.
- **One pet folder** both sides read, filled by `automagik-pets bake`, with one pose map
  (`STATE_ROWS` and `EVENT_ROWS` in `pet.js`).
- **One home.** The desktop app's Bot team lives at `~/.automagik/desktop/bots` today
  (`dsh.js:707`). D6 moves it to `~/.automagik/bots`, through the registry RFC. Until then the
  app and Herdr see different Bots and pets.

What stays apart: the Bot team's Sessions, rooms, memory and schedules are never read by the
pack. Herdr's layout, spaces and attach ledger (`~/.config/herdr-app`) are read by the app only
through the herdr-app CLI.

Universal Bots ([RFC 0014](0014-shared-bot-registry.md), Amendments, 2026-11-07): the switch
picks which face is in front, and both faces show the Bot's one DSH Session. Its Herdr face is
a pane that reads and types into that Session through the desktop host (or `dsh-tui --resume`
once the host has let go of it), not a projected Claude pane. The pack still reads no DSH files.

### Cross-OS

All three OSes ship at once (D27).

| | macOS | Linux | Windows |
|---|---|---|---|
| Herdr build (`dev.herdr.app`) | aarch64 only, no Intel Mac | x86_64 and aarch64 | x86_64 only, Windows 10 1803+ |
| Installed at | `~/Applications/Herdr.app` (herdrdev's `install.sh`), else `/Applications/Herdr.app`; CLI `herdr-app` | `~/.local/share/herdr-app`; `herdr-app` in `~/.local/bin` | `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`, on PATH |
| `ls`, `do`, `status` | verified (0.1.12) | documented; delivery 1 proves it | documented; delivery 1 proves it; socket or named pipe unknown |
| Start or raise | LaunchServices | detached binary; Wayland may refuse focus | detached binary; Windows may flash the taskbar instead |
| Return link | `open` | `xdg-open`; deb registers the schemes, AppImage unverified | `start`; NSIS registers the schemes |
| Automagik app | ships | packages (#191) | needs #191's four fixes first |
| Window close | keeps running | quits herdr-app (`window.close`) | unverified |

Every build comes from herdrdev's feed: version, `core_min`, and a URL and sha256 for each
target (`herdr-app-<target>.tar.gz`). herdrdev publishes no GitHub release assets. Its
installers (`install.sh`, `install.ps1`) install herdr-core and `hc` when missing, and running
them again updates the app. #191's Linux and Windows results were for penso/herdr-gpui, a
different project, so they do not carry over.

Terminals live in herdr-core, so a closed window loses none of them; the next click starts it
again. Shipping all three at once makes #191's Windows fixes and the cross-OS harness
prerequisites, not follow-ups. Supported targets: macOS arm64, Linux x86_64 and aarch64,
Windows x86_64. Intel Macs and Windows on ARM are not supported (Decided 7). If `ls` or `do`
fails on Linux or Windows, we ask herdrdev (Decided 6).

### Sandbox (RFC 0010)

D27 puts herdr-app inside Automagik's environment. Here that means installed, kept latest and
checked by Automagik's installer, like DSH. It does not yet mean fenced (Decided 2). RFC 0010
recorded code mode as outside every boundary (gap 6). This RFC keeps the process side of that and
changes the install side:

- herdr-app never runs as a child of the app or DSH. On macOS LaunchServices starts it. On
  Linux and Windows it starts detached, with the app's own launch environment and none of the
  names the supervisor sets for DSH (`DSH_HOME`, `AUTOMAGIK_*`).
- Its agents run as the person and need the person's git and SSH credentials, which 0010's
  server fence denies. A fence for code mode comes later, through 0010's boundary API.
- The launch runs in the main process, so 0010's fence on DSH does not break it.
- Under the fence, DSH writes its home and repo files only inside a session's workspace. A
  repo's Bot definitions sit in its Bot's workspace, so that write stays allowed.
- If services move into an Arca guest later, the Bot home needs 0010's mount contract, with
  file-watch, or the two modes stop seeing each other's edits.

## Contracts introduced

- **The `automagik://` scheme.** New: `automagik://open`, and `automagik://open?bot=<id>` from
  delivery 8. `omni://` stays registered as an alias; `omni://connect` keeps its meaning.
- **`bot` on `open`.** New, on both schemes, from delivery 8. It only selects the Bot. An
  unknown or malformed id opens the app and selects nothing.
- **Preload bridge `omniDesktop.herdr`**: `status()`, `open({ botId })` (sent only during a
  click) and `onOpenBot(callback)`. New. The plugin checks for it; an app without it shows no
  switch.
- **IPC channels** `automagik-herdr-status`, `automagik-herdr-open` and `automagik-open-bot`.
  Between the preload and the main process only.
- **`AUTOMAGIK_HERDR_APP`**: a path override for the binary. New.
- **Log** `~/.automagik/desktop/logs/switch.log`. New, local only.
- **The herdr-app surface we depend on** (not ours): `--version`; `status` exit codes (0 open,
  2 no window); `ls` JSON (`spaces[].id`, `folder`, `machine`, `active`, terminal `status`);
  `do space.select`, `space.new`, `agent.focus`, `app.update`; the feed's `latest.json`. The
  pack's `start` and `whois --json` are ours (`herdr/`), later `am` verbs (D22).
- **The Bot team's home.** It stays at `~/.automagik/desktop/bots` (`dsh.js:707`) in this RFC.
  D6 moves it to `~/.automagik/bots` through the registry RFC. Plugin ids, routes and storage
  prefixes do not change.

## Threat model

- **Who reaches the bridge.** Any script in DSH's page, so any DSH client plugin. It can send
  only a Bot id, and main finds the folder itself, so the page cannot name a folder. The click
  check does not tie a call to the switch: user activation belongs to the page and is shared by
  every script in it. Right after the person clicks anything, any client plugin can call
  `open()`. After delivery 8 that can start any known Bot's agent and spend the person's tokens.
  Client plugins are trusted code today. If that changes, the fix is a check in the main
  process that the click landed on the switch.
- **The links.** Any web page or app can fire `automagik://open?bot=<id>`. It brings Automagik
  forward and selects a Bot. It never starts, sends or changes anything. The id must match the
  registry's id shapes.
- **Herdr's socket.** `~/.config/herdr-app/herdr-app.sock` is mode 0755. Other users have no
  write bit on it, so they cannot connect. Any process of the same user can already drive
  Herdr; the switch adds nothing to that.
- **The install and updates.** herdr-app is a third-party app. Each download is checked against
  the sha256 in herdrdev's `latest.json`; that proves the file matches the feed, not who made
  it. The feed and its sha256 come from the same host, `releases.herdr.dev`, so that host is
  trusted in full: whoever controls it controls what installs. The switch reads the feed and
  downloads builds from that host alone, over https, with redirects refused. herdr-app also
  updates itself, and no release passes a review of ours.
- **Undo.** Revert the release. The switch keeps no state but its log.

## Failure modes

| Failure | What the person sees | Log line |
|---|---|---|
| Not set up | "Set up" (after delivery 7); before it, no switch | `missing` |
| The person declines the update | Herdr opens on the installed version | `declined <version>` |
| The update fails or there is no network | Herdr opens on the installed version, with a note | `stale <version>` |
| No window within 10 s | "Herdr didn't open", with Retry | `timeout`, the last stderr line |
| A stale socket (exit 2 after a crash) | treated as closed: start, then retry once | `restart` |
| `do` answers `{ "error" }` (exit 1) | Herdr comes forward; the switch shows the message | `do-error` and the message |
| An unknown Bot, a missing folder, or none | Herdr comes forward with no space picked | `no-space` |
| The remote machine is offline | Herdr comes forward; "<machine> is offline" | `machine-offline` |
| The Bot's agent fails to start | Herdr shows its own error toast in the space | `start-error` |
| The OS refuses focus | "Herdr is open in another window" | `no-focus` |
| Unsupported host (Intel Mac, Windows on ARM) | no switch | `unsupported-host` |
| An older app and a newer plugin | no switch | nothing |

## Telemetry

There is no remote product telemetry today (`privacy.js` holds only third-party shares). The
switch writes local lines to `logs/switch.log`, in `timeline.js`'s step format: found, latest,
started, ready, space, agent, raised, each with its ms, and the outcome. Bot ids, never names.
Any remote send would be a new share on the Privacy page, off by default.

## Test plan

- **Unit (desktop, `node --test`).** A pure planner turns `ls` JSON, a Bot's folder and machine
  into the herdr-app argv list: match, no match, two matches, a remote space, no folder, a pane
  to focus, no pane to start. The finder runs against a fake file system for each OS. A fake
  `herdr-app` on PATH records argv and answers canned JSON and exit codes. A fake feed covers
  newer, same, unreachable, and a bad sha256.
- **Unit (desktop).** `deeplink.test.js` covers both schemes, `bot` ids good and bad, and that
  `omni://connect` is unchanged. The preload refuses `open()` without user activation.
- **Unit (plugin).** The switch renders only with the bridge; each state shows its label; a
  link's Bot is selected.
- **Mod.** `herdr-app check` on the pack's mod with the Work button.
- **Cross-OS.** Extend #191's `workflow_dispatch` harness. On macOS, Linux (under xvfb) and
  Windows: install herdr-app from the feed, start a window on a temp `HERDR_APP_HOME`, run
  `status`, `ls` and `do space.new`, and fire `automagik://open`. Record whether each window
  raised or the no-focus message showed.
- **Manual, with the owner's OK** (it drives the real window): Code with Herdr closed, open, out of
  date and not set up (through `AUTOMAGIK_HERDR_APP`); a remote space; the Work button back.

## Deliveries

Prerequisites, tracked elsewhere: #191's four Windows fixes for the Electron app; RFC 0012's
`am` shell and parts (for delivery 7); the registry RFC (for delivery 8).

1. **Find and raise** (desktop). The finder, start or raise, the wait, and the bridge with
   `status()` and `open()` (raise only).
   *Check:* the unit tests; on all three OSes the harness's `status`, `ls` and `do space.new`
   succeed, and the window is raised or the no-focus message shows.
   *Rollback:* revert. Nothing is stored.
2. **Always latest** (desktop). The feed check, the offer, the update on yes, and the installed
   version when declined or offline.
   *Check:* the fake-feed tests; with an older herdr-app, yes ends on the feed's version, and no
   and offline open the installed one.
   *Rollback:* revert; Herdr opens on whatever is installed.
3. **Automagik's links** (desktop). Register `automagik://` and keep `omni://` as an alias.
   *Check:* `deeplink.test.js`; on each OS, `automagik://open` brings the app forward.
   *Rollback:* revert; `omni://open` still works.
4. **The right space** (desktop). Main looks up the Bot's folder and machine, then picks or
   creates the space, or none for a Bot without a folder.
   *Check:* the planner's argv for each case; on all three OSes a Bot's folder opens its space.
   *Rollback:* revert; `open()` raises only again.
5. **The switch** (plugin). The sidebar control and its states, and the click. Ships after
   deliveries 1-4.
   *Check:* the plugin test; Code opens the Bot's space on each OS.
   *Rollback:* revert. The bridge stays unused.
6. **The way back** (herdr). The Work button in `am-footer` opens `automagik://open`.
   *Check:* `herdr-app check`; a click brings Automagik forward.
   *Rollback:* revert the pack.
7. **One install** (desktop, after RFC 0012). "Set up" runs the code set's install.
   *Check:* on a fresh machine of each OS, one click ends with Herdr open on the Bot's space.
   *Rollback:* revert; the switch hides where code mode is not set up.
8. **Shared Bots** (after the registry RFC), one PR per lane:
   - desktop: `bot` on the links; `whois --bot`, then `agent.focus`; a Bot with no pane gets
     its agent started;
   - plugin: the `onOpenBot()` listener selects the Bot;
   - herdr: the Work button sends its pane's Bot.
   *Check:* a Bot with a live pane is shown, a Bot without one starts in its space, and the
   Work button lands on the same Bot.
   *Rollback:* revert each; the space stays the target and the link opens without a Bot.

## Alternatives

**One window: code mode lite** (spike `spike/code-mode-in-wrapper`, `FINDINGS.md`, 2026-11-03).
The spike drew herdr-app's real spaces, tabs and splits in the Electron window, with live xterm.js
terminals on herdr-core's attach stream. It worked: key to echo p50 0.6 ms in the renderer, about
8 MB/s throughput, about 300 MB more memory with two busy panes. Its cost was about 5 dev-days,
plus 3-4 for layout editing, plus 1-3 days for each mod. Every mod's UI would be rewritten, and
herdr-app's keys, themes and palette lost. **Rejected (D27):** it rebuilds Herdr.

**One window: upstream embedding.** No embed, host-window, webview-pane or SDK mode exists or is
planned in herdr-app, herdr-gpui or herdr-core (the spike's route B). **Not available.**

**One window: docking herdr-app beside the wrapper.** macOS has no cross-process child windows.
Moving herdr-app through the Accessibility API lags on drag, fights over z-order and focus, and
breaks fullscreen and Spaces (route C). **Rejected.**

## Decided

D27 answered the first fourteen questions. The owner answered the rest on 2026-11-03, relayed by
the orchestrator.

1. **The Herdr source** is `dev.herdr.app`, from herdrdev, self-updating. It ships macOS,
   Linux and Windows builds (herdrdev's feed, checked by the Herdr pack's maintainers).
2. **Sandbox.** herdr-app is installed and kept latest now. The fence comes later.
3. **Updates.** The switch offers an update and does it on yes. With no network, it opens the
   installed version with a note.
4. **Remote starts** come as soon as the pack supports them. Spaces on every machine count now.
5. **Before RFC 0012's installer,** the switch shows only where herdr-app is already set up.
6. **Linux and Windows control.** Delivery 1's harness proves `ls`, `do` and `status` on all
   three OSes. If it fails, we ask herdrdev.

7. **Supported targets.** The one install supports macOS arm64, Linux x86_64 and aarch64, and
   Windows x86_64. Intel Macs and Windows on ARM are not supported: the switch never shows there.
   *Why:* herdrdev ships no build for them, and the sandbox cannot stand in. Apple's
   `container`, libkrun and microsandbox all need Apple silicon on macOS (their READMEs and
   libkrun `docs/building.md`). Unfold's microVM (`rth/council/08-poc-vmbox.md`) has no guest
   display. A full VM would need software Vulkan and a remote-desktop viewer. On Windows on ARM,
   x64 emulation and WSLg were untested options.

## Open questions

None. The owner answered every question (D27 and Decided).

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: none.
- Merged changes that cite this RFC: #205, #211, #236, #237, #238, #252, #259, #265, #272, #292, #302, #666 (last merged 2026-11-08).

## Links

- Handoffs: `~/.config/herdr-app/handoffs/bot-system-unification.md` (D1, D4, D6, D7, D10, D12,
  D13, D15, D20, D22, D27); `council-desktop-shell-2026-11-02.md` (synthesis, finding 4);
  `pocket-into-automagik-monorepo.md` ("One am CLI", "Parts").
- Spikes: #182 (Tauri, FINDINGS.md), #191 (cross-OS matrix), `spike/code-mode-in-wrapper`
  (`apps/desktop-code-mode-spike/FINDINGS.md`). PR #190 (Herdr import, merged).
- RFCs: [0006](0006-herdr-terminal-mode.md) Herdr terminal mode,
  [0010](0010-desktop-sandbox.md) desktop sandbox;
  [0011](0011-monorepo-parts-and-releases.md) monorepo parts and releases;
  0012 (`am` CLI and parts, not yet written); [0014](0014-shared-bot-registry.md) the registry RFC.
- Unfold: `~/workspace/repos/rth/council/08-poc-vmbox.md`, `27-deployment-boundary.md`.
- Sandbox sources: apple/container README (Requirements); containers/libkrun
  `docs/building.md` (macOS); superradcompany/microsandbox README (Requirements);
  microsoft/wslg README.
- Code: `apps/desktop/src/deeplink.js`, `main.js:101-131`, `frame.js`, `dsh.js:707`;
  `apps/bots-dsh/src/client/sidebar.js:392`, `client/desktop-update.js:85`, `client/pet.js`,
  `host/roster.js:200`; `herdr/mods/am-sidebar/model.js:13`.
