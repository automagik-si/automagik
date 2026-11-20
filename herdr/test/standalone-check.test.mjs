// scripts/standalone-check.mjs: the scan finds what a mod reaches outside its folder, and the
// script runs against a stand-in herdr-app of the test's own (in HERDR_APP_BIN and first on PATH).
// The real one runs only with AUTOMAGIK_HERDR_APP_CHECK=1 and HERDR_APP_BIN naming it (CI's herdr
// pack job, Node 24 leg), on a machine with no live Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import { REVIEWED, scanMod, scratchBase, summarize, verdictOf } from "../scripts/standalone-check.mjs";

const SCRIPT = new URL("../scripts/standalone-check.mjs", import.meta.url).pathname;
const MODS = new URL("../mods/", import.meta.url).pathname;
const AM = readdirSync(MODS).filter((n) => n.startsWith("am-") && statSync(join(MODS, n)).isDirectory()).sort();

/** The opt-in: only then does a row here start a real herdr-app (CI's Node 24 leg sets it). */
const REAL_APP = process.env.AUTOMAGIK_HERDR_APP_CHECK === "1";
const REAL_APP_SKIP = REAL_APP ? false
  : "runs the real herdr-app: set AUTOMAGIK_HERDR_APP_CHECK=1 and HERDR_APP_BIN, only on a machine with no live Herdr (CI's herdr pack job does on Node 24)";

/**
 * A stand-in herdr-app in `dir/bin`, logging each call to `dir/herdr-app.log` as `arg1<TAB>arg2<TAB>$HERDR_APP_HOME`.
 * `version: null` makes `--version` exit 1. Otherwise it prints `herdr-app <version>`.
 * Checks pass unless `crashMod` names the mod to kill. Anything else exits 64.
 */
function standInApp(dir, { version = null, crashMod = null } = {}) {
  const binDir = join(dir, "bin");
  const bin = join(binDir, "herdr-app");
  const log = join(dir, "herdr-app.log");
  mkdirSync(binDir);
  writeFileSync(log, "");
  const versionReply = version === null ? "exit 1" : `echo "herdr-app ${version}"; exit 0`;
  const crash = crashMod === null ? "" :
    `case "$2" in */${crashMod}) echo "check: loading ${crashMod}" >&2; kill -KILL $$ ;; esac`;
  writeFileSync(bin, `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$1" "$2" "$HERDR_APP_HOME" >> "${log}"
case "$1" in
  --version) ${versionReply} ;;
  check)
    ${crash}
    echo "check passed: $2"
    exit 0 ;;
  *) exit 64 ;;
esac
`);
  chmodSync(bin, 0o755);
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
  return { bin, binDir, calls };
}

function tempFolder(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const deps = (self, text, reviewed, file = "main.js") => summarize(scanMod(self, { [file]: text }), reviewed);

test("scan: another mod, opened as an overlay, a tab, by mod.open or by path, is a hard dependency", () => {
  const { hard } = deps("am-x", [
    'openOverlay({ mod: "am-new-menu", kind: "popup" });',
    'run("tab.new", { name: "Mods", mod: "am-mods" });',
    'run("mod.open", { name: "pocket-link" });',
    'const k = { "cmd-m": "mod.open:am-y" };',
    'svg("mods/am-z/icon.svg");',
  ].join("\n"));
  assert.deepEqual(hard.map((d) => d.dep), ["mod am-new-menu", "mod am-mods", "mod pocket-link", "mod am-y", "mod am-z"]);
  assert.equal(hard[0].at, "main.js:1");
});

test("scan: itself, Herdr's own mods and Herdr's own layout nodes are not dependencies", () => {
  const { hard, optional } = deps("am-x", [
    'openOverlay({ mod: "am-x", kind: "popup" });',
    'svg("mods/pane/close.svg"); run("mod.open", { name: "picker" });',
    'openOverlay({ mod: "worktree", kind: "dialog" });',
    'run("layout.select", { stack: "panel-body", child: want }); run("layout.hide", { id: "panel" });',
  ].join("\n"));
  assert.deepEqual([hard, optional], [[], []]);
});

test("scan: a layout node Herdr does not ship is a dependency", () => {
  const { hard } = deps("am-x", [
    'run("layout.toggle", { id: "am-quota-panel" });',
    'const shown = !find(layout(), "automations-panel")?.hidden;',
  ].join("\n"));
  assert.deepEqual(hard.map((d) => d.dep), ["node am-quota-panel", "node automations-panel"]);
});

test("scan: a probed mod is optional everywhere, and a reviewed entry moves or drops a finding", () => {
  const text = [
    'bots = (await readTextFile(`${appHome()}/mods/am-sidebar/mod.json`)) !== null;',
    'const f = { mod: "am-sidebar", kind: "dialog" };',
    'const r = await exec("node", ["-e", X]);',
    'const g = await exec("gh", ["api"]);',
  ].join("\n");
  const { hard, optional } = deps("am-x", text, [{ dep: "exec node", soft: "behind a probe" }, { dep: "exec gh", drop: "not real" }]);
  assert.deepEqual(hard, []);
  assert.deepEqual(optional.map((d) => d.dep), ["mod am-sidebar", "exec node"]);
});

test("scan: hc, programs other than the system's, usagemeter, hosts and installer state", () => {
  const { hard } = deps("am-x", [
    'const r = await hc(["read", term]);',
    'await exec("sh", ["-c", s]); await exec("git", ["status"]); await io.exec("herdr-automations", ["version"]);',
    'const bin = `${home}/.local/bin/usagemeter`;',
    'const URL = "https://api.github.com/repos"; const ns = "http://www.w3.org/2000/svg";',
    'const p = `${appHome}/data/am-mods/catalog.json`;',
  ].join("\n"));
  assert.deepEqual(hard.map((d) => d.dep), ["hc", "exec herdr-automations", "exec usagemeter", "file ~/.local/bin/usagemeter", "net api.github.com", "installer state data/am-mods"]);
});

test("scan: a fetch of a computed URL is reported, also in a file that names a host", () => {
  assert.deepEqual(deps("am-x", "const res = await fetch(`${root}${path}`);").hard.map((d) => d.dep), ["net computed URL"]);
  assert.deepEqual(deps("am-x", 'const U = "https://x.dev/a";\nawait fetch(U);').hard.map((d) => d.dep), ["net x.dev", "net computed URL"]);
});

test("scan: every program run is listed; system ones, sh -c and run-time names under runs", () => {
  const { hard, touches } = deps("am-x", [
    'await exec("sh", ["-c", script, "sh", dir]);',
    'await exec("git", ["status"]); await exec("wc", ["-c", p]);',
    'const r = await exec(this.bin, args); await io.exec(cmd, args, opts);',
    'const m = /^(a)$/.exec(p); const n = RE.exec("x");',
  ].join("\n"));
  assert.deepEqual(hard, []);
  assert.deepEqual(touches.map((d) => d.dep), ["sh -c", "git", "wc", "program from this.bin", "program from cmd"]);
});

test("scan: a shell script's programs, hosts and home paths count; its comments and messages do not", () => {
  const { hard } = deps("am-x", [
    "# node and curl https://comment.dev, ~/.nope",
    'command -v node >/dev/null && exec node "$@"',
    'for d in "$HOME/.nvm/versions"; do :; done',
    'echo "none in ~/.bun/bin: curl -fsSL https://bun.sh/install | bash" >&2',
    'hc read "$t"',
  ].join("\n"), [], "bin/run.sh");
  assert.deepEqual(hard.map((d) => d.dep), ["exec node", "file ~/.nvm/versions", "hc"]);
});

test("scan: files under the person's home are dependencies; other app-home files are listed under runs", () => {
  const { hard, touches } = deps("am-x", [
    'const KEY = "~/.config/tool/key"; const t = p.startsWith("~/");',
    'const a = `${home()}/.codex/auth.json`; const b = `${home}/.claude`; const c = `${home}/layouts`;',
    'const d = join(homedir(), "notes.txt"); const e = join(home, ".local/state");',
    'readTextFile(`${appHome()}/cliproxy.json`); readTextFile(`${appHome()}/mods/am-x/x.json`);',
  ].join("\n"));
  assert.deepEqual(hard.map((d) => d.dep), ["file ~/.config/tool/key", "file ~/.codex/auth.json", "file ~/.claude", "file ~/notes.txt", "file ~/.local/state"]);
  assert.deepEqual(touches.map((d) => d.dep), ["file <app home>/cliproxy.json"]);
});

test("scan: comment lines are prose, not references", () => {
  const { hard } = deps("am-x", [
    '// opens am-sidebar\'s dialog: openOverlay({ mod: "am-sidebar" })',
    ' * hc(["read"]) and https://example.com',
    '/* run("layout.toggle", { id: "am-quota-panel" }) */',
  ].join("\n"));
  assert.deepEqual(hard, []);
});

test("verdict: standalone only with no hard dependency and a check that ran and passed", () => {
  assert.equal(verdictOf({ status: "pass" }, []), "standalone");
  assert.equal(verdictOf({ status: "skipped" }, []), "standalone (unchecked)");
  assert.equal(verdictOf({ status: "fail" }, []), "needs a passing check");
  assert.equal(verdictOf({ status: "pass" }, [{ dep: "mod am-new-menu" }, { dep: "hc" }]), "needs mod am-new-menu, hc");
});

test("REVIEWED: every entry names a mod and still matches what its scan finds", async () => {
  const { readFileSync } = await import("node:fs");
  for (const [mod, entries] of Object.entries(REVIEWED)) {
    assert.ok(AM.includes(mod), `${mod} is not a mod`);
    const files = {};
    const walk = (d, rel = "") => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), r);
        else if (/\.(m?js|sh)$/.test(e.name)) files[r] = readFileSync(join(d, e.name), "utf8");
      }
    };
    walk(join(MODS, mod));
    const { hard, optional, touches } = summarize(scanMod(mod, files));
    const found = [...hard, ...optional, ...touches].map((d) => d.dep);
    for (const e of entries) assert.ok(found.includes(e.dep), `${mod}: reviewed "${e.dep}" is no longer found`);
  }
});

test("scratch base: the home folder, the real app home and anything inside it are refused", (t) => {
  assert.throws(() => scratchBase({ HERDR_APP_HOME: join(homedir(), ".config/herdr-app") }), /refusing/);
  assert.throws(() => scratchBase({ HERDR_APP_HOME: join(homedir(), ".config/herdr-app/mods") }), /refusing/);
  assert.throws(() => scratchBase({ HERDR_APP_HOME: homedir() }), /refusing/);
  // A stand-in home: a folder inside its app home, one not created yet, and a link into it.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "standalone-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".config/herdr-app/mods"), { recursive: true });
  symlinkSync(join(home, ".config/herdr-app/mods"), join(home, "link"));
  for (const p of [".config/herdr-app/mods", ".config/herdr-app/new/deeper", "link", "link/x", "."]) {
    assert.throws(() => scratchBase({ HERDR_APP_HOME: join(home, p) }, home), /refusing/, p);
  }
  assert.equal(scratchBase({ HERDR_APP_HOME: join(home, ".config/herdr-app-scratch") }, home), join(home, ".config/herdr-app-scratch"));
  assert.equal(scratchBase({ HERDR_APP_HOME: join(home, "scratch") }, home), join(home, "scratch"));
});

test("the script without herdr-app: one row per am-* mod, every check skipped, never plain standalone, scratch left empty", (t) => {
  const scratch = tempFolder(t, "standalone-check-");
  const s = standInApp(tempFolder(t, "standalone-app-"));
  const r = spawnSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8",
    timeout: 600000,
    env: { ...process.env, HERDR_APP_HOME: scratch, HERDR_APP_BIN: s.bin, PATH: `${s.binDir}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const { herdrApp, skipped, rows } = JSON.parse(r.stdout);
  assert.equal(herdrApp, null);
  assert.match(skipped, /herdr-app not installed/);
  assert.deepEqual(rows.map((row) => row.mod), AM);
  for (const row of rows) {
    assert.equal(row.check.status, "skipped");
    assert.notEqual(row.verdict, "standalone", row.mod);
  }
  const by = Object.fromEntries(rows.map((row) => [row.mod, row]));
  assert.ok(by["am-tabs"].hard.some((d) => d.dep === "mod am-new-menu"));
  assert.ok(by["am-footer"].hard.some((d) => d.dep === "mod am-mods"));
  assert.deepEqual(readdirSync(scratch), [], "the run's homes are removed");
  assert.deepEqual(s.calls().map((c) => c[0]), ["--version"]);
});

test("the script with a stand-in herdr-app: each am-* mod checked alone in its own scratch app home, removed after", (t) => {
  const CRASH = AM.at(-1) === "am-tabs" ? AM.at(-2) : AM.at(-1);
  const scratch = tempFolder(t, "standalone-check-");
  const s = standInApp(tempFolder(t, "standalone-app-"), { version: "0.0.0-test", crashMod: CRASH });
  const r = spawnSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8",
    timeout: 600000,
    env: { ...process.env, HERDR_APP_HOME: scratch, HERDR_APP_BIN: s.bin, PATH: `${s.binDir}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const { herdrApp, rows } = JSON.parse(r.stdout);
  assert.equal(herdrApp, "herdr-app 0.0.0-test");
  assert.deepEqual(rows.map((row) => row.mod), AM);
  const by = Object.fromEntries(rows.map((row) => [row.mod, row]));
  assert.deepEqual(by[CRASH].check, { status: "fail", crashed: true, detail: "killed by SIGKILL" });
  assert.match(by["am-tabs"].verdict, /^needs/);
  for (const row of rows) {
    if (row.mod !== CRASH) assert.deepEqual(row.check, { status: "pass", detail: "" }, row.mod);
    assert.equal(row.verdict, verdictOf(row.check, row.hard), row.mod);
  }
  const [versionCall, ...checks] = s.calls();
  assert.deepEqual(versionCall.slice(0, 2), ["--version", ""]);
  assert.equal(checks.length, AM.length);
  const base = realpathSync(scratch);
  const homes = new Set();
  for (const [i, [verb, folder, home]] of checks.entries()) {
    assert.equal(verb, "check");
    assert.equal(folder, join(home, "mods", AM[i]));
    assert.ok(home.startsWith(base + sep), home);
    homes.add(home);
  }
  assert.equal(homes.size, AM.length);
  assert.deepEqual(readdirSync(scratch), [], "the run's homes are removed");
});

test("the script with the real herdr-app (AUTOMAGIK_HERDR_APP_CHECK=1): every am-* mod checked alone in a scratch home", { skip: REAL_APP_SKIP, timeout: 600000 }, (t) => {
  const bin = process.env.HERDR_APP_BIN ?? "";
  assert.ok(isAbsolute(bin), "AUTOMAGIK_HERDR_APP_CHECK=1 needs HERDR_APP_BIN: the absolute path of the herdr-app to run (CI's kept pinned build)");
  assert.doesNotThrow(() => accessSync(bin, constants.X_OK), `HERDR_APP_BIN is not an executable: ${bin}`);
  const scratch = tempFolder(t, "standalone-check-");
  const r = spawnSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8",
    timeout: 600000,
    env: { ...process.env, HERDR_APP_HOME: scratch, HERDR_APP_BIN: bin },
  });
  assert.equal(r.status, 0, r.stderr);
  const { herdrApp, rows } = JSON.parse(r.stdout);
  assert.ok(herdrApp, "no herdr-app answered --version at HERDR_APP_BIN");
  assert.deepEqual(rows.map((row) => row.mod), AM);
  for (const row of rows) assert.ok(["pass", "fail"].includes(row.check.status), row.mod);
  assert.deepEqual(rows.filter((r) => r.check.crashed).map((r) => `${r.mod}: ${r.check.detail}`), [], "herdr-app could not run, timed out or was killed");
  for (const row of rows) t.diagnostic(`${row.mod}: ${row.check.status} ${row.verdict}`);
  const by = Object.fromEntries(rows.map((row) => [row.mod, row]));
  assert.ok(by["am-tabs"].hard.some((d) => d.dep === "mod am-new-menu"));
  assert.ok(by["am-footer"].hard.some((d) => d.dep === "mod am-mods"));
  assert.deepEqual(readdirSync(scratch), [], "the run's homes are removed");
});

test("the script refuses the real app home before it copies anything", (t) => {
  const s = standInApp(tempFolder(t, "standalone-app-"), { version: "0.0.0-test" });
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, HERDR_APP_HOME: join(homedir(), ".config/herdr-app"), HERDR_APP_BIN: s.bin, PATH: `${s.binDir}:${process.env.PATH}` },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing/);
  assert.deepEqual(s.calls(), [], "refused before herdr-app was asked anything");
});
