# The Automagik server image

The `automagik-web` DeepSeek Harness profile on a host: dsh's base and web app, the Bot team
(`@automagik/bots-dsh`), the welcome (`@automagik/welcome-dsh`) and ACP agents
(`@automagik/acp-dsh`), from one chosen release (or the committed checkout in PR tests). Built by CI only
(`.github/workflows/server-image.yml`): every change builds, smokes and scans it, and a dispatch
or a published release pushes it to `ghcr.io/automagik-si/automagik-server` as
`:<content>-<short sha>` and, when allowed, `:latest`. There is no laptop push. Tracked in #620.

Pins: dsh `0.2.2-rc.2` (the desktop runtime's own lock) and the plugins at one release, the
content. A dispatch takes `-f content=<tag>`, a release whose assets include `plugins.json`
(e.g. `v3.93.0`); empty picks the newest stable release that carries it, within the last 30
releases. A release event uses its own version as the content. A herdr, Pocket or am patch
carries no plugin tarballs: a dispatch whose content has none is refused, naming the tag, and a
release event for such a version builds and pushes nothing. The `Dockerfile`'s
`AUTOMAGIK_VERSION` is that plugin release (default `3.90.1` for a manual build); CI passes it as
both `--version` and `--image-version`. The identity names the content and the tree: the tag
`:<content>-<short sha>` (e.g. `3.93.0-91cf4862`), `org.opencontainers.image.version` = the
content version, and `org.opencontainers.image.revision` = the full workflow commit. A
`versions.json` inside the image names the plugin release it installed. Each tarball is checked
against the release's `plugins.json` (sha512 integrity, size) and `PLUGINS.SHA256SUMS` (sha256)
before dsh installs it.

Pull requests use a separate, nonpublishing checkout input. The runner installs only the
frozen root tooling, then normally packs all four owned plugins with `bun pm pack
--ignore-scripts`; it neither installs plugin dependencies nor regenerates bundles. Every
packed file must match a regular file at the actual checkout HEAD (normally GitHub's merge
commit); packable untracked/ignored files and dirty source fail. The fixed package set, normal
`plugins.json`, size/SRI/SHA chain and independently passed checkout SHA and manifest digest
are checked again before assembly. DSH installs the same three profile plugins normally.
There is no release fallback, arbitrary source directory or URL in checkout mode.

The PR tag and OCI version are `checkout-<full SHA>`; `versions.json.automagik` and plugin
versions remain the root version, with separate source kind, revision and manifest metadata.
CI copies the installed Bots child and versions metadata from an owned stopped container of
the inspected candidate image ID, verifies the child against the committed checkout, and
keeps `checkout-image-proof.json` even if a later smoke or scan fails. Both existing smokes
and the complete secrecy scan still apply. No PR image is saved for publication. Publication
requires release/dispatch and release input, then checks the loaded candidate's labels and
rootfs source metadata before registry login. Deployment, digest records and attestations
continue to describe verified release assets only.

A push to `dev` retains its existing path filter and release resolution: use the current
version's release when it has plugins, otherwise the newest stable release with plugins.
It never publishes and can still fail on old immutable release content. Release and dispatch
selection, prerelease/latest rules and default standalone/companion builds remain release
based. Unknown events and contradictory source arguments fail closed. Image builds and the
actual rootfs proof run in GitHub Actions only.

The builder also applies the desktop app's DSH runtime patches
(`apps/desktop/runtime/patches` via `apps/desktop/scripts/runtime-patches.mjs`) to the same
pinned packages, and fails the build on any version or hash mismatch. Today that includes
`frontend-static-index-cache.patch`: the SPA index gets `cache-control: no-cache` with a weak
ETag of the rendered bytes, and a matching `If-None-Match` gets an empty 304, so a reload after
a plugin update cannot keep a stale manifest.

## Pull

```sh
docker pull ghcr.io/automagik-si/automagik-server@sha256:…
```

Every run that pushes writes the manifest digest into the release's own record: the asset
`server-image.json` on the content release (`server/image-record.mjs`), on a release event and
on a dispatch alike. Pin a workspace by that digest, never by `:latest` or another tag (RFC 0024
(g)):

```sh
gh release download v3.93.0 --pattern server-image.json --output - | jq -r .ref
```

The record holds `image`, `digest`, `ref` (`image@digest`), `version` (the content release),
`revision` (the workflow commit) and `tag`. The `record` job builds it only from the digest the
push printed, refuses anything that is not a `sha256:` manifest digest, reads the asset back from
the release, and is the only job that may write to a release or attest the pushed digest. A
later push for the same content release replaces the record; a desktop rebuild keeps it. The
publish job also prints the digest in its summary and saves it as `image-digest.txt`. `:<content>-<short sha>` identifies one build of one content release from
one commit; the version label is the content release and the revision label the commit. `:latest`
moves only when the content release is not a prerelease and its version is not older than the
published `:latest` (compared by that label). GitHub creates a new package private, so the first
publish needs the one-time visibility flip below before an anonymous pull works.

## Follow

Arca and other consumers discover the newest stable image at one URL:

<https://github.com/automagik-si/automagik/releases/download/server-lane/server-image.json>

After the `record` job attests the pushed digest and records it on its content release, the
`server-lane` job replaces that same record on `server-lane`. This rolling release is created as a prerelease,
never marked Latest and never edited by hand. The lane job takes turns in a concurrency group (one waiting, an older waiting run dropped for a
newer, as `pocket-lane`), compares all three version components numerically, and refuses an older content
version. A rebuild of the same version may replace its digest. Prereleases never advance the
lane. An unreadable or malformed existing pointer stops the update; only a confirmed missing
release creates the lane.

Each pushed image receives a GitHub build-provenance attestation through
`actions/attest-build-provenance`, published to GHCR with `push-to-registry`. Signing is keyless:
only the `record` job gets `id-token: write` and `attestations: write`; it uses the workflow token
for registry access, with no new secret. Verify the digest before pulling or deploying it:

```sh
curl -fsSL https://github.com/automagik-si/automagik/releases/download/server-lane/server-image.json \
  -o server-image.json
ref=$(jq -er 'select(.schema == 1 and .image == "ghcr.io/automagik-si/automagik-server"
  and (.digest | test("^sha256:[0-9a-f]{64}$")) and .ref == (.image + "@" + .digest)) | .ref' server-image.json)
gh attestation verify "oci://${ref}" --repo automagik-si/automagik
docker pull "${ref}"
```

Consumers must stop on a failed validation or verification, retain their highest accepted
content version, and refuse a downgrade. Provenance verifies the image digest and repository;
the JSON record itself is not signed and the attestation does not prove its freshness. Pin
the verified digest and update on the same volumes as described below. GitHub documents the
[attestation action](https://github.com/actions/attest-build-provenance) and
[verification command](https://cli.github.com/manual/gh_attestation_verify).

## Publish

A published release for a version that carries `plugins.json` publishes the image. A cut's own
release event starts no workflow, so `release.yml` explicitly dispatches every stable plugin
release on its tag with `content=v<version>`. This independent job only warns on dispatch failure.
To retry manually after merge:

```sh
gh workflow run server-image.yml --ref dev -f content=v3.93.0
```

`content` is the release tag whose plugin tarballs are installed; empty means the newest stable
release that has `plugins.json`. The dispatch runs on `dev` or on a `v<version>` tag equal to
`package.json`'s version. A pull request or a push to `dev` only builds and scans.

## The image

Four preparation/runtime stages, every base digest-pinned (plus the distroless base input):

| Stage | What it does |
|---|---|
| `builder` | `node:24.22.3-trixie-slim`: installs the pinned harness and pnpm, verifies the release tarballs, installs/prunes the profile, prepares its inspected offline dependency store, writes version/revision metadata |
| `tools` | `debian:bookworm-slim`: `bash`, `dash` as `/bin/sh`, git core, `ripgrep`, `flock`, `tar`, `gzip`, `find`, their `ldd` closure, and the empty `/data` tree owned by uid 1000. No perl: git's perl subcommands are not shipped |
| `gate-deps` | Bun 1.4.4 installs the exact WebAuthn dependency and `server/bun.lock`, with lifecycle scripts disabled, then prunes development files. Bun stays in this stage |
| `runtime` | `scratch` holding the distroless nodejs24 rootfs (node and glibc), cleaned in the `tools` stage (man pages and changelogs stripped there with coreutils), plus the tools above, the code, nothing else — no apt, npm, curl or build toolchain |

The distroless tag ships Node 24.14.0 (above dsh's 24.9 floor); the builder is 24.22.3. The
pruned payload keeps everything the composed tree names — office-to-pdf and its
`libreoffice-kit-wasm` included — and drops the inspector, the voice engine, the musl sharp
variants, the win32/darwin node-pty prebuilds and the experimental bundles the profile never
composes.

## Build and smoke

```sh
node server/build.mjs --tag automagik-server:local --version 3.93.0 --image-version 3.93.0 \
  --revision "$(git rev-parse HEAD)"
node server/smoke.mjs automagik-server:local
node server/follow-smoke.mjs automagik-server:local
```

`--version` is the release whose plugin tarballs are installed; `--image-version` is the content
version label (normally the same release, without its `v`); `--revision` is the commit label. With
no arguments the release is `3.90.1` and the revision label `unknown`.

The context is the repository root because the builder reuses
`apps/desktop/runtime/package-lock.json`; `server/Dockerfile.dockerignore` keeps the context
small. The smoke runs the image with a named volume (no published port), waits for `401`, checks
the log has no token (it reads the real token from `/data/dsh/launch-url`), the profile and its
three plugins are in `/data`, `launch-url` is `0600`, the process is uid 1000, Docker's health
check turns healthy, the composed tree still has its 200 entries (bots, welcome, ACP, web app,
office), no composed plugin failed to import, koffi and node-pty load and a PTY spawns, and a
restart does not reseed. No coreutils are assumed: the checks use node and bash.
The follow smoke builds a companion release, seeds a volume with the real older plugins, then
starts the newer image on that same volume with networking disabled. It verifies all three
versions moved, a backup exists, user settings survived, and a second restart keeps the update.

## Run

```sh
docker volume create automagik-data
docker run -d --name automagik --network host \
  --volume automagik-data:/data \
  --env DEEPSEEK_API_KEY=sk-… \
  ghcr.io/automagik-si/automagik-server@sha256:…
```

Use `automagik-server:local` here after `node server/build.mjs --tag automagik-server:local` to
run a build from this checkout.

No port is published: dsh binds `127.0.0.1:3081` inside the container, as the production host's
layout does. That is reachable with `--network host` on Linux, or by running the reverse proxy in
the same network namespace; `-p 3081:3081` does not reach a loopback bind. There is no `EXPOSE`.

The key comes from `DEEPSEEK_API_KEY`, or from a `0400`/`0600` file: `DEEPSEEK_API_KEY_FILE`,
else `/data/secrets/deepseek-api-key`, else `/run/secrets/deepseek_api_key`. A file readable by
group or other, or executable, stops the start (Docker's `0444` secrets need the env instead).
The value is never logged.

`DEEPSEEK_API_KEY` is optional for the idle server: without it the image still boots, the auth
fence answers `401` and the welcome offers the sign-in tiles. A model turn needs the key; a
healthy `401` says the fence is up, not that a model is configured.

| Mount | What it holds |
|---|---|
| `/data` | the volume: `dsh/`, `bots/`, `workspace/`, `secrets/`, `dsh/launch-url` |
| `/data/dsh` | `DSH_HOME`: the `automagik-web` profile, dsh settings, `pnpm-store` |
| `/data/bots` | `AUTOMAGIK_BOTS_HOME`: the Bot team's state |
| `/data/workspace` | the working directory dsh gives its Sessions |
| `/data/secrets/deepseek-api-key` | optional model key, `0400` |

`/opt/automagik` is read-only code. The image bakes nothing into `/data`: the profile is seeded
at first start. An image-managed seed follows newer image releases on subsequent starts, as
described below; a profile whose `package.json` the owner changed stays owner-managed.

## Update a workspace through its image

Arca and host operators update by changing the pinned image digest and restarting on the **same
volumes**. Take a host snapshot of the workspace volumes first. Replace the container using the
new digest and the same mounts/environment from Run, or set `AUTOMAGIK_SERVER_IMAGE` to the new
digest for both Compose services and recreate them. Do not remove the data volumes or move the
profile aside for a normal update.

```sh
docker compose -f server/compose.gate.yml --profile gate up -d
docker compose -f server/compose.gate.yml --profile gate exec gate \
  /nodejs/bin/node /opt/automagik/healthcheck.mjs --json
```

For the single-container form, read the same report with:

```sh
docker exec automagik /nodejs/bin/node /opt/automagik/healthcheck.mjs --json
```

At seeding, `automagik-server-profile` records the image release, the image's own manifest and a
SHA-256 of the exact `package.json`. Plugins added later through the welcome (Power Omni on) or
DSH's Plugins page keep the profile following the image: their dependencies and bundles are the
workspace's, and a newer image still updates the Bot team, welcome and ACP. An update keeps each
added plugin's locked resolution and installed version, with its peer references moved to the
new Bot team. If one cannot be reinstalled from the volume's cache, or comes out at another
version, the update rolls back. A restart on the same image keeps the workspace's lock.

Markers written before this held only the hash: their base is the image's manifest with the
recorded release's three tarball names. Volumes without a structured marker are adopted only when
the entire canonical package manifest matches the known image seed shape. Missing or mixed
installed plugins never become an owner-managed exception. Changing one of the image's three
dependencies, removing or reordering a base bundle, or editing any other manifest field opts out.
Owner-managed profiles are left alone and identified in startup logs and the report. Settings
such as `cordis.patch.yml` survive an automatic update.

Image preparation holds a kernel file lock on the DSH volume across recovery, first seeding
and the complete update. Concurrent starts sharing that volume wait up to 180 seconds, then
read the completed profile instead of repeating the install. Failure to acquire the lock stops
startup. The private `.automagik-image-follow.lock` file stays in place; the operating system
releases its lease when the holder exits, including after a crash. Do not delete the lock file
while containers are using the volume.

Before installing, the image saves the complete old profile, including its package manifest,
lock and installed dependencies, under `/data/dsh/backups/<UTC>/automagik-web`. Installation runs
in a separate staging profile through `dsh plugin install --offline --frozen-lockfile --prod
--ignore-scripts`. Its local tarballs are materialized from the image's inspected, unpacked
plugin files; their dependencies come from its pruned offline store, and added plugins from the
volume's own pnpm store, where DSH put them when it installed them. The frozen lock is the
workspace's with the image's three resolutions swapped in: it never picks new versions of added
plugins. pnpm indexes a git-hosted plugin (Omni's) by whether its scripts ran, so the update
reuses the index of the files DSH installed instead of fetching them again. No runtime release
download or registry access is needed; the image still ships no archive that bypasses the
secrecy scan. All three installed versions, and every added plugin's, must verify before the
staged profile replaces the old one. A failed attempt leaves the old profile running and reports
`update-rolled-back` with an unhealthy result, so a keeper can distinguish rollback from a
successful update.

Fresh seeds also materialize those three tarballs on the data volume. Both seeds and upgrades
retain them in the profile's `vendor/`, with matching lockfile integrity: any later
`dsh plugin install` re-resolves the profile's direct dependencies. Once an update's install has
verified, the previous image's three archives leave `vendor/` (the backup keeps them); any other
file there stays. A matching image repairs an older image-managed seed whose tarballs are
missing, in the workspace's own lock (a lock it cannot read is replaced by the image's).
Owner-managed profiles are left alone.
The image itself stays archive-free and carries no Omni installation. Omni's plugin downloads
and verifies its own Bun runtime using Node; its sandbox installer uses the image's `tar`,
`gzip` and `find` to unpack its verified Postgres and NATS downloads.

Equal or older releases never downgrade installed plugins. **Going back requires restoring the
host snapshot**, including matching image/data state: plugin migrations are forward only.
Changing to an older digest alone leaves newer plugins in place and reports `newer-than-image`.
The profile backup is an install recovery copy, not a substitute for the host's data snapshot.

The first launch URL, token included, is written to `/data/dsh/launch-url` (`0600`) and printed
redacted in the log:

```sh
docker exec automagik cat /data/dsh/launch-url
```

## Configuration

`AUTOMAGIK_PUBLIC_URL` optionally names the public HTTPS URL for a single-container run without
the gate, served by your tunnel or reverse proxy, for example `https://example.invalid/`. Pass it with
`--env AUTOMAGIK_PUBLIC_URL=https://example.invalid/` in the `docker run` command above.
The entrypoint passes `--public-url <url>` and `--trusted-host <host[:port]>` to dsh, preserving
an explicit non-default port. The proxy must reach the loopback listener and provide HTTPS;
this setting keeps dsh bound to `127.0.0.1:3081` and keeps its authentication enabled.

When unset, startup is unchanged. An empty or invalid value stops startup with a message
naming `AUTOMAGIK_PUBLIC_URL`. Use an absolute HTTPS URL with a host, optionally a path prefix
for a proxy that strips that prefix, and no credentials, query, fragment, whitespace or
backslashes. The advertised launch URL, including its token, is still saved only in
`/data/dsh/launch-url` and redacted in logs.

### Incus

Incus creates a custom volume root-owned, and the image runs as uid 1000: the first start cannot
write `/data` unless the volume is created for that uid, and the image cannot chown (it runs as
1000 and has no root). Create and attach the volume with its initial owner:

```sh
incus storage volume create <pool> automagik-data initial.uid=1000 initial.gid=1000
incus storage volume attach <pool> automagik-data <instance> data /data
```

`attach` takes a device name (`data`) and then the mount path (`/data`); a filesystem volume
requires the path. Incus takes `initial.uid` and `initial.gid` as positional `key=value` config
on `create`. For an existing root-owned volume, chown it to `1000:1000` on the host instead
(`chown -R 1000:1000 <the volume's path>`). Docker's named volume needs neither: Docker seeds a
fresh volume with the image's `/data` ownership (1000:1000).

The volume flags above stay required. The image's WorkingDir is `/opt/automagik`, off the
`/data` volume on purpose: an Incus instance pre-creates the image WorkingDir on the mounted
volume as root, which would leave `/data/workspace` 0:0 755. The entrypoint prepares
`/data/workspace` as uid 1000 and chdirs there afterwards, so no `oci.cwd` override is needed.
An empty root-owned `/data/workspace` left on a volume by an older image is removed and
recreated; a non-empty one is refused with the directory's uid 1000 message. An empty one that
is itself a mount point is left in place and refused the same way: `rmdir` fails `EBUSY`, and
the entrypoint never forces it.

## Visibility

GitHub creates a new Container package private even when the repository is public, and its REST
API has no endpoint for a Container package's visibility (as of 2026-11). Make it public once, as
an organization owner:

1. Open <https://github.com/orgs/automagik-si/packages/container/automagik-server>.
2. **Package settings → Danger Zone → Change visibility → Public**.

The publish job checks the package with `GITHUB_TOKEN` and, when it is not public (or the token
cannot read packages), leaves this path in the job summary and warns. The image is still pushed,
but anonymous pulls fail until the flip; the login-less pull is the verification:

```sh
docker logout ghcr.io 2>/dev/null || true
docker pull ghcr.io/automagik-si/automagik-server@sha256:…
```

## Measured

The **compressed** figure is the sum of the registry manifest's layer sizes (`.layers[].size`),
the compressed blobs a pull fetches; it is not a `docker save | gzip` artifact. **Unpacked** is
the sum of the 18 layers' regular-file payloads, counted layer by layer, so a file a later layer
replaces or deletes is counted again in its own layer: 546,556,270 bytes (521.24 MiB).
**Flattened rootfs** is the other count: extract all 18 layers into one directory and sum the
regular-file bytes that remain, 541,605,298 bytes (516.52 MiB). `docker image inspect .Size`
reports a different number that includes the store's layer accounting and compressed blobs
(784,888,111 bytes, 748.5 MiB, with Docker 29.9.1's containerd store), so it is not the unpacked
payload and is not used here. The earlier 193 MiB figure was a `docker save` gzip artifact of
202,734,124 bytes, a different count and never the image size.

A test laptop on an Incus-based OS, 2026-11-07, on the image in the table below. Pull and create
are the Incus timings for the launch. Memory is the instance's cgroup (`memory.current`) unless
the row says RSS; anon and file are the 5-minute split.

| Measure | Value |
|---|---|
| Image | `sha256:f3ba1643b147fa78f76bf05e736d17c11c5e4f3fd2589469f327093c225fba09` |
| Layers | 18 |
| Unpacked (per-layer sum) | 546,556,270 bytes (521.24 MiB) |
| Flattened rootfs | 541,605,298 bytes (516.52 MiB) |
| Compressed OCI blobs | 185,312,829 bytes (176.7 MiB) |
| Pull | 21.3 s |
| Create | 4.3 s |
| First 401 | 4.1 s (polled every 1.6 s, likely 2.5–4 s) |
| Idle at 5 min | 198.9 MiB cgroup (anon 163 MiB, file 35 MiB) |
| Largest RSS | 174 MiB |
| First minute | ~341 MiB |
| By minute 2 | ~206 MiB |
| CPU | 0.09% of one core |
| Warnings | none |

The **350 MB unpacked target is not reachable** (546,556,270 bytes, 521.24 MiB across layers).
The **350 MB compressed target is met** (176.7 MiB).

The 350 MB goal is therefore the **compressed** size, the bytes a pull fetches. As an unpacked
size it is not a trim goal any more: no small cut closes the gap. The office stack
(`@deepseek-ai/libreoffice-kit-wasm`, 152,349,402 bytes, 145.3 MiB) is the only large
discretionary piece, and the flattened rootfs without it is still 371.2 MiB (389.3 MB). Getting
under 350 MB unpacked would also mean dropping the shell tools Bots use (bash, git, ripgrep and
their libraries, 48.3 MiB), so it removes features rather than waste. A smaller unpacked image
is a product decision (for example office fetched or run on demand), not image work to schedule
here; it and the first-minute memory peak are tracked in
[#638](https://github.com/automagik-si/automagik/issues/638).

## Health

```sh
docker inspect --format '{{.State.Health.Status}}' automagik   # healthy
docker exec automagik /nodejs/bin/node /opt/automagik/healthcheck.mjs   # prints 401
docker logs automagik | grep 'startup:'
```

**Only `401` can be healthy**: a `200` or no answer fails. The compact form prints the status
(`000` for no answer), and exits nonzero if the profile does not match the image and is not
explicitly owner-managed. In gate mode, both DSH and the main gate must answer `401`; a gate
that is up cannot conceal a stopped DSH. The check uses Node's `http`, not curl.

`healthcheck.mjs --json` gives keepers a versioned report:

| Field | Meaning |
|---|---|
| `schemaVersion` | Report format, currently `1` |
| `image.version`, `image.revision` | The image's plugin release and build commit |
| `plugins` | Actual installed version of each of the three plugins; `null` when unavailable |
| `followsImage`, `ownerManaged`, `reason` | Whether the seed matches the image, whether the owner opted out, and a fixed reason such as `matching-image`, `owner-managed`, `update-rolled-back`, `newer-than-image` or `missing-plugins` |
| `dsh`, `gate` | Listener availability and HTTP status; `gate.enabled` says whether it is required |
| `fence`, `healthy` | Fence status and overall result; exit `0` only for healthy fences plus matching or owner-managed plugins |

No launch URL, token, model key, raw installer diagnostics or home path is included. The startup
log still names the redacted fence: `startup: http://127.0.0.1:3081/ (token in /data/dsh/launch-url)`.

## Secrecy gate

The workflow extracts the built image's rootfs (`docker export`; the image is never run), lists
every file and scans it before logging in or pushing (`server/secrecy.mjs`). Every file gets the
repository's own privacy grep (`herdr/scripts/privacy-check.mjs`, same deny list) plus the image
rules: a provider key, a `token=` or JSON token field, a private-key block with a real body (a
base64 line of any length, a short final line, or a `Proc-Type`/`DEK-Info` header; a bare
`BEGIN`/`END` label is not a key), a `.env` or `launch-url` file, any file under `/data` (the
image bakes no profile, bot/team state, workspace or secret), a home or `/mnt/ai` path, a
credential URL, an archive (not opened by this scan), or an environment variable named like a
secret. The image's config is scanned too. A hit fails the job.

### Billing rules

The same scan is the static scan of RFC 0025's Decided 12: the open-source image has no billing
code, gateway address or credential, and Cloud supplies only configuration at run time. It reads
the image's dependencies and imports and fails on:

| Rule | What | Where |
|---|---|---|
| `stripe-sdk` | a `stripe` or `@stripe/*` package folder, package, dependency (not a development one) or import | every file |
| `stripe-client` | a Stripe host | every text file |
| `stripe-key`, `stripe-id` | a Stripe secret, restricted or webhook key; a price, product, account, customer, subscription, plan or publishable-key id | every text file |
| `gateway-address` | an address on one of this product's hosts that names a gateway | every text file |
| `gateway-address` | a gateway-named setting with a URL default (a reserved example host is a placeholder) | our own code, the image config |
| `gateway-credential` | a gateway-named token, key or secret with a literal value | our own code, the image config |
| `billing-import`, `billing-route` | an import or a route literal with a `billing` or `ledger` segment | our own code |
| `gateway-address`, `billing-config` | an environment variable named for a gateway, Stripe, billing or a ledger, with a value | the image config |

"Our own code" is the image's scripts, the seed profile and every `@automagik` package, wherever
the installer put it; a dependency under another `node_modules` folder is third-party. A
provider preset's third-party address (a user-chosen model provider) is not a built-in gateway.
A billing hit in our own code or the config may never be allowlisted, nor may `stripe-sdk`,
`gateway-credential` or `billing-config` anywhere; another dependency's hit needs an exact entry.
Every finding, billing or not, prints one constant from a fixed table in `secrecy.mjs`
(`LABELS`): `sk-***`, `a home path`, `gateway default https://***`, `/***/billing/***`. Nothing
is copied from what was scanned: not a matched string, a URL's userinfo, host, path or query, a
route, an import, a package name, a setting's key, an environment variable's name or value, or
the privacy grep's own text. So a credential carried in any of them never reaches the log or
the uploaded inventory. No hash of a match or of a flagged file is written either (stdout,
stderr, the step summary, `secrecy.txt`, `secrecy-hits.json`): an unkeyed sha256 of a short
value can be guessed offline. The file and the line place a finding. For an allowlist entry,
read the match in the file itself and take the digests locally (`sha256sum` for `fileSha256`).
The inventory still lists every file path and symlink target in the image, and the image's
layer ids, by design.
The rules are shapes: this repository writes no Stripe key, price or account id, and
`node server/secrecy.mjs --repo .` (CI's `privacy` job) fails on one in any tracked file. A price
written as a plain amount is not a shape a scan can know; that stays a review rule.

The only exceptions are exact entries in `server/secrecy-allowlist.json`: one file, one rule and
the exact matched string (or its sha256), each with a reason. There are no path patterns, and a
key, `/data`, this repository's own code, `/etc` or a config file may never be allowlisted. A
private-key block is an entry only for the six reviewed gnutls test vectors in
`usr/lib/x86_64-linux-gnu/libgnutls.so.30`; each names its gnutls source and pins both the block
sha256 and the containing library's `sha256sum` (so a library update stops matching). The Node
binary's `/home/iojs` is excused only when that binary's `sha256sum` matches the entry's pin. The
workflow lists the entries used and reports a stale entry.

The image is shrunk before the scan: third-party test, example and docs folders, non-Linux
prebuilds and the profile's `vendor/*.tgz` install inputs are pruned (`assemble.mjs`). The offline
store contains only individually hashed files retained in the inspected profile; local plugin
archives are generated and retained in the writable profile at seed or update time. The
`tools` stage copies the distroless rootfs, strips `usr/share/doc`, `man`, `info` and `lintian`
there with coreutils, and the final `scratch` copies that cleaned rootfs. There is no `rm` in
the runtime image. The `archive` rule never allows an archive that is left.

The image's `/etc/passwd` is the repository's own (`server/passwd`), with no `/home/<user>`; the
distroless `nonroot` home is not in the image. The layer list is the image's RootFS plus
`docker save`'s manifest blobs (the content scan is the final flattened rootfs, which is what
runs), and external/dangling symlinks are listed rather than followed. The inventory, the exact
allowlist used and the symlink list are uploaded as an artifact. Before the real build, CI also
runs the gate in image mode against a small image with a planted key and requires it to fail.

Run it on an already-extracted tree without Docker:

```sh
node server/secrecy.mjs --rootfs /tmp/rootfs --inventory secrecy
```

## Files

| File | Role |
|---|---|
| `Dockerfile`, `Dockerfile.dockerignore` | the builder, tools and distroless runtime stages |
| `assemble.mjs` | builder stage: runtime, release tarballs, profile, prune |
| `fetch-plugins.mjs` | downloads and verifies the pinned release's tarballs |
| `entrypoint.mjs`, `lib.mjs` | seed `/data`, key file, pnpm store, dsh, redacted log |
| `profile-follow.mjs`, `profile-state.mjs` | ownership, staged offline update, backup and live version state |
| `plugin-payload.mjs`, `offline-store.mjs` | local install inputs from scanned files; build-only dependency-cache preparation |
| `healthcheck.mjs` | compact Docker health check and keeper JSON report |
| `secrecy.mjs`, `secrecy-allowlist.json` | pre-push scan: rootfs extraction, inventory, rules (billing included) and the exact reviewed exceptions; `--repo` for the tracked files |
| `image-record.mjs` | the release's record of the pushed image digest (`server-image.json`) |
| `passwd` | the image's account record (no `/home/<user>`; `automagik` is uid 1000) |
| `bin/dsh`, `bin/pnpm` | the image's pinned commands for `docker exec` |
| `profile/` | the seed profile: `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml` |
| `build.mjs`, `smoke.mjs`, `follow-smoke.mjs`, `test/` | build, fresh/restart and older-volume smokes, unit tests |

## Tests

```sh
bun install --cwd server --frozen-lockfile --ignore-scripts --linker hoisted
node --test 'server/test/*.test.mjs'
```

The Compose contract test needs the Docker Compose CLI; `compose config` parses the topology
without starting containers or requiring a running Docker daemon.

The unit tests cover the token redaction, the startup-line match, the private-key rule, the
first-start-only seed, the pnpm-store pin, the tarball verification, the third-party prune, and
the secrecy gate: 17 negative probes (keys, tokens, a real-shaped fake private key, `/mnt/ai`,
homes, a private name, credentials, `.env`, `launch-url`, `/data` state, an archive, and a key
that the allowlist may never excuse), that a bare PEM label is not a key while a short final
line and a `Proc-Type`/`DEK-Info` header are, that a private-key entry is allowed only for the
gnutls library, that the Node build account is excused only for the pinned binary hash, the exact
allowlist, that the image's own redaction regex is not mistaken for a token, the billing rules
(the Stripe SDK as a folder, package, dependency and import; Stripe hosts, keys and ids; billing
imports and routes; a built-in gateway address or credential against a provider preset and a
placeholder; the image config; what may never be allowlisted; the repository's own tracked
files), and the digest record (what it refuses, the CLI, and the workflow's wiring: every
pushing run records, only the `record` job writes to a release, a desktop rebuild keeps it). The smoke is
the real check of the image; the workflow runs the scan on the real rootfs before pushing.

## Gate foundation (C2.1, #907)

The image also carries `gate-entrypoint.mjs`, a separate plain Node process. It is disabled by
default. When enabled, it uses the self-hosted claim and passkeys below, or the optional Access
mode. Cloud workspace tokens (#909) are a later delivery. The single-container run above still works.

`compose.gate.yml` describes the opt-in two-container topology. Set `AUTOMAGIK_SERVER_IMAGE`
to the same reviewed digest for both services, `AUTOMAGIK_GATE_ENABLED=1` and
`AUTOMAGIK_GATE_ORIGIN` to the exact public origin (`https://{instance-host}` or
`http://localhost:{port}`, with placeholders replaced locally), then use Docker Compose's
`--profile gate`. The tunnel connector belongs in the `dsh` service's network namespace
(`network_mode: service:dsh` for another Compose service) and targets `http://127.0.0.1:3082`,
the gate's loopback listener. No port is published; keep this topology off host networking.

The `dsh` service in `compose.gate.yml` receives no `AUTOMAGIK_PUBLIC_URL` or trusted-host
setting. `AUTOMAGIK_PUBLIC_URL` is only for the single-container run without the gate above.
DSH's API/connection routes therefore refuse public `Host` headers with `403`: a tunnel
misrouted to DSH on port 3081 fails at that fence. The gate sends DSH its loopback Host for
legitimate traffic. Point the tunnel at the gate on port 3082 and keep DSH's public Host
untrusted.

Only the network namespace is shared. The gate has its own `gate-data` volume at `/data`,
never mounted into DSH; it reads `dsh-data` at `/dsh:ro` for the launch credential. It has no
model key. With Access unset it connects only to the fixed loopback DSH listener and never
follows a launch file's destination or any upstream redirect. Tests use temporary stores and
listeners; they do not touch a running installation.

Workspace HTTP requests and every WebSocket upgrade need a gate session; otherwise they get
`401`, including static assets, `/connect` and unknown paths. Only the sign-in ceremonies below
can create a session. The health probe
still expects `401` (at the gate port when enabled). An exact Host, origin including port, and
same-origin browser markers are checked. Mutations and WebSockets require an Origin. Forwarded
headers cannot override that decision: TLS termination and the public origin are operator
configuration, never browser assertions. Self-hosted passkeys require HTTPS or HTTP localhost,
with the RP ID and exact origin pinned in the owner's authentication record.

The gate exchanges DSH's launch token server-side for its browser owner credential. That
credential admits DSH's HTTP API and WebSocket owner peer too; it stays in gate memory and is
never sent as a browser cookie. Browser credentials and identity headers are stripped on the
upstream hop; DSH's `Set-Cookie` is stripped on the return. A DSH `401` clears and re-mints the
cached credential from the launch file for the next request, including after a DSH restart.
The failed request is returned as-is: bodies are never automatically replayed. A browser launch
token URL and `/connect` cannot establish or replace a gate session.

The local owner has `{version: 1, local_id, instance_id}` and, for passkeys, an `auth` record in
`/data/owner.json` (`0600`). Both ids are random UUIDs, independent of the host. The first valid
claim creates the owner exclusively; startup does not create one. Missing, malformed and newer records never
replace an existing owner; unsupported versions stop startup. Linked records also fail closed
until linking is implemented. Sessions and rotated-secret hashes are atomic `0600` JSON in the
gate store, survive restart, and are not written to DSH's volume. No raw session secret is saved.

Sessions have a 12-hour sliding idle limit and `__Host-automagik-session` cookies: `Path=/`,
`HttpOnly`, `Secure`, `SameSite=Lax`, no Domain. Secure stays set on HTTP localhost too, as the
`__Host-` prefix requires. A browser must renew before cookie expiry:
`POST /_gate/session/renew` rotates the secret and refreshes its lifetime. Reusing an old secret
revokes the entire family, including its open WebSockets. Idle expiry and sign out also close
open WebSockets. `GET /_gate/sessions` lists session ids and times without secrets and includes
this settings notice: **On loopback, another local service can receive your cookie. A local
process holding it can replay it with any Origin; origin binding does not prevent this. Local
processes are inside the host trust boundary.** `POST /_gate/sign-out-everywhere` revokes all
families and clears the cookie. All three routes require a session; POST requires the pinned
Origin. Every passkey or recovery change revokes all families through that same seam.

The gate makes the four-field principal from the owner record, following
[contracts v1](../docs/cloud/contracts-v1.md). Its upstream envelope is base64url JSON in
`X-Automagik-Principal`, replaced rather than forwarded from the browser. This is gate-produced
metadata on the loopback hop: DSH 0.2.2-rc.1 does not interpret that header as its caller
principal. Its own routes continue to use DSH's owner peer. This is the single-human limit in
RFC 0024 (b), (c), (f); a Bot that reads the launch credential can impersonate the owner on
loopback. It is not the unforgeable channel or role filtering needed for other people to join.

The gate tests cover unauthenticated HTTP/upgrade paths, exact origin and port, cookie flags,
rotation/replay/idle/restart, the downgrade refusal, credential stripping, the principal
upstream envelope, DSH restart recovery, and live-socket revocation. The container smoke also
checks the two-volume topology and gate `401`; CI builds, smokes and scans the image as before.

## Self-hosted claim, passkeys and recovery (#908)

Leave all three `AUTOMAGIK_GATE_ACCESS_*` settings unset to use this mode. It makes no outside
authentication connection. The verifier is the maintained, MIT-licensed
[`@simplewebauthn/server` 14.1.0](https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v14.1.0),
pinned exactly with its transitive Bun lock. It supports the image's Node 24 runtime. Registrations
use ES256, user verification and no attestation; there is no metadata-service or certificate fetch.

Set `AUTOMAGIK_GATE_ORIGIN` before enrolling: either `http://localhost:{port}` or a stable
`https://{instance-host}` origin, with an optional explicit non-default port. Use placeholders
only in examples; replace them on your host. IP origins are refused with an explanation: use
localhost through an SSH tunnel, or a stable HTTPS name. Host and Origin must match exactly,
including the port; forwarded headers cannot change them.

Choose `AUTOMAGIK_GATE_CLAIM=local` (the default) or `remote` before starting the Compose topology.
A loopback bind alone does not keep a same-namespace tunnel connector from forwarding remote
browsers. These modes therefore control which listener serves the claim:

| Mode | Claim boundary |
|---|---|
| `local` | Claim page/API only on the separate `127.0.0.1:3083` bootstrap listener. `AUTOMAGIK_GATE_BOOTSTRAP_PORT` can change it, but it must differ from DSH and the main gate port. Main port 3082 returns `404` for claims, including requests with the correct code. **Never forward the bootstrap listener through a public or tailnet connector.** Reach it only from the operator's host or private SSH tunnel |
| `remote` | Claim page/API on main port 3082. The 128-bit code, delivered to the owner out of band, is the claim barrier. Choose this only when that delivery is trusted. Up to 64 wrong attempts can wait 250 ms outside the state queue; excess wrong attempts get `429` immediately without a timer. Disconnecting cancels the delay and releases its slot. The code is checked first, so a correct code always bypasses this limit and delay. Logs contain a failure count, never the code |

Until claimed, the main listener still binds only `127.0.0.1`, even with
`AUTOMAGIK_GATE_HOST=0.0.0.0`. After claiming, the default remains loopback, which is correct for
a tunnel connector sharing DSH's network namespace and forwarding **only main port 3082**. A host
deployment can use the wildcard setting after claiming; keep DSH on loopback and TLS in front
of the gate. The local bootstrap listener always stays on loopback and supports the owner's
authenticated follow-up steps, including adding the offered second passkey.

On the host, retrieve the code through the private gate container, outside captured logs:

```sh
docker compose -f server/compose.gate.yml --profile gate exec gate \
  /nodejs/bin/node -e 'process.stdout.write(require("fs").readFileSync("/data/claim-code","utf8"))'
```

This explicit host read is the only image bootstrap output. The image itself never prints the
code, even with a terminal attached. It writes `/data/claim-code` as `0600`; `/data/claim-state.json`
holds only its hash and expiry. Outside the image, an interactive gate writes to its host console
instead of making that plaintext file. The code is 128 random bits, works once for 15 minutes,
and is compared in constant time. HTTP never returns it; paste it only into the claim form,
never a URL. Local claims and recovery allow five operations per minute, with a bounded
challenge store. Remote claims use the per-attempt delay above instead of a drainable bucket.

In local mode, reach `/_gate/claim` at the configured browser origin while routing your private
host connection to bootstrap port 3083. For localhost, an operator-only SSH tunnel maps the
configured browser port to that bootstrap port inside the gate's namespace. For a stable HTTPS
name, use a host-local TLS proxy targeting the bootstrap listener and local name resolution;
the public/tailnet connector must continue targeting only main port 3082, never bootstrap.
In remote mode, the owner's browser reaches `/_gate/claim` through the normal main-port connector.
In both modes the browser must see the exact configured origin, including its port, that will
be used afterwards. Claim with a passkey, save the eight recovery codes shown
once, and use the immediate offer to add a second passkey. Two simultaneous claims cannot replace
the winner. Claim-code files are removed on success. DSH's launch URL never signs a browser into
the gate, including after the claim.

Every unauthenticated claim, sign-in or recovery ceremony also belongs to the browser that
started it. Options create a server-side pre-authentication session with a five-minute
`__Host-automagik-preauth` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no Domain).
Verification requires that same browser cookie as well as the one-time, expiring challenge.
Copying a ceremony id or response to another browser cannot complete it. Pre-authentication
credentials are never forwarded to DSH; a completed sign-in issues the ordinary gate session.

Afterwards use `/_gate/sign-in` and manage passkeys at `/_gate/settings`. Adding or removing a
passkey or replacing recovery codes ends **every** session, including open WebSockets; sign in
again with a registered passkey. At least one passkey must remain. Each recovery code is stored
only as an independently salted scrypt hash (`N=16384`, `r=8`, `p=1`). `/_gate/recovery` consumes
one code, logs only that recovery happened and a generated request id, revokes all sessions, and
authorizes only registering a new passkey. Sign in normally afterwards. No email reset exists.

An expired claim code can be replaced only by restarting an unclaimed gate or by this host command:

```sh
docker compose -f server/compose.gate.yml --profile gate exec gate \
  /nodejs/bin/node /opt/automagik/gate-control.mjs renew-claim
```

For a lost passkey and no recovery codes, the host operator can start a fresh claim:

```sh
docker compose -f server/compose.gate.yml --profile gate exec gate \
  /nodejs/bin/node /opt/automagik/gate-control.mjs reset
```

Both commands use `/data/control.sock` (`0600`) inside the gate container, never HTTP. Reset
removes all passkeys, recovery hashes and sessions, closes connections and returns the listener
to loopback before reporting success. It preserves the instance and local owner ids. Read the
new private code and claim again in the configured mode: local claims return only on the private
bootstrap listener; remote claims return on the main listener with the code barrier and delay.
A changed origin also stays on loopback: enrol the new origin
through recovery, which replaces the old origin's keys, or use host reset. It never silently
reopens the first claim. Unsupported newer authentication records stop startup without rewriting
them. An Access-created owner without passkeys needs an explicit host reset before switching to
self-hosted enrolment.

The gate protects against the network, not the instance's own Bots. Keep its store and host
control out of DSH's container, as Compose does. Bots can still reach DSH's own launch credential
on loopback. Settings also state the local-cookie limit: another localhost service can receive
and replay a cookie regardless of its port; local processes belong to the host trust boundary.

The tests use fresh keys in a software authenticator against the real WebAuthn verifier. They
cover wrong RP/origin/port/challenge/signature, verification flags, replay, expiry, concurrent
claims, recovery, revocation, the private reset socket and actual listener addresses. The image
smoke checks private claim output and host control in the built runtime.

## Interim Cloudflare Access sign-in

This optional mode gives the first owner a browser sign-in before workspace tokens (#909).
Configure the Access application and a policy allowing **only the owner's exact e-mail** on the
public name **before adding a tunnel route**. Point that route at the gate, never DSH, in its
shared network namespace. Keep the DSH listener off public ingress. The existing
`AUTOMAGIK_GATE_ENABLED=1` and exact HTTPS `AUTOMAGIK_GATE_ORIGIN` still apply.

Set these non-secret values on the gate container, using your own values on the host:

| Setting | Value |
|---|---|
| `AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN` | `{team}.cloudflareaccess.com`, host only, without a scheme, port or path |
| `AUTOMAGIK_GATE_ACCESS_AUD` | `{application-audience-tag}` |
| `AUTOMAGIK_GATE_ACCESS_EMAILS` | `{owner-email}`, or comma-separated exact addresses; trimmed and case-insensitive |

All three unset selects the self-hosted claim/passkey mode and opens no Access connection.
All three configured selects Access exclusively: no claim secret, passkey routes or host reset
socket is created. Existing passkeys remain stored but are not an alternate sign-in in Access mode.
Partial configuration refuses startup and names the missing settings. Every allowlisted address
gets the same local owner principal and full owner privileges: this is not a member/guest mode.
The first verified sign-in creates the random local owner record if absent; existing, malformed
or newer owner records are never overwritten. Workspace tokens will replace this interim mode.

The gate verifies only `Cf-Access-Jwt-Assertion`, never an e-mail header on its own, and exchanges
a valid assertion for the normal gate cookie. DSH credentials remain server-side. The verifier
uses the configured team's HTTPS certs endpoint and RS256, exact issuer, application audience,
timestamps and the exact e-mail allowlist. It never takes a key location from the token.
[Cloudflare's validation contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
describes the assertion header and certs endpoint. Tokens belong only in the assertion header,
never in a URL or log. Authentication failures log only a status and a generated request id.

Certs are fetched on demand, cached for at most five minutes, and refreshed on an unknown key
id at most once every 30 seconds. A fetch has a five-second deadline and a bounded response
size. A failed required refresh clears the cache and denies sign-in; stale keys are never used
as an outage fallback. The verifier permits 30 seconds of clock skew and checks time again
after the key fetch. A valid cached key remains usable until its bounded cache expiry.

Access sign-in sets the existing `__Host-automagik-session` cookie and uses the same idle,
rotation and replay rules. A stale or replayed gate cookie is refused even when Access supplies
an assertion; it never silently replaces a revoked family. Signing out ends gate sessions;
Access can still authenticate a new session after that cookie is cleared. End the Access
session too when signing out of the identity provider. Gate sessions retain the normal 12-hour
idle limit; Access policy enforcement at public ingress remains the operator's responsibility
until #909 supplies workspace-token revocation.

Access assertions are exchanged only on HTTP requests. WebSocket upgrades require an existing
gate session cookie and never create an owner, session or browser cookie. Complete HTTP sign-in
before opening a WebSocket.

The exact Host and Origin checks still apply. The signed assertion may establish the first
session on a safe top-level GET/HEAD navigation back from Access; cross-site mutations and
WebSockets stay refused. Gate management paths use the literal `/_gate/` prefix. Alternate
encoded, backslash, duplicate-slash or dot-segment spellings that enter that namespace get
`400` before sign-in in both modes, including WebSocket upgrades. Ordinary upstream paths
retain their raw spelling.

### Agent MCP access

A space with the Bot plugin exposes one separate agent entry through the gate:
`https://<SPACE_ORIGIN>/api/omni-mcp`. The owner creates a named bearer token in
**Settings → Agent access**. This exact HTTP path forwards only to the plugin's MCP handler,
which checks the token on every call and audits reads, writes and authentication refusals.
It supports MCP Streamable HTTP clients without a browser session or an Access exchange.

The gate pins Host and Origin, rejects cross-site requests, strips caller cookies and identity
headers, and supplies its own DSH credential only for that fixed upstream path. The plugin
still refuses missing, wrong or revoked agent tokens; a browser cookie alone never admits MCP.
Queries, alternate spellings and upgrades retain normal session authentication, as do all other
web routes. Gate-level Host/origin refusals use the gate audit; calls reaching the plugin appear
in the owner's activity list. No extra container port needs publishing.

For direct private-network access, the plugin's `agentAccessHost` and `agentAccessPort` configure
its separate listener; its defaults remain loopback and an OS-selected port. See the Bot
plugin's [MCP setup and tool reference](../apps/bots-dsh/README.md#agent-access-mcp).
