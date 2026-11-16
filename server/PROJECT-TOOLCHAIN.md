# Per-project toolchain bootstrap (#1443)

Status: first deliverable. The bootstrap module, manifest and tests land now; the one call site
in `server/entrypoint.mjs` lands after PR 1427 merges, because 1427 has a single writer in
`server/first-boot.mjs` and `server/entrypoint.mjs` and this work does not become a second one.

The common server image stays project-agnostic: it still ships no Bun and no project tooling.
This module installs a project's own pins into that project's own persistent volume, and a
native worker then runs the project's real gate from that volume.

## Manifest

A project commits one manifest at:

```
<workspace>/.automagik-toolchain.json
```

`<workspace>` is `AUTOMAGIK_WORKSPACE` (`/data/workspace` in the image). The file belongs to the
project, travels with its source, and is reviewed like any other project file. The JSON Schema
is [`project-toolchain.schema.json`](project-toolchain.schema.json); this repository's own
manifest is [`.automagik-toolchain.json`](../.automagik-toolchain.json).

```json
{
  "schemaVersion": 1,
  "tools": {
    "bun": {
      "version": "1.4.4",
      "sha256": {
        "linux-x64": "…",
        "linux-arm64": "…"
      }
    }
  },
  "gate": { "command": "bun run check" }
}
```

Pinning rules, enforced by both the schema and the module:

- `version` is one exact `x.y.z` release. Tags, ranges, `latest` and prerelease spellings are
  refused.
- every platform an instance may run must pin a lowercase sha256 of the official release zip;
  a platform with no pin is refused before anything is written.
- the download URL is derived from the tool, the exact version and the platform
  (`https://github.com/oven-sh/bun/releases/download/bun-v<version>/bun-linux-<arch>.zip`).
  A manifest cannot name another URL.
- unknown fields, unknown tools and an absent gate command are refused. A typo cannot silently
  install nothing.

Only Bun is in the closed installer set today. Adding a tool is a deliberate code change to
`SUPPORTED_TOOLS` and its installer, never a project-specific image fork.

## Install location and layout

The install root is `<volume>/.automagik/toolchain`, where `<volume>` is `AUTOMAGIK_HOME`
(`/data`). The layout is deliberately the shape Bun itself uses when `BUN_INSTALL` points at a
directory:

```
/data/.automagik/toolchain/
  tools/bun/1.4.4/bun                         the pinned binary, 0755
  tools/bun/1.4.4/.automagik-install.json     version, platform, archive sha256, binary sha256/size
  bin/bun -> ../tools/bun/1.4.4/bun           the stable command path
  .staging/                                   per-run work space; stale entries are pruned
```

Versioned directories mean a later pin installs beside the old one instead of overwriting it;
the `bin` symlink is replaced atomically. Old versions are kept for rollback and are not
cleaned up by this deliverable.

## Guarantees

- **No manifest, no work.** The module reads the manifest first. If it is absent it touches no
  volume, creates no directory and calls no network.
- **Validate before write.** The whole manifest is checked, including a sha256 for the running
  platform, before the install root is created.
- **Pinned download only.** The archive is streamed into staging inside the project volume and
  hashed as it is written, with a ten-minute timeout and a hard byte cap. The hash must equal the
  manifest pin. The fixed `bun` member is then extracted with zip64, encryption, declared-size,
  CRC and unsupported-compression checks; the extracted binary is hashed again and recorded. Bun
  publishes Linux releases as ZIP and the image has no `unzip`, so the module carries a small
  streaming reader limited to that one fixed member rather than a general archive extractor.
- **Whole or absent.** A version directory is built under `.staging/` and renamed into place
  only after every check passes. A failed download, a wrong hash, a corrupt archive or a missing
  member removes staging and leaves no version directory and no `bin/bun` link.
- **Idempotent.** The install record plus the binary's recorded size are the second-run check. A
  second start with the same pins calls no network and changes no file or directory metadata.
- **Crash cleanup.** Staging entries older than six hours are removed before a new install, so a
  hard kill cannot leave a partial archive growing forever. A live install is never that old and
  is left alone.
- **Volume-confined.** Every write resolves under the project volume; an explicit root outside
  it is refused, and a symlinked component on the way to the root or to `bin`/`tools`/`.staging`
  is refused rather than followed. The module never writes `/opt/automagik`, `/usr/local/bin`,
  `HOME`, `/tmp` or the workspace.
- **No permission to publish.** This is preparation: it signs in to nothing, pushes nothing and
  changes no image.

## The native worker and the real gate

The manifest's `gate.command` is the project's real gate, not a generic substitute. For this
repository it is `bun run check`, the root `check` script in `package.json` (the version check,
`bun test scripts`, and the marketplace index check). A native worker runs exactly:

```sh
cd /data/workspace
PATH=/data/.automagik/toolchain/bin:$PATH \
BUN_INSTALL=/data/.automagik/toolchain \
BUN_INSTALL_CACHE_DIR=/data/.automagik/toolchain/cache \
bun run check
```

The PATH entry is what makes the nested `bun` commands inside the `check` script resolve to the
volume's Bun; `BUN_INSTALL` and `BUN_INSTALL_CACHE_DIR` keep Bun's own global and cache writes
inside the project volume. A worker that passes an environment directly can use
`gateEnvironment('/data/.automagik/toolchain')`, which returns the same `PATH`, `BUN_INSTALL`
and `BUN_INSTALL_CACHE_DIR`.

The gate itself is `bun run check`. A fresh checkout needs the same dependency preparation CI
runs before it, `bun install --frozen-lockfile --ignore-scripts`, once; dependency installation
is the project's own step, not tooling provisioning, and the gate command stays the project's
real root check.

## The one integration point, after 1427

PR 1427 owns `server/first-boot.mjs` and `server/entrypoint.mjs` and has one writer. This PR
does not edit either file and does not touch that worktree or branch. After 1427 merges, one
follow-up wires the bootstrap at exactly one point:

1. Package the module: add `server/project-toolchain.mjs` to the existing
   `COPY server/entrypoint.mjs … /opt/automagik/` line in `server/Dockerfile`.
2. In `server/entrypoint.mjs`, import the module and, immediately after the existing
   `runFirstBoot(...)` try/catch and before `let key`, add:

```js
import { bootstrapProjectToolchain } from './project-toolchain.mjs'

// …inside main(), after runFirstBoot:
try {
  const toolchain = await bootstrapProjectToolchain({
    volume: env.AUTOMAGIK_HOME,
    workspace,
    log,
  })
  if (toolchain.state !== 'absent') {
    log(`project toolchain: ${toolchain.state}; gate ${JSON.stringify(toolchain.gate.command)}`)
  }
} catch (error) {
  warn(`project toolchain: ${error?.message ?? error}`)
}
```

The call is awaited, not backgrounded: a worker must never see a toolchain that is still being
prepared, and a second start is a no-op. A failure is logged and startup continues, exactly as
the existing first-boot hooks do; the gate is then unavailable and the log names why. A project
with no manifest takes the absent path and nothing else changes.

`server/project-toolchain.mjs` also runs standalone, so the same preparation can be rehearsed
from a checkout of this branch before the entrypoint edit lands (the image does not carry the
module until the Dockerfile COPY above lands):

```sh
node server/project-toolchain.mjs --workspace /data/workspace --volume /data
```

## Verification

The module is covered offline by `server/test/project-toolchain.test.mjs`:

- a manifest with Bun installs it into the project volume, exposes `bin/bun`, and records the
  archive and binary hashes;
- a second run changes nothing and calls no network;
- a failed download leaves no half-installed tool (a network failure and a pin mismatch are
  both covered);
- a project with no manifest does nothing;
- a stored (uncompressed) release archive installs, and stale staging is pruned while a recent
  staging directory is kept;
- plus refusal coverage for unpinned manifests, a platform with no pin, an install root outside
  the volume, a symlinked root, `bin` or a dangling install path, an over-large declared download,
  malformed archives (duplicate, encrypted, zip64, unsupported compression, size lie), an archive
  without the expected member, and a corrupt archive that matches its pin.

This repository's real gate, run with the volume's Bun as above, is the acceptance evidence
after integration: the download is proven by the archive and binary hashes, and the gate by its
own exit code, not by a Node equivalent.

## Out of scope

- Any change to the common image, including adding Bun to it.
- Any per-project image fork or project tooling in the infra layer.
- Publishing, signing in, deploying, or pushing an image.
- Running the gate automatically; the native worker does that from the command above.
- Pruning older installed versions.
