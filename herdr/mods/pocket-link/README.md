# Pocket Link for Herdr

Pair your phone with Herdr desktop like a TV pairs with a streaming account:
press **Pair a phone**, scan the code with [Automagik Pocket](../../../apps/pocket/README.md),
done. Your agents on your phone from anywhere, with no SSH, no password and no port to open.

![Pocket Link](preview.png)

## Install

Ask your Herdr agent to add this mod, or do it yourself:

1. Copy `mods/pocket-link/` into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into `~/.config/herdr-app/keys.json` (⌘⌥P on macOS, Ctrl+Alt+P on Linux).
3. Open it with ⌘⌥P. The first time, press **Install the bridge** (npm, about 25 MB), then **Turn on**.

It needs Node.js 20.3+ and herdr-core (`hc`), on macOS or Linux (systemd). Herdr opened from the
Dock doesn't see a Node that only your shell's rc file adds to PATH. So the dialog also asks your
login shell, which finds a Node set up in `.zprofile` or `.bash_profile` but not one that
`.zshrc` or `.bashrc` adds (where nvm usually puts itself), then looks in nvm's, volta's, fnm's,
asdf's and Homebrew's folders ([RECIPE.md](RECIPE.md#how-it-behaves)).

## Update

No release ships the mod and nothing updates an installed copy. To update it:

1. Press **Turn off** in the dialog. The bridge loads its packages even to stop, so do this before
   anything changes.
2. Copy the new `mods/pocket-link/` over the old one from a fresh clone:

   ```sh
   d=$(mktemp -d) && m=~/.config/herdr-app/mods/pocket-link && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/automagik-dev/automagik "$d" && git -C "$d" sparse-checkout set herdr/mods/pocket-link && { cmp -s "$d/herdr/mods/pocket-link/bridge/package-lock.json" "$m/bridge/package-lock.json" || rm -rf "$m/bridge/node_modules"; } && rsync -a "$d/herdr/mods/pocket-link/" "$m/"
   ```

   It compares the bridge's `package-lock.json` before copying. If the packages changed, it
   deletes `bridge/node_modules`; otherwise `rsync` (without `--delete`) keeps them.
3. Open the dialog. If it shows **Install the bridge**, press it.
4. Press **Turn on**.

Pairings live outside the mod folder and stay.

The phone's chat view (RFC 0015) needs a Pocket Link with the chat route (`herdr-pocket/chat/1`,
the `chat/` folder and `bridge/chat.mjs`). An older one refuses that route, and the phone says
"Update Pocket Link on this computer for chat" and shows the terminal view as before. Nothing
updates Pocket Link by itself, so updating it as above is what turns the chat on.

## What it does on your computer

- Runs a small bridge (`mods/pocket-link/bridge/bridge.mjs`) as a login service:
  a LaunchAgent on macOS, or a systemd user unit on Linux.
- **Network:** [iroh](https://iroh.computer). Phones dial this computer by its public key.
  Connections are direct when they can be, otherwise through n0's public relays,
  and always end to end encrypted. The bridge and the phone each publish their public key and the
  n0 relay they currently use (no IP addresses) to n0's address lookup, so phones find this
  computer after an IP change.
- **Programs it runs:** `node`, `npm` (setup), `hc connect`, `launchctl` / `systemctl --user`, `sh`,
  `ls`, and your login shell, once, to find `node`.
- **Files it writes:** its state folder (below), the one login service file, and `.node` in the
  mod folder (the path of the Node it runs with).
- **Where its state lives:** `${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link/`, mode 0700,
  outside the mod folder: this computer's key (`secret.key`, the identity phones pair with), the
  paired phones (`devices.json`), the current pairing code, the bridge's address and its log (`bridge.log`, and
  `bridge.log.1` once it has filled), each 0600; and `public-status.json` (0644), which says only whether phones are connected
  ([For other mods](#for-other-mods)).
  - **Reinstalling the mod is safe.** Deleting `mods/pocket-link/` and copying it again keeps every
    pairing; only **Install the bridge** (npm) needs pressing again.
  - Older versions kept it in `mods/pocket-link/.state/`. The first time the new bridge runs, it
    moves those files over and leaves `.state/` empty.
  - A Herdr started with another `HERDR_APP_HOME` gets its own folder,
    `automagik-pocket-link-<hash>/`, so a test window never sees your phones.
    `POCKET_LINK_STATE_DIR` sets the folder outright; the login service is given it.
  - Deleting this folder unpairs every phone.
  - **Reset key…** in Pocket Link changes this computer's key, unpairs every phone and
    ends any pairing code. Each phone shows the old desktop as unreachable or not paired.
    Pair again with a new code, then remove the old desktop card on the phone.
  - **One writer for the paired phones.** Only the running bridge writes `devices.json`. Remove
    (`bridge.mjs forget <id>`) hands the phone to it over `bridge.sock`, a socket in this folder,
    and waits for its answer, so a removed phone can't be written back by a session updating its
    "last seen" time. With no bridge running, `forget` writes the file itself. So it does when
    this folder's path is too long for a socket: `bridge.sock`'s full path must be 104 bytes or
    fewer on macOS (measured) and 107 or fewer on Linux (a safe bound, not measured), or the bridge
    runs without `bridge.sock`.

- **Before a phone is paired** (`bridge/guard.mjs`, `bridge/pairing.mjs`):
  - A connection from a source address that isn't validated yet gets a QUIC retry first, so a
    spoofed address never takes a slot.
  - A connection gets 10 seconds for its handshake and first line, and a pairing all of it, then
    it is closed. At most 16 connections can be in that phase, 4 of them from one address (an IPv4
    address, an IPv6 /64, or over a relay the key it claims), and 64 open in all; past that, new
    ones are refused before their handshake.
  - A key that isn't paired is closed before the bridge reads anything from it, and so is a
    pairing attempt while no code is live.
  - One phone key gets 3 wrong codes, then its tries are refused without counting. Only a flood
    (1000 wrong codes in all) ends a code: new keys are free, so a low total would let one stranger
    end each new code. Codes are 128-bit, so guessing isn't the worry.
  - Closing the dialog ends its code (`bridge.mjs cancel`). Each paired phone shows its key's
    fingerprint, the first 12 hex characters in fours, next to the name the phone sent.
  - Refusals, timeouts and wrong codes log at most 5 lines of each kind a minute. `bridge.log`
    stays under 1 MB: past that it is copied to `bridge.log.1` and emptied.
  - **What's left (accepted):** someone who knows this computer's key can still fill the 16
    pending slots, by flooding through a relay with a new key per connection or by stalling
    handshakes. While that lasts, a paired phone's *new* sessions are refused. Sessions already
    open keep working, and nothing gets paired. The remedy is a new desktop key, so the old address
    leads nowhere: [#48](https://github.com/automagik-dev/automagik-pocket/issues/48).
- **No usage meter.** Older versions installed and ran
  [usagemeter](https://github.com/automagik-dev/usagemeter) on every connected machine. The
  Automagik Herdr pack installs it now; the phone only reads its summary
  ([decision](../../../apps/pocket/docs/decisions/pocket-link-no-meter-installer.md)).

A paired phone can use every herdr-core session on this computer, just like a terminal running `hc`.
Pair only your own phones. Remove one in the dialog and its new connections are refused; the
bridge checks its list every second and then closes that phone's open sessions. Agents it
started keep running on the computer.

## The chat route

`herdr-pocket/chat/1` (RFC 0015 delivery 4) serves a terminal agent's conversation as chat rows. It
is admitted like the terminal session: only paired keys, closed before anything is read
otherwise, and a removed phone's chats end within 2 seconds. Its header line is the session's
(`{"session": "<hc session>"}`); each hc session gets its own engine (at most 8).

- **Hello.** The phone sends `hello` with `generation: 1, framed: true`, as to herdr-core. The
  answer adds `chat: 1`, `credit` (the window each subscription starts with, 256 KiB; read it
  from here) and `limits`. Then frames, as herdr-core's: a 9-byte little-endian header (channel
  u32, kind u8, length u32), kinds DATA 0, CREDIT 1, CLOSE 2.
  A phone may add `groups: 1`. The answer includes `groups: true` only when the Bot plugin's
  socket offered groups. The grant belongs to that chat connection, socket and team home.
- **Requests** (JSON-RPC on channel 0): `chat.list`; `chat.subscribe {terminal, after?}` →
  `{channel}`; `chat.backfill {terminal, before, limit}` (≤ 200 rows, ≤ 1 MiB); `chat.send
  {terminal, text, id}` (≤ 32 KiB; answers `sent`, `queued`, `held` or `refused`);
  `chat.sendHeld` and `chat.cancelHeld {terminal, id}`; `chat.answer {terminal, row, choice,
  text?}` (an approval's `allow`/`deny`; a question's option digit, digits joined by `,` on a
  multi-select, or `other` with `text`; `chat/question.js`);
  `chat.interrupt {terminal}`. Every chat write needs a subscription to that terminal on the
  same connection.
- **Management.** The methods are `memory.read {terminal}`, `memory.edit {terminal, id, rev, text}`,
  `memory.add {terminal, text}`, `schedule.list {terminal, id?}`, `schedule.pause {terminal, id, rev}`,
  `schedule.resume {terminal, id, rev}`, `schedule.rename {terminal, id, rev, title}`,
  `settings.read {terminal}`, `settings.name {terminal, rev, name}` and `settings.model {terminal, rev, model}`. They can
  run with the Bot's chat closed. The bridge limits the `dsh:<botId>` terminal to 128 characters.
  The 16-request transport limit applies first and returns a JSON-RPC `busy` error. Management
  refusals then come in the result as `{ok:false, state:'refused', reason}` and start with
  `read-only` for missing authority, then `invalid` for bad fields, `busy` for another management call
  for this phone and terminal, and `rate` after 60 reads or 20 writes per minute per phone.
  Memory, schedules and settings share the same slot across connections and the same read and write limits.
  Bot chat writes also count toward the write limit. The host's reasons follow these bridge checks.
  The host keeps prompts, targets and other Bots' titles out of schedule replies.
  Before taking a slot for settings, the bridge checks that `rev` is 16 lowercase hex digits,
  `name` is a string of at most 4096 UTF-8 bytes, and `model` is a string of 3 to 512 UTF-8 bytes
  without ASCII control characters, with its first `/` neither first nor last. The host controls
  level, effort, role and every other Bot field. A settings read waits up to 5 s for the host and
  a settings write waits up to 25 s. The host sizes each settings reply to fit its 1 MiB socket line.
- **Recovery.** A lost management read reply is `offline`. A lost write reply is `unknown` with
  reason `offline` once sent. A phone that asks for memory edit or add should also ask for read to
  reconcile an unknown outcome. After a lost or `unknown` schedule write, the phone must avoid
  automatic resends and reconcile with `schedule.list {terminal, id}` on the original team and
  terminal. The outcome stays unknown on `busy`, `rate`, `unavailable`, `offline` or `unknown`.
  Only a successful `read` carrying that id allows a fresh user action. A phone that negotiated
  writes without `schedule.list` needs a fresh hello on a new chat connection to ask for it. The
  phone cannot see the team, so if a bridge reconnect between the lost write and the read could
  have failed over to another team, the outcome stays unknown.
  A phone gets either settings write only with `settings.read`. For a lost settings write or an
  `unknown` result without settings, the phone calls `settings.read {terminal}` once. It uses the
  settings from a reply that carries them and only sends another write on a fresh user action.
- **Events** (JSON lines on the subscription's channel, sent while the phone has credit; it
  grants more with CREDIT): first a `snapshot` (rows, screen, status, approval, question, held;
  `reset` when the cursor in `after` is no longer held), then `rows`, `screen`, `status`, `approval`,
  `question`, `held`, `sent`, `sending`, `matched`, `source`, `gone` and `offline`. A row's text
  is cut at 64 KiB (`cut: true`). A subscriber that stops granting credit gets CLOSE `slow` and
  resubscribes with its cursor. A CLOSE from the phone ends the subscription.
  A group's `gone` goes out without waiting for credit and drops undelivered events on that channel.
- Rows are kept in memory only, the last 500 per terminal, while a phone watches and 10 minutes
  after; a restarted bridge numbers them again, so a phone's cursor gets `reset`. Row text is
  never logged. A message held for a terminal goes with the phone that wrote it: once that
  phone stops watching (or is removed), it is dropped, never typed later.
- **What one phone can hold:** every frame from it is at most 256 KiB; 16 requests at once (more
  are answered `busy`); 4 MiB written and not yet taken (then the connection ends); credit never
  above the window (an event bigger than the window goes when credit is full); 8 subscriptions
  per connection; 2 hc sessions per phone at once; 16 terminals per session. Session names are
  hc's (letters, digits, `_`, `.`, `-`), never only dots.
- **Automagik Bots' chats (#517).** Beside the terminals, `chat.list` also lists the Automagik
  Bots' own chats, as `dsh:<botId>` with `chat: "session"`, read from the Bot plugin's
  socket in the team's home, `<team home>/pocket/chat.sock`. The bridge tries these
  team homes in order and uses the first whose socket passes the check below (a folder that
  exists is not enough): `$AUTOMAGIK_BOTS_HOME` when the bridge's own environment sets it, then
  the desktop app's team `~/.automagik/desktop/bots` (the app sets `AUTOMAGIK_BOTS_HOME` there
  for its own DSH only; the bridge's login service does not see it), then
  `~/.automagik/bots` (a team in a dsh you run). `~/.automagik` is `$AUTOMAGIK_HOME` when set;
  `HERDR_APP_HOME` does not move the team home. It never searches elsewhere: a team kept
  anywhere else is not seen. The check: the socket and its folder are this account's alone (no
  group or other access), every folder above them belongs to this account or root and nobody
  else can write it (a sticky folder like `/tmp` is fine; on Linux a folder writable by your own
  primary group is fine too, as umask 002 makes it, so a shared primary group there is trusted;
  on macOS, where that group is the shared `staff`, it is not). The socket must answer
  read-only or advertise chat writes with `write: 1` for its chats to be listed. Rows come
  from the Bot's DSH Session log (a cursor is `dsh:<session>:<seq>`). A writable socket
  can take `chat.send`, `chat.answer` and `chat.interrupt` on a subscribed chat. A read-only
  socket refuses these writes. Its approval and question rows say "Answer on the computer".
  For memory, schedules and settings, the phone includes the methods it wants in one `manage` list in its
  chat hello. The bridge returns the methods the phone requested that the bridge and host support
  after opening one grant for that connection. A bridge failover to another team home requires a
  fresh hello on a new chat connection. The bridge reads the host's offer once per socket because
  another hello on the shared socket would revoke every grant. Schedule writes that become available
  appear in the offer after the next socket connection. If the host withdraws writes, it answers
  already-negotiated writes with `unavailable` while list still works. Management replies are sent
  only while the connection is live. Forget closes each grant. The control socket starts that close
  at once, and file-based forget is checked every second. The bridge drops the DSH socket if a grant
  close has no ack within 500 ms. Revocation ends host authority within 2 seconds while the bridge's
  timers run on schedule.
- **Group chats (RFC 0040).** `chat.list` includes `dsh:room:<roomId>` rows (`chat: "group"`)
  only for a connection with a group grant. Without one, a subscribe returns `not_found` and
  writes return `not-watching`. The prefix is reserved and negotiated management methods return
  `invalid` for those terminals. Group watches are text-only. Attachment methods, thumbnail
  reads and sends with `uploads` return `unsupported`. The bridge passes `retry: true` on
  `chat.send` through to the host, which may answer `unknown`. A group watch tracks each open
  approval by id and uses the same per-phone limits as Bot chats. On `gone`, the bridge drops
  pending replies for the watch. A socket reconnect, a host that stops offering groups or a team
  change ends group watches with `gone`. The phone needs a fresh chat connection and hello to
  see groups again.

## For other mods

Another mod (a sidebar dot, say) can tell whether a phone is connected from `public-status.json`
in the state folder. It is **read-only for other mods**: only the bridge writes it, and no other
file in the folder is part of this contract.

**Where it is.** The first that applies, as `bridge/state.mjs` (`stateDir`) resolves it:

1. `$POCKET_LINK_STATE_DIR`, when set to an absolute path.
2. `${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link-<hash>/`, when `HERDR_APP_HOME` is set
   to an absolute path other than `~/.config/herdr-app`. `<hash>` is the first 8 hex characters of
   the SHA-256 of the resolved `HERDR_APP_HOME` path.
3. `${XDG_STATE_HOME:-~/.local/state}/automagik-pocket-link/`.

A relative `XDG_STATE_HOME` or `HERDR_APP_HOME` is ignored. The folder is 0700, so only your own
user can read the file.

**What it holds** (schema 1):

```json
{
  "schema": 1,
  "running": true,
  "updated": 1793520000000,
  "phones_connected": 1,
  "phones": [{ "name": "Pixel 9", "since": 1793519400000 }]
}
```

- `schema`: 1. A new field can be added within schema 1, so ignore fields you don't know. Removing
  or renaming a field, or changing its type or meaning, takes a new number: treat any value but 1
  as unknown.
- `running`: the bridge is serving. A clean stop (**Turn off**, `bridge.mjs stop`, logout) writes
  `false`, with no phones.
- `updated`: when it was written, in epoch milliseconds. While it runs, the bridge rewrites it at
  least every 30 seconds (every 20 today) and whenever a phone connects or hangs up.
- `phones_connected`: how many phones have a session open now. A phone with several sessions open
  counts once.
- `phones`: one entry per connected phone, oldest first: `name`, the device name the phone sent
  when it paired, and `since`, when its oldest open session began (epoch ms).

**Staleness.** If `updated` is more than 90 seconds old, the bridge stopped without saying so
(killed, or the computer slept): treat it as `running: false` with no phones. Treat a missing or
unreadable file, or another `schema`, the same way.

It never holds the pairing ticket, this computer's endpoint id, a phone's key or any secret. Those
stay in `status.json` and the other 0600 files, which other mods must not read.

See [RECIPE.md](RECIPE.md) for how it's built.

## License

Apache-2.0
