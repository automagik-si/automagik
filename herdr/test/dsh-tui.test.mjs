// dsh-TUI as a Herdr agent (#561): the pin and its integrity, the package's own `dsh-tui` profile,
// the `dsh-tui` shim's launcher rule (no literal `--`), the onboarding pre-write, the opt-in
// doctor, uninstall, and the release-age exception. A fake `dsh` in a temp PATH and a temp HOME
// that boots the way DSH 0.2.2 does: the real DSH, Herdr and ~/.dsh are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { workerArgs } from "../mods/am-sidebar/workers.js";
import {
  DSH_TUI, PIN, PROFILE, RECORD_FILE, SHIM, SHIM_MARK, SHIM_TEXT, SKIP, desktopFingerprint, doctorDshTui, findDsh, installDshTui, installSandboxRow, lockIntegrity,
  ownershipOf, packRootOf, packWrapperOf, packageOfEntry, panePathOf, profileState, releaseAgeEntries, sandboxRootOf, sandboxState, sandboxWrapperOf, scopeReleaseAge, STABLE_FILES,
  shimIsOurs, uninstallDshTui, MAX_SYMLINK_DEPTH, realOrAbs, stableRootProblem,
  approvedDataRootProblem,
} from "../mods/am-sidebar/dshTui.mjs";
import { approveProject } from "../mods/am-sidebar/approved.js";
import { scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
/** The pinned release's publish time: an hour before this run, so the fresh path never depends on the wall clock. */
const PUBLISHED = new Date(Date.now() - 3600e3).toISOString();
const rootsOf = (s) => [["the app home", join(s.home, ".config", "herdr-app")], ["the temp folder", join(s.root, "pane-tmp")]];
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

/**
 * A scratch home with a fake `dsh`: it records every argv; on `plugin --profile dsh-tui add` it
 * initializes the profile the way real DSH 0.2.2 does (no shipped template for this name: the
 * base bundle only) and adds dsh-TUI, so the profile is the one dsh-TUI itself creates; without
 * `plugin`, it boots like the launcher and parses the app argv like dsh-TUI's resume grammar.
 * `cfg.add.integrity`, `.pin`, `.installed`, `.workspace` and `.fail` change what it writes.
 */
function scene(t, { dsh = true, config = {} } = {}) {
  const root = scratchRoot(t, "dsh-tui-");
  const home = join(root, "home"), bin = join(root, "bin"), log = join(root, "dsh.log");
  const paneTmp = join(root, "pane-tmp");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(paneTmp);
  writeFileSync(log, "");
  // The desktop profile, its settings and DSH's credentials: sentinels that must never change.
  mkdirSync(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
  writeFileSync(join(home, ".dsh", "profiles", "desktop", "package.json"), "{\"name\":\"dsh-profile-desktop\"}\n");
  writeFileSync(join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml"), "[]\n");
  writeFileSync(join(home, ".dsh", ".credentials.yaml"), "keep: me\n");
  // The login shell a Herdr pane starts in: its login PATH is the scene's, set outright and never
  // appended to the machine's login PATH, so the fake dsh is the only one a test can reach.
  const localBin = join(home, ".local", "bin"), scenePath = `${bin}:${localBin}:/usr/bin:/bin`;
  writeFileSync(join(home, ".profile"), `export PATH="${scenePath}"\n`);
  const cfgPath = join(root, "dsh.json");
  writeFileSync(cfgPath, JSON.stringify(config));
  const helper = join(root, "fake-dsh.cjs");
  writeFileSync(helper, `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), cfg = JSON.parse(fs.readFileSync(process.env.DSH_FAKE, "utf8"));
const dshHome = process.env.DSH_HOME || path.join(process.env.HOME, ".dsh");
const TUI = "@deepseek-harness-tui/dsh-tui", BASE = "@deepseek-ai/dsh-base", WEB = "@deepseek-ai/dsh-web-app";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Boot, the launcher rule: dsh [--profile] <name> [own flags] [app args]. The first token it does
// not recognize starts the app's argv; DSH 0.2.2 drops a bare \`--\` that follows only launcher
// options (Commander), so the shim sends no \`--\` at all. A web-template profile rejects
// --resume/-c/-p; the dsh-tui profile parses them.
if (args[0] !== "plugin") {
  const named = args[0] === "--profile";
  const profile = named ? args[1] : args[0], raw = args.slice(named ? 2 : 1);
  const app = [];
  let unknown = false;
  for (const arg of raw) {
    if (!unknown && arg === "--") continue;
    unknown = true;
    app.push(arg);
  }
  const dir = path.join(dshHome, "profiles", profile);
  const bundles = readJson(path.join(dir, "package.json"))?.dsh?.profile?.bundles ?? [];
  if (bundles.includes(WEB)) {
    const bad = app.find((a) => a === "--resume" || a === "-c" || a === "--continue" || a === "-p" || a.startsWith("--resume="));
    if (bad) { console.error("web app: unknown option " + bad); process.exit(2); }
  }
  if (!bundles.includes(TUI)) { console.error("profile " + profile + " does not mount dsh-TUI"); process.exit(3); }
  // dsh-TUI's resume grammar (lib/types/sessionHistory.js): \`--\` ends parsing (it starts literal
  // prompt text), so the shim sends none and these flags are read as flags.
  const cut = app.indexOf("--"), head = cut < 0 ? app : app.slice(0, cut);
  let resume = null;
  const promptArgs = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--resume" || a === "-c" || a === "--continue" || a.startsWith("--resume=")) {
      if (a.startsWith("--resume=")) resume = resume ?? a.slice(9);
      else if (a === "--resume" && head[i + 1] !== undefined && !head[i + 1].startsWith("-")) resume = resume ?? head[++i];
      else resume = resume ?? "last";
      continue;
    }
    if (a.startsWith("-")) continue;
    promptArgs.push(a);
  }
  const prompt = promptArgs.join(" ").trim() || null;
  // onboardingPrefs: completed at the current guide revision means the wizard stays away.
  let onboarding = true;
  try { const prefs = readJson(path.join(process.env.HOME, ".dsh-tui", "onboarding.json")); onboarding = prefs.completed !== true || !(prefs.version >= 1); } catch {}
  console.log(JSON.stringify({ profile, dshHome, app, resume, prompt, onboarding, key: process.env.AM_TEST_KEY ?? null }));
  process.exit(0);
}
if (args[1] !== "--profile" || args[2] !== "dsh-tui") { console.error("wrong call: " + args.join(" ")); process.exit(64); }
const dir = path.join(dshHome, "profiles", "dsh-tui");
if (args[3] === "add") {
  if (cfg.add && cfg.add.fail) { console.error("ERR_PNPM a fake add failure"); process.exit(1); }
  const spec = args[4] || "", version = spec.slice(spec.lastIndexOf("@") + 1);
  const add = cfg.add || {};
  const pkg = path.join(dir, "node_modules", "@deepseek-harness-tui", "dsh-tui");
  fs.mkdirSync(pkg, { recursive: true });
  // The real command initializes a missing custom profile from DEFAULT_PROFILE_BUNDLES (base
  // only; no shipped template is named dsh-tui) and appends the package to dsh.profile.bundles.
  const manifest = fs.existsSync(path.join(dir, "package.json"))
    ? readJson(path.join(dir, "package.json"))
    : { name: "dsh-profile-dsh-tui", private: true, dependencies: {}, dsh: { profile: { bundles: [BASE] } } };
  manifest.dependencies = { ...manifest.dependencies, [TUI]: add.pin || version };
  const bundles = manifest.dsh?.profile?.bundles ?? [BASE];
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.includes(TUI) ? bundles : [...bundles, TUI] } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest) + "\\n");
  fs.writeFileSync(path.join(dir, "cordis.yml"), "[]\\n");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "# dsh profile root\\n");
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), add.workspace || "minimumReleaseAgeExclude:\\n  - '@deepseek-harness-tui/dsh-tui@0.19.0'\\n");
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "packages:\\n\\n  '@deepseek-harness-tui/dsh-tui@0.19.0':\\n    resolution: {integrity: " + (add.integrity || "sha512-4TAPhsTqfL+oG1H39Fbj13tfaVVGnwV9N33dV8Acn/YBoZT/YgXwF+ZnbhvRi0l55bNc6X6loKkngxrNL8NX3w==") + "}\\n\\n");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: add.installed || version }) + "\\n");
  process.exit(0);
}
if (args[3] === "remove") {
  if (cfg.remove && cfg.remove.fail) { console.error("ERR_PNPM a fake remove failure"); process.exit(1); }
  const manifest = readJson(path.join(dir, "package.json"));
  delete manifest.dependencies?.[TUI];
  if (manifest.dsh?.profile) manifest.dsh.profile.bundles = (manifest.dsh.profile.bundles ?? []).filter((name) => name !== TUI);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest) + "\\n");
  fs.rmSync(path.join(dir, "node_modules", "@deepseek-harness-tui", "dsh-tui"), { recursive: true, force: true });
  process.exit(0);
}
process.exit(0);
`);
  if (dsh) {
    exe(join(bin, "dsh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_LOG"
exec "${process.execPath}" "${helper}" "$@"
`);
  }
  // A test run may point the scene's login shell at a wrapper (the hostile-login-PATH run);
  // named `sh`, it still maps to ~/.profile. Otherwise the POSIX login shell is used.
  const env = {
    HOME: home, SHELL: process.env.DSH_TUI_TEST_SHELL || "/bin/sh", PATH: scenePath, TMPDIR: paneTmp,
    DSH_LOG: log, DSH_FAKE: cfgPath,
    AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED: PUBLISHED,
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
  const pane = panePathOf({ env });
  assert.equal(pane.login, true, "the login shell answered");
  assert.equal(pane.path, env.PATH, "the login shell gives the pane exactly the scene's PATH");
  assert.equal(pane.config, "~/.profile");
  if (!dsh) assert.equal(findDsh({ ...env, PATH: pane.path }), null, "no dsh on the scene's pane PATH");
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const runShim = (args, extra = {}) => spawnSync("sh", [join(home, ".local", "bin", SHIM), ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  return { root, home, bin, env, calls, runShim, cli, dsh: join(bin, "dsh"), profile: join(home, ".dsh", "profiles", PROFILE) };
}

/** A dsh-tui profile as an earlier install (or the person) left it; `record` marks it the pack's. */
function seedProfile(s, { version = DSH_TUI.version, record = false } = {}) {
  const profile = join(s.home, ".dsh", "profiles", PROFILE);
  const dir = join(profile, "node_modules", "@deepseek-harness-tui", "dsh-tui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-dsh-tui", private: true, dependencies: { [DSH_TUI.package]: version }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", DSH_TUI.package] } } }) + "\n");
  writeFileSync(join(profile, "pnpm-workspace.yaml"), `minimumReleaseAgeExclude:\n  - '${DSH_TUI.package}@${version}'\n`);
  writeFileSync(join(profile, "pnpm-lock.yaml"), `packages:\n\n  '${DSH_TUI.package}@${version}':\n    resolution: {integrity: ${DSH_TUI.integrity}}\n\n`);
  writeFileSync(join(dir, "package.json"), `{"version":"${version}"}\n`);
  if (record) {
    writeFileSync(join(profile, RECORD_FILE), JSON.stringify({ package: DSH_TUI.package, version, integrity: DSH_TUI.integrity }) + "\n");
  }
  return profile;
}

test("install pins exactly 0.19.0 with its integrity into the dsh-tui profile only", async (t) => {
  const s = scene(t);
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED, now: () => Date.parse(PUBLISHED) + 3600e3 });
  assert.equal(r.status, "installed", r.detail);
  const state = profileState(join(s.home, ".dsh"));
  assert.equal(state.pin, DSH_TUI.version);
  assert.equal(state.installed, DSH_TUI.version);
  assert.equal(state.integrity, DSH_TUI.integrity);
  assert.equal(lockIntegrity(readFileSync(join(state.dir, "pnpm-lock.yaml"), "utf8")), DSH_TUI.integrity);
  assert.deepEqual(s.calls(), [`plugin --profile dsh-tui add ${PIN} --save-exact`]);
  assert.equal(readFileSync(join(s.home, ".local", "bin", SHIM), "utf8"), SHIM_TEXT);
  assert.ok(statSync(join(s.home, ".local", "bin", SHIM)).mode & 0o111, "the shim is executable");
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".dsh-tui", "onboarding.json"), "utf8")), { completed: true, version: 1 });
  assert.equal(JSON.parse(readFileSync(join(state.dir, RECORD_FILE), "utf8")).version, DSH_TUI.version, "the installer records that it added the pin");
});

test("install copies the sandbox wrapper byte-equal and installs the managed dsh-tui row", async (t) => {
  const s = scene(t);
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "installed", r.detail);
  const wrapper = sandboxWrapperOf(s.env);
  assert.ok(existsSync(wrapper), wrapper);
  assert.ok(readFileSync(wrapper).equals(readFileSync(packWrapperOf())), "the stable wrapper is the pack's, byte for byte");
  assert.ok(statSync(wrapper).mode & 0o111, "the wrapper is executable");
  const patch = readFileSync(join(s.home, ".dsh", "profiles", PROFILE, "cordis.patch.yml"), "utf8");
  assert.match(patch, /^# dsh-sandbox begin$/m);
  const stableRoot = sandboxRootOf(s.env);
  assert.ok(patch.includes(`runnerCommand: ['${wrapper}', '--pack-root', '${stableRoot}']`), patch);
  assert.ok(patch.includes(`'--pack-root', '${stableRoot}'`), "the row names the stable folder the wrapper keeps read-only");
  for (const file of STABLE_FILES) {
    if (file === "bin/run.sh") continue;
    assert.ok(readFileSync(join(stableRoot, file)).equals(readFileSync(join(packRootOf(), file))), `${file} is byte-equal`);
  }
  assert.ok(readFileSync(join(stableRoot, "bin", "run.sh"), "utf8").includes(`# am-node: ${process.execPath}`));
  assert.ok(readFileSync(join(stableRoot, "guard", "hc")).equals(readFileSync(join(packRootOf(), "guard", "hc"))), "the guard is byte-equal");
  // #955: the hc kill shim a sandboxed bot's worker of another agent gets, executable as the pack's.
  assert.ok(readFileSync(join(stableRoot, "hc-kill", "hc")).equals(readFileSync(join(packRootOf(), "hc-kill", "hc"))), "the hc kill shim is byte-equal");
  assert.ok(statSync(join(stableRoot, "hc-kill", "hc")).mode & 0o111, "and executable");
  assert.ok(patch.includes("runnerFailureSignatures: ['hc-socket-mask: ']"), patch);
  const state = sandboxState(s.env, { forbiddenRoots: rootsOf(s) });
  assert.equal(state.current, true);
  assert.equal(state.row.ok, true, state.row.message);
});

test("install refuses a stable execution root inside a writable tree", (t) => {
  const s = scene(t);
  assert.throws(
    () => installSandboxRow({ env: { ...s.env, XDG_DATA_HOME: s.root }, project: s.root }),
    /the stable execution root .* is inside the project/,
  );
});

test("install refuses a not-yet-created stable root under literal /tmp", (t) => {
  const s = scene(t);
  const missing = join(realpathSync("/tmp"), `am-hc-install-${process.pid}-${Date.now()}`, "data");
  assert.throws(
    () => installSandboxRow({ env: { ...s.env, XDG_DATA_HOME: missing }, project: process.cwd() }),
    /the stable execution root .* is inside the literal temp folder/,
  );
});

test("install refuses a DSH profile or a node inside a writable tree", (t) => {
  const s = scene(t);
  writeFileSync(join(s.root, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.root, "node"), 0o755);
  assert.throws(
    () => installSandboxRow({ env: { ...s.env, DSH_HOME: s.root, XDG_DATA_HOME: `${s.root}-data` }, project: s.root, forbiddenRoots: [["the project", s.root]] }),
    /the DSH profile .* is inside the project/,
  );
  assert.throws(
    () => installSandboxRow({ env: { ...s.env, PATH: s.root, HOME: `${s.root}-home`, DSH_HOME: `${s.root}-dsh`, XDG_DATA_HOME: `${s.root}-data`, HERDR_APP_HOME: `${s.root}-app` }, project: s.root, forbiddenRoots: [["the project", s.root]] }),
    /the node that runs the helper .* is inside the project/,
  );
});

test("XDG_DATA_HOME names one stable root for install and the pane start", async (t) => {
  const s = scene(t);
  const dataHome = join(dirname(s.home), "data");
  const env = { ...s.env, XDG_DATA_HOME: dataHome };
  const installed = await installDshTui({ forbiddenRoots: rootsOf(s), env, publishedAt: PUBLISHED });
  assert.equal(installed.status, "installed", installed.detail);
  const root = sandboxRootOf(env);
  assert.equal(root, join(dataHome, "automagik-herdr", "dsh-sandbox"));
  assert.ok(existsSync(join(root, "hcPane.mjs")));
  assert.equal(sandboxState(env, { forbiddenRoots: rootsOf(s) }).current, true);
  const args = workerArgs({ botId: "b-devdevdev", branch: "b", cwd: "/p/wt", parent: "t1", agent: "dsh-tui",
    argv: ["dsh-tui"], task: "t", path: "/bin", project: "/p", sandbox: true, stableRoot: root });
  const tail = args.slice(args.indexOf("--") + 1);
  assert.ok(tail.includes(join(root, "hcPane.mjs")), "the start names the install's root");
  assert.ok(tail.includes(join(root, "bin", "run.sh")));
});

test("the stable copy from STABLE_FILES loads hcPane.mjs", async (t) => {
  const s = scene(t);
  const installed = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(installed.status, "installed", installed.detail);
  const mod = await import(`${pathToFileURL(join(sandboxRootOf(s.env), "hcPane.mjs")).href}?t=${Date.now()}`);
  assert.equal(typeof mod.runPane, "function");
});

test("sandboxState sees a stable runner whose exec line differs from its comment", async (t) => {
  const s = scene(t);
  const installed = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(installed.status, "installed", installed.detail);
  const runner = join(sandboxRootOf(s.env), "bin", "run.sh");
  writeFileSync(runner, readFileSync(runner, "utf8").replace(/^exec .*/m, "exec '/bin/false'"));
  assert.equal(sandboxState(s.env, { forbiddenRoots: rootsOf(s) }).current, false);
});

test("doctor reports a sandbox wrapper that drifted from the pack's", async (t) => {
  const s = scene(t);
  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  appendFileSync(sandboxWrapperOf(s.env), "\n// drift\n");
  const report = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  const check = report.checks.find((c) => c.check === "dsh-sandbox");
  assert.equal(check.ok, false);
  assert.match(check.detail, /differs from the pack's/);
  assert.equal(report.code, 1);
});

test("a lockfile integrity that is not the pin fails, removes what it added, and writes no shim", async (t) => {
  const s = scene(t, { config: { add: { integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" } } });
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /lockfile records .*not the pinned/);
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
  assert.deepEqual(s.calls(), [`plugin --profile dsh-tui add ${PIN} --save-exact`, `plugin --profile dsh-tui remove ${DSH_TUI.package}`]);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".dsh", "profiles", PROFILE, "package.json"), "utf8")).dependencies, {});
});

test("the desktop profile, its settings and DSH's credentials are untouched", async (t) => {
  const s = scene(t);
  const before = desktopFingerprint(join(s.home, ".dsh"));
  const desktop = (name) => readFileSync(join(s.home, ".dsh", "profiles", "desktop", name), "utf8");
  const pkg = desktop("package.json"), patch = desktop("cordis.patch.yml"), creds = readFileSync(join(s.home, ".dsh", ".credentials.yaml"), "utf8");
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "installed", r.detail);
  assert.deepEqual(desktopFingerprint(join(s.home, ".dsh")), before);
  assert.equal(desktop("package.json"), pkg);
  assert.equal(desktop("cordis.patch.yml"), patch);
  assert.equal(readFileSync(join(s.home, ".dsh", ".credentials.yaml"), "utf8"), creds);
  assert.ok(s.calls().every((line) => line.includes(`--profile ${PROFILE}`) && !line.includes("desktop")), "every dsh call is the dsh-tui profile");
});

test("the shim runs the dsh-tui profile and the TUI parses its startup flags", async (t) => {
  const s = scene(t);
  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  const shimLog = join(s.root, "shim.log");
  writeFileSync(shimLog, "");
  // The profile is the one dsh-TUI itself creates: base + the TUI bundle, never a web template.
  const manifest = JSON.parse(readFileSync(join(s.profile, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", DSH_TUI.package]);
  assert.equal(existsSync(join(s.home, ".dsh", "profiles", "tui")), false, "no web-template tui profile is created");
  // Every argument reaches the app as the TUI's own grammar reads it; no literal `--` in between.
  // dsh-TUI's startup grammar on the pinned DSH: resume flags, a backend, and `-- <text>` for a
  // literal prompt. `-p`/run is not asserted here: on DSH 0.2.2-rc.1 its automation adapter is
  // unavailable (headless work uses `dsh --profile headless`).
  for (const [args, expected] of [
    [["--resume", "abc"], { resume: "abc", prompt: null }],
    [["-c"], { resume: "last", prompt: null }],
    [["--continue"], { resume: "last", prompt: null }],
    [["--", "hello", "world"], { prompt: "hello world" }],
  ]) {
    const r = s.runShim(args, { DSH_LOG: shimLog });
    assert.equal(r.status, 0, r.stderr);
    const boot = JSON.parse(r.stdout);
    assert.equal(boot.profile, PROFILE);
    if (expected.resume !== undefined) assert.equal(boot.resume, expected.resume);
    assert.equal(boot.prompt, expected.prompt);
  }
  // The shim's own launcher call has no added separator; a user's `-- <text>` travels verbatim.
  assert.deepEqual(readFileSync(shimLog, "utf8").split("\n").filter(Boolean),
    ["--profile dsh-tui --resume abc", "--profile dsh-tui -c", "--profile dsh-tui --continue",
      "--profile dsh-tui -- hello world"]);
  assert.equal(spawnSync("sh", ["-n", join(s.home, ".local", "bin", SHIM)], { encoding: "utf8" }).status, 0);
  assert.match(readFileSync(join(s.home, ".local", "bin", SHIM), "utf8"), /^exec dsh --profile dsh-tui "\$@"$/m);
  const missing = s.runShim([], { PATH: "/usr/bin:/bin" });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /DSH \(dsh\) is not on PATH/);
});

test("the shim sources only a safe provider env file, and leaves the arguments alone", async (t) => {
  const s = scene(t);
  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  const guide = join(s.home, ".dsh", "deepseek.env");
  // The env file's folder is the owner's alone, set here rather than left to the umask: on a
  // umask-002 host it would be 0775, and the shim rightly refuses a file in it (#578).
  chmodSync(join(s.home, ".dsh"), 0o700);
  const boot = (args = [], extra = {}) => {
    const r = s.runShim(args, extra);
    assert.equal(r.status, 0, r.stderr);
    return { r, boot: JSON.parse(r.stdout) };
  };
  // Missing: silent, nothing exported, the shim still starts.
  let run = boot();
  assert.equal(run.boot.key, null);
  assert.equal(run.r.stderr, "");
  // A regular 0600 file owned by this user: every variable it sets is exported to dsh.
  writeFileSync(guide, "AM_TEST_KEY=from-env\n");
  chmodSync(guide, 0o600);
  run = boot(["--resume", "abc"]);
  assert.equal(run.boot.key, "from-env");
  assert.deepEqual(run.boot.app, ["--resume", "abc"], "the env file does not change argv");
  assert.equal(run.boot.resume, "abc");
  assert.equal(run.r.stderr, "");
  // A symlink is skipped with one line, even when its target is a safe file.
  const target = join(s.root, "keys.env");
  writeFileSync(target, "AM_TEST_KEY=via-link\n");
  chmodSync(target, 0o600);
  rmSync(guide);
  symlinkSync(target, guide);
  run = boot();
  assert.equal(run.boot.key, null);
  assert.match(run.r.stderr, /^dsh-tui: skipped the provider env file/m);
  assert.equal(run.r.stderr.trim().split("\n").length, 1);
  // Any group/other read or write bit is refused, one bit at a time.
  for (const mode of [0o620, 0o602, 0o660, 0o606, 0o666, 0o644, 0o604]) {
    if (existsSync(guide)) rmSync(guide);
    writeFileSync(guide, "AM_TEST_KEY=unsafe-mode\n");
    chmodSync(guide, mode);
    run = boot();
    assert.equal(run.boot.key, null, `mode ${mode.toString(8)} must not be sourced`);
    assert.match(run.r.stderr, /skipped the provider env file/);
    assert.equal(run.r.stderr.trim().split("\n").length, 1);
  }
  // Unreadable is skipped too.
  chmodSync(guide, 0o600);
  writeFileSync(guide, "AM_TEST_KEY=unreadable\n");
  chmodSync(guide, 0o000);
  run = boot();
  assert.equal(run.boot.key, null);
  assert.match(run.r.stderr, /skipped the provider env file/);
  // Malformed shell is refused without echoing the offending line or its value.
  chmodSync(guide, 0o600);
  writeFileSync(guide, 'AM_TEST_KEY="unterminated\n');
  chmodSync(guide, 0o600);
  run = boot();
  assert.equal(run.boot.key, null);
  assert.match(run.r.stderr, /^dsh-tui: skipped the provider env file/m);
  assert.equal(run.r.stderr.trim().split("\n").length, 1);
  assert.ok(!run.r.stderr.includes("AM_TEST_KEY"), "the shell's syntax error is discarded");
  assert.ok(!run.r.stderr.includes("unterminated"));
  // The parent folder matters too: check and source are separate opens.
  writeFileSync(guide, "AM_TEST_KEY=parent-unsafe\n");
  chmodSync(guide, 0o600);
  for (const mode of [0o730, 0o702, 0o777]) {
    chmodSync(join(s.home, ".dsh"), mode);
    run = boot();
    assert.equal(run.boot.key, null, `parent mode ${mode.toString(8)} must not trust the file`);
    assert.match(run.r.stderr, /skipped the provider env file/);
  }
  chmodSync(join(s.home, ".dsh"), 0o700);
  // DSH_HOME moves the file; the default under ~/.dsh is not read.
  chmodSync(guide, 0o600);
  writeFileSync(guide, "AM_TEST_KEY=from-default\n");
  const alt = join(s.root, "alt-dsh");
  mkdirSync(alt, { mode: 0o700 });
  symlinkSync(join(s.home, ".dsh", "profiles"), join(alt, "profiles"));
  writeFileSync(join(alt, "deepseek.env"), "AM_TEST_KEY=from-alt\n");
  chmodSync(join(alt, "deepseek.env"), 0o600);
  run = boot([], { DSH_HOME: alt });
  assert.equal(run.boot.key, "from-alt");
  assert.equal(run.boot.dshHome, alt);
});

test("a fresh pane with the onboarding record starts clean, and a person's record is kept", async (t) => {
  const s = scene(t);
  const guide = join(s.home, ".dsh-tui", "onboarding.json");
  assert.equal((await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED })).status, "installed");
  assert.equal(readFileSync(guide, "utf8"), "{\n  \"completed\": true,\n  \"version\": 1\n}\n");
  const boot = JSON.parse(s.runShim([]).stdout);
  assert.equal(boot.onboarding, false, "the wizard does not offer itself on a fresh pane");
  // A person completing the guide writes this file; install keeps their copy byte for byte.
  const theirs = "{\"completed\":true,\"version\":1,\"note\":\"walked it myself\"}\n";
  writeFileSync(guide, theirs);
  const again = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(again.status, "installed");
  assert.match(again.lines.join("\n"), /Kept dsh-TUI's first-run guide state/);
  assert.equal(readFileSync(guide, "utf8"), theirs);
});

test("doctor states dsh, the dsh-tui profile and the shim honestly, before and after install", async (t) => {
  const missing = scene(t, { dsh: false });
  const missingPane = panePathOf({ env: missing.env });
  assert.equal(missingPane.login, true, "the login shell answered");
  assert.equal(missingPane.path, missing.env.PATH, "the login shell gives the pane exactly the scene's PATH");
  assert.equal(missingPane.config, "~/.profile");
  assert.equal(findDsh({ ...missing.env, PATH: missingPane.path }), null, "no dsh on the scene's pane PATH");
  const none = doctorDshTui({ forbiddenRoots: rootsOf(missing), env: missing.env });
  assert.equal(none.code, 2, "no dsh: not applicable");
  assert.equal(none.checks.find((c) => c.check === "dsh").ok, true);
  assert.match(none.checks.find((c) => c.check === "dsh").detail, /not found on the PATH Herdr panes get/);
  assert.match(none.checks.find((c) => c.check === "dsh-tui-profile").detail, /not installed/);
  assert.match(none.checks.find((c) => c.check === "dsh-tui-shim").detail, /not installed/);
  const noPath = doctorDshTui({ forbiddenRoots: rootsOf(missing), env: missing.env,
    panePath: { path: "/usr/bin:/bin", shell: "/bin/sh", config: "~/.profile", login: true } });
  assert.equal(noPath.code, 2, "nothing installed and ~/.local/bin off PATH is still not applicable, never broken");
  assert.equal(noPath.checks.find((c) => c.check === "dsh-tui-path").ok, true);
  assert.match(noPath.checks.find((c) => c.check === "dsh-tui-path").fix, />> ~\/\.profile$/);

  const s = scene(t);
  const paneBefore = panePathOf({ env: s.env });
  assert.equal(paneBefore.login, true, "the login shell answered");
  assert.equal(paneBefore.path, s.env.PATH, "the login shell gives the pane exactly the scene's PATH");
  assert.equal(paneBefore.config, "~/.profile");
  const before = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(before.code, 2);
  assert.equal(before.checks.find((c) => c.check === "dsh").detail, s.dsh);
  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  const after = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(after.code, 0, JSON.stringify(after.checks));
  assert.ok(after.checks.every((c) => c.ok), JSON.stringify(after.checks));
  assert.match(after.checks.find((c) => c.check === "dsh-tui-profile").detail, /integrity ok.*added by this installer/);
  const pane = panePathOf({ env: s.env });
  assert.equal(pane.login, true);
  assert.equal(pane.config, "~/.profile");
  assert.equal(pane.path, s.env.PATH);
  assert.ok(pane.path.split(":").includes(join(s.home, ".local", "bin")), pane.path);
  const off = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env,
    panePath: { path: "/usr/bin:/bin", shell: "/bin/zsh", config: "~/.zshrc", login: true } });
  const offPath = off.checks.find((c) => c.check === "dsh-tui-path");
  assert.equal(offPath.ok, false);
  assert.match(offPath.fix, /\$PATH"' >> ~\/\.zshrc$/);

  rmSync(join(s.home, ".local", "bin", SHIM));
  const half = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(half.code, 1);
  assert.equal(half.checks.find((c) => c.check === "dsh-tui-shim").ok, false);
});

test("proxy doctor detects a stale helper and update repairs it without changing the row",
  { skip: process.platform !== "linux" }, async (t) => {
  const s = scene(t);
  const options = { env: s.env, forbiddenRoots: rootsOf(s), publishedAt: PUBLISHED };
  assert.equal((await installDshTui(options)).status, "installed");
  const profile = join(s.home, ".dsh", "profiles", "dsh-tui", "cordis.patch.yml");
  const before = readFileSync(profile, "utf8");
  assert.match(before, /^- id: sandbox$/m);
  const helper = join(sandboxRootOf(s.env), "hcPane.mjs");
  writeFileSync(helper, "// previous version\n");
  const stale = doctorDshTui(options);
  const check = stale.checks.find((row) => row.check === "dsh-hc-proxy");
  assert.equal(stale.code, 1);
  assert.equal(check.ok, false);
  assert.match(check.detail, /stable proxy execution copy is stale/);
  assert.equal(check.fix, "am dsh-tui install");
  assert.equal(readFileSync(helper, "utf8"), "// previous version\n", "doctor only reads");
  assert.equal((await installDshTui(options)).status, "installed");
  const repaired = doctorDshTui(options);
  assert.equal(repaired.code, 0, JSON.stringify(repaired.checks));
  assert.match(repaired.checks.find((row) => row.check === "dsh-hc-proxy").detail,
    /current; hcProxy defaults off per bot/);
  assert.equal(readFileSync(profile, "utf8"), before);
});

test("install and update preserve every bot's saved switch and never opt in a default bot",
  async (t) => {
  const s = scene(t);
  const project = join(s.root, "project");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  const bots = [true, false, undefined].map((value, i) => ({
    id: `b-${["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"][i]}`, name: `Bot ${i}`,
    kind: i === 0 ? "main" : "member", agent: "dsh-tui",
    ...(value === undefined ? {} : { hcProxy: value }),
  }));
  const file = join(project, ".herdr", "bots.json");
  const before = `${JSON.stringify({ version: 1, categories: [], bots }, null, 2)}\n`;
  writeFileSync(file, before);
  const { cmdDshTui } = await import(CLI);
  const io = { env: s.env, forbiddenRoots: rootsOf(s) };
  for (const verb of ["install", "update"]) {
    const result = await cmdDshTui({ project, json: true }, [verb], io);
    assert.equal(result.status, "installed", result.detail);
    assert.equal(readFileSync(file, "utf8"), before, `${verb} keeps every saved switch byte for byte`);
  }
});

test("the pane PATH is the login shell's, read between its markers", (t) => {
  const s = scene(t);
  const extra = join(s.root, "extra-bin");
  const local = join(s.home, ".local", "bin");
  mkdirSync(extra);
  mkdirSync(local, { recursive: true });
  writeFileSync(join(s.home, ".profile"), `export PATH="${local}:${extra}:/usr/bin:/bin"\n`);
  const pane = panePathOf({ env: { ...s.env, PATH: "/usr/bin:/bin" } });
  assert.equal(pane.login, true, "the login shell answered");
  assert.equal(pane.config, "~/.profile");
  assert.equal(pane.path, `${local}:${extra}:/usr/bin:/bin`);
  assert.doesNotMatch(pane.path, /\n/);
  assert.ok(pane.path.split(":").includes(extra), pane.path);
  assert.ok(pane.path.split(":").includes(local), pane.path);
});

test("uninstall removes the plugin and the shim, and leaves a foreign shim alone", async (t) => {
  const s = scene(t);
  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  const r = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "removed", JSON.stringify(r));
  assert.ok(s.calls().includes(`plugin --profile dsh-tui remove ${DSH_TUI.package}`));
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".dsh", "profiles", PROFILE, "package.json"), "utf8")).dependencies, {});
  assert.deepEqual(releaseAgeEntries(readFileSync(join(s.home, ".dsh", "profiles", PROFILE, "pnpm-workspace.yaml"), "utf8")), []);
  assert.equal(existsSync(join(s.home, ".dsh", "profiles", PROFILE, RECORD_FILE)), false, "the ownership record goes too");
  assert.equal(readFileSync(join(s.home, ".dsh", ".credentials.yaml"), "utf8"), "keep: me\n", "credentials stay");

  const foreign = scene(t);
  mkdirSync(join(foreign.home, ".local", "bin"), { recursive: true });
  writeFileSync(join(foreign.home, ".local", "bin", SHIM), "#!/bin/sh\nexec my-own-dsh \"$@\"\n");
  const refused = await installDshTui({ forbiddenRoots: rootsOf(s), env: foreign.env, publishedAt: PUBLISHED });
  assert.equal(refused.status, "failed");
  assert.match(refused.detail, /not this installer's/);
  assert.equal(readFileSync(join(foreign.home, ".local", "bin", SHIM), "utf8"), "#!/bin/sh\nexec my-own-dsh \"$@\"\n");
  assert.deepEqual(foreign.calls(), []);
});

test("uninstall removes a shim released before the profile fix, as ours", (t) => {
  const s = scene(t);
  seedProfile(s, { record: true });
  const shim = join(s.home, ".local", "bin", SHIM);
  mkdirSync(dirname(shim), { recursive: true });
  exe(shim, `#!/bin/sh\n${SHIM_MARK}\nexec dsh --profile tui -- "$@"\n`);
  const r = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "removed", JSON.stringify(r));
  assert.equal(existsSync(shim), false);
  assert.ok(s.calls().includes(`plugin --profile dsh-tui remove ${DSH_TUI.package}`));
});

test("no dsh: one honest line, nothing written", async (t) => {
  const s = scene(t, { dsh: false });
  // No scene bin either: the pane PATH has no dsh entry at all, so a real machine dsh cannot leak in.
  s.env.PATH = "/usr/bin:/bin";
  writeFileSync(join(s.home, ".profile"), 'export PATH="/usr/bin:/bin"\n');
  const pane = panePathOf({ env: s.env });
  assert.equal(pane.login, true, "the login shell answered");
  assert.equal(pane.config, "~/.profile");
  assert.equal(pane.path, "/usr/bin:/bin");
  assert.equal(findDsh({ ...s.env, PATH: pane.path }), null, "no dsh on the scene's pane PATH");
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "skipped");
  assert.deepEqual(r.lines, [SKIP]);
  assert.match(r.lines[0], /^DSH is not installed \(no dsh on PATH\)/);
  assert.equal(findDsh(s.env), null);
  assert.equal(existsSync(join(s.home, ".local")), false);
  assert.equal(existsSync(join(s.home, ".dsh-tui")), false);
  const cli = s.cli(["dsh-tui", "install"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), SKIP);
});

test("the release-age exception is exact, leaves other packages alone, and is pruned once aged", async (t) => {
  const s = scene(t);
  const workspace = join(s.home, ".dsh", "profiles", PROFILE, "pnpm-workspace.yaml");
  const publishedAt = Date.parse(PUBLISHED);
  const young = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED, now: () => publishedAt + 3600e3 });
  assert.equal(young.status, "installed", young.detail);
  assert.deepEqual(releaseAgeEntries(readFileSync(workspace, "utf8")), [PIN]);
  const aged = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED, now: () => publishedAt + 72 * 3600e3 });
  assert.equal(aged.status, "installed");
  assert.deepEqual(releaseAgeEntries(readFileSync(workspace, "utf8")), []);
  assert.match(aged.lines.join("\n"), /Removed the release-age exception for .*older than the profile's minimumReleaseAge/);

  const scoped = "minimumReleaseAgeExclude:\n  - '@deepseek-harness-tui/dsh-tui'\n  - 'someone-else@1.0.0'\n";
  const fixed = scopeReleaseAge(scoped, [PIN]);
  assert.deepEqual(releaseAgeEntries(fixed.text).sort(), [PIN, "someone-else@1.0.0"].sort());
  assert.ok(!releaseAgeEntries(fixed.text).includes(DSH_TUI.package), "the bare package entry is gone");
  assert.equal(packageOfEntry(PIN), DSH_TUI.package);
  assert.equal(packageOfEntry(DSH_TUI.package), DSH_TUI.package);
  assert.equal(packageOfEntry("someone-else"), "someone-else");
});

test("the CLI command installs, reports doctor JSON and uninstalls", async (t) => {
  const s = scene(t);
  const { cmdDshTui } = await import(CLI);
  const io = { env: s.env, forbiddenRoots: rootsOf(s),
    project: { key: join(s.root, "project"), file: { bots: [] } } };
  const installed = await cmdDshTui({ json: true }, ["install"], io);
  assert.equal(installed.status, "installed", installed.detail);
  const report = await cmdDshTui({ json: true }, ["doctor"], io);
  assert.equal(report.code, 0);
  assert.deepEqual(report.checks.map((c) => c.check), ["dsh", "dsh-tui-profile", "dsh-tui-shim", "dsh-tui-path", "dsh-tui-guide", ...(process.platform === "linux" ? ["dsh-hc-proxy"] : []), "dsh-sandbox", "herdr-ledgers"]);
  const removed = await cmdDshTui({ json: true }, ["uninstall"], io);
  assert.equal(removed.status, "removed");
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
});

test("a pack-owned pin from an earlier release is still the pack's after a pin bump", async (t) => {
  const s = scene(t);
  const profile = seedProfile(s, { version: "0.18.0", record: true });
  assert.equal(ownershipOf(profile).version, "0.18.0", "the record is read by package, not the current pin");
  const installed = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(installed.status, "installed", installed.detail);
  assert.equal(JSON.parse(readFileSync(join(profile, RECORD_FILE), "utf8")).version, DSH_TUI.version, "the record follows the version the install set");
  const r = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "removed");
  assert.ok(s.calls().includes(`plugin --profile dsh-tui remove ${DSH_TUI.package}`));
  assert.deepEqual(JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dependencies, {});
  assert.equal(existsSync(join(profile, RECORD_FILE)), false);
});

test("a pack-owned old pin uninstalls even when the current pin has moved on", (t) => {
  const s = scene(t);
  const profile = seedProfile(s, { version: "0.18.0", record: true });
  const r = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "removed");
  assert.ok(s.calls().includes(`plugin --profile dsh-tui remove ${DSH_TUI.package}`));
  assert.deepEqual(JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dependencies, {});
});

test("a different version the person pinned is skipped, never replaced", async (t) => {
  const s = scene(t);
  const profile = seedProfile(s, { version: "0.18.0" });
  const lock = readFileSync(join(profile, "pnpm-lock.yaml"), "utf8");
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /already pins .*0\.18\.0, not 0\.19\.0/);
  assert.match(r.detail, /left it and its lockfile unchanged/);
  assert.deepEqual(s.calls(), []);
  assert.equal(JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dependencies[DSH_TUI.package], "0.18.0");
  assert.equal(readFileSync(join(profile, "pnpm-lock.yaml"), "utf8"), lock, "the person's lockfile is untouched");
  assert.equal(existsSync(join(profile, RECORD_FILE)), false);
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
});

test("a person's pin is skipped without plugin add even at the pinned version; uninstall leaves it", async (t) => {
  const s = scene(t);
  const profile = seedProfile(s, { version: DSH_TUI.version });
  const lock = readFileSync(join(profile, "pnpm-lock.yaml"), "utf8");
  const installed = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(installed.status, "skipped", installed.detail);
  assert.match(installed.detail, /already pins .*0\.19\.0, which this installer did not add/);
  assert.deepEqual(s.calls(), [], "no plugin add over a pin it did not record");
  assert.equal(ownershipOf(profile), null);
  assert.equal(existsSync(join(profile, RECORD_FILE)), false);
  assert.equal(readFileSync(join(profile, "pnpm-lock.yaml"), "utf8"), lock, "the person's lockfile is untouched");
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
  const r = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(r.status, "absent");
  assert.equal(s.calls().filter((line) => line.includes("remove")).length, 0, "no dsh plugin remove for a pin it did not add");
  assert.equal(JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dependencies[DSH_TUI.package], DSH_TUI.version);
  assert.deepEqual(releaseAgeEntries(readFileSync(join(profile, "pnpm-workspace.yaml"), "utf8")), [PIN]);
  assert.match(r.lines.join("\n"), /did not add it/);
  assert.equal(existsSync(join(s.home, ".local", "bin", SHIM)), false);
});

test("a record whose pin the person moved is dropped, and their current pin is never written over", async (t) => {
  const s = scene(t);
  const profile = seedProfile(s, { version: "0.18.0", record: true });
  // The person set the pin themselves after the pack recorded 0.18.0: still their pin.
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: { [DSH_TUI.package]: DSH_TUI.version } }) + "\n");
  const lock = readFileSync(join(profile, "pnpm-lock.yaml"), "utf8");
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "skipped");
  assert.equal(r.changed, true, "the stale record was dropped");
  assert.match(r.detail, /already pins .*0\.19\.0, which this installer did not add/);
  assert.deepEqual(s.calls(), [], "no plugin add over the person's pin");
  assert.equal(existsSync(join(profile, RECORD_FILE)), false);
  assert.equal(readFileSync(join(profile, "pnpm-lock.yaml"), "utf8"), lock);
});

test("a dangling shim is present but broken; install refuses and uninstall leaves it", async (t) => {
  const s = scene(t);
  const shim = join(s.home, ".local", "bin", SHIM);
  mkdirSync(dirname(shim), { recursive: true });
  symlinkSync(join(s.root, "missing-dsh-tui"), shim);
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /dangling link/);
  assert.ok(lstatSync(shim).isSymbolicLink());
  assert.deepEqual(s.calls(), []);
  const d = doctorDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.equal(d.checks.find((c) => c.check === "dsh-tui-shim").ok, false);
  assert.match(d.checks.find((c) => c.check === "dsh-tui-shim").detail, /unreadable/);
  const u = uninstallDshTui({ forbiddenRoots: rootsOf(s), env: s.env });
  assert.match(u.lines.join("\n"), /dangling link/);
  assert.ok(lstatSync(shim).isSymbolicLink());
});

test("a shim released before the profile fix is still ours and install replaces it", async (t) => {
  const s = scene(t);
  const shim = join(s.home, ".local", "bin", SHIM);
  mkdirSync(dirname(shim), { recursive: true });
  exe(shim, `#!/bin/sh\n${SHIM_MARK}\nexec dsh --profile tui -- "$@"\n`);
  const stale = doctorDshTui({ forbiddenRoots: rootsOf(s),
    env: s.env }).checks.find((c) => c.check === "dsh-tui-shim");
  assert.equal(stale.ok, false, "the released shim is not healthy: it still boots the tui profile");
  assert.match(stale.detail, /earlier release's shim/);
  assert.equal(stale.fix, "am dsh-tui install");
  const r = await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });
  assert.equal(r.status, "installed", r.detail);
  assert.equal(readFileSync(shim, "utf8"), SHIM_TEXT, "the old tui/no-profile shim is replaced");
  assert.equal(doctorDshTui({ forbiddenRoots: rootsOf(s),
    env: s.env }).checks.find((c) => c.check === "dsh-tui-shim").ok, true);
});

test("shimIsOurs accepts only the marker and a known exec line", () => {
  assert.equal(shimIsOurs(SHIM_TEXT), true);
  assert.equal(shimIsOurs(`#!/bin/sh\n${SHIM_MARK}\nexec dsh --profile tui -- "$@"\n`), true, "the released shim is still ours, so install can replace it");
  assert.equal(shimIsOurs("#!/bin/sh\nexec dsh --profile dsh-tui -- \"$@\"\n"), false, "no marker");
  assert.equal(shimIsOurs(`#!/bin/sh\n${SHIM_MARK}\nexec dsh --profile dsh-tui -- "$@"\n`), false, "a literal -- is not ours");
  assert.equal(shimIsOurs(`#!/bin/sh\n${SHIM_MARK}\nexec my-own-dsh --profile dsh-tui "$@"\n`), false, "another command is not ours");
});

// ---- #631 PR C1: approvals survive an install; the dangling last-component symlink ----

test("G1 (d): the approval data-root check refuses every writable tree", (t) => {
  const s = scene(t);
  const project = join(s.root, "project"), app = join(s.root, "app");
  const temp = join(s.root, "pane-tmp"), runtime = join(s.root, "runtime");
  const forbiddenRoots = [["the project", project], ["the app home", app],
    ["the temp folder", temp], ["the runtime folder", runtime]];
  for (const [name, parent] of forbiddenRoots) {
    const env = { ...s.env, XDG_DATA_HOME: join(parent, "data"), HERDR_APP_HOME: app,
      XDG_RUNTIME_DIR: runtime };
    assert.match(approvedDataRootProblem({ env, project, forbiddenRoots }), /is inside/, name);
    assert.throws(() => installSandboxRow({ env, project, forbiddenRoots }), /is inside/, name);
    const checked = sandboxState(env, { forbiddenRoots });
    assert.equal(checked.capable, false, name);
  }
});

test("G1 (d): the stable root and approved folder must stay beneath the data parent", (t) => {
  const s = scene(t);
  const parent = dirname(sandboxRootOf(s.env));
  mkdirSync(parent, { recursive: true });
  for (const name of ["dsh-sandbox", "approved"]) {
    const link = join(parent, name);
    symlinkSync(s.root, link);
    assert.match(approvedDataRootProblem({ env: s.env, forbiddenRoots: rootsOf(s) }),
      /not beneath/);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    unlinkSync(link);
  }
});

test(
  "G1 (f): a pack install/copyStable leaves an approved record and its parent alone", async (t) => {
  const s = scene(t);
  const project = join(s.root, "project");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(join(project, ".herdr", "bots.json"), `${JSON.stringify({
    version: 1, categories: [], bots: [{
      id: "b-aaaaaaaaaa", name: "Main", kind: "main", look: { character: "star", colour: "blue" },
      role: "", instructions: "", agent: "dsh-tui",
    }],
  }, null, 2)}\n`);
  const approved = approveProject({ project, env: s.env, approvedAt: "2026-11-01T00:00:00.000Z",
    approvedBy: "tester" });
  const before = readFileSync(approved.path);
  const first = installSandboxRow({ env: s.env, forbiddenRoots: rootsOf(s) });
  writeFileSync(join(first.stableRoot, "hcProxy.mjs"), "// previous pack version\n");
  const second = installSandboxRow({ env: s.env, forbiddenRoots: rootsOf(s) });
  assert.equal(first.stableRoot, sandboxRootOf(s.env));
  assert.equal(second.changed, true, "the update replaces a changed stable file");
  assert.equal(installSandboxRow({ env: s.env, forbiddenRoots: rootsOf(s) }).changed, false);
  assert.equal(readFileSync(approved.path).equals(before), true,
    "the approval bytes are untouched");
  assert.equal(statSync(approved.path).mode & 0o777, 0o600);
  assert.equal(dirname(dirname(approved.path)), dirname(sandboxRootOf(s.env)),
    "record and stable root share the parent");
});

test("LOW1 (j): a dangling final symlink at the checked path resolves and is refused", (t) => {
  const root = scratchRoot(t, "am-low1-");
  const project = join(root, "project"), parent = join(root, "data", "automagik-herdr");
  mkdirSync(project, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const link = join(parent, "dsh-sandbox");
  symlinkSync("../../project/missing-stable", link);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.match(stableRootProblem(link, { project, env: { ...process.env, TMPDIR: join(root,
    "tmp") } }),
    /the stable execution root .* is inside the project/);
});

test("LOW1 (k): a dangling final symlink at a forbidden root resolves and is refused", (t) => {
  const root = scratchRoot(t, "am-low1-");
  const project = join(root, "project"), link = join(root, "forbidden");
  mkdirSync(project, { recursive: true });
  symlinkSync(join(project, "missing-root"), link);
  const checked = join(project, "missing-root", "dsh-sandbox");
  assert.match(stableRootProblem(checked, { project, forbiddenRoots: [["the project", link]],
    env: { ...process.env, TMPDIR: join(root, "tmp") } }), /inside the project/);
});

test("LOW1 (l): a valid symlink still resolves to its target", (t) => {
  const root = scratchRoot(t, "am-low1-");
  const project = join(root, "project"), safe = join(root, "safe"), link = join(root, "link");
  mkdirSync(project, { recursive: true });
  mkdirSync(safe, { recursive: true });
  symlinkSync(safe, link);
  assert.equal(realOrAbs(join(link, "new")), join(realpathSync(safe), "new"));
  assert.equal(stableRootProblem(join(link, "dsh-sandbox"),
    { project, forbiddenRoots: [["the project", project]], env: { ...process.env,
      TMPDIR: join(root, "tmp") } }),
  null);
});

test("LOW1 (m): a symlink loop is refused", (t) => {
  const root = scratchRoot(t, "am-low1-");
  const a = join(root, "a"), b = join(root, "b");
  symlinkSync(b, a);
  symlinkSync(a, b);
  assert.throws(() => realOrAbs(a), /symlink loop/);
  assert.throws(() => stableRootProblem(a, { project: root, env: { ...process.env,
    TMPDIR: join(root, "tmp") } }),
    /symlink loop/);
});

test("LOW1 (n): a chain over 32 symlinks is refused; exactly 32 still resolves", (t) => {
  const root = scratchRoot(t, "am-low1-");
  const real = join(root, "real");
  mkdirSync(real);
  let at = real;
  for (let i = 0; i < MAX_SYMLINK_DEPTH; i += 1) {
    const link = join(root, `link-${i}`);
    symlinkSync(at, link);
    at = link;
  }
  assert.equal(realOrAbs(at), real, "exactly 32 links resolve");
  symlinkSync(at, join(root, "over"));
  assert.throws(() => realOrAbs(join(root, "over")), /more than 32 symlinks/);
});

test("#839: doctorDshTui and cmdDshTui doctor report wide or unowned ledgers read-only with chmod 600 fix, and pass once 0600", async (t) => {
  const s = scene(t);
  const { cmdDshTui } = await import(CLI);
  const project = join(s.root, "project");
  const appHome = join(s.home, ".config", "herdr-app");
  mkdirSync(join(appHome, "automagik-herdr"), { recursive: true });
  mkdirSync(join(project, ".herdr", "app-home", "automagik-herdr"), { recursive: true });
  const io = { env: s.env, forbiddenRoots: rootsOf(s), project: { key: project, file: { bots: [] } } };

  await installDshTui({ forbiddenRoots: rootsOf(s), env: s.env, publishedAt: PUBLISHED });

  const globalWorkers = join(appHome, "automagik-herdr", "workers.jsonl");
  const projAttach = join(project, ".herdr", "app-home", "automagik-herdr", "attach.jsonl");
  writeFileSync(globalWorkers, '{"event":"start","session":"s-1"}\n');
  chmodSync(globalWorkers, 0o644);
  writeFileSync(projAttach, '{"event":"attach","session":"s-2"}\n');
  chmodSync(projAttach, 0o664);

  const report = await cmdDshTui({ json: true, project }, ["doctor"], io);
  assert.equal(report.code, 1);
  const ledgerCheck = report.checks.find((c) => c.check === "herdr-ledgers");
  assert.equal(ledgerCheck.ok, false);
  assert.match(ledgerCheck.detail, /workers\.jsonl is mode 0644, wider than 0600/);
  assert.match(ledgerCheck.detail, /attach\.jsonl is mode 0664, wider than 0600/);
  assert.equal(ledgerCheck.fix, `chmod 600 '${globalWorkers}' '${projAttach}'`);
  assert.equal(lstatSync(globalWorkers).mode & 0o777, 0o644, "doctor is read-only");
  assert.equal(lstatSync(projAttach).mode & 0o777, 0o664, "doctor is read-only");

  const text = await cmdDshTui({}, ["doctor"], io);
  assert.match(text, /FAIL herdr-ledgers: .* \(fix: chmod 600 /);

  // #883: the exec bits count as wider than 0600, and an owner-unreadable ledger (0070), which
  // install and update leave alone without a word, is reported here with the chmod to run.
  chmodSync(globalWorkers, 0o700);
  chmodSync(projAttach, 0o070);
  try {
    const odd = await cmdDshTui({ json: true, project }, ["doctor"], io);
    const oddCheck = odd.checks.find((c) => c.check === "herdr-ledgers");
    assert.equal(oddCheck.ok, false);
    assert.match(oddCheck.detail, /workers\.jsonl is mode 0700, wider than 0600/);
    assert.match(oddCheck.detail, /attach\.jsonl is mode 0070, wider than 0600/);
    assert.equal(oddCheck.fix, `chmod 600 '${globalWorkers}' '${projAttach}'`);
    assert.equal(lstatSync(projAttach).mode & 0o777, 0o070, "doctor is read-only");
  } finally {
    chmodSync(projAttach, 0o600);
  }

  chmodSync(globalWorkers, 0o600);
  chmodSync(projAttach, 0o600);

  const unowned = await cmdDshTui({ json: true, project }, ["doctor"], { ...io, getuid: () => 999999 });
  assert.equal(unowned.code, 1);
  const unownedCheck = unowned.checks.find((c) => c.check === "herdr-ledgers");
  assert.equal(unownedCheck.ok, false);
  assert.match(unownedCheck.detail, /owned by uid \d+, not 999999/);
  assert.equal(unownedCheck.fix, null, "never suggest chmod 600 for another user's file");

  // Symlink and FIFO ledgers: doctor never hangs on a FIFO and never prints chmod 600 for symlinks or FIFOs.
  unlinkSync(globalWorkers);
  assert.equal(spawnSync("mkfifo", [globalWorkers]).status, 0);
  unlinkSync(projAttach);
  symlinkSync(join(s.root, "outside.jsonl"), projAttach);
  const nonRegular = await cmdDshTui({ json: true, project }, ["doctor"], io);
  assert.equal(nonRegular.code, 1);
  const nonRegularCheck = nonRegular.checks.find((c) => c.check === "herdr-ledgers");
  assert.equal(nonRegularCheck.ok, false);
  assert.match(nonRegularCheck.detail, /workers\.jsonl is not a regular file/);
  assert.match(nonRegularCheck.detail, /attach\.jsonl is a symlink/);
  assert.equal(nonRegularCheck.fix, null, "never suggest chmod 600 for FIFO or symlink");

  unlinkSync(globalWorkers);
  unlinkSync(projAttach);
  writeFileSync(globalWorkers, '{"event":"start","session":"s-1"}\n');
  chmodSync(globalWorkers, 0o600);
  writeFileSync(projAttach, '{"event":"attach","session":"s-2"}\n');
  chmodSync(projAttach, 0o600);

  const clean = await cmdDshTui({ json: true, project }, ["doctor"], io);
  assert.equal(clean.code, 0, JSON.stringify(clean.checks));
  const cleanCheck = clean.checks.find((c) => c.check === "herdr-ledgers");
  assert.equal(cleanCheck.ok, true);
  assert.equal(cleanCheck.fix, null);
  assert.match(cleanCheck.detail, /2 ledger\(s\) mode 0600 and owned by current user/);
});
