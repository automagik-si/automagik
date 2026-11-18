# Automagik Herdr

Autonomous teams of coding agents across harnesses (Claude Code, Codex, Antigravity, Kimi, Oh My Pi…)
with a main bot, captains and members, running in [Herdr](https://dev.herdr.app).

The pack lives in the [Automagik monorepo](https://github.com/automagik-dev/automagik) under
`herdr/`, and ships on its releases with its one version (`v3.x`): a release carries the pack
(`automagik-herdr-pack-<v>.tgz`) when `herdr/` changed since the release before. v0.14.x was the
last release line from the old `automagik-dev/automagik-herdr` repository.

<!-- hero: docs/hero.png, a sidebar screenshot with a team running -->

## Install

On macOS or Linux with Node 22.7 or later:

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash
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
`herdr-automations-v<version>`). The installer puts the build the pack pins
(`mods/am-automations/scheduler.js`, read from the pack tarball it has just checked) in
`~/.local/bin/herdr-automations`, for macOS and Linux on arm64 and x86_64: downloaded, checked
against the pinned sha256, run once (`version` must be exactly the pinned one), then renamed into
place. It keeps its own record (`<app home>/automagik-herdr/scheduler`) and replaces or removes
only the binary it wrote, while it is still those bytes: one on your PATH somewhere else, a link, or
a file you installed yourself (upstream's build, a dev build) is left as it is and only checked.
The one exception: a file there that is exactly the pinned build (what the panel's repair command
installs) is adopted, recorded without being replaced, so later pins reach it.

For its own binary it then sets things up. A machine with no `automations.yaml` gets one saying
`backend: hc`, so runs open in the Herdr app; an existing file is never edited, and neither it nor
the run history is ever removed. It asks before starting the scheduler's login service
(`herdr-automations service install`, for your user only; `--yes` says yes, no terminal says
no), and restarts that service without asking only when it started it and the binary was replaced.
Last, the runtime check: it asks the scheduler `ls --json` and says whether Automations is ready
(the scheduler runs and the backend is the app's) or what is missing. A failure anywhere here is a
warning; the pack is installed all the same, and a rerun retries.

`--no-scheduler` leaves the binary and the service alone, on install and on `--uninstall`.
`--uninstall` otherwise removes the login service when this installer started it, then the binary.
While a login service you started yourself (Start in the panel, or `service install`) is installed,
it keeps the binary too and says how to remove both, so no service is left restarting a missing file.
`am update` (the pack's own updater) has no scheduler step yet: after it, or wherever
the binary is missing, the panel shows the command that installs it, with an Install button.

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

1. Run: curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash
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
model, its agent's icon and its status. Right-click a bot for its menu: Configure opens the edit
form (name, agent, model, role, category, lead, worker defaults); Prompt edits its instructions
in place and saves them as the form does; Run starts it, or focuses its pane when it has one,
restarts it (Restart runs `am restart`; Restart on… restarts it on another installed
agent, a new conversation, the bot's definition keeping its agent), attaches it to the focused
pane or detaches it; What happened shows `am history` for it (its panes, starts,
sessions, the newest transcript, which a click copies, its workers) and the helpers its pane runs
now. A planned bot's menu has no Run items. A queued restart waits for its next idle. A busy-pane
refusal offers "Restart anyway". With helpers, choose "Restart with its helpers" to restart immediately and resume
those conversations, or "End helpers and restart" to end them. On a linked machine, the first choice
runs the installed CLI's local `--tree --force` restart on the machine holding the panes, then updates
this sidebar's attachment. Saved configuration changes use these same choices when you restart to apply
them. Pack updates reload mods and do not restart bot panes. The Bots list and the Attach picker open
on the bots the sidebar already knows and refresh behind.

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
config, which may hold a prompt the briefing would replace, is only read on this computer. What
happened isn't shown for those bots yet. A machine that isn't answering shows its bots as last
seen, dimmed, and its menu says so.

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
       [--agy-mode auto|accept-edits|plan] [--agy-allow RULE]... [--agy-deny RULE]...
       [--planned-wave N [--planned-note T]]
       [--worker-agent A] [--worker-model M] [--worker-effort E] [--worker-agy-mode M]
       [--worker-template T]
am edit <bot> [the create options] [--code true|false] [--unplanned] [--no-model] [--no-category] [--no-lead-project] [--no-cross-members] [--rank=]
am rm <bot>
am category ls | add --title T [--sub S] [--id ID] | edit <id> | rm <id> | order <id>...
am start <bot> [--space ID] [--tab ID]
am restart --queued [--project DIR] [--json]
am restart --cancel <bot> [--project DIR] [--json]
am restart <bot> [--fresh] [--agent A] [--model M [--save]] [--force]
am attach <bot> <terminal> [--move]
am detach <bot>
am import --from-hc [--squad-label L] [--apply]
am whois <terminal> | whois --bot <bot>
am history <bot>
am brief <bot>
am forget <project>
am worker "<task>" (--branch B [--base REF] | --worktree DIR)
       [[--agent A] [--model M] [--effort E] | --template T] [--name N] [--role dev|test|review|fix]
       [--task ID [--lead BOT]]
am worker kill <pane>   # from a bot's pane: end one worker that bot started; any other pane is refused
am update [--check | --rollback]
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
  the old one only once the new one is up. `worker`, `brief`, `history` and `tidy` stay this
  computer's.
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
  The sidebar's Start knows the panes. `start` from the command line, `--machine` too, reads
  them from `herdr-app ls`, which counts no mod pane: it closes the tab only when it saw that
  shell, right after its own `space.new`, as the new space's one tab and that tab's one
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

- Every bot the attach ledger binds on this computer whose pane is gone, or is a bare shell, is
  restarted by `am restart --tree`: in its pane's space, tab and folder, resumed by
  its session id where its agent allows it, its helpers (workers included) under the new pane.
  The main bot comes first, each bot after its lead. A pane with a program in front is never
  touched.
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

Session ids. Claude gets its id from Herdr at launch. dsh-TUI and Antigravity take none at
launch, so the pack reads the id from what each leaves on disk (DSH's session folders for the
pane's folder, Antigravity's prompt history: only its time, folder and conversation id) and
records it as it does Claude's: a session row in the workers ledger and the pane's
`agent.session` label. Anyone can leave a session in that folder with no pane the pack knows (a
terminal of your own, DSH Desktop), so the pack takes only a pane's first conversation: the one
session born within two minutes after the pane started. It records none, and the bot comes back
on a new conversation, which the report says, when two sessions were born then, when none was,
or when another pane of that agent in that folder (any hc pane, whoever started it, and every
launch the workers ledger names) started within two minutes before the pane or before that
session. A session born later is never taken, and a recorded id is never replaced. What stays
unknowable: a session someone started outside hc in that folder inside those two minutes, when
the pane's own agent left none. A conversation started later inside the pane is not followed:
the bot resumes its first one. DSH's home is `$DSH_HOME`, else `~/.dsh`.

The login service. `install.sh --revive` (or a yes when it asks; `--yes` never installs it)
runs `am revive service install`: on Linux a systemd user unit,
`~/.config/systemd/user/automagik-herdr-revive.service`, enabled and never started on the spot.
The unit has no start timeout (the pass bounds its own waits), and what the pass prints, which
the user journal keeps, is counts only: no folder, no bot name.
At login it runs `am revive --boot --wait 600`: it waits for herdr-core, runs once
per boot, and also takes the bots whose ended pane another command swept since the boot.
`loginctl enable-linger` makes it run at boot with nobody logged in.
`am revive service uninstall` (and `install.sh --uninstall`) removes the unit when
it is the pack's. macOS (launchd) is not built yet: run `am revive` by hand there.
Panes on a linked machine are that machine's own to bring back.

## The attach ledger

Which pane plays which bot is recorded in one file, `<app home>/automagik-herdr/attach.jsonl`
(beside the workers ledger), and nowhere else. Only `automagik-herdr` writes it: `start`,
`attach` and `detach`, and any run that reads it and finds a pane ended. The sidebar's Start
and Attach run the command line too. The `bot` label is a display hint: `hc label` changes
no row, so relabelling a pane moves no bot.

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
```

`since` is the attach row's `at`; `created_ms` is hc's. Both forms fold and confirm with hc first.

**The first run.** With no file yet, the first command that reads it imports today's labels
once: each live pane on this computer carrying `bot=<id>` of a bot some project here defines
becomes an attach row with `by: "import"` (one pane per bot: an agent in front, then the
newest). The file is then made, even empty, so this happens once. The briefing hook reads the
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
  also ends when its bot's program ends; its branch stays.
- **Cleanup (#567):** a worktree this command made (`created` in the ledger) is removed
  (`git worktree remove`, no `--force`, then `git worktree prune`) once every worker that ran
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
    it. Ignored files (`.env`, build output) do not keep it: they go with the folder, as
    `git worktree remove` does.
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
  lead, base, created, swap, override, override_requested, at }` (`at` is ISO 8601).
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
full send/keys/attach scope is #628): it scans PATH past every guard folder and passes an
allowed call through unchanged — same stdio, same exit code, same stdout and stderr. It allows
`send`, `read`, `ls`, `get`, `wait`, `put`, `label` (the caller's own workers only), `kill`,
`rm`, `events`, `schema`, `templates`, the doc-only `--help`/`-h`/`--version`/`--skill` forms,
and one `run` shape: the dsh-tui worker start that `am worker` emits (`--bg`, the
caller as `--parent`, `worker.of=<the caller's bot>`, a `--cwd` under the project's
`.claude/worktrees/`, and `/usr/bin/env PATH=… dsh-tui` after `--`). Everything else is
refused with one stderr line naming #624, #628 and #631, and the real `hc` is never called:
`exec`, any other `run` (including a template or another agent), file writes, edits and reads,
`machine`, `server`, `update`, `connect`, `keys`, `attach`, a `machine/t7` target on every
verb but `send` (`hc events --terminal`/`--children-of` included), and any `--on` outside an
allowed `send`.

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
labels). Any target outside that team is refused. The launch briefing carries the guard
paragraph only for a dsh-tui bot; a claude, omp or hermes briefing is unchanged. On a linked
machine the seat uses the guard folder that machine has, beside its own `automagik-herdr`; with
none it gets no guard, no briefing paragraph claiming one, and one warning naming #624.

**This is a guardrail, not a boundary.** A bot can bypass it with an absolute path to the real
`hc`, a raw socket client, or `hc connect`. The team data is still writable: a bot that edits
its project's `.herdr/bots.json` can widen its own `send` scope (for example by giving itself
the pm, integrator or fixer rank), and a bot can label its own workers. `kill`, `rm` and `put`
stay unscoped, and `read`/`ls`/`get` are cross-pane by design; #628 owns that scope. The real
fix is the sandboxed socket mask plus the per-pane filtering proxy wish (#624), and #631 is the
hard boundary. This wrapper only stops the ordinary `hc exec` attempt while that lands. The
pack's own CLI still reaches the real `hc` for its trusted calls (system status, machine lists,
remote file/exec, docs), so `am worker` and the remote commands keep working in a
guarded pane.

### The per-pane hc proxy (the sandbox boundary, opt-in)

The proxy is **off by default** for every bot. Set the bot entry's `hcProxy` boolean with
`am edit <bot> --hc-proxy on|off`, then run `am proxy approve`
(review the diff), then restart that bot to apply it. The effective value comes from that bot's
entry in the approved snapshot, read at each start, restart and worker start. Approved on stays
on when a pane changes the working key to false or removes it. Working on with approval off
or missing refuses with an instruction to run `am proxy approve` first.
Invalid approval refuses working on. Working off starts plain, preserving its argv, with a
loud STDERR warning naming the record, the problem and `am proxy approve`:
invalid approval cannot be trusted to say on. Known limit: previously approved on plus a
working off edit and an invalid record starts plain with that warning. A sandboxed pane
cannot write the approved record; only an outside change can cause that combination.
`show` and `dsh-tui doctor` print both values; doctor warns about invalid approval regardless
of the switches, and warns
when working off still has a running proxy and retains install checks for a malformed roster.
Only Linux
pack-started dsh-tui seats and dsh-tui workers get the helper. `AM_HC_PROXY` no longer opts in
other bots. C2b-1 prepares the approved switch; leave it off until C2b-2's approved-worker
allowance and C2c's coordinated sandbox-row enablement have shipped. The profile row stays
unchanged. For rollback, run `edit <bot> --hc-proxy off`, `proxy approve` (review the diff),
then `restart <bot>`; end and relaunch any existing workers that also need rollback.
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
`am proxy approve --project <dir>` (which prints the diff first), and is the only
roster the proxy reads. **A roster change needs a pane restart** after
`am proxy approve`, so the new pane's
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
run `proxy approve`. The printed diff is the check, and approving is the person's act.

The helper sets `DSH_SANDBOX_MASK=1`, `AM_HC_REAL_SOCKET` and `AM_HC_PROXY_SOCKET` for the
pane; the DSH runner wrapper applies its mount rules and binds the proxy at the real core socket
path, so the real socket folder is hidden, and binds the data parent read-only once (the
stable execution folder and `approved/` both live there) so a sandboxed bot cannot rewrite its
helper, runner or guard, or its project's approved roster. The wrapper is copied byte-equal from
`mods/am-sidebar/bin/hc-socket-mask.mjs` to `~/.local/share/automagik-herdr/dsh-sandbox/` by
`dsh-tui install`, which also installs the profile's managed sandbox row. The proxy pins
herdr-core 0.1.14 and refuses any other version; its socket lives in
`$XDG_RUNTIME_DIR/automagik-hc-proxy/<terminal>/hc.sock` (0700 folder, 0600 socket), outside
the worktree and the app home. **Fail closed:** if the proxy cannot start, the pane's command is
never started, so no sandbox exists and `hc` cannot auto-start a core inside one; a proxy that
dies takes its pane with it. The network stays open: the proxy filters the hc socket, not the
box's TCP listeners, and localhost admin ports cannot be hidden without a network namespace.

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
am update --auto off   # Install updates automatically: on (default), off, or status
```

**Install updates automatically** is on by default: when the sidebar's check finds a newer
release, it installs it the same way `am update` does (the signed pointer, the
sha256, the replaced set kept for `--rollback`), Herdr reloads the mods, and one notice says
"Automagik Herdr updated to X". Your bots keep running: they live in herdr-core, not in the mods.
A version you rolled back with `--rollback` is never installed on its own again; it waits for a
newer one. A failed install posts one notice with the reason, changes nothing, and tries again
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
`am update --rollback`). Then usagemeter, as `meter install` does (the signed
meter-lane pointer checked here, the build's sha256 on the machine, never a downgrade, the old
binary kept as `usagemeter.prev`): on a machine that has one, or on all of them once you agreed to
that, and never after `install.sh --no-usagemeter`. This computer's am and usagemeter follow in the
same run; its pack is the sidebar's own update above.

`am machines` shows the last answer of each machine: its am, pack and usagemeter
versions, and what the last run did or why it did not (a pointer it could not verify, a download
that failed, a machine that was not connected). A machine that was not updated is also said once in
a notice. The record is `<app home>/automagik-herdr/linked-updates.json`.

It is on by default. A machine opts out with its own switch, the file `~/.automagik/linked-update`
holding `off` (`am machines --auto off` there, or `--machine M` from here): the run
reads it first and starts nothing on that machine. `AUTOMAGIK_HERDR_NO_UPDATE=1` on the computer
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
- `codexAuto` is retired (#1125). It used to opt a bot's Codex seat and workers out of Codex's
  auto mode; the owner's ruling (10 and 12 Nov) is that every Codex seat and worker runs in it,
  so `false` no longer opts out: the field is kept as written, ignored, and loading the bots
  file warns once ("codexAuto false no longer opts out"); remove it. A value that isn't a boolean
  is still dropped with a warning (and refused by `check`). See
  [Codex's launch mode](#codexs-launch-mode).
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
| Codex (`codex`) | `--approve-for-me --disable hooks --no-daemon -c sandbox_workspace_write.network_access=true`, `--add-dir <folder>` per derived folder | Codex's auto mode: its reviewer answers approval requests, inside the workspace-write sandbox (#946), its hooks are off (#1045), so startup never stops at "Hooks need review" and never runs an untrusted `.codex/hooks.json` command in an unattended pane, and it runs in its pane, with network and the folders it needs (#1125). No opt-out. |
| Antigravity (`agy`) | `--dangerously-skip-permissions`, `--mode <agyMode>`, `--settings <file>` | No permission prompt and no classifier: everything the file's deny list does not name runs (see [what runs without a prompt](#antigravitys-permission-list)). The file's `trustedWorkspaces` answers the folder-trust question. |
| dsh-TUI (`dsh-tui`) | nothing | Its DSH profile on the machine it runs on sets the approval policy; dsh-tui takes no such flag. |
| Oh My Pi (`omp`) | nothing | omp 18.14.2 has only skip-all flags (`--auto-approve`, `--approval-mode=yolo`). |
| Hermes (`hermes`) | nothing | Hermes 0.22.5 has only a skip-all flag (`--yolo`). |
| Pi, OpenCode, Cursor, Copilot, Amp, Grok, Kimi, Kiro, Qoder, Crush | nothing | Not checked: none is installed where the flags were read (2026-11-10), and the pack adds no flag it has not seen an agent's own help name. |

Flags read from claude 2.1.322, codex-cli 0.167.0 and agy 1.5.4. No skip-all-approvals flag is
passed for any agent but Antigravity; one for another agent needs the owner's word first.
`am show <bot>` prints the bot's `auto mode` line (in `--json`, `autoMode`: its
words, a note, and for an Antigravity bot on this computer whether agy's sandbox can run here).

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
- `--add-dir <folder>`, derived per launch and only for folders that are there: the launch
  folder's git dirs, which Codex otherwise keeps read-only (`git rev-parse --git-dir
  --git-common-dir`: a checkout's own `.git`; for a linked worktree its own folder under the main
  checkout's `.git/worktrees`, where its index and lock live, then that `.git`), herdr-core's
  state and data folders (`$XDG_STATE_HOME/herdr-core`, `$XDG_DATA_HOME/herdr-core`, else under
  the home folder: `hc` needs them to reach its core), and the tool caches a build writes: Go's
  module and build caches (`GOMODCACHE`, `GOCACHE`), npm's (`npm_config_cache`, else `~/.npm`),
  pnpm's store and cache, and Bun's install cache (`BUN_INSTALL_CACHE_DIR`). Never the root, the
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
- shells and wrappers: `sh`, `bash`, `env`, `xargs`, `find -exec` and `-delete`, `awk`, `tee`,
  `sed -i`, and so a pipeline such as `cat x | sh`;
- the network and other machines: `curl`, `ssh`, `hc run --on`, `gh gist create`;
- a plain (non-force) `git push`, to `dev` or `main` too: only GitHub's branch protection
  stands there;
- a child agent started by hand (`claude --dangerously-skip-permissions`, another `agy`,
  `hc run -- ...`), and text typed into another pane with `hc send`;
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

### Ending a worker

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
