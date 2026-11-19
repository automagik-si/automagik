---
title: "One shared debug signing key for Pocket PR builds"
type: decision
status: Accepted
created: 2026-11-10
updated: 2026-11-18
pr: "automagik-si/automagik#986"
tags: [decisions, build, signing, ci]
---
# One shared debug signing key for Pocket PR builds

Two debug APKs built in different worktrees carried different certificates, because each worktree
got its own debug keystore; one phone could install neither over the other. CI signs debug APKs with
one shared debug key from a repository secret (set by the owner), so PR APKs install over each
other. Local builds keep AGP's own debug key unless a keystore is provided.

## Decision

Taken by the Orchestrator on 2026-11-10, from the design in this pull request.

1. **A repository secret, never a committed keystore.** `POCKET_DEBUG_SIGNING_KEYSTORE` holds the
   base64 debug keystore. A keystore holds a private key, so it never enters git.
2. **One secret, the standard `android` password.** Alias `androiddebugkey`, store and key password
   `android`. The owner creates the key and sets the secret; the password changes only if the owner
   says so.
3. **A workflow artifact only.** The debug APK is a workflow artifact; the job needs no
   `pull-requests: write` permission and does not comment on the pull request.
4. **Fourteen days of retention** for that artifact.
5. **No RFC.** The never-change rule covers the release key and the app ID; both stay untouched, so
   a debug-only key does not need an RFC.
6. **Local gates keep their own default.** No copy of the shared key is provisioned on any host. A
   local build uses AGP's debug key unless `POCKET_DEBUG_STORE` (or `-Ppocket.debugStore`) points it
   at a keystore.

## Current state

- `apps/pocket/android/app/build.gradle.kts:41` reads `POCKET_DEBUG_STORE`, else
  `-Ppocket.debugStore`; `:70-71` creates the `sharedDebug` signing config from it.
- The debug build type picks the release key first, then `sharedDebug`, then AGP's default debug key
  (`apps/pocket/android/app/build.gradle.kts:79`). The release build type and
  `signingConfigs.pocket` are unchanged.
- With no path, debug builds keep AGP's default debug key, including the read-only-home fallback
  (`apps/pocket/android/app/build.gradle.kts:121-122`).
- `.github/workflows/ci.yml:658-676` decodes the secret to the runner's temporary folder and exports
  `POCKET_DEBUG_STORE`; `:685-698` prints `apksigner verify --print-certs` and uploads
  `app-debug.apk` as `pocket-debug-apk-<pr-or-run>` for 14 days; `:700-702` removes the file.
- Without the secret (a fork, or before the owner sets it), the job builds with the default key and
  uploads no APK. Fork pull requests cannot read repository secrets.

## Why not commit the debug keystore

A debug keystore still holds a private key, and this repository never commits one. The standard
debug credentials make it low risk, but they do not make it a public file; the shared key travels
through a repository secret.

## Verification

- Built with a throwaway keystore via `POCKET_DEBUG_STORE`, via `-Ppocket.debugStore`, and with
  neither: the first two APKs carried the throwaway certificate, the third the worktree's AGP debug
  certificate (the pull request has the fingerprints).
- Once the owner sets the secret, two PR runs must print the same certificate SHA-256, and their
  APKs must install over each other (`adb install -r`). A run without the secret prints no
  certificate and uploads no APK.
- The owner set the secret on 2026-11-10. Three PR runs since print the same certificate:
  `CN=Automagik-Pocket-PR-Debug`, SHA-256
  `095b43805012910686cd51880c621a85a1ed1071826af8338e1f4d267b8c0ab9` (runs 42929345512,
  42937994765 and 43353712566). The shared digest is what lets one phone install either PR's APK
  over the other. A physical install-over check on one device is the next render pass's.

## Risks

- A missing or rotated secret means no shared APK for that build; installed debug copies may need
  one uninstall. Release signing is unaffected.
- A same-repository branch can read the secret and sign its debug APK with it; that is the intended
  trust boundary for a debug-only key. Fork pull requests cannot.

## Open questions

None.

## Related

- [Development](../guides/development.md): the local default and the CI secret/artifact.
- [Releasing](../guides/releasing.md): how the release key signs published APKs.
