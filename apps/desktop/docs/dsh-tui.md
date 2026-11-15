# DSH in Herdr: the desktop's dsh-TUI setup

Herdr's `+` menu has a built-in **dsh-TUI** entry that appears when a `dsh-tui` command is on
Herdr's PATH. This page is the desktop app's opt-in step for that: it installs the pinned
`@deepseek-harness-tui/dsh-tui` into the user's own DSH, writes the `dsh-tui` shim, and shows
the existing doctor, update and uninstall paths in one place.

The installer itself is not here. It is `am/dshTui.mjs`, shared with `am dsh-tui` (`automagik-herdr` still works as an alias)
and the Herdr pack; this app imports it (see "How the app invokes it") and owns none of the pin,
profile, shim or pnpm rules.

## Where it is

The desktop app has no settings page of its own: Settings is DSH's page, and the first-run
welcome is the `welcome-dsh` plugin, which is its own lane. The app's own chrome is the title
bar, so the opt-in step lives there, next to **Check for Updates…**:

- right-click the title bar, or use the app menu, and choose **Set up DSH in Herdr…**;
- the app reads the doctor first and shows what is actually there: `dsh`, the `dsh-tui` profile,
  the shim, the shim's folder on the login shell's PATH, and dsh-TUI's first-run guide state;
- one dialog carries every action: **Install** (not installed), **Reinstall / update** (installed
  at the pin), **Repair** (installed but not the pinned one), **Uninstall**, and **Close**.

The menu entry is absent where the shim's shell cannot run (the native Windows build is off).
Nothing runs before the user picks an action, and nothing installs on first launch. Each action's
output is also appended to `dsh-tui.log` in the app's data folder.

## How the app invokes it

The app imports the shared module; it does not carry a second copy of its rules.

- `scripts/prepare-runtime.mjs` copies `am/dshTui.mjs` and its two local imports
  (`am/layoutSafe.mjs`, `am/release.js`) into `build/dsh-tui/`, which `electron-builder.yml`
  ships as the `dsh-tui` resource folder. The copy is a build product, not a committed fork.
- `src/dsh-tui.js` resolves it: the packaged resource folder in an installed app, the
  repository's `am/` in a checkout.
- `src/dsh-tui-run.mjs` runs one action (`doctor`, `install`, `update` or `uninstall`) in a child
  Node process, importing `dshTui.mjs`, and prints one JSON result. It ships beside the module,
  outside the app archive, so the packaged binary can run it as Node (`ELECTRON_RUN_AS_NODE`);
  a pnpm install never blocks the window.
- The runner asks the module for the login shell's PATH (`panePathOf`) and gives that PATH to
  every call: it is the PATH Herdr panes get, and the one the shim will run in. It uses the
  account's login shell from the OS when the app was started without `SHELL` (a desktop launch).

`install` and `update` are the same idempotent module call: it installs the exact
`@deepseek-harness-tui/dsh-tui` 0.19.0 pin into the `dsh-tui` profile (never `tui`, never the
reserved `desktop` profile), checks the registry integrity, records that it added the pin, and
writes the shim. The pnpm `minimumReleaseAgeExclude` is the module's too: exactly
`@deepseek-harness-tui/dsh-tui@0.19.0` while that version is younger than the profile's
`minimumReleaseAge`, and removed once it has aged. The desktop only displays the module's lines.

## PATH and the shim

The module writes the `dsh-tui` shim in the user bin folder, a `/bin/sh` script that runs
`exec dsh --profile dsh-tui "$@"` (the long form; dsh-TUI reads the profile name there). It also
checks that `dsh` is on PATH and exits 127 with a clear line when it is not.

That folder is not on every shell's PATH. When the doctor says it is missing, the setup asks once
and then appends a marked line to the login shell's own config file: `export PATH=...` for sh,
bash and zsh, and `fish_add_path` for fish. It never adds the line twice, and writes nothing
without that yes. Herdr must be restarted after the change: its `+` menu checks its own PATH. The
app writes no `programs.json`; Herdr's built-in `dsh-tui` entry already exists.

## Auth, sessions and limits

The app writes no credential and ships no key launcher. Sign in inside dsh-TUI with `/model`
(DeepSeek Account) or `/auth`; a `DEEPSEEK_API_KEY` already in the environment, or a key already
in DSH's credential store, also works. The module marks dsh-TUI's first-run guide done (its own
state record) when the user has not completed it, so a fresh pane does not stop on the wizard.

Sessions land in the user's DSH home (or the `DSH_HOME` the app was started with). DSH Desktop
shows them after it is quit and reopened; there is no live refresh.

## What it never writes

- DSH's reserved `desktop` profile, its settings or its credentials file: the module fingerprints
  them across the plugin step and fails rather than claim success if DSH changed them.
- The Automagik app's own settings or its private DSH home. This is the user's DSH, apart from
  the private home the app runs.
- Any provider key, environment file or key launcher.

## Update and uninstall

**Reinstall / update** calls the same module install, so a newer app release carrying a newer pin
moves the profile to it. **Uninstall** calls `uninstallDshTui`: it removes the plugin from the
`dsh-tui` profile, the exact release-age entry it added, and the shim only when the shim is this
installer's. Sessions, dsh-TUI's own state and the profile stay. A pin the module did not record
is left alone, with the module's line saying how to hand it over.

## Tests

`test/dsh-tui.test.js` covers the desktop's own layer: module paths and the shipped file list,
the dialog states (install, healthy, repair, uninstall, no DSH, unsupported host), the PATH line
(idempotent, per shell), the child runner's JSON and errors, and an end-to-end run of the runner
against a temp home and a fake `dsh` (install, doctor, update, uninstall, the exact skip line).
The installer's own rules stay covered by `herdr/test/dsh-tui.test.mjs`.
