// The public install path end to end (#43): the pack built by release.yml's own Pack lines, served
// as a file:// release with the tarball's .sha256, installed by install.sh piped into bash as the README's
// one-liner runs it, on three scratch homes: a fresh one, a v0.4.0 sidebar-only install, and one
// with a personal layout and an unrelated mod (sheepdog). The folder list is PACK_MODS from
// mods/am-sidebar/release.js, as release.yml reads it from the tag; this test does not take it
// from release.yml. Fake `uname`, `brew` and `herdr-app`; never the real home,
// ~/.config/herdr-app or Homebrew.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(ROOT, "install.sh");
// The monorepo's release workflow: its "Pack the herdr pack" step builds the pack from herdr/.
const RELEASE_YML = join(ROOT, "..", ".github", "workflows", "release.yml");
const { OFF_BY_DEFAULT, PACK_MODS, PACK_KEYS, PACK_LAYOUT, CATALOG_URL, POCKET_LINK, V020_LAYOUT_SHA256, sumsName, tarballName } = await import("../mods/am-sidebar/release.js");
const { meterKey, publishMeter } = await import("./meter-lane-fake.mjs");
const METER_VERSION = "3.200.5";
/** The pack mods a fresh install turns on; the rest (OFF_BY_DEFAULT) land in mods-disabled/. */
const ON_MODS = PACK_MODS.filter((m) => !OFF_BY_DEFAULT.includes(m));
const { hookCommand, legacyHookCommand } = await import("../mods/am-sidebar/briefingText.mjs");
const { keys: TEST_KEYS, pointerBytes, signatureOf } = await import("./pointer.mjs");
/** The release this branch becomes (a monorepo release that carries the pack); release.yml sets VERSION to it in the commit it tags. */
const RELEASE = "3.57.0";
/** The latest sidebar-only release (v0.2-v0.4.x: automagik-herdr-<v>.tgz, spaces-agents only). */
const OLD = "0.4.0";
/** A run's output with its exit code and stderr, for the message of an assertion about its notice. */
const ran = (r) => `exit ${r.code}\nstderr:\n${r.err}\nstdout:\n${r.out}`;
/** Paths update.mjs carries over from the replaced folder (D10): never in the archive. */
const PRIVATE = (rel) => rel.split("/").some((s) => s.startsWith(".") || s === "node_modules");

const git = (args, env = {}) => execFileSync("git", args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" }).trim();
const haveGit = (() => { try { return git(["rev-parse", "--is-inside-work-tree"]) === "true"; } catch { return false; } })();
/** The repository's top and the pack's folder in it (`herdr/` in the Automagik monorepo). */
const TOP = haveGit ? git(["rev-parse", "--show-toplevel"]) : ROOT;
const PREFIX = haveGit ? git(["rev-parse", "--show-prefix"]) : "";
const topGit = (args, env = {}) => execFileSync("git", args, { cwd: TOP, env: { ...process.env, ...env }, encoding: "utf8" }).trim();
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** v0.3.5-v0.4.0's bin/automagik-herdr, byte for byte: the command their install.sh links. */
const WRAPPER = `#!/bin/sh
# The automagik-herdr command (install.sh links ~/.local/bin/automagik-herdr here): runs
# automagik-herdr.mjs beside it with the runtime run.sh finds (node 22.7 or later, else bun), so
# it works where PATH has no node. Apache-2.0.

# $0 is the link's path: follow the links to this file's own folder.
p=$0
while [ -L "$p" ]; do
  to=$(readlink "$p") || break
  case $to in /*) p=$to ;; *) p=$(dirname "$p")/$to ;; esac
done
dir=$(cd "$(dirname "$p")" && pwd -P) || exit 127
exec sh "$dir/run.sh" "$dir/automagik-herdr.mjs" "$@"
`;
/** A stand-in for their bin/run.sh (it looks for node 22.7+ or bun); node is on PATH here. */
const RUN_SH = "#!/bin/sh\nexec node \"$@\"\n";
const LAUNCHER = ["mods/am-sidebar/bin/automagik-herdr", "mods/am-sidebar/bin/run.sh"];

/** Every file and link under `dir`, as `rel → {bytes or link target, exec bit}`. */
function files(dir, { skip = () => false } = {}) {
  const out = new Map();
  const walk = (at, rel) => {
    for (const name of readdirSync(at).sort()) {
      const r = rel ? `${rel}/${name}` : name, path = join(at, name), st = lstatSync(path);
      if (skip(r)) continue;
      if (st.isSymbolicLink()) out.set(r, `link:${readlinkSync(path)}`);
      else if (st.isDirectory()) walk(path, r);
      else out.set(r, `${st.mode & 0o111 ? "x" : "-"}:${sha(readFileSync(path))}`);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * The pack exactly as release.yml's Pack step builds it: its `git show` of the tag's
 * herdr/scripts/pack.mjs and the line that runs it, by sh with the tag replaced by a tree of this
 * working copy (the tag's tree in a release), and that tree's VERSION set to RELEASE as the release
 * commit does. pack.mjs checks mods/ (but pocket-link) is PACK_MODS and the archive's top level is
 * PACK_MODS + layouts; both are checked here again.
 * `launcher`: undefined packs the tree as it is; false drops dev's launcher (bin/automagik-herdr
 * and bin/run.sh), as wish/am-pack had none before dev merged in; true adds it where missing;
 * "none" drops it and bin/automagik-herdr.mjs too (a pack with no command, which must not link).
 */
function buildPack(dir, { launcher } = {}) {
  const step = readFileSync(RELEASE_YML, "utf8");
  const pack = step.slice(step.indexOf("- name: Pack the herdr pack\n"), step.indexOf("- name: Pack the plugins\n"));
  assert.ok(pack.length > 0, "release.yml has a Pack the herdr pack step before Pack the plugins");
  const only = (re) => {
    const lines = pack.split("\n").map((l) => l.trim()).filter((l) => re.test(l));
    assert.equal(lines.length, 1, `release.yml's Pack step has one line matching ${re}`);
    return lines[0];
  };
  const swap = (line, from, to) => {
    assert.equal(line.split(from).length, 2, `release.yml's line names ${from} once: ${line}`);
    return line.replace(from, to);
  };
  assert.equal(only(/^tgz=/), 'tgz="automagik-herdr-pack-${VERSION}.tgz"');
  assert.equal(only(/^\(cd release && sha256sum /), '(cd release && sha256sum -- "${tgz}" > "${tgz}.sha256")');
  // The tag's own pack.mjs, run on the tag (here: a tree of the whole working copy, from the top).
  const show = swap(only(/^git show "v\$\{VERSION\}:herdr\/scripts\/pack\.mjs"/), '"v${VERSION}:', '"${TOPTREE}:');
  const run = swap(swap(only(/^node "\$\{RUNNER_TEMP\}\/pack\.mjs" /), '--ref "v${VERSION}"', '--ref "${TOPTREE}"'), '--out "release/${tgz}"', '--out "${tgz}"');

  // A tree of the working copy (staged in a scratch index, never the repository's own index),
  // from the repository's top: the pack is its PREFIX (herdr/), and TREE that folder's tree.
  const idx = { GIT_INDEX_FILE: join(dir, "index") };
  topGit(["add", "-A", "--", `${PREFIX}mods`, `${PREFIX}scripts`, "herdr-layout"], idx);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, input: `${RELEASE}\n`, encoding: "utf8" }).trim();
  topGit(["update-index", "--cacheinfo", `100644,${blob},${PREFIX}mods/am-sidebar/VERSION`], idx);
  const staged = new Set(topGit(["ls-files", "--", ...LAUNCHER.map((path) => PREFIX + path)], idx).split("\n").filter(Boolean));
  for (const path of LAUNCHER.map((path) => PREFIX + path)) {
    if ((launcher === false || launcher === "none") && staged.has(path)) topGit(["update-index", "--force-remove", "--", path], idx);
    if (launcher === true && !staged.has(path)) {
      const text = path.endsWith("run.sh") ? RUN_SH : WRAPPER;
      const b = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, input: text, encoding: "utf8" }).trim();
      topGit(["update-index", "--add", "--cacheinfo", `100755,${b},${path}`], idx);
    }
  }
  if (launcher === "none") topGit(["update-index", "--force-remove", "--", `${PREFIX}mods/am-sidebar/bin/automagik-herdr.mjs`], idx);
  const top = topGit(["write-tree"], idx);
  const tree = PREFIX ? topGit(["rev-parse", `${top}:${PREFIX.replace(/\/$/, "")}`]) : top;

  // From the top: ls-tree and archive run in a subfolder list only that subfolder's paths.
  const tagged = topGit(["ls-tree", "--name-only", `${tree}:mods`]).split("\n").filter((m) => m !== POCKET_LINK).sort();
  assert.deepEqual(tagged, [...PACK_MODS].sort(), "mods/ (but pocket-link) is PACK_MODS, as release.yml checks");
  const tgz = join(dir, "release", tarballName(RELEASE));
  mkdirSync(dirname(tgz), { recursive: true });
  mkdirSync(join(dir, "runner"));
  execFileSync("sh", ["-euc", `${show}\n${run}\n`], {
    cwd: TOP, env: { ...process.env, TOPTREE: top, tgz, RUNNER_TEMP: join(dir, "runner") }, stdio: "pipe",
  });
  const level = [...new Set(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).map((p) => p.split("/")[0]))].sort();
  assert.deepEqual(level, [...PACK_MODS, "layouts"].sort(), "the archive's top level is PACK_MODS plus layouts, as release.yml checks");
  const x = join(dir, "archive");
  mkdirSync(x);
  execFileSync("tar", ["-xzf", tgz, "-C", x]);
  return { tgz, x };
}

/** One pack per launcher variant (each is the same release). */
const built = new Map();
const pack = (launcher) => {
  if (!built.has(launcher)) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-e2e-pack-")));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    built.set(launcher, buildPack(dir, { launcher }));
  }
  return built.get(launcher);
};

/** A scratch machine: a home, the release folder (file://), and fake uname, brew and herdr-app. */
function machine(t, { launcher, os = "Darwin", arch = "arm64" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-e2e-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), bin = join(root, "bin"), apps = join(root, "Applications"), rel = join(root, "release");
  for (const d of [home, bin]) mkdirSync(d, { recursive: true });
  // macOS: Herdr is the app whose bundle id is dev.herdr.app (only its Info.plist here).
  if (os === "Darwin") {
    mkdirSync(join(apps, "Herdr.app", "Contents"), { recursive: true });
    writeFileSync(join(apps, "Herdr.app", "Contents", "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n    <key>CFBundleIdentifier</key><string>dev.herdr.app</string>\n</dict></plist>\n');
  }
  const log = join(root, "herdr-app.log"), shown = join(root, "herdr-shown"), brew = join(root, "brew.log"), spaces = join(root, "herdr-spaces.json");
  writeFileSync(log, "");
  writeFileSync(brew, "");
  exe(join(bin, "uname"), `#!/bin/sh\ncase $1 in -m) echo ${arch} ;; *) echo ${os} ;; esac\n`);
  exe(join(bin, "brew"), `#!/bin/sh\necho "$*" >> "${brew}"\nexit 1\n`);
  // Herdr's own installer is never fetched: Herdr is already here.
  exe(join(bin, "curl"), `#!/bin/sh\nfor a; do case $a in https://releases.herdr.dev/*) echo "no network in tests: $a" >&2; exit 22 ;; esac; done\nexec /usr/bin/curl "$@"\n`);
  // herdr-app: logs its arguments; `status` prints the layout show() set, or fails with none;
  // `ls` prints the spaces openSpace() opened, or nothing.
  exe(join(bin, "herdr-app"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = ls ]; then
  [ ! -f "${spaces}" ] || cat "${spaces}"
fi
if [ "$1" = status ]; then
  [ -f "${shown}" ] || exit 1
  printf '{\\n  "layout": "%s",\\n  "zoom": false\\n}\\n' "$(cat "${shown}")"
fi
`);
  // The release: download/v<RELEASE>/{the pack, its .sha256}, as GitHub serves it, and the
  // herdr-lane release's pack.json naming it, signed (pack.json.sig) with the test key the
  // installer is told to trust. A newer release the pointer does not name is not offered.
  const { tgz } = pack(launcher);
  const body = readFileSync(tgz);
  for (const version of [RELEASE, "3.58.0"]) {
    const dl = join(rel, "download", `v${version}`);
    mkdirSync(dl, { recursive: true });
    writeFileSync(join(dl, tarballName(version)), body);
    writeFileSync(join(dl, sumsName(version)), `${sha(body)}  ${tarballName(version)}\n`);
  }
  const lane = join(rel, "download", "herdr-lane");
  mkdirSync(lane, { recursive: true });
  const pointer = pointerBytes(RELEASE, { url: `file://${rel}/download/v${RELEASE}/${tarballName(RELEASE)}`, body });
  writeFileSync(join(lane, "pack.json"), pointer);
  writeFileSync(join(lane, "pack.json.sig"), `${signatureOf(pointer)}\n`);
  // The meter lane in the same release folder: meter.json signed by a key made for this run (the
  // installer trusts it through AUTOMAGIK_HERDR_METER_KEYS, a file:// release only) and the builds
  // it names, each a script answering --version.
  const meterKeys = meterKey();
  publishMeter(rel, meterKeys, { version: METER_VERSION });
  // A fake hc with no linked machine: install.sh's `meter install --linked` never reaches a real one.
  const hcState = join(root, "hc.json"), hcLog = join(root, "hc.log");
  writeFileSync(hcState, JSON.stringify({ terminals: [], machines: [] }));
  writeFileSync(hcLog, "");
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test", "fake-hc.mjs")}" "$@"\n`);

  const appHome = join(home, ".config", "herdr-app");
  const env = {
    HOME: home, TMPDIR: root, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AUTOMAGIK_HERDR_RELEASE_URL: `file://${rel}`, AUTOMAGIK_HERDR_TTY: join(root, "no-tty"), AUTOMAGIK_HERDR_APPS: apps,
    AUTOMAGIK_HERDR_PACK_KEYS: JSON.stringify({ keys: TEST_KEYS }),
    AUTOMAGIK_HERDR_METER_KEYS: meterKeys.keys, HC_FAKE_STATE: hcState, HC_FAKE_LOG: hcLog,
  };
  return {
    launcher, root, home, appHome, mods: join(appHome, "mods"), state: join(appHome, "automagik-herdr"),
    link: join(home, ".local", "bin", "automagik-herdr"),
    show: (name) => writeFileSync(shown, name),
    openSpace: (folder) => writeFileSync(spaces, JSON.stringify({ spaces: [{ id: "w1", folder, machine: null }] })),
    // The README's one-liner: `curl -fsSL …/install.sh | bash -s -- --yes`, the script on stdin.
    oneLiner: (...args) => {
      const hadKeys = existsSync(join(appHome, "keys.json"));
      const r = spawnSync("bash", ["-s", "--", ...args], { cwd: root, env, encoding: "utf8", input: readFileSync(INSTALL) });
      return { code: r.status, out: r.stdout, err: r.stderr, hadKeys };
    },
    // The linked command, run as a person runs it.
    cli: (...args) => {
      const r = spawnSync(join(home, ".local", "bin", "automagik-herdr"), args, { cwd: root, env, encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    herdrLog: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    brewCalls: () => readFileSync(brew, "utf8").split("\n").filter(Boolean),
  };
}

/** What every install must leave: the whole pack, as archived, activated and set up. */
function assertFullPack(m, r) {
  const { x } = pack(m.launcher);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.deepEqual(m.brewCalls(), [], "Homebrew is never run");
  // Every PACK_MODS folder installed, byte-identical to the archive (exec bits too); only the
  // private paths update.mjs carries over (.state, dotfiles, node_modules) may be added. The ones
  // that ship off (am-quota) are installed in mods-disabled/, where Herdr does not load them.
  for (const mod of PACK_MODS) {
    const dir = OFF_BY_DEFAULT.includes(mod) ? join(m.appHome, "mods-disabled", mod) : join(m.mods, mod);
    assert.ok(existsSync(join(dir, "mod.json")), `${mod} is installed`);
    if (OFF_BY_DEFAULT.includes(mod)) assert.ok(!existsSync(join(m.mods, mod)), `${mod} ships off`);
    assert.deepEqual(files(dir, { skip: PRIVATE }), files(join(x, mod)), `${mod} is byte-identical to the archive`);
  }
  assert.equal(readFileSync(join(m.mods, "am-sidebar", "VERSION"), "utf8"), `${RELEASE}\n`);
  // The ownership record lists every pack folder, and the output names them all: never a
  // sidebar-only install that reads like a complete one.
  const mark = readFileSync(join(m.state, "installed-by-install.sh"), "utf8");
  assert.match(mark, new RegExp(`^version=${RELEASE.replaceAll(".", "\\.")}$`, "m"));
  assert.deepEqual(/^mods=(.*)$/m.exec(mark)?.[1].split(",").sort(), [...PACK_MODS].sort());
  const said = /Installed the pack (\S+) in .*: (.*)\.$/m.exec(r.out);
  assert.ok(said, r.out);
  assert.equal(said[1], RELEASE);
  // A mod that ships off is named, marked off.
  assert.deepEqual(said[2].split(", ").sort(), PACK_MODS.map((mod) => (OFF_BY_DEFAULT.includes(mod) ? `${mod} (off; turn it on in the Mods panel)` : mod)).sort());
  // herdr-app check on every pack mod that is on (one switched off is not loaded).
  assert.deepEqual(m.herdrLog().filter((l) => l.startsWith("check ")).map((l) => l.slice(6)).sort(), ON_MODS.map((mod) => join(m.mods, mod)).sort());
  // The pack layout (the archive's), and the pack's copy kept for later comparisons.
  const shipped = readFileSync(join(x, PACK_LAYOUT));
  assert.deepEqual(readFileSync(join(m.appHome, PACK_LAYOUT)), shipped, "the automagik layout is the pack's");
  assert.deepEqual(readFileSync(join(m.state, "automagik.json")), shipped);
  // Activation: the layout shows the sidebar, the footer rail, the tab bar and the Markdown menu;
  // the sidebar's + opens am-new-menu; every pack mod it names is installed. It names no panel the
  // footer opens itself (Automations, Accounts): Herdr shows plain Herdr instead of a layout that
  // names a mod that is off (#221).
  const layout = JSON.parse(shipped);
  const blocks = [];
  const walk = (n) => { if (n.content?.mod) blocks.push(n.content); (n.children ?? []).forEach(walk); };
  walk(layout);
  const named = blocks.map((c) => c.mod);
  for (const mod of ["am-sidebar", "am-tabs", "am-footer", "am-status"]) assert.ok(named.includes(mod), `the layout names ${mod}`);
  for (const mod of ["am-automations", "am-quota", ...OFF_BY_DEFAULT]) assert.ok(!named.includes(mod), `the layout does not name ${mod}`);
  assert.deepEqual(blocks.find((c) => c.mod === "am-footer")?.props, { footer: true }, "the footer rail");
  assert.equal(layout.terminal_menu, "am-markdown");
  assert.match(readFileSync(join(m.mods, "am-sidebar", "main.js"), "utf8"), /openOverlay\(\{ mod: "am-new-menu"/, "the sidebar's + opens am-new-menu");
  // The tab bar's + too: the pack's menu replaces Herdr's stock new-menu (owner, Group 7).
  const tabs = readFileSync(join(m.mods, "am-tabs", "main.js"), "utf8");
  assert.match(tabs, /button\("tab-new", "\+", \(\) => openOverlay\(\{ mod: "am-new-menu"/, "the tab bar's + opens am-new-menu");
  assert.doesNotMatch(tabs, /mod: "new-menu"/, "never the stock new-menu");
  for (const mod of [...named, layout.terminal_menu].filter((n) => ON_MODS.includes(n))) assert.ok(existsSync(join(m.mods, mod, "mod.json")), `${mod} (in the layout) is installed`);
  // The mod manager: its catalog and its key (merged only where free).
  assert.deepEqual(JSON.parse(readFileSync(join(m.appHome, "data", "am-mods", "catalog.json"), "utf8")), { url: CATALOG_URL });
  const keys = r.hadKeys ? JSON.parse(readFileSync(join(m.appHome, "keys.json"), "utf8")) : {};
  if (r.hadKeys) {
    for (const [section, entries] of Object.entries(PACK_KEYS)) for (const [key, action] of Object.entries(entries)) assert.equal(keys[section]?.[key], action, `key ${key}`);
  } else {
    assert.equal(existsSync(join(m.appHome, "keys.json")), false, "first launch still initializes native keybindings");
    assert.match(r.out, /Open Herdr.*rerun/);
  }
  for (const mod of ON_MODS) assert.ok(existsSync(join(m.mods, mod)), mod);
  // The command, linked to the entry the installed sidebar ships (the launcher's wrapper, else
  // the .mjs), and it runs.
  const entry = existsSync(join(x, "am-sidebar", "bin", "automagik-herdr")) ? "automagik-herdr" : "automagik-herdr.mjs";
  assert.equal(readlinkSync(m.link), join(m.mods, "am-sidebar", "bin", entry));
  // usagemeter, the token meter the sidebar runs, in place beside it.
  const meter = spawnSync(join(m.home, ".local", "bin", "usagemeter"), ["--version"], { encoding: "utf8" });
  assert.equal(meter.stdout, `usagemeter ${METER_VERSION}\n`, "usagemeter is installed");
  const v = m.cli("--version");
  assert.equal(v.code, 0, `am --version: ${v.out}${v.err}`);
  assert.equal(v.out, `am ${RELEASE}\n`);
  return keys;
}

for (const arch of ["x86_64", "aarch64"]) {
  test(`e2e: Linux ${arch} installs the signed release pack and runs its CLI`, { skip: !haveGit && "no git work tree" }, (t) => {
    const m = machine(t, { os: "Linux", arch });
    assertFullPack(m, m.oneLiner("--yes"));
  });
}

test("e2e: release.yml's pack is the whole pack: every PACK_MODS folder plus the layout, nothing else", { skip: !haveGit && "no git work tree" }, () => {
  const { x } = pack();
  assert.deepEqual(readdirSync(x).sort(), [...PACK_MODS, "layouts"].sort());
  assert.deepEqual(readdirSync(join(x, "layouts")), ["automagik.json"]);
  assert.equal(readFileSync(join(x, "am-sidebar", "VERSION"), "utf8"), `${RELEASE}\n`);
  // Each folder holds what git tracks under mods/<mod>; the sidebar's also the layout part's
  // part.json (herdr-layout/part.json as am-sidebar/layout/part.json, scripts/pack.mjs).
  for (const mod of PACK_MODS) {
    const tracked = git(["ls-files", "--", `mods/${mod}`]).split("\n").filter(Boolean).map((p) => p.slice(`mods/${mod}/`.length));
    if (mod === "am-sidebar") tracked.push("layout/part.json");
    assert.deepEqual([...files(join(x, mod)).keys()].sort(), tracked.sort(), `${mod}: the archive holds every tracked file`);
  }
  assert.equal(readFileSync(join(x, "am-sidebar", "layout", "part.json"), "utf8"), readFileSync(join(ROOT, "..", "herdr-layout", "part.json"), "utf8"));
});

test("e2e (a): a fresh home gets the whole pack, activated, from the public one-liner", { skip: !haveGit && "no git work tree" }, (t) => {
  const m = machine(t);
  const r = m.oneLiner("--yes");
  assertFullPack(m, r);
  assert.match(r.out, /added the automagik layout/);
  assert.match(r.out, /To show the Automagik sidebar, switch Herdr to the automagik layout/, "no status: the switch command is printed");
  assert.match(readFileSync(join(m.state, "installed-by-install.sh"), "utf8"), /^layout=added$/m);
  // Herdr's first launch creates native shortcuts only if keys.json is absent.
  const native = { terminal: { "ctrl-shift-v": "terminal.paste", "shift-insert": "terminal.paste" } };
  writeFileSync(join(m.appHome, "keys.json"), JSON.stringify(native), { flag: "wx" });
  const rerun = m.oneLiner("--yes");
  assert.equal(rerun.code, 0, `${rerun.out}\n${rerun.err}`);
  const keys = JSON.parse(readFileSync(join(m.appHome, "keys.json"), "utf8"));
  assert.deepEqual(keys.terminal, native.terminal);
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) assert.equal(keys[section][key], action);
  }
});

// (b) twice: the pack as wish/am-pack had it, without dev's launcher (the link moves to the .mjs),
// and after dev merged in, with it (the link moves to the new wrapper).
for (const launcher of [false, true]) {
test(`e2e (b): a v0.4.0 sidebar-only install is replaced by the whole pack (${launcher ? "with" : "without"} the launcher); a personal layout learns what it lacks`, { skip: !haveGit && "no git work tree" }, (t) => {
  const m = machine(t, { launcher });
  // What v0.3.5-v0.4.0's install.sh left (git show v0.4.0:install.sh, lines 193-197 and 296-307):
  // a v1 marker, the sidebar-only spaces-agents with its layout and state, the layout v0.2.0-v0.4.0
  // shipped (the same bytes), and the link to the sidebar's bin/automagik-herdr wrapper.
  const old = join(m.mods, "spaces-agents");
  mkdirSync(join(old, "bin"), { recursive: true });
  mkdirSync(join(old, "layouts"));
  mkdirSync(join(old, ".state"));
  const v03layout = readFileSync(join(ROOT, "test", "fixtures", "layout-v0.2.0.json"));
  assert.equal(sha(v03layout), V020_LAYOUT_SHA256, "v0.2.0-v0.4.0 shipped these bytes");
  writeFileSync(join(old, "VERSION"), `${OLD}\n`);
  writeFileSync(join(old, "mod.json"), "{\"place\":\"none\",\"title\":\"Spaces & Agents\"}\n");
  writeFileSync(join(old, "main.js"), `// spaces-agents ${OLD}, sidebar only\n`);
  exe(join(old, "bin", "automagik-herdr.mjs"), "#!/usr/bin/env node\n");
  exe(join(old, "bin", "automagik-herdr"), WRAPPER);
  exe(join(old, "bin", "run.sh"), RUN_SH);
  writeFileSync(join(old, "layouts", "automagik.json"), v03layout);
  writeFileSync(join(old, ".state", "projects.json"), "[\"/work/acme\"]\n");
  mkdirSync(join(m.appHome, "layouts"), { recursive: true });
  writeFileSync(join(m.appHome, PACK_LAYOUT), v03layout);
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, "installed-by-install.sh"), `version=${OLD}\nbefore=none\nlayout=added\n`);
  mkdirSync(dirname(m.link), { recursive: true });
  symlinkSync(join(old, "bin", "automagik-herdr"), m.link);
  assert.notEqual(OLD, RELEASE, "an upgrade, never the same-version path (#44)");
  // As in the issue: the installing agent adapted a personal layout to show the sidebar beside
  // Sheepdog, and Herdr shows it.
  const sheepdog = join(m.mods, "sheepdog");
  mkdirSync(sheepdog);
  writeFileSync(join(sheepdog, "mod.json"), "{\"place\":\"none\",\"title\":\"Sheepdog\"}\n");
  writeFileSync(join(sheepdog, "main.js"), "// sheepdog\n");
  const personal = join(m.appHome, "layouts", "main-agents.json");
  const mine = `${JSON.stringify({ id: "root", type: "row", children: [
    { id: "spaces", type: "block", content: { mod: "spaces-agents" }, children: [] },
    { id: "dog", type: "block", content: { mod: "sheepdog" }, children: [] },
    // Pack names as ids, not as blocks: they don't count as the pack's pieces.
    { id: "am-quota-panel", type: "block", content: { mod: "sheepdog" }, children: [] },
    { id: "am-quota", type: "block", content: { mod: "sheepdog" }, children: [] },
    { id: "automations", type: "column", children: [] },
  ] }, null, 2)}\n`;
  writeFileSync(personal, mine);
  m.show("main-agents");
  const dogBefore = files(sheepdog);
  // A bot's project the CLI listed, with v0.4's hook (straight at mods/spaces-agents).
  const proj = join(m.root, "acme");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q", proj]);
  const projSettings = join(proj, ".claude", "settings.local.json");
  writeFileSync(projSettings, `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(m.appHome), timeout: 10 }] }] } }, null, 2)}\n`);
  writeFileSync(join(m.appHome, "spaces-agents-projects.json"), JSON.stringify([proj]));

  const r = m.oneLiner("--yes");
  assertFullPack(m, r);
  // The hook moved, and the run says so last, loudly: the file with its project, the running
  // sessions that keep the old hook, and the projects it didn't know.
  assert.equal(JSON.parse(readFileSync(projSettings, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command, hookCommand(m.appHome));
  const out = r.out.split("\n");
  const from = out.indexOf("IMPORTANT: the bots' briefing hook moved to a new path in 1 settings file:");
  assert.ok(from > 0, ran(r));
  assert.equal(out[from + 1], `  ${proj}: ${projSettings}`);
  assert.match(out[from + 2], /keeps the OLD hook and gets NO briefing until it is restarted\. Restart the bot: am restart <bot> \(or the bot row's Restart\)/);
  assert.match(out[from + 3], /were not rewritten .*am start <bot>/);
  assert.ok(out.findIndex((l) => l.startsWith("Done: Automagik Herdr")) > from + 3, "after every step's output, before the closing lines");
  assert.ok(!r.out.includes("notice: "), "the tag never shows");
  // The sidebar-only pack is replaced and kept as the rollback set; its state carried over.
  assert.equal(readFileSync(join(m.state, ".prev", "spaces-agents", "VERSION"), "utf8"), `${OLD}\n`);
  assert.equal(existsSync(old), false, "spaces-agents became am-sidebar");
  assert.equal(readFileSync(join(m.mods, "am-sidebar", ".state", "projects.json"), "utf8"), "[\"/work/acme\"]\n", "the sidebar's state carried over");
  // The rename migration ran: the link (asserted above) is am-sidebar's wrapper, and the personal
  // layout that names the sidebar follows the rename, its original kept in the dated backup.
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(m.state, "installed-by-install.sh"), "utf8"), new RegExp(`^migrated=backup/layouts-${day}`, "m"));
  assert.equal(readFileSync(join(m.state, "backup", `layouts-${day}`, "layouts", "main-agents.json"), "utf8"), mine);
  assert.match(r.out, new RegExp(`The folders it replaced \\(${OLD.replaceAll(".", "\\.")}\\) are kept in .*\\.prev`));
  assert.match(r.out, /replaced the automagik layout .*an older release shipped/, "v0.4's unchanged layout becomes the pack's (D8)");
  // The personal layout changed only there, Sheepdog is untouched, and nothing switched the person's layout...
  assert.deepEqual(JSON.parse(readFileSync(personal, "utf8")), JSON.parse(mine.replace('"mod": "spaces-agents"', '"mod": "am-sidebar"')));
  assert.deepEqual(files(sheepdog), dogBefore);
  assert.deepEqual(m.herdrLog().filter((l) => l.startsWith("do ")), []);
  // ...but the output says what that layout lacks and how it gains it.
  const lines = r.out.split("\n"), at = lines.findIndex((l) => l.includes("Your layout") && l.includes(personal));
  assert.ok(at >= 0, `the output names ${personal}:\n${r.out}`);
  const note = `${lines[at]}\n${lines[at + 1]}`;
  for (const what of ["footer rail (am-footer)", "tab bar (am-tabs)", "Markdown menu (am-markdown)"]) {
    assert.ok(note.includes(what), `it names the ${what}: ${note}`);
  }
  // The panels the footer opens itself are never missed: the pack's layout has no block for them.
  for (const what of ["automations panel", "Accounts panel"]) assert.ok(!note.includes(what), `${what} is not named: ${note}`);
  assert.ok(note.includes(join(m.state, "automagik.json")), `it points at the pack's layout to copy from: ${note}`);
});
}

test("e2e (c): a personal layout and an unrelated mod (sheepdog) stay as they were; keys and catalog merge", { skip: !haveGit && "no git work tree" }, (t) => {
  const m = machine(t);
  const sheepdog = join(m.mods, "sheepdog");
  mkdirSync(join(sheepdog, ".state"), { recursive: true });
  writeFileSync(join(sheepdog, "mod.json"), "{\"place\":\"none\",\"title\":\"Sheepdog\"}\n");
  writeFileSync(join(sheepdog, "main.js"), "// sheepdog\n");
  writeFileSync(join(sheepdog, ".state", "flock.json"), "{\"sheep\":12}\n");
  const personal = join(m.appHome, "layouts", "pasture.json");
  mkdirSync(dirname(personal), { recursive: true });
  const mine = "{\"id\":\"root\",\"type\":\"row\",\"children\":[{\"id\":\"dog\",\"type\":\"block\",\"content\":{\"mod\":\"sheepdog\"},\"children\":[]}]}\n";
  writeFileSync(personal, mine);
  writeFileSync(join(m.appHome, "keys.json"), "{\"global\":{\"cmd-shift-d\":\"mod.open:sheepdog\"}}\n");
  m.show("pasture");
  const dogBefore = files(sheepdog);

  const r = m.oneLiner("--yes");
  const keys = assertFullPack(m, r);
  assert.equal(keys.global["cmd-shift-d"], "mod.open:sheepdog", "the person's key stays");
  assert.deepEqual(files(sheepdog), dogBefore, "sheepdog is byte-identical, its state too");
  assert.equal(readFileSync(personal, "utf8"), mine, "the personal layout is untouched");
  assert.deepEqual(readdirSync(join(m.appHome, "layouts")).sort(), ["automagik.json", "pasture.json"]);
  assert.deepEqual(readdirSync(m.mods).sort(), [...ON_MODS, "sheepdog"].sort(), "nothing else in mods/");
  // A layout that doesn't show the sidebar gets no note: --yes switches to the pack's layout.
  assert.ok(!r.out.includes(personal), r.out);
  assert.deepEqual(m.herdrLog().filter((l) => l.startsWith("do ")), ['do layout.switch {"name":"automagik"}']);
});

test("e2e: a pack whose sidebar ships no command fails loudly and leaves no dangling link", { skip: !haveGit && "no git work tree" }, (t) => {
  const m = machine(t, { launcher: "none" });
  // v0.4.0's link, into the sidebar folder the install replaces.
  const old = join(m.mods, "spaces-agents");
  mkdirSync(join(old, "bin"), { recursive: true });
  writeFileSync(join(old, "VERSION"), `${OLD}\n`);
  writeFileSync(join(old, "mod.json"), "{\"place\":\"none\"}\n");
  exe(join(old, "bin", "automagik-herdr"), WRAPPER);
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, "installed-by-install.sh"), `version=${OLD}\nbefore=none\n`);
  mkdirSync(dirname(m.link), { recursive: true });
  symlinkSync(join(old, "bin", "automagik-herdr"), m.link);
  const r = m.oneLiner("--yes");
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /has neither automagik-herdr nor automagik-herdr\.mjs, so automagik-herdr is not linked\. Removed /);
  assert.equal(readdirSync(dirname(m.link)).includes("automagik-herdr"), false, "no link left behind");
  // The run stopped at the link, after the pack crossed the rename: the held hooks notice still prints.
  assert.match(r.out, /^IMPORTANT: the sidebar moved to a new folder, and no settings file's briefing hook was rewritten/m, ran(r));
});

test("e2e: a project unknown at the upgrade keeps its hook and is warned about; opened as a space, a rerun moves it", { skip: !haveGit && "no git work tree" }, (t) => {
  const m = machine(t);
  // A v0.4.0 sidebar-only install, and a bot's project no list of the pack's names.
  const old = join(m.mods, "spaces-agents");
  mkdirSync(join(old, "bin"), { recursive: true });
  writeFileSync(join(old, "VERSION"), `${OLD}\n`);
  writeFileSync(join(old, "mod.json"), "{\"place\":\"none\"}\n");
  writeFileSync(join(old, "main.js"), "// v0.4\n");
  exe(join(old, "bin", "automagik-herdr"), WRAPPER);
  exe(join(old, "bin", "run.sh"), RUN_SH);
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, "installed-by-install.sh"), `version=${OLD}\nbefore=none\n`);
  const proj = join(m.root, "unlisted");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q", proj]);
  const file = join(proj, ".claude", "settings.local.json");
  const v04 = `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(m.appHome), timeout: 10 }] }] } }, null, 2)}\n`;
  writeFileSync(file, v04);
  const hookOf = () => JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;

  const up = m.oneLiner("--yes");
  assert.equal(up.code, 0, up.err);
  assert.equal(readFileSync(file, "utf8"), v04, "not known yet: left as it is");
  // Crossing the rename with no file rewritten still warns, last.
  const lines = up.out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("IMPORTANT: the sidebar moved to a new folder, and no settings file's briefing hook was rewritten"));
  assert.ok(at > 0, ran(up));
  assert.match(lines[at + 1], /keeps the OLD hook and gets NO briefing until it is restarted\. Restart the bot: am restart <bot> \(or the bot row's Restart\)/);
  assert.match(lines[at + 2], /were not rewritten .*open it as a space in Herdr and run the installer again/);
  assert.ok(lines.findIndex((l) => l.startsWith("Done: Automagik Herdr")) > at);

  // The person opens it in Herdr and reruns the installer: the same release, the repair path.
  m.openSpace(proj);
  const again = m.oneLiner("--yes");
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already up to date/);
  assert.equal(hookOf(), hookCommand(m.appHome), "the open space's hook moved");
  assert.ok(existsSync(`${file}.am-backup`), "its original kept beside it");
  const said = again.out.split("\n");
  const from = said.indexOf("IMPORTANT: the bots' briefing hook moved to a new path in 1 settings file:");
  assert.ok(from >= 0, ran(again));
  assert.equal(said[from + 1], `  ${proj}: ${file}`);
  assert.ok(!again.out.includes("notice: "), "the tag never shows");
  // A third run: nothing left to move, and no notice.
  const third = m.oneLiner("--yes");
  assert.equal(third.code, 0, third.err);
  assert.ok(!third.out.includes("IMPORTANT:"), ran(third));
});
