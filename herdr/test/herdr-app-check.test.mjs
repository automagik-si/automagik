// #682: .github/scripts/herdr-app-check.mjs keeps "verified bad" (herdr-app ran and a pack mod
// failed to load: always fail, with the app's own output) apart from "could not verify" (the
// pinned build could not be downloaded or started: warn in PR CI, fail with --strict). A sha256
// mismatch stays loud in both modes. The app and the pack here are fakes built in a temp folder:
// no network, no herdr-app, no release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "../../.github/scripts/herdr-app-check.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { PACK_MODS } = await import(pathToFileURL(join(REPO, "herdr", "mods", "am-sidebar", "release.js")).href);
const BUILD = "https://releases.herdr.dev/app/0.1.13/herdr-app-linux-x86_64.tar.gz";
const skip = process.platform !== "linux" || process.arch !== "x64"
  ? "the pinned herdr-app build is linux-x86_64" : false;
const symlinkSkip = process.platform === "win32" ? "a directory symlink needs extra privilege on Windows" : false;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-app-check-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tarball(dir, name, top, entries) {
  const file = join(dir, `${name}.tgz`);
  const r = spawnSync("tar", ["-czf", file, "-C", top, ...entries], { encoding: "utf8" });
  assert.equal(r.status, 0, `tar could not make ${name}: ${r.stderr}`);
  return file;
}

/** The pack's shape: every PACK_MODS folder with the mod.json the check asks for. */
function packTarball(dir) {
  const top = join(dir, "pack");
  for (const mod of PACK_MODS) {
    mkdirSync(join(top, mod), { recursive: true });
    writeFileSync(join(top, mod, "mod.json"), "{}\n");
  }
  return tarball(dir, "pack", top, PACK_MODS);
}

/** A fake herdr-app: it answers --version and check like the pinned one, except when told to fail. */
function appTarball(dir, { failMod = null, exitsOnVersion = 0, versionLine = "herdr-app 0.1.13" } = {}) {
  const top = join(dir, "app");
  mkdirSync(join(top, "herdr-app"), { recursive: true });
  const lines = ["#!/bin/sh", 'if [ "$1" = "--version" ]; then', `  echo "${versionLine}"`, `  exit ${exitsOnVersion}`, "fi",
    'if [ "$1" = "check" ]; then'];
  if (failMod) {
    lines.push('  case "$2" in', `    */${failMod}) echo "cannot resolve module node:url" >&2; exit 9 ;;`, "  esac");
  }
  lines.push('  echo "check passed: $2"', "  exit 0", "fi", "exit 64");
  const bin = join(top, "herdr-app", "herdr-app");
  writeFileSync(bin, `${lines.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return tarball(dir, "app", top, ["herdr-app"]);
}

const sha256Of = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The pinned URL served from a local tarball; nothing leaves the machine. */
const serve = (file) => async () => {
  const bytes = readFileSync(file);
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer };
};

async function invoke(args, deps) {
  const out = [];
  const err = [];
  const code = await run(args, { ...deps, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

test("a pack mod that fails to load is verified bad and fails in both modes", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const app = appTarball(dir, { failMod: "am-footer" });
  const deps = { fetchImpl: serve(app), sha256: sha256Of(app), buildUrl: BUILD };
  for (const strict of [false, true]) {
    const label = strict ? "--strict" : "default";
    const r = await invoke(["--pack", pack, ...(strict ? ["--strict"] : [])], deps);
    assert.equal(r.code, 1, `${label}: a mod that does not load fails the step`);
    assert.match(`${r.out}${r.err}`, /herdr-app check am-footer: FAILED/);
    assert.match(`${r.out}${r.err}`, /cannot resolve module node:url/, `${label}: herdr-app's own output is shown`);
  }
});

test("a download failure warns and exits 0 by default, and fails with --strict", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const deps = {
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND releases.herdr.dev"); },
    sha256: "0".repeat(64),
    buildUrl: BUILD,
  };
  const relaxed = await invoke(["--pack", pack], deps);
  assert.equal(relaxed.code, 0, "PR CI does not block on an unreachable release feed");
  assert.match(relaxed.out, /::warning::/);
  assert.match(relaxed.out, /https:\/\/releases\.herdr\.dev\/app\/0\.1\.13\/herdr-app-linux-x86_64\.tar\.gz/);
  assert.match(relaxed.out, /ENOTFOUND/, "the warning names the cause");
  const strict = await invoke(["--pack", pack, "--strict"], deps);
  assert.equal(strict.code, 1, "the release cut still fails");
  assert.match(strict.err, /could not be downloaded from/);
  assert.match(strict.err, /::error::herdr-app check failed/);
});

test("a download body that aborts mid-read is could-not-verify", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const deps = {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => { throw new Error("terminated: other side closed"); },
    }),
    sha256: "0".repeat(64),
    buildUrl: BUILD,
  };
  const relaxed = await invoke(["--pack", pack], deps);
  assert.equal(relaxed.code, 0, "a body cut mid-read is still a failed download, not verified bad");
  assert.match(relaxed.out, /::warning::/);
  assert.match(relaxed.out, /could not be downloaded from/);
  assert.match(relaxed.out, /terminated: other side closed/, "the warning names the cause");
  const strict = await invoke(["--pack", pack, "--strict"], deps);
  assert.equal(strict.code, 1, "the release cut still fails");
  assert.match(strict.err, /terminated: other side closed/);
});

test("a sha256 mismatch fails loudly in both modes", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const app = appTarball(dir);
  const deps = { fetchImpl: serve(app), sha256: "0".repeat(64), buildUrl: BUILD };
  for (const strict of [false, true]) {
    const label = strict ? "--strict" : "default";
    const r = await invoke(["--pack", pack, ...(strict ? ["--strict"] : [])], deps);
    assert.equal(r.code, 1, `${label}: a changed pin is a failure`);
    assert.match(r.err, /does not match its pinned sha256/);
    assert.doesNotMatch(r.out, /::warning::/, `${label}: a sha256 mismatch is never could-not-verify`);
  }
});

test("an app that cannot start warns by default and fails with --strict", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const app = appTarball(dir, { exitsOnVersion: 7 });
  const deps = { fetchImpl: serve(app), sha256: sha256Of(app), buildUrl: BUILD };
  const relaxed = await invoke(["--pack", pack], deps);
  assert.equal(relaxed.code, 0);
  assert.match(relaxed.out, /::warning::/);
  assert.match(relaxed.out, /could not start/);
  assert.match(relaxed.out, /exit 7/, "the warning names the cause");
  const strict = await invoke(["--pack", pack, "--strict"], deps);
  assert.equal(strict.code, 1);
  assert.match(strict.err, /could not start/);
});

test("a --version text mismatch is hard in both modes", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const app = appTarball(dir, { versionLine: "herdr-app 0.1.12" });
  const deps = { fetchImpl: serve(app), sha256: sha256Of(app), buildUrl: BUILD };
  for (const strict of [false, true]) {
    const label = strict ? "--strict" : "default";
    const r = await invoke(["--pack", pack, ...(strict ? ["--strict"] : [])], deps);
    assert.equal(r.code, 1, `${label}: a different version string is a failure`);
    assert.match(r.err, /herdr-app --version said "herdr-app 0\.1\.12"/);
    assert.doesNotMatch(r.out, /::warning::/, `${label}: a version mismatch is never could-not-verify`);
  }
});

test("a clean pack passes with no warning", { skip }, async (t) => {
  const dir = scratch(t);
  const pack = packTarball(dir);
  const app = appTarball(dir);
  const deps = { fetchImpl: serve(app), sha256: sha256Of(app), buildUrl: BUILD };
  const r = await invoke(["--pack", pack], deps);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`herdr-app check: ${PACK_MODS.length} pack mods loaded`));
  assert.match(r.out, /sha256 [0-9a-f]{64} verified/);
  assert.doesNotMatch(`${r.out}${r.err}`, /::warning::/);
});

test("a symlinked invocation still runs the entry guard", { skip: symlinkSkip }, (t) => {
  const dir = scratch(t);
  symlinkSync(join(REPO, ".github"), join(dir, ".github"), "dir");
  const linked = join(dir, ".github", "scripts", "herdr-app-check.mjs");
  const r = spawnSync(process.execPath, [linked, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1, `the guard must run the check through a symlink, not exit 0: ${r.stderr}`);
  assert.match(r.stderr, /usage: node \.github\/scripts\/herdr-app-check\.mjs/);
});

test("the release cut runs the check with --strict; PR CI keeps the default", () => {
  const step = (workflow, name) => {
    const text = readFileSync(join(REPO, ".github", "workflows", workflow), "utf8");
    const start = text.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `${workflow} has the ${name} step`);
    const end = text.indexOf("\n\n", start);
    return text.slice(start, end === -1 ? undefined : end);
  };
  // The command is the cut's gates script's (#668), so a re-cut on a moved dev runs it again.
  assert.match(step("release.yml", "Every pack mod loads in herdr-app"),
    /run: bash scripts\/release-gates\.sh herdr-app/);
  const gates = readFileSync(join(REPO, "scripts", "release-gates.sh"), "utf8");
  // The dispatch calls the gate function, and the function holds the command: a case label run as
  // a command (#1653) fails the dispatch test in scripts/release-cut.test.ts.
  assert.match(gates, /\n  herdr-app\) gate_herdr_app ;;/);
  assert.match(gates, /\n    gate_herdr_app\n/);
  const fn = gates.slice(gates.indexOf("\ngate_herdr_app() {"), gates.indexOf("\ngate_herdr_key() {"));
  assert.match(fn, /node \.github\/scripts\/herdr-app-check\.mjs --strict/);
  assert.match(step("ci.yml", "Every pack mod loads in herdr-app"),
    /^        run: node \.github\/scripts\/herdr-app-check\.mjs$/m);
});
