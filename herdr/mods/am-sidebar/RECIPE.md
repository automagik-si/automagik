# am-sidebar

The sidebar of Automagik Herdr, and the bots in it: each project's main bot and its team, drawn
with Automagik's characters, created and edited in one form, started on or attached to any coding
agent, labelled for the agent event envelope, and briefed before every Claude turn. Derived from
Herdr's shipped `spaces` 0.1.7 (the owner's clone of it); everything bot-shaped is this pack's.

## What you see

One scrolling column, `chrome` background, 13 px text.

- **Machine headers** when a space isn't on this computer: this computer first, then the others by
  name, unless the person moved one up (a hovered header's `↑`, **Move to top**; the order is kept in
  the sidebar's localStorage as `machines.order`, like the folds; machines it does not name follow
  in that default order); **space rows** with the space's icon
  (an image, an emoji on its colour, or its letter), name, repo · branch, `↑n ↓n`, and a `+` that
  opens `am-new-menu` for that space.
- **Under the first space of each project** (its folder's git main checkout; worktree spaces keep
  plain rows): the project's bot tree. The main bot is a raised card bordered in its ink;
  categories are uppercase headers with a muted subtitle; members nest under their lead inside a
  solid guide line, the helpers herdr-core reports as a pane's children inside a dashed one.
  A row is a fold arrow (shown on hover only, no count), the character in a pose for its
  status, the name in its colour's ink over `role · model` (`Main bot · model · project` for the
  main bot, `not running · role` for a stopped bot), the agent's Herdr icon and the status mark.
  A planned bot is dimmed and dashed, asleep, with its note and a `Wave n` pill. A project with
  no open space (its last space closed, or the CLI listed it) keeps its tree where its space
  was, else right after the open spaces, under the project's name and a Start button that
  opens a space on the project and starts the main bot there. Plain agents with no bot still
  list as they always did.
- **Collapsed**, the rail shows numbers and status glyphs, and a spaceless project as its main
  bot's character (a click starts it).

## How it behaves

- **Definitions** are the project's `.herdr/bots.json` (schema and validation in `model.js`):
  every open space's folder, the projects remembered in shared `am.sidebar.projects` and the
  ones the CLI lists in `<app home>/am-sidebar-projects.json` are read on this machine or
  another, watched for edits, and written back here only.
- **The view is pure data** (`rows.js`): which bots are live by the `bot=<id>` label on a terminal,
  each bot's pose per status, the project tree (nesting by `lead`, categories, planned members,
  helpers), where each project's tree sits in the sidebar, and the rows a fold leaves showing.
- **Start and Attach** (`launch.js`, `launchArgs.js`): a bot's live pane is the terminal carrying
  its label with an agent in front. Start builds the `hc run` line: a main bot with `--no-parent`,
  a member with `--parent <its lead's live terminal> --outlive-parent` when that lead is live,
  else `--no-parent`, and a pinned model with the agent's own flag. Attach moves the labels of a
  pane that is already running, after checking that a Claude session runs in the bot's project.
  Refusals say why.
- **Pane labels** (`launchArgs.js` `paneLabels`): Start and Attach set `bot=<id>`, `role=` (`main`
  for the main bot, `captain` for a member that leads others, else the bot's `rank`) and
  `category=<id>`; `squad=` is never overwritten, and a pane without one copies its lead's. An
  edit relabels the changed bots' live panes on this computer (`bots.js`); a pane hc wouldn't
  label, or a bot whose panes couldn't be checked, is named in one notice. Detach (CLI) takes
  off only what it set.
- **Create / Edit / Attach picker / bot list** (`create.js`, `formModel.js`) open as a dialog or
  popup (`props.form`: `create` | `edit` | `attach` | `pick` | `menu`), drawn to the approved
  mockup: live character preview, look, name and sidebar preview on the left; role, instructions,
  agent and model (detected, or pinned from the agent's list), place in the team and planned on
  the right; the matching `am create …` / `edit …` line in the footer, with Copy.
- **Briefing** (`briefing.mjs`, `briefingText.mjs`): Claude Code runs it on `UserPromptSubmit` from
  the per-person hook Start and Attach write into the session's `.claude/settings.local.json`; it
  prints the bot's own name, kind and instructions, then the state of the team above and below it.
  Fail-open: it prints nothing and exits 0 unless the terminal carries a `bot` label the project
  defines.
- **Updates** (`updateCheck.js`, with `update.mjs` and `release.js`): 20 seconds after load, then
  every 4 hours, `node update.mjs check --mods <app home>/mods` (node on PATH, else Homebrew's)
  asks GitHub for the latest release; a newer one gets one notice per version (shared
  `am.sidebar.update-shown`) naming `am update`. A failed look is silent and
  retried in 30 minutes. `AUTOMAGIK_HERDR_NO_UPDATE=1` turns it off. **Install updates
  automatically** (`updater.js`; on unless `<app home>/automagik-herdr/auto-update.json` says
  `"auto": false`): a newer release from a check goes in through the same claim and `update.mjs
  apply --expect <v> --auto`, which reads the setting, the install record (`sequence=`, no link)
  and the rollback's `skip` again under its lock before any download. The new build posts
  "Automagik Herdr updated to X"; a failure posts once and retries 4 h, then 8 h, 16 h and 24 h
  after each failure, then daily. A release that moved on mid-install is no failure: the next
  check installs the newer one. One sidebar copy writes the status bar's switch (its request id).
- **Theme** (`theme.js`, `themes/`): the Automagik light and dark themes are copied into
  `<app home>/themes/` when absent and selected with `app.theme` once, recorded in shared
  `am.sidebar.theme-selected`; a theme picked later is never overridden.
  A theme file already in `<app home>/themes/` is never overwritten, so later releases never
  update it; a theme file the person deletes is copied back on the next load.
- **Pressing**: a space selects on click and reorders on drag (inside its machine); an agent or bot
  row focuses its pane; a bot row's right-click offers Edit, Start and Attach; an agent's offers
  "Attach as bot…"; the space's tile opens the icon dialog (below). **New bot** and
  **Bot settings** live in the footer's Bots tab (`am-footer`), which opens this mod's `create` and `pick` forms; the
  `pick` list with no bot yet shows one **New bot** line that opens the form. Commands: `am-sidebar.new-bot`, `edit`, `start`, `attach`, `refresh`.
- **Icon dialog** (`spaceIcon.js`, `spaceIconModel.js`, `emoji-data.js`; formerly the separate
  `space-icon` mod): the space's tile opens this mod again as a 440 × 520 dialog with props
  `{spaceIcon: <space id>}`, and `init` hands it to `SpaceIconDialog`, as it does the bot form.
  Three tabs. **Emoji**: a searchable grid of 1,741 emoji (Unicode's names, generated from
  `unicodedata`; 84 per page), a typed or pasted one (`Paste` reads the clipboard through
  `osascript`) — one emoji, no spaces or ASCII, at most twelve code points, so a flag or a joined
  family passes and a word does not. **Image**: drop or type a `.png` (square, 16–2048 px, ≤5 MB),
  a whole `.svg`, or an `.ico` converted to PNG with `sips`; kept as
  `<app home>/space-icons/<space>-<time>.<ext>`, and the file it replaces is deleted. Emoji and
  image apply and close. **Colour**: six palette swatches, `none` (transparent) or a hex, applied
  live with the dialog left open; it shows behind an emoji or the letter, an image covers it.
  `Use letter` removes the icon. Search is by Unicode name ("grinning", not "happy"); flags are not
  listed, paste one.
- **Paste**: `am-sidebar.paste` / `paste_image` put the clipboard into a terminal, sending it as
  a real PNG to another machine (`paste.js`, `clipboard-png.jxa`).
- **Names** for terminals that report no status come from `${appHome()}/sidebar-agents.json`.

## Built from

`main.js` (the column and its presses), `rows.js`, `characters.js` (21 Automagik characters, inks
and poses as SVG text), `model.js`, `models.js` (agents, their models and the flags that pin one),
`retired.js` (the retired agents and their replacements, the pack's one list; am-automations and
am-new-menu carry byte-equal copies),
`bots.js` (reading, writing and watching definitions, relabelling after an edit), `remoteFile.js`
(a linked machine's bots.json read and written through herdr-core, compare-and-swap), `create.js` +
`formModel.js` (the form and its rules), `launch.js` + `launchArgs.js` (Start, Attach, pane
labels), `briefing.mjs` + `briefingText.mjs`, `updateCheck.js` + `update.mjs` + `release.js`
(updates; `VERSION` is the installed version), `theme.js` + `themes/automagik-light.json` and
`automagik-dark.json`, `spaceIcon.js` + `spaceIconModel.js` + `emoji-data.js` (the icon dialog),
`argv.js`, `paste.js`, `clipboard-png.jxa`, `bin/automagik-herdr.mjs` (the
same rules from a terminal, through `hc`, plus `update`), `layouts/automagik.json` (Herdr's `main`
layout with the pack in place of `spaces` and `agents`), and `mod.json` (`place: none`, titled
"Automagik Sidebar"; the lineage is this file's and NOTICE's, not a `cloned_from`). Tests for every pure module live in the
repository's `test/`.

Herdr API: `spaces`, `machines`, `panes`, `agents`, `terminals`, `focused`, `run`, `openOverlay`,
`closeOverlay`, `exec`, `hc`, `theme`, `themes`, `settings`, `shared`, `setShared`, `watchFolder`,
`window`, `nextCommand`, `readTextFile`, `writeTextFile`, `pickFolder`, `appHome`, `home`,
`knownAgents`, `notify`, `props`, `setAgentOrder`; `fs/promises`. Programs: `git`, `sips` and
`osascript` (the icon dialog).

## Watch out

- **A linked machine's bots** (automagik#206): their file is written there through herdr-core
  (`remoteFile.js`) and their panes run there (`hc run --on`). The command is built on this
  computer from Herdr's agent table and `programs.json`, so an agent that needs other words
  gets them from an entry under `programs` in `<app home>/programs.json`, e.g. the Hermes TUI:
  `{"programs": {"hermes": {"run": ["hermes", "--tui"]}}}` (beside any entries already there).
  Attach-ledger rows for those panes keep the bare `tN`, `machine` and that machine's core id.
  A Claude bot started or restarted fresh there runs on a session id chosen here
  (`--session-id`), set as the pane's `agent.session` label, as on this computer: that label is
  the linked machine's own record of the seat's session.

- **It is a clone of Herdr's `spaces`**: Herdr's later changes don't reach it, and every modified
  file must stay marked as changed (see `NOTICE` here).
- **No cross-module imports in Herdr**: everything a view needs lives in this folder, which is why
  the bot model, the form rules and the CLI share modules here rather than across mods.
- **Its own files come first**: `bot` labels and `.herdr/bots.json`, not terminal parentage,
  decide who is a bot and whom it reports to; a terminal whose agent exits stays a bot row marked
  not running.
- **Placed by the layout only**: `mod.json` says `place: none`. A mod placed `left` that a layout
  also names is docked twice; use `layouts/automagik.json` (`layout.switch {"name":"automagik"}`
  after it is copied to `<app home>/layouts/`).
- **State**: shared `am.sidebar.icons` (space id → `{kind: "emoji", char}` or
  `{kind: "image", file}`; an older bare path reads as an image), `am.sidebar.projects`, `am.sidebar.update-shown`,
  `am.sidebar.theme-selected`, `am.space.colors` (space id → palette name, hex or `transparent`), `am.sidebar.collapsed`, `bots.defined` (whether this
  computer or an answering linked machine has a bot, for the footer's Bots popup); before the rename they had their old names
  (`migrate.js` SHARED_RENAMES lists each), copied to `am.*` once on load and left in place for one
  release (`migrate.js` SHARED_RENAMES). Outside the mod folder,
  so replacing it loses nothing: the rename map (`${appHome()}/sidebar-agents.json`), the CLI's
  project list (`am-sidebar-projects.json`, copied once from its name before the rename), the space icons (`space-icons/`), the copied
  themes, and the replaced pack kept for
  rollback (`<app home>/automagik-herdr/`).
- **Another machine's project** is read, never written; a live bot there is shown, not started.
- **This file and `preview.png`** are for people reading the repository; an installed copy
  ignores them.

## Done when

`herdr-app check mods/am-sidebar` passes; a project's `.herdr/bots.json` shows as a tree with
characters and statuses; Create writes an entry the CLI then lists; Start opens a pane carrying the
bot's labels; Attach ties an existing pane; a Claude bot receives its briefing before a turn; the
Automagik theme shows after the first load and a theme picked later stays; a space's tile opens
the icon dialog, a grid cell sets its emoji, a dropped SVG becomes its icon and `none` leaves the
tile transparent.
