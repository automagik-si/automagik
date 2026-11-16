// The held start: the runner ships inert inside am. Nothing outside am/runner/ (and these tests)
// imports or names it; no am verb, installer, pack path, hook or boot path starts it or writes
// its unit. The command runs live in a temp home, with fake uid-switch and systemd tools on PATH
// that would leave a sentinel if anything ever started a member shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { base } from "./runner-helpers.mjs";

const AM = fileURLToPath(new URL("..", import.meta.url));
const PACK = join(AM, "..", "herdr", "mods", "am-sidebar");
const NODE_DIR = dirname(process.execPath);
const TEXT = /\.(?:mjs|js|sh|json|md)$/;
const RUNNER_REF = /am\/runner|runner\/(?:main|locks|proto|spawn)\.mjs/;

/** Every text file under `dir`, skipping folders named in `skip` anywhere below it. */
function texts(dir, skip = new Set()) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...texts(path, skip));
    else if (TEXT.test(entry.name)) found.push(path);
  }
  return found;
}

test("nothing outside am/runner/ and its tests imports or names the runner", () => {
  const amFiles = texts(AM, new Set(["runner", "test", "node_modules"]));
  assert.ok(amFiles.some((path) => path.endsWith("bin/am.mjs")));
  for (const path of amFiles) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, RUNNER_REF, relative(AM, path));
  }
  const packFiles = texts(join(AM, "..", "herdr"), new Set(["test", "node_modules", ".git"])).filter(
    (path) => !path.includes(`${join("herdr", "docs")}/`),
  );
  assert.ok(packFiles.length > 50);
  for (const path of packFiles) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /am\/runner|runner\/main\.mjs/, relative(join(AM, ".."), path));
  }
});

test("the part ships am/** as one patch, with no runner entry, path or write", () => {
  const part = JSON.parse(readFileSync(join(AM, "part.json"), "utf8"));
  assert.deepEqual(part.paths, ["am/**"]);
  assert.ok(!JSON.stringify(part).includes("runner"));
  assert.ok(relative(AM, join(AM, "runner", "main.mjs")).startsWith("runner/"));
});

function sentinelBin(root) {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  const marker = join(root, "TOUCHED");
  for (const name of ["unshare", "systemd-run", "newuidmap", "newgidmap"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, marker };
}

function everyVerb(env, cwd) {
  const help = spawnSync(process.execPath, [join(PACK, "bin", "automagik-herdr.mjs"), "--help"], {
    encoding: "utf8",
    env,
    cwd,
  });
  assert.equal(help.status, 0, help.stderr);
  const verbs = new Set();
  for (const line of help.stdout.split("\n")) {
    const match = /^ {2}([a-z][a-z-]*)(?=\s|$)/.exec(line);
    if (match !== null) verbs.add(match[1]);
  }
  for (const verb of ["update", "rollback", "self"]) verbs.add(verb);
  return [...verbs].sort();
}

function walkFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else found.push(path);
  }
  return found;
}

test("no am verb starts the runner, makes its socket or writes its unit", (t) => {
  const root = base(t);
  const home = join(root, "home");
  const app = join(root, "app");
  const releases = join(root, "releases");
  for (const path of [home, app, releases]) mkdirSync(path, { recursive: true });
  const sentinel = sentinelBin(root);
  const env = {
    PATH: `${NODE_DIR}:${sentinel.dir}:/usr/bin:/bin`,
    HOME: home,
    HERDR_APP_HOME: app,
    AM_RELEASE_URL: `file://${releases}`,
    AUTOMAGIK_HERDR_NO_UPDATE: "1",
    LANG: "C.UTF-8",
  };
  const am = (args) =>
    spawnSync(process.execPath, [join(AM, "bin", "am.mjs"), ...args], {
      encoding: "utf8",
      env,
      cwd: root,
      timeout: 20000,
    });

  const install = am(["self", "install", "--json"]);
  assert.equal(install.status, 0, install.stderr);
  const store = join(home, ".automagik", "parts", "automagik.am");
  assert.ok(existsSync(join(store, "current", "runner", "main.mjs")), "the runner ships in am's copy");
  const release = readFileSync(join(AM, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.match(release, /git archive .*v\$\{VERSION\}:am.*\(exclude\)test/, "am packs without its tests");

  const verbs = everyVerb(env, root);
  assert.ok(verbs.includes("ls") && verbs.includes("start") && verbs.includes("revive"));
  const calls = [
    ["help"],
    ["--version"],
    ["self", "doctor", "--json"],
    ["update", "--check", "--json"],
    ["rollback", "automagik.am", "--json"],
    ...verbs.map((verb) => [verb, "--json"]),
  ];
  for (const args of calls) {
    const result = am(args);
    assert.equal(result.signal, null, `am ${args.join(" ")} hung`);
    assert.equal(typeof result.status, "number", `am ${args.join(" ")} did not end`);
  }

  assert.equal(existsSync(sentinel.marker), false, "a uid switch or a systemd scope was made");
  for (const path of walkFiles(home)) {
    const info = lstatSync(path);
    assert.ok(!info.isSocket() || !path.includes("runner"), `a runner socket was made: ${path}`);
    if (path.endsWith(".service")) assert.ok(!readFileSync(path, "utf8").includes("runner"), path);
  }

  const uninstall = am(["self", "uninstall", "--json"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
});
