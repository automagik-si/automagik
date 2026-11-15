// The pack's updates over a fake release: no network, a temp app home for mods/.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, fchmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  POINTER_SIG_URL, POINTER_URL, applyUpdate, checkForUpdate, compareVersions, downloadUpdate, fetchPointer, installUpdate, noticeText, packKeys,
  packOfPointer, parseSums, verifyPointer,
  checkMods, markerOf, moveHooks, offDirOf, packOut, pickUpdate, tightenLedgers, writeMarker, repairInstall, setupHome, toCheck, prevSetOf, readMarker, readVersion, relinkCli, rollback, staleLayoutLine, stateDirOf, unsafeEntries, verifySha256,
  autoFileOf, autoStatus, lockOf, managedPack, olderSequence, overtaken, readAuto, takeLock, writeAuto,
} from "../mods/am-sidebar/update.mjs";
import { CHECK_FILE, RESTORE_FILE, formatMarker, OFF_BY_DEFAULT, parseMarker } from "../mods/am-sidebar/release.js";
import { cmdUpdate } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { keys, pointerBytes, signatureOf } from "./pointer.mjs";

/** The herdr-lane release serving the pointer to `version` (pointerBytes' options), signed with the test key. */
const served = (version, opts = {}, { untrusted = false } = {}) => {
  const bytes = pointerBytes(version, opts);
  return { [POINTER_URL]: bytes, [POINTER_SIG_URL]: signatureOf(bytes, { untrusted }) };
};
const packOf = (version, opts) => packOfPointer(JSON.parse(pointerBytes(version, opts)));
import { OLD_PACK_NAME } from "../mods/am-sidebar/release.js";

const UPDATE = fileURLToPath(new URL("../mods/am-sidebar/update.mjs", import.meta.url));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// Every update now runs `herdr-app check` after its swap. This stand-in passes and logs, and is
// first on PATH for the whole file, so no test can reach the real herdr-app; a test that needs a
// failing or missing one passes its own `herdrApp`.
const HERDR_APP_BIN = mkdtempSync(join(tmpdir(), "herdr-app-bin-"));
const HERDR_APP_CALLS = join(HERDR_APP_BIN, "calls");
writeFileSync(join(HERDR_APP_BIN, "herdr-app"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${HERDR_APP_CALLS}"\nexit 0\n`);
chmodSync(join(HERDR_APP_BIN, "herdr-app"), 0o755);
// Restoration tests must never discover the host's live hc, even if cwd has a roster.
writeFileSync(join(HERDR_APP_BIN, "hc"), "#!/bin/sh\nprintf '%s\\n' '{\"terminals\":[]}'\n");
chmodSync(join(HERDR_APP_BIN, "hc"), 0o755);
process.env.PATH = `${HERDR_APP_BIN}:${process.env.PATH ?? ""}`;
after(() => rmSync(HERDR_APP_BIN, { recursive: true, force: true }));

/** A two-folder pack at `version` under `parent` (`mods` its PACK_MODS), as release.yml lays the tarball out. */
const MODS = ["am-sidebar", "am-tabs"];
function packDir(parent, version, { main = true, mod = true, mods = MODS } = {}) {
  for (const m of mods) {
    const dir = join(parent, m);
    mkdirSync(dir, { recursive: true });
    if (main || m !== "am-sidebar") writeFileSync(join(dir, "main.js"), `export const v = "${version}";\n`);
    if (mod || m !== "am-sidebar") writeFileSync(join(dir, "mod.json"), '{ "place": "none" }\n');
  }
  const pack = join(parent, "am-sidebar");
  writeFileSync(join(pack, "VERSION"), `${version}\n`);
  writeFileSync(join(pack, "release.js"), `export const PACK_MODS = ${JSON.stringify(mods)};\n`);
  writeFileSync(join(pack, "update.mjs"), "// the pack's updater\n");
  return pack;
}
function tarball(version, opts) {
  const src = mkdtempSync(join(tmpdir(), "pack-src-"));
  const tree = join(src, "tree");
  packDir(tree, version, opts);
  const out = join(src, `automagik-herdr-pack-${version}.tgz`);
  execFileSync("tar", ["czf", out, "-C", tree, ...(opts?.mods ?? MODS)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { path: out, buf: readFileSync(out), src };
}
/** An app home with the pack installed at `version` (or none), its ownership record listing it. */
function appHome(version, mods = MODS) {
  const home = mkdtempSync(join(tmpdir(), "app-home-"));
  const modsDir = join(home, "mods");
  mkdirSync(modsDir);
  if (version) {
    packDir(modsDir, version, { mods });
    mkdirSync(join(home, "automagik-herdr"));
    writeFileSync(join(home, "automagik-herdr", "installed-by-install.sh"), `version=${version}\nmods=${mods.join(",")}\nbefore=none\n`);
  }
  return { home, mods: modsDir };
}
const kept = (mods, m = "am-sidebar") => join(prevSetOf(mods), m);
/** fetch over a table url → body (string, Buffer, object for JSON, or a status number). */
const fakeFetch = (table, calls = []) => async (url, init) => {
  calls.push({ url, init });
  const body = table[url];
  if (body === undefined) return new Response("not found", { status: 404 });
  if (typeof body === "number") return new Response("", { status: body });
  if (Buffer.isBuffer(body) || typeof body === "string") return new Response(body);
  return Response.json(body);
};

test("compareVersions orders by semver precedence", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0-rc.1", "0.1.0"), -1);
  assert.ok(Number.isNaN(compareVersions("v0.1.0", "0.1.0")));
});

test("the marker carries the pointer's sequence; an unknown or malformed one is none", () => {
  const text = formatMarker({ version: "3.57.1", mods: ["am-sidebar"], sequence: 570001 });
  assert.equal(text, "version=3.57.1\nmods=am-sidebar\nbefore=none\nsequence=570001\n");
  assert.equal(parseMarker(text).sequence, 570001);
  assert.equal(parseMarker("version=1.0.0\nmods=a\n").sequence, null);
  assert.equal(parseMarker("version=1.0.0\nmods=a\nsequence=12x\n").sequence, null);
  assert.doesNotMatch(formatMarker({ version: "1.0.0", mods: ["a"] }), /sequence/);
});

test("pickUpdate offers only a newer pack than the installed one", () => {
  const up = pickUpdate("0.1.0", packOf("0.2.0"));
  assert.equal(up.version, "0.2.0");
  assert.equal(up.tarball.name, "automagik-herdr-pack-0.2.0.tgz");
  assert.match(up.sha256, /^[0-9a-f]{64}$/);
  assert.equal(up.page, "https://github.com/automagik-dev/automagik/releases/tag/v0.2.0");
  assert.equal(pickUpdate("0.2.0", packOf("0.2.0")), null, "same version");
  assert.equal(pickUpdate("0.3.0", packOf("0.2.0")), null, "older");
  assert.equal(pickUpdate("0.1.0", null), null, "no pointer");
  assert.equal(pickUpdate("0.0.0", packOf("0.1.0")).version, "0.1.0", "an unreleased install takes the first release");
  assert.equal(pickUpdate("0.8.0", packOf("3.57.1")).version, "3.57.1", "an automagik-herdr v0.8.x install takes the monorepo's pack");
  assert.match(noticeText(up), /Automagik Herdr 0\.2\.0 is out/);
});

test("packOfPointer refuses what is not this pack's pointer", () => {
  const bad = (extra, re) => assert.throws(() => packOfPointer({ ...JSON.parse(pointerBytes("3.57.1")), ...extra }), re);
  bad({ schemaVersion: 2 }, /schema 2/);
  bad({ part: "plugins" }, /part plugins/);
  bad({ version: "3.57" }, /names version 3\.57/);
  bad({ tarball: { name: "automagik-herdr-pack-3.57.2.tgz", url: "https://x/y", sha256: "a".repeat(64) } }, /not automagik-herdr-pack-3\.57\.1\.tgz/);
  bad({ tarball: { name: "automagik-herdr-pack-3.57.1.tgz", url: "https://x/y", sha256: "nope" } }, /sha256/);
  bad({ tarball: { name: "automagik-herdr-pack-3.57.1.tgz", sha256: "a".repeat(64) } }, /no tarball URL/);
  bad({ sequence: undefined }, /has no sequence/);
  bad({ sequence: "570001" }, /has no sequence/);
  bad({ sequence: -1 }, /has no sequence/);
  assert.equal(packOf("3.57.1").sequence, 570001);
});

test("fetchPointer: a good signature names the pack; a bad one, an untrusted key or no signature is refused", async () => {
  assert.equal(POINTER_URL, "https://github.com/automagik-dev/automagik/releases/download/herdr-lane/pack.json");
  assert.equal(POINTER_SIG_URL, `${POINTER_URL}.sig`);
  const calls = [];
  const got = await fetchPointer({ fetch: fakeFetch(served("3.57.1"), calls), env: {}, keys });
  assert.equal(got.version, "3.57.1");
  assert.deepEqual(calls.map((c) => c.url), [POINTER_URL, POINTER_SIG_URL], "the pointer and its signature: no search through releases");
  assert.equal(calls[0].init.headers["user-agent"], "automagik-herdr");
  // A bad signature (another key's, over the same bytes) is refused.
  await assert.rejects(fetchPointer({ fetch: fakeFetch(served("3.57.1", {}, { untrusted: true })), env: {}, keys }), /signature does not match: refusing it/);
  // A pointer changed after it was signed is refused.
  const table = served("3.57.1");
  table[POINTER_URL] = Buffer.from(table[POINTER_URL].toString().replace("3.57.1", "3.57.9"));
  await assert.rejects(fetchPointer({ fetch: fakeFetch(table), env: {}, keys }), /signature does not match/);
  // A key the pack does not list, and a pointer without its signature.
  await assert.rejects(fetchPointer({ fetch: fakeFetch(served("3.57.1", { keyId: "someone-else" })), env: {}, keys }), /signed by someone-else, a key this pack does not trust/);
  await assert.rejects(fetchPointer({ fetch: fakeFetch({ [POINTER_URL]: pointerBytes("3.57.1") }), env: {}, keys }), /404 for the pack pointer's signature/);
  // No pointer yet (404): no pack released here, no update. Updates off: nothing is asked.
  assert.equal(await fetchPointer({ fetch: fakeFetch({}), env: {}, keys }), null);
  const none = [];
  assert.equal(await fetchPointer({ fetch: fakeFetch(served("3.57.1"), none), env: { AUTOMAGIK_HERDR_NO_UPDATE: "1" }, keys }), null);
  assert.equal(none.length, 0);
  await assert.rejects(fetchPointer({ fetch: fakeFetch({ [POINTER_URL]: 500 }), env: {}, keys }), /500 for the pack pointer/);
  assert.throws(() => verifyPointer(Buffer.from("not json"), "", keys), /not JSON/);
});

test("the trusted keys are the installed pack's pack-keys.json", async () => {
  const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../mods/am-sidebar/pack-keys.json", import.meta.url)), "utf8")).keys;
  assert.deepEqual(packKeys(), shipped);
  for (const key of shipped) assert.doesNotMatch(key.publicKey, /PRIVATE/);
  // Without a key passed, a pointer signed by a key the shipped file does not list is refused.
  if (!shipped.some((k) => k.keyId === "herdr-pack-test")) {
    await assert.rejects(fetchPointer({ fetch: fakeFetch(served("3.57.1")), env: {} }), /a key this pack does not trust/);
  }
});

test("verifySha256 takes a match and refuses a mismatch or a missing name", () => {
  const buf = Buffer.from("pack");
  const sums = `${sha(buf)}  automagik-herdr-0.2.0.tgz\n${"0".repeat(64)} *other.tgz\n`;
  assert.equal(parseSums(sums).get("other.tgz"), "0".repeat(64));
  assert.equal(verifySha256(buf, sums, "automagik-herdr-0.2.0.tgz"), sha(buf));
  assert.throws(() => verifySha256(Buffer.from("tampered"), sums, "automagik-herdr-0.2.0.tgz"), /does not match its \.sha256/);
  assert.throws(() => verifySha256(buf, sums, "automagik-herdr-0.3.0.tgz"), /not in its \.sha256/);
});

test("downloadUpdate refuses a tampered tarball (not the signed pointer's sha256), writing nothing", async () => {
  const t = tarball("0.2.0");
  const out = mkdtempSync(join(tmpdir(), "dl-"));
  try {
    const up = pickUpdate("0.1.0", packOf("0.2.0", { body: t.buf }));
    const tampered = Buffer.concat([t.buf, Buffer.from("x")]);
    await assert.rejects(downloadUpdate(up, { fetch: fakeFetch({ [up.tarball.url]: tampered }), dir: out }), /does not match the signed pointer/);
    assert.equal(existsSync(join(out, up.tarball.name)), false);
    const path = await downloadUpdate(up, { fetch: fakeFetch({ [up.tarball.url]: t.buf }), dir: out });
    assert.deepEqual(readFileSync(path), t.buf);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("applyUpdate swaps the pack in, keeps the old one outside mods/, and rollback swaps back and forth", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  try {
    const project = join(home, "project", ".herdr");
    mkdirSync(project, { recursive: true });
    const roster = '{"version":1,"bots":[{"id":"b-aaaaaaaaaa","code":false,"agyMode":"plan"}]}\n';
    writeFileSync(join(project, "bots.json"), roster);
    const done = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.equal(readFileSync(join(project, "bots.json"), "utf8"), roster);
    assert.equal(done.version, "0.2.0");
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.2.0");
    assert.equal(done.prev, join(home, "automagik-herdr", ".prev"));
    assert.deepEqual(done.replaced, MODS);
    assert.equal(stateDirOf(mods), join(home, "automagik-herdr"));
    assert.equal(readVersion(kept(mods)), "0.1.0");
    assert.equal(readFileSync(join(kept(mods, "am-tabs"), "main.js"), "utf8"), 'export const v = "0.1.0";\n', "the whole set is kept");
    assert.deepEqual(execFileSync("ls", ["-A", mods], { encoding: "utf8" }).trim().split("\n"), MODS, "nothing else in mods/");
    assert.deepEqual(execFileSync("ls", ["-A", stateDirOf(mods)], { encoding: "utf8" }).trim().split("\n"), [".prev", "installed-by-install.sh"], "staging removed");
    assert.equal(readMarker(mods).version, "0.2.0");

    assert.equal(rollback({ modsDir: mods }).version, "0.1.0");
    assert.equal(readMarker(mods).version, "0.1.0");
    assert.equal(readVersion(kept(mods)), "0.2.0", "the rolled-back pack is kept");
    assert.equal(rollback({ modsDir: mods }).version, "0.2.0", "a second rollback undoes the first");

    const t3 = tarball("0.3.0");
    await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: mods });
    assert.equal(readVersion(kept(mods)), "0.2.0", "only one pack is kept");
    rmSync(t3.src, { recursive: true, force: true });
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyUpdate refuses a pack without main.js or mod.json and leaves the installed one", async () => {
  const { home, mods } = appHome("0.1.0");
  const noMain = tarball("0.2.0", { main: false });
  const noMod = tarball("0.2.0", { mod: false });
  try {
    await assert.rejects(applyUpdate({ tgzPath: noMain.path, version: "0.2.0", modsDir: mods }), /am-sidebar\/ has no main\.js and mod\.json/);
    await assert.rejects(applyUpdate({ tgzPath: noMod.path, version: "0.2.0", modsDir: mods }), /refusing/);
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.1.0");
    assert.equal(existsSync(prevSetOf(mods)), false);
    assert.deepEqual(execFileSync("ls", ["-A", stateDirOf(mods)], { encoding: "utf8" }).trim(), "installed-by-install.sh", "staging removed");
  } finally {
    for (const t of [noMain, noMod]) rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyUpdate installs into an empty mods/ and refuses a linked checkout; rollback needs a kept pack", async () => {
  const { home, mods } = appHome(null);
  const t = tarball("0.2.0");
  try {
    assert.throws(() => rollback({ modsDir: mods }), /nothing to roll back to/);
    const done = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.equal(done.prev, null);
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.2.0");
    rmSync(join(mods, "am-sidebar"), { recursive: true });
    symlinkSync(t.src, join(mods, "am-sidebar"));
    await assert.rejects(applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods }), /is a link/);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkForUpdate and installUpdate against a fake release", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
  const table = { ...served("0.2.0", { url, body: t.buf }), [url]: t.buf };
  try {
    const off = await checkForUpdate({ fetch: fakeFetch(table), env: { AUTOMAGIK_HERDR_NO_UPDATE: "1" }, modsDir: mods, keys });
    const { auto, ...rest } = off;
    assert.deepEqual(rest, { current: "0.1.0", latest: null, update: null, disabled: true });
    assert.equal(auto.managed, false, "an install record without sequence= (before signed releases) stays manual");
    const found = await checkForUpdate({ fetch: fakeFetch(table), env: {}, modsDir: mods, keys });
    assert.equal(found.current, "0.1.0");
    assert.equal(found.latest, "0.2.0");
    assert.equal(found.update.version, "0.2.0");
    const done = await installUpdate({ fetch: fakeFetch(table), env: {}, modsDir: mods, keys });
    assert.equal(done.installed.version, "0.2.0");
    assert.equal(readMarker(mods).sequence, 20000, "the update records the signed pointer's sequence");
    const again = await installUpdate({ fetch: fakeFetch(table), env: {}, modsDir: mods, keys });
    assert.equal(again.update, null);
    assert.equal(again.installed, null);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("node update.mjs apply and update both exit 5 after a restore", async () => {
  const t = tarball("0.2.0");
  const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
  const table = { ...served("0.2.0", { url, body: t.buf }), [url]: t.buf };
  const root = mkdtempSync(join(tmpdir(), "pack-cli-"));
  const pack = join(root, "am-sidebar");
  try {
    cpSync(dirname(UPDATE), pack, { recursive: true });
    // The temp pack trusts the test key, as a test install of this pack would.
    writeFileSync(join(pack, "pack-keys.json"), JSON.stringify({ keys }));
    const fetchFile = join(root, "fetch.json");
    writeFileSync(fetchFile, JSON.stringify(Object.fromEntries(Object.entries(table).map(([u, b]) => [u, Buffer.from(b).toString("base64")]))));
    const fakeFetch = join(root, "fake-fetch.mjs");
    writeFileSync(fakeFetch, `import { readFileSync } from "node:fs";
const table = JSON.parse(readFileSync(process.env.AUTOMAGIK_TEST_FETCH, "utf8"));
globalThis.fetch = async (url) => {
  const body = table[String(url)];
  return body === undefined ? new Response("not found", { status: 404 }) : new Response(Buffer.from(body, "base64"));
};
`);
    const run = (command, h) => {
      const app = fakeCheckApp(join(h.home, "bad"), ["am-tabs"]);
      const env = { ...process.env, HOME: h.home, HERDR_APP_HOME: h.home, AUTOMAGIK_TEST_FETCH: fetchFile,
        PATH: `${dirname(app.bin)}:${process.env.PATH ?? ""}` };
      delete env.AUTOMAGIK_HERDR_NO_UPDATE;
      return spawnSync(process.execPath, ["--import", fakeFetch, join(pack, "update.mjs"), command,
        ...(command === "update" ? ["--json"] : []), "--mods", h.mods], { env, encoding: "utf8" });
    };
    const homes = [autoHome(["0.2.0"]), autoHome(["0.2.0"])];
    try {
      const applied = run("apply", homes[0]);
      assert.equal(applied.status, 5, applied.stderr);
      const applyAnswer = JSON.parse(applied.stdout.trim().split("\n").at(-1));
      assert.equal(applyAnswer.installed.restored.version, "0.1.0");
      assert.equal(applyAnswer.installed.restored.failedVersion, "0.2.0");
      const updated = run("update", homes[1]);
      assert.equal(updated.status, 5, updated.stderr);
      const updateAnswer = JSON.parse(updated.stdout.trim().split("\n").at(-1));
      assert.equal(updateAnswer.installed.restored.version, "0.1.0");
      assert.equal(updateAnswer.installed.restored.failedVersion, "0.2.0");
    } finally { for (const h of homes) h.done(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(t.src, { recursive: true, force: true });
  }
});

test("node update.mjs: one JSON line, no network with AUTOMAGIK_HERDR_NO_UPDATE=1, rollback by CLI", () => {
  const { home, mods } = appHome("0.1.0");
  try {
    // HOME too: a rollback looks at $HOME/.local/bin, which must be a scratch one.
    const env = { ...process.env, HOME: home, HERDR_APP_HOME: home, AUTOMAGIK_HERDR_NO_UPDATE: "1" };
    const out = execFileSync(process.execPath, [UPDATE, "check"], { env, encoding: "utf8" });
    const { auto, ...answer } = JSON.parse(out);
    assert.deepEqual(answer, { current: "0.1.0", latest: null, update: null, disabled: true });
    assert.deepEqual(Object.keys(auto).sort(), ["managed", "on", "skip", "why"], "the setting rides along for the mod");
    let failed;
    try { execFileSync(process.execPath, [UPDATE, "rollback", "--mods", mods], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { failed = error; }
    assert.equal(failed.status, 1);
    assert.match(JSON.parse(failed.stdout).error, /nothing to roll back to/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** One ustar entry: `type` "0" file, "1" hard link, "2" symlink, "5" folder, "6" fifo. */
function tarEntry(name, { type = "0", body = "", linkname = "", mode = 0o644 } = {}) {
  const data = Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
/** A gzipped tarball of a valid 0.2.0 pack plus `extra` entries ([name, options]). */
function crafted(dir, file, extra) {
  const entries = [
    ["am-sidebar/", { type: "5", mode: 0o755 }],
    ["am-sidebar/main.js", { body: "export {};\n" }],
    ["am-sidebar/mod.json", { body: '{ "place": "left" }\n' }],
    ["am-sidebar/VERSION", { body: "0.2.0\n" }],
    ["am-sidebar/release.js", { body: 'export const PACK_MODS = ["am-sidebar"];\n' }],
    ["am-sidebar/update.mjs", { body: "//\n" }],
    ...extra,
  ];
  const path = join(dir, file);
  writeFileSync(path, gzipSync(Buffer.concat([...entries.map(([n, o]) => tarEntry(n, o)), Buffer.alloc(1024)])));
  return path;
}

test("unsafeEntries: only plain files and folders in pack folders, plus layouts/automagik.json", () => {
  assert.deepEqual(unsafeEntries(["am-sidebar/", "am-sidebar/main.js"], ["drwxr-xr-x 0 0 0 0 x am-sidebar/", "-rw-r--r-- 0 0 0 1 x am-sidebar/main.js"]), []);
  assert.match(unsafeEntries(["am-sidebar/l"], ["lrwxrwxrwx 0 0 0 0 x am-sidebar/l -> /etc"])[0], /not a plain file/);
  assert.match(unsafeEntries(["am-sidebar/h"], ["-rw-r--r-- 0 0 0 0 x am-sidebar/h link to am-sidebar/main.js"])[0], /not a plain file/);
  assert.match(unsafeEntries(["am-sidebar/../x"], ["-"])[0], /\.\. segment/);
  assert.match(unsafeEntries(["/etc/x"], ["-"])[0], /absolute/);
  assert.deepEqual(unsafeEntries(["am-tabs/main.js", "layouts/", "layouts/automagik.json"], ["-", "d", "-"]), []);
  for (const outside of ["evil.js", "pocket-link/main.js", "layouts/other.json", "Bad/x"]) {
    assert.match(unsafeEntries([outside], ["-"])[0], /outside the pack's folders/, outside);
  }
  assert.match(unsafeEntries([], [])[0], /empty/);
  assert.match(unsafeEntries(["a", "b"], ["-"])[0], /does not add up/);
});

test("applyUpdate refuses crafted tarballs (symlink, hard link, .., absolute, outside, fifo) and writes nothing", async () => {
  const { home, mods } = appHome("0.1.0");
  const dir = mkdtempSync(join(tmpdir(), "crafted-"));
  const cases = {
    symlink: [["am-sidebar/link", { type: "2", linkname: "/etc" }]],
    hardlink: [["am-sidebar/hard", { type: "1", linkname: "am-sidebar/main.js" }]],
    dotdot: [["am-sidebar/../evil.js", { body: "x" }]],
    absolute: [[`${home}/evil.js`, { body: "x" }]],
    outside: [["evil.js", { body: "x" }]],
    fifo: [["am-sidebar/pipe", { type: "6" }]],
  };
  try {
    for (const [label, extra] of Object.entries(cases)) {
      const tgz = crafted(dir, `${label}.tgz`, extra);
      await assert.rejects(applyUpdate({ tgzPath: tgz, version: "0.2.0", modsDir: mods }), /refusing it|Command failed/, label);
      assert.equal(readVersion(join(mods, "am-sidebar")), "0.1.0", `${label}: installed pack kept`);
      assert.equal(existsSync(join(home, "evil.js")), false, `${label}: nothing written outside`);
      assert.equal(existsSync(join(stateDirOf(mods), "evil.js")), false, `${label}: nothing written beside`);
    }
    const plain = crafted(dir, "plain.tgz", []);
    assert.equal((await applyUpdate({ tgzPath: plain, version: "0.2.0", modsDir: mods })).version, "0.2.0", "the same pack without them installs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyUpdate refuses a tarball whose VERSION is not the release's, and needs the version", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  try {
    await assert.rejects(applyUpdate({ tgzPath: t.path, version: "0.3.0", modsDir: mods }), /carries VERSION 0\.2\.0, not 0\.3\.0/);
    await assert.rejects(applyUpdate({ tgzPath: t.path, modsDir: mods }), /needs the release's version/);
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.1.0");
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pack made as release.yml makes it (git archive of the tag's mods/am-sidebar) installs", async (t) => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, stdio: "ignore" });
  } catch {
    t.skip("not a git checkout (an export?): git archive needs the repository's history");
    return;
  }
  const { home, mods } = appHome(null);
  const tgz = join(home, "pack.tgz");
  try {
    // release.yml's "Pack the herdr pack" step: the tag's PACK_MODS folders of herdr/mods/ plus
    // the pack's layout (herdr-layout/layouts/ at the top), from the repository's top (archive in a
    // subfolder lists only its paths).
    const { PACK_MODS } = await import("../mods/am-sidebar/release.js");
    const topDir = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: repo, encoding: "utf8" }).trim();
    const layout = join(home, "automagik.json");
    writeFileSync(layout, execFileSync("git", ["show", "HEAD:herdr-layout/layouts/automagik.json"], { cwd: topDir }));
    execFileSync("git", ["archive", "--format=tar.gz", "-o", tgz, "--prefix=layouts/", `--add-file=${layout}`, "--prefix=", `HEAD:${prefix}mods`, "--", ...PACK_MODS], { cwd: topDir });
    const top = [...new Set(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).map((n) => n.split("/")[0]))].sort();
    assert.deepEqual(top, [...PACK_MODS, "layouts"].sort());
    const version = execFileSync("git", ["show", `HEAD:${prefix}mods/am-sidebar/VERSION`], { cwd: topDir, encoding: "utf8" }).trim();
    const done = await applyUpdate({ tgzPath: tgz, version, modsDir: mods });
    assert.equal(done.version, version);
    assert.deepEqual(done.installed, [...PACK_MODS].sort());
    assert.ok(existsSync(join(mods, "am-sidebar", "update.mjs")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update.mjs runs from a copy of the pack outside the repository (no package.json), without warnings", () => {
  const home = mkdtempSync(join(tmpdir(), "installed-"));
  try {
    const pack = join(home, "mods", "am-sidebar");
    cpSync(fileURLToPath(new URL("../mods/am-sidebar", import.meta.url)), pack, { recursive: true });
    const r = spawnSync(process.execPath, [join(pack, "update.mjs"), "check"], {
      env: { ...process.env, HERDR_APP_HOME: home, AUTOMAGIK_HERDR_NO_UPDATE: "1", NODE_OPTIONS: "" }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(JSON.parse(r.stdout).current, readVersion(pack));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update.mjs install needs --from and --version (install.sh's entry); any unknown flag is a usage error", () => {
  const home = mkdtempSync(join(tmpdir(), "strict-"));
  try {
    for (const args of [["install", "--from", "/nowhere.tgz"], ["rollback", "--mod", home], ["update", "--chek"], ["install", "--from", "/x.tgz", "--version", "1.0.0", "--mods"], ["nope"]]) {
      const r = spawnSync(process.execPath, [UPDATE, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stdout, /install --from <tgz> --version <v>/);
    }
    assert.equal(execFileSync("ls", ["-A", home], { encoding: "utf8" }), "", "nothing written");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failure in the middle of the swap renames every folder back, and the record and kept set are unchanged", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  try {
    let n = 0;
    const rename = (a, b) => { if (++n === 3) throw new Error("disk full"); renameSync(a, b); };
    await assert.rejects(applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, rename }), /disk full/);
    for (const m of MODS) assert.equal(readFileSync(join(mods, m, "main.js"), "utf8"), 'export const v = "0.1.0";\n', m);
    assert.equal(readMarker(mods).version, "0.1.0");
    assert.deepEqual(execFileSync("ls", ["-A", stateDirOf(mods)], { encoding: "utf8" }).trim(), "installed-by-install.sh", "no staging, no half set");
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    n = 0;
    assert.throws(() => rollback({ modsDir: mods, rename }), /disk full/);
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.2.0");
    assert.equal(readVersion(kept(mods)), "0.1.0");
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("private paths are carried on update and rollback; a symlinked .state stays a link", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  const elsewhere = mkdtempSync(join(tmpdir(), "state-"));
  try {
    symlinkSync(elsewhere, join(mods, "am-sidebar", ".state"));
    mkdirSync(join(mods, "am-tabs", "node_modules", "x"), { recursive: true });
    writeFileSync(join(mods, "am-tabs", ".tabs.json"), "{}\n");
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.equal(lstatSync(join(mods, "am-sidebar", ".state")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(mods, "am-sidebar", ".state")), elsewhere);
    assert.equal(readFileSync(join(mods, "am-tabs", ".tabs.json"), "utf8"), "{}\n");
    assert.ok(existsSync(join(mods, "am-tabs", "node_modules", "x")));
    writeFileSync(join(mods, "am-tabs", ".tabs.json"), "{\"newer\":true}\n");
    rollback({ modsDir: mods });
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.1.0");
    assert.equal(readFileSync(join(mods, "am-tabs", ".tabs.json"), "utf8"), "{\"newer\":true}\n", "rollback carries the latest state back");
    assert.equal(readlinkSync(join(mods, "am-sidebar", ".state")), elsewhere);
  } finally {
    for (const d of [t.src, home, elsewhere]) rmSync(d, { recursive: true, force: true });
  }
});

test("a folder not in the record is left alone, or adopted to backup/; a retired one leaves with the set; rollback refuses a foreign folder", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "old-mod"]);
  const t = tarball("0.2.0");
  try {
    mkdirSync(join(mods, "am-tabs"));
    writeFileSync(join(mods, "am-tabs", "main.js"), "// mine\n");
    const left = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual([left.left, left.replaced, left.retired], [["am-tabs"], ["am-sidebar"], ["old-mod"]]);
    assert.equal(readFileSync(join(mods, "am-tabs", "main.js"), "utf8"), "// mine\n");
    assert.equal(existsSync(join(mods, "old-mod")), false);
    assert.ok(existsSync(join(kept(mods, "old-mod"), "main.js")));
    assert.deepEqual(readMarker(mods).mods, ["am-sidebar"]);
    assert.throws(() => { mkdirSync(join(mods, "old-mod")); rollback({ modsDir: mods }); }, /mods\/old-mod is not this installer's: nothing rolled back/);
    rmSync(join(mods, "old-mod"), { recursive: true });
    const adopted = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, adopt: true });
    assert.deepEqual(adopted.adopted.map((a) => a.mod), ["am-tabs"]);
    assert.equal(readFileSync(join(adopted.adopted[0].backup, "main.js"), "utf8"), "// mine\n");
    assert.deepEqual(readMarker(mods).mods, MODS);
    assert.match(readFileSync(markerOf(mods), "utf8"), /^adopted=am-tabs:backup\/am-tabs-\d{4}-\d\d-\d\d$/m);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("release.js's PACK_KEYS and CATALOG_URL equal the repository's keys.json and the mod manager's index URL", async () => {
  const { PACK_KEYS, CATALOG_URL } = await import("../mods/am-sidebar/release.js");
  const core = await import("../mods/am-mods/core.js");
  assert.deepEqual(JSON.parse(JSON.stringify(PACK_KEYS)), JSON.parse(readFileSync(new URL("../keys.json", import.meta.url), "utf8")));
  assert.equal(CATALOG_URL, core.CATALOG_URL);
});

test("rollback then reinstall: a folder only the newer set had comes back with its .state", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar"]);
  const t = tarball("0.2.0");
  try {
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    mkdirSync(join(mods, "am-tabs", ".state"));
    writeFileSync(join(mods, "am-tabs", ".state", "cred"), "SECRET\n");
    rollback({ modsDir: mods });
    assert.equal(existsSync(join(mods, "am-tabs")), false);
    assert.equal(readFileSync(join(kept(mods, "am-tabs"), ".state", "cred"), "utf8"), "SECRET\n");
    const again = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual(again.installed, ["am-tabs"]);
    assert.equal(readFileSync(join(mods, "am-tabs", ".state", "cred"), "utf8"), "SECRET\n");
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failure after the swap never deletes the replaced folders, and says where they are", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  try {
    // The kept set cannot take its new place: the install stands, the record names it, and the
    // replaced 0.1.0 folders wait in .prev-next-<pid>-<random> with the old set back in .prev.
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    const rename = (a, b) => { if (b === prevSetOf(mods)) throw new Error("EPERM"); renameSync(a, b); };
    const t3 = tarball("0.3.0");
    const r = await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: mods, rename });
    rmSync(t3.src, { recursive: true, force: true });
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.3.0");
    assert.equal(readMarker(mods).version, "0.3.0");
    assert.equal(r.prev, null);
    const next = /they are in (\S+)$/.exec(r.warnings[0])?.[1];
    assert.match(r.warnings[0], new RegExp(`could not become the kept set .*they are in ${join(stateDirOf(mods), ".prev-next-")}${process.pid}-[0-9a-f]{8}$`));
    assert.equal(readVersion(join(next, "am-sidebar")), "0.2.0", "the replaced folders are kept");
    assert.equal(readVersion(kept(mods)), "0.1.0", "the older set is back in .prev, still a rollback point");
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an older kept set that cannot be removed is reported, and the new set is still kept", { skip: process.getuid?.() === 0 }, async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  const t3 = tarball("0.3.0");
  const locked = () => join(stateDirOf(mods), readdirSync(stateDirOf(mods), { encoding: "utf8" }).find((n) => n.startsWith(".prev-old-")) ?? ".prev", "am-tabs");
  try {
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    chmodSync(join(prevSetOf(mods), "am-tabs"), 0o555);
    const r = await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: mods });
    assert.match(r.warnings[0], /older kept set could not be removed .*\.prev-old-/);
    assert.equal(readVersion(join(mods, "am-sidebar")), "0.3.0");
    assert.equal(readVersion(kept(mods)), "0.2.0", "the set just replaced is the kept one");
    chmodSync(locked(), 0o755);
  } finally {
    for (const d of [t.src, t3.src, home]) rmSync(d, { recursive: true, force: true });
  }
});

test("an earlier run's leftover .prev-next-<pid> or .prev-old-<pid> (a reused pid) is never deleted", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.2.0");
  try {
    for (const n of [`.prev-next-${process.pid}`, `.prev-old-${process.pid}`]) {
      mkdirSync(join(stateDirOf(mods), n, "am-sidebar"), { recursive: true });
      writeFileSync(join(stateDirOf(mods), n, "am-sidebar", "main.js"), "// left by a failed run\n");
    }
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    rollback({ modsDir: mods });
    for (const n of [`.prev-next-${process.pid}`, `.prev-old-${process.pid}`]) {
      assert.equal(readFileSync(join(stateDirOf(mods), n, "am-sidebar", "main.js"), "utf8"), "// left by a failed run\n", n);
    }
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("relinkCli: the am link follows the pack's entry the same way, and a link elsewhere is left", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const link = join(binDir, "am");
  const bin = join(mods, "am-sidebar", "bin");
  const wrapper = join(bin, "automagik-herdr"), mjs = join(bin, "automagik-herdr.mjs");
  mkdirSync(bin);
  writeFileSync(mjs, "#!/usr/bin/env node\n");
  writeFileSync(wrapper, "#!/bin/sh\n");
  symlinkSync(mjs, link);
  assert.deepEqual(relinkCli({ modsDir: mods, binDir }), { link, from: mjs, to: wrapper });
  assert.equal(readlinkSync(link), wrapper);
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  unlinkSync(link);
  symlinkSync("/somewhere/else/am", link);
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readlinkSync(link), "/somewhere/else/am");
  // Missing: made quietly (an install from before am's link).
  unlinkSync(link);
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readlinkSync(link), wrapper);
  // A file of the person's is never replaced.
  unlinkSync(link);
  writeFileSync(link, "mine\n");
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readFileSync(link, "utf8"), "mine\n");
});

test("relinkCli: a pack the install record does not list gets no am link", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "automagik-herdr"), "#!/bin/sh\n");
  rmSync(join(home, "automagik-herdr", "installed-by-install.sh"));
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(existsSync(join(binDir, "am")), false);
});

test("relinkCli: an install record that exists but does not list the pack gets no am link (M3)", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "automagik-herdr"), "#!/bin/sh\n");
  const record = join(home, "automagik-herdr", "installed-by-install.sh");
  for (const list of ["am-quota,am-hooks", ""]) {
    writeFileSync(record, `version=0.4.0\nmods=${list}\nbefore=none\n`);
    assert.equal(relinkCli({ modsDir: mods, binDir }), null, `mods=${list}`);
    assert.equal(existsSync(join(binDir, "am")), false, `mods=${list}`);
  }
});

test("relinkCli: a record with no mods line, or a mods list that only resembles the pack, gets no am link", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "automagik-herdr"), "#!/bin/sh\n");
  const record = join(home, "automagik-herdr", "installed-by-install.sh");
  // The first row has no mods line (a v1 record: it names the old pack, never this one); the others list
  // a different token, one that starts with the pack's name among them (an exact token match, not a prefix).
  for (const [row, text] of [["no mods line", "version=0.4.0\nbefore=none\n"],
    ["mods=spaces-agents", "version=0.4.0\nmods=spaces-agents\nbefore=none\n"],
    ["mods=am-sidebar-agents", "version=0.4.0\nmods=am-sidebar-agents\nbefore=none\n"]]) {
    writeFileSync(record, text);
    assert.equal(relinkCli({ modsDir: mods, binDir }), null, row);
    assert.equal(existsSync(join(binDir, "am")), false, row);
  }
});

test("relinkCli: our link follows the pack's entry (the wrapper, or the .mjs before it); any other is left", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin"); // a scratch ~/.local/bin
  mkdirSync(binDir);
  const link = join(binDir, "automagik-herdr");
  const bin = join(mods, "am-sidebar", "bin");
  const wrapper = join(bin, "automagik-herdr"), mjs = join(bin, "automagik-herdr.mjs");
  mkdirSync(bin);
  writeFileSync(mjs, "#!/usr/bin/env node\n");
  // unlinkSync for a link: Node 24.9's rmSync leaves a dangling one in place.
  const point = (to) => {
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
    else rmSync(link, { force: true });
    symlinkSync(to, link);
  };
  // A pack from before the wrapper: a link to the .mjs is already right; one to a missing wrapper is repointed.
  point(mjs);
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  point(wrapper);
  assert.deepEqual(relinkCli({ modsDir: mods, binDir }), { link, from: wrapper, to: mjs });
  assert.equal(readlinkSync(link), mjs);
  // A pack with the wrapper: the .mjs link (absolute or relative) moves to it, once.
  writeFileSync(wrapper, "#!/bin/sh\n");
  assert.deepEqual(relinkCli({ modsDir: mods, binDir }), { link, from: mjs, to: wrapper });
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  point(relative(binDir, mjs));
  assert.equal(relinkCli({ modsDir: mods, binDir }).to, wrapper);
  // Not ours: another target, a regular file, no link at all.
  point("/somewhere/else/automagik-herdr.mjs");
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readlinkSync(link), "/somewhere/else/automagik-herdr.mjs");
  unlinkSync(link); // dangling: see point()
  writeFileSync(link, "mine\n");
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readFileSync(link, "utf8"), "mine\n");
  rmSync(link);
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(existsSync(link), false);
});

test("relinkCli across the rename: a link into the old sidebar folder moves to this pack's entry, never onto nothing", (t) => {
  const { home, mods } = appHome("0.5.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const link = join(binDir, "automagik-herdr");
  const old = join(mods, OLD_PACK_NAME, "bin", "automagik-herdr"); // a v0.4.x link; that folder is gone
  symlinkSync(old, link);
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  // No entry in this pack yet: the link stays where it was.
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
  assert.equal(readlinkSync(link), old);
  writeFileSync(join(bin, "automagik-herdr"), "#!/bin/sh\n");
  assert.deepEqual(relinkCli({ modsDir: mods, binDir }), { link, from: old, to: join(bin, "automagik-herdr") });
  assert.equal(relinkCli({ modsDir: mods, binDir }), null);
});

test("relinkCli: a leftover dangling temp link (a killed run, the same pid since) is unlinked, never followed (#550)", (t) => {
  const { home, mods } = appHome("0.5.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const link = join(binDir, "automagik-herdr");
  const bin = join(mods, "am-sidebar", "bin");
  const wrapper = join(bin, "automagik-herdr"), mjs = join(bin, "automagik-herdr.mjs");
  mkdirSync(bin);
  writeFileSync(mjs, "#!/usr/bin/env node\n");
  writeFileSync(wrapper, "#!/bin/sh\n");
  symlinkSync(mjs, link);
  // relinkCli's own temp name, left pointing at nothing. Node 24.0 to 24.9's rmSync returns on a
  // dangling link and leaves it, so the symlinkSync after it failed with EEXIST.
  const tmp = join(binDir, `.automagik-herdr.relink-${process.pid}`);
  const gone = join(home, "gone", "automagik-herdr");
  symlinkSync(gone, tmp);
  assert.deepEqual(relinkCli({ modsDir: mods, binDir }), { link, from: mjs, to: wrapper });
  assert.equal(readlinkSync(link), wrapper);
  assert.equal(lstatSync(tmp, { throwIfNoEntry: false }), undefined, "the temp link is gone");
  assert.equal(existsSync(dirname(gone)), false, "nothing was made where the temp link pointed");
});

test("update --rollback to a pack without the wrapper repoints the link at its .mjs, and back again", async (t) => {
  const { home, mods } = appHome("0.3.2"); // the installed pack: no wrapper
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pack = join(mods, "am-sidebar");
  mkdirSync(join(pack, "bin"));
  writeFileSync(join(pack, "bin", "automagik-herdr.mjs"), "x\n");
  // The update to 0.4.0 ships the wrapper; the 0.3.2 set is kept.
  const src = mkdtempSync(join(tmpdir(), "pack-src-"));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const tree = join(src, "tree");
  packDir(tree, "0.4.0");
  mkdirSync(join(tree, "am-sidebar", "bin"));
  for (const f of ["automagik-herdr", "automagik-herdr.mjs"]) writeFileSync(join(tree, "am-sidebar", "bin", f), "x\n");
  const tgz = join(src, "automagik-herdr-pack-0.4.0.tgz");
  execFileSync("tar", ["czf", tgz, "-C", tree, ...MODS], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  await applyUpdate({ tgzPath: tgz, version: "0.4.0", modsDir: mods });
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const link = join(binDir, "automagik-herdr");
  symlinkSync(join(pack, "bin", "automagik-herdr"), link);
  const io = { modsDir: mods, binDir, env: { HOME: join(home, "no-such-home") } };
  const back = await cmdUpdate({ rollback: true }, [], io);
  assert.match(back, /^Rolled back to Automagik Herdr 0\.3\.2 .* now points at .*automagik-herdr\.mjs\.$/);
  assert.equal(readlinkSync(link), join(pack, "bin", "automagik-herdr.mjs"));
  const json = await cmdUpdate({ rollback: true, json: true }, [], io);
  assert.equal(json.rolledBack.version, "0.4.0");
  assert.deepEqual(json.relinked, { link, from: join(pack, "bin", "automagik-herdr.mjs"), to: join(pack, "bin", "automagik-herdr") });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test("update when already up to date (an older CLI did the update) still moves our link to the wrapper", async (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binDir = join(home, "local-bin");
  mkdirSync(binDir);
  const link = join(binDir, "automagik-herdr");
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  for (const f of ["automagik-herdr", "automagik-herdr.mjs"]) writeFileSync(join(bin, f), "x\n");
  symlinkSync(join(bin, "automagik-herdr.mjs"), link);
  const io = { modsDir: mods, binDir, env: {}, keys, fetch: fakeFetch(served("0.4.0")) };
  assert.equal(await cmdUpdate({ check: true }, [], io), "Automagik Herdr 0.4.0 is installed; the latest release is 0.4.0. Up to date.");
  assert.equal(readlinkSync(link), join(bin, "automagik-herdr.mjs"), "--check changes nothing");
  assert.match(await cmdUpdate({}, [], io), /Up to date\. .*automagik-herdr now points at .*bin\/automagik-herdr\.$/);
  assert.equal(readlinkSync(link), join(bin, "automagik-herdr"));
  assert.equal(await cmdUpdate({}, [], io), "Automagik Herdr 0.4.0 is installed; the latest release is 0.4.0. Up to date.", "idempotent");
});

test("any CLI start moves our link from the .mjs to the installed pack's wrapper (scratch HOME and app home)", (t) => {
  const { home, mods } = appHome("0.4.0");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(mods, "am-sidebar", "bin");
  mkdirSync(bin);
  for (const f of ["automagik-herdr", "automagik-herdr.mjs"]) writeFileSync(join(bin, f), "x\n");
  const binDir = join(home, "home", ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "automagik-herdr");
  symlinkSync(join(bin, "automagik-herdr.mjs"), link);
  const cli = fileURLToPath(new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8",
    env: { HOME: join(home, "home"), HERDR_APP_HOME: home, PATH: process.env.PATH, AUTOMAGIK_HERDR_NO_UPDATE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(link), join(bin, "automagik-herdr"));
});

// ---- The automagik layout on update and rollback (PR #79: am-status in the status bar) ----

const LAYOUT_V1 = '{ "id": "root", "children": [{ "id": "status", "content": { "mod": "workspace-status" } }] }\n';
const LAYOUT_V2 = '{ "id": "root", "children": [{ "id": "status", "content": { "mod": "am-status" } }] }\n';
/** A release tarball at `version` carrying layouts/automagik.json = `layout`, as release.yml packs it. */
function tarballWithLayout(version, layout, mods = MODS) {
  const src = mkdtempSync(join(tmpdir(), "pack-src-"));
  const tree = join(src, "tree");
  packDir(tree, version, { mods });
  mkdirSync(join(tree, "layouts"));
  writeFileSync(join(tree, "layouts", "automagik.json"), layout);
  const out = join(src, `automagik-herdr-pack-${version}.tgz`);
  execFileSync("tar", ["czf", out, "-C", tree, ...mods, "layouts"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { path: out, buf: readFileSync(out), src };
}
/** An app home at 0.1.0 whose pack placed LAYOUT_V1 (live and reference), and a 0.2.0 release with LAYOUT_V2. */
function layoutHome() {
  const { home, mods } = appHome("0.1.0");
  mkdirSync(join(home, "layouts"));
  writeFileSync(join(home, "layouts", "automagik.json"), LAYOUT_V1);
  writeFileSync(join(home, "automagik-herdr", "automagik.json"), LAYOUT_V1);
  const t = tarballWithLayout("0.2.0", LAYOUT_V2);
  // The signed herdr-lane pointer to 0.2.0 and its tarball.
  const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
  const table = { ...served("0.2.0", { url, body: t.buf }), [url]: t.buf };
  const live = () => readFileSync(join(home, "layouts", "automagik.json"), "utf8");
  const ref = () => readFileSync(join(home, "automagik-herdr", "automagik.json"), "utf8");
  const done = () => { rmSync(t.src, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); };
  return { home, mods, table, live, ref, done };
}

test("installUpdate places the release's layout over the last pack's own (what `automagik-herdr update` runs)", async () => {
  const h = layoutHome();
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(r.installed.layout, "replaced");
    assert.equal(h.live(), LAYOUT_V2, "the status bar block names am-status now");
    assert.equal(h.ref(), LAYOUT_V2);
    assert.equal(readFileSync(join(prevSetOf(h.mods), ".layout.json"), "utf8"), LAYOUT_V1, "the kept set carries the layout its pack placed");
  } finally { h.done(); }
});

test("installUpdate keeps a layout the person edited (D8), and adds one that is missing", async () => {
  const h = layoutHome();
  try {
    const mine = LAYOUT_V1.replace('"root"', '"mine"');
    writeFileSync(join(h.home, "layouts", "automagik.json"), mine);
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods });
    assert.equal(r.installed.layout, "kept");
    assert.equal(h.live(), mine);
    assert.equal(h.ref(), LAYOUT_V2, "the pack's copy is still the reference");
  } finally { h.done(); }
  const g = layoutHome();
  try {
    rmSync(join(g.home, "layouts", "automagik.json"));
    const r = await installUpdate({ keys, fetch: fakeFetch(g.table), env: {}, modsDir: g.mods });
    assert.equal(r.installed.layout, "added");
    assert.equal(g.live(), LAYOUT_V2);
  } finally { g.done(); }
});

test("#387: an update swaps a kept layout's workspace-status for am-status and says so; a rollback to a pack without am-status puts it back", async () => {
  const h = layoutHome();
  const withStatus = tarballWithLayout("0.2.0", LAYOUT_V2, [...MODS, "am-status"]);
  const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
  const table = { ...served("0.2.0", { url, body: withStatus.buf }), [url]: withStatus.buf };
  try {
    // Both shown with the sidebar and the status block still Herdr's; automagik.json edited (kept, D8).
    const mine = '{\n    "id": "mine",\n    "children": [\n        { "id": "spaces", "content": { "mod": "am-sidebar" } },\n        { "id": "status", "content": { "mod": "workspace-status" } }\n    ]\n}\n';
    const agents = JSON.stringify({ id: "root", children: [{ id: "spaces", content: { mod: "am-sidebar" } }, { id: "status", content: { mod: "workspace-status" } }] });
    writeFileSync(join(h.home, "layouts", "automagik.json"), mine);
    writeFileSync(join(h.home, "layouts", "main-agents.json"), agents);
    const lines = [];
    const r = await installUpdate({ keys, fetch: fakeFetch(table), env: {}, modsDir: h.mods, log: (l) => lines.push(l) });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(r.installed.layout, "kept");
    assert.equal(h.live(), mine.replace('"workspace-status"', '"am-status"'), "that block only, the rest byte for byte");
    const agentsNow = readFileSync(join(h.home, "layouts", "main-agents.json"), "utf8");
    assert.equal(agentsNow, agents.replace('"workspace-status"', '"am-status"'));
    for (const name of ["automagik", "main-agents"]) {
      assert.ok(lines.some((l) => l.startsWith(`swapped Herdr's workspace-status for am-status in ${join(h.home, "layouts", `${name}.json`)}`)), lines.join("\n"));
    }
    // 0.1.0's pack has no am-status: a layout naming it would show plain Herdr, so the swap is undone.
    const back = rollback({ modsDir: h.mods });
    assert.equal(back.version, "0.1.0");
    for (const [name, before] of [["automagik", mine], ["main-agents", agents]]) {
      assert.equal(readFileSync(join(h.home, "layouts", `${name}.json`), "utf8"), before, `${name}: back byte for byte`);
    }
  } finally { h.done(); rmSync(withStatus.src, { recursive: true, force: true }); }
});

test("#387: an update leaves a kept layout placing workspace-status twice and says why", async () => {
  const h = layoutHome();
  const withStatus = tarballWithLayout("0.2.0", LAYOUT_V2, [...MODS, "am-status"]);
  const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
  const table = { ...served("0.2.0", { url, body: withStatus.buf }), [url]: withStatus.buf };
  try {
    const twice = JSON.stringify({ id: "mine", children: [{ id: "a", content: { mod: "workspace-status" } }, { id: "b", content: { mod: "workspace-status" } }] });
    writeFileSync(join(h.home, "layouts", "automagik.json"), twice);
    const lines = [];
    const r = await installUpdate({ keys, fetch: fakeFetch(table), env: {}, modsDir: h.mods, log: (l) => lines.push(l) });
    assert.equal(r.installed.layout, "kept");
    assert.equal(h.live(), twice, "left byte for byte");
    const file = join(h.home, "layouts", "automagik.json");
    assert.ok(lines.some((l) => l.startsWith(`left: ${file} (it places Herdr's workspace-status 2 times, so am-status`)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.startsWith("swapped")), lines.join("\n"));
  } finally { h.done(); rmSync(withStatus.src, { recursive: true, force: true }); }
});

test("rollback puts the rolled-to pack's layout back (no layout naming a missing am-status), and a second rollback undoes it", async () => {
  const h = layoutHome();
  try {
    await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods });
    const back = rollback({ modsDir: h.mods });
    assert.equal(back.version, "0.1.0");
    assert.equal(back.layout, "restored");
    assert.equal(h.live(), LAYOUT_V1);
    assert.equal(h.ref(), LAYOUT_V1, "the reference is the rolled-to pack's");
    assert.equal(readFileSync(join(prevSetOf(h.mods), ".layout.json"), "utf8"), LAYOUT_V2, "the rolled-out pack's layout is kept with it");
    const forward = rollback({ modsDir: h.mods });
    assert.equal(forward.version, "0.2.0");
    assert.equal(forward.layout, "restored");
    assert.equal(h.live(), LAYOUT_V2);
    assert.equal(h.ref(), LAYOUT_V2);
  } finally { h.done(); }
});

test("rollback keeps a layout the person edited after the update; a set kept before v0.9 (no layout) changes nothing", async () => {
  const h = layoutHome();
  try {
    await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods });
    const mine = LAYOUT_V2.replace('"root"', '"mine"');
    writeFileSync(join(h.home, "layouts", "automagik.json"), mine);
    const back = rollback({ modsDir: h.mods });
    assert.equal(back.layout, "kept");
    assert.equal(h.live(), mine);
    assert.equal(h.ref(), LAYOUT_V1);
  } finally { h.done(); }
  const g = layoutHome();
  try {
    await installUpdate({ keys, fetch: fakeFetch(g.table), env: {}, modsDir: g.mods });
    rmSync(join(prevSetOf(g.mods), ".layout.json"));
    const back = rollback({ modsDir: g.mods });
    assert.equal(back.layout, null);
    assert.equal(g.live(), LAYOUT_V2);
  } finally { g.done(); }
});

/** Every file and link under `dir` (paths, link targets, bytes), for a run that must change nothing. */
function filesOf(dir, rel = "") {
  return readdirSync(join(dir, rel)).sort().flatMap((name) => {
    const path = join(dir, rel, name), st = lstatSync(path), at = join(rel, name);
    if (st.isSymbolicLink()) return [`${at} -> ${readlinkSync(path)}`];
    if (st.isDirectory()) return [`${at}/`, ...filesOf(dir, at)];
    return [`${at} ${sha(readFileSync(path))}`];
  });
}

test("#488: a rollback refuses, changing nothing, while a file in layouts/ names a mod the rolled-to set lacks; the pack's own unedited layout does not count", async () => {
  // 0.1.0 shipped am-sidebar alone, its layout naming only it; 0.2.0 adds am-tabs and its layout names it.
  const tree = (...mods) => `${JSON.stringify({ id: "root", children: mods.map((m, i) => ({ id: `b${i}`, content: { mod: m } })) })}\n`;
  const L1 = tree("am-sidebar"), L2 = tree("am-sidebar", "am-tabs");
  const { home, mods } = appHome("0.1.0", ["am-sidebar"]);
  const t = tarballWithLayout("0.2.0", L2, MODS);
  const live = join(home, "layouts", "automagik.json");
  try {
    mkdirSync(join(home, "layouts"));
    writeFileSync(live, L1);
    writeFileSync(join(home, "automagik-herdr", "automagik.json"), L1);
    const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
    const fetch = fakeFetch({ ...served("0.2.0", { url, body: t.buf }), [url]: t.buf });
    assert.equal((await installUpdate({ keys, fetch, env: {}, modsDir: mods })).installed.version, "0.2.0");
    assert.equal(readFileSync(live, "utf8"), L2);
    writeFileSync(join(mods, "am-sidebar", ".state"), "private\n");

    // Another layout naming am-tabs: refused, every byte of the app home as it was (no skip, no private path carried).
    writeFileSync(join(home, "layouts", "mine.json"), tree("am-tabs"));
    const before = filesOf(home);
    assert.throws(() => rollback({ modsDir: mods }),
      /^Error: nothing rolled back: am-tabs would leave mods\/, but the mine layout still names it, .*then roll back$/);
    assert.deepEqual(filesOf(home), before);

    // The pack's own layout edited to name it counts too.
    rmSync(join(home, "layouts", "mine.json"));
    writeFileSync(live, L2.replace('"root"', '"mine"'));
    assert.throws(() => rollback({ modsDir: mods }), /but the automagik layout still names it/);

    // Unedited, it is the kept set's again after the rollback: the rollback goes on.
    writeFileSync(live, L2);
    const back = rollback({ modsDir: mods });
    assert.equal(back.version, "0.1.0");
    assert.equal(back.layout, "restored");
    assert.equal(readFileSync(live, "utf8"), L1);
    assert.ok(!existsSync(join(mods, "am-tabs")));
    assert.equal(readFileSync(join(kept(mods), ".state"), "utf8"), "private\n", "the private path went with the rolled-out set");
    assert.equal(readAuto(mods).skip, "0.2.0");
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("#503: a rollback to a set kept with no layout says automagik.json still names the mods that left; one kept with its layout says nothing", async () => {
  const tree = (...mods) => `${JSON.stringify({ id: "root", children: mods.map((m, i) => ({ id: `b${i}`, content: { mod: m } })) })}\n`;
  const L1 = tree("am-sidebar"), L2 = tree("am-sidebar", "am-tabs");
  for (const keptLayout of [false, true]) {
    const { home, mods } = appHome("0.1.0", ["am-sidebar"]);
    const t = tarballWithLayout("0.2.0", L2, MODS);
    const live = join(home, "layouts", "automagik.json");
    try {
      mkdirSync(join(home, "layouts"));
      writeFileSync(live, L1);
      writeFileSync(join(home, "automagik-herdr", "automagik.json"), L1);
      const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
      const fetch = fakeFetch({ ...served("0.2.0", { url, body: t.buf }), [url]: t.buf });
      assert.equal((await installUpdate({ keys, fetch, env: {}, modsDir: mods })).installed.version, "0.2.0");
      // A set kept before v0.9 carries no layout.
      if (!keptLayout) rmSync(join(prevSetOf(mods), ".layout.json"));
      const lines = [];
      const back = rollback({ modsDir: mods, log: (l) => lines.push(l) });
      assert.equal(back.version, "0.1.0");
      assert.ok(!existsSync(join(mods, "am-tabs")), "am-tabs left mods/");
      const said = `left automagik.json (${live}) as the rolled-out pack placed it: the pack rolled back to kept no layout to put back `
        + "(a set kept before v0.9), and its blocks name am-tabs, which left mods/ in this rollback. "
        + "Herdr drops a layout whose mod is gone (plain Herdr instead): if Herdr shows it, switch layouts (ctrl-shift-l)";
      assert.equal(staleLayoutLine(live, ["am-tabs"]), said);
      if (keptLayout) {
        assert.equal(back.layout, "restored");
        assert.equal(readFileSync(live, "utf8"), L1);
        assert.ok(!lines.some((l) => l.includes("as the rolled-out pack placed it")), lines.join("\n"));
      } else {
        assert.equal(back.layout, null);
        assert.equal(readFileSync(live, "utf8"), L2, "the stale layout stays, byte for byte");
        assert.deepEqual(lines.filter((l) => l.includes("automagik.json")), [said]);
      }
    } finally {
      rmSync(t.src, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("installUpdate with `expect`: a newer latest than the confirmed version downloads nothing and is refused", async () => {
  const h = layoutHome();
  try {
    const calls = [];
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table, calls), env: {}, modsDir: h.mods, expect: "0.1.5" });
    assert.equal(r.installed, null);
    assert.deepEqual(r.refused, { expected: "0.1.5", latest: "0.2.0" });
    assert.deepEqual(calls.map((c) => c.url), [POINTER_URL, POINTER_SIG_URL], "only the signed pointer: no tarball");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    const ok = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.2.0" });
    assert.equal(ok.installed.version, "0.2.0");
  } finally { h.done(); }
});

test("node update.mjs apply --expect <v>: the flag takes a value; other commands refuse it", async () => {
  const { parseArgs } = await import("../mods/am-sidebar/update.mjs");
  assert.deepEqual(parseArgs(["apply", "--expect", "0.8.1", "--mods", "/m"]), { command: "apply", opts: { expect: "0.8.1", mods: "/m" } });
  assert.throws(() => parseArgs(["apply", "--expect"]), /usage/);
  assert.throws(() => parseArgs(["check", "--expect", "0.8.1"]), /usage/);
});

test("a pack mod switched off (mods-disabled/) is updated where it is and stays off; rollback and retiring keep it off", async () => {
  const { home, mods } = appHome("0.1.0");
  const off = offDirOf(mods);
  assert.equal(off, join(home, "mods-disabled"));
  mkdirSync(off);
  renameSync(join(mods, "am-tabs"), join(off, "am-tabs"));
  mkdirSync(join(off, "am-tabs", ".state"));
  writeFileSync(join(off, "am-tabs", ".state", "mine"), "kept\n");
  const t = tarball("0.2.0");
  const t3 = tarball("0.3.0", { mods: ["am-sidebar"] });
  try {
    const lines = [];
    const done = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, log: (l) => lines.push(l) });
    assert.deepEqual(done.off, ["am-tabs"]);
    assert.equal(existsSync(join(mods, "am-tabs")), false, "never switched back on by an update");
    assert.equal(readFileSync(join(off, "am-tabs", "main.js"), "utf8"), 'export const v = "0.2.0";\n', "updated in mods-disabled/");
    assert.equal(readFileSync(join(off, "am-tabs", ".state", "mine"), "utf8"), "kept\n", "its private paths carried");
    assert.equal(readFileSync(join(kept(mods, "am-tabs"), "main.js"), "utf8"), 'export const v = "0.1.0";\n', "the old copy is in the kept set");
    assert.deepEqual(readMarker(mods).mods, MODS, "the record still lists it");
    assert.ok(lines.includes("updated mods-disabled/am-tabs: it stays off"));

    rollback({ modsDir: mods });
    assert.equal(existsSync(join(mods, "am-tabs")), false, "a rollback keeps it off");
    assert.equal(readFileSync(join(off, "am-tabs", "main.js"), "utf8"), 'export const v = "0.1.0";\n');
    assert.equal(readFileSync(join(off, "am-tabs", ".state", "mine"), "utf8"), "kept\n");

    // A release that no longer ships it: the off copy leaves with the set, like a live one.
    const r = await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: mods });
    assert.deepEqual(r.retired, ["am-tabs"]);
    assert.equal(existsSync(join(off, "am-tabs")), false);
    assert.equal(existsSync(kept(mods, "am-tabs")), true);
  } finally {
    for (const d of [t.src, t3.src, home]) rmSync(d, { recursive: true, force: true });
  }
});

for (const mod of OFF_BY_DEFAULT) test(`${mod} ships off: a fresh install puts it in mods-disabled/; an installed copy keeps its state`, async () => {
  const WITH = ["am-sidebar", "am-tabs", mod];
  const t = tarball("0.2.0", { mods: WITH });
  const homes = [];
  try {
    // A fresh install: no record, nothing in mods/.
    const fresh = appHome(null);
    homes.push(fresh.home);
    const lines = [];
    const r = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: fresh.mods, log: (l) => lines.push(l) });
    const off = offDirOf(fresh.mods);
    assert.equal(existsSync(join(fresh.mods, mod)), false, "not on");
    assert.equal(readFileSync(join(off, mod, "main.js"), "utf8"), 'export const v = "0.2.0";\n');
    assert.ok(existsSync(join(fresh.mods, "am-tabs", "main.js")), "the other mods are on");
    assert.deepEqual(r.installedOff, [mod]);
    assert.deepEqual(readMarker(fresh.mods).mods.sort(), [...WITH].sort(), "the record owns it, so updates keep it off");
    assert.ok(lines.includes(`installed mods-disabled/${mod}: it ships off; turn it on in the Mods panel`));
    // ...and the next update keeps it off.
    const t3 = tarball("0.3.0", { mods: WITH });
    try {
      const again = await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: fresh.mods });
      assert.deepEqual(again.off, [mod]);
      assert.equal(existsSync(join(fresh.mods, mod)), false);
    } finally { rmSync(t3.src, { recursive: true, force: true }); }

    // An update from a release that did not ship it: arriving for the first time, it comes off.
    const older = appHome("0.1.0");
    homes.push(older.home);
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: older.mods });
    assert.equal(existsSync(join(older.mods, mod)), false);
    assert.ok(existsSync(join(offDirOf(older.mods), mod, "main.js")));
    // Rolled back to the release without it, then forward: it is still off, never turned on.
    assert.equal(rollback({ modsDir: older.mods }).version, "0.1.0");
    assert.equal(existsSync(join(older.mods, mod)), false);
    assert.equal(rollback({ modsDir: older.mods }).version, "0.2.0");
    assert.equal(existsSync(join(older.mods, mod)), false, "still off after rolling forward");
    assert.ok(existsSync(join(offDirOf(older.mods), mod, "main.js")));

    // Installed and on (the record lists it, in mods/): updated in place, still on.
    const on = appHome("0.1.0", WITH);
    homes.push(on.home);
    const u = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: on.mods });
    assert.equal(readFileSync(join(on.mods, mod, "main.js"), "utf8"), 'export const v = "0.2.0";\n');
    assert.equal(existsSync(join(offDirOf(on.mods), mod)), false);
    assert.deepEqual(u.installedOff, []);
    // Rollback and forward again: it stays on both ways, never moved to mods-disabled/.
    assert.equal(rollback({ modsDir: on.mods }).version, "0.1.0");
    assert.equal(readFileSync(join(on.mods, mod, "main.js"), "utf8"), 'export const v = "0.1.0";\n');
    assert.equal(rollback({ modsDir: on.mods }).version, "0.2.0");
    assert.equal(readFileSync(join(on.mods, mod, "main.js"), "utf8"), 'export const v = "0.2.0";\n');
    assert.equal(existsSync(join(offDirOf(on.mods), mod)), false);

    // A repair of a missing one the record lists reinstalls it on, as it was.
    rmSync(join(on.mods, mod), { recursive: true, force: true });
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: on.mods, repair: [mod] });
    assert.ok(existsSync(join(on.mods, mod, "main.js")));

    // A folder already in mods-disabled/ that the record does not own is left alone.
    const theirs = appHome(null);
    homes.push(theirs.home);
    mkdirSync(join(offDirOf(theirs.mods), mod), { recursive: true });
    writeFileSync(join(offDirOf(theirs.mods), mod, "main.js"), "// mine\n");
    const said = [];
    const l = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: theirs.mods, log: (x) => said.push(x) });
    assert.equal(readFileSync(join(offDirOf(theirs.mods), mod, "main.js"), "utf8"), "// mine\n");
    assert.equal(l.mods.includes(mod), false);
    assert.ok(said.some((x) => x.includes(`left alone: mods-disabled/${mod}`)));
  } finally {
    for (const d of [t.src, ...homes]) rmSync(d, { recursive: true, force: true });
  }
});

test("herdr-app check skips only a switched-off mod: one missing from mods/ and mods-disabled/ still fails", () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "am-tabs", "am-quota", "am-footer"]);
  try {
    const off = offDirOf(mods);
    mkdirSync(off);
    renameSync(join(mods, "am-quota"), join(off, "am-quota"));       // switched off (or shipped off)
    rmSync(join(mods, "am-footer"), { recursive: true });             // should be on, and is gone
    assert.deepEqual(toCheck(mods, ["am-sidebar", "am-tabs", "am-quota", "am-footer"]), ["am-sidebar", "am-tabs", "am-footer"]);
    // A stand-in herdr-app that fails a folder that isn't there, as the real check does.
    const bin = join(home, "herdr-app");
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = check ] && [ -d "$2" ] && exit 0\necho "no mod at $2" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    const lines = [];
    const r = checkMods({ modsDir: mods, mods: toCheck(mods, readMarker(mods).mods), log: (l) => lines.push(l), herdrApp: bin });
    assert.deepEqual(r.failed, ["am-footer"], "the missing mod fails the setup; the switched-off one is not checked");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A stand-in herdr-app: logs each `check <dir>` and fails a folder that isn't there, as the real one does. */
function fakeHerdrApp(dir) {
  const bin = join(dir, "herdr-app"), calls = join(dir, "herdr-app.log");
  writeFileSync(bin, `#!/bin/sh\necho "$2" >> "${calls}"\n[ "$1" = check ] && [ -d "$2" ] && exit 0\nexit 1\n`);
  chmodSync(bin, 0o755);
  return { bin, checked: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((p) => p.split("/").pop()) : []) };
}

test("setupHome checks the record's mods but a switched-off one: a mod missing from both folders fails", () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "am-tabs", "am-quota"]);
  try {
    mkdirSync(offDirOf(mods));
    renameSync(join(mods, "am-quota"), join(offDirOf(mods), "am-quota"));
    rmSync(join(mods, "am-tabs"), { recursive: true });
    const tgzDir = join(home, "empty");
    mkdirSync(tgzDir);
    const app = fakeHerdrApp(home);
    const failed = setupHome({ modsDir: mods, tgzDir, record: { mods: ["am-sidebar", "am-tabs", "am-quota"] }, herdrApp: app.bin });
    assert.deepEqual(failed, ["am-tabs"], "the missing one fails; the switched-off one is not checked");
    assert.deepEqual(app.checked().sort(), ["am-sidebar", "am-tabs"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repairInstall refuses unreadable keys before repairing a missing mod", async () => {
  const { home, mods } = appHome("0.1.0");
  const t = tarball("0.1.0");
  try {
    rmSync(join(mods, "am-tabs"), { recursive: true });
    writeFileSync(join(home, "keys.json"), "{ invalid");
    const before = readFileSync(markerOf(mods));
    await assert.rejects(repairInstall({ tgzPath: t.path, version: "0.1.0", modsDir: mods }), /keys.json is unreadable.*nothing was installed/);
    assert.equal(existsSync(join(mods, "am-tabs")), false);
    assert.equal(readFileSync(join(home, "keys.json"), "utf8"), "{ invalid");
    assert.deepEqual(readFileSync(markerOf(mods)), before);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("repairInstall checks every mod that is on, never the one that ships off", async () => {
  const WITH = ["am-sidebar", "am-tabs", "am-quota"];
  const t = tarball("0.2.0", { mods: WITH });
  const { home, mods } = appHome(null);
  try {
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.ok(existsSync(join(offDirOf(mods), "am-quota")), "am-quota starts off");
    const app = fakeHerdrApp(home);
    const r = await repairInstall({ tgzPath: t.path, version: "0.2.0", modsDir: mods, herdrApp: app.bin });
    assert.deepEqual(r.checkFailed, []);
    assert.deepEqual(app.checked().sort(), ["am-sidebar", "am-tabs"]);
  } finally {
    for (const d of [t.src, home]) rmSync(d, { recursive: true, force: true });
  }
});

test("rollback keeps a switched-off mod off: one a release retired (a), and one new in the rolled-out release (b)", async () => {
  const off = (mods) => offDirOf(mods);
  const at = (mods, m) => (existsSync(join(mods, m)) ? "on" : existsSync(join(off(mods), m)) ? "off" : "gone");
  // (a) am-tabs is off; a release that drops it keeps it (off=); the rollback brings it back off.
  {
    const { home, mods } = appHome("0.1.0");
    mkdirSync(off(mods));
    renameSync(join(mods, "am-tabs"), join(off(mods), "am-tabs"));
    const t = tarball("0.2.0", { mods: ["am-sidebar"] });
    try {
      const r = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
      assert.deepEqual(r.retired, ["am-tabs"]);
      assert.match(readFileSync(join(prevSetOf(mods), ".pack"), "utf8"), /^off=am-tabs$/m, "the kept set says it was off");
      assert.equal(at(mods, "am-tabs"), "gone");
      rollback({ modsDir: mods });
      assert.equal(at(mods, "am-tabs"), "off");
      assert.equal(readFileSync(join(off(mods), "am-tabs", "main.js"), "utf8"), 'export const v = "0.1.0";\n');
      rollback({ modsDir: mods });
      assert.equal(at(mods, "am-tabs"), "gone", "forward again: retired again");
      rollback({ modsDir: mods });
      assert.equal(at(mods, "am-tabs"), "off", "and back, still off");
    } finally {
      rmSync(t.src, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
  // (b) am-tabs is new in 0.2.0 and switched off there; rolled back twice it ends where it was: off.
  {
    const { home, mods } = appHome("0.1.0", ["am-sidebar"]);
    const t = tarball("0.2.0");
    try {
      await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
      mkdirSync(off(mods));
      renameSync(join(mods, "am-tabs"), join(off(mods), "am-tabs"));
      rollback({ modsDir: mods });
      assert.equal(at(mods, "am-tabs"), "gone", "0.1.0 has no am-tabs");
      assert.match(readFileSync(join(prevSetOf(mods), ".pack"), "utf8"), /^off=am-tabs$/m);
      rollback({ modsDir: mods });
      assert.equal(at(mods, "am-tabs"), "off", "back to 0.2.0, still off");
      assert.equal(readFileSync(join(off(mods), "am-tabs", "main.js"), "utf8"), 'export const v = "0.2.0";\n');
    } finally {
      rmSync(t.src, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("an update with a mod in both mods/ and mods-disabled/ updates mods/ and says the off copy is left", async () => {
  const { home, mods } = appHome("0.1.0");
  mkdirSync(join(offDirOf(mods), "am-tabs"), { recursive: true });
  writeFileSync(join(offDirOf(mods), "am-tabs", "main.js"), "stale\n");
  const t = tarball("0.2.0");
  try {
    const lines = [];
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, log: (l) => lines.push(l) });
    assert.equal(readFileSync(join(mods, "am-tabs", "main.js"), "utf8"), 'export const v = "0.2.0";\n');
    assert.equal(readFileSync(join(offDirOf(mods), "am-tabs", "main.js"), "utf8"), "stale\n");
    assert.ok(lines.some((l) => /mods\/am-tabs and mods-disabled\/am-tabs both exist/.test(l)));
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a mod retired while it was off, then shipped again, comes back off (the kept set's off=)", async () => {
  const { home, mods } = appHome("0.1.0");
  mkdirSync(offDirOf(mods));
  renameSync(join(mods, "am-tabs"), join(offDirOf(mods), "am-tabs"));
  const t2 = tarball("0.2.0", { mods: ["am-sidebar"] });
  const t3 = tarball("0.3.0");
  try {
    await applyUpdate({ tgzPath: t2.path, version: "0.2.0", modsDir: mods });
    assert.ok(!existsSync(join(offDirOf(mods), "am-tabs")));
    const r = await applyUpdate({ tgzPath: t3.path, version: "0.3.0", modsDir: mods });
    assert.ok(r.off.includes("am-tabs"));
    assert.ok(!existsSync(join(mods, "am-tabs")), "never back on by itself");
    assert.equal(readFileSync(join(offDirOf(mods), "am-tabs", "main.js"), "utf8"), 'export const v = "0.3.0";\n');
    assert.ok(readMarker(mods).mods.includes("am-tabs"));
  } finally {
    for (const d of [t2.src, t3.src, home]) rmSync(d, { recursive: true, force: true });
  }
});

// ---- Installing updates on their own: update.mjs's side (temp homes, a fake release) ----

/** A temp app home at 0.1.0 installed by install.sh from a signed release (sequence=), and a release table. */
function autoHome(served_ = ["0.2.0"]) {
  const { home, mods } = appHome("0.1.0");
  writeFileSync(markerOf(mods), "version=0.1.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=10000\n");
  const made = [];
  const table = {};
  const serve = (version) => {
    const t = tarball(version);
    made.push(t.src);
    const url = `https://dl.test/v${version}/automagik-herdr-pack-${version}.tgz`;
    Object.assign(table, served(version, { url, body: t.buf }), { [url]: t.buf });
  };
  served_.forEach(serve);
  const done = () => { for (const d of [...made, home]) rmSync(d, { recursive: true, force: true }); };
  return { home, mods, table, serve, done };
}

/** A stand-in herdr-app that fails the mods named in `fail`. */
function fakeCheckApp(dir, fail = []) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr-app"), calls = join(dir, "herdr-app-calls");
  const cases = fail.map((m) => `  */${m}) printf '%s\\n' "${m}: cannot load" >&2; exit 1 ;;`).join("\n");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
[ "$1" = check ] || exit 0
case "$2" in
${cases}
  *) exit 0 ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []) };
}

/**
 * A stand-in herdr-app that fails `mod` and, since the bad pack is live and `.prev` is its kept
 * set, leaves a folder in `.prev` no removal can take (a file system that refuses it): the restore
 * still happens, but what it rolled away from stays in its set-aside name, said as a warning.
 */
function fakeCheckStuckPrev(dir, mod = "am-tabs") {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr-app"), calls = join(dir, "herdr-app-calls");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
[ "$1" = check ] || exit 0
case "$2" in
  */${mod}) printf '%s\\n' "${mod}: cannot load" >&2
    state="$(dirname "$(dirname "$2")")/automagik-herdr"
    mkdir -p "$state/.prev/stuck" && printf x > "$state/.prev/stuck/keep" && chmod 500 "$state/.prev/stuck"
    exit 1 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []) };
}

/** Lets go of the read-only folders a stuck-prev test left in the state folder, so cleanup can run. */
function unlockState(modsDir) {
  const state = stateDirOf(modsDir);
  let names = [];
  try { names = readdirSync(state); } catch { return; }
  for (const name of [".prev", ...names.filter((n) => n.startsWith(".prev-old-") || n.startsWith(".prev-next-"))]) {
    const stuck = join(state, name, "stuck");
    try { if (existsSync(stuck)) chmodSync(stuck, 0o700); } catch {}
  }
}

/** A stand-in herdr-app that fails the first mod and dies by signal on the next: a failed A then dead B. */
function fakeCheckFailThenKill(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr-app"), calls = join(dir, "herdr-app-calls");
  writeFileSync(bin, `#!/bin/sh
printf '%s\n' "$*" >> "${calls}"
[ "$1" = check ] || exit 0
case "$2" in
  */am-sidebar) printf '%s\n' "am-sidebar: cannot load" >&2; exit 1 ;;
  *) kill -TERM $$ ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []) };
}

/** A stand-in herdr-app whose check dies by signal: execFileSync reports a non-numeric status. */
function fakeCheckKilled(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr-app"), calls = join(dir, "herdr-app-calls");
  writeFileSync(bin, `#!/bin/sh
printf '%s\n' "$*" >> "${calls}"
kill -TERM $$
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []) };
}

test("a herdr-app check killed by a signal is could-not-run: update kept, no restore, one unchecked note", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckKilled(join(h.home, "killed"));
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(r.installed.restored, undefined);
    assert.equal(r.installed.restoreError, undefined);
    assert.equal(r.installed.check.checked, false, "no mod was judged");
    assert.deepEqual(r.installed.check.failed, []);
    assert.match(r.installed.check.unavailable, /could not run/);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.2.0", "the update was kept");
    assert.equal(readVersion(join(prevSetOf(h.mods), "am-sidebar")), "0.1.0", "the kept set stayed the kept set");
    assert.equal(readAuto(h.mods).skip, null, "nothing was recorded as rolled back");
    const note = JSON.parse(readFileSync(join(h.home, "automagik-herdr", CHECK_FILE), "utf8"));
    assert.deepEqual([note.version, note.from], ["0.2.0", "0.1.0"]);
    assert.match(note.unavailable, /could not run/);
    assert.equal(app.calls().length, 1, "it stops at the first check that could not run");
  } finally { h.done(); }
});

test("a judged failed mod wins over a later killed check: restore and one notice", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckFailThenKill(join(h.home, "mixed"));
  const lines = [];
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin,
      log: (l) => lines.push(l) });
    const restore = r.installed.restored;
    assert.equal(restore.version, "0.1.0");
    assert.equal(restore.failedVersion, "0.2.0");
    assert.deepEqual(restore.failed, ["am-sidebar"]);
    assert.equal(restore.mod, "am-sidebar");
    assert.equal(restore.checked, true);
    assert.match(restore.unavailable, /could not run/);
    assert.equal(r.installed.check.checked, true, "a mod was judged failed");
    assert.deepEqual(r.installed.check.failed, ["am-sidebar"]);
    assert.match(r.installed.check.unavailable, /could not run/);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "the kept set is back");
    assert.equal(existsSync(prevSetOf(h.mods)), false, "the failed release is not kept for a rollback");
    assert.equal(restore.prevRemoved, true);
    assert.equal(readAuto(h.mods).skip, "0.2.0", "the failed version is held back");
    assert.ok(lines.some((l) => /check FAILED: am-sidebar/.test(l)));
    assert.ok(lines.some((l) => /could not run/.test(l)));
    const note = JSON.parse(readFileSync(join(h.home, "automagik-herdr", RESTORE_FILE), "utf8"));
    assert.deepEqual(note.failed, ["am-sidebar"]);
    assert.match(note.unavailable, /could not run/);
    assert.equal(app.calls().length, 2, "the failed mod and the dead check after it");
  } finally { h.done(); }
});

test("a bad pack is restored at once; the bad version is held, and a newer one installs", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckApp(join(h.home, "bad"), ["am-tabs"]);
  const passing = fakeCheckApp(join(h.home, "passing"));
  const lines = [];
  try {
    const bad = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin,
      log: (l) => lines.push(l) });
    assert.equal(bad.installed.version, "0.2.0", "the answer names the release that failed");
    // #671: the failed release is removed, never kept as the next rollback target.
    assert.equal(existsSync(prevSetOf(h.mods)), false, "the bad pack is not what a rollback would put back");
    assert.deepEqual(bad.installed.restored, { version: "0.1.0", failedVersion: "0.2.0", mod: "am-tabs", failed: ["am-tabs"], checked: true,
      prevRemoved: true });
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "the .prev set is back");
    assert.equal(readMarker(h.mods).version, "0.1.0");
    assert.throws(() => rollback({ modsDir: h.mods }),
      (e) => /^no earlier pack kept: 0\.2\.0 was removed after it failed to load, so 0\.1\.0 is the installed pack$/.test(e.message));
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "the refused rollback changed nothing");
    assert.equal(readAuto(h.mods).skip, "0.2.0", "the bad version is recorded as rolled back");
    const note = JSON.parse(readFileSync(join(h.home, "automagik-herdr", RESTORE_FILE), "utf8"));
    assert.deepEqual([note.version, note.failedVersion, note.mod, note.failed, note.checked, note.prevRemoved],
      ["0.1.0", "0.2.0", "am-tabs", ["am-tabs"], true, true], "the restored build can say it once, and why there is no rollback");
    assert.deepEqual(app.calls().map((c) => c.split(" ")[0]), ["check", "check"], "herdr-app check ran; nothing restarted Herdr");
    assert.ok(lines.some((l) => /check FAILED: am-tabs/.test(l)));
    // The same release is held; a newer one is taken.
    const held = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true,
      herdrApp: passing.bin });
    assert.equal(held.installed, null);
    assert.match(held.held, /0\.2\.0 was rolled back here/);
    h.serve("0.3.0");
    const newer = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.3.0", auto: true,
      herdrApp: passing.bin });
    assert.equal(newer.installed.version, "0.3.0");
    assert.equal(newer.installed.restored, undefined);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.3.0");
    // A normal update after a restore keeps its rollback target, as before.
    assert.equal(readVersion(join(prevSetOf(h.mods), "am-sidebar")), "0.1.0");
    assert.equal(rollback({ modsDir: h.mods }).version, "0.1.0", "a manual rollback goes back to the good pack");
  } finally { h.done(); }
});

test("#671: a restore that cannot remove the kept set still restores, says where it stays, and a rollback changes nothing", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckStuckPrev(join(h.home, "stuck"));
  const state = stateDirOf(h.mods);
  const path = process.env.PATH;
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin });
    assert.equal(r.installed.version, "0.2.0", "the answer still names the release that failed");
    assert.equal(r.installed.restored.version, "0.1.0", "the restore still stands");
    assert.equal(r.installed.restored.prevRemoved, true);
    assert.equal(existsSync(prevSetOf(h.mods)), false);
    assert.ok(r.installed.warnings.some((w) => /^the earlier kept set could not be removed \(/.test(w)), r.installed.warnings.join("; "));
    assert.ok(r.installed.warnings.some((w) => /\.prev-old-/.test(w)), "the warning names where the folders stay");
    assert.deepEqual(r.installed.restored.warnings, r.installed.warnings, "the restored answer carries the warning");
    const note = JSON.parse(readFileSync(join(state, RESTORE_FILE), "utf8"));
    assert.deepEqual(note.warnings, r.installed.warnings, "the note the restored build reads carries it");
    // A manual rollback refuses and changes nothing: .prev is gone, and the message names the bad release.
    assert.throws(() => rollback({ modsDir: h.mods }),
      (e) => /^no earlier pack kept: 0\.2\.0 was removed after it failed to load, so 0\.1\.0 is the installed pack$/.test(e.message));
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "nothing rolled back");
    // The CLI says the warning too, on its restore line.
    process.env.PATH = `${dirname(app.bin)}:${path}`;
    const line = await cmdUpdate({}, [], { modsDir: h.mods, env: {}, keys, fetch: fakeFetch(h.table) });
    assert.match(line, /Warning: the earlier kept set could not be removed .*\.prev-old-/);
    // A leftover .prev whose marker lists a folder that is no longer there (as a failed removal can
    // leave, and where rmSync's last failed unlink is not deterministic) is caught by rollback's own
    // validation: it refuses and changes nothing, so the bad pack is never reinstalled.
    assert.equal(existsSync(prevSetOf(h.mods)), false, "the restore left no .prev");
    mkdirSync(prevSetOf(h.mods), { recursive: true });
    writeFileSync(join(prevSetOf(h.mods), ".pack"), formatMarker({ version: "0.1.0", mods: ["am-sidebar"] }));
    assert.throws(() => rollback({ modsDir: h.mods }), /kept set lists am-sidebar, which is not there: nothing rolled back/);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "still nothing rolled back");
    assert.equal(readAuto(h.mods).skip, "0.2.0", "the skip did not change either");
  } finally {
    process.env.PATH = path;
    unlockState(h.mods);
    h.done();
  }
});

test("#671: the CLI's restore line names the failed version and the previous one back; its rollback refuses the bad pack", async () => {
  const h = autoHome(["0.2.0"]);
  const bad = fakeCheckApp(join(h.home, "bad"), ["am-tabs"]);
  const good = fakeCheckApp(join(h.home, "good"));
  const path = process.env.PATH;
  try {
    process.env.PATH = `${dirname(bad.bin)}:${path}`;
    const line = await cmdUpdate({}, [], { modsDir: h.mods, env: {}, keys, fetch: fakeFetch(h.table) });
    assert.match(line, /^Automagik Herdr 0\.2\.0 failed to load \(am-tabs failed herdr-app check\): the previous version 0\.1\.0 is back\./);
    assert.match(line, /The failed pack was removed, so `am update --rollback` has nothing to go back to\./);
    assert.match(line, /The bad version is held back; a newer release installs on its own\./);
    await assert.rejects(cmdUpdate({ rollback: true }, [], { modsDir: h.mods, env: {} }),
      (e) => /^Nothing rolled back: no earlier pack kept: 0\.2\.0 was removed after it failed to load, so 0\.1\.0 is the installed pack$/.test(e.message));
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0", "the bad version was not reinstalled");
    // A normal update after the restore keeps its rollback target: a manual rollback goes back.
    h.serve("0.3.0");
    process.env.PATH = `${dirname(good.bin)}:${path}`;
    assert.match(await cmdUpdate({}, [], { modsDir: h.mods, env: {}, keys, fetch: fakeFetch(h.table) }),
      /^Updated Automagik Herdr 0\.1\.0 → 0\.3\.0\./);
    assert.match(await cmdUpdate({ rollback: true }, [], { modsDir: h.mods, env: {} }), /^Rolled back to Automagik Herdr 0\.1\.0 /);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
  } finally {
    process.env.PATH = path;
    h.done();
  }
});

test("a pack whose mods all load updates with no restore and no failure", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckApp(join(h.home, "good"));
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(r.installed.restored, undefined);
    assert.equal(r.installed.restoreError, undefined);
    assert.deepEqual(r.installed.check, { failed: [], checked: true });
    assert.deepEqual(app.calls().map((c) => c.split(" ")[0]), ["check", "check"], "every pack mod was checked");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.2.0");
    assert.equal(readVersion(join(prevSetOf(h.mods), "am-sidebar")), "0.1.0");
    assert.equal(readAuto(h.mods).skip, null);
  } finally { h.done(); }
});

test("a bad first install with nothing kept cannot restore: a clear reason, no crash, no retry loop", async () => {
  const h = autoHome(["0.2.0"]);
  const app = fakeCheckApp(join(h.home, "bad"), ["am-tabs"]);
  try {
    // Nothing installed before: applyUpdate keeps no .prev, so there is nothing to put back.
    rmSync(join(h.mods, "am-sidebar"), { recursive: true, force: true });
    rmSync(join(h.mods, "am-tabs"), { recursive: true, force: true });
    rmSync(markerOf(h.mods));
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin });
    assert.equal(r.installed.version, "0.2.0", "the update is kept");
    assert.equal(r.installed.restored, undefined);
    assert.equal(r.installed.restoreError, "could not restore: no previous version kept");
    assert.equal(readMarker(h.mods).version, "0.2.0");
    assert.equal(existsSync(prevSetOf(h.mods)), false);
    assert.match(readFileSync(join(h.home, "automagik-herdr", RESTORE_FILE), "utf8"), /"error":"could not restore: no previous version kept"/);
    // The same pointer is not offered over itself: the next look has nothing to install.
    const again = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin });
    assert.equal(again.installed, null);
    assert.equal(again.update, null);
  } finally { h.done(); }
});

test("herdr-app missing after an update: no restore, the update is kept and said unchecked", async () => {
  const h = autoHome(["0.2.0"]);
  try {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods,
      herdrApp: join(h.home, "no-herdr-app") });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(r.installed.restored, undefined);
    assert.equal(r.installed.restoreError, undefined);
    assert.deepEqual(r.installed.check, { failed: [], checked: false, unavailable: "herdr-app is not on PATH" });
    const note = JSON.parse(readFileSync(join(h.home, "automagik-herdr", CHECK_FILE), "utf8"));
    assert.deepEqual([note.version, note.from, note.unavailable], ["0.2.0", "0.1.0", "herdr-app is not on PATH"],
      "the new build can say it was not checked");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.2.0", "the update was kept");
    assert.equal(readVersion(join(prevSetOf(h.mods), "am-sidebar")), "0.1.0");
    assert.equal(readAuto(h.mods).skip, null);
  } finally { h.done(); }
});

test("managedPack: only a pack install.sh put in place from a signed release; never a checkout or a hand install", () => {
  const h = autoHome([]);
  try {
    assert.deepEqual(managedPack(h.mods), { managed: true, why: null });
    writeFileSync(markerOf(h.mods), "version=0.1.0\nmods=am-sidebar,am-tabs\nbefore=none\n");
    assert.match(managedPack(h.mods).why, /before signed releases: run `am update` once/);
    rmSync(markerOf(h.mods));
    assert.match(managedPack(h.mods).why, /not installed by install.sh/);
    // A dev checkout: mods/am-sidebar is a link.
    const checkout = mkdtempSync(join(tmpdir(), "checkout-"));
    renameSync(join(h.mods, "am-sidebar"), join(checkout, "am-sidebar"));
    symlinkSync(join(checkout, "am-sidebar"), join(h.mods, "am-sidebar"));
    writeFileSync(markerOf(h.mods), "version=0.1.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=10000\n");
    assert.match(managedPack(h.mods).why, /is a link to a checkout/);
    rmSync(checkout, { recursive: true, force: true });
  } finally { h.done(); }
});

test("the setting: on by default, written whole beside the record, read by check; garbage reads as on", async () => {
  const h = autoHome();
  try {
    assert.deepEqual(readAuto(h.mods), { on: true, skip: null });
    assert.equal(autoFileOf(h.mods), join(h.home, "automagik-herdr", "auto-update.json"));
    writeAuto(h.mods, { on: false });
    assert.deepEqual(JSON.parse(readFileSync(autoFileOf(h.mods), "utf8")), { auto: false });
    const found = await checkForUpdate({ fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, keys });
    assert.deepEqual(found.auto, { on: false, skip: null, managed: true, why: null });
    writeFileSync(autoFileOf(h.mods), "{ not json");
    assert.deepEqual(readAuto(h.mods), { on: true, skip: null });
    assert.deepEqual(readdirSync(join(h.home, "automagik-herdr")).filter((f) => f.startsWith(".auto-update")), [], "no temp file left");
  } finally { h.done(); }
});

test("a rollback sticks: the version rolled away from is never installed on its own; a newer one is", async () => {
  const h = autoHome();
  try {
    const first = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true });
    assert.equal(first.installed.version, "0.2.0");
    rollback({ modsDir: h.mods });
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    assert.equal(readAuto(h.mods).skip, "0.2.0", "the rollback recorded the version it rolled away from");
    assert.equal(autoStatus(h.mods).managed, true, "the rolled-to pack is still install.sh's");
    const calls = [];
    const held = await installUpdate({ keys, fetch: fakeFetch(h.table, calls), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true });
    assert.equal(held.installed, null);
    assert.match(held.held, /0\.2\.0 was rolled back here/);
    assert.deepEqual(calls.map((c) => c.url), [POINTER_URL, POINTER_SIG_URL], "nothing downloaded");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    // The person can still install it by hand.
    const asked = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.2.0" });
    assert.equal(asked.installed.version, "0.2.0");
    rollback({ modsDir: h.mods });
    h.serve("0.3.0");
    const newer = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.3.0", auto: true });
    assert.equal(newer.installed.version, "0.3.0");
  } finally { h.done(); }
});

test("apply --auto holds, downloading nothing: the switch off, a checkout, another update or rollback running", async () => {
  const h = autoHome();
  try {
    const calls = [];
    writeAuto(h.mods, { on: false });
    const off = await installUpdate({ keys, fetch: fakeFetch(h.table, calls), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true });
    assert.equal(off.installed, null);
    assert.match(off.held, /is off/);
    writeAuto(h.mods, { on: true });
    const free = takeLock(h.mods);
    const busy = await installUpdate({ keys, fetch: fakeFetch(h.table, calls), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true });
    assert.match(busy.held, /another update or rollback is running/);
    await assert.rejects(installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods }), /another update or rollback is running/,
      "asked for by hand: an error, not a silent hold");
    assert.throws(() => rollback({ modsDir: h.mods }), /another update or rollback is running/);
    free();
    assert.equal(existsSync(lockOf(h.mods)), false);
    assert.ok(calls.every((c) => c.url === POINTER_URL || c.url === POINTER_SIG_URL), "no tarball fetched");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    // A lock left by a run that died (older than LOCK_STALE_MS) is taken over.
    mkdirSync(lockOf(h.mods));
    const later = takeLock(h.mods, Date.now() + 11 * 60_000);
    later();
    // The released lock lets it through.
    const ok = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, expect: "0.2.0", auto: true });
    assert.equal(ok.installed.version, "0.2.0");
    assert.equal(existsSync(lockOf(h.mods)), false, "freed after the install");
  } finally { h.done(); }
});

test("a failed swap leaves the installed pack whole (no half-installed pack) and the lock free", async () => {
  const h = autoHome();
  try {
    let n = 0;
    const rename = (from, to) => { if (++n === 3) throw new Error("disk full"); renameSync(from, to); };
    const t = tarball("0.2.0");
    try {
      await assert.rejects(applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: h.mods, rename }), /disk full/);
    } finally { rmSync(t.src, { recursive: true, force: true }); }
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    assert.equal(readFileSync(join(h.mods, "am-tabs", "main.js"), "utf8"), 'export const v = "0.1.0";\n');
    assert.equal(readMarker(h.mods).version, "0.1.0");
    assert.deepEqual(readdirSync(stateDirOf(h.mods)).filter((f) => f.startsWith("staging-") || f.startsWith(".prev-next-")), []);
  } finally { h.done(); }
});

test("automagik-herdr update --auto on|off|status, and apply --auto in update.mjs's arguments", async () => {
  const h = autoHome([]);
  try {
    assert.match(await cmdUpdate({ auto: "status" }, [], { modsDir: h.mods, env: {} }), /^Install updates automatically: on\.$/);
    assert.match(await cmdUpdate({ auto: "off" }, [], { modsDir: h.mods, env: {} }), /^Install updates automatically: off\.$/);
    assert.equal(readAuto(h.mods).on, false);
    writeAuto(h.mods, { skip: "0.2.0" });
    assert.equal(await cmdUpdate({ auto: "on" }, [], { modsDir: h.mods, env: {} }),
      "Install updates automatically: on.\n0.2.0 was rolled back here: it waits for a release newer than 0.2.0.");
    assert.deepEqual(await cmdUpdate({ auto: "status", json: true }, [], { modsDir: h.mods, env: {} }),
      { on: true, skip: "0.2.0", managed: true, why: null, checks: true });
    rmSync(markerOf(h.mods));
    assert.match(await cmdUpdate({ auto: "status" }, [], { modsDir: h.mods, env: {} }), /It doesn't apply to this pack \(this pack was not installed by install.sh/);
    await assert.rejects(cmdUpdate({ auto: "maybe" }, [], { modsDir: h.mods }), /--auto takes on, off or status/);
    await assert.rejects(cmdUpdate({ auto: "on", check: true }, [], { modsDir: h.mods }), /--auto alone/);
    const { parseArgs } = await import("../mods/am-sidebar/update.mjs");
    assert.deepEqual(parseArgs(["apply", "--expect", "0.2.0", "--auto"]), { command: "apply", opts: { expect: "0.2.0", auto: true } });
    assert.throws(() => parseArgs(["check", "--auto"]), /usage/);
  } finally { h.done(); }
});

// ---- Review of #271: races between runs (the reviewer's zz-race scenarios, with assertions) ----

/** fetch that runs `between()` once, right after the signed pointer is read: another run lands then. */
const racing = (fetch, between) => {
  let raced = false;
  return async (url, init) => {
    const r = await fetch(url, init);
    if (!raced && String(url).endsWith(".sig")) { raced = true; await between(); }
    return r;
  };
};

test("race: a CLI update lands between the auto check and its lock: no reinstall over itself, the rollback target kept", async () => {
  const h = autoHome(["0.2.0"]);
  try {
    const base = fakeFetch(h.table);
    const fetch = racing(base, () => installUpdate({ fetch: base, env: {}, modsDir: h.mods, keys }));
    const r = await installUpdate({ fetch, env: {}, modsDir: h.mods, keys, expect: "0.2.0", auto: true });
    assert.equal(r.installed, null);
    assert.equal(r.update, null);
    assert.equal(r.current, "0.2.0");
    assert.equal(parseMarker(readFileSync(join(prevSetOf(h.mods), ".pack"), "utf8")).version, "0.1.0", "rollback still goes to 0.1.0");
    // The same for an update asked for by hand.
    rollback({ modsDir: h.mods });
    writeAuto(h.mods, { skip: null });
    const manual = racing(base, () => installUpdate({ fetch: base, env: {}, modsDir: h.mods, keys }));
    const m = await installUpdate({ fetch: manual, env: {}, modsDir: h.mods, keys });
    assert.equal(m.installed, null);
    assert.equal(parseMarker(readFileSync(join(prevSetOf(h.mods), ".pack"), "utf8")).version, "0.1.0");
  } finally { h.done(); }
});

test("race: a newer release installed between the auto check and its lock is never downgraded", async () => {
  const h = autoHome(["0.2.0"]);
  const t3 = autoHome(["0.3.0"]);
  try {
    const newer = fakeFetch({ ...h.table, ...t3.table });
    const fetch = racing(fakeFetch(h.table), () => installUpdate({ fetch: newer, env: {}, modsDir: h.mods, keys }));
    const r = await installUpdate({ fetch, env: {}, modsDir: h.mods, keys, expect: "0.2.0", auto: true });
    assert.equal(r.installed, null);
    assert.equal(readMarker(h.mods).version, "0.3.0");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.3.0");
  } finally { h.done(); t3.done(); }
});

test("an auto install whose record can't be written is a failure (no reinstall loop); asked for by hand it warns", async () => {
  const h = autoHome(["0.2.0"]);
  try {
    mkdirSync(`${markerOf(h.mods)}.tmp`); // writeMarker's temp path is taken: the record can't be written
    await assert.rejects(installUpdate({ fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, keys, expect: "0.2.0", auto: true }),
      /0\.2\.0 went in, but the install record could not be written/);
    assert.equal(existsSync(lockOf(h.mods)), false, "the lock is freed");
    rollback({ modsDir: h.mods });
    writeAuto(h.mods, { skip: null });
    const manual = await installUpdate({ fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, keys });
    assert.equal(manual.installed.recorded, false);
    assert.ok(manual.installed.warnings.some((w) => /ownership record could not be written/.test(w)));
  } finally { h.done(); }
});

test("lock: a run whose stale lock was taken over never frees the new holder's; a second taker is refused", () => {
  const h = autoHome([]);
  try {
    const old = takeLock(h.mods, Date.now());
    const later = Date.now() + 11 * 60_000;
    const a = takeLock(h.mods, later); // the old one looks dead: taken over
    assert.throws(() => takeLock(h.mods, Date.now()), /another update or rollback is running/, "A's lock is fresh");
    old(); // the slow old holder finishes
    assert.equal(existsSync(lockOf(h.mods)), true, "A still holds it");
    assert.throws(() => takeLock(h.mods, Date.now()), /another update or rollback is running/);
    a();
    assert.equal(existsSync(lockOf(h.mods)), false);
    assert.deepEqual(readdirSync(stateDirOf(h.mods)).filter((f) => f.startsWith(".update.lock")), [], "nothing left aside");
  } finally { h.done(); }
});

test("lock: the setting is written under it, so a switch never wipes a rollback's skip; rollback records it while holding", async () => {
  const h = autoHome(["0.2.0"]);
  try {
    await installUpdate({ fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, keys });
    const free = takeLock(h.mods);
    assert.throws(() => writeAuto(h.mods, { on: false }), /another update or rollback is running/);
    await assert.rejects(cmdUpdate({ auto: "off" }, [], { modsDir: h.mods, env: {} }), /The setting was not saved: another update/);
    assert.equal(readAuto(h.mods).on, true);
    free();
    rollback({ modsDir: h.mods });
    assert.equal(readAuto(h.mods).skip, "0.2.0");
    writeAuto(h.mods, { on: false });
    assert.deepEqual(readAuto(h.mods), { on: false, skip: "0.2.0" });
  } finally { h.done(); }
});

// ---- The pointer's sequence (#207 L2) and #276's off-by-default, through an install on its own ----

test("a pointer whose sequence is below the record's is never offered or installed, whatever version it names", async () => {
  const h = autoHome([]);
  const t = tarball("0.2.0");
  try {
    const url = "https://dl.test/v0.2.0/automagik-herdr-pack-0.2.0.tgz";
    const table = { ...served("0.2.0", { url, body: t.buf, sequence: 5000 }), [url]: t.buf }; // the record says 10000
    const found = await checkForUpdate({ fetch: fakeFetch(table), env: {}, modsDir: h.mods, keys });
    assert.equal(found.update, null);
    assert.deepEqual(found.olderSequence, { sequence: 5000, recorded: 10000 });
    const calls = [];
    for (const auto of [true, false]) {
      const r = await installUpdate({ fetch: fakeFetch(table, calls), env: {}, modsDir: h.mods, keys, auto });
      assert.equal(r.installed, null);
    }
    assert.ok(calls.every((c) => c.url !== url), "no tarball downloaded");
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    assert.equal(olderSequence({ sequence: 10000 }, { sequence: 10000 }), false, "the same sequence is not older");
    assert.equal(olderSequence({ sequence: null }, { sequence: 1 }), false, "a record without one compares nothing");
  } finally { rmSync(t.src, { recursive: true, force: true }); h.done(); }
});

test("under the lock: a record that moved to a higher sequence since the check stops the install", async () => {
  const h = autoHome(["0.2.0"]); // pointer 0.2.0 at sequence 20000; record 0.1.0 at 10000
  try {
    // Between the check and the lock, the record now came through sequence 30000 (same version).
    const fetch = racing(fakeFetch(h.table), async () => {
      writeFileSync(markerOf(h.mods), "version=0.1.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=30000\n");
    });
    const r = await installUpdate({ fetch, env: {}, modsDir: h.mods, keys, expect: "0.2.0", auto: true });
    assert.equal(r.installed, null);
    assert.equal(readVersion(join(h.mods, "am-sidebar")), "0.1.0");
    assert.equal(readMarker(h.mods).sequence, 30000);
  } finally { h.done(); }
});

test("an install on its own keeps #276's off-by-default: am-quota arriving first lands in mods-disabled/, an on copy stays on", async () => {
  const h = autoHome([]);
  const withQuota = [...MODS, "am-quota"];
  const t2 = tarball("0.2.0", { mods: withQuota });
  const t3 = tarball("0.3.0", { mods: withQuota });
  const table = {};
  for (const [v, t] of [["0.2.0", t2], ["0.3.0", t3]]) {
    const url = `https://dl.test/v${v}/automagik-herdr-pack-${v}.tgz`;
    Object.assign(table, { [url]: t.buf });
  }
  const at = (v, t) => ({ ...table, ...served(v, { url: `https://dl.test/v${v}/automagik-herdr-pack-${v}.tgz`, body: t.buf }) });
  try {
    const r = await installUpdate({ fetch: fakeFetch(at("0.2.0", t2)), env: {}, modsDir: h.mods, keys, expect: "0.2.0", auto: true });
    assert.equal(r.installed.version, "0.2.0");
    assert.equal(existsSync(join(h.mods, "am-quota")), false, "Herdr doesn't load it");
    assert.equal(existsSync(join(offDirOf(h.mods), "am-quota", "main.js")), true);
    // The person turns it on; the next install on its own keeps it on.
    renameSync(join(offDirOf(h.mods), "am-quota"), join(h.mods, "am-quota"));
    const r3 = await installUpdate({ fetch: fakeFetch(at("0.3.0", t3)), env: {}, modsDir: h.mods, keys, expect: "0.3.0", auto: true });
    assert.equal(r3.installed.version, "0.3.0");
    assert.equal(readFileSync(join(h.mods, "am-quota", "main.js"), "utf8"), 'export const v = "0.3.0";\n');
    assert.equal(existsSync(join(offDirOf(h.mods), "am-quota")), false);
  } finally { for (const t of [t2, t3]) rmSync(t.src, { recursive: true, force: true }); h.done(); }
});

// ---- Re-review of #271: the lock's takeover and the re-check under it, each pinned ----

test("lock: two runs that both find it stale: the second to move it aside gets the first's fresh lock back and is refused", () => {
  const h = autoHome([]);
  try {
    takeLock(h.mods, Date.now()); // a holder that died: its lock goes stale
    const later = Date.now() + 11 * 60_000;
    let b = null;
    // A looked and found it stale; before A moves it aside, B takes it over completely.
    assert.throws(() => takeLock(h.mods, later, { beforeTakeover: () => { b = takeLock(h.mods, later); } }),
      /another update or rollback is running/);
    assert.ok(b, "B holds it");
    assert.equal(existsSync(lockOf(h.mods)), true, "A put B's lock back");
    assert.throws(() => takeLock(h.mods, Date.now()), /another update or rollback is running/, "and B's lock is fresh");
    b();
    assert.equal(existsSync(lockOf(h.mods)), false);
    assert.deepEqual(readdirSync(stateDirOf(h.mods)).filter((f) => f.startsWith(".update.lock")), []);
  } finally { h.done(); }
});

test("lock: a takeover that loses the folder to another run between the move and the mkdir is 'locked', not a raw EEXIST", () => {
  const h = autoHome([]);
  try {
    takeLock(h.mods, Date.now());
    const later = Date.now() + 11 * 60_000;
    assert.throws(() => takeLock(h.mods, later, { beforeRetake: () => mkdirSync(lockOf(h.mods)) }),
      (e) => e.locked === true && /another update or rollback is running/.test(e.message));
  } finally { h.done(); }
});

test("overtaken (under the lock): the version installed since the check, or a record that came through a higher sequence", () => {
  const h = autoHome([]);
  try {
    const update = { version: "0.2.0", sequence: 20000 };
    assert.equal(overtaken(h.mods, update), null, "0.1.0 at sequence 10000: 0.2.0 at 20000 goes in");
    writeFileSync(markerOf(h.mods), "version=0.1.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=30000\n");
    assert.match(overtaken(h.mods, update).why, /sequence 20000 is below the record's 30000/);
    writeFileSync(markerOf(h.mods), "version=0.2.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=20000\n");
    assert.deepEqual(overtaken(h.mods, update), { current: "0.2.0", why: "0.2.0 is installed now" });
    writeFileSync(markerOf(h.mods), "version=0.3.0\nmods=am-sidebar,am-tabs\nbefore=none\nsequence=30000\n");
    assert.equal(overtaken(h.mods, update).current, "0.3.0", "never a downgrade");
  } finally { h.done(); }
});

// #432: a rename's old folder leaves on the migration moving the layouts onto the new name. A
// layout it cannot move (a link, whose target is the person's, or a shape it does not read) still
// names the old folder, so the folder stays in mods/ beside the new one, said, and the record's;
// the update after the layout changes retires it. This mirrors #420's hold of a retired mod.
{
  const { migrateRefs, placeLayout, restoreLayout } = await import("../mods/am-sidebar/update.mjs");
  const { applyPatch, heldFrom, landedNotice } = await import("../mods/am-sidebar/updateCheck.js");
  const naming = (mod) => `${JSON.stringify({ id: "root", children: [{ id: "t", content: { mod } }, { id: "p", content: { mod: "pane" } }] }, null, 2)}\n`;
  const renameHome = () => {
    const h = appHome("0.1.0", ["am-sidebar", "auto-tabs"]);
    writeFileSync(join(h.mods, "auto-tabs", ".state"), "mine\n");
    mkdirSync(join(h.home, "layouts"));
    return { ...h, t: tarball("0.2.0"), done() { rmSync(this.t.src, { recursive: true, force: true }); rmSync(h.home, { recursive: true, force: true }); } };
  };

  test("a linked layout naming a renamed mod's old folder keeps the folder beside the new one; its target is never written", async () => {
    const h = renameHome();
    try {
      const target = join(h.home, "dotfiles", "mine.json");
      mkdirSync(dirname(target));
      writeFileSync(target, naming("auto-tabs"));
      symlinkSync(target, join(h.home, "layouts", "mine.json"));
      // A layout and a key the migration can move: they still follow the rename while the old folder is held.
      writeFileSync(join(h.home, "layouts", "plain.json"), naming("auto-tabs"));
      writeFileSync(join(h.home, "keys.json"), `${JSON.stringify({ global: { "cmd-t": "auto-tabs.new" } }, null, 2)}\n`);
      const logs = [];
      const r = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods, log: (l) => logs.push(l) });
      assert.deepEqual([r.retired, r.held, r.renamed], [[], [{ mod: "auto-tabs", renamed: "am-tabs", layouts: ["mine"] }], [["auto-tabs", "am-tabs"]]]);
      assert.ok(existsSync(join(h.mods, "auto-tabs", "main.js")), "held in mods/");
      assert.ok(existsSync(join(h.mods, "am-tabs", "main.js")), "the new folder is installed");
      assert.equal(readFileSync(join(h.mods, "am-tabs", ".state"), "utf8"), "mine\n", "its state carried over");
      assert.deepEqual(readMarker(h.mods).mods.sort(), ["am-sidebar", "am-tabs", "auto-tabs"], "still the record's");
      assert.ok(logs.some((l) => /^Kept mods\/auto-tabs beside mods\/am-tabs: the mine layout still names it, 0\.2\.0 cannot rewrite it/.test(l)), logs.join("\n"));
      assert.ok(logs.some((l) => /The copy kept is the earlier release's code and gets no updates while it is held/.test(l)), logs.join("\n"));
      // The auto-update's fallback when the old build stopped first: held-mods.json carries `renamed`.
      const note = heldFrom(readFileSync(join(stateDirOf(h.mods), "held-mods.json"), "utf8"), "0.2.0");
      assert.deepEqual(note, [{ mod: "auto-tabs", renamed: "am-tabs", layouts: ["mine"] }]);
      assert.match(landedNotice("0.2.0", "0.1.0", false, note).body, /Kept mods\/auto-tabs beside mods\/am-tabs: the mine layout still names it/);
      const mlog = [];
      const m = migrateRefs({ modsDir: h.mods, log: (l) => mlog.push(l) });
      assert.ok(m.journal, "the rest migrated");
      assert.match(readFileSync(join(h.home, "layouts", "plain.json"), "utf8"), /"mod": "am-tabs"/);
      assert.deepEqual(JSON.parse(readFileSync(join(h.home, "keys.json"), "utf8")), { global: { "cmd-t": "am-tabs.new" } });
      assert.ok(lstatSync(join(h.home, "layouts", "mine.json")).isSymbolicLink());
      assert.equal(readFileSync(target, "utf8"), naming("auto-tabs"), "a link's target is the person's");
      assert.ok(mlog.some((l) => l.includes("mine.json (it names auto-tabs, and this migration cannot move it to am-tabs, so mods/auto-tabs stays")), mlog.join("\n"));
      // The person points the layout at the new name: the next update retires the old folder.
      writeFileSync(target, naming("am-tabs"));
      const later = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods });
      assert.deepEqual([later.retired, later.held], [["auto-tabs"], []]);
      assert.equal(existsSync(join(h.mods, "auto-tabs")), false);
      assert.ok(existsSync(join(kept(h.mods, "auto-tabs"), "main.js")));
      assert.ok(!readMarker(h.mods).mods.includes("auto-tabs"));
    } finally { h.done(); }
  });

  test("a layout the migration does not read, naming a renamed mod's old folder, keeps the folder; one that does not parse holds nothing", async () => {
    const h = renameHome();
    try {
      const odd = `${JSON.stringify({ id: "root", children: { tabs: { id: "t", content: { mod: "auto-tabs" } } } }, null, 2)}\n`;
      writeFileSync(join(h.home, "layouts", "odd.json"), odd);
      writeFileSync(join(h.home, "layouts", "broken.json"), '{"content": {"mod": "auto-tabs"');
      const r = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods });
      assert.deepEqual([r.retired, r.held], [[], [{ mod: "auto-tabs", renamed: "am-tabs", layouts: ["odd"] }]]);
      assert.ok(existsSync(join(h.mods, "auto-tabs", "main.js")));
      migrateRefs({ modsDir: h.mods });
      assert.equal(readFileSync(join(h.home, "layouts", "odd.json"), "utf8"), odd, "left as it is");
    } finally { h.done(); }
  });

  test("a held old folder survives a repair and a rollback, and the auto-update's notice says it", async () => {
    const h = renameHome();
    try {
      const target = join(h.home, "mine-target.json");
      writeFileSync(target, naming("auto-tabs"));
      symlinkSync(target, join(h.home, "layouts", "mine.json"));
      const held = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods });
      assert.equal(held.held.length, 1);
      const patch = applyPatch({ code: 0, stdout: JSON.stringify({ installed: { version: "0.2.0", held: held.held } }) }, { current: "0.1.0" }, 1);
      assert.deepEqual(patch.heldMods, held.held);
      assert.match(landedNotice("0.2.0", "0.1.0", false, patch.heldMods).body, /Kept mods\/auto-tabs beside mods\/am-tabs: the mine layout still names it/);
      await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods, repair: ["am-sidebar"] });
      assert.deepEqual(readMarker(h.mods).mods.sort(), ["am-sidebar", "am-tabs", "auto-tabs"], "a repair keeps it on the record");
      const back = rollback({ modsDir: h.mods });
      assert.equal(back.version, "0.1.0");
      assert.ok(existsSync(join(h.mods, "auto-tabs", "main.js")), "the layout keeps its mod");
      assert.equal(existsSync(join(h.mods, "am-tabs")), false);
      assert.equal(readFileSync(join(h.mods, "auto-tabs", ".state"), "utf8"), "mine\n");
      assert.deepEqual(readMarker(h.mods).mods.sort(), ["am-sidebar", "auto-tabs"]);
      assert.equal(readFileSync(target, "utf8"), naming("auto-tabs"));
    } finally { h.done(); }
  });

  test("a renamed old folder whose layouts the migration can move still leaves", async () => {
    const h = renameHome();
    try {
      writeFileSync(join(h.home, "layouts", "plain.json"), naming("auto-tabs"));
      const r = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods });
      assert.deepEqual([r.retired, r.held], [["auto-tabs"], []]);
    } finally { h.done(); }
  });

  test("a linked layouts/ folder naming a renamed mod's old folder keeps the folder, and nothing is written into it", async () => {
    const h = renameHome();
    try {
      const outside = join(h.home, "dotfiles-layouts");
      mkdirSync(outside);
      writeFileSync(join(outside, "mine.json"), naming("auto-tabs"));
      rmSync(join(h.home, "layouts"), { recursive: true });
      symlinkSync(outside, join(h.home, "layouts"));
      const r = await applyUpdate({ tgzPath: h.t.path, version: "0.2.0", modsDir: h.mods });
      assert.deepEqual([r.retired, r.held], [[], [{ mod: "auto-tabs", renamed: "am-tabs", layouts: ["mine"] }]]);
      assert.ok(existsSync(join(h.mods, "auto-tabs", "main.js")));
      migrateRefs({ modsDir: h.mods });
      const tgzDir = join(h.home, "tgz");
      mkdirSync(join(tgzDir, "layouts"), { recursive: true });
      writeFileSync(join(tgzDir, "layouts", "automagik.json"), "{\"id\":\"new\"}\n");
      const logs = [];
      assert.equal(placeLayout({ modsDir: h.mods, tgzDir, record: readMarker(h.mods), log: (l) => logs.push(l) }), "kept");
      assert.deepEqual(readdirSync(outside), ["mine.json"], "nothing added behind the link");
      assert.equal(readFileSync(join(outside, "mine.json"), "utf8"), naming("auto-tabs"));
      assert.ok(logs.some((l) => /layouts\/ is a link/.test(l)), logs.join("\n"));
    } finally { h.done(); }
  });

  test("restoreLayout never writes through a linked automagik.json or layouts/, and says it is a link", () => {
    for (const linkDir of [false, true]) {
      const { home, mods } = appHome("0.1.0");
      try {
        writeFileSync(join(home, "automagik-herdr", "automagik.json"), "{\"id\":\"last\"}\n");
        const outside = join(home, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "automagik.json"), "{\"id\":\"last\"}\n");
        if (linkDir) symlinkSync(outside, join(home, "layouts"));
        else { mkdirSync(join(home, "layouts")); symlinkSync(join(outside, "automagik.json"), join(home, "layouts", "automagik.json")); }
        const logs = [];
        assert.equal(restoreLayout({ modsDir: mods, body: Buffer.from("{\"id\":\"kept\"}\n"), log: (l) => logs.push(l) }), "kept");
        assert.equal(readFileSync(join(outside, "automagik.json"), "utf8"), "{\"id\":\"last\"}\n", "the link's target is the person's");
        assert.ok(logs.some((l) => (linkDir ? /: layouts\/ is a link; the rolled-back pack's/ : /: it is a link; the rolled-back pack's/).test(l)), logs.join("\n"));
        assert.ok(!logs.some((l) => /you changed it/.test(l)), logs.join("\n"));
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });

  test("placeLayout never writes through a linked automagik.json, even one equal to the last pack's", () => {
    const { home, mods } = appHome("0.1.0");
    try {
      const target = join(home, "mine.json");
      writeFileSync(target, "{\"id\":\"old\"}\n");
      writeFileSync(join(home, "automagik-herdr", "automagik.json"), "{\"id\":\"old\"}\n");
      mkdirSync(join(home, "layouts"));
      symlinkSync(target, join(home, "layouts", "automagik.json"));
      const tgzDir = join(home, "tgz");
      mkdirSync(join(tgzDir, "layouts"), { recursive: true });
      writeFileSync(join(tgzDir, "layouts", "automagik.json"), "{\"id\":\"new\"}\n");
      const logs = [];
      const placed = placeLayout({ modsDir: mods, tgzDir, record: readMarker(mods), log: (l) => logs.push(l) });
      assert.equal(placed, "kept");
      assert.equal(readFileSync(target, "utf8"), "{\"id\":\"old\"}\n");
      assert.ok(lstatSync(join(home, "layouts", "automagik.json")).isSymbolicLink());
      assert.ok(logs.some((l) => /it is a link/.test(l)), logs.join("\n"));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
// #420: a mod the release no longer ships stays in mods/ while a layout's block names it (Herdr
// would drop that layout for plain Herdr on the next launch), said, and still the record's; the
// update after the layout changes retires it. A rename's old folder leaves when the migration can
// move every layout naming it onto the new name; one it cannot move holds it (#432, below).
test("a retired mod a layout's block names is held in mods/ and said; once no layout names it, it retires", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "old-mod"]);
  const t = tarball("0.2.0");
  try {
    mkdirSync(join(home, "layouts"));
    const mine = join(home, "layouts", "mine.json");
    writeFileSync(mine, JSON.stringify({ id: "root", children: [{ id: "o", content: { mod: "old-mod" } }, { id: "p", content: { mod: "pane" } }] }));
    writeFileSync(join(home, "layouts", "broken.json"), "{");
    const logs = [];
    const held = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, log: (l) => logs.push(l) });
    assert.deepEqual([held.retired, held.held], [[], [{ mod: "old-mod", layouts: ["mine"] }]]);
    assert.ok(existsSync(join(mods, "old-mod", "main.js")), "held in mods/");
    assert.ok(readMarker(mods).mods.includes("old-mod"), "still the record's");
    assert.ok(logs.some((l) => /^Kept mods\/old-mod: 0\.2\.0 no longer ships it, but the mine layout shows it, and Herdr drops a layout whose mod is gone/.test(l)), logs.join("\n"));
    const note = join(home, "automagik-herdr", "held-mods.json");
    assert.deepEqual(JSON.parse(readFileSync(note, "utf8")), { version: "0.2.0", held: [{ mod: "old-mod", layouts: ["mine"] }] }, "the file the new build reads");
    // The layout changed: the next update retires it into the kept set.
    writeFileSync(mine, JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "pane" } }] }));
    const later = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual([later.retired, later.held], [["old-mod"], []]);
    assert.equal(existsSync(note), false, "an install that holds nothing leaves no old note");
    assert.equal(existsSync(join(mods, "old-mod")), false);
    assert.ok(existsSync(join(kept(mods, "old-mod"), "main.js")));
    assert.ok(!readMarker(mods).mods.includes("old-mod"));
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a switched-off mod the release no longer ships retires even when a layout names it", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "old-mod"]);
  const t = tarball("0.2.0", { mods: ["am-sidebar"] });
  try {
    mkdirSync(offDirOf(mods));
    renameSync(join(mods, "old-mod"), join(offDirOf(mods), "old-mod"));
    mkdirSync(join(home, "layouts"));
    writeFileSync(join(home, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "o", content: { mod: "old-mod" } }] }));
    const r = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual([r.retired, r.held], [["old-mod"], []]);
    assert.ok(!readMarker(mods).mods.includes("old-mod"));
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a held mod survives a repair and a rollback: still in mods/, still the record's", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "old-mod"]);
  const t = tarball("0.2.0", { mods: ["am-sidebar"] });
  try {
    mkdirSync(join(home, "layouts"));
    writeFileSync(join(home, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "o", content: { mod: "old-mod" } }] }));
    writeFileSync(join(mods, "old-mod", ".state"), "mine\n");
    const held = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual(held.held, [{ mod: "old-mod", layouts: ["mine"] }]);
    await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods, repair: ["am-sidebar"] });
    assert.deepEqual(readMarker(mods).mods.sort(), ["am-sidebar", "old-mod"], "a repair keeps it on the record");
    assert.ok(existsSync(join(home, "automagik-herdr", "held-mods.json")), "and leaves the install's note");
    const back = rollback({ modsDir: mods });
    assert.equal(back.version, "0.1.0");
    assert.ok(existsSync(join(mods, "old-mod", "main.js")), "a rollback leaves the layout its mod");
    assert.equal(readFileSync(join(mods, "old-mod", ".state"), "utf8"), "mine\n");
    assert.deepEqual(readMarker(mods).mods.sort(), ["am-sidebar", "old-mod"]);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the pack's unedited automagik.json holds nothing (the release replaces it); an edited one does", async () => {
  const body = JSON.stringify({ id: "root", children: [{ id: "o", content: { mod: "old-mod" } }] });
  for (const [edited, retired, layouts] of [[false, ["old-mod"], []], [true, [], ["automagik"]]]) {
    const { home, mods } = appHome("0.1.0", ["am-sidebar", "old-mod"]);
    const t = tarball("0.2.0", { mods: ["am-sidebar"] });
    try {
      mkdirSync(join(home, "layouts"));
      writeFileSync(join(home, "automagik-herdr", "automagik.json"), body);
      writeFileSync(join(home, "layouts", "automagik.json"), edited ? `${body}\n` : body);
      const r = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
      assert.deepEqual([r.retired, r.held.flatMap((h) => h.layouts)], [retired, layouts]);
    } finally {
      rmSync(t.src, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a renamed mod's old folder a layout names still leaves: the migration moves the layout onto the new name", async () => {
  const { home, mods } = appHome("0.1.0", ["am-sidebar", "auto-tabs"]);
  const t = tarball("0.2.0");
  try {
    mkdirSync(join(home, "layouts"));
    writeFileSync(join(home, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "s", content: { mod: "auto-tabs" } }] }));
    const r = await applyUpdate({ tgzPath: t.path, version: "0.2.0", modsDir: mods });
    assert.deepEqual([r.retired, r.held, r.renamed], [["auto-tabs"], [], [["auto-tabs", "am-tabs"]]]);
    assert.equal(existsSync(join(mods, "auto-tabs")), false);
  } finally {
    rmSync(t.src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- #494: a linked mods/ is the person's folder: nothing moves through it, and the refusal says why ----

/** The refusal's exact words (layoutSafe.mjs linkedModsLine), written out so a changed line fails here. */
const linkedLine = (mods, to) => `mods/ (${mods}) is a link to ${to}, your own folder, not one this install made: nothing is moved `
  + "through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again";

/** The pack at 0.1.0, then mods/ made a link to a folder outside the app home (the folders inside it). */
function linkedHome(t) {
  const { home, mods } = appHome("0.1.0");
  const ext = mkdtempSync(join(tmpdir(), "their-mods-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true }); });
  renameSync(mods, join(ext, "mods"));
  symlinkSync(join(ext, "mods"), mods);
  return { home, mods, ext: join(ext, "mods") };
}

test("#494: an update through a linked mods/ is refused with why: nothing moves, the record stays 0.1.0", async (t) => {
  const h = linkedHome(t);
  const tgz = tarball("0.2.0");
  t.after(() => rmSync(tgz.src, { recursive: true, force: true }));
  const before = readdirSync(h.ext).sort();
  await assert.rejects(applyUpdate({ tgzPath: tgz.path, version: "0.2.0", modsDir: h.mods }), (e) => e.message === linkedLine(h.mods, h.ext));
  assert.deepEqual(readdirSync(h.ext).sort(), before);
  assert.equal(readFileSync(join(h.ext, "am-sidebar", "main.js"), "utf8"), 'export const v = "0.1.0";\n');
  assert.equal(readMarker(h.mods).version, "0.1.0", "the record still names what mods/ holds");
  assert.equal(existsSync(prevSetOf(h.mods)), false, "nothing went into the kept set");
});

test("#494: pack-out through a linked mods/ is refused with why: no folder moves, no line says one did", (t) => {
  const h = linkedHome(t);
  const to = join(stateDirOf(h.mods), ".prev-next.test");
  mkdirSync(to);
  assert.throws(() => packOut({ modsDir: h.mods, to, move: [join(h.mods, "am-tabs")] }), (e) => e.message === linkedLine(h.mods, h.ext));
  assert.ok(existsSync(join(h.ext, "am-tabs", "main.js")));
  assert.deepEqual(readdirSync(to), []);
});

test("#494: a rollback whose swap stays in mods-disabled/ leaves an adopted folder out of a linked mods/, saying why (L3)", (t) => {
  const three = ["am-sidebar", "am-tabs", "am-status"];
  const { home, mods } = appHome("0.1.0", three);
  const ext = mkdtempSync(join(tmpdir(), "their-mods-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true }); });
  // Every mod switched off; the kept set (0.0.9) had no am-status, which the install adopted over the person's.
  const off = offDirOf(mods);
  mkdirSync(off);
  for (const m of three) renameSync(join(mods, m), join(off, m));
  const prev = prevSetOf(mods);
  packDir(prev, "0.0.9", { mods: ["am-sidebar", "am-tabs"] });
  writeFileSync(join(prev, ".pack"), formatMarker({ version: "0.0.9", mods: ["am-sidebar", "am-tabs"], off: ["am-sidebar", "am-tabs"] }));
  const backup = join(stateDirOf(mods), "backup", "am-status-old");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "main.js"), "// mine\n");
  writeMarker(mods, { ...readMarker(mods), adopted: [{ mod: "am-status", path: "backup/am-status-old" }] });
  renameSync(mods, join(ext, "mods"));
  symlinkSync(join(ext, "mods"), mods);
  const r = rollback({ modsDir: mods });
  assert.ok(r.warnings.includes(`mods/am-status stays in ${backup} (${linkedLine(mods, join(ext, "mods"))})`), r.warnings.join("\n"));
  assert.deepEqual(readdirSync(join(ext, "mods")), [], "nothing went into the linked mods/");
  assert.ok(existsSync(join(backup, "main.js")), "the adopted folder stays in backup/");
  assert.deepEqual(readMarker(mods).adopted, [{ mod: "am-status", path: "backup/am-status-old" }], "still recorded, so a later run can put it back");
});

// ---- #839: tighten existing Herdr ledgers to 0600 on install/update ----

test("#839: applyUpdate and moveHooks tighten 0664/0644 workers.jsonl and attach.jsonl in appHome, knownProjects and ledgerFolders to 0600 once, keeping bytes and 0400/missing ledgers untouched", async (t) => {
  const { home, mods } = appHome("0.1.0");
  const root = mkdtempSync(join(tmpdir(), "ledgers-proj-"));
  const tgz = tarball("0.2.0");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(tgz.src, { recursive: true, force: true });
  });
  const projA = join(root, "proj-a");
  const projB = join(root, "proj-b");
  const worktreeB = join(projB, ".claude", "worktrees", "task-1");
  mkdirSync(join(projA, ".herdr", "app-home", "automagik-herdr"), { recursive: true });
  mkdirSync(join(projB, ".herdr", "app-home", "automagik-herdr"), { recursive: true });
  mkdirSync(worktreeB, { recursive: true });
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "am.sidebar.projects": [{ key: projA }] }));

  const globalWorkers = join(home, "automagik-herdr", "workers.jsonl");
  const globalAttach = join(home, "automagik-herdr", "attach.jsonl");
  const projAWorkers = join(projA, ".herdr", "app-home", "automagik-herdr", "workers.jsonl");
  const projAAttach = join(projA, ".herdr", "app-home", "automagik-herdr", "attach.jsonl");
  const projBAttach = join(projB, ".herdr", "app-home", "automagik-herdr", "attach.jsonl");
  const projBWorkersMissing = join(projB, ".herdr", "app-home", "automagik-herdr", "workers.jsonl");

  const globalWorkersText = `${JSON.stringify({ event: "start", worker: "w-1", worktree: worktreeB, session: "s-1" })}\n`;
  const globalAttachText = `${JSON.stringify({ event: "attach", bot: "b-1", project: projA, session: "s-2" })}\n`;
  writeFileSync(globalWorkers, globalWorkersText);
  chmodSync(globalWorkers, 0o664);
  writeFileSync(globalAttach, globalAttachText);
  chmodSync(globalAttach, 0o644);
  writeFileSync(projAWorkers, '{"event":"start","session":"s-a"}\n');
  chmodSync(projAWorkers, 0o644);
  writeFileSync(projAAttach, '{"event":"attach","session":"s-ro"}\n');
  chmodSync(projAAttach, 0o400);
  writeFileSync(projBAttach, '{"event":"attach","session":"s-b"}\n');
  chmodSync(projBAttach, 0o664);

  const logs = [];
  await applyUpdate({ tgzPath: tgz.path, version: "0.2.0", modsDir: mods, log: (l) => logs.push(l) });

  for (const f of [globalWorkers, globalAttach, projAWorkers, projBAttach]) {
    assert.equal(lstatSync(f).mode & 0o777, 0o600, `${f} tightened to 0600`);
  }
  assert.equal(lstatSync(projAAttach).mode & 0o777, 0o400, "0400 ledger is never widened");
  assert.equal(existsSync(projBWorkersMissing), false, "missing ledger is never created");
  assert.equal(readFileSync(globalWorkers, "utf8"), globalWorkersText);
  assert.equal(readFileSync(globalAttach, "utf8"), globalAttachText);
  const summaryLines = logs.filter((l) => l.startsWith("tightened Herdr ledger(s) to 0600: "));
  assert.equal(summaryLines.length, 1, `expected one summary line, got: ${logs.join("\n")}`);
  for (const f of [globalWorkers, globalAttach, projAWorkers, projBAttach]) {
    assert.ok(summaryLines[0].includes(f), `summary names ${f}: ${summaryLines[0]}`);
  }

  // Second run via moveHooks and tightenLedgers: idempotent, nothing changed or logged.
  const logs2 = [];
  moveHooks({ modsDir: mods, log: (l) => logs2.push(l) });
  const second = tightenLedgers(home, { log: (l) => logs2.push(l) });
  assert.deepEqual(second, { tightened: [], warnings: [] });
  assert.equal(logs2.some((l) => l.includes("tightened Herdr ledger")), false, logs2.join("\n"));
  chmodSync(projAAttach, 0o600);
});

test("#839: tightenLedgers refuses symlinks without changing the target and warns on unowned ledgers without chmod", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ledgers-safe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "automagik-herdr"), { recursive: true });
  const target = join(home, "outside-target.jsonl");
  writeFileSync(target, '{"session":"keep"}\n');
  chmodSync(target, 0o644);
  const workersLink = join(home, "automagik-herdr", "workers.jsonl");
  symlinkSync(target, workersLink);

  const attachFile = join(home, "automagik-herdr", "attach.jsonl");
  writeFileSync(attachFile, '{"session":"unowned"}\n');
  chmodSync(attachFile, 0o644);

  const logs = [];
  const fchmodCalls = [];
  const r = tightenLedgers(home, {
    getuid: () => 999999,
    fchmod: (fd, m) => { fchmodCalls.push([fd, m]); fchmodSync(fd, m); },
    log: (l) => logs.push(l),
  });
  assert.deepEqual(r.tightened, []);
  assert.deepEqual(fchmodCalls, [], "neither symlink nor unowned file is fchmodded");
  assert.equal(lstatSync(workersLink).isSymbolicLink(), true);
  assert.equal(lstatSync(target).mode & 0o777, 0o644, "symlink target mode is untouched");
  assert.equal(lstatSync(attachFile).mode & 0o777, 0o644, "unowned file mode is untouched");
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /workers\.jsonl is a symlink: left as it is/);
  assert.match(r.warnings[1], /attach\.jsonl is owned by uid \d+, not 999999: left as it is/);
  assert.equal(logs.filter((l) => l.startsWith("warning: ")).length, 2);
});

test("#839: tightenLedgers refuses a ledger swapped for a symlink between inspection and open/fchmod, skips owner-unreadable ledgers, and tightens 0444/0464 to 0400 with truthful logging", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ledgers-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "automagik-herdr"), { recursive: true });
  const targetA = join(home, "target-a.jsonl");
  const targetB = join(home, "target-b.jsonl");
  const targetC = join(home, "target-c.jsonl");
  writeFileSync(targetA, '{"session":"target-a"}\n');
  chmodSync(targetA, 0o644);
  writeFileSync(targetB, '{"session":"target-b"}\n');
  chmodSync(targetB, 0o644);
  writeFileSync(targetC, '{"session":"target-c"}\n');
  chmodSync(targetC, 0o644);

  const workersFile = join(home, "automagik-herdr", "workers.jsonl");
  const attachFile = join(home, "automagik-herdr", "attach.jsonl");
  writeFileSync(workersFile, '{"session":"plain-w"}\n');
  chmodSync(workersFile, 0o644);
  writeFileSync(attachFile, '{"session":"plain-a"}\n');
  chmodSync(attachFile, 0o644);

  // (a1) Swap workers.jsonl for a symlink right after the first stat (before openSync).
  let seenWorkers = false;
  const rSwapStat = tightenLedgers(home, {
    stat: (p) => {
      const st = lstatSync(p);
      if (p === workersFile && !seenWorkers) {
        seenWorkers = true;
        unlinkSync(workersFile);
        symlinkSync(targetA, workersFile);
      }
      return st;
    },
  });
  assert.deepEqual(rSwapStat.tightened, [attachFile]);
  assert.equal(lstatSync(attachFile).mode & 0o777, 0o600, "attach.jsonl tightened to 0600");
  assert.equal(lstatSync(workersFile).isSymbolicLink(), true);
  assert.equal(lstatSync(targetA).mode & 0o777, 0o644, "symlink targetA stays 0644");
  assert.equal(rSwapStat.warnings.length, 1);
  assert.match(rSwapStat.warnings[0], /workers\.jsonl became a symlink: left as it is/);

  // (a2) O_NOFOLLOW open/fstat/fchmod path: swap attach.jsonl for a symlink right before openSync.
  unlinkSync(workersFile);
  writeFileSync(workersFile, '{"session":"plain-w2"}\n');
  chmodSync(workersFile, 0o600);
  chmodSync(attachFile, 0o644);
  const rSwapOpen = tightenLedgers(home, {
    open: (p, flags) => {
      if (p === attachFile) {
        unlinkSync(attachFile);
        symlinkSync(targetB, attachFile);
      }
      return openSync(p, flags);
    },
  });
  assert.deepEqual(rSwapOpen.tightened, []);
  assert.equal(lstatSync(attachFile).isSymbolicLink(), true);
  assert.equal(lstatSync(targetB).mode & 0o777, 0o644, "symlink targetB stays 0644");
  assert.equal(rSwapOpen.warnings.length, 1);
  assert.match(rSwapOpen.warnings[0], /attach\.jsonl became a symlink: left as it is/);

  // (a3) Open-then-swap: openSync opens the regular ledger, and before open returns fd, the path
  // is replaced with a symlink to victim targetC (0644). fchmod tightens only the open fd,
  // leaving targetC at 0644 untouched (kills Mutant MB: replacing fchmod with path chmod).
  unlinkSync(attachFile);
  writeFileSync(attachFile, '{"session":"plain-a3"}\n');
  chmodSync(attachFile, 0o644);
  const origLink = join(home, "attach-orig.jsonl");
  linkSync(attachFile, origLink);
  const rOpenThenSwap = tightenLedgers(home, {
    open: (p, flags) => {
      const fd = openSync(p, flags);
      if (p === attachFile) {
        unlinkSync(attachFile);
        symlinkSync(targetC, attachFile);
      }
      return fd;
    },
  });
  assert.deepEqual(rOpenThenSwap.tightened, [attachFile]);
  assert.equal(rOpenThenSwap.warnings.length, 0);
  assert.equal(lstatSync(origLink).mode & 0o777, 0o600, "fchmod tightened the opened descriptor");
  assert.equal(lstatSync(targetC).mode & 0o777, 0o644, "victim symlink targetC stays 0644 untouched");
  unlinkSync(origLink);

  // (b) 0444 and 0464 ledgers tighten to 0400 (never widened to 0600) and log 'to 0400'.
  unlinkSync(attachFile);
  writeFileSync(workersFile, '{"session":"ro-444"}\n');
  chmodSync(workersFile, 0o444);
  writeFileSync(attachFile, '{"session":"ro-464"}\n');
  chmodSync(attachFile, 0o464);

  const roLogs = [];
  const rRo = tightenLedgers(home, { log: (l) => roLogs.push(l) });
  assert.deepEqual(rRo.tightened, [workersFile, attachFile]);
  assert.equal(rRo.warnings.length, 0);
  assert.equal(lstatSync(workersFile).mode & 0o777, 0o400, "0444 tightened to 0400, not widened to 0600");
  assert.equal(lstatSync(attachFile).mode & 0o777, 0o400, "0464 tightened to 0400, not widened to 0600");
  assert.deepEqual(roLogs, [`tightened Herdr ledger(s) to 0400: ${workersFile}, ${attachFile}`]);

  // Mixed target modes (0644 -> 0600 and 0444 -> 0400) log without a single-mode claim.
  chmodSync(workersFile, 0o644);
  chmodSync(attachFile, 0o444);
  const mixedLogs = [];
  const rMixed = tightenLedgers(home, { log: (l) => mixedLogs.push(l) });
  assert.deepEqual(rMixed.tightened, [workersFile, attachFile]);
  assert.deepEqual(mixedLogs, [`tightened Herdr ledger(s): ${workersFile}, ${attachFile}`]);
  chmodSync(workersFile, 0o600);
  chmodSync(attachFile, 0o600);

  // (b2) Owner-unreadable ledger (0070): skipped untouched (remains 0070, not 0000). The warning
  // naming chmod 600 is returned and not logged (#883): the doctor reports such a ledger.
  chmodSync(attachFile, 0o070);
  try {
    const unreadLogs = [];
    const rUnread = tightenLedgers(home, { log: (l) => unreadLogs.push(l) });
    assert.deepEqual(rUnread.tightened, []);
    assert.equal(lstatSync(attachFile).mode & 0o777, 0o070, "0070 ledger stays 0070 untouched");
    assert.equal(rUnread.warnings.length, 1);
    assert.match(rUnread.warnings[0], /attach\.jsonl is not readable by its owner \(mode 0070\): left as it is; run chmod 600 /);
    assert.ok(rUnread.warnings[0].includes(attachFile));
    assert.deepEqual(unreadLogs, [], "install and update do not repeat it on every run");
  } finally {
    chmodSync(attachFile, 0o600);
  }

  // (c) M1 + M2: a FIFO ledger never blocks, and 2,000 repeated rows deduplicate before git resolution.
  const projDir = join(home, "proj-dedup");
  mkdirSync(projDir, { recursive: true });
  const row = `${JSON.stringify({ event: "start", worktree: projDir, project: projDir })}\n`;
  writeFileSync(workersFile, row.repeat(2000));
  chmodSync(workersFile, 0o644);
  unlinkSync(attachFile);
  assert.equal(spawnSync("mkfifo", [attachFile]).status, 0);
  let gitCalls = 0;
  const rFifo = tightenLedgers(home, {
    git: () => { gitCalls += 1; return ""; },
  });
  assert.deepEqual(rFifo.tightened, [workersFile]);
  assert.equal(rFifo.warnings.length, 1);
  assert.match(rFifo.warnings[0], /attach\.jsonl is not a regular file: left as it is/);
  assert.ok(gitCalls <= 2, `expected distinct folders resolved at most once, got ${gitCalls} git calls`);
});


test("#883: tightenLedgers skips an owner-unreadable ledger for every user, names the real reason an open fails, and refuses another regular file swapped in", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ledgers-883-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "automagik-herdr"), { recursive: true });
  const workersFile = join(home, "automagik-herdr", "workers.jsonl");
  const attachFile = join(home, "automagik-herdr", "attach.jsonl");
  writeFileSync(workersFile, '{"session":"w"}\n');
  chmodSync(workersFile, 0o600);
  const modeOf = (file) => lstatSync(file).mode & 0o777;
  /** openSync as root's would be: it succeeds whatever the mode, and the mode is as it was after. */
  const openAsRoot = (file, flags) => {
    const mode = modeOf(file);
    chmodSync(file, 0o600);
    try { return openSync(file, flags); } finally { chmodSync(file, mode); }
  };
  const fchmods = [];
  const fchmod = (fd, mode) => { fchmods.push(mode); fchmodSync(fd, mode); };

  // (1a) A 0070 ledger whose open succeeds (root, where no EACCES stops it): the owner-read
  // check alone keeps it from becoming 0000. Without root the open's EACCES hid that check.
  writeFileSync(attachFile, '{"session":"a"}\n');
  chmodSync(attachFile, 0o070);
  const logs = [];
  const asRoot = tightenLedgers(home, { open: openAsRoot, fchmod, log: (l) => logs.push(l) });
  assert.equal(modeOf(attachFile), 0o070, "0070 stays 0070, never 0000");
  assert.deepEqual(asRoot.tightened, []);
  assert.deepEqual(fchmods, []);
  assert.equal(asRoot.warnings.length, 1);
  assert.match(asRoot.warnings[0], /attach\.jsonl is not readable by its owner \(mode 0070\): left as it is; run chmod 600 /);
  assert.deepEqual(logs, [], "not logged: every install and update would repeat it; the doctor reports it");

  // (1b) The same when the mode loses its owner-read bit between the first look and the open:
  // the check on the opened descriptor stops it.
  chmodSync(attachFile, 0o644);
  let looked = false;
  const lateUnreadable = tightenLedgers(home, {
    stat: (p) => {
      const st = lstatSync(p);
      if (p === attachFile && !looked) { looked = true; chmodSync(attachFile, 0o070); }
      return st;
    },
    open: openAsRoot, fchmod, log: (l) => logs.push(l),
  });
  assert.equal(modeOf(attachFile), 0o070, "0070 stays 0070, never 0000");
  assert.deepEqual(lateUnreadable.tightened, []);
  assert.deepEqual(fchmods, []);
  assert.match(lateUnreadable.warnings[0], /attach\.jsonl is not readable by its owner \(mode 0070\)/);
  assert.deepEqual(logs, []);

  // (1c) An open that fails with EACCES or EPERM, for any user: skipped, and since the mode lets
  // the owner read it (0644), the warning names the open, not "not readable by its owner".
  for (const code of ["EACCES", "EPERM"]) {
    chmodSync(attachFile, 0o644);
    const refusedLogs = [];
    const refusedOpen = tightenLedgers(home, {
      open: (p, flags) => {
        if (p !== attachFile) return openSync(p, flags);
        throw Object.assign(new Error(`${code}: permission denied, open '${p}'`), { code });
      },
      fchmod, log: (l) => refusedLogs.push(l),
    });
    assert.equal(modeOf(attachFile), 0o644, "left as it is");
    assert.deepEqual(refusedOpen.tightened, []);
    assert.deepEqual(fchmods, []);
    assert.equal(refusedOpen.warnings.length, 1);
    assert.ok(refusedOpen.warnings[0].startsWith(`${attachFile} could not be opened (${code}) although its mode 0644 lets its owner read it`),
      refusedOpen.warnings[0]);
    assert.doesNotMatch(refusedOpen.warnings[0], /not readable by its owner/);
    assert.deepEqual(refusedLogs, [`warning: ${refusedOpen.warnings[0]}`], "this one is logged");
  }

  // (2) Another regular file renamed over the ledger between the first look and the open: the
  // device and inode re-check refuses it, and the file now there keeps its mode.
  chmodSync(attachFile, 0o644);
  const other = join(home, "other.jsonl");
  writeFileSync(other, '{"session":"other"}\n');
  chmodSync(other, 0o644);
  let swapped = false;
  const swappedIn = tightenLedgers(home, {
    stat: (p) => {
      const st = lstatSync(p);
      if (p === attachFile && !swapped) { swapped = true; renameSync(other, attachFile); }
      return st;
    },
    fchmod,
  });
  assert.equal(swapped, true);
  assert.equal(readFileSync(attachFile, "utf8"), '{"session":"other"}\n', "the other file is at the ledger's path");
  assert.equal(modeOf(attachFile), 0o644, "the file swapped in is not tightened");
  assert.deepEqual(swappedIn.tightened, []);
  assert.deepEqual(fchmods, []);
  assert.equal(swappedIn.warnings.length, 1);
  assert.match(swappedIn.warnings[0], /attach\.jsonl changed during inspection: left as it is/);

  // (5) The exec bits count as wider than 0600: 0700 becomes 0600 and 0500 becomes 0400.
  chmodSync(workersFile, 0o700);
  chmodSync(attachFile, 0o500);
  const exec = tightenLedgers(home, { fchmod });
  assert.deepEqual(exec.tightened, [workersFile, attachFile]);
  assert.deepEqual(exec.warnings, []);
  assert.equal(modeOf(workersFile), 0o600);
  assert.equal(modeOf(attachFile), 0o400);
  assert.deepEqual(fchmods, [0o600, 0o400]);
});

test("#805 restore notifies only the live project main bot once per version", async (t) => {
  const { notifyMainBotOfRestore } = await import("../mods/am-sidebar/update.mjs");
  assert.equal(typeof notifyMainBotOfRestore, "function");
  const dir = mkdtempSync(join(tmpdir(), "restore-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modsDir = join(dir, "app/mods"), projectDir = join(dir, "project");
  mkdirSync(join(projectDir, ".herdr"), { recursive: true });
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id: "b-main", kind: "main" }, { id: "b-other", kind: "member" }] }));
  const calls = [];
  let live = false;
  const hcRun = (args) => { calls.push(args); return JSON.stringify(args[0] === "ls" ? { terminals: live ? [{ address: "t5", state: "live" }] : [] } : {}); };
  const args = { modsDir, projectDir, version: "0.2.0", restored: "0.1.0", failed: ["am-tabs"], hcRun };
  assert.deepEqual(notifyMainBotOfRestore(args), { sent: false });
  live = true;
  assert.equal(notifyMainBotOfRestore(args).sent, true);
  assert.deepEqual(notifyMainBotOfRestore(args), { sent: false });
  const sends = calls.filter((c) => c[0] === "send");
  assert.deepEqual(sends, [["send", "t5", "Automagik Herdr update 0.2.0 failed to load (am-tabs) and rolled back to 0.1.0; no restart is needed for 0.2.0."]]);
  assert.deepEqual(calls.find((c) => c[0] === "ls"), ["ls", "--label", "bot=b-main", "--json"]);
  const note = join(stateDirOf(modsDir), "restore-notified.json");
  assert.equal((await import("node:fs")).statSync(note).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(note)).botId, "b-main");
  assert.deepEqual(notifyMainBotOfRestore({ ...args, version: "0.3.0", hcRun: () => { throw Error("missing hc"); } }), { sent: false });
});


test("#805 update restoration sends the main-bot notice and keeps its dedup record", async (t) => {
  const h = autoHome(["0.2.0"]);
  t.after(() => h.done());
  const app = fakeCheckFailThenKill(join(h.home, "notify-check"));
  const projectDir = join(h.home, "project");
  mkdirSync(join(projectDir, ".herdr"), { recursive: true });
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id: "b-main", kind: "main" }] }));
  const calls = [];
  const hcRun = (args) => { calls.push(args); return JSON.stringify(args[0] === "ls" ? { terminals: [{ address: "t5", state: "live" }] } : {}); };
  for (let n = 0; n < 2; n += 1) {
    const r = await installUpdate({ keys, fetch: fakeFetch(h.table), env: {}, modsDir: h.mods, herdrApp: app.bin, projectDir, hcRun });
    assert.equal(r.installed.restored.version, "0.1.0");
  }
  assert.equal(calls.filter((c) => c[0] === "send").length, 1);
  assert.equal(JSON.parse(readFileSync(join(stateDirOf(h.mods), "restore-notified.json"))).failedVersion, "0.2.0");
});

test("#805 restore falls back to a live binding and the last bound project", async (t) => {
  const { notifyMainBotOfRestore } = await import("../mods/am-sidebar/update.mjs");
  const { attachLine, attachRow } = await import("../mods/am-sidebar/attach.js");
  const root = mkdtempSync(join(tmpdir(), "restore-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modsDir = join(root, "app/mods"), state = stateDirOf(modsDir), projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".herdr"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id: "b-aaaaaaaaaa", kind: "main" }] }));
  writeFileSync(join(state, "attach.jsonl"), attachLine(attachRow({ event: "attach", bot: "b-aaaaaaaaaa", terminal: "t5", created_ms: 10, core: "fake", project: projectDir, by: "start" })));
  const calls = [];
  let live = false;
  const hcRun = (args) => { calls.push(args); return JSON.stringify(args[0] === "ls" ? { terminals: [] } : { state: live ? "live" : "finished", created_ms: 10 }); };
  const args = { modsDir, version: "0.2.0", restored: "0.1.0", failed: ["am-tabs"], hcRun };
  assert.deepEqual(notifyMainBotOfRestore({ ...args, projectDir }), { sent: false });
  live = true;
  const previous = process.cwd();
  try {
    process.chdir(root);
    assert.equal(notifyMainBotOfRestore(args).sent, true);
  } finally { process.chdir(previous); }
  assert.deepEqual(calls.filter((c) => c[0] === "send").map((c) => c[1]), ["t5"]);
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [] }));
  assert.deepEqual(notifyMainBotOfRestore({ ...args, version: "0.3.0", projectDir }), { sent: false });
});

test("#805 a blocked main bot is recorded pending and notified on the next call", async (t) => {
  const { notifyMainBotOfRestore } = await import("../mods/am-sidebar/update.mjs");
  const dir = mkdtempSync(join(tmpdir(), "restore-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modsDir = join(dir, "app/mods"), projectDir = join(dir, "project");
  mkdirSync(join(projectDir, ".herdr"), { recursive: true });
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id: "b-main", kind: "main" }] }));
  const calls = [];
  let blocked = true;
  const hcRun = (args) => {
    calls.push(args);
    if (args[0] === "ls") return JSON.stringify({ terminals: [{ address: "t5", state: "live" }] });
    if (args[0] === "send" && blocked) { const error = new Error("hc send failed"); error.status = 9; throw error; }
    return "{}";
  };
  const args = { modsDir, projectDir, version: "0.2.0", restored: "0.1.0", failed: ["am-tabs"], hcRun };
  assert.deepEqual(notifyMainBotOfRestore(args), { sent: false });
  const note = () => JSON.parse(readFileSync(join(stateDirOf(modsDir), "restore-notified.json"), "utf8"));
  assert.deepEqual(note().pendingBots, ["b-main"]);
  assert.deepEqual(note().notifiedBots, []);
  blocked = false;
  assert.deepEqual(notifyMainBotOfRestore(args), { sent: true });
  assert.deepEqual(note().notifiedBots, ["b-main"]);
  assert.deepEqual(note().pendingBots, []);
  assert.equal(calls.filter((c) => c[0] === "send").length, 2);
  assert.deepEqual(notifyMainBotOfRestore(args), { sent: false });
});

test("#805 restore notifies every project main bot and prefers its own live binding", async (t) => {
  const { notifyMainBotOfRestore } = await import("../mods/am-sidebar/update.mjs");
  const { attachLine, attachRow } = await import("../mods/am-sidebar/attach.js");
  const root = mkdtempSync(join(tmpdir(), "restore-projects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modsDir = join(root, "app/mods"), state = stateDirOf(modsDir);
  const p1 = join(root, "one"), p2 = join(root, "two");
  for (const [dir, id] of [[p1, "b-aaaaaaaaaa"], [p2, "b-cccccccccc"]]) {
    mkdirSync(join(dir, ".herdr"), { recursive: true });
    writeFileSync(join(dir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id, kind: "main" }] }));
  }
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "attach.jsonl"), attachLine(attachRow({ event: "attach", bot: "b-aaaaaaaaaa", terminal: "t5", created_ms: 10, core: "fake", project: p1, by: "start" })));
  writeFileSync(join(dirname(modsDir), "am-sidebar-projects.json"), JSON.stringify({ projects: [{ path: p1 }, p2] }));
  const calls = [];
  const hcRun = (args) => {
    calls.push(args);
    if (args[0] === "get") return JSON.stringify({ state: "live", created_ms: 10 });
    if (args[0] === "ls") {
      const label = args[args.indexOf("--label") + 1];
      if (label === "bot=b-aaaaaaaaaa") return JSON.stringify({ terminals: [{ address: "t9", state: "live", cwd: "/elsewhere" }] });
      return JSON.stringify({ terminals: [{ address: "t8", state: "live", cwd: "/elsewhere" }, { address: "t6", state: "live", cwd: p2 }] });
    }
    return "{}";
  };
  assert.equal(notifyMainBotOfRestore({ modsDir, projectDir: p1, version: "0.2.0", restored: "0.1.0", failed: ["am-tabs"], hcRun }).sent, true);
  assert.deepEqual(calls.filter((c) => c[0] === "send").map((c) => c[1]), ["t5", "t6"]);
  assert.equal(calls.some((c) => c[0] === "ls" && c.includes("bot=b-aaaaaaaaaa")), false, "the project's live binding came first");
  const note = JSON.parse(readFileSync(join(state, "restore-notified.json"), "utf8"));
  assert.deepEqual(note.notifiedBots, ["b-aaaaaaaaaa", "b-cccccccccc"]);
  assert.deepEqual(note.pendingBots, []);
});

test("#805 checkForUpdate retries a pending rollback notice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "restore-tick-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modsDir = join(dir, "app/mods"), state = stateDirOf(modsDir), projectDir = join(dir, "project");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(projectDir, ".herdr"), { recursive: true });
  writeFileSync(join(projectDir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id: "b-main", kind: "main" }] }));
  writeFileSync(join(state, RESTORE_FILE), JSON.stringify({ version: "0.1.0", failedVersion: "0.2.0", failed: ["am-tabs"], mod: "am-tabs" }));
  writeFileSync(join(state, "restore-notified.json"), JSON.stringify({ failedVersion: "0.2.0", restoredVersion: "0.1.0", notifiedBots: [], pendingBots: ["b-main"] }));
  const calls = [];
  const hcRun = (args) => {
    calls.push(args);
    return JSON.stringify(args[0] === "ls" ? { terminals: [{ address: "t5", state: "live", cwd: projectDir }] } : {});
  };
  const r = await checkForUpdate({ modsDir, projectDir, env: {}, fetch: async () => ({ status: 404, ok: false }), hcRun });
  assert.equal(r.disabled, false);
  assert.equal(calls.filter((c) => c[0] === "send").length, 1);
  assert.match(calls.find((c) => c[0] === "send")[2], /0\.2\.0/);
  const note = JSON.parse(readFileSync(join(state, "restore-notified.json"), "utf8"));
  assert.deepEqual(note.notifiedBots, ["b-main"]);
  assert.deepEqual(note.pendingBots, []);
});

test("#805 a blocked main pane is kept pending and never receives the notice", async (t) => {
  const { notifyMainBotOfRestore } = await import("../mods/am-sidebar/update.mjs");
  const { attachLine, attachRow } = await import("../mods/am-sidebar/attach.js");
  const root = mkdtempSync(join(tmpdir(), "restore-blocked-pane-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modsDir = join(root, "app/mods"), state = stateDirOf(modsDir);
  const p1 = join(root, "one"), p2 = join(root, "two");
  for (const [dir, id] of [[p1, "b-aaaaaaaaaa"], [p2, "b-cccccccccc"]]) {
    mkdirSync(join(dir, ".herdr"), { recursive: true });
    writeFileSync(join(dir, ".herdr/bots.json"), JSON.stringify({ bots: [{ id, kind: "main" }] }));
  }
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "attach.jsonl"), attachLine(attachRow({ event: "attach", bot: "b-cccccccccc", terminal: "t6", created_ms: 20, core: "fake", project: p2, by: "start" })));
  const calls = [];
  const hcRun = (args) => {
    calls.push(args);
    if (args[0] === "get") return JSON.stringify({ state: "live", created_ms: 20, status: { state: "blocked" } });
    if (args[0] === "ls") {
      const label = args[args.indexOf("--label") + 1];
      return JSON.stringify({ terminals: label === "bot=b-aaaaaaaaaa" ? [{ address: "t5", state: "live", cwd: p1, status: "blocked" }] : [] });
    }
    throw new Error("send must not run on a blocked pane");
  };
  assert.deepEqual(notifyMainBotOfRestore({ modsDir, projectDir: p1, version: "0.2.0", restored: "0.1.0", failed: ["am-tabs"], hcRun }), { sent: false });
  let note = JSON.parse(readFileSync(join(state, "restore-notified.json"), "utf8"));
  assert.deepEqual(note.pendingBots, ["b-aaaaaaaaaa", "b-cccccccccc"]);
  assert.deepEqual(note.notifiedBots, []);
  assert.deepEqual(notifyMainBotOfRestore({ modsDir, projectDir: p2, version: "0.3.0", restored: "0.1.0", failed: ["am-tabs"], hcRun }), { sent: false });
  note = JSON.parse(readFileSync(join(state, "restore-notified.json"), "utf8"));
  assert.deepEqual(note.pendingBots, ["b-cccccccccc"]);
  assert.deepEqual(note.notifiedBots, []);
  assert.equal(calls.filter((c) => c[0] === "send").length, 0);
});
