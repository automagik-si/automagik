---
title: "Development"
type: guide
created: 2026-11-01
updated: 2026-11-10
tags: [guide, build, test, contributors]
---
# Development

Build, test and run Automagik Pocket from source. Releases are in [releasing.md](releasing.md).

## 1. Set up

1. Install JDK 17 (CI uses Temurin 17). Gradle 8.11.1 also runs on JDK 21; it does not run on
   very new JDKs, so point `JAVA_HOME` at 17 or 21 if Android Studio bundles a newer one.
2. Install Android SDK Platform 36 and Build Tools 35.0.0.
3. Tell Gradle where the SDK is:

   ```sh
   printf 'sdk.dir=/absolute/path/to/Android/Sdk\n' > android/local.properties
   ```

`local.properties` is ignored by git. The Gradle wrapper is pinned to its distribution checksum.

## 2. Build, test, lint

```sh
cd apps/pocket/android
./gradlew :app:assembleGithubDebug :app:testGithubDebugUnitTest :app:lintGithubDebug \
  :app:testPlayDebugUnitTest :app:lintPlayDebug
```

This is the same gate CI runs. From the repository root, use `scripts/capped-run --lock` as
shown in [AGENTS.md](../../../../AGENTS.md). The GitHub debug APK is
`android/app/build/outputs/apk/github/debug/app-github-debug.apk` relative to `apps/pocket/`.

**Debug signing.** A local build uses the debug key AGP creates for the worktree, unless the release
key is present (then it uses that). When the `POCKET_DEBUG_SIGNING_KEYSTORE` repository secret is
set, CI signs PR debug APKs with one shared debug key, so two PR APKs install over each other. A run
with the secret uploads the APK as the `pocket-debug-apk-<number>` artifact (the PR number, or the
run number on a push) for 14 days and prints its certificate. Without the secret, CI uses the
runner's default debug key and uploads no APK. To build locally with a keystore you provide, set
`POCKET_DEBUG_STORE` (or `-Ppocket.debugStore`) to its path; alias `androiddebugkey`, password
`android`. The environment variable wins over the Gradle property, and a relative path resolves
against `apps/pocket/android/app/`.

**16 KB pages.** Play requires every native library to support 16 KB memory pages. JNA is pinned
to 5.17.0 (`android/app/build.gradle.kts:147`) because iroh-android 1.2.0 brings 5.15.0, whose
`libjnidispatch.so` isn't 16 KB aligned. Drop the pin when iroh-android depends on JNA 5.17 or newer.

## 3. Run it

**On a phone:** from `apps/pocket/`, run `adb install -r android/app/build/outputs/apk/github/debug/app-github-debug.apk`.
The minimum is Android 8.0 (API 26).

**On an emulator:**

1. Create a device with an x86_64 or arm64 image, API 26 or newer. 32-bit x86 images won't run
   it: the APK ships only arm64-v8a, armeabi-v7a and x86_64 (`android/app/build.gradle.kts:27`).
2. Install the APK as above.
3. Without a machine, use **Settings → About → Explore the interface with sample data**.
4. To pair, paste the Pocket Link link instead of scanning: the emulator camera can't see a real
   QR code.

A debug build signed with a different key than the installed copy can't replace it. Uninstall
first. CI's shared-key PR APKs have the same certificate, so they replace each other.

## 4. More tests

**Against a real herdr-core.** Unit tests skip these unless you point them at `hc`:

```sh
cd android
HERDR_TEST_HC=/absolute/path/to/hc ./gradlew :app:testGithubDebugUnitTest --rerun
```

They start their own core sessions with temporary XDG state, config and runtime folders, and stop
only those.

**Terminal page (Playwright).** CI runs it on every pull request:

```sh
python -m pip install playwright && python -m playwright install chromium
python android/scripts/test_terminal.py
```

It covers zero-height parents, keyboard resize and input, touch scrolling in history and in
full-screen programs, keeping the scroll position as output arrives, **↓ Latest**, and pinch to
resize text.

**Terminal assets.** xterm.js is bundled, so an Android build doesn't need Node. To refresh the
pinned assets, run `android/scripts/vendor-terminal.sh` with npm available. It transpiles xterm for
older Android WebViews.

## 5. The release key

Releases are signed with one key. Android only updates an installed copy with an APK signed by the
same key.

- **CI** reads two repository secrets: `POCKET_SIGNING_KEYSTORE` (the PKCS12 keystore, base64) and
  `POCKET_SIGNING_PASSWORD`.
- **A maintainer's machine** keeps the key in `~/.config/herdr-pocket/`: the keystore, a password
  file, and `signing.properties` with `storeFile`, `passwordFile` and `alias` (default `pocket`).
  The environment variables `POCKET_SIGNING_STORE` and `POCKET_SIGNING_PASSWORD` override it
  (`android/app/build.gradle.kts:30-35`).
- With the key present, debug builds are signed with it too, so a build from Android Studio and the
  releases update each other. Without it, builds are debug-signed (section 2).
- Never commit a key: `*.jks` and `*.keystore` are in `.gitignore`. Never regenerate the key;
  every installed copy would have to uninstall.
- A fork signs with its own key and sets `pocket.updateUrl` in `android/gradle.properties` to its
  own `latest.json`.
- To test self-update on an emulator, build an older copy with `-Ppocket.versionCode=1` and a
  normal one, both with `-Ppocket.updateUrl=http://10.0.2.2:PORT/latest.json`, and serve the newer
  APK and its `latest.json` from the computer. GitHub debug builds may use plain HTTP to
  `10.0.2.2` (`android/app/src/githubDebug/`).

## 6. Where things are

App code, `android/app/src/main/java/ai/namastex/automagik/`:

| File | What |
|---|---|
| `Model.kt` | Machine profiles, terminal records, the desktop layout reader, frame codec |
| `CoreClient.kt` | Framed JSON-RPC to herdr-core, events, terminal channels with flow control |
| `LegacySsh.kt` | Machines saved over SSH before [RFC 0008](../rfcs/0008-drop-ssh.md): re-pair with QR, then delete the old key |
| `IrohLink.kt`, `PairScreens.kt` | Pocket Link pairing and sessions |
| `PocketViewModel.kt` | Connections, inventory, selection, terminal lifecycle, input order |
| `MainActivity.kt`, `Screens.kt`, `ProjectScreens.kt`, `Cockpit.kt`, `Projects.kt`, `Nav.kt`, `Sidebar*.kt` | Compose UI |
| `TerminalScreen.kt`, `assets/terminal/` | Terminal view and its key and message controls |
| `KeyInput.kt`, `TerminalModes.kt` | Key row modifiers, cursor and paste encoding |
| `Notify.kt`, `Alerts.kt`, `Prompt.kt`, `WatchService.kt` | Notifications, buttons, background watch |
| `AssistActivity.kt` | Side-button assistant panel |
| `Theme.kt` | Automagik Stage colours, light and dark |

The GitHub updater, its UI and network policy live in `android/app/src/github/` and
`android/app/src/githubDebug/`. The Play flavor's update hooks live in `android/app/src/play/`.

Desktop mod: `herdr/mods/pocket-link/` — see its [README](../../../../herdr/mods/pocket-link/README.md) and
[RECIPE](../../../../herdr/mods/pocket-link/RECIPE.md).

## 7. Commits and pull requests

- Work in a branch or worktree, open the pull request into `dev`.
- Every commit subject is conventional: `type(scope): description`. CI rejects others
  (`.github/workflows/commitlint.yml`). The type decides whether a merge cuts a release; see
  [releasing.md](releasing.md).
- A change to a contract, privacy or permissions needs an RFC first:
  [RFC 0000](../rfcs/0000-rfc-process.md).
