#!/usr/bin/env node
// Every mod the pack ships must load in the real Herdr app, not just pass the pack's tests. A pack
// mod that imported node:url passed every test once and failed only in the app (#624); the
// import-graph test now catches that form statically (#652), and this is the app's own loader as
// the last gate before a release ships. The Linux build is pinned to ONE version and ONE sha256
// (the numbers https://releases.herdr.dev/app/latest.json published for 0.1.13 when the pin was
// made): no "latest" tag, no secrets. A bump changes VERSION and SHA256 together.
//
//   node .github/scripts/herdr-app-check.mjs [--pack <file.tgz>] [--strict] [--keep-app]
//
// `--keep-app` (CI's herdr pack job): after a verified pass (sha256 matched, `--version` was
// `herdr-app 0.1.13`, every PACK_MODS mod loaded), the pinned executable stays in this run's own temp
// folder (`<tmp>/app/herdr-app/herdr-app`; everything else there is removed) and its absolute path is
// printed and written to `$GITHUB_OUTPUT` as `outcome=verified` and `bin=<path>`, for the Tests step's
// standalone check. A could-not-verify warning writes `outcome=unverified` and keeps nothing. A failure
// writes nothing and keeps nothing. Only the folder this run made with mkdtemp is ever removed.
//
// Two outcomes, kept apart (#682). "Verified bad" is herdr-app running and a pack mod failing to
// load: it always fails, in both modes, with herdr-app's own output. "Could not verify" is the
// pinned build not being downloaded, unpacked or started (including a runner that cannot run it):
// PR CI prints a ::warning:: naming the URL or cause and exits 0, while the release cut passes
// --strict and fails. A sha256 mismatch is never could-not-verify: it means the pin changed, so it
// always fails loudly, in both modes.
//
// Without --pack it builds the pack from HEAD with herdr/scripts/pack.mjs, the way release.yml
// packs the tag, and checks the archive's mod folders, not the source tree. `herdr-app check`
// loads the mod in-process: it needs the app's shared libraries (libxkbcommon-x11-0, which brings
// libxcb-xkb1) but no X server, so no xvfb. Every result and the step's wall time are printed;
// the run fails (exit 1, with herdr-app's own output for the mod) when a mod does not load. It
// never skips. Apache-2.0.
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
// The one pinned build: herdr-app 0.1.13, linux-x86_64, as the release feed published it.
const VERSION = "0.1.13";
const SHA256 = "77b0be72a46ca14bb367365a04164641f914b3a69712bac391d39c56a959bef4";
const BUILD = `https://releases.herdr.dev/app/${VERSION}/herdr-app-linux-x86_64.tar.gz`;
const BUDGET_MS = 2 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 1000;

/** A pinned build that could not be fetched, unpacked or started: warns unless --strict. */
class CouldNotVerify extends Error {}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fail = (message) => { throw new Error(message); };
const unverified = (message) => { throw new CouldNotVerify(message); };
const output = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();

/** `{ pack, strict, keepApp }` from argv, or the usage. */
function parseArgs(argv) {
  const opts = { pack: null, strict: false, keepApp: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pack" && argv[i + 1]) opts.pack = resolve(argv[++i]);
    else if (argv[i] === "--strict") opts.strict = true;
    else if (argv[i] === "--keep-app") opts.keepApp = true;
    else throw new Error("usage: node .github/scripts/herdr-app-check.mjs [--pack <file.tgz>] [--strict] [--keep-app]");
  }
  return opts;
}

/** The pack tarball from HEAD, exactly as release.yml builds it from the tag. */
function buildPack(file, out) {
  const script = join(REPO, "herdr", "scripts", "pack.mjs");
  if (!existsSync(script)) fail(`there is no pack builder at ${script}`);
  const r = spawnSync(process.execPath, [script, "--repo", REPO, "--ref", "HEAD", "--out", file],
    { encoding: "utf8", timeout: 120_000 });
  if (r.error || r.status !== 0) {
    fail(`the pack could not be built from HEAD (${r.error?.message ?? `exit ${r.status}`}):\n${output(r)}`);
  }
  out(`${r.stdout}`);
}

/** Extracts the pack and returns its folder, holding it to the PACK_MODS it claims to ship. */
function unpack(pack, dir, packMods) {
  const r = spawnSync("tar", ["-xzf", pack, "-C", dir], { encoding: "utf8", timeout: 120_000 });
  if (r.error || r.status !== 0) {
    fail(`the pack tarball could not be extracted (${r.error?.message ?? `exit ${r.status}`}):\n${output(r)}`);
  }
  const top = readdirSync(dir).sort();
  const extra = top.filter((name) => name !== "layouts" && !packMods.includes(name));
  if (extra.length) fail(`the pack's top level has entries that are not PACK_MODS: ${extra.join(" ")}`);
  for (const mod of packMods) {
    if (!existsSync(join(dir, mod, "mod.json"))) fail(`the built pack has no ${mod}/mod.json`);
  }
  return dir;
}

/** Downloads the pinned Linux build, checks the pinned sha256, and returns its executable. */
async function installApp(tmp, { buildUrl, fetchImpl, sha256 }) {
  const tarball = join(tmp, "herdr-app.tar.gz");
  let bytes;
  try {
    const response = await fetchImpl(buildUrl, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) unverified(`herdr-app ${VERSION} could not be downloaded from ${buildUrl}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (e) {
    if (e instanceof CouldNotVerify) throw e;
    unverified(`herdr-app ${VERSION} could not be downloaded from ${buildUrl}: ${e.message}`);
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) {
    fail(`herdr-app ${VERSION} does not match its pinned sha256: got ${got}, pinned ${sha256} (${buildUrl})`);
  }
  writeFileSync(tarball, bytes);
  const appDir = join(tmp, "app");
  mkdirSync(appDir);
  const r = spawnSync("tar", ["-xzf", tarball, "-C", appDir], { encoding: "utf8", timeout: 120_000 });
  if (r.error || r.status !== 0) {
    unverified(`herdr-app ${VERSION} could not be unpacked (${r.error?.message ?? `exit ${r.status}`}):\n${output(r)}`);
  }
  const bin = join(appDir, "herdr-app", "herdr-app");
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    unverified(`herdr-app ${VERSION}'s tarball has no executable herdr-app/herdr-app`);
  }
  return bin;
}

/** Runs the pinned app once so an unrunnable binary fails before any mod is judged. */
function checkAppRuns(bin, env) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, env });
  if (r.error || r.status !== 0) {
    unverified(`herdr-app could not start (${r.error?.message ?? `exit ${r.status}`}):\n${output(r)}`);
  }
  const line = String(r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (line !== `herdr-app ${VERSION}`) fail(`herdr-app --version said "${line}", not "herdr-app ${VERSION}"`);
  return line;
}

/** `herdr-app check <mod>`: loads it once; returns null on success, else herdr-app's output. */
function checkMod(bin, dir, env) {
  const r = spawnSync(bin, ["check", dir], { encoding: "utf8", timeout: CHECK_TIMEOUT_MS, env, maxBuffer: 16 << 20 });
  const passed = !r.error && r.status === 0 && /(^|\n)check passed:/.test(String(r.stdout ?? ""));
  if (passed) return null;
  const reason = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  return `herdr-app check could not load this mod (${reason}):\n${output(r)}`;
}

/**
 * The whole check. Returns the step's exit code: 0 on success, and 0 for a could-not-verify
 * warning when --strict is absent. `deps` lets the rows swap fetch, the pin, `GITHUB_OUTPUT` and
 * the temp parent. The CLI fills none of it.
 */
export async function run(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const buildUrl = deps.buildUrl ?? BUILD;
  const sha256 = deps.sha256 ?? SHA256;
  const githubOutput = deps.githubOutput ?? process.env.GITHUB_OUTPUT;
  let opts = { pack: null, strict: false, keepApp: false };
  let tmp = null;
  let kept = false;
  const report = (lines) => { if (opts.keepApp && githubOutput) appendFileSync(githubOutput, lines); };
  try {
    opts = parseArgs(argv);
    const started = Date.now();
    if (process.platform !== "linux" || process.arch !== "x64") {
      unverified(`the pinned herdr-app build is linux-x86_64; this runner is ${process.platform}-${process.arch}`);
    }
    const { PACK_MODS } = await import(pathToFileURL(join(REPO, "herdr", "mods", "am-sidebar", "release.js")).href);
    if (!Array.isArray(PACK_MODS) || PACK_MODS.length === 0) fail("PACK_MODS is empty: there is no pack to check");

    tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "herdr-app-check-"));
    const pack = opts.pack ?? join(tmp, "automagik-herdr-pack.tgz");
    if (opts.pack) {
      if (!existsSync(pack)) fail(`there is no pack at ${pack}`);
      out(`pack: ${pack}\n`);
    } else {
      buildPack(pack, out);
    }
    const packDir = unpack(pack, mkdtempSync(join(tmp, "pack-")), PACK_MODS);

    const bin = await installApp(tmp, { buildUrl, fetchImpl, sha256 });
    out(`herdr-app ${VERSION}: sha256 ${sha256} verified\n`);
    const home = join(tmp, "home");
    mkdirSync(home);
    const env = { ...process.env, HERDR_APP_HOME: home };
    out(`${checkAppRuns(bin, env)}\n`);

    const checksStarted = Date.now();
    for (const mod of PACK_MODS) {
      const modStarted = Date.now();
      const problem = checkMod(bin, join(packDir, mod), env);
      const took = secs(Date.now() - modStarted);
      if (problem) {
        err(`herdr-app check ${mod}: FAILED (${took})\n${problem}\n`);
        fail(`herdr-app could not load ${mod}`);
      }
      out(`herdr-app check ${mod}: passed (${took})\n`);
    }
    const total = Date.now() - started;
    out(`herdr-app check: ${PACK_MODS.length} pack mods loaded in ${secs(Date.now() - checksStarted)};`
      + ` step wall time ${secs(total)} (budget under 2 minutes)\n`);
    if (total > BUDGET_MS) out(`::warning::the herdr-app check took ${secs(total)}, over its 2-minute budget\n`);
    const kept_bin = resolve(bin);
    report(`outcome=verified\nbin=${kept_bin}\n`);
    if (opts.keepApp) {
      kept = true;
      out(`herdr-app kept for the tests: ${kept_bin}\n`);
    }
    return 0;
  } catch (e) {
    if (e instanceof CouldNotVerify && !opts.strict) {
      out(`::warning::${e.message}\n`);
      try { report("outcome=unverified\n"); } catch {}
      return 0;
    }
    err(`herdr-app check: ${e.message}\n`);
    err("::error::herdr-app check failed\n");
    return 1;
  } finally {
    if (tmp && kept) {
      for (const name of readdirSync(tmp)) {
        if (name !== "app") rmSync(join(tmp, name), { recursive: true, force: true });
      }
    } else if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  run().then((code) => { process.exitCode = code; });
}
