// The pack's other install path and its index, run as the person would against scratch folders:
// the mod manager's core.js (staged installs, linked state, the catalog's commit) and
// scripts/catalog.mjs (strict flags, --check). install.sh and update.mjs have their own tests.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../mods/am-mods/core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "scripts", "catalog.mjs");

/** core.js's io over real processes and files; `fail(cmd, args)` true makes that call fail. */
const ioOf = (fail = () => false) => ({
  exec: async (cmd, args) => {
    if (fail(cmd, args)) return { code: 1, stdout: "", stderr: "injected failure" };
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
  },
  readText: async (path) => readFileSync(path, "utf8"),
  writeText: async (path, text) => writeFileSync(path, text),
});
const scratch = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-mods-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("fetchSource installs at the catalog's headCommit, not whatever HEAD is", async (t) => {
  const root = scratch(t);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "mods", "demo"), { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "mods", "demo", "main.js"), "// pinned\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pinned");
  const pinned = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "mods", "demo", "main.js"), "// newer\n");
  git(repo, "commit", "-qam", "newer");
  const source = `file://${repo}`;
  const catalog = core.parseCatalog({ mods: [{ fullName: source, headCommit: pinned, modNames: ["demo"] }] });
  assert.equal(core.catalogCommit(catalog, source), pinned);
  assert.equal(core.catalogCommit(catalog, "someone/else"), null);
  assert.equal(core.catalogCommit(core.parseCatalog({ mods: [{ fullName: source, headCommit: "", modNames: ["demo"] }] }), source), null);
  const at = await core.fetchSource(ioOf(), source, join(root, "cache"), pinned);
  assert.equal(at.sha, pinned);
  assert.equal(readFileSync(join(at.dir, "mods", "demo", "main.js"), "utf8"), "// pinned\n");
  const head = await core.fetchSource(ioOf(), source, join(root, "cache"));
  assert.equal(readFileSync(join(head.dir, "mods", "demo", "main.js"), "utf8"), "// newer\n");
});

/** A package at `base` (mods/demo, new code) and an app home where demo is installed with private state. */
function installed(root) {
  const base = join(root, "pkg");
  mkdirSync(join(base, "mods", "demo", ".state"), { recursive: true });
  writeFileSync(join(base, "mods", "demo", "main.js"), "// new\n");
  writeFileSync(join(base, "mods", "demo", ".state", "default.json"), "{}\n");
  const appHome = join(root, "app");
  const live = join(appHome, "mods", "demo");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "main.js"), "// old\n");
  writeFileSync(join(live, ".token"), "mine\n");
  const elsewhere = join(root, "state-elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "key"), "secret\n");
  symlinkSync(elsewhere, join(live, ".state"));
  const plan = { clashes: [], mods: ["demo"], layouts: [], base, keyAdds: [], keyConflicts: [], risks: [] };
  return { base, appHome, live, elsewhere, plan, record: { mods: ["demo"], layouts: [], keys: [] } };
}

test("applyInstall stages the new folder, keeps a linked .state a link and a dotfile a file, and moves the old one aside", async (t) => {
  const s = installed(scratch(t));
  await core.applyInstall(ioOf(), { appHome: s.appHome, plan: s.plan, source: "x", prefix: "", sha: "0", record: s.record });
  assert.equal(readFileSync(join(s.live, "main.js"), "utf8"), "// new\n");
  assert.equal(lstatSync(join(s.live, ".state")).isSymbolicLink(), true, "a linked .state stays a link (probe C2)");
  assert.equal(readlinkSync(join(s.live, ".state")), s.elsewhere);
  assert.equal(readFileSync(join(s.elsewhere, "key"), "utf8"), "secret\n");
  assert.equal(readFileSync(join(s.live, ".token"), "utf8"), "mine\n");
  const backups = readdirSync(join(s.appHome, "automagik-herdr", "backup"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(s.appHome, "automagik-herdr", "backup", backups[0], "main.js"), "utf8"), "// old\n");
  assert.deepEqual(readdirSync(join(s.appHome, "automagik-herdr", "staging")), [], "nothing left staged");
  assert.deepEqual(readdirSync(join(s.appHome, "mods")), ["demo"]);
});

test("applyInstall that fails mid-way (copy or rename) leaves the old folder in place, whole (probes P2, C4)", async (t) => {
  for (const failing of [(cmd, args) => cmd === "cp" && args[0] === "-P", (cmd, args) => cmd === "mv" && /\/staging\//.test(args[0])]) {
    const s = installed(scratch(t));
    await assert.rejects(core.applyInstall(ioOf(failing), { appHome: s.appHome, plan: s.plan, source: "x", prefix: "", sha: "0", record: s.record }), /injected failure/);
    assert.equal(readFileSync(join(s.live, "main.js"), "utf8"), "// old\n");
    assert.equal(lstatSync(join(s.live, ".state")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(s.live, ".token"), "utf8"), "mine\n");
    assert.deepEqual(readdirSync(join(s.appHome, "automagik-herdr", "staging")), [], "staging cleared");
    assert.deepEqual(readdirSync(join(s.appHome, "automagik-herdr", "backup")), [], "nothing left aside");
  }
});

test("the manager never installs over, records or removes pocket-link", async (t) => {
  const s = installed(scratch(t));
  const args = { appHome: s.appHome, source: "x", prefix: "", sha: "0" };
  await assert.rejects(core.applyInstall(ioOf(), { ...args, plan: { ...s.plan, mods: [core.POCKET_LINK] }, record: null }), /automagik-pocket/);
  await assert.rejects(core.applyInstall(ioOf(), { ...args, plan: s.plan, record: { mods: [core.POCKET_LINK] } }), /automagik-pocket/);
  await assert.rejects(core.uninstall(ioOf(), { appHome: s.appHome, record: { mods: [core.POCKET_LINK] } }), /automagik-pocket/);
  assert.equal(existsSync(join(s.appHome, "automagik-herdr", "staging")), false, "refused before anything was written");
});

test("catalog.mjs: --check passes on this checkout and writes nothing; an unknown flag exits 2", (t) => {
  const index = join(ROOT, "catalog", "index.json");
  const before = readFileSync(index, "utf8");
  const check = spawnSync(process.execPath, [CATALOG, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /catalog matches the checkout/);
  for (const bad of [["--chek"], ["--refresh", "-x"]]) {
    const r = spawnSync(process.execPath, [CATALOG, ...bad], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 2, bad.join(" "));
    assert.match(r.stderr, /unknown flag/);
  }
  assert.equal(spawnSync(process.execPath, [CATALOG, "--help"], { encoding: "utf8" }).status, 0);
  assert.equal(readFileSync(index, "utf8"), before, "the index is untouched");
  // The pack's own entry: the monorepo, its herdr/ folder.
  const pack = JSON.parse(before).mods.find((e) => e.fullName === "automagik-si/automagik" && e.path === "herdr");
  assert.equal(pack.modNames.includes("pocket-link"), false);
});

test("applyInstall refuses a package that ships a link (a .state pointing outside, a dangling dotfile), changing nothing", async (t) => {
  for (const [name, target] of [[".state", "/tmp"], [".dangling", "/nowhere"]]) {
    const s = installed(scratch(t));
    rmSync(join(s.base, "mods", "demo", name), { recursive: true, force: true });
    symlinkSync(target, join(s.base, "mods", "demo", name));
    await assert.rejects(core.applyInstall(ioOf(), { appHome: s.appHome, plan: s.plan, source: "x", prefix: "", sha: "0", record: s.record }), /link or special file/, name);
    assert.equal(readFileSync(join(s.live, "main.js"), "utf8"), "// old\n");
    assert.equal(readlinkSync(join(s.live, ".state")), s.elsewhere);
    assert.equal(readFileSync(join(s.elsewhere, "key"), "utf8"), "secret\n", "nothing written through the link");
    assert.deepEqual(readdirSync(join(s.appHome, "automagik-herdr", "staging")), []);
  }
});

test("applyInstall whose key write fails puts the mods and layouts back, writing no layout", async (t) => {
  const s = installed(scratch(t));
  mkdirSync(join(s.base, "layouts"));
  writeFileSync(join(s.base, "layouts", "demo.json"), "{}\n");
  const plan = { ...s.plan, layouts: ["demo.json"], keyAdds: [{ section: "global", key: "cmd-k", action: "demo.open" }] };
  const io = { ...ioOf(), readText: async () => "{}", writeText: async () => { throw new Error("disk full"); } };
  await assert.rejects(core.applyInstall(io, { appHome: s.appHome, plan, source: "x", prefix: "", sha: "0", record: s.record }), /disk full/);
  assert.equal(readFileSync(join(s.live, "main.js"), "utf8"), "// old\n");
  assert.equal(existsSync(join(s.appHome, "layouts", "demo.json")), false);
  assert.deepEqual(readdirSync(join(s.appHome, "automagik-herdr", "backup")), []);
});

/** Every file under `dir`, path → bytes, links as their target: equal means byte-identical. */
const snapshot = (dir) => {
  const out = {};
  const walk = (at, rel) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name), st = lstatSync(path);
      if (st.isSymbolicLink()) out[`${rel}${name}`] = `-> ${readlinkSync(path)}`;
      else if (st.isDirectory()) walk(path, `${rel}${name}/`);
      else out[`${rel}${name}`] = readFileSync(path, "utf8");
    }
  };
  walk(dir, "");
  return out;
};

test("names differing only in case: Pocket-Link, Demo and Main.json never touch the person's folders", async (t) => {
  const s = installed(scratch(t));
  const pocket = join(s.appHome, "mods", "pocket-link");
  mkdirSync(join(pocket, ".state"), { recursive: true });
  writeFileSync(join(pocket, ".state", "pairing.key"), "secret\n");
  mkdirSync(join(s.appHome, "layouts"));
  writeFileSync(join(s.appHome, "layouts", "main.json"), "{\"mine\":true}\n");
  writeFileSync(join(s.appHome, "keys.json"), "{}\n");
  for (const m of ["Pocket-Link", "Demo", "fresh"]) {
    mkdirSync(join(s.base, "mods", m), { recursive: true });
    writeFileSync(join(s.base, "mods", m, "main.js"), `// ${m} from the package\n`);
  }
  mkdirSync(join(s.base, "layouts"));
  writeFileSync(join(s.base, "layouts", "Main.json"), "{\"theirs\":true}\n");
  const before = snapshot(s.appHome);
  // The plan flags them before anything runs.
  const plan = await core.planInstall(ioOf(), { appHome: s.appHome, dir: s.base, pkg: { prefix: "", mods: ["Demo", "Pocket-Link"], layouts: ["layouts/Main.json"], keys: false, files: [] },
    record: null, existingMods: ["demo", "pocket-link"], existingLayouts: ["main.json"] });
  assert.deepEqual(plan.clashes, ["mods/Demo", "mods/Pocket-Link", "layouts/Main.json"]);
  // And applyInstall refuses them even when handed a plan that missed them.
  const args = { appHome: s.appHome, source: "x", prefix: "", sha: "0", record: null };
  const bare = { clashes: [], layouts: [], base: s.base, keyAdds: [], keyConflicts: [], risks: [] };
  await assert.rejects(core.applyInstall(ioOf(), { ...args, plan: { ...bare, mods: ["Pocket-Link"] } }), /automagik-pocket/);
  await assert.rejects(core.applyInstall(ioOf(), { ...args, plan: { ...bare, mods: ["Demo"] } }), /name refused: Demo/);
  await assert.rejects(core.applyInstall(ioOf(), { ...args, plan: { ...bare, mods: ["demo"] } }), /already there: mods\/demo/);
  // A layout that clashes (on macOS's disk) after a mod was placed: the undo removes only that mod.
  await core.applyInstall(ioOf(), { ...args, plan: { ...bare, mods: ["fresh"], layouts: ["Main.json"] } }).catch(() => {});
  const caseless = existsSync(join(s.appHome, "layouts", "MAIN.JSON"));
  if (caseless) assert.equal(existsSync(join(s.appHome, "mods", "fresh")), false, "the undo took back the mod it placed");
  rmSync(join(s.appHome, "mods", "fresh"), { recursive: true, force: true });
  // Created only on a case-sensitive disk (Linux); on macOS's that name is the person's main.json.
  if (readdirSync(join(s.appHome, "layouts")).includes("Main.json")) rmSync(join(s.appHome, "layouts", "Main.json"));
  assert.equal(readFileSync(join(s.appHome, "layouts", "main.json"), "utf8"), "{\"mine\":true}\n");
  const after = snapshot(s.appHome);
  for (const k of Object.keys(after)) if (k.startsWith("automagik-herdr/")) delete after[k];
  for (const k of Object.keys(before)) if (k.startsWith("automagik-herdr/")) delete before[k];
  assert.deepEqual(after, before, "the person's mods and layouts are byte-identical");
});

test("the catalog URLs: core.js and release.js agree, and a copy of an old pack URL reads the monorepo's", async (t) => {
  const release = await import("../mods/am-sidebar/release.js");
  assert.equal(core.CATALOG_URL, release.CATALOG_URL);
  assert.equal(core.CATALOG_URL, "https://raw.githubusercontent.com/automagik-dev/automagik/dev/herdr/catalog/index.json");
  assert.deepEqual([...core.PACK_URLS], [...release.PACK_CATALOG_URLS]);
  const home = scratch(t);
  const ioOf = () => ({ readText: async (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } }, exec: async () => ({ code: 1 }) });
  for (const old of core.PACK_URLS.slice(1)) {
    mkdirSync(join(home, "data", "am-mods"), { recursive: true });
    writeFileSync(join(home, "data", "am-mods", "catalog.json"), JSON.stringify({ url: old }));
    assert.equal(await core.catalogUrl(ioOf(), home), core.CATALOG_URL, `a copy still on ${old}`);
  }
  // A URL the person set stays theirs.
  writeFileSync(join(home, "data", "am-mods", "catalog.json"), JSON.stringify({ url: "https://example.test/mine.json" }));
  assert.equal(await core.catalogUrl(ioOf(), home), "https://example.test/mine.json");
});

test("catalogUrl: a local catalog path whose file is gone falls back to the published index", async (t) => {
  const home = scratch(t);
  const put = (dir, url) => {
    mkdirSync(join(home, "data", dir), { recursive: true });
    writeFileSync(join(home, "data", dir, "catalog.json"), JSON.stringify({ url }));
  };
  const gone = join(home, "renamed", "catalog", "index.json");
  put("am-mods", gone);
  assert.equal(await core.catalogUrl(ioOf(), home), core.CATALOG_URL, "the only candidate is dead");
  const nullIo = { ...ioOf(), readText: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) };
  assert.equal(await core.catalogUrl(nullIo, home), core.CATALOG_URL, "a readText that returns null on a missing file");
  put("mod-manager", core.CATALOG_URL);
  assert.equal(await core.catalogUrl(ioOf(), home), core.CATALOG_URL, "the pack's URL in the old folder");
  put("mod-manager", "https://example.test/index.json");
  assert.equal(await core.catalogUrl(ioOf(), home), "https://example.test/index.json", "the person's other URL wins");
  mkdirSync(dirname(gone), { recursive: true });
  writeFileSync(gone, JSON.stringify({ mods: [] }));
  // Both the person's now: the one changed last wins. Explicit mtimes, as `[ -nt ]` compares
  // whole seconds in macOS sh and nanoseconds in Linux dash.
  const at = (dir, secs) => utimesSync(join(home, "data", dir, "catalog.json"), secs, secs);
  at("am-mods", 2_000_000); at("mod-manager", 1_000_000);
  assert.equal(await core.catalogUrl(ioOf(), home), gone, "a local path that is there counts again");
  at("am-mods", 1_000_000); at("mod-manager", 2_000_000);
  assert.equal(await core.catalogUrl(ioOf(), home), "https://example.test/index.json", "and loses to a newer one");
  // No case for file:// URLs: nothing reads them, so which one wins is not a contract.
});

// #215: a release commit touches herdr/ (the version bump) and used to rewrite the index's
// generatedAt and our pushedAt, so every catalog pull request conflicted after each release.
// #1600 keeps both stamps from the committed index when nothing the index describes changed, so
// the release commit no longer rewrites it. A scratch repository: the generator writes its own
// catalog/index.json and can never be pointed elsewhere.
const catalogPack = (t, origin = "https://github.com/automagik-si/automagik.git") => {
  const root = scratch(t);
  const pack = join(root, "herdr");
  mkdirSync(join(pack, "scripts"), { recursive: true });
  mkdirSync(join(pack, "catalog"), { recursive: true });
  mkdirSync(join(pack, "mods", "demo"), { recursive: true });
  copyFileSync(CATALOG, join(pack, "scripts", "catalog.mjs"));
  writeFileSync(join(pack, "catalog", "repos.json"), JSON.stringify({ repos: [] }));
  writeFileSync(join(pack, "mods", "demo", "main.js"), "// demo\n");
  writeFileSync(join(pack, "mods", "demo", "mod.json"), JSON.stringify({ title: "Demo" }));
  writeFileSync(join(pack, "mods", "demo", "RECIPE.md"), "# Demo\n\nA demo mod.\n");
  writeFileSync(join(pack, "mods", "demo", "LICENSE"), "Apache License\nVersion 2.0\n");
  writeFileSync(join(pack, "README.md"), "# Automagik Herdr\n\nThe pack.\n");
  writeFileSync(join(pack, "RECIPE.md"), "# The pack\n");
  writeFileSync(join(pack, "LICENSE"), "Apache License\nVersion 2.0\n");
  git(root, "init", "-q", "-b", "dev");
  git(root, "remote", "add", "origin", origin);
  git(root, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "the pack"], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z", GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z" },
  });
  return { root, pack };
};

test("catalog.mjs: an unchanged rebuild writes the same bytes (#215)", (t) => {
  const { root, pack } = catalogPack(t);
  const dated = (date) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const commit = (message, date) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message], { cwd: root, env: dated(date) });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "v9.9.9", "-m", "v9.9.9"], { cwd: root, env: dated("2026-01-02T03:04:05Z") });
  const run = () => {
    const r = spawnSync(process.execPath, [join(pack, "scripts", "catalog.mjs")], { cwd: pack, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(join(pack, "catalog", "index.json"), "utf8");
  };
  const first = run();
  // A release's own commit touches the pack (the version bump) after the tag was cut, without
  // changing what the index describes.
  writeFileSync(join(pack, "mods", "demo", "VERSION"), "9.9.10\n");
  git(root, "add", "-A");
  commit("chore(release): v9.9.10", "2026-02-02T00:00:00Z");
  const second = run();
  assert.equal(second, first, "the release commit keeps the same bytes, generatedAt and pushedAt included");
  const packEntry = JSON.parse(second).mods.find((e) => e.path === "herdr");
  assert.equal(packEntry.pushedAt, "2026-01-02T03:04:05Z", "the release commit keeps the pack's indexed pushedAt");
});

// #215: a checkout whose origin is a local mirror parsed no owner/repo, so a regeneration blanked
// the pack entry's url while its fullName still fell back to the monorepo. Both fall back together.
test("catalog.mjs: a mirror checkout keeps the pack's monorepo url (#215)", (t) => {
  const { pack } = catalogPack(t, "/srv/automagik-mirror.git");
  const r = spawnSync(process.execPath, [join(pack, "scripts", "catalog.mjs")], { cwd: pack, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const packEntry = JSON.parse(readFileSync(join(pack, "catalog", "index.json"), "utf8")).mods.find((e) => e.path === "herdr");
  assert.equal(packEntry.fullName, "automagik-si/automagik");
  assert.equal(packEntry.url, "https://github.com/automagik-si/automagik");
});
