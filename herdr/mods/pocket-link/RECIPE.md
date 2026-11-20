# Pocket Link

A small dialog that pairs a phone with this computer the way a TV pairs with a
streaming account. You turn it on and press **Pair a phone**. A QR code
appears. You scan it with the Herdr Pocket Android app, and from then on the
phone reaches this machine's terminals and agents from anywhere. There is no
SSH, no password and no port to open. A small Node bridge answers the phone
over [iroh](https://iroh.computer). Connections are end to end encrypted and
direct when possible, or go through a relay that can't read them. The bridge
hands each paired phone a herdr-core session. The dialog also lists paired
phones, so you can remove one: its new connections are refused, and its open
sessions close within 2 seconds. Agents it started keep running.

![Pocket Link](preview.png)

## What you see

The dialog is 460px wide, from `mod.json` `{ "kind": "dialog", "width": 460 }`, with 18px padding on the theme's `popover` background. From top to bottom:

1. **Title row:**
   - a 16px link icon in `accent`
   - "Pocket Link" in 15px semibold
   - "Esc" in 11px `dim`, on the right
2. **Intro:** one line in 12.3px/18px `muted`: "Your agents on your phone, from anywhere. A phone pairs once with a code from this screen: no SSH, no password, no port to open."
3. **Power card:** 14px above it, 12px padding, 10px radius, a 1px `border`, on `raised`.
   - An 8px dot: `done` when on, `dim` when off.
   - Two status lines, 13px semibold over 12px `dim`:
     - On, with the service: "On · <host name>" over "Starts with your login."
     - On, without the service: "Running until you log out."
     - Off: "Off" over "Phones can't reach this computer."
   - While on, a third line in 12px `dim`: "Computer key fingerprint 4f1c 9a07 de21".
     The label may shorten, and the digits stay visible. The line is hidden during a key change.
   - On the right, a button: **Turn off** (outlined), or **Turn on** (solid, primary).
4. **"Pair a phone"** section, shown only while it's on. The section title is 11.5px medium `dim` with 16px above and 6px below.
   - With no code: one `muted` note and a primary **Pair a phone** button. The note reads "Open Herdr Pocket on the phone, tap Pair with Herdr desktop, and scan the code this makes. The code works once, for 10 minutes, and ends when you close this window."
   - With a code, a `raised` card (14px padding, 10px radius) holds, centred:
     - The QR code: black modules on a white card with an 8px radius and a 3-module quiet zone. Each module is `floor(224 / modules)` px, which is 3px for the usual 73 modules, so about 237px square.
     - "Scan with Herdr Pocket" in 12.5px.
     - "Expires in 9:41 · works once" in 12px `dim`, counting down every second.
     - Two outlined buttons: **Copy link** (reads "Copied" once the link is on the clipboard) and **New code**. Both are disabled while the dialog is busy.
     - Under them, centred, in 11.5px/16px `dim`, the clipboard warning: "Can't scan? Copy the link and paste it in Pocket. Your clipboard may sync to your other devices, so a copied code ends 2 minutes later." After a copy it reads "Copied. Your clipboard may sync to your other devices, so this code ends 2 minutes after the copy; then a new one appears here."
5. **Phones:** the section title is "Paired phones", or "No phones paired yet". Each phone is a row, 40px tall with a 10px side padding and an 8px radius, that turns `hover` under the pointer. The row has:
   - a 15px phone icon in `muted`
   - the phone's name in 13px, truncated
   - the key fingerprint, "4f1c 9a07 de21" (the first 12 hex characters of its key, in fours), in 11.5px `dim` beside the name
   - "Last seen 3 min ago" in 11.5px `dim`
   - an outlined **Remove** button
6. **Reset key…:** an outlined button below the phone list, whether Pocket Link is on or off.
   It asks "A new key for this computer: every phone (N) is unpaired and pairs again with a new
   code. Codes shown before stop working." With no phones, it says "no phones are paired" in place
   of the phone count and re-pairing text. The buttons are **Reset key** and **Cancel**.
   On success, a "Key reset" toast appears.
7. **Errors:** when there is one, it shows in 12px `blocked`.
8. **Footer:** in 11.5px/17px `dim`: "Phones connect directly when they can, and otherwise through
   a public iroh relay that passes along encrypted bytes it can't read. A removed phone's sessions
   close within 2 seconds; agents it started keep running."

Buttons are 30px tall with 12px side padding, a 7px radius and 12.5px medium text.
- **Primary:** `solid` with `solid_foreground` text.
- **Outlined:** `raised` with a 1px `input` border, turning `hover` on hover.
- **Disabled:** 45% opacity.
- **Busy:** the label changes ("Turning on…", "Making a code…") and a 12px spinner turns once every 900ms.

Before the bridge can run, the dialog shows one of two other screens in place of items 3–6:
- **No Node.js 20.3+ found:** a note lists the places it looked, any Node there that is too old, and how to get one.
- **Packages not installed:** a note and a primary **Install the bridge** button.

## How it behaves

- **Opening:** it asks the bridge for its status and draws it.
- **Live updates:** it then watches the state folder (`status` names it) and redraws whenever the bridge writes something there (pairing, phones, its address). Nothing polls.
- **Turn on:**
  1. It installs a login service:
     - **macOS:** a LaunchAgent `dev.herdr.pocket-link` with `KeepAlive`, bootstrapped into `gui/<uid>`
     - **Linux:** a systemd user unit `herdr-pocket-link.service`, enabled with `--now`
  2. The service starts the bridge now and at every login.
  3. If the bridge isn't running 4s later, the dialog starts a detached one instead, which lives until logout.
- **Turn off:** removes the service, stops the bridge, and cancels any open code.
- **Pair a phone:**
  - The bridge makes a one-time code: 16 random bytes, base64url, valid for 10 minutes.
  - The dialog draws the QR of `herdr-pocket://pair?v=1&n=<host>&c=<code>&t=<iroh endpoint ticket>`.
  - **New code** replaces the old code, so the old one stops working.
  - **Copy link** is for a phone that can't scan. The clipboard may sync to other devices (macOS Universal Clipboard), so a copied link must not stay good for 10 minutes:
    - The dialog first runs `bridge.mjs copied`, which cuts the live code's `expires` in `pairing.json` to 2 minutes from now (`COPIED_LIFE` in `bridge/pairing.mjs`). It never lengthens a code and keeps its wrong-try counts. The serving bridge reads `pairing.json` on every try, so this needs no change to the phones' protocol, and a bridge already running honours it.
    - Only then does the link go on the clipboard, and the countdown jumps to 2:00. If the bridge can't shorten it (the code was just used or expired), nothing is copied and the error shows.
    - `copied` rewrites `pairing.json` in place, not with a temporary file and a rename, so a code a phone used (and the bridge deleted) a moment before is never brought back.
    - The bridge still saves a wrong try with a rename, which can land over that write with the old expiry. So `copied` checks that `pairing.json` is still the file it wrote, with the same code and the shorter expiry, right away and again 50 ms later; if not, it shortens the new file. A different code is left alone, and after 5 tries it gives up ("The pairing code kept changing, so the link wasn't copied. Try again."). The dialog's own new code at 0:00 also ends a copied code, whatever the file says.
    - When the copied code reaches 0:00, the dialog makes a new code, once: the new one isn't copied, so at its own 0:00 the card goes back to the button. **New code** or closing the dialog ends a copied code at once, the same as any other.
  - At 0:00 the card goes back to the button.
- **When a phone pairs** with the code:
  - The bridge stores the phone's iroh public key and deletes the code.
  - The dialog posts a "Phone paired" toast (`notify`, success, 8s) with the phone's name and key fingerprint, puts the card away, and lists the phone. If the phone paired while the dialog was closing, the toast comes from what `cancel` returns.
  - Pairing again from a phone that's already listed refreshes its entry and also shows the toast.
- **Checking this computer's key:** a link tapped or shared from outside Pocket opens a confirm
  dialog with "Computer key fingerprint" for a new or a known computer. Confirming saves the
  computer without connecting. A scan or paste inside Pocket pairs and connects at once. A paired
  card shows its stored digits when it saved the computer's key. The digits must match the line in
  Pocket Link. After a reset, Pocket Link shows new digits and the old card keeps the old ones.
- **Reset key:** the running bridge changes its key in place over `bridge.sock`. With the bridge
  off, the command changes the files, and the new digits appear at the next **Turn on**. Every
  phone is unpaired and every earlier code stops working. The toast appears only on success. For
  an older bridge or a missing socket, **Turn off**, **Reset key**, then **Turn on**.
- **Remove:** forgets the phone. `forget` hands the removal to the running bridge over `bridge.sock` and waits for its answer; the bridge takes the phone out of `devices.json` and closes its open sessions with "not paired" at once (it also checks its list every second). With no bridge running, or a state folder whose path is too long for `bridge.sock`, `forget` writes the file itself. On the phone, Pocket says to pair again.
- **Wrong codes:** one phone key gets 3 wrong codes, then its tries are refused and not counted; only a flood, 1000 wrong codes in all, ends the code. A used or expired code is refused, and with no live code a pairing connection is closed after its handshake ("No pairing code is live. Make a new one on the desktop.").
- **Closing the dialog ends the code:** Esc runs `bridge.mjs cancel` and closes it; the view's `close(cx)` runs `cancel` too, for any other way the host closes it. A code still being made when the dialog closes is cancelled as it arrives.
- **Esc** closes the dialog. **⌘⌥P** on macOS, or **Ctrl+Alt+P** on Linux, opens it (see `keys.json`).
- **Phone sessions:**
  - Each phone session opens a bidirectional QUIC stream on ALPN `herdr-pocket/1`.
  - Its first line is a JSON header `{"session":"<herdr-core session>"}`; names must match `[A-Za-z0-9_.-]{1,64}`, or `default` is used.
  - The rest of the stream is piped to and from `hc connect` with `HC_SESSION` set, so the phone speaks herdr-core's own protocol.
  - The bridge refuses any key that isn't paired.
  - When `hc` ends while the phone still sends, the bridge stops writing to `hc`. An `EPIPE` no
    longer stops the bridge. It sends the rest of the output and ends the stream. Pocket closes
    the connection when it reads the end. If the connection is still open 30s after `hc` ended,
    the bridge closes it. Output the phone had yet to read can be lost. Other sessions stay open.

## Built from

- **`mods/pocket-link/mod.json`:** `{ "place": "none", "title": "Pocket Link", "overlay": { "kind": "dialog", "width": 460 } }`.
- **`mods/pocket-link/main.js`:** one `View`.
  - **Imports:**
    - `div` and `svg` from `gpui-kit`
    - `v_flex` and `h_flex` from `gpui-base`
    - `exec`, `appHome`, `home`, `readTextFile`, `theme`, `props`, `closeOverlay`, `notify` and `watchFolder` from `herdr`
    - `platform` from `os`
    - `findNode` and `noNodeMessage` from `./find-node.js`
  - **Finding Node** (`find-node.js`): Herdr started from the Dock or by launchd has a short PATH, without nvm, volta, fnm or asdf. The dialog takes the first Node that answers `--version` with 20.3 or newer, from:
    1. the login service file (the Node the LaunchAgent or systemd unit was installed with), then `.node` in the mod folder, which `install` and `start` write;
    2. the login shell (`$SHELL -lc 'command -v node'`), then Herdr's own PATH. A non-interactive login shell reads `.zprofile` or `.bash_profile`, not `.zshrc` or `.bashrc`, so it finds Homebrew or volta set up there but usually not nvm, which step 3 finds. The shell gets 3s: it runs in its own process group (`setsid` on Linux, where `sh` is dash and has no job control without a terminal; `set -m` elsewhere), and the whole group gets SIGKILL at the cap. Its answer goes through a temp file, so nothing left behind holds the pipe;
    3. `~/.nvm/versions/node/*` (newest first), `~/.volta/bin`, fnm's `node-versions` and default alias, `~/.asdf/shims`, then `/opt/homebrew/bin` and `/usr/local/bin` (macOS) or `/usr/local/bin` and `/usr/bin` (Linux).

    It keeps the answer for every later call. A search that found nothing is kept until the dialog closes; when the bridge gives no answer and the kept Node no longer answers `--version` with 20.3+ (gone, or broken by an upgrade), the dialog forgets it, searches again and retries the command once.
  - **Calling the bridge:** it runs `exec("<that node>", ["<appHome>/mods/pocket-link/bridge/bridge.mjs", <command>, …])` and parses the last stdout line as JSON. `install` and `start` run under that Node, so the login service and a detached bridge use it too. The commands are `status`, `install`, `start`, `stop`, `pair`, `cancel`, `forget <id>` and `reset`.
  - **Clipboard:** `cx.write_to_clipboard`.
  - **Timers:** a 1s `cx.timer.every` runs only while a code shows.
  - **Install the bridge:** runs `npm ci --omit=dev` in `bridge/`, with the found Node's folder first on PATH (npm sits next to it). It is detached so it can run past `exec`'s 30s limit, and the dialog watches for `.setup.done`.
  - **The QR:** drawn as divs, one `h_flex` per module row, with runs of dark modules merged into one div.
- **`mods/pocket-link/icons/`:** its own `link.svg`, `phone.svg`, `spinner.svg` and `x.svg`. These are 24×24 strokes on `currentColor`, used with `svg()` so they take the text colour.
- **`mods/pocket-link/bridge/`:**
  - `package.json` depends on exact versions: `@number0/iroh` 1.2.0 and `qrcode` 1.5.4. `package-lock.json` is included.
  - **`bridge.mjs`** commands:
    - `serve`
    - `pair [minutes]` prints `{link, expires, rows}`, where `rows` holds the QR modules as strings of `1`/`0`
    - `status` prints `{running, id, name, ticket, fingerprint, devices, pairing, login, state}`.
      The computer's key fingerprint shows while the bridge is running with an id and ticket,
      outside a key change. It is `null` otherwise. Each device has its own `fingerprint`.
    - `cancel` deletes the live code and prints `{ok, cancelled, devices}`
    - `forget <id>` prints `{ok, removed, via}`: `via` is `bridge` when the running bridge removed the phone, `file` when no bridge answered on `bridge.sock` and `forget` wrote `devices.json` itself (`bridge/devices.mjs`). A bridge that refuses or gives no answer within 10s is an error, and so is a socket that is there but refuses connections (a busy bridge) after 2s of tries; nothing is written then. Each of these errors names the bridge's pid and ends with what to do: Remove again, or Turn off, Remove, Turn on.
    - `reset` prints `{ok, via, unpaired}` and adds `id` when `via` is `bridge`. A running bridge changes its key in place over `bridge.sock`. With the bridge off, `via` is `file`. If a bridge starts during the file change, the command asks it to adopt the new key. With an older bridge or a missing control socket, turn Pocket Link off, reset the key, then turn it back on.
    - `start`, `stop` (prints `{ok, stopped}`, the pid it signalled or null), `install` and `uninstall`
    - **Whether a bridge runs** (`bridgeState` in `bridge/devices.mjs`), the one check behind `serve`, `start`, `stop`, `status`'s `running`, `pair` and `forget`: `status.json`'s pid being alive is not enough, because after a crash the pid can be another process's (issue #301). A bridge runs when `bridge.sock` answers `{"ping": true}` (with `{ok: true, pid}`; any answer from a bridge older than the ping counts) or takes the connection without answering within 2s; otherwise when the pid is alive and its start time (`ps -o lstart`, in UTC and the C locale) is the `pidStart` the bridge recorded, or, for a `status.json` without that field, its command line runs `bridge.mjs serve`. A start time or command line that can't be read still counts as running (never a second bridge), but `stop` never signals that pid. Anything else is stale: `serve` and `start` remove the stale `bridge.sock` (only while it is still the same file that refused, by the same identity) and `status.json` (only while it names that pid) and start a bridge; `stop` removes them and signals nothing; `forget` writes the file.
  - **Serving:**
    1. It binds an iroh `Endpoint` with the n0 preset, a persistent secret key and three ALPNs:
       `herdr-pocket/1` (session), `herdr-pocket/pair/1` (pair), `herdr-pocket/chat/1` (chat).
    2. It writes its ticket (`EndpointTicket.fromAddr(ep.addr())`) to `status.json`, and again whenever its address changes.
       It writes `public-status.json` (`bridge/presence.mjs`) when it starts, every 20 seconds, whenever a phone's session opens or closes, and with `running: false` when it stops.
    3. It accepts connections through `bridge/guard.mjs`: an unvalidated source address gets a QUIC retry before it takes a slot; then 10 seconds for the handshake, the first stream and its header line (and a whole pairing); at most 16 connections in that phase, 4 from one address (the IPv4 address, the IPv6 /64, or over a relay the key it claims, never the relay itself), and 64 in all, refused before the handshake past that; an unpaired key on `herdr-pocket/1` closed before anything is read. Pair requests check the code (`bridge/pairing.mjs`), and sessions are piped to `hc connect`.
    4. Lines a stranger can cause (refusals, timeouts, wrong codes) log at most 5 of each kind a minute. Each minute, a `bridge.log` over 1 MB is copied to `bridge.log.1` and emptied in place; the service's stderr appends, so it carries on at the start.
  - **Finding `hc`:** `command -v hc || command -v herdr-core` in a login shell, then `$HC`,
    `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
- **The state folder,** `${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link/` (`bridge/state.mjs`), mode 0700, outside the mod so a reinstall keeps it, files written atomically, all mode 0600 but one:
  - `secret.key`
  - `status.json`: the bridge's `pid`, `pidStart` (its start time, as `ps` prints it), `id`, `ticket`, `name` and `started` (when it last wrote the file). During a key change it carries `rotating: true` and omits the ticket.
  - `devices.json`, written by the running bridge or by `forget` and `reset` when they change the files directly. Each change is flushed to disk (`fsync`) before the rename and the folder after it, so a crash leaves the old list or the new one.
  - `bridge.sock`, the running bridge's socket, where `forget` hands it a removal. The bridge removes it on exit only while it is still its own (same device, inode, change and birth time: Linux reuses a freed inode number), never a later bridge's. Neither end uses a path that does not fit a socket address (`fits` in `bridge/devices.mjs`): 104 bytes or fewer on macOS, measured (105 fails on Node 24, and Node 22 binds it cut short, outside this folder), and 107 or fewer on Linux, a safe bound from the 108-byte `sun_path` less its NUL, not measured. With a longer one the bridge serves without the socket and logs `serve: no control socket`
  - `pairing.json`
  - `bridge.log`, and `bridge.log.1` once it has filled
  - `public-status.json`, mode 0644: whether the bridge runs and which phones are connected, for other mods ([README](README.md#for-other-mods)). No ticket, id or secret. The dialog's folder watch skips it.
  - Another `HERDR_APP_HOME` gets `automagik-pocket-link-<hash>/`; `POCKET_LINK_STATE_DIR` overrides both, and the login service is given the resolved folder that way (launchd and systemd don't see the dialog's environment).
  - **Moving from `mods/pocket-link/.state/`:** when the new folder has no `secret.key`, the bridge moves each old file with `link()` and `unlink()` (atomic, never over an existing file, the mode kept), then logs one line. While an older bridge still runs from `.state/` (its `status.json` pid is alive), it uses `.state/` for that run instead and moves nothing.
- **The phone side:** [Automagik Pocket](../../../apps/pocket/README.md), with
  `computer.iroh:iroh-android:1.2.0`. Only a `herdr-pocket://pair` link opened from outside Pocket
  asks for confirmation and shows the fingerprint. An in-app scan or paste pairs and connects.
  Pocket keeps its own key in no-backup storage.
- **What it touches on the computer:**
  - **Network:** iroh's n0 preset. It keeps a connection to n0's public relays and publishes the bridge's public key and the n0 relay it currently uses to n0's address lookup, so phones find it after an IP change. iroh's publisher sends no IP addresses by default (`AddrFilter::relay_only`); the phone's iroh publishes the same way. Phones connect in over QUIC/UDP.
  - **Programs:** `node`, `npm` (setup only), `hc connect`, `launchctl` or `systemctl --user`, `ls` (to list Node versions), `sh` (to find `hc` and run setup) and the user's login shell (to find `node`).
  - **Files outside the folder:** the state folder above, and the login service file, `~/Library/LaunchAgents/dev.herdr.pocket-link.plist` or `~/.config/systemd/user/herdr-pocket-link.service`.

## Watch out

- **Don't draw the QR from a file.** `image()` wouldn't show one from the old hidden `.state/` folder, and a QR file inside the mod folder would reload the mod on every code. Drawing it from its modules avoids that, and also avoids image caching when a new code is made.
- **Keep state out of the mod folder.** Reinstalling a mod is `rm -rf` and a copy; a `.state/` inside it took the computer's key and every pairing with it.
- **`exec` stops a program after 30s**, so `serve` can't run under it. The bridge has to run as a login service or detached (`start`), and npm setup also has to run detached.
- **`launchctl bootstrap` right after `bootout` fails** with "Input/output error" while launchd is still unloading the old job. Retry it for a few seconds.
- **Herdr's PATH isn't the terminal's:** opened from the Dock, Herdr has no nvm, volta, fnm or asdf on PATH, so `exec("node", …)` fails where the terminal works. Find Node yourself (above), and give npm the same folder.
- **The Homebrew Cellar path breaks:** `process.execPath` under Homebrew is a versioned Cellar path that disappears on upgrade. Write the `opt/<formula>/bin/node` link into the service.
- **Log lines appear twice:** under launchd, stderr already is `bridge.log`. Append to the file yourself only when stderr is a terminal.
- **A removed phone would come back with two writers:** a session's "seen" update reads `devices.json` and writes it back, so a separate `forget` process writing between the two is overwritten. Keep one writer: `forget` asks the running bridge over `bridge.sock`, and the bridge's reads and writes of the file are synchronous, so they never interleave. `forget` writes the file only when no bridge runs, or one runs without a socket (an older one that a mod update left running, or a state folder too long for one: `bridge.sock`'s full path over 104 bytes on macOS or over 107 on Linux; there a "seen" update racing the write can still bring the phone back); a socket that is there but refuses means a busy bridge, so it tries again and then fails rather than write. A pid a crash left to another process is no bridge (`bridgeState`), so its refusing socket is not mistaken for a busy one. After its own write it asks the socket once more for a bridge that started meanwhile. `bridge/devices.test.mjs` holds a "seen" update open while `forget` runs as its own process. With no bridge to ask, `forget` and `reset` take `devices.lock` (an exclusive file in the state folder; a dead owner's or one older than 30s is replaced) around their own write, so two commands never overwrite each other's change. `reset` writes the new key under the same lock, and the running bridge checks every 2s that it serves the key on disk.
- **The pairing link is a capability:** anyone holding the link (or the QR) within its 10 minutes can pair, because the code is the secret. Don't screenshot a live one. This preview's QR encodes a made-up link.
- **The phone's code must match:**
  - The phone accepts only `v=1`, `t` matching `^endpoint[a-z2-7]{20,2000}$` and `c` matching `^[A-Za-z0-9_-]{16,64}$`.
  - Names are cut to 60 characters with control characters removed.
- **Requirements:**
  - Node 20.3+, in one of the places above.
  - herdr-core's `hc` installed.
  - macOS or Linux with systemd; Windows isn't handled.
- **Phones see every herdr-core session**, the same way a terminal running `hc` does. Pair only your own phones.

## Done when

- `herdr-app check mods/pocket-link` passes, and `mod.open pocket-link` (or ⌘⌥P) opens the dialog, which shows "Off" or "On · <host>".
- **Turn on:** `node bridge/bridge.mjs status` reports `"running":true,"login":true`, and on macOS `launchctl print gui/$(id -u)/dev.herdr.pocket-link` shows `state = running`.
- **Pair a phone:**
  - A QR appears and decodes, with any QR reader, to the same link `bridge.mjs pair` printed.
  - Its `c=` equals the code in `pairing.json` in the state folder.
  - The countdown falls each second.
- **Copy link:** the countdown reads 2:00 or less, `expires` in `pairing.json` is now about 2 minutes away (the code is unchanged), and the clipboard holds the link. The code still pairs within those 2 minutes; at 0:00 a new QR appears, and the copied link is refused with "That code is not the one on the desktop."
- **Pairing with Herdr Pocket:**
  - Scanning or pasting in Pocket pairs, connects and lists the agents.
  - A link opened from outside Pocket asks to pair with a new computer or to pair a known one
    again. Tap **Pair** to save it, then **Connect** to open a session.
  - The dialog shows a "Phone paired" toast and lists the phone.
  - The dialog's "Computer key fingerprint" equals the digits Pocket shows.
  - `bridge.log` reads `pair: added …`, then `session: …` when Pocket connects.
- **Reusing a code** is refused with "This pairing code was already used or has expired…", and a wrong code with "That code is not the one on the desktop."
- **Remove:** the phone's open session ends within about 2s, and `bridge.log` reads "session: ended for a removed phone". Its next connection is refused with "not paired".
- **Reset key:** confirm **Reset key…** with Pocket Link on or off. The paired-phone list empties
  and the old code expires. A running bridge stays on with a new id and the old address stops
  answering. The fingerprint line shows new digits, at the next **Turn on** if it was off.
  Pair again with a new code, then remove the old desktop card on the phone.
- **Turn off** removes the service file, stops the bridge, and the dialog shows "Off".
