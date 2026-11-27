import { startFakeCore } from "./fake-core.mjs";
// Shared by the pack and am CI jobs: real CLI calls, only scratch homes and fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";
import { readJsonLines } from "./log-lines.mjs";
import { ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { attachPath } from "../mods/am-sidebar/attach.js";
import { recordFileOf } from "../mods/am-sidebar/approved.js";
import { loginFixture, loginPointerFixture, privateFixtureHome } from "./login-fixture.mjs";
import { POINTER_VAR, REQUIRED_VAR } from "../mods/am-sidebar/loginRecord.js";

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
  exe(join(bin, "claude"));
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
  const core = startFakeCore(t, { ...env, AUTOMAGIK_HERDR_TEST_ROOTS: root });
  Object.assign(env, { ...core.env });
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args, "--project", project,
    ...(remote ? ["--machine", "vm"] : []), "--json"], { cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8" });
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
  test("restart resolves the one pointer export (#1509)", (t) => {
    const s = scene(t, cli, "codex", false, false);
    s.live();
    const current = join(s.root, "acp", "cli-homes", "current");
    const claudeGen = "11111111-1111-4111-8111-111111111111";
    const codexGen = "22222222-2222-4222-8222-222222222222";
    const claudeDir = join(dirname(current), "homes", "claude", claudeGen, ".claude");
    const codexDir = join(dirname(current), "homes", "codex", codexGen, ".codex");
    for (const dir of [current, claudeDir, codexDir]) mkdirSync(dir, { recursive: true });
    privateFixtureHome(claudeDir); privateFixtureHome(codexDir);
    writeFileSync(join(current, "generation.json"), JSON.stringify({ version: 1, sequence: 5,
      claude: { generation: claudeGen, configDir: claudeDir }, codex: { generation: codexGen, home: codexDir },
      updatedAt: "2026-11-16T20:00:00.000Z" }));
    writeFileSync(join(current, "claude"), claudeGen);
    writeFileSync(join(current, "codex"), codexGen);
    const r = s.run(["restart", id], loginPointerFixture(t, join(current, "claude")));
    assert.equal(r.status, 0, r.stderr);
    const launch = s.calls().filter((call) => call[0] === "run").at(-1);
    assert.ok(launch.includes(`CODEX_HOME=${codexDir}`), JSON.stringify(launch));
  });

  for (const action of ["start", "restart", "tree"]) {
    test(`#1509 linked ${action} refuses this computer's Bot login before launch`, (t) => {
      const s = scene(t, cli, "codex", false, true);
      if (action !== "start") s.live();
      const env = action === "restart" ? { [REQUIRED_VAR]: "required" } : loginFixture(t, join(s.root, "acp", "cli-homes"), "codex").env;
      const r = s.run([action === "start" ? "start" : "restart", id, ...(action === "tree" ? ["--tree", "--force"] : [])], env);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stderr.trim(), "am: A linked machine can't carry this computer's Bot login; start the bot on that machine. (linked-machine)");
      assert.deepEqual(s.calls().filter((c) => ["run", "kill"].includes(c[0])), []);
      // Identifying the launch agent requires reading the project on the linked machine.
      const remoteExec = ["exec", "--json", "--on", "vm"];
      const projectProbes = [
        [...remoteExec, "--", "test", "-d", s.project],
        [...remoteExec, "--cwd", s.project, "--", "git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ];
      // The setup attach looks up the project, then checks the approval path and mode twice.
      const approvalExec = ["exec", "--json", "--timeout", "10", "--on", "vm", "--", "sh", "-c"];
      const approvalProbes = [
        [...approvalExec, 'CDPATH= cd -- "$1" && pwd -P && printf "%s\\n" "${XDG_DATA_HOME-}" "${HOME-}"', "sh", s.project],
        [...approvalExec, 'if ! entry=$(LC_ALL=C ls -d -- "$1" 2>&1); then '
          + 'case "$entry" in *": No such file or directory") exit 3;; *) exit 1;; esac; fi; '
          + '[ -f "$1" ] && [ ! -L "$1" ] || exit 1; stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1"',
        "sh", recordFileOf(s.project, { HOME: join(s.root, "remote") })],
      ];
      const setupProbes = action === "start" ? [] : [...projectProbes, ...approvalProbes, ...approvalProbes];
      assert.deepEqual(s.calls().filter((c) => c[0] === "exec"), [...setupProbes, ...projectProbes]);
    });
  }

  for (const action of ["start", "restart", "swap"]) {
    test(`#1509 linked ${action} allows a non-vendor agent under the Bot login policy`, (t) => {
      const s = scene(t, cli, action === "swap" ? "codex" : "omp", false, true);
      if (action !== "start") s.live();
      const args = [action === "start" ? "start" : "restart", id];
      if (action === "swap") args.push("--agent", "omp");
      const r = s.run(args, { [REQUIRED_VAR]: "required" });
      assert.equal(r.status, 0, r.stderr);
      const launch = s.calls().find((c) => c[0] === "run");
      assert.ok(launch?.some((word) => word === "omp" || word.endsWith("/omp")), JSON.stringify(s.calls()));
    });
  }

  test("#1509 a linked restart refuses a swap to a vendor under the Bot login policy", (t) => {
    const s = scene(t, cli, "omp", false, true);
    s.live();
    const r = s.run(["restart", id, "--agent", "codex"], { [REQUIRED_VAR]: "required" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\(linked-machine\)/);
    assert.deepEqual(s.calls().filter((c) => ["run", "kill"].includes(c[0])), []);
  });

  test("#1509 start resolves a custom program's executable instead of its key", (t) => {
    const s = scene(t, cli, "omp", false, false);
    const programs = structuredClone(fixture);
    programs.programs.omp.run = ["codex"];
    writeFileSync(join(s.app, "programs.json"), JSON.stringify(programs));
    const login = loginFixture(t, join(s.root, "acp", "cli-homes"), "codex");
    const r = s.run(["start", id], login.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(s.calls().find((c) => c[0] === "run").includes(`CODEX_HOME=${login.dir}`));
  });

  for (const [action, vendor] of [["start", "codex"], ["restart", "claude"]]) {
    test(`#1509 linked ${action} refuses a ${vendor} executable under a non-vendor key`, (t) => {
      const s = scene(t, cli, "omp", false, true);
      if (action === "restart") s.live();
      const programs = structuredClone(fixture);
      programs.programs.omp.run = [vendor];
      writeFileSync(join(s.app, "programs.json"), JSON.stringify(programs));
      const args = [action, id, ...(action === "restart" ? ["--fresh"] : [])];
      const refused = s.run(args, { [POINTER_VAR]: "" });
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /\(linked-machine\)/);
      assert.deepEqual(s.calls().filter((c) => ["run", "kill"].includes(c[0])), []);
      const baseline = s.run(args);
      assert.equal(baseline.status, 0, baseline.stderr);
      assert.ok(s.calls().find((c) => c[0] === "run")?.includes(vendor));
    });
  }

  test("#1509 a linked tree with a non-vendor parent and a vendor helper is refused", (t) => {
    const s = scene(t, cli, "omp", false, true);
    s.live();
    const state = JSON.parse(readFileSync(s.statePath, "utf8"));
    state.terminals.push({ address: "vm/t2", name: "helper", parent: "vm/t1", die_with_parent: true,
      state: "live", cwd: s.project, argv: ["codex"], foreground: { argv: ["codex"], cwd: s.project } });
    writeFileSync(s.statePath, JSON.stringify(state));
    const before = s.calls().length;
    const refused = s.run(["restart", id, "--tree", "--force"], { [REQUIRED_VAR]: "required" });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /\(linked-machine\)/);
    const calls = s.calls().slice(before);
    assert.deepEqual(calls.filter((c) => ["run", "kill"].includes(c[0])), []);
    assert.ok(!calls.some((c) => c[0] === "exec" && c.includes("--tree")), JSON.stringify(calls));
  });

  test("#1509 Claude launch settings are guarded only while the Bot login policy is active", (t) => {
    const s = scene(t, cli, "claude", false, false);
    const login = loginFixture(t, join(s.root, "acp", "cli-homes"), "claude");
    const programs = structuredClone(fixture);
    const settings = join(s.root, "settings.json");
    writeFileSync(settings, "{}");
    const override = (words) => {
      programs.programs.claude = { run: ["claude", ...words] };
      writeFileSync(join(s.app, "programs.json"), JSON.stringify(programs));
    };
    for (const words of [
      ["--settings", '{"env":{}}'],
      ["--settings", '{"env":{"CLAUDE_CONFIG_DIR":"/other"}}'],
      ['--settings={"forceLoginOrgUUID":"other"}'],
      ["--settings", settings],
    ]) {
      override(words);
      const refused = s.run(["start", id], login.env);
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /\(settings-overrides-login\)/);
      assert.deepEqual(s.calls().filter((c) => c[0] === "run"), []);
    }
    const baseline = s.run(["start", id]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.ok(s.calls().find((c) => c[0] === "run")?.includes(settings));
    const generated = scene(t, cli, "claude", false, false);
    const native = loginFixture(t, join(generated.root, "acp", "cli-homes"), "claude");
    const started = generated.run(["start", id], native.env);
    assert.equal(started.status, 0, started.stderr);
    assert.ok(generated.calls().find((c) => c[0] === "run")?.includes(`CLAUDE_CONFIG_DIR=${native.dir}`));
  });

  for (const [agent, argv] of [
    ["claude", ["/bin/sh", "-lc", "exec claude"]],
    ["codex", ["/usr/bin/env", "-S", "codex"]],
    ["omp", ["opaque-wrapper"]],
  ]) test(`#1509 start refuses programs.json ${agent} command ${argv[0]} under the policy`, (t) => {
    const s = scene(t, cli, agent, false, false);
    const programs = structuredClone(fixture);
    programs.programs[agent] = { ...(programs.programs[agent] ?? {}), run: argv };
    writeFileSync(join(s.app, "programs.json"), JSON.stringify(programs));
    const login = loginFixture(t, join(s.root, "acp", "cli-homes"), "claude");
    const r = s.run(["start", id], login.env);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr.trim(), "am: Under the Bot login policy only a direct Claude or Codex command can start; run the agent directly. (launch-not-direct)");
    assert.deepEqual(s.calls().filter((c) => ["run", "kill"].includes(c[0])), []);
  });

  test("#1509 start rereads the Bot login after the early check", (t) => {
    const s = scene(t, cli, "codex", false, false);
    const root = join(s.root, "acp", "cli-homes");
    const generation = "22222222-2222-4222-8222-222222222222";
    const next = loginFixture(t, root, "codex", generation);
    const first = loginFixture(t, root, "codex");
    const hook = join(s.root, "switch.cjs");
    writeFileSync(hook, `
      const fs = require("node:fs");
      const lstat = fs.lstatSync;
      let seen = 0;
      // The early check reads the home's markers twice (before and after it rechecks the
      // pointer); switch only once that read is complete, so start must reread.
      fs.lstatSync = (path, ...args) => {
        if (path === ${JSON.stringify(join(dirname(first.dir), "changing"))} && ++seen === 2) {
          fs.writeFileSync(${JSON.stringify(next.pointer)}, ${JSON.stringify(generation)});
          fs.writeFileSync(${JSON.stringify(next.recordPath)}, ${JSON.stringify(next.text)});
        }
        return lstat(path, ...args);
      };
      require("node:module").syncBuiltinESMExports();
    `);
    const r = s.run(["start", id], { ...first.env, CODEX_HOME: join(s.root, "caller-codex"), NODE_OPTIONS: `--require=${hook}` });
    assert.equal(r.status, 0, r.stderr);
    const launch = s.calls().find((c) => c[0] === "run");
    assert.ok(launch.includes(`CODEX_HOME=${next.dir}`), JSON.stringify(launch));
    assert.equal(launch.includes(`CODEX_HOME=${first.dir}`), false);
    const row = readLedger(readFileSync(ledgerPath(s.app), "utf8")).find((row) => row.kind === "seat");
    assert.equal(row.env.CODEX_HOME, next.dir);
  });

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
    assert.equal(after.terminals.some((p) => p.address === "vm/t1"), false);
    const oldHelper = after.terminals.find((p) => p.address === "vm/t2");
    if (mode === "partial") {
      assert.equal(oldHelper?.state, "finished");
      assert.equal(oldHelper.labels["agent.session"], "helper-session");
    } else assert.equal(oldHelper, undefined);
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
