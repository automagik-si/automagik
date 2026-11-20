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
continues to serve the owner through its fallback.

- `AUTOMAGIK_MULTIUSER=1` enables the carrier. Unset, empty or `0` refuses carrier requests.
  After a restart, the carrier accepts assertions issued more than five seconds after the
  later of startup and the recorded verification time in `$DSH_HOME/multiuser-dsh/caller-watermark`.
- `AUTOMAGIK_CALLER_KEYS` is the absolute path to the gate's public key file on a read-only mount.
- `AUTOMAGIK_INSTANCE_ID`, if set, must equal the instance in the published key file.
- `maxRequestBodyBytes` defaults to 314572800 and must equal
  `dsh-client-connection.maxRequestBodyBytes`. The image follow-up must verify equality
  and the effective profile composition before enabling multiuser mode.

Caller assertions allow targets up to 4,096 bytes and assertion headers up to 8,192 bytes because DSH partitions startup combos at 3,072 bytes.

## Remote stream WebSocket upstream dependency

DSH 0.2.2-rc.2's `dsh-api-gateway` provides the stream protocol and
`wireStream.open(..., peer, signal)`. Its `RemoteStreamMuxServer` is only accessible as
TypeScript under `src/` and an unexported compiled module.

Request an exported mux server or `handleUpgrade(req, socket, head, peer)` on the
gateway service. The upstream API must bind a fixed caller Peer for the socket lifetime,
propagate cancellation, enforce stream limits and release streams and the Peer on disconnect.
After verifying those behaviors, the gate can add `/api/remote.mux` to the member upgrade
allowlist and route it to an adapter-owned upgrade. This delivery refuses member and guest upgrades.
