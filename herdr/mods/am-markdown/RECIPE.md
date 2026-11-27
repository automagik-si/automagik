# am-markdown

Right-click in a terminal and, under Herdr's own items, the Markdown files that terminal's text
talks about; click one and it renders in a preview pane beside the chat. One mod, two faces.

Derived from Herdr's shipped `menu` 0.1.10, with the Markdown renderer from
[`ohneda/herdr-markdown-browser`](https://github.com/ohneda/herdr-markdown-browser) (MIT; the
verbatim notice is `LICENSE-upstream`).

## What you see

- **The terminal menu** (props `{tab, target}`, or opened by a key): Herdr's items unchanged (split,
  zoom, right-click routing, park, close), a divider, **Markdown in this terminal**, and up to
  twelve rows — file icon, path relative to the terminal's folder, `machine` for another machine's
  file. A popup 380 × 460, `popover` background, 12.8 px text, `selected` on the row under the
  pointer, ↑/↓ + Enter over both sections. Under the divider, one `dim` line when there is something
  to say: **Searching…** from the moment the menu opens until the search ends; **Pane is working /
  Pane is blocked / Pane has an error: only paths on screen** when the terminal gave its screen
  alone (below the rows, or alone when the screen names no file); **Could not read this terminal:
  …** with `hc read`'s own error; a failed check's message; **No Markdown files in this terminal**
  only after a whole read that named no file on disk.
- **The preview** (props `{file, on}`): a 32 px header with the file name (semibold), the full path
  in `dim` (`machine:path` for another machine's file) and, on this machine, a **Default app**
  button; the rendered Markdown at 14 px, 20 px side padding, scrollable and selectable;
  `Loading…` before the first read, `File not found` when the file is gone.

`mod.json` has `place: "none"`, so nothing is docked: every face is opened with props.

## How it behaves

- **Finding paths** (menu face): `hc read <terminal> --lines 600 --json`, then one regex over its
  `text` (`.md|.mdx|.markdown`), newest first. Each match is resolved against the terminal's live
  folder and then the repo's root (`git rev-parse --show-toplevel`); an absolute path as it is, and
  `~/` as printed, for the terminal's machine to expand.
- **A partial read**: `hc read --json` answers `complete: false` when it gives the screen alone
  (`why`: `working`, `blocked` or `error`; a full-screen app is not scrolled in those states). The
  screen's paths are still listed, with the note for that `why` (any other `why` reads "Pane was
  not fully read"). It is not read again when the pane stops: reopen the menu.
- **Keeping only real files**: one `sh -c` loop over every candidate, on the terminal's machine
  (`{ on }`): it expands `~/` with that machine's `$HOME` and prints `printed<TAB>resolved` for
  each one `[ -f ]` finds, so a fabricated path in prose never becomes a row and a row carries the
  resolved path. Doubles are dropped, twelve kept.
- **Errors are said**: `hc read` exiting non-zero shows its stderr, and a check that rejects shows
  its message, in place of "No Markdown files in this terminal".
- **Clicking one** opens the preview: the tab's existing preview switches in place through shared
  `am.markdown.slots` / `.show`, else a new pane splits to the right of the clicked pane and is
  recorded as its slot; a preview opened any other way (a shell's `pane.split`) is replaced by
  opening beside it, focusing, swapping left and closing it. A popup closes only once the work has
  started.
- **Reading and reloading** (preview face): the newest read wins (a slower, older one is dropped);
  local files are watched with `watchFolder`; another machine's are re-read every 3 s while their tab
  is shown.
- **Default app**: `sh -c realpath` first (refusing folders and `*.md` links to programs), then
  `open` / `rundll32` / `xdg-open`; `am-markdown.open` reaches every shown preview and the focused one
  acts.
- **Offered where**: a right-click on a terminal (props `{tab: "pane", target}`) or opened by a key
  (`mod.open:am-markdown`, which falls back to the focused terminal, else the tab's first terminal).

## The shared-state names

`am.markdown.slots`, `.show` and `.last` had the old Markdown browser's names before the
rename (`migrate.js` SHARED_RENAMES lists them): on load the mod copies an old value into an empty `am.*` key once
and leaves the old key in place for one release (`SHARED_OLD`; the rename migration in
am-sidebar/migrate.js lists every such key). Only this mod writes them — the menu when it opens or re-points a preview. A
preview opened by hand (`pane.split {mod: "am-markdown", props: {file}}`) carries no `slot` and writes
nothing; the menu simply opens beside it and takes its place when asked to.

## Built from

`main.js` (both faces, the pane bookkeeping), `marks.js` (regex, resolution, labels — no Herdr
import, so `node` can run it), `open.js` (the default-app check), `mod.json` (`place: "none"`,
popup 380 × 460), `LICENSE`, `LICENSE-upstream` (MIT). Herdr API: `props`, `run`, `panes`, `focused`,
`terminals`, `hc`, `exec`, `shared`, `setShared`, `notify`, `closeOverlay`, `openOverlay`,
`theme`, `keys`, `spaces`, `readTextFile`, `watchFolder`, `nextCommand`.
Layout: the shown layout's root needs `"terminal_menu": "am-markdown"`; previews are split as
`{mod: "am-markdown", props: {file, on}}`.

## Watch out

- **It replaces the terminal menu, it does not extend it** — a clone of the shipped one, so Herdr's
  later changes to `menu` don't reach it, and the renderer keeps its upstream fork distance
  (`.mdx` import/export stripping is line-based, not a parser). Re-clone/merge by hand when upstream
  moves.
- Paths with spaces are missed (the regex stops at whitespace); a fragment that still exists on disk
  is matched, anything else is dropped.
- `exec` has a time limit; `hc read` of 600 lines and one `sh` per open are cheap but not free: the
  first whole read of a full-screen app after it changes took about 3 s on another machine (#2041).
- While a pane is working, blocked or in error, a path that scrolled above its screen is not offered.
- Only rows the terminal printed are offered: it is not a file browser. The upstream file-list panel
  was dropped with the merge.
- `open` on Windows and Linux has never been exercised by this pack.

## Checked

`test/am-markdown-faces.test.mjs` (12 tests, a stub runtime) is criterion 1's committed check: a printed
`NOTES.md` becomes a row and a path that is not on disk stays hidden; a click splits a pane to the
right as `am-markdown` with a slot and records `slots`/`show`/`last`; a second click re-points that slot
in place. And the search (#2041): "Searching…" until it ends; a `complete: false` read lists the
screen's paths with the note for its `why` (`working`, `blocked`, `error`, none) and never says "No
Markdown files"; a failed `hc read` and a rejected check show their error; `~/` becomes the resolved
path, and for another machine's terminal the check is sent with `{ on }`. The in-app click-through on a scratch home belongs to Group 8's end-to-end run.

## Done when

`herdr-app check mods/am-markdown` passes; right-clicking a terminal that printed a `.md` path lists it;
clicking it opens (or switches) the preview in the tab; editing the file updates the pane within a
second; **Default app** opens it.
