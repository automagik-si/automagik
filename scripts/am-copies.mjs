#!/usr/bin/env node
/**
 * am's copies of the pack's CLI, briefing and Pocket Link (RFC 0012, "The am part"). The pack stays the source:
 * am/ carries byte-equal copies of herdr/mods/am-sidebar's CLI (bin/automagik-herdr.mjs and its
 * wrapper), the briefing (briefing.mjs, briefingEntry.mjs), run.sh and every module they import,
 * at the same relative paths so each import resolves unchanged, plus the trust anchors am carries
 * (pack-keys.json, meter-keys.json, the plugin lane's keys). At run time am reads nothing from the pack's folders.
 *
 * The list is not kept by hand: it is the import closure of ROOTS inside the sidebar, plus EXTRA.
 * am/copies.json records what --write copied, so a module the CLI stops importing is removed.
 *
 *   node scripts/am-copies.mjs --check   exit 1, naming each file, when a copy drifted, is missing or is stale
 *   node scripts/am-copies.mjs --write   copy them (and remove stale ones)
 *
 * Plain Node (22.7+), no dependencies: herdr's gate runs --check, so a herdr PR that drifts fails
 * in its own CI. Apache-2.0.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "herdr/mods/am-sidebar";
export const TARGET = "am";
export const POCKET_SOURCE = "herdr/mods/pocket-link";
export const POCKET_TARGET = "am/pocket/link";
const POCKET_EXTRAS = ["bridge/package.json", "bridge/package-lock.json", "chat/package.json",
  "LICENSE", "chat/LICENSE-upstream", "chat/UPSTREAM.md"];
export const RECORD = "am/copies.json";
export const WRITE = "node scripts/am-copies.mjs --write";
/** The entry points whose import closure am copies, inside SOURCE. */
export const ROOTS = ["bin/automagik-herdr.mjs", "bin/accounts.mjs", "briefing.mjs", "briefingEntry.mjs"];
/** Copied too, though nothing imports them: [from (repository path), to (repository path)]. */
export const EXTRA = [
  [`${SOURCE}/bin/automagik-herdr`, `${TARGET}/bin/automagik-herdr`],
  [`${SOURCE}/bin/run.sh`, `${TARGET}/bin/run.sh`],
  [`${SOURCE}/bin/hc-socket-mask.mjs`, `${TARGET}/bin/hc-socket-mask.mjs`],
  [`${SOURCE}/hcPane.mjs`, `${TARGET}/hcPane.mjs`],
  [`${SOURCE}/hcProxy.mjs`, `${TARGET}/hcProxy.mjs`],
  [`${SOURCE}/guard/hc`, `${TARGET}/guard/hc`],
  [`${SOURCE}/hc-kill/hc`, `${TARGET}/hc-kill/hc`],
  [`${SOURCE}/hcGuard.mjs`, `${TARGET}/hcGuard.mjs`],
  [`${SOURCE}/pack-keys.json`, `${TARGET}/pack-keys.json`],
  [`${SOURCE}/meter-keys.json`, `${TARGET}/meter-keys.json`],
  ["plugin-lane/keys.json", `${TARGET}/plugin-lane-keys.json`],
];

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The relative imports of `roots` (paths inside `dir`), followed through every file they reach. */
export function closure(dir, roots = ROOTS) {
  const seen = new Set();
  const queue = roots.map((p) => resolve(dir, p));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (!existsSync(file)) throw new Error(`${relative(ROOT, file)} is imported but does not exist`);
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) queue.push(resolve(dirname(file), m[1]));
  }
  for (const file of seen) {
    if (relative(dir, file).startsWith("..")) throw new Error(`${relative(ROOT, file)} is outside ${relative(ROOT, dir)}: am cannot copy it`);
  }
  return [...seen].map((f) => relative(dir, f)).sort();
}

/** Every copy as [from, to], repository paths: once each, when an EXTRA is also imported (hcGuard.mjs). */
export function copies(root = ROOT) {
  const inside = closure(join(root, SOURCE)).map((p) => [`${SOURCE}/${p}`, `${TARGET}/${p}`]);
  inside.push(...[...closure(join(root, POCKET_SOURCE), ["bridge/bridge.mjs"]), ...POCKET_EXTRAS]
    .map(p => [`${POCKET_SOURCE}/${p}`, `${POCKET_TARGET}/${p}`]));
  const imported = new Set(inside.map(([, to]) => to));
  return [...inside, ...EXTRA.filter(([, to]) => !imported.has(to))].sort((a, b) => a[1].localeCompare(b[1]));
}

const recorded = (root) => { try { return JSON.parse(readFileSync(join(root, RECORD), "utf8")).files ?? []; } catch { return []; } };
const recordText = (list) => `${JSON.stringify({ note: `Written by ${WRITE}; do not edit. Each is a byte-equal copy (RFC 0012).`, files: list.map(([from, to]) => ({ from, to })) }, null, 2)}\n`;

/** What is wrong with am's copies: one line per file, empty when all match. */
export function problems(root = ROOT) {
  const list = copies(root);
  const out = [];
  for (const [from, to] of list) {
    const a = join(root, from);
    const b = join(root, to);
    if (!existsSync(b)) out.push(`${to} is missing (a copy of ${from})`);
    else if (!readFileSync(a).equals(readFileSync(b))) out.push(`${to} differs from ${from}`);
    else if ((statSync(a).mode & 0o111) !== (statSync(b).mode & 0o111)) out.push(`${to}'s executable bits differ from ${from}'s`);
  }
  const wanted = new Set(list.map(([, to]) => to));
  for (const { to } of recorded(root)) if (!wanted.has(to)) out.push(`${to} is a stale copy: nothing am copies imports it now`);
  let record = null;
  try { record = readFileSync(join(root, RECORD), "utf8"); } catch { /* missing */ }
  if (record !== recordText(list)) out.push(`${RECORD} does not list exactly these copies`);
  return out;
}

/** Copies every file, removes stale ones, writes the record; returns the files it changed. */
export function write(root = ROOT) {
  const list = copies(root);
  const changed = [];
  for (const [from, to] of list) {
    const a = join(root, from);
    const b = join(root, to);
    if (existsSync(b) && readFileSync(a).equals(readFileSync(b)) && statSync(a).mode === statSync(b).mode) continue;
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(a, b);
    chmodSync(b, statSync(a).mode & 0o777);
    changed.push(to);
  }
  const wanted = new Set(list.map(([, to]) => to));
  for (const { to } of recorded(root)) if (!wanted.has(to)) { rmSync(join(root, to), { force: true }); changed.push(to); }
  const text = recordText(list);
  let before = null;
  try { before = readFileSync(join(root, RECORD), "utf8"); } catch { /* missing */ }
  if (before !== text) { writeFileSync(join(root, RECORD), text); changed.push(RECORD); }
  return changed;
}

const invoked = (() => { try { return resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invoked) {
  const [flag] = process.argv.slice(2);
  if (flag === "--check") {
    const found = problems();
    if (found.length) {
      for (const line of found) console.error(`am copies: ${line}`);
      console.error(`am copies: am/ carries byte-equal copies of the pack's CLI and briefing and Pocket Link (RFCs 0012 and 0046). Run \`${WRITE}\` and commit am/.`);
      process.exit(1);
    }
    console.log(`am copies: ${copies().length} files match ${SOURCE} and ${POCKET_SOURCE}`);
  } else if (flag === "--write") {
    const changed = write();
    console.log(changed.length ? `am copies: wrote ${changed.join(", ")}` : "am copies: nothing to write");
  } else {
    console.error("usage: node scripts/am-copies.mjs --check | --write");
    process.exit(2);
  }
}
