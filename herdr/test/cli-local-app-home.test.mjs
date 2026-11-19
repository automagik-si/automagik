import { startFakeCore } from "./fake-core.mjs";
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachPath, readAttach as readRows } from "../mods/am-sidebar/attach.js";
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
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, { ...core.env });
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

// #1195: one project, one fake core, two app homes whose Claude records select different
// synthetic login folders. Genie starts with the project's home explicit (login B); the restart
// is then typed from Genie's own pane with HERDR_APP_HOME unset, so the CLI falls back to the
// default home (login A). The pane's launch words are the only carried context.
const cliWith = (s, over, drop, args) => {
  const env = { ...s.env, ...over };
  for (const name of drop) delete env[name];
  return spawnSync(process.execPath, [CLI, ...args], { cwd: s.project, env, encoding: "utf8" });
};
const restartFrom = (s, terminal, args) => cliWith(s, { HC_TERMINAL_ID: terminal }, ["HERDR_APP_HOME"], args);
const liveFor = (s, bot) => JSON.parse(readFileSync(s.statePath, "utf8")).terminals
  .filter((x) => x.state === "live" && x.labels?.bot === bot);
const envWord = (run, name) => afterDash(run).find((word) => word.startsWith(`${name}=`)) ?? null;
const fileOrNull = (path) => (existsSync(path) ? readFileSync(path) : null);

function twoHomes(t) {
  const s = scene(t);
  const fallback = join(s.home, ".config", "herdr-app");
  const loginA = join(s.root, "claude-a"), loginB = join(s.root, "claude-b");
  for (const d of [fallback, loginA, loginB]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fallback, "claude-logins.json"), JSON.stringify({ use: "a", logins: [{ id: "a", dir: loginA }] }));
  writeFileSync(join(s.app, "claude-logins.json"), JSON.stringify({ use: "b", logins: [{ id: "b", dir: loginB }] }));
  const started = s.cli(["start", "Genie", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const terminal = JSON.parse(started.stdout).terminal;
  assert.equal(envWord(runs(s)[0], "CLAUDE_CONFIG_DIR"), `CLAUDE_CONFIG_DIR=${loginB}`, "started on the project home's login");
  // An idle pane is what a restart replaces now, not queues.
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.address === terminal).status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
  return { s, fallback, loginA, loginB, terminal };
}

for (const ledger of ["absent", "stale"]) {
  test(`#1195 restart from the bot's own pane with HERDR_APP_HOME unset replaces it on its login (default ledger ${ledger})`, (t) => {
    const { s, fallback, loginA, loginB, terminal } = twoHomes(t);
    const row = readRows(readFileSync(attachPath(s.app), "utf8")).rows.at(-1);
    if (ledger === "stale") {
      // The default home once recorded Genie on a pane that is gone now.
      mkdirSync(join(fallback, "automagik-herdr"), { recursive: true });
      writeFileSync(attachPath(fallback), `${JSON.stringify({ ...row, terminal: "t3", created_ms: 1 })}\n`);
    }
    const before = fileOrNull(attachPath(fallback));
    writeFileSync(s.logPath, "");
    const r = restartFrom(s, terminal, ["restart", "Genie", "--json"]);
    // The fake hc ends the CLI as the real kill of its own pane would: what it printed first stands.
    assert.ok(r.stdout.trim(), r.stderr);
    assert.equal(JSON.parse(r.stdout).replaced, terminal, r.stderr);
    assert.deepEqual(calls(s).at(-1), ["kill", terminal], "the kill of its own pane is the last hc call");
    const launches = runs(s);
    assert.equal(launches.length, 1, "one replacement, never a twin");
    assert.equal(envWord(launches[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${s.app}`, "the carried app home");
    assert.equal(envWord(launches[0], "CLAUDE_CONFIG_DIR"), `CLAUDE_CONFIG_DIR=${loginB}`, "the old pane's login");
    assert.ok(!afterDash(launches[0]).includes(`CLAUDE_CONFIG_DIR=${loginA}`), "never the default home's login");
    assert.ok(calls(s).some((call) => call[0] === "kill" && call[1] === terminal), "the original pane ended");
    const live = liveFor(s, ID.main);
    assert.equal(live.length, 1, `exactly one live seat: ${live.map((x) => x.address).join(", ")}`);
    assert.notEqual(live[0].address, terminal);
    const whois = s.cli(["whois", "--bot", ID.main, "--json"]);
    assert.equal(whois.status, 0, whois.stderr);
    assert.equal(JSON.parse(whois.stdout).terminal, live[0].address, "the project home binds the new pane");
    assert.deepEqual(fileOrNull(attachPath(fallback)), before, "the default ledger stays absent or byte-identical");
  });
}

test("#1195 two live labels for one bot: restart refuses before any launch or kill, and show says duplicate", (t) => {
  const { s, fallback, terminal } = twoHomes(t);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const original = state.terminals.find((x) => x.address === terminal);
  state.terminals.push({ ...original, address: "t50", name: "twin", created_ms: original.created_ms + 1 });
  writeFileSync(s.statePath, JSON.stringify(state));
  const before = fileOrNull(attachPath(fallback)), project = readFileSync(attachPath(s.app));
  writeFileSync(s.logPath, "");
  const r = restartFrom(s, terminal, ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).refused, "duplicate");
  assert.match(r.stderr, new RegExp(`duplicate live labels in .*${terminal}`));
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or killed");
  assert.deepEqual(fileOrNull(attachPath(fallback)), before, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(s.app)), project, "the project home's ledger untouched");
  const show = s.cli(["show", "Genie", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).duplicate, true);
});

test("#1195 keeps the Accounts switch: an explicit-home restart of a recorded seat moves login A to B", (t) => {
  const s = scene(t);
  const loginA = join(s.root, "claude-a"), loginB = join(s.root, "claude-b");
  for (const d of [loginA, loginB]) mkdirSync(d);
  const logins = (use) => writeFileSync(join(s.app, "claude-logins.json"),
    JSON.stringify({ use, logins: [{ id: "a", dir: loginA }, { id: "b", dir: loginB }] }));
  logins("a");
  const started = s.cli(["start", "Genie", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(envWord(runs(s)[0], "CLAUDE_CONFIG_DIR"), `CLAUDE_CONFIG_DIR=${loginA}`);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.labels?.bot === ID.main).status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
  logins("b"); // the Accounts panel's switch, applied by an ordinary restart
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envWord(runs(s)[1], "CLAUDE_CONFIG_DIR"), `CLAUDE_CONFIG_DIR=${loginB}`, "the switch applies");
  assert.equal(liveFor(s, ID.main).length, 1);
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

// #1128: a restart typed without HERDR_APP_HOME must resolve the same app-home context the
// project's bot was started in, or refuse before it writes a row. The project's own app home
// (RFC 0021 delivery 3, `<project>/.herdr/app-home`) is the one other context the command can
// derive from the project itself. HERDR_APP_HOME, when unset, falls back to the default home.
const projectHomePath = (s) => join(s.project, ".herdr", "app-home");
const withProjectHome = (s) => {
  const dir = projectHomePath(s);
  mkdirSync(join(dir, "mods", "am-sidebar"), { recursive: true });
  writeFileSync(join(dir, "mods", "am-sidebar", "briefing.mjs"), "// stand-in\n");
  return dir;
};
const defaultHomePath = (s) => join(s.home, ".config", "herdr-app");
const defaultLedgerPath = (s) => attachPath(defaultHomePath(s));
const startIn = (s, dir) => {
  const r = cliWith(s, { HERDR_APP_HOME: dir }, [], ["start", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).terminal;
};
const endPane = (s, terminal) => {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.address === terminal).state = "finished";
  writeFileSync(s.statePath, JSON.stringify(state));
};
/** hc no longer knows the terminal at all: a reboot, or `hc rm` (no ended launch to retain). */
const forgetPane = (s, terminal) => {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals = state.terminals.filter((x) => x.address !== terminal);
  writeFileSync(s.statePath, JSON.stringify(state));
};
const attachRowsIn = (dir) => (existsSync(attachPath(dir)) ? readRows(readFileSync(attachPath(dir), "utf8")).rows : []);
const writeStaleDefaultRow = (s, row) => {
  mkdirSync(join(defaultHomePath(s), "automagik-herdr"), { recursive: true });
  writeFileSync(defaultLedgerPath(s), `${JSON.stringify({ ...row, terminal: "t3", created_ms: 1 })}\n`, { mode: 0o600 });
};
/** The label is a display hint (the README's "relabelling a pane moves no bot"): drop it, as a
 * person can with `hc label`, while the ledger row still proves the pane. */
const dropLabel = (s, terminal) => {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const pane = state.terminals.find((x) => x.address === terminal);
  delete pane.labels?.bot;
  writeFileSync(s.statePath, JSON.stringify(state));
};
/** A live pane is what a restart replaces: its turn has to be idle first. */
const idlePane = (s, terminal) => {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.address === terminal).status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
};

test("#1128 restart without HERDR_APP_HOME writes the project's app home, never the default one", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  endPane(s, terminal);
  const before = fileOrNull(defaultLedgerPath(s));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.replaced, null, "its pane was gone: a start, never a twin");
  const launches = runs(s);
  assert.equal(launches.length, 1, "one replacement");
  assert.equal(envWord(launches[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${home}`, "the next pane carries the resolved home");
  assert.equal(fileOrNull(defaultLedgerPath(s)), before, "the default ledger stays absent");
  const bound = attachRowsIn(home).filter((row) => row.event === "attach").at(-1);
  assert.equal(bound.bot, ID.main);
  assert.equal(bound.terminal, out.terminal, "the project home binds the new pane");
  assert.equal(liveFor(s, ID.main).length, 1, "exactly one live seat");
});

test("#1128 restart without app-home context refuses two ledgers that both name the bot", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  forgetPane(s, terminal);
  writeStaleDefaultRow(s, attachRowsIn(home).at(-1));
  const beforeDefault = readFileSync(defaultLedgerPath(s)), beforeProject = readFileSync(attachPath(home));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).refused, "app-home");
  assert.match(r.stderr, /bindings in two app homes/);
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or ended");
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the project home's ledger untouched");
});

test("#1128 restart without the word recovers a live pane whose launch carries no app-home word", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  // A pane started before #650 carries no app-home word; the row in the project home is the proof.
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const pane = state.terminals.find((x) => x.address === terminal);
  pane.argv = pane.argv.filter((word) => !word.startsWith("HERDR_APP_HOME="));
  pane.status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
  const before = fileOrNull(defaultLedgerPath(s));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).replaced, terminal, "the live pane is replaced, never twinned");
  assert.equal(envWord(runs(s)[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${home}`);
  assert.equal(fileOrNull(defaultLedgerPath(s)), before, "no row written to the default ledger");
  assert.equal(liveFor(s, ID.main).length, 1);
});

test("#1128 restart without app-home context retains the home an ended pane was launched with", (t) => {
  const s = scene(t);
  const away = join(s.root, "away-app");
  mkdirSync(away, { recursive: true });
  const terminal = startIn(s, away);
  // The agent ended but hc still keeps the terminal: its launch word names the home.
  endPane(s, terminal);
  const before = fileOrNull(defaultLedgerPath(s));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envWord(runs(s)[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${away}`, "the retained home, not the default");
  assert.equal(fileOrNull(defaultLedgerPath(s)), before, "the default ledger stays absent");
  assert.equal(attachRowsIn(away).filter((row) => row.event === "attach").at(-1).bot, ID.main);
  assert.equal(liveFor(s, ID.main).length, 1);
});

test("#1128 revive from either app-home context never duplicates a live bot", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  // A split from before the fix: the default ledger also names the bot, on a pane that is gone.
  writeStaleDefaultRow(s, attachRowsIn(home).at(-1));
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.find((x) => x.address === terminal).status.state = "idle";
  writeFileSync(s.statePath, JSON.stringify(state));
  writeFileSync(s.logPath, "");
  // Without HERDR_APP_HOME: the default ledger's row is stale, but a live pane carries the label
  // in the project home. Revive leaves that live bot alone; it never starts a twin.
  const implicit = cliWith(s, {}, ["HERDR_APP_HOME"], ["revive", "--json"]);
  assert.equal(implicit.status, 0, implicit.stderr);
  assert.deepEqual(runs(s), [], "the live bot is not restarted or twinned");
  assert.match(JSON.stringify(JSON.parse(implicit.stdout)), /live pane carries its label/);
  assert.equal(liveFor(s, ID.main).length, 1);
  // With the project home explicit, the same live bot is left alone.
  const explicit = cliWith(s, { HERDR_APP_HOME: home }, [], ["revive", "--json"]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(runs(s), []);
  assert.equal(liveFor(s, ID.main).length, 1);
  // Its pane is gone for good: the explicit context brings it back once, in the project home.
  endPane(s, terminal);
  const back = cliWith(s, { HERDR_APP_HOME: home }, [], ["revive", "--json"]);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(runs(s).length, 1, "brought back once");
  assert.equal(envWord(runs(s)[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${home}`);
  assert.equal(liveFor(s, ID.main).length, 1);
  // From the default context again: the stale row and the live replacement are still no twin.
  writeFileSync(s.logPath, "");
  const again = cliWith(s, {}, ["HERDR_APP_HOME"], ["revive", "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(runs(s), [], "the live replacement is left alone");
  assert.equal(liveFor(s, ID.main).length, 1);
  // Both ledgers now name the bot on a pane that is gone: revive reports the conflict and
  // starts nothing, rather than choosing an authority.
  writeFileSync(s.logPath, "");
  forgetPane(s, JSON.parse(back.stdout).projects[0].results[0].terminal);
  const beforeDefault = readFileSync(defaultLedgerPath(s)), beforeProject = readFileSync(attachPath(home));
  const conflict = cliWith(s, {}, ["HERDR_APP_HOME"], ["revive", "--json"]);
  assert.equal(conflict.status, 1, "the pass could not reconcile it");
  assert.deepEqual(runs(s), [], "nothing started");
  assert.match(JSON.stringify(JSON.parse(conflict.stdout)), /two app homes/);
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the project home's ledger untouched");
});

// The Tester's F1 (#1128): the live binding is in the project's own app home, its pane lost the
// display label, and the selected (default) home still has a stale row. Live must win; the row
// in the default home is not authority and is not written.
test("#1128 a live project-home binding beats a stale default row on restart, label lost", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  writeStaleDefaultRow(s, attachRowsIn(home).at(-1));
  dropLabel(s, terminal);
  idlePane(s, terminal);
  const beforeDefault = readFileSync(defaultLedgerPath(s));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).replaced, terminal, "the live project-home pane is replaced, never twinned");
  const launches = runs(s);
  assert.equal(launches.length, 1, "one replacement");
  assert.equal(envWord(launches[0], "HERDR_APP_HOME"), `HERDR_APP_HOME=${home}`, "the live binding's home, not the default");
  assert.equal(liveFor(s, ID.main).length, 1, "exactly one live seat");
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger is not written");
  assert.equal(attachRowsIn(home).filter((row) => row.event === "attach").at(-1).bot, ID.main);
});

// The Reviewer's HIGH (#1128) from the other side: two live bindings for one bot, the selected
// home's pane labelled and the project home's pane unlabelled. No launch record decides between
// two panes, so restart refuses, names both ledgers, and writes nothing.
test("#1128 two live bindings refuse before any write, even when one lost its label", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  dropLabel(s, terminal);
  const row = attachRowsIn(home).at(-1);
  // The selected (default) home's own live pane for the same bot: the split #1128 leaves behind.
  mkdirSync(join(defaultHomePath(s), "automagik-herdr"), { recursive: true });
  writeFileSync(defaultLedgerPath(s), `${JSON.stringify({ ...row, terminal: "t8", created_ms: 100 })}\n`, { mode: 0o600 });
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  state.terminals.push({ ...state.terminals.find((x) => x.address === terminal), address: "t8", name: "twin", created_ms: 100,
    labels: { ...(state.terminals.find((x) => x.address === terminal).labels ?? {}), bot: ID.main } });
  writeFileSync(s.statePath, JSON.stringify(state));
  const beforeDefault = readFileSync(defaultLedgerPath(s)), beforeProject = readFileSync(attachPath(home));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).refused, "app-home");
  assert.ok(r.stderr.includes(attachPath(defaultHomePath(s))), `the selected ledger's path: ${r.stderr}`);
  assert.ok(r.stderr.includes(attachPath(home)), `the project home's path: ${r.stderr}`);
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or ended");
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the project home's ledger untouched");
});

// The Reviewer's HIGH (#1128), the symmetric orientation: the selected home's live binding lost
// the label and the project's own home holds the labelled pane. The same twin check must run
// before the fall-through, so the refusal names both ledgers instead of "attachment".
test("#1128 the symmetric two-live split refuses naming both ledgers", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home); // labelled in the project's own home
  const row = attachRowsIn(home).at(-1);
  // The selected (default) home's own live pane for the same bot, unlabelled: the split #1128
  // leaves behind, the reverse of the test above.
  mkdirSync(join(defaultHomePath(s), "automagik-herdr"), { recursive: true });
  writeFileSync(defaultLedgerPath(s), `${JSON.stringify({ ...row, terminal: "t8", created_ms: 100 })}\n`, { mode: 0o600 });
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const projectPane = state.terminals.find((x) => x.address === terminal);
  state.terminals.push({ ...projectPane, address: "t8", name: "twin", created_ms: 100, labels: {} });
  writeFileSync(s.statePath, JSON.stringify(state));
  assert.ok(projectPane.labels?.bot, "the project home's pane keeps the label");
  const beforeDefault = readFileSync(defaultLedgerPath(s)), beforeProject = readFileSync(attachPath(home));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).refused, "app-home");
  assert.ok(r.stderr.includes(attachPath(defaultHomePath(s))), `the selected ledger's path: ${r.stderr}`);
  assert.ok(r.stderr.includes(attachPath(home)), `the project home's path: ${r.stderr}`);
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or ended");
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the project home's ledger untouched");
  // The read path resolves too: show and whois refuse the same split instead of naming the
  // selected pane with duplicate:false while the project home binds the labelled pane.
  for (const args of [["whois", "--bot", ID.main, "--json"], ["show", "Genie", "--json"]]) {
    const read = cliWith(s, {}, ["HERDR_APP_HOME"], args);
    assert.equal(read.status, 1, `${args[0]}: ${read.stdout}`);
    assert.equal(JSON.parse(read.stdout).refused, "app-home", args[0]);
    assert.ok(read.stderr.includes(attachPath(defaultHomePath(s))), `${args[0]} names the selected ledger: ${read.stderr}`);
    assert.ok(read.stderr.includes(attachPath(home)), `${args[0]} names the project home: ${read.stderr}`);
  }
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the reads wrote nothing to the default ledger");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the reads wrote nothing to the project home's ledger");
});

// The one-time label import can record the same launch in both ledgers. One pane, but two homes
// naming it: restart refuses to choose an authority, names both ledgers, and writes nothing.
test("#1128 the same launch in two app homes refuses naming both ledgers", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  const row = attachRowsIn(home).at(-1);
  mkdirSync(join(defaultHomePath(s), "automagik-herdr"), { recursive: true });
  writeFileSync(defaultLedgerPath(s), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  idlePane(s, terminal);
  const beforeDefault = readFileSync(defaultLedgerPath(s)), beforeProject = readFileSync(attachPath(home));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).refused, "app-home");
  assert.ok(r.stderr.includes(attachPath(defaultHomePath(s))), `the selected ledger's path: ${r.stderr}`);
  assert.ok(r.stderr.includes(attachPath(home)), `the project home's path: ${r.stderr}`);
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or ended");
  assert.deepEqual(readFileSync(defaultLedgerPath(s)), beforeDefault, "the default ledger untouched");
  assert.deepEqual(readFileSync(attachPath(home)), beforeProject, "the project home's ledger untouched");
});

// The same live-over-stale rule on a direct read path: whois (and show) use the one resolver,
// so the live project-home binding answers there too. A mutation that reads the selected map
// alone (attachView().live) fails this test.
test("#1128 whois and show read the same resolver: live project home beats a stale default row", (t) => {
  const s = scene(t);
  const home = withProjectHome(s);
  const terminal = startIn(s, home);
  writeStaleDefaultRow(s, attachRowsIn(home).at(-1));
  dropLabel(s, terminal);
  const whois = cliWith(s, {}, ["HERDR_APP_HOME"], ["whois", "--bot", ID.main, "--json"]);
  assert.equal(whois.status, 0, whois.stderr);
  assert.equal(JSON.parse(whois.stdout).terminal, terminal, "the live project-home pane, not the stale default row");
  assert.equal(JSON.parse(whois.stdout).project, s.project);
  const show = cliWith(s, {}, ["HERDR_APP_HOME"], ["show", "Genie", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).terminal, terminal, "show reads the same resolved binding");
  assert.equal(JSON.parse(show.stdout).status !== "not running", true);
});

// The Tester's F2 (#1128): a pane launched before #650 has no app-home word, and the project
// has no own app home. There is no second home to read, so restart refuses before any write
// rather than guess the default one.
test("#1128 a pre-#650 pane with no project app home refuses without writing", (t) => {
  const s = scene(t);
  const away = join(s.root, "away-app");
  mkdirSync(away, { recursive: true });
  const terminal = startIn(s, away);
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  const pane = state.terminals.find((x) => x.address === terminal);
  pane.argv = pane.argv.filter((word) => !word.startsWith("HERDR_APP_HOME="));
  writeFileSync(s.statePath, JSON.stringify(state));
  const beforeAway = readFileSync(attachPath(away));
  writeFileSync(s.logPath, "");
  const r = cliWith(s, {}, ["HERDR_APP_HOME"], ["restart", "Genie", "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).refused, "attachment");
  assert.match(r.stderr, /no matching attachment in the selected or carried app home/);
  assert.deepEqual(calls(s).filter((call) => ["run", "kill"].includes(call[0])), [], "nothing launched or ended");
  assert.deepEqual(readFileSync(attachPath(away)), beforeAway, "the carried home's ledger untouched");
  assert.equal(existsSync(defaultLedgerPath(s)), false, "no default ledger written");
});
