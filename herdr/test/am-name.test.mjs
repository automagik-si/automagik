// The command is `am` in everything a person or a bot reads: the help, the briefing and every
// message. The old name, automagik-herdr, stays a silent alias (RFC 0012 D22): its link runs the
// same CLI, prints the same text and says nothing about the rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODS = fileURLToPath(new URL("../mods/", import.meta.url));
const SIDEBAR = join(MODS, "am-sidebar");
const WRAPPER = join(SIDEBAR, "bin", "automagik-herdr");
const VERSION = readFileSync(join(SIDEBAR, "VERSION"), "utf8").trim();
const { USAGE, PROXY_USAGE } = await import("../mods/am-sidebar/bin/automagik-herdr.mjs");
const { PACK_MODS } = await import("../mods/am-sidebar/release.js");

/** The old name used as a command or a message prefix: a path (automagik-herdr/…) is not one. */
const OLD_NAME = /automagik-herdr[ :`]/;

test("the old command name still runs the CLI, says am, and says nothing about the rename", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-name-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, home, app]) mkdirSync(d);
  const old = join(bin, "automagik-herdr");
  symlinkSync(WRAPPER, old);
  const env = { HOME: home, HERDR_APP_HOME: app, PATH: "/usr/bin:/bin", AUTOMAGIK_HERDR_RUNTIME_DIRS: dirname(process.execPath), AUTOMAGIK_HERDR_NO_UPDATE: "1" };
  const run = (...args) => spawnSync(old, args, { encoding: "utf8", env, cwd: root });

  const version = run("--version");
  assert.deepEqual([version.status, version.stdout, version.stderr], [0, `am ${VERSION}\n`, ""]);

  const help = run("--help");
  assert.deepEqual([help.status, help.stdout, help.stderr], [0, `${USAGE}\n`, ""]);

  const unknown = run("nonsense");
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, `am: unknown command "nonsense"\n\n${USAGE}\n`);

  // Exact output above: nothing is added for the old name. And none of it names the old command.
  for (const r of [version, help, unknown]) assert.doesNotMatch(r.stdout + r.stderr, OLD_NAME);
});

test("the help names am, never the old command", () => {
  assert.match(USAGE, /^am: /);
  assert.match(USAGE, /^Usage: am <command> \[options\]/m);
  assert.match(USAGE, /^ {7}am --version {30}the installed pack's version$/m, "the columns still line up");
  assert.match(PROXY_USAGE, /^usage: am proxy approve /);
  for (const text of [USAGE, PROXY_USAGE]) assert.doesNotMatch(text, OLD_NAME);
});

// Every mod of the pack, its CLI and its launchers: no string a person or a bot reads names the
// old command. Comments are skipped. KEPT lists the three places that keep it on purpose.
const VERBS = ["ls", "show", "create", "edit", "rm", "category", "start", "restart", "attach", "detach", "import", "whois", "history", "brief",
  "briefing", "update", "tidy", "forget", "worker", "reap", "meter", "machines", "dsh-tui", "doc", "proxy", "launch-path", "revive"];
const AS_COMMAND = new RegExp(`automagik-herdr(?:: | <| \\$\\{| --| (?:${VERBS.join("|")})(?![\\w/.-]))`);
const KEPT = [
  // The Antigravity deny rules name both commands: the alias must stay refused too.
  ["am-sidebar/models.js", /^ {2}"command\(automagik-herdr (?:edit|restart|rm|create)\)",$/],
  // The login service's first line is how an installed unit is known as ours: changing it would
  // orphan every unit already installed.
  ["am-sidebar/revive.js", /^export const UNIT_MARK = /],
];
const withoutComments = (line, shell) => (shell ? line.replace(/^\s*#.*$/, "")
  : line.replace(/\/\*.*?\*\//g, "").replace(/^\s*(?:\/\*|\*).*$/, "").replace(/(^|\s)\/\/.*$/, ""));

test("no message in the pack names the old command", () => {
  const files = [];
  for (const mod of PACK_MODS) {
    for (const name of readdirSync(join(MODS, mod))) if (/\.m?js$/.test(name)) files.push(join(mod, name));
  }
  for (const name of readdirSync(join(SIDEBAR, "bin"))) files.push(join("am-sidebar", "bin", name));
  for (const dir of ["guard", "hc-kill", "pack"]) for (const name of readdirSync(join(SIDEBAR, dir))) if (!name.endsWith(".json")) files.push(join("am-sidebar", dir, name));
  assert.ok(files.includes("am-sidebar/bin/automagik-herdr.mjs") && files.includes("am-sidebar/briefingText.mjs") && files.includes("am-status/label.js"), files.join(" "));
  const hits = [];
  for (const file of files) {
    const shell = !/\.m?js$/.test(file);
    readFileSync(join(MODS, file), "utf8").split("\n").forEach((line, i) => {
      if (!AS_COMMAND.test(withoutComments(line, shell))) return;
      if (KEPT.some(([f, re]) => f === file && re.test(line))) return;
      hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the sweep above sees the old command where it is written", () => {
  for (const line of ["`automagik-herdr restart ${bot.id}`", "\"automagik-herdr: \"", "run automagik-herdr dsh-tui install again", "automagik-herdr <command>", "automagik-herdr --version"]) {
    assert.match(withoutComments(line, false), AS_COMMAND, line);
  }
  for (const line of ["join(appHome(), \"automagik-herdr\", \"x.json\")", "<app home>/automagik-herdr/attach.jsonl", "bin/automagik-herdr.mjs", "the automagik-herdr link",
    "  // `automagik-herdr update` reports why", " * `automagik-herdr brief`."]) {
    assert.doesNotMatch(withoutComments(line, false), AS_COMMAND, line);
  }
});
