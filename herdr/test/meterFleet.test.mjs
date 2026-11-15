// usagemeter on every linked machine (meterFleet.js, meterLane.mjs, `automagik-herdr meter`, the
// sidebar's sync fan-out). The linked machines are a fake hc's (test/fake-hc.mjs): `lin` (Linux
// x86_64, connected) and `off` (Linux aarch64, disconnected), each a scratch home folder; the
// release is a file:// folder whose meter-lane pointer is signed by a key made for this run
// (test/meter-lane-fake.mjs). The install script itself runs for real (sh, curl on file://,
// sha256). Nothing here reaches a real machine, a real hc or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPT_IN, assetFor, decodeExec, hcExecArgs, linkedMachines, meterScope, recordAfter, targetFor } from "../mods/am-sidebar/meterFleet.js";
import { METER_POINTER_URL, METER_TARGETS, meterKeys, meterSequenceOf, meterSource, readMeterLane, verifyMeterPointer } from "../mods/am-sidebar/meterLane.mjs";
import { METER_EVERY_MS, METER_EXEC_LIMIT_MS, METER_KEY, SYNC, syncMeter, syncTargets } from "../mods/am-sidebar/meter.js";
import { USAGEMETER, formatMarker, parseMarker } from "../mods/am-sidebar/release.js";
import { meterAfterUpdate } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { assetBytes, meterKey, publishMeter, writePointer } from "./meter-lane-fake.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "mods", "am-sidebar", "bin", "automagik-herdr.mjs");
const FAKE_HC = join(ROOT, "test", "fake-hc.mjs");
const V = "3.200.5";
const SEQ = 2_000_005;
const re = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * A scratch world: a fake hc with linked machines, an install record, and a release folder whose
 * meter lane names v`version` (publishMeter's options in `lane`). `machines` replaces the two.
 */
function fleet(t, { marker = true, version = V, lane = {}, machines = null, extraEnv = {} } = {}) {
  const root = scratchRoot(t, "am-fleet-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const home = join(root, "home"), app = join(root, "app"), mods = join(app, "mods");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(mods, "am-sidebar"), { recursive: true });
  mkdirSync(join(app, "automagik-herdr"), { recursive: true });
  const markPath = join(app, "automagik-herdr", "installed-by-install.sh");
  if (marker) writeFileSync(markPath, formatMarker({ version: "9.9.0", mods: ["am-sidebar"], layout: "added" }));
  const release = join(root, "release");
  const key = meterKey();
  const pointer = publishMeter(release, key, { version, ...lane });
  // Each machine: a home, and a curl that logs every file:// URL (the downloads) before the real one.
  const curlLog = join(root, "curl.log");
  writeFileSync(curlLog, "");
  const machine = (name, state, uname) => {
    const mhome = join(root, `m-${name}`), path = join(root, `m-${name}-bin`);
    mkdirSync(mhome, { recursive: true });
    mkdirSync(path, { recursive: true });
    exe(join(path, "curl"), `#!/bin/sh\nfor a; do case $a in file://*) echo "${name} $a" >> "${curlLog}" ;; esac; done\nexec /usr/bin/curl "$@"\n`);
    return { name, state, uname, home: mhome, path };
  };
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const list = (machines ?? [["lin", "connected", "Linux x86_64"], ["off", "disconnected", "Linux aarch64"]]).map((m) => machine(...m));
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100, machines: list }));
  writeFileSync(logPath, "");
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, HERDR_APP_HOME: app, TMPDIR: root,
    HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, AUTOMAGIK_HERDR_RELEASE_URL: `file://${release}`, AUTOMAGIK_HERDR_METER_KEYS: key.keys,
    GIT_CEILING_DIRECTORIES: dirname(root),
    ...extraEnv,
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const meterOf = (name) => join(root, `m-${name}`, ".local", "bin", "usagemeter");
  const says = (name) => spawnSync(meterOf(name), ["--version"], { encoding: "utf8" }).stdout.trim();
  const plant = (name, version) => { mkdirSync(dirname(meterOf(name)), { recursive: true }); exe(meterOf(name), `#!/bin/sh\necho "usagemeter ${version}"\n`); };
  const downloads = () => readFileSync(curlLog, "utf8").split("\n").filter(Boolean);
  const execs = () => readJsonLines(logPath).filter((a) => a[0] === "exec");
  const mark = () => parseMarker(readFileSync(markPath, "utf8"));
  const leftovers = (name) => (existsSync(dirname(meterOf(name))) ? readdirSync(dirname(meterOf(name))).filter((n) => n.startsWith(".usagemeter")) : []);
  const temps = () => readdirSync(root).filter((n) => n.startsWith("usagemeter."));
  return { root, home, mods, release, key, pointer, cli, meterOf, says, plant, downloads, execs, mark, leftovers, temps, markPath };
}

// ---- the pure parts ----

test("uname -sm picks the target (Pocket Link's aliases too, the Intel Mac kept); the pointer names its build", (t) => {
  assert.equal(targetFor("Linux x86_64\n"), "linux-x86_64");
  assert.equal(targetFor("Linux amd64"), "linux-x86_64");
  assert.equal(targetFor("Linux aarch64"), "linux-aarch64");
  assert.equal(targetFor("Linux arm64"), "linux-aarch64");
  assert.equal(targetFor("Darwin arm64"), "darwin-arm64");
  assert.equal(targetFor("Darwin x86_64"), "darwin-x86_64");
  assert.equal(targetFor("FreeBSD amd64"), null);
  assert.equal(targetFor(""), null);
  const s = fleet(t);
  const p = verifyMeterPointer(readFileSync(join(s.release, "download", "meter-lane", "meter.json")), readFileSync(join(s.release, "download", "meter-lane", "meter.json.sig"), "utf8"), JSON.parse(s.key.keys).keys);
  for (const [uname, name] of [["Darwin x86_64", "usagemeter-darwin-x86_64"], ["Darwin arm64", "usagemeter-darwin-arm64"], ["Linux x86_64", "usagemeter-linux-x86_64"], ["Linux aarch64", "usagemeter-linux-aarch64"]]) {
    assert.equal(assetFor(uname, p).name, name, uname);
    assert.equal(assetFor(uname, p).sha256, s.pointer.assets[targetFor(uname)].sha256);
  }
  assert.equal(assetFor("FreeBSD amd64", p), null);
  assert.deepEqual(USAGEMETER, { repo: "automagik-dev/automagik", lane: "meter-lane" }, "no version or hash is pinned any more");
});

test("the lane is this repository's meter-lane; a file:// test folder and its keys replace it, never for https", () => {
  assert.equal(METER_POINTER_URL, "https://github.com/automagik-dev/automagik/releases/download/meter-lane/meter.json");
  const real = meterSource({});
  assert.equal(real.pointer, METER_POINTER_URL);
  assert.equal(real.base("v3.108.17"), "https://github.com/automagik-dev/automagik/releases/download/v3.108.17");
  const file = meterSource({ AUTOMAGIK_HERDR_RELEASE_URL: "file:///tmp/rel/", AUTOMAGIK_HERDR_METER_KEYS: "{}" });
  assert.deepEqual([file.pointer, file.base("v3.1.2"), file.testKeys], ["file:///tmp/rel/download/meter-lane/meter.json", "file:///tmp/rel/download/v3.1.2", "{}"]);
  for (const url of ["https://evil.example/x", "https://github.com/automagik-dev/automagik/releases", "file:///tmp/../etc", "file:///tmp/%2e%2e"]) {
    const src = meterSource({ AUTOMAGIK_HERDR_RELEASE_URL: url, AUTOMAGIK_HERDR_METER_KEYS: "{}" });
    assert.equal(src.pointer, METER_POINTER_URL, url);
    assert.equal(src.testKeys, null, `${url}: the test keys are ignored`);
  }
  // The pack's own keys: the meter's public key, the copy of meter/usagemeter/meter-keys.json.
  assert.deepEqual(meterKeys().map((k) => k.keyId), ["meter-2026-11"]);
  assert.deepEqual(meterSequenceOf("3.108.17"), 1_080_017);
  assert.equal(meterSequenceOf("0.3.0"), null);
});

test("over https: the pointer comes through fetch, and a test's keys never count there", async (t) => {
  const s = fleet(t);
  const lane = join(s.release, "download", "meter-lane");
  const served = { [METER_POINTER_URL]: readFileSync(join(lane, "meter.json")), [`${METER_POINTER_URL}.sig`]: readFileSync(join(lane, "meter.json.sig")) };
  const asked = [];
  const fetch = async (url) => { asked.push(url); const body = served[url]; return { ok: !!body, status: body ? 200 : 404, arrayBuffer: async () => body }; };
  const env = { AUTOMAGIK_HERDR_METER_KEYS: s.key.keys };
  await assert.rejects(readMeterLane({ env, fetch }), /is not signed by a key this pack trusts \(meter-keys\.json\): nothing was installed/);
  const { pointer, base } = await readMeterLane({ env, fetch, keys: JSON.parse(s.key.keys).keys });
  assert.equal(pointer.version, V);
  assert.equal(base, `https://github.com/automagik-dev/automagik/releases/download/v${V}`);
  assert.deepEqual(asked.slice(0, 2), [METER_POINTER_URL, `${METER_POINTER_URL}.sig`]);
  await assert.rejects(readMeterLane({ env, fetch: async () => ({ ok: false, status: 404 }) }), /could not read the meter-lane pointer .*GitHub answered 404/);
});

/** Every way a pointer is refused: one line each, and the file:// lane never handed to a machine. */
test("a pointer is refused, whole, for each thing wrong with it", async (t) => {
  const s = fleet(t);
  const keys = JSON.parse(s.key.keys).keys;
  const env = { AUTOMAGIK_HERDR_RELEASE_URL: `file://${s.release}`, AUTOMAGIK_HERDR_METER_KEYS: s.key.keys };
  const read = (opts = {}) => readMeterLane({ env, ...opts });
  assert.equal((await read()).pointer.version, V, "the untouched pointer verifies");
  const refused = async (why, edit, { signer = s.key, sig = true } = {}) => {
    const p = JSON.parse(JSON.stringify(s.pointer));
    if (edit) edit(p);
    writePointer(s.release, p, { signer, sig });
    await assert.rejects(read(), (e) => { assert.match(e.message, why); assert.match(e.message, /: nothing was installed$/); assert.doesNotMatch(e.message, /\n/); return true; }, String(why));
  };
  const other = meterKey("meter-other");
  await refused(/is not signed by a key this pack trusts/, null, { signer: other }); // an unknown key
  await refused(/is not signed by a key this pack trusts/, (p) => { p.keyId = "meter-other"; }, { signer: other }); // an unknown key id
  await refused(/names the key meter-other, but meter-test signed it/, (p) => { p.keyId = "meter-other"; }); // a listed key, another id
  await refused(/has no signature/, null, { sig: false });
  await refused(/is not signed by a key this pack trusts/, null, { sig: "bm90IGEgc2lnbmF0dXJl\n" });
  // A byte changed after signing: the signature no longer matches.
  writePointer(s.release, s.pointer, { signer: s.key });
  const file = join(s.release, "download", "meter-lane", "meter.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(s.pointer.assets["linux-x86_64"].sha256, "f".repeat(64)));
  await assert.rejects(read(), /is not signed by a key this pack trusts/);
  await refused(/is not a usagemeter pointer \(schema 1, part automagik\.am\)/, (p) => { p.part = "automagik.am"; });
  await refused(/is not a usagemeter pointer \(schema 2/, (p) => { p.schemaVersion = 2; });
  await refused(/names another repository \(https:\/\/github\.com\/someone\/fork\)/, (p) => { p.repository = "https://github.com/someone/fork"; });
  await refused(/names another repository/, (p) => { p.publisher = "someone"; });
  await refused(/names the tag v3\.200\.4, not v3\.200\.5/, (p) => { p.tag = "v3.200.4"; });
  await refused(/names no release version \(0\.3\.0\)/, (p) => { p.version = "0.3.0"; p.tag = "v0.3.0"; });
  await refused(/has the sequence 9999999, not the one 3\.200\.5 has/, (p) => { p.sequence = 9_999_999; });
  await refused(/names no commit/, (p) => { p.commit = "HEAD"; });
  await refused(/does not name exactly the targets/, (p) => { delete p.assets["darwin-x86_64"]; });
  await refused(/does not name exactly the targets/, (p) => { p.assets["windows-x86_64"] = p.assets["linux-x86_64"]; });
  await refused(/names usagemeter-linux-x86_64 for linux-aarch64, not usagemeter-linux-aarch64/, (p) => { p.assets["linux-aarch64"] = { ...p.assets["linux-x86_64"] }; });
  await refused(/has usagemeter-linux-x86_64 at https:\/\/evil\.example\/usagemeter-linux-x86_64, off the tag v3\.200\.5/, (p) => { p.assets["linux-x86_64"].url = "https://evil.example/usagemeter-linux-x86_64"; });
  await refused(/off the tag v3\.200\.5/, (p) => { p.assets["linux-x86_64"].url = p.assets["linux-x86_64"].url.replace("v3.200.5", "v3.200.4"); });
  await refused(/names no sha256 for usagemeter-darwin-arm64/, (p) => { p.assets["darwin-arm64"].sha256 = "nope"; });
  await refused(/names no size for usagemeter-darwin-arm64/, (p) => { p.assets["darwin-arm64"].size = 0; });
  writePointer(s.release, [s.pointer], { signer: s.key });
  await assert.rejects(read(), /is not a JSON object/);
  // Test keys that are not a keys file refuse too, and none at all trust nothing.
  writePointer(s.release, s.pointer, { signer: s.key });
  await assert.rejects(readMeterLane({ env: { ...env, AUTOMAGIK_HERDR_METER_KEYS: "not json" } }), /AUTOMAGIK_HERDR_METER_KEYS is not a keys file/);
  assert.throws(() => verifyMeterPointer(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), []), /is not signed by a key this pack trusts/);
  assert.equal(verifyMeterPointer(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), keys).sequence, SEQ);
  assert.deepEqual(Object.keys(verifyMeterPointer(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), keys).assets).sort(), Object.keys(METER_TARGETS).sort());
});

test("no downgrade through the lane: a lower sequence than the one taken is refused; the same or none is taken", async (t) => {
  const s = fleet(t);
  const env = { AUTOMAGIK_HERDR_RELEASE_URL: `file://${s.release}`, AUTOMAGIK_HERDR_METER_KEYS: s.key.keys };
  assert.equal((await readMeterLane({ env, recorded: null })).pointer.sequence, SEQ);
  assert.equal((await readMeterLane({ env, recorded: SEQ })).pointer.sequence, SEQ);
  assert.equal((await readMeterLane({ env, recorded: SEQ - 1 })).pointer.sequence, SEQ);
  await assert.rejects(readMeterLane({ env, recorded: SEQ + 1 }),
    /^Error: the meter-lane pointer names 3\.200\.5 \(sequence 2000005\), older than the sequence 2000006 this install already took: refusing to downgrade: nothing was installed$/);
});

test("linked machines: temporary ones and names the record can't hold are left out", () => {
  const json = JSON.stringify({ machines: [
    { name: "lin", state: "connected" }, { name: "off", state: "disconnected" },
    { name: "tmp", state: "connected", temporary: true }, { name: "a b,c", state: "connected" }, { state: "connected" },
  ] });
  assert.deepEqual(linkedMachines(json), [{ name: "lin", connected: true }, { name: "off", connected: false }]);
  assert.deepEqual(linkedMachines("not json"), []);
  assert.deepEqual(hcExecArgs("lin", ["uname", "-sm"], 20), ["exec", "--json", "--timeout", "20", "--on", "lin", "--", "uname", "-sm"]);
});

test("hc exec --json is decoded: base64 output, a timeout or no JSON is a failure", () => {
  const b = (s) => Buffer.from(s).toString("base64");
  assert.deepEqual(decodeExec({ code: 0, stdout: JSON.stringify({ code: 3, stdout: b("x\n"), stderr: b("bad"), timed_out: false }) }, 10), { code: 3, stdout: "x\n", stderr: "bad" });
  assert.deepEqual(decodeExec({ code: 0, stdout: JSON.stringify({ code: null, timed_out: true }) }, 10), { code: -1, stdout: "", stderr: "timed out after 10 s" });
  assert.equal(decodeExec({ code: 1, stdout: "", stderr: "hc: lin is not connected\n" }, 10).stderr, "hc: lin is not connected");
});

test("the record: usagemeter-sequence, -machines and -scope round-trip; junk is dropped; recordAfter", () => {
  const base = { version: "1.0.0", mods: ["am-sidebar"], layout: "added" };
  const text = formatMarker({ ...base, usagemeter: V, usagemeterSequence: SEQ, usagemeterOn: { lin: V, "far.b": "0.2.0" }, usagemeterScope: "local" });
  assert.match(text, new RegExp(`\nusagemeter=${V.replace(/\./g, "\\.")}\nusagemeter-sequence=${SEQ}\nusagemeter-machines=lin:${V.replace(/\./g, "\\.")},far\\.b:0\\.2\\.0\nusagemeter-scope=local\n$`));
  const back = parseMarker(text);
  assert.equal(back.usagemeterSequence, SEQ);
  assert.equal(parseMarker(`${formatMarker(base)}usagemeter-sequence=-1\n`).usagemeterSequence, null);
  assert.equal(parseMarker(formatMarker(base)).usagemeterSequence, null);
  assert.deepEqual(back.usagemeterOn, { lin: V, "far.b": "0.2.0" });
  assert.equal(back.usagemeterScope, "local");
  assert.equal(formatMarker(back), text);
  assert.deepEqual(parseMarker(`${formatMarker(base)}usagemeter-machines=../x:1.0.0,ok:junk,ok2:1.2.3\nusagemeter-scope=everywhere\n`),
    { ...parseMarker(formatMarker(base)), usagemeterOn: { ok2: "1.2.3" }, usagemeterScope: null });
  assert.doesNotMatch(formatMarker(base), /usagemeter/);
  assert.deepEqual(recordAfter({ a: "0.2.0", b: V, c: V }, [
    { machine: "a", status: "installed", version: V }, { machine: "b", status: "newer", version: "9.0.0" },
    { machine: "c", status: "failed" }, { machine: null, status: "installed", version: V },
  ]), { a: V, c: V });
});

// ---- automagik-herdr meter install / uninstall ----

test("meter install --linked: the connected machine gets the pointer's build, sha256-checked; the other is a warning", (t) => {
  const s = fleet(t);
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, re(`usagemeter ${V} on lin: installed (signed pointer, checksum ok).`));
  assert.match(r.out, /Warning: usagemeter on off: skipped, the machine is not connected\./);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.equal(lstatSync(s.meterOf("lin")).mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(s.meterOf("lin")), assetBytes(s.release, s.pointer, "linux-x86_64"));
  assert.equal(sha(s.meterOf("lin")), s.pointer.assets["linux-x86_64"].sha256);
  assert.equal(existsSync(s.meterOf("off")), false);
  assert.deepEqual(s.leftovers("lin"), []);
  assert.deepEqual(s.temps(), []);
  // The machine downloaded its own asset once, from the version the pointer names; no checksums file.
  assert.deepEqual(s.downloads().map((l) => l.replace(/ file:.*\/download\//, " ")), [`lin v${V}/usagemeter-linux-x86_64`]);
  // Only lin was asked (never the disconnected one), and nothing ran on this computer.
  assert.deepEqual([...new Set(s.execs().map((a) => a[a.indexOf("--on") + 1]))], ["lin"]);
  assert.equal(existsSync(join(s.home, ".local", "bin", "usagemeter")), false);
  assert.deepEqual(s.mark().usagemeterOn, { lin: V });
  assert.equal(s.mark().usagemeterSequence, SEQ, "the pointer's sequence is recorded");
});

test("meter install on an Intel Mac: uname Darwin x86_64 gets usagemeter-darwin-x86_64", (t) => {
  const s = fleet(t, { machines: [["imac", "connected", "Darwin x86_64"], ["mini", "connected", "Darwin arm64"], ["pi", "connected", "Linux aarch64"]] });
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readFileSync(s.meterOf("imac")), assetBytes(s.release, s.pointer, "darwin-x86_64"));
  assert.deepEqual(readFileSync(s.meterOf("mini")), assetBytes(s.release, s.pointer, "darwin-arm64"));
  assert.deepEqual(readFileSync(s.meterOf("pi")), assetBytes(s.release, s.pointer, "linux-aarch64"));
  assert.deepEqual(s.downloads().map((l) => l.replace(/ file:.*\/download\//, " ")).sort(),
    [`imac v${V}/usagemeter-darwin-x86_64`, `mini v${V}/usagemeter-darwin-arm64`, `pi v${V}/usagemeter-linux-aarch64`]);
});

test("meter install: already the pointer's version is skipped with no download", (t) => {
  const s = fleet(t);
  assert.equal(s.cli("meter", "install", "--linked").code, 0);
  const before = s.downloads().length, kept = sha(s.meterOf("lin"));
  const again = s.cli("meter", "install", "--machine", "lin");
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, re(`usagemeter ${V} on lin: already installed.`));
  assert.equal(s.downloads().length, before);
  assert.equal(sha(s.meterOf("lin")), kept);
  assert.deepEqual(s.mark().usagemeterOn, { lin: V });
});

test("meter install: a build that is not the pointer's sha256 installs nothing, keeps the old binary and no temp file", (t) => {
  const s = fleet(t, { lane: { edit: (p) => { p.assets["linux-x86_64"].sha256 = "0".repeat(64); } } });
  s.plant("lin", "0.3.0");
  const kept = sha(s.meterOf("lin"));
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Warning: usagemeter on lin: usagemeter-linux-x86_64 is not the build the signed meter-lane pointer names \(sha256 [0-9a-f]{64}, expected 0{64}\): nothing was installed\./);
  assert.equal(sha(s.meterOf("lin")), kept, "the old binary stays");
  assert.equal(s.says("lin"), "usagemeter 0.3.0");
  assert.deepEqual(s.leftovers("lin"), []);
  assert.deepEqual(s.temps(), [], "the download's temp folder is removed");
  assert.deepEqual(s.mark().usagemeterOn, {});
  // Asked for that machine by name, the failure is the exit code.
  const one = s.cli("meter", "install", "--machine", "lin");
  assert.equal(one.code, 1);
  assert.match(one.err, /usagemeter on lin: .*is not the build the signed meter-lane pointer names/);
});

test("meter install: the sha256 is the signed pointer's, never the release's usagemeter.SHA256SUMS", (t) => {
  // The release's checksums file lies (it lists the real hashes, but the pointer names others): refused.
  const lying = fleet(t, { lane: { sums: (name, real) => `${real}  ${name}`, edit: (p) => { p.assets["linux-x86_64"].sha256 = "c".repeat(64); } } });
  assert.match(lying.cli("meter", "install", "--linked").out, /usagemeter-linux-x86_64 is not the build the signed meter-lane pointer names \(sha256 [0-9a-f]{64}, expected c{64}\)/);
  assert.equal(existsSync(lying.meterOf("lin")), false);
  // A checksums file that is wrong, or none at all, changes nothing when the pointer is right.
  const wrong = fleet(t, { lane: { sums: (name) => `${"0".repeat(64)}  ${name}` } });
  assert.match(wrong.cli("meter", "install", "--linked").out, /on lin: installed/);
  assert.equal(wrong.says("lin"), `usagemeter ${V}`);
});

test("meter install: a pointer that does not verify, or one older than the record's, is refused before any machine is asked", (t) => {
  const s = fleet(t);
  const other = meterKey("meter-other");
  writePointer(s.release, s.pointer, { signer: other });
  const unsigned = s.cli("meter", "install");
  assert.equal(unsigned.code, 1);
  assert.match(unsigned.err, /^am: usagemeter: the meter-lane pointer is not signed by a key this pack trusts \(meter-keys\.json\): nothing was installed\.$/m);
  writePointer(s.release, s.pointer, { signer: s.key, sig: false });
  assert.match(s.cli("meter", "install").err, /the meter-lane pointer has no signature/);
  // A newer pointer taken before: this older one is refused, on every machine and here.
  writePointer(s.release, s.pointer, { signer: s.key });
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterSequence: SEQ + 1 }));
  const older = s.cli("meter", "install");
  assert.equal(older.code, 1);
  assert.match(older.err, /names 3\.200\.5 \(sequence 2000005\), older than the sequence 2000006 this install already took: refusing to downgrade/);
  assert.deepEqual(s.execs(), [], "no machine was asked anything");
  assert.equal(existsSync(join(s.home, ".local", "bin", "usagemeter")), false);
  assert.equal(existsSync(s.meterOf("lin")), false);
  assert.equal(s.mark().usagemeterSequence, SEQ + 1, "the record is unchanged");
  assert.deepEqual(s.downloads(), []);
  // The same sequence again is taken; the record never goes down.
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterSequence: SEQ }));
  assert.equal(s.cli("meter", "install", "--linked").code, 0);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.equal(s.mark().usagemeterSequence, SEQ);
});

test("meter install with no install record: a verified pointer is taken; nothing to record it in", (t) => {
  const s = fleet(t, { marker: false });
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.equal(existsSync(s.markPath), false);
});

test("meter install: never a downgrade (a newer, a dev build, a link or no version stays); an older 0.3.0 is upgraded", (t) => {
  const s = fleet(t);
  s.plant("lin", "3.201.0");
  const kept = sha(s.meterOf("lin"));
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, re(`usagemeter 3.201.0 on lin is not older than ${V}: not replacing it.`));
  assert.equal(sha(s.meterOf("lin")), kept);
  assert.deepEqual(s.downloads(), []);
  assert.deepEqual(s.mark().usagemeterOn, {});
  s.plant("lin", `${V}-dev`);
  assert.match(s.cli("meter", "install", "--linked").out, /on lin is not older than/);
  s.plant("lin", "4.0.0");
  assert.match(s.cli("meter", "install", "--linked").out, /usagemeter 4\.0\.0 on lin is not older than/);
  exe(s.meterOf("lin"), "#!/bin/sh\necho 'something else'\n");
  assert.match(s.cli("meter", "install", "--linked").out, /on lin: ~\/\.local\/bin\/usagemeter reports no usagemeter version; left as it is/);
  assert.equal(readFileSync(s.meterOf("lin"), "utf8"), "#!/bin/sh\necho 'something else'\n");
  rmSync(s.meterOf("lin"));
  mkdirSync(s.meterOf("lin"));
  assert.match(s.cli("meter", "install", "--linked").out, /on lin: ~\/\.local\/bin\/usagemeter is a link or a folder; left as it is/);
  assert.deepEqual(s.downloads(), []);
  // The old upstream 0.3.0 is older: replaced, and recorded as the pack's.
  rmSync(s.meterOf("lin"), { recursive: true });
  s.plant("lin", "0.3.0");
  const up = s.cli("meter", "install", "--linked");
  assert.match(up.out, /on lin: installed \(signed pointer, checksum ok\)/);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.deepEqual(s.mark().usagemeterOn, { lin: V });
});

test("the new build runs once before the swap: anything but exactly `usagemeter <version>` keeps the old binary", (t) => {
  // Each build's sha256 is the pointer's: only the run catches it. The old binary stays, no temp is left.
  const cases = [
    ["another version", { reports: "3.200.4" }, /--version said: usagemeter 3\.200\.4\)/],
    ["a longer version, not a prefix", { reports: "3.200.50" }, /--version said: usagemeter 3\.200\.50\)/],
    ["more than the version", { script: () => `#!/bin/sh\necho "usagemeter ${V}"\necho extra\n` }, /--version said: usagemeter 3\.200\.5 extra\)/],
    ["one that does not run", { script: () => "#!/bin/sh\nexit 1\n" }, /--version said: nothing\)/],
  ];
  for (const [what, lane, said] of cases) {
    const s = fleet(t, { lane });
    s.plant("lin", "0.3.0");
    const kept = sha(s.meterOf("lin"));
    const r = s.cli("meter", "install", "--linked");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Warning: usagemeter on lin: the new usagemeter does not run as 3\.200\.5 \(--version said: /, what);
    assert.match(r.out, said, what);
    assert.match(r.out, /the old binary stays, nothing was installed\./, what);
    assert.equal(sha(s.meterOf("lin")), kept, `${what}: the old binary stays`);
    assert.deepEqual(s.leftovers("lin"), [], `${what}: no temp file beside it`);
    assert.deepEqual(s.temps(), [], `${what}: no temp folder`);
    assert.equal(existsSync(`${s.meterOf("lin")}.prev`), false, what);
    assert.deepEqual(s.mark().usagemeterOn, {}, what);
  }
});

test("the smoke run sees no variable but a bare PATH and a scratch HOME, and a build that hangs is cut off", (t) => {
  // A build that answers only under the minimal env: anything the caller's env carries would fail it.
  const s = fleet(t, { extraEnv: { METER_SMOKE_LEAK: "x", METER_STATE_DIR: "/nowhere" }, lane: { script: () => `#!/bin/sh
[ -z "\${METER_SMOKE_LEAK:-}\${METER_STATE_DIR:-}\${HC_FAKE_STATE:-}" ] && [ "$PATH" = /usr/bin:/bin ] && [ "$1" = --version ] && echo "usagemeter ${V}"
exit 0
` } });
  const r = s.cli("meter", "install", "--local");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /on this computer: installed \(signed pointer, checksum ok\)/);
  const hang = fleet(t, { lane: { script: () => "#!/bin/sh\nexec sleep 60\n" } });
  hang.plant("lin", "0.3.0");
  const started = Date.now();
  const h = hang.cli("meter", "install", "--linked");
  assert.ok(Date.now() - started < 40_000, "cut off at the smoke timeout, not left to hang");
  assert.match(h.out, /the new usagemeter does not run as 3\.200\.5 \(--version said: nothing\)/);
  assert.equal(hang.says("lin"), "usagemeter 0.3.0");
  assert.deepEqual(hang.leftovers("lin"), []);
});

test("a swap keeps the old binary as usagemeter.prev, its mode the binary's; one rename goes back", (t) => {
  const s = fleet(t);
  s.plant("lin", "0.3.0");
  chmodSync(s.meterOf("lin"), 0o750);
  const old = readFileSync(s.meterOf("lin"));
  const prev = `${s.meterOf("lin")}.prev`;
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, re(`usagemeter ${V} on lin: installed (signed pointer, checksum ok); the previous one is kept as ~/.local/bin/usagemeter.prev (to go back: mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter).`));
  assert.deepEqual(readFileSync(prev), old, ".prev is the old binary");
  assert.equal(lstatSync(prev).mode & 0o777, 0o750, "with the old binary's mode");
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.deepEqual(s.leftovers("lin"), []);
  // The next swap replaces it with the binary it replaces.
  publishMeter(s.release, s.key, { version: "3.200.6" });
  assert.match(s.cli("meter", "install", "--linked").out, /usagemeter 3\.200\.6 on lin: installed/);
  assert.deepEqual(readFileSync(prev), assetBytes(s.release, s.pointer, "linux-x86_64"), ".prev is now the 3.200.5 build");
  assert.equal(lstatSync(prev).mode & 0o777, 0o755);
  // Going back is the one rename the line names.
  const back = spawnSync("sh", ["-c", "mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter"], { env: { HOME: join(s.root, "m-lin"), PATH: "/usr/bin:/bin" } });
  assert.equal(back.status, 0);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.equal(existsSync(prev), false);
});

test("usagemeter.prev only ever holds a binary the swap replaced: never on a first install, a link, an unversioned or a newer one", (t) => {
  const s = fleet(t);
  const prev = `${s.meterOf("lin")}.prev`;
  assert.match(s.cli("meter", "install", "--linked").out, re(`usagemeter ${V} on lin: installed (signed pointer, checksum ok).`));
  assert.equal(existsSync(prev), false, "nothing replaced, nothing kept");
  for (const [what, make] of [["newer", () => s.plant("lin", "3.201.0")], ["unversioned", () => exe(s.meterOf("lin"), "#!/bin/sh\necho hello\n")]]) {
    rmSync(s.meterOf("lin"), { force: true });
    make();
    const before = readFileSync(s.meterOf("lin"));
    assert.equal(s.cli("meter", "install", "--linked").code, 0);
    assert.deepEqual(readFileSync(s.meterOf("lin")), before, what);
    assert.equal(existsSync(prev), false, `${what}: no .prev`);
  }
  // A .prev that is a folder (not a backup this keeps): nothing is replaced.
  rmSync(s.meterOf("lin"));
  s.plant("lin", "0.3.0");
  mkdirSync(prev);
  const r = s.cli("meter", "install", "--linked");
  assert.match(r.out, /usagemeter\.prev is a link or a folder, not the backup this keeps: nothing was installed/);
  assert.equal(s.says("lin"), "usagemeter 0.3.0");
  assert.deepEqual(s.leftovers("lin"), []);
});

test("meter install --machine: a disconnected machine exits 1, an unknown one 2; flags are exclusive", (t) => {
  const s = fleet(t);
  const off = s.cli("meter", "install", "--machine", "off");
  assert.equal(off.code, 1);
  assert.match(off.err, /usagemeter on off: skipped, the machine is not connected/);
  assert.equal(s.cli("meter", "install", "--machine", "nope").code, 2);
  assert.equal(s.cli("meter", "install", "--linked", "--local").code, 2);
  assert.equal(s.cli("meter", "frobnicate").code, 2);
  assert.deepEqual(s.execs(), []);
});

test("meter install --local: this computer only (update's path), recorded, no machine asked", (t) => {
  const s = fleet(t);
  const r = s.cli("meter", "install", "--local");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, re(`usagemeter ${V} on this computer: installed (signed pointer, checksum ok).`));
  const here = join(s.home, ".local", "bin", "usagemeter");
  assert.equal(spawnSync(here, ["--version"], { encoding: "utf8" }).stdout.trim(), `usagemeter ${V}`);
  assert.equal(s.mark().usagemeter, V);
  assert.equal(s.mark().usagemeterSequence, SEQ);
  assert.deepEqual(s.execs(), []);
  // The old upstream 0.3.0 here is upgraded the same way.
  writeFileSync(here, "#!/bin/sh\necho 'usagemeter 0.3.0'\n");
  assert.match(s.cli("meter", "install", "--local").out, /on this computer: installed/);
  assert.equal(spawnSync(here, ["--version"], { encoding: "utf8" }).stdout.trim(), `usagemeter ${V}`);
});

test("meter install with no hc: this computer only, the machines a note", (t) => {
  // The CLI also looks beside node for hc: a real one there would be found, so the case can't be made.
  if (existsSync(join(dirname(process.execPath), "hc"))) { t.skip("an hc sits beside node"); return; }
  const s = fleet(t);
  rmSync(join(s.root, "bin", "hc"));
  const r = s.cli("meter", "install", "--linked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /usagemeter on linked machines: skipped \(hc \(herdr-core\) is not on PATH\)\./);
});

test("meter uninstall: only where the record says the pack put it, and only that version", (t) => {
  const s = fleet(t);
  assert.equal(s.cli("meter", "install", "--linked").code, 0);
  const u = s.cli("meter", "uninstall");
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /Removed usagemeter on lin\. Its store is kept\./);
  assert.equal(existsSync(s.meterOf("lin")), false);
  assert.deepEqual(s.mark().usagemeterOn, {});
  // Not recorded (the person's own on lin): never asked, never removed.
  s.plant("lin", V);
  const none = s.cli("meter", "uninstall");
  assert.equal(none.code, 0, none.err);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  // Recorded, then replaced by a newer one: left. Recorded on a disconnected machine: left, kept.
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterOn: { lin: "0.2.0", off: V } }));
  const left = s.cli("meter", "uninstall");
  assert.match(left.out, new RegExp(`Left usagemeter on lin: it is usagemeter ${V.replace(/\./g, "\\.")}, not the one the pack put there\\.`));
  assert.match(left.out, /Left usagemeter on off: the machine is not connected\./);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
  assert.deepEqual(s.mark().usagemeterOn, { off: V });
  // Pocket Link beside the pack: every machine left, none asked.
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterOn: { lin: V } }));
  mkdirSync(join(s.mods, "pocket-link"));
  const before = s.execs().length;
  assert.match(s.cli("meter", "uninstall").out, /Left usagemeter on lin: Pocket Link .* runs it too\./);
  assert.equal(s.execs().length, before);
  assert.equal(s.says("lin"), `usagemeter ${V}`);
});

test("an old opt-out (no scope line, no usagemeter= line): update installs nowhere and says how to opt in", async (t) => {
  // What dev's install.sh --no-usagemeter left: a record with no usagemeter line at all.
  const s = fleet(t);
  assert.equal(meterScope(s.mark()), null);
  const calls = [];
  const io = { modsDir: s.mods, meter: async (args) => { calls.push(args); return { code: 0, stdout: '{"results":[],"notes":[]}' }; } };
  const r = await meterAfterUpdate(io);
  assert.deepEqual(r, { lines: [OPT_IN], results: [] });
  assert.match(OPT_IN, /am meter install$/);
  assert.deepEqual(calls, [], "nothing ran, here or on a machine");
  // The sidebar's sync stays on this computer too.
  assert.deepEqual(syncTargets([{ name: "lin", state: "connected" }], meterScope(s.mark())), []);
  // An old record never fans out (t22n's ruling): usagemeter= with no scope line is this computer
  // only; a machines line alone (only a meter install --machine writes one) says nothing of the rest.
  assert.equal(meterScope({ ...s.mark(), usagemeter: "0.2.0" }), "local");
  assert.equal(meterScope({ ...s.mark(), usagemeterOn: { lin: V } }), null);
  assert.equal(meterScope({ ...s.mark(), usagemeter: V, usagemeterScope: "all" }), "all");
  assert.equal(meterScope({ ...s.mark(), usagemeter: V, usagemeterScope: "none" }), "none");
  assert.equal(meterScope(null), null);
  // An explicit meter install is the yes: it records all (or local with --local), and update follows.
  assert.equal(s.cli("meter", "install", "--local").code, 0);
  assert.equal(s.mark().usagemeterScope, "local");
  assert.equal(s.cli("meter", "install").code, 0);
  assert.equal(s.mark().usagemeterScope, "all");
  assert.equal(s.cli("meter", "install", "--local").code, 0);
  assert.equal(s.mark().usagemeterScope, "all", "--local never narrows an all");
  await meterAfterUpdate(io);
  assert.deepEqual(calls, [["meter", "install", "--json"]]);
});

test("an old record with usagemeter= and no scope line: update installs on this computer only, the sidebar syncs here only", async (t) => {
  const s = fleet(t);
  // What an install.sh before this release left after installing usagemeter: usagemeter=0.2.0, no scope.
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeter: "0.2.0" }));
  assert.doesNotMatch(readFileSync(s.markPath, "utf8"), /usagemeter-scope/);
  assert.equal(meterScope(s.mark()), "local");
  const calls = [];
  const io = { modsDir: s.mods, meter: async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ results: [{ machine: null, status: "installed", version: V }], notes: [] }) }; } };
  assert.deepEqual((await meterAfterUpdate(io)).lines, [`usagemeter ${V} on this computer: installed (signed pointer, checksum ok).`]);
  assert.deepEqual(calls, [["meter", "install", "--json", "--local"]], "this computer only, never a linked machine");
  assert.deepEqual(syncTargets([{ name: "lin", state: "connected" }], meterScope(s.mark()), Object.keys(s.mark().usagemeterOn)), []);
  // The real new pack's CLI with --local: nothing is asked of a linked machine, and the scope stays local.
  const r = s.cli("meter", "install", "--json", "--local");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.execs(), []);
  assert.equal(existsSync(s.meterOf("lin")), false);
  assert.equal(s.mark().usagemeterScope, "local");
  // Only an explicit meter install fans out.
  assert.equal(s.cli("meter", "install").code, 0);
  assert.equal(s.mark().usagemeterScope, "all");
  assert.equal(s.says("lin"), `usagemeter ${V}`);
});

test("update runs the new pack's meter install, as the recorded scope says", async (t) => {
  const s = fleet(t);
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterScope: "all" }));
  const calls = [];
  const io = { modsDir: s.mods, meter: async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ results: [{ machine: "lin", status: "installed", version: V }], notes: [] }) }; } };
  assert.deepEqual((await meterAfterUpdate(io)).lines, [`usagemeter ${V} on lin: installed (signed pointer, checksum ok).`]);
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterScope: "local" }));
  await meterAfterUpdate(io);
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterScope: "none" }));
  assert.deepEqual((await meterAfterUpdate(io)).lines, ["usagemeter: skipped (install.sh --no-usagemeter)."]);
  assert.deepEqual(calls, [["meter", "install", "--json"], ["meter", "install", "--json", "--local"]]);
  writeFileSync(s.markPath, formatMarker({ ...s.mark(), usagemeterScope: "all" }));
  // A pack whose CLI can't answer: one warning, never a failed update.
  const bad = await meterAfterUpdate({ modsDir: s.mods, meter: async () => ({ code: 1, stdout: "", stderr: "boom\n" }) });
  assert.match(bad.lines[0], /^Warning: usagemeter was not checked: boom\./);
  // Without an injected runner, a test's modsDir never spawns anything.
  assert.deepEqual(await meterAfterUpdate({ modsDir: s.mods }), { lines: [], results: [] });
});

// ---- the sidebar's sync fan-out (meter.js) ----

test("sync fan-out: this computer, then each connected linked machine in turn; failures are silent", async () => {
  const machines = [{ name: "lin", state: "connected" }, { name: "off", state: "disconnected" }, { name: "tmp", state: "connected", temporary: true }];
  assert.deepEqual(syncTargets(machines, "all"), ["lin"]);
  assert.deepEqual(syncTargets(machines), [], "nobody asked: this computer only");
  assert.deepEqual(syncTargets(machines, "local"), []);
  // A machine a meter install --machine put it on is synced; a disconnected one never.
  assert.deepEqual(syncTargets(machines, null, ["lin", "off"]), ["lin"]);
  assert.deepEqual(syncTargets(machines, "local", ["lin"]), ["lin"]);
  assert.deepEqual(syncTargets(machines, "none", ["lin"]), []);
  assert.deepEqual(syncTargets(machines, "none"), []);
  const calls = [];
  const exec = async (bin, args, opts) => { calls.push([bin, args, opts?.on ?? null]); if (opts?.on === "far") throw new Error("unreachable"); return { code: 0 }; };
  const state = {};
  const r = await syncMeter({ exec, bin: "/h/.local/bin/usagemeter", state, machines: ["lin", "far"] });
  assert.deepEqual(calls, [["sh", ["-c", SYNC, "sh", "/h/.local/bin/usagemeter"], null], ["sh", ["-c", SYNC], "lin"], ["sh", ["-c", SYNC], "far"]]);
  assert.deepEqual(r.on, { lin: 0, far: null });
  assert.equal(r.started, true);
  assert.equal(state.busy, false);
  // No sh here (Herdr's exec rejects only when the program cannot start; a missing usagemeter is
  // SYNC's exit 0): the machines are still synced; no machines: the run is as before.
  const noShell = await syncMeter({ exec: async (bin, args, o) => { if (!o?.on) throw new Error("ENOENT"); return { code: 0 }; }, bin: "/x", machines: ["lin"] });
  assert.equal(noShell.started, false);
  assert.equal(noShell.why, "no-shell");
  assert.deepEqual(noShell.on, { lin: 0 });
  assert.equal("on" in await syncMeter({ exec: async () => ({ code: 0 }), bin: "/x" }), false);
});

test("a machine that hangs during sync: left at the 30 s limit (the caller's timer), the run goes on and ends, the next is due", async () => {
  assert.equal(METER_EXEC_LIMIT_MS, 30_000);
  // The injected timer, as main.js builds it on cx.timer (a mod has no timer functions): each
  // sleep is a promise the test ends by hand, and nothing here uses Node's timers.
  const sleeps = [];
  const sleep = (ms) => new Promise((done) => sleeps.push({ ms, done }));
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  const store = new Map();
  let clock = 1_000_000;
  const calls = [];
  // `hang` never answers (its sync is stuck); `lin` answers at once.
  const exec = (bin, args, opts) => { calls.push(opts?.on ?? "here"); return opts?.on === "hang" ? new Promise(() => {}) : Promise.resolve({ code: 0 }); };
  const state = {};
  const run = () => syncMeter({ exec, bin: "/h/usagemeter", now: () => clock, get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), state, machines: ["hang", "lin"], sleep });
  let done = null;
  const first = run().then((r) => { done = r; });
  await flush();
  assert.deepEqual(calls, ["here", "hang"], "one machine at a time: stuck on hang, lin not started");
  assert.deepEqual(sleeps.map((x) => x.ms), [METER_EXEC_LIMIT_MS], "hang is timed by the caller's sleep");
  assert.equal(done, null);
  assert.equal(state.busy, true, "the run is still going");
  sleeps[0].done(); // 30 s pass on the caller's timer
  await first;
  assert.deepEqual(calls, ["here", "hang", "lin"], "the run moved on to the next machine");
  assert.deepEqual(done.on, { hang: "timed out", lin: 0 });
  assert.equal(done.started, true);
  assert.equal(done.wait, METER_EVERY_MS, "the next look is scheduled as usual");
  assert.equal(state.busy, false, "the run is over: the next one may start");
  assert.equal(store.get(METER_KEY), 1_000_000);
  // The next run, when it is due, starts again from this computer.
  clock += METER_EVERY_MS;
  const again = run();
  await flush();
  sleeps[sleeps.length - 1].done();
  assert.equal((await again).started, true);
  assert.deepEqual(calls.slice(3), ["here", "hang", "lin"]);
  // A machine that answers in time is not cut off when its timer ends later.
  const quick = await syncMeter({ exec: async () => ({ code: 0 }), bin: "/x", machines: ["lin"], sleep: () => new Promise(() => {}) });
  assert.deepEqual(quick.on, { lin: 0 });
  // Without a timer (none given), nothing is timed here: Herdr's exec cap is the limit.
  assert.deepEqual((await syncMeter({ exec: async () => ({ code: 3 }), bin: "/x", machines: ["lin"] })).on, { lin: 3 });
});

test("SYNC on a machine: no binary is silent (exit 0); one there runs `sync`", (t) => {
  const home = scratchRoot(t, "am-sync-");
  const run = () => spawnSync("sh", ["-c", SYNC], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(run().status, 0);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  exe(join(home, ".local", "bin", "usagemeter"), `#!/bin/sh\necho "ran $*"\n`);
  assert.equal(run().stdout, "ran sync\n");
});

// usagemeter finds hc on PATH (METER_HC is its tests' own). Herdr started from the Dock, and hc
// exec on a linked machine, may run it without ~/.local/bin, where hc is: no terminal, label or
// machine id then reaches the meter. A fake hc and a fake usagemeter in a temp home only.
const hcWorld = (t) => {
  const home = scratchRoot(t, "am-sync-hc-");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\necho "fake hc $*"\n`);
  exe(join(bin, "usagemeter"), `#!/bin/sh\nprintf '%s\\n' "$PATH" > "$HOME/path"\n`
    + `hc machine-id > "$HOME/hc" 2>/dev/null || echo "no hc" > "$HOME/hc"\n`);
  const seen = () => ({ path: readFileSync(join(home, "path"), "utf8").trim(), hc: readFileSync(join(home, "hc"), "utf8").trim() });
  return { home, bin, seen };
};

test("SYNC on a machine: ~/.local/bin goes on PATH once, after what is there, so usagemeter finds hc", (t) => {
  const { home, bin, seen } = hcWorld(t);
  const run = (PATH) => spawnSync("/bin/sh", ["-c", SYNC], { env: { HOME: home, PATH }, encoding: "utf8" });
  assert.equal(run("/usr/bin:/bin").status, 0);
  assert.deepEqual(seen(), { path: `/usr/bin:/bin:${bin}`, hc: "fake hc machine-id" });
  // Already there (first, last or between): PATH is left as it is, in its order.
  for (const path of [`${bin}:/usr/bin:/bin`, `/usr/bin:/bin:${bin}`, `/usr/bin:${bin}:/bin`]) {
    run(path);
    assert.deepEqual(seen(), { path, hc: "fake hc machine-id" }, path);
  }
  // An empty PATH gets the folder alone, with no empty entry (the current folder) before it.
  run("");
  assert.deepEqual(seen(), { path: bin, hc: "fake hc machine-id" });
});

test("the local sync finds hc too: the same SYNC, with Herdr's absolute usagemeter path", async (t) => {
  const { home, bin, seen } = hcWorld(t);
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  // Herdr's exec: { code, stdout, stderr }, rejects only when the program can't start.
  const exec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { env }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") reject(err); else resolve({ code: err ? err.code : 0, stdout, stderr });
  }));
  const r = await syncMeter({ exec, bin: join(bin, "usagemeter"), state: {} });
  assert.deepEqual(r, { started: true, code: 0, wait: METER_EVERY_MS });
  assert.deepEqual(seen(), { path: `/usr/bin:/bin:${bin}`, hc: "fake hc machine-id" });
});
