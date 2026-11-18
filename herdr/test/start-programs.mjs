// Shared by the pack and am CI jobs: real CLI calls, only scratch homes and fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { attachPath } from "../mods/am-sidebar/attach.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/start-programs.json", import.meta.url), "utf8"));
const fake = new URL("./fake-hc.mjs", import.meta.url).pathname;
const keys = Object.keys(fixture.programs);
const id = "b-aaaaaaaaaa";
const exe = (path, text = "#!/bin/sh\nexit 0\n") => { writeFileSync(path, text); chmodSync(path, 0o755); };

function scene(t, cli, agent, paired, remote) {
  const root = scratchRoot(t, "start-programs-");
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "remote");
  for (const dir of [bin, home, app, vm]) mkdirSync(dir);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  exe(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  exe(join(bin, "pgrep"), "#!/bin/sh\nexit 1\n");
  for (const { run } of Object.values(fixture.programs)) exe(join(bin, run[0]));
  const binding = { home: join(root, "hermes-data"), profile: "research" };
  const bot = { id, name: "Research", kind: "main", look: { character: "star", colour: "blue" },
    role: "", instructions: "", agent, ...(paired ? { hermes: binding } : {}) };
  const project = scratchProject(root, "project", { bots: { version: 1, categories: [], bots: [bot] } });
  writeFileSync(join(app, "programs.json"), JSON.stringify(fixture));
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  const state = { next: 100, terminals: [], machines: [{ name: "vm", id: "test-core", state: "connected", home: vm, path: bin, uname: "Linux x86_64" }] };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  writeFileSync(logPath, "");
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: app,
    HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath, GIT_CEILING_DIRECTORIES: root,
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "1", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "1000" };
  const run = (args) => spawnSync(process.execPath, [cli, ...args, "--project", project,
    ...(remote ? ["--machine", "vm"] : []), "--json"], { cwd: project, env, encoding: "utf8" });
  const live = () => {
    state.terminals = [{ address: remote ? "vm/t1" : "t1", state: "live", created_ms: 1, cwd: project,
      labels: { bot: id, "agent.session": "test-session" },
      foreground: { argv: fixture.programs[agent].run, cwd: project }, status: { app: agent, state: "idle" }, turn: 1 }];
    save();
    if (remote) {
      const attached = run(["attach", id, "vm/t1"]);
      assert.equal(attached.status, 0, attached.stderr);
    }
  };
  return { root, bin, app, project, binding, run, live, statePath, calls: () => readJsonLines(logPath) };
}

export function startProgramsTests(cli) {
  for (const remote of [false, true]) for (const source of [...keys.map((agent) => ({ agent, paired: false })), { agent: "hermes", paired: true }]) {
    for (const action of ["start", "restart-stopped", "restart", ...keys.map((key) => `on:${key}`)]) {
      test(`programs fixture: ${remote ? "linked" : "local"} ${source.paired ? "paired" : "unpaired"} ${source.agent} ${action}`, (t) => {
        const s = scene(t, cli, source.agent, source.paired, remote);
        if (action !== "start" && action !== "restart-stopped") s.live();
        const target = action.startsWith("on:") ? action.slice(3) : source.agent;
        const args = [action === "start" ? "start" : "restart", id, ...(action.startsWith("on:") ? ["--agent", target] : [])];
        const r = s.run(args);
        if (source.paired && target !== "hermes") {
          // A Bot Chat cannot move to another agent: require an explicit unpair, never erase it.
          assert.notEqual(r.status, 0);
          assert.match(r.stderr, /pair|unpair/i);
          assert.doesNotMatch(r.stderr, /\n\s+at |Error:/);
          assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "kill"), false);
          return;
        }
        assert.equal(r.status, 0, r.stderr);
        const launches = s.calls().filter((c) => c[0] === "run");
        assert.equal(launches.length, 1, r.stdout);
        const argv = launches[0];
        const command = fixture.programs[target].run;
        const at = argv.findIndex((word) => word === command[0] || word.endsWith(`/${command[0]}`));
        assert.ok(at >= 0, JSON.stringify(argv));
        assert.deepEqual(argv.slice(at + 1, at + command.length), command.slice(1));
        if (action === "restart" && ["omp", "codex"].includes(target)) {
          assert.ok(argv.includes(target === "omp" ? "--resume=test-session" : "test-session"), JSON.stringify(argv));
          assert.equal(JSON.parse(r.stdout).session, "***");
        }
        if (source.paired) {
          if (action === "restart") assert.equal(JSON.parse(r.stdout).session, null, "pairing resolves Bot Chat, not an old pane's session label");
          assert.equal(argv.filter((word) => word === "--tui").length, 1);
          assert.equal(argv[argv.indexOf("--profile") + 1], "research");
          assert.equal(argv[argv.indexOf("--continue") + 1], "Bot Chat");
          assert.ok(argv.includes(`HERMES_HOME=${s.binding.home}`));
          assert.ok(argv.includes("HERMES_PROFILE=research"));
        }
        assert.equal(s.calls().some((c) => ["send", "keys", "interrupt"].includes(c[0])), false);
        assert.equal(s.calls().filter((c) => c[0] === "kill").length, action === "start" || action === "restart-stopped" ? 0 : 1);
        const saved = JSON.parse(readFileSync(join(s.project, ".herdr/bots.json"), "utf8")).bots[0];
        assert.equal(saved.agent, source.agent);
        if (source.paired) assert.deepEqual(saved.hermes, s.binding);
      });
    }
  }
  for (const remote of [false, true]) for (const action of ["start", "restart"]) {
    test(`programs fixture: ${remote ? "linked" : "local"} ${action} profile contradiction logs its trace`, (t) => {
      const s = scene(t, cli, "hermes", true, remote);
      const programs = structuredClone(fixture);
      programs.programs.hermes.run.push("--profile=other");
      writeFileSync(join(s.app, "programs.json"), JSON.stringify(programs));
      const r = s.run([action, id]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /different Hermes profile; match --profile/);
      assert.doesNotMatch(r.stderr, /\n\s+at |Error:/);
      const log = readFileSync(join(s.app, "automagik-herdr/actions.log"), "utf8");
      assert.match(log, /Error: The command selects a different Hermes profile/);
      assert.match(log, /\n\s+at /);
      assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "kill"), false);
    });
  }
  for (const mode of ["tree", "end", "partial"]) test(`programs fixture: linked paired helper restart ${mode}`, (t) => {
    const tree = mode !== "end";
    const s = scene(t, cli, "hermes", true, true);
    s.live();
    // Configure writes the bot before the owner restarts to apply that update.
    const edited = s.run(["edit", id, "--role", "updated role"]);
    assert.equal(edited.status, 0, edited.stderr);
    const state = JSON.parse(readFileSync(s.statePath, "utf8"));
    const helperFolder = join(s.root, "helper");
    mkdirSync(helperFolder);
    state.terminals.push({ address: "vm/t2", name: "helper", created_ms: 2, state: "live", parent: "vm/t1", die_with_parent: true,
      cwd: helperFolder, argv: ["codex"], foreground: { argv: ["codex"], cwd: helperFolder },
      status: { state: "working", app: "codex" }, labels: { "agent.session": "helper-session" } });
    if (mode === "partial") state.failRun = ["helper"];
    const holdingApp = join(s.root, "holding-app");
    mkdirSync(holdingApp);
    // Its ledger already exists: one-time label import cannot discover this remote start.
    mkdirSync(dirname(attachPath(holdingApp)), { recursive: true });
    writeFileSync(attachPath(holdingApp), "");
    writeFileSync(join(holdingApp, "programs.json"), JSON.stringify(fixture));
    state.machines[0].env = { HOLDING_CLI: cli, HOLDING_APP: holdingApp };
    writeFileSync(s.statePath, JSON.stringify(state));
    const holding = new URL("./fake-holding-cli.mjs", import.meta.url).pathname;
    exe(join(s.bin, "automagik-herdr"), `#!/bin/sh\nexec "${process.execPath}" "${holding}" "$@"\n`);
    const refusal = s.run(["restart", id]);
    assert.equal(refusal.status, 1);
    assert.equal(JSON.parse(refusal.stdout).refused, "helpers");
    const r = s.run(["restart", id, "--force", ...(tree ? ["--tree"] : [])]);
    assert.equal(r.status, mode === "partial" ? 1 : 0, r.stderr);
    const result = JSON.parse(r.stdout);
    const after = JSON.parse(readFileSync(s.statePath, "utf8"));
    assert.equal(after.terminals.find((p) => p.address === "vm/t1").state, "finished");
    assert.equal(after.terminals.find((p) => p.address === "vm/t2").state, "finished");
    const live = after.terminals.filter((p) => p.state === "live");
    assert.equal(live.length, mode === "tree" ? 2 : 1);
    const lead = live.find((p) => p.address === `vm/${result.terminal}`);
    assert.equal(JSON.parse(readFileSync(join(s.project, ".herdr/bots.json"), "utf8")).bots[0].role, "updated role");
    assert.ok(lead.argv.includes("research"), "paired profile retained");
    assert.equal(lead.argv.filter((word) => word === "--tui").length, 1);
    if (tree) {
      if (mode === "tree") {
        const helper = live.find((p) => p.parent === lead.address);
        assert.ok(helper.argv.includes("helper-session"), "helper conversation resumed");
        assert.equal(helper.cwd, helperFolder);
      } else assert.match(result.helpers[0].error, /hc run failed/);
      const who = s.run(["whois", lead.address]);
      assert.equal(who.status, 0, who.stderr);
      assert.equal(JSON.parse(who.stdout).bot, id, "controller attachment moved");
    }
  });
}
