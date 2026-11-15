// The mod manager's panel (mods/am-mods/main.js) drawn under the gpui and herdr stand-ins over a
// scratch HERDR_APP_HOME: the groups, the pack's row and detail line, the folded built-in row, and
// `u` on a pack mod running the pack's own `automagik-herdr update` (a fake command here).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const here = (f) => new URL(f, import.meta.url).href;
const stubs = { herdr: here("./footer-herdr.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
registerHooks({ resolve: (specifier, context, next) => (stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context)) });
const { state, ui } = await import(stubs.herdr);
const { default: ModManager } = await import("../mods/am-mods/main.js");
const { index, nodes, textOf } = await import(stubs["gpui-kit"]);
const { PACK_MODS, formatMarker } = await import("../mods/am-sidebar/release.js");
const core = await import("../mods/am-mods/core.js");

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const makeCx = () => {
  const cx = { pending: [], spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    timer: { after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) }, notify() {}, stop_propagation() {},
    focus_handle: () => ({ focus() {} }) };
  cx.settle = async () => { while (cx.pending.length) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
};

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-panel-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appHome = join(root, "app");
  for (const m of PACK_MODS) write(join(appHome, m === "am-tabs" ? "mods-disabled" : "mods", m, "mod.json"), "{}");
  write(join(appHome, "mods", "my-menu", "mod.json"), JSON.stringify({ cloned_from: { name: "menu", version: "0.1.10" } }));
  write(join(appHome, "mods", "scratch", "mod.json"), "{}");
  for (const m of ["spaces", "workspace-chrome"]) write(join(appHome, "mods", m, "mod.json"), "{}");
  write(join(appHome, "installed.json"), JSON.stringify({ spaces: {}, "workspace-chrome": {} }));
  write(join(appHome, core.PACK_MARKER), formatMarker({ version: "0.5.1", mods: [...PACK_MODS], installed: "2026-11-03T14:05:00.000Z" }));
  // The catalog lists a pack mod and one of the person's: a local file, never the network.
  const catalog = join(root, "index.json");
  write(catalog, JSON.stringify({ mods: [
    { name: "Automagik", fullName: "automagik-dev/automagik-herdr", modNames: ["am-mods", "am-tabs"], stars: 1 },
    { name: "Scratch", fullName: "someone/scratch", modNames: ["scratch"], headCommit: "abcdef1234", stars: 7 },
  ] }));
  write(join(appHome, "data", "am-mods", "catalog.json"), JSON.stringify({ url: catalog }));
  // A herdr-app that passes every check, and the pack's command, which records how it was called.
  const bin = join(root, "bin");
  write(join(bin, "herdr-app"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "herdr-app"), 0o755);
  const calls = join(root, "cli-calls");
  write(join(appHome, core.PACK_CLI), `#!/bin/sh\nprintf '%s %s\\n' "$HERDR_APP_HOME" "$*" >> '${calls}'\necho "Automagik Herdr 0.5.1 is installed; the latest release is 0.5.1. Up to date."\n`);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => { process.env.PATH = path; });
  state.appHome = appHome;
  state.shared.clear?.();
  ui.props = {};
  ui.layout = null;
  return { appHome, calls };
}

const key = async (view, cx, k, ch = k) => { view.onKey({ key: k, key_char: ch }, cx); await cx.settle(); };
const draw = (view, cx) => index(view.render(cx));
const select = (view, name) => { view.at = view.grouped().rows.findIndex((r) => r.mod?.name === name); };

test("the list: the pack as one group with its version, Yours, Herdr built-in folded; one language", async (t) => {
  scratch(t);
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  const text = textOf(draw(view, cx));
  assert.match(text, new RegExp(`${PACK_MODS.length} Automagik Herdr · 2 yours · 2 built-in · 1 off`));
  for (const head of ["ON", "NAME", "KIND", "CHECK", "VERSION", "SOURCE", "INSTALLED", "CHANGED"]) assert.match(text, new RegExp(`\\b${head}\\b`));
  assert.doesNotMatch(text, /\bPATH\b/, "the path is in the detail line, not an untitled column");
  assert.doesNotMatch(text, /seus|do Herdr|desligad|catálogo|atualiz|upstream \?|←/);
  assert.match(textOf(nodes.get("group-pack")), new RegExp(`Automagik Herdr 0\\.5\\.1 · ${PACK_MODS.length}`));
  assert.match(textOf(nodes.get("group-yours")), /Yours · 2/);
  assert.match(textOf(nodes.get("group-herdr")), /▸ Herdr built-in · 2 mods/);
  assert.equal(nodes.get("mod-spaces"), undefined, "built-in mods fold into one row");
  for (const m of PACK_MODS) {
    const row = textOf(nodes.get(`mod-${m}`));
    assert.match(row, m === "am-tabs" ? /\boff\b/ : /Automagik Herdr/, m);
    assert.match(row, /0\.5\.1 automagik-herdr 2026-11-03/, m);
  }
  assert.match(textOf(nodes.get("mod-scratch")), /catalog .*upstream abcdef1 someone\/scratch ★7/);
  assert.match(textOf(nodes.get("mod-my-menu")), /clone .*from menu v0\.1\.10/);

  select(view, "am-sidebar");
  assert.match(textOf(draw(view, cx)), /Automagik Herdr 0\.5\.1 · installed 2026-11-03 · u updates the pack/);
  // b unfolds the built-in group, wherever the cursor is; again folds it.
  await key(view, cx, "b");
  draw(view, cx);
  assert.match(textOf(nodes.get("mod-spaces")), /built-in .*Herdr/);
  assert.equal(view.selectedMod()?.name, "am-sidebar", "the cursor stays on its mod");
  await key(view, cx, "b");
  draw(view, cx);
  assert.equal(nodes.get("mod-spaces"), undefined);
  // The cursor skips the pack's and Yours's headings; the built-in heading takes it, enter unfolds.
  view.at = 0;
  view.clampAt();
  assert.equal(view.at, 1, "from the pack's heading to its first mod");
  view.step(-1);
  assert.equal(view.at, 1, "nothing selectable above it");
  view.at = view.grouped().rows.findIndex((r) => r.mod?.name === "am-tabs");
  view.step(1);
  assert.equal(view.selectedMod()?.name, "my-menu", "past the Yours heading");
  view.at = view.grouped().rows.length - 1;
  await key(view, cx, "enter");
  assert.ok(view.grouped().rows.some((r) => r.mod?.name === "spaces"));
});

test("u on a pack mod asks, then runs am update in this app home; no clone", async (t) => {
  const s = scratch(t);
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  select(view, "am-footer");
  await key(view, cx, "u");
  // #219: a switched-off pack mod is named before the yes: the update keeps it off, where it is.
  assert.equal(view.confirm?.text, `update Automagik Herdr (all ${PACK_MODS.length} of its mods; am-tabs is off and stays off, updated in mods-disabled/) with am update? (y/n)`);
  await key(view, cx, "y");
  await cx.settle();
  assert.equal(readFileSync(s.calls, "utf8"), `${s.appHome} update\n`);
  assert.match(view.message, /Up to date/);
  assert.ok(!state.calls.some((c) => c.kind === "exec" && c.command === "git"), "no per-mod clone");
  // u on the switched-off one asks the same; with every pack mod on, nothing is added; two off are both named.
  select(view, "am-tabs");
  await key(view, cx, "u");
  assert.match(view.confirm?.text ?? "", /; am-tabs is off and stays off, updated in mods-disabled\/\) with am update\?/);
  await key(view, cx, "n");
  await view.toggle(view.mods.find((m) => m.name === "am-tabs"), cx);
  await cx.settle();
  select(view, "am-footer");
  await key(view, cx, "u");
  assert.equal(view.confirm?.text, `update Automagik Herdr (all ${PACK_MODS.length} of its mods) with am update? (y/n)`);
  await key(view, cx, "n");
  for (const name of ["am-quota", "am-tabs"]) { await view.toggle(view.mods.find((m) => m.name === name), cx); await cx.settle(); }
  select(view, "am-footer");
  await key(view, cx, "u");
  assert.match(view.confirm?.text ?? "", /of its mods; am-quota, am-tabs are off and stay off, updated in mods-disabled\/\) with/);
  await key(view, cx, "n");
  // d on a pack mod says how the pack checks itself; it never clones to compare.
  await key(view, cx, "d");
  assert.match(view.message, /Automagik Herdr checks its own files/);
});

// #305: Herdr drops a layout whose block names a mod missing from mods/ ("needs mods that aren't
// here") and shows plain Herdr. The switch reads the shown layout (layout(), shared("layout")): the
// stock one here, from the repo, never an app home's.
const STOCK_LAYOUT = JSON.parse(readFileSync(new URL("../../herdr-layout/layouts/automagik.json", import.meta.url), "utf8"));
async function shownLayout(t) {
  const s = scratch(t);
  ui.layout = STOCK_LAYOUT;
  state.shared.set("layout", "automagik");
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  const flip = async (name) => { view.toggle(view.mods.find((m) => m.name === name), cx); await cx.settle(); };
  const on = (name) => existsSync(join(s.appHome, "mods", name, "mod.json"));
  const off = (name) => existsSync(join(s.appHome, core.OFF_DIR, name, "mod.json"));
  return { view, flip, on, off };
}

test("off on a mod the shown layout's blocks name is refused, naming the layout; the folder stays", async (t) => {
  const { view, flip, on, off } = await shownLayout(t);
  for (const name of ["am-sidebar", "am-footer", "am-status"]) {
    await flip(name);
    assert.ok(on(name) && !off(name), `${name} stays in mods/`);
    assert.match(view.message, new RegExp(`^${name} stays on: the automagik layout shows it`));
    assert.ok(view.mods.find((m) => m.name === name).enabled);
  }
});

test("off on a mod the shown layout doesn't name moves it as before", async (t) => {
  const { view, flip, on, off } = await shownLayout(t);
  for (const name of ["scratch", "am-quota"]) {
    await flip(name);
    assert.ok(!on(name) && off(name), `${name} moved to ${core.OFF_DIR}/`);
    assert.equal(view.message, `${name} off · its folder moved to ${core.OFF_DIR}/`);
  }
  await flip("scratch");
  assert.ok(on("scratch"), "and back on");
});

test("a mod the layout names that is already off turns on; the right-click menu's mod turns off with a note", async (t) => {
  const { view, flip, on, off } = await shownLayout(t);
  assert.ok(off("am-tabs"), "am-tabs starts off in this home");
  await flip("am-tabs");
  assert.ok(on("am-tabs") && !off("am-tabs"));
  assert.equal(view.message, "am-tabs on");
  // terminal_menu: Herdr warns and falls back to its own "menu", the layout stays.
  await flip("am-markdown");
  assert.ok(off("am-markdown"));
  assert.match(view.message, /^am-markdown off · its folder moved to mods-disabled\/ · it was the automagik layout's right-click menu: Herdr's own menu shows instead$/);
});

// #414: remove (x) asks the shown layout as off does, before its y/n question: a mod a block names
// stays where it is; the right-click menu's goes, with the note; the rest go as before.
const removeKey = async (view, cx, name) => { select(view, name); await key(view, cx, "x"); };

test("x on a mod the shown layout's blocks name is refused before the question; the folder stays", async (t) => {
  const { view, on } = await shownLayout(t);
  const cx = makeCx();
  for (const name of ["am-sidebar", "am-footer", "am-status"]) {
    await removeKey(view, cx, name);
    assert.equal(view.confirm, null, `${name}: no y/n question`);
    assert.match(view.message, new RegExp(`^${name} stays on: the automagik layout shows it`));
    assert.match(view.message, /Switch layouts first \(ctrl-shift-l\), then remove it$/);
    assert.ok(on(name), `${name} stays in mods/`);
  }
  // A layout switched while the question was open: remove() asks again.
  await removeKey(view, cx, "scratch");
  ui.layout = { id: "root", children: [{ id: "s", content: { mod: "scratch" } }] };
  state.shared.set("layout", "mine");
  await key(view, cx, "y");
  assert.match(view.message, /^scratch stays on: the mine layout shows it/);
  assert.ok(on("scratch"));
});

test("x on a mod the shown layout doesn't name removes it as before; the menu's mod goes with a note", async (t) => {
  const { view, on } = await shownLayout(t);
  const cx = makeCx();
  for (const name of ["scratch", "am-quota"]) {
    await removeKey(view, cx, name);
    assert.equal(view.confirm?.text, `remove the folder mods/${name}? (y/n)`);
    await key(view, cx, "y");
    assert.ok(!on(name), `${name} left mods/`);
    assert.equal(view.message, `removed: ${name}`);
  }
  // terminal_menu: Herdr warns and falls back to its own menu; the layout stays.
  await removeKey(view, cx, "am-markdown");
  await key(view, cx, "y");
  assert.ok(!on("am-markdown"));
  assert.equal(view.message, "removed: am-markdown · it was the automagik layout's right-click menu: Herdr's own menu shows instead");
  // A mod that is already off is not in the layout's way: am-tabs, a block of it, goes.
  await removeKey(view, cx, "am-tabs");
  assert.match(view.confirm?.text ?? "", /^remove /);
});

// #545: with no tree of the shown layout to check, a mod the manager did not install goes as before
// (fail open), and the panel says why, in the package paths' wording: never silently.
const LOCAL_AFTER = " If Herdr shows a layout naming it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)";

test("x with Herdr's layout name but no tree and no file to read removes, and says it could not check (#545)", async (t) => {
  const { view, on } = await shownLayout(t);
  ui.layout = null;
  const cx = makeCx();
  await removeKey(view, cx, "am-footer");
  await key(view, cx, "y");
  assert.ok(!on("am-footer"));
  assert.equal(view.message, "removed: am-footer · removed am-footer without knowing the layout Herdr shows (Herdr shows the automagik layout"
    + ` but gave no tree, and layouts/automagik.json could not be read, so the remove could not check it).${LOCAL_AFTER}`);
});

test("x on a local mod with no layout from Herdr removes it and the panel says why, with the layouts naming it (#545)", async (t) => {
  const s = scratch(t);
  const names = JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "scratch" } }] });
  write(join(s.appHome, "layouts", "scratchy.json"), names);
  write(join(s.appHome, "layouts", "work.json"), names);
  // A link to a folder of the person's, in mods/: only the link goes, and the same line is said.
  const theirs = join(dirname(s.appHome), "their-mod");
  write(join(theirs, "mod.json"), "{}");
  symlinkSync(theirs, join(s.appHome, "mods", "linked"));
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  const said = (name, which) => `removed ${name} without knowing the layout Herdr shows (no layout from Herdr, so the remove could not check it;`
    + ` is Herdr running?)${which}.${LOCAL_AFTER}`;
  await removeKey(view, cx, "scratch");
  assert.equal(view.confirm?.text, "remove the folder mods/scratch? (y/n)");
  await key(view, cx, "y");
  assert.ok(!existsSync(join(s.appHome, "mods", "scratch")));
  assert.equal(view.message, `removed: scratch · ${said("scratch", "; the layouts scratchy, work name it")}`);
  assert.ok(textOf(draw(view, cx)).includes(view.message), "the panel draws the line");
  await removeKey(view, cx, "linked");
  await key(view, cx, "y");
  assert.equal(view.message, `link linked removed (the folder it points to stays) · ${said("linked", "")}`);
  assert.ok(existsSync(join(theirs, "mod.json")));
  // A mod already off is in no layout's way: nothing to say of it.
  await removeKey(view, cx, "am-tabs");
  await key(view, cx, "y");
  assert.equal(view.message, "removed: am-tabs");
  // The pure line: a tree read says nothing; one layout naming it is worded in the singular.
  assert.deepEqual(core.localRemoveLines({ name: "scratch", tree: { id: "root" }, naming: { scratch: ["work"] } }), []);
  assert.deepEqual(core.localRemoveLines({ name: "scratch", tree: {}, naming: { scratch: ["work"] } }), [said("scratch", "; the work layout names it")]);
});

// #420: a package's remove moves its own layouts aside (core.uninstall), so one Herdr shows is
// refused before the question, as a block's mod is; once another layout shows, it goes as before.
test("x on a package whose own layout Herdr shows is refused before the question; the layout stays", async (t) => {
  const s = scratch(t);
  write(join(s.appHome, "layouts", "scratchy.json"), JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "pane" } }] }));
  state.shared.set("am.mods.installed", [{ source: "someone/scratch", prefix: "", sha: "abcdef1234", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] }]);
  ui.layout = { id: "root", children: [{ id: "p", content: { mod: "pane" } }] };
  state.shared.set("layout", "scratchy");
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  assert.ok(view.mods.find((m) => m.name === "scratch")?.record, "scratch is the package's");
  await removeKey(view, cx, "scratch");
  assert.equal(view.confirm, null, "no y/n question");
  assert.match(view.message, /^the scratchy layout is this package's \(layouts\/scratchy\.json\) and Herdr shows it: .*Switch layouts first \(ctrl-shift-l\), then remove it$/);
  assert.ok(existsSync(join(s.appHome, "layouts", "scratchy.json")) && existsSync(join(s.appHome, "mods", "scratch", "mod.json")));
  // Another layout shown: the package goes, its layout with it.
  state.shared.set("layout", "automagik");
  ui.layout = STOCK_LAYOUT;
  await removeKey(view, cx, "scratch");
  assert.match(view.confirm?.text ?? "", /^remove scratch and the keys it added\? \(y\/n\)$/);
  await key(view, cx, "y");
  await cx.settle();
  assert.ok(!existsSync(join(s.appHome, "layouts", "scratchy.json")) && !existsSync(join(s.appHome, "mods", "scratch")));
});

// #491: with no layout from Herdr (no name, no tree) nothing can be checked, so a package's remove
// goes on (fail open), and the panel's line says why, the package, what moved and which layouts name it.
test("x on a package with no layout from Herdr removes it and the panel says why, naming the package and its mods", async (t) => {
  const s = scratch(t);
  const names = JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "scratch" } }] });
  write(join(s.appHome, "layouts", "scratchy.json"), names);
  write(join(s.appHome, "layouts", "work.json"), names);
  write(join(s.appHome, "layouts", "broken.json"), `${names},`);
  state.shared.set("am.mods.installed", [{ source: "someone/scratch", prefix: "", sha: "abcdef1234", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] }]);
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  await removeKey(view, cx, "scratch");
  assert.equal(view.confirm?.text, "remove scratch and the keys it added? (y/n)");
  await key(view, cx, "y");
  assert.ok(!existsSync(join(s.appHome, "layouts", "scratchy.json")) && !existsSync(join(s.appHome, "mods", "scratch")));
  assert.equal(view.message, "removed: scratch · removed the package someone/scratch without knowing the layout Herdr shows"
    + " (no layout from Herdr, so the remove could not check it; is Herdr running?): moved mods/scratch, layouts/scratchy.json"
    + " to the backup folder; the layouts scratchy, work name scratch. If Herdr shows the package's layout or one naming its"
    + " mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)");
  // The line is the panel's: render() draws the message under the list.
  assert.ok(textOf(draw(view, cx)).includes(view.message), "the panel draws the line");
});

// #512: the remove decides on the shown layout's tree. Herdr's name alone reads the tree from
// layouts/<name>.json, so another shown layout naming the package's mod refuses; a tree alone is
// checked, and the line says so instead of "is Herdr running?".
async function packageHome(t, { name = null, tree = null, files = {} } = {}) {
  const s = scratch(t);
  for (const [f, body] of Object.entries(files)) write(join(s.appHome, "layouts", f), body);
  state.shared.set("am.mods.installed", [{ source: "someone/scratch", prefix: "", sha: "abcdef1234", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] }]);
  if (name) state.shared.set("layout", name);
  ui.layout = tree;
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  return { s, view, cx };
}
const NAMES_SCRATCH = JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "scratch" } }] });
const NAMES_PANE = JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "pane" } }] });

test("x on a package with Herdr's layout name but no tree: another shown layout naming its mod refuses, read from layouts/ (#512)", async (t) => {
  const { s, view, cx } = await packageHome(t, { name: "work", files: { "scratchy.json": NAMES_PANE, "work.json": NAMES_SCRATCH } });
  await removeKey(view, cx, "scratch");
  assert.equal(view.confirm, null, "no y/n question");
  assert.match(view.message, /^scratch stays on: the work layout shows it, and Herdr drops a layout whose mod is off .*then remove it$/);
  assert.ok(existsSync(join(s.appHome, "mods", "scratch", "mod.json")) && existsSync(join(s.appHome, "layouts", "scratchy.json")), "nothing moved");
  // The shown layout names none of its mods: it goes, with nothing to say (the tree was read from the file).
  write(join(s.appHome, "layouts", "work.json"), NAMES_PANE);
  await removeKey(view, cx, "scratch");
  await key(view, cx, "y");
  assert.equal(view.message, "removed: scratch");
  assert.ok(!existsSync(join(s.appHome, "mods", "scratch")));
});

test("x on a package with Herdr's layout name but a file that does not read: it goes on, said as checked and unreadable (#512)", async (t) => {
  const { s, view, cx } = await packageHome(t, { name: "work", files: { "scratchy.json": NAMES_SCRATCH, "work.json": `${NAMES_SCRATCH},` } });
  await removeKey(view, cx, "scratch");
  await key(view, cx, "y");
  assert.ok(!existsSync(join(s.appHome, "mods", "scratch")));
  assert.equal(view.message, "removed: scratch · removed the package someone/scratch without knowing the layout Herdr shows"
    + " (Herdr shows the work layout but gave no tree, and layouts/work.json does not read, so the remove checked its name only):"
    + " moved mods/scratch, layouts/scratchy.json to the backup folder; the scratchy layout names scratch. If Herdr shows the package's layout"
    + " or one naming its mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)");
  assert.doesNotMatch(view.message, /is Herdr running\?/);
});

test("x on a package with Herdr's tree but no name: the tree is checked, and the line says so, never \"is Herdr running?\" (#512)", async (t) => {
  // The tree names its mod: refused, as layoutGuard words a layout with no name.
  const named = await packageHome(t, { tree: JSON.parse(NAMES_SCRATCH), files: { "scratchy.json": NAMES_SCRATCH } });
  await removeKey(named.view, named.cx, "scratch");
  assert.equal(named.view.confirm, null);
  assert.match(named.view.message, /^scratch stays on: the shown layout shows it/);
  // The tree names none: it goes; its own layout may be the shown one, which only a name would tell.
  const { s, view, cx } = await packageHome(t, { tree: JSON.parse(NAMES_PANE), files: { "scratchy.json": NAMES_PANE } });
  await removeKey(view, cx, "scratch");
  await key(view, cx, "y");
  assert.ok(!existsSync(join(s.appHome, "mods", "scratch")));
  assert.equal(view.message, "removed: scratch · removed the package someone/scratch without knowing the name of the layout Herdr shows"
    + " (Herdr gave its tree, which the remove checked, but not its name): moved mods/scratch, layouts/scratchy.json to the backup folder."
    + " If Herdr shows layouts/scratchy.json, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)");
  // A record layout already gone from the disk: nothing is claimed for it, and nothing is left unknown.
  const gone = await packageHome(t, { tree: JSON.parse(NAMES_PANE) });
  await removeKey(gone.view, gone.cx, "scratch");
  await key(gone.view, gone.cx, "y");
  assert.equal(gone.view.message, "removed: scratch");
});

test("a linked mods/: the panel says why under the list, in the refusal's own words (#494)", async (t) => {
  const s = scratch(t);
  const ext = join(dirname(s.appHome), "their-mods");
  renameSync(join(s.appHome, "mods"), ext);
  symlinkSync(ext, join(s.appHome, "mods"));
  const cx = makeCx();
  const view = new ModManager();
  view.init({}, cx);
  await cx.settle();
  assert.equal(view.message, `mods/ (${join(s.appHome, "mods")}) is a link to ${ext}, your own folder, not one this install made: `
    + "nothing is moved through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again");
  assert.ok(textOf(draw(view, cx)).includes(view.message), "the panel draws the line");
  assert.ok(existsSync(join(ext, "scratch", "mod.json")), "nothing moved");
});
