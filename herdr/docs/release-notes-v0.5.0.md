# Automagik Herdr 0.5.0: the whole pack in one download

Until now a new install got only the bot sidebar. From 0.5.0 one download installs, updates and
rolls back every Automagik mod together, renamed `am-*`.

```sh
curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik-herdr/main/install.sh | bash
```

## Upgrading from 0.2.x, 0.3.x or 0.4.x: run the installer again

`automagik-herdr update` from 0.2.x–0.4.x will not reach 0.5.0. Those updaters look for the old
sidebar-only download (`automagik-herdr-<version>.tgz`). This release ships
`automagik-herdr-pack-0.5.0.tgz`, so they report no update. An older updater also never runs the
0.5.0 migration: it does not move layouts, key bindings or briefing hooks onto the new folder
names.

**Rerun the one-liner above.** It recognises the old install, moves it aside into
`~/.config/herdr-app/automagik-herdr/.prev/`, installs the pack and migrates your setup:

- layouts, with a dated backup first;
- `keys.json`, for example `cmd-v → spaces-agents.paste` becomes `am-sidebar.paste`;
- the CLI link;
- the bots' briefing hooks.

Your bots (`.herdr/bots.json`) and Herdr's own settings are not touched. Neither is Pocket Link.

## What's new

- **Eight mods, one install.** Each has its own `RECIPE.md`:
  - `am-sidebar`: the spaces and bots sidebar, with the space-icon dialog now inside it;
  - `am-footer`: the brand bar and footer rail;
  - `am-tabs`: the tab bar;
  - `am-new-menu`: the `+` menu;
  - `am-markdown`: right-click a terminal for the Markdown files it printed and preview them;
    it replaces md-menu and markdown-browser;
  - `am-mods`: the mod manager, `⌘⇧M`;
  - `am-automations`: scheduled agent prompts;
  - `am-quota`: per-account usage for Claude Code and Codex through CLIProxyAPI, plus account
    switching.

  Every mod is Apache-2.0. The three MIT-derived mods keep their upstream notices in
  `LICENSE-upstream`.
- **The footer rail.** Bots comes first, then Mods, Automations, Quota, Settings and Add machine.
  The Bots tab opens a small menu with **New bot** and **Bot settings**. The sidebar body no longer
  has a "+ New bot" row.
- **Sidebar buttons from other mods.** Any installed mod can add up to 4 buttons to the footer rail
  by declaring `automagik.footer` in its own `mod.json`. A button can show a badge count. See
  "Add a sidebar button from your mod" in the README.
- **usagemeter.** The installer puts the pinned usagemeter 0.2.0 into `~/.local/bin/usagemeter`.
  The download is checked against the release's `SHA256SUMS`, and the installer never replaces a
  newer copy. While Herdr is open, the sidebar runs `usagemeter sync` 30 s after it loads, then
  every 10 minutes, one run at a time. There is no LaunchAgent. `--no-usagemeter` skips this step.
  A failed download is only a warning.
- **Install verify and repair.** Rerunning the installer on the version you already have checks
  every installed pack file against the release. It reinstalls a missing or damaged mod and keeps
  the damaged copy in `backup/`. It also restores a deleted `automagik` layout and runs
  `herdr-app check` again. It says "up to date" only when every file matches.
- **One rollback.** `automagik-herdr update --rollback` swaps the whole previous set back. When the
  rollback crosses the rename, it also moves your layouts, keys and briefing hooks back.

## After the upgrade: the briefing hook

0.5.0 renames the sidebar's folder from `spaces-agents` to `am-sidebar`. The installer moves every
briefing hook it knows about to a fixed entry point, `~/.config/herdr-app/automagik-herdr/briefing.mjs`.
At the end of its run it lists each settings file it rewrote. A run that crosses the rename always
prints the two points below, even when it rewrote no file. The old path has no shim, so:

- **Running Claude sessions keep the OLD hook and get no briefing.** This applies to a session that
  was already running in one of the listed projects: it still holds the old hook, which points into
  the renamed folder. It gets no briefing until you restart the bot: `automagik-herdr restart <bot>`
  (or the bot row's Restart; v0.6.0 and later).
- **Projects the pack doesn't know about are not rewritten.** The installer only rewrites projects
  it knows:
  - the sidebar's remembered projects;
  - the CLI's project list;
  - folders in the workers ledger;
  - the open spaces and bot panes of the default app home.

  Any other project keeps the old hook and gets no briefing. To fix one, run
  `automagik-herdr start <bot>` or `automagik-herdr attach <bot>`; either writes the new hook. You
  can also open the project as a space in Herdr and run the installer again. A rerun of the same
  release checks the installed files and moves the hooks of every project it now knows, open spaces
  included.

`automagik-herdr update --rollback` moves the hooks back to the older release's path and prints the
same kind of list. A running session keeps the hook it loaded until you restart the bot:
`automagik-herdr restart <bot>` (or the bot row's Restart).

## Also lost or kept across the rename

- **The tab bar's per-space panel memory is reset.** auto-tabs kept it in its own mod storage, which
  no other mod or installer can read, so `am-tabs` starts with nothing remembered.
- **Shared state moves when each mod first loads.** This covers the sidebar's projects, icons,
  colours, pets, collapsed state and width, plus the Markdown preview's slots. Each mod copies its
  old keys to `am.*` once, and the old keys stay in place. Changes you make under 0.5.0 (a new
  icon, a recoloured space) are **lost if you roll back**: the older release reads only the old
  keys.

## Known limits, and what to do

- **Two rollbacks in a row don't toggle.** After a rollback to 0.2–0.4, the link runs that
  release's CLI. It looks for its own kept folder (`spaces-agents.prev`), so a second
  `--rollback` reports nothing to roll back and changes nothing. To return to 0.5.0, rerun the
  installer.
- **An older updater can't roll forward.** Covered above: a 0.2–0.4 CLI never installs 0.5.0, so
  rerun the installer.
- **A sidebar folder you installed yourself blocks the updater.** If `mods/am-sidebar` (or
  `mods/spaces-agents`, before the upgrade) is a folder this installer didn't put there, the pack's
  `automagik-herdr update` can't manage the other seven mods, and each rerun of the installer
  reinstalls them. Run the installer with `--adopt` to let the pack take that folder over. Your
  copy is moved to `automagik-herdr/backup/` first and comes back on `--uninstall`.
- **A rollback keeps the pack's key binding and the setup layout.**
  - `cmd-shift-m → mod.open:am-mods` was merged into `keys.json` and stays after a rollback; delete
    the line if you don't want it.
  - When a rollback crosses a change in the mod list, an `automagik` layout replaced by the
    installer can still name mods that are gone. Switch to another layout, or restore it from
    `automagik-herdr/backup/layouts-<date>/`.
- **An old footer or space-icon you kept still writes old keys.** If you didn't adopt a hand-installed
  `sidebar-chrome` or `space-icon`, it keeps writing the old shared keys. `am-sidebar` stops reading
  them after its one-time copy. Remove the old mod (or rerun with `--adopt`) so there is one source.
- **`--uninstall` doesn't undo the rename edits.** It moves the pack out of `mods/` into
  `automagik-herdr/.prev/` and removes the command link. Layouts, `keys.json` and hooks still name
  `am-*`. To get the old ones back, copy them from `automagik-herdr/backup/layouts-<date>/` (and
  each `settings.local.json.am-backup`), or roll back before uninstalling.
- **Running `update.mjs install` by hand twice replaces the kept set.** Only the latest replaced set
  is kept in `.prev/`. The installer and `automagik-herdr update` never do this, so it matters only
  if you call `update.mjs` yourself.
- **Open spaces are checked for hooks only at their own folder.** A space open in Herdr that isn't
  in a remembered list gets its own `.claude/settings.local.json` moved, but no subfolder or
  worktree scan. That is deliberate: an open space can be any folder, including your home folder.
  For a bot in a subfolder of such a space, run `automagik-herdr attach <bot>`.
