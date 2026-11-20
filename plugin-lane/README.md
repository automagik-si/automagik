# The plugin lane

Plugins have a route of their own, apart from app releases. A plugin release reaches the
Automagik desktop app, and any market that serves plugins (Omni's), without a new app, a
new Omni or a new Genie.

A publisher puts two files on a rolling GitHub release named `plugin-lane`:

- `lane.json`, the newest plugins.
- `lane.json.sig`, its signature: ed25519 over the exact bytes of `lane.json`, detached,
  base64.

The rolling release holds nothing else. Every tarball stays on its own versioned release,
which never changes, so a consumer that cached a version can always serve it again.

For Automagik's plugins the URLs are:

- https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json
- https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json.sig

`keys.json` in this folder lists the public keys, `{ keys: [{ keyId, publicKey }] }`, with
`publicKey` in PEM (SPKI). A consumer pins them in its code. Two keys may be listed at once
while one is rotated.

## lane.json, schemaVersion 1

```json
{
  "schemaVersion": 1,
  "publisher": "automagik",
  "keyId": "automagik-2026-10",
  "sequence": 220001,
  "issuedAt": "2026-10-26T03:00:00Z",
  "repository": "https://github.com/automagik-si/automagik",
  "version": "3.22.1",
  "commit": "<the release commit, 40 hex>",
  "base": "3.22.0",
  "plugins": [
    {
      "name": "@automagik/bots-dsh",
      "version": "3.22.1",
      "url": "https://github.com/automagik-si/automagik/releases/download/v3.22.1/automagik-bots-dsh-3.22.1.tgz",
      "integrity": "sha512-…",
      "sha256": "<64 hex>",
      "size": 3305405,
      "engines": { "dsh": ">=0.2.1-rc.3 <0.2.2-0" }
    }
  ]
}
```

- `sequence` grows with every lane a publisher issues. A consumer refuses a lane with a
  lower sequence than the last one it took, so an old lane can't be replayed or rolled back
  to. Automagik's sequence is 3.N.P as N·10000 + P.
- `base` is the app release the plugins were built against. The desktop app takes a lane
  only on the same 3.N line, at or past `base`. An app on another line waits for its own
  release.
- `integrity` is the npm and pnpm SRI (sha512). `sha256` and `size` describe the same bytes.
  A consumer checks them before it unpacks anything.
- `engines.dsh` is the plugin's own range. A consumer skips a plugin its DSH is outside of.
- A consumer takes from a publisher's lane only the plugins that publisher owns, and trusts
  only that publisher's keys for it. Automagik's lane names `@automagik/bots-dsh` and
  `@automagik/welcome-dsh`. Genie's lane (automagik-si/genie, keyId `genie-2026-10`) names
  `@automagik/genie-dsh`.
- Genie's `base` is the oldest app its plugin runs on, not an app release line. The app
  takes Genie's lane on any version at or past that base.

## Publishing (Automagik)

`.github/workflows/release.yml` does this on every release. `scripts/lane.ts` does each step:

1. `kind` decides between a plugin patch and a full release. A merge into dev that changes
   only the plugins (apps/bots-dsh, apps/welcome-dsh) is released as a patch, 3.N.P, with
   the plugin tarballs and no desktop build. A patch is never the Latest release. Anything
   else is a full release: the app itself, a plugin's dependencies, lockfile or engines, or
   its DSH harness.
2. `manifest`, `sign` and `verify` write the lane from the release's `plugins.json`, sign
   it, and check it.
3. The workflow uploads both files to `plugin-lane`.

The signing key is the `PLUGIN_LANE_KEY` Actions secret. It exists only there.

Every versioned release that packs `bots-dsh`, including prereleases, also carries the official
role catalog `roles.json` and its detached signature `roles.json.sig`, signed with the same key.
The rolling `plugin-lane` release holds only `lane.json` and `lane.json.sig`.

## Consuming

- **The desktop app** (`apps/desktop/src/lane.js`):
  - It looks at the lane a minute after it starts, then every 15 minutes, using the same
    recurring interval as app updates. Checks continue even when there is no newer version.
  - It downloads, checks and unpacks a lane meant for it, then stages it.
  - The next start puts the plugins in place before DSH starts. That start is a trial: the
    page must draw the Bot team within 45 s. Otherwise the previous plugins come back and
    that version is never taken again.
  - The sidebar's Restart button, a quit, or a start while the person is away makes that
    start.
- **Omni's market** reads the lane, checks the signature and sequence, drops versions below
  its floor or outside `engines.dsh`, and serves the rest. `OMNI_PLUGIN_LANE=off` turns that
  network call off.
