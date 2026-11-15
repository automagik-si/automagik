// bin/run.sh (the runtime finder) and bin/automagik-herdr (the CLI wrapper the ~/.local/bin link
// names): which runtime runs, in which order, with every argument and stdin passed through, and
// the one-line error when there is none. Fake runtimes in a scratch HOME and PATH; the real node
// (and bun, when installed) only for the CLI's --version. POSIX sh: CI's sh is dash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../mods/am-sidebar/bin/", import.meta.url));
const RUN = join(BIN, "run.sh");
const WRAPPER = join(BIN, "automagik-herdr");
const CLI = join(BIN, "automagik-herdr.mjs");
const VERSION = readFileSync(new URL("../mods/am-sidebar/VERSION", import.meta.url), "utf8").trim();

/** A scratch HOME and PATH folder; `fake(path, version)` writes a runtime that prints its name, args and stdin. */
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), path = join(root, "path");
  for (const d of [home, path]) mkdirSync(d, { recursive: true });
  const fake = (file, version) => {
    mkdirSync(dirname(file), { recursive: true });
    // Builtins only: the PATH under test may hold nothing else.
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\n`
      + `printf '%s\\n' "${file}" "$#" "$@"\nIFS= read -r line && printf 'stdin:%s\\n' "$line"\nexit 0\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const run = (args, { env = {}, input = "" } = {}) => {
    const r = spawnSync("/bin/sh", [RUN, ...args], { input, encoding: "utf8",
      env: { HOME: home, PATH: path, AUTOMAGIK_HERDR_RUNTIME_DIRS: "", ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
  };
  return { root, home, path, fake, run };
}

test("run.sh is POSIX sh", () => {
  for (const f of [RUN, WRAPPER]) assert.equal(spawnSync("sh", ["-n", f]).status, 0, f);
});

test("node on PATH, 22.7 or later, runs the script with every argument and stdin passed through", (t) => {
  const s = scratch(t);
  const node = s.fake(join(s.path, "node"), "v22.7.0");
  s.fake(join(s.home, ".nvm/versions/node/v24.0.0/bin/node"), "v24.0.0");
  const r = s.run(["/x/script.mjs", "--version", "a b", "", "$HOME"], { input: '{"prompt":"hi"}\n' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, [node, "5", "/x/script.mjs", "--version", "a b", "$HOME", 'stdin:{"prompt":"hi"}']);
  assert.match(r.out, /\na b\n\n\$HOME\n/, "the empty argument is kept");
});

test("an older node on PATH is passed over for the newest nvm node, compared by number", (t) => {
  const s = scratch(t);
  s.fake(join(s.path, "node"), "v22.6.9");
  const nvm = (v) => s.fake(join(s.home, ".nvm/versions/node", v, "bin/node"), v);
  nvm("v20.19.0");
  nvm("v22.9.0");
  const best = nvm("v22.10.1");
  nvm("v22.10.0");
  const r = s.run(["/x/s.mjs"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines[0], best, "22.10.1, not 22.9.0 (the last one in glob order)");
});

test("then Homebrew's folders in order, skipping a dangling link and an old node", (t) => {
  const s = scratch(t);
  s.fake(join(s.home, ".nvm/versions/node/v20.0.0/bin/node"), "v20.0.0");
  const [gone, old, good, later] = ["gone", "old", "good", "later"].map((d) => join(s.root, d));
  mkdirSync(gone);
  symlinkSync(join(s.root, "Cellar/node/26.0.0/bin/node"), join(gone, "node")); // Homebrew lost the link target
  s.fake(join(old, "node"), "v21.9.9");
  const node = s.fake(join(good, "node"), "v26.13.0");
  s.fake(join(later, "node"), "v26.13.0");
  s.fake(join(s.path, "bun"), "1.4.4");
  const r = s.run(["/x/s.mjs", "go"], { env: { AUTOMAGIK_HERDR_RUNTIME_DIRS: [gone, old, good, later].join(":") } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines.slice(0, 4), [node, "2", "/x/s.mjs", "go"]);
});

test("no node anywhere: bun on PATH, then ~/.bun/bin/bun", (t) => {
  const s = scratch(t);
  const homeBun = s.fake(join(s.home, ".bun/bin/bun"), "1.4.4");
  assert.equal(s.run(["/x/s.mjs"]).lines[0], homeBun);
  const pathBun = s.fake(join(s.path, "bun"), "1.4.4");
  // --no-env-file first: bun would otherwise read the working folder's .env into the process.
  assert.deepEqual(s.run(["/x/s.mjs", "a"]).lines, [pathBun, "3", "--no-env-file", "/x/s.mjs", "a"]);
});

test("$NVM_DIR, when set, is where the nvm nodes are looked for", (t) => {
  const s = scratch(t);
  s.fake(join(s.home, ".nvm/versions/node/v24.0.0/bin/node"), "v24.0.0");
  const custom = s.fake(join(s.root, "nvm/versions/node/v22.7.0/bin/node"), "v22.7.0");
  assert.equal(s.run(["/x/s.mjs"], { env: { NVM_DIR: join(s.root, "nvm") } }).lines[0], custom);
});

test("nothing found: one line on stderr naming what is needed and how to get it, exit 127", (t) => {
  const s = scratch(t);
  const none = s.run(["/x/s.mjs"]);
  assert.equal(none.code, 127);
  assert.equal(none.out, "");
  assert.equal(none.err.split("\n").filter(Boolean).length, 1, none.err);
  assert.match(none.err, /needs Node\.js 22\.7 or later, or Bun/);
  assert.match(none.err, /brew install node/);
  assert.match(none.err, /bun\.sh\/install/);
  s.fake(join(s.path, "node"), "v20.1.0");
  const old = s.run(["/x/s.mjs"]);
  assert.equal(old.code, 127);
  assert.match(old.err, /node 20\.1\.0 at .*\/path\/node is too old/);
  assert.equal(s.run([]).code, 64, "no script: a usage error, never 2 (which blocks a Claude prompt)");
});

/** The real node's folder as the only place run.sh finds a runtime (PATH keeps readlink and dirname). */
const nodeOnlyFromDirs = (home) => ({ HOME: home, PATH: "/usr/bin:/bin", AUTOMAGIK_HERDR_RUNTIME_DIRS: dirname(process.execPath) });

test("the CLI wrapper, through an absolute or a relative link, runs the CLI without node on PATH", (t) => {
  const s = scratch(t);
  const abs = join(s.root, "abs");
  const rel = join(s.root, "local/bin");
  mkdirSync(abs);
  mkdirSync(rel, { recursive: true });
  symlinkSync(WRAPPER, join(abs, "automagik-herdr"));
  symlinkSync(relative(rel, WRAPPER), join(rel, "automagik-herdr"));
  for (const link of [join(abs, "automagik-herdr"), join(rel, "automagik-herdr")]) {
    const r = spawnSync(link, ["--version"], { encoding: "utf8", env: nodeOnlyFromDirs(s.home) });
    assert.equal(r.stdout.trim(), `am ${VERSION}`, `${link}: ${r.stderr}`);
  }
});

// The CLI and briefing.mjs under bun: the whole CLI and briefing suites run with
// AUTOMAGIK_HERDR_TEST_RUNTIME=$(command -v bun) node --test test/cli.test.mjs test/briefing.test.mjs;
// this one runs on every machine that has bun.
const BUN = [spawnSync("/bin/sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim(),
  join(process.env.HOME ?? "/nonexistent", ".bun/bin/bun")].find((p) => p && existsSync(p));

test("under bun (skipped without it): the CLI's --version, directly and as run.sh's only runtime", { skip: !BUN && "bun is not installed" }, (t) => {
  const s = scratch(t);
  const direct = spawnSync(BUN, [CLI, "--version"], { encoding: "utf8", env: { HOME: s.home, PATH: "/usr/bin:/bin" } });
  assert.equal(direct.stdout.trim(), `am ${VERSION}`, direct.stderr);
  symlinkSync(BUN, join(s.path, "bun"));
  const viaRun = s.run([CLI, "--version"]);
  assert.equal(viaRun.code, 0, viaRun.err);
  assert.equal(viaRun.out.trim(), `am ${VERSION}`);
  // A project's .env stays out: run from a folder holding one, the CLI never sees its keys.
  const project = join(s.root, "project");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "HC_TERMINAL_ID=leaked\n");
  const probe = join(s.root, "probe.mjs");
  writeFileSync(probe, "console.log(process.env.HC_TERMINAL_ID ?? 'clean');\n");
  const env = spawnSync("/bin/sh", [RUN, probe], { cwd: project, encoding: "utf8",
    env: { HOME: s.home, PATH: s.path, AUTOMAGIK_HERDR_RUNTIME_DIRS: "" } });
  assert.equal(env.stdout.trim(), "clean", env.stderr);
});
