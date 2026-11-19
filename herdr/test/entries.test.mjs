// scripts/entries.mjs: no herdr-mod entry folder holds layouts/ (herdr.dev skips the whole
// repository for one, RFC 0011).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { entryFolders, layoutEntryProblems, layoutsInEntries, layoutsInMods, problemsOf } from "../scripts/entries.mjs";

test("an entry folder is any folder holding mods/<name>/main.js; its layouts/ is refused", () => {
  const files = [
    "herdr/mods/am-sidebar/main.js", "herdr/mods/am-tabs/main.js", "herdr/install.sh",
    "herdr-layout/layouts/automagik.json", "herdr-layout/RECIPE.md", "herdr-layout/preview.png", "herdr-layout/part.json",
    "apps/x/mods/y/main.js", "apps/x/README.md",
    "mods/root/main.js",
    "docs/layouts/note.md",
  ];
  assert.deepEqual(entryFolders(files), ["", "apps/x", "herdr"]);
  assert.deepEqual(layoutsInEntries(files), [], "a layout folder of its own, and layouts/ outside an entry, are fine");
  assert.deepEqual(layoutsInEntries([...files, "herdr/layouts/automagik.json"]), ["herdr/layouts/"]);
  assert.deepEqual(layoutsInEntries([...files, "layouts/a.json", "apps/x/layouts/b.json"]), ["layouts/", "apps/x/layouts/"], "in entry-folder order: the root first");
  assert.deepEqual(layoutsInEntries(["mods/a/main.js", "mods/a/layouts/x.json"]), [], "a mod's own folder is not the entry's layouts/");
});

test("herdr/ must stay a mod entry with no layouts/; herdr-layout/ a layout entry in herdr.dev's shape", () => {
  const files = [
    "herdr/mods/am-sidebar/main.js", "herdr/RECIPE.md",
    "herdr-layout/layouts/automagik.json", "herdr-layout/RECIPE.md", "herdr-layout/preview.png", "herdr-layout/part.json",
  ];
  assert.deepEqual(problemsOf(files), [], "part.json at the layout entry's root is its manifest, not a layout");
  assert.match(problemsOf([...files, "herdr/layouts/automagik.json"]).join("\n"), /^herdr\/layouts\/: a herdr-mod entry folder holds layouts\//);
  assert.match(problemsOf(files.filter((f) => !f.startsWith("herdr/mods/"))).join("\n"), /^herdr\/: no mods\/<name>\/main\.js/);
  // The crawler probe's e2: no layouts/, so nothing to list; the root .json is named as the likely
  // layout, but not part.json or keys.json.
  const e2 = [...files, "herdr-layout/keys.json"].map((f) => f.replace("herdr-layout/layouts/", "herdr-layout/"));
  assert.deepEqual(layoutEntryProblems(e2), [
    "herdr-layout/layouts/<name>.json: missing; herdr.dev lists a layout only from its entry's layouts/",
    "herdr-layout/automagik.json: herdr.dev ignores a .json at the entry's root; move it to herdr-layout/layouts/",
  ]);
  // With layouts/<name>.json in place a root .json is ignored, as in 60 listed layout entries.
  assert.deepEqual(problemsOf([...files, "herdr-layout/keys.json", "herdr-layout/extra.json"]), []);
  // mods/ in the layout entry: one problem naming it, not "move the layout out of herdr-layout/".
  const withMods = [...files, "herdr-layout/mods/am-sidebar/main.js"];
  assert.deepEqual(problemsOf(withMods), [
    "herdr-layout/mods/: the layout entry keeps no mods of its own; the pack's mods are herdr/'s, which its RECIPE adds first, so remove this copy",
  ]);
  assert.deepEqual(layoutEntryProblems(files.filter((f) => !f.endsWith(".png"))), ["herdr-layout/preview.png: missing; a layout entry needs it"]);
  assert.deepEqual(layoutEntryProblems([...files, "herdr-layout/layouts/nested/x.json"]), [], "a layout of its own beside it is fine");
});

test("a mod's own layouts/ is refused once for each mod holding main.js", () => {
  const files = [
    "herdr/mods/x/main.js", "herdr/mods/x/layouts/a.json", "herdr/mods/x/layouts/b.json",
    "herdr/mods/nomain/layouts/a.json", "docs/layouts/x.md",
    "mods/r/main.js", "mods/r/layouts/a.json",
    "apps/x/mods/y/main.js", "apps/x/mods/y/layouts/a.json",
    "herdr-layout/examples/mods/m/main.js", "herdr-layout/examples/mods/m/layouts/a.json",
    "herdr-layout/layouts/automagik.json", "herdr-layout/RECIPE.md", "herdr-layout/preview.png",
  ];
  const dirs = ["apps/x/mods/y/layouts/", "herdr-layout/examples/mods/m/layouts/", "herdr/mods/x/layouts/", "mods/r/layouts/"];
  assert.deepEqual(layoutsInMods(files), dirs);
  assert.deepEqual(problemsOf(files), dirs.map((dir) => `${dir}: a mod keeps no layouts/ of its own; the pack's layout lives in herdr-layout/layouts/ (herdr.dev skips the whole repository when a herdr-mod entry folder holds layouts/), so move it there`));

  const pack = ["herdr/mods/x/main.js", "herdr-layout/layouts/automagik.json", "herdr-layout/RECIPE.md", "herdr-layout/preview.png"];
  assert.deepEqual(problemsOf([...pack, "mods/a/main.js", "mods/a/mods/b/main.js", "mods/a/layouts/a.json"]), [
    "mods/a/layouts/: a herdr-mod entry folder holds layouts/, and herdr.dev skips the whole repository for it; move the layout to its own top-level folder (herdr-layout/layouts/)",
  ]);
  assert.deepEqual(problemsOf([...pack, "herdr-layout/mods/m/main.js", "herdr-layout/mods/m/layouts/a.json"]), [
    "herdr-layout/mods/: the layout entry keeps no mods of its own; the pack's mods are herdr/'s, which its RECIPE adds first, so remove this copy",
  ]);
});

test("this repository: no herdr-mod entry folder holds layouts/", () => {
  const script = fileURLToPath(new URL("../scripts/entries.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no herdr-mod entry folder holds layouts\/: .*herdr; herdr-layout\/ is a layout entry/);
});
