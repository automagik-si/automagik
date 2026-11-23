// am-markdown: Herdr's terminal menu, this terminal's Markdown files, and the preview they open in.
// Two faces, chosen by props:
// - { tab: "pane" | "tab" | "space" | "global", target } (or nothing): the context menu, as a popup,
//   with the Markdown files the right-clicked terminal printed below Herdr's own items.
// - { file, on }: that file rendered in a pane, reloaded when it changes, with a button that hands
//   it to the system's default app (`on` = the machine it lives on, null for this one).
//
// The preview carries a `slot`, and shared `am.markdown.slots` / `.show` / `.last` (the merged Markdown panel's
// before the rename, copied over once) let the next file replace the current one in place instead of piling up panes. Only
// this mod writes them: a preview opened from a shell's own `pane.split` carries no slot.
// The menu face: Herdr's items (an item is [label, command, args]; "worktree" opens the worktree
// dialog), then the Markdown files this terminal's text shows, newest first. ↑/↓ move, Enter runs,
// Esc closes. Clicking a file opens it in a preview pane: the tab's preview switches in place, a
// new one splits to the right.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, hc, home, shared, setShared, notify, focused, nextCommand, readTextFile, watchFolder } from "herdr";
import { markdownCandidates, resolve, label } from "./marks.js";
import { openDefault } from "./open.js";


// The mod previews are opened into, and the shared state that lets a click switch an existing
// preview in place. Only this mod writes them; a preview split by hand carries no slot and writes nothing.
const PREVIEW = "am-markdown";
const SLOTS = "am.markdown.slots";
const SHOW = "am.markdown.show";
const LAST = "am.markdown.last";
// The rename shim (D12): the values from before the rename are copied over once on load, and the
// old keys stay (am-sidebar/migrate.js SHARED_RENAMES).
export const SHARED_OLD = Object.freeze({ "markdown-browser.slots": SLOTS, "markdown-browser.show": SHOW, "markdown-browser.last": LAST });
function carryShared() {
  for (const [old, now] of Object.entries(SHARED_OLD)) if (shared(now) == null && shared(old) != null) setShared(now, shared(old));
}
// Previews opened from the menu: { pane id: slot }, and what each slot shows now
// ({ slot: { file, on } }; without one, its props' file). External splits carry no slot.
const shown = (slot) => (slot && shared(SHOW)?.[slot]) || null;
const lastByTab = () => { const v = shared(LAST); return v && typeof v === "object" ? v : {}; };
// Front matter, and in MDX the top-level import/export lines (not inside a code fence): not prose.
function prose(text, file) {
  const s = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  if (!/\.mdx$/i.test(file)) return s;
  let fence = null;
  return s.split("\n").filter((line) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m && !fence) fence = m[1];
    else if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    else if (!fence && /^(import|export)\s/.test(line)) return false;
    return true;
  }).join("\n");
}

// How much of the terminal to read, and how many files to offer.
const LINES = 600;
const OFFER = 12;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}


export default class MdMenu extends View {
  init(_given, cx) {
    carryShared();
    if (props()?.file) return this.initPreview(cx);
    return this.initMenu(cx);
  }

  initMenu(cx) {
    this.at = 0;
    this.git = null;
    this.marks = [];
    this.note = null;
    this.searching = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });

    // The right-clicked pane, or the focused one when opened by a key. A mod pane (a preview) has
    // no terminal: then the tab's first terminal is what printed the paths.
    const tg = p?.tab === "pane" ? p.target ?? {} : {};
    const anchor = panes().find((x) => x.pane === tg.pane) ?? null;
    const pane =
      (anchor?.terminal ? anchor : null) ??
      panes().find((x) => x.focused && x.terminal) ??
      panes().find((x) => x.tab === (anchor?.tab ?? focused()?.tab) && x.terminal) ??
      null;
    const term = tg.terminal ?? pane?.terminal ?? null;
    this.origin = anchor?.pane ?? pane?.pane ?? null;
    this.tab = anchor?.tab ?? pane?.tab ?? focused()?.tab ?? null;
    if (term) {
      this.searching = true;
      cx.spawn(async (cx) => {
        await this.find(term, pane);
        this.searching = false;
        cx.notify();
      });
    } else this.note = "No terminal in this tab";
  }

  // The Markdown files this terminal's text shows, newest first, kept only if they exist.
  async find(term, pane) {
    try {
      const on = term.includes("/") ? term.split("/")[0] : null;
      const cwd = pane?.cwd ?? focused()?.cwd ?? null;
      const read = await hc(["read", term, "--lines", String(LINES), "--json"]);
      if (read?.code !== 0) return void (this.note = `Could not read this terminal: ${String(read?.stderr || `hc read exited ${read?.code}`).trim()}`);
      // `--json` says how the pane was read; text that is not JSON is taken as the text itself.
      let text = read.stdout ?? "", partial = false;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.text === "string") ({ text } = j), (partial = j.complete === false && j.why === "working");
      } catch {}
      if (!cwd) return void (this.note = "No folder for this terminal");
      // A path in output may be relative to the shell's folder or to the repo's root.
      const roots = [cwd];
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      const root = top?.code === 0 ? top.stdout.trim() : "";
      if (root && root !== cwd) roots.push(root);
      // `~/` stays as printed: the machine the terminal runs on expands it, in the check below.
      const args = [];
      for (const raw of markdownCandidates(text).reverse())
        for (const path of raw.startsWith("~/") ? [raw] : resolve(raw, roots, ""))
          if (path && !args.includes(path)) args.push(path);
      const hint = partial ? "Pane is working: only paths on screen" : null;
      if (!args.length) return void (this.note = hint ?? "No Markdown files in this terminal");
      // One process for every check, printing `printed<TAB>resolved` for the files that exist:
      // `[ -f ]` exits 1 when the last one isn't, so read stdout only.
      const seen = await exec(
        "sh",
        ["-c", 'for f do case "$f" in "~/"*) p="$HOME/${f#??}";; *) p=$f;; esac; [ -f "$p" ] && printf "%s\\t%s\\n" "$f" "$p"; done', "am-markdown", ...args.slice(0, 60)],
        { on },
      );
      const live = new Map();
      for (const line of (seen.stdout ?? "").split("\n")) {
        const [arg, path] = line.replace(/\r$/, "").split("\t");
        if (arg && path) live.set(arg, path);
      }
      const found = [];
      for (const arg of args) {
        const path = live.get(arg);
        if (path && !found.some((f) => f.path === path)) found.push({ path, rel: label(path, cwd) });
      }
      this.marks = found.slice(0, OFFER).map((f) => ({ ...f, on }));
      this.note = this.marks.length ? hint : hint ?? "No Markdown files in this terminal";
    } catch (e) {
      this.note = String(e?.message ?? e);
    }
  }

  // Menu items first, then the Markdown files; `at` walks both.
  rows() {
    return [...items(props(), this.git).map((it) => ({ cmd: it })), ...this.marks.map((md) => ({ md }))];
  }

  choose(i, cx) {
    const row = this.rows()[i];
    if (!row) return;
    if (row.md) return this.openMark(row.md, cx);
    const it = row.cmd;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  // A popup closes only once the work is started: closing it ends its tasks.
  openMark(mark, cx) {
    const overlay = props()?.overlay;
    cx.spawn(async (cx) => {
      await this.reveal(mark.path, mark.on, cx);
      closeOverlay(overlay);
    });
  }

  // Shows the file in the tab's preview, as a click in the old Markdown panel did: the tab's
  // preview switches in place when it was opened by a preview (a slot in shared state), else a
  // new pane splits to the right of the clicked one. run() doesn't wait, so each step is polled.
  async reveal(file, on, cx) {
    const tab = this.tab ?? focused()?.tab;
    const previews = panes().filter((x) => x.tab === tab && x.mod === PREVIEW);
    const last = (shared(LAST) ?? {})[tab];
    const old = previews.find((x) => x.focused) ?? previews.find((x) => x.pane === last) ?? previews[0] ?? null;
    const slot = old ? (shared(SLOTS) ?? {})[old.pane] : null;
    if (slot) {
      setShared(SHOW, { ...(shared(SHOW) ?? {}), [slot]: { file, on } });
      run("pane.focus", { pane: old.pane });
      return;
    }
    const before = new Set(panes().map((x) => x.pane));
    const fresh = { slot: Math.random().toString(36).slice(2, 10) + Date.now().toString(36) };
    const args = { direction: "right", mod: PREVIEW, props: { file, on, slot: fresh.slot } };
    const anchor = old?.pane ?? this.origin;
    if (anchor) args.pane = anchor;
    run("pane.split", args);
    const until = async (test) => {
      for (let i = 0; i < 40; i++) {
        if (test()) return true;
        await cx.sleep(25);
      }
      return false;
    };
    if (!(await until(() => (fresh.pane = panes().find((x) => !before.has(x.pane) && x.tab === tab && x.mod === PREVIEW)?.pane)))) {
      return notify({ title: "Can't open a preview", body: "The new pane didn't appear.", level: "error" });
    }
    // Record the new pane's slot, forgetting closed panes'.
    const alive = new Set(panes().map((x) => x.pane));
    const slots = Object.fromEntries(Object.entries(shared(SLOTS) ?? {}).filter(([pane]) => alive.has(pane)));
    slots[fresh.pane] = fresh.slot;
    const kept = new Set(Object.values(slots));
    setShared(SLOTS, slots);
    setShared(SHOW, { ...Object.fromEntries(Object.entries(shared(SHOW) ?? {}).filter(([s]) => kept.has(s))), [fresh.slot]: { file, on } });
    setShared(LAST, Object.fromEntries(Object.entries(shared(LAST) ?? {}).filter(([, pane]) => alive.has(pane))));
    // A preview this menu didn't open has no slot: the new one takes its place, since a closed
    // pane's room goes to the pane before it.
    if (!old) return;
    run("pane.focus", { pane: fresh.pane });
    if (!(await until(() => focused()?.pane === fresh.pane)))
      return notify({ title: "Couldn't replace the preview", body: "The old one is still open beside it.", level: "warning" });
    run("pane.swap", { direction: "left" });
    run("pane.close", { pane: old.pane });
  }

  renderMenu(cx) {
    const t = theme();
    const list = items(props(), this.git);
    const rows = this.rows();
    const commandRow = (it, i) =>
      v_flex()
        .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(
          h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))),
        );
    const markRow = (md, i) => {
      const at = list.length + i;
      return h_flex()
        .id(`mm-${i}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .justify_between()
        .text_color(t.foreground)
        .when(at === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(at, cx))
        .child(svg("mods/workspace-chrome/file-text.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(md.rel))
        .when(Boolean(md.on), (el) => el.child(div().text_size(11).text_color(t.dim).child(md.on)));
    };
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % Math.max(1, rows.length);
        else if (e.key === "up") this.at = (this.at + Math.max(1, rows.length) - 1) % Math.max(1, rows.length);
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children([
        ...list.map(commandRow),
        ...(this.marks.length
          ? [
              div().mx(7).my(4).h(1).bg(t.border),
              div().px(8).py(3).text_size(11).text_color(t.dim).child("Markdown in this terminal"),
              ...this.marks.map(markRow),
              ...(this.note ? [div().px(8).py(3).text_size(11).text_color(t.dim).child(this.note)] : []),
            ]
          : this.searching || this.note
            ? [div().mx(7).my(4).h(1).bg(t.border), div().px(8).py(3).text_size(11).text_color(t.dim).child(this.searching ? "Searching…" : this.note)]
            : []),
      ]);
  }


  initPreview(cx) {
    const { file, on } = props() ?? {};
    this.file = file ?? null;
    this.on = on ?? null;
    if (!this.file) return;

    // Opened from the list: its slot, which shared SHOW can point at another file.
    this.slot = props().slot ?? null;
    this.request = 0;
    this.text = null;
    this.show(shown(this.slot) ?? { file: this.file, on: this.on }, cx);
    // watchFolder only sees this machine: another's, look again every 3 s (one read at a time),
    // and not while its tab is in the background.
    cx.timer.every(3000, (cx) => {
      if (!this.on || this.reading) return;
      const me = panes().find((p) => p.pane === this.paneId());
      if (!me || me.tab === focused()?.tab) this.load(cx);
    });
    // "am-markdown.open" in keys.json: the default app. It reaches every shown copy; the focused one acts.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "open" && !this.on && this.isFocused()) this.openExternally();
      }
    });
  }

  // A pane doesn't know its id; the list recorded it for this copy's slot.
  paneId() {
    return this.slot ? Object.entries(shared(SLOTS) ?? {}).find(([, slot]) => slot === this.slot)?.[0] ?? null : null;
  }

  // Only a copy that knows its pane can tell it's the focused one.
  isFocused() {
    const pane = this.paneId();
    return Boolean(pane && panes().find((p) => p.pane === pane)?.focused);
  }

  // Show this file from now on, and watch it. The text shown before stays until the new one
  // is read, rather than a "Loading…" flash.
  show({ file, on }, cx) {
    this.file = file;
    this.on = on ?? null;
    this.error = null;
    this.load(cx);
    const watching = (this.watching = { file });
    if (this.on) return;
    const dir = file.replace(/[\\/][^\\/]*$/, "") || "/";
    cx.spawn(async (cx) => {
      while (this.watching === watching) {
        const changed = await watchFolder(dir);
        if (this.watching === watching && changed.includes(file)) this.load(cx);
      }
    });
  }

  // The newest read wins: a slower, older one (or one for the file shown before) is dropped.
  load(cx) {
    const request = ++this.request, file = this.file, on = this.on;
    this.reading = true;
    cx.spawn(async (cx) => {
      let text = null, error = null;
      try {
        text = await readTextFile(file, { on });
        if (text === null) error = "File not found";
      } catch (e) {
        error = String(e?.message ?? e);
      }
      if (request !== this.request || file !== this.file || on !== this.on) return;
      this.reading = false;
      if (error) {
        if (error === this.error) return;
        this.error = error;
      } else {
        if (text === this.text && file === this.textFile && !this.error) return;
        this.text = text;
        this.textFile = file;
        this.error = null;
      }
      cx.notify();
    });
  }

  // openDefault checks the file before it starts the app, so a link named *.md never runs.
  openExternally() {
    openDefault(this.file).then((why) => {
      if (why) notify({ title: "Can't open in the default app", body: why, level: "error" });
    });
  }

  renderPreview() {
    const t = theme();
    const name = this.file.split(/[\\/]/).pop();
    return v_flex().id("am-markdown").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(32).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().font_semibold().truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.on ? `${this.on}:${this.file}` : this.file))
        .when(!this.on, (el) => el.child(
          div().id("mb-open").flex_none().px(8).py(2).rounded(5).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.openExternally())
            .child("Default app"))))
      .child(this.error
        ? div().p(16).text_size(12.5).text_color(t.dim).child(this.error)
        : this.text === null
          ? div().p(16).text_size(12.5).text_color(t.dim).child("Loading…")
          : div().flex_1().min_h(0).px(20).py(14).text_size(14)
            .child(TextView.markdown(`md-body-${this.textFile}`, prose(this.text, this.textFile)).scrollable(true).selectable(true).size_full()));
  }

  // Which face this copy is.
  render(cx) {
    if (!props()?.file) return this.renderMenu(cx);
    const want = shown(this.slot);
    if (want && (want.file !== this.file || (want.on ?? null) !== this.on)) this.show(want, cx);
    const pane = this.paneId(), me = pane && panes().find((p) => p.pane === pane);
    if (me?.focused && lastByTab()[me.tab] !== pane) setShared(LAST, { ...lastByTab(), [me.tab]: pane });
    return this.renderPreview();
  }
}
