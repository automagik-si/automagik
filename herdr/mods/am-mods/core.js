// Everything the manager does to files, with no dependency on the Herdr runtime: the view passes
// `io` (exec, readText, writeText) so the same code runs under `node --test` against real git.

export const MARKET_TOPIC = "herdr-mod";

// Pocket Link belongs to automagik-pocket (its mod, LaunchAgent and pairing state). This manager
// reads its row and links to that repo's installer; it never installs, updates or removes it —
// a delete here would destroy the pairing key in .state/.
export const POCKET_LINK = "pocket-link";
/** Pocket Link under any spelling: macOS's disk is case-insensitive, so `Pocket-Link` is its folder too. */
export const isPocketLink = (name) => String(name ?? "").toLowerCase() === POCKET_LINK;
/** A mod folder a package may bring: lowercase words and dashes, as update.mjs's packFolder. */
export const MOD_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A layout file a package may bring. */
const LAYOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const lower = (names) => new Set([...names].map((n) => String(n).toLowerCase()));
export const POCKET_LINK_REFUSAL =
  "Pocket Link belongs to automagik-dev/automagik-pocket: install or remove it with that installer. This row is read-only.";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = (appHome) => `${appHome}/automagik-herdr/backup`;
// Beside mods/, on the same file system, where Herdr never loads a mod from.
const stagingDir = (appHome) => `${appHome}/automagik-herdr/staging`;
const present = async (io, path) => (await io.exec("test", ["-e", path])).code === 0;

/**
 * The refusal of a linked mods/ (#494): `mods` is a link to `target`, the person's folder, so the
 * manager moves nothing in or out through it. The words of layoutSafe.mjs linkedModsLine, which
 * this file (inside Herdr, through its io) cannot load.
 */
export const linkedModsLine = (mods, target) => `mods/ (${mods}) is a link to ${target}, your own folder, not one this install made: `
  + "nothing is moved through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again";

/** linkedModsLine while `<appHome>/mods` is a link, else null. */
export async function linkedModsRefusal(io, appHome) {
  const mods = `${appHome}/mods`;
  if ((await io.exec("test", ["-L", mods])).code !== 0) return null;
  return linkedModsLine(mods, (await run(io, "readlink", [mods])).trim());
}

/**
 * Where `<appHome>/layouts` points while it is a link (#511), else null: the person's own folder,
 * so an update moves no layout out of it and writes none into it (as the pack's leaves its layout
 * in a linked layouts/, #448).
 */
export async function linkedLayouts(io, appHome) {
  const layouts = `${appHome}/layouts`;
  if ((await io.exec("test", ["-L", layouts])).code !== 0) return null;
  return (await run(io, "readlink", [layouts])).trim();
}

/**
 * What an install or update says of a linked layouts/ (`target`, linkedLayouts; null: nothing):
 * the record's layouts stay as they are (and stay the record's), and a layout the commit adds is
 * not written. No layout of either: nothing.
 */
export function linkedLayoutsLines({ appHome, target, record, plan }) {
  if (target == null) return [];
  const stay = record?.layouts ?? [];
  const own = lower(stay);
  const added = (plan?.layouts ?? []).filter((l) => !own.has(String(l).toLowerCase()));
  const list = (files) => files.map((f) => `layouts/${f}`).join(", ");
  const parts = [
    ...(stay.length ? [`${list(stay)} ${stay.length === 1 ? "stays as it is" : "stay as they are"}`] : []),
    ...(added.length ? [`${list(added)} ${added.length === 1 ? "was" : "were"} not added`] : []),
  ];
  if (!parts.length) return [];
  return [`layouts/ (${appHome}/layouts) is a link to ${target}, your own folder, not one this install made: nothing is moved or written through it, so `
    + `${parts.join(" and ")}. Put that folder in the link's place (a plain layouts/), then update again for this commit's layouts`];
}

/** Moves a folder or file aside, stamped, and returns where it went: never a delete. */
async function moveAside(io, appHome, path, name) {
  await run(io, "mkdir", ["-p", backupDir(appHome)]);
  const to = `${backupDir(appHome)}/${name}-${stamp()}`;
  await run(io, "mv", [path, to]);
  return to;
}

/**
 * Puts a mod's private state into its staged folder: dot paths and node_modules.
 * A folder's *contents* are copied, not the folder: the package may ship its own `.state/`, and
 * copying `from/.state` onto `to/.state` would nest it as `.state/.state/<key>`. The person's files
 * are copied after the package's, so theirs win. A link (a `.state` kept elsewhere) stays a link
 * to the same place, and a dotfile stays a file.
 */
async function carryPrivate(io, from, to) {
  if (!from) return 0;
  const names = (await run(io, "ls", ["-A", from])).split("\n").filter(Boolean);
  let carried = 0;
  for (const name of names) {
    if (!(name.startsWith(".") || name === "node_modules")) continue;
    const src = `${from}/${name}`, dst = `${to}/${name}`;
    const link = (await io.exec("test", ["-L", src])).code === 0;
    if (!link && (await io.exec("test", ["-d", src])).code === 0) {
      await run(io, "mkdir", ["-p", dst]);
      await run(io, "cp", ["-RP", `${src}/.`, `${dst}/`]);
    } else {
      await run(io, "rm", ["-rf", dst]);
      await run(io, "cp", ["-P", src, dst]);
    }
    carried += 1;
  }
  return carried;
}

// A package is any folder of a repo that holds `mods/<name>/main.js`: the repo root, or one
// folder per package when a repo holds several (`github-panel/mods/github/…`).
export function findPackages(files) {
  const byPrefix = new Map();
  for (const f of files) {
    const m = f.match(/^(?:(.*)\/)?mods\/([^/]+)\/main\.js$/);
    if (!m) continue;
    const prefix = m[1] ?? "";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, mods: [], layouts: [], files: [] });
    byPrefix.get(prefix).mods.push(m[2]);
  }
  for (const pkg of byPrefix.values()) {
    const base = pkg.prefix ? `${pkg.prefix}/` : "";
    pkg.mods.sort();
    pkg.files = files.filter((f) => pkg.mods.some((name) => f.startsWith(`${base}mods/${name}/`)));
    pkg.layouts = files.filter((f) => f.startsWith(`${base}layouts/`) && !f.slice(base.length + 8).includes("/"));
    pkg.recipe = files.includes(`${base}RECIPE.md`);
    pkg.preview = files.includes(`${base}preview.png`);
    pkg.keys = files.includes(`${base}keys.json`);
    pkg.name = pkg.prefix ? pkg.prefix.split("/").at(-1) : pkg.mods.join(" + ");
  }
  return [...byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// What AGENTS.md asks to tell the person before adding a mod: whether it runs programs, reaches
// the network or touches files. A pattern match on the source, so it can only over-report.
const RISKS = [
  ["runs programs", /\bexec\s*\(|\bhc\s*\(|process\.run/],
  ["reaches the network", /\bfetch\s*\(|WebSocket/],
  ["reads files", /readTextFile\s*\(|watchFolder\s*\(|fs\.(readFile|readdir|stat)/],
  ["writes files", /writeTextFile\s*\(|fs\.(writeFile|mkdir|rm|unlink|rename)/],
];

// An alias hides the plain call from a pattern match (`import { exec as sh }`, `const { exec: sh }`),
// so the scan also reads every aliased binding and reports the risk its real name carries.
const RISK_OF = {
  exec: "runs programs", hc: "runs programs", "process.run": "runs programs",
  fetch: "reaches the network", WebSocket: "reaches the network",
  readTextFile: "reads files", watchFolder: "reads files",
  writeTextFile: "writes files",
};
export function aliasedRisks(text) {
  const out = [];
  const parts = (list) => list.split(",").map((x) => x.trim()).filter(Boolean);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from/g)) for (const p of parts(m[1])) {
    const a = /^([\w$.]+)\s+as\s+([\w$]+)$/.exec(p);
    if (a && RISK_OF[a[1]]) out.push(RISK_OF[a[1]]);
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) for (const p of parts(m[1])) {
    const a = /^([\w$.]+)\s*:\s*([\w$]+)$/.exec(p);
    if (a && RISK_OF[a[1]]) out.push(RISK_OF[a[1]]);
  }
  return out;
}

export function scanRisks(sources) {
  const found = new Map();
  const add = (label, path) => {
    if (!found.has(label)) found.set(label, []);
    if (!found.get(label).includes(path)) found.get(label).push(path);
  };
  for (const { path, text } of sources) {
    for (const [label, re] of RISKS) if (re.test(text)) add(label, path);
    for (const label of aliasedRisks(text)) add(label, path);
  }
  return [...found].map(([label, paths]) => ({ label, paths }));
}

async function run(io, cmd, args, opts) {
  const r = await io.exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function repoUrl(fullName) {
  return /^(https?|file|git):|^\//.test(fullName) ? fullName : `https://github.com/${fullName}.git`;
}

// Shallow clone into a fresh folder under `cacheDir`; returns the folder, commit and tracked files.
// With `commit` (the catalog's headCommit) the clone is that commit, not whatever HEAD is now.
export async function fetchSource(io, source, cacheDir, commit = null) {
  const dir = `${cacheDir}/${source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}-${Date.now()}`;
  await run(io, "mkdir", ["-p", cacheDir]);
  await run(io, "git", ["clone", "-q", "--depth", "1", repoUrl(source), dir]);
  if (/^[0-9a-f]{40}$/.test(commit ?? "") && (await run(io, "git", ["-C", dir, "rev-parse", "HEAD"])).trim() !== commit) {
    await run(io, "git", ["-C", dir, "fetch", "-q", "--depth", "1", "origin", commit]);
    await run(io, "git", ["-C", dir, "checkout", "-q", "--detach", commit]);
  }
  const sha = (await run(io, "git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  const files = (await run(io, "git", ["-C", dir, "ls-files"])).split("\n").filter(Boolean);
  return { dir, sha, files };
}

export async function remoteSha(io, source) {
  const out = await run(io, "git", ["ls-remote", repoUrl(source), "HEAD"]);
  return out.split(/\s/)[0] || null;
}

export async function readSources(io, dir, pkg) {
  const texts = [];
  for (const path of pkg.files.filter((f) => /\.(m?js|json)$/.test(f))) {
    texts.push({ path, text: (await io.readText(`${dir}/${path}`)) ?? "" });
  }
  return texts;
}

function parseKeys(text) {
  if (!text) return {};
  const v = JSON.parse(text);
  return v && typeof v === "object" ? v : {};
}

// What installing `pkg` would do, without doing it. `record` is the earlier install of the same
// package (an update): its own mods and layouts are replaced, anything else with the same name is
// a clash and blocks the install, as AGENTS.md never overwrites.
export async function planInstall(io, { appHome, dir, pkg, record, existingMods, existingLayouts }) {
  const base = pkg.prefix ? `${dir}/${pkg.prefix}` : dir;
  // Names compare case-insensitively (macOS's disk does): `Demo` is the person's `demo`.
  const ownMods = lower(record?.mods ?? []);
  const ownLayouts = lower(record?.layouts ?? []);
  const haveMods = lower(existingMods);
  const haveLayouts = lower(existingLayouts);
  const layouts = pkg.layouts.map((f) => f.split("/").at(-1));
  const clashes = [
    ...pkg.mods.filter((m) => !MOD_NAME.test(m) || (haveMods.has(m.toLowerCase()) && !ownMods.has(m.toLowerCase()))).map((m) => `mods/${m}`),
    ...layouts.filter((l) => !LAYOUT_NAME.test(l) || (haveLayouts.has(l.toLowerCase()) && !ownLayouts.has(l.toLowerCase()))).map((l) => `layouts/${l}`),
  ];
  const theirs = pkg.keys ? parseKeys(await io.readText(`${base}/keys.json`)) : {};
  const mine = parseKeys(await io.readText(`${appHome}/keys.json`));
  // A key the package added earlier and the person left alone is the package's to change.
  const ownKeys = new Map((record?.keys ?? []).map((k) => [`${k.section}\u0000${k.key}`, k.action]));
  const keyAdds = [];
  const keyConflicts = [];
  for (const [section, entries] of Object.entries(theirs)) {
    for (const [key, action] of Object.entries(entries ?? {})) {
      const current = mine[section]?.[key];
      const own = ownKeys.get(`${section}\u0000${key}`);
      if (current === undefined || current === action || (own !== undefined && current === own)) {
        if (current !== action) keyAdds.push({ section, key, action });
      } else {
        keyConflicts.push({ section, key, action, current });
      }
    }
  }
  return { base, mods: pkg.mods, layouts, clashes, keyAdds, keyConflicts, risks: scanRisks(await readSources(io, dir, pkg)) };
}

async function writeKeys(io, appHome, change) {
  const path = `${appHome}/keys.json`;
  const keys = parseKeys(await io.readText(path));
  change(keys);
  await io.writeText(path, JSON.stringify(keys, null, 2) + "\n");
}

// Copies the package and adds its keys. Conflicting keys are left as the person has them. Each
// mod is built in a staging folder (the package's files, then the installed copy's private state),
// and only then are the record's old folders moved aside (never deleted) and the staged ones
// renamed in; on any failure every folder goes back where it was, so no half-written mod is left.
// `shown`: the name of the layout Herdr shows, `tree` its tree (shownLayout): a layout is held on
// the name, a mod on the tree (#512); neither read, nothing is held. With layouts/ a link (linkedLayouts, #511) no layout moves or is
// written: the record's stay there and in the record, the commit's new ones are left out.
export async function applyInstall(io, { appHome, plan, source, prefix, sha, record, shown = null, tree = null }) {
  if (plan.clashes.length) throw new Error(`already there: ${plan.clashes.join(", ")}`);
  if ([...plan.mods, ...(record?.mods ?? [])].some(isPocketLink)) throw new Error(POCKET_LINK_REFUSAL);
  const badName = plan.mods.find((m) => !MOD_NAME.test(m)) ?? plan.layouts.find((l) => !LAYOUT_NAME.test(l));
  if (badName) throw new Error(`name refused: ${badName} (mod folders are lowercase, a-z 0-9 -)`);
  // Before anything is staged or moved: nothing goes in or out through a linked mods/ (#494).
  const linked = await linkedModsRefusal(io, appHome);
  if (linked) throw new Error(linked);
  const layoutsLinked = (await linkedLayouts(io, appHome)) != null;
  await run(io, "mkdir", ["-p", `${appHome}/mods`, ...(layoutsLinked ? [] : [`${appHome}/layouts`]), backupDir(appHome), stagingDir(appHome)]);
  const staged = [];
  try {
    for (const m of plan.mods) {
      const stage = `${stagingDir(appHome)}/${m}-${stamp()}`;
      staged.push([m, stage]);
      await run(io, "cp", ["-R", `${plan.base}/mods/${m}`, stage]);
      // The package brings plain files and folders only: a link it ships (a `.state` pointing
      // outside, a dangling dotfile) would be written through or installed as is. Refused, as
      // update.mjs refuses one in a release tarball.
      const odd = (await run(io, "find", [stage, "!", "-type", "f", "!", "-type", "d"])).split("\n").filter(Boolean);
      if (odd.length) throw new Error(`${m}: the package carries a link or special file (${odd[0].slice(stage.length + 1)}): refused`);
      const live = `${appHome}/mods/${m}`;
      if ((record?.mods ?? []).includes(m) && (await present(io, live))) await carryPrivate(io, live, stage);
    }
  } catch (e) {
    for (const [, stage] of staged) await io.exec("rm", ["-rf", stage]);
    throw e;
  }
  // Mods, then layouts, then keys, journalled: a failure anywhere puts every folder and layout
  // back where it was. keys.json is written last, in one write, so a failed write changed nothing
  // and nothing after it can fail.
  const aside = [];
  const placed = [];
  const laid = [];
  // The record's layout Herdr shows (`shown`, its name) that this commit no longer ships stays in
  // layouts/ and in the record (#431): moved aside, Herdr would show plain Herdr. The next update
  // after a switch moves it aside.
  const held = droppedLayouts(record, plan).filter((l) => isShownLayout(shown, l));
  // Its mod twin (#490): a record mod this commit no longer ships that the shown layout's blocks
  // name stays in mods/ and in the record, as it is (a link stays a link). Moved aside, Herdr would
  // drop that layout. The next update after a switch moves it aside.
  const heldMods = heldRetiredMods({ record, plan, shown, tree });
  try {
    for (const m of record?.mods ?? []) {
      if (heldMods.includes(m)) continue;
      const live = `${appHome}/mods/${m}`;
      if (await present(io, live)) aside.push([live, await moveAside(io, appHome, live, m)]);
    }
    for (const [m, stage] of staged) {
      // Only into a free name: `mv` onto an existing folder (any case) would land inside it, and
      // the undo below must reverse only what this run created.
      const dest = `${appHome}/mods/${m}`;
      if (await present(io, dest)) throw new Error(`already there: mods/${m}`);
      await run(io, "mv", [stage, dest]);
      placed.push([dest, stage]);
    }
    for (const l of layoutsLinked ? [] : record?.layouts ?? []) {
      const p = `${appHome}/layouts/${l}`;
      if (held.includes(l)) continue;
      if (await present(io, p)) aside.push([p, await moveAside(io, appHome, p, l)]);
    }
    for (const l of layoutsLinked ? [] : plan.layouts) {
      const to = `${appHome}/layouts/${l}`;
      if (await present(io, to)) throw new Error(`already there: layouts/${l}`);
      laid.push(to);
      await run(io, "cp", [`${plan.base}/layouts/${l}`, to]);
    }
    if (plan.keyAdds.length) {
      await writeKeys(io, appHome, (all) => {
        for (const k of plan.keyAdds) (all[k.section] ??= {})[k.key] = k.action;
      });
    }
  } catch (e) {
    for (const to of laid) await io.exec("rm", ["-f", to]);
    for (const [live, stage] of placed.reverse()) await io.exec("mv", [live, stage]);
    for (const [live, to] of aside.reverse()) await io.exec("mv", [to, live]);
    for (const [, stage] of staged) await io.exec("rm", ["-rf", stage]);
    throw e;
  }
  const keys = [...(record?.keys ?? []).filter((k) => !plan.keyConflicts.some((c) => c.section === k.section && c.key === k.key)), ...plan.keyAdds];
  return {
    source, prefix, sha, mods: [...plan.mods, ...heldMods], layouts: layoutsLinked ? [...(record?.layouts ?? [])] : [...plan.layouts, ...held], keys: dedupeKeys(keys),
    risks: plan.risks.map((r) => r.label), at: new Date().toISOString(),
  };
}

function dedupeKeys(keys) {
  const seen = new Map();
  for (const k of keys) seen.set(`${k.section}\u0000${k.key}`, k);
  return [...seen.values()];
}

export async function checkMods(io, appHome, mods) {
  const failures = [];
  for (const m of mods) {
    const r = await io.exec("herdr-app", ["check", `${appHome}/mods/${m}`]);
    if (r.code !== 0) failures.push({ mod: m, error: (r.stderr || r.stdout).trim() });
  }
  return failures;
}

// Removes what the record says the manager installed. A key is removed only while it still runs
// the action the package added: one the person rebound since then stays. Returns `{ moved }`.
export async function uninstall(io, { appHome, record }) {
  if (record.mods.some(isPocketLink)) throw new Error(POCKET_LINK_REFUSAL);
  // Before any mod, layout or key goes: nothing leaves through a linked mods/ (#494).
  const linked = await linkedModsRefusal(io, appHome);
  if (linked) throw new Error(linked);
  // What it moved aside (`mods/<m>`, `layouts/<l>`), for the line that says so (#512): a record
  // entry already gone from the disk is not in it.
  const moved = [];
  for (const m of record.mods) {
    const p = `${appHome}/mods/${m}`;
    if (await present(io, p)) { await moveAside(io, appHome, p, m); moved.push(`mods/${m}`); }
  }
  for (const l of record.layouts ?? []) {
    const p = `${appHome}/layouts/${l}`;
    if (await present(io, p)) { await moveAside(io, appHome, p, l); moved.push(`layouts/${l}`); }
  }
  if (record.keys?.length) {
    await writeKeys(io, appHome, (all) => {
      for (const k of record.keys) {
        if (all[k.section]?.[k.key] === k.action) delete all[k.section][k.key];
      }
    });
  }
  return { moved };
}

// A mod the manager did not install: a symlink is only unlinked, the folder it points to stays.
export async function removeLocal(io, { appHome, name, symlink, path }) {
  if (isPocketLink(name)) throw new Error(POCKET_LINK_REFUSAL);
  const where = `${appHome}/${path ?? `mods/${name}`}`;
  if (symlink) return void (await run(io, "rm", [where]));   // only the link; the folder it points to stays
  if (await present(io, where)) await moveAside(io, appHome, where, name);
  // The record said this folder was the pack's; it is not any more, so a folder of the person's
  // put at that name is theirs, and the pack's update leaves it alone (#219).
  await forgetPackMod(io, appHome, name);
}

/**
 * The pack installer's record text without `name` in its `mods=` list, every other line as it
 * was; null when it does not list it (nothing to write). Only that one line changes, so
 * `version=`, `layout=`, `before=`, `installed=` and the usagemeter lines stay as they were (#219).
 */
export function packMarkerWithout(text, name) {
  if (typeof text !== "string") return null;
  const m = /^mods=(.*)$/m.exec(text);
  if (!m) return null;                    // a v1 (v0.2.x) marker has no mods= line
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.includes(name)) return null;
  const line = `mods=${names.filter((n) => n !== name).join(",")}`;
  return text.slice(0, m.index) + line + text.slice(m.index + m[0].length);
}

/** Drops `name` from the pack's ownership record after the manager moved its folder out (#219). */
async function forgetPackMod(io, appHome, name) {
  const path = `${appHome}/${PACK_MARKER}`;
  let text = null;
  try { text = await io.readText(path); } catch { return false; }
  const next = packMarkerWithout(text, name);
  if (next == null) return false;
  await io.writeText(path, next);
  return true;
}

// The person's mods folder: Herdr's own (listed in installed.json), the manager's and the rest.
// A mod is on in `mods/`, and off in `mods-disabled/` — beside it, where the app never looks.
export const OFF_DIR = "mods-disabled";
const onOff = (on) => (on ? "mods" : OFF_DIR);

// The pack installer's ownership record (install.sh, am-sidebar/update.mjs): which folders in
// mods/ the Automagik Herdr pack put there, at which release and when. Read here as plain text,
// never imported from am-sidebar (it may be switched off); test/am-mods-list.test.mjs keeps this
// parser equal to am-sidebar/release.js parseMarker for the fields it reads.
export const PACK_MARKER = "automagik-herdr/installed-by-install.sh";
export const PACK_TITLE = "Automagik Herdr";
export const PACK_SOURCE = "automagik-herdr";
export const PACK_REPO = "automagik-dev/automagik";
/** The sidebar folder carries the pack's VERSION and the `automagik-herdr` command. */
export const PACK_CLI = "mods/am-sidebar/bin/automagik-herdr";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parsePackMarker(text) {
  if (typeof text !== "string") return null;
  const get = (key) => (new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "").trim();
  // A v1 marker (v0.2.x, no `mods=`) installed only the sidebar under its old name.
  const mods = /^mods=/m.test(text) ? get("mods").split(",").map((s) => s.trim()).filter(Boolean) : ["spaces-agents"];
  return { version: get("version") || null, mods, installed: ISO_TIME.test(get("installed")) ? get("installed") : null };
}

export async function listMods(io, { appHome, records }) {
  const shipped = Object.keys(parseKeys(await io.readText(`${appHome}/installed.json`)));
  // The pack's own folders: a marker from before `installed=` (v0.5.1 and older) dates the
  // install by the marker file itself; a release folder with no `version=` by the sidebar's VERSION.
  let marker = null;
  try { marker = parsePackMarker(await io.readText(`${appHome}/${PACK_MARKER}`)); } catch {}
  let pack = null;
  if (marker) {
    let at = marker.installed ? Date.parse(marker.installed) : null;
    if (!at) try { at = Number((await run(io, "stat", ["-f", "%m", `${appHome}/${PACK_MARKER}`])).trim()) * 1000 || null; } catch {}
    let version = marker.version;
    if (!version) try { version = String((await io.readText(`${appHome}/mods/am-sidebar/VERSION`)) ?? "").trim() || null; } catch {}
    pack = { mods: new Set(marker.mods), version, installed: at };
  }
  // A folder that isn't there yet is not an error: the first mod turned off creates it.
  const entries = async (dir, on) => {
    try {
      const out = await run(io, "find", [`${appHome}/${dir}`, "-mindepth", "1", "-maxdepth", "1", "(", "-type", "d", "-o", "-type", "l", ")"]);
      return out.split("\n").filter(Boolean).map((path) => ({ path, on }));
    } catch {
      return [];
    }
  };
  const links = new Set();
  for (const dir of ["mods", OFF_DIR]) {
    try {
      const out = await run(io, "find", [`${appHome}/${dir}`, "-mindepth", "1", "-maxdepth", "1", "-type", "l"]);
      for (const p of out.split("\n").filter(Boolean)) links.add(p);
    } catch {}
  }
  const owner = new Map();
  for (const r of records) for (const m of r.mods) owner.set(m, r);
  const found = [...(await entries("mods", true)), ...(await entries(OFF_DIR, false))];
  const mods = [];
  for (const { path, on } of found) {
    const name = path.split("/").at(-1);
    if (name.startsWith(".")) continue;
    // What the files themselves say: a clone names what it came from, an installer leaves a
    // manifest under data/, and the app writes <name>.error when a mod fails to load.
    let meta = {};
    try { meta = JSON.parse((await io.readText(`${path}/mod.json`)) ?? "{}") ?? {}; } catch {}
    let manifest = null;
    try { manifest = JSON.parse((await io.readText(`${appHome}/data/${name}/install-manifest.json`)) ?? "null"); } catch {}
    let changed = null;
    try { changed = Number((await run(io, "stat", ["-f", "%m", path])).trim()) * 1000 || null; } catch {}
    const record = owner.get(name) ?? null;
    // Pack first: the marker lists only folders the pack installer put in mods/ (a person's
    // folder with a pack name is left alone by it, so never listed), switched off or not. A link
    // under a pack name is never the pack's copy (#219): the installer and the updater put plain
    // folders there and leave a link alone (a checkout), so it is the person's, like any link.
    const ofPack = Boolean(pack?.mods.has(name)) && !links.has(path);
    const kind = ofPack ? "pack" : record ? "installed" : on && shipped.includes(name) ? "herdr" : meta.cloned_from ? "clone" : "local";
    mods.push({
      name,
      enabled: on,
      kind,
      pack: ofPack ? { version: pack.version, installed: pack.installed } : null,
      symlink: links.has(path),
      path: `${onOff(on)}/${name}`,
      clone: meta.cloned_from ?? null,
      title: typeof meta.title === "string" ? meta.title : null,
      manifest: manifest && typeof manifest === "object" ? { owner: manifest.owner ?? null, at: manifest.installedAt ?? null } : null,
      changed,
      record,
    });
  }
  return mods.sort(
    (a, b) => (a.kind === "herdr") - (b.kind === "herdr") || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
}

// What one row of the table says, from a listMods entry and its catalog entry (`origin`, matched
// by the catalog's modNames, or null). Pure, so the panel and the tests read the same columns.
export const KIND_LABELS = Object.freeze({
  pack: PACK_TITLE, installed: "marketplace", catalog: "catalog", clone: "clone", local: "local", herdr: "built-in",
});
export const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
const sha7 = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function describeMod(mod, origin = null) {
  // A pack mod is the pack's, whatever the catalog lists under its name.
  const entry = mod.kind === "pack" || mod.kind === "herdr" ? null : origin;
  const kind = mod.kind === "local" && entry ? "catalog" : mod.kind;
  const version = kind === "pack" ? (mod.pack?.version ?? "—")
    : mod.record ? (sha7(mod.record.sha) ? `commit ${sha7(mod.record.sha)}` : "—")
      : mod.clone ? `from ${mod.clone.name}${mod.clone.version ? ` v${mod.clone.version}` : ""}`
        : entry && sha7(entry.headCommit) ? `upstream ${sha7(entry.headCommit)}`
          : "—";
  const source = kind === "pack" ? PACK_SOURCE
    : mod.record ? `${mod.record.source}${mod.record.prefix ? `/${mod.record.prefix}` : ""}`
      : entry ? `${entry.fullName}${entry.path ? `/${entry.path}` : ""}${entry.stars ? ` ★${entry.stars}` : ""}`
        : mod.manifest?.owner ? `${mod.manifest.owner} (installer)`
          : kind === "herdr" ? "Herdr" : "—";
  const at = kind === "pack" ? mod.pack?.installed
    : mod.record?.at ? Date.parse(mod.record.at) : mod.manifest?.at ? Date.parse(mod.manifest.at) : null;
  return { kind, label: mod.enabled ? KIND_LABELS[kind] : "off", version, source, installed: day(at || null), origin: entry };
}

// The table in three groups: the pack's mods (one release, one row each), the person's own
// (marketplace, catalog, clones, local folders) and Herdr's built-in ones, which fold into one
// row unless `builtInOpen`. `rows` is what the panel draws, top to bottom: a group's heading
// (`{ group }`, selectable only for built-in, where enter folds it) then its mods (`{ mod }`).
export function groupMods(mods, { builtInOpen = false } = {}) {
  const pack = mods.filter((m) => m.kind === "pack");
  const herdr = mods.filter((m) => m.kind === "herdr");
  const yours = mods.filter((m) => m.kind !== "pack" && m.kind !== "herdr");
  const version = pack.find((m) => m.pack?.version)?.pack.version ?? null;
  const groups = [
    { key: "pack", title: version ? `${PACK_TITLE} ${version}` : PACK_TITLE, mods: pack, folded: false },
    { key: "yours", title: "Yours", mods: yours, folded: false },
    { key: "herdr", title: "Herdr built-in", mods: herdr, folded: !builtInOpen },
  ].filter((g) => g.mods.length);
  const rows = [];
  for (const g of groups) {
    rows.push({ group: g, selectable: g.key === "herdr" });
    if (!g.folded) for (const m of g.mods) rows.push({ mod: m, selectable: true });
  }
  const off = mods.filter((m) => !m.enabled).length;
  // The header counts what is drawn: one count per group shown, then the mods switched off.
  const named = { pack: PACK_TITLE, yours: "yours", herdr: "built-in" };
  const counts = [...groups.map((g) => `${g.mods.length} ${named[g.key]}`), ...(off ? [`${off} off`] : [])];
  return { groups, rows, counts };
}

// Moves a mod between the two folders; kept off, it is out of the app's sight until moved back.
export async function setEnabled(io, { appHome, name, enabled }) {
  if (!name || /\//.test(name)) throw new Error(`not a mod name: ${name}`);
  // Off means "moved to mods-disabled/", which would strand a pairing key that lives in .state/.
  if (isPocketLink(name)) throw new Error(POCKET_LINK_REFUSAL);
  // On or off, the move goes in or out of mods/: never through a linked one (#494). A switched-off
  // mod is still listed (mods-disabled/ is not the link), so this is reachable from the panel.
  const linked = await linkedModsRefusal(io, appHome);
  if (linked) throw new Error(linked);
  const to = enabled ? "mods" : OFF_DIR;
  await run(io, "mkdir", ["-p", `${appHome}/${to}`]);
  await run(io, "mv", [`${appHome}/${onOff(!enabled)}/${name}`, `${appHome}/${to}/${name}`]);
}

// The mods a layout tree (Herdr's `layout()`, the shown layouts/<name>.json) names. `blocks`: every
// `content.mod` in it (blocks, floating ones, pane headers); Herdr refuses a layout whose block
// names a mod missing from mods/ ("needs mods that aren't here") and shows plain Herdr instead.
// `menu`: the root's `terminal_menu`, which Herdr only warns about and swaps for its own "menu".
export function layoutNeeds(tree) {
  const blocks = new Set();
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (typeof node.content?.mod === "string") blocks.add(node.content.mod);
    for (const value of Object.values(node)) walk(value);
  };
  walk(tree);
  const menu = typeof tree?.terminal_menu === "string" ? tree.terminal_menu : null;
  return { blocks, menu };
}

// Before a mod goes off or out of mods/ (`then`: what the person does after switching, "turn it
// off", "remove it", "uninstall it"): what the shown layout (`name`, `tree`) loses. `refuse` when a
// block names it, since that would drop the whole layout; `note` when it is only the right-click
// menu. am-sidebar/release.js carries a copy for `am uninstall` (test/am-mods-list.test.mjs).
export function layoutGuard({ name, tree, mod, then = "turn it off" }) {
  const { blocks, menu } = layoutNeeds(tree);
  const layout = name ? `the ${name} layout` : "the shown layout";
  if (blocks.has(mod)) {
    return { refuse: `${mod} stays on: ${layout} shows it, and Herdr drops a layout whose mod is off`
      + ` (plain Herdr instead). Switch layouts first (ctrl-shift-l), then ${then}` };
  }
  if (menu === mod) return { note: `${layout}'s right-click menu: Herdr's own menu shows instead` };
  return null;
}

// Before a package's remove (#420): uninstall() moves its own layouts (`layouts`, the record's file
// names) aside, so the one Herdr shows (`name`) would vanish from the screen. `refuse` for that one,
// else null. `then` names what follows the switch (`am uninstall herdr.layout` asks too, #430).
export function packageLayoutGuard({ name, layouts, then = "remove it" }) {
  if (typeof name !== "string" || !name) return null;
  const own = (layouts ?? []).find((l) => typeof l === "string" && l.toLowerCase() === `${name.toLowerCase()}.json`);
  if (!own) return null;
  return { refuse: `the ${name} layout is this package's (layouts/${own}) and Herdr shows it: removing the package takes it away`
    + ` (plain Herdr instead). Switch layouts first (ctrl-shift-l), then ${then}` };
}

/**
 * The layout Herdr shows, for the guards (#512): `name` (`shared("layout")`) and `tree` (`layout()`)
 * as Herdr gave them. The tree decides what a mod's leaving breaks, as layoutGuard reads it; with a
 * name but no tree, the tree is read from layouts/<name>.json (as install.sh and `am uninstall`
 * read the shown layout). Returns `{ name, tree, unread }`: `tree` is null when none was read;
 * `unread` then says why a named layout gave none (checked, and unreadable), and is null when
 * Herdr gave nothing at all (not checked).
 */
export async function shownLayout(io, appHome, { name, tree } = {}) {
  const named = typeof name === "string" && name !== "" ? name : null;
  if (treeRead(tree)) return { name: named, tree, unread: null };
  if (!named) return { name: null, tree: null, unread: null };
  const gave = `Herdr shows the ${named} layout but gave no tree`;
  if (/[/\\]/.test(named) || named === "." || named === "..") return { name: named, tree: null, unread: `${gave}, and its name has a path, so no file in layouts/ was read` };
  let text = null;
  try { text = await io.readText(`${appHome}/layouts/${named}.json`); } catch {}
  if (typeof text !== "string") return { name: named, tree: null, unread: `${gave}, and layouts/${named}.json could not be read` };
  try {
    const read = JSON.parse(text);
    if (treeRead(read)) return { name: named, tree: read, unread: null };
  } catch {}
  return { name: named, tree: null, unread: `${gave}, and layouts/${named}.json does not read` };
}
/** Whether Herdr gave a layout tree: an object holding something (with none shown, `layout()` gives nothing or `{}`). */
const treeRead = (tree) => Boolean(tree) && typeof tree === "object" && Object.keys(tree).length > 0;

/** Whether layouts/`file` is the layout Herdr shows (`name`, case-insensitive as macOS's disk); no name, no. */
export function isShownLayout(name, file) {
  return typeof name === "string" && name !== "" && typeof file === "string" && file.toLowerCase() === `${name.toLowerCase()}.json`;
}

/** The record's layouts an update to `plan` no longer ships (applyInstall moves them aside unless shown). */
export function droppedLayouts(record, plan) {
  const now = lower(plan?.layouts ?? []);
  return (record?.layouts ?? []).filter((l) => !now.has(String(l).toLowerCase()));
}

// After an update (#431): what is said of each layout it no longer ships. `held` (applyInstall kept
// it: Herdr shows it) in the guard's wording; with no shown layout to read (`shown` none), each one
// moved aside is named with that reason (fail open); else nothing (an unshown layout goes quietly).
export function droppedLayoutLines({ dropped, held, shown }) {
  const name = (f) => f.replace(/\.json$/i, "");
  const known = typeof shown === "string" && shown !== "";
  return dropped.flatMap((f) => (held.includes(f)
    ? [`kept layouts/${f}: the ${name(f)} layout is this package's (layouts/${f}) and Herdr shows it; this update no longer ships it,`
      + " and moving it aside would leave plain Herdr. Switch layouts (ctrl-shift-l), and the next update moves it aside"]
    : known ? []
      : [`moved layouts/${f} to the backup folder without knowing the layout Herdr shows (no layout to read; is Herdr running?):`
        + ` this update no longer ships the ${name(f)} layout. Showing it? Switch layouts (ctrl-shift-l)`]));
}

/** The record's mods an update to `plan` no longer ships (applyInstall moves them aside unless shown, #490). */
export function retiredMods(record, plan) {
  const now = lower(plan?.mods ?? []);
  return (record?.mods ?? []).filter((m) => !now.has(String(m).toLowerCase()));
}

/**
 * The retired mods applyInstall keeps in mods/ (#490): those the blocks of the shown layout's tree
 * name (`tree`, shownLayout), whatever its name, as layoutGuard decides (#512). No tree read, none.
 */
export function heldRetiredMods({ record, plan, tree }) {
  const { blocks } = layoutNeeds(tree);
  return retiredMods(record, plan).filter((m) => blocks.has(m));
}

/** The layouts in layouts/ (names, sorted) whose blocks name each of `mods`: `{ mod: [name] }`; one that does not parse names none. */
export async function layoutsNamingMods(io, appHome, mods) {
  const out = Object.fromEntries(mods.map((m) => [m, []]));
  if (!mods.length) return out;
  const files = (await io.exec("ls", [`${appHome}/layouts`])).stdout?.split("\n").filter((f) => f.endsWith(".json")).sort() ?? [];
  for (const f of files) {
    let blocks;
    try { blocks = layoutNeeds(JSON.parse(await io.readText(`${appHome}/layouts/${f}`))).blocks; } catch { continue; }
    for (const m of mods) if (blocks.has(m)) out[m].push(f.slice(0, -".json".length));
  }
  return out;
}

// After an update (#490): what is said of each mod it no longer ships. `held` (applyInstall kept it:
// the shown layout names it) as the pack's update says of a mod it holds; with no tree read
// (shownLayout's `tree` none), each one moved aside is named with the reason and the layouts in
// layouts/ naming it (`naming`, layoutsNamingMods; fail open): `unread` when Herdr named a layout
// whose tree could not be read, else that nothing came from Herdr (#512). A tree read: nothing (a
// mod no shown block names goes quietly).
export function retiredModLines({ retired, held, shown, tree, unread = null, naming = {} }) {
  const layout = typeof shown === "string" && shown !== "" ? `the ${shown} layout` : "the shown layout";
  return retired.flatMap((m) => {
    if (held.includes(m)) {
      return [`kept mods/${m}: this update no longer ships it, but ${layout} shows it, and Herdr drops a layout whose mod is gone`
        + " (plain Herdr instead). Switch layouts (ctrl-shift-l), and the next update moves it aside"];
    }
    if (treeRead(tree)) return [];
    const names = naming[m] ?? [];
    const which = !names.length ? "" : names.length === 1 ? `; the ${names[0]} layout names it` : `; the layouts ${names.join(", ")} name it`;
    return [`moved mods/${m} to the backup folder without knowing the layout Herdr shows (${unread ?? "no layout to read; is Herdr running?"}):`
      + ` this update no longer ships it${which}, and Herdr drops a layout whose mod is gone (plain Herdr instead)`];
  });
}

// After a package's remove (#491): what the guards could not check of the shown layout (`shown`,
// `tree`, `unread`: shownLayout's), so the remove went on (fail open). Said with the reason: the
// package (its source, as the list names it), what uninstall() moved aside (`moved`, its return:
// never a record entry already gone, #512), and the layouts in layouts/ naming its mods (`naming`,
// layoutsNamingMods, read before the move). Three reasons (#512):
// - nothing from Herdr: not checked;
// - a name whose tree could not be read (`unread`): packageLayoutGuard checked the name only;
// - a tree with no name: layoutGuard checked the tree, so only the package's own layouts that
//   moved (one may be the shown one) are said, and nothing when none did.
// A name and a tree read: nothing (the guards checked both).
export function packageRemoveLines({ record, shown, tree, unread = null, moved = [], naming = {} }) {
  const known = typeof shown === "string" && shown !== "";
  if (known && treeRead(tree)) return [];
  const pkg = `${record.source}${record.prefix ? `/${record.prefix}` : ""}`;
  const went = moved.length ? `moved ${moved.join(", ")} to the backup folder` : "nothing of it was left to move";
  if (treeRead(tree)) {
    const layouts = moved.filter((p) => p.startsWith("layouts/"));
    if (!layouts.length) return [];
    return [`removed the package ${pkg} without knowing the name of the layout Herdr shows (Herdr gave its tree, which the remove checked,`
      + ` but not its name): ${went}. If Herdr shows ${layouts.join(" or ")}, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)`];
  }
  const named = record.mods.flatMap((m) => {
    const names = naming[m] ?? [];
    if (!names.length) return [];
    return [names.length === 1 ? `the ${names[0]} layout names ${m}` : `the layouts ${names.join(", ")} name ${m}`];
  });
  const reason = unread ? `${unread}, so the remove checked its name only` : "no layout from Herdr, so the remove could not check it; is Herdr running?";
  return [`removed the package ${pkg} without knowing the layout Herdr shows (${reason}): ${went}${named.length ? `; ${named.join("; ")}` : ""}.`
    + " If Herdr shows the package's layout or one naming its mods, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)"];
}

// After the remove of a mod the manager did not install (#545), as packageRemoveLines says of a
// package: with no tree read of the shown layout (`tree`, `unread`: shownLayout's), layoutGuard had
// nothing to check, so the remove went on (fail open). Said with the reason and the layouts in
// layouts/ naming the mod (`naming`, layoutsNamingMods). A tree read: nothing (the guard checked it).
export function localRemoveLines({ name, tree, unread = null, naming = {} }) {
  if (treeRead(tree)) return [];
  const names = naming[name] ?? [];
  const which = !names.length ? "" : names.length === 1 ? `; the ${names[0]} layout names it` : `; the layouts ${names.join(", ")} name it`;
  const reason = unread ? `${unread}, so the remove could not check it` : "no layout from Herdr, so the remove could not check it; is Herdr running?";
  return [`removed ${name} without knowing the layout Herdr shows (${reason})${which}.`
    + " If Herdr shows a layout naming it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l)"];
}

// GitHub search for the topic, as herdr.dev lists Community. `gh api` carries the person's login
// (30 searches a minute instead of 10); without `gh`, `anonymous(url)` fetches the same URL.
export async function searchMarket(io, { query = "", sort = "stars", page = 1, perPage = 50 }, anonymous) {
  const q = `topic:${MARKET_TOPIC}${query.trim() ? ` ${query.trim()}` : ""}`;
  const params = { q, sort, order: "desc", per_page: String(perPage), page: String(page) };
  let body = null;
  let ghError = null;
  try {
    const args = ["api", "-X", "GET", "search/repositories"];
    for (const [k, v] of Object.entries(params)) args.push("-f", `${k}=${v}`);
    const r = await io.exec("gh", args);
    if (r.code === 0) body = JSON.parse(r.stdout);
    else ghError = (r.stderr || r.stdout).trim();
  } catch (e) {
    ghError = String(e?.message ?? e);
  }
  if (!body) {
    const url = `https://api.github.com/search/repositories?${new URLSearchParams(params)}`;
    const res = await anonymous(url);
    if (res.status !== 200) {
      const msg = (() => { try { return JSON.parse(res.text).message; } catch { return res.text.slice(0, 120); } })();
      throw new Error(`GitHub answered ${res.status}: ${msg}${ghError ? ` (gh: ${ghError})` : ""}`);
    }
    body = JSON.parse(res.text);
  }
  return {
    total: Math.min(body.total_count ?? 0, 1000),
    items: (body.items ?? []).map((r) => ({
      fullName: r.full_name,
      description: r.description ?? "",
      stars: r.stargazers_count ?? 0,
      pushedAt: r.pushed_at,
      url: r.html_url,
    })),
  };
}

// ---- the official catalog (herdr.dev/mods) ----

// Our marketplace: this pack publishes its own index (herdr/catalog/index.json in the Automagik
// monorepo, same shape as herdr.dev's), and an installed copy may point anywhere via
// data/am-mods/catalog.json. The pack publishes from `dev`. Kept equal to
// mods/am-sidebar/release.js's CATALOG_URL (and PACK_URLS to its PACK_CATALOG_URLS) by
// test/pack-installer.test.mjs; an installed copy can override it via data/am-mods/catalog.json.
export const CATALOG_URL = "https://raw.githubusercontent.com/automagik-dev/automagik/dev/herdr/catalog/index.json";

/** The commit the catalog pins for `source` (its `headCommit`), or null: an install fetches that commit. */
export function catalogCommit(catalog, source) {
  for (const entry of catalog?.byMod?.values() ?? []) {
    if (entry?.fullName === source && /^[0-9a-f]{40}$/.test(entry.headCommit ?? "")) return entry.headCommit;
  }
  return null;
}

export function parseCatalog(json) {
  const mods = Array.isArray(json?.mods) ? json.mods : [];
  const byMod = new Map();
  for (const entry of mods) {
    for (const name of entry.modNames ?? []) if (!byMod.has(name)) byMod.set(name, entry);
  }
  return { generatedAt: json?.generatedAt ?? null, count: mods.length, byMod };
}

// Where the index is: the pack's installer writes data/am-mods/catalog.json ({ url }); an install
// from before the rename has data/mod-manager/'s, copied to data/am-mods/ by the rename migration
// and read as the fallback; the mod's own catalog.json is the copy in a checkout,
// and the published index is the fallback. A URL the person set wins wherever it is, the most
// recently changed one when both data folders hold one (else data/am-mods first): a copy still
// holding a URL the pack wrote never shadows it, and reads the current index (CATALOG_URL), not an
// older one the pack wrote (automagik-herdr's, before the pack moved into the monorepo). A local
// path (no URL scheme) whose file is gone counts as not set, so a renamed or removed checkout
// falls back to the published index.
export const PACK_URLS = Object.freeze([
  CATALOG_URL,
  "https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/catalog/index.json",
  "https://raw.githubusercontent.com/automagik-dev/automagik-herdr/dev/catalog/index.json",
  "https://raw.githubusercontent.com/automagik-dev/automagik-herdr/main/catalog/index.json",
]);
export const isLocalCatalogPath = (url) => !/^[a-z][a-z0-9+.-]*:/i.test(url);
export async function catalogUrl(io, appHome) {
  const found = [];
  for (const path of [`${appHome}/data/am-mods/catalog.json`, `${appHome}/data/mod-manager/catalog.json`, `${appHome}/mods/am-mods/catalog.json`]) {
    try {
      const raw = await io.readText(path);
      const url = raw ? JSON.parse(raw)?.url : null;
      if (typeof url !== "string" || !url) continue;
      if (isLocalCatalogPath(url)) {
        let text = null;
        try { text = await io.readText(url); } catch {}
        if (!text) continue;
      }
      found.push({ path, url });
    } catch {}
  }
  const mine = found.filter((f) => !PACK_URLS.includes(f.url));
  if (mine.length >= 2 && !mine[1].path.includes("/mods/")) {
    try {
      const newer = await io.exec("sh", ["-c", '[ "$1" -nt "$2" ]', "sh", mine[1].path, mine[0].path]);
      if (newer?.code === 0) return mine[1].url;
    } catch {}
  }
  return mine[0]?.url ?? CATALOG_URL;
}

export async function fetchCatalog(io, http, url = CATALOG_URL) {
  // A checkout points at its own file; a published index is fetched.
  if (!/^https?:\/\//.test(url)) {
    const text = await io.readText(url);
    if (!text) throw new Error(`no mods index at ${url}`);
    return parseCatalog(JSON.parse(text));
  }
  const res = await http(url);
  if (res.status !== 200) throw new Error(`mods index: HTTP ${res.status} (${url})`);
  return parseCatalog(JSON.parse(res.text));
}

// Where a catalog entry keeps a mod's files: `path` is the folder a multi-mod repo nests it in.
export const catalogPath = (entry) => (entry.path ? `${entry.path}/` : "");

// What changed between the installed folder and the catalog's head commit: file by file, hashed
// on both sides. `dir` is a checkout of the repo at that commit.
export async function drift(io, { appHome, dir, entry, name, localPath }) {
  const root = `${dir}/${catalogPath(entry)}mods/${name}`;
  const local = `${appHome}/${localPath}`;
  // The app writes its own files into every mod folder; they are not part of anyone's package.
  const SKIP = /^(gpui-kit\.d\.ts|jsconfig\.json|node_modules\/.*|\..*)$/;
  const list = async (at) =>
    (await run(io, "find", [at, "-type", "f"])).split("\n").filter(Boolean)
      .map((p) => p.slice(at.length + 1)).filter((f) => !SKIP.test(f));
  const hash = async (at, files) => {
    const out = new Map();
    if (!files.length) return out;
    const sums = await run(io, "shasum", ["-a", "256", ...files.map((f) => `${at}/${f}`)]);
    for (const line of sums.split("\n").filter(Boolean)) {
      const cut = line.indexOf("  ");
      if (cut < 0) continue;
      out.set(line.slice(cut + 2).slice(at.length + 1), line.slice(0, cut));
    }
    return out;
  };
  const [theirs, mine] = await Promise.all([list(root), list(local)]);
  const [theirsHash, mineHash] = await Promise.all([hash(root, theirs), hash(local, mine)]);
  let changed = 0, added = 0, removed = 0;
  for (const [file, sum] of mineHash) {
    if (!theirsHash.has(file)) added += 1;
    else if (theirsHash.get(file) !== sum) changed += 1;
  }
  for (const file of theirsHash.keys()) if (!mineHash.has(file)) removed += 1;
  return { changed, added, removed, mine: mine.length, theirs: theirs.length, clean: !changed && !added && !removed, at: new Date().toISOString() };
}
