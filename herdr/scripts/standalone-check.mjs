#!/usr/bin/env node
// Standalone check for each am-* mod: may it be listed on herdr.dev on its own?
//
// The owner's gate (2026-11-03): copied ALONE into an empty app home (no am-sidebar, no
// hc/herdr-core, no installer, no hooks, no private server), `herdr-app check` passes AND the mod
// has no dead references to other mods. Per mod in mods/am-*, this script
//   1. copies only mods/<name>/ into a fresh scratch app home and runs `herdr-app check` there
//      (skipped, with a note, where no herdr-app answers --version);
//   2. lists, statically, what the mod reaches outside its own folder: other mods and layout nodes
//      that Herdr does not ship, hc/herdr-core calls, programs it executes (node, usagemeter, …),
//      network hosts, and reads of installer state (data/am-mods/catalog.json, ownership record).
// It prints `mod | check | hard deps | optional | verdict` (markdown, or JSON with --json).
//
// The scratch homes live under $HERDR_APP_HOME (a fresh folder per run, removed afterwards), or
// under the system temp folder when it is unset. The real app home is refused: nothing here
// writes ~/.config/herdr-app. The scan is a reader of source text; a mod's code never runs here
// (`herdr-app check` loads and renders a mod once; it does not run the programs a mod executes).
// `herdr-app check` runs the mod's init() for real, and a mod may call Herdr's hc API there and
// contact a live core: run this only on a machine with no live Herdr (the tests use a stand-in).
//
//   node scripts/standalone-check.mjs [--json] [--no-check] [--keep]

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MODS = join(ROOT, "mods");

/** Mods Herdr itself ships (found in the Herdr 0.1.12 binary): a reference to one is not a dependency. */
export const BUILTIN_MODS = new Set([
  "agents", "board", "changes", "clippy", "desktop", "files", "machine-add", "menu", "new-menu",
  "pane", "picker", "settings", "spaces", "taskbar", "workspace-chrome", "workspace-status", "worktree",
]);
/** Node ids in Herdr's own default layouts (same binary): toggling one of these is not a dependency. */
export const BUILTIN_NODES = new Set([
  "agents", "board", "brand", "changes", "clippy", "desktop", "files", "main", "panel", "panel-body",
  "root", "screen", "sidebar", "sidebar-footer", "sidebar-lists", "spaces", "status", "taskbar",
  "tabs", "work", "work-body",
]);
/** Programs any Unix (or the app itself) has: executing them needs nothing from another mod or service. */
export const SYSTEM_PROGRAMS = new Set([
  "cat", "chmod", "cp", "env", "find", "git", "herdr-app", "ls", "mkdir", "mv", "open", "osascript",
  "powershell", "printf", "rm", "sh", "sips", "tar", "test", "true", "wc",
]);
/** Hosts that only appear as XML namespaces, never contacted. */
const NOT_HOSTS = new Set(["www.w3.org"]);
const INSTALLER = /data\/am-mods|catalog\.json|\bownership\b|mod-manager/;

/**
 * What a reader confirmed that the scan cannot see: `soft` (the code runs only behind a presence
 * probe) or `drop` (not a dependency). Each entry must still match a dependency the scan finds;
 * the test fails on a stale one.
 */
export const REVIEWED = {
  "am-footer": [
    { dep: "exec node", soft: "runs only after the pocket-link probe found Pocket Link (main.js:104-111)" },
    { dep: "file ~/.local/state", soft: "Pocket Link's status folder, in that node script (main.js:16)" },
  ],
  "am-automations": [
    { dep: "file ~/Projects/myapp", drop: "the repo field's placeholder text, never read" },
  ],
};

/** A line that is only a comment (`//`, `/*`, ` * `; `#` in a shell script): prose, not references. */
const commentLine = (line, shell) => (shell ? /^\s*#/ : /^\s*(\/\/|\/\*|\*)/).test(line);
/** A call that starts a program: Herdr's exec, an injected io.exec, or node:child_process (not `re.exec`). */
const EXEC = String.raw`(?:(?<![\w$.])|\bio\.)(?:exec|execFile|execFileSync|spawn|spawnSync)\(\s*`;
/** Programs a shell script may start that come from outside the system. */
const SHELL_PROGRAMS = /(?:^|[\s;|&(`])(node|bun|hc|herdr-core|usagemeter|curl|wget|gh|security)(?=[\s;|&)`]|$)/g;

/**
 * What one mod reaches outside its own folder, from its source text.
 * `files` maps a path (relative to the mod folder) to its text; `self` is the mod's folder name.
 * Each reference is { kind, target, at, soft }: `soft` marks a presence probe (the mod looks for
 * the other mod and works without it), which is reported as optional, not as a hard dependency.
 */
export function scanMod(self, files) {
  const refs = [];
  // `touch`: listed for the reader (a system program, a file in the app home), not a dependency.
  const add = (kind, target, at, soft = false, touch = false) => refs.push({ kind, target, at, soft, touch });
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split("\n");
    const shell = file.endsWith(".sh");
    lines.forEach((full, i) => {
      if (commentLine(full, shell)) return;
      // A shell script's echo/printf is a message to the person: its words start nothing.
      const line = shell ? full.replace(/(?:^|[;&|]\s*)(?:echo|printf)\s.*$/, "") : full;
      const at = `${file}:${i + 1}`;
      const mod = (name, soft = false) => {
        if (name !== self && !BUILTIN_MODS.has(name)) add("mod", name, at, soft);
      };
      // Other mods: opened as an overlay or a tab, by mod.open, by a key binding, or by path.
      for (const m of line.matchAll(/\bmod:\s*["'`]([a-z0-9-]+)["'`]/g)) mod(m[1]);
      for (const m of line.matchAll(/["'`]mod\.open["'`],\s*\{[^}]*\bname:\s*["'`]([a-z0-9-]+)["'`]/g)) mod(m[1]);
      for (const m of line.matchAll(/["'`]mod\.open:([a-z0-9-]+)["'`]/g)) mod(m[1]);
      for (const m of line.matchAll(/mods\/([a-z0-9-]+)\/([A-Za-z0-9._/-]*)/g)) {
        // readTextFile(`…/mods/<x>/mod.json`) asks whether <x> is installed: optional by design.
        const probe = m[2] === "mod.json" && /readTextFile\(/.test(line);
        mod(m[1], probe);
      }
      // Layout nodes: shown, hidden, toggled, resized or looked up by id.
      for (const m of line.matchAll(/["'`]layout\.(?:toggle|show|hide|select|resize)["'`],\s*\{([^}]*)\}/g)) {
        for (const n of m[1].matchAll(/\b(?:id|stack|child):\s*["'`]([a-z0-9-]+)["'`]/g)) {
          if (!BUILTIN_NODES.has(n[1])) add("node", n[1], at);
        }
      }
      for (const m of line.matchAll(/find\(layout\(\),\s*["'`]([a-z0-9-]+)["'`]\)/g)) {
        if (!BUILTIN_NODES.has(m[1])) add("node", m[1], at);
      }
      // herdr-core: the `hc(...)` call Herdr's module exports, or the program itself.
      if (/(?<![\w.$])hc\(\s*\[/.test(line)) add("hc", "hc", at);
      // Programs executed. Every one is listed: one from outside the system is a dependency, a
      // system program, a `sh -c` script or a program named at run time is listed under "runs".
      for (const m of line.matchAll(new RegExp(`${EXEC}["'\`]([A-Za-z0-9._-]+)["'\`](\\s*,\\s*\\[\\s*["'\`]-c["'\`])?`, "g"))) {
        const prog = m[1];
        if (prog === "hc" || prog === "herdr-core") add("hc", prog, at);
        else if (!SYSTEM_PROGRAMS.has(prog)) add("exec", prog, at);
        else add("run", m[2] && prog === "sh" ? "sh -c" : prog, at, false, true);
      }
      for (const m of line.matchAll(new RegExp(`${EXEC}([A-Za-z_$][\\w$.]*)\\s*[,)]`, "g"))) {
        add("run", `program from ${m[1]}`, at, false, true);
      }
      if (shell) {
        for (const m of line.matchAll(SHELL_PROGRAMS)) {
          if (m[1] === "hc" || m[1] === "herdr-core") add("hc", m[1], at);
          else add("exec", m[1], at);
        }
      }
      if (/\busagemeter\b/.test(line)) add("exec", "usagemeter", at);
      // Network: every literal host, and every fetch of a URL computed at run time (where it
      // points cannot be read from the source: a configured server until a reader shows otherwise).
      for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        if (!NOT_HOSTS.has(m[1])) add("net", m[1], at);
      }
      if (/\bfetch\(\s*[^"'\s)]/.test(line)) add("net", "computed URL", at);
      // Files outside the mod folder: under the person's home (a dependency: another tool's state)
      // or elsewhere in the app home (listed under "runs").
      // `home()`/`homedir()` is the person's home; a plain `home` may be either, so only its
      // dot-folders (~/.config, ~/.codex …) count.
      const homeFiles = shell
        ? [...line.matchAll(/(?:\$HOME|\$\{HOME\}|~)(\/[\w.-][\w.\/-]*)/g)]
        : [...line.matchAll(/["'`]~(\/[\w.-][^"'`]*)/g), ...line.matchAll(/\$\{home(?:dir)?\(\)\}(\/[^"'`$]*)/g),
          ...line.matchAll(/\$\{home\}(\/\.[^"'`$]*)/g),
          ...line.matchAll(/join\(\s*home(?:dir)?\(\)\s*,\s*["'`]([^"'`]+)/g), ...line.matchAll(/join\(\s*home\s*,\s*["'`](\.[^"'`]+)/g)];
      for (const m of homeFiles) add("file", `~${m[1].startsWith("/") ? "" : "/"}${m[1].replace(/[.,]+$/, "")}`, at);
      for (const m of line.matchAll(/\$\{appHome(?:\(\))?\}\/([^"'`\s]*)/g)) {
        if (!m[1].startsWith("mods")) add("file", `<app home>/${m[1]}`, at, false, true);
      }
      // Installer state: the pack installer's catalog and ownership record.
      const inst = INSTALLER.exec(line);
      if (inst) add("installer", inst[0], at);
    });
  }
  return refs;
}

/** One line per distinct dependency: `mod am-new-menu (main.js:164)`. */
const label = (r) => r.kind === "hc" || r.kind === "run" ? r.target
  : `${r.kind === "installer" ? "installer state" : r.kind} ${r.target}`;

/**
 * The distinct dependencies of a scan, hard and optional, each with its first location. A mod the
 * scan saw probed is optional everywhere: its other references sit behind that probe.
 * `reviewed` is the mod's REVIEWED list.
 */
export function summarize(input, reviewed = []) {
  const probed = new Set(input.filter((r) => r.kind === "mod" && r.soft).map((r) => r.target));
  const verdicts = new Map(reviewed.map((v) => [v.dep, v]));
  const refs = input
    .map((r) => ({ ...r, soft: r.soft || (r.kind === "mod" && probed.has(r.target)) || Boolean(verdicts.get(label(r))?.soft) }))
    .filter((r) => !verdicts.get(label(r))?.drop);
  const hard = new Map(), soft = new Map(), touches = new Map();
  const put = (m, r) => m.has(label(r)) || m.set(label(r), r.at);
  for (const r of refs) if (r.touch) put(touches, r);
  for (const r of refs) if (!r.touch && !r.soft) put(hard, r);
  for (const r of refs) if (!r.touch && r.soft && !hard.has(label(r))) put(soft, r);
  const list = (m) => [...m].map(([dep, at]) => ({ dep, at }));
  return { hard: list(hard), optional: list(soft), touches: list(touches) };
}

/**
 * What the mod needs; `standalone` only when nothing hard is reached AND herdr-app check really ran
 * and passed. With the check skipped, a clean scan is `standalone (unchecked)`.
 */
export function verdictOf(check, hard) {
  const needs = hard.map((h) => h.dep);
  if (check.status === "fail") needs.unshift("a passing check");
  if (needs.length) return `needs ${needs.join(", ")}`;
  return check.status === "pass" ? "standalone" : "standalone (unchecked)";
}

/** The mod's .js/.mjs/.sh files, relative to its folder. */
function sources(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|sh)$/.test(e.name)) out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** The herdr-app to run, or null: $HERDR_APP_BIN, else `herdr-app` on PATH. */
function findHerdrApp() {
  const bin = process.env.HERDR_APP_BIN || "herdr-app";
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
  return r.error || r.status !== 0 ? null : { bin, version: r.stdout.trim() };
}

/** `herdr-app check` of one mod, alone in a fresh app home under `runDir`. */
function checkAlone(app, name, runDir) {
  const home = join(runDir, name);
  const folder = join(home, "mods", name);
  mkdirSync(join(home, "mods"), { recursive: true });
  cpSync(join(MODS, name), folder, { recursive: true });
  const r = spawnSync(app.bin, ["check", folder], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HERDR_APP_HOME: home },
  });
  // A check that could not start, timed out or was killed says nothing about the mod: marked crashed.
  if (r.error || r.signal) {
    const why = r.error ? String(r.error.message ?? r.error) : `killed by ${r.signal}`;
    return { status: "fail", crashed: true, detail: why };
  }
  if (r.status === 0) return { status: "pass", detail: "" };
  const out = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = out.find((l) => !l.startsWith("at ") && !l.startsWith("check failed")) ?? out[0] ?? `exit ${r.status}`;
  return { status: "fail", detail: first.replaceAll(home, "<home>") };
}

/** A path with its existing part resolved through symlinks (the rest need not exist yet). */
function real(p) {
  const rest = [];
  let at = resolve(p);
  for (;;) {
    try { return join(realpathSync(at), ...rest.reverse()); } catch {}
    const up = dirname(at);
    if (up === at) return resolve(p);
    rest.push(basename(at));
    at = up;
  }
}

/** Whether `p` is `dir` or anything inside it. */
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The folder scratch homes go under. Refused: the home folder itself, and the real app home or
 * anything inside it (HERDR_APP_HOME=~/.config/herdr-app/mods would copy mods into the live ones).
 */
export function scratchBase(env = process.env, home = homedir()) {
  const base = real(env.HERDR_APP_HOME || tmpdir());
  const appHome = real(join(home, ".config/herdr-app"));
  if (base === real(home) || within(base, appHome)) {
    throw new Error(`refusing to use ${base}: set HERDR_APP_HOME to a scratch folder, never the real app home or your home folder`);
  }
  return base;
}

/** Every am-* mod's row. `check: false` skips herdr-app. */
export function run({ check = true, keep = false, env = process.env } = {}) {
  const names = readdirSync(MODS).filter((n) => n.startsWith("am-") && statSync(join(MODS, n)).isDirectory()).sort();
  const base = check ? scratchBase(env) : null;   // refused before anything runs
  const app = check ? findHerdrApp() : null;
  const skipped = check ? "skipped: herdr-app not installed" : "skipped: --no-check";
  let runDir = null;
  if (app) {
    mkdirSync(base, { recursive: true });
    runDir = mkdtempSync(join(base, "standalone-"));
  }
  try {
    const rows = names.map((name) => {
      const c = app ? checkAlone(app, name, runDir) : { status: "skipped", detail: skipped };
      const { hard, optional, touches } = summarize(scanMod(name, sources(join(MODS, name))), REVIEWED[name]);
      return { mod: name, check: c, hard, optional, runs: touches, verdict: verdictOf(c, hard) };
    });
    return { herdrApp: app?.version ?? null, skipped: app ? null : skipped, rows };
  } finally {
    if (runDir && !keep) rmSync(runDir, { recursive: true, force: true });
  }
}

const cell = (s) => String(s).replaceAll("|", "\\|");

/** The markdown table. */
export function table({ herdrApp, skipped, rows }) {
  const out = [
    herdrApp ? `checked with ${herdrApp}, each mod alone in an empty app home` : `herdr-app check ${skipped}`,
    "",
    "| mod | check | hard deps | optional (probed) | runs (system programs, app-home files) | verdict |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const check = r.check.status === "fail" ? `FAIL: ${r.check.detail}` : r.check.status === "skipped" ? "skipped" : "pass";
    const deps = (l) => (l.length ? l.map((d) => `${d.dep} (${d.at})`).join("<br>") : "—");
    out.push(`| ${r.mod} | ${cell(check)} | ${cell(deps(r.hard))} | ${cell(deps(r.optional))} | ${cell(deps(r.runs))} | ${cell(r.verdict)} |`);
  }
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  try {
    const result = run({ check: !args.has("--no-check"), keep: args.has("--keep") });
    process.stdout.write(args.has("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${table(result)}\n`);
  } catch (e) {
    process.stderr.write(`standalone-check: ${e.message}\n`);
    process.exit(2);
  }
}
