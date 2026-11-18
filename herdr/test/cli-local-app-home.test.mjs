// #650: a local start (and restart) gives the pane the CLI's own app home as an env word when
// the CLI runs with HERDR_APP_HOME set, as a linked machine's pane gets the project's pane-env
// one (seatOnMachine). With it unset, the argv stays byte for byte as before: the fixture below
// was recorded from origin/dev's head (b48b02d5) by this test before the fix, and only compared.
// The guard rows then run the pack's own hc guard as a pane started this way would: the emitted
// word is the whole difference between a binding found in that app home's attach ledger and
// today's unbound refusal. Hermetic: a temp app home, a temp project, a stub hc and a stub
// pgrep; the real hc is never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GUARD_DIR, KILL_GUARD_DIR } from "../mods/am-sidebar/workers.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_PGREP = new URL("./fake-pgrep.mjs", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/local-start-no-app-home-argv.json", import.meta.url).pathname;

const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const ID = { main: "b-mainaaaaaa", dev: "b-devbbbbbbb" };
const BOTS = [
  { id: ID.main, name: "Genie", kind: "main" },
  { id: ID.dev, name: "Dev", kind: "member", lead: ID.main },
].map((b) => ({ ...b, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude" }));

// The guard's stub hc: Dev's pane t7 answers, any other address is not_found, and every call
// (send included) is one JSON argv line in the same log the CLI's fake hc writes.
const GUARD_STUB = `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HC_STUB_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "ls") { process.stdout.write(JSON.stringify({ terminals: [{ address: "t7", name: "dev", state: "live" }] }) + "\\n"); process.exit(0); }
if (args[0] === "get") {
  if (args[1] === "t7") { process.stdout.write(JSON.stringify({ address: "t7", state: "live", created_ms: 100, labels: { bot: "__PEER__" } }) + "\\n"); process.exit(0); }
  process.stderr.write(JSON.stringify({ error: { kind: "not_found" } }) + "\\n"); process.exit(3);
}
process.stdout.write("stub-out " + JSON.stringify(args) + "\\n"); process.exit(0);
`;

/**
 * One scratch world: a git project with Genie and Dev, a stub hc, a stub window and a temp app
 * home. `withAppHome` false runs the CLI with HERDR_APP_HOME unset (its default app home is
 * then `<home>/.config/herdr-app`). Dev's pane t7 is live there, Genie's send target.
 */
function scene(t, { withAppHome = true } = {}) {
  const root = scratchRoot(t, "hb-650-");
  // Not a folder named "home": privacy-check reads a "/home/<name>" path (even under <root>) as a
  // real home path. It is the scratch HOME all the same.
  const bin = join(root, "bin"), home = join(root, "box"), app = join(root, "app");
  const guardBin = join(root, "guard-bin");
  for (const d of [bin, home, app, guardBin]) mkdirSync(d, { recursive: true });
  const project = scratchProject(root, "proj", { template: "", bots: { version: 1, categories: [], bots: BOTS } });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  // The guard's own stub: the CLI's fake hc has no send (the CLI never sends), this one logs it.
  exe(join(guardBin, "hc"), `#!${process.execPath}\n${GUARD_STUB.replace("__PEER__", ID.dev)}`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\necho \"no window in tests\" >&2\nexit 1\n");
  exe(join(bin, "pgrep"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PGREP}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const peer = { address: "t7", name: "dev", cwd: project, state: "live", created_ms: 100, labels: { bot: ID.dev },
    foreground: { argv: ["claude"], cwd: project }, status: { app: "claude-code", state: "idle" } };
  writeFileSync(statePath, JSON.stringify({ terminals: [peer], next: 100 }));
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, LANG: "C",
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "100", GIT_CEILING_DIRECTORIES: root };
  if (withAppHome) env.HERDR_APP_HOME = app;
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
  return { root, project, bin, guardBin, home, app, statePath, logPath, env, cli };
}

const runs = (s) => readJsonLines(s.logPath).filter((call) => call[0] === "run");
const afterDash = (run) => run.slice(run.indexOf("--") + 1);
const calls = (s) => readJsonLines(s.logPath);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A scratch path as the fixture records it: the temp root, the guard folder, the briefing hash. */
const norm = (root) => (word) => word.split(root).join("<root>").split(KILL_GUARD_DIR).join("<hc-kill>").split(GUARD_DIR).join("<guard>")
  .replace(/(\/briefings\/)[0-9a-f]{10}-/g, "$1<hash>-")
  // RFC 0021: a fresh Claude start's session id is random; only its place is pinned.
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<session-id>");

/** The env word a start emitted (`HERDR_APP_HOME=...`), or null. */
const appHomeWord = (run) => afterDash(run).find((word) => word.startsWith("HERDR_APP_HOME=")) ?? null;

const guardRun = (s, terminal, word) => spawnSync(process.execPath, [join(GUARD_DIR, "hc"), "send", "t7", "hi"], {
  env: { PATH: `${GUARD_DIR}:${s.guardBin}:/usr/bin:/bin`, HOME: s.home, HC_TERMINAL_ID: terminal,
    HC_STUB_LOG: s.logPath, ...(word ? { HERDR_APP_HOME: word } : {}) },
  encoding: "utf8",
});

test("a local start with HERDR_APP_HOME set puts it in the pane's env word (#650)", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const words = afterDash(runs(s)[0]);
  // The default Claude login's -u first (env takes options before assignments), then PATH, then
  // the app home word before the agent, as seatOnMachine puts a linked machine's.
  assert.deepEqual(words.slice(0, 5), ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", `PATH=${KILL_GUARD_DIR}:${s.bin}:/usr/bin:/bin`, `HERDR_APP_HOME=${s.app}`]);
  assert.equal(words[5], "claude");
});

test("a local restart puts HERDR_APP_HOME in the pane's env word too (#650)", (t) => {
  const s = scene(t);
  assert.equal(s.cli(["start", "Genie", "--json"]).status, 0);
  // The fake's new pane is mid-turn: an idle one is what a restart replaces.
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.labels?.bot === ID.main).status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const words = afterDash(runs(s)[1]);
  assert.equal(words[words.findIndex((word) => word.startsWith("PATH=")) + 1], `HERDR_APP_HOME=${s.app}`);
});

test("a local start with HERDR_APP_HOME unset is byte-identical to before #650", (t) => {
  const s = scene(t, { withAppHome: false });
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const seen = afterDash(runs(s)[0]).map(norm(s.root));
  if (process.env.AUTOMAGIK_GOLDEN_RECORD === "1") writeFileSync(FIXTURE, `${JSON.stringify(seen, null, 2)}\n`);
  assert.deepEqual(seen, JSON.parse(readFileSync(FIXTURE, "utf8")));
  assert.equal(seen.some((word) => word.startsWith("HERDR_APP_HOME=")), false, "no word without the CLI's app home");
});

test("a pane started this way resolves its hc guard binding from that app home (#650)", (t) => {
  const s = scene(t);
  const started = s.cli(["start", "Genie", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const terminal = JSON.parse(started.stdout).terminal;
  const word = appHomeWord(runs(s)[0]);
  assert.ok(word, "the start emitted the word");
  writeFileSync(s.logPath, "");
  const r = guardRun(s, terminal, word.slice(word.indexOf("=") + 1));
  assert.equal(r.status, 0, r.stderr);
  // Bound in the app home's ledger: no worker.of fallback (an hc get of t100), and the send runs.
  assert.deepEqual(calls(s), [["ls", "--json"], ["get", "t7", "--json"], ["send", "t7", "hi"]], "the allowed send reached the stub");
});

test("without the word, the same send is refused as unbound (#650)", (t) => {
  const s = scene(t);
  const started = s.cli(["start", "Genie", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const terminal = JSON.parse(started.stdout).terminal;
  assert.ok(appHomeWord(runs(s)[0]), "the start emitted the word this row leaves out, as today's argv does");
  writeFileSync(s.logPath, "");
  const r = guardRun(s, terminal, null);
  assert.notEqual(r.status, 0, "an unbound caller is refused");
  assert.match(r.stderr, /neither bound in the attach ledger nor a worker pane/);
  assert.equal(calls(s).some((call) => same(call, ["send", "t7", "hi"])), false, "the stub never got the send");
});
