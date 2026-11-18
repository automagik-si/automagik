// The herdr parts' entries (RFC 0012): what `am install|uninstall|doctor <id>` runs for each part.json
// under herdr/ and herdr-layout/, through pack/part.mjs. Node only (like update.mjs); Herdr never
// loads this file. Apache-2.0.
//
// The pack is still one unit underneath: one tarball, installed, updated and rolled back together
// by update.mjs, and its marker (<app home>/automagik-herdr/installed-by-install.sh) stays the
// install record during the bridge cycle. These entries keep writing it; am only reads it.
//   herdr.pack         the updater, the record and the kept set. install: the pack (update.mjs install
//                      --setup) when the record is not at this version, and ~/.local/bin/automagik-herdr
//                      linked as install.sh does where nothing else holds it (am's link is left: RFC
//                      0012, D34). uninstall: the whole pack, as install.sh --uninstall does, plus the
//                      briefing hooks, the hooks' entry point, the pack's keys and its command link.
//                      The folders go to the kept set (<app home>/automagik-herdr/.prev) unless --purge.
//                      Refused, with nothing changed, while a block of the layout Herdr shows names a
//                      pack mod (guardLayouts, #420).
//   herdr.am-<mod>     install: the pack, then the mod switched back on. uninstall: switched off
//                      (moved to mods-disabled/, as the mod manager does); an update keeps it off.
//                      The sidebar refuses while the CLI link or the briefing entry point still runs
//                      code in its folder (sidebarCarries), and stops refusing once am's copies do.
//                      Any of them refuses while a block of the layout Herdr shows names it (Herdr
//                      would drop that layout for plain Herdr; guardLayouts, #414).
//   herdr.layout       install: the pack, then the automagik layout put back if it was removed.
//                      uninstall: the layout removed while it is the pack's copy (layout=removed).
// Never written: Herdr's shared.json or data/, Pocket Link (mods/pocket-link) or its LaunchAgent,
// usagemeter (its own part). doctor reads only, and prints one JSON line per check.

import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, realpathSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { stableBriefingPath, ENTRY_SOURCE, hookDoctorLine } from "./briefingText.mjs";
import { AM_LINK, CLI_LINK, hooksRunning, knownProjects, ledgerFolders, removeHooks } from "./migrateHooks.mjs";
import {
  HELD_FILE, OLD_PACK_NAME, PACK_KEYS, PACK_LAYOUT, PACK_MODS, PACK_NAME, POCKET_LINK, compareVersions, formatMarker,
} from "./release.js";
import { change, linkedModsLine, removePath, switchCommand } from "./layoutSafe.mjs";
import { appHomeOf, binDirOf, markerOf, mergePackKeys, offDirOf, placeLayout, prevSetOf, readMarker, readVersion, stateDirOf, writeKeys, writeMarker } from "./update.mjs";
import { dshTuiPresence } from "./dshTui.mjs";

export const NODE_MIN = "22.7.0";
/** What a herdr part's id names: `herdr.pack`, `herdr.<pack mod>`, `herdr.layout`. */
export const PART_IDS = Object.freeze(["herdr.pack", ...PACK_MODS.map((m) => `herdr.${m}`), "herdr.layout"]);

export function partOf(id) {
  if (id === "herdr.layout") return { id, kind: "layout" };
  if (id === "herdr.pack") return { id, kind: "pack" };
  const mod = typeof id === "string" && id.startsWith("herdr.") ? id.slice("herdr.".length) : null;
  if (mod && PACK_MODS.includes(mod)) return { id, kind: "mod", mod };
  return null;
}

/** A command's result: `{ code, stdout, stderr, missing }` (missing: the program is not there). */
export function runCommand(cmd, args, { env, cwd, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { env, cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: r.error?.code === "ENOENT" };
}

/**
 * Where everything is, from the environment am runs the entry with (AM_HOME, AM_PART_DIR,
 * AM_VERSION, AM_ARTIFACT, AM_JSON; HERDR_APP_HOME and HOME as the pack reads them). `exec` runs
 * a program (runCommand's shape); tests pass their own, and an app home of their own.
 */
export function contextOf({ env = process.env, exec = runCommand, log = (line) => process.stderr.write(`${line}\n`), platform = process.platform,
  node = process.execPath, nodeVersion = process.versions.node, project = process.cwd() } = {}) {
  const appHome = appHomeOf(env);
  const modsDir = join(appHome, "mods");
  return {
    env, exec, log, platform, node, nodeVersion, appHome, modsDir, project, offDir: offDirOf(modsDir), binDir: binDirOf(env),
    version: /^\d+\.\d+\.\d+$/.test(env.AM_VERSION ?? "") ? env.AM_VERSION : null,
  };
}

const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };
const exists = (p) => lstat(p) !== null;
const isLink = (p) => Boolean(lstat(p)?.isSymbolicLink());
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// A program of the pack's on this computer: PATH, then the user bin folder the pack links into.
const programOn = (ctx, program) => {
  for (const dir of [...(ctx.env.PATH ?? "").split(":"), ctx.binDir]) {
    if (dir && isFile(join(dir, program))) return join(dir, program);
  }
  return null;
};
const packFolder = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== POCKET_LINK;
const fresh = (dir, prefix) => join(dir, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
/** Names a mod's tree never ships (update.mjs privateName: dot-names, node_modules, editor files). */
const unshipped = (name) => name.startsWith(".") || name === "node_modules" || name === "gpui-kit.d.ts" || name === "jsconfig.json";

// ---- the artifact (RFC 0012 entry contract): the one place that knows how am hands it over ----

/**
 * Where AM_PART_DIR's pack is: `{ tree }`, the extracted tarball am points AM_PART_DIR into
 * (`<extracted>/<select>`: the tree holds `am-sidebar/update.mjs` and `layouts/`), or `{ repo }`, a
 * checkout (`am install ./herdr/mods/am-footer`), which herdr/scripts/pack.mjs --worktree packs the
 * way release.yml packs a tag.
 */
export function packTree(partDir) {
  if (!partDir) throw new Error("am gave no AM_PART_DIR (nor AM_ARTIFACT): no pack to install from");
  let dir = resolve(partDir);
  for (let i = 0; i < 5; i++, dir = dirname(dir)) {
    if (isFile(join(dir, "herdr", "scripts", "pack.mjs")) && isFile(join(dir, "herdr", "mods", PACK_NAME, "update.mjs"))) {
      if (exists(join(dir, ".git"))) return { repo: dir };
      throw new Error(`${dir} is a copy of the repository, not a git checkout: am installs a herdr part from a git checkout (git clone) or a release, which say what the pack holds`);
    }
    if (isFile(join(dir, PACK_NAME, "update.mjs")) && isFile(join(dir, PACK_NAME, "release.js")) && basename(dir) !== "mods") return { tree: dir };
  }
  throw new Error(`${partDir} is in no Automagik Herdr pack (an extracted automagik-herdr-pack-<v>.tgz, or a checkout's herdr/)`);
}

/**
 * The pack to install from: `{ tgz, tree, version, cleanup }`. AM_ARTIFACT (the tarball am checked
 * against the signed pointer) when am gives it, else a tarball made from packTree. `tree` is that
 * tarball unpacked (its update.mjs runs the install, as install.sh runs the release's own), and
 * `version` am's AM_VERSION, else the tarball's VERSION (update.mjs refuses a mismatch).
 */
export function packSource(ctx) {
  const tmp = mkdtempSync(join(tmpdir(), "am-herdr-part-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let tgz = ctx.env.AM_ARTIFACT || null;
    if (tgz && !isFile(tgz)) throw new Error(`AM_ARTIFACT ${tgz} is not a file`);
    if (!tgz) {
      const where = packTree(ctx.env.AM_PART_DIR);
      tgz = join(tmp, "pack.tgz");
      const r = where.repo
        ? ctx.exec(ctx.node, [join(where.repo, "herdr", "scripts", "pack.mjs"), "--worktree", "--repo", where.repo, "--out", tgz], { env: ctx.env })
        : ctx.exec("tar", ["-czf", tgz, "-C", where.tree, ...readdirSync(where.tree).filter((n) => !unshipped(n)).sort()], { env: { ...ctx.env, COPYFILE_DISABLE: "1" } });
      if (r.code !== 0) throw new Error(`could not pack ${where.repo ?? where.tree} (${r.stderr.trim() || `exit ${r.code}`})`);
    }
    const tree = join(tmp, "x");
    mkdirSync(tree);
    const r = ctx.exec("tar", ["-xzf", resolve(tgz), "-C", tree], { env: ctx.env });
    if (r.code !== 0) throw new Error(`could not unpack ${tgz} (${r.stderr.trim() || `tar exit ${r.code}`})`);
    return { tgz: resolve(tgz), tree, version: ctx.version ?? readVersion(join(tree, PACK_NAME)), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---- install ----

/**
 * The pack at the source's version, through the source's own update.mjs (`install --setup`: the
 * folders, the record, the free keys, the mod manager's catalog, the layout, `herdr-app check`).
 * Nothing when the record already names that version. Throws on a failure (exit 3: a mod's
 * check failed; 4: a step after the swap did not finish; its lines are in the log).
 */
function ensurePack(ctx, source) {
  const record = readMarker(ctx.modsDir);
  // am's AM_VERSION when it gives one, so an install already at that version unpacks nothing.
  if (record && !record.v1 && record.version === (ctx.version ?? source().version)) return false;
  const src = source();
  // AM_SEQUENCE: the signed pointer's sequence, so the record keeps install.sh's replay guard on.
  const sequence = /^\d{1,15}$/.test(ctx.env.AM_SEQUENCE ?? "") ? ["--sequence", ctx.env.AM_SEQUENCE] : [];
  const r = ctx.exec(ctx.node, [join(src.tree, PACK_NAME, "update.mjs"), "install", "--from", src.tgz, "--version", src.version, "--mods", ctx.modsDir, "--setup", ...sequence],
    { env: { ...ctx.env, HERDR_APP_HOME: ctx.appHome } });
  for (const line of r.stderr.split("\n").filter(Boolean)) ctx.log(line.replace(/^notice: /, ""));
  if (r.code === 3) throw new Error(`the pack ${src.version} is installed, but herdr-app check failed for a mod (above)`);
  if (r.code === 4) throw new Error(`the pack ${src.version} is installed, but a step after it did not finish (the warning above says what)`);
  if (r.code !== 0) {
    let why = r.stdout.trim() || r.stderr.trim();
    try { why = JSON.parse(r.stdout).error ?? why; } catch {}
    throw new Error(`the pack ${src.version} was not installed: ${why}`);
  }
  ctx.log(`installed the pack ${src.version} in ${ctx.modsDir}`);
  return true;
}

/** Each pack key (PACK_KEYS) out of keys.json while it still runs the pack's action; a rebound one stays. */
function dropKeys(ctx) {
  const path = join(ctx.appHome, "keys.json");
  if (!isFile(path) || isLink(path)) return 0;
  const keys = JSON.parse(readFileSync(path, "utf8"));
  let dropped = 0;
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) if (keys[section]?.[key] === action) { delete keys[section][key]; dropped += 1; }
  }
  if (dropped) writeKeys(ctx.appHome, keys);
  return dropped;
}

/** The sidebar's folder wherever it is, on (mods/) or switched off (mods-disabled/); null when neither. */
const sidebarDir = (ctx) => [join(ctx.modsDir, PACK_NAME), join(ctx.offDir, PACK_NAME)].find((d) => isDir(d) && !isLink(d)) ?? null;
/** Whether the briefing hooks' entry point is the pack's own (the sidebar's briefingEntry.mjs), not am's. */
function packEntry(ctx) {
  const entry = stableBriefingPath(ctx.appHome), dir = sidebarDir(ctx);
  return Boolean(dir) && isFile(entry) && !isLink(entry) && isFile(join(dir, ENTRY_SOURCE)) && readFileSync(entry).equals(readFileSync(join(dir, ENTRY_SOURCE)));
}

/** The CLI's own entries in a sidebar folder: the bin/automagik-herdr wrapper and the .mjs it runs. */
const cliEntries = (ctx, sidebar = PACK_NAME) => ["automagik-herdr", "automagik-herdr.mjs"].map((f) => join(ctx.modsDir, sidebar, "bin", f));
/** Whether the link `link` is the pack's (install.sh link_ours): it points at one of `entries`. */
function linkOurs(link, entries) {
  if (!isLink(link)) return false;
  const to = resolve(dirname(link), readlinkSync(link));
  return entries.includes(to);
}
/** `<binDir>/<name>` linked to the first of `entries` that exists; a file or another link there stays the person's. */
function linkCommand(ctx, name, entries, ours) {
  const link = join(ctx.binDir, name);
  const target = entries.find(isFile);
  if (!target) return { link, done: false, why: "not shipped" };
  if (exists(link) && !isLink(link)) return { link, done: false, why: `${link} is a file, not a link: left alone (remove it, then install again)` };
  if (isLink(link) && !linkOurs(link, ours)) return { link, done: false, why: `${link} points at ${readlinkSync(link)}, not this install: left alone` };
  if (isLink(link) && resolve(dirname(link), readlinkSync(link)) === target) return { link, done: true, changed: false };
  chmodSync(target, statSync(target).mode | 0o111);
  mkdirSync(ctx.binDir, { recursive: true });
  const tmp = join(ctx.binDir, `.${name}.am-tmp-${process.pid}`);
  removePath(tmp, { force: true }); // a leftover tmp link may dangle: unlinked, never followed (#550)
  symlinkSync(target, tmp);
  renameSync(tmp, link);
  return { link, done: true, changed: true };
}
/** The pack's automagik-herdr link removed where it is ours; another is reported. */
function unlinkCommands(ctx) {
  return [CLI_LINK, AM_LINK].flatMap((name) => {
    const link = join(ctx.binDir, name);
    if (linkOurs(link, [...cliEntries(ctx), ...cliEntries(ctx, OLD_PACK_NAME)])) { unlinkSync(link); return [`removed ${link}`]; }
    return exists(link) ? [`left ${link}: it is not this install's`] : [];
  });
}

/**
 * `install <id>`: idempotent. Returns `{ ok, changed, detail }`; throws on a failure.
 * `source` is packSource, called only when the pack itself has to be installed (or the layout read).
 */
export function install(ctx, part, source) {
  let src = null;
  const lazy = () => (src ??= source(ctx));
  try {
    let changed = ensurePack(ctx, lazy);
    const record = readMarker(ctx.modsDir);
    if (!record) throw new Error(`the pack's record ${markerOf(ctx.modsDir)} is missing after the install`);
    if (part.kind === "mod") {
      if (!record.mods.includes(part.mod)) throw new Error(`mods/${part.mod} is not the pack's (a folder of your own is left alone; install.sh --adopt replaces it)`);
      const live = join(ctx.modsDir, part.mod), off = join(ctx.offDir, part.mod);
      if (!exists(live) && exists(off) && !isLink(off)) {
        const r = change(ctx.appHome, [{ op: "move", from: off, to: live }]);
        if (r.refused) throw new Error(r.refused);
        ctx.log(`switched ${part.mod} back on (mods-disabled/ → mods/)`);
        changed = true;
      }
      if (!exists(live)) throw new Error(`mods/${part.mod} is missing: run install.sh again, which repairs the pack`);
      if (part.mod === "am-mods" && mergePackKeys(ctx.appHome, ctx.log)) { ctx.log("added the mod manager's key (cmd-shift-m)"); changed = true; }
      return { ok: true, changed, detail: `${part.mod} is on (pack ${record.version})` };
    }
    if (part.kind === "layout") {
      const live = join(ctx.appHome, PACK_LAYOUT);
      if (!exists(live)) {
        if (record.layout === "removed") record.layout = null;
        const placed = placeLayout({ modsDir: ctx.modsDir, tgzDir: lazy().tree, record, log: ctx.log });
        if (!placed) throw new Error(`the pack ${record.version} ships no ${PACK_LAYOUT}`);
        changed = true;
      }
      return { ok: true, changed, detail: `${live} is in place` };
    }
    // The pack's command, as install.sh links it: a file or another link there stays the person's.
    const cli = linkCommand(ctx, CLI_LINK, cliEntries(ctx), [...cliEntries(ctx), ...cliEntries(ctx, OLD_PACK_NAME)]);
    if (cli.changed) { ctx.log(`linked ${cli.link}`); changed = true; }
    if (!cli.done) ctx.log(cli.why === "not shipped" ? `${join(ctx.modsDir, PACK_NAME, "bin")} has no automagik-herdr command: not linked` : cli.why);
    // am, the same command under its own name (install.sh links both): the same rule. A link into
    // am's own store is am's and stays.
    const amLink = join(ctx.binDir, AM_LINK);
    if (!(isLink(amLink) && within(amLink, amStoreOf(ctx.env)))) {
      const am = linkCommand(ctx, AM_LINK, cliEntries(ctx), [...cliEntries(ctx), ...cliEntries(ctx, OLD_PACK_NAME)]);
      if (am.changed) { ctx.log(`linked ${am.link}`); changed = true; }
      if (!am.done && am.why !== "not shipped") ctx.log(am.why);
    }
    if (!(ctx.env.PATH ?? "").split(":").includes(ctx.binDir)) ctx.log(`add ${ctx.binDir} to your PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
    return { ok: true, changed, detail: `the pack ${record.version} is installed (${record.mods.join(", ")})` };
  } finally {
    src?.cleanup();
  }
}

// ---- uninstall ----

/**
 * The layout Herdr shows, read as install.sh's shown_layout reads it ("layout" in `herdr-app
 * status`), and its tree from <app home>/layouts/<name>.json: `{ name, tree, why }`. `tree` is null
 * and `why` says so when Herdr gives no layout (no herdr-app, Herdr not running), a name that is
 * not a plain file name in layouts/ (a path: never read, #420), or its file is not there or unreadable.
 */
export function shownLayout(ctx) {
  const r = ctx.exec("herdr-app", ["status"], { env: ctx.env, timeout: 10_000 });
  const name = r.code === 0 ? (/"layout"\s*:\s*"([^"]*)"/.exec(r.stdout)?.[1] ?? null) : null;
  if (!name) return { name: null, tree: null, why: r.missing ? "no herdr-app" : "herdr-app status gave no layout: is Herdr running?" };
  if (!/^[^/\\]+$/.test(name) || name === "." || name === "..") {
    return { name, tree: null, why: `Herdr shows the layout "${name}", a name with a path, so no file in ${join(ctx.appHome, "layouts")} was read` };
  }
  const file = join(ctx.appHome, "layouts", `${name}.json`);
  if (!isFile(file)) return { name, tree: null, why: `Herdr shows ${name}, and ${file} is not there` };
  try {
    return { name, tree: JSON.parse(readFileSync(file, "utf8")), why: null };
  } catch (e) {
    return { name, tree: null, why: `${file} is unreadable (${e.message})` };
  }
}

/** What an uninstall says of the pack's layout it leaves in a linked layouts/ (#448; install.sh's line). */
const leftLine = (live) => `left ${live}: ${dirname(live)} is a link, your own folder, not one this install made; the file in it stays yours`;

/** The layout Herdr shows, as layoutSafe.mjs change() asks it. */
const asking = (ctx) => () => shownLayout(ctx);

/** A mod switched off: mods/<m> → mods-disabled/<m>, where Herdr never looks and an update keeps it. */
function switchOff(ctx, part) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  if (!record.mods.includes(part.mod)) return { ok: true, changed: false, detail: `mods/${part.mod} is not the pack's: left alone` };
  const live = join(ctx.modsDir, part.mod), off = join(ctx.offDir, part.mod);
  let changed = false;
  if (isLink(live)) return { ok: true, changed: false, detail: `mods/${part.mod} is a link (a checkout?): left alone` };
  if (exists(live)) {
    if (exists(off)) throw new Error(`${off} is in the way: move it, then uninstall again`);
    // Before a pack mod leaves mods/ (#414), as the mod manager's off and remove (#305): refused while
    // a block of the shown layout names it, since Herdr would drop that layout and show plain Herdr;
    // a right-click menu's mod goes, with a note. With no shown layout to read (shownLayout's `why`),
    // it goes as the mod manager's does (fail open), never silently: each layout in layouts/ whose
    // blocks name it is listed, with what to do if Herdr shows it.
    const r = change(ctx.appHome, [{ op: "move", from: live, to: off, mkdir: true }], {
      ask: asking(ctx), needed: "refuse", unknown: "warn", then: "uninstall it", log: ctx.log,
    });
    if (r.refused) throw new Error(r.refused);
    ctx.log(`switched ${part.mod} off (mods/ → mods-disabled/): an update keeps it off; \`am install ${part.id}\` switches it back on`);
    changed = true;
  }
  if (part.mod === "am-mods" && dropKeys(ctx)) { ctx.log("removed the mod manager's key (cmd-shift-m)"); changed = true; }
  return { ok: true, changed, detail: `${part.mod} is off` };
}

/**
 * The layout out while it is still the pack's copy; the record says removed, so no update adds it back.
 * Refused while Herdr shows it (#430, as the mod manager's package remove, #420): Herdr would drop the
 * layout it shows for plain Herdr. The shown layout's name decides; when it cannot be read
 * (shownLayout's `why`), the layout goes (fail open), and the log says why and how to switch back.
 */
function removeLayout(ctx) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  const live = join(ctx.appHome, PACK_LAYOUT);
  const ref = join(stateDirOf(ctx.modsDir), "automagik.json");
  let changed = false;
  if (isFile(live) && !isLink(live)) {
    if (!isFile(ref) || !readFileSync(live).equals(readFileSync(ref))) {
      return { ok: true, changed: false, detail: `${live} differs from the pack's: it is yours, left as it is` };
    }
    // A live file inside a linked layouts/ is the person's folder: left there (#448).
    const r = change(ctx.appHome, [{ op: "remove", path: live }], { ask: asking(ctx), shownFile: "refuse", links: "hold-layouts", then: "uninstall it" });
    if (r.refused) throw new Error(r.refused);
    const { shown } = r;
    if (r.left.length) {
      ctx.log(leftLine(live));
      return { ok: true, changed: false, detail: `${live} is in a linked layouts/ folder: it is yours, left as it is` };
    }
    ctx.log(shown.name
      ? `removed ${live}`
      : `removed ${live} without knowing the layout Herdr shows (${shown.why}); if Herdr shows it, switch layouts (ctrl-shift-l)${switchCommand(null)}`);
    changed = true;
  }
  if (record.layout !== "removed") { writeMarker(ctx.modsDir, { ...record, layout: "removed" }); changed = true; }
  return { ok: true, changed, detail: "the automagik layout is out" };
}

/**
 * The whole pack out, as install.sh --uninstall does: the record's folders (on or off) leave mods/
 * together as the kept set (with --purge: deleted, with the older set), adopted folders come back,
 * the layout goes while it is the one this install added, the briefing hooks and their entry
 * point go, the pack's keys and its command links go, then the record. Your bots, Herdr's
 * settings (shared.json, data/), Pocket Link and usagemeter stay.
 */
function uninstallPack(ctx, { purge }) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  if (record.v1) throw new Error("this pack was installed by v0.2's installer: run install.sh --uninstall");
  // A linked mods/ (#494) refuses before anything, as install.sh --uninstall does: change() refuses
  // only an op in mods/, and with every pack mod switched off the first batch has none, so the
  // layout and folders would go before an adopted folder's put-back into mods/ is refused.
  if (isLink(ctx.modsDir)) throw new Error(linkedModsLine(resolve(ctx.modsDir), readlinkSync(ctx.modsDir)));
  const state = stateDirOf(ctx.modsDir);
  const prev = prevSetOf(ctx.modsDir);
  const lines = [];
  // Read before the folders move: the hooks and their entry point are the pack's only while the entry
  // point is the sidebar's own; once am's replaces it, they are am's (RFC 0012, D34) and stay.
  const ownEntry = packEntry(ctx);

  const live = join(ctx.appHome, PACK_LAYOUT), ref = join(state, "automagik.json");
  const dropLayout = record.layout === "added" && isFile(live) && !isLink(live) && isFile(ref) && readFileSync(live).equals(readFileSync(ref));
  // The record's folders, wherever they are (mods/, or mods-disabled/ for one switched off).
  const next = fresh(state, ".prev-next-");
  const moved = [];
  const movedOff = [];
  const ops = dropLayout ? [{ op: "remove", path: live }] : [];
  for (const m of record.mods.filter(packFolder)) {
    const on = join(ctx.modsDir, m), off = join(ctx.offDir, m);
    const at = isLink(on) ? null : exists(on) ? on : exists(off) && !isLink(off) ? off : null;
    if (isLink(on)) lines.push(`left ${on}: it is a link, not a folder this install put there`);
    if (!at) continue;
    ops.push({ op: "move", from: at, to: join(next, m) });
    moved.push(m);
    if (at === off) movedOff.push(m);
  }
  // Before anything leaves (#420): refused while the shown layout's blocks name a pack mod in mods/;
  // with no shown layout, each other layout naming one is listed (fail open). Then refused while the
  // layout file this removes is the one Herdr shows, though each mod it names is a link that stays
  // (#450); and the pack's layout inside a linked layouts/, the person's folder, stays there (#448).
  const r = change(ctx.appHome, ops, {
    ask: asking(ctx), needed: "refuse", unknown: "warn", shownFile: "refuse", links: "hold-layouts", then: "uninstall the pack", pack: true,
    skip: dropLayout ? [basename(PACK_LAYOUT)] : [], log: ctx.log, prepare: () => mkdirSync(next, { recursive: true }),
  });
  if (r.refused) throw new Error(r.refused);
  if (dropLayout && r.left.includes(live)) lines.unshift(leftLine(live));
  else if (dropLayout) lines.unshift(`removed ${live}; if Herdr shows it, switch back: herdr-app do layout.switch '{"name":"main"}'`);
  // A folder already kept (one a rollback moved out) stays kept beside them.
  if (moved.length && isFile(join(prev, ".pack"))) {
    const kept = readFileSync(join(prev, ".pack"), "utf8").match(/^mods=(.*)$/m)?.[1].split(",").map((s) => s.trim()).filter(packFolder) ?? [];
    for (const m of kept) {
      if (isDir(join(prev, m)) && !isLink(join(prev, m)) && !exists(join(next, m))) { renameSync(join(prev, m), join(next, m)); moved.push(m); }
    }
  }
  if (moved.length) {
    writeFileSync(join(next, ".pack"), formatMarker({ version: record.version, mods: moved, off: movedOff }));
    const old = fresh(state, ".prev-old-");
    if (exists(prev)) renameSync(prev, old);
    if (purge) {
      rmSync(next, { recursive: true, force: true });
      lines.push(`deleted the pack's folders (${moved.join(", ")}) and their data (--purge)`);
    } else {
      renameSync(next, prev);
      lines.push(`moved the pack out of ${ctx.modsDir} (${moved.join(", ")}); it is kept in ${prev}`);
    }
    removePath(old, { recursive: true, force: true }); // .prev renamed aside, a dangling link too (#566)
  } else {
    rmSync(next, { recursive: true, force: true });
    if (purge && exists(prev)) { removePath(prev, { recursive: true, force: true }); lines.push(`deleted the kept set ${prev} (--purge)`); }
  }

  // What the person had before: each adopted folder comes back where mods/ is free.
  for (const a of record.adopted) {
    const from = join(state, a.path), to = join(ctx.modsDir, a.mod);
    if (isDir(from) && !isLink(from) && !exists(to)) {
      const r = change(ctx.appHome, [{ op: "move", from, to }]);
      if (r.refused) throw new Error(r.refused);
      lines.push(`put back ${to}, the one that was there before the install`);
    }
  }

  if (ownEntry) {
    const hooks = removeHooks(knownProjects(ctx.appHome), { appHome: ctx.appHome, also: ledgerFolders(ctx.appHome), log: ctx.log });
    for (const f of hooks.removed) lines.push(`removed the briefing hook from ${f} (the original is beside it, ${basename(f)}.am-backup…)`);
    for (const s of hooks.skipped) lines.push(`left: ${s.file} (${s.reason})`);
    rmSync(stableBriefingPath(ctx.appHome));
    lines.push(`removed the briefing hook's entry point ${stableBriefingPath(ctx.appHome)}`);
  } else if (isFile(stableBriefingPath(ctx.appHome))) lines.push("left the briefing hooks and their entry point: they are not the pack's");
  if (dropKeys(ctx)) lines.push("removed the pack's keys from keys.json");
  lines.push(...unlinkCommands(ctx));
  rmSync(markerOf(ctx.modsDir), { force: true });
  // The hooks journal is the pack's only while the entry point is; the layout reference always is.
  if (purge) for (const f of [...(ownEntry ? ["hooks-journal.json"] : []), "automagik.json", HELD_FILE]) rmSync(join(state, f), { force: true });
  if (record.usagemeter || Object.keys(record.usagemeterOn).length) {
    lines.push("left usagemeter where it is (~/.local/bin/usagemeter, and linked machines): it is its own part");
  }
  for (const l of lines) ctx.log(l);
  return { ok: true, changed: true, detail: `the pack ${record.version} is uninstalled${purge ? " (--purge)" : ""}; your bots and Herdr's settings are untouched` };
}

/** am's parts store (RFC 0012): `$AM_HOME/parts/`, AM_HOME being $AUTOMAGIK_HOME, else ~/.automagik. */
export const amStoreOf = (env) => join(env.AM_HOME || env.AUTOMAGIK_HOME || join(env.HOME || homedir(), ".automagik"), "parts");
/** `p`'s real path (APFS's own case, through every link), or null when it does not resolve. */
const realOf = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const within = (p, dir) => { const r = realOf(p), d = realOf(dir); return Boolean(r && d) && (r === d || r.startsWith(d + sep)); };

/**
 * What still needs the sidebar's folder, as the reasons it may not be switched off; empty when it may.
 * Read from what is installed, so it lifts by itself once am's copies replace them, and fails closed:
 *   - ~/.local/bin/automagik-herdr resolving into mods/am-sidebar;
 *   - the briefing hooks' entry point not being positively am's: it must resolve into am's parts
 *     store (amStoreOf), or every bot's hook would run the sidebar's briefing.mjs, or nothing;
 *   - a project hook calling mods/am-sidebar/briefing.mjs directly (written when the entry point could
 *     not be placed), wherever syncHooks looks;
 *   - a project hook running through mods/am-sidebar/bin/run.sh (hookCommand's shape, every hook
 *     the pack writes): switched off, that hook runs nothing. It lifts once am runs the hooks
 *     through its own runner (RFC 0012, delivery 3).
 */
export function sidebarCarries(ctx) {
  const reasons = [];
  const folder = join(ctx.modsDir, PACK_NAME);
  // Either name (the pack links both): one reason, naming the first that still runs from the folder.
  const carrying = [CLI_LINK, AM_LINK].map((name) => join(ctx.binDir, name))
    .find((link) => isLink(link) && (within(link, folder) || resolve(dirname(link), readlinkSync(link)).startsWith(folder + sep)));
  if (carrying) reasons.push(`the command (${carrying} runs mods/${PACK_NAME}/bin)`);
  const entry = stableBriefingPath(ctx.appHome);
  if (!within(entry, amStoreOf(ctx.env))) reasons.push(`every bot's briefing (${entry} is not am's: it ${isFile(entry) ? "runs the sidebar's briefing.mjs" : "is missing"})`);
  const direct = hooksRunning(knownProjects(ctx.appHome), { scripts: [join(folder, "briefing.mjs")], also: ledgerFolders(ctx.appHome) });
  if (direct.length) reasons.push(`the briefing hook in ${direct.length} project${direct.length === 1 ? "" : "s"} (${direct.slice(0, 3).join(", ")}${direct.length > 3 ? ", …" : ""} call mods/${PACK_NAME}/briefing.mjs)`);
  const runner = hooksRunning(knownProjects(ctx.appHome), { runners: [join(folder, "bin", "run.sh")], also: ledgerFolders(ctx.appHome) })
    .filter((f) => !direct.includes(f));
  if (runner.length) {
    reasons.push(`the briefing hook in ${runner.length} project${runner.length === 1 ? "" : "s"} (${runner.slice(0, 3).join(", ")}${runner.length > 3 ? ", …" : ""}), which starts through mods/${PACK_NAME}/bin/run.sh: with the sidebar off, that hook would run nothing`);
  }
  return reasons;
}
const carriesText = (reasons) => `mods/${PACK_NAME} still carries ${reasons.join(" and ")}: switched off, they would stop working. `
  + "`am uninstall herdr.pack` removes the whole pack; the sidebar switches off on its own once the am part carries them";

/** `uninstall <id> [--purge]`: idempotent. Returns `{ ok, changed, detail }`; throws on a failure. */
export function uninstall(ctx, part, { purge = false } = {}) {
  if (part.kind === "pack") return uninstallPack(ctx, { purge });
  if (part.kind === "mod") {
    if (part.mod === PACK_NAME && exists(join(ctx.modsDir, PACK_NAME))) {
      const reasons = sidebarCarries(ctx);
      if (reasons.length) throw new Error(carriesText(reasons));
    }
    return switchOff(ctx, part);
  }
  if (part.kind === "layout") return removeLayout(ctx);
  throw new Error(`${part.id} is not a herdr part`);
}

// ---- doctor ----

/** The am part's own store (am/lib/self.mjs storeOf): the parts folder amStoreOf names, then automagik.am. */
const amPartStoreOf = (env) => join(amStoreOf(env), "automagik.am");

/**
 * A project's settings.local.json, read only (installHook writes its briefing hook): { file, text }
 * (text null when the file isn't there) or { file, readError } when it can't be read.
 */
function projectSettings(project) {
  const file = join(project, ".claude", "settings.local.json");
  try { return { file, text: readFileSync(file, "utf8"), readError: null }; } catch (e) {
    return e.code === "ENOENT" ? { file, text: null, readError: null } : { file, text: null, readError: e.message };
  }
}

/**
 * `doctor <id>`: reads only, in well under 30 s (no program runs, no network). Returns
 * `{ code, checks: [{ part, check, ok, detail, fix }] }`: code 0 healthy, 1 broken, 2 not
 * applicable (not macOS, or a mod switched off). `fix` is the exact command, or null.
 */
export function doctor(ctx, part) {
  const checks = [];
  const add = (check, ok, detail, fix = null) => checks.push({ part: part.id, check, ok, detail, fix: ok ? null : fix });
  // Healthy, with a note and the command that changes it: never a reason for am to roll an install back.
  const note = (check, detail, fix = null) => checks.push({ part: part.id, check, ok: true, detail, fix });
  const done = (code) => ({ code: code ?? (checks.every((c) => c.ok) ? 0 : 1), checks });
  if (part.kind === "pack") note("restart-path", "In a Herdr bot pane, restart the session with am restart <bot>, never /restart.");
  const reinstall = `am install ${part.id}`;
  if (ctx.platform !== "darwin") { add("os", true, `not applicable: Automagik Herdr runs on macOS (Herdr is a Mac app); this is ${ctx.platform}`); return done(2); }

  let record = null;
  try { record = readMarker(ctx.modsDir); } catch (e) { add("record", false, `${markerOf(ctx.modsDir)} is unreadable (${e.message})`, reinstall); return done(); }
  if (!record) { add("record", false, `the pack is not installed: ${markerOf(ctx.modsDir)} is missing`, reinstall); return done(); }
  if (record.v1) { add("record", false, "a v0.2 install: the parts need the pack 3.x", "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash"); return done(); }
  add("record", true, `the pack ${record.version} (${record.mods.join(", ")})`);
  if (ctx.version && compareVersions(record.version, ctx.version) !== 0) add("version", false, `the record says ${record.version}, am expects ${ctx.version}`, reinstall);

  if (part.kind === "mod") {
    const m = part.mod, live = join(ctx.modsDir, m), off = join(ctx.offDir, m);
    if (!record.mods.includes(m)) { add("listed", false, `the record does not list ${m}: mods/${m}, if any, is not the pack's`, reinstall); return done(); }
    if (!exists(live) && exists(off)) { add("switched-off", true, `not applicable: ${m} is switched off (${off})`); return done(2); }
    if (isLink(live)) add("folder", true, `mods/${m} is a link (a checkout): not the release's files`);
    else if (!isDir(live)) { add("folder", false, `mods/${m} is missing`, "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash"); return done(); }
    else add("folder", true, live);
    const lacks = ["main.js", "mod.json"].filter((f) => !isFile(join(live, f)));
    add("files", lacks.length === 0, lacks.length ? `mods/${m} has no ${lacks.join(" or ")}` : "main.js and mod.json are there", reinstall);
    if (m === PACK_NAME) {
      const reasons = sidebarCarries(ctx);
      add("switch-off", true, reasons.length ? `it cannot be switched off yet: ${carriesText(reasons)}` : "it can be switched off: no command or briefing runs from its folder");
    }
  }

  if (part.kind === "pack") {
    const dir = sidebarDir(ctx);
    const v = dir ? readVersion(dir) : null;
    add("pack-version", v === record.version, dir ? `${dir}/VERSION is ${v}; the record says ${record.version}` : `mods/${PACK_NAME} is in neither mods/ nor mods-disabled/`, reinstall);
    const gone = record.mods.filter((m) => packFolder(m) && !exists(join(ctx.modsDir, m)) && !exists(join(ctx.offDir, m)));
    add("pack-mods", gone.length === 0, gone.length ? `the record lists ${gone.join(", ")}, in neither mods/ nor mods-disabled/` : "every mod the record lists is there (on or off)",
      "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash");
    const entry = stableBriefingPath(ctx.appHome);
    if (!isFile(entry)) add("briefing-entry", false, `${entry} is missing: the bots' briefing hook finds no briefing`, reinstall);
    else add("briefing-entry", true, packEntry(ctx) ? `${entry} (the pack's)` : `${entry} (not the pack's)`);
    // Which briefing a project's hook runs (installHook writes it): the pack's stable or direct
    // entry, am's own entry on a CLI-only host, or none, said plainly when neither is installed.
    // hookDoctorLine is am self doctor's too, so the two say it the same way; a settings file
    // that can't be read is that project's state, reported without failing the pack's doctor.
    const hook = hookDoctorLine({ ...projectSettings(ctx.project), appHome: ctx.appHome, amStore: amPartStoreOf(ctx.env), isFile });
    add("briefing-hook", hook.ok, hook.detail, hook.repair === "am" ? "am self install" : reinstall);
  }

  if (part.kind === "mod" && part.mod === "am-mods") {
    let keys = {};
    try { keys = isFile(join(ctx.appHome, "keys.json")) ? JSON.parse(readFileSync(join(ctx.appHome, "keys.json"), "utf8")) : {}; } catch (e) {
      add("keys", false, `keys.json is unreadable (${e.message})`, null);
    }
    for (const [section, entries] of Object.entries(PACK_KEYS)) {
      for (const [key, action] of Object.entries(entries)) {
        const now = keys?.[section]?.[key];
        if (now === action) add("keys", true, `${key} opens the mod manager`);
        else if (now !== undefined) add("keys", true, `${key} is yours (${now}): the mod manager has no key`);
        else add("keys", false, `${key} is bound to nothing`, reinstall);
      }
    }
  }

  if (part.kind === "pack") {
    const link = join(ctx.binDir, CLI_LINK);
    const to = isLink(link) ? resolve(dirname(link), readlinkSync(link)) : null;
    if (!exists(link)) add("command", false, `${link} is missing`, reinstall);
    else if (!to) note("command", `${link} is a file of yours, not the pack's link: left alone`, `rm ${link} && ${reinstall}`);
    else if (!cliEntries(ctx).includes(to)) note("command", `${link} points at ${to}, not this install: left alone`, `rm ${link} && ${reinstall}`);
    else add("command", isFile(to), isFile(to) ? `${link} → ${to}` : `${link} points at ${to}, which is gone`, reinstall);
    // am's link, the same command under its own name: a missing one is a notice (an install from
    // before it), never a failure; one of the person's, or am's own, stays.
    const amLink = join(ctx.binDir, AM_LINK);
    const amTo = isLink(amLink) ? resolve(dirname(amLink), readlinkSync(amLink)) : null;
    if (!exists(amLink)) note("am command", `${amLink} is missing`, reinstall);
    else if (amTo && cliEntries(ctx).includes(amTo)) add("am command", isFile(amTo), isFile(amTo) ? `${amLink} → ${amTo}` : `${amLink} points at ${amTo}, which is gone`, reinstall);
    const onPath = (ctx.env.PATH ?? "").split(":").includes(ctx.binDir);
    if (onPath) add("path", true, `${ctx.binDir} is on PATH`);
    else note("path", `${ctx.binDir} is not on PATH: run automagik-herdr by its full path, or add it`, `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
    const nodeOk = compareVersions(ctx.nodeVersion, NODE_MIN) >= 0;
    add("node", nodeOk, `node ${ctx.nodeVersion}${nodeOk ? "" : `: the command needs ${NODE_MIN} or later`}`, "brew install node");
    // DSH as a Herdr agent (dsh-TUI, #561) is opt-in, so its absence is a note, never a broken pack.
    // The dedicated `automagik-herdr dsh-tui doctor` carries the fix commands.
    const dsh = dshTuiPresence({ env: ctx.env });
    note("dsh-tui", dsh.dsh ? `dsh is ${dsh.dsh}` : "dsh is not on this process's PATH: dsh-TUI is skipped (install DSH Desktop or @deepseek-ai/dsh)");
    note("dsh-tui-profile", dsh.profile
      ? `the dsh-tui profile is there${dsh.pinned ? " (pinned to the pack's dsh-TUI)" : " (not the pack's pin)"}${dsh.owned ? " (added by this installer)" : " (not added by this installer)"}`
      : "not installed (opt-in: `am dsh-tui install`)");
    note("dsh-tui-shim", dsh.shimOurs
      ? dsh.shimLegacy
        ? `${dsh.shim} is the earlier release's shim: \`am dsh-tui install\` replaces it`
        : `${dsh.shim} (exec dsh --profile dsh-tui "$@")`
      : dsh.shimExists ? `${dsh.shim} is not this installer's`
        : dsh.profile ? `${dsh.shim} is missing: \`am dsh-tui install\` adds it` : "not installed");
    // Antigravity (#793): a bot or worker on it can't start without agy, and its models come
    // from `agy models`. A note, never a broken pack (agy is the person's install, not am's).
    const agy = programOn(ctx, "agy");
    note("agent-antigravity", agy ? `antigravity (agy) is installed at ${agy}`
      : "antigravity (agy) is not installed: bots and workers on it cannot start until it is (its model list comes from agy models)");
  }

  if (part.kind === "layout") {
    const live = join(ctx.appHome, PACK_LAYOUT), ref = join(stateDirOf(ctx.modsDir), "automagik.json");
    if (!isFile(live)) {
      if (record.layout === "removed") { add("layout", true, "not applicable: the automagik layout was uninstalled"); return done(2); }
      add("layout", false, `${live} is missing`, reinstall);
      return done();
    }
    let parsed = true;
    try { JSON.parse(readFileSync(live, "utf8")); } catch { parsed = false; }
    add("layout-json", parsed, parsed ? `${live} is JSON` : `${live} is not valid JSON`, null);
    const ours = isFile(ref) && readFileSync(live).equals(readFileSync(ref));
    add("layout", true, ours ? `${live} is the pack's` : `${live} is yours (kept: it differs from the pack's ${ref})`);
  }
  return done();
}
