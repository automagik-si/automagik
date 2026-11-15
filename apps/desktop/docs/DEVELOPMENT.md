# The Automagik desktop app: how it is built

The [README](../README.md) is for people who use the app. This page is for people who build, release or change it.

It is Automagik's Bot team on a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) of its own, with the plugins already in it: the Bot team and the welcome from this repository (`apps/bots-dsh`, `apps/welcome-dsh`), and Omni's channels and canvases from one Omni release (`omni.json`). The app carries Automagik's version (`3.N.0`, the repository's), like the plugins built beside it.

Until 2.261023.x it was automagik-dev/omni-desktop, versioned as the Omni release it carried, and until 3.261023.x it was named Omni. Its last release there is this app, so an installed omni-desktop updates into it and then follows this repository's releases. On its first start an update moves the profile from the old plugin names (`@automagik/omni-dsh`, `@automagik/omni-ai-dsh`) to the new ones, keeping every setting row, and the Bot team's home is untouched (`src/dsh.js` `migrateRenamed`).

### The name and the installed identity

The app is **Automagik** wherever a person sees it: the bundle and its menu bar, the window, the update notice (`src/identity.js` `PRODUCT`), the desktop entry's Name, the dmg and the artifacts (`Automagik-<version>-…`), and in what an installed copy is known by. Builds up to 3.11.x kept the identity Omni shipped; one of those does not update into this one, it is installed afresh.

| Identity | Why it matters |
|---|---|
| appId `ai.namastex.automagik` | macOS (Squirrel) installs an update only for the same bundle id and signer; TCC permissions and preferences are filed under it. |
| `~/.automagik` (`src/dsh.js` `automagikHome`, `$AUTOMAGIK_HOME`) | the preload, the builds the CLIs download, and the app's own `desktop/` folder (below). |
| Electron's userData `…/Automagik` (`src/identity.js` `dataPathsOf`) | `main.js` pins it before anything reads it: the page's storage, each Bot browser's partition and the single-instance lock. |
| Linux: executable `automagik`, desktop entry id `automagik.desktop` (`desktopName`), deb package `automagik` | the window's app id and WM class, `/usr/bin/automagik` and the AppArmor profile match, and a new deb upgrades the installed package. It installs to `/opt/Automagik`. |
| the `automagik://` scheme (`src/deeplink.js`) | Automagik's own links (RFC 0013): `automagik://open`, which Herdr's Work button opens. They only bring the app forward. |
| the `omni://` scheme, the `omni-desktop` client id, `window.omniDesktop` | Omni's protocol names: what Omni's pages, its API and the plugins use. `omni://` is also `automagik://`'s alias; only it connects (`omni://connect`). |

There are no keychain items to carry: Electron keeps its cookies unencrypted (the cookie-encryption fuse is off), nothing reads or writes the secure token store yet (`src/secure-tokens.js` waits for its setting), and its credentials are the files above.

What an updated install shows: the update into the rename is announced by the installed app, so that one notice still reads "Omni <version> is ready"; after the restart the window, title bar, later notices and (macOS) menu bar and About say Automagik. On macOS the updater replaces the bundle where it is, so it stays `/Applications/Omni.app` (with `CFBundleName` and `CFBundleDisplayName` Automagik and the executable `Contents/MacOS/Automagik`), and Finder, Launchpad and the Dock may keep showing the file's name until the person renames it; a fresh install from the dmg is `Automagik.app`. A versioned AppImage is replaced by `Automagik-<version>-linux-x86_64.AppImage` in the same folder (electron-updater keeps a name without a version as it is).

> Labs: macOS (Apple silicon, signed and notarized) and Linux x64 (AppImage, deb; also WSL with WSLg). Windows itself is not supported.

## Install from the command line

```sh
omni desktop      # Omni's CLI: opens it with Omni preloaded
genie desktop     # Genie's CLI: opens it with Genie preloaded
```

downloads the build for this machine from this repository's releases, checks it against the release's `SHA256SUMS`, and opens it with `--preload=omni` or `--preload=genie`. Or download the dmg, AppImage or deb from [Releases](https://github.com/automagik-si/automagik/releases).

### The preload

`--preload=omni|genie` (or `AUTOMAGIK_PRELOAD`) says which product the app was opened for. It is a preference, not another build: the launch that passes it saves it in `~/.omni/desktop/preload`, so later launches from the Dock or a desktop entry keep it, and the app hands it to DSH as `AUTOMAGIK_PRELOAD`. The welcome's team step lists that product first and starts with it chosen; the other stays a click away, then or later. No flag and nothing saved is no preference. The profile is the same either way.

## How it works

- Electron's main process starts dsh with Electron's own Node (`ELECTRON_RUN_AS_NODE`), on `127.0.0.1` and a free port, and opens the launch URL dsh prints with its per-launch token. Quitting stops dsh.
- Everything the app keeps is in one folder, `~/.automagik/desktop` (`$AUTOMAGIK_HOME/desktop`):

  | Folder | What |
  |---|---|
  | `dsh/` | dsh's home (`DSH_HOME`): its Sessions, settings, and the `omni` profile the app copies in from the build |
  | `bots/` | the Bot team's home (`AUTOMAGIK_BOTS_HOME`): the team, the companion's picture, and `omni.json`, the Omni this app is linked to (0600) |
  | `bin/` | `node` and `pnpm` for dsh, written at each launch: both run on the app's own Electron as Node, so installing a plugin (Settings → Plugins, the market) needs nothing on the machine |
  | `logs/dsh.log`, `logs/update.log` | dsh's output, and the update checks |

  It is apart from a dsh you already run (`~/.dsh`) and from the Bot team installed into that dsh (`~/.automagik/bots`). The app sets no `OMNI_HOME`: an Omni sandbox and the Bun Omni's channels download are in Omni's own `~/.omni`.
- The window is a plain page: context isolation and the renderer sandbox are on, there is no Node in it, it stays on dsh's origin, and web links (a `wa.me` link, docs) open in your browser. Other schemes are refused.
- The window's own frame (`src/shell.html`, `shell.css`: the title bar, the update notice and the splash while dsh starts) wears the clay theme of the app inside, light or dark as the system is set (`prefers-color-scheme`). Before dsh's page paints, it and macOS's window show the clay table (`frame.js` `TABLE`, from Electron's `nativeTheme`), so a light system sees no dark flash. macOS has no vibrancy: clay is matte. Manrope and DM Sans are bundled in `src/fonts` with their licences (SIL OFL 1.1).
- Linux sandbox: Chromium needs user namespaces or a setuid helper, and Ubuntu 24.04+ restricts user namespaces. The deb installs an AppArmor profile that allows them for the app, so the window is sandboxed. An AppImage cannot carry one; on such a system its launcher runs without the sandbox and says so on stderr. Prefer the deb there.
- An AppImage opened directly is mounted with FUSE and needs `libfuse2` (`sudo apt install libfuse2t64` on Ubuntu 24.04+; WSL rarely has it). `omni desktop` needs none: it unpacks the AppImage once into `~/.omni/desktop/app/extracted/` and runs it from there. By hand: `./Automagik-*.AppImage --appimage-extract`, then `squashfs-root/AppRun`.
- Its profile switches DSH's own welcome notice and credential step off (`profile/cordis.patch.yml`), so the octopus opens the app.
- The app updates itself from this repository's releases (`v<version>`, the same ones `omni desktop` downloads; `src/update.js`). A release without desktop files (no update feed) is skipped. It checks 20 seconds after start and every 15 minutes afterward, even when the previous check found no newer version. Plugin lanes use the same 15-minute interval, with their first check one minute after start. Failed checks also schedule a retry after 30 minutes (or one minute for a transient failure, up to three times); periodic checks continue independently. It also checks from **Check for Updates…** (the macOS app menu, or a right click on the title bar). A build follows its own release's channel: stable builds skip prereleases, and prerelease builds take both (`OMNI_DESKTOP_UPDATE_CHANNEL=stable|prerelease` overrides it). A newer build downloads in the background, and its sha512 is checked. The title bar then shows a notice with **Restart now** and **Later** (`frame.js` `updateView`, drawn by `shell.js`), and quitting installs it too. On macOS the update must carry the installed app's own signature, so only signed releases offer one. On Linux the AppImage updates itself when opened as an AppImage. A deb only says a newer release is out, and **Download** opens its release page. An AppImage unpacked by `omni desktop` updates by opening a newer one. Set `OMNI_DESKTOP_UPDATES=off` to turn updates off, or `OMNI_DESKTOP_UPDATE_FEED` to take them from another feed folder (https, or http on loopback). Every check is logged in `logs/update.log`, including "up to date".
- An update replaces the profile's packages and keeps everything you set: a setting a newer build ships is added to your `cordis.patch.yml` only when your file has no entry with its id, and `pnpm-workspace.yaml` is added when missing.

## DSH in Herdr (dsh-TUI)

The title bar's menu has **Set up DSH in Herdr…** (a right click, or the app menu). It imports
the shared installer `am/dshTui.mjs` — the same module `am dsh-tui` (`automagik-herdr` still works as an alias) and the Herdr
pack use — through a child runner (`src/dsh-tui-run.mjs`), and shows the module's doctor before
any action. `prepare-runtime` copies the module, its two local imports (`am/layoutSafe.mjs`,
`am/release.js`) and the runner into `build/dsh-tui`, shipped as a resource outside the app
archive; a packaged app reads `process.resourcesPath/dsh-tui`, a checkout reads `am/` and
`src/`. The menu is absent where the shim's shell cannot run (the native Windows build is off).

The dialog installs the exact `@deepseek-harness-tui/dsh-tui` pin into the `dsh-tui` DSH profile,
writes the `dsh-tui` shim Herdr's built-in entry finds in the user bin folder, and offers the
login shell's PATH line when that folder is missing. Update is the same idempotent install;
uninstall is the module's `uninstallDshTui`. It never writes DSH's credentials, its reserved
`desktop` profile or the app's settings. See [docs/dsh-tui.md](dsh-tui.md).

## Which plugins it carries

The Bot team and the welcome come from this repository at the same commit (`apps/*-dsh`, at the app's version). `omni.json` pins the Omni release whose channels and canvases the app carries: its version and commit. The build packs each plugin with `npm pack` and refuses one at another version. It also refuses a dsh other than the one the plugins are tested on (`runtime/package.json` against `apps/bots-dsh/dev/harness` here and Omni's `apps/omni-channels-dsh/dev/harness`).

`follow-omni.yml` (repository root) checks Omni's releases every 30 minutes. When Omni has cut a newer one tested on the same dsh, it moves `omni.json` to it on dev and cuts an Automagik release (`release.yml`), which builds the app (`desktop-build.yml`).

## Build

```sh
npm ci                  # Electron and electron-builder
npm test                # the main-process logic, without Electron
npm run dist:linux      # dist/Automagik-<version>-linux-x86_64.AppImage and -amd64.deb
npm run dist:mac        # on macOS: dist/Automagik-<version>-mac-<arch>.dmg and .zip, signed and notarized (see macOS)
```

The profile also ships the add-on that connects AI subscriptions DSH does not sign in to, from Omni's reviewed fork at the commit `profile/package.json` pins (the version it holds is under `omni.addonVersions`, and the build checks it): `@goodandready/dsh-subscriptions` ([automagik-genie/dsh-subscriptions](https://github.com/automagik-genie/dsh-subscriptions), the plans DSH doesn't sign in to itself, with no updater of its own). Claude comes through DSH's own pi-ai route (a Claude Pro or Max sign-in, or an Anthropic API key, in Connect AI); an update takes Oh My Claude out of a profile an earlier build installed with it (`RETIRED` in `src/dsh.js`). The profile is installed the way DSH installs any plugin, with the pinned dsh's own `dsh plugin --profile omni install` (pnpm, hoisted, no install scripts), so its pnpm lockfile ships with it.

`dist:*` first runs `scripts/prepare-runtime.mjs`: it packs the Bot team and the welcome from `../bots-dsh` and `../welcome-dsh`, fetches Omni at `omni.json`'s commit (only its plugin folders) into `build/omni`, installs the pinned dsh into `build/runtime`, and installs the packed plugins into `build/profile`, in one install. Set `OMNI_SOURCE` to a local Omni checkout to pack its channels and canvases instead. Native packages are per platform, so build each target on its own platform. Builds run with `DO_NOT_TRACK=1`.

To run from a checkout: `npm run prepare-runtime`, then `npx electron .` (add `--no-sandbox` on a system where Chromium's sandbox cannot start unpackaged).

### The Cmd+W contract

Cmd+W reaches the web client's `page.close` command by its key (`src/pane-close.js`), so `prepare-runtime` fails the build when the installed `@deepseek-ai/dsh-client-ui-sidebar-right` no longer registers that command on primary+alt+W for the web runtime on macOS. After a dsh bump that trips it, cut `test/fixtures/page-close/` again from the new bundle and check Cmd+W still closes a pane.

### Patches to DSH

`runtime/patches` holds changes the app makes to the pinned dsh until DeepSeek ships them. `prepare-runtime` applies them to `build/runtime` once npm has installed it (`scripts/runtime-patches.mjs`). `patches.json` pins each patch to the exact dsh version, each package's version and each file's sha256 before and after. Another version or hash, or a hunk that does not apply, fails the build; a file already at its after-hash is left alone. `follow-dsh.mjs` moves the patch version guards with the runtime pin, but deliberately preserves the file hashes and hunks: this is not evidence that the patch applies. Verify the new release's actual package bytes with `patchRuntime` before accepting the bump. If those bytes changed, port the patch on that dsh's files and regenerate it with `diff -u`; never discard or weaken the hash guards to make a build pass.

Agent Teams use rc.2's named subagents. A fresh `subagent` accepts `provider`, `model` and `reasoning_effort` when model selection is enabled; `list_subagent_models` lists allowed routes. `subagent_fork` keeps the parent's route. The former `teammate-models.patch` is removed because its experimental packages and `spawn_teammate` no longer exist. Two follow-ups remain: `list_agents` no longer shows each member's route, and model-selection allowlists are captured when a Session starts rather than applied live to running sessions.

- `frontend-static-index-cache.patch` (dsh 0.2.2-rc.2): the SPA index (`/` and the configured index path) answers `cache-control: no-cache` with a weak ETag of the rendered bytes, and a matching `If-None-Match` gets an empty 304 — the validator non-index assets already carry in this release — and authorization still runs before the bytes are read. Without it a normal reload after a plugin update can keep a stale manifest and client bundle; the release-change reload prompt is already in this dsh, and the server image applies the same patch. It carries no `Last-Modified`: a plugin update can rewrite the manifest without touching `index.html`'s mtime, so only a content ETag validates the served document. **Delete it in the DSH release that serves the index with cache directives.**

- `client-connection-cookie-lax.patch` (dsh 0.2.2-rc.2): the browser-session cookie is `SameSite=Lax` instead of `Strict`, so a launch link opened from a phone camera or QR — a top-level cross-site navigation — reaches `./` with the cookie and does not get the 401 failed-authentication page (#632). `HttpOnly`, the computed `Secure` attribute and the 303 are unchanged; the desktop runtime and the server image both apply this patch. **Delete it in the DSH release whose browser-session cookie is Lax.**

- `web-launch-token-persistence.patch` (dsh 0.2.2-rc.2): `dsh web` records the launch URL
  (with its per-process token) in `$DSH_HOME/launch-url`, mode `0600`, replacing the previous
  start's file without partial content (a brief absence is possible while it is replaced) and
  removing it when the profile shuts down. A write that fails is reported, never fatal: the URL
  line still prints, even when the temporary file cannot be cleaned up. Without it a `--no-open`
  start whose stdout was lost has no way back to the URL, and a 401 tells the caller to reopen a
  URL that cannot be obtained (#361). The 401 wording names the file; it is carried in
  `client-connection-cookie-lax.patch`, which owns that one file, so each patch still applies to
  the pinned package on its own. The file is a credential: never log or commit it. The desktop
  launcher reads it when dsh's output is unavailable and removes a previous start's before it
  spawns; a removal that fails is logged, and the start continues. The desktop runtime and the
  server image both apply this patch. **Delete it in the DSH release that persists the launch URL
  itself.**

- `layout-widths-persistence.patch` (dsh 0.2.2-rc.2): the client layout saves the sidebar and right panel widths in localStorage under `dsh.layout.widths` and restores them when the client plugin reloads, so a reload no longer resets them to 280 and the 45% first-open width (#483). It persists the width the user chose on a drag or a right panel open, keeps that right panel preference when the viewport shrinks (the renderer's 300..70% clamp is display-only), reopens the sidebar at its last positive width after a collapse, restores a hand-stored sidebar `0` as 280 (a collapse is runtime state, not a preference), and ignores missing, unreadable or invalid stored values. The desktop runtime and the server image both apply this patch. **Delete it in the DSH release whose ui-layout persists the panel widths itself.**

### The icon

`assets/icon.svg` is the icon's source: the approved three-colour triskle (`assets/triskle-three-colours.svg`, a byte copy of the final logo set's large drawing; `src/art/SOURCE.json` records it) on the set's ink ground (`#1e1923`), drawn as the app's rounded clay tile. electron-builder makes every platform's icons from `assets/icon.png`, which is the SVG rendered by headless Chromium (`--no-sandbox` where its sandbox cannot start; the SVG loads `triskle-three-colours.svg` beside it):

```sh
chrome-headless-shell --screenshot=assets/icon.png --window-size=1024,1024 \
  --default-background-color=00000000 --hide-scrollbars "file://$PWD/assets/icon.svg"
```

## Measured (labs prototype, 2026-10-20, Linux x64)

| | |
|---|---|
| AppImage | 251 MB |
| deb | 208 MB |
| dsh runtime, unpacked | 864 MB (145 MB of it is LibreOffice WASM for document previews) |
| Memory after start, idle | about 1.0 GB RSS across Electron's processes and dsh (dsh itself about 290 MB) |

## macOS

Releases are signed with the Developer ID Application certificate and notarized in CI (`desktop-build.yml`, with the `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` secrets). Without them the dmg is unsigned and the release offers no macOS update.

`npm run dist:mac` on a Mac signs with the certificate in its login keychain, under the hardened runtime (`assets/entitlements.mac.plist`), and notarizes when `APPLE_KEYCHAIN_PROFILE` names a `notarytool` profile:

```sh
xcrun notarytool store-credentials omni-notary   # once
APPLE_KEYCHAIN_PROFILE=omni-notary npm run dist:mac
```

Signing reads the login keychain, so run it from a Terminal in the Mac's own session (over ssh the keychain is locked).

The dmg is signed, notarized and stapled too (`electron-builder.yml` `dmg.sign`, and `desktop-build.yml` sends it to Apple's notary and writes its new checksum into `latest-mac.yml` with `scripts/restamp-feed.mjs`). Every release is the repository's Latest and also carries `Automagik-Mac.dmg`, `Automagik-Linux.AppImage` and `Automagik-Linux.deb`, and the same files as `Omni-Mac.dmg`, `Omni-Linux.AppImage` and `Omni-Linux.deb` for links made before the rename, so `releases/latest/download/<name>` always fetches the newest. `omni desktop`, `genie desktop` and the updater read only the versioned names, and match them by what follows the version (`-linux-x86_64.AppImage`, `-mac-arm64.dmg`), so the name in front can change.
