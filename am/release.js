// Automagik Herdr's releases over plain data (A14): which GitHub release is newer than the
// installed pack, which files it must carry, and the timing of the mod's check. Taken from
// Automagik's desktop updater (apps/desktop/src/update.js: compareVersions, pickUpdate, the
// 4-hour timing). Pure: no `herdr` and no `node:` imports, so the mod, the CLI and
// `node --test` share it; the download, checksum and swap live in update.mjs. Apache-2.0.
//
// The pack lives in the Automagik monorepo (herdr/) and ships on its releases, `v<version>` with
// the monorepo's one version (docs/rfcs/0011-monorepo-parts-and-releases.md there). A release
// carries the pack only when herdr/ changed since the one before, so the newest pack is named by a
// signed pointer, as plugin-lane names the plugins: the rolling `herdr-lane` release holds pack.json
// (the newest pack release, its tarball and that tarball's sha256) and pack.json.sig (ed25519 over
// its exact bytes, base64), checked against the keys this pack carries (pack-keys.json). The
// signature is checked in update.mjs and install.sh (node:crypto); this file only reads the pointer.

export const REPO = "automagik-dev/automagik";
/** The rolling release that names the newest pack, and its two files. */
export const LANE_RELEASE = "herdr-lane";
export const POINTER_URL = `https://github.com/${REPO}/releases/download/${LANE_RELEASE}/pack.json`;
export const POINTER_SIG_URL = `${POINTER_URL}.sig`;
export const POINTER_SCHEMA = 1;
/** The public keys this pack trusts for the pointer, beside this file: `{ keys: [{ keyId, publicKey (PEM) }] }`. */
export const PACK_KEYS_FILE = "pack-keys.json";
/** Where the pack lived until v0.14.x; the monorepo's release of it is the first above 3.0.0. */
export const OLD_REPO = "automagik-dev/automagik-herdr";
/** The folder that carries the pack's VERSION, update.mjs and the CLI. */
export const PACK_NAME = "am-sidebar";
/**
 * That folder's name before the rename (v0.2.0 to v0.4.x): what a v1 marker installed, where an
 * older install keeps its CLI, its first pack (`<name>.before-install`) and its briefing. Kept
 * here, not imported from migrate.js, because release.yml imports this file on its own.
 */
export const OLD_PACK_NAME = "spaces-agents";
/**
 * Every mod folder the pack ships (D3, D10): the tarball's top level is exactly these plus
 * `layouts/automagik.json`, and release.yml asserts it. It ships inside the tarball it checks, so
 * it guards against packaging bugs, not tampering (the signed pointer covers that). Pocket
 * Link is never one of them: Pocket owns it.
 */
export const PACK_MODS = Object.freeze(["am-automations", "am-footer", "am-markdown", "am-mods", "am-new-menu", "am-quota",
  "am-sidebar", "am-status", "am-tabs"]);
export const POCKET_LINK = "pocket-link";
/**
 * Pack mods that ship switched off: the first time one arrives (a fresh install, or an update
 * from a release that did not ship it) it goes to <app home>/mods-disabled/, where Herdr never
 * looks, and the person turns it on in the Mods panel. A copy already installed keeps its state,
 * on or off. am-quota is a personal tool for people who run their own CLIProxyAPI.
 * am-automations needs the herdr-automations scheduler. install.sh puts the build the pack pins in
 * ~/.local/bin (#220); the pack's own updater does not, so the panel still ships off, and names
 * what is missing with the command that installs it (Copy, or Install).
 */
export const OFF_BY_DEFAULT = Object.freeze(["am-automations", "am-quota"]);
/**
 * Where install.sh and `automagik-herdr meter install` get usagemeter, the shared binary at
 * ~/.local/bin/usagemeter (Group 6c; Pocket Link runs it too, so it is never downgraded): the
 * signed pointer on this repository's rolling `lane` release names the newest build, per target
 * with its sha256 (meterLane.mjs checks it against meter-keys.json; RFC 0017 delivery 6). No version
 * or hash is pinned here any more.
 */
export const USAGEMETER = Object.freeze({ repo: "automagik-dev/automagik", lane: "meter-lane" });
/** The one layout the pack ships, beside the mod folders in the tarball. */
export const PACK_LAYOUT = "layouts/automagik.json";

// `am uninstall herdr.<mod>` (parts.mjs switchOff) asks the shown layout as the mod manager does
// before a mod goes off or out (#305, #414): these two are mods/am-mods/core.js's, byte for byte (a
// test keeps them equal), since the pack's entries never load another mod's files. `layoutNeeds`:
// the mods a layout tree names, `blocks` (Herdr drops a layout whose block names a mod missing from
// mods/) and the root's `terminal_menu` (Herdr only warns and shows its own menu). `layoutGuard`:
// `refuse` for a block's mod, `note` for the menu's, null for the rest.
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

// `am uninstall herdr.layout` (parts.mjs removeLayout, #430) asks as the mod manager's package remove
// does (#420): core.js's packageLayoutGuard, byte for byte (the same test keeps it equal).
export function packageLayoutGuard({ name, layouts, then = "remove it" }) {
  if (typeof name !== "string" || !name) return null;
  const own = (layouts ?? []).find((l) => typeof l === "string" && l.toLowerCase() === `${name.toLowerCase()}.json`);
  if (!own) return null;
  return { refuse: `the ${name} layout is this package's (layouts/${own}) and Herdr shows it: removing the package takes it away`
    + ` (plain Herdr instead). Switch layouts first (ctrl-shift-l), then ${then}` };
}

/**
 * What an update says of a mod it held in mods/ because a layout names it (update.mjs applyUpdate
 * `held`, #420): in its log, in `automagik-herdr update` and in the notice after an install. `renamed`:
 * a rename's old folder, held while a layout the migration cannot move names it (#432); with `gone`,
 * one already out of mods/ (an update before #432 retired it), so that layout shows plain Herdr.
 */
export function heldModLine({ mod, renamed, gone, layouts }, version) {
  if (typeof renamed !== "string") {
    const which = layouts.length === 1 ? `the ${layouts[0]} layout shows it` : `the layouts ${layouts.join(", ")} show it`;
    return `Kept mods/${mod}: ${version} no longer ships it, but ${which}, and Herdr drops a layout whose mod is gone (plain Herdr instead). `
      + "Take its block out of each of those layouts, or remove them, and the next update retires it. "
      + "Switching layouts does not retire it: every file in layouts/ is scanned.";
  }
  const which = layouts.length === 1 ? `the ${layouts[0]} layout still names it` : `the layouts ${layouts.join(", ")} still name it`;
  if (gone === true) {
    return `mods/${mod} is gone (it is ${renamed} now), but ${which}, and ${version} cannot rewrite it (a link, or a shape it does not read), `
      + `so Herdr shows plain Herdr instead of it. Name ${renamed} in each of them, or take the block out.`;
  }
  return `Kept mods/${mod} beside mods/${renamed}: ${which}, ${version} cannot rewrite it (a link, or a shape it does not read), `
    + `and Herdr drops a layout whose mod is gone (plain Herdr instead). The copy kept is the earlier release's code and gets no `
    + `updates while it is held. Name ${renamed} in each of them, or take the block out, and the next update retires mods/${mod}.`;
}

/** sha256 of the bots-only layout v0.2.0–v0.2.2 installed: only that copy is replaced (D8). */
export const V020_LAYOUT_SHA256 = "5a479f72db788826acb2413df7d32721fbbb9fd070caaf1c7096c6b84778a8a3";
/** The pack's keys (the repository's keys.json, which a test keeps equal): merged only where free. */
export const PACK_KEYS = Object.freeze({ global: Object.freeze({ "cmd-shift-m": "mod.open:am-mods" }) });
/** What the mod manager lists; mods/am-mods/core.js's CATALOG_URL is kept equal by a test. */
export const CATALOG_URL = "https://raw.githubusercontent.com/automagik-dev/automagik/dev/herdr/catalog/index.json";
/**
 * Every catalog URL a pack has written (the current one first): the monorepo's on `main`, and the
 * old repository's on `dev` and `main`. A copy holding one of them is the pack's to rewrite; any
 * other URL is the person's. core.js keeps the same list (a test keeps them equal).
 */
export const PACK_CATALOG_URLS = Object.freeze([
  CATALOG_URL,
  "https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/catalog/index.json",
  `https://raw.githubusercontent.com/${OLD_REPO}/dev/catalog/index.json`,
  `https://raw.githubusercontent.com/${OLD_REPO}/main/catalog/index.json`,
]);
/** The pack's tarball on release `version` (release.yml's "Pack the herdr pack" step). */
export const tarballName = (version) => `automagik-herdr-pack-${version}.tgz`;
/** Its sha256, `sha256sum` output for the tarball alone, beside it on the same release (for --version). */
export const sumsName = (version) => `${tarballName(version)}.sha256`;

/**
 * The installer's ownership record (`<app home>/automagik-herdr/installed-by-install.sh`) as data.
 * v2: `version=`, `mods=<comma list>`, `layout=added|kept|removed` (removed: `am uninstall herdr.layout`
 * took it out, and no install or update puts it back), `before=kept|none`, and
 * `adopted=<mod>:<path under automagik-herdr/>,…` for folders moved to backup/ on --adopt, and
 * `migrated=backup/<name>,…`, the rename migration's journals (oldest first) that a rollback across
 * the rename reverts, `installed=<ISO time>` when update.mjs last put the pack's folders in place
 * (the mod manager's INSTALLED column; am-mods/core.js parsePackMarker reads it too),
 * `sequence=<n>`, the signed pointer's sequence when the installed release came through it
 * (install.sh refuses an older pointer), `off=<mods>` in a kept set's .pack only: the folders it
 * holds that were switched off (mods-disabled/) when kept, so a rollback puts them back off,
 * `usagemeter=<version>` when install.sh put the usagemeter binary in ~/.local/bin (--uninstall
 * removes only that one), `usagemeter-sequence=<n>` the highest meter-lane pointer sequence this
 * install took (a lower one is refused), `usagemeter-machines=<machine>:<version>,…` for the linked machines the
 * pack put it on (meterFleet.js), and `usagemeter-scope=all|local|none`, what the person chose
 * (install.sh: all by default, local with --usagemeter-local-only, none with --no-usagemeter;
 * `automagik-herdr meter install` sets all, or local with --local). An older install.sh wrote no
 * scope, not even for --no-usagemeter: meterFleet.js meterScope reads that as local when it shows
 * `usagemeter=`, else as "not asked"; never as all. A v1 marker (v0.2.x: no `mods=`) installed only OLD_PACK_NAME.
 */
/** Where an adopted folder may be kept: `backup/<name>`, a plain name (install.sh checks the same). */
export const ADOPTED_PATH = /^backup\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseMarker(text) {
  if (typeof text !== "string") return null;
  const get = (key) => (new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "").trim();
  const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);
  const v1 = !/^mods=/m.test(text);
  return {
    v1,
    version: get("version") || null,
    mods: v1 ? [OLD_PACK_NAME] : list(get("mods")),
    layout: get("layout") || null,
    before: get("before") || "none",
    adopted: list(get("adopted")).map((e) => ({ mod: e.slice(0, e.indexOf(":")), path: e.slice(e.indexOf(":") + 1) }))
      .filter((a) => /^[a-z0-9][a-z0-9-]*$/.test(a.mod) && a.mod !== POCKET_LINK && ADOPTED_PATH.test(a.path)),
    migrated: list(get("migrated")).filter((p) => ADOPTED_PATH.test(p)),
    installed: ISO_TIME.test(get("installed")) ? get("installed") : null,
    usagemeter: /^\d+\.\d+\.\d+$/.test(get("usagemeter")) ? get("usagemeter") : null,
    usagemeterSequence: /^\d{1,15}$/.test(get("usagemeter-sequence")) ? Number(get("usagemeter-sequence")) : null,
    usagemeterOn: Object.fromEntries(list(get("usagemeter-machines")).map((e) => [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)])
      .filter(([m, v]) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m) && /^\d+\.\d+\.\d+$/.test(v))),
    usagemeterScope: ["all", "local", "none"].includes(get("usagemeter-scope")) ? get("usagemeter-scope") : null,
    sequence: /^\d{1,15}$/.test(get("sequence")) ? Number(get("sequence")) : null,
    off: list(get("off")).filter((m) => /^[a-z0-9][a-z0-9-]*$/.test(m) && m !== POCKET_LINK),
  };
}

/** What `installed=` may hold: `new Date().toISOString()`. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const formatMarker = ({ version, mods, layout, before = "none", adopted = [], migrated = [], installed = null, sequence = null,
  usagemeter = null, usagemeterSequence = null, usagemeterOn = {}, usagemeterScope = null, off = [] }) =>
  [`version=${version}`, `mods=${mods.join(",")}`, ...(layout ? [`layout=${layout}`] : []), `before=${before}`,
    ...(adopted.length ? [`adopted=${adopted.map((a) => `${a.mod}:${a.path}`).join(",")}`] : []),
    ...(migrated.length ? [`migrated=${migrated.join(",")}`] : []),
    ...(installed ? [`installed=${installed}`] : []),
    // sequence before the usagemeter lines, which install.sh writes last: a rewrite keeps the bytes.
    ...(Number.isSafeInteger(sequence) ? [`sequence=${sequence}`] : []),
    ...(off?.length ? [`off=${off.join(",")}`] : []),
    ...(usagemeter ? [`usagemeter=${usagemeter}`] : []),
    ...(Number.isSafeInteger(usagemeterSequence) ? [`usagemeter-sequence=${usagemeterSequence}`] : []),
    ...(Object.keys(usagemeterOn ?? {}).length ? [`usagemeter-machines=${Object.entries(usagemeterOn).map(([m, v]) => `${m}:${v}`).join(",")}`] : []),
    ...(usagemeterScope ? [`usagemeter-scope=${usagemeterScope}`] : [])].join("\n") + "\n";
/** Set to 1 to never ask GitHub (the CLI's update --check, the mod's notice). */
export const NO_UPDATE_ENV = "AUTOMAGIK_HERDR_NO_UPDATE";
export const FIRST_CHECK_MS = 20_000;
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
export const RETRY_MS = 30 * 60 * 1000;
export const TIMEOUT_MS = 15_000;

export const updatesOff = (env = {}) => String(env?.[NO_UPDATE_ENV] ?? "").trim() === "1";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, NaN when either is not a version. */
export function compareVersions(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return Number.NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Math.sign(Number(p[i]) - Number(q[i]));
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return Math.sign(p.length - q.length);
}

/**
 * The update a pointer (pack.json, parsed, its signature already checked) names: `{ version, tag,
 * page, sequence, tarball: { name, url }, sha256, size }`. Throws when it is not this pack's
 * pointer: another schema or part, a version that is not X.Y.Z, no whole-number sequence, a tarball
 * of another name, or a sha256 that is not 64 hex.
 */
export function packOfPointer(pointer) {
  const bad = (why) => { throw new Error(`the pack pointer ${why}: refusing it`); };
  if (!pointer || typeof pointer !== "object") bad("is not JSON");
  if (pointer.schemaVersion !== POINTER_SCHEMA) bad(`has schema ${pointer.schemaVersion}, not ${POINTER_SCHEMA}`);
  if (pointer.part !== "herdr") bad(`names part ${pointer.part}, not herdr`);
  const version = pointer.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) bad(`names version ${version}`);
  const tarball = pointer.tarball ?? {};
  if (tarball.name !== tarballName(version)) bad(`names ${tarball.name}, not ${tarballName(version)}`);
  if (typeof tarball.url !== "string" || !/^(https|file):\/\//.test(tarball.url)) bad("has no tarball URL");
  if (typeof tarball.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(tarball.sha256)) bad("has no sha256 of 64 hex");
  if (!Number.isSafeInteger(pointer.sequence) || pointer.sequence < 0) bad("has no sequence");
  const tag = `v${version}`;
  return {
    version, tag, page: `https://github.com/${REPO}/releases/tag/${tag}`, sequence: pointer.sequence,
    tarball: { name: tarball.name, url: tarball.url }, sha256: tarball.sha256, size: Number.isInteger(tarball.size) ? tarball.size : null,
  };
}

/** The update `pack` (packOfPointer's) offers over `current`: itself when newer, else null. */
export const pickUpdate = (current, pack) => (pack && compareVersions(pack.version, current) > 0 ? pack : null);

/** `sha256sum` output (`<hex>  <name>`, `*<name>` in binary mode) as a Map name → lowercase hex. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** The mod's notice for `update` (from pickUpdate). */
export const noticeText = (update) =>
  `Automagik Herdr ${update.version} is out. Run \`am update\` to install it (${update.page}).`;

// ---- Installing updates on their own (auto-update) ----

/**
 * The pack's own update setting and state, beside its record:
 * `<app home>/automagik-herdr/auto-update.json`, `{ "auto": true | false, "skip": "X.Y.Z" }`.
 * `auto`: install verified releases on their own (on unless it says false). `skip`: the version
 * `automagik-herdr update --rollback` rolled away from; auto-update never installs it again and
 * waits for a newer one. The mod, update.mjs and the CLI all read it through parseAuto.
 */
export const AUTO_FILE = "auto-update.json";
/**
 * Beside the record: `{ version, held }`, the mods the last install held for a layout (#420), for the
 * new build's notice. update.mjs writes it after the swap, since the build that asked for the install
 * usually never hears back (updateCheck.js), and removes it when an install holds nothing.
 */
export const HELD_FILE = "held-mods.json";
/**
 * Beside the record: `{ version, failedVersion, mod, failed, at }` after an update restored the
 * kept set because herdr-app check found a mod that does not load, or `{ version, error, at }`
 * when it could not restore. The build that asked for the update usually never hears back (the
 * folders swap and Herdr reloads it), so the restored build reads this at load and says it once.
 * `prevRemoved`: the restore removed the failed release's folders instead of keeping them (#671),
 * so no `.prev` is left and a manual rollback has nothing to put back. `warnings`: what the
 * restore could not remove, and where it stays (the update's answer and notice say it too).
 */
export const RESTORE_FILE = "restored-mods.json";
/**
 * Beside the record: `{ version, from, unavailable, at }` when herdr-app could not judge the pack
 * an update just installed (it is kept). The new build reads it at load, since the build that ran
 * the update is usually reloaded away before its answer arrives; it says the update was not checked.
 */
export const CHECK_FILE = "unchecked-mods.json";

/** The setting as `{ on, skip }`: on unless the file says `"auto": false`; skip a version or null. */
export function parseAuto(text) {
  let value = null;
  try { value = JSON.parse(text); } catch {}
  const o = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { on: o.auto !== false, skip: typeof o.skip === "string" && /^\d+\.\d+\.\d+$/.test(o.skip) ? o.skip : null };
}

export const formatAuto = ({ on = true, skip = null } = {}) =>
  `${JSON.stringify({ auto: on !== false, ...(skip ? { skip } : {}) }, null, 2)}\n`;

/**
 * Why auto-update leaves `version` alone, or null when it may install it. `auto`: `{ on, skip,
 * managed, why }` (update.mjs autoStatus): a pack install.sh did not put in place through a signed
 * release (a checkout, a hand-installed pack) keeps today's notice, and so does the setting off.
 */
export function autoHold(version, auto) {
  if (!auto?.managed) return auto?.why ?? "this pack is not one install.sh installed";
  if (auto.on === false) return "Install updates automatically is off";
  if (auto.skip && !(compareVersions(version, auto.skip) > 0)) return `${auto.skip} was rolled back here: waiting for a newer release`;
  return null;
}
