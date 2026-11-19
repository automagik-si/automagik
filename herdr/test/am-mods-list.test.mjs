// The mod manager's list (mods/am-mods/core.js): which kind each folder is, what its VERSION,
// SOURCE and INSTALLED columns say, and the groups the panel draws — run against a scratch
// HERDR_APP_HOME shaped like an installed pack beside a person's own mods and Herdr's built-in ones.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as core from "../mods/am-mods/core.js";
import * as release from "../mods/am-sidebar/release.js";
import { linkedModsLine } from "../mods/am-sidebar/layoutSafe.mjs";
import { PACK_MODS, formatMarker, parseMarker } from "../mods/am-sidebar/release.js";

const io = {
  exec: async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
  },
  readText: async (path) => readFileSync(path, "utf8"),
  writeText: async (path, text) => writeFileSync(path, text),
};
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const INSTALLED = "2026-11-03T14:05:00.000Z";

/** A home with the pack (am-tabs switched off), a person's clone and folder, two built-in mods. */
function home(t, { marker = formatMarker({ version: "0.5.1", mods: [...PACK_MODS], layout: "added", installed: INSTALLED }) } = {}) {
  const appHome = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-list-")));
  t.after(() => rmSync(appHome, { recursive: true, force: true }));
  for (const m of PACK_MODS) {
    const dir = join(appHome, m === "am-tabs" ? "mods-disabled" : "mods", m);
    write(join(dir, "mod.json"), JSON.stringify({ place: "none", title: m }));
    write(join(dir, "main.js"), "");
  }
  write(join(appHome, "mods", "am-sidebar", "VERSION"), "0.5.1\n");
  write(join(appHome, "mods", "my-menu", "mod.json"), JSON.stringify({ place: "none", cloned_from: { name: "menu", version: "0.1.10" } }));
  write(join(appHome, "mods", "scratch", "mod.json"), "{}");
  for (const m of ["spaces", "workspace-chrome"]) write(join(appHome, "mods", m, "mod.json"), "{}");
  write(join(appHome, "installed.json"), JSON.stringify({ spaces: {}, "workspace-chrome": {} }));
  if (marker != null) write(join(appHome, core.PACK_MARKER), marker);
  return appHome;
}
const byName = (mods) => Object.fromEntries(mods.map((m) => [m.name, m]));

test("parsePackMarker reads version, mods and installed= as release.js parseMarker does", () => {
  const texts = [
    formatMarker({ version: "0.5.1", mods: [...PACK_MODS], layout: "added", installed: INSTALLED, usagemeter: "0.2.0" }),
    "version=0.5.1\nmods=am-mods,am-sidebar\nlayout=added\nbefore=none\nusagemeter=0.2.0\n",
    "version=0.3.0\nmods=\nbefore=none\n",
    "version=0.2.2\nbefore=none\n",
    "version=0.5.1\nmods=am-mods\ninstalled=yesterday\n",
  ];
  for (const text of texts) {
    const a = parseMarker(text);
    assert.deepEqual(core.parsePackMarker(text), { version: a.version, mods: a.mods, installed: a.installed }, text);
  }
  assert.equal(parseMarker(texts[0]).installed, INSTALLED);
  assert.equal(core.parsePackMarker(null), null);
});

test("formatMarker keeps installed= before usagemeter=, where install.sh's rewrite leaves it", () => {
  const text = formatMarker({ version: "1.0.0", mods: ["am-mods"], installed: INSTALLED, usagemeter: "0.2.0" });
  assert.equal(text, `version=1.0.0\nmods=am-mods\nbefore=none\ninstalled=${INSTALLED}\nusagemeter=0.2.0\n`);
  assert.equal(parseMarker(formatMarker(parseMarker(text))).installed, INSTALLED);
  assert.doesNotMatch(formatMarker({ version: "1.0.0", mods: [] }), /installed=/);
});

test("the pack's folders are one kind: Automagik Herdr, the pack's version, its install date, automagik-herdr", async (t) => {
  const appHome = home(t);
  const mods = byName(await core.listMods(io, { appHome, records: [] }));
  for (const m of PACK_MODS) {
    assert.equal(mods[m].kind, "pack", m);
    // The catalog may list a pack mod (the pack's own entry): it never turns it into "catalog".
    const d = core.describeMod(mods[m], { fullName: "automagik-dev/automagik-herdr", headCommit: null, stars: 3 });
    assert.deepEqual([d.kind, d.version, d.source, d.installed], ["pack", "0.5.1", "automagik-herdr", "2026-11-03"], m);
    assert.equal(d.label, m === "am-tabs" ? "off" : "Automagik Herdr", m);
  }
  assert.equal(mods["am-tabs"].enabled, false, "switched off, still the pack's");
  assert.equal(mods["my-menu"].kind, "clone", "a person's own mod.clone keeps its lineage");
  assert.deepEqual(
    [core.describeMod(mods["my-menu"]).version, core.describeMod(mods["my-menu"]).label],
    ["from menu v0.1.10", "clone"],
  );
  assert.equal(mods.scratch.kind, "local");
  assert.deepEqual(core.describeMod(mods.scratch, { fullName: "someone/scratch", path: "mods/scratch", headCommit: "abcdef1234", stars: 7 }),
    { kind: "catalog", label: "catalog", version: "upstream abcdef1", source: "someone/scratch/mods/scratch ★7", installed: "—",
      origin: { fullName: "someone/scratch", path: "mods/scratch", headCommit: "abcdef1234", stars: 7 } });
  assert.deepEqual([mods.spaces.kind, core.describeMod(mods.spaces).label, core.describeMod(mods.spaces).source], ["herdr", "built-in", "Herdr"]);
});

test("the pack's own mod.json files carry no cloned_from (the lineage is in RECIPE.md / NOTICE)", () => {
  for (const m of PACK_MODS) {
    const meta = JSON.parse(readFileSync(new URL(`../mods/${m}/mod.json`, import.meta.url), "utf8"));
    assert.equal(meta.cloned_from, undefined, m);
  }
});

test("only folders the marker lists are the pack's; without a marker a pack-named folder is the person's", async (t) => {
  const partial = home(t, { marker: formatMarker({ version: "0.5.1", mods: ["am-sidebar", "am-mods"], installed: INSTALLED }) });
  const mods = byName(await core.listMods(io, { appHome: partial, records: [] }));
  assert.deepEqual(PACK_MODS.filter((m) => mods[m].kind === "pack"), ["am-mods", "am-sidebar"]);
  assert.equal(mods["am-footer"].kind, "local", "left alone by the installer: not the pack's");
  const none = byName(await core.listMods(io, { appHome: home(t, { marker: null }), records: [] }));
  assert.ok(PACK_MODS.every((m) => none[m].kind !== "pack"));
});

// #219: the installer and the updater put plain folders under the pack's names and leave a link
// alone, so a link there (a checkout) is the person's: never listed as the pack's, on or off.
test("a link under a pack mod's name is the person's, not the pack's, in mods/ and in mods-disabled/ (#219)", async (t) => {
  const appHome = home(t);
  const ext = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-checkout-")));
  t.after(() => rmSync(ext, { recursive: true, force: true }));
  for (const [m, dir] of [["am-sidebar", "mods"], ["am-tabs", "mods-disabled"]]) {
    renameSync(join(appHome, dir, m), join(ext, m));
    symlinkSync(join(ext, m), join(appHome, dir, m));
  }
  const mods = byName(await core.listMods(io, { appHome, records: [] }));
  for (const m of ["am-sidebar", "am-tabs"]) {
    assert.deepEqual([mods[m].kind, mods[m].pack, mods[m].symlink], ["local", null, true], m);
    assert.notEqual(core.describeMod(mods[m]).source, core.PACK_SOURCE, m);
  }
  assert.equal(mods["am-tabs"].enabled, false);
  // The pack's plain folders beside them are still the pack's.
  assert.deepEqual(PACK_MODS.filter((m) => mods[m].kind === "pack"), PACK_MODS.filter((m) => !["am-sidebar", "am-tabs"].includes(m)));
  const { groups } = core.groupMods(Object.values(mods));
  assert.ok(groups.find((g) => g.key === "yours").mods.some((m) => m.name === "am-sidebar"), "listed under Yours");
});

// #219 case 2: x removed the pack's folder but the marker kept the name, so a folder of the
// person's put there still showed as the pack's and u replaced it (moving it to the rollback set).
// The record is the marker both the manager and the pack's update read, so x drops the name once.
test("packMarkerWithout drops one name from mods= and leaves every other line and value as it was (#219)", () => {
  const text = formatMarker({ version: "0.5.1", mods: [...PACK_MODS], layout: "added", installed: INSTALLED, usagemeter: "0.2.0" });
  const next = core.packMarkerWithout(text, "am-footer");
  assert.deepEqual(core.parsePackMarker(next), { ...core.parsePackMarker(text), mods: PACK_MODS.filter((m) => m !== "am-footer") });
  assert.equal(next, text.replace(`mods=${PACK_MODS.join(",")}`, `mods=${PACK_MODS.filter((m) => m !== "am-footer").join(",")}`));
  assert.deepEqual(parseMarker(next), { ...parseMarker(text), mods: PACK_MODS.filter((m) => m !== "am-footer") }, "the pack's own parser still reads it");
  assert.equal(core.packMarkerWithout(next, "am-footer"), null, "already gone");
  assert.equal(core.packMarkerWithout("version=0.2.2\nbefore=none\n", "spaces-agents"), null, "a v1 marker has no mods= line");
  assert.match(core.packMarkerWithout(formatMarker({ version: "1.0.0", mods: ["am-mods"] }), "am-mods"), /^mods=$/m, "the last one leaves an empty line, not no line");
});

test("x on a pack mod forgets it in the pack's record: the person's folder at that name is theirs (#219)", async (t) => {
  const appHome = home(t);
  await core.removeLocal(io, { appHome, name: "am-footer", symlink: false, path: "mods/am-footer" });
  const record = parseMarker(readFileSync(join(appHome, core.PACK_MARKER), "utf8"));
  assert.deepEqual(record.mods, PACK_MODS.filter((m) => m !== "am-footer"));
  assert.deepEqual([record.version, record.layout, record.installed], ["0.5.1", "added", INSTALLED], "every other field stays");
  // The person puts their own folder at the same name.
  write(join(appHome, "mods", "am-footer", "mod.json"), JSON.stringify({ title: "mine" }));
  const mods = byName(await core.listMods(io, { appHome, records: [] }));
  assert.deepEqual([mods["am-footer"].kind, mods["am-footer"].pack, mods["am-footer"].symlink], ["local", null, false]);
  assert.equal(mods["am-sidebar"].kind, "pack", "the rest of the pack is still the pack's");
});

test("x on a link under a pack name unlinks it and leaves the pack's record alone (#219)", async (t) => {
  const appHome = home(t);
  const ext = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-checkout-")));
  t.after(() => rmSync(ext, { recursive: true, force: true }));
  renameSync(join(appHome, "mods", "am-footer"), join(ext, "am-footer"));
  symlinkSync(join(ext, "am-footer"), join(appHome, "mods", "am-footer"));
  const before = readFileSync(join(appHome, core.PACK_MARKER), "utf8");
  await core.removeLocal(io, { appHome, name: "am-footer", symlink: true, path: "mods/am-footer" });
  assert.equal(readFileSync(join(appHome, core.PACK_MARKER), "utf8"), before, "a link was never the pack's");
  assert.ok(existsSync(join(ext, "am-footer", "mod.json")), "the folder it points to stays");
});

test("a marker from before installed= dates the install by the marker file; no version= reads VERSION",
  { skip: process.platform !== "darwin" && "stat -f %m is the macOS form" }, async (t) => {
    const appHome = home(t, { marker: "mods=am-mods,am-sidebar\nlayout=added\nbefore=none\n" });
    const at = new Date("2026-10-30T09:00:00Z");
    utimesSync(join(appHome, core.PACK_MARKER), at, at);
    const mods = byName(await core.listMods(io, { appHome, records: [] }));
    assert.deepEqual(mods["am-mods"].pack, { version: "0.5.1", installed: at.getTime() });
    assert.equal(core.describeMod(mods["am-mods"]).installed, "2026-10-30");
  });

test("groupMods: the pack, yours, then built-in folded to one row; the counts are the groups'", async (t) => {
  const appHome = home(t);
  const mods = await core.listMods(io, { appHome, records: [] });
  const folded = core.groupMods(mods);
  assert.deepEqual(folded.groups.map((g) => [g.key, g.title, g.mods.length, g.folded]),
    [["pack", "Automagik Herdr 0.5.1", PACK_MODS.length, false], ["yours", "Yours", 2, false], ["herdr", "Herdr built-in", 2, true]]);
  assert.deepEqual(folded.counts, [`${PACK_MODS.length} Automagik Herdr`, "2 yours", "2 built-in", "1 off"]);
  // Heading, every pack mod, heading, 2 of yours, one built-in row (the heading, selectable).
  assert.equal(folded.rows.length, 1 + PACK_MODS.length + 1 + 2 + 1);
  assert.deepEqual(folded.rows.filter((r) => r.group).map((r) => [r.group.key, r.selectable]), [["pack", false], ["yours", false], ["herdr", true]]);
  assert.ok(folded.rows.every((r) => !r.mod || r.mod.kind !== "herdr"));
  assert.equal(folded.rows.at(-1).group.key, "herdr");
  const open = core.groupMods(mods, { builtInOpen: true });
  assert.deepEqual(open.rows.slice(-3).map((r) => r.group?.key ?? r.mod.name), ["herdr", "spaces", "workspace-chrome"]);
  assert.deepEqual(open.counts, folded.counts);
  // An empty group is not drawn; a home without the pack starts with Yours.
  const bare = core.groupMods(mods.filter((m) => m.kind !== "pack"));
  assert.deepEqual(bare.groups.map((g) => g.key), ["yours", "herdr"]);
  assert.deepEqual(bare.counts, ["2 yours", "2 built-in"], "no count for a group that is not drawn");
});

// #305: Herdr drops a layout whose block names a mod missing from mods/, so the switch reads what
// the stock layout names. The tree is the repo's own herdr-layout file, never an app home's.
const STOCK_LAYOUT = JSON.parse(readFileSync(new URL("../../herdr-layout/layouts/automagik.json", import.meta.url), "utf8"));

test("layoutNeeds: the stock layout's blocks (header and floating ones too) and its right-click menu", () => {
  const { blocks, menu } = core.layoutNeeds(STOCK_LAYOUT);
  assert.deepEqual([...blocks].sort(), ["am-footer", "am-sidebar", "am-status", "am-tabs", "changes", "files", "pane", "workspace-chrome"]);
  assert.equal(menu, "am-markdown");
  const floating = { id: "root", children: [{ id: "a", floating: [{ id: "f", content: { mod: "float-mod" } }] }] };
  assert.deepEqual([...core.layoutNeeds(floating).blocks], ["float-mod"]);
  assert.deepEqual(core.layoutNeeds(null), { blocks: new Set(), menu: null });
  assert.deepEqual(core.layoutNeeds({}), { blocks: new Set(), menu: null });
});

test("layoutGuard: a block's mod is refused with the layout's name; the menu's only noted; others pass", () => {
  for (const mod of ["am-sidebar", "am-footer", "am-tabs", "am-status"]) {
    const g = core.layoutGuard({ name: "automagik", tree: STOCK_LAYOUT, mod });
    assert.match(g?.refuse ?? "", new RegExp(`^${mod} stays on: the automagik layout shows it`));
    assert.match(g.refuse, /ctrl-shift-l/);
  }
  const menu = core.layoutGuard({ name: "automagik", tree: STOCK_LAYOUT, mod: "am-markdown" });
  assert.equal(menu?.refuse, undefined);
  assert.match(menu?.note ?? "", /the automagik layout's right-click menu/);
  for (const mod of ["am-quota", "am-automations", "am-new-menu", "scratch"]) {
    assert.equal(core.layoutGuard({ name: "automagik", tree: STOCK_LAYOUT, mod }), null, mod);
  }
  assert.match(core.layoutGuard({ tree: STOCK_LAYOUT, mod: "am-tabs" }).refuse, /the shown layout shows it/);
  assert.equal(core.layoutGuard({ name: "main", tree: {}, mod: "am-sidebar" }), null, "no tree: nothing to guard");
});

// #414: `am uninstall herdr.<mod>` (parts.mjs) asks with release.js's copy, since the pack's entries
// never load another mod's files: both functions byte for byte as the mod manager's.
// #430: `am uninstall herdr.layout` asks with release.js's packageLayoutGuard the same way.
test("layoutNeeds, layoutGuard and packageLayoutGuard: release.js's copies are core.js's, byte for byte", () => {
  assert.equal(String(release.layoutNeeds), String(core.layoutNeeds));
  assert.equal(String(release.layoutGuard), String(core.layoutGuard));
  assert.equal(String(release.packageLayoutGuard), String(core.packageLayoutGuard));
});

test("layoutGuard: `then` names what follows the switch; off is the default", () => {
  const off = core.layoutGuard({ name: "automagik", tree: STOCK_LAYOUT, mod: "am-footer" }).refuse;
  assert.match(off, /Switch layouts first \(ctrl-shift-l\), then turn it off$/);
  for (const then of ["remove it", "uninstall it"]) {
    const g = core.layoutGuard({ name: "automagik", tree: STOCK_LAYOUT, mod: "am-footer", then });
    assert.equal(g.refuse, off.replace(/turn it off$/, then));
  }
});

test("packageLayoutGuard: the package's own layout that Herdr shows is refused; any other passes", () => {
  const g = core.packageLayoutGuard({ name: "Mine", layouts: ["other.json", "mine.json"] });
  assert.match(g.refuse, /^the Mine layout is this package's \(layouts\/mine\.json\) and Herdr shows it: .*then remove it$/);
  assert.equal(core.packageLayoutGuard({ name: "automagik", layouts: ["mine.json"] }), null);
  assert.equal(core.packageLayoutGuard({ name: null, layouts: ["mine.json"] }), null, "no layout shown: nothing to guard");
  assert.equal(core.packageLayoutGuard({ name: "mine", layouts: undefined }), null, "a record with no layouts");
  // `then` names what follows the switch; remove is the default (the mod manager's).
  const un = core.packageLayoutGuard({ name: "Mine", layouts: ["mine.json"], then: "uninstall it" }).refuse;
  assert.equal(un, g.refuse.replace(/remove it$/, "uninstall it"));
});

// #491: with no shown layout to read the remove goes on (fail open) and says why, naming the
// package, every mod and own layout it moved aside, and the layouts naming those mods.
test("packageRemoveLines: no name from Herdr says why, the package, its mods and layouts; a name read says nothing", () => {
  const record = { source: "someone/tools", prefix: "pkgs/scratch", mods: ["scratch", "pane"], layouts: ["scratchy.json"], keys: [] };
  const naming = { scratch: ["scratchy", "work"], pane: ["scratchy"] };
  for (const shown of [undefined, null, ""]) {
    assert.deepEqual(core.packageRemoveLines({ record, shown, moved: ["mods/scratch", "mods/pane", "layouts/scratchy.json"], naming }), [
      "removed the package someone/tools/pkgs/scratch without knowing the layout Herdr shows (no layout from Herdr, so the remove"
      + " could not check it; is Herdr running?): moved mods/scratch, mods/pane, layouts/scratchy.json to the backup folder;"
      + " the layouts scratchy, work name scratch; the scratchy layout names pane. If Herdr shows the package's layout or one"
      + " naming its mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)",
    ], String(shown));
  }
  // No layout names its mods (or none parses): the reason, the package and what moved are still said.
  assert.deepEqual(core.packageRemoveLines({ record: { source: "someone/scratch", prefix: "", mods: ["scratch"], layouts: [] }, shown: null, moved: ["mods/scratch"] }), [
    "removed the package someone/scratch without knowing the layout Herdr shows (no layout from Herdr, so the remove could not"
    + " check it; is Herdr running?): moved mods/scratch to the backup folder. If Herdr shows the package's layout or one naming"
    + " its mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)",
  ]);
  // A name and a tree read: the guards checked both, nothing to say.
  assert.deepEqual(core.packageRemoveLines({ record, shown: "automagik", tree: STOCK_LAYOUT, moved: ["mods/scratch"], naming }), []);
});

// ---- #512: the guards decide on the shown layout's tree; a name alone reads it from layouts/ ----

const NAMES_SCRATCH = { id: "root", children: [{ id: "p", content: { mod: "scratch" } }] };

test("shownLayout: Herdr's tree as given; a name alone reads layouts/<name>.json; why when that gives none (#512)", async (t) => {
  const appHome = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-shown-")));
  t.after(() => rmSync(appHome, { recursive: true, force: true }));
  write(join(appHome, "layouts", "work.json"), JSON.stringify(NAMES_SCRATCH));
  write(join(appHome, "layouts", "broken.json"), `${JSON.stringify(NAMES_SCRATCH)},`);
  write(join(appHome, "layouts", "empty.json"), "{}");
  const nullIo = { ...io, readText: async (path) => (existsSync(path) ? readFileSync(path, "utf8") : null) };
  for (const use of [io, nullIo]) {
    const shown = (given) => core.shownLayout(use, appHome, given);
    // A tree from Herdr is the tree, named or not; the file is not read.
    assert.deepEqual(await shown({ name: "broken", tree: NAMES_SCRATCH }), { name: "broken", tree: NAMES_SCRATCH, unread: null });
    assert.deepEqual(await shown({ name: null, tree: NAMES_SCRATCH }), { name: null, tree: NAMES_SCRATCH, unread: null });
    // Nothing from Herdr (`layout()` gives nothing, or an empty object): not checked.
    for (const tree of [undefined, null, {}]) assert.deepEqual(await shown({ name: "", tree }), { name: null, tree: null, unread: null });
    assert.deepEqual(await core.shownLayout(use, appHome), { name: null, tree: null, unread: null });
    // The name alone: the tree is the file's.
    assert.deepEqual(await shown({ name: "work", tree: {} }), { name: "work", tree: NAMES_SCRATCH, unread: null });
    // Checked, and unreadable: each says why.
    assert.deepEqual(await shown({ name: "broken", tree: null }), { name: "broken", tree: null,
      unread: "Herdr shows the broken layout but gave no tree, and layouts/broken.json does not read" });
    assert.equal((await shown({ name: "empty" })).unread, "Herdr shows the empty layout but gave no tree, and layouts/empty.json does not read");
    assert.deepEqual(await shown({ name: "gone", tree: {} }), { name: "gone", tree: null,
      unread: "Herdr shows the gone layout but gave no tree, and layouts/gone.json could not be read" });
    assert.equal((await shown({ name: "../work" })).unread, "Herdr shows the ../work layout but gave no tree, and its name has a path, so no file in layouts/ was read");
  }
});

test("heldRetiredMods holds on the tree, whatever the name, as layoutGuard refuses; no tree holds nothing (#512)", () => {
  const record = { mods: ["scratch", "pane"], layouts: [] }, plan = { mods: ["other"], layouts: [] };
  for (const shown of [undefined, null, "", "scratchy"]) {
    assert.deepEqual(core.heldRetiredMods({ record, plan, shown, tree: NAMES_SCRATCH }), ["scratch"], String(shown));
    assert.match(core.layoutGuard({ name: shown, tree: NAMES_SCRATCH, mod: "scratch" }).refuse, /^scratch stays on/);
    for (const tree of [undefined, null, {}]) assert.deepEqual(core.heldRetiredMods({ record, plan, shown, tree }), [], String(shown));
  }
});

test("retiredModLines: held names the layout, or the shown one; unread and nothing from Herdr each say their reason (#512)", () => {
  const retired = ["scratch"], naming = { scratch: ["scratchy"] };
  const kept = (layout) => [`kept mods/scratch: this update no longer ships it, but ${layout} shows it, and Herdr drops a layout whose mod is gone`
    + " (plain Herdr instead). Switch layouts (ctrl-shift-l), and the next update moves it aside"];
  assert.deepEqual(core.retiredModLines({ retired, held: ["scratch"], shown: "scratchy", tree: NAMES_SCRATCH }), kept("the scratchy layout"));
  assert.deepEqual(core.retiredModLines({ retired, held: ["scratch"], shown: null, tree: NAMES_SCRATCH }), kept("the shown layout"));
  // A tree read that does not name it: it goes quietly, named or not.
  for (const shown of [null, "main"]) assert.deepEqual(core.retiredModLines({ retired, held: [], shown, tree: { id: "root" }, naming }), []);
  const moved = (why) => [`moved mods/scratch to the backup folder without knowing the layout Herdr shows (${why}):`
    + " this update no longer ships it; the scratchy layout names it, and Herdr drops a layout whose mod is gone (plain Herdr instead)"];
  // Not checked: nothing came from Herdr.
  for (const tree of [undefined, null, {}]) assert.deepEqual(core.retiredModLines({ retired, held: [], shown: null, tree, naming }), moved("no layout to read; is Herdr running?"));
  // Checked, and unreadable: a name with no tree to read is never silent, and never "is Herdr running?".
  const unread = "Herdr shows the work layout but gave no tree, and layouts/work.json does not read";
  assert.deepEqual(core.retiredModLines({ retired, held: [], shown: "work", tree: null, unread, naming }), moved(unread));
});

test("packageRemoveLines: the three reasons, and only what uninstall() moved (#512)", () => {
  const record = { source: "someone/scratch", prefix: "", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] };
  const moved = ["mods/scratch", "layouts/scratchy.json"];
  const tail = " If Herdr shows the package's layout or one naming its mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)";
  // Not checked.
  assert.deepEqual(core.packageRemoveLines({ record, shown: null, tree: {}, moved }), [
    "removed the package someone/scratch without knowing the layout Herdr shows (no layout from Herdr, so the remove could not check it;"
    + ` is Herdr running?): moved mods/scratch, layouts/scratchy.json to the backup folder.${tail}`]);
  // Checked, and unreadable: the name was checked, the tree was not.
  const unread = "Herdr shows the work layout but gave no tree, and layouts/work.json does not read";
  assert.deepEqual(core.packageRemoveLines({ record, shown: "work", tree: null, unread, moved, naming: { scratch: ["scratchy"] } }), [
    `removed the package someone/scratch without knowing the layout Herdr shows (${unread}, so the remove checked its name only):`
    + ` moved mods/scratch, layouts/scratchy.json to the backup folder; the scratchy layout names scratch.${tail}`]);
  // The tree checked, no name: only the package's own layout that moved may be the shown one.
  assert.deepEqual(core.packageRemoveLines({ record, shown: null, tree: { id: "root" }, moved }), [
    "removed the package someone/scratch without knowing the name of the layout Herdr shows (Herdr gave its tree, which the remove checked,"
    + " but not its name): moved mods/scratch, layouts/scratchy.json to the backup folder. If Herdr shows layouts/scratchy.json, Herdr drops it"
    + " (plain Herdr instead): switch layouts (ctrl-shift-l)"]);
  assert.deepEqual(core.packageRemoveLines({ record, shown: null, tree: { id: "root" }, moved: ["mods/scratch"] }), [], "no layout of its own moved: the tree said it all");
  // A record entry already gone from the disk is not claimed as moved.
  assert.match(core.packageRemoveLines({ record, shown: null, moved: ["mods/scratch"] })[0], /\): moved mods\/scratch to the backup folder\. If/);
  assert.match(core.packageRemoveLines({ record, shown: null, moved: [] })[0], /\): nothing of it was left to move\. If/);
});

test("uninstall returns what it moved: a record entry missing on disk is not in it, and no backup is claimed for it (#512)", async (t) => {
  const appHome = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-moved-")));
  t.after(() => rmSync(appHome, { recursive: true, force: true }));
  write(join(appHome, "mods", "scratch", "mod.json"), "{}");
  write(join(appHome, "layouts", "kept.json"), "{}");
  const record = { source: "someone/scratch", prefix: "", mods: ["scratch", "gone"], layouts: ["scratchy.json", "kept.json"], keys: [] };
  const { moved } = await core.uninstall(io, { appHome, record });
  assert.deepEqual(moved, ["mods/scratch", "layouts/kept.json"]);
  const backup = readdirSync(join(appHome, "automagik-herdr", "backup")).map((f) => f.replace(/-\d{4}-.*$/, "")).sort();
  assert.deepEqual(backup, ["kept.json", "scratch"], "the backup folder holds exactly what it says moved");
  const [line] = core.packageRemoveLines({ record, shown: null, moved });
  assert.match(line, /: moved mods\/scratch, layouts\/kept\.json to the backup folder\./);
  assert.doesNotMatch(line, /mods\/gone|scratchy\.json/);
});

// ---- #494: a linked mods/ is the person's folder: the manager moves nothing through it ----

/** The refusal's exact words, written out so a changed line fails here. */
const linkedLine = (mods, to) => `mods/ (${mods}) is a link to ${to}, your own folder, not one this install made: nothing is moved `
  + "through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again";

/** A scratch app home whose mods/ (scratch in it) is a link to a folder outside it, and scratchy.json. */
function linkedHome(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-linked-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appHome = join(root, "app"), ext = join(root, "their-mods");
  write(join(ext, "scratch", "mod.json"), "{}");
  write(join(appHome, "layouts", "scratchy.json"), "{}");
  symlinkSync(ext, join(appHome, "mods"));
  return { root, appHome, ext };
}

test("linkedModsLine: the mod manager's words are layoutSafe.mjs's, word for word (#494)", () => {
  assert.equal(core.linkedModsLine("/app/mods", "/elsewhere"), linkedLine("/app/mods", "/elsewhere"));
  assert.equal(core.linkedModsLine("/app/mods", "/elsewhere"), linkedModsLine("/app/mods", "/elsewhere"));
});

test("a package's remove and its update through a linked mods/ are refused with why; nothing moves (#494)", async (t) => {
  const h = linkedHome(t);
  const want = linkedLine(join(h.appHome, "mods"), h.ext);
  assert.equal(await core.linkedModsRefusal(io, h.appHome), want);
  const record = { source: "someone/scratch", prefix: "", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] };
  await assert.rejects(core.uninstall(io, { appHome: h.appHome, record }), (e) => e.message === want);
  const base = join(h.root, "repo");
  write(join(base, "mods", "scratch", "main.js"), "// v2\n");
  const plan = { clashes: [], mods: ["scratch"], layouts: [], keyAdds: [], keyConflicts: [], risks: [], base };
  await assert.rejects(core.applyInstall(io, { appHome: h.appHome, plan, source: "someone/scratch", prefix: "", sha: "abc", record }), (e) => e.message === want);
  assert.deepEqual(readdirSync(h.ext), ["scratch"]);
  assert.ok(existsSync(join(h.appHome, "layouts", "scratchy.json")));
  assert.equal(existsSync(join(h.appHome, "automagik-herdr")), false, "no backup or staging folder made");
  // A plain mods/ says nothing.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-plain-")));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  mkdirSync(join(plain, "mods"));
  assert.equal(await core.linkedModsRefusal(io, plain), null);
});

test("switching a mod back on through a linked mods/ is refused with why; it stays in mods-disabled/ (#494 review)", async (t) => {
  const h = linkedHome(t);
  write(join(h.appHome, "mods-disabled", "offmod", "mod.json"), "{}");
  await assert.rejects(core.setEnabled(io, { appHome: h.appHome, name: "offmod", enabled: true }), (e) => e.message === linkedLine(join(h.appHome, "mods"), h.ext));
  assert.ok(existsSync(join(h.appHome, "mods-disabled", "offmod", "mod.json")), "still off, where it was");
  assert.deepEqual(readdirSync(h.ext), ["scratch"], "nothing went into the linked mods/");
});

// ---- #511: a linked layouts/ is the person's folder: an update moves and writes no layout through it ----

test("an update through a linked layouts/ leaves the record's layout as it is and adds none; the mods update; said with why (#511)", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-linked-layouts-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appHome = join(root, "app"), ext = join(root, "their-layouts"), base = join(root, "repo");
  write(join(appHome, "mods", "scratch", "main.js"), "// v1\n");
  write(join(ext, "scratchy.json"), "{\"mine\":true}\n");
  symlinkSync(ext, join(appHome, "layouts"));
  assert.equal(await core.linkedLayouts(io, appHome), ext);
  write(join(base, "mods", "scratch", "main.js"), "// v2\n");
  write(join(base, "layouts", "scratchy.json"), "{\"theirs\":2}\n");
  write(join(base, "layouts", "extra.json"), "{}\n");
  const record = { source: "someone/scratch", prefix: "", mods: ["scratch"], layouts: ["scratchy.json"], keys: [] };
  const plan = { clashes: [], mods: ["scratch"], layouts: ["scratchy.json", "extra.json"], keyAdds: [], keyConflicts: [], risks: [], base };
  const rec = await core.applyInstall(io, { appHome, plan, source: "someone/scratch", prefix: "", sha: "abc", record, shown: "main", tree: {} });
  assert.equal(readFileSync(join(appHome, "mods", "scratch", "main.js"), "utf8"), "// v2\n", "the mod is updated");
  assert.deepEqual(readdirSync(ext), ["scratchy.json"], "nothing added to the person's folder, nothing taken out");
  assert.equal(readFileSync(join(ext, "scratchy.json"), "utf8"), "{\"mine\":true}\n");
  assert.deepEqual(rec.layouts, ["scratchy.json"], "the record keeps its layout, and not the one left out");
  assert.ok(!readdirSync(join(appHome, "automagik-herdr", "backup")).some((f) => f.startsWith("scratchy.json")), "no layout in the backup folder");
  assert.deepEqual(core.linkedLayoutsLines({ appHome, target: ext, record, plan }), [
    `layouts/ (${appHome}/layouts) is a link to ${ext}, your own folder, not one this install made: nothing is moved or written through it, so `
    + "layouts/scratchy.json stays as it is and layouts/extra.json was not added. Put that folder in the link's place (a plain layouts/), "
    + "then update again for this commit's layouts",
  ]);
  // A first install: the commit's layouts are left out, and the record lists none.
  write(join(base, "mods", "other", "main.js"), "// v1\n");
  const fresh = await core.applyInstall(io, { appHome, plan: { ...plan, mods: ["other"] }, source: "someone/other", prefix: "", sha: "abc", record: null });
  assert.deepEqual(fresh.layouts, []);
  assert.deepEqual(readdirSync(ext), ["scratchy.json"]);
  assert.match(core.linkedLayoutsLines({ appHome, target: ext, record: null, plan })[0], /so layouts\/scratchy\.json, layouts\/extra\.json were not added\. /);
  // A plain layouts/, or a package with no layout: nothing to say.
  assert.deepEqual(core.linkedLayoutsLines({ appHome, target: null, record, plan }), []);
  assert.deepEqual(core.linkedLayoutsLines({ appHome, target: ext, record: { ...record, layouts: [] }, plan: { ...plan, layouts: [] } }), []);
  assert.equal(await core.linkedLayouts(io, join(root, "repo")), null);
});
