// am end to end on temp homes (RFC 0012 delivery 1): the Bot verbs are automagik-herdr's byte for
// byte; am updates from a file:// am-lane signed by a key made for this run, refuses a lower
// sequence and a tarball that does not match, rolls back, keeps two copies, and takes and hands
// back the links. Never a real home, never the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync,
  writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY, sequenceOf } from "../lib/lane.mjs";
import { lockStore } from "../lib/self.mjs";
import { signedRelease } from "./signed-release.mjs";

const AM = fileURLToPath(new URL("..", import.meta.url));
const PACK = join(AM, "..", "herdr", "mods", "am-sidebar");
const NODE_DIR = dirname(process.execPath);
const KEY = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, trusted: JSON.stringify({ keys: [{ keyId: "am-test", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }] }) };
})();

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const app = join(home, ".config", "herdr-app");
  const releases = join(root, "releases");
  mkdirSync(app, { recursive: true });
  const env = {
    PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, AUTOMAGIK_HERDR_NO_UPDATE: "1",
    AM_RELEASE_URL: `file://${releases}`, AM_TRUSTED_KEYS: KEY.trusted,
  };
  const run = (cmd, args, extra = {}) => spawnSync("sh", [cmd, ...args], { encoding: "utf8", env: { ...env, ...extra }, cwd: root });
  const am = (...args) => run(join(AM, "bin", "am"), args);
  const installed = (...args) => run(join(home, ".local", "bin", "am"), args);
  const store = join(home, ".automagik", "parts", "automagik.am");
  return { root, home, app, releases, env, run, am, installed, store };
}

/** An am tarball of this checkout at `version` (no test/), as the release packs it. */
function tarball(s, version, { tamper } = {}) {
  const dir = join(s.root, `src-${version}`);
  cpSync(AM, dir, { recursive: true, filter: (p) => !p.startsWith(join(AM, "test")) });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  tamper?.(dir);
  const out = join(s.releases, "download", `v${version}`);
  mkdirSync(out, { recursive: true });
  const tgz = join(out, `automagik-am-${version}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", dir, ...readdirSync(dir)]);
  return tgz;
}

/** Posts am-lane's pointer to `version`'s tarball, signed with this run's key (or `sig`). */
function post(s, version, { tgz = join(s.releases, "download", `v${version}`, `automagik-am-${version}.tgz`), sig } = {}) {
  const bytes = readFileSync(tgz);
  const pointer = Buffer.from(JSON.stringify({
    schemaVersion: 1, publisher: "automagik", part: "automagik.am", keyId: "am-test", sequence: sequenceOf(version),
    issuedAt: "2026-11-03T00:00:00Z", repository: "https://github.com/automagik-dev/automagik", version, tag: `v${version}`, commit: "c".repeat(40),
    tarball: { name: `automagik-am-${version}.tgz`, url: `${REPOSITORY}/releases/download/v${version}/automagik-am-${version}.tgz`,
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength },
  }, null, 2));
  const lane = join(s.releases, "download", "am-lane");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "am.json"), pointer);
  writeFileSync(join(lane, "am.json.sig"), sig ?? sign(null, pointer, KEY.privateKey).toString("base64"));
}

const json = (r) => { assert.equal(r.stderr, "", r.stderr); return JSON.parse(r.stdout); };
const record = (s) => JSON.parse(readFileSync(join(s.store, "record.json"), "utf8"));
const versions = (s) => readdirSync(s.store).filter((n) => /^\d/.test(n)).sort();

test("every Bot verb's output is byte for byte the pack's automagik-herdr's, under am and the alias", (t) => {
  const s = scratch(t);
  assert.equal(s.am("self", "install").status, 0);
  const pack = join(PACK, "bin", "automagik-herdr");
  const alias = join(s.home, ".local", "bin", "automagik-herdr");
  for (const args of [["--version"], ["ls", "--json"], ["ls"], ["show", "nobody"], ["whois", "t1", "--json"], ["whois", "--bot", "x", "--json"],
    ["brief", "nobody"], ["category", "ls", "--json"], ["history", "nobody"], ["nonsense"]]) {
    const want = s.run(pack, args);
    for (const [name, got] of [["am", s.installed(...args)], ["automagik-herdr", s.run(alias, args)]]) {
      assert.deepEqual([got.status, got.stdout, got.stderr], [want.status, want.stdout, want.stderr], `${name} ${args.join(" ")}`);
    }
  }
  // The alias's help is the pack's too; am's adds its own verbs before it.
  assert.equal(s.run(alias, ["--help"]).stdout, s.run(pack, ["--help"]).stdout);
  const help = s.installed("help").stdout;
  assert.match(help, /^am: Automagik's one command/);
  assert.ok(help.endsWith(s.run(pack, ["--help"]).stdout));
});

test("am update --rollback and --auto are the pack's own update, as its help says", (t) => {
  const s = scratch(t);
  assert.equal(s.am("self", "install").status, 0);
  const pack = join(PACK, "bin", "automagik-herdr");
  for (const args of [["update", "--auto", "status"], ["update", "--auto=status", "--json"], ["update", "--rollback"], ["update", "--auto", "maybe"]]) {
    const want = s.run(pack, args);
    const got = s.installed(...args);
    assert.deepEqual([got.status, got.stdout, got.stderr], [want.status, want.stdout, want.stderr], `am ${args.join(" ")}`);
    assert.doesNotMatch(got.stderr, /unknown option/, `am ${args.join(" ")}`);
  }
  assert.match(s.installed("update", "--auto", "status").stdout, /^Install updates automatically: (?:on|off)\.$/m);
  // Named at am itself, the pack's switches do not run: nothing of the pack's is touched.
  for (const args of [["update", "automagik.am", "--rollback"], ["update", "automagik.am", "--auto", "status"], ["update", "--rollback", "automagik.am"]]) {
    const got = s.installed(...args);
    assert.equal(got.status, 2, `am ${args.join(" ")}`);
    assert.equal(got.stdout, "", `am ${args.join(" ")}`);
    assert.match(got.stderr, /^am: --rollback and --auto are herdr\.pack's own update, not automagik\.am's/, `am ${args.join(" ")}`);
  }
  // Any word but the pack's own id is refused, whatever its form.
  for (const word of ["am", "foo", "usagemeter", "Automagik.am", "AUTOMAGIK.AM", "Herdr.Pack", "herdr.am-quota", "", " ", "-x", "--automagik.am", "--herdr.pack"]) {
    for (const args of [["update", word, "--rollback"], ["update", "--rollback", word], ["update", "--auto=status", word], ["update", "--auto", "status", word]]) {
      const got = s.installed(...args);
      assert.equal(got.status, 2, `am ${args.join(" ")}`);
      assert.equal(got.stdout, "", `am ${args.join(" ")}`);
      assert.match(got.stderr, /^am: --rollback and --auto are herdr\.pack's own update/, `am ${args.join(" ")}`);
    }
  }
  // Named at the pack, they are the pack's own.
  const want = s.run(pack, ["update", "--auto", "status"]);
  const named = s.installed("update", "herdr.pack", "--auto", "status");
  assert.deepEqual([named.status, named.stdout], [want.status, want.stdout]);
  // An option neither knows is still am's usage error.
  const bad = s.installed("update", "--nope");
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [2, "", "am: unknown option --nope (am help)\n"]);
});

test("am update --retry-skipped is the pack's own recovery, as am's help says (#1486)", (t) => {
  const s = scratch(t);
  assert.equal(s.am("self", "install").status, 0);
  const pack = join(PACK, "bin", "automagik-herdr");
  // Forwarded as given: the pack decides what each combination does and what it exits with.
  for (const args of [["update", "--retry-skipped"], ["update", "--retry-skipped", "--json"], ["update", "herdr.pack", "--retry-skipped"],
    ["update", "--retry-skipped", "--check"], ["update", "--retry-skipped", "--auto", "status"]]) {
    const want = s.run(pack, args);
    const got = s.installed(...args);
    assert.deepEqual([got.status, got.stdout, got.stderr], [want.status, want.stdout, want.stderr], `am ${args.join(" ")}`);
    assert.doesNotMatch(got.stderr, /unknown option/, `am ${args.join(" ")}`);
  }
  // Named at another part, it does not run.
  for (const args of [["update", "automagik.am", "--retry-skipped"], ["update", "--retry-skipped", "foo"]]) {
    const got = s.installed(...args);
    assert.equal(got.status, 2, `am ${args.join(" ")}`);
    assert.equal(got.stdout, "", `am ${args.join(" ")}`);
    assert.match(got.stderr, /^am: --retry-skipped is herdr\.pack's own update, not /, `am ${args.join(" ")}`);
  }
  // am's own part of the help lists it.
  const help = s.installed("help").stdout;
  assert.match(help.slice(0, help.length - s.run(pack, ["--help"]).stdout.length), /--retry-skipped/);
});

test("self install: the store, the links and the briefing entry; doctor is healthy", (t) => {
  const s = scratch(t);
  const r = s.am("self", "install", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).detail.version, readFileSync(join(AM, "VERSION"), "utf8").trim());
  assert.equal(readlinkSync(join(s.home, ".local", "bin", "am")), join(s.store, "current", "bin", "am"));
  assert.equal(readFileSync(join(s.app, "automagik-herdr", "briefing.mjs"), "utf8"), readFileSync(join(PACK, "briefingEntry.mjs"), "utf8"),
    "the entry am writes is the pack's, byte for byte");
  assert.equal(record(s).current.signed, false);
  assert.equal(record(s).current.part.id, "automagik.am", "the store keeps its own copy of the manifest");
  const doctor = s.installed("self", "doctor", "--json");
  assert.equal(doctor.status, 0, doctor.stdout);
  const restart = doctor.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.check === "restart-path");
  assert.equal(restart?.ok, true);
  assert.match(restart.detail, /with am restart <bot>, never \/restart/);
  for (const line of doctor.stdout.trim().split("\n").map((l) => JSON.parse(l))) {
    assert.deepEqual(Object.keys(line).slice(0, 4), ["part", "check", "ok", "detail"]);
    assert.equal(line.ok, true, line.detail);
  }
});

test("update from a file:// am-lane: newer moves, a lower sequence is refused, rollback goes back, two copies kept", (t) => {
  const s = scratch(t);
  // Nothing posted yet: nothing to do, and that is not a failure.
  const none = s.am("update", "automagik.am", "--json");
  assert.equal(none.status, 0, none.stderr);
  assert.equal(json(none).am.state, "none");

  tarball(s, "3.70.1");
  post(s, "3.70.1");
  assert.equal(json(s.am("update", "automagik.am", "--check", "--json")).am.state, "available");
  assert.equal(existsSync(s.store), false, "--check installs nothing");
  const first = s.am("update", "automagik.am", "--json");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual([json(first).am.state, json(first).am.to], ["updated", "3.70.1"]);
  assert.equal(s.installed("--version").stdout.trim(), "am 3.70.1");
  assert.deepEqual([record(s).current.signed, record(s).current.sequence, record(s).seen], [true, sequenceOf("3.70.1"), sequenceOf("3.70.1")]);
  assert.equal(json(s.installed("update", "automagik.am", "--json")).am.state, "current");

  tarball(s, "3.70.2");
  post(s, "3.70.2");
  assert.equal(json(s.installed("update", "automagik.am", "--json")).am.to, "3.70.2");
  tarball(s, "3.71.0");
  post(s, "3.71.0");
  assert.equal(json(s.installed("update", "automagik.am", "--json")).am.to, "3.71.0");
  assert.deepEqual(versions(s), ["3.70.2", "3.71.0"], "only current and previous are kept");
  assert.equal(s.installed("--version").stdout.trim(), "am 3.71.0");

  // A replayed older pointer (validly signed) is refused, and nothing moves.
  post(s, "3.70.2");
  const older = s.installed("update", "automagik.am");
  assert.equal(older.status, 1);
  assert.match(older.stderr, /older than the newest this machine took \(sequence 710000\): refusing it/);
  assert.equal(s.installed("--version").stdout.trim(), "am 3.71.0");

  // Rollback goes back to the kept copy; the next update moves forward again.
  const back = s.installed("rollback", "automagik.am");
  assert.equal(back.status, 0, back.stderr);
  assert.equal(s.installed("--version").stdout.trim(), "am 3.70.2");
  assert.equal(record(s).seen, sequenceOf("3.71.0"), "a rollback keeps the newest sequence taken");
  post(s, "3.71.0");
  assert.equal(json(s.installed("update", "automagik.am", "--json")).am.to, "3.71.0");
  assert.equal(s.installed("--version").stdout.trim(), "am 3.71.0");
});

test("local self install, update and rollback use a symlinked am home", (t) => {
  const s = scratch(t);
  const amHome = dirname(dirname(s.store));
  const data = join(s.root, "data");
  mkdirSync(data);
  symlinkSync(data, amHome);
  const before = "3.70.1", next = "3.70.2";
  tarball(s, before);
  const first = s.run(join(s.root, `src-${before}/bin/am`), ["self", "install", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(record(s).current.version, before);
  assert.equal(realpathSync(s.store), join(data, "parts", "automagik.am"));
  tarball(s, next);
  post(s, next);
  const updated = s.installed("update", "automagik.am", "--json");
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(json(updated).am.to, next);
  const rollback = s.installed("rollback", "automagik.am");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(s.installed("--version").stdout.trim(), `am ${before}`);
  assert.equal(readlinkSync(join(s.home, ".local/bin/am")), join(s.store, "current/bin/am"));
  assert.equal(readlinkSync(amHome), data);
});

test("local mutations reconcile a pending linked install before changing the store", (t) => {
  const s = scratch(t);
  const before = "3.70.1", next = "3.70.2";
  tarball(s, before);
  post(s, before);
  assert.equal(s.am("update", "automagik.am").status, 0);
  const initial = record(s);
  const marker = join(s.store, ".verification-pending");
  const pending = JSON.stringify({ current: null, previous: null });
  writeFileSync(marker, pending);
  const launcher = join(s.store, initial.current.dir, "bin/am");
  const original = readFileSync(launcher);
  writeFileSync(launcher, "#!/bin/sh\necho 'am 3.0.0'\n");
  for (const args of [["self", "install"], ["update", "automagik.am"], ["rollback", "automagik.am"], ["self", "uninstall", "--purge"]]) {
    const r = s.am(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /^am [^\n]+: am launcher verification pending\. Retry `am machines install --machine <this machine>` from the controller\.\n$/);
    assert.deepEqual(record(s), initial);
    assert.equal(readFileSync(marker, "utf8"), pending);
    assert.equal(existsSync(join(s.store, ".lock")), false);
  }
  writeFileSync(launcher, original);
  const alias = join(s.home, ".local/bin/automagik-herdr");
  const target = readlinkSync(alias);
  rmSync(alias);
  assert.equal(s.am("update", "automagik.am").status, 1, "both links must resolve");
  assert.equal(readFileSync(marker, "utf8"), pending);
  symlinkSync(target, alias);
  assert.equal(json(s.am("update", "automagik.am", "--check", "--json")).am.state, "current");
  assert.equal(readFileSync(marker, "utf8"), pending, "a check leaves the marker in place");
  assert.equal(json(s.am("update", "automagik.am", "--json")).am.state, "current");
  assert.equal(existsSync(marker), false, "an update reconciles even with no new version");
  writeFileSync(marker, pending);
  tarball(s, next);
  post(s, next);
  assert.equal(json(s.am("update", "automagik.am", "--json")).am.state, "updated");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(record(s).previous, initial.current);
});

test("refused, with nothing installed: a tarball that is not the signed one, an unsigned pointer, an unsafe tarball", (t) => {
  const s = scratch(t);
  const tgz = tarball(s, "3.70.1");
  post(s, "3.70.1");
  writeFileSync(tgz, Buffer.concat([readFileSync(tgz), Buffer.from("x")]));
  const swapped = s.am("update", "automagik.am");
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /does not match the signed pointer/);

  tarball(s, "3.70.1");
  post(s, "3.70.1", { sig: "AAAA" });
  assert.match(s.am("update", "automagik.am").stderr, /signature does not match/);
  rmSync(join(s.releases, "download", "am-lane", "am.json.sig"));
  assert.match(s.am("update", "automagik.am").stderr, /am\.json\.sig is missing/);

  // The run's own keys only for a file:// folder: with none trusted (am-keys.json is empty), refused.
  post(s, "3.70.1");
  assert.match(s.run(join(AM, "bin", "am"), ["update", "automagik.am"], { AM_TRUSTED_KEYS: "" }).stderr, /a key this am does not trust/);

  tarball(s, "3.70.1", { tamper: (dir) => symlinkSync("/etc/passwd", join(dir, "evil")) });
  post(s, "3.70.1");
  assert.match(s.am("update", "automagik.am").stderr, /evil: not a plain file or folder/);
  assert.equal(existsSync(join(s.store, "current")), false);
});

test("the briefing entry point becomes a link into am's parts store: the pack's guard lifts, its placement leaves it", async (t) => {
  const s = scratch(t);
  const { contextOf, sidebarCarries } = await import(join(PACK, "parts.mjs"));
  const { placeEntry } = await import(join(PACK, "migrateHooks.mjs"));
  // A machine with the pack: the sidebar, its command link and its plain copy of the entry point.
  const sidebar = join(s.app, "mods", "am-sidebar");
  cpSync(PACK, sidebar, { recursive: true });
  const bin = join(s.home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(sidebar, "bin", "automagik-herdr"), join(bin, "automagik-herdr"));
  const entry = join(s.app, "automagik-herdr", "briefing.mjs");
  mkdirSync(dirname(entry), { recursive: true });
  cpSync(join(sidebar, "briefingEntry.mjs"), entry);
  const guard = () => sidebarCarries(contextOf({ env: s.env }));
  assert.equal(guard().length, 2, "before am: the command and every bot's briefing still need the sidebar");

  assert.equal(s.am("self", "install").status, 0);
  assert.ok(lstatSync(entry).isSymbolicLink(), "a link, not a copy");
  assert.equal(readlinkSync(entry), join(s.store, "current", "briefingEntry.mjs"));
  assert.ok(realpathSync(entry).startsWith(`${join(s.home, ".automagik", "parts")}/`), "it resolves into $AM_HOME/parts/");
  assert.deepEqual(guard(), [], "the sidebar may switch off now");
  // The pack's placement (an install, update or rollback) leaves am's link as it is, and quietly.
  const prev = process.env.HOME;
  process.env.HOME = s.home;
  try { assert.equal(placeEntry(s.app, "am-sidebar"), false); } finally { process.env.HOME = prev; }
  assert.equal(readlinkSync(entry), join(s.store, "current", "briefingEntry.mjs"));
  assert.equal(s.installed("self", "doctor").status, 0);

  // Uninstalling am hands the pack's own copy back: a plain file again, and the guard holds again.
  assert.equal(s.installed("self", "uninstall").status, 0);
  assert.ok(lstatSync(entry).isFile());
  assert.equal(readFileSync(entry, "utf8"), readFileSync(join(sidebar, "briefingEntry.mjs"), "utf8"));
  assert.equal(guard().length, 2);
});

test("uninstall removes am's links when they dangle (the store's copy gone), never leaving them (#550)", (t) => {
  const s = scratch(t);
  const bin = join(s.home, ".local", "bin");
  const entry = join(s.app, "automagik-herdr", "briefing.mjs");
  assert.equal(s.am("self", "install").status, 0);
  const links = [join(bin, "am"), join(bin, "automagik-herdr"), entry];
  for (const l of links) assert.ok(lstatSync(l).isSymbolicLink(), l);
  // The copy current names is gone, so every link into the store dangles. Node 24.0 to 24.9's
  // rmSync returned on a dangling link and left it, while uninstall reported it removed.
  rmSync(join(s.store, readlinkSync(join(s.store, "current"))), { recursive: true, force: true });
  for (const l of links) assert.equal(existsSync(l), false, `${l} dangles`);
  const gone = s.am("self", "uninstall");
  assert.equal(gone.status, 0, gone.stderr);
  for (const l of links) assert.equal(lstatSync(l, { throwIfNoEntry: false }), undefined, `${l} is gone`);
});

test("links: am takes the pack's automagik-herdr, leaves a foreign one, and hands it back on uninstall", (t) => {
  const s = scratch(t);
  const bin = join(s.home, ".local", "bin");
  const packCli = join(s.app, "mods", "am-sidebar", "bin", "automagik-herdr");
  mkdirSync(dirname(packCli), { recursive: true });
  writeFileSync(packCli, "#!/bin/sh\necho pack\n");
  mkdirSync(bin, { recursive: true });
  symlinkSync(packCli, join(bin, "automagik-herdr"));
  assert.equal(s.am("self", "install").status, 0);
  assert.equal(readlinkSync(join(bin, "automagik-herdr")), join(s.store, "current", "bin", "automagik-herdr"));

  const gone = s.installed("self", "uninstall");
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(readlinkSync(join(bin, "automagik-herdr")), packCli, "handed back to the pack's entry");
  assert.equal(readlinkSync(join(bin, "am")), packCli, "am goes to the pack's entry too, so the pack is not without it");
  assert.ok(existsSync(join(s.store, "current")), "the store stays without --purge");

  // Someone else's automagik-herdr is left alone, and doctor says so.
  rmSync(join(bin, "automagik-herdr"));
  symlinkSync("/usr/bin/true", join(bin, "automagik-herdr"));
  const again = s.am("self", "install");
  assert.match(again.stdout, /automagik-herdr: left \(it points at \/usr\/bin\/true\)/);
  assert.ok(lstatSync(join(bin, "automagik-herdr")).isSymbolicLink());
  assert.equal(readlinkSync(join(bin, "automagik-herdr")), "/usr/bin/true");
  assert.equal(s.installed("self", "doctor").status, 1);
});

test("links: the pack's am link (install.sh) goes to am on self install, both names run am, doctor passes, uninstall hands both back", (t) => {
  const s = scratch(t);
  const bin = join(s.home, ".local", "bin");
  const packCli = join(s.app, "mods", "am-sidebar", "bin", "automagik-herdr");
  mkdirSync(dirname(packCli), { recursive: true });
  writeFileSync(packCli, "#!/bin/sh\necho pack\n");
  mkdirSync(bin, { recursive: true });
  // The pack first, as install.sh leaves it: both names on the pack's wrapper.
  for (const name of ["am", "automagik-herdr"]) symlinkSync(packCli, join(bin, name));
  assert.equal(s.am("self", "install").status, 0);
  for (const name of ["am", "automagik-herdr"]) {
    assert.equal(readlinkSync(join(bin, name)), join(s.store, "current", "bin", name), `${name} is am's`);
  }
  assert.equal(s.installed("self", "doctor").status, 0);
  assert.match(s.run(join(bin, "automagik-herdr"), ["--version"]).stdout, /^am \d/, "the old name runs am");
  assert.match(s.run(join(bin, "am"), ["--version"]).stdout, /^am \d/);
  // Uninstall: the pack's entry back under both names, so the pack is not without am.
  assert.equal(s.installed("self", "uninstall").status, 0);
  for (const name of ["am", "automagik-herdr"]) assert.equal(readlinkSync(join(bin, name)), packCli, `${name} handed back`);
  // A person's own am (a link elsewhere) is still left alone.
  rmSync(join(bin, "am"));
  symlinkSync("/usr/bin/true", join(bin, "am"));
  const again = s.am("self", "install");
  assert.match(again.stdout, /am: left \(it points at \/usr\/bin\/true\)/);
  assert.equal(readlinkSync(join(bin, "am")), "/usr/bin/true");
});

test("a machine with no pack (work only): am update is am's alone, and herdr.pack is not applicable", (t) => {
  const s = scratch(t);
  const all = s.am("update", "--json");
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(json(all), { am: { state: "none", from: null, to: null, detail: "nothing is posted on am-lane yet" }, pack: { state: "not-installed" } });
  const pack = s.am("update", "herdr.pack");
  assert.equal(pack.status, 2);
  assert.match(pack.stderr, /the herdr pack is not installed on this machine/);
  assert.equal(existsSync(join(s.app, "mods")), false, "nothing of the pack was installed");
});

test("a self install records its version's sequence: an older signed pointer is refused after it", (t) => {
  const s = scratch(t);
  const version = readFileSync(join(AM, "VERSION"), "utf8").trim();
  assert.equal(s.am("self", "install").status, 0);
  assert.deepEqual([record(s).current.sequence, record(s).seen], [sequenceOf(version), sequenceOf(version)]);
  const [major, minor] = version.split(".").map(Number);
  const older = `${major}.${minor - 1}.0`;
  tarball(s, older);
  post(s, older);
  const r = s.installed("update", "automagik.am");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /older than the newest this machine took/);
  assert.equal(s.installed("--version").stdout.trim(), `am ${version}`);
});

test("one am at a time: a live lock refuses an update, a stale one is taken over", (t) => {
  const s = scratch(t);
  tarball(s, "3.70.1");
  post(s, "3.70.1");
  mkdirSync(s.store, { recursive: true });
  // A live process (this test) holds it: refused, nothing installed.
  writeFileSync(join(s.store, ".lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const held = s.am("update", "automagik.am");
  assert.equal(held.status, 1);
  assert.match(held.stderr, new RegExp(`another am \\(pid ${process.pid}\\) is installing or updating am`));
  assert.equal(existsSync(join(s.store, "current")), false);
  assert.equal(s.am("self", "install").status, 1, "a self install waits for the lock too");
  // Its process is gone: the lock is taken over, and released after.
  writeFileSync(join(s.store, ".lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const r = s.am("update", "automagik.am", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).am.to, "3.70.1");
  assert.equal(existsSync(join(s.store, ".lock")), false);
});

test("reinstalling the current version goes into a fresh folder: current never names a missing one", (t) => {
  const s = scratch(t);
  const version = readFileSync(join(AM, "VERSION"), "utf8").trim();
  assert.equal(s.am("self", "install").status, 0);
  const first = readlinkSync(join(s.store, "current"));
  assert.equal(first, version);
  assert.equal(s.am("self", "install").status, 0);
  const second = readlinkSync(join(s.store, "current"));
  assert.match(second, new RegExp(`^${version.replaceAll(".", "\\.")}-[0-9a-f]{6}$`));
  assert.equal(record(s).current.dir, second);
  assert.ok(existsSync(join(s.store, "current", "bin", "am.mjs")));
  assert.deepEqual(readdirSync(s.store).filter((n) => !n.startsWith(".") && /^\d/.test(n)), [second], "the replaced folder is pruned");
  assert.equal(s.installed("--version").stdout.trim(), `am ${version}`);
  // Run from the store itself, it is that folder: nothing is copied.
  assert.equal(s.installed("self", "install").status, 0);
  assert.equal(readlinkSync(join(s.store, "current")), second);
});

test("usage: exit 2 for an id am does not handle and an unknown option", (t) => {
  const s = scratch(t);
  assert.equal(s.am("rollback", "herdr.am-quota").status, 2);
  assert.equal(s.am("update", "--nope").status, 2);
  assert.equal(s.am("self", "dance").status, 2);
});

function signedScene(t) {
  const s = scratch(t);
  const lane = signedRelease(s.root);
  const signed = (version, options) => {
    const { dir, archive } = lane.pack(version, options);
    lane.post(version, archive);
    cpSync(archive, join(lane.lane, archive.split("/").pop()));
    return { dir, archive };
  };
  const env = { ...s.env, NODE_OPTIONS: process.env.NODE_OPTIONS, AM_RELEASE_URL: `file://${lane.releases}`, AM_TRUSTED_KEYS: undefined };
  const run = (file, ...args) => spawnSync("sh", [file, ...args], { env, cwd: s.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const candidate = (dir, ...args) => run(join(dir, "bin/am"), ...args);
  const installed = (...args) => run(join(s.home, ".local/bin/am"), ...args);
  const install = (dir) => candidate(dir, "self", "install", "--signed", lane.lane, "--json");
  const entry = join(s.app, "automagik-herdr/briefing.mjs");
  return { ...s, signed, lane, install, candidate, installed, entry };
}

test("signed install, update and rollback through the installed launcher keep linked entry mode", (t) => {
  const s = signedScene(t);
  const first = s.signed("3.162.4");
  const initial = s.install(first.dir);
  assert.equal(initial.status, 0, initial.stdout || initial.stderr);
  assert.deepEqual(json(initial), { part: "automagik.am", ok: true, changed: true, state: "installed", version: "3.162.4",
    sequence: 1620004, sha256: createHash("sha256").update(readFileSync(first.archive)).digest("hex") });
  assert.equal(record(s).entry, false);
  assert.equal(existsSync(s.entry), false);
  const again = s.install(first.dir);
  assert.equal(again.status, 0, again.stdout || again.stderr);
  assert.equal(json(again).state, "current");
  assert.equal(json(again).changed, false);
  const next = s.signed("3.162.5");
  const concurrent = s.install(next.dir);
  assert.equal(concurrent.status, 0, concurrent.stdout || concurrent.stderr);
  assert.deepEqual([json(concurrent).state, json(concurrent).version, json(concurrent).changed], ["installed", "3.162.4", false]);
  mkdirSync(dirname(s.entry), { recursive: true });
  writeFileSync(s.entry, "their stable entry\n");
  const update = s.installed("update", "automagik.am", "--json");
  assert.equal(update.status, 0, update.stdout || update.stderr);
  assert.equal(json(update).am.state, "updated");
  assert.equal(record(s).entry, false);
  assert.equal(s.installed("rollback", "automagik.am").status, 0);
  assert.equal(record(s).current.version, "3.162.4");
  assert.equal(record(s).entry, false);
  assert.equal(record(s).seen, 1620005);
  assert.equal(readFileSync(s.entry, "utf8"), "their stable entry\n");
  const doctor = s.installed("self", "doctor", "--json");
  assert.equal(doctor.status, 0, doctor.stdout || doctor.stderr);
  const lines = doctor.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(lines.find((line) => line.check === "briefing entry").detail, "a linked install writes no stable entry");
  assert.equal(lines.find((line) => line.check === "briefing hook").ok, true);
});

test("an update through a genuinely pre-9a rollback drops linked entry mode", (t) => {
  const s = signedScene(t);
  const old = s.signed("3.162.4", { edit: (dir) => {
    for (const path of ["bin/am", "bin/run.sh", "bin/am.mjs", "lib/self.mjs", "lib/lane.mjs"]) {
      const bytes = execFileSync("git", ["-C", AM, "show", `3e58d9d57:am/${path}`], { stdio: ["ignore", "pipe", "pipe"] });
      writeFileSync(join(dir, path), bytes);
    }
  } });
  // The pre-9a am was installed with no app home, then uninstalled without purging its tree.
  rmSync(s.app, { recursive: true });
  assert.equal(s.candidate(old.dir, "self", "install").status, 0);
  assert.equal(s.installed("self", "uninstall").status, 0);
  const next = s.signed("3.162.5");
  const installed = s.install(next.dir);
  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  mkdirSync(s.app, { recursive: true });
  assert.equal(s.installed("rollback", "automagik.am").status, 0);
  assert.equal(record(s).entry, false);
  assert.equal(record(s).current.version, "3.162.4");
  assert.equal(existsSync(s.entry), false);
  const update = s.installed("update", "automagik.am", "--json");
  assert.equal(update.status, 0, update.stdout || update.stderr);
  assert.equal(record(s).entry, undefined);
  assert.ok(lstatSync(s.entry).isSymbolicLink());
});

test("a fresh empty owner is busy; two contenders cannot both reclaim a stale am lock", async (t) => {
  const s = scratch(t);
  mkdirSync(s.store, { recursive: true });
  const lock = join(s.store, ".lock");
  writeFileSync(lock, "");
  assert.throws(() => lockStore(s.store), { state: "busy" });
  assert.equal(readFileSync(lock, "utf8"), "");
  utimesSync(lock, new Date(0), new Date(0));
  const ready = join(s.root, "ready"), go = join(s.root, "go"), child = promisify(execFile);
  const script = `import { lockStore } from ${JSON.stringify(new URL("../lib/self.mjs", import.meta.url).href)};
import { existsSync, appendFileSync } from 'node:fs';
const [store, ready, go] = process.argv.slice(1);
appendFileSync(ready, 'ready\\n');
while (!existsSync(go)) await new Promise((done) => setTimeout(done, 10));
try {
  const drop = lockStore(store);
  console.log('held');
  await new Promise((done) => setTimeout(done, 500));
  drop();
} catch (e) { console.log(e.state ?? e.message); }`;
  const workers = [0, 1].map(() => child(process.execPath, ["--input-type=module", "-e", script, s.store, ready, go]));
  for (const worker of workers) worker.catch(() => {});
  try {
    for (let i = 0; i < 150; i++) {
      if (existsSync(ready) && readFileSync(ready, "utf8") === "ready\nready\n") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(readFileSync(ready, "utf8"), "ready\nready\n");
  } finally { writeFileSync(go, "go\n"); }
  assert.deepEqual((await Promise.all(workers)).map((r) => r.stdout.trim()).sort(), ["busy", "held"]);
  assert.deepEqual(readdirSync(s.store), []);
});

test("a stale-lock reclaimer holds ownership until death even when its owner file is old", (t) => {
  const s = scratch(t);
  mkdirSync(s.store, { recursive: true });
  const lock = join(s.store, ".lock"), reclaim = `${lock}-reclaim`;
  const owner = join(reclaim, "owner-test.json");
  const staleLock = () => writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  staleLock();
  mkdirSync(reclaim);
  assert.throws(() => lockStore(s.store), { state: "busy" });
  utimesSync(reclaim, new Date(0), new Date(0));
  lockStore(s.store)();
  assert.deepEqual(readdirSync(s.store), []);
  for (const at of [Date.now(), Date.now() - 31_000]) {
    staleLock();
    mkdirSync(reclaim);
    writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.throws(() => lockStore(s.store), { state: "busy" });
    writeFileSync(owner, JSON.stringify({ pid: process.pid, at }));
    assert.throws(() => lockStore(s.store), { state: "busy" });
    writeFileSync(owner, JSON.stringify({ pid: 2 ** 22 + 12345, at }));
    lockStore(s.store)();
    assert.deepEqual(readdirSync(s.store), []);
  }
});

test("a reclaimer's reused PID with a different start identity is stale", (t) => {
  const s = scratch(t);
  const lock = join(s.store, ".lock");
  const reclaim = `${lock}-reclaim`;
  mkdirSync(reclaim, { recursive: true });
  writeFileSync(lock, "");
  utimesSync(lock, new Date(0), new Date(0));
  writeFileSync(join(reclaim, "owner-test.json"), JSON.stringify({ pid: process.pid, start: "start of a different process" }));
  const release = lockStore(s.store);
  try { assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid); }
  finally { release(); }
  assert.deepEqual(readdirSync(s.store), []);
});
