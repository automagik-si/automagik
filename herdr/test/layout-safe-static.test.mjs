// The one door, checked statically (refs #431, #448, #450): a folder leaves mods/ and a file leaves
// layouts/ only through mods/am-sidebar/layoutSafe.mjs change(). Every .js and .mjs under herdr/mods
// (Pocket Link left out: it owns its folder) and am/ (its tests left out) is scanned for rmSync,
// renameSync, unlinkSync, cpSync, rmdirSync, layoutSafe.mjs removePath (#550: rmSync that never
// follows a link), fs.promises' rm, rename, unlink and cp, a bare
// rm/rename/unlink call (an injected one), and a program run through Herdr's io or an exec (`rm`,
// `mv`, `cp`, a `find` that deletes: mods/am-mods moves its folders that way, inside Herdr). A call outside
// layoutSafe.mjs fails unless ALLOWLIST names it, with its reason: its target is never under mods/
// or layouts/, or (am-mods, which runs inside Herdr and cannot load layoutSafe.mjs) which guard
// covers it and which matrix rows. An entry nothing matches fails too, so the list stays the
// code's. am/'s byte-equal copies (am/copies.json) share their source's entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DOOR = "herdr/mods/am-sidebar/layoutSafe.mjs";

const CALL = new RegExp([
  String.raw`\b(?:rmSync|renameSync|unlinkSync|cpSync|rmdirSync|removePath)\s*\(`,
  String.raw`\b(?:fs|fsp|promises)\s*\.\s*(?:rm|rename|unlink|cp|rmdir)\s*\(`,
  String.raw`(?<![\w.$])(?:rm|rename|unlink)\s*\(`,
  String.raw`\b(?:run\s*\(\s*io\s*,|(?:io\.)?exec\s*\()\s*["'\`](?:rm|mv|cp|find|rmdir|unlink)["'\`]`,
].join("|"), "g");

/** The call starting at `at` in `text`, up to its closing parenthesis, whitespace folded. */
function callAt(text, at) {
  let depth = 0, quote = null;
  for (let i = text.indexOf("(", at); i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(at, i + 1).replace(/\s+/g, " ");
  }
  return text.slice(at, at + 80).replace(/\s+/g, " ");
}

const files = (dir, skip) => readdirSync(dir).sort().flatMap((n) => {
  const p = join(dir, n);
  if (skip(p)) return [];
  if (statSync(p).isDirectory()) return files(p, skip);
  return /\.(m?js)$/.test(n) ? [p] : [];
});

/**
 * Every call in scope: `{ file, canonical, line, call }`, `file` a repository path and `canonical`
 * its source when it is one of am/'s copies. A function's own name (`function rename(`) and a line
 * that is a comment are not calls.
 */
export function scan(repo = REPO) {
  const copies = new Map(JSON.parse(readFileSync(join(repo, "am", "copies.json"), "utf8")).files.map((f) => [f.to, f.from]));
  const rel = (p) => relative(repo, p).split("\\").join("/");
  const inScope = [
    ...files(join(repo, "herdr", "mods"), (p) => /[/\\](pocket-link|node_modules|test)$/.test(p)),
    ...files(join(repo, "am"), (p) => /[/\\](node_modules|test)$/.test(p)),
  ];
  return inScope.flatMap((path) => {
    const file = rel(path);
    const text = readFileSync(path, "utf8");
    const found = [];
    for (const m of text.matchAll(CALL)) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(before) || /\bfunction\s*$/.test(before)) continue;
      const call = callAt(text, m.index);
      // A find only lists, unless it deletes or runs rm/mv on what it finds.
      if (/^\S*\(\s*(?:io\s*,\s*)?["'`]find["'`]/.test(call) && !/"-delete"|"-exec",\s*"(?:rm|mv)"/.test(call)) continue;
      found.push({ file, canonical: copies.get(file) ?? file, line: text.slice(0, m.index).split("\n").length, call });
    }
    return found;
  });
}

/**
 * The calls that stay outside layoutSafe.mjs: `[file, call, count, reason]`, `file` the source (an
 * am/ copy shares it), `call` as scan() folds it, `count` how many times each scanned copy holds it.
 */
export const ALLOWLIST = [
  ["herdr/mods/am-mods/core.js", "run(io, \"mv\", [path, to])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: moveAside, a package's mods/ folder or layouts/ file moved to automagik-herdr/backup (never deleted). Remove is guarded in main.js removeGuard (layoutGuard, packageLayoutGuard); an update keeps the shown layout it no longer ships (applyInstall held, #431) and a mod it no longer ships that the shown layout's blocks name (applyInstall heldMods, #490); matrix: package update and package remove rows"],
  ["herdr/mods/am-mods/core.js", "run(io, \"cp\", [\"-RP\", `${src}/.`, `${dst}/`])", 1, "carryPrivate: a mod's private paths copied into its staged folder (automagik-herdr/staging), never into mods/"],
  ["herdr/mods/am-mods/core.js", "run(io, \"rm\", [\"-rf\", dst])", 1, "carryPrivate: a path inside the staged folder (automagik-herdr/staging) replaced by the person's copy"],
  ["herdr/mods/am-mods/core.js", "run(io, \"cp\", [\"-P\", src, dst])", 1, "carryPrivate: a private file copied into the staged folder (automagik-herdr/staging)"],
  ["herdr/mods/am-mods/core.js", "run(io, \"cp\", [\"-R\", `${plan.base}/mods/${m}`, stage])", 1, "applyInstall: a package's mod copied from its fetched checkout into automagik-herdr/staging"],
  ["herdr/mods/am-mods/core.js", "io.exec(\"rm\", [\"-rf\", stage])", 2, "applyInstall: its own staged folders under automagik-herdr/staging, removed after a swap or a failure"],
  ["herdr/mods/am-mods/core.js", "run(io, \"mv\", [stage, dest])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: applyInstall places a staged mod into mods/ after moveAside took the old one (rolled back on failure); not a removal. Matrix: package update rows"],
  ["herdr/mods/am-mods/core.js", "run(io, \"cp\", [`${plan.base}/layouts/${l}`, to])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: applyInstall writes a package's layout into layouts/ (a name LAYOUT_NAME admits, never over one it did not record). Matrix: package update rows"],
  ["herdr/mods/am-mods/core.js", "io.exec(\"rm\", [\"-f\", to])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: applyInstall's rollback removes only the layouts/ files it placed in this run"],
  ["herdr/mods/am-mods/core.js", "io.exec(\"mv\", [live, stage])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: applyInstall's rollback moves the mods it placed in this run back to staging"],
  ["herdr/mods/am-mods/core.js", "io.exec(\"mv\", [to, live])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: applyInstall's rollback puts each folder or layout moveAside took back where it was"],
  ["herdr/mods/am-mods/core.js", "run(io, \"rm\", [where])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: removeLocal of a symlinked mod removes only the link in mods/ (the folder it points to stays); guarded by main.js removeGuard (layoutGuard). Matrix: package remove | symlinked mod folder"],
  ["herdr/mods/am-mods/core.js", "run(io, \"mv\", [`${appHome}/${onOff(!enabled)}/${name}`, `${appHome}/${to}/${name}`])", 1, "am-mods runs inside Herdr through its io and cannot load layoutSafe.mjs: setEnabled moves a mod between mods/ and mods-disabled/; off is guarded by main.js (layoutGuard on the shown layout, #305)"],
  ["herdr/mods/am-mods/main.js", "exec(\"find\", [cacheDir(), \"-mindepth\", \"1\", \"-maxdepth\", \"1\", \"-mmin\", \"+60\", \"-exec\", \"rm\", \"-rf\", \"{}\", \"+\"])", 1, "the mod manager's fetch cache (cacheDir, under data/am-mods), entries older than an hour"],
  ["herdr/mods/am-mods/main.js", "exec(\"rm\", [\"-rf\", this.review.fetched.dir])", 2, "a fetched package checkout in the mod manager's cache (data/am-mods)"],
  ["herdr/mods/am-mods/main.js", "exec(\"rm\", [\"-rf\", fetched.dir])", 2, "a fetched package checkout in the mod manager's cache (data/am-mods)"],
  ["herdr/mods/am-sidebar/update.mjs", "cpSync(join(modsDir, h.mod), join(next, h.mod), { recursive: true, verbatimSymlinks: true })", 1, "a held mod copied INTO the new kept set (.prev-next-), read from mods/ and never written there"],
  ["herdr/mods/am-sidebar/update.mjs", "cpSync(layoutRefOf(modsDir), join(dir, KEPT_LAYOUT))", 1, "the layout reference copied into a kept set; it reads the state folder's copy, never layouts/"],
  ["herdr/mods/am-sidebar/update.mjs", "cpSync(src, dst, { recursive: true, verbatimSymlinks: true })", 1, "carryPrivate: a private path copied into a staged folder or the kept set, never into mods/"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(dst, { recursive: true, force: true })", 1, "carryPrivate: a private path copied into a staged folder or the kept set, never into mods/"],
  ["herdr/mods/am-sidebar/update.mjs", "rename(next, prevSetOf(modsDir))", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(`${path}.tmp`, path)", 1, "writeMarker: the ownership record in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(aside, lock)", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(gone, lock)", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(lock, aside)", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(lock, gone)", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(aside, { recursive: true, force: true })", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(gone, { recursive: true, force: true })", 1, "the update lock (<app home>/automagik-herdr/update.lock) and its aside/gone names, in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(join(state, old), join(backupOf(modsDir), name))", 1, "carryV1: v0.2's kept copies, from the state folder into its backup/"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(old, prevSetOf(modsDir))", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(prevSetOf(modsDir), old)", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(tmp, autoFileOf(modsDir))", 1, "the auto-update file (auto.json) in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(tmp, file)", 4, "restore notification and saveHeld/saveRestore/saveCheck: held-mods.json, restored-mods.json and unchecked-mods.json in the state folder, beside the record, never under mods/ or layouts/"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(file, { force: true })", 1, "saveHeld: held.json in the state folder"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(join(stateDirOf(modsDir), name), { force: true })", 1, "clearNotes: a previous update's restore/check notes (restored-mods.json/unchecked-mods.json) in the state folder, never under mods/ or layouts/"],
  ["herdr/mods/am-sidebar/update.mjs", "renameSync(tmp, link)", 2, "the command link in the bin folder (~/.local/bin/automagik-herdr) and its temp link"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(tmp, { force: true })", 4, "the command link in the bin folder (~/.local/bin/automagik-herdr) and its temp link"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(keysTmp, { force: true })", 1, "writeKeys: its own temp file beside keys.json in the app home (keys.json itself goes through change()), never under mods/ or layouts/"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(dir, { recursive: true, force: true })", 1, "a staging folder or temp file it made itself (mkdtemp in tmpdir, or staging-/tgz folders in the state folder)"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(next, { recursive: true, force: true })", 2, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(old, { recursive: true, force: true })", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/update.mjs", "removePath(path, { recursive: true, force: true })", 1, "dropSet (#671): the failed release's folders in the state folder's .prev-next- and the emptied kept set (.prev/.prev-old-), beside mods/, never in it; a restore removes them so a manual rollback cannot reinstall the bad pack"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(staging, { recursive: true, force: true })", 2, "a staging folder or temp file it made itself (mkdtemp in tmpdir, or staging-/tgz folders in the state folder)"],
  ["herdr/mods/am-sidebar/update.mjs", "rmSync(tgzDir, { recursive: true, force: true })", 2, "a staging folder or temp file it made itself (mkdtemp in tmpdir, or staging-/tgz folders in the state folder)"],
  ["herdr/mods/am-sidebar/parts.mjs", "renameSync(join(prev, m), join(next, m))", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "renameSync(next, prev)", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "renameSync(prev, old)", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "removePath(old, { recursive: true, force: true })", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "removePath(prev, { recursive: true, force: true })", 1, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "rmSync(next, { recursive: true, force: true })", 2, "the pack's state folder (<app home>/automagik-herdr: the record, held.json, the kept set .prev, its .prev-next-/.prev-old- neighbours), beside mods/, never in it"],
  ["herdr/mods/am-sidebar/parts.mjs", "rmSync(join(state, f), { force: true })", 1, "--purge: the state folder's own files (hooks journal, layout reference, held.json)"],
  ["herdr/mods/am-sidebar/parts.mjs", "rmSync(markerOf(ctx.modsDir), { force: true })", 1, "the ownership record in the state folder"],
  ["herdr/mods/am-sidebar/parts.mjs", "rmSync(stableBriefingPath(ctx.appHome))", 1, "the briefing's files under <app home>/automagik-herdr/ (briefed/, seen ledgers, its entry point)"],
  ["herdr/mods/am-sidebar/parts.mjs", "renameSync(tmp, link)", 1, "the command link in the bin folder (~/.local/bin/automagik-herdr) and its temp link"],
  ["herdr/mods/am-sidebar/parts.mjs", "removePath(tmp, { force: true })", 1, "the command link in the bin folder (~/.local/bin/automagik-herdr) and its temp link"],
  ["herdr/mods/am-sidebar/parts.mjs", "unlinkSync(link)", 1, "the command link in the bin folder (~/.local/bin/automagik-herdr) and its temp link"],
  ["herdr/mods/am-sidebar/parts.mjs", "rmSync(tmp, { recursive: true, force: true })", 1, "packSource: the temp folder (mkdtemp in tmpdir) a checkout is packed into"],
  ["herdr/mods/am-sidebar/migrateHome.mjs", "cpSync(f.file, keys ? join(backupDir, \"keys.json\") : join(backupDir, \"layouts\", basename(f.file)), { force: false, errorOnExist: true })", 1, "the migration's backup folder (<app home>/automagik-herdr/backup/<date>): its copies and journal; it reads layouts/, never writes there"],
  ["herdr/mods/am-sidebar/migrateHome.mjs", "cpSync(join(home, old), join(home, now), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })", 1, "migrate.js PATH_RENAMES: app-home files and data/ folders (data/mod-manager, the projects file), never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/migrateHome.mjs", "renameSync(journalPath, join(backupDir, REVERTED))", 1, "the migration's backup folder (<app home>/automagik-herdr/backup/<date>): its copies and journal"],
  ["herdr/mods/am-sidebar/migrateHooks.mjs", "renameSync(tmp, link)", 2, "an agent's settings file in a project (.claude/settings.json and the like) or the CLI link, never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/migrateHooks.mjs", "renameSync(tmp, path)", 1, "an agent's settings file in a project (.claude/settings.json and the like) or the CLI link, never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/migrateHooks.mjs", "rmSync(tmp, { force: true })", 1, "an agent's settings file in a project (.claude/settings.json and the like), never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/migrateHooks.mjs", "removePath(tmp, { force: true })", 2, "the CLI link's temp link in the bin folder (~/.local/bin), never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/briefing.mjs", "renameSync(tmp, path)", 1, "the briefing's files under <app home>/automagik-herdr/ (briefed/, seen ledgers, its entry point)"],
  ["herdr/mods/am-sidebar/briefingEntry.mjs", "renameSync(tmp, path)", 1, "the briefing's files under <app home>/automagik-herdr/ (briefed/, seen ledgers, its entry point)"],
  ["herdr/mods/am-sidebar/briefingEntry.mjs", "rmSync(path, { force: true })", 1, "the briefing's files under <app home>/automagik-herdr/ (briefed/, seen ledgers, its entry point)"],
  ["herdr/mods/am-sidebar/briefingEntry.mjs", "rmSync(tmp, { force: true })", 1, "the briefing's files under <app home>/automagik-herdr/ (briefed/, seen ledgers, its entry point)"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "renameSync(lock, aside)", 1, "the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "unlinkSync(aside)", 1, "the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "unlinkSync(lock)", 1, "the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "unlinkSync(path)", 1, "the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "unlinkSync(unit)", 1, "the revive login service's own systemd user unit under ~/.config/systemd/user (#939), only when its first line is the pack's mark: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "unlinkSync(tmp)", 2, "the queued-restarts.json temp in <app home>/automagik-herdr and the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "renameSync(tmp, file)", 4, "queued-restarts.json and linked-updates.json (the linked machines' update record, #954) and their sibling temp files under <app home>/automagik-herdr, never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "renameSync(tmp, path)", 2, "the CLI's own files: .herdr/bots.json in a project, its lock and temp files beside them; and a bot's launch briefing file under <app home>/automagik-herdr/"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "renameSync(from, to)", 1, "the Antigravity model cache's temp file under <app home>/automagik-herdr/ (antigravity-models.json.tmp-<time>) renamed onto its cache: never under mods/ or layouts/"],
  ["herdr/mods/am-sidebar/bin/automagik-herdr.mjs", "renameSync(tmp, settings.path)", 1, "the Antigravity launch permission file under <app home>/automagik-herdr/agy-settings, written 0600 and renamed onto its deterministic path: never under mods/ or layouts/"],
  ["herdr/mods/am-sidebar/modelCache.js", "rename(tmp, path)", 2, "the injected rename of the Antigravity model cache's temp file under <app home>/automagik-herdr/ (antigravity-models.json.tmp-<time>) onto its cache: never under mods/ or layouts/; the caller supplies rename"],
  ["herdr/mods/am-sidebar/main.js", "fs.unlink(file)", 1, "a pasted image in <app home>/paste-tmp/"],
  ["herdr/mods/am-sidebar/spaceIcon.js", "fs.unlink(scratch)", 1, "a space icon the sidebar wrote under <app home>/space-icons/ (spaceIconModel.js leftover) or its scratch file"],
  ["herdr/mods/am-sidebar/spaceIcon.js", "fs.unlink(`${appHome()}/${drop}`)", 2, "a space icon the sidebar wrote under <app home>/space-icons/ (spaceIconModel.js leftover) or its scratch file"],
  ["herdr/mods/am-sidebar/hcProxy.mjs", "unlinkSync(path)", 1, "the proxy's own stale per-pane socket under $XDG_RUNTIME_DIR/automagik-hc-proxy/<terminal>/hc.sock: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/hcProxy.mjs", "unlinkSync(socketPath)", 2, "the proxy's own per-pane socket when it closes or a start fails after listen: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/hcProxy.mjs", "renameSync(tmp, plan.path)", 1, "the proxy's write of an approved worker's Antigravity permission file under the data root's approved/agy-settings (bound read-only to the sandbox): never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/approved.js", "renameSync(tmp, path)", 1,
    "the 0600 roster record under <data root>/approved: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/approved.js", "unlinkSync(tmp)", 1,
    "the roster record's temp file under <data root>/approved: never mods/ or layouts/"],
  ["herdr/mods/am-quota/switch.js", "fs.unlink(p)", 1, "am-quota's Codex payload under its data folder (write.js payloadDir)"],
  ["herdr/mods/am-quota/switch.js", "unlink(scratch)", 1, "am-quota's Codex payload under its data folder (write.js payloadDir)"],
  ["am/lib/self.mjs", "cpSync(dir, staging, { recursive: true, verbatimSymlinks: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "renameSync(staging, join(store, name))", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "renameSync(tmp, join(store, \"record.json\"))", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "renameSync(tmp, join(store, name))", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "removePath(join(store, \"previous\"), { force: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "removePath(link, { force: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home (and am's own command link)"],
  ["am/lib/self.mjs", "rmSync(staging, { recursive: true, force: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "removePath(store, { recursive: true, force: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "rmSync(work, { recursive: true, force: true })", 1, "a temp folder am unpacks a release into (mkdtemp in tmpdir)"],
  ["am/lib/self.mjs", "renameSync(tmp, link)", 2, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home (and am's own command link)"],
  ["am/lib/self.mjs", "renameSync(tmp, path)", 2, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home (and the briefing entry point am places)"],
  ["am/lib/self.mjs", "removePath(join(store, name), { recursive: true, force: true })", 2, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home"],
  ["am/lib/self.mjs", "rmSync(path, { force: true })", 1, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home: the store lock it made"],
  ["am/lib/self.mjs", "removePath(path, { force: true })", 2, "am's parts store ($AM_HOME/parts: am's own record, versions and links), never Herdr's app home (and the briefing entry point am places)"],
  ["herdr/mods/am-sidebar/dshTui.mjs", "renameSync(temp, path)", 1, "writeAtomic: dsh-TUI's shim in ~/.local/bin, DSH's dsh-tui profile files under ~/.dsh (or $DSH_HOME) and dsh-TUI's ~/.dsh-tui state: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/dshTui.mjs", "removePath(cwd, { recursive: true, force: true })", 1, "a temp folder the dsh plugin run works in (mkdtemp in tmpdir)"],
  ["herdr/mods/am-sidebar/dshTui.mjs", "removePath(shim, { force: true })", 1, "the dsh-tui shim in ~/.local/bin: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/dshTui.mjs", "removePath(join(profile, RECORD_FILE), { force: true })", 1, "the installer's own ownership record in the dsh-tui profile: never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/bin/dsh-sandbox.mjs", "renameSync(tmp, path)", 1, "dsh-sandbox's atomic profile write: the dsh-tui profile's cordis.patch.yml under ~/.dsh (or $DSH_HOME), never mods/ or layouts/"],
  ["herdr/mods/am-sidebar/bin/dsh-sandbox.mjs", "unlinkSync(tmp)", 1, "the sibling temp file of dsh-sandbox's atomic profile write: never mods/ or layouts/"],
];

test("every rm, rename, unlink and cp outside layoutSafe.mjs is one the allowlist names", () => {
  const found = scan().filter((f) => f.file !== DOOR && f.canonical !== DOOR);
  const counts = new Map();
  for (const f of found) {
    const key = `${f.file}\0${f.call}`;
    counts.set(key, { ...f, n: (counts.get(key)?.n ?? 0) + 1 });
  }
  const allowed = new Map(ALLOWLIST.map(([file, call, count, reason]) => [`${file}\0${call}`, { count, reason }]));
  const problems = [];
  for (const f of counts.values()) {
    const entry = allowed.get(`${f.canonical}\0${f.call}`);
    if (!entry) problems.push(`${f.file}:${f.line}: ${f.call}: outside layoutSafe.mjs and not in the allowlist (route it through change(), or allowlist it with why its target is never under mods/ or layouts/)`);
    else if (entry.count !== f.n) problems.push(`${f.file}: ${f.call}: ${f.n} call(s), the allowlist says ${entry.count}`);
  }
  const seen = new Set([...counts.values()].map((f) => `${f.canonical}\0${f.call}`));
  for (const [file, call] of ALLOWLIST) if (!seen.has(`${file}\0${call}`)) problems.push(`${file}: ${call}: an allowlist entry nothing matches`);
  assert.deepEqual(problems, []);
});

test("every allowlist entry gives its reason, once", () => {
  const keys = ALLOWLIST.map(([file, call]) => `${file}\0${call}`);
  assert.equal(new Set(keys).size, keys.length, "an entry twice");
  for (const [file, call, count, reason] of ALLOWLIST) {
    assert.ok(Number.isInteger(count) && count > 0, `${file}: ${call}: a count`);
    assert.ok(typeof reason === "string" && reason.length > 20, `${file}: ${call}: a reason`);
  }
});

test("the scan sees the calls it is for", () => {
  // layoutSafe.mjs itself holds the door's renames and removes; a scan that found none would pass anything.
  const door = scan().filter((f) => f.file === DOOR).map((f) => f.call);
  assert.ok(door.some((c) => c.startsWith("renameSync(")) && door.some((c) => c.startsWith("rmSync(")) && door.some((c) => c.startsWith("rename(")), door.join("\n"));

  // mods/am-mods's io: moveAside's mv and removeLocal's rm of a link, both into mods/ or layouts/.
  const io = scan().filter((f) => f.file === "herdr/mods/am-mods/core.js").map((f) => f.call);
  assert.ok(io.includes('run(io, "mv", [path, to])') && io.includes('run(io, "rm", [where])'), io.join("\n"));
  // layoutSafe.mjs removePath (#550) is scanned like rmSync: relinkCli's temp link, and am's copy of it.
  assert.ok(scan().some((f) => f.file === "herdr/mods/am-sidebar/update.mjs" && f.call === "removePath(tmp, { force: true })"));
  assert.ok(scan().some((f) => f.file === "am/update.mjs" && f.call === "removePath(tmp, { force: true })"));
  // #566: the lock's aside/gone names and the older kept set (update.mjs, am's copy too), and parts.mjs's .prev/.prev-old-.
  for (const file of ["herdr/mods/am-sidebar/update.mjs", "am/update.mjs"]) {
    for (const v of ["aside", "gone", "old"]) assert.ok(scan().some((f) => f.file === file && f.call === `removePath(${v}, { recursive: true, force: true })`), `${file}: ${v}`);
  }
  for (const v of ["old", "prev"]) assert.ok(scan().some((f) => f.file === "herdr/mods/am-sidebar/parts.mjs" && f.call === `removePath(${v}, { recursive: true, force: true })`), v);
  // A find that only lists is not a call; one that deletes is.
  assert.ok(!scan().some((f) => f.file === "herdr/mods/am-footer/contributions.js"));
  assert.ok(scan().some((f) => f.file === "herdr/mods/am-mods/main.js" && f.call.startsWith('exec("find"')));
});
