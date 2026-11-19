# dsh-sandbox: the hc socket mask for dsh-tui panes

The DSH lane's part of #624 (tracked by #631), and the owner's answer to #700 and #743: a
`bwrap` runner wrapper that gives every sandboxed dsh-tui pane its **own network namespace**,
hides the herdr-core socket, the user's `~/.ssh` and the known container runtime sockets, and
binds the pane's filtering proxy at the exact real core socket path inside the sandbox. The
host's loopback, its LAN and its own addresses are not in the pane's namespace; egress to the
public internet goes through one explicit CONNECT relay on the namespace's own loopback. The
Herdr lane owns the hc proxy itself and the pack/shim integration; this folder owns the runner,
the profile row snippet and the install/check helper. #631, #700 and #743 are shared wishes, so
pull requests here say `Refs #631` and `Refs #700`/`Refs #743`, never `Fixes`.

The sandbox is **Linux/bwrap only**. macOS has no network namespace and no bwrap: the pack
never turns the switch on there, so a pane stays unsandboxed exactly as today. Setting the
switch on macOS (or Windows) is refused, never silently run on the host network. A macOS
network rule would be a Seatbelt rule for loopback TCP or a separate VM boundary, which is a
different design and out of scope here.

## Ownership

- **DSH lane** (this folder): the runner wrapper, the profile row snippet, the install/check
  helper, their tests and this contract.
- **Herdr lane**: the per-pane filtering proxy, the shim's pane environment and proxy lifecycle,
  the pack's copy of the wrapper and its call to the helper.
- #631 is the shared wish for both lanes, so pull requests here say `Refs #631`, never `Fixes`.

## Files

- `bin/hc-socket-mask.mjs`: the sandbox provider's `runnerCommand`. It inserts mount args
  before `--`, then execs `bwrap`. Mode 100755, Node ESM, no dependencies.
- `profile/sandbox-row.yml`: the profile row snippet, OFF by default. `{{WRAPPER}}` is a
  placeholder only the helper substitutes.
- `bin/dsh-sandbox.mjs`: `install` / `check` for the managed profile block. Node ESM, no
  dependencies.
- `test/wrapper.test.mjs`: hermetic runner tests (fake `bwrap`, temp Unix sockets, fake
  container list).
- `test/profile.test.mjs`: hermetic helper tests (temp profiles and temp wrappers only).

## Names (the contract with the Herdr lane)

- `DSH_SANDBOX_MASK=1`: the pack sets it at pane start. Exactly `1` turns the mask on; absent
  or anything else is today's behavior (the wrapper runs `bwrap` with exactly the arguments it
  received).
- `AM_HC_REAL_SOCKET`: the pane's real herdr-core socket, handed over by the dsh-tui shim.
  `HC_TERMINAL_SOCKET` is the fallback when it is absent.
- `AM_HC_PROXY_SOCKET`: the host-side per-pane proxy socket the Herdr lane starts; the wrapper
  binds it at `AM_HC_REAL_SOCKET` inside the sandbox and always hides its folder. It must be an
  absolute path: unset or relative is fatal (the wrapper cannot hide a folder it cannot name,
  and another pane's proxy could be impersonated).
- `--pack-root <dir>`: the wrapper's own leading word before the bwrap profile args, written by
  `dsh-sandbox install` into the row. It names the stable execution folder
  (`<data home>/automagik-herdr/dsh-sandbox`); the wrapper binds its parent
  (`<data home>/automagik-herdr`) read-only last, so the pack's `hcPane.mjs`, `bin/run.sh`,
  guard and the approved rosters under `approved/` cannot be rewritten from inside a writable
  workspace.
- `hc-socket-mask: `: the prefix of every wrapper line. It is the profile row's
  `runnerFailureSignatures` entry, so DSH reports a wrapper refusal as a runner failure.

The runner receives `[...runnerCommand, ...bwrapProfileArgs(policy), '--', ...command]` and
must leave the profile args, the separator and the command intact.

## What the mask does

With `DSH_SANDBOX_MASK=1` the wrapper first adds `--unshare-net` (unless the profile already
carries `--unshare-net` or `--unshare-all`), so the pane gets a fresh network namespace whose
`lo` is only its own. A profile that pairs either of those with `--share-net` is refused: bwrap
would re-enable the host network, and the wrapper never starts a pane on it. It then inserts
these mounts after the profile args and before the `--`, in this order:

1. `--tmpfs <dirname(AM_HC_REAL_SOCKET)>` - hides the core socket and the holder sockets beside
   it (and any other listener in the core's runtime folder).
2. `--tmpfs <dirname(dirname(AM_HC_PROXY_SOCKET))>` - hides the shared `automagik-hc-proxy`
   folder, so every other pane's proxy socket is unreachable. When the path is also a live Unix
   socket, the bind comes first: `--bind <proxy> <real>` (the proxy answers at the path the
   client already uses, so `HC_TERMINAL_SOCKET`, `core.lock` and the client's address check need
   no rewrite), then the shared folder's tmpfs; the bind resolves its source before that tmpfs.
   When the socket is missing or not a socket, the shared folder is still hidden (with no bind),
   and the pane starts with no core socket. An unset or relative path is fatal before `bwrap`:
   the wrapper cannot name the folder to hide, so another pane's proxy could be impersonated.
   The parent must be the `automagik-hc-proxy` folder; anything else is fatal. The hidden folder
   is the proxy's, never the attach ledger's: the CLI in the pane still reads `attach.jsonl`.
3. The egress slot, inside the core runtime folder the wrapper just hid:
   `--dir <realDir>/egress`, `--bind <host egress folder> <realDir>/egress` and
   `--bind <this wrapper> <realDir>/egress/relay.mjs`. The host folder is a 0700 temp folder
   holding one Unix socket; the wrapper serves the egress proxy on that socket. The command
   bwrap runs is the relay (this same wrapper file), which listens on `127.0.0.1:3128` inside
   the pane's namespace and execs the real command. No host path outside the wrapper's own
   temp folder is mounted for it.

4. `$HOME/.ssh` when it exists, following symlinks: a directory is shadowed with
   `--tmpfs <canonical path>`, anything else is bound over with
   `--bind /dev/null <canonical path>`. Absent, nothing is added (there is nothing to hide).
   `HOME` must be an absolute path.
5. For each existing container runtime socket, `--bind /dev/null <socket>`, canonicalized and
   deduplicated. The fixed list is:
   - `/var/run/docker.sock`
   - `/run/docker.sock`
   - `/run/containerd/containerd.sock`
   - `/run/podman/podman.sock`
   - `/run/user/<uid>/docker.sock` (rootless Docker, only when the platform has a uid)
   - `/run/user/<uid>/podman/podman.sock` (rootless Podman, only with a uid)

   Only paths that exist are masked; a test passes its own fake list, so no test looks at a live
   `docker.sock`.

6. When the row carries `--pack-root`, `--ro-bind <its parent> <its parent>`, after the
   profile args and the masks above, so it wins over a writable workspace bind. The pack's
   helper, runner and guard and the approved rosters live under that parent (the stable folder
   and `approved/`); without this a sandboxed bot inside the writable project could rewrite them
   and start a worker that runs the changed file outside the sandbox, or forge its next
   approval.

Everything else is the profile's own bwrap policy (`--ro-bind / /`, `--dev /dev`,
`--unshare-pid`, `--proc /proc`, `--die-with-parent`, the workspace binds). The wrapper adds no
port list: the network rule is the namespace itself plus the one loopback relay below, and the
pane's command gets the proxy environment so proxy-aware clients use it.

## Fail-closed rules

Before running `bwrap`, the wrapper refuses with one `hc-socket-mask: ` line and a nonzero exit
(no `bwrap`, so no pane) when:

- the real socket path (`AM_HC_REAL_SOCKET`, else `HC_TERMINAL_SOCKET`) is absent or not
  absolute;
- the real socket path has no folder of its own to hide (`dirname` is `/`);
- `AM_HC_PROXY_SOCKET` is unset or not absolute (the shared proxy folder cannot be hidden, so
  another pane's proxy could be impersonated);
- `HOME` is absent or not absolute (the runner will not guess where `~/.ssh` is);
- the runner arguments have no `--` separator (the command cannot be preserved);
- the profile carries `--share-net` together with `--unshare-all` or `--unshare-net`: bwrap
  would re-enable the host network, so the pane would not have its own namespace;
- `--pack-root` is relative, missing or not a folder, or is not
  `<data home>/automagik-herdr/dsh-sandbox` (the data parent could not be made read-only);
- the proxy parent is not the `automagik-hc-proxy` folder, or it is the real socket path or an
  ancestor of it (masking it would hide the real socket or a shared system folder);
- `AM_HC_PROXY_SOCKET` is absolute but its folder is the real socket path or one of its parents
  (masking that folder would hide the proxy again), whether or not a bind is added;
- the platform is not Linux (there is no network namespace to create);
- a `bwrap --unshare-net` probe cannot create a network namespace (missing privilege, an old
  kernel or a container that forbids it), or bwrap is missing;
- the 0700 egress folder cannot be made, or the host-side egress proxy cannot bind its socket.

All of these refuse the pane before any bwrap run: a sandboxed pane never falls back to the
host's network. When the egress relay cannot listen inside the namespace, or cannot reach the
host-side proxy, it answers 502 and the pane starts without egress; it never falls back to a
host route. A refused CONNECT (a host, loopback, link-local or private destination) gets 403.

When `AM_HC_PROXY_SOCKET` is absolute but missing or not a Unix socket, the wrapper prints one
`hc-socket-mask: ` line, hides the proxy's host folder along with the real folder, `~/.ssh` (if
present) and the container sockets, and runs `bwrap` with **no core socket**: the pane starts
and its `hc` calls fail closed. This is the "proxy not up yet" case and a non-socket path; it
never falls back to the real socket. **The pack must always set an absolute
`AM_HC_PROXY_SOCKET`**: an unset or relative one refuses the pane instead of starting it without
the folder mask.

With the switch off, nothing above applies: the wrapper runs `bwrap` with exactly the argv it
was handed, which is today's behavior.

## The network: own namespace, one loopback relay

The owner decision (19/11) covers #700 and #743 as one design: sandboxed panes get an **own
network namespace with filtered loopback** (option 1), not a port-by-port workaround. A port
list is the fragile half of the pair, so there is no list of admin ports anywhere in this
wrapper.

- **The namespace is the boundary.** `--unshare-net` gives the pane a fresh netns with its own
  `lo`. The host's `127.0.0.1` is a different interface in a different namespace, and the host's
  LAN and its interface addresses have no route in the pane's namespace. A service that listens
  on the host loopback (the hc core, DSH, a local proxy's admin API) is not reachable even
  though the pane's uid could open it on the host. A LAN address in the host's subnet fails with
  `ENETUNREACH`.
- **The explicit allowlist is the namespace's own loopback and one port.** The pane's own
  loopback (`127.0.0.0/8`, `::1`) is up inside the namespace, because pane-local tools expect
  it, and the only listener the wrapper deliberately puts there is the egress relay on
  `127.0.0.1:3128`. That one TCP port is the smallest allowlist that works: proxy-aware clients
  need a loopback TCP endpoint, and a Unix socket cannot be named in `HTTPS_PROXY`. Nothing
  else is added; there is no host loopback, no LAN route and no port list.
- **The filter is the host-side egress proxy.** The relay forwards every connection to a Unix
  socket in a 0700 host folder; the wrapper serves an HTTP CONNECT proxy there. The broker
  normalizes the requested host before any range check - lower-case, zone id dropped, the full
  IPv6 form expanded, an IPv4-mapped IPv6 address folded to its IPv4, and an IPv4 in inet_aton's
  decimal/octal/hex spellings read as that IPv4 - then resolves the name once, checks the
  normalized address with `net.BlockList` and connects to that same pinned literal: loopback,
  link-local, the RFC 1918/ULA/CGNAT ranges, multicast/reserved ranges, documentation ranges and
  every address this host itself owns are refused with 403. A name that later changes cannot
  turn into a LAN destination because the resolver is never consulted again, and anything
  unparseable (userinfo, brackets, an unparseable numeric spelling) fails closed. Only CONNECT
  is accepted; a plain HTTP absolute-URI request gets 405.
- **The pane gets a proxy environment.** The wrapper starts bwrap with `HTTPS_PROXY`,
  `HTTP_PROXY`, `ALL_PROXY` (and their lower-case forms) set to `http://127.0.0.1:3128`,
  `NO_PROXY=127.0.0.1,localhost,::1`, and `NODE_USE_ENV_PROXY=1`, so DSH's own proxy installer,
  git over HTTPS and Node's fetch use the relay. Raw TCP, SSH and anything that ignores the
  proxy environment have no egress: they are outside the design, not silently allowed. The
  host-side broker connects directly, so a host that itself needs an upstream egress proxy is
  not chained; that is a separate host setting, not something the pane can turn off.
- **The check is at launch.** The wrapper probes `bwrap --unshare-net` before it starts the
  pane. A host where that fails (no unprivileged user namespaces, a kernel without network
  namespaces, a restrictive container, bwrap missing) refuses the pane with one
  `hc-socket-mask: ` line; it never falls back to the host network. macOS has no network
  namespaces at all, and the sandbox switch is never on there (see the first section).
- **Limitation, stated plainly.** The namespace is created at launch. A privileged process that
  later adds an interface or a route to the pane's namespace, or moves a process into another
  namespace, is outside what this wrapper can see or stop; that is out of scope for this
  design. The wrapper does not watch the namespace after the pane starts.

## Rollout

Nothing here is installed on a live profile today. The order:

1. This PR lands the runner, the row snippet, the helper, the tests and the CI job. It installs
   nothing and changes no live profile.
2. The Herdr lane's proxy PR adds the per-pane proxy and sets, in the pane environment it
   starts: `DSH_SANDBOX_MASK=1`, `AM_HC_REAL_SOCKET=<the pane's real core socket>` and
   `AM_HC_PROXY_SOCKET=<the absolute host proxy socket>`. It starts the proxy before DSH and
   refuses the pane if the proxy cannot start; the wrapper refuses a pane without an absolute
   proxy path. The egress namespace, relay and proxy environment need no extra variable: the
   wrapper creates them itself. A sandboxed pane therefore loses its direct network and reaches
   the public internet only through the relay's proxy environment.
3. At enablement the pack (`herdr/mods/am-sidebar/dshTui.mjs`) copies `bin/hc-socket-mask.mjs`
   **byte-equal** from the pack release to a stable path, the way
   `node scripts/am-copies.mjs --check` treats the am copies, then runs
   `dsh-sandbox install --profile <the dsh-tui profile> --wrapper <that absolute path>`. The
   pack owns when; this folder owns how.
4. Until steps 2-3 are deployed together, the row is inert: with no `DSH_SANDBOX_MASK=1` the
   wrapper is a pass-through, and with the switch but no proxy the pane fails closed instead of
   reaching the real socket.

The pack carries the wrapper in its own release; this repository's release lane never ships
`apps/dsh-sandbox/` (`scripts/lane.ts` `NEVER_SHIPPED`), so a change here alone cuts no release
and never becomes a plugin tarball.

## Helper usage

The default profile is `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`, with `DSH_HOME` defaulting
to `~/.dsh`.

```sh
# Install (or re-install) the managed row. The wrapper must exist, be executable and be named by
# an absolute path (a relative one is refused).
node apps/dsh-sandbox/bin/dsh-sandbox.mjs install \
  --wrapper /path/to/hc-socket-mask.mjs --pack-root /path/to/data/automagik-herdr/dsh-sandbox

# Check it without writing: exit 0 when the block is there exactly once and matches.
node apps/dsh-sandbox/bin/dsh-sandbox.mjs check \
  --wrapper /path/to/hc-socket-mask.mjs --pack-root /path/to/data/automagik-herdr/dsh-sandbox

# A temp profile, as the tests and the pack's dry run use.
node apps/dsh-sandbox/bin/dsh-sandbox.mjs install \
  --profile /tmp/cordis.patch.yml --wrapper /path/to/hc-socket-mask.mjs \
  --pack-root /path/to/data/automagik-herdr/dsh-sandbox
```

`install` backs an existing profile up to
`<profile>.dsh-sandbox-backup-<ISO-timestamp>`, writes through a sibling temp file and a rename,
and is idempotent: an already-current block is not rewritten and takes no new backup. The block
is marked `# dsh-sandbox begin` / `# dsh-sandbox end`; install replaces it in place (or appends
it), and refuses to guess when the markers are duplicated or broken. `check` only reads. Exit
codes: `0` installed/current, `1` refusal or mismatch, `2` usage.

The helper understands three top-level layer shapes: an empty/comments-only file, the DSH
template's lone `[]`, and a block array. `install` replaces the lone `[]` line (keeping the
template comments) and appends after an empty/comments-only file or an existing block array,
then requires the result to be one block array again; it refuses a mapping, a scalar or a
non-empty flow array without writing. This is a top-level shape check, not a YAML parser.
`check` applies the same shape check before it compares the managed block, so the corrupted
`[]` plus block state is never reported as current.

## Tests

```sh
node --check apps/dsh-sandbox/bin/*.mjs
node --test 'apps/dsh-sandbox/test/*.test.mjs'
```

The runner tests put a fake `bwrap` first on a temp `PATH` and assert the argv it records,
including `--unshare-net` and the relay command; the proxy sockets are real
`net.createServer()` sockets under temp folders. `test/netns.test.mjs` goes further: when the
host allows bwrap namespaces it starts a real sandbox against fixture listeners on the host's
loopback and on the host's own LAN address, and asserts the pane reaches neither, reaches the
relay, and gets 403 from the egress proxy for both; the same probe without the switch reaches
both, so a skip or a false green is visible. On a host where bwrap cannot make a namespace the
live test skips with the reason and the hermetic refusal test still runs. CLI-level tests drop the
host-dependent container `--bind /dev/null` pairs by shape and never stat a live path; their
exact targets are asserted only by the pure-helper tests with an explicit fake container list.
So no test reads, creates or connects to a live core, a live `docker.sock` or a live profile.
The helper tests write only temp profiles. `ci.yml`'s
`dsh-sandbox` job runs both on every change under `apps/dsh-sandbox/` and on every change to
the workflow itself.
