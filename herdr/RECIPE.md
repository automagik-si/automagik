# automagik-herdr pack

A Herdr pack: a bundle of mods that installs itself and manages its own marketplace, instead of a
single plugin. `mods/` holds each piece, `catalog/index.json` is the index of what we ship and what
we carry, `install.sh` puts the released pack into an app home, `scripts/catalog.mjs` rebuilds the index.

## What you see

Nothing of its own: the pack is what it installs. The main mod is **`am-sidebar`** — the
sidebar and the Bots in it (a project's main bot and its team, Automagik's characters, the
Create/Edit form, Start/Attach, the per-turn briefing, and `bin/automagik-herdr.mjs`); its own
`RECIPE.md` describes it. Beside it are the pieces that make the sidebar usable — `am-footer`
(the footer rail), `am-status` (the bottom status bar, with the pack's version and update
check), `am-tabs` (the tab bar), `am-new-menu` (the `+` menu), `am-markdown`
(Markdown straight from a terminal — the menu and the preview in one mod), `am-automations`
(scheduled agent prompts), `am-quota` (the Accounts panel) — and **`am-mods`**, the table at
`⌘⇧M` that lists every installed mod with on/off switches, `herdr-app check` results, versions,
sources from our catalog and paths, plus the marketplace (`m`) and the review before any copy.

Every mod brings its own `RECIPE.md`, `LICENSE` and keys.

## How it behaves

- **Install** (`install.sh`, through `mods/am-sidebar/update.mjs`): installs every `PACK_MODS`
  folder of the release's `automagik-herdr-pack-<v>.tgz` into `<app home>/mods/` as one unit,
  only over folders its record lists (others are left alone, or moved to `backup/` with
  `--adopt`), merges the pack's keys (only free keys — one in use stays the person's, printed as
  `key = … stays …`), writes `<app home>/data/am-mods/catalog.json` with the index URL (or brings
  the `catalog.json` in its data folder from before the rename up to date), then
  runs `herdr-app check` per mod and fails the run if any fails. Settings, terminals, Pocket Link
  and Herdr's own mods are untouched.
- **Catalog** (`node scripts/catalog.mjs`, `--refresh`, `--check`): reads the remotes and HEAD of this
  checkout, lists every `mods/*/main.js` as a mod of the pack's entry, appends `catalog/repos.json`'s
  repos that pass the gate (each of ours needs RECIPE.md + LICENSE; a curated repo needs a licence
  and an upstream RECIPE.md; a mod name has one owner, ours first — every refusal is printed), and writes
  `catalog/index.json` in the shape `herdr.dev/mods` publishes (`schemaVersion`, `generatedAt`,
  `modCount`, `repositoryCount`, `mods[]` with `owner/repo/fullName/url/stars/pushedAt/headCommit/
  path/name/blurb/modNames/hasKeys/hasPreview/recipeBytes/previewUrl`). One mod has one owner: the
  first entry to claim a name keeps it (the pack is first), and a repo left with nothing drops out.
  `generatedAt` and our own `pushedAt` are kept when what the index describes is unchanged, so a
  release commit never rewrites it and an open catalog pull request stays mergeable (#215).
- **At run time** the manager reads that index: `data/am-mods/catalog.json` (else the one from
  before the rename) → `{ url }`, a
  local path in a checkout or the published raw URL after a push. From it, each installed mod gets
  its repo, blurb, stars and head commit; `d` compares the folder against that commit; `u` adopts a
  hand-installed catalog mod so later updates are ordinary.

## Built from

- `mods/am-mods/` — `main.js`, `core.js`, `mod.json`, `RECIPE.md` (vendored from
  `jacksonpires/herdr-app-mod-manager`, MIT, retargeted at our index).
- `catalog/index.json` (generated), `catalog/repos.json` (the other repos we carry).
- `scripts/catalog.mjs`, `install.sh` with `mods/am-sidebar/update.mjs` (no dependencies; `gh` optional for stars).
- `keys.json` — `cmd-shift-m` → `mod.open:am-mods`.
- Programs the pack runs: `git`, `herdr-app check`, `node`; the manager adds `gh`, `find`,
  `shasum`, `stat`, `rm`, `mv`, `mkdir`, `cp`, `open`.

## Watch out

- The installer owns `mods/` and `keys.json`; the manager owns what it installs (shared
  `"am.mods.installed"`). Installed copies of a pack mod are replaced wholesale by the
  installer — edit here, not in the app home.
- The pack's entry is generated from this checkout: a stale HEAD in `catalog/index.json` makes the
  manager think the pack is behind. Regenerate before tagging a release.
- A catalog `path` names the subfolder a multi-mod repo nests its mods in; get it wrong and the
  mod's entry lands with an empty `modNames` and disappears from the marketplace.
- `whats-in-the-catalog` needs to be true: dedupe keeps the first claim, so ordering matters (the
  pack first, then curated repos).
- The manager can't draw catalog preview images (mod `fetch` is text/JSON only).

## Done when

- `herdr-app check mods/am-mods` passes, run as the contributor gate in a scratch `HERDR_APP_HOME` on a machine with no live Herdr (the check runs the mod's `init()` for real: `AGENTS.md`).
- `node scripts/catalog.mjs` writes an index whose first entry is this pack, whose `modNames` is
  exactly the folders under `mods/`, and with no mod name claimed twice; `--check` exits 0 on that
  index and 1 when any entry drifted (never for its age or head commit).
- `HERDR_APP_HOME=<temp> sh install.sh --yes` installs every mod, adds only free keys, writes the
  catalog config and prints `check passed` for each mod. Run it, too, only on a machine with no live Herdr: the installer runs `herdr-app check` on each mod.
- In the app: `⌘⇧M` opens the table; a mod installed from our catalog shows its repo and stars;
  `d` reports equal or differing file counts; a switch moves the folder to `mods-disabled/`.
