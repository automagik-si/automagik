# The Linux image and its guest launcher

RFC 0016 (`docs/rfcs/0016-windows-wslc.md`) delivery 2. On Windows, everything but the Electron
window and herdr-app runs in Linux inside a WSL container. This folder holds that Linux side:

- `Dockerfile`: the image (Debian 13 slim, Node 24, the desktop's DSH runtime and profile, the
  tools, `hc`, and the launcher). Built in CI only (`.github/workflows/linux-image.yml`); not
  published (see "Deferred").
- `bin/dsh-launch.mjs`: the launcher, `/opt/automagik/bin/dsh-launch` in the image.
- `bin/xdg-open.mjs`: `xdg-open` and `$BROWSER` in the image.
- `lib/`: the framing, the CDP tunnel, `open`, the lane's handoff, seeds, and the launcher itself.
- `smoke/`: the CI smoke (`smoke.mjs`), the Electron side it plays (`driver.mjs`), a fake DSH
  (`fake-dsh.mjs`) mounted into the container for it, and the masker that keeps the launch token
  out of the public log (`redact.mjs`), in the forwarded stderr and in the driver's timeout
  reports. The fake is never built into the image.
- `test/`: the launcher's tests, plain Node: `node --test 'test/*.test.mjs'` from this folder.
  They run in the Linux job, not in the desktop's Windows matrix (Unix sockets, signals).

The launcher imports the desktop's own modules (`../src/dsh.js`, `../src/lane.js`), and the
image keeps the same layout (`/opt/automagik/desktop/{src,wslc}`), so DSH starts in the guest
exactly as `startDsh` starts it on macOS and Linux, and the lane's unpack is `lane.js`'s own.

## The image

| What | Where |
|---|---|
| Base | `node:24.22.2-trixie-slim`, pinned by digest (glibc 2.41) |
| Node | 24.22.2 (DSH needs 22.19 or later) |
| pnpm | the runtime's pinned pnpm 10 (`/usr/local/bin/pnpm` runs `runtime/node_modules/pnpm`) |
| Debian packages | bash, bubblewrap, ca-certificates, coreutils, curl, git, openssh-client, procps, ripgrep, tini |
| `hc` | herdr-core 0.1.18 for Linux x86_64, checked against its sha256, at `/usr/local/bin/{herdr-core,hc}` |
| DSH runtime | `/opt/automagik/runtime` (`build/runtime` from `scripts/prepare-runtime.mjs`) |
| Profile | `/opt/automagik/profile` (`build/profile`), copied into the volume at the first start |
| Launcher | `/opt/automagik/bin/dsh-launch`, `/opt/automagik/bin/xdg-open` |
| Guest user | `automagik`, uid and gid 1000, home `/home/automagik` (the volume) |
| DSH | `127.0.0.1:41700` in the container |
| Exchange | `/mnt/automagik-exchange/{downloads,lane}` (the one Windows folder, mounted) |
| Entry | `tini -- sleep infinity`: the container idles; the app runs `dsh-launch` in it |

`/opt/automagik` is read-only code; a new image never touches `/home/automagik`. The volume holds
`~/.automagik/desktop` as the desktop lays it out (`dsh/`, `bots/`, `bin/`, `logs/`, `lane/`).

## The framed protocol (version 1)

`dsh-launch` speaks for DSH over its stdin and stdout. Nothing but frames is ever written to its
stdout; its stderr carries its own log lines and DSH's output.

**Framing.** One frame is one JSON object on one line, ended by `\n` (a `\r` before it is
dropped). Frames the launcher writes are pure ASCII: anything past U+007F is a `\u` escape, so a
channel that is not byte-clean still carries them. A reader takes raw UTF-8 too. Blank lines are
skipped. A newline ends every frame, so no reader can lose its place.

**Version.** Every frame carries `v`, the protocol's major version, an integer: `1`. Within a major
version, additions are new optional fields and new types; a receiver ignores fields and types it
does not know (the launcher logs an unknown type and goes on). A frame of another major version is
refused (Electron refuses a launcher whose frames are not `v: 1`; the launcher stops on one, below).

**Bounds.**

| Bound | Value |
|---|---|
| A frame, its `\n` included | at most 1 MiB (1,048,576 bytes) |
| Tunnel `data` per frame | at most 48 KiB raw (65,536 base64 characters) |
| Open tunnels | at most 64 at once; a 65th connection is refused |
| Bytes Electron may send ahead of a guest socket that does not read | 8 MiB, then that tunnel closes |
| An `open` URL | at most 8 KiB; at most 10 opens a minute |
| The lane handoff | `handoff.json` at most 256 KiB; each tarball at most 64 MiB |

**From the launcher (stdout).**

| Frame | When, and its fields |
|---|---|
| `log` | `{ level: 'info' \| 'warn' \| 'error', text }`: the launcher's own notices (also on stderr and in `logs/dsh.log`) |
| `lane` (state) | Once per start, before `ready`: `{ state: 'applied' \| 'restored' \| 'trial' \| 'none', version?, staged: ['<publisher>@<version>'], skipped: [...], error? }` (below) |
| `lane` (verdict) | The answer to Electron's verdict: `{ trial: 'passed' \| 'failed', recorded }` |
| `ready` | Once DSH prints its launch line: `{ url, port }`; `url` is the in-guest `http://127.0.0.1:41700/…token=…` (Electron swaps in its host port and keeps the token) |
| `ipc` | `{ message }`: one message DSH sent with `process.send` |
| `tunnel` | `{ op: 'open', id, host: '127.0.0.1', port }`: a guest connection to carry to Windows' `host:port`; `{ op: 'data', id, data }` (base64); `{ op: 'end', id }` (the guest half-closed); `{ op: 'close', id, error? }` |
| `open` | `{ url, callbackPort? }`: open this https: URL in the default browser; `callbackPort` when its `redirect_uri` names the guest's loopback |

**To the launcher (stdin).**

| Frame | Fields, and what it does |
|---|---|
| `ipc` | `{ message }`: sent to DSH with `child.send`. A `ds-bot:browser-endpoint-response` with a `url` naming a loopback port first has that URL moved onto the CDP tunnel (below) |
| `tunnel` | `{ op: 'data', id, data }`, `{ op: 'end', id }`, `{ op: 'close', id, error? }`: Electron's side of tunnel `id`. Data or end for a tunnel the launcher no longer has is answered with `close` |
| `lane` | `{ trial: 'passed' \| 'failed' }`: Electron's verdict on this start's lane trial |

Electron opens no tunnel in version 1: only the guest does.

**Failures.** A line that is not a frame, a frame past 1 MiB, a frame of another major version or
a stream that ends inside a frame stops the launcher with exit code 2, as a stop (below): it
cannot trust its input any more. A frame it cannot send (past 1 MiB, such as a huge IPC message)
is dropped and logged; the rest goes on. A tunnel frame that is wrong for its tunnel (bad base64,
too long, an unknown op) closes that tunnel with an `error`. An `ipc` frame while DSH is not
running is dropped and logged.

**Exit codes.** 0: stopped as asked (stdin's end, SIGTERM, SIGINT, SIGHUP). 1: DSH did not start
(no launch line within 120 s, or it exited first) or stopped on its own. 2: stdin carried
something that is no frame. 3: the volume or the profile could not be set up.

## A start

1. Seeds (below), then the profile: `dsh.js` `installProfile` into `~/.automagik/desktop/dsh`
   and `pinProfileStore`, as the desktop does.
2. The lane step (below), and its `lane` frame.
3. The tools (`writeTools`, on the image's Node), the privacy overlay (`writeOverlay`, and a new
   anonymous id unless the person chose to keep one), and the `open` socket.
4. DSH, with `dsh.js` `startDsh`: the same arguments (`--profile omni --patch … --no-open --host
   127.0.0.1 --port 41700`), the same environment (`dshEnv`, with `/opt/automagik/bin` first on
   PATH, `BROWSER` the shim and `AUTOMAGIK_OPEN_SOCKET` its socket), stdio `['ignore', 'pipe',
   'pipe', 'ipc']`. Its output goes to `~/.automagik/desktop/logs/dsh.log` and to stderr.
5. `ready`.

DSH's own IPC messages are relayed from its spawn on, before `ready` too, as `main.js` answers
them from the spawn.

## Stop on stdin's end

When stdin ends or closes (Electron died, so the helper did, so the pipe closed: RFC 0016,
"Parent death"), the launcher stops: DSH gets SIGTERM, then SIGKILL if it is still there 3 s
later, and the launcher exits 0 once DSH is gone, or at 4.5 s whatever happens. A stop during the
setup lets the step in hand finish (none leaves a half-made profile: `installProfile` moves a
finished copy in, and the lane step records nothing until it is done) and starts no DSH. SIGTERM,
SIGINT and SIGHUP to the launcher, and its stdout breaking, stop it the same way.

## The CDP tunnel

The Bot team asks for a Bot's browser over IPC (`ds-bot:browser-endpoint`, from bots-dsh
`appBrowserEndpoint`), and Electron answers with its relay's URL,
`ws://127.0.0.1:<relay port>/devtools/browser/<token>`, which names Windows' loopback. The launcher
rewrites that answer's `url` before DSH sees it: for each loopback port it is given, it listens on
the container's `127.0.0.1` (a port of its own, reused for that relay port) and hands DSH the same
URL on that port. Each connection there becomes a tunnel: an `open` frame naming the relay's port,
then the bytes both ways as `data`. Electron (delivery 3) connects to the relay from Windows'
`127.0.0.1` for each `open`, so the relay's checks (a loopback peer, no Origin, the Bot's 64-hex
token) hold unchanged; the launcher never reads the token. Backpressure: when stdout's buffer is
full the guest socket pauses until it drains; Electron's side is bounded by the 8 MiB rule above.
If no listener can be made, DSH gets `{ error: 'The app browser relay is unavailable.' }`, which
the Bot team already handles. `downloadRoots` pass through unchanged (see "Deferred").

## Links out

`xdg-open` and `$BROWSER` are `bin/xdg-open.mjs`. It sends `{"url": "…"}` on one line to the
launcher's Unix socket (`$AUTOMAGIK_OPEN_SOCKET`, else `~/.automagik/desktop/run/open.sock`, in a
folder the launcher makes private to the guest user) and gets `{"ok": true}` or `{"ok": false, "error"}` back.
The launcher decides: only an `https:` URL with a host and no user name or password, at most 8 KiB,
at most 10 a minute. A URL that passes goes to Electron as an `open` frame, which opens it with
`shell.openExternal`. The shim's exit codes are xdg-open's: 0 handed over, 1 not one argument, 3 no
launcher, 4 refused.

## The lane handoff

Electron keeps all of the lane on Windows: `lane.js` checks the signed pointer against the keys
the app was built with, each tarball's sha256, sha512 integrity and size, the 3.N line,
`engines.dsh` and bad versions, and keeps its own `staged.json`, `applied.json` and `bad.json`.
The launcher verifies no signature: the trust root stays in the signed app.

When Electron has a verified update for the guest, it writes into the exchange folder's `lane/`
each tarball, and then, last and whole (written aside and renamed), `handoff.json`:

```json
{
  "v": 1,
  "lanes": { "automagik": { "version": "3.84.1", "sequence": 840001 } },
  "plugins": [{
    "publisher": "automagik", "name": "@automagik/welcome-dsh", "version": "3.84.1",
    "file": "automagik-welcome-dsh-3.84.1.tgz", "size": 123456,
    "sha256": "<hex>", "integrity": "sha512-<base64>"
  }]
}
```

A publisher must be one `lane.js` `PUBLISHERS` names, and each plugin one its lane may replace;
`file` is a bare `.tgz` name in `lane/`. At the next start, before DSH, the launcher:

1. removes `handoff.json` (a handoff is taken once; one that cannot be removed is not taken, and
   one that is not a valid handoff is removed and reported);
2. skips a lane version this guest already found bad;
3. stages each plugin with `lane.js` `stage()`, reading the exchange file instead of the network,
   so the same size, sha256, integrity and version-inside checks catch a copy damaged on the way;
   then removes the tarballs from `lane/`;
4. runs `lane.js` `beforeStart()` on the profile: the staged plugins go in, each replaced plugin
   stays beside it as `<folder>.lane-prev`, the profile's `package.json` and pnpm's records name
   the new tarball (`pinLanePackage`), and this start is a trial. Its record is
   `~/.automagik/desktop/lane/applied.json` in the volume.

The `lane` frame before `ready` says what happened: `applied` (a trial starts now), `trial` (the
second start of a trial that got no verdict), `restored` (a failed trial's previous plugins are
back, and that version is bad here), or `none`.

**The verdict.** Electron judges the trial as today (the page must draw the Bot team within
`TRIAL_MS`) and sends `{ "type": "lane", "trial": "passed" }` or `"failed"`. `passed` runs
`lane.js` `confirm()`: the `.lane-prev` folders go. `failed` runs `trialFailed()`: nothing changes
under the running DSH; the next start puts the previous plugins back, before DSH, as on the
desktop. Electron then stops the launcher (closes stdin) and starts it again, as it restarts DSH
today. A start after a trial that got no verdict at all (a crash) is its second chance, and the
one after that restores, as `beforeStart` does on the desktop. The launcher answers each verdict
with `{ type: 'lane', trial, recorded }`; `recorded: false` means no trial was pending.

## Seeds

`<image>/seeds/seeds.json` (`{ "v": 1, "seeds": [{ "path": "<relative to the home>" }] }`, each
tree under `<image>/seeds/tree/<path>`) lists copies the image may carry. At each start a seed goes
into the volume only where nothing is at its path, so what the person or the tool's updater has is
never replaced. This image lists none: see "Deferred".

## Deferred, and why

- **The Windows side (delivery 3).** `automagik-wslc.exe`, the container and its port mapping,
  Electron reading these frames (refusing another major version, swapping in the host port,
  connecting each tunnel to `bot-relay.js`, `shell.openExternal`, writing the handoff and sending
  the verdict).
- **The sign-in reverse tunnel.** RFC 0016 has Electron listen on Windows'
  `127.0.0.1:<callback port>` and carry each connection to the guest. The `open` frame reports
  `callbackPort` for it; the frames that would carry it (Electron-opened tunnels) are not in
  version 1, and need delivery 3 and the spike's sign-in check.
- **Download folders.** The relay's `downloadRoots` are Windows paths; the guest's are Linux paths.
  Translating them through `/mnt/automagik-exchange/downloads` needs the Windows side's path for
  the folder (delivery 3). The launcher passes them through unchanged.
- **Seeds of Claude Code, Codex and the ACP adapters.** Claude Code's supported installer fetches
  whatever is newest from Anthropic's servers, with no pinned artifact or checksum to build
  against, so the image would not be reproducible, and where its updater expects its files
  (`~/.local/share/claude`) inside this guest is the spike's sign-in check. Codex's npm package
  could be pinned, but it updates itself through a global npm prefix the read-only image does not
  give it; where it lives in the guest needs the same check. The ACP adapters are not pinned on
  purpose (RFC 0003): acp-dsh installs the newest at DSH's start, into the volume, so a seed would
  be a stale cache. The mechanism is here and tested; the image lists no seeds, and the smoke checks
  none.
- **`am`.** `am` updates itself in place from the signed am-lane, and `/opt/automagik` is
  read-only; where `am` and the pack's CLI half live in the guest is delivery 4's split install.
- **Publishing the image.** See the anchor comment in `.github/workflows/linux-image.yml`: the
  `docker save` tarball `automagik-linux-image-<v>.tar` and its `.sha256` go on a desktop release
  in delivery 6, once delivery 3's app pins the image's hash. Until then no app reads it.
- **arm64.** The image is x86_64 only, as WSLC's first target.
- **DSH's bind address.** DSH binds `127.0.0.1` in the container, as on the desktop. Whether WSLC's
  port mapping reaches a loopback bind is the spike's question; if it does not, the bind moves to
  the container's interface and the token stays the gate.
