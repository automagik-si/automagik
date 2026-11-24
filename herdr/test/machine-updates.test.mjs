// Every machine linked into one Herdr follows the signed lanes (#954, machineUpdates.js): one
// `automagik-herdr machines update` on the computer that runs Herdr brings each linked machine's
// am and usagemeter to the versions the pointers name, each machine checking am-lane with its own
// keys; a machine that cannot verify the pointer refuses it and says why; a machine switched off is
// left alone. The linked machines are a fake hc's (test/fake-hc.mjs): scratch homes, each with a
// real am installed from this checkout at its own version. The lanes are file:// folders signed by
// keys made for this run. Never a real home, a real hc or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync,
  symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LINKED_UPDATE_ENV, MACHINES_EVERY_MS, MACHINES_KEY, START, UPDATE, entryLine, failureNotice, meterFollows, parseProbe, parseState,
  readUpdate, startCycle, stateAfter, stateLines, updateOn } from "../mods/am-sidebar/machineUpdates.js";
import { classify, installState } from "../mods/am-sidebar/amInstallState.js";
import { PACK_MODS } from "../mods/am-sidebar/release.js";
import { POINTER_SIG_URL, POINTER_URL } from "../mods/am-sidebar/update.mjs";
import { keys as packKeys, pointerBytes, signatureOf } from "./pointer.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { meterKey, publishMeter, writePointer } from "./meter-lane-fake.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AM = join(ROOT, "..", "am");
const CLI = join(ROOT, "mods", "am-sidebar", "bin", "automagik-herdr.mjs");
const FAKE_HC = join(ROOT, "test", "fake-hc.mjs");
const NODE_DIR = dirname(process.execPath);
const RELEASES = "https://github.com/automagik-dev/automagik/releases";
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const amKey = (keyId) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { keyId, privateKey, trusted: JSON.stringify({ keys: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }] }) };
};
const sequenceOf = (version) => { const [, n, p] = version.split(".").map(Number); return n * 10_000 + p; };
/** The pieces amInstallState.js reads a home with, for the fixture's own classification. */
const FSP = { accessSync, constants, lstatSync, readFileSync, readlinkSync, realpathSync };
const PATHS = { basename, dirname, join, resolve };

/**
 * A scratch Herdr: this computer (`here`: its am version, or null for none) and `machines`
 * ({ name: { am, meter, trusts?, state? } }: the am and the usagemeter each starts on; `trusts`: its
 * own am keys instead of the lane's), both lanes at `lane`.
 */
function herd(t, { here = null, machines, lane }) {
  const root = scratchRoot(t, "am-machines-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), release = join(root, "release");
  for (const d of [bin, home, app]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const key = amKey("am-test");
  const mKey = meterKey();
  const base = { PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root, AUTOMAGIK_HERDR_NO_UPDATE: "", GIT_CEILING_DIRECTORIES: dirname(root) };
  const amEnv = (trusted) => ({ AM_RELEASE_URL: `file://${release}`, AM_TRUSTED_KEYS: trusted });

  /** An am of this checkout at `version` (no test/), as a folder and as the release's tarball. */
  const sources = new Map();
  const source = (version) => {
    if (sources.has(version)) return sources.get(version);
    const dir = join(root, `am-src-${version}`);
    cpSync(AM, dir, { recursive: true, filter: (p) => !p.startsWith(join(AM, "test")) });
    writeFileSync(join(dir, "VERSION"), `${version}\n`);
    const out = join(release, "download", `v${version}`);
    mkdirSync(out, { recursive: true });
    execFileSync("tar", ["-czf", join(out, `automagik-am-${version}.tgz`), "-C", dir, ...readdirSync(dir)]);
    sources.set(version, dir);
    return dir;
  };
  /** Points am-lane at `version`, signed by this run's key (or `sig`, a text that does not verify). */
  const postAm = (version, { sig } = {}) => {
    source(version);
    const bytes = readFileSync(join(release, "download", `v${version}`, `automagik-am-${version}.tgz`));
    const pointer = Buffer.from(JSON.stringify({
      schemaVersion: 1, publisher: "automagik", part: "automagik.am", keyId: key.keyId, sequence: sequenceOf(version),
      issuedAt: "2026-11-10T00:00:00Z", repository: "https://github.com/automagik-dev/automagik", version, tag: `v${version}`, commit: "c".repeat(40),
      tarball: { name: `automagik-am-${version}.tgz`, url: `${RELEASES}/download/v${version}/automagik-am-${version}.tgz`,
        sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength },
    }, null, 2));
    const dir = join(release, "download", "am-lane");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "am.json"), pointer);
    writeFileSync(join(dir, "am.json.sig"), sig ?? sign(null, pointer, key.privateKey).toString("base64"));
  };
  const meterPointer = publishMeter(release, mKey, { version: lane });
  postAm(lane);

  const homes = { "": home };
  const envs = { "": { ...base, HOME: home, HERDR_APP_HOME: app, ...amEnv(key.trusted), AUTOMAGIK_HERDR_RELEASE_URL: `file://${release}`, AUTOMAGIK_HERDR_METER_KEYS: mKey.keys } };
  const plant = (name, version) => { const m = join(homes[name], ".local", "bin", "usagemeter"); mkdirSync(dirname(m), { recursive: true }); exe(m, `#!/bin/sh\necho "usagemeter ${version}"\n`); };
  const installAm = (name, version) => {
    const r = spawnSync("sh", [join(source(version), "bin", "am"), "self", "install"], { encoding: "utf8", env: { ...envs[name], HOME: homes[name] }, cwd: root });
    assert.equal(r.status, 0, r.stderr);
  };
  const list = Object.entries(machines).map(([name, m]) => {
    homes[name] = join(root, `m-${name}`);
    mkdirSync(homes[name], { recursive: true });
    // Its own environment: its own Herdr app home (none there), and the am keys it trusts.
    const env = { HERDR_APP_HOME: join(homes[name], ".config", "herdr-app"), ...amEnv(m.trusts ?? key.trusted) };
    envs[name] = { ...base, ...env };
    if (m.am) installAm(name, m.am);
    if (m.meter) plant(name, m.meter);
    return { name, state: m.state ?? "connected", uname: "Linux x86_64", home: homes[name], path: m.path ?? NODE_DIR, env: { ...env, ...(m.env ?? {}) } };
  });
  if (here) installAm("", here);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100, machines: list }));
  writeFileSync(logPath, "");
  const env = { ...envs[""], HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", cwd: root });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const store = (name) => join(homes[name], ".automagik", "parts", "automagik.am");
  const amOf = (name) => readFileSync(join(store(name), "current", "VERSION"), "utf8").trim();
  const recordOf = (name) => JSON.parse(readFileSync(join(store(name), "record.json"), "utf8"));
  const meterOf = (name) => spawnSync(join(homes[name], ".local", "bin", "usagemeter"), ["--version"], { encoding: "utf8" }).stdout.trim();
  const record = () => JSON.parse(readFileSync(join(app, "automagik-herdr", "linked-updates.json"), "utf8"));
  const execsOn = (name) => readJsonLines(logPath).filter((a) => a[0] === "exec" && a[a.indexOf("--on") + 1] === name);
  return { root, release, app, homes, envOf: (name) => envs[name], cli, store, amOf, recordOf, meterOf, record, execsOn, postAm, key, mKey, meterPointer, plant };
}

const entryOf = (out, machine) => out.entries.find((e) => e.machine === machine);

test("two linked machines on different versions both end on the pointers' versions; one that cannot verify the pointer refuses it", (t) => {
  const s = herd(t, { here: "3.2.0", lane: "3.3.0", machines: {
    old: { am: "3.1.0", meter: "3.1.0" },
    mid: { am: "3.2.0", meter: "3.2.0" },
    // Its am trusts another key: to it, the lane's pointer is one it cannot verify.
    wary: { am: "3.1.0", trusts: amKey("someone-else").trusted },
    gone: { state: "disconnected" },
  } });
  assert.deepEqual([s.amOf("old"), s.amOf("mid"), s.amOf("wary")], ["3.1.0", "3.2.0", "3.1.0"]);

  const run = s.cli("machines", "update", "--json");
  assert.equal(run.code, 0, run.err);
  const out = run.json();

  // Both are on the pointers' versions, with no one at either: am and usagemeter.
  for (const [name, from] of [["old", "3.1.0"], ["mid", "3.2.0"]]) {
    const e = entryOf(out, name);
    assert.equal(e.result, "updated", JSON.stringify(e));
    assert.deepEqual(e.versions, { am: "3.3.0", pack: null, meter: "3.3.0" });
    assert.equal(s.amOf(name), "3.3.0");
    assert.equal(s.meterOf(name), "usagemeter 3.3.0");
    // The trust is the machine's own: its record says a signed am-lane pointer and the tarball's sha256.
    const rec = s.recordOf(name);
    assert.equal(rec.current.signed, true);
    assert.equal(rec.current.source, "am-lane");
    assert.equal(rec.current.sha256, createHash("sha256").update(readFileSync(join(s.release, "download", "v3.3.0", "automagik-am-3.3.0.tgz"))).digest("hex"));
    // The rollback is kept: the am it replaced, and the usagemeter it replaced.
    assert.equal(rec.previous.version, from);
    assert.equal(readFileSync(join(s.store(name), "previous", "VERSION"), "utf8").trim(), from);
    assert.equal(spawnSync(join(s.homes[name], ".local", "bin", "usagemeter.prev"), ["--version"], { encoding: "utf8" }).stdout.trim(), `usagemeter ${from}`);
    assert.deepEqual(e.steps.map((p) => [p.part, p.state]), [["am", "updated"], ["pack", "absent"], ["meter", "updated"]]);
  }

  // The one that cannot verify the pointer refuses it, stays where it was, and says why.
  const wary = entryOf(out, "wary");
  assert.equal(wary.result, "failed");
  assert.match(wary.why.join("\n"), /^am: am lane: the pointer is signed by am-test, a key this am does not trust$/);
  assert.equal(wary.versions.am, "3.1.0");
  assert.equal(s.amOf("wary"), "3.1.0");
  assert.equal(s.recordOf("wary").previous, null);

  // This computer: its am follows the lane too (its pack is the sidebar updater's).
  const here = entryOf(out, null);
  assert.equal(here.result, "updated");
  assert.equal(s.amOf(""), "3.3.0");
  assert.deepEqual(here.steps.map((p) => [p.part, p.state]), [["am", "updated"]]);
  // A machine that is not connected is not asked anything.
  assert.equal(entryOf(out, "gone").result, "disconnected");
  assert.deepEqual(s.execsOn("gone"), []);

  // The computer that runs Herdr shows each machine's versions and its last update.
  assert.deepEqual(Object.keys(s.record().machines).sort(), ["gone", "mid", "old", "wary"]);
  const shown = s.cli("machines");
  assert.equal(shown.code, 0, shown.err);
  const lines = shown.out.trim().split("\n");
  assert.match(lines[0], /^this computer: am 3\.3\.0, pack none, usagemeter none\. pack auto: no pack; linked auto: on\. .*: am 3\.2\.0 → 3\.3\.0\.$/);
  assert.match(lines.find((l) => l.startsWith("old: ")), /^old: am 3\.3\.0, pack none, usagemeter 3\.3\.0\. pack auto: no pack; linked auto: on\. .*: am 3\.1\.0 → 3\.3\.0; usagemeter 3\.3\.0\.$/);
  assert.match(lines.find((l) => l.startsWith("mid: ")), /am 3\.2\.0 → 3\.3\.0/);
  assert.match(lines.find((l) => l.startsWith("wary: ")), /^wary: am 3\.1\.0, pack none, usagemeter none\. pack auto: no pack; linked auto: on\. .*: am not updated \(am lane: the pointer is signed by am-test, a key this am does not trust\)\.$/);
  assert.match(lines.find((l) => l.startsWith("gone: ")), /^gone: versions not known\. pack auto: unknown; linked auto: unknown\. .*not connected: nothing was checked\.$/);
  assert.deepEqual(s.cli("machines", "--machine", "old", "--json").json().linked, ["old"]);

  // The next cycle has nothing to do on the two, and still reports the third.
  const again = s.cli("machines", "update", "--json").json();
  assert.deepEqual(["old", "mid", "wary"].map((n) => entryOf(again, n).result), ["current", "current", "failed"]);
  assert.equal(s.recordOf("old").previous.version, "3.1.0");

  // Never a downgrade: a pointer re-posted for an older release is refused on each machine.
  s.postAm("3.2.0");
  const back = s.cli("machines", "update", "--linked", "--json").json();
  assert.equal(entryOf(back, null), undefined);
  for (const name of ["old", "mid"]) {
    assert.equal(entryOf(back, name).result, "failed");
    assert.match(entryOf(back, name).why[0], /older than the newest this machine took \(sequence 30000\): refusing it$/);
    assert.equal(s.amOf(name), "3.3.0");
  }
  // --machine: that one alone, and its failure is the command's.
  const one = s.cli("machines", "update", "--machine", "old");
  assert.equal(one.code, 1);
  assert.match(one.err, /old: am 3\.3\.0, .*am not updated/);
  assert.equal(s.cli("machines", "update", "--machine", "nobody").code, 2);
});

test("a pointer whose signature does not verify is refused everywhere: every machine stays as it was and says why", (t) => {
  const s = herd(t, { lane: "3.3.0", machines: { old: { am: "3.1.0", meter: "3.1.0" }, mid: { am: "3.2.0", meter: "3.2.0" } } });
  s.postAm("3.3.0", { sig: Buffer.from("not a signature").toString("base64") });
  writePointer(s.release, s.meterPointer, { sig: Buffer.from("not a signature").toString("base64") });
  const run = s.cli("machines", "update", "--json");
  assert.equal(run.code, 0, run.err);
  const out = run.json();
  for (const [name, at] of [["old", "3.1.0"], ["mid", "3.2.0"]]) {
    const e = entryOf(out, name);
    assert.equal(e.result, "failed");
    assert.match(e.why[0], /^am: am lane: the signature does not match$/);
    assert.match(e.why[1], /^usagemeter: the meter-lane pointer is not signed by a key this pack trusts/);
    assert.deepEqual(e.versions, { am: at, pack: null, meter: at });
    assert.equal(s.amOf(name), at);
    assert.equal(s.meterOf(name), `usagemeter ${at}`);
    assert.equal(existsSync(join(s.homes[name], ".local", "bin", "usagemeter.prev")), false);
    // The meter's pointer is refused here, before any machine is asked to download anything.
    assert.equal(s.execsOn(name).some((a) => a.includes("uname")), false);
  }
  // The sidebar says it once per set of reasons.
  const state = parseState(JSON.stringify(s.record()));
  const first = failureNotice(state, null);
  assert.equal(first.notice.title, "2 machines were not updated");
  assert.match(first.notice.body, /mid: am: am lane: the signature does not match/);
  assert.equal(failureNotice(state, first.sig).notice, null);
});

test("a machine opts out with its own switch: nothing runs there until it is on again; the default is on", (t) => {
  const s = herd(t, { lane: "3.3.0", machines: { old: { am: "3.1.0", meter: "3.1.0" } } });
  assert.deepEqual(s.cli("machines", "--auto", "status", "--machine", "old", "--json").json(), { machine: "old", on: true });
  const off = s.cli("machines", "--auto", "off", "--machine", "old");
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /^Updates from the Herdr old is linked into: off\./);
  assert.equal(readFileSync(join(s.homes.old, ".automagik", "linked-update"), "utf8"), "off\n");
  const before = s.execsOn("old").length;
  const out = s.cli("machines", "update", "--linked", "--json").json();
  assert.equal(entryOf(out, "old").result, "off");
  assert.deepEqual(entryOf(out, "old").versions, { am: "3.1.0", pack: null, meter: "3.1.0" });
  // One look (the versions and the switch), and nothing else there.
  assert.equal(s.execsOn("old").length, before + 1);
  assert.equal(s.amOf("old"), "3.1.0");
  assert.equal(s.meterOf("old"), "usagemeter 3.1.0");
  assert.match(s.cli("machines").out, /^old: am 3\.1\.0, pack none, usagemeter 3\.1\.0\. .*updates are off there/m);
  // This computer's own switch is the same file, in its own home.
  assert.deepEqual(s.cli("machines", "--auto", "off", "--json").json(), { machine: null, on: false });
  assert.equal(entryOf(s.cli("machines", "update", "--local", "--json").json(), null).result, "off");
  assert.deepEqual(s.cli("machines", "--auto", "on", "--json").json(), { machine: null, on: true });
  // On again: it follows the lanes.
  assert.equal(s.cli("machines", "--auto", "on", "--machine", "old").code, 0);
  assert.equal(existsSync(join(s.homes.old, ".automagik", "linked-update")), false);
  assert.equal(entryOf(s.cli("machines", "update", "--linked", "--json").json(), "old").result, "updated");
  assert.equal(s.amOf("old"), "3.3.0");
  assert.equal(s.meterOf("old"), "usagemeter 3.3.0");
  // Usage mistakes.
  assert.equal(s.cli("machines", "--auto", "maybe").code, 2);
  assert.equal(s.cli("machines", "update", "--auto", "off").code, 2);
  assert.equal(s.cli("machines", "install").code, 2);
  assert.equal(s.cli("machines", "update", "--linked", "--local").code, 2);
});

test("update checks switched off on this computer: a cycle runs nothing anywhere", (t) => {
  const s = herd(t, { lane: "3.3.0", machines: { old: { am: "3.1.0" } } });
  const r = spawnSync(process.execPath, [CLI, "machines", "update"], { encoding: "utf8", cwd: s.root,
    env: { PATH: `${join(s.root, "bin")}:${NODE_DIR}:/usr/bin:/bin`, HOME: s.homes[""], HERDR_APP_HOME: s.app, HC_FAKE_STATE: join(s.root, "hc.json"), HC_FAKE_LOG: join(s.root, "hc.log"), AUTOMAGIK_HERDR_NO_UPDATE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Update checks are off \(AUTOMAGIK_HERDR_NO_UPDATE=1\): nothing was updated anywhere\.$/m);
  assert.deepEqual(s.execsOn("old"), []);
  assert.equal(s.amOf("old"), "3.1.0");
});

// ---- the pack part takes the machine's automatic path (#1505) ----
// A linked machine with a pack install.sh installed: this checkout's am, its own app home, a real
// install record and a release served through the same fake-fetch preload update.test.mjs uses.
// The cycle runs the real am and the real update.mjs over hc's fake exec; only the network is faked,
// so the machine's auto-update.json and its skip are read by the product's own code.

const PACK_RELEASE = (version) => `https://dl.test/v${version}/automagik-herdr-pack-${version}.tgz`;
const SIDEBAR_PACK = join(ROOT, "mods", "am-sidebar");

/** The repo's pack at `version` as release.yml tars it: its PACK_MODS folders. */
function packRelease(root, version) {
  const tree = join(root, `pack-${version}`);
  mkdirSync(tree, { recursive: true });
  for (const mod of PACK_MODS) cpSync(join(ROOT, "mods", mod), join(tree, mod), { recursive: true });
  writeFileSync(join(tree, "am-sidebar", "VERSION"), `${version}\n`);
  const tgz = join(root, `automagik-herdr-pack-${version}.tgz`);
  execFileSync("tar", ["czf", tgz, "-C", tree, ...PACK_MODS], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return readFileSync(tgz);
}

/** An app home with the pack installed at `version` by install.sh, and its own switch(es). */
function installPack(appHome, { version = "0.1.0", auto = true, skip = null } = {}) {
  const mods = join(appHome, "mods");
  cpSync(SIDEBAR_PACK, join(mods, "am-sidebar"), { recursive: true });
  writeFileSync(join(mods, "am-sidebar", "VERSION"), `${version}\n`);
  const state = join(appHome, "automagik-herdr");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "installed-by-install.sh"), `version=${version}\nmods=am-sidebar\nbefore=none\nsequence=10000\n`);
  writeFileSync(join(state, "auto-update.json"), `${JSON.stringify({ auto, ...(skip ? { skip } : {}) }, null, 2)}\n`);
}

/** The fake fetch update.test.mjs uses: a URL to bytes table, never the network. */
function fakeFetchAt(root, table) {
  const data = join(root, "fetch.json");
  writeFileSync(data, JSON.stringify(Object.fromEntries(Object.entries(table).map(([url, body]) => [url, Buffer.from(body).toString("base64")]))));
  const preload = join(root, "fake-fetch.mjs");
  writeFileSync(preload, `import { readFileSync } from "node:fs";
const table = JSON.parse(readFileSync(process.env.AUTOMAGIK_TEST_FETCH, "utf8"));
globalThis.fetch = async (url) => {
  const body = table[String(url)];
  return body === undefined ? new Response("not found", { status: 404 }) : new Response(Buffer.from(body, "base64"));
};
`);
  return { data, preload };
}

/** The fake fleet: the pack installed on each machine, and the 0.2.0 release served by a fake fetch. */
function packFleet(t, { machines = ["off", "skipped", "diverge"], settings = {} } = {}) {
  const root = scratchRoot(t, "am-pack-machine-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 0\n");
  const body = packRelease(root, "0.2.0");
  const url = PACK_RELEASE("0.2.0");
  const pointer = pointerBytes("0.2.0", { url, body });
  const fetch = fakeFetchAt(root, { [POINTER_URL]: pointer, [POINTER_SIG_URL]: signatureOf(pointer), [url]: body });
  const target = { path: bin, env: { PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_OPTIONS: `--import ${fetch.preload}`,
    AUTOMAGIK_TEST_FETCH: fetch.data, AUTOMAGIK_HERDR_NO_UPDATE: "", AUTOMAGIK_HERDR_LINKED_UPDATE: "" } };
  const s = herd(t, { lane: "3.3.0", machines: Object.fromEntries(machines.map((name) => [name, { am: "3.3.0", ...target }])) });
  for (const name of machines) {
    // A test install trusts this run's key, as update.test.mjs's temp pack does.
    writeFileSync(join(s.store(name), "current", "pack-keys.json"), JSON.stringify({ keys: packKeys }));
    installPack(join(s.homes[name], ".config", "herdr-app"), settings[name] ?? {});
  }
  return {
    s, target, fetch,
    packVersion: (name) => readFileSync(join(s.homes[name], ".config", "herdr-app", "mods", "am-sidebar", "VERSION"), "utf8").trim(),
    settingsOf: (name) => JSON.parse(readFileSync(join(s.homes[name], ".config", "herdr-app", "automagik-herdr", "auto-update.json"), "utf8")),
    /** A person at that machine, with no cycle variable: the explicit retry the skip always yields to. */
    retry: (name) => {
      const env = { ...s.envOf(name), HOME: s.homes[name], PATH: target.env.PATH, NODE_OPTIONS: target.env.NODE_OPTIONS, AUTOMAGIK_TEST_FETCH: fetch.data };
      delete env.AUTOMAGIK_HERDR_LINKED_UPDATE;
      return spawnSync("sh", [join(s.homes[name], ".local", "bin", "am"), "update", "herdr.pack", "--retry-skipped", "--json"],
        { encoding: "utf8", env, cwd: s.root });
    },
  };
}

/**
 * #1874's host: no am part, and install.sh's `~/.local/bin/am` (and `automagik-herdr`) link to the
 * pack's own command under a scratch app home. The wrapper logs what it was asked and the automatic
 * mark (`calls`), moves its VERSION like a real install, and `PACK_MODE=fail` makes it refuse with a
 * real stderr line. `install`/`uninstall` run the checkout's own am, so the retained store and the
 * links' handback are the real ones, never simulated.
 */
function packOnly(t, { version = "3.169.0", latest = "3.170.1" } = {}) {
  const root = scratchRoot(t, "am-machines-1874-");
  const home = join(root, "home");
  const app = join(home, ".config", "herdr-app");
  const packDir = join(app, "mods", "am-sidebar");
  const cli = join(packDir, "bin", "automagik-herdr");
  const versionFile = join(packDir, "VERSION");
  const calls = join(root, "calls");
  const amHome = join(home, ".automagik");
  const release = join(root, "release");
  for (const dir of [join(packDir, "bin"), join(home, ".local", "bin"), amHome, release, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  writeFileSync(versionFile, `${version}\n`);
  writeFileSync(calls, "");
  exe(cli, [
    "#!/bin/sh",
    'printf "%s:%s\\n" "$' + LINKED_UPDATE_ENV + '" "$*" >> "$PACK_CALLS"',
    'case ${PACK_MODE:-ok} in fail) echo "the pack lane refused it" >&2; exit 1 ;; esac',
    `printf '%s\\n' "${latest}" > "$PACK_VERSION"`,
    `printf '%s\\n' '${JSON.stringify({ current: version, latest, installed: { version: latest } })}'`,
    "",
  ].join("\n"));
  for (const name of ["am", "automagik-herdr"]) symlinkSync(cli, join(home, ".local", "bin", name));
  const env = {
    HOME: home, HERDR_APP_HOME: app, PATH: `${NODE_DIR}:/usr/bin:/bin`, TMPDIR: join(root, "tmp"),
    PACK_CALLS: calls, PACK_VERSION: versionFile, AM_RELEASE_URL: `file://${release}`, AUTOMAGIK_HERDR_NO_UPDATE: "1",
  };
  const run = async (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: root, env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const lifecycle = (program, action) => {
    const r = spawnSync("sh", [program, "self", action], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  return {
    root, env, run,
    install: () => lifecycle(join(AM, "bin", "am"), "install"),
    uninstall: () => lifecycle(join(home, ".local", "bin", "am"), "uninstall"),
    calls: () => readFileSync(calls, "utf8").trim(),
    packVersion: () => readFileSync(versionFile, "utf8").trim(),
    retained: () => readFileSync(join(amHome, "parts", "automagik.am", "current", "VERSION"), "utf8").trim(),
    inspect: () => {
      const installation = installState({ home, amHome, appHome: app }, FSP, PATHS);
      return { command: installation.am.state, installation: classify(installation).state };
    },
  };
}

test("#1874: a pack-only host reads the pack's own answer, and this computer runs nothing", async (t) => {
  const f = packOnly(t);
  const now = () => new Date("2026-11-22T00:00:00Z");
  assert.deepEqual(f.inspect(), { command: "pack", installation: "pack" });

  // This computer (amOnly): no am part, so nothing runs; the pack is the sidebar updater's.
  const here = await updateOn(f.run, null, { now });
  assert.deepEqual(here.steps, [{ part: "am", state: "absent" }]);
  assert.equal(here.result, "current");
  assert.deepEqual(here.versions, { am: null, pack: "3.169.0", meter: null });
  assert.equal(f.calls(), "", "am update automagik.am never reaches the pack's command");

  // A linked machine there is pack-only: its own pack update runs, with the automatic mark.
  const there = await updateOn(f.run, "vm", { now });
  assert.deepEqual(there.steps, [{ part: "am", state: "absent" }, { part: "pack", state: "updated", from: "3.169.0", to: "3.170.1" }]);
  assert.equal(there.result, "updated");
  assert.deepEqual(there.why, []);
  assert.deepEqual(there.versions, { am: null, pack: "3.170.1", meter: null });
  assert.equal(f.calls(), "1:update --json");
});

test("#1874: after am self uninstall the retained store is not the active am", async (t) => {
  const f = packOnly(t);
  const now = () => new Date("2026-11-22T00:00:00Z");
  f.install();
  assert.deepEqual(f.inspect(), { command: "am", installation: "installed" });
  f.uninstall();
  assert.ok(f.retained().length, "the uninstall keeps the store");
  assert.deepEqual(f.inspect(), { command: "pack", installation: "pack" });

  const here = await updateOn(f.run, null, { now });
  assert.deepEqual(here.steps, [{ part: "am", state: "absent" }]);
  assert.equal(here.versions.am, null, "the retained am is not the active am");
  assert.equal(f.calls(), "");

  const there = await updateOn(f.run, "vm", { now });
  assert.deepEqual(there.steps, [{ part: "am", state: "absent" }, { part: "pack", state: "updated", from: "3.169.0", to: "3.170.1" }]);
  assert.deepEqual(there.versions, { am: null, pack: "3.170.1", meter: null });
  assert.deepEqual(there.why, []);
  assert.equal(f.calls(), "1:update --json");
});

test("#1874: am self install takes the pack's links back; the linked pack stays the machine's", async (t) => {
  const f = packOnly(t);
  const now = () => new Date("2026-11-22T00:00:00Z");
  f.install();
  const version = readFileSync(join(AM, "VERSION"), "utf8").trim();
  const here = await updateOn(f.run, null, { now });
  assert.deepEqual(here.steps, [{ part: "am", state: "current", to: version }]);
  assert.equal(f.calls(), "");
  const there = await updateOn(f.run, "vm", { now });
  assert.deepEqual(there.steps.map(({ part, state }) => [part, state]), [["am", "current"], ["pack", "off"]]);
  assert.equal(there.why.length, 0);
  assert.equal(f.calls(), "", "the machine's own pack update is the automatic path here");
});

test("#1874: a pack-only host with linked updates off runs nothing", async (t) => {
  const f = packOnly(t);
  writeFileSync(join(f.root, "home", ".automagik", "linked-update"), "off\n");
  const here = await updateOn(f.run, null, { now: () => new Date("2026-11-22T00:00:00Z") });
  assert.equal(here.result, "off");
  assert.equal(here.auto, false);
  assert.deepEqual(here.steps, []);
  assert.equal(f.calls(), "");
});

test("#1874: a real pack failure is the pack's failure, with its own line", async (t) => {
  const f = packOnly(t);
  f.env.PACK_MODE = "fail";
  const there = await updateOn(f.run, "vm", { now: () => new Date("2026-11-22T00:00:00Z") });
  assert.deepEqual(there.steps, [{ part: "am", state: "absent" }, { part: "pack", state: "failed", why: "the pack lane refused it" }]);
  assert.equal(there.result, "failed");
  assert.deepEqual(there.why, ["the pack: the pack lane refused it"]);
  assert.equal(f.packVersion(), "3.169.0");
  assert.equal(f.calls(), "1:update --json");
});

test("#1505 (a): the target's own am update --auto off holds the linked pack: the cycle installs nothing", (t) => {
  const f = packFleet(t, { machines: ["off"], settings: { off: { auto: false } } });
  const run = f.s.cli("machines", "update", "--linked", "--json");
  assert.equal(run.code, 0, run.err);
  const entry = entryOf(run.json(), "off");
  assert.equal(entry.result, "current");
  assert.equal(entry.auto, true, "the linked updater's switch is on");
  assert.equal(entry.packAuto, false, "the machine's own pack switch is off");
  assert.deepEqual(entry.steps.find((p) => p.part === "pack"), { part: "pack", state: "off", to: "0.1.0", why: "Install updates automatically is off" });
  assert.equal(f.packVersion("off"), "0.1.0", "the pack stays where the machine put it");
});

test("#1505 (b): a release rolled back on the target is not pushed again by the cycle", (t) => {
  const f = packFleet(t, { machines: ["skipped"], settings: { skipped: { skip: "0.2.0" } } });
  const run = f.s.cli("machines", "update", "--linked", "--json");
  assert.equal(run.code, 0, run.err);
  const entry = entryOf(run.json(), "skipped");
  assert.equal(entry.result, "current");
  assert.equal(entry.packAuto, true);
  assert.equal(entry.steps.find((p) => p.part === "pack").state, "off");
  assert.match(entry.steps.find((p) => p.part === "pack").why, /^0\.2\.0 was rolled back here: waiting for a newer release$/);
  assert.equal(f.packVersion("skipped"), "0.1.0", "the skipped release is not installed");
});

test("#1505 (c): a person's explicit retry still installs the skipped release, and clears the skip", (t) => {
  const f = packFleet(t, { machines: ["skipped"], settings: { skipped: { skip: "0.2.0" } } });
  // The cycle first leaves it alone (b), then the person asks for it.
  const cycle = f.s.cli("machines", "update", "--linked", "--json");
  assert.equal(cycle.code, 0, cycle.err);
  assert.equal(f.packVersion("skipped"), "0.1.0");
  const retry = f.retry("skipped");
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.packVersion("skipped"), "0.2.0", "the person's explicit retry installs it");
  assert.equal(f.settingsOf("skipped").skip, undefined, "and clears the record");
});

test("#1505 (d): am machines shows both switches per machine, including when they diverge", (t) => {
  const f = packFleet(t, { machines: ["off", "skipped", "diverge"], settings: { off: { auto: false }, skipped: { skip: "0.2.0" } } });
  assert.equal(f.s.cli("machines", "--auto", "off", "--machine", "diverge").code, 0);
  const run = f.s.cli("machines", "update", "--linked", "--json");
  assert.equal(run.code, 0, run.err);
  const shown = f.s.cli("machines");
  assert.equal(shown.code, 0, shown.err);
  const line = (name) => shown.out.trim().split("\n").find((l) => l.startsWith(`${name}: `));
  assert.match(line("off"), /^off: am 3\.3\.0, pack 0\.1\.0, usagemeter none\. pack auto: off; linked auto: on\. .*: the pack: Install updates automatically is off\.$/);
  assert.match(line("skipped"), /^skipped: am 3\.3\.0, pack 0\.1\.0, usagemeter none\. pack auto: on; linked auto: on\. .*: the pack: 0\.2\.0 was rolled back here/);
  assert.match(line("diverge"), /^diverge: am 3\.3\.0, pack 0\.1\.0, usagemeter none\. pack auto: on; linked auto: off\. .*: updates are off there/);
  const json = f.s.cli("machines", "--json").json();
  assert.deepEqual([json.machines.off.packAuto, json.machines.off.auto], [false, true]);
  assert.deepEqual([json.machines.skipped.packAuto, json.machines.skipped.auto], [true, true]);
  assert.deepEqual([json.machines.diverge.packAuto, json.machines.diverge.auto], [true, false]);
});

// ---- the pure parts ----

test("parseProbe: five lines, or nothing; both switches", () => {
  assert.deepEqual(parseProbe("am 3.1.0\npack -\nmeter ?\nauto off\npackauto -\n"), { am: "3.1.0", pack: null, meter: "?", auto: false, packAuto: null });
  assert.deepEqual(parseProbe("am -\npack 3.117.4\nmeter 3.116.0-dev\nauto on\npackauto off\n"), { am: null, pack: "3.117.4", meter: "3.116.0-dev", auto: true, packAuto: false });
  assert.deepEqual(parseProbe("am 3.1.0\npack 3.2.0\nmeter -\nauto on\npackauto on\n"), { am: "3.1.0", pack: "3.2.0", meter: null, auto: true, packAuto: true });
  assert.equal(parseProbe("am 3.1.0\npack -\nmeter -\nauto on\n"), null, "a probe that does not say both switches is not one");
  assert.equal(parseProbe("am 3.1.0\npack -\nmeter -\n"), null);
  assert.equal(parseProbe("am $(reboot)\npack -\nmeter -\nauto on\n"), null);
  assert.equal(parseProbe("am ?\npack -\nmeter -\nauto on\n"), null);
  assert.equal(parseProbe("am 3.1.0\npack -\nmeter -\nauto on\npackauto maybe\n"), null);
  assert.equal(parseProbe(""), null);
});

test("readUpdate: the machine's own answer, am then the pack; a refusal is that part's failure", () => {
  const am = (value, code = 0, stderr = "") => readUpdate({ code, stdout: `via am\n${JSON.stringify(value)}\n`, stderr });
  assert.deepEqual(am({ am: { state: "updated", from: "3.1.0", to: "3.3.0" }, pack: { state: "not-installed" } }),
    [{ part: "am", state: "updated", from: "3.1.0", to: "3.3.0" }, { part: "pack", state: "absent" }]);
  assert.deepEqual(am({ am: { state: "current", to: "3.3.0" }, pack: { current: "3.2.0", latest: "3.3.0", update: null, installed: { version: "3.3.0" } } })[1],
    { part: "pack", state: "updated", from: "3.2.0", to: "3.3.0" });
  assert.deepEqual(am({ am: { state: "none", from: "3.3.0", to: null, detail: "nothing is posted on am-lane yet" }, pack: { current: "3.3.0", latest: "3.3.0", update: null, installed: null } }),
    [{ part: "am", state: "current", to: "3.3.0" }, { part: "pack", state: "current", to: "3.3.0" }]);
  // The pack's own refusal: am prints null for it and the pack's line is on stderr.
  assert.deepEqual(am({ am: { state: "current", to: "3.3.0" }, pack: null }, 1, "am: Not updated: the signature does not match\n")[1],
    { part: "pack", state: "failed", why: "am: Not updated: the signature does not match" });
  // A release that did not load there: its previous pack is back, and it is said.
  assert.match(am({ am: { state: "current", to: "3.3.0" }, pack: { current: "3.2.0", installed: { version: "3.3.0", restored: { version: "3.2.0", failedVersion: "3.3.0" } } } })[1].why, /^3\.3\.0 did not load there; 3\.2\.0 is back$/);
  // The automatic path held it (#1505): the machine's own setting or its skip, not a failure.
  assert.deepEqual(am({ am: { state: "current", to: "3.3.0" }, pack: { current: "3.2.0", latest: "3.3.0", update: { version: "3.3.0" }, installed: null, held: "Install updates automatically is off" } })[1],
    { part: "pack", state: "off", to: "3.2.0", why: "Install updates automatically is off" });
  assert.equal(am({ am: { state: "current", to: "3.3.0" }, pack: { current: "3.2.0", disabled: true } })[1].state, "off");
  assert.deepEqual(readUpdate({ code: 0, stdout: "via none\n", stderr: "" }), [{ part: "am", state: "absent" }, { part: "pack", state: "absent" }]);
  assert.deepEqual(readUpdate({ code: 0, stdout: `via pack\n${JSON.stringify({ current: "3.3.0", update: null, installed: null })}\n`, stderr: "" }),
    [{ part: "am", state: "absent" }, { part: "pack", state: "current", to: "3.3.0" }]);
  assert.deepEqual(readUpdate({ code: 0, stdout: "via none\n", stderr: "" }, { amOnly: true }), [{ part: "am", state: "absent" }]);
  assert.deepEqual(readUpdate({ code: -1, stdout: "", stderr: "timed out after 600 s" }), [{ part: "am", state: "failed", why: "timed out after 600 s" }]);
  assert.deepEqual(readUpdate({ code: 1, stdout: "via am\n", stderr: "no supported runtime\n" }, { amOnly: true }), [{ part: "am", state: "failed", why: "no supported runtime" }]);
});

test("usagemeter follows the lane where there is one, everywhere when agreed to, never after --no-usagemeter", () => {
  assert.equal(meterFollows(null, "3.1.0"), true);
  assert.equal(meterFollows(null, null), false);
  assert.equal(meterFollows("local", null), false);
  assert.equal(meterFollows("all", null), true);
  assert.equal(meterFollows("none", "3.1.0"), false);
});

test("the record: a machine not connected keeps its last versions, one no longer linked is dropped", () => {
  const entry = (machine, result, am) => ({ machine, at: "2026-11-10T00:00:00.000Z", result, auto: true, versions: am ? { am, pack: null, meter: null } : null, steps: [], why: [] });
  let state = stateAfter(parseState(""), [entry(null, "current", "3.3.0"), entry("a", "current", "3.3.0"), entry("b", "current", "3.2.0")], { at: "t1", linked: ["a", "b"] });
  state = stateAfter(parseState(JSON.stringify(state)), [{ machine: "a", at: "t2", result: "disconnected", steps: [], why: [] }], { at: "t2", linked: ["a"] });
  assert.deepEqual(Object.keys(state.machines), ["a"]);
  assert.equal(state.machines.a.result, "disconnected");
  assert.equal(state.machines.a.versions.am, "3.3.0");
  assert.equal(state.here.versions.am, "3.3.0");
  assert.match(entryLine(state.machines.a), /^a: am 3\.3\.0, pack none, usagemeter none\. pack auto: unknown; linked auto: on\. t2: not connected: nothing was checked\.$/);
  assert.deepEqual(stateLines(parseState(""), ["new"]), ["new: not checked yet (am machines update)."]);
  assert.deepEqual(parseState("not json"), { at: null, here: null, machines: {} });
  // Nothing failed: nothing to say, and the signature is empty so a later failure is said.
  assert.deepEqual(failureNotice(state, "old reasons"), { sig: "", notice: null });
});

test("the sidebar starts one cycle an hour across its copies, and never waits for it", async () => {
  const shared = new Map();
  const calls = [];
  let now = 1_000_000;
  const io = { exec: async (...a) => { calls.push(a); return { code: 0 }; }, cli: "/app/mods/am-sidebar/bin/automagik-herdr", now: () => now, get: (k) => shared.get(k), set: (k, v) => shared.set(k, v) };
  assert.deepEqual(await startCycle(io), { started: true });
  assert.deepEqual(calls, [["sh", ["-c", START, "sh", io.cli]]]);
  assert.equal(shared.get(MACHINES_KEY), now);
  now += MACHINES_EVERY_MS - 1;
  assert.deepEqual(await startCycle(io), { started: false, why: "fresh" });
  now += 1;
  assert.deepEqual(await startCycle(io), { started: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(await startCycle({ ...io, now: () => now + MACHINES_EVERY_MS, exec: async () => { throw new Error("no sh"); } }), { started: false, why: "no-shell" });
  // START runs the CLI apart (setsid or nohup, in the background) and exits at once.
  assert.match(START, /machines update --json <\/dev\/null >\/dev\/null 2>&1 &/);
});
