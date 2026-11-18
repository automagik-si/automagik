// A local start's command, byte for byte (#582): the linked-machine briefing and pane-env must
// never change what a bot started on this computer gets. For a Claude bot (the briefing file and
// the per-turn hook), an omp bot (the briefing as text) and a Hermes bot (the briefing in its
// environment): the `hc run` argv with its `/usr/bin/env` words, the briefing file and the
// project's settings.local.json, scratch paths written as <root>. The project holds a
// .herdr/pane-env, which a local start never reads (it is for a linked machine's panes). The
// fixture is recorded from origin/dev in a fresh copy (AUTOMAGIK_GOLDEN_RECORD=1; the commit is
// named in the PR); every later run compares. #650 adds the CLI's own HERDR_APP_HOME beside
// PATH when the CLI has it set (this scene does), and only that word: with it unset, the bytes
// stay as they were (cli-local-app-home.test.mjs holds the fixture recorded before the fix).
// Fake hc and a scratch home only: the real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJsonLines } from "./log-lines.mjs";
import { GUARD_DIR, KILL_GUARD_DIR } from "../mods/am-sidebar/workers.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/local-start-argv.json", import.meta.url).pathname;
const OVERRIDE_FIXTURE = new URL("./fixtures/local-start-override-argv.json", import.meta.url).pathname;
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const BOTS = [
  { id: "b-claudeaaaa", name: "Genie", kind: "main", agent: "claude", model: "claude-opus-5-5" },
  { id: "b-ompaaaaaaa", name: "Omen", kind: "member", agent: "omp" },
  { id: "b-hermesaaaa", name: "Atlas", kind: "member", agent: "hermes" },
];
// #612: a local start with this computer's programs.json holding an absolute override.
const OVERRIDE = { id: "b-overtuiaaa", name: "Overt", kind: "member", agent: "dsh-tui" };

/**
 * One local start of `bot` in a fresh scratch world: what hc run got, and the files it wrote.
 * `bots`: the project's bots (default BOTS); `override`: an absolute programs.json run for the
 * bot's agent, its first word a program in the scratch bin.
 */
function startOne(t, bot, { bots = BOTS, override = null } = {}) {
  const root = scratchRoot(t, "hb-golden-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app");
  for (const d of [bin, home, join(app, "mods/am-sidebar")]) mkdirSync(d, { recursive: true });
  // No template: a runner's own init.templateDir can't change the exclude file the start writes.
  const project = scratchProject(root, "proj", { template: "" });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  for (const a of ["claude", "omp", "hermes"]) exe(join(bin, a), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(join(project, ".herdr/pane-env"), "PATH_PREPEND=/opt/node-22/bin\nHERDR_APP_HOME=/srv/bots/herdr-app\n");
  if (override) {
    exe(join(bin, override[0]), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(app, "programs.json"),
      `${JSON.stringify({ programs: { [bot.agent]: { run: [join(bin, override[0]), ...override.slice(1)] } } })}\n`);
  }
  const look = { character: "star", colour: "blue" };
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [],
    bots: bots.map((b) => ({ look, role: "r", instructions: "i", ...b, ...(b.kind === "member" ? { lead: bots[0].id } : {}) })) }, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: [], next: 100 }));
  writeFileSync(logPath, "");
  // A pinned PATH, so the pane's PATH is the same on every runner.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C", GIT_CEILING_DIRECTORIES: root };
  const r = spawnSync(process.execPath, [CLI, "start", bot.name, "--json"], { cwd: project, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // The briefing file's name starts with a hash of the project's folder, a new temp folder each run.
  const norm = (text) => (text === null ? null : text.split(root).join("<root>").split(KILL_GUARD_DIR).join("<hc-kill>").split(GUARD_DIR).join("<guard>")
    .replace(/(\/briefings\/)[0-9a-f]{10}-/g, "$1<hash>-")
    // RFC 0021: the session id a fresh Claude start runs on is random; only its place is pinned.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<session-id>"));
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const run = readJsonLines(logPath).find((c) => c[0] === "run");
  const file = run.find((w, i) => run[i - 1] === "--append-system-prompt-file") ?? null;
  return {
    argv: run.map(norm),
    briefingFile: file === null ? null : norm(read(file)),
    settings: norm(read(join(project, ".claude/settings.local.json"))),
    exclude: norm(read(join(project, ".git/info/exclude"))),
  };
}

test("a local start's argv, env words, briefing file and hook are byte-identical to before #582", (t) => {
  const seen = Object.fromEntries(BOTS.map((b) => [b.agent, startOne(t, b)]));
  if (process.env.AUTOMAGIK_GOLDEN_RECORD === "1") writeFileSync(FIXTURE, `${JSON.stringify(seen, null, 2)}\n`);
  const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const agent of Object.keys(want)) assert.deepEqual(seen[agent], want[agent], agent);
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(want).sort());
});

// #612: the shipped-run fallback is for a start on another machine only. A local start with this
// computer's programs.json override still runs exactly that override, model words and all; the
// fixture is recorded from the base before the fix (AUTOMAGIK_GOLDEN_RECORD=1) and only compared.
test("a local start with a programs.json override runs it byte for byte (#612)", (t) => {
  const seen = startOne(t, OVERRIDE, { bots: [...BOTS, OVERRIDE], override: ["dsh-tui-local", "--profile", "worker"] });
  if (process.env.AUTOMAGIK_GOLDEN_RECORD === "1") writeFileSync(OVERRIDE_FIXTURE, `${JSON.stringify(seen, null, 2)}\n`);
  const want = JSON.parse(readFileSync(OVERRIDE_FIXTURE, "utf8"));
  // Keep the base golden: only the DSH prompt prefix changes; its briefing stays byte-equal.
  const prompt = seen.argv.pop();
  assert.equal(prompt, `${OVERRIDE.name} - ${want.argv.at(-1)}`);
  seen.argv.push(prompt.slice(`${OVERRIDE.name} - `.length));
  assert.deepEqual(seen, want);
  // The override's absolute first word, never the shipped dsh-tui it would fall back to.
  const launched = seen.argv.slice(seen.argv.indexOf("--") + 1);
  assert.ok(launched.some((word) => word.endsWith("/bin/dsh-tui-local")), launched.join(" "));
  assert.equal(launched.includes("dsh-tui"), false, "the shipped command is not local");
});
