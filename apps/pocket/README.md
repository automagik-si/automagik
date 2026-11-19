# Automagik Pocket

Your coding agents on your Android phone: a companion app for herdr-core and Herdr desktop.
Android 8.0 or newer. Not an official Herdr release.

## Install

1. On your phone, open the [newest Pocket build](https://github.com/automagik-si/automagik/releases/download/pocket-lane/latest.json)
   and open its `url`: the `automagik-pocket-<version>.apk` on its Automagik release
   ([all releases](https://github.com/automagik-si/automagik/releases)). Builds up to v0.23.0 are on
   the archived [automagik-pocket](https://github.com/automagik-si/automagik-pocket/releases).
2. Have the old **Herdr Pocket** (`dev.herdr.pocket`) installed? Uninstall it first. It can't
   update to this app, and you'll pair again.
3. Open the APK. Allow your browser to install apps when Android asks.
4. Open **Automagik**.

Want to check the download first? See [SECURITY.md](SECURITY.md).

## Connect

The app connects through Pocket Link only.

1. On the computer, add the Pocket Link mod to Herdr desktop: follow
   [herdr/mods/pocket-link](../../herdr/mods/pocket-link/README.md). It needs Node.js 20.3+ and herdr-core,
   on macOS or Linux.
2. In Herdr desktop, press ⌘⌥P (Ctrl+Alt+P on Linux), then **Turn on**, then **Pair a phone**.
   A QR code appears.
3. In the app, tap **Pair with Herdr desktop**, then **Scan the QR code**. You can also paste the
   link.
4. Done. The code works once, for 10 minutes, and ends when you close the dialog.

Saved an SSH machine in an older version? It stays in **Settings**, greyed. Tap **Pair with QR**
on it and scan that computer's code; the old entry goes once it pairs
([RFC 0008](docs/rfcs/0008-drop-ssh.md)).

More detail: [docs/guides/using.md](docs/guides/using.md).

## What it does

- **Home:** agents that need you first, then the ones that finished, across your machines.
- **Team:** each project's bots, with their pets. The app opens here.
- **Code:** your spaces grouped by git repository, the desktop's spaces tree, and agents by branch.
- **Settings:** your machines and pairing, then the display, alerts and updates.
- **Terminals:** any agent full screen, with its tabs, a key row and a message composer.
- **Alerts:** Android notifications for Needs you and Done, with Reply, Yes/No and answer buttons,
  also while the app is open.
- **Watch in background:** stays connected while you're away and reconnects on its own.
- **Side-button assistant:** hold the side button, even on the lock screen, to see what needs you
  and answer by typing or speaking.
- **Updates itself** from GitHub Releases, in the background.
- **Automagik Stage theme,** light and dark, following the phone.

## Privacy and safety

- The app talks only to your own machines, plus GitHub to check for updates. Pocket Link traffic
  is end-to-end encrypted, even through n0's relays. The phone and your computer's Pocket Link
  bridge each publish their public key and the n0 relay they use (no IP addresses) to n0's
  address lookup, so they can find each other.
- No analytics, no ads, no account.
- Answering from the lock screen is off until you turn it on.
- Full policy: [docs/privacy.md](docs/privacy.md). Report a vulnerability: [SECURITY.md](SECURITY.md).

## Limits

- Pocket Link needs the desktop mod and Node.js 20.3+ on macOS or Linux.
- No SSH: a computer without Herdr desktop and the Pocket Link mod can't be reached.
- If Android stops the background service or the phone restarts, open the app and connect again.
- Spaces and tabs come from the desktop; the app doesn't edit them.
- The phone's keys can't be backed up. Uninstalling loses them; pair again.
- Opening a terminal on the phone can resize it on the desktop too.
- Needs herdr-core protocol generation 1. The older `herdr` TUI isn't supported.

## Updates

1. The app checks when it opens and every 6 hours while it or **Watch in background** runs. Or tap
   **Settings → About → Check for updates**.
2. On Android 12 and newer, once Automagik may install apps, a new version downloads on Wi-Fi and
   installs on its own after you leave the app. A quiet notification then says **Updated to X**.
3. Otherwise a notification says **Automagik X is ready**: Android 11 and older, a phone plan,
   **Install updates automatically** off, before you've allowed installs (the first tap asks), or
   when Android wants a confirmation. Tap **Install** and confirm.

Updating closes the app, and with it any connections; open it again to reconnect. A copy signed
with a different key (a debug build, a pull request artifact) can't update. Uninstall it once and
install the release.

## Build from source

```sh
cd android && ./gradlew :app:assembleGithubDebug
```

Requirements, tests and the emulator: [docs/guides/development.md](docs/guides/development.md).
How releases are cut: [docs/guides/releasing.md](docs/guides/releasing.md).

## Docs

Start at [docs/_index.md](docs/_index.md): guides, privacy, RFCs and decisions.

## License and attribution

Apache-2.0, see [LICENSE](../../LICENSE). The bundled xterm.js terminal is MIT.

Herdr desktop's program table and sidebar rules come from
[herdrdev/herdr-app](https://github.com/herdrdev/herdr-app) (Apache-2.0). The wire format follows
[herdr-core's API](https://github.com/herdrdev/herdr-core/tree/master/schema).
[juanibiapina/herdr-mobile](https://github.com/juanibiapina/herdr-mobile) was a protocol and SSH
reference; this app's UI and Kotlin protocol code were written for this project. All bundled
components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
