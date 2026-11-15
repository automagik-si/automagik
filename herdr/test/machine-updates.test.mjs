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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MACHINES_EVERY_MS, MACHINES_KEY, START, entryLine, failureNotice, meterFollows, parseProbe, parseState, readUpdate, startCycle,
  stateAfter, stateLines } from "../mods/am-sidebar/machineUpdates.js";
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
    return { name, state: m.state ?? "connected", uname: "Linux x86_64", home: homes[name], path: NODE_DIR, env };
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
  return { root, release, app, homes, cli, store, amOf, recordOf, meterOf, record, execsOn, postAm, key, mKey, meterPointer, plant };
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
  assert.match(lines[0], /^this computer: am 3\.3\.0, pack none, usagemeter none\. .*: am 3\.2\.0 → 3\.3\.0\.$/);
  assert.match(lines.find((l) => l.startsWith("old: ")), /^old: am 3\.3\.0, pack none, usagemeter 3\.3\.0\. .*: am 3\.1\.0 → 3\.3\.0; usagemeter 3\.3\.0\.$/);
  assert.match(lines.find((l) => l.startsWith("mid: ")), /am 3\.2\.0 → 3\.3\.0/);
  assert.match(lines.find((l) => l.startsWith("wary: ")), /^wary: am 3\.1\.0, pack none, usagemeter none\. .*: am not updated \(am lane: the pointer is signed by am-test, a key this am does not trust\)\.$/);
  assert.match(lines.find((l) => l.startsWith("gone: ")), /^gone: versions not known\. .*not connected: nothing was checked\.$/);
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

// ---- the pure parts ----

test("parseProbe: four lines, or nothing", () => {
  assert.deepEqual(parseProbe("am 3.1.0\npack -\nmeter ?\nauto off\n"), { am: "3.1.0", pack: null, meter: "?", auto: false });
  assert.deepEqual(parseProbe("am -\npack 3.117.4\nmeter 3.116.0-dev\nauto on\n"), { am: null, pack: "3.117.4", meter: "3.116.0-dev", auto: true });
  assert.equal(parseProbe("am 3.1.0\npack -\nmeter -\n"), null);
  assert.equal(parseProbe("am $(reboot)\npack -\nmeter -\nauto on\n"), null);
  assert.equal(parseProbe("am ?\npack -\nmeter -\nauto on\n"), null);
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
  assert.match(entryLine(state.machines.a), /^a: am 3\.3\.0, pack none, usagemeter none\. t2: not connected: nothing was checked\.$/);
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
