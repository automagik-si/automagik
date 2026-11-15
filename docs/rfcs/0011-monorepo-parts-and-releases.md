# RFC 0011: Monorepo parts and releases

| Field | Value |
|---|---|
| Status | Accepted (process in use; delivery unverified: open work #207 and #215; #250 Play flavor deferred to Pocket; #190, #203 and #210 merged 2026-11-03; the owner OKd one version and the jump) |
| Delivered | |
| Milestone | n/a (process) |
| Lanes | herdr (3.N.P), added here; pocket (3.N.P), added by Pocket's import |
| Created | 2026-11-03 |

## Summary

Automagik is one repository whose parts ship on their own: the desktop app, the DSH plugins, the
herdr pack, and Pocket, the phone app. Every release has the one version and the one tag
`vX.Y.Z`. A release rebuilds and attaches only the parts whose paths changed since the release
before, and each part's updater finds the newest release that carries its own asset (the desktop
app by its feed, the plugins and the herdr pack through a signed rolling pointer, Pocket through
the rolling `pocket-lane` release). A desktop-only
release never offers a pack update, and a pack-only release never cuts a desktop build.

This RFC covers the herdr part, imported from `automagik-dev/automagik-herdr` with its history,
and Pocket, imported from `automagik-dev/automagik-pocket` with its history ("Pocket" below: its
lane, the versionCode guard, `latest.json` on `pocket-lane`, the signing secrets, the bridge).

**Amended by [RFC 0012](0012-am-cli-and-parts.md) (D35, 2026-11-03).** `am` is its own part,
in a top-level `am/` folder, and the one exception to "a release attaches only the parts it
rebuilt": every `vX.Y.Z` release attaches `automagik-am-<v>.tgz` and re-signs a rolling `am-lane`
pointer with am's own key, whatever its lane kind. An am-only merge is a new lane kind, `am`
(3.N.P). `am-lane` follows `herdr-lane`'s rules below (check-key before the tag, fail-closed
posting, no lower sequence). RFC 0012's deliveries make the `release.yml` and `lane.ts` changes;
until they ship, this RFC describes the releases as they are.

## Motivation

The owner decided (2026-11-03) that the herdr pack and Pocket are Automagik, not standalone
products, and that everything ends up in this monorepo. The repository already releases on every
merge into `dev` (`.github/workflows/release.yml`), and every installed app takes those releases.
Importing a part therefore needs three things in the same pull request: a lane, so a change to the
part does not cut builds of the others; the part's own artifacts on the releases that rebuilt it;
and updaters that find their asset among releases that are mostly someone else's.

## Parts

| Part | Paths | On a release that rebuilt it | Its updater reads |
|---|---|---|---|
| Desktop app | everything not below (`apps/desktop/`, the profile, lockfiles…) | the dmg, AppImage and deb, `latest-*.yml`, `SHA256SUMS` | `apps/desktop/src/update.js`: the newest release with its platform's feed |
| Plugins | `apps/<plugin>/` | `automagik-<plugin>-<v>.tgz`, `plugins.json`, `PLUGINS.SHA256SUMS`, `lane.json` | the rolling `plugin-lane` release (`scripts/lane.ts`) |
| Server image | `server/` | GHCR image by digest, keyless GitHub build provenance, `server-image.json` on the content release | [server-lane/server-image.json](https://github.com/automagik-si/automagik/releases/download/server-lane/server-image.json); a rolling prerelease, never Latest, advanced only by stable content without downgrades; consumers verify the image attestation (`server/README.md`, Follow) |
| Herdr pack | `herdr/`, `herdr-layout/` | `automagik-herdr-pack-<v>.tgz` and `automagik-herdr-pack-<v>.tgz.sha256`; the `herdr-lane` pointer is re-signed | the rolling `herdr-lane` release (`scripts/herdr-lane.ts`), checked against the pack's `pack-keys.json` |
| Pocket | `apps/pocket/` (Pocket Link, `herdr/mods/pocket-link`, is on the herdr lane) | `automagik-pocket-<v>.apk` and `latest.json`; `latest.json` on the rolling `pocket-lane` release is replaced | `latest.json` on `pocket-lane` (`apps/pocket/android/app/build.gradle.kts`, `UPDATE_URL`) |

`herdr/` is a top-level folder because Herdr's crawler (herdr.dev) indexes top-level folders. The
herdr.dev listing waits on the owner's gate: no `herdr-mod` or `herdr-layout` topic is set on this
repository until then.

The pack's layout is its own top-level entry folder, `herdr-layout/` (`layouts/automagik.json`,
`RECIPE.md`, `preview.png`), not `herdr/layouts/`: the crawler skips the whole repository when a herdr-mod entry
folder holds `layouts/`, and a skip deletes a listing it had (probe-confirmed, t22n and t259). A
herdr-mod entry folder is any folder holding `mods/<name>/main.js`, as the mod manager reads a
package. `herdr/scripts/entries.mjs --check` fails when one holds `layouts/`; CI runs it on every
pull request and the release with the pack's gates. The probe's layout test
settled the shape: herdr.dev lists a layout only from its entry folder's `layouts/<name>.json`
and ignores a `.json` at the folder's root (e2 went unlisted for want of `layouts/`, not because of
its root `.json`: 60 listed layout entries hold one), and the entry needs no `mods/` of its own
(its RECIPE tells people to add `herdr/` first). `entries.mjs --check` also fails when `herdr-layout/` loses
that shape. Until then the mod manager,
which installs a package's own `layouts/`, no longer installs the layout with the pack from the
catalog; `install.sh` and the updater still do, from the tarball.

## Versioning

- One version (`bun scripts/version.ts`). It writes `herdr/package.json` and the pack's
  `herdr/mods/am-sidebar/VERSION`, a plain-text field (the version alone on one line, which the
  pack's updater reads). `herdr/scripts/version.mjs` only checks that the pack carries the root's
  version; the pack has no bump or release logic of its own.
- No `herdr-v*` tags. The import fetches no tags: the old repository's `v0.N.P` are not releases
  of this one.
- On its first monorepo release the pack jumps from automagik-herdr's v0.14.x (the final import is
  v0.14.1, `513f91ac`, its frozen `dev`) to the monorepo's 3.N.P. Semver only goes up, so every updater accepts
  it.

## Lanes

`scripts/lane.ts kind <last-full-tag> <last-tag>` and `scripts/lane.ts herdr <last-tag>` decide
what a release is and whether it attaches the pack:

| What shipped | Kind | Version | Attaches | Desktop build | Plugin lane | Market index |
|---|---|---|---|---|---|---|
| Since the last release (any tag), only `herdr/` | `herdr` | 3.N.P (next patch) | the pack | no | not re-signed | not re-pinned |
| Since the last release, only `apps/pocket/` (or `apps/pocket/` and the herdr part) | `pocket` | 3.N.P | the APK and `latest.json`, the pack when `herdr/` shipped | no | not re-signed | not re-pinned |
| Since the last full release, only plugins (and `herdr/`) | `plugins` | 3.N.P | the plugins, the lane, the pack when `herdr/` shipped since the last release | no | signed | pinned |
| Anything else | `full` | 3.(N+1).0 | everything, the pack when `herdr/` shipped since the last release | yes | signed | pinned |

- `herdr/` shipped since the last release when one of its paths changed that is neither never
  shipped nor a version-only bump. Never shipped in the part: its top-level `*.md`, `docs/`,
  `.genie/`, `mockup/`, `test/` and `catalog/` (installed mod managers read the catalog from `dev`
  directly). `herdr-layout/` is part of the herdr part: its `layouts/automagik.json` ships in the pack, its
  `RECIPE.md` and `preview.png` do not. The repository's own `docs/` ships nothing either (this change adds it to
  `NEVER_SHIPPED`; no build reads it).
- The herdr kind is measured since the last release of any kind, not since the last full one:
  measured since the full one, a herdr-only merge after a plugin patch would pack the plugins again
  and re-sign the lane, and every desktop app would reinstall plugins that did not change.
- A herdr patch, like a plugin patch, is not marked Latest; `main` still moves to it.

## The pack on a release

`release.yml`'s "Pack the herdr pack" step is the old repository's Pack step, under `herdr/`:

- From the tag, not the working tree: `git archive` of the tag's `herdr/mods/<PACK_MODS>` plus
  `herdr-layout/layouts/automagik.json` as `layouts/automagik.json` (inside the tarball, `layouts/` is where
  the updater and the installer look; in the repository it is never under `herdr/`). The folder list is the tag's
  `PACK_MODS` (`herdr/mods/am-sidebar/release.js`); every other folder of `herdr/mods/` but
  `pocket-link` must be in it, and the archive's top level must be exactly it plus `layouts/`.
- `automagik-herdr-pack-<v>.tgz.sha256` is `sha256sum` of the tarball alone: the same line the old
  release's `SHA256SUMS` held. It is named after the tarball because a full release's desktop build
  writes its own `SHA256SUMS` to the same release.
- The pack goes into `release/` before the plugins' `PLUGINS.SHA256SUMS` is written, so that list
  names it too: a full release's desktop build deletes any asset the list does not name (except
  `automagik-*.tgz`), and would otherwise delete the `.sha256`.
- The release re-runs the pack's CI gate before it tags, when `herdr/` shipped, and regenerates
  `herdr/catalog/index.json` in the release commit, as the old release did.

## Updaters and the installer

A release carries the pack only when `herdr/` changed, so most releases carry none, and the
`.sha256` beside a tarball comes from the same release, which proves integrity, not who published
it (t259). Both are answered by a signed rolling pointer, as `plugin-lane` answers them for the
plugins (`scripts/herdr-lane.ts`):

- A rolling `herdr-lane` release (a prerelease, never Latest) holds only `pack.json` and
  `pack.json.sig`. `pack.json` names the newest pack release: its version, tag and commit, the
  tarball's URL, sha256 and size, a monotonic `sequence` (3.N.P as N·10000 + P), the key id and the
  time it was issued. A release that rebuilt the pack uploads the pack to its own versioned release
  first, then rewrites both with `--clobber`. `--clobber` replaces each asset in turn, so a reader
  may briefly see a pointer and a signature that do not match, or neither; both fail closed (refused,
  or no update yet).
- The pointer never goes back: before it posts, the release downloads the posted pointer, and
  `herdr-lane.ts posted` refuses to post one whose sequence is lower than a posted pointer that
  verifies (a re-run of an older release's run). It fails closed: only "nothing posted yet" (no
  release, no assets) lets it post without that check; any other error reading the posted pointer
  stops the run. A posted pointer that does not verify (its key since removed from
  `pack-keys.json`, a bad signature, only one of the two files) is refused too, since its sequence
  cannot be trusted; an operator who has checked it dispatches the release with
  `replace_unverified_herdr_pointer=true` to post over it (#207, L1).
- `pack.json.sig` is ed25519 over the exact bytes of `pack.json`, detached and base64, as
  `scripts/lane.ts sign` makes `lane.json.sig`. It is made with a key of the pack's own, the
  `HERDR_PACK_KEY` Actions secret, never `PLUGIN_LANE_KEY` (t22n's recommendation, t259's ruling): a
  leak of one key does not reach the other part. The pointer's `keyId` is the `pack-keys.json` entry
  whose public key is the secret's, so any listed key signs under its own id. The release verifies
  what it signed before it posts it, and `herdr-lane.ts check-key` stops a release that would ship
  the pack before it tags when the secret is missing or its public key is not in `pack-keys.json`.
- The trusted public keys are `herdr/mods/am-sidebar/pack-keys.json`, which the pack tarball
  carries, so the installed copy is the trust anchor. `install.sh` embeds the same list
  (`TRUSTED_KEYS`; `herdr-lane.test.ts` keeps the two equal). Rotation is in two phases ("Making
  the key").
- The pack's updater (`release.js`, `update.mjs`, the sidebar's check through `updateCheck.js`)
  reads `releases/download/herdr-lane/pack.json` and its `.sig`, one request each, verifies the
  signature against the installed `pack-keys.json` (`node:crypto`), offers the pack only when its
  version is newer than the installed one (an older pointer, replayed, offers nothing), and checks
  the downloaded tarball against the sha256 the pointer names before anything is written. No
  pointer yet (404) means no pack released here: no update. A missing signature, a key the pack
  does not list, a signature that does not match, or a tarball whose hash differs is refused.
  Releases are never listed or searched.
- `herdr/install.sh` does the same: the pointer, its signature against its embedded keys (Node is
  checked before it reads them), then the tarball from `releases/download/v<v>/` against the
  pointer's sha256, before anything is written. It never downgrades: it refuses a pointer whose
  version is older than the installed one or whose sequence is lower than the one it recorded
  (the marker's `version=` and `sequence=`; update.mjs records the sequence on every install and
  update through the pointer, and a rollback restores the kept set's). Someone who can write
  release assets but has no key can re-post an older signed pointer; a re-run of the installer then
  stops and says how to downgrade on purpose. `--version <v>` installs a named release, older ones
  included, and checks it against that release's `.sha256` alone, and says so (integrity, not who
  published it); it records no sequence. The
  one-liner is `curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash`;
  `main` moves to every release, so it serves the released installer.
- Tests sign their fixtures with a key generated per run (`herdr/test/pointer.mjs`,
  `scripts/herdr-lane.test.ts`) and pass it only through the file:// test mode
  (`AUTOMAGIK_HERDR_PACK_KEYS`, honoured for a file:// release URL alone), never for a GitHub URL.
  No private key is committed.
- The mod manager's catalog is `https://raw.githubusercontent.com/automagik-dev/automagik/dev/herdr/catalog/index.json`.
  The old repository's two catalog URLs count as written by the pack: an install or update rewrites
  them to the new one, and until then the mod manager reads the new one. The index names the pack as
  `automagik-dev/automagik`, path `herdr`.

### Making the key

`HERDR_PACK_KEY` was created on 2026-11-03 as key id `herdr-pack-2026-11` (fa21806 committed its
public key). `scripts/lane.ts` has no key command (it
only reads `PLUGIN_LANE_KEY`), so how that key was made is not recorded here. This is the
documented process for the pack's key, with the same key type and format as the plugin lane's
(ed25519, PKCS#8 PEM in the secret, SPKI PEM in the keys file):

```sh
bun scripts/herdr-lane.ts keygen --key-id <id>   # --repo automagik-dev/automagik
```

It generates an ed25519 pair in memory and pipes the private key to `gh secret set` on its stdin:
it is never printed and never written to disk. Only when that succeeds does it add the public key
under its key id to `pack-keys.json` and to `install.sh`'s `TRUSTED_KEYS`; both are committed in a
pull request. It refuses a key id `pack-keys.json` already lists.

There are two secret slots, `HERDR_PACK_KEY` and `HERDR_PACK_KEY_NEXT`. The repository variable
`HERDR_PACK_SIGNER` names the one releases sign with (`HERDR_PACK_KEY` when unset). keygen never
writes that slot: the first key goes to `HERDR_PACK_KEY`, and any later key goes to the other slot.
A rotation is two phases:

1. Ship the new public key. `keygen --key-id herdr-pack-<yyyy-mm>` puts the new private key in the
   slot that is not signing and adds the public key to both files. Releases keep signing with the
   old key, so every pack released from then on carries both public keys, under a pointer installs
   already trust.
2. Switch the secret, later, once installs have taken a pack that lists the new key:
   `gh variable set HERDR_PACK_SIGNER --body <the new slot>`. The next release signs with the new
   key, and its `keyId` follows. An install still on a pack that lists only the old key refuses
   the new pointers, so wait long enough for installs to update. Retire the old public key from
   both files in a later release, and leave its slot for the next rotation.

Switched too early, nothing is installed wrongly: those installs stop updating until they reinstall
with `install.sh`. A release whose secret is missing or unlisted stops at `check-key`, before it
tags.

## CI

- `ci.yml`'s `herdr` job runs the old repository's gate from `herdr/`, on the newest Node 22 and
  on 24. Two floors (t22n's ruling): the pack's users run it on Node 22.7 or later (the launcher,
  `install.sh`), and its tests need the newest Node 22, as the stubs use `module.registerHooks`
  (22.15+). No stub fallback: `node --test 'test/*.test.mjs'`, `node --check` on every pack mod and
  script, `sh -n` and `shellcheck -s sh` on the installer and the CLI's shell scripts,
  `node scripts/catalog.mjs --check`, `node scripts/version.mjs check`. It runs when `herdr/`, the
  CI or release workflow, or `scripts/lane.ts` or `scripts/version.ts` changed. The other jobs are
  unchanged; the `repo` job's `bun run check` covers the pack's version fields.
- am-quota's Keychain tests run against the stand-in `security` in `herdr/test/am-quota-keychain.mjs`,
  and `am-quota-keychain-guard.test.mjs` fails any that could reach the real one.
- The old repository's workflows were deleted at the import (`herdr/.github/`).
- Pocket: `ci.yml`'s `pocket` job (JDK 17, the Android SDK 35) runs automagik-pocket's
  `android.yml` gate from `apps/pocket/android` (`:app:assembleDebug :app:testDebugUnitTest
  :app:lintDebug`) and the terminal page's Playwright test. It runs when `apps/pocket/`, the root
  `package.json` (the version Gradle reads), the CI or release workflow, or `scripts/lane.ts` or
  `scripts/version.ts` changed. The `pocket-link` job (Linux and macOS, Node 22) runs the old
  `pocket-link.yml`, syntax and bridge tests, when `herdr/mods/pocket-link/` or `ci.yml` changed.
  automagik-pocket's workflows were not copied (`apps/pocket/.github/` was deleted at the import);
  its commitlint is the monorepo's.

## Importing a repository with its history

- `scripts/import-herdr.sh` clones the source's `dev` into a temporary folder, runs
  `git filter-repo --to-subdirectory-filter herdr` there (never in this repository), and merges it
  with `--allow-unrelated-histories`, without tags. It refuses a history that holds a database, a
  key or an `.env`. filter-repo is deterministic, so a re-run before the cutover merges only the
  source's newer commits.
- `commitlint.yml` skips only the history an import brought. An import merge is a merge whose
  second parent's history never reaches this repository's own first commit (the root of dev's
  first-parent line), and its imported commits are those reachable from that second parent and not
  from its first. The final re-run adds a second such merge, and only its new upstream commits are
  skipped. Every other commit is checked: the pull request's own, ones after dev is merged in, and
  those of a branch of this repository merged with `--no-ff`. `scripts/import-pocket.sh` does the
  same for automagik-pocket in two filter-repo passes (all of it under `apps/pocket/`, then Pocket
  Link's folder and the files around it, including the old automagik-pocket-link history's root
  `mods/pocket-link/`, to `herdr/mods/pocket-link/`). It also refuses a keystore,
  `local.properties` or `signing.properties` anywhere in the history. The herdr import has ten commits whose
  bodies run past 100 characters; they stay as the source wrote them.

## Bridge and cutover (after this change)

1. The monorepo publishes the first release that carries the pack (the first merge after this
   change that ships something under `herdr/`), with `HERDR_PACK_KEY` set and the `herdr-lane`
   pointer signed.
2. automagik-herdr cuts one bridge release from v0.14.x. It ships this verifier and
   `pack-keys.json`: its `release.js`, `update.mjs` and `install.sh` read this repository's
   `herdr-lane` pointer and check it against the keys it carries, as here. An installed 0.x
   takes the bridge from automagik-herdr with the hash check alone (that release's `.sha256`), so
   the bridge release is the trust anchor for every 0.x install; from then on each update is the
   3.N.P the signed pointer names.
3. An installed copy is seen to update across the bridge; then automagik-herdr is archived with a
   README pointer here.

Until the bridge, installed packs keep updating from automagik-herdr.

## Pocket

Pocket is the Android app (`ai.namastex.automagik`) and Pocket Link, its desktop mod. The owner
decided (2026-11-03) that it ships only as a part of Automagik: no separate listing, no Pocket step
in the herdr.dev layout entry. `scripts/import-pocket.sh` imported automagik-pocket `dev` with its
history: the app and its docs under `apps/pocket/`, Pocket Link under `herdr/mods/pocket-link/` (its
README, recipe, keys, licence and preview beside the mod, as the pack's mods keep theirs).

### Lane

- `pocket` (`apps/pocket/**`). `scripts/lane.ts pocket <tag>` says whether a release rebuilds the
  app: a shipping `apps/pocket/` change since the build phones have, version-only bumps aside. That
  tag is `scripts/lane.ts pocket-since`: the version `pocket-lane`'s `latest.json` names, or the last
  release when there is no lane yet. It is not simply the last tag, because a prerelease never moves
  `pocket-lane`. A Pocket change that shipped only in a prerelease (or whose lane post failed) is
  therefore still ahead of the lane, and the next release builds it again, even when that release
  changes nothing under `apps/pocket/`. Never shipped in the part: its top-level `*.md`, `docs/`, unit tests (`test/`) and
  `android/scripts/` (the terminal page's test, the vendoring script).
- A release whose shipping changes since the last release are all under `apps/pocket/`, or under
  `apps/pocket/` and the herdr part (`herdr/`, `herdr-layout/`), is a `pocket` patch: 3.N.P, the APK (and the pack when `herdr/`
  shipped), no desktop build, no plugin tarballs, no new plugin lane, no market pin, not Latest.
  With plugins or the app in it, the release is a `plugins` patch or a `full` release that also
  builds the APK; Pocket never makes one.
- Pocket Link (`herdr/mods/pocket-link`) is under `herdr/`, so a change to it is on the herdr lane
  (the pack is rebuilt; it never carries Pocket Link). Its bridge tests are `ci.yml`'s `pocket-link`
  job. The pack's catalog (`herdr/scripts/catalog.mjs`) and its no-LaunchAgent test leave it out:
  it is Pocket's, never in `PACK_MODS`.

### Version and versionCode

- Gradle reads the root `package.json` version (the one version); `version.properties` and
  `scripts/version.sh` are gone.
- `versionCode = major*1_000_000 + minor*1_000 + patch` (3.57.0 is 3057000). A minor or patch of
  1000 would give two versions one code (3.1000.0 and 4.0.0), so minor and patch stop at 999:
  `bun scripts/version.ts set` and `next` refuse more, `scripts/lane.ts next-patch` refuses
  3.N.1000 (cut 3.(N+1).0 instead), and Gradle refuses to build one. The release workflow sets the
  version through `version.ts`, so it refuses it too. `bun scripts/version.ts code <v>` prints the
  code; the Pocket job checks the APK's versionCode against it.
- The jump: automagik-pocket's builds used minutes since 2025 (v0.21.0 was 966485, about 966 000 in
  November 2026), and any 3.N.P is at least 3 001 000, so installed phones accept it. The
  `-Ppocket.versionCode=` override stays for local self-update tests.

### Release

- Before the cut, when `pocket` is yes: the `cut` job checks that `POCKET_SIGNING_KEYSTORE` and
  `POCKET_SIGNING_PASSWORD` exist (it reads only whether they are set) and runs the unit tests and
  lint, so a failing app or a missing key stops the run before a tag.
- After it, the `Pocket` job builds the release APK from the tag, signed with the key from those
  secrets (decoded to the runner's temp folder and removed after the build). It checks the APK's
  versionName (the tag) and versionCode (the formula), then attaches `automagik-pocket-<v>.apk` and
  after it `latest.json` (`versionCode`, `versionName`, `url` on that `vX.Y.Z`, `sha256`, `notes`) to
  the release. The asset is no longer `automagik.apk`: a monorepo release is shared, and phones take
  the URL from `latest.json`, never from a name.
- Then, unless the run is a prerelease, a small `pocket-lane` job (`needs: [cut, pocket]`) takes the
  `latest.json` from `vX.Y.Z` and replaces the one on `pocket-lane`.
- `desktop-build.yml`'s sweep of a full release's assets spares `automagik-pocket-*.apk` and
  `latest.json`.

### Updater: the rolling `pocket-lane` release

Installed phones read `https://github.com/automagik-dev/automagik/releases/download/pocket-lane/latest.json`
and nothing else; the APK stays on its own `vX.Y.Z` release. `-Ppocket.updateUrl=` (or
`pocket.updateUrl` in `gradle.properties`) still points a fork or a local test server at its own.

Why not the old URL, and why not the releases API (t16r's ruling, 2026-11-03, after measuring this
repository that day):
- `releases/latest/download/latest.json` (automagik-pocket's) cannot work here: a pocket patch is not
  Latest, and the Latest release is usually a desktop build without Pocket.
- "The newest release carrying `latest.json`, via the releases API" was the plan. This repository
  cut 91 releases in 10 days (about 9 a day), and the API returns about 33 KB of JSON per release
  (100 releases come to 3 MB). Every 6-hour check would download 0.3 to 3 MB over mobile data,
  growing as Pocket releases get rarer than desktop ones. A window of pages would lose a Pocket
  release older than about 11 days. And the unauthenticated API allows 60 calls an hour per IP,
  which carrier NAT shares across many phones; a 403 means no updates.
- A rolling release, as #190 settled for herdr (`herdr-lane`): one small file, no API, no rate limit,
  no window.

The rolling release is never taken for a release:
- Its tag is not `v*`. `apps/desktop/src/update.js` takes only `v`-prefixed tags with its platform's
  feed. `release.yml`'s last-release and last-full-release lookups read `git tag --list 'v3.*'`
  filtered by `^v3\.N\.P$`. `scripts/version.ts` and `scripts/lane.ts` read only v3.N.P tags. Follow
  Omni reads Omni's releases by `^v<semver>$`. None can take `pocket-lane`, `herdr-lane` or
  `plugin-lane`. `scripts/pocket-lane.test.ts` and `apps/desktop/test/update.test.js` check each.
- It is created once with `--prerelease --latest=false` and never edited (no `gh release edit`):
  later runs only `gh release upload --clobber` its `latest.json`. So it is never Latest and never
  flips prerelease. The same test checks that only the Pocket job writes it, only `latest.json`, never
  in a prerelease run, and never to a lower versionCode.

Trust: `latest.json` is not signed (`herdr-lane` signs its `pack.json` with ed25519). That is
acceptable because the pointer cannot make a phone install anything the release key did not sign:
- Android installs an update only when the APK is signed by the installed app's key (the same-signer
  rule). The key is only in this repository's secrets.
- The app downloads only an `https://` URL, checks the APK's SHA-256 against `latest.json` before it
  hands it to the installer (`Release.matches`), and offers only a versionCode above the installed
  one (`UpdatePolicy.isNewer`). `ReleaseTest` covers both.
- So a forged or stale `latest.json` (someone with write access to the releases, or a bad run) can
  point at nothing installable or at an older build: at worst it denies updates until the next good
  release replaces it. The herdr pack runs code from a tarball with no such check, which is why its
  pointer is signed.

Races: `herdr-lane` is posted by the `cut` job, and `pocket-lane` by the `pocket-lane` job, which runs
after the cut and the Pocket build. They are separate releases holding separate files. On `vX.Y.Z`,
the Pocket job adds only its own two assets, so the two never write the same asset. The Pocket build
is in no concurrency group, so every release that rebuilt Pocket gets its APK and `latest.json`.
Only the `pocket-lane` job takes turns, in the `pocket-lane` group, so two runs never interleave on
the pointer. GitHub keeps at most one job waiting in a group and drops an older waiting one when a
newer one arrives, even with `cancel-in-progress: false`. The newer one is always a later
non-prerelease release whose APK built (a prerelease or a failed build never enters the group), so
the pointer still ends on the newest build. The job also never moves it to a lower versionCode, so
an older run that finishes last leaves it alone.

### Signing secrets

`POCKET_SIGNING_KEYSTORE` (the keystore, base64) and `POCKET_SIGNING_PASSWORD`: the same release key
automagik-pocket used, so installed phones accept the monorepo's builds. The owner adds them to this
repository's secrets. They are never printed, and the key is never regenerated (every installed copy
would have to uninstall). The import's own merge ships `apps/pocket/`, so it does not merge before
the secrets exist: that release would stop at the secrets check.

### Bridge and cutover

1. The monorepo publishes the first release that carries Pocket (the import's merge), which creates
   `pocket-lane`.
2. automagik-pocket cuts one bridge release: same key, same app ID, its default `pocket.updateUrl` set
   to `pocket-lane`'s `latest.json`. Its versionCode is still minutes since 2025, below every 3.N.P,
   so a phone takes the bridge from automagik-pocket, then the monorepo's builds.
3. An installed phone is seen to update across the bridge; then automagik-pocket is archived, never
   deleted, with a README pointer here. Its releases stay: phones that have not taken the bridge yet
   download it from there.

Until the bridge, installed phones keep updating from automagik-pocket.

### Names and the Parts manifest (RFC 0012)

No `part.json` comes with this import. The names it adds are the lane kind `pocket`, the release
`pocket-lane` and the asset `automagik-pocket-<v>.apk`; none is a part id, a capability, a
`parts.json` field or an `am` verb, so `apps/pocket/part.json` can take its own id and name this
artifact later.

## Open questions

1. `herdr/catalog/repos.json` lists Pocket Link as an external entry at `automagik-dev/automagik-pocket`,
   and am-mods' read-only row, its refusal message (`herdr/mods/am-mods/core.js`) and am-footer's
   comments name that repository. They still work after the archive (the repository stays, with a
   pointer here). Repointing them to `herdr/mods/pocket-link` needs an external entry with a path,
   a change to the pack's catalog and manager, so it is left to the pack. (t22n)
2. The Play build (automagik-pocket PR #31) is the Play session's call; if it moves, it moves into
   `apps/pocket/`. (t16r)

Resolved (t259's review, t22n's rulings, 2026-11-03):
- Commitlint skips only what an import merge's second parent brought, and keeps working across the
  final re-run's second import merge.
- The 100-release window: replaced by the signed rolling `herdr-lane` pointer in this change; no
  releases search, no paging. Its key is `HERDR_PACK_KEY`, the pack's own, never `PLUGIN_LANE_KEY`.
- The bridge release ships the verifier and `pack-keys.json`; its own hash-checked update is the
  trust anchor for 0.x installs.
- `HERDR_PACK_KEY` exists (2026-11-03): key id `herdr-pack-2026-11`; its public key is in
  `pack-keys.json` and `install.sh` (fa21806).
- No downgrade (t259's re-review, H1): install.sh refuses a pointer older than what is installed,
  by version or by recorded sequence, and the release refuses to post a lower sequence.
- Key rotation in two phases, the keyId taken from the secret's public key (t259's re-review, M3).
- The Node floors: users' runtime Node 22.7 or later (the launcher, `install.sh`); tests on the
  newest Node 22 (22.15+, for `module.registerHooks`) and 24; no stub fallback.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #207, #215.
- Deferred to Pocket: #250 (Play distribution) - RFC 0011 Open question 2.
- Merged changes that cite this RFC: #190, #203, #210, #278, #791, #806 (last merged 2026-11-09).
