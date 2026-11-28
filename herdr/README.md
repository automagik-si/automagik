# Automagik Herdr

Autonomous teams of coding agents across harnesses (Claude Code, Codex, Antigravity, Kimi, Oh My Pi…)
with a main bot, captains and members, running in [Herdr](https://dev.herdr.app).

The pack lives in the [Automagik monorepo](https://github.com/automagik-si/automagik) under
`herdr/`, and ships on its releases with its one version (`v3.x`): a release carries the pack
(`automagik-herdr-pack-<v>.tgz`) when `herdr/` changed since the release before. v0.14.x was the
last release line from the old `automagik-dev/automagik-herdr` repository.

<!-- hero: docs/hero.png, a sidebar screenshot with a team running -->

## Install

On macOS or Linux with Node 22.7 or later:

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-si/automagik/main/herdr/install.sh | bash
```

The installer checks Node and [Herdr](https://dev.herdr.app) (herdrdev's app, bundle id
`dev.herdr.app`; another app named Herdr, penso/herdr-gpui, is a different app and does not load this pack).
If Herdr is missing, it asks before running Herdr's own installer,
`curl -fsSL https://releases.herdr.dev/app/install.sh | sh`, which needs no root: on macOS (Apple
silicon) it puts `Herdr.app` in `~/Applications`; on Linux (x86_64 or ARM64) the app in
`~/.local/share/herdr-app`. Both link `herdr-app` into `~/.local/bin` and add `herdr-core` and
`hc` when there are none. Install Node from [nodejs.org](https://nodejs.org) first on Linux;
Node installation through Homebrew is offered only on macOS.
It reads the signed pack pointer (the `herdr-lane` release's `pack.json`,
checked against the keys the installer carries), downloads the pack it names
(`automagik-herdr-pack-<v>.tgz`: every mod below and the `automagik` layout; a desktop-only release
has none), checks it against the sha256 the pointer names before writing
anything, and installs every mod into `~/.config/herdr-app/mods/` as one unit. It links the
`am` command (and `automagik-herdr`, its alias) into `~/.local/bin`, merges the pack's keys where they are free (a key
you already use stays yours), points the mod manager at the pack's catalog (`herdr/catalog/` here), and runs
`herdr-app check` on each mod.

On a machine where Herdr has never opened, the installer leaves `keys.json` absent so
Herdr can create its native shortcuts, including terminal copy/paste. Open Herdr once,
then rerun the installer to add the pack's free shortcuts. The Mods button in the footer
works before its shortcut is added. Existing key files and personal bindings are preserved;
a `keys.json` that is a link (your own file) is left as it is, and the installer names the
pack's shortcuts for you to add there.

**What a release contains.** From v0.5.0, every release is one pack: `automagik-herdr-pack-<v>.tgz`
holds nine mod folders and one layout, and nothing else:

| Folder | What you get |
|---|---|
| `am-sidebar` | the sidebar: spaces, bots, workers, the Create form, the `am` command |
| `am-footer` | the footer rail (Bots, Mods, Automations, Accounts, Settings, Add machine) |
| `am-status` | the bottom status bar, with the pack's version and its update check |
| `am-tabs` | the tab bar |
| `am-new-menu` | the `+` menu (a space row's `+` and the tab bar's `+`) |
| `am-markdown` | the terminal's right-click menu with its Markdown files |
| `am-mods` | the mod manager (`⌘⇧M`) |
| `am-automations` | the automations panel; installed switched off, turn it on in the Mods panel (it needs the `herdr-automations` scheduler: `install.sh` installs the build the pack pins, and where it is missing the panel shows the command that installs it, with an Install button) |
| `am-quota` | the Accounts panel (your own CLIProxyAPI's accounts); installed switched off, turn it on in the Mods panel |
| `../herdr-layout/layouts/automagik.json` | the layout that shows all of the above (its own folder: herdr.dev skips a pack folder that holds `layouts/`) |

Releases up to v0.4.x shipped `automagik-herdr-<v>.tgz` instead: the sidebar alone (under its
old folder name, see [From v0.2 to v0.4.x](#from-v02-to-v04x)), with no footer, tab bar, `+` menu, Markdown menu, mod manager, automations or quota. A
checksum and a version number don't tell the two apart; the folder list does. After installing,
the installer prints `Installed the pack <v> in <mods>: <folders>`; that list must name all
nine. To check an install later:

```bash
sed -n 's/^mods=//p' ~/.config/herdr-app/automagik-herdr/installed-by-install.sh
# am-automations,am-footer,am-markdown,am-mods,am-new-menu,am-quota,am-sidebar,am-status,am-tabs
```

It never touches anything it did not install:

- its record (`~/.config/herdr-app/automagik-herdr/installed-by-install.sh`) lists every folder
  it put in `mods/`, and only those are ever replaced, updated or rolled back;
- a folder of the same name that you installed yourself (say your own `am-footer`, or one under
  its name from before v0.5.0) is reported and left alone; `--adopt` takes it over, after moving it to
  `automagik-herdr/backup/<mod>-<date>/`, where it stays until `--uninstall` puts it back;
- the folders an install or update replaces are kept together in `automagik-herdr/.prev/`;
- each mod's `.state/`, other dot paths and `node_modules` move into its new copy (a linked
  `.state` stays a link), and Pocket Link (`mods/pocket-link`) is never read, written or moved
  (`--uninstall` only checks that it is there, to leave the usagemeter it shares).

It adds the `automagik` layout (Herdr's main layout with the whole pack in place) when you have
none, and replaces it only while it is the unchanged copy v0.2 to v0.4 shipped. The pack shows
only in a layout that names it, so while Herdr shows another one the installer asks before
switching (or prints the `herdr-app do layout.switch` command when it can't ask). A layout of
your own that shows the sidebar keeps its blocks: the installer only renames the pack mods it
names (from v0.4.x, below), lists the pack pieces it lacks and points at the pack's copy to take
their blocks from (see [Wiring](#wiring-your-layout)); or switch to the `automagik` layout. Running it again is safe.
Add options after `bash -s --`: `--yes` answers every question, `--version 3.58.0` installs that
Automagik release (one that carries the pack), `--adopt` takes over same-named mods,
`--uninstall` moves the pack out of `mods/`, puts back what it adopted and removes the layout if
the installer added it and you haven't changed it. It is refused, with nothing moved, while the
layout Herdr shows uses a pack mod or is that layout: switch layouts first (ctrl-shift-l, or
`herdr-app do layout.switch '{"name":"main"}'`). A layout inside a linked `layouts/` folder is
yours and stays. With Node, the layout and the folders leave through the installed pack's
updater (`update.mjs pack-out`, one move that fails undoes the others); without Node, or with an
older pack, through the installer itself, and it says which. If the updater stops partway, nothing
more moves and the record stays: it says which folders are already in the kept set and which are
still in place.

It also installs usagemeter, the token meter (`meter/usagemeter` in this repository), to
`~/.local/bin/usagemeter`: the build for your OS and architecture that the signed `meter-lane`
pointer names (`meter.json` and its ed25519 signature on this repository's rolling `meter-lane`
release, checked against the meter's public keys the installer carries), checked against the
sha256 that pointer names, written atomically. A pointer that does not verify, or one older than a
pointer this install already took, installs nothing. Before the swap the new binary is run once
(`--version`, with a minimal environment and a 10-second limit) and must answer exactly its
version, or the old binary stays. The binary it replaces is kept as `~/.local/bin/usagemeter.prev`
until the next swap, so if a new release misbehaves, one rename goes back:

```sh
mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter
```

(`am meter install` or an update would put the newer build back, so hold those until
a fixed release.) It skips the download when that version is already there and never replaces a
newer one (Pocket Link installs the same binary). While Herdr is open, the
sidebar runs `usagemeter sync` 30 seconds after it loads and then every 10 minutes, one run at a
time; there is no LaunchAgent and no daemon. A dev build counts by its version number, so
`3.108.17-dev` stays, and a file there that reports no version is left with a warning.
`--no-usagemeter` leaves the binary alone, on install and on `--uninstall`; a failed install is
only a warning. `--uninstall` removes the binary only when this installer put it there, it is still
that version and Pocket Link is not installed; usagemeter's data is kept.

The phone reads each machine's own usage summary there (the `herdr-meter` document in that
machine's herdr-core), so usagemeter runs on every linked machine too: the installer installs the
build the pointer names on each connected machine in `hc machine ls` (the pointer is checked once,
on the computer running the command; each machine downloads its build and checks the pointer's
sha256 itself; one that fails is a warning naming it), and the sidebar's 10-minute run syncs
each connected machine after this computer, one at a time. `am meter install
[--machine M]` does it again, for example for a machine linked later. `--usagemeter-local-only`
keeps it to this computer, and `--no-usagemeter` covers the linked machines too; both are
remembered.

Where you agreed to usagemeter, the same 10-minute run also asks each of those machines for its
bot-tag coverage (`usagemeter coverage --window d30 --json`, a read of that machine's own store)
and writes one record of the answers, `automagik-herdr/fleet-coverage.json` in the app home,
beside the install record: readable by you alone (0600) and replaced on every run. It holds, per
machine, token counts by class, bot and repository (no session id, no path), and names the
machines that did not answer (`missing`, with why) and the linked machines usagemeter is not on
(`out_of_scope`); a machine that did not answer is unknown, never counted as zero. Its contract
is `meter/schema/fleet/v1/` in the repository. `--uninstall` removes it.

**Updating to this release from an earlier one:** the update is run by the earlier release's
command, which has no usagemeter step, so run `am meter install` once afterwards. It
installs usagemeter on this computer and every connected linked machine, and records that you
asked for it. From then on, `am update` keeps them on the build the meter lane names,
within what you chose. An earlier install's record is never read as a yes for the linked machines: if
that installer put usagemeter on this computer, `update` keeps it there only; if it recorded
nothing (an earlier `install.sh --no-usagemeter` recorded nothing), `update` installs nowhere and
prints that command instead. Either way the sidebar syncs only this computer until you run it. `--uninstall` removes it
from a linked machine only where the install record says the pack put it and it is still that
version.

### The automations scheduler (herdr-automations)

The Automations panel (`am-automations`) drives `herdr-automations`, the scheduler that fires the
automations (our build of the vendored fork in `scheduler/`, released as
`herdr-automations-v<version>`). The pack pins 0.12.1-am.4. The installer puts that build
(`mods/am-automations/scheduler.js`, read from the pack tarball it has just checked) in
`~/.local/bin/herdr-automations`, for macOS and Linux on arm64 and x86_64: downloaded, checked
against the pinned sha256, run once (`version` must be exactly the pinned one), then renamed into
place. It keeps its own record (`<app home>/automagik-herdr/scheduler`) and replaces or removes
only the binary it wrote, while it is still those bytes: one on your PATH somewhere else, a link, or
a file you installed yourself (upstream's build, a dev build) is left as it is and only checked.
The installer also adopts a file there that exactly matches the current pin. It records the file
without replacing it and keeps any recorded ownership of the login service. If the pin has
already moved past a build the panel installed, the installer needs a matching record to
recognize that build as its own.

For its own binary it then sets things up. A machine with no `automations.yaml` gets one saying
`backend: hc`, so runs open in the Herdr app; an existing file is never edited, and neither it nor
the run history is ever removed. It asks before starting the scheduler's login service
(`herdr-automations service install`, for your user only; `--yes` says yes, no terminal says
no). When it replaces the binary for a service it set up, it runs the service setup again without
asking. On a Mac, that stops and starts the service. On Linux, the running scheduler switches to
the new build after its current runs finish.
Last, the runtime check: it asks the scheduler `ls --json` and says whether Automations is ready
(the scheduler runs and the backend is the app's) or what is missing. A failure anywhere here is a
warning; the pack is installed all the same, and a rerun retries.

`--no-scheduler` leaves the binary and the service alone, on install and on `--uninstall`.
`--uninstall` otherwise removes the login service when this installer started it, then the binary.
While a login service you started yourself (Start in the panel, or `service install`) is installed,
it keeps the binary too and says how to remove both, so no service is left restarting a missing file.
`am update` updates the pack. On macOS and Linux, **Automations** offers **Update** when a
writable scheduler binary differs from the pack's pinned build, even if the installed build is
newer. The row names the file it will replace, including the target of a link. Launcher scripts
and schedulers in unwritable folders must be updated where they were installed. If the scheduler
is missing, use **Install** or copy the command shown in the panel.

Update verifies the download before replacing the file and leaves the login service alone.
Right after the file is replaced on macOS, a code-signing check can stop the scheduler's first
start and the login service starts it again within seconds, so “not running” briefly is expected.
The panel checks the running scheduler each time it refreshes, including after reopening. It
names a different executable if the scheduler runs from another file. When the running scheduler
still uses the previous build of the same file, the panel says it switches once no run is busy.
A record left running by a cut-off run stops counting as busy once its timeout and a two-minute
margin pass. If the panel sees the same old image for a minute with no busy runs, or for ten
minutes regardless of run history, it checks the scheduler's status and can show the restart
command for your setup. Restarting stops running commands and the scheduler loses track of agent
runs in progress.

With 0.12.1-am.4 and `AFTER A RUN` set to never close, a finished run keeps its terminal until that
automation's next run starts. The scheduler removes terminals it opened for failed, timed-out or
stuck runs. A bot keeps its own terminal, and the last tab of a shared space stays open.

**When you update to 0.12.1-am.4.** Read any old run terminals you care about before updating.
Before each automation's first new run, the scheduler tries to close all the terminals it can
identify from that automation's earlier runs at once, including any you chose never to close.
On a Mac, the installer's login service restart can stop the scheduler from tracking an unfinished
agent run. The agent can keep working in its terminal until the automation runs again, when the
scheduler tries to close it.
Your worktrees and their files stay on disk. The panel shows the failure reason. For the reason
and any saved screen lines from a removed terminal, run `herdr-automations history --json`.

### DSH as a Herdr agent (dsh-TUI)

DSH, the DeepSeek Harness, is an agent in Herdr's `+` menu through
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), in its own DSH profile. The installer asks
once; `--dsh-tui` takes it without asking and `--no-dsh-tui` leaves DSH alone. `--yes` never
installs it: a third-party package is opt-in by its own flag or an explicit answer. The command does
the same later:

```bash
am dsh-tui install   # install, or update to the pack's pin
am dsh-tui doctor    # what is there: dsh, the profile, the shim, the guide, Antigravity's lists
am dsh-tui uninstall # the plugin and the shim away; sessions and state stay
```

- **DSH first.** It assumes `dsh` is on PATH (DSH Desktop, or `npm install -g @deepseek-ai/dsh`).
  With none, install prints one line saying how to get it and changes nothing. **herdr-app
  v0.1.13 or later** is what ships the built-in `dsh-tui` program entry this shim lights up.
- **The exact pin.** `@deepseek-harness-tui/dsh-tui` **0.19.0**, built for DSH 0.2.2-rc.1. The
  profile's `package.json` pins the exact version and its `pnpm-lock.yaml` must record the
  registry integrity this pack carries (`sha512-4TAP…`); an install that lands on another
  version or integrity fails and takes back what it added. The install records that *it* added
  the pin in `~/.dsh/profiles/dsh-tui/.automagik-herdr-dsh-tui.json`; a pin already there is the
  person's, and uninstall leaves it. A pin the pack did not record is never written over—not even
  at the pinned version—because `dsh plugin add` rewrites the person's lockfile: the install skips
  it and says how to remove it or hand it over. The record names the package and the version it
  set, so a pack-owned older pin is still the pack's after a bump.
- **Its own profile, `dsh-tui`.** `dsh plugin --profile dsh-tui add …` writes
  `<DSH_HOME>/profiles/dsh-tui` only (DSH's home is `~/.dsh` unless `DSH_HOME` says otherwise).
  That is the profile dsh-TUI creates for itself (`bin/dsh-tui.js`'s `PROFILE`, where
  `dsh-tui` and `dsh --profile dsh-tui` are equivalent), mounted as base + the TUI bundle.
  Never `tui`: a profile with that name can have been initialized from the web template, which
  boots the web app, and the web app rejects `--resume`, `-c` and `-p`. A `tui` profile an
  earlier pack release created is left alone (nothing uses it now): remove its pin with
  `dsh plugin --profile tui remove @deepseek-harness-tui/dsh-tui` if you want it gone. The
  reserved `desktop` profile, its settings and `~/.dsh/.credentials.yaml` are never written; the
  install checks their fingerprints after the plugin step and fails rather than claim success if
  DSH changed them. The install writes `package.json`, the lockfile and the pnpm workspace file;
  it never writes the profile's generated `cordis.yml` (DSH rewrites that root on every boot).
  Machine or sandbox settings belong in the profile's `cordis.patch.yml`, the documented user
  layer.
- **pnpm's release-age gate.** pnpm 11's `minimumReleaseAge` (1440 minutes by default) refuses a
  version published hours ago, so the profile's `pnpm-workspace.yaml` carries
  `minimumReleaseAgeExclude` for exactly `@deepseek-harness-tui/dsh-tui@0.19.0` — never the bare
  package name. Once that version is older than the profile's threshold, install/update removes
  that exact entry; uninstall removes it only for a pin this installer added. Other packages'
  entries are left alone.
- **The shim.** `~/.local/bin/dsh-tui` is a shell script that checks `dsh` is on PATH (a clear
  line and exit 127 when it isn't) and then runs `exec dsh --profile dsh-tui "$@"`, with the env
  it was started in. No separator of its own: DSH's launcher takes its own flags first and the
  first token it does not recognize starts the app's arguments, so `--resume <id>`, `-c` and
  `--continue` reach dsh-TUI. `--backend` is **not supported through the shim**: the package's
  own launcher maps it to `DSH_TUI_BACKEND`, but dsh passes it to the app, which reads it as
  prompt text. A literal `-- <text>` is not a safe escape for text that starts with a flag: DSH
  drops the bare `--`, so `-- --resume=<id>` resumes that session instead of sending text.
  Herdr's built-in `dsh-tui` program entry (its `programs.json`) checks that the first word
  resolves on its PATH, so the built-in DSH menu entry works with no per-user `programs.json`.
- **Provider keys (optional).** The shim sources an optional `0600` env file at
  `~/.dsh/deepseek.env` (or `$DSH_HOME/deepseek.env`) so panes and workers get provider keys set
  outside DSH; you can still use `/auth` or the credential store. Quote values so a space cannot
  change the assignment:

  ```sh
  # ~/.dsh/deepseek.env, mode 0600
  DEEPSEEK_API_KEY="your-key"
  OTHER_KEY='your-value'
  ```

  Only a readable regular file you own with **mode 0600 or stricter** (no group or other
  read/write), in a folder you own that is not group- or world-writable, with valid shell, is
  sourced; anything else is skipped with one fixed line.
  The shell's own syntax error (which can quote the offending line) is discarded, so the file's
  content or values never reach stderr. Checking and sourcing are separate opens, which is why
  the parent folder is checked too (another user who can write it could swap the file between
  them). The installer writes no secret.
- **Sandbox and permissions (`cordis.patch.yml`).** The installer writes no config and no policy.
  Settings belong in the profile's `cordis.patch.yml` (the documented user layer), never the
  generated `cordis.yml`, which DSH rewrites on every boot. A concrete example:

  ```yaml
  - id: sandbox-policy
    config:
      mode: workspace-write
      workspaceRoot: !!js process.cwd()
      additionalWritableRoots:
        - /path/to/main-checkout/.git   # replace with your checkout's .git
  - id: approval
    config:
      policy: never
  - id: permission
    config:
      defaultPreset: unattended
      presets:
        read-only:
          sandbox: read-only
          approval: ask
        workspace-write:
          sandbox: workspace-write
          approval: ask
        danger-full-access:
          sandbox: danger-full-access
          approval: never
        unattended:
          sandbox: workspace-write
          approval: never
  ```

  `defaultPreset` is only inferred when it is **unset**: the composed sandbox/approval defaults
  must then match one of `presets`; if they match none, `dsh-permission-presets` refuses boot
  ("composed sandbox and approval defaults match no preset; configure defaultPreset
  explicitly"). Setting `defaultPreset` names a configured preset instead (an unknown name also
  refuses boot). The `unattended` preset is workspace-write + approval never. Interactive
  dsh-TUI takes no permission, add-dir or approval flags (they become prompt text); the profile
  supplies them.
- **Automation.** dsh-TUI's `-p`/`run` automation exits 3 `ADAPTER_UNAVAILABLE` on DSH
  0.2.2-rc.1. Use `dsh --profile headless` for headless work.
- **PATH.** The doctor checks `~/.local/bin` on the PATH Herdr **panes** get (an interactive login
  shell's, the way herdr-core starts a program) and names the file to edit for that shell
  (`~/.zshrc`, `~/.bash_profile`, `~/.config/fish/config.fish`, `~/.profile`). Herdr's `+` menu
  checks its own PATH; restart Herdr after changing the file so its dot sees the shim too.
- **First launch.** Sign in in dsh-TUI with `/model` → **DeepSeek Account**, or `/auth`; a key
  already in DSH's credential store or `DEEPSEEK_API_KEY` in the environment works too. No key is
  stored by this installer and no BWS launcher ships. The four-step first-run guide is marked
  done before the first pane: the install writes dsh-TUI's own record
  `~/.dsh-tui/onboarding.json` with `{"completed": true, "version": 1}` (its `DATA_DIR`,
  `ONBOARDING_VERSION` in `lib/types/onboardingPrefs.js`) only when that file is absent, so a
  fresh pane starts clean and never blocks. A person completing the guide writes the same file;
  an existing one is left byte for byte, and `/setup` opens it later.
- **Sessions.** They land in DSH's home (usually `~/.dsh`) and appear in DSH Desktop's history
  after Desktop is quit and reopened: Desktop has no live refresh. One writer per session applies:
  don't continue the same session from Desktop and dsh-TUI at once.
- **Uninstall.** `dsh plugin --profile dsh-tui remove` takes out the pin this installer added, the
  release-age entry that came with it, and the shim (only when it is the pack's). A pin the person
  added, a foreign shim, a dangling link and DSH's sessions are left alone. `--uninstall` of the
  pack does the same while its command is still in place. `~/.dsh-tui` state and the `dsh-tui`
  profile stay.

### From v0.2 to v0.4.x

Rerun the one-liner above. Their own `am update` finds nothing newer, because the
pack ships under a new name. v0.5.0 also renames every mod folder (there are no aliases):

| Before v0.5.0 | From v0.5.0 |
|---|---|
| `spaces-agents` | `am-sidebar` |
| `sidebar-chrome` | `am-footer` |
| `auto-tabs` | `am-tabs` |
| `new-menu-tui` | `am-new-menu` |
| `md-menu` (with `markdown-browser`) | `am-markdown` |
| `mod-manager` | `am-mods` |
| `automations` | `am-automations` |
| `space-icon` | inside `am-sidebar` |

The installer:

- replaces the sidebar-only folder with `am-sidebar` (the old one is kept in
  `automagik-herdr/.prev/`, its `.state` carried over) and adds the other seven mods;
- replaces the `automagik` layout while it is the unchanged one those releases shipped;
- renames the pack mods your own layouts and `keys.json` name, each file backed up first in
  `automagik-herdr/backup/layouts-<date>/` (a mod you installed yourself keeps its name until
  `--adopt`), and prints what a layout of yours still lacks. A layout it cannot rewrite (a link,
  whose target is yours, or a shape it does not read) keeps its old folder in `mods/` beside the
  new one, said on every run, until you name the new folder in it or take the block out; the next
  update then retires the old folder;
- points the `automagik-herdr` link at `am-sidebar`'s command;
- moves the bots' briefing hooks to a fixed path and lists, at the end of its run, every file it
  rewrote. A Claude session already running in one of those projects keeps the old hook and gets
  no briefing until it is restarted: `am restart <bot>` (or the bot row's Restart). A project the installer doesn't
  know about keeps the old hook: `am start` or `attach` its bot, or open it as a
  space in Herdr and run the installer again.

`am update --rollback` returns to the release before, the old names included.

### Paste this to your agent

Or let a coding agent do it. The prompt lives in [docs/agent-install.md](docs/agent-install.md):

```text
Install Automagik Herdr on this macOS or Linux machine and set up my first bot. The command is am (automagik-herdr still works as an alias).

1. Run: curl -fsSL https://raw.githubusercontent.com/automagik-si/automagik/main/herdr/install.sh | bash
   If it stops to ask something (install Node or Herdr), ask me; if I say yes, run it again
   with: ... | bash -s -- --yes. If it stops for anything else, tell me what it printed and stop.
   If the output has a layout.switch command, ask me before running that exact command. If
   it names a layout of mine that lacks pack pieces, tell me which; edit it only if I ask.
2. Verify, don't assume: a version and a checksum don't say what was installed. All must hold:
   am --version prints 0.5.0 or later (0.4.x and older are the sidebar alone);
   sed -n 's/^mods=//p' ~/.config/herdr-app/automagik-herdr/installed-by-install.sh prints
   am-automations,am-footer,am-markdown,am-mods,am-new-menu,am-quota,am-sidebar,am-status,am-tabs;
   herdr-app check ~/.config/herdr-app/mods/<mod> succeeds for each on (am-automations, am-quota ship off).
   If anything is missing or fails, report the install as incomplete. If am is not
   found, use ~/.local/bin/am and tell me to add ~/.local/bin to my PATH.
3. Ask me for: the project folder, and the main bot's name, character and coding agent
   (claude, codex, antigravity…). Characters: whale, octopus, star, moon, wave, squircle, zed,
   hex, gumdrop, peanut, saucer, bunny, kitty, beacon, plus, magnet, acorn, pebbles, cushion,
   ring, gem. If I don't pick a character, use --omni (the octopus); never guess the folder,
   name or agent.
4. In that folder, create and start it:
   am create --kind=main --name=<name> --agent=<agent> --character=<character>
   am start <name>
5. Report back: the installed version and mods, the output of am ls, and what failed.
Do not edit files under ~/.config/herdr-app by hand.
```

## Why a team

One agent in one terminal forgets what the others are doing. Automagik Herdr gives each agent
a place in a team, and keeps that team in front of every agent and of you.

- **A role and a lead.** Every bot has a name, a role, instructions and a lead. The project has
  one main bot; captains lead squads; members report to their captain or to the main bot.
  The team lives in `.herdr/bots.json`, committed with the project.
- **A briefing at launch.** Start and Restart hand a bot its name, role, instructions, lead and
  team as part of its agent's system prompt (Claude Code, Codex, Oh My Pi, Pi, Grok, Hermes),
  once, never again each turn. Its team's live state, each member's status and latest report,
  is `am brief <bot>`. A Claude pane attached while running gets the briefing
  once, from its hook, on its first turn and again after an edit or a compaction. An edit to a
  bot's instructions reaches it at its next `am restart`. Claude Code's `/restart`
  never works in a Herdr pane with its launch flags (`--append-system-prompt-file`,
  `--settings`), including the hint `Update installed · /restart to apply`, so the briefing
  tells every bot, whatever its agent, to point you to `am restart <bot>` (run in
  the project's folder, or with `--project`; it keeps the bot's agent and model) or the bot's
  Restart instead of its agent's own restart command.
- **Typed notes when blocked.** A member started under its lead's pane makes herdr-core type
  its `blocked`, `error` and exit notes into the lead's pane, so the lead wakes up.
- **Any harness.** Bots run Claude Code, Codex, Antigravity, Kimi, Oh My Pi or any agent Herdr
  knows, side by side in the same team.
- **A detected model.** The sidebar shows the model a bot's pane really runs, read from its
  command line, else the agent's own default. A model can be pinned from the agent's known
  list; it is never typed.

## The team in the sidebar

The pack replaces Herdr's `spaces` sidebar with one that draws each project's team under its
space: the main bot as a card, categories as headers, captains with their members folded
under them, planned bots dimmed with their wave. Each bot shows its character, its role and
model, its agent's icon and its status. The rows and their clicks follow the attach ledger
(`am whois --all`) for the panes it names at the current session's `created_ms`: after a
relabel, a bot is drawn and focused on the pane the ledger binds it to; in that project a bot
it binds is never drawn from another pane's label. A live pane carrying
`bot=` that no ledger row names at its generation — an empty answer, a bot bound on another
machine's ledger, or a snapshot address the ledger kept bare (`wsl/t2y`) — is drawn and
focused from its label. A replaced pane (a new session at the same address) never inherits
the old card's status or click; its own `bot=` label may draw it as the bot whose label it
carries. A planned bot's card stays planned, and a pane labelled with a planned bot is drawn
as a plain agent row.
Right-click a bot for its menu: Configure opens the edit form (name, agent, model, role,
category, lead, worker defaults); Prompt edits its instructions in place and saves them
as the form does; Run starts it, or focuses its pane when it has one, restarts it (Restart
runs `am restart`; Restart on… restarts it on another installed agent, a new conversation, the
bot's definition keeping its agent), attaches it to the focused pane or detaches it; What
happened shows `am history` for it (its panes, starts, sessions, the newest transcript, which a
click copies, its workers) and the helpers its pane runs now. A planned bot's menu has no Run
items. A queued restart waits for its next idle. A busy-pane refusal offers "Restart anyway".
With helpers, choose "Restart with its helpers" to restart immediately and resume
those conversations, or "End helpers and restart" to end them. On a linked machine, the first choice
runs the installed CLI's local `--tree --force` restart on the machine holding the panes, then updates
this sidebar's attachment. Saved configuration changes use these same choices when you restart to apply
them. Pack updates reload mods and do not restart bot panes. The Bots list and the Attach picker open
on the bots the sidebar already knows and refresh behind.

**Restart at a context threshold.** A running Claude Code seat's `context_tokens` is the newest
assistant message's input plus cache-read and cache-creation tokens; `am ls --json` and
`am show <bot>` report it. A bot may store a threshold in tokens (`restartAt`, set with
`am edit <bot> --restart-at N` or cleared with `--no-restart-at`): a main bot defaults to 250000,
a member has none until one is set. `am restart --due [--dry-run] [--all]` asks every seat over
its threshold to write a handoff to the exact path printed by the command, under
`<app home>/automagik-herdr/handoff/<project hash>/<bot>.md`. The handoff covers what's in
flight, what waits on whom, and the next three actions. After the seat ends its turn, it restarts
fresh with its helpers (`--fresh --tree`) and the handoff becomes its new conversation's first
message. A working or blocked seat is queued until its next idle (`am restart --queued` lists
it). The old conversation is not resumed: what survives is the handoff file, the bot's definition
and briefing, and its helpers' own conversations (resumed under the new pane); nothing else from
the old conversation does. A seat that doesn't write the file within the time limit, or a handoff
home that can't be written, is reported and left running: the pass refuses rather than restarting
without the handoff. A handoff restart that fails, or is dropped after waiting, is also kept in
`<app home>/automagik-herdr/handoff-failures.json`: `am restart --queued` lists it after the queued
watcher's own pane is gone, and a queued watcher tells the project's main bot (the same report
`am revive` uses). A restart whose handoff can't be sent as the new conversation's first message is
kept there as a `send` warning: the seat is restarted and the pass exits 0, and the file stays for a
person to send by hand. A timer or the login service can run the pass; `--dry-run` prints the plan and touches
nothing.

**A seat on Claude Code's rate-limit dialog.** A running Claude Code seat blocked on Claude
Code's rate-limit options dialog is reported as `rate-limited` by `am ls`, `am show` and the
sidebar, with the reset time the dialog shows (the field is left out when it shows none). The
detector matches the dialog's own shape, never a word: at least two numbered options must end the
pane tail, start at 1 and be consecutive, one must carry the `❯` selection cursor, and the limit
cue must be the dialog's own line: one of the three non-empty lines directly above the choices,
with only the dialog's limit/reset words between it and them. A limit sentence in a report or in
scrollback above the options is therefore not a cue, and a screen whose question the permission
detector owns (a permission/selection dialog) is never a rate-limit match. The footer both
dialogs may show (`Esc to cancel`, `Press enter to confirm`) is marked as a footer, so the
options/limit shape decides the rate-limit rule while the send guard still treats the pane as
held. A quoted, fenced or patched transcript is text, not the live dialog: a patch stays
text however far above the dialog its hunk header sits within the visible tail (the rule never
measures that distance).
A raw, unmarked paste that ends the pane tail is the accepted limit of a text-only rule: it is
byte-for-byte the live modal, so the rule cannot tell them apart, and every marked form (a
quote, a fence, a patch) is refused. An ordinary report
whose text says "rate limit" and lists findings is not the dialog, and an unreadable or empty tail
is never a match. Detection only reads the pane tail. Automatic delivery checks that tail
before sending and holds delivery on a dialog or an unreadable screen. A dialog can still open
between the read and the paste. Closing that interval requires a conditional paste in herdr-core.
Both project settings for `onRateLimit` (`"park"` and `"switch"`) preserve the original
pane and its workers. Resume in that pane when the provider allows it. Herdr cannot atomically
retire a pane only if it has no dependent workers, and a session named in a launch command
does not confirm which conversation the provider actually opened.

`am rate-limit [--all] [--dry-run]` runs one sweep. The scheduled `am restart --due` checks
the dialog first. Each episode writes one item in `<app home>/automagik-herdr/attention.json`
for `am ls` and `am show`. If the dialog names a reset time, `am restart --queued` shows a
recheck one minute later. An unknown reset has no timed recheck. The watcher observes the
original pane until it recovers or the watch expires. A live watcher on a reachable core rechecks
within two minutes of the scheduled time. An unreadable screen or expired watcher keeps the hold,
attention item and first deadline. A later sweep reattaches the watcher. Canceling the queued
entry closes its attention item. An already queued restart keeps its operation, and a handoff
continues after recovery with the same ask and response file. The updated Herdr automations scheduler checks `am delivery-status` before sending
to a target or a notification recipient and preserves each automation's `enabled` setting.
The pack pins 0.12.1-am.4. The scheduler has checked delivery status since 0.12.1-am.3.

**Wake a bot every day.** Set `am edit <bot> --wake daily@09:30`, or add the same flag to
`am create`. Clear it with `am edit <bot> --no-wake`. The owning machine's local time applies,
including for a linked project named with `--machine M --project DIR`. Its scheduler must
be running, with backend `hc` and bot targets (`herdr-automations` 0.12.1-am.2 or later; the
pack pins 0.12.1-am.4). A bot seen busy or blocked when the run starts is skipped. If a dialog opens
just before the send, hc refuses to type into it and the failed run shows the reason.
A new wake starts at its next occurrence. An already registered wake missed while the
scheduler was stopped can catch up once on startup within 1380 elapsed minutes (23 hours).
Daylight saving time follows the scheduler's cron library.

`am ls` and `am show` report the schedule and the last run. Rerun the same `am edit` with
`--wake` or `--no-wake` to repair a failed sync. A worktree edit saves to that worktree's
roster. Run the same edit against the main checkout to change the live schedule.

**A question is not a permission.** An agent that ends its turn waiting on you sets the pane
label `automagik-herdr.needs-owner=<short text>` with `hc label` (and clears it with
`hc label <terminal> automagik-herdr.needs-owner=` once you have answered).
Every `am worker` task, whatever its agent except Hermes, ends with the same rule.
A bot started by the pack as Claude Code, Codex, omp, pi, grok or guarded dsh-tui is told to
set and clear it in its launch briefing. Attached Claude Code seats get the guidance when the
briefing hook prints. `am brief` and Hermes omit it. The dsh-tui guard and per-pane proxy
allow exactly this key on the caller's own pane.
The sidebar draws a **Question** chip on its agent, sub-agent, bot or helper row, apart from a blocked pane's
**Needs you**, and a dot on its space (the narrow rail too), its tooltip naming the text. The chip
clears the moment the pane works again or the label is removed: the sidebar reads the label from
the one terminal snapshot it already takes. The label is the signal for the question, without a
screen scan or a herdr-core status word for it. The chip also clears when
the pane exits or leaves the snapshot, and once the label is past the pack's stale window (a day,
the same rule as `am tidy`'s `stale-needs-owner`), so a label left behind never keeps asking.

A project on a linked machine (`hc machine ls`) is managed from here too. Its bots' menu has
Configure, Prompt and Run (Start, Focus, Restart, Attach to a focused pane of that machine,
Detach). The Bots list names the project with its machine, and New bot on a focused space of
that machine creates the bot in that machine's project. The file is read and written on that
machine through herdr-core (`hc file edit` with the text read, an exclusive create for a new
file), so an edit made there since the form opened is refused, never overwritten. Its panes run
there (`hc run --on`, addressed `machine/tN`) and show in this window, in a space of that
machine on the project. The command a bot starts with is built here, from Herdr's agent table
and your `programs.json`. A bot there gets the briefing a local start gives, written on that
machine through herdr-core, in its app home: a Claude bot's briefing file (private, 0600) and,
once am is installed there, its per-turn hook in that project's
`.claude/settings.local.json` (until then it starts with a warning and no hook); an omp, pi or grok
bot gets the briefing as text. A start never creates an app home on another machine, which may be
shared: when that app home isn't a folder there, a Claude bot starts with one warning and no
briefing file or hook. Codex and Hermes bots start there without it, since their own
config, which may hold a prompt the briefing would replace, is only read on this computer.
**What happened** shows the attach, detach and end events this computer recorded for the bot on
that machine and project. A machine that isn't answering shows its bots as last seen, dimmed,
and its menu says so.

A project there can carry a pane-env file, `<project>/.herdr/pane-env` on that machine, for its
bots' panes only: other panes there never read it. It takes two keys, one per line:

```text
PATH_PREPEND=/opt/node-22/bin:/opt/tools/bin
HERDR_APP_HOME=/srv/bots/herdr-app
```

`PATH_PREPEND` puts those folders first on the PATH the agent is checked and started with (a
chosen Node, say). `HERDR_APP_HOME` is the app home the pane gets (`HERDR_APP_HOME=` in its
`/usr/bin/env` words) and the one its briefing file and hook use; without it, that machine's
`~/.config/herdr-app`, either way only while that folder is there. Every folder is absolute, with
no space at its start or end; blank lines and `#` comments are skipped. Another key, a relative
folder or a line that isn't `KEY=value` leaves the whole file out with one warning, and the bot
starts as it would without it, with no briefing file or hook: a file left out never falls back to
the default app home. With no file, nothing changes.

pane-env belongs to that machine: keep it out of git (add `.herdr/pane-env` to the checkout's
`.git/info/exclude` there), since a committed one would apply on every machine the project is
checked out on. A start on this computer never reads it.

To move a project's bots onto a shared machine:

1. Write `<project>/.herdr/pane-env` there, with `HERDR_APP_HOME` naming an app home that is
   already there (yours, not the machine user's), and `PATH_PREPEND` if your bots need their own
   Node.
2. Start one bot: `am start <bot> --machine <machine> --project <folder there> --json`.
3. Read its `warnings`: they should be empty. A `pane-env ... was left out` or `without its
   briefing` warning names what to fix; fix it and restart the bot.

Start and Restart there can take minutes when the machine answers slowly (every question to it
has its own bound; the CLI's worst case is about 6 min for a start and 9.5 min for a restart), so
the sidebar runs them with Herdr's longest exec timeout, 10 min. A Herdr that doesn't take an exec
timeout ends a mod's programs at 30 s, which could land after the new pane started: a pane with no
attach row, or after a restart two panes on one session. On such a Herdr, or one that can't say,
Start still runs, with that 30 s as its deadline: just before it would ask for a new space, and
again just before `hc run`, it checks what is left, and starts nothing when too little is left to
finish (20 s and 16 s; the calls after `hc run` then get 5 s each). A space made for it stays.
Restart isn't run there: after `hc run` it can still wait 30 s for the agent. Either way the
sidebar names the command to run from a terminal instead
(`am start <bot> --project <folder> --machine <machine>`, or `restart`), where
no limit applies. When Herdr ends the CLI anyway, the sidebar says it may have stopped part-way and
what to check (`am whois --bot`, `hc ls`).

On its first load the pack switches Herdr to the Automagik theme, light or dark following the
system. Both halves are listed in Herdr's Settings, and a theme you pick later stays: the pack
switches it once and never again. The theme files it copies into Herdr's `themes/` folder are
never overwritten, so a later release does not update a theme file already there; a theme file
you delete is copied back on the next load (pick another theme in Settings to stop using it).

## The command line

`am` does everything the sidebar does, without a Herdr window. Agents use it to
build and run their own teams. `automagik-herdr` still works as an alias (hooks and old scripts keep it).

```text
am ls [--all]                 bots: kind, lead, category, rank, code, planned, agent, model, pane, status
am show <bot>                 one bot in full
am create --name N --agent A [--kind main|member] [--role R] [--code true|false]
       [--instructions TEXT | --instructions-file F|-] [--lead BOT [--lead-project DIR]] [--category ID]
       [--cross-member BOT@DIR]...
       [--character C --colour K | --omni] [--model M] [--rank R]
       [--person-features on|off] [--effort E] [--tier fast|standard]
       [--permission-mode MODE] [--agy-mode auto|accept-edits|plan] [--agy-allow RULE]... [--agy-deny RULE]...
       [--planned-wave N [--planned-note T]]
       [--worker-agent A] [--worker-model M] [--worker-effort E] [--worker-agy-mode M]
       [--worker-template T]
am edit <bot> [the create options] [--code true|false] [--unplanned] [--no-model] [--no-category] [--no-lead-project] [--no-cross-members] [--rank=] [--effort=] [--tier=] [--permission-mode=]
am rm <bot>
am category ls | add --title T [--sub S] [--id ID] | edit <id> | rm <id> | order <id>...
am start <bot> [--space ID] [--tab ID]
am restart --queued [--project DIR] [--json]
am restart --cancel <bot> [--project DIR] [--json]
am restart <bot> [--fresh] [--agent A] [--model M [--save]] [--force]
am attach <bot> <terminal> [--move]
am detach <bot>
am import --from-hc [--squad-label L] [--apply]
am whois <terminal> | whois --bot <bot> | whois --all
am history <bot>
am brief <bot>
am forget <project>
am worker "<task>" (--branch B [--base REF] | --worktree DIR)
       [[--agent A] [--model M] [--effort E] | --template T] [--name N] [--role dev|test|review|fix]
       [--task ID [--lead BOT]] [--agent-home DIR]
am worker kill <pane>   # end a worker you started with am worker. Plain hc run cleanup belongs to the project's main bot.
am worker done --report <file> [--state done|blocked]  # finish your own worker pane
am update [--check | --rollback | --retry-skipped]
am meter install [--machine M | --linked | --local] | meter uninstall
am machines [update [--machine M | --linked | --local] | --auto on|off|status [--machine M]]
am dsh-tui install | update | uninstall | doctor
```

- `forget <project>` takes a project's folder off this CLI's project list (#229): only that
  entry, under the list's lock. Its folder, worktrees, bots file and panes stay as they are; a
  project not on the list is refused and the list left as it was. `ls --all` and the sidebar
  also show the sidebar's own remembered projects (each one it started a bot or wrote bots in),
  which only the sidebar changes: it forgets one once its `.herdr/bots.json` is gone. When the
  sidebar remembers the project too, `forget` still takes it off its own list and says on stderr
  that it stays shown until then (`--json`: `sidebar_remembers`). `start`, `restart`, `attach`
  and `create` already take off an entry whose folder is gone (tidy's registry prune) and say
  so in one line when the command succeeds.
- `import --from-hc` turns a running hc team into bots (#232): each live pane on this computer
  labelled `squad=` (or `--squad-label L`) with an hc name and an agent in front becomes a bot of
  that name, attached to that pane. Per squad, the captain (the pane labelled `role=captain`, else
  the one whose name or template is the squad's name, a separator and `cap` or `captain`, as
  `web-cap` or `web_captain`; `escape-cap` is not web's captain, and a pane whose `role=` is
  another rank is never one by name) reports to the main bot and the rest to their captain; the
  plan says which rule picked it. Without `--apply` it prints the plan and writes nothing: no
  bot, no label, and no attach ledger row (on a first run it works out the ledger's one-time
  import from `bot=` labels without saving it, and writes no end row for a pane hc no longer
  confirms). With `--apply` it prints the plan, writes every new bot at once and attaches each
  seat as `attach` does, never with `--move`. So besides `bots.json` and the attach ledger, it
  writes what `attach` and `create` write: the pane labels (`bot=`, `role=`, `category=`, a
  copied `squad=`), one workers-ledger seat row per attach, the Claude briefing hook and its git
  exclude line, the projects list, tidy's registry prune, and new `role=` labels on the panes of bots already there
  whose role changes (a captain whose members are made in this run). A pane already playing its
  bot gets back the labels `attach` sets that it has lost, with no ledger row, so a second run
  changes nothing; a bot defined but attached nowhere (a run cut short) is only attached. Any
  conflict refuses the whole import, nothing written: a pane playing or labelled for another bot,
  a bot of the seat's name attached elsewhere, under another lead or defined with another agent
  than the pane runs, a squad without exactly one captain, a Claude session outside the project,
  or no main bot. It never starts, moves or restarts a pane.
- Every command takes `--json` and `--project <folder>`. Without `--project`, the project is
  the one the current folder belongs to: its git main checkout, or outside git the nearest
  folder at or above it holding `.herdr/bots.json`. A folder named with `--project` is the
  project itself outside git, never a parent folder's project; in git it is still the main
  checkout. A `--project` folder that isn't there is a usage mistake.
- An edit (`create`, `edit`, `rm`, `category`, `restart --save`) run in a git worktree, or with
  `--project` naming one, is written in that worktree's `.herdr/bots.json` (from the main
  checkout's when the worktree has none yet), so the main checkout stays clean for the merge's
  `git pull`. Reads stay on the main checkout: `ls`, `show`, `whois`, Start and the sidebar show
  the change once it is merged there (RFC 0014 Q16); a bot one of them can't find in its file is
  named with the other file when that one has it. When the main checkout's `bots.json` was never
  committed, or has local changes, the note warns that pulling would stop on it: git won't
  overwrite it. When it was committed and is deleted in the working tree (not staged), the note
  says so: a merge pull brings it back with the worktree's version, while a rebase pull
  (`pull.rebase=true`) refuses until the deletion is committed or discarded; with
  `rebase.autoStash=true` it stashes the deletion instead, lets the pull through, and the stash
  apply then conflicts (UD). When the deletion is staged, the note says to restore and commit the
  file, or unstage the deletion, before pulling: committing it ends the pull in modify/delete.
  When the deletion is committed (HEAD has no file), the worktree has one, and their merge base
  still has it, the note says the pull ends in a modify/delete conflict, and to restore and commit
  the file before pulling or resolve it after. A deletion committed before the worktree branched
  leaves nothing at the merge base: the pull only adds the worktree's file, so the note says
  nothing.
- `ls`, `show`, `create`, `edit`, `rm` and `category` also take `--machine M --project <folder>`:
  the project on linked machine M (`hc machine ls`), `--project` an absolute folder there, keyed
  there by the same rule. The file is read and written there through hc by the same
  compare-and-swap rule, and the `--json` answers carry `machine`. A write whose answer is lost
  (a timeout, or the link dropping, which hc reports as `unavailable`) is read back: saved if the file holds it, else `State unknown`, so check the file
  before trying again. One write carries at most 96 KiB.
- `start`, `restart`, `attach`, `detach` and `whois` take `--machine` too: the pane runs on that
  machine (`attach <bot> M/tN`, or a bare `tN` with `--machine`). The attach ledger's row keeps
  the bare `tN`, `machine` and that machine's core id. `whois --json` keeps its shape: its
  `terminal` is the bare `tN` and `core` that machine's, never `M/tN`. While the machine isn't
  connected, its rows stay as they were (`status` `unknown`), never ended. A project's checkouts on two
  machines share their bots' ids, so a bot is per machine: `--machine` acts only on that machine's
  pane in that project, never on this computer's same-id bot, and `whois --bot <bot>` answers for
  this computer unless given `--machine M`. The pane's PATH comes from that machine's login shell,
  asked once with a 10 s bound (herdr-core may run as a service that never read `~/.profile`), plus
  the PATH hc runs programs with, `~/.local/bin` and `~/.bun/bin`. When the PATH hc runs programs
  with already finds the agent, that PATH goes first, so a working machine keeps the same agent and
  interpreter; otherwise the login shell's goes first. The agent and the interpreter on
  its `#!/usr/bin/env` line are checked under that same PATH before anything starts. A broken
  copy on the PATH hc runs programs with (one whose interpreter isn't there) still goes first and
  is refused by name, even when the login shell's PATH holds a working copy: remove or fix that
  copy. A login shell
  that is slow or prints no PATH leaves a warning, not a refusal; profile output is only ever read as
  text. On a linked macOS machine (`uname -s` is `Darwin`), the check also runs `security show-keychain-info`
  there before writing any files, starting a pane or ending an old one, and refuses when `herdr-core`
  has no access to the login keychain (for example when an incoming SSH connection started it outside
  the desktop GUI session, which leaves new terminals without Claude Code or `gh` login;
  see [macOS desktop session and login keychain](#macos-desktop-session-and-login-keychain-for-herdr-core)). A session id the pane carries is resumed by id
  (`--resume`); with none, `restart` refuses unless `--force`, as the agent's own "latest" may be a
  conversation started there by hand. A pane that reports
  no status to hc (Hermes) can't say whether it is waiting for an approval, so `restart` refuses
  it unless `--force`. No command ever sends a pane keys: `--force` starts the new pane and ends
  the old one only once the new one is up. `worker`, `brief` and `tidy` stay this computer's.
- `history <bot> --machine M --project <folder>` shows the attach, detach and end events
  this computer recorded for that machine's core and project. `--json` adds `machine` beside
  the bot's identity. Plain `history <bot>` shows this computer's bots' history.
- A bot is named by its id or by its name. A refusal exits 1, a usage mistake (such as a
  missing `--project` folder) exits 2, and nothing is written.
- `start` runs the bot's agent in a new pane with `hc run`, labelled `bot=<id>`, and records it
  in the [attach ledger](#the-attach-ledger). A member whose lead is running gets the lead's
  pane as its parent. A running bot is not started twice.
  The pane opens in a tab of its own in the space showing the project, never in another
  pane's tab; with none open, `start` opens one on the project folder (`--space` picks the
  space instead, `--tab` a tab in it). The sidebar's Start passes the space only. A space
  opened this way (by `start` or the sidebar's Start) comes with a shell in its first tab:
  that tab is closed (`tab.close`, not `confirmed`: Herdr asks the person only before it
  closes a space's last tab, and the bot's tab is always left) once the bot shows in its own
  tab there, and only while that shell is known to be the tab's one pane (a mod pane counts)
  with the shell itself in front, idle, and no job of its own running (`sleep 99 &` left at
  the prompt keeps it: its child processes are asked with `pgrep -P`, and an answer that
  can't be read keeps it too), so the space is never left empty and nothing else is closed.
  When two starts open spaces on the project, they use the first one. The sidebar can close the
  extra space identified by its own `space.new` reply, even if it appears after the wait, while
  it still has just its original tab with a single idle shell. A lost reply can leave the extra
  space open. `start` from the command line, `--machine` too, reads the panes from `herdr-app ls`,
  which counts no mod pane: it closes the tab only when it saw that shell, right after its own
  `space.new`, as the new space's one tab and that tab's one
  terminal. `AUTOMAGIK_HERDR_TAB_WAIT_MS` sets how long `start` and `worker` wait for Herdr to show
  the new pane (5000 by default); `0` turns this tab setup off.
- `restart <bot>` (also `am restart <bot>`) queues a working or blocked bot for its next
  idle prompt. A background shell at an empty agent prompt already counts as idle. A dialog
  stays for the owner to answer: Herdr never sends keys or answers it. `restart --queued`
  lists the queue; `restart --cancel <bot>` (or `restart <bot> --cancel`) cancels one. Both
  accept `--project DIR` and `--json`. A second request replaces that bot's queued options.
  `--force` restarts immediately; helpers still require `--tree` or `--force`.
- A paired Hermes bot keeps its `programs.json` command, including wrapper scripts and
  `--tui`, and adds its profile and Bot Chat options once; a different `--profile` must be
  corrected to match the pairing. Start and Restart errors show a short explanation in the
  menu. The CLI records the diagnostic and trace in `automagik-herdr/actions.log` under the
  app home; failures in the sidebar itself go to Herdr's app log.
- `restart` runs the bot's agent again in its pane's place: the new pane starts in the same
  space, tab and folder with the same labels, and the old one is ended (`hc kill`) only once the
  new one has kept its agent in front at every check for 5 seconds (1.5 once the agent reports
  its status to hc), so an agent that exits at startup (a stale resume, a failed swap) never
  leaves the space empty. A replacement that doesn't make it is ended, and the old pane keeps
  running. The launch is rebuilt from its current source — a live hc template's current command,
  else the bot's agent row and model pin, plus the agent's own resume words — never copied from
  the old pane, so a flag the source no longer names (a retired proxy, say) doesn't survive.
  When the pane's command differs, one line names the flag names only, their values masked
  (#597); a template hc no longer lists falls back to the agent row, and the line names it.
  It resumes the conversation by its session id, for every agent that resumes one: the
  id on the pane (`agent.session`, carried to the new pane, or a reviver's `revive.session`),
  else the workers ledger's last session row for that terminal (`claude --resume <id>`,
  `codex resume <id>`, `omp --resume=<id>`, `pi --session <id>`, `kimi --session=<id>`,
  `agy --conversation <id>`, `hermes --resume <id>`). With no id it takes the latest
  conversation in the bot's folder (`--continue`, `codex resume --last`), which could be a
  teammate's: while another pane or bot on that agent is in that folder (a live pane, a bot's or
  one started by hand, or another bot's last seat row in the workers ledger, its pane ended or
  not; for agy, whose `--continue` isn't limited to a folder, any folder), the restart starts a
  new conversation instead and says why (#328; the quota panel's restart lists those too). Only
  Claude's hook records an id today; on another agent, set the pane's `agent.session` label to
  keep its own conversation in a shared folder. An agent with no resume here starts fresh, and
  says so.
  `--fresh` starts a new conversation. `--agent` / `--model` swap the agent or model (always a new
  conversation: they don't cross agents); `bots.json` keeps the old ones unless `--save` is given.
  A bot that isn't running is started. A busy bot queues until idle. It is refused if it has
  helpers, such as workers, that hc would end with its pane; `--force`
  restarts anyway. The old pane is found in the attach ledger; once the new pane has stayed up,
  the ledger moves the bot to it (the old binding detached, by `start`, reason `moved`; the new
  terminal attached, by `start`), and a replacement that didn't make it writes no rows. A bot
  restarting itself writes and prints everything before the kill that ends its own pane. It
  prints the new terminal.
- `attach` ties a running pane to a bot. A Claude pane whose session runs outside the bot's
  project is refused, and so are a pane another bot plays and a bot another pane plays; the
  refusal names the holder. `attach --move` moves a bot from its pane to this one.
- `detach` unties a bot from its pane. `whois` says which bot a pane plays, or which pane a
  bot plays.
- `history` reads the two ledgers for a bot: its attach, detach and end rows, its starts, the
  Claude sessions of the panes it played, matched by terminal id and time, with the newest
  transcript, and the workers it started. The match is exact once a pane's detach or end row is
  written; a terminal id hc reused before then can briefly show the new pane's session. It
  writes nothing; a removed bot is named by its id.

## After a restart of the computer

A restart of the computer ends every agent. herdr-core keeps each pane it was told to keep and
puts a bare shell in it; a pane it did not keep is gone. `am revive` brings the bots
back:

- An eligible bot the attach ledger binds on this computer whose pane is gone, or is a bare shell, is
  restarted by `am restart --tree`: in its pane's space, tab and folder, resumed by
  its session id where its agent allows it, its helpers (workers included) under the new pane.
  The main bot comes first, each bot after its lead. A pane with a program in front is never
  touched.
- Revive brings back a local seat ended by holder loss, or ended by a sweep since boot, only
  in the login service's pass (`--boot`) and only if its attach row says it started more than
  10 minutes before the estimated boot (wall clock minus uptime). The margin allows for small
  clock adjustments. Revive reports why it leaves a seat alone and gives manual recovery advice
  when the destination can be confirmed. After a sweep, `am holders losses` reports seats lost
  to the holder.
- Each project's main bot gets one message: who resumed, who is on a new conversation and why,
  who is not back, and the command that brings it back by hand. The same report is kept in
  `<app home>/automagik-herdr/revive-last.json` (it holds no session id).
- `am revive --dry-run` prints what it would do and touches nothing.
- A resume that finds nothing is tried once more as a new conversation, and the report says so.
- A pane that is gone whole comes back in the folder its last seat row names, in the project's
  space; its old tab is not on record.
- A bot whose agent was quit, its pane left at a shell, comes back too: revive cannot tell that
  from a restart of the computer. To keep a bot down across restarts, detach it
  (`am detach <bot>`): a detached bot is never brought back. Every report says so.

Session ids. Claude gets its id from Herdr at launch. dsh-TUI, Antigravity, Codex and Kimi take none at
launch, so the pack reads the id from what each leaves on disk (DSH's session folders for the
pane's folder, Antigravity's prompt history, Codex's rollout session_meta, Kimi's session index:
only ids, folders and times) and records it as it does Claude's: a session row in the workers ledger and the pane's
`agent.session` label. The search root is the seat's own, never the reviving process's: its
launch records the person's `HOME` and the agent's own home (`$DSH_HOME`, `$CODEX_HOME` or
`$KIMI_CODE_HOME`, only absolute ones) in the seat row, and a hand launch's own `env` words on
the pane count too; a search reads those. When the seat's launch names no home, the search
fails closed and the bot starts new; the reviving process's `HOME` or `$CODEX_HOME` is not used.
The recorded home is the launching command's environment: a herdr-core started with another
home isn't followed. A seat started before this release names none, so it comes back on a new
conversation once, and the report says why. Anyone can leave a session in that folder
with no pane the pack knows (a terminal of your own, DSH Desktop), so the pack takes only a
pane's first conversation: the one session born within two minutes after the pane started. It
records none, and the bot comes back on a new conversation, which the report says, when two
sessions were born then, when none was, or when another pane of that agent in that folder (any
hc pane, whoever started it, and every launch the workers ledger names) started within two
minutes before the pane or before that session. An id another live pane's label or the workers
ledger ties to another launch is never taken, whatever folder or agent that pane shows, and
when hc can't read one of its panes nothing is taken. A session born later is never taken,
and a recorded id is never replaced. A rollout's file name must name the id inside it, and a
session file that is a symlink, or is replaced under the read, is refused. What stays
unknowable: a session someone started outside hc in that folder inside those two minutes, or one
an older pane of that agent there (started more than two minutes before this pane) started inside
them, when the pane's own agent left none; that one is taken, since ids, folders and times can't
tell it from the pane's own. A conversation started later inside the pane is not followed:
the bot resumes its first one. Codex's UUIDv7 dates its thread's creation at launch, even if its
first turn writes the rollout days later; the pack looks in every dated folder from the launch's
local day minus one onward. DSH's home is `$DSH_HOME`, else `~/.dsh`; Codex's is `$CODEX_HOME`, else
`~/.codex`; Kimi's is `$KIMI_CODE_HOME`, else `~/.kimi-code` (only absolute overrides count).
Revive never guesses Codex's or Kimi's latest conversation, for a bot or its helper: with no
conversation of its own (recorded, or found by the rule above) it starts a new one, and the report
says why. A helper whose own shell or template command names that agent's latest-conversation
flag (`--last`, `--continue`, `-c`) is not started; the report gives the command to run it by hand.
A manual `am restart` keeps its latest-conversation fallback.
Kimi's index format comes from the 2.5.0 package and has not been verified live.

The login service. `install.sh --revive` (or a yes when it asks; `--yes` never installs it)
runs `am revive service install`. On Linux it writes the systemd user unit
`~/.config/systemd/user/automagik-herdr-revive.service` and enables it; the unit has no start
timeout (the pass bounds its own waits). On macOS it writes the launchd agent
`~/Library/LaunchAgents/dev.herdr.automagik-herdr-revive.plist`, which launchd loads at your next
login: it is never bootstrapped, because that would run the pass now. Neither is started on the
spot, and what the pass prints — the user journal on Linux, launchd's unified log on macOS — is
counts only: no folder, no bot name.
At login it runs `am revive --boot --wait 600`: it waits for herdr-core, runs once
per boot, and also takes the bots whose ended pane another command swept since the boot.
`loginctl enable-linger` makes the unit run at boot with nobody logged in.
`am revive service uninstall` (and `install.sh --uninstall`) removes the file when it is the
pack's. On macOS it asks launchd first and removes the plist only when launchd says the job is
not loaded: exit 113, or its exact "Could not find service". Any other answer — a usage error,
EPERM, an I/O error — is a refusal that leaves the plist, exits non-zero and names
`launchctl bootout gui/<uid>/dev.herdr.automagik-herdr-revive`, so a job launchd still holds is
never orphaned. It asks even when the plist is already gone, so a second run boots out a label an
earlier run left behind and says so. `install.sh --uninstall` follows the same rule: it calls that
command first when its read-only `revive service status --json` answer parses as JSON and carries
the exact launchd label and a path under `Library/LaunchAgents` — also when the plist is gone. A
pack from before the macOS agent answers `status` with exit 0, but names the systemd unit and no
launchd job, and refuses only `uninstall`, so its `uninstall` is never asked. A truncated or
unparseable answer, a missing field, a wrong type or a label without that path falls back the same
way. When the command is gone, or its bounded read-only question doesn't answer, it asks launchd
itself — with the same 113/exact-words rule — before it removes the pack and its link. It never
overrules a refusal from a command that answered.
Panes on a linked machine are that machine's own to bring back.

## More than one holder (#1432)

Every pane belongs to one herdr-core **holder**: the process of the core that started it. When a
holder is lost, hc ends every terminal it held (issue #1432), so on a computer with one core a
single loss ends every bot. The pack can spread new starts over more than one holder on the same
computer: each extra holder is another hc session's core, exposed as a linked machine on this
host, and a bot started there runs the pack's normal linked-machine launch.

- **Default: one holder, `local`, and a limit of 6 agents per holder.** Nothing is spread and no
  core is started until the lead adds a holder, so a pack that never runs `am holders` behaves
  exactly as before. The limit is configurable with `am holders limit N` (1-64).
- `am holders` shows the pool: each holder's agent count against the limit (a binding on a
  holder whose line is down still counts: its terminal keeps running there), whether its core
  answers, and the recent losses. `am holders add --local NAME` adds one: it creates the hc
  session `am-holder-NAME` and links it as the machine `NAME` (`hc machine add --via`), so the
  holder's panes show in this window in that machine's space on the project. `am holders remove
  NAME` takes one away only once it holds no agent, live or on a dropped line; the refusal names
  the agents. `am holders up` starts a holder's core after a reboot.
- A holder is **full at its limit**: `count >= limit` leaves no room, and `over limit` is
  `count > limit` (the wording only; the choice and `am holders` use the same meaning). A new
  `am start` chooses its holder and reserves that seat together under `holders.json`'s lock, so
  two starts of different bots launched at once go to different holders instead of both picking
  `local`; the reservation is released once the start's attach row is written, or when the start
  fails (a reservation left by a killed CLI lapses after the holder-start timeout). `am holders`
  counts attached agents, not in-flight reservations. One bot never gets two seats: a start is
  refused when the bot already has a binding (live, or unknown on a holder whose line dropped)
  or another start is still placing it. The refusal exits non-zero and says the bot and holder;
  with `--json` it carries `error`, `bot` and `holder`. A start goes to the holder with the
  fewest of the pack's agents, and never to a holder whose core isn't answering while another
  is. With N agents and a limit L over two or more holders, a start above the limit goes to
  another holder: one holder's loss cannot take every seat. A start is never refused for the
  limit; when every holder is full, the least loaded takes it and says so on stderr (and as
  `limitWarning` with `--json`).
- `am ls`, `am show` and `am whois` name the holder; a bot whose holder's line dropped reads
  `unknown in NAME/tN`, never stopped. `am restart` finds the bot's holder and runs the restart
  there. A worker started from a holder's pane runs in that holder (its `am` talks to that
  core). `am holders losses` reads back what each loss took; a lost holder and a dropped
  machine line are recorded in `<app home>/automagik-herdr/holder-loss.log` with the holder's name
  and bot IDs. A holder loss also records the seats' terminal IDs, creation stamps, core IDs and
  machine names. The log and JSON output omit paths, sockets and commands. The loss report reads
  the attach ledger to say whether each seat was attached again. Only a pool holder's dropped line
  produces a `holder_unreachable` record.
- `am holders` also checks, on Linux, for a holder process cut off from its core. It looks for
  a live holder process on a pool core's holder socket that no pool core lists in two reads.
  The second read happens only when the first finds a candidate. Set
  `AUTOMAGIK_HERDR_CUTOFF_RECHECK_MS` to change the delay (5000 ms by default). The check gives
  the holder name, process ID and number of same-user live direct child processes at the second
  read. With `--json`, the result is in `cutOff`. The check uses herdr-core's internal process
  arguments and socket names. An incomplete check or an unsupported platform such as macOS
  reports `not checked`. The check itself starts nothing, stops nothing, records no loss and writes no
  file. It does not change what `am revive` does.
- A `holders.json` that isn't JSON, or whose limit or holder entries are bad, is said on stderr
  (so `--json` still parses) and the run keeps the one-holder default instead of silently
  turning spreading off; fix it with `am holders limit N` / `am holders add` / `remove`.
- After a reboot, `am holders up` starts the extra holders. To bring a bot back on one, use
  `am restart <bot> --machine NAME --project <folder>`. Restart uses the roster on that machine
  and starts a new conversation for an unpaired bot with no old pane. On a machine, `--tree`
  requires `--force`, which can replace a pane started in the meantime. After a holder loss while
  the computer stayed up, check that the old program stopped before using the manual command from
  `am holders losses`. The local hint excludes paired Hermes Bots.
- The upstream half of #1432 - the core logging why it closes a holder's link, and a holder
  whose link is gone not sweeping its programs - belongs to `herdrdev/herdr-core` (#372 and #303).

## The attach ledger

Which pane plays which bot is recorded in one file, `<app home>/automagik-herdr/attach.jsonl`
(beside the workers ledger), and nowhere else. Only `automagik-herdr` writes it: `start`,
`attach` and `detach`, and any run that reads it and finds a pane ended. The sidebar's Start
and Attach run the command line too. The `bot` label is a display hint: `hc label` changes
no row, so relabelling a pane moves no bot.
`am tidy` identifies local bot panes through the attach ledger and uses `bot=` labels for bots the local ledger has never recorded.

**Which app home a restart uses.** `HERDR_APP_HOME` names it. With it unset, restart resolves
the home before it writes anything: a pane's launch home wins, live or ended (hc keeps an ended
pane until it is removed, and its launch carries the home); else a live binding wins over a
stale one; else the project's own app home (`<project>/.herdr/app-home`, RFC 0021 delivery 3)
is used when it names the bot and the default does not. A binding is **live** while hc still
gives its terminal with the same `created_ms` (a finished, vanished or reused terminal is
**stale**), and that one rule is what `restart`, `attach`, `show`, `whois` and `revive` resolve
with: the live binding is the bot's wherever the command was typed. `ls`, `brief` and `start`
read the selected home first and fall back to the project's own home when it names nothing
live. Two live bindings on different panes, and two stale ledgers that both name the bot, have
no launch record to decide between them: `restart`, `show` and `whois` refuse them, naming both
ledgers, before anything starts or is written. Set `HERDR_APP_HOME` to the home that owns it.
`am revive` leaves a bot alone when a live pane carries its label or the project's own home
still binds it live, so a stale row in another home never brings back a twin.

The file is made with mode 0600; one that is group- or world-writable is refused (every
command that reads it exits 1, naming the fix: `chmod 600`). Each row is one line, written
with one append, under the file's lock (`attach.jsonl.lock`), so two runs never attach one bot:

```json
{ "v": 1, "event": "attach", "bot": "b-…", "project": "/abs/main/checkout", "terminal": "t7",
  "core": "<hc core id>", "created_ms": 1762100000000, "machine": null,
  "at": "2026-11-02T10:00:00.000Z", "by": "start" }
```

- `event`: `attach`, `detach` or `end`. `bot`: a bot id (`b-…`) or a session (`session-…`).
- `core`: `hc server status`'s `core.id`, the core's permanent id (reset only when hc's state is
  wiped). `created_ms`: the terminal's, from `hc get`. A terminal is the triple
  (`core`, `terminal`, `created_ms`), so an id hc hands out again is another terminal.
- `by`: `start`, `attach`, `detach`, `sweep` (an end row) or `import` (see below). `reason`, on
  some rows: `moved` (the detach of `attach --move`, written before its attach, in the same
  run), `finished` (hc says the terminal finished, or doesn't know it) or `replaced` (its id
  now has another `created_ms`). `machine` is `null`: every row is this computer's.

**The fold.** Read the rows in order, skipping any line that isn't a well-formed row:

1. `attach`: end any earlier binding of the same bot and of the same terminal, then bind the
   terminal to the bot.
2. `detach`: unbind the terminal if it is bound to that bot (a detach naming another bot does
   nothing).
3. `end`: unbind the terminal, whatever bot it holds.

What is left binds each bot to at most one terminal. A binding counts only when hc confirms
it: its `core` is this computer's, and `hc get <terminal>` says `live` with the same
`created_ms`. Anything else reads as ended at once; the next command that reads the file
appends its `end` row.

**Looking it up** (the interface for other tools):

```text
am whois <terminal> --json
  { "terminal", "core", "created_ms", "bot", "project", "since" }   or   { "terminal", "core", "created_ms", "bot": null }
am whois --bot <bot> --json
  the same, or { "terminal": null, "core", "created_ms": null, "bot", "project": null, "since": null }
am whois --all --json
  { "core", "bindings": [ { "terminal", "core", "created_ms", "bot", "project", "since",
                            "address", "machine", "state" } ] }
```

`since` is the attach row's `at`; `created_ms` is hc's. Both single forms fold and confirm with
hc first. `--all` lists every binding the ledger holds, live or on a machine that is away
(`state` is `live` or `unknown`), with the hc address and the machine's name; it is the
interface for tools that draw a bot beside a terminal without reading labels (`bots.whois-all-json@1`).

**The first run.** With no file yet, the first command that reads it imports today's labels
once: each live pane on this computer carrying `bot=<id>` of a bot some project here defines
becomes an attach row with `by: "import"` (one pane per bot: an agent in front, then the
newest). "Defines" means a folder this run names or remembers, or a project the sidebar knows
from its project list, a sibling folder, or a cross-project reference. The file is then made, even empty, so this happens once. The briefing hook reads the
file and never writes it; before the file exists it goes by the label.

## Workers

A bot manages its lane and writes no code. For each task it starts one worker, from its own
pane:

```bash
am worker "Fix the login redirect loop" --branch fix/login-loop --effort high
am worker "Fix the login redirect loop" --task gl-231 --worktree ../proj-gl-231
```

- **Who:** the calling bot is read from `HC_TERMINAL_ID` and that terminal's `bot` label.
  Anywhere else the command is refused.
- **Where:** `--worktree DIR` uses an existing worktree of the bot's project. `--branch B`
  reuses the worktree already on `B`, or makes `<main checkout>/.claude/worktrees/<slug>`
  with `git worktree add -b B`. After a fetch, a new branch starts from `--base`, else
  `origin/B`, else origin/HEAD's branch, else `dev`, else `main`, else `master`. It tracks
  `origin/B` when it starts there and nothing otherwise, so the first push is
  `git push -u origin B` and a plain `git push` never lands on the base. The main
  checkout is never a worker's folder, and its HEAD is never moved. `/.claude/worktrees/` goes
  into the clone's own git exclude, so `git add -A` in the main checkout never picks a
  worktree up.
- **Task (Genie's task contract):** `--task ID` is Genie's short task id, `^[a-z0-9][a-z0-9-]{0,40}$`
  (`gn-42`, `gh-1415`, `gl-231`). An internal `t_…` id is refused with `internal Genie id; pass
  the short id gn-N, gh-N or gl-N`; any other bad shape exits 2. With `--branch`, the branch
  must contain the id as a whole token (`fix/gl-231-login` names `gl-231`, not `gl-23`); with
  `--worktree`, Genie's flow, it isn't checked. The worker is named exactly `<id>-<role>`
  (`gl-231-dev`, `gl-231-review`): a live terminal on this computer already named that is
  refused and named, never suffixed; `--name` doesn't go with `--task`, and a name over hc's
  32 characters is refused. Without `--task`, the worker is named after its branch.
- **Lead:** `--lead BOT` is the task's lead bot, a bot id (`b-` plus 10 base32 characters) or a
  Genie session (`session-<uuid>`), checked by shape only; it defaults to the calling bot. A
  `reviewer` or `fixer` bot passing `--task` must pass `--lead`.
- **Planned swaps:** a bot's `worker.swap` in `.herdr/bots.json` (`{ agent?, model?, effort? }`)
  is the other arm its workers run on about one task in three, picked by rule: the first byte
  of sha256(`<bot id>:<project>:<task id>`) mod 3 is 0. Only with `--task`, never for a template
  worker, and the same for every worker of that bot on that task. On a swap task the arm
  replaces the bot's worker defaults; a per-task `--agent`, `--model` or `--effort` is recorded
  in the ledger (`override_requested`), not used, with one warning. Off a swap task they work
  as below and the row says `override: true`. `show <bot>` prints the worker defaults and the
  swap.
- **Role:** `--role dev|test|review|fix` says what the worker does. Without it the role comes
  from the bot's rank: `tester` runs `test`, `reviewer` runs `review`, `fixer` runs `fix`,
  any other rank (or none) runs `dev`. A captain passes `--role`. Another value exits 2.
- **One writer per worktree:** `dev`, `test` and `fix` write to the worktree; `review`
  never does. A writer is refused while any live worker of any bot on this computer is in the
  same worktree (its cwd, as a real path) with a writer role; a worker with no `worker.role`
  label (started before roles) counts as a writer. Reviewers start alongside a writer, and
  several may run at once; one bot's second reviewer on the same branch is refused, while its
  reviewers on other branches run in parallel. A refusal names the live worker, to check with
  `hc read` or end with `hc kill`. The check and the start run under one lock per worktree
  (`<app home>/automagik-herdr/worktree-<hash of its real path>.lock`); the lock and the check
  are local, so workers on other machines are not counted. The check comes first: a refused
  call, `hc ls` failing included, makes no worktree and writes no hook; so does a live
  terminal in the worktree that `hc get` doesn't answer for within 5 s. The lock is kept
  fresh while held, so a slow `hc` never lets a second call take it. A second call waits up
  to 75 s for it, saying on stderr after 3 s which lock it waits for and its holder's pid.
  A `--task` worker first takes a lock for its name (`task-<hash of its name>.lock`, the
  same 75 s in all): a second call for that task on another branch waits for the first's
  start, then is refused by the name check before it makes a worktree or a hook. A call
  waiting for a lock keeps refreshing the one it holds, and a refusal for a wait that ran out
  names the task or worktree it waited for.
- **Warnings:** `worker` prints the bots file's warnings about the calling bot on stderr
  first (a bad `worker` field is dropped, and its defaults with it); `--json` lists them.
- **What runs:** `--agent`, `--model` and `--effort` for this task, else the bot's `worker`
  defaults in `.herdr/bots.json`, else the bot's own agent with that agent's defaults. A
  default model belongs to the default worker agent, so a task that picks another agent
  runs that agent's own default model. Effort goes to `claude --effort`, codex
  `-c model_reasoning_effort`, and pi or omp `--thinking`; other agents get none, with a
  warning. An Antigravity worker always gets `--mode` (the bot's `worker.agyMode`, auto when
  absent) and its own `--settings` permission file, written per launch (see
  [Antigravity's permission list](#antigravitys-permission-list)); any other agent's launch
  line is unchanged. A template whose command runs `agy` is rebuilt with the file and its task;
  one whose command can't take words runs without the list, with a plain warning.
- **The task:** an agent's task is the last word of its command (Antigravity's behind `-i`).
  Kimi takes none there (#1032; kimi 2.5.0 reads a bare word as a command name and exits, and
  its `-p, --prompt` is a one-shot print mode that ends after one answer), so a Kimi worker
  starts bare and the task is sent as its first message: `hc wait <pane>` until Kimi says it is
  ready (up to 30 s for one that reports no status), then `hc send <pane> "<task>"`. When hc
  refuses the send (the pane waits for a sign-in or a trust answer, or has ended), the worker
  is kept and a warning names the pane and the `hc send` to run by hand; `--json` lists it.
- **Login home (#1208):** `--agent-home DIR` starts one Claude or Codex worker on the login
  folder `DIR` (Claude: `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`; Codex:
  `CODEX_HOME`). Without the flag, a worker that runs the bot's default worker agent uses the
  bot's `worker.agentHome` when it has one; a worker on any other agent, or a bot with neither,
  starts exactly as before (Claude on the Accounts login, `claude-logins.json`). The folder must
  exist, belong to you and have mode exactly `0700`; it is used by its real path, and Claude's
  default `~/.claude` is refused (omit the flag for the default login). The launch runs the
  agent's shipped command only (a `programs.json` run for it is refused), never a template, and
  unsets the variables that would outrank the folder's sign-in (Claude: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex
  and Foundry switches; Codex: `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`). The
  worktree's own settings may not pick another account: Claude's `.claude/settings.json` and
  `.claude/settings.local.json` with an `apiKeyHelper` or an `env` naming one of those variables
  (or either folder variable), and Codex's `.codex/config.toml` naming a provider, profile or
  login method, are refused by file and key (Claude's are read again after the briefing hook is
  written, just before the start). A call through the hc proxy or behind the full hc guard is
  refused; the `hc kill` shim every ordinary seat runs behind is fine. An hc that doesn't
  report a pane's launch argv is refused too: such a worker could never be told apart from a
  seat. Every
  refusal comes before any branch, worktree or hook is made, except the settings check, which
  needs the worktree. Before `hc run` the launch is reserved in the workers ledger (an `intent`
  row: its launch id, name, folder and home; no reservation, no start), and its argv carries
  that id (`AUTOMAGIK_AGENT_HOME_LAUNCH`) after the folder words. Right after hc answers (a late
  answer too) the pane must show that id, the folder and `die_with_parent: false`: one that is
  this launch but not that is ended, and one hc can't show to be this launch is left alone and
  named. The start row records `agentHome` and `launch`, and its `env` names the folder, so
  Codex's session search reads that folder. Under the Bot login policy, the chosen folder must
  match the reader's folder for that vendor, and the row records the reader's login pair
  (#1532). With the policy off, both fields are null. A Codex worker reads its model list and
  its project trust from the chosen folder. The folder decides the sign-in only: the model
  and effort pins, the pane's PATH (the agent's program is found on it, as for every launch),
  Codex's granted folders, managed policy, and the
  folder's own settings (Claude's `settings.json` there, Codex's `config.toml` there) are the
  person's choices as for any launch. A Codex folder that is also the one the Accounts panel
  manages is switched with it: the panel replaces that folder's `auth.json`, so a separate
  account needs a separate folder.
- **Templates:** `--template T` runs the hc template `T` (`hc templates` lists them)
  instead of an agent, for seats whose command sets more than a model: a custom model
  provider, keys, flags. A template owns its command, so `--template` with `--agent`,
  `--model` or `--effort` is refused. A bot's `worker.template` default wins over its
  `worker` agent, model and effort defaults, with a warning; any per-task `--agent`,
  `--model` or `--effort` sets the default template aside, so a captain whose workers run
  `dev-sol` can still start a Claude reviewer. A template hc doesn't list is refused before
  any worktree is made, and so is any template when `hc templates` gives no list (`hc run`
  would start an unlisted name as a program). An empty `--template=` is refused. A template
  whose command runs `claude` gets the session hook; when
  the command names no agent Herdr knows, the hook is skipped with a warning.
- **Spawn:** `hc run --bg --parent <bot pane> --cwd <worktree>`, labelled `worker.of=<bot id>`,
  `branch=<branch>`, `worker.role=<role>` (a template too), `worker.model` and `worker.effort`
  (`worker.agyMode` too, when it isn't auto);
  with `--task`, also `task=<id>`, `task.project=<main checkout>` and `task.lead=<lead>`
  (without it, no `task` label at all). When the bot's pane is in a Herdr space, also
  `herdr.space=<that space>` and no `herdr.tab`, so the worker opens in a tab of its own there
  as it starts: the space where the window shows the bot's pane, else its pane's
  `herdr.space` label while the window still has that space (none once it was closed).
  Once Herdr shows the worker (within 5 seconds), its tab is moved right after the bot's
  tab and named after its branch, as a click on its row does; it is never focused.
  A worker started before this release has no `branch`
  label: its `task` label holds the branch, and Herdr's readers fall back to it. Then
  `-- /usr/bin/env PATH=<the calling pane's PATH> <agent argv> <task text>`. The agent gets the
  bot's pane's PATH, not herdr-core's, so programs in `~/.bun/bin` (omp, and the `bun` it runs
  on) start. An npm agent such as codex is a `#!/usr/bin/env node` script: when that PATH has
  the agent but no `node`, the folder of one is put first (the one beside the agent's link,
  else what `bin/run.sh` picks: nvm's newest 22.7+, then Homebrew's), with one line saying so.
  A template runs in hc's template form, `<template> <task text>` after the
  options, labelled `worker.template=<name>` and without the PATH: the template sets its own
  command. The task text is always one argument, never part of a shell string. The worker has
  no `bot` label, so the sidebar folds it under its bot as a helper row showing its template,
  or its model and effort. Clicking that row focuses the worker's pane; without one, the
  worker opens as a tab right after its bot's tab, named after its branch. A bot with no
  pane, or a worker on another machine, is peeked instead.
- **Output:** the worker's terminal, then its role, worktree, branch, and agent, model and
  effort, or its template (`--json`: the same as data, with `role` and `template`).
- **Lifecycle:** the bot checks the worker's result, and ends it with
  `am worker kill <terminal>` once the task merges (see
  [Ending a worker](#ending-a-worker)). The bot's briefing says so. As an hc child, a worker
  also ends when its bot's program ends; its branch stays. A worker on a chosen login home
  (#1208) is started with `--outlive-parent` instead: it never ends with its lead, and no
  restart, `--tree` or revive runs it again; it ends when its task ends, by `am worker kill`, the
  worktree sweep, or by hand. It is never a Bot's seat: attach (here or on a linked machine),
  the one-time label import, restart's adoption of a labelled pane and a restart of a binding
  that names it refuse it, by its launch argv (and here, by its ledger rows too: a pane that
  shows no argv while a reservation of its name less than ten minutes old has no start row yet
  is refused as well, and a failed verification marks an observed pane unresolved for the life
  of that instance). A restart that would end it with its parent (hc saying it doesn't outlive
  it, at any depth under the pane) is refused before anything, `--force` included. A local start
  that times out refuses a chosen or unresolved pane that took its name. Linked timeout recovery
  uses the launch signature when `hc ls` supplies argv. An `am` or pack CLI older than this
  release can attach such a worker,
  after which a restart would run it on the seat's login, so chosen homes need both at this
  version or newer; a worker may run for a moment before its launch is checked (on its chosen
  folder); a linked reader sees one as ordinary when its hc reply omits launch argv, including
  the list used for timeout recovery; a process of yours that edits the worktree's settings
  after the last check is not seen; and hc
  has no conditional kill, so `--tree` cleanup still reads a helper's address and ends it in two
  calls (it skips a pane whose core, `created_ms` or launch shows another pane there now). A seat on a
  chosen home (`am restart --agent-home`) is not done: it needs the seat's relaunch (linked
  restart, revive, clear and switch, the restart queue) to carry the home.
- **Cleanup (#567):** a worktree this command made (`created` in the ledger) is removed
  (`git worktree remove`, no `--force`) once every worker that ran
  in it has ended, done or killed, at least 15 minutes ago (hc's `finished_ms`: restart
  `--tree` runs a bot's workers again one at a time, about 1 + 2k minutes at worst for the k-th),
  and no live terminal works in it. Each `worker` call does
  it after its own start, newest first, at most 5 worktrees, and starts no new check after
  about 20 s; one slow check and one large remove (up to 120 s) can still run past that.
  `am reap` does all of them at once.
  - An open pull request's worktree is removed once its workers end, if it is pushed and
    clean. The branch is always kept: only the folder goes.
  - The first sweep after this release covers every older `created: true` row in the
    ledger: 5 per worker call, or all of them with `reap`.
  - Kept, with one line naming the path and why: uncommitted changes (untracked files
    included); a tree no longer on the worker's branch; a detached HEAD with commits on no
    remote; commits on no remote branch, unless `gh pr list --head <branch>` shows the
    branch's pull requests all merged or closed (a squash merge). gh missing or failing keeps
    it. Ignored files (`.env`, build output) do not keep it, but the cleanup names them before
    it removes the folder, so what goes with it is never silent; a list git can't give keeps
    the checkout.
  - A missing checkout is kept while its recorded repository still lists the worktree, since
    its actual repository can't be proved. When the repository no longer lists it (a person's
    `git worktree prune`, say), it is recorded `gone` with a read of `git worktree list`: no
    remove and no prune. A `removed` or `gone` one is never looked at again (#1143).
  - A worktree only given to a worker (`--worktree`, a branch's existing worktree) is never
    removed. A worker call that waited for a worktree the cleanup removed meanwhile never
    starts in what is left: `--branch` makes the worktree again, `--worktree` is refused.
  - Outcomes go to `<app home>/automagik-herdr/worker-reap.jsonl` (`{ worktree, result:
    "removed" | "kept" | "failed" | "gone", why, at }`), never to the workers ledger. A kept
    worktree is looked at again on each call, and its line is said again only when its reason
    changes; a worker call skips one whose reason is a day old (`reap` still looks).
- **Ledger:** `worker`, `start` and `attach` append one row per terminal to
  `<app home>/automagik-herdr/workers.jsonl`: `{ event: "start", kind: "worker" | "seat",
  terminal, pid, botId, task, worktree, agent, model, effort, template, role, branch, project,
  lead, base, created, swap, override, override_requested, generation, sequence, at }` (`at` is
  ISO 8601).
  - `task`: Genie's task id (`--task`), else null; a seat's is null. `project`: the main
    checkout's absolute path, the project key, on seats too. Usage joins to tasks on
    **(project, task)**: task ids are unique per project only.
  - `branch`: the worker's branch. `lead`: the task's lead bot. `worktree`: the worker's
    folder as a real path. `base`: the commit the worktree started from (the base ref's SHA
    when this command made it, else the branch's oldest reflog entry), or null. `created`:
    this command made the worktree. `role`: the worker's role, null for a seat.
  - `swap`: the task ran the bot's swap arm. `override`: the bot picked the agent, model,
    effort or template itself. `override_requested`: on a swap task, what it asked for and
    didn't get, else null.
  - `template` is the hc template a worker runs, else null (seats and agent workers).
  - `generation` and `sequence`: the vendor's Bot login generation and record sequence the
    reader resolved at spawn from ACP's `generation.json` (#1527, #1532). The ledger uses that
    resolution without reading the record again. Both fields are null for a verified legacy
    login, an unusable advisory sequence, or a launch without a Bot login resolution. A
    backwards sequence that the reader accepts is recorded as accepted. A launch the policy
    refuses (a required pointer is missing, the record is unreadable, the chosen home
    differs, or a template is used with the policy on) writes no start row. `am attach`
    records null for both fields because it has no launch-time resolution. A failed append
    is reported and the launch keeps running.
  - Rows written before a field have no such key. A worker row with no `branch` key predates
    the task contract: its `task` is the branch, not a Genie id.
  When a template runs, `agent`, `model` and `effort` are null: the template sets them. The
  briefing hook appends `{ event: "session", terminal, session, transcript, at }` and sets the terminal's `agent.session` label when a Claude session
  changes. A session row can repeat when the label write fails, so consumers dedupe session
  rows on (terminal, session). The rows outlive the terminals, so usage can be tied to bots
  and tasks afterwards.
  - **End rows:** `{ event: "end", kind, terminal, core, created_ms, reason: "replaced" |
    "finished", at }`, one per launch: when the CLI replaced its terminal, or when the cleanup
    found it finished. A `finished` row also copies how hc says the terminal ended (#899):
    `hc_reason` (hc's own word: `exited`, `killed`, `stopped_by_restart` and its others), and
    with it `exit_code` and `signal` when hc gave them. The three keys are left out when hc said nothing, and a status
    or a signal is never written without its reason: usagemeter counts a status with no reason
    as a failed run, and a kill or a restart is not one.
  - **Pull requests (#899):** the cleanup's sweep also asks `gh pr list --head <branch>` for
    the ledger's worker branches and appends `{ event: "pr", project, branch, task, pr, state:
    "open" | "merged" | "closed", first_commit_at, opened_at, merged_at, closed_at, core, at }`
    when it first sees a pull request and each time its state or one of its times changes; the
    newest row of a (project, branch, pr) is the one that counts. usagemeter's time to a pull
    request reads them (`usagemeter outcomes`). The times are gh's own, so a late sweep loses
    nothing. A row never holds a title, an author, a text, a commit or an address.
    - `first_commit_at` is the author date of the branch's first commit, read from git: the
      oldest commit on the branch that is neither in the start row's `base` nor on the branch
      the pull request targets, as `origin` has it (a rebase on it brings its commits in). It
      is null when git can't tell and no earlier row recorded it, and when it is later than
      the pull request's opening (the branch name was used again).
    - A branch is followed until its pull requests have all merged or closed with no worker
      started on it since, or for 30 days after its last worker start or `pr` row. One with an
      open pull request, or pushed with none recorded yet, is asked about a quarter of its
      idle time after the last ask (10 minutes at least, 6 hours at most); a branch git shows
      no push of, an hour after its last worker start, then daily, for 3 days.
    - A `worker` call asks gh for at most 3 branches, the longest due first, inside the
      sweep's 20 s; `am reap` asks for every branch that is due, and for every
      one with an open pull request, or pushed with none recorded yet, whether due or not.
      What gh told the cleanup about a worktree's branch is used as it is. When each branch
      was last asked is kept in `<app home>/automagik-herdr/pr-checks.json`. gh missing or
      failing writes nothing.

## The hc guard (a guardrail, not a boundary)

A pack-started dsh-tui bot pane, and every worker it starts, gets
`mods/am-sidebar/guard/` first on its PATH (`startArgs` and `workerArgs` add it for the
`dsh-tui` agent only). Its `hc` is a deny-by-default wrapper around the real `hc` (#624; the
full send/keys/attach scope is #628): it scans PATH past every guard folder and forwards
allowed calls with the same stdio and exit code. It allows
`send`, `read`, `ls`, `get`, `wait`, `label` (the caller's own workers and
`automagik-herdr.needs-owner` on the caller's own pane), `kill`,
`rm` (the caller's own workers only), `events`, `schema`, `templates`, the doc-only
`--help`/`-h`/`--version`/`--skill` forms,
and one `run` shape: the dsh-tui worker start that `am worker` emits (`--bg`, the
caller as `--parent`, `worker.of=<the caller's bot>`, a `--cwd` under the project's
`.claude/worktrees/`, and `/usr/bin/env PATH=… dsh-tui` after `--`). Everything else is
refused with one stderr line naming #624, #628 and #631, and the real `hc` is never called:
`exec`, any other `run` (including a template or another agent), file writes, edits and reads,
`machine`, `server`, `update`, `connect`, `put`, `keys`, `attach`, a `machine/t7` target on
every verb but `send` (whether typed or returned by `hc get`), and any `--on` outside an allowed
`send`. Herdr-core types keys after about 3 seconds of quiet with no condition, so a guard
check can go stale before delivery. `keys` stays refused until RFC 0044 delivery 6:
herdr-core binds, marks and grants the caller (R1-R3) and checks that grant with every
write (R4, advertised as `checked_input`); then the guard and the proxy allow it together,
to the same set as `send`. `attach` opens a persistent keyboard and stays refused for
sandboxed panes for good (RFC 0044 Q5).

`send` is scoped to the caller's team: its lead chain (`effectiveLead` up), its declared lead
chain (`bot.lead`, then that bot's lead, while each id is listed in the project's bots.json,
planned entries included — so a captain whose lead is a planned Orchestrator reaches it), its
members (`descendantsOf`), the project's main bot (`mainBotOf`), its own workers (`worker.of` =
the caller's bot) and the shared tester/reviewer/fixer ranks in bots.json (`RANKS`). Across
projects (`--lead-project` paired with `--cross-member <bot>@<dir>` on the lead), `send` adds
only the direct `lead <-> member` link (never the lead's upward chain or main bot, and never the
member's team or workers), and the guard and proxy read the other project's `0600` approved
snapshot (`approved/`), never its live `.herdr/bots.json`; a one-sided or unapproved link fails
closed. The existing reviewer/fixer pane-label path also remains; a `role=tester` label alone
grants nothing.
A captain bot may send to another squad's captain when both bots.json ranks are `captain`.
Its workers do not inherit that rule, and a `role=captain` label alone grants nothing.
A pm, integrator or fixer bot the project lists may also send to any bot the project lists,
planned entries included: their job is to message the Orchestrator, the captains and each other.
That rank is the caller's
bots.json entry, never its pane's `role=` label or an environment variable, and a worker of
such a bot does not inherit the widening. The caller comes from the attach ledger, the
authority; a worker pane has no ledger row, so its `worker.of` label names its bot and its
cwd's project. The target is resolved with the real `hc` (`ls` for a name, `get` for the
labels). Any target outside that team is refused. `read`, `get` and `wait` are scoped to the
same graph — the caller's own pane, its own workers and its team — and the shared send roles do
not widen them. For `send`, `read`, `get`, `wait`, `label`, `kill`, `rm` and both `hc events`
target options, the guard forwards the checked address from `hc get`. A rename between the check
and the call cannot redirect it. With `--on`, the guard verifies that address is on the named
machine and forwards its bare terminal ID. `rm` ends the caller's own workers only (`parent` is the caller's pane,
or `worker.of` is the caller's bot); a team member's seat, another bot's worker and every
stranger are refused, and a worker pane ends nothing. The launch briefing carries the guard
paragraph only for a dsh-tui bot; a claude, omp or hermes briefing is unchanged. On a linked
machine the seat uses the guard folder that machine has, beside its own `automagik-herdr`; with
none it gets no guard, no briefing paragraph claiming one, and one warning naming #624.

A send to a pane held by a dialog is refused before anything is typed (#1414). The wrapper
reads the target's herdr-core status and, when it is neither working nor blocked, its screen
(the restart planner's `pendingDialog`); a pane running agy is also read once when working, for
Antigravity's two prompts (see "Antigravity's prompts: Needs you");
a blocked pane or a visible question, permission or sign-in dialog gets one JSON error line on
stderr, kind `blocked`, naming the pane, and exit 9 (hc's own `blocked` code), so a relay can tell
it from a transport error and route the message elsewhere. It never presses a key and never answers the dialog, and `--force` does not bypass
it. A free pane's message is forwarded as given. When the screen cannot be read, hc handles
delivery. This is the pack's wrapper: a sender that bypasses it with an
absolute hc path, `hc connect` or a raw socket still reaches herdr-core's delivery, where the
hold belongs.

**This is a guardrail, not a boundary.** A bot can bypass it with an absolute path to the real
`hc`, a raw socket client, or `hc connect`. The team data is still writable: a bot that edits
its project's `.herdr/bots.json` can widen its own `send` scope (for example by giving itself
the pm, integrator or fixer rank), and a bot can label its own workers. For the own-pane label
exception, the guard trusts `HC_TERMINAL_ID`. Forging it can use that exception to set or clear
only `automagik-herdr.needs-owner` on another local pane. With the proxy on, the per-pane socket
fixes the caller's identity independently of that environment variable. `ls` and `events` stay
cross-pane (a wrapper cannot filter a table's text or a stream without changing what the real
`hc` printed), and `kill` is the project's main bot's; the per-pane proxy is where a sandboxed
pane's list is filtered and its events are refused. The real
fix is the sandboxed socket mask plus the per-pane filtering proxy wish (#624), and #631 is the
hard boundary. This wrapper only stops the ordinary `hc exec` attempt while that lands. The
pack's own CLI still reaches the real `hc` for its trusted calls (system status, machine lists,
remote file/exec, docs), so `am worker` and the remote commands keep working in a
guarded pane.

### The per-pane hc proxy (the sandbox boundary, opt-in)

The proxy is **off by default** for every bot. Set the bot entry's `hcProxy` boolean with
`am edit <bot> --hc-proxy on|off`, then run `am proxy approve --project <dir>`.
Review the preview, run the printed command with `--confirm <digest>`, and restart that bot.
The effective value comes from that bot's
entry in the approved snapshot, read at each start, restart and worker start. Approved on stays
on when a pane changes the working key to false or removes it. Working on with approval off
or missing refuses with an instruction to preview and confirm with `am proxy approve` first.
Invalid approval refuses working on. Working off starts plain, preserving its argv, with a
loud STDERR warning naming the record, the problem and `am proxy approve`:
invalid approval cannot be trusted to say on. Known limit: previously approved on plus a
working off edit and an invalid record starts plain with that warning. A sandboxed pane
cannot write the approved record; only an outside change can cause that combination.
`show` and `dsh-tui doctor` print both values; doctor warns about invalid approval regardless
of the switches, and warns
when working off still has a running proxy and retains install checks for a malformed roster.
Only Linux pack-started dsh-tui seats and dsh-tui workers get the helper.
A local start on macOS ignores the switch and starts plain, with no pack mask yet (RFC 0044 §F).
While that bot's approved record is valid and on, `am dsh-tui doctor --project <project>` warns for
it. The rollback's edit, preview and confirmation, each with `--project <project>`, clear the warning.
`AM_HC_PROXY` no longer opts in
other bots. C2b-1 prepares the approved switch; leave it off until C2b-2's approved-worker
allowance and C2c's coordinated sandbox-row enablement have shipped. The profile row stays
unchanged. For rollback, run `am edit <bot> --hc-proxy off`, preview with
`am proxy approve --project <dir>`, review and confirm with `--confirm <digest>`, then run
`am restart <bot>`. End and relaunch any existing workers that also need rollback.
Linked starts check the target platform and, on Linux, the target's approved switch.
Approved on refuses until they can verify the proxy execution path; start locally on the
target computer instead. Non-Linux targets ignore the switch.
If the target platform cannot be checked, working off starts plain with a warning and working
on refuses.

When it is on, a pack-started dsh-tui pane runs through one helper,
`mods/am-sidebar/hcPane.mjs`: it starts the pane's hc proxy in its own process
**before DSH starts**, then runs the agent as its child. The proxy reads the project's approved
roster before the pane can create a sandbox, and it ends when the pane ends. The record
lives outside the project, is written 0600 by
`am proxy approve --project <dir> --confirm <digest>`, and is the only
roster the proxy reads. **A roster change needs a pane restart** after confirmation, so the new pane's
proxy reads the newly approved record. A working-tree edit that differs warns once, naming
the command, and still starts on the approved roster; a missing record refuses a proxied
pane. A worker's record is keyed by the main checkout the pack resolved (its lead seat's
project), never by the worktree it owns. A proxied bot cannot unset the switch in its own
shell to start a plain worker: the proxy refuses the old five-word worker argv and accepts
only the helper's own shape, which runs from a stable copy under the data home (never the
writable pack folder). A node upgrade (nvm, Homebrew, bun) needs `dsh-tui install` again:
the stable runner bakes one absolute node. Its own README, `mods/am-sidebar/hcProxy.md`,
has the policy, the start checks and the run command. A pack update that changes the
wrapper needs `am dsh-tui install` again; an opted-in pane refuses to start
while the profile's sandbox row is stale.

Approval-root checks apply only to `proxy approve` and proxied starts. Plain `dsh-tui`
install/check keeps the stable execution root checks without validating approval storage.

Residual, in the command's own help too: a sandboxed bot can ask an in-team unsandboxed pane to
run `proxy approve`. The preview is the check, and running `--confirm <digest>` is the person's act.

The helper sets `DSH_SANDBOX_MASK=1`, `AM_HC_REAL_SOCKET` and `AM_HC_PROXY_SOCKET` for the
pane; the DSH runner wrapper applies its mount rules and binds the proxy at the real core socket
path, so the real socket folder is hidden, and binds the data parent read-only once (the
stable execution folder and `approved/` both live there) so a sandboxed bot cannot rewrite its
helper, runner or guard, or its project's approved roster. The wrapper is copied byte-equal from
`mods/am-sidebar/bin/hc-socket-mask.mjs` to `~/.local/share/automagik-herdr/dsh-sandbox/` by
`dsh-tui install`, which also installs the profile's managed sandbox row. The proxy supports
herdr-core 0.1.14 and 0.1.21 and checks the serving version on every upstream connection. Its
socket lives in `$XDG_RUNTIME_DIR/automagik-hc-proxy/<terminal>/hc.sock` (0700 folder, 0600 socket), outside
the worktree and the app home. **Fail closed:** if the proxy cannot start, the pane's command is
never started, so no sandbox exists and `hc` cannot auto-start a core inside one; a proxy that
dies takes its pane with it. The wrapper also gives the pane its own network namespace
(`--unshare-net`), so the host's loopback, the host's LAN and the host's own addresses are not
reachable from inside; the only loopback port the pane gets is the wrapper's egress relay on
127.0.0.1:3128, whose host-side CONNECT proxy allows public destinations only. Raw TCP and SSH
have no egress, and a host where the namespace cannot be made refuses the pane instead of
falling back to the host network. The proxy itself still filters the hc socket, not the box's
listeners; the namespace is the network boundary (#700, #743; `apps/dsh-sandbox/README.md`,
"The network: own namespace, one loopback relay").

## The Create form

**New bot** at the foot of the sidebar opens the form: a live preview of the bot's character,
its name, look, role and instructions (at most 4,000 characters), the agent it runs on, the
model it uses, whom it reports to, its category, and whether it is planned for a later wave.
The footer shows the matching `am create …` line, ready to copy. The form writes
`.herdr/bots.json` in the project's main checkout, or, from a focused worktree space, in that
worktree. The form then says where it saves and that the sidebar shows the bot once the change
is merged, stays open after saving, offers no Create & start (bots start from the main
checkout's file), and warns when the main checkout's `bots.json` isn't committed, has local
changes, is deleted in the working tree (a merge pull restores it, a rebase pull refuses), or
was deleted in a commit (the pull ends in a modify/delete conflict).

The form starts on the focused space's project. A folder picked from the project chip is the
project itself outside git, and with no `.herdr/bots.json` yet it is a new project whose
first bot is its main bot. When the focused folder is outside git and sits under another
project's folder, the form asks: that parent project, or the folder as its own project. A
focused folder that no longer exists is not used; the form asks for the folder. The sidebar
still places panes by the walk-up, so a folder joins its own project once it has its file.

## Updates

```bash
am update --check      # the installed and the latest version
am update              # download, verify against the signed pointer, install
am update --rollback   # put the replaced set of mods back
am update --retry-skipped  # install the release a rollback skipped, and clear that record
am update --auto off   # Install updates automatically: on (default), off, or status
```

**Install updates automatically** is on by default: when the sidebar's check finds a newer
release, it installs it the same way `am update` does (the signed pointer, the
sha256, the replaced set kept for `--rollback`), Herdr reloads the mods, and one notice says
"Automagik Herdr updated to X". Your bots keep running: they live in herdr-core, not in the mods.
A version you rolled back with `--rollback` is never installed on its own again; it waits for a
newer one. The skip outlives the run that wrote it, so an install that already rolled back keeps
the skipped version in `auto-update.json` (with its cause, `skipCause: "mods"`, when the restore
knew it); to re-attempt it by hand, run `am update --retry-skipped`, which clears the recorded
skip for the release it installs and then updates. An ordinary `am update` installs the skipped
release too (the skip holds only automatic updates) but leaves the record, and a skip recorded
from a real mod failure is never cleared by an ordinary update: only `--retry-skipped` clears it,
or a newer release moves past it. A failed install posts one notice with the reason, changes
nothing, and tries again
4 hours later; each further failure of that release waits longer (8, 16, then 24 hours, then
daily), with no second notice. Turn it off with `am update --auto off` or the switch
in the status bar; then a new release is only announced, as before. It applies only to a pack
`install.sh` installed from a signed release (its record in `<app home>/automagik-herdr/` has a
`sequence=`); the setting lives beside it, in `auto-update.json`.

### Every linked machine

```bash
am machines                        # what each machine runs, and how its last update went
am machines update                 # one update of them all now
am machines --auto off --machine M # M opts out (on again: --auto on); no --machine: this computer
```

The machines linked into your Herdr (`hc machine ls`) follow the releases too, with no one at each
of them. About 90 seconds after the sidebar loads and then once an hour, the computer that runs
Herdr starts `am machines update`: on each connected machine it runs that machine's
own `am update` (am, then the pack where one is installed), so every check is made there, by the
copy installed there, against the keys it pins: the signed pointer, the tarball's sha256, never a
release older than one it took, and the replaced copy kept (`am rollback automagik.am`,
`am update --rollback`). The pack there takes the machine's **automatic** path (#1505): its own
setting (`am update --auto off` on that machine) and a release it rolled back hold the pack,
exactly as they hold the machine's own auto-update; a person's explicit `am update` there
(`--retry-skipped` also clears the record) is still the only way to install a skipped release.
Then usagemeter, as `meter
install` does (the signed meter-lane pointer checked here, the build's sha256 on the machine, never
a downgrade, the old binary kept as `usagemeter.prev`): on a machine that has one, or on all of
them once you agreed to that, and never after `install.sh --no-usagemeter`. This computer's am and
usagemeter follow in the same run; its pack is the sidebar's own update above.

`am machines` shows the last answer of each machine: its am, pack and usagemeter
versions, both switches (its own pack auto setting and the linked updater's) and what the last run
did or why it did not (a pointer it could not verify, a download that failed, a machine that was
not connected). A machine that was not updated is also said once in a notice. The record is
`<app home>/automagik-herdr/linked-updates.json`.

The linked updater is on by default. A machine opts out with its own switch, the file
`~/.automagik/linked-update` holding `off` (`am machines --auto off` there, or `--machine M` from
here): the run reads it first and starts nothing on that machine. This is not the machine's pack
setting (`am update --auto off`, shown as `pack auto`): that one holds the pack alone, while this
one stops the whole linked run. `AUTOMAGIK_HERDR_NO_UPDATE=1` on the computer
that runs Herdr turns the whole run off.

Updates come from the Automagik monorepo's GitHub releases, through one signed pointer: the
`herdr-lane` release's `pack.json` names the newest pack release (not GitHub's "latest", often a
desktop or plugin release without it), and `pack.json.sig` signs it. The sidebar looks 20 seconds after it
loads and then every 4 hours, and installs a newer one (or, with the switch off, shows one notice
per new version with the command to run).
When it can't look (no network, no `node`), it says nothing and tries again in 30 minutes.
Set `AUTOMAGIK_HERDR_NO_UPDATE=1` to turn both off. A pack installed as a link to a checkout
is never replaced: update it with git.

The pointer is ed25519-signed with the pack's own key; the installed pack carries the public keys
(`mods/am-sidebar/pack-keys.json`) and refuses a pointer it can't verify, then a tarball whose
sha256 is not the one the pointer names. So an update shows who published it, not only that the
download is intact. `install.sh --version <v>` is the exception: a named older release is checked
against its own `.sha256` alone, and the installer says so.

## Pane labels

A bot's pane carries hc labels that say which bot it is, so tools such as herdr-meter can
stamp events with them (`actor.bot`, `actor.role`, `actor.squad`):

| Label | Value |
|---|---|
| `bot` | the bot's id |
| `role` | `main` for the main bot; `captain` for a bot that leads other bots; otherwise its `rank`. No rank, no label. |
| `category` | the category it shows under (a deeper member: its chain's category), when there is one |
| `squad` | the team, set by the team-assembly helper (`squad=memory`). Never overwritten. A pane with none gets its lead's pane's squad, and `automagik-herdr.squad=<that squad>` records the copy. |

They are a hint for display and for those tools; which pane plays which bot is the
[attach ledger](#the-attach-ledger)'s answer. Start sets them. Attach leaves the pane matching its bot: a `role=` or `category=` the bot
doesn't have (left by the pane's last bot) comes off. An edit that changes a bot's rank, lead or category, or a lead's
captain status, rewrites the labels on the live panes of the bots it changes; a squad this
pack copied (the pane's `squad` still equals its `automagik-herdr.squad`) follows a lead
change, or comes off when the new lead's pane has none. Detach takes off `bot`, any `role`
and any `category` (nothing else sets those two today), the `automagik-herdr.squad` mark,
and `squad` only while it still equals the mark: a squad set after the copy stays. Only panes
on this computer are labelled. The lead's pane is the one the attach ledger ties it to.

## Reference

### `.herdr/bots.json`

```json
{
  "version": 1,
  "categories": [{ "id": "eng", "title": "Engineering", "sub": "build and ship" }],
  "bots": [
    { "id": "b-k3m7q2zt5x", "name": "Genie", "kind": "main", "look": { "character": "octopus", "colour": "deepseek" },
      "role": "Runs the project", "instructions": "…", "agent": "claude", "model": "claude-opus-5-5" },
    { "id": "b-a2b3c4d5e6", "name": "Captain", "kind": "member", "category": "eng", "look": { "character": "star", "colour": "blue" },
      "role": "Squad lead", "instructions": "…", "agent": "codex" },
    { "id": "b-f7g2h3j4k5", "name": "Dev", "kind": "member", "lead": "b-a2b3c4d5e6", "look": { "character": "moon", "colour": "green" },
      "role": "Builds", "instructions": "…", "agent": "claude" },
    { "id": "b-m5n6p7q2r3", "name": "Studio", "kind": "member", "category": "eng", "look": { "character": "bunny", "colour": "violet" },
      "role": "Access and studio", "instructions": "", "planned": { "wave": 3, "note": "waits for the auth v2 decision" } }
  ]
}
```

- Exactly one bot has `kind: "main"`. Every other bot is a `member`.
- `lead` is the id of the bot a member (or a `main` bot with `leadProject`) reports to. Without
  one, a member reports to the main bot. `leadProject` is an optional absolute main-checkout
  path (`--lead <bot> --lead-project <dir>`, cleared with `--no-lead-project` or
  `--lead-project=""`): the lead lives in that other project on the same machine, and the bot
  (or the whole team under a cross-project `main` bot) nests under that lead in the sidebar,
  receives briefings and parent pane wiring across the two projects, and can exchange `hc send`
  messages with its cross-project lead chain and reports. A lead (or `leadProject`) that is
  missing, planned or part of a cycle falls back to the project's main bot (or no lead for a
  `main` bot), and the row shows a warning.
- `category` places a bot that reports to the main bot under a category header. Bots
  deeper down show under their lead and ignore it. A category id is a lowercase slug
  (`a-z`, `0-9`, single dashes, like `quality-gate`), since it goes into a pane label. A new
  id must be one (`category add --id`, the form's new category). An id already in the file
  that isn't one (`Knowledge`, written by hand) keeps working, with a warning, and gives its
  bots no `category=` label.
- `planned` marks a bot that is not started yet. It needs no `agent`.
- `instructions` holds at most 4,000 characters.
- `code` is an optional boolean, defaulting to `true`. Set `code: false` for a bot whose
  work is not code with the **Code bot** toggle in the bot editor or
  `am edit <bot> --code false`; `--code true` restores it.
  Create accepts the same option; `show` prints it and `ls` marks code opt-outs. Both launch and full briefings
  include the instruction to start a worker only for code bots in a Git working tree,
  including linked projects; if the per-turn hook's Git check times out, it reuses the
  Git answer recorded by an earlier hook call. On the first hook call there is no recorded
  answer; a matching launch briefing hash can establish that the project was in Git.
  Without either, the worker instruction is omitted, leaving the bot's own instructions to lead.
  Other edits, installs and updates keep the setting in the project's roster.
- `model` is an optional pin, picked from the agent's known models (never typed freely).
  Start passes it with the agent's own model flag; a pin the agent doesn't list (an old
  free-text model) is skipped by the sidebar with a note and refused by the CLI. A running
  bot shows the model its pane runs: the one its command line names, else the agent's own
  configured default. A bot that isn't running shows no model in its sidebar row
  ("not running · role"), while `am ls` and `show` print its pin, else that default.
- `effort` and `tier` are optional Codex settings: the bot's own reasoning effort (`low` …
  `ultra`) and service tier (`fast` or `standard`). `create|edit --effort E --tier fast|standard`
  sets them; an empty value clears one. Every start, restart and revive passes them as that
  launch's own `-c` overrides, after the agent's and its template's own words, so the record wins
  over a Codex profile and the global config (which is never written). A `--model` change without
  `--tier` runs the new model on standard, stored and said on the launch line, so a Fast a
  profile or the host config still names never applies to it. `show` prints both with their
  source, and `show --json` carries `effort`, `effortSource`, `tier`, `tierSource`,
  `pinnedEffort` and `pinnedTier`. See
  [Reasoning effort and service tier](#reasoning-effort-and-service-tier-codex).
- `permissionMode` is optional: a Claude Code bot's own `--permission-mode`, set with
  `am create|edit ... --permission-mode MODE`. One of Claude Code's names (`acceptEdits`, `auto`,
  `bypassPermissions`, `manual`, `dontAsk`, `plan`); `auto` is the pack's default when the field
  is absent, and an empty value clears a stored one. Every start, restart, revive and Claude
  worker helper launch passes it from the record, independent of the model, reasoning effort and
  service tier. A value Claude Code doesn't accept, or one on another agent, is refused with the
  accepted names rather than passed through or dropped. `show` prints it with its source
  (`detected`, `live`, `roster` or `default`), and `show --json` carries `permissionMode`,
  `permissionModeSource` and `pinnedPermissionMode`. See
  [Permission mode](#permission-mode-claude-code).
- `codexAuto` is retired (#1125). It used to opt a bot's Codex seat and workers out of Codex's
  auto mode; the owner's ruling (10 and 12 Nov) is that every Codex seat and worker runs in it,
  so `false` no longer opts out: the field is kept as written, ignored, and loading the bots
  file warns once ("codexAuto false no longer opts out"); remove it. A value that isn't a boolean
  is still dropped with a warning (and refused by `check`). See
  [Codex's launch mode](#codexs-launch-mode).
- `personFeatures` is an optional boolean, defaulting to `false`: a Claude Code bot's launch
  turns off the suggested next prompt, the away summary and the subagent progress summaries
  (#1558, [Claude Code's person features](#claude-codes-person-features-1558)). Set it with
  `am edit <bot> --person-features on` (create accepts it too) for a seat a person talks to all
  day; `--person-features off` clears it. A value that isn't a boolean is dropped with a warning
  (and refused by `check`); any other agent ignores it.
- `agyMode` is optional: the Antigravity execution mode Start and Restart pass as
  `agy --mode <mode>`. One of `auto` (the default when absent), `accept-edits` or `plan`; any
  other value is refused at launch with one line and never passed to agy. It applies only to
  an Antigravity seat. Where agy can't run `auto` (see
  [Automatic mode](#automatic-mode)) it continues in manual mode, so a roster that names `auto`
  itself gets one warning at launch on such a host. The pack never writes
  agy's own saved settings; each launch's own `--settings` file lists just that launch's
  folder in `trustedWorkspaces` (see below) -- the project folder for a seat, the worker's
  worktree for a worker, the helper's folder for a helper, a review worker and a reviewer seat
  included -- so the rest of the person's trust list and saved settings stay theirs.
  `create|edit --agy-mode` sets it (`--agy-mode auto` or an empty value clears it back to the
  default); setting it on another agent warns that it only applies to Antigravity. The form
  offers it for an Antigravity bot. Other edits, installs and updates keep it in the roster.
  `show`, `ls` and `dsh-tui doctor` print it.
- `agyPermissions` is optional: rules an Antigravity bot and its workers add to the permission
  list every launch carries (#823). `{ "allow": ["command(npm publish)"], "deny": ["command(git stash)"] }`,
  each list optional. A rule is `command(<the words it starts with>)` or
  `write_file(<an absolute folder>)`; anything else is dropped with a warning and never reaches
  agy. The launch's own allow list (its scope and rank or role) and the fixed deny rules (the
  force-push, history-rewrite and release escapes listed below) are always there, so this field
  only ever adds rules: it cannot drop a fixed deny.
  `create|edit --agy-allow RULE` and `--agy-deny RULE` (repeatable) set a list; one empty value
  clears that list and `--no-agy-permissions` clears both. The form keeps the field as it is.
  `show` prints the effective lists, `ls` their counts, and `dsh-tui doctor` the lists per bot
  plus a host-level row saying whether agy's terminal sandbox (and so `--mode`) is available.
- `rank` is optional: one of `captain`, `dev`, `tester`, `reviewer`, `fixer`, `integrator`,
  `pm`, `owner`. It sets the pane's `role=` label (see [Pane labels](#pane-labels)). `main` is not a
  rank: `role=main` belongs to the main bot alone. The free-text `role` is separate and goes
  to the briefing. An unknown rank is ignored with a warning. The form offers ranks as chips
  for team members; `am create|edit --rank R` sets one (`--rank=` clears it).
- `worker` is optional: `{ "agent": "codex", "model": "gpt-5.5", "effort": "high", "agyMode": "plan" }` or
  `{ "template": "dev-sol" }`, each key optional, the defaults of the bot's
  [workers](#workers). Without `agent`, workers run the bot's own agent; a `template` (an hc
  template name: letters, digits, `.`, `_`, `-`, no dash first) wins over `agent`, `model`
  and `effort`. `agyMode` is the Antigravity workers' `--mode` (auto when absent or empty).
  A template owns its command line: add `--mode` to the template's command if needed;
  `worker.agyMode` adds no mode flag to a template worker.
  `create|edit --worker-agent/--worker-model/--worker-effort/--worker-template/--worker-agy-mode` set them
  (an empty value clears one); the form keeps the field as it is. An invalid one is ignored
  with a warning. A Codex worker runs [Codex's launch mode](#codexs-launch-mode) like its bot's
  seat; a `template` owns the command and gets no flag.
- `worker.agentHome` (#1208) is an optional absolute folder: the login home a worker on the
  bot's default worker agent (`worker.agent`, else the bot's own agent) runs on, Claude or Codex
  only, never beside a `worker.template` (see the worker's login home in [Workers](#workers)).
  `am create|edit --worker-agent-home DIR` sets it and `--worker-agent-home=` clears it. The save
  checks its shape only; each launch checks the folder on its own machine. An edit that changes
  the default worker agent drops it unless the same edit gives it again, and a writer that has
  no field for it (the form, `restart --save`) keeps it while that agent stays and never brings
  back one that was dropped. A worker object the file has to drop (a field that isn't text) takes
  no launch with a home: one that would use it is refused, never run without those defaults.
- Ids are `b-` plus 10 lowercase base32 characters. A bot's terminal carries the hc label
  `bot=<id>`.

### Automatic mode

The launcher starts every bot and every worker in its agent's automatic mode, so an unattended
pane never stops at an approval prompt only a person can answer (#955). The words come from the
agent's definition on every start, restart, linked-machine start, worker and Restart --tree
helper, never from an old pane's command. A `programs.json` run that already names one of an
agent's own approval flags is left as the person wrote it (Codex's excepted: its approval and
sandbox words are left out, by name, #1125), and an hc template owns its command: the pack adds
nothing to it (a Codex seat's template excepted, see [Codex's launch mode](#codexs-launch-mode)).

| Agent | What its launch adds | What that does |
| --- | --- | --- |
| Claude Code (`claude`) | `--permission-mode auto` | Claude Code's auto mode: its classifier answers permission requests. |
| Codex (`codex`) | `--approve-for-me --disable hooks --no-daemon -c sandbox_workspace_write.network_access=true -c allow_login_shell=false`, `--add-dir <folder>` per derived folder; worker starts only: `-c 'projects={"<worktree>"={trust_level="trusted"}}'` when the checks below allow it | Codex's auto mode: its reviewer answers approval requests, inside the workspace-write sandbox (#946), its hooks are off (#1045), so startup never stops at "Hooks need review" and never runs an untrusted `.codex/hooks.json` command in an unattended pane, and it runs in its pane, with network and the folders it needs (#1125). Its commands run in a non-login shell, so a login startup cannot shadow the pane's hc kill shim (#1133). Worker starts pre-trust only their worktree path (#1420); a withheld trust word gets a warning. No opt-out from the launch mode. |
| Antigravity (`agy`) | `--dangerously-skip-permissions`, `--mode <agyMode>`, `--settings <file>` | No permission prompt and no classifier: everything the file's deny list does not name runs (see [what runs without a prompt](#antigravitys-permission-list)). The file's `trustedWorkspaces` answers the folder-trust question. |
| dsh-TUI (`dsh-tui`) | nothing | Its DSH profile on the machine it runs on sets the approval policy; dsh-tui takes no such flag. |
| Oh My Pi (`omp`) | nothing | omp 18.14.2 has only skip-all flags (`--auto-approve`, `--approval-mode=yolo`). |
| Hermes (`hermes`) | nothing | Hermes 0.22.5 has only a skip-all flag (`--yolo`). |
| Pi, OpenCode, Cursor, Copilot, Amp, Grok, Kimi, Kiro, Qoder, Crush | nothing | Not checked: none is installed where the flags were read (2026-11-10), and the pack adds no flag it has not seen an agent's own help name. |

A Claude Code bot may name another of Claude Code's own permission modes for its seat (and its
Claude workers and helpers) with `permissionMode` / `am edit <bot> --permission-mode MODE`; the
launch then passes that mode instead of `auto`, and the rest of the table is unchanged. See
[Permission mode](#permission-mode-claude-code). Codex's and Antigravity's modes are not per-bot
settings: Codex's launch mode is fixed (#1125), and Antigravity always runs without prompts under
its deny list, its execution mode set by `agyMode`.

Flags read from claude 2.1.322 (the permission-mode list from 2.1.328), codex-cli 0.167.0 and agy
1.5.4. No skip-all-approvals flag is passed for any agent but Antigravity; one for another agent
needs the owner's word first.
`am show <bot>` prints the bot's `auto mode` line (in `--json`, `autoMode`: its
words, a note, and for an Antigravity bot on this computer whether agy's sandbox can run here).

### Claude Code's person features (#1558)

A Claude Code bot seat launches with the features meant for a person at the keyboard switched
off: the suggested next prompt and the away summary, as `promptSuggestionEnabled: false` and
`awaySummaryEnabled: false`, and the progress summaries of running subagents, as
`CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1`. All three ride on the launch's own
`--settings` inline JSON (its `env` carries the variable), so the host's
`~/.claude/settings.json` is never written and a person's own session there keeps them. Every
Claude launch the pack builds gets them: a start, a restart, a linked-machine start, a worker
and a Restart --tree helper. A run that names its own `--settings` file is left as it is (that
file is the person's own, and a linked machine's file can't be read here), and an hc template
owns its command. A bot a person talks to all day keeps them with `personFeatures: true`
(`am edit <bot> --person-features on`; off is the default); `am restart` applies an edit.

Antigravity is the exception, measured on agy 1.5.4 on Linux and macOS: `--mode auto` is not
available where agy's terminal sandbox can't run (restricted unprivileged user namespaces, say)
or where the account lacks it, and agy then continues in its default manual mode. It says so
only in print mode ("warning: --mode auto is not available ..."); an interactive pane shows
nothing and stops at its first command. `--dangerously-skip-permissions` removes every prompt
and still enforces the `permissions.deny` list of the launch's `--settings` file, in every part
of a compound command (`echo hi && git push --force` is refused: "Matches user-configured deny
rule"). So an Antigravity launch gets the flag only beside that file: a launch with no file (a
helper with no bot to write one for, a command that takes no words) has the flag taken out. The
flag does not answer the folder-trust question; the file's `trustedWorkspaces` does (#953).
`dsh-tui doctor`'s `agy-sandbox` row and `show` say when this computer can't run `--mode auto`.

### Reasoning effort and service tier (Codex)

A Codex bot may store its own reasoning effort and service tier, so two bots on one host can run
at different ones without touching the person's global Codex config (#1411):

- `effort` is an optional effort level (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`; whatever
  the Codex CLI lists for the model), set with `am create|edit ... --effort E`.
- `tier` is optional, `fast` or `standard`, set with `--tier fast|standard`. It stores the menu's
  words: Fast is Codex's `priority` service tier, Standard its `default` one.

Both are stored on the bot (`am edit <bot> --effort= --tier=` clears them) and passed on every
launch as that launch's own overrides: `-c model_reasoning_effort=<effort>` and
`-c service_tier=<priority|default>`. A start, a restart, a revive after a reboot and a linked
machine's start all rebuild the command from the bot's record, so all three keep the values. The
global `~/.codex/config.toml` is read for what a bot with neither inherits, and is never written.

What wins, when more than one names a value:

1. the bot's record (`effort`, `tier`), added after the agent's own words;
2. the hc template the pane runs, whose own `-c` words come first in the command; the record's go
   after it, so the record wins when both name one;
3. the Codex profile the launch names (`-p <profile>`), if any: the file
   `~/.codex/<profile>.config.toml`, which Codex layers on the global config;
4. the global Codex config.

Codex reads the last `-c` for a key, so a later word wins. A service tier belongs to the model
choice: `am edit <bot> --model M` without `--tier` in the same call runs the new model on
Standard, stored as `standard` and passed as `-c service_tier=default`, so a model swapped for a
standard one never keeps a Fast that the record, a profile, a template or the host's config still
names. Workers take their agent, model and effort from the worker defaults or a template, never
from the seat's `effort`/`tier`.

`am show <bot> --json` reports the effective values and their source: `effort`, `effortSource`,
`tier` and `tierSource`, beside `pinnedEffort` and `pinnedTier` (what the record stores). A source
is `detected` (what the live pane's command line runs, a template's own words included), `roster`
(the bot's own value, when it isn't running), `profile` (the Codex profile the live launch names:
`-p <name>` layers `~/.codex/<name>.config.toml` on the global config), `global` (that global
config's top level) or `default` (Codex's own default tier, Standard). The text `am show` prints
the same two lines.

### Permission mode (Claude Code)

Claude Code's `--permission-mode` decides what a session may run without asking. The pack starts
every Claude launch in `auto` ([Automatic mode](#automatic-mode)); a Claude Code bot may store one
of Claude Code's own modes instead, in `.herdr/bots.json` as `permissionMode`:

| Mode | Runs without asking |
| --- | --- |
| `manual` | reads only; anything else asks a person |
| `acceptEdits` | reads and file edits |
| `plan` | reads and plans; edits wait for a person's approval |
| `auto` | everything, through Claude Code's classifier (the default) |
| `dontAsk` | only what is already allowed; anything else is refused instead of asked |
| `bypassPermissions` | every tool call, with no prompt |

`am create ... --permission-mode MODE` stores one and `am edit <bot> --permission-mode MODE`
changes it; `am edit <bot> --permission-mode=` clears it back to `auto`. Only Claude Code's own
names are accepted: another word is refused with the list, and so is a mode on an agent that has
none (Codex's launch mode is fixed, #1125; Antigravity's execution mode is `agyMode`), never
passed through or dropped. `bypassPermissions` is the one that runs an orchestrator seat with no
prompt at all; use it only for a bot the owner means to run that way.

Every launch path the pack builds rebuilds the command from the record: a start, a restart, a
revive after a reboot, a linked machine's start, a worker and a worker's Restart --tree helper.
It is independent of the model, reasoning effort and service tier: a model change never rewrites
it, and it never changes the model. A Claude worker helper inherits its seat's mode; a non-worker
helper keeps the command a person gave it, its own `--permission-mode` included, and the seat's
mode is never added to one that names none; a worker template owns its command, so the pack adds
no flag to it (put the mode in the template's command if it needs one).

`am show <bot>` prints `permission <mode> (<source>)`; `show --json` carries `permissionMode`,
`permissionModeSource` and `pinnedPermissionMode`. A source is `detected` (what the live pane's
command line runs), `live` (the pane is running and the pack reads no `--permission-mode` in its
command line: `permissionMode` is `null`, and the record's mode, or the pack's `auto`, applies to
the next start), `roster` (the bot's own value while it isn't running) or `default` (the pack's
`auto` when the record stores none). A live pane is never reported as running the record's mode:
for one that names none, `am show` says the live command line names none and the record's mode
applies to the next start, and its `auto mode` line names what the pane actually runs.
A hand-written value the CLI wouldn't accept is dropped with a warning when the file is read, so
it never reaches the launch; every command that reads the record says that warning once, `am
start`, `am restart`, `am revive` and `am show` included, not only `am ls` and `am worker`.

The accepted names are pinned, never read from the CLI at launch: `CLAUDE_PERMISSION_MODES` holds
Claude Code 2.1.328's `--help` list. `herdr/test/permission-mode.test.mjs` compares it with the
`--help` of the Claude Code on the PATH of a gate that has one and fails when the lists differ, so
an upgrade that adds a mode is seen in the gate instead of silently refusing a valid value. The
test skips where Claude Code isn't installed, so the manual step stays: re-read `claude --help` and
update `CLAUDE_PERMISSION_MODES` in `models.js` and this table together.

### Codex's launch mode

The owner's ruling (10 Nov, reaffirmed 12 Nov, #1125): every Codex seat and every worker the pack
starts with `--agent codex` runs Codex's auto mode with its sandbox on, and the pack never
passes `--dangerously-bypass-approvals-and-sandbox`. One mode on every machine, built from the
definition on a start, a restart (resume, fresh, agent or model swap), a linked machine's start,
a worker and a Restart --tree helper:

- `--approve-for-me --disable hooks`: the auto mode above. Codex 0.167 refuses it beside
  `-a`/`--ask-for-approval`, `-s`/`--sandbox` or the bypass flag, and it wins over a config
  file's `sandbox_mode` and `approval_policy`.
- `--no-daemon`: `hc --skill` says Codex must run with it, templates included, or its commands
  run in Codex's shared background server, outside hc and with the environment of whichever pane
  started that server (`HC_TERMINAL_ID` included). That is a strong candidate cause of a restarted
  Codex captain's `isn't a terminal hc knows` refusal; it was not reproduced in isolation.
- `-c sandbox_workspace_write.network_access=true`: the sandbox's own network switch, so `hc`'s
  socket and GitHub (`gh`, git's transport) answer. It is off by default under the auto mode.
- `-c allow_login_shell=false` (#1133): Codex runs every command through the account's login
  shell by default, and a login startup that prepends a folder (macOS's `/etc/zprofile`, a
  person's `.bash_profile` or `.zprofile`) puts its own `hc` or `automagik-herdr` ahead of the
  pane PATH, hiding the hc kill shim. A non-login shell keeps the launch PATH's guard first at
  command time. The shell's non-login startup and every tool the pane PATH holds still resolve;
  no shell startup file is edited. A template worker keeps its own command and is warned when
  it does not name this word. A start, restart, worker or `--tree` helper also refuses to run
  when the guarded PATH it built does not resolve its first `hc` to the pack's guard shim (an
  ordinary-named folder ahead of the guard, a missing shim, a relative first word), naming what
  it found and how to repair; a launch with no guard folder on its PATH (an agentless helper) is
  left as it was.
- Worker starts only (#1420): `-c 'projects={"<worktree>"={trust_level="trusted"}}'`, after the
  mode words and before any extra folders, subcommand or task. Checked on codex-cli 0.169.0:
  this inline TOML table keeps dots in paths literal, merges with the person's projects table,
  skips that folder's trust prompt and writes no setting. It trusts the worktree path only,
  never its repository root, a parent or the home folder. Seats and Restart --tree helpers
  do not get this word; those are a follow-up.
  Before adding it, the pack reads `/etc/codex/config.toml`, `/etc/codex/managed_config.toml`
  and `$CODEX_HOME/config.toml` (the default is `~/.codex/config.toml` when `CODEX_HOME` is unset
  or empty). A missing file is absent. Codex consults the cwd and its repository root, the
  parent of the git common dir: the pack checks both, and the project's main checkout too (a git
  dir kept elsewhere), by written path and resolved aliases,
  and withholds trust if either has any level other than exactly `trusted` in any read file.
  A `trusted` entry never blocks it. An invalid worktree path or the home folder, an unknown
  repository root, an unreadable config, or a relative `CODEX_HOME` also withholds it. So do
  settings the narrow reader cannot prove: unclosed strings, duplicate project paths, inline
  project tables, project arrays of tables, non-string trust levels or `project_root_markers`.
  A Codex run through a wrapper, or one choosing its own folder (`-C`/`--cd`), profile
  (`-p`/`--profile`) or projects/root markers (`-c`/`--config`), gets no trust word. Proxied
  workers and Codex template workers keep their commands and get no trust word either.
  Each withheld case warns why, without printing config contents: its folder wasn't
  pre-trusted and Codex may stop at its folder-trust prompt until a person answers it in the
  worker's pane. The pack never observes the pane to answer that prompt. Limit: cloud/MDM
  Codex layers cannot be read by the pack, so these local checks cannot account for them.
- `--add-dir <folder>`, derived per launch and only for folders that are there: the launch
  folder's git dirs, which Codex otherwise keeps read-only (`git rev-parse --git-dir
  --git-common-dir`: a checkout's own `.git`; for a linked worktree its own folder under the main
  checkout's `.git/worktrees`, where its index and lock live, then that `.git`), herdr-core's
  state and data folders (`$XDG_STATE_HOME/herdr-core`, `$XDG_DATA_HOME/herdr-core`, else under
  the home folder), and the tool caches a build writes: Go's module and build caches (`GOMODCACHE`,
  `GOCACHE`), npm's (`npm_config_cache`, else `~/.npm`), pnpm's store and cache, and Bun's install
  cache (`BUN_INSTALL_CACHE_DIR`). The two herdr-core folders are the one pair a running core does
  not need: #1125's N4 left both out and `hc ls`, `hc get self` and `am brief` still exited 0.
  They are kept as a narrow defence for the case #1125 did not test, when no core is running and
  the hc client must start it or take its lock; no isolated check has shown that case works
  without them, so they stay until one does (#1261). The network word above is required in every
  case (N3). Never the root, the
  home folder, a folder above it, the app home (its attach binding, locks and ledgers), a folder
  inside it or above it, or a whole XDG, cache, `GOPATH` or Bun folder. Each folder is weighed in
  its canonical form where the launch runs (#1142), resolved the filesystem's way: symlinks
  followed through the nearest folder that is there, then each `..` from where they led (never
  as text: `link/..` is the parent of the link's target), so an alias of the home folder or the app
  home goes too; a path whose place can't be proved (a dangling link, a file in the way, a `..`
  after a part that isn't there) is withheld (below). Codex is passed that canonical value, the
  one checked, never the path as written. The app home is
  the launch's effective one (`HERDR_APP_HOME`, a linked project's pane-env) and the default under
  the home folder both. A linked machine's folders are read and resolved there (its environment,
  git and realpaths, through `hc exec`), never against this computer. Anything else the sandbox
  blocks goes to Codex's reviewer, which may refuse it.
- One inventory (#1142): the same environment words (`HOME`, `HERDR_APP_HOME`, the four XDG
  folders, `GOPATH`, `GOMODCACHE`, `GOCACHE`, `npm_config_cache`, `NPM_CONFIG_CACHE`,
  `BUN_INSTALL`, `BUN_INSTALL_CACHE_DIR`) name the folders a linked machine is asked about, the
  folders granted and the assignments a seat's template may not make (below), and the folders are
  derived once, from the home folder as the launch spells it, then resolved. An XDG, cache or
  `GOPATH` value that isn't an absolute path is ignored and its default used, as the XDG spec says.
- Each folder is then proved outside the app home on its own (#1142), by object identity as well
  as by path: the folder and every folder above it, the home folder and every folder above it,
  and each app home and every folder above it are observed where the launch runs with `stat`
  (device and inode, symlinks followed: here by the pack's own `stat`, on a linked machine by its
  `stat -L` through `hc exec`). A folder may not be the same object as the home folder or a folder
  above it, an app home or a folder above one, or a general folder (a whole XDG, cache, `GOPATH` or
  Bun folder) or a folder above one, nor have an app home among the folders above it. A cache
  folder named at or above a general folder (`GOCACHE` set to the XDG cache's parent, say) is no
  cache and is not granted.
- A failed observation proves nothing and is never read as "different": any `stat` that fails (a
  missing folder, permission denied, a dangling link, a loop), and a linked machine's answer that
  is unsupported, short, malformed or missing. A folder whose own resolution or observation fails
  is withheld alone, and the others are still granted. A derived folder that isn't there is just
  not granted, and an optional general folder that isn't there or can't be resolved keeps nothing
  else out: only a folder derived under one that can't be resolved is withheld. The home folder
  or an app home that can't be resolved or observed (an empty or relative `HOME`, a machine that
  doesn't answer for it, a resolver error, an app home that isn't there, the default
  `~/.config/herdr-app` included) withholds every folder: that launch passes no `--add-dir` and no
  derived folder. Unsupported or unproven layouts get no extra folders.
- A launch that withheld folders says so once, counting each folder once. When it still passes
  some: "Codex extra folders withheld: the pack cannot prove N of them are outside the Herdr app
  home and passes no grant for those; writes outside permitted locations may require automatic
  review or fail. See #1151." When it passes none: "Codex extra folders withheld: the pack cannot
  prove they are outside the Herdr app home. It passes no additional folder grants; writes outside
  permitted locations may require automatic review or fail. See #1151." The mode words,
  `--no-daemon` and the network switch stay either way. A template worker runs its own command
  and gets neither the pack's folders nor this warning.
- Known limit (tracked in #1151): a bind mount that shows a folder inside an app home
  under another path has that folder's own device and inode, and no folder above it is an app
  home, so the pack can't tell it apart and may grant it. The pack claims no bind containment. (A
  bind of an app home itself, or of a folder above one, is the same object and is refused.)
  Case-insensitive disks are not tested.

A source that picks its own approvals or sandbox loses those words, named in one warning with
flag names only (never a value): a `programs.json` Codex run naming the bypass flag or `--yolo`,
`-a`/`--ask-for-approval` or `-s`/`--sandbox` (separate, joined or `=` forms), `--remote` (another
app server, outside the pane), an `--add-dir` the folder rules above refuse (by any alias, or a
relative one; one only withheld is counted by the warning above instead), or a `-c`/`--config`
for `sandbox_mode`, `approval_policy`, `approvals_reviewer`, `sandbox_workspace_write`,
`default_permissions`, `permission_profile` or `permissions`, or a key under one (on 0.167 a
`-c default_permissions=":danger-full-access"` overrides `--approve-for-me`). A profile's copy goes
too (`profiles.<name>.<key>` for one of those keys, or a key under one: `--profile <name>` applies
it), named `-c profiles.*.<key>`, never by the profile's name; so does `profiles` or
`profiles.<name>` set whole, named `-c profiles` (a table that can hold any of them). Every other
word stays.
Only a Codex run's words before its `--` are options: after it, Codex reads them as prompt text.

Templates keep their command. A worker started with `--template`, or by a bot's
`worker.template`, runs its hc template exactly as written, in hc's template form, so the
template's instructions still reach the task: the owner's exception for template workers,
bypass included, and never with the pack's folders. One that runs Codex without `--no-daemon`
among its options starts as before with one warning naming the template and the fix (add
`--no-daemon` to its command). One whose Codex run puts a Codex option after its `--` (the mode
words, an approval, sandbox or bypass word, `-c`, `--add-dir`) is refused before anything starts,
by name (#1142): Codex would read that option as prompt text, so the launch it means can't be
proved. Restart --tree keeps that exception, and that refusal, only for a pane with the
`worker.template` label (or a ledger row naming its template); any other Codex helper runs the
launch mode, and one whose shell command picks its own approvals, names a refused `--add-dir`
or can't be shown to pass words to Codex as options is refused by name, as is a Codex pane whose
command runs Codex where the pack can't read it (inside an `if` or a group, say). A bot's seat
never runs a template's bypass: a Codex seat's template is kept (a seat's template has run through
`sh -c` with words after it through `"$@"` since #213) only when it names no approval, sandbox or
refused `--add-dir` word of its own, writes each `--add-dir` as the canonical value it is checked
as (a template's text is never rewritten), and Codex provably gets words after it as options.
That proof reads one shape only (#1142): literal assignments (`NAME=value`) or `export` of them,
joined by `;`, `&&` or a newline, then one Codex run (optionally behind `exec`) whose words are
literals, with exactly one `"$@"`, its own or the one the pack appends, and no `--` (a quoted
`'--'` included). Anything else (`set --`, `shift`, `eval`, `.`, a function, `cd` or any other
program before Codex, a pipe, a subshell, a redirection, a substitution, `$*`, a variable in a
Codex word) proves nothing. Nor does an assignment that could move the launch's folders or its
program (`HOME`, `PATH`, `HERDR_APP_HOME`, `GOPATH`, `GOMODCACHE`, `GOCACHE`, any `XDG_`,
`CODEX_`, `npm_config_` or `BUN_INSTALL` word): the folders were weighed for the pane's own. And
every Codex word before and after `"$@"` must be one of Codex's options of known arity with its
value in place: a flag that takes none (`--oss`, `--search`, the mode words), or one that takes a
value, given joined (`--model=x`, `-mx`) or as the next word, which may not be `"$@"` or start
with `-`, and may not be missing at the end. A subcommand (`exec`, `resume`), a prompt word or an
unknown flag proves nothing. That reads Codex 0.167's options as the pack lists them; it is not a
proof by Codex's own parser. Then the mode words it lacks and the folders go after it; any other is
set aside for the agent row, and the restart says which template and why, by flag name.

Migration: nothing restarts on its own and a running pane keeps its launch. A Codex seat gets the
mode at its next start or restart; a `programs.json` Codex run with its own approval words gets
them left out (said once per launch; remove them to quiet it); `codexAuto: false` is warned
about; a Codex template without `--no-daemon` is named at each worker start until the file has it.

Known limit: once a sandboxed Codex seat can reach `hc` it can have herdr-core run commands
outside its sandbox (`hc run`, `hc exec`): the workspace-write sandbox does not contain commands
delegated through hc. The hc guard is a guardrail, not a boundary (#624, #628); the boundary is
the per-pane hc proxy sandbox (#631), opt-in and off by default.

Under that proxy, a Codex worker gets the mode words without the `--add-dir` folders: the proxy
starts only the approved command, which names no per-launch folder, and its contract is
unchanged. The worker says so in one warning. Its writes to the git dirs, herdr-core's folders or
the caches go to Codex's reviewer, and the proxy's own sandbox may still refuse them.

### Antigravity's permission list

agy takes a permission list from
`--settings` for one session, never saved, so every Antigravity launch of this pack — a bot's
start, restart and resume, a worker, a helper Restart --tree runs again — writes its own file
0600 under `<app home>/automagik-herdr/agy-settings/` and passes it as `--settings <file>`.
The pack never writes agy's own `settings.json`, so its saved settings stay the person's.
Since every launch runs without prompts, the deny list is the only thing agy still checks:
see "What runs without a prompt" below for what that leaves open.

The file is
`{ "permissions": { "allow": [...], "deny": [...] }, "trustedWorkspaces": ["<folder>"] }`,
both arrays in full every time (agy replaces its saved list field by field). `trustedWorkspaces`
lists one folder for every launch with a valid one, whatever its role: the project folder for a
seat, the worker's worktree for a worker (a review worker included), the helper's folder for a
helper. agy trusts folders by exact path, so without it a new worktree would stop at the
first-run question, "Do you trust the contents of this project?" (`agy` 1.5.3 reads
`TrustedWorkspaces []string json:"trustedWorkspaces,omitempty"` as a top-level key of
`--settings`). Trusting a folder lets agy load that folder's project
customizations, such as its `.agents/` agents, rules, hooks and MCP servers, without asking. A
review launch (a worker with `role: "review"`, a seat with `rank: "reviewer"`) is trusted the
same way (#1046), so an unattended `--role review` worker never hangs at startup on the trust
question; its read-only brief, never an empty trust list, is what bounds it. Never a parent
folder and never the home folder is listed: a launch at the home folder leaves
`trustedWorkspaces` out entirely (so the saved trust list is never overwritten with `[]`), and
the pack never writes agy's own `settings.json`, so its saved trust list stays the person's.

**What runs without a prompt.** Every launch carries `--dangerously-skip-permissions`, and
under that flag agy asks nothing and runs no classifier: a command runs unless a
`permissions.deny` rule names it. The allow rules do nothing under the flag. So all of this
runs unasked, on a seat, a worker and a read-only review launch alike:

- inline code and scripts: `python3 -c`, `node -e`, `bash -c`, a heredoc, any script file;
- the test runners: `node --test` and `bun test` run any test file they are given, so a
  read-only launch can run code through one, exactly as `node -e` would;
- shells and wrappers: `sh`, `bash`, `env`, `xargs`, `find -exec` and `-delete`, `awk`, `tee`,
  `sed -i`, and so a pipeline such as `cat x | sh`;
- the network and other machines: `curl`, `ssh`, `hc run --on`, `gh gist create`;
- a plain (non-force) `git push`, to `dev` or `main` too: only GitHub's branch protection
  stands there;
- a child agent started by hand (`claude --dangerously-skip-permissions`, another `agy`,
  `hc run -- ...`), and text typed into another pane with `hc send` (an agent's prompt or a
  shell's, as that pane decides);
- a write to the launch's own settings file or to the roster (the next pack launch writes the
  file again from the roster);
- `gh api <endpoint> -X PUT ...` with the endpoint first, `--method=PUT`, `-XPUT` and
  `gh api graphql -f ...`: only the forms with the flag right after `api` are denied, so such a
  call can still merge a pull request;
- reading any file the user can read, and anything else no deny rule names.

A review launch (a seat with `rank: "reviewer"`, a worker with `role: "review"`) is trusted for
its own folder like any launch, but read-only by its brief only: nothing in agy keeps it from
writing. The real boundary is the hc-proxy sandbox (the per-pane hc proxy, `hcProxy`), never
these lists.

The allow list is still written to the file, and it is what bounds a launch that runs without
the flag (a `programs.json` run or an hc template that leaves it out): a dev bot's project (or a
worker's worktree) as `write_file`, `hc`, `git`, `node`, `bun`, the 24 read-only shell tools
(`ls`, `cat`, `head`, `tail`, `grep`, `wc`, `diff`, `pwd`, `echo`, `cut`, `tr`, `jq`, `printf`,
`basename`, `dirname`, `true`, `which`, `stat`, `realpath`, `readlink`, `date`, `nl`, `comm`,
and `column`), the writer-only shell tools (`mkdir`, `chmod`, `rg`, `sort`, `uniq`, and
`sed -n`), the read-only `gh` verbs, `gh pr create`/`gh pr edit`/`gh pr comment`, and the
repository's own gates (`node --test`, `node --check`, `bun test`, `scripts/privacy-check.mjs`,
`scripts/am-copies.mjs`, the `version`/`entries`/`parts`/`catalog` checks, …). A read-only
launch lists only `hc ls`, `hc get`, `hc read`, `hc wait`, `hc send`, the 24 read-only shell
tools, the test checks, the `gh` reads and a short list of git subcommands (`log`, `diff`,
`show`, `status`, …). No release verb and no `gh pr merge` is in either list.

Run repository tests only in a checkout you trust. Tests execute checkout code with the access
available to the test process, so give that process only the files and credentials its work
needs. Before sending a message, check the intended recipient. The proxy restricts which
destinations are available, and each recipient handles messages with its own permissions.

The fixed deny rules are always present, the same for a seat and for every worker role, and a
roster's `agyPermissions` can only add to them:

- pushes: `git push --force`, `--force-with-lease`, `-f`, `--mirror`, `--delete` right after
  `push`; the same force flags after `origin`, after `-u` (and `--set-upstream --force`), and
  after `origin main`, `origin dev`, `origin master` and `origin HEAD`;
- lost work: `git reset --hard`, `git clean`, `git rebase`, `git stash`, `git checkout --`,
  `git checkout -f`, `git checkout --force`, `git restore .`, `git branch -D`,
  `git branch --delete --force` (and `--delete -f`, `-d --force`, `-d -f`), `rm -rf`, `rm -fr`,
  `rm -r -f`, `rm -f -r`, `rm -Rf`, `rm -fR`, `rm -R -f`, `rm --recursive`;
- git pointed elsewhere: `git -C`, `git -c`, `git --git-dir`;
- landing and releasing: `gh pr merge`, `gh release`, and `gh api -X`, `gh api --method`,
  `gh api -f`, `gh api -F` (flag first only);
- the roster and other bots: `am edit`, `restart`, `rm` and `create`, and the same
  four under `am` (`am edit`, `am restart`, `am rm`, `am create`), which runs the same CLI;
- other panes: `hc keys`, `hc interrupt` and `hc exec`;
- `hc kill` and `hc --json kill`, for every worker and for every seat whose bot is not the
  project's main bot (see [Ending a worker](#ending-a-worker)). A main bot's seat does not
  carry these two.

A rule is whole words from the start of each command in a line, with no wildcard (checked on
agy 1.5.4: `command(echo * two)` does not match `echo one two`, and a rule for `--flag` does not
match `--flag=value`). agy resolves quotes and a leading `VAR=x` before matching, so those do
not get around a rule; a reordered command, an absolute path, a wrapper or an interpreter does.
Not caught at all: a force refspec whose `+` is attached to the ref (`git push origin +main`),
combined short flags (`git push -fu`), `--force-with-lease=<ref>`, a force flag after a ref the
list does not name (`git push origin my-branch --force`), a global option before the
subcommand (`hc --timeout 5 kill t3`, `am --project /p restart`), and a reset that
reaches `--hard` after other words (`git reset HEAD~1 --hard`). These lists are a guardrail
against accidents, not a security boundary. `dsh-tui doctor` prints the same reminder beside
the lists.

The settings file's path is deterministic from the bot, the scope, the role and the worktree,
so an approved-worker proxy plan and the argv it approves name the same file: the approved
worker's `--settings` path is part of the exact argv the proxy checks, and another path is
refused. For a proxied worker the proxy writes that file itself, from the approved snapshot's
entry (its defaults, the approved `agyPermissions` and the fixed denies), 0600 in its own folder
under the approved root, which the sandbox binds read-only; the pane only names the path. A file
planted in the app home, or an unapproved rule added to the working roster, never reaches an
approved start. A template whose command runs agy is rebuilt with the file and its task; one whose
command ends in a separator or a comment can't take either, so it runs without the list with a
plain warning. A linked machine's start writes the file under that machine's app home, through
`hc`; with no app home there the start is refused rather than launched without its list.

`dsh-tui doctor` prints each Antigravity bot's effective trusted folder and allow and deny lists
(its seat's and its worker defaults'; a worker's trusted folder is its worktree, named at
launch, a review worker's included), in JSON too, plus one host-level row saying whether agy's
terminal sandbox, and so `--mode`, can
work here: Linux's user namespace controls, or macOS's `/usr/bin/sandbox-exec`. Unreadable evidence
is a note, not a false warning.

### Antigravity's prompts: Needs you

agy fires no hook while it waits at its folder-trust or file-access prompt, so herdr-core never
reports that pane as blocked (#917). The sidebar reads the screen of a live pane when the
foreground argv Herdr reports for it runs `agy`: `agy` itself, its absolute path, `env ... agy`,
or agy under the pack's `hc keep` wrapper, which covers the pack's bots, workers and helpers and
an agy typed by hand in a pane. It does not read a pane whose foreground is a script or a shell
that started agy (`bash run.sh`, `sh -c 'agy; wait'`, an opaque worker template), nor one whose
record carries no foreground argv. It does read any program the same identity rule names agy:
past any of the launchers `node`, `bun`, `bunx`, `deno`, `python`, `python3`, `npx`, `pnpm`, `yarn`,
`uv`, `uvx`, `ruby`, `bundle`, `env`, a privilege wrapper, `nice`, `time`, `watch` and `nodemon` and
their flags, a program whose file name, without a leading `-` and without a `.js`, `.mjs` or
`.cjs` suffix, is `agy` or `antigravity`, such as `node /tools/agy.js`. Such a pane is treated as
agy: when its screen ends in the exact rows of one of agy's two captured prompts (a quotation of
them, say), the sidebar draws it Needs you after two identical reads and a send into it is
refused after the wrapper's one read. Each 2.5-second tick reads at most eight of these panes
shown in the sidebar; when one of the two prompts captured on agy 1.5.16 on Linux is at the
bottom of the screen in two reads in a row with nothing changed, it draws that pane as
**Needs you**, its tooltip naming the question. On a small, responsive host that takes about
5 seconds (two visits): an estimate, not a bound.

- folder trust: "Do you trust the contents of this project?";
- file access: "Allow access to this file?", directly under agy's "File access" heading, its
  rule, the "Read:" row naming the file and the reason "outside workspace".

A send through the pack's wrapper into such a pane is refused with the `blocked` error (exit 9) a
dialog gets (#1414), naming the pane, never the prompt's folder or file: nothing is typed into the
prompt. Answer it in the pane. The wrapper's check is best effort: it reads the screen once, just
before the send, so a pane it cannot read or a prompt that opens after that read still reaches
herdr-core's delivery. Automatic delivery (a message or an update notice the pack sends on its
own) checks such a pane too: the attempt is withheld; update notices remain pending, and retry
behavior for other messages depends on the caller.

The pack's own launches carry `--dangerously-skip-permissions` and trust their folder, so they
stop at neither prompt; a launch at the home folder (left out of `trustedWorkspaces`), a launch
with no settings file and an agy started by hand can. The supported prompt rows were measured on
Linux with agy 1.5.16. macOS and other agy releases are unverified. A release that draws the same
supported rows can match. Only the folder-trust screen requires a separate model row. A question
wrapped between words still matches. A wrapped path matches while the "File access" heading is
visible and no continuation resembles a structural row. A word split across rows, a choice or footer
wrapped onto two rows (a narrow pane), a question scrolled off the top, a prompt worded otherwise, a
selection marker on no choice or on two, or a file-access block whose heading, rule, "Read:" row or
reason is missing, reworded, out of order or scrolled off the top draws nothing:
never a guess. On a matcher miss, a pane reported working proceeds to herdr-core's delivery.
A pane reported idle or done, or with no status, still gets the generic dialog and rate-limit
checks. The generic dialog check refuses sends under a visible question, numbered choices or a
confirm footer. It still recognizes the file-access fixture when just the heading rows, selection
marker or exact choice wording change. It returns no dialog for the padded folder-trust fixture
with its selection marker removed. Trimming that same unmarked fixture exposes the question to
the generic dialog check. Two parts of a matched screen are free: the trust screen's model row,
so a quotation of those rows with any text there but an input line is taken as the prompt once
it sits unchanged at the bottom of an agy pane; and the path after "Read:". Its continuation
rows can contain ordinary text, but must not be a heading, rule, "Read:" or "Reason:" row.

### Ending a worker

From your worker pane, put the final report in a readable `.md` file up to 64 KiB. Use the
system temp folder or the worker's worktree. Run `am worker done --report <file>` from a clean
worktree. Add `--state blocked` to report a blocker from a worktree with uncommitted changes.
am replaces the worker's report under `${AM_HOME:-~/.automagik}/projects/<project>/reports/`.
A private `project.json` records the full project key. A basename collision adds a 12-digit
hash suffix to the project folder. The local core's helper checks that the caller is running
under the worker pane and that the core's launch and attach ledgers identify it as a worker.
It removes Markdown reports older than 30 days when saving a new report. The lead receives
one notice starting with `[am] worker …`. Read the named report and check the worker in am
before acting on the notice. The worker sees the hand-over receipt before the helper ends its
pane. The existing sweep handles worktree cleanup. Workers behind the per-pane hc proxy or
on a linked machine leave their report for their bot, who can use `am worker kill`.
The outside step's Git calls ignore the repository's hooks, file monitor, pager and external diff,
but a clean or smudge filter named in the repository's Git config can still run because Git has no
switch to disable filters.

`hc kill` is for the seat of a project's main bot only (`kind: "main"` in `bots.json`). Every
other bot, a member that leads a squad included, ends a worker it started with:

```sh
automagik-herdr worker kill <pane>     # or: am worker kill <pane>
```

run from the bot's own pane. It ends one terminal and only when all of this holds: the
terminal's `worker.of` label names the calling bot (the bot the attach ledger binds the
caller's pane to), it is not a bot's seat, it is not the caller's own pane, it is on this
computer, and hc does not report it as `working`. A worker stuck mid-turn is the main bot's to
end.

`am worker` registers the worker to the bot's ID in `worker.of`. The same bot can still end
its worker from its new seat after a restart. Only the project's main bot can end a terminal
started with plain `hc run`, including after a handoff or restart. In a Git project, seats
configured for coding (`code` defaults to `true`) can start with `am worker` when they need
to end the worker themselves.

Before ending a registered worker, the CLI rereads the caller's and target's attach bindings
and asks hc again for the target's identity, ownership and turn status. hc provides no
conditional kill, so the bindings or terminal can still change between the recheck and the kill.

Where the rule is enforced:

| Launch | `hc kill` from a worker or a non-main seat |
| --- | --- |
| dsh-TUI (the hc guard is first on its PATH) | refused by the guard, with one line naming `worker kill`. `hc --json kill` and any other flag before the command are refused too. |
| Claude Code, Codex, Antigravity and every other agent (the `hc kill` shim is first on its PATH) | refused by the shim in every flag order (`hc kill t3`, `hc --json kill t3`, `hc kill --json t3`), with one line naming `worker kill`. Every other hc call goes to the real hc untouched. |
| A sandboxed pane (the per-pane hc proxy) | the proxy ends only the caller's own worker, for a main bot too; a worker's own kill is refused. |
| Antigravity, as well | `command(hc kill)` and `command(hc --json kill)` are in the launch's deny list. |

**The `hc kill` shim** (`hc-kill/hc` in the pack and in am, the same rule as the guard's): the
pack puts its folder first on the PATH of every seat, worker and `restart --tree` helper it
starts for an agent other than dsh-TUI. A call whose command is `kill` is allowed only from a
pane the attach ledger binds to a bot that is `kind: "main"` in its project's `bots.json`;
a worker, a member's seat, a pane the ledger does not know and a call with no
`HC_TERMINAL_ID` are refused (exit 2, one line). `hc kill --help` and every other call run the
real hc with the same words, input, output and exit code, and the shim reads nothing for them.
`am worker kill` calls the real hc itself, past the shim and the guard.

What the shim does not do, plainly:

- It stops the honest path only. The real `hc` by its full path, a copy of it, a raw socket,
  `hc connect`, or a `PATH` the agent changes goes around it, as it goes around the guard and
  the deny list. **The boundary is the hc-proxy sandbox, never the shim.**
- A shell a command starts can still prepend a folder. The pack's Codex launch tells Codex not
  to use a login shell for its commands (`-c allow_login_shell=false`, #1133), and a launch
  whose PATH holds a pack guard folder refuses when its first `hc` is not that guard's shim,
  whatever the folder ahead is called; a launch with no guard on its PATH is left as it is, and
  a template worker that keeps its own command is warned, not rewritten.
- A worker started from an hc template in hc's own form (`<template> <task>`) keeps the
  template's command and environment, so it gets no shim; a template the pack rebuilds for a
  Claude login has no PATH word either.
- A pane started before this release keeps the PATH it has until its next restart.
- On a linked machine the start uses that machine's own shim (the folder beside its
  `automagik-herdr`). A machine whose pack is older, or has none on its pane PATH, starts the
  bot without it and prints one warning: `<bot> runs on <machine> without the hc kill shim (#955)`.
- `dsh-tui install` copies the shim to the stable folder beside the guard; the proxy accepts
  a worker's PATH only as the pack builds it.
- A worker of another agent started from a dsh-TUI bot's pane inherits that pane's PATH, full
  guard included. It keeps the full guard, as before this release, and gets no shim: the guard
  holds the same kill rule and also limits the worker's `send`, `label` and `run` calls. The
  same holds under the hc proxy, where the pane's PATH has the stable folder's guard.
- Version skew fails closed. The CLI's own verbs (`restart`, `rm`, `worker kill`) reach the
  real hc by skipping the guard and shim folders whose `hcGuard.mjs` is byte-equal to the
  CLI's own copy. With am and the pack installed at different versions, a pane that one of
  them started has the other version's shim first on its PATH; a restart asked from that pane
  by the other CLI sends its kill through that shim, which refuses it unless the pane is a
  main bot's seat. The old pane stays and the verb says it wasn't ended. Bring am and the pack
  to one version and restart the pane.
- It adds one short Node start to every `hc` call from those panes.

### The briefing hook (Claude bots)

Start and Attach add one `UserPromptSubmit` hook to `.claude/settings.local.json` in the
bot's session folder, never to the shared `settings.json`, and keep that file out of git
through the clone's own exclude file. The hook runs
`sh <app home>/mods/<sidebar>/bin/run.sh <app home>/automagik-herdr/briefing.mjs`, with the
installed sidebar folder's run.sh (`am-sidebar`, else the sidebar's folder from before v0.5.0;
nothing when neither has one): run.sh finds node 22.7 or later, or bun, even where the agent's PATH has no `node`, and the
fixed entry point runs that folder's `briefing.mjs`, so a renamed folder or a rollback doesn't
break it. The installer and `am update` move
older hooks onto it (each file backed up beside itself as `settings.local.json.am-backup`), a hook
in the older `node` form is upgraded to it the next time the bot starts or attaches, and a
rollback to a pack without the entry point moves the hooks back onto that folder's own
`briefing.mjs`. It prints nothing outside a bot's pane (by the attach ledger), finishes within about 2 seconds, and never fails a
prompt. `am worker` adds the same hook to a Claude worker's worktree. In any hc
terminal it runs in, the hook also records a new Claude session (see [Workers](#workers)). Members' reports are fenced as untrusted data. A session attached while it was
already running may need a restart to load the hook: `am restart <bot>` (or the bot row's Restart).

### Requirements

- macOS, Herdr and herdr-core (`hc`).
- Node 22.7 or later, or Bun, for the CLI, the briefing and updates, found automatically
  (`bin/run.sh`: node on PATH, nvm, Homebrew, then bun), even where PATH has no node.
  install.sh needs Node. The sidebar works without either, but its update check needs Node.
- herdr-core's typed notes left on (`~/.config/herdr-core/config.toml` must not say
  `notes = false`).

### macOS desktop session and login keychain for herdr-core

On macOS, `herdr-core serve` and the `herdr-core hold` processes that hold terminal PTYs must be
started from a desktop GUI (`Aqua`) terminal so they inherit access to the logged-in user's macOS
login keychain (`security show-keychain-info` exits `0`). (`launchctl managername` is not the check
for an already-running holder: daemonized holders report `Background` even when started from the
desktop and still holding login keychain access.) When `herdr-core` is not running and the first
client to reach it arrives over SSH (such as a linked machine's `hc … --on <mac>`, which runs
`ssh … herdr-core connect`), `herdr-core serve` and any new `herdr-core hold` start inside the SSH
session without login keychain access (`security show-keychain-info` exits `36` with
`SecKeychainCopySettings <NULL>: User interaction is not allowed.`), so Claude Code reports it is
not logged in and `gh` cannot read its keychain token. Terminals started earlier under a desktop-born
holder keep their keychain access and keep working.

Before `am start --machine` or `restart --machine` (and `am start --machine` /
`restart --machine`) writes any file, starts a pane or ends an old pane on a macOS machine, it
runs `security show-keychain-info` there (#1033). When that exits non-zero, the command refuses with
a clear hint instead of starting a keychainless terminal.

**Moving `herdr-core` back to a desktop terminal without touching live terminals.** Live terminals
are held by `herdr-core hold --socket …` processes, which survive a `herdr-core serve` restart.
Killing an older desktop-born holder ends the live terminals it holds, while leaving an SSH-born
`herdr-core hold` (or its socket) in place lets the new server reconnect to that keychainless holder.
Linked machines also reconnect over SSH every few seconds (`herdr-core connect` auto-starts a server
if none is listening), so stopping the SSH-born server and starting the desktop-born server must
happen in **one command pipeline** from a desktop terminal on that Mac (Terminal.app, iTerm2, or an
existing working Herdr pane — never over SSH):

```bash
# 1. In a desktop terminal on the Mac, verify login keychain access:
security show-keychain-info && claude auth status

# 2. Inspect herdr-core serve and each herdr-core hold --socket ... process:
pgrep -fl 'herdr-core (serve|hold)'

# 3. In one pipeline from that desktop terminal, stop the SSH-born herdr-core serve and
#    any SSH-born herdr-core hold (never older holders that hold live working terminals),
#    remove the SSH-born holder socket, and immediately start the core from the desktop:
security show-keychain-info && \
  kill -TERM <serve-pid> <ssh-hold-pid> && \
  rm -f ~/.local/state/herdr-core/default.holder.<id>.sock && \
  hc server status && \
  hc exec -- security show-keychain-info
```

If no terminal was started under the SSH-born server yet, there is no SSH-born `herdr-core hold` or
holder socket to remove: pass only `<serve-pid>` to `kill -TERM` and run `hc server status` in the
same pipeline.

### Manual install

Without the installer, from a checkout: the bot mod alone, which is the sidebar without the rest
of the pack (for the rest, copy each folder of the table above the same way, and see
[Wiring](#wiring-your-layout)):

```bash
cp -R mods/am-sidebar ~/.config/herdr-app/mods/
mkdir -p ~/.config/herdr-app/layouts ~/.local/bin
cp ../herdr-layout/layouts/automagik.json ~/.config/herdr-app/layouts/
herdr-app do layout.switch '{"name":"automagik"}'
ln -s ~/.config/herdr-app/mods/am-sidebar/bin/automagik-herdr ~/.local/bin/automagik-herdr
```

Herdr never overwrites a mod folder that is already there. If you run your own
`am-sidebar` clone, move it out of `mods/` first, and keep the backup outside `mods/`,
or Herdr loads it as a second mod. A rename map in `<app home>/sidebar-agents.json` is read
as before. The sidebar docks nowhere by itself (its `mod.json` place is `none`): it shows only
in a layout that names it. `automagik.json` is Herdr's `main` layout with the pack in place of
the `spaces` and `agents` sidebars, so copying it and switching to it are required steps. If
your own layout already names `am-sidebar`, keep it and skip those two lines.

### Upgrading from herdr-bots

If you ran `herdr-bots` from a clone, use `automagik-herdr` in its place.

## Develop

No build step and no dependencies. The checks CI runs (`.github/workflows/ci.yml` at the
monorepo's root, from `herdr/`):

```bash
node --test 'test/*.test.mjs' && for f in mods/*/*.js mods/*/*.mjs mods/*/bin/*.mjs scripts/*.mjs scripts/*/*.mjs; do node --check "$f" || exit 1; done && node scripts/version.mjs check
```

The rules shared by the sidebar and the CLI import nothing from Herdr (`model.js`,
`launchArgs.js`, `models.js`, `workers.js`, `attach.js`, `formModel.js`, `release.js`,
`updateCheck.js`, `workerTab.js`, `migrate.js`, `restart.js`), so the tests
run them under plain node. The tests run the CLI and the briefing against scratch git
projects with a fake `hc`, and the sidebar's modules against stand-ins for Herdr's own. A
pass does not prove the pack works inside Herdr; check that in Herdr itself. Releases are
cut by CI on every push to `dev` with something new (see `AGENTS.md`).

The two theme files are built from Automagik's colours by `node scripts/themes.mjs`; edit that
script, not the JSON (`test/theme.test.mjs` fails when they differ).

### Publishing

The public repository carries the `herdr-mod` topic, which is set on GitHub (repository
settings), not in a file. `mods/am-sidebar/RECIPE.md` (how the pack is built) and
`mods/am-sidebar/preview.png` (the bot view) are Herdr's share files: they describe the pack
to readers of the repository and are inert in an installed copy.

## License and credits

Apache-2.0 (`LICENSE`; the pack folder carries a copy). The sidebar is derived from Herdr's
shipped `spaces` mod 0.1.7 (`LICENSE-herdr`); `main.js` says so at its top, and `mod.json`'s
`title` changed to "Automagik Sidebar". The characters come from Automagik by Namastex Labs
(`LICENSE-automagik`), whose drawing comes from DS Bot. See `mods/am-sidebar/NOTICE`.

## What else is in the pack

Besides the bot mod above, this pack builds and ships the pieces that make the sidebar usable, each
with its own `RECIPE.md`:

| Mod | Derived from | What it does |
|---|---|---|
| `am-footer` | Herdr's `workspace-chrome` | The sidebar's brand bar and a footer rail of icon tabs — Bots, Mods, Automations, Accounts (while am-quota is on), Settings, Add machine, and up to 4 buttons other mods add — so tabs never stack up. |
| `am-status` | Herdr's `workspace-status` | The window's bottom status bar (machine, branch, agents, `⌘⇧P commands`) plus the installed Automagik Herdr version beside "commands": click it to check now; when a release is out, `0.8.0 → 0.8.1 · update` installs it after a confirm, the same way `am update` does. |
| `am-tabs` | Herdr's `tabs` | The tab bar: pills named from the agent's own title, close ✕ on hover, middle-click to close, drag to reorder, per-space side-panel memory. Scrolling never switches tabs. Its `+` opens `am-new-menu`. |
| `am-automations` | `DnzzL/herdr-automations` (MIT) | Scheduled agent prompts as a side panel: inbox of finished runs, run now, pause all, and a form that previews the next runs. The panel draws and asks; the `herdr-automations` scheduler launches the work. **Ships switched off** (#220): a fresh install puts the mod in `mods-disabled/`; turn it on in the Mods panel (*Automagik Automations*), and the rail's Automations tab then opens it. `install.sh` installs the scheduler the pack pins to `~/.local/bin/herdr-automations`, checked against its sha256 (never over one it did not install; `--no-scheduler` skips it), writes `backend: hc` only where there is no `automations.yaml` yet, asks before starting the login service, and says whether Automations is ready. Without the scheduler (an update through the pack's own updater installs none), the panel shows the hash-checked command that installs it: Copy copies it, Install runs it. An install that already has it keeps its state. |
| `am-markdown` | Herdr's `menu` + `ohneda/herdr-markdown-browser` (MIT) | Right-click a terminal: under Herdr's own items, the Markdown files that terminal printed. Pick one and it renders in a preview pane — live reload on save, `Default app` — that the next pick replaces in place. |
| `am-new-menu` | Herdr's `new-menu` | The `+` menu (the sidebar's and the tab bar's, in place of Herdr's own): terminal, the agents actually installed (per machine), new space, worktree dialogs; `⌘1…9`/`⌘T`/`⌘N`. |
| `am-mods` | `jacksonpires/herdr-app-mod-manager` (MIT) | The table over every installed mod — on/off, check result, version, source, drift — install, update, remove; `⌘⇧M`. |
| `am-quota` | clean-room | **Accounts**, for people who run their own CLIProxyAPI: per tool (Claude Code or Codex), the account this computer uses and whether it lasts until its window resets, one button to switch to the next account on the proxy, and a restart of the bots still on the old one. **Ships switched off** (a fresh install puts it in `mods-disabled/`): turn it on in the Mods panel (*Automagik Accounts*), and the rail's Accounts tab then toggles it. An install that already has it keeps its state. |

**Not in this pack, on purpose:** Pocket Link ([mods/pocket-link](mods/pocket-link/README.md)) sits
beside the pack's mods but belongs to Pocket (`apps/pocket/`), which owns its mod, its LaunchAgent and
its pairing state. Install it from its README; this pack never vendors, installs, updates, removes or
restarts it.

## Add a sidebar button from your mod

Any installed mod can put a button in the footer rail. Declare it in your own `mods/<name>/mod.json`:

```json
"automagik": { "footer": [ { "id": "tasks", "label": "Tasks", "icon": "mods/genie-herdr/tasks.svg",
                             "command": "mod.open", "args": { "name": "tasks-mock" }, "badge": "genie.tasks.waiting" } ] }
```

- `id` (required): unique within your mod; the button's key is `<mod>/<id>`.
- `label` (required): the name the rail shows while the pointer is on the button.
- `command` (required) and `args` (an object, default `{}`): a press calls `run(command, args)`.
  `mod.open {name}` opens the mod and closes it on a second press, so the button toggles it.
- `icon`: an SVG under the app home (`~/.config/herdr-app`), drawn with `svg()` and tinted like the
  rail's own icons. A missing, non-SVG or outside path draws a neutral circle.
- `badge`: a `shared()` key. While its value is a number above 0, the button shows it as a small
  count (9+ past 9); 0, `null`, a string or no value shows nothing.

An entry with no `id`, `label` or `command`, an `id` used twice, or a `mod.json` that is not JSON is
skipped (the reason goes to the console). The rail shows at most 4 contributed buttons in all, by
mod name, then in the order each mod lists them, after the pack's own tabs and before Settings. They
sit in their own group, which clips when the sidebar is too narrow: the rail's own tabs always show.
A mod named `pocket-link` (in any case) cannot add buttons: the rail has its own Pocket Link tab and
does not read that folder. The rail reads every installed mod's `mod.json` every 30 s, and at once
when a `mod.json`, a mod folder or an SVG under `mods/` changes; it writes nothing.

## Wiring (your layout)

The installer does this for the `automagik` layout. To give a layout of your own the whole pack,
copy these from `~/.config/herdr-app/automagik-herdr/automagik.json` (the pack's copy) into it:

1. root: `"terminal_menu": "am-markdown"`;
2. the tab bar block: `"mod": "am-tabs"`, `"size": { "px": 42 }`;
3. the `spaces` block: `"mod": "am-sidebar"`;
4. the footer block: `"mod": "am-footer"` with `"props": { "footer": true }` and
   `"size": { "px": 42 }`;
5. the status bar block (`"id": "status"`, `"size": { "px": 28 }`): `"mod": "am-status"` in place of
   `workspace-status`.

`am-new-menu` (opened by the sidebar's and the tab bar's `+`), `am-mods` (`⌘⇧M`, the rail's
Mods tab), `am-automations` and `am-quota` need no block. The rail's clock and Accounts tabs open
those two as a popup over the rail. Don't give them a block: Herdr shows plain Herdr instead of a
layout that names a mod that is off ("needs mods that aren't here"), even in a hidden block, and
both ship off. A layout that already has an `automations-panel` or `am-quota-panel` block
keeps working: while the mod is on, its tab shows and hides that block instead.

## One installer

`install.sh` (above) installs every mod of the pack; there is no second installer. To try it on a
scratch home first: `HERDR_APP_HOME=$(mktemp -d) sh install.sh --yes`.

## Our marketplace

`catalog/index.json` is the index the mod manager reads, in the same shape `herdr.dev/mods`
publishes. `scripts/catalog.mjs` builds it from this checkout (`--refresh` re-reads
stars/licence/head from GitHub, `--check` verifies and exits 1 when stale). Strict gate: a mod of
ours must carry `RECIPE.md` and `LICENSE`, a curated repo needs a licence and an upstream
`RECIPE.md`, and a mod name has one owner — this pack first. Every refusal is printed.

## Pack layout

```
mods/        each mod this pack installs (bots first, then the sidebar and its tools)
catalog/     index.json (generated) · repos.json (the other repos we carry)
scripts/     catalog.mjs (build the index) · version.mjs · themes.mjs
keys.json    the keys the pack asks for
test/        the bot work's pure-module tests (node --test)
```

The one layout the pack ships is `../herdr-layout/layouts/automagik.json`, beside this folder, not in it.

## Develop

```bash
node --test 'test/*.test.mjs' && for f in mods/*/*.js mods/*/*.mjs mods/*/bin/*.mjs scripts/*.mjs scripts/*/*.mjs; do node --check "$f" || exit 1; done
```

The pure rules (project key, schema, leads, ids, looks) live in `mods/am-sidebar/model.js`
and import nothing from Herdr; so does the briefing's text (`briefingText.mjs`).
Model detection lives in `models.js` (`test/models.test.mjs`). `test/briefing.test.mjs`
runs `briefing.mjs` under node with a fake `hc` on `PATH`, and `test/cli.test.mjs` runs every
`automagik-herdr` command against scratch git projects with a recording fake `hc`
(`test/fake-hc.mjs`). `test/scratch-project.mjs` makes every scratch project its own isolated
project (`git init` when `isGit`, its own `.herdr` folder, and `GIT_CEILING_DIRECTORIES`),
asserts before any CLI call that `projectOf`/`projectKeyOf` resolves to the scratch folder
itself (failing with one line naming the outer project if it does not), and prints a one-line
warning at suite start when `TMPDIR` lies inside a folder holding `.herdr/bots.json` or `.git`. `test/bots.test.mjs` runs `bots.js` against stand-ins for
Herdr's `herdr` and `fs/promises` modules (`test/herdr-stub.mjs`, `test/fs-stub.mjs`; the
second has only the seven functions Herdr gives a mod). A pass there does not prove the pack
works inside Herdr. Check that in Herdr itself.

## License

Apache-2.0 (`LICENSE`; the pack folder carries a copy). Two files are changed from Herdr's
`spaces` 0.1.7: `mods/am-sidebar/main.js`, which says so at its top, and
`mods/am-sidebar/mod.json`, whose `title` changed to "Automagik Sidebar". JSON can't
carry a comment, so the change to `mod.json` is noted here and in the repository history.
