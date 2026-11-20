# Automagik Multiuser for DeepSeek Harness

The adapter verifies the gate's RFC 0038 caller assertions on the private
`/_automagik/caller` route. It dispatches admitted requests with a per-request DSH Peer
and exposes the current frozen principal through the `automagikCaller` service.

The gated server image follow-up will install the release tarball and load it with
this profile row.

```yaml
- insert:
    - id: multiuser-dsh
      name: '@automagik/multiuser-dsh'
```

In the standard `dsh-web-app` composition, the carrier reads the built Web frontend
directly and renders the shell for each admitted member or guest. The stock Web app
continues to serve the owner through its fallback. Single plugin bundle requests
are limited to rc.2 executable web chunks, including `client.pane.js`.

Once installed, the `/_automagik` reservation lasts for the lifetime of the WebServer.
Private HTTP paths return 503 when the adapter is absent and 404 on a startup route
collision or an unmatched path while the adapter is active. Unmatched private upgrades
return 503 even while the adapter is active. The reservation covers the gate's
canonical path rewrite. Direct DSH requests using path aliases fall outside that guarantee.

- `AUTOMAGIK_MULTIUSER=1` enables the carrier. Unset, empty or `0` returns 401 on
  carrier requests and registered private upgrades. The carrier accepts assertions
  issued more than five seconds after its issuance cutoff. Each activation starts
  with the later of startup and the recorded second in `$DSH_HOME/multiuser-dsh/caller-watermark`.
  A backward clock step beyond five seconds raises the cutoff to the second projected
  by the monotonic clock. A corrupt or unreadable watermark returns 503 until it is
  repaired and DSH is restarted.
- `AUTOMAGIK_CALLER_KEYS` is the absolute path to the gate's public key file on a read-only mount.
- `AUTOMAGIK_INSTANCE_ID`, if set, must equal the instance in the published key file.
- `maxRequestBodyBytes` defaults to 314572800 and must equal
  `dsh-client-connection.maxRequestBodyBytes`. The image follow-up must verify equality
  and the effective profile composition before enabling multiuser mode.

Caller assertions allow targets up to 4,096 bytes and assertion headers up to 8,192 bytes because DSH partitions startup combos at 3,072 bytes.

## Bot principal record

With multiuser on and a nonblank `AUTOMAGIK_INSTANCE_ID`, the adapter records confirmed
Bot sessions in `$DSH_HOME/multiuser-dsh/principals.json`. DSH's uid owns the `0700`
directory and the `0600` file. In Bot mode, point the member wall's `principalsFile` at
that absolute path and leave `instanceId` blank to use the environment value or set it
to the same id, including any surrounding whitespace. The wall checks the live
`automagikPrincipalRecord` service for the writer's path, instance and verified directory
identity. A missing writer, a mismatch,
or a record file rejected for unsafe metadata or invalid UTF-8 denies all scoped file
access in Bot mode.
Multiuser off leaves the record untouched. A missing instance id disables recording and logs
a warning. If the record directory cannot be initialized, the adapter keeps the private
route reserved and refuses confirmed Bot work.

Each recording point (agent creation, before a step, and before a tool executes) checks
the live `automagikBotSessions` service. The adapter adds or confirms only
`bot:<registry-id>` entries. It can correct a stale entry for a confirmed Bot. Other
rows are preserved. New `owner` and `member:*` entries are deferred until there is a
trusted source for owner sessions and a mapping from verified `(issuer, subject)` to a
member area. Unclassified sessions, including fresh scheduled sessions and evicted
sessions the resolver cannot identify, receive no entry. An unrecorded, confirmed
Bot has no area. When the wall mounts after the adapter, it can refuse a Bot's first
out-of-step search before the recording hook runs. The Bot's first step records its
session for subsequent searches. In normal turns a step precedes its tools.

The first Bot entry creates a version 2 record when the file is absent. An existing
file must be a private, DSH-owned regular file with one link and a valid version 2
record for this instance. The adapter refuses other files and preserves their
contents. Version 1 member entries remain readable by the wall. Enabling Bot areas
on a version 1 installation requires the owner's one-time migration under RFC 0038
Q6. A single writer per record is a security requirement. Run one DSH process per
`DSH_HOME`, and stop it before migration or repair writes. A second writer's stale
snapshot can restore an `owner` row that the adapter replaced or drop a Bot entry.

During an adapter overlap, if the current writer leaves while the incoming carrier
is still activating, the incoming adapter can miss the removal and leave scoped file
access denied. If one adapter's writer setup fails, its refusing hooks can block confirmed
Bot work even when a healthy writer records the binding, for as long as both are mounted.

The writer keeps the verified directory descriptor open for its lifetime to prevent inode
reuse. The reader in Bot mode and the writer check that the pathname still refers to that
directory. Node lacks directory-relative `openat`, `renameat`, and `unlinkat`.
A directory swap and restore between pathname
operations can evade these checks.

## Remote stream WebSocket upstream dependency

DSH 0.2.2-rc.2's `dsh-api-gateway` exports the stream protocol (`./stream-protocol`) and
`wireStream.open(endpoint, payload, uplink, peer, signal)`, but not its mux server
(`RemoteStreamMuxServer` exists only as TypeScript under `src/` and in an unexported compiled
module). So the adapter carries a member's or guest's `/api/remote.mux` itself
(RFC 0038 delivery 5b):

- **Carrier.** The gate forwards a member's or guest's `GET /api/remote.mux`, and nothing else,
  to the private upgrade `/_automagik/caller/api/remote.mux` with a signed assertion for
  `GET /api/remote.mux`, the WebSocket handshake fields and no DSH credential. The adapter
  refuses any other raw target, a non-GET or a request body with 400, admits the assertion
  as it admits HTTP (one nonce store), and makes one Peer for the socket's life with
  `interactions: 'answer'`. Every logical stream (open, iteration and cleanup) runs as that
  caller, with `automagikCaller` reporting the principal and the gate session family.
  `src/mux.js` rebuilds DSH's mux from `packages/api/gateway/src/stream-server.ts` (MIT; see
  NOTICE) on `ws` 8.18.3, the version the Bot team pins.
- **Limits.** 4 sockets per person and 64 in total (429 and 503 before the handshake); 64 open
  streams per socket (the 65th gets `gateway/protocol`). IDs longer than 256 UTF-8 bytes
  get `gateway/protocol`. Limits also include 1 MiB per message, fragments
  included (1009), and at most 1024 frames per message (the socket is destroyed); a 256 KiB
  uplink inbox per stream; a ping every 2 seconds, closed after 2 missed; a malformed frame
  or a duplicate stream id is 1008 and a binary message 1003. The downlink drains DSH's
  iterators into one queue per socket. The 8 MiB budget per person covers queued and unsent
  bytes, including Ping, Pong and Close, and the wire size of stream opens awaiting the
  source. A socket may hold up to 32,768 outstanding writes, with 131,072 across a person's
  sockets. When a person exceeds a write limit, the socket with the largest backlog for
  that limit closes first. Every write has a 10-second deadline. The carrier drops the
  connection if a Close frame cannot fit or flush by that deadline. A stream ID stays
  reserved until its output is sent or discarded, including a refused open's error.
- **The `automagik` policy.** The adapter registers the only policy for the `automagik`
  principal kind, empty, before it admits any caller: every business call and every
  policy-filtered notification of a member or guest is denied. The access snapshot
  (`remoteAccess/follow`) and the `$events` ready frame are the exceptions; a member's
  `$events` never gets a pending event and cannot answer one. A policy another plugin
  registered first, or the loss of ours, closes admission and cancels every caller at once:
  sockets close and both pending uploads and dispatched HTTP are cancelled. Items of any
  other stream pass through a caller projection before they are queued; in this delivery there is none, so
  such a stream ends with no item.
- **Readiness probe.** `GET /_automagik/caller/_ready` answers `204` with
  `x-automagik-ready: 1` (no body, the connection kept open) while the adapter admits
  callers, else 503. The gate asks it on a fresh loopback connection and sends the member's
  request on that same connection, so a DSH restart in between breaks the connection instead
  of reaching a route registered before the adapter's reservation. HTTP and streams require
  application readiness and the live Typert gateway on the adapter's connection, using the
  same remote-access service and policy registration. Member RPC uses the bound gateway's
  dispatcher. Losing the gateway registration closes sockets bound to it and drops their
  queued frames. The private reservation remains in place in profiles without the
  optional gateway package.
- **Unload.** New member requests get 503 at once and carried sockets start a 1011 close.
  Pending uploads are cancelled and dispatched HTTP drains for up to 30 seconds.
  `automagikCaller` stays available until the dispatched requests and stream pumps settle.

The upstream ask, in RFC 0023's form: one export from `dsh-api-gateway`, either its mux server
as a public entry point (a `./stream-server` export of `RemoteStreamMuxServer` with
`handleUpgrade(req, socket, head, peer)` and its options) or a
`wireStream.serve(req, socket, head, peer)` that runs DSH's own mux on a plugin's upgrade
route. When it lands, the rebuilt carrier and its parity test go; the limits above stay as
options.

The `automagik` policy stays empty through delivery 5d. Members and guests read through
the Bot UI's caller routes once 5d exposes them.

The frozen `automagikCaller` service is version 2. It retains `multiuser` and `current()`.
`roleOf(principal)` returns the effective role. `visibleBotIds(principal)` computes Bot
visibility from the facts supplied by `provide({ bots })`, which registers one provider
and returns its disposer. Without usable facts, visibility is empty. `invalidate()`
wakes remote-access followers. `seen()` lists recently admitted identities for the
owner during this activation and refuses inside a carried caller scope.
