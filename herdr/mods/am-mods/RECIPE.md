# Mod manager

A table of every mod in a Herdr app home, with the switches, versions and origins that let a
person run their own mod set: install from a marketplace, update, switch off, remove — each after
a review that lists what enters, what the code does, and which keys it takes.

It is vendored from `jacksonpires/herdr-app-mod-manager` (MIT) and changed for this pack: the
catalog it reads is ours (`catalog/index.json`), the table gained on/off, `herdr-app check`,
catalog pairing and drift, and it is written against Herdr's current mod API.

## What it shows

A dialog at 80% × 75% (`⌘⇧M`, `mod.open:am-mods`), `popover` background, 13 px text.

All of it in English (the rest of the pack is; there is no locale mechanism to share).

- **Header**: `Mods`, then the groups' counts — `N Automagik Herdr · N yours · N built-in · N off ·
  N with errors · checking N` — and, when the index can't be read, `catalog unavailable: …`
  instead of silence.
- **Table** (fixed columns, scrolling) in three groups, each under a heading (`core.groupMods`):
  `Automagik Herdr <version>` (the folders the pack installer put in `mods/`, read from its
  ownership record `automagik-herdr/installed-by-install.sh`), `Yours` (marketplace, catalog,
  clones, local folders) and `Herdr built-in`, folded to one row until `enter` on it or `b`.
  Columns (`core.describeMod`): `ON` (30×17 switch, accent when on; `–` for Herdr's own mods,
  which cannot move), `NAME`, `KIND` (`Automagik Herdr`, `marketplace`, `catalog`, `clone`,
  `local`, `built-in`, `off`), `CHECK` (`…` → `ok` / `error` from `herdr-app check`), `VERSION`
  (the pack's release, `commit <sha7>`, `from <clone> v<version>`, `upstream <sha7>`), `SOURCE`
  (`automagik-herdr`, `owner/repo[/path] ★stars`, `owner (installer)`, `Herdr`), `INSTALLED`
  (for the pack: the record's `installed=`, else the record file's date), `CHANGED` (folder
  mtime). The path is in the detail line.
- **Detail line** under the table: `path:`, then for a pack mod `Automagik Herdr <version> ·
  installed <date> · u updates the pack`; otherwise the catalog's name and blurb with stars, the
  drift result when checked, origin/commit/mods/layouts/keys/installed date, or the error from a
  failed check. A selected mod that is switched off says so.
- **Marketplace** (`m`): the index's repos, ten per page, with stars and description; `/`
  searches, `s` sorts (stars / updated), `←→` pages, `o` opens a repo, `enter` reviews.
- **Review** before install or update: what enters (mods, layouts, file count, commit), what the
  code does (runs programs, reaches the network, reads/writes files — a pattern match over the
  source), the keys it adds and the keys it keeps, and `Blocked` when a name is taken.

## How it behaves

- **On/off** moves the folder between `mods/` and `mods-disabled/` (`core.setEnabled`): the app
  loads only `mods/`, so off is real and nothing is deleted. Herdr's own mods are refused.
  So is off for a mod a block of the shown layout names (`layout()`, its name `shared("layout")`;
  `core.layoutGuard`): Herdr drops a layout whose mod is missing and shows plain Herdr, so the
  message names the layout and says to switch layouts first. Its `terminal_menu` mod may go off
  (Herdr warns and falls back to its own menu); the message says so. Turning on is never blocked.
  Remove (`x`) asks the same before its question, for every mod of a package that is on (#414):
  refused, "then remove it", for a block's mod; the menu's goes, with the note. `am uninstall
  herdr.<mod>` asks too (`am-sidebar/release.js` carries a copy of both functions, a test keeps
  them equal), reading the shown layout from `herdr-app status`; when that gives none, it switches
  the mod off anyway and names each of `layouts/` that shows it. A package whose own layout
  (its record's `layouts`) is the one shown is refused first (`core.packageLayoutGuard`, #420):
  remove moves that layout aside; `am uninstall herdr.layout` asks with release.js's copy, "then
  uninstall it" (#430), and removes the layout anyway, saying why, when `herdr-app status` gives
  none. `am uninstall herdr.pack` and `install.sh --uninstall` refuse
  while the shown layout's blocks name a pack mod; an update holds a mod it no longer ships in
  `mods/` while a layout's block names it. A package update that stops shipping its layout Herdr
  shows (`shared("layout")`) keeps that file in `layouts/` and in the record, and says so (#431):
  the review marks it, the message names it; the next update after a switch moves it aside. With
  no shown layout to read, it is moved aside as any other the update drops, and the message names
  it and says why. Its mod twin (#490): a mod the update stops shipping that the shown layout's
  blocks name stays in `mods/` (a link stays a link) and in the record, the same way; with no
  shown layout to read, it is moved aside and the message says why and names each layout in
  `layouts/` whose blocks name it.
- **Records** of what the manager installed live in shared `"am.mods.installed"` (copied once on load from its
  name before the rename, `migrate.js` SHARED_RENAMES; source,
  prefix, commit, mods, layouts, keys added, risks seen). Update and remove work off them.
- **Catalog**: `core.catalogUrl` reads `data/am-mods/catalog.json` (`{ url }`), then the one in its
  data folder from before the rename, or the mod's own
  `catalog.json`, else the published index; a local path is read, an `https` URL is fetched. A mod
  is matched by the entry's `modNames`, so an installed folder with no record still knows its repo,
  blurb and head commit.
- **Origin**: installs come from the **GitHub topic search** (`herdr-mod`) — that is where a source
  is chosen. The catalog (`catalog/index.json`) only labels a mod's origin and drift; it is not an
  install source, and an entry that is a link to someone else's installer (`"external": true`,
  e.g. Pocket Link) carries no `modNames`, no path and no install action.
- **Drift** (`d`): shallow clone at the catalog's commit, SHA-256 both sides, skipping the files
  Herdr writes into every mod folder (`gpui-kit.d.ts`, `jsconfig.json`). Reports changed / new /
  removed counts — "differs from upstream", which is edited *or* behind.
- **Check**: `herdr-app check` once per enabled non-Herdr mod, one at a time, streamed into the
  `CHECK` column; a failure turns the name red and puts the message in the detail line.
- **Install / update / remove**: clone into `~/.config/herdr-app/.am-mods-cache/`, review, then
  copy `mods/<name>/` and `layouts/*`, merge `keys.json` (never overwriting a key in use), check,
  toast. An update or a removal **moves the old folder aside** to
  `<app home>/automagik-herdr/backup/<mod>-<stamp>` — a rename, never `rm -rf` — and an update puts
  the mod's own `.state/`, other dot paths and `node_modules/` back into the fresh folder. A name
  the manager didn't install blocks the install until the person removes or renames it.
- **The pack's mods** update together: `u` on one asks, then runs the pack's own
  `mods/am-sidebar/bin/automagik-herdr update` (the file behind `am update`; checksum-verified release, the replaced folders
  kept for `--rollback`) in this app home, never a per-mod clone; `d` on one says the pack checks
  its own files (install.sh again). The installer writes `installed=` into its record on every
  install, update and rollback.
- **Bulk update** (`U`) is a queue of reviews, one package at a time: nothing is applied that a
  person has not seen, because a plan can add a risk or clash with a name.
- **Pocket Link is read-only**: the mod, its LaunchAgent and its pairing key belong to
  `automagik-dev/automagik-pocket`. Its row refuses install, update and remove and `o` opens that
  repo's installer; the manager never touches `mods/pocket-link`.
- **Marketplace search**: `gh api search/repositories` for the topic, else the same URL through
  `fetch` anonymously. The risk scan reads aliased imports too (`import { exec as sh }`,
  `const { exec: sh } = …`), so renaming a call does not hide it.

## Built from

- `mods/am-mods/`: `main.js` (the view: table, marketplace, review, form), `core.js` (files,
  git, catalog, drift — no Herdr import, so `node` can run it), `mod.json`
  (`place: "none"`, dialog overlay 0.8 × 0.75).
- Herdr API: `exec`, `appHome`, `readTextFile`, `writeTextFile`, `shared`/`setShared`, `props`,
  `closeOverlay`, `openOverlay`, `notify`, `theme`, `layout`, `panes`; `fetch`; `fs/promises`
  (`readFile`, `writeFile`, `mkdir`, `unlink`, `stat`); `InputState`/`Input`.
- Programs: `git`, `gh` (optional), `herdr-app check`, `find`, `shasum`, `stat`, `rm`, `mv`,
  `mkdir`, `cp`, `open`.
- Keys: `cmd-shift-m` → `mod.open:am-mods` (from the pack's `keys.json`).

## Watch out

- **It runs programs, reaches the network and moves files**: it clones repos, searches GitHub,
  copies into `mods/`, `layouts/` and `keys.json`, and moves folders to `mods-disabled/`. That is
  its job; the review screen exists so a person sees the same about every mod they add.
- The risk scan is a regex over source text: it over-reports and cannot prove a mod safe.
- Switching off a mod a layout still points at leaves that block empty — hide the block too.
- A mod's failure is only visible through `herdr-app check`; Herdr writes no `<mod>.error` file.
- `exec` has a time limit, and each check is one process: the sweep runs one at a time.
- The dialog's preview images from a catalog (`previewUrl`) are not shown: the mod `fetch`
  returns text/JSON only, so there is no binary to draw.
- The pack's installer (`install.sh`) owns the folders its record lists; the manager owns what it
  installs. Both record what they did, in different places. An install from the catalog is
  fetched at the catalog's `headCommit`, built in `automagik-herdr/staging/`, then renamed in.

## Done when

- `herdr-app check mods/am-mods` passes.
- `node scripts/catalog.mjs` writes `catalog/index.json` with this pack first, every `mods/*`
  folder in its `modNames`, and one owner per mod name.
- `HERDR_APP_HOME=<temp> sh install.sh --yes` installs the pack, adds only free keys, writes the
  catalog config and passes `herdr-app check` on each installed mod.
- `⌘⇧M` opens the table; a mod installed from the pack's catalog shows its repo and stars in
  `SOURCE`; `d` reports equal or differing counts; the switch moves a folder to `mods-disabled/`.
