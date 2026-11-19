// The Automations panel (am-automations) without its scheduler (#220): one line says what is
// missing, the exact install command is shown and copied by Copy, nothing runs it, and the panel
// finds the scheduler once it is installed. gpui and herdr are stood in for (gpui-stub.mjs,
// am-automations-herdr.mjs); the in-app check in the mod's RECIPE still applies.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const here = (f) => new URL(f, import.meta.url).href;
const stubs = { herdr: here("./am-automations-herdr.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
const fromMod = (context) => context.parentURL?.includes("/mods/am-automations/");
registerHooks({
  resolve: (specifier, context, next) =>
    stubs[specifier] && fromMod(context) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context),
});

const { state } = await import(stubs.herdr);
const { nodes, index, textOf, all } = await import(stubs["gpui-kit"]);
const { default: Automations, SCHEDULER, repairCommand } = await import("../mods/am-automations/main.js");

function makeCx() {
  const cx = { pending: [], ticks: [], clipboard: [],
    spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    timer: { every: (_ms, fn) => { cx.ticks.push(fn); return { cancel() {} }; } },
    focus_handle: () => ({}), notify() {}, stop_propagation() {}, write_to_clipboard(x) { cx.clipboard.push(x); } };
  cx.settle = async () => { while (cx.pending.length) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
}

/** An exec where only `uname -m` answers, unless `scheduler` names a binary that does too. */
function answer({ machine = "arm64", scheduler = null } = {}) {
  state.exec = async (command, args) => {
    if (command === "uname") return { code: 0, stdout: `${machine}\n`, stderr: "" };
    if (command !== scheduler) return { code: 127, stdout: "", stderr: `cannot run ${command}: no such file` };
    if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ automations: [], invalid: [], scheduler: { pid: 1 }, paused: false }), stderr: "" };
    if (args[0] === "history") return { code: 0, stdout: "[]", stderr: "" };
    return { code: 0, stdout: "0.12.1\n", stderr: "" };
  };
}

async function panel() {
  state.calls = [];
  const cx = makeCx();
  const view = new Automations();
  view.init({}, cx);
  await cx.settle();
  return { view, cx, draw: () => { index(view.render(cx)); return nodes; } };
}

test("the repair command: our pinned release for this Mac's arch, hash-checked, into ~/.local/bin", () => {
  const arm = repairCommand("arm64");
  assert.match(arm, /\/automagik-dev\/automagik\/releases\/download\/herdr-automations-v0\.12\.1-am\.1\/herdr-automations_darwin_arm64 /);
  assert.ok(arm.includes(`echo "${SCHEDULER.sha256.arm64}  herdr-automations" | shasum -a 256 -c`));
  assert.match(arm, /shasum -a 256 -c && chmod 755 herdr-automations && mv herdr-automations ~\/\.local\/bin\/; s=\$\?; /, "moved in only once the hash matches");
  // Its scratch folder goes whether it worked or not, and the subshell keeps the install's status.
  assert.ok(arm.startsWith('(d=; mkdir -p ~/.local/bin && d="$(mktemp -d)" && cd "$d" && curl '));
  assert.ok(arm.endsWith('; s=$?; cd /; [ -z "$d" ] || rm -rf "$d"; exit "$s")'));
  const intel = repairCommand("x86_64");
  assert.match(intel, /herdr-automations-v[^/]+\/herdr-automations_darwin_amd64 /);
  assert.ok(intel.includes(SCHEDULER.sha256.amd64));
  assert.doesNotMatch(arm + intel, /service install|launchctl|LaunchAgents/, "it installs the program, never a login service");
  // A Linux Herdr gets the Linux build, checked with sha256sum (no shasum there).
  const linux = repairCommand("x86_64", "Linux"), linuxArm = repairCommand("aarch64", "Linux");
  assert.match(linux, /herdr-automations-v0\.12\.1-am\.1\/herdr-automations_linux_amd64 /);
  assert.ok(linux.includes(`echo "${SCHEDULER.linux.amd64}  herdr-automations" | sha256sum -c && chmod 755`));
  assert.match(linuxArm, /herdr-automations_linux_arm64 /);
  assert.ok(linuxArm.includes(SCHEDULER.linux.arm64));
  assert.equal(repairCommand("arm64", "Darwin"), arm, "a Mac is the default");
});

// The command is pasted into the person's own terminal, and a ( … ) subshell inherits that shell's
// variables. Run for real, in a scratch home where ~/.local/bin cannot be made (.local is a file),
// with `d` already naming a folder: the cleanup must not touch it. Nothing is downloaded: mkdir
// fails first, so curl never runs.
test("the repair command never removes a folder it did not make: a preset d survives a failing mkdir", () => {
  const scratch = mkdtempSync(join(tmpdir(), "am-repair-"));
  try {
    const home = join(scratch, "home"), victim = join(scratch, "victim"), tmp = join(scratch, "tmp");
    for (const dir of [home, victim, tmp]) mkdirSync(dir);
    writeFileSync(join(home, ".local"), "a file where the folder would go\n");
    writeFileSync(join(victim, "keep.txt"), "the person's own\n");
    for (const [machine, os] of [["x86_64", "Linux"], ["arm64", "Darwin"]]) {
      const env = { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", d: victim };
      // Both ways a terminal can hold it: exported into the environment, and a plain shell variable.
      for (const script of [repairCommand(machine, os), `d='${victim}'; ${repairCommand(machine, os)}`]) {
        const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
        assert.notEqual(r.status, 0, "mkdir failed, and the command says so by its status");
        assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "the person's own\n", `${os}: the preset d is untouched`);
        assert.deepEqual(readdirSync(tmp), [], "no scratch folder was made or left");
        assert.equal(existsSync(join(home, ".local", "bin")), false);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

// The release the Integrator cuts carries the checksums; until they are pasted in, this fails loudly
// so nothing merges with the repair command pointing at placeholder hashes.
test("the scheduler pin is a real release hash, never the PENDING-SHA256 placeholder", () => {
  assert.equal(SCHEDULER.repo, "automagik-dev/automagik");
  assert.equal(SCHEDULER.version, "0.12.1-am.1");
  for (const arch of ["arm64", "amd64"]) {
    assert.notEqual(SCHEDULER.sha256[arch], "PENDING-SHA256", `${arch}: paste the release's checksums.txt sha256`);
    assert.match(SCHEDULER.sha256[arch], /^[0-9a-f]{64}$/, `${arch}: a sha256`);
    assert.match(SCHEDULER.linux[arch], /^[0-9a-f]{64}$/, `linux ${arch}: a sha256`);
  }
  assert.equal(new Set([...Object.values(SCHEDULER.sha256), ...Object.values(SCHEDULER.linux)]).size, 4, "four builds, four hashes");
});

test("no scheduler: one line says what is missing, the command is shown, Copy copies it, nothing runs it", async () => {
  answer({ machine: "x86_64" });
  const { view, cx, draw } = await panel();
  assert.equal(view.bin, null);
  const n = draw();
  assert.ok(n.has("scheduler-missing"));
  assert.match(textOf(n.get("scheduler-missing")), /Missing the scheduler: herdr-automations is not on PATH or in ~\/\.local\/bin\./);
  assert.equal(textOf(n.get("repair-command")), repairCommand("x86_64"));
  assert.equal(view.error, null, "no 'no such file' error under it");
  assert.doesNotMatch(textOf(view.render(cx)), /Loading/, "the repair block is all the body says");
  assert.ok(!n.has("new"), "no + while there is no scheduler to save to");
  n.get("copy-repair").click({}, cx);
  assert.deepEqual(cx.clipboard, [repairCommand("x86_64")]);
  assert.equal(textOf(draw().get("copy-repair")), "Copied");
  const ran = state.calls.map(([c]) => c);
  assert.ok(ran.every((c) => c === "herdr-automations" || c === "uname" || c.endsWith("/.local/bin/herdr-automations")), ran.join(" "));
  assert.ok(!state.calls.some((c) => c.includes("service")), "no service install");
});

test("installed later: the next refresh finds it in ~/.local/bin and the repair line goes", async () => {
  answer();
  const { view, cx, draw } = await panel();
  assert.ok(draw().has("scheduler-missing"));
  const local = `${state.home}/.local/bin/herdr-automations`;
  answer({ scheduler: local });
  await cx.ticks[0](cx);
  await cx.settle();
  assert.equal(view.bin, local);
  assert.equal(view.missing, null);
  const after = draw();
  assert.ok(!after.has("scheduler-missing"));
  assert.ok(after.has("new"), "+ is back");
  assert.deepEqual(view.list.automations, []);
});

// The repair action (#220): Install runs the shown command, once, from a click only; the panel then
// finds the scheduler without waiting for the 30 s refresh, and starts no service by itself.
test("Install runs the shown command once; the panel then finds the scheduler and offers Start", async () => {
  const local = `${state.home}/.local/bin/herdr-automations`;
  let installed = false;
  const shell = [];
  state.exec = async (command, args) => {
    if (command === "uname") return { code: 0, stdout: args[0] === "-s" ? "Linux\n" : "x86_64\n", stderr: "" };
    if (command === "sh") { shell.push(args); installed = true; return { code: 0, stdout: "herdr-automations: OK\n", stderr: "" }; }
    if (command !== local || !installed) return { code: 127, stdout: "", stderr: `cannot run ${command}: no such file` };
    if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ automations: [], invalid: [], scheduler: 0, backend: "hc", paused: false }), stderr: "" };
    if (args[0] === "history") return { code: 0, stdout: "[]", stderr: "" };
    return { code: 0, stdout: "0.12.1-am.1\n", stderr: "" };
  };
  const { view, cx, draw } = await panel();
  const n = draw();
  assert.equal(textOf(n.get("repair-command")), repairCommand("x86_64", "Linux"), "this machine's own build");
  assert.equal(textOf(n.get("install-repair")), "Install");
  assert.deepEqual(shell, [], "nothing ran before the click");
  n.get("install-repair").click({}, cx);
  assert.equal(textOf(draw().get("install-repair")), "Installing…");
  draw().get("install-repair").click({}, cx); // a second click while it runs starts nothing
  await cx.settle();
  assert.deepEqual(shell, [["-c", repairCommand("x86_64", "Linux")]], "exactly the shown command, once");
  assert.equal(view.bin, local);
  const after = draw();
  assert.ok(!after.has("scheduler-missing"), "the repair block is gone");
  assert.ok(after.has("start"), "the stopped scheduler's Start is offered");
  assert.ok(!after.has("backend-notice"), "backend hc is ready");
  assert.ok(!state.calls.some((c) => c.includes("service")), "the panel started no service by itself");
});

test("a failed Install keeps the repair block and says why", async () => {
  state.exec = async (command) => {
    if (command === "uname") return { code: 0, stdout: "arm64\n", stderr: "" };
    if (command === "sh") return { code: 1, stdout: "", stderr: "curl: (22) The requested URL returned error: 404\nherdr-automations: FAILED\n" };
    return { code: 127, stdout: "", stderr: "no such file" };
  };
  const { view, cx, draw } = await panel();
  draw().get("install-repair").click({}, cx);
  await cx.settle();
  assert.equal(view.bin, null);
  assert.equal(view.note, "The scheduler was not installed: herdr-automations: FAILED");
  const n = draw();
  assert.ok(n.has("scheduler-missing"));
  assert.equal(textOf(n.get("install-repair")), "Install", "ready to try again");
  assert.match(textOf(view.render(cx)), /The scheduler was not installed: herdr-automations: FAILED/);
});

// Readiness (#220): ls --json answers, but under backend herdr nothing would open in this app.
test("backend herdr, or none named: the panel says runs open in the TUI and names the file; hc and auto say nothing", async () => {
  const serve = (backend) => {
    state.exec = async (command, args) => {
      if (command !== "herdr-automations") return { code: 127, stdout: "", stderr: "no such file" };
      if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ automations: [], invalid: [], scheduler: 7, backend, paused: false }), stderr: "" };
      if (args[0] === "history") return { code: 0, stdout: "[]", stderr: "" };
      return { code: 0, stdout: "0.12.1-am.1\n", stderr: "" };
    };
  };
  serve("herdr");
  const tui = await panel();
  assert.equal(textOf(tui.draw().get("backend-notice")), 'Backend is herdr: runs open in the Herdr TUI, not in this app. Set "backend: hc" in automations.yaml.');
  // With the config path ls --json reports (set here: the stub's folder watch never returns), the file is named.
  tui.view.list.config = `${state.home}/.config/herdr/plugins/config/automations/automations.yaml`;
  assert.equal(textOf(tui.draw().get("backend-notice")),
    'Backend is herdr: runs open in the Herdr TUI, not in this app. Set "backend: hc" in ~/.config/herdr/plugins/config/automations/automations.yaml.');
  // No automations.yaml yet: ls --json names no backend, and the scheduler's default is herdr.
  serve("");
  assert.ok((await panel()).draw().has("backend-notice"), "no backend named is herdr");
  for (const backend of ["hc", "auto"]) {
    serve(backend);
    assert.ok(!(await panel()).draw().has("backend-notice"), backend);
  }
});

test("on PATH: no repair line, and uname is never asked", async () => {
  answer({ scheduler: "herdr-automations" });
  const { view, draw } = await panel();
  assert.equal(view.bin, "herdr-automations");
  assert.ok(!draw().has("scheduler-missing"));
  assert.ok(!state.calls.some(([c]) => c === "uname"));
});

/** The scheduler on PATH listing `automations`; every put (through `sh -c`) is kept and answers ok. */
function listing(automations) {
  const puts = [];
  state.exec = async (command, args) => {
    if (command === "sh") { puts.push({ entry: JSON.parse(args[4]), args: args.slice(5) }); return { code: 0, stdout: "{}", stderr: "" }; }
    if (command !== "herdr-automations") return { code: 127, stdout: "", stderr: `cannot run ${command}: no such file` };
    if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ automations, invalid: [], scheduler: { pid: 1 }, paused: false }), stderr: "" };
    if (args[0] === "history") return { code: 0, stdout: "[]", stderr: "" };
    return { code: 0, stdout: "0.12.1\n", stderr: "" };
  };
  return puts;
}

const nightly = (agent) => ({ name: "nightly", cron: "0 9 * * 1-5", repo: "/r", workspace: "worktree", agent, prompt: "p", timeout_minutes: 60 });
const border = (node) => node.calls.filter(([m]) => m === "border_color").map(([, c]) => c).at(-1);
const bg = (node) => node.calls.filter(([m]) => m === "bg").map(([, c]) => c).at(-1);

test("an automation saved with gemini shows a dimmed, picked 'gemini (retired)' pill and saves gemini back (#224)", async () => {
  const puts = listing([nightly("gemini")]);
  state.agents = [{ key: "claude", installed: true }, { key: "gemini", installed: true }];
  const { view, cx, draw } = await panel();
  view.edit("nightly", cx);
  await cx.settle();
  const t = (await import(stubs.herdr)).theme();
  const n = draw();
  const pill = n.get("f-agent-gemini");
  assert.ok(pill, "the saved agent has a pill");
  assert.equal(textOf(pill), "gemini (retired)");
  assert.equal(pill.props.color, t.dim, "dim text");
  assert.equal(pill.props.opacity, 0.6, "dimmed");
  assert.equal(border(pill), t.accent, "it is the picked one");
  const claude = n.get("f-agent-claude");
  assert.equal(claude.props.color, t.muted, "the offered agents are drawn as before");
  assert.equal(claude.props.opacity, undefined);
  assert.equal(border(claude), t.border);
  assert.ok(![...n.keys()].some((id) => /^f-agent-(codex|pi)$/.test(id)), "only installed agents are offered");
  assert.equal(view.form.agent, "gemini", "the value is kept");
  assert.equal(view.entry().agent, "gemini");
  view.save(cx);
  await cx.settle();
  const saved = puts.filter((p) => !p.args.includes("--dry-run"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.agent, "gemini", "saved back unchanged");
  assert.deepEqual(saved[0].args, ["put", "--original", "nightly"]);
});

test("a non-retired automation: no retired pill, its agent picked as before; a new one never offers gemini", async () => {
  listing([nightly("claude")]);
  state.agents = [{ key: "claude", installed: true }, { key: "gemini", installed: true }];
  const { view, cx, draw } = await panel();
  const t = (await import(stubs.herdr)).theme();
  for (const name of ["nightly", undefined]) {
    view.edit(name, cx);
    await cx.settle();
    const n = draw();
    assert.ok(!n.has("f-agent-gemini"), `no gemini pill (${name ?? "new"})`);
    assert.ok(![...n.values()].some((node) => /retired/.test(textOf(node))), "no retired label");
    const claude = n.get("f-agent-claude");
    assert.equal(claude.props.color, t.foreground);
    assert.equal(claude.props.opacity, undefined);
    assert.equal(border(claude), t.accent);
    assert.equal(view.entry().agent, "claude");
  }
});

// ---- the stub scheduler (#501, #498) ----
// A stand-in herdr-automations in a temp home's ~/.local/bin: it records every argv and every
// put's JSON, and keeps its entries in a fake automations.yaml (JSON, which YAML reads) in that
// home. Its put changes only the keys it is sent and removes a sent key whose value is empty, as
// v0.12.1's config.Put does (edit.go setKeys; the yaml tags are omitempty), and its ls leaves out
// the keys v0.12.1's api.Automation has no field for (close_workspace, session). Only the stub
// and `sh` (the panel's stdin hand-over) really run; any other program, the real scheduler's
// bare name included, is refused, so no test can reach a real config.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";

const STUB = String.raw`
const fs = require("node:fs"), path = require("node:path");
const home = process.env.STUB_HOME, args = process.argv.slice(2);
const version = process.env.STUB_VERSION || "0.12.1";
const OUR = version.includes("-am.");
// putCmd's api.Automation keys, the fields a put writes: 15 upstream, close_workspace the 16th in
// our build (herdr/scheduler). A sent key outside them is not in the entry put encodes, so
// config.Put's setKeys removes it from the config, exactly as the real put does (held #595 Low).
const FIELDS = ["name", "cron", "repo", "workspace", "workspace_id", "agent", "model", "template",
  "prompt", "workflow", "mcp_config", "agent_args", "timeout_minutes", "catch_up_minutes", "disabled"];
if (OUR) FIELDS.push("close_workspace");
// A build with the command kind (#938): its put writes command and notify, its ls names the kinds.
const COMMANDS = process.env.STUB_COMMANDS === "1";
if (COMMANDS) FIELDS.push("command", "notify");
// A build with targets (#498): its put writes target and target_when_busy, its ls names the kinds.
const TARGETS = process.env.STUB_TARGETS === "1";
if (TARGETS) FIELDS.push("target", "target_when_busy");
const yaml = path.join(home, ".config/herdr-automations/automations.yaml");
const read = () => JSON.parse(fs.readFileSync(yaml, "utf8"));
const out = (x) => process.stdout.write(JSON.stringify(x));
let input = "";
if (args[0] === "put") input = fs.readFileSync(0, "utf8");
fs.appendFileSync(path.join(home, "argv.jsonl"), JSON.stringify({ argv: args, input }) + "\n");
if (args[0] === "version") process.stdout.write(version + "\n");
else if (args[0] === "ls") out({ automations: read().map(({ session, ...a }) => {
  if (OUR) a.close_workspace = a.close_workspace ?? "never";
  else delete a.close_workspace; // upstream's api.Automation has no field for it
  return a;
}), invalid: [], scheduler: { pid: 1 }, paused: false, ...(COMMANDS ? { kinds: ["prompt", "workflow", "command"] } : {}),
  ...(TARGETS ? { targets: ["bot", "worker"] } : {}) });
else if (args[0] === "history") out(JSON.parse(process.env.STUB_HISTORY || "[]"));
else if (args[0] === "put") {
  const entry = JSON.parse(input), list = read();
  const at = args[1] === "--original" ? list.findIndex((a) => a.name === args[2]) : -1;
  if (!args.includes("--dry-run")) {
    // A build with the command kind writes no empty repo (its yaml tag is omitempty: a command has none).
    const empty = (k, v) => !(COMMANDS ? ["name", "cron"] : ["name", "cron", "repo"]).includes(k)
      && (v === undefined || v === null || v === "" || v === 0 || v === false || (Array.isArray(v) && !v.length));
    const into = at >= 0 ? list[at] : {};
    for (const [k, v] of Object.entries(entry)) if (!FIELDS.includes(k) || empty(k, v)) delete into[k]; else into[k] = v;
    if (at < 0) list.push(into);
    fs.writeFileSync(yaml, JSON.stringify(list, null, 2));
  }
  out({ next: ["2026-11-09T09:00:00Z"] });
} else { process.stderr.write("stub: not offered: " + args.join(" ")); process.exit(2); }
`;

function stubScheduler(automations, { version = "0.12.1", commands = false, targets = false, bots = [], history = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "am-automations-"));
  mkdirSync(join(dir, ".local/bin"), { recursive: true });
  mkdirSync(join(dir, ".config/herdr-automations"), { recursive: true });
  const bin = join(dir, ".local/bin/herdr-automations");
  writeFileSync(bin, `#!${process.execPath}\n${STUB}`);
  chmodSync(bin, 0o755);
  const yaml = join(dir, ".config/herdr-automations/automations.yaml");
  writeFileSync(yaml, JSON.stringify(automations, null, 2));
  state.home = dir;
  let running = version; // the installed build; useVersion() swaps it, like a repair does
  // The pack's am CLI, for a target's project roster (#498): `am ls --json --project <folder>`.
  const am = (command, args) => {
    if (command !== "am" && command !== join(dir, ".local/bin/am")) return null;
    if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ projects: [{ project: args[3], bots }] }), stderr: "" };
    return { code: 2, stdout: "", stderr: "stub am: not offered" };
  };
  state.exec = (command, args) => new Promise((resolve) => {
    const answered = am(command, args);
    if (answered) { resolve(answered); return; }
    if (command !== "sh" && command !== bin) { resolve({ code: 127, stdout: "", stderr: `cannot run ${command}: refused` }); return; }
    execFile(command, args, { env: { PATH: "/usr/bin:/bin", STUB_HOME: dir, STUB_VERSION: running, STUB_COMMANDS: commands ? "1" : "0",
      STUB_TARGETS: targets ? "1" : "0", STUB_HISTORY: JSON.stringify(history) } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
  const calls = () => readFileSync(join(dir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return {
    dir, bin, version,
    useVersion: (v) => { running = v; },
    saves: () => calls().filter((c) => c.argv[0] === "put" && !c.argv.includes("--dry-run")).map((c) => ({ argv: c.argv, raw: c.input, entry: JSON.parse(c.input) })),
    yaml: () => JSON.parse(readFileSync(yaml, "utf8")),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const handArgs = ["--sandbox", "workspace-write", "-c", "model_reasoning_effort=high"];

test("an edit that changes only the prompt keeps hand-written agent_args exactly (#501)", async () => {
  const s = stubScheduler([{ ...nightly("codex"), agent_args: handArgs }]);
  try {
    state.agents = [{ key: "codex", installed: true, run: ["codex"] }];
    const { view, cx } = await panel();
    assert.equal(view.bin, s.bin, "the stub, found in the temp home");
    view.edit("nightly", cx);
    await cx.settle();
    view.form.prompt.type("p, said again", cx);
    view.save(cx);
    await cx.settle();
    const saved = s.saves();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].argv, ["put", "--original", "nightly"]);
    assert.equal(saved[0].entry.prompt, "p, said again");
    assert.deepEqual(saved[0].entry.agent_args, handArgs, "sent to put as they were");
    assert.deepEqual(s.yaml()[0].agent_args, handArgs, "and still in the config after the put");
  } finally { s.done(); }
});

test("an edit of a paused automation keeps it paused (#501)", async () => {
  const s = stubScheduler([{ ...nightly("claude"), disabled: true }]);
  try {
    state.agents = [{ key: "claude", installed: true, run: ["claude"] }];
    const { view, cx } = await panel();
    view.edit("nightly", cx);
    await cx.settle();
    view.form.prompt.type("p, said again", cx);
    view.save(cx);
    await cx.settle();
    const saved = s.saves();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].entry.disabled, true, "sent to put still paused");
    assert.equal(s.yaml()[0].disabled, true, "and still paused in the config");
  } finally { s.done(); }
});

// ---- permission modes (#498) and the other fields put would erase (#501) ----
const { AUTO_ARGS, addressesIn, addressWarning, argsText, envText, modeOf, parseArgs, parseEnv, splitPermission, templateMode } =
  await import("../mods/am-automations/modes.js");
const ALL = [{ key: "claude", installed: true, run: ["claude"] }, { key: "codex", installed: true, run: ["codex"] }, { key: "pi", installed: true, run: ["pi"] }];
const TEMPLATES = { templates: [
  { name: "reviewer-opus", command: 'env PATH="$HOME/.local/bin:$PATH" claude --dangerously-skip-permissions --model claude-opus-5-5' },
  { name: "dev-sol", command: "codex --no-daemon --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-sol" },
  { name: "plain", command: "pi --model x" },
] };

/** A panel on the stub scheduler with every agent installed and the fake hc's templates. */
async function stubPanel(automations, options) {
  const s = stubScheduler(automations, options);
  state.agents = ALL;
  state.hc = async (args) => (args.join(" ") === "templates --json"
    ? { code: 0, stdout: JSON.stringify(TEMPLATES), stderr: "" } : { code: 2, stdout: "", stderr: "fake hc: not offered" });
  const p = await panel();
  return { s, ...p };
}

/** Fills a new automation's name, repo and prompt, then picks `agent` by its pill. */
async function fillNew(view, cx, draw, agent, prompt = "tidy up") {
  view.edit(null, cx);
  await cx.settle();
  view.form.name.type("job", cx);
  view.form.repo.type("/r", cx);
  view.form.prompt.type(prompt, cx);
  draw().get(`f-agent-${agent}`).click({}, cx);
  await cx.settle();
}

async function saveIt(view, cx) { view.save(cx); await cx.settle(); }

test("the automatic flags: codex skips approvals and sandbox, claude its permission prompts, pi none", () => {
  assert.deepEqual(AUTO_ARGS.codex, ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(AUTO_ARGS.claude, ["--dangerously-skip-permissions"]);
  assert.equal(AUTO_ARGS.pi, undefined);
});

for (const [agent, flag] of [["codex", "--dangerously-bypass-approvals-and-sandbox"], ["claude", "--dangerously-skip-permissions"]]) {
  test(`a new ${agent} automation saves with its automatic flag, and the form says so (#498)`, async () => {
    const { s, view, cx, draw } = await stubPanel([]);
    try {
      await fillNew(view, cx, draw, agent);
      const n = draw();
      assert.match(textOf(n.get("f-mode-auto")), new RegExp(flag), "the Automatic pill names the flag");
      assert.match(textOf(n.get("f-mode-now")), /^Runs automatic/);
      assert.ok(!n.has("f-mode-kept"), "a new entry has no saved args to keep");
      await saveIt(view, cx);
      const saved = s.saves();
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0].argv, ["put"]);
      assert.equal(saved[0].entry.agent, agent);
      assert.deepEqual(saved[0].entry.agent_args, [flag]);
      assert.deepEqual(s.yaml()[0].agent_args, [flag]);
    } finally { s.done(); }
  });
}

test("a new pi automation: no automatic mode, the form says so, and it saves no flags", async () => {
  const { s, view, cx, draw } = await stubPanel([]);
  try {
    await fillNew(view, cx, draw, "pi");
    const n = draw();
    assert.ok(!n.has("f-mode-auto"));
    assert.equal(textOf(n.get("f-mode-none")), "pi has no known automatic mode: it runs with its own default.");
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, [], "sent empty: put keeps a key it is not sent");
    assert.ok(!("agent_args" in s.yaml()[0]), "none in the config");
  } finally { s.done(); }
});

test("turning a new automation down to Agent default saves no automatic flag; extra words still go", async () => {
  const { s, view, cx, draw } = await stubPanel([]);
  try {
    await fillNew(view, cx, draw, "codex");
    draw().get("f-mode-default").click({}, cx);
    view.form.args.type('-c "model_reasoning_effort=high"', cx);
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, ["-c", "model_reasoning_effort=high"]);
  } finally { s.done(); }
});

test("an existing entry with no agent_args shows 'agent default' and stays without after a prompt-only edit", async () => {
  const { s, view, cx, draw } = await stubPanel([nightly("codex")]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    const n = draw();
    assert.equal(textOf(n.get("f-mode-kept")), "As saved: agent default");
    assert.equal(border(n.get("f-mode-kept")), "#accent", "picked: nothing is migrated on load");
    assert.equal(s.saves().length, 0, "opening the form saves nothing");
    view.form.prompt.type("p, said again", cx);
    await saveIt(view, cx);
    const saved = s.saves();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].entry.agent_args, [], "sent empty, which keeps none");
    assert.ok(!("agent_args" in s.yaml()[0]), "none in the config");
  } finally { s.done(); }
});

test("an existing entry shows its hand-written mode, and picking Automatic adds the flag and keeps its other words", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("codex"), agent_args: handArgs }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    assert.equal(textOf(draw().get("f-mode-kept")), "As saved: sandbox workspace-write");
    assert.equal(view.form.args.value(), "-c model_reasoning_effort=high", "the extra words, without the permission flags");
    draw().get("f-mode-auto").click({}, cx);
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, ["--dangerously-bypass-approvals-and-sandbox", "-c", "model_reasoning_effort=high"]);
  } finally { s.done(); }
});

test("an existing automatic entry turned down to Agent default loses only the permission flag", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("claude"), agent_args: ["--dangerously-skip-permissions", "--verbose"] }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    draw().get("f-mode-default").click({}, cx);
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, ["--verbose"]);
  } finally { s.done(); }
});

// v0.12.0 changed put to keep every key it is not sent (edit.go setKeys). A form that sent no
// agent_args for "none" would leave the old flag in place: agent_args always goes, [] for none.
test("an automatic-only entry turned down to Agent default keeps no flag in the config (v0.12 put)", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("codex"), agent_args: ["--dangerously-bypass-approvals-and-sandbox"] }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    draw().get("f-mode-default").click({}, cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.ok(saved.raw.includes(`"agent_args":[]`), "sent, and empty");
    assert.ok(!("agent_args" in s.yaml()[0]), "the bypass flag is gone from the config");
  } finally { s.done(); }
});

// Under an upstream scheduler close_workspace (and session) can only be hand-written: v0.12.1's put
// has no field for them, and a key it is sent with no value is removed. The panel never sends either
// there, so an edit keeps them.
test("a hand-written close_workspace and session survive a prompt-only edit; put is never sent them", async () => {
  const { s, view, cx } = await stubPanel([{ ...nightly("claude"), close_workspace: "on-success", session: "night" }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    view.form.prompt.type("p, said again", cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.ok(!("close_workspace" in saved.entry) && !("session" in saved.entry), "neither key sent");
    assert.equal(s.yaml()[0].close_workspace, "on-success");
    assert.equal(s.yaml()[0].session, "night");
    assert.equal(s.yaml()[0].prompt, "p, said again");
  } finally { s.done(); }
});

// ---- our scheduler build (#498): the close_workspace switch ----
// The panel installs and drives our build of the vendored fork (herdr/scheduler/), whose ls --json
// and put carry close_workspace; upstream DnzzL's v0.12.1 has no field for it. `version` tells them
// apart: ours contains "-am.".
const OUR = "0.12.1-am.1";

test("our scheduler: a new worktree automation closes its space after a successful run by default (D2)", async () => {
  const { s, view, cx, draw } = await stubPanel([], { version: OUR });
  try {
    const t = (await import(stubs.herdr)).theme();
    await fillNew(view, cx, draw, "claude");
    const toggle = draw().get("f-close");
    assert.ok(toggle, "the close switch is shown for a new worktree entry");
    assert.equal(bg(toggle), t.accent, "on by default");
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.equal(saved.entry.close_workspace, "on-success");
    assert.equal(s.yaml()[0].close_workspace, "on-success");
  } finally { s.done(); }
});

test("upstream: close_workspace is never sent, and one line says our build is needed (#595)", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("claude"), close_workspace: "on-success" }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    const n = draw();
    assert.ok(!n.has("f-close"), "no switch for an upstream binary");
    assert.match(textOf(n.get("f-close-upstream")), /Our scheduler build \(0\.12\.1-am\.1\) is needed/);
    view.form.prompt.type("p, said again", cx);
    await saveIt(view, cx);
    assert.ok(!("close_workspace" in s.saves()[0].entry), "never sent");
    assert.equal(s.yaml()[0].close_workspace, "on-success", "the stub would have removed it had it been sent");
  } finally { s.done(); }
});

test("an existing space hides the switch: close_workspace on-success is refused with workspace existing", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("claude"), workspace: "existing", workspace_id: "w7" }], { version: OUR });
  try {
    view.edit("nightly", cx);
    await cx.settle();
    assert.ok(!draw().has("f-close"), "no switch");
    assert.ok(!draw().has("f-close-upstream"), "and no upstream line: ours is installed");
    await saveIt(view, cx);
    assert.equal(s.saves()[0].entry.close_workspace, "never", "sent never, never on-success");
    assert.equal(s.yaml()[0].close_workspace, "never");
  } finally { s.done(); }
});

test("an existing entry shows ls's on-success, and switching the close switch off sends never", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("claude"), close_workspace: "on-success" }], { version: OUR });
  try {
    const t = (await import(stubs.herdr)).theme();
    view.edit("nightly", cx);
    await cx.settle();
    const toggle = draw().get("f-close");
    assert.ok(toggle, "shown for a worktree entry");
    assert.equal(bg(toggle), t.accent, "on: ls --json said on-success");
    toggle.click({}, cx);
    await cx.settle();
    assert.equal(bg(draw().get("f-close")), t.input, "off after the click");
    await saveIt(view, cx);
    assert.equal(s.saves()[0].entry.close_workspace, "never");
    assert.equal(s.yaml()[0].close_workspace, "never");
  } finally { s.done(); }
});

test("a binary swapped for upstream before Save: close_workspace is withheld (fail closed)", async () => {
  const { s, view, cx, draw } = await stubPanel([], { version: OUR });
  try {
    const t = (await import(stubs.herdr)).theme();
    await fillNew(view, cx, draw, "claude");
    assert.equal(bg(draw().get("f-close")), t.accent, "ours at start: the switch is on");
    s.useVersion("0.12.1"); // repaired to upstream while the panel is open, before the 30 s refresh
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.ok(!("close_workspace" in saved.entry), "the probe right before put says upstream");
    assert.ok(!("close_workspace" in s.yaml()[0]), "and nothing was written");
  } finally { s.done(); }
});

test("upstream at start, ours at Save: the key goes, because the switch is on", async () => {
  const { s, view, cx, draw } = await stubPanel([], { version: "0.12.1" });
  try {
    await fillNew(view, cx, draw, "claude");
    assert.ok(!draw().has("f-close"), "upstream at start: no switch");
    assert.ok(draw().has("f-close-upstream"), "one line says our build is needed");
    s.useVersion(OUR); // repaired to our build while the panel is open
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.equal(saved.entry.close_workspace, "on-success", "the fresh probe says ours, D2 is on");
    assert.equal(s.yaml()[0].close_workspace, "on-success");
  } finally { s.done(); }
});

test("the stub's put deletes a key outside putCmd's field list, like the real put (held #595 Low)", () => {
  const entry = { name: "nightly", cron: "0 9 * * 1-5", repo: "/r", workspace: "worktree", agent: "claude",
    prompt: "p", timeout_minutes: 60, close_workspace: "on-success", session: "night" };
  const upstream = stubScheduler([{ ...nightly("claude"), close_workspace: "on-success", session: "night" }]);
  const ours = stubScheduler([{ ...nightly("claude"), session: "night" }], { version: OUR });
  try {
    const put = (s) => execFileSync(s.bin, ["put", "--original", "nightly"], {
      input: JSON.stringify(entry), env: { PATH: "/usr/bin:/bin", STUB_HOME: s.dir, STUB_VERSION: s.version },
    });
    put(upstream);
    assert.ok(!("close_workspace" in upstream.yaml()[0]), "upstream's 15 fields: the 16th is removed");
    assert.ok(!("session" in upstream.yaml()[0]), "session is no field of either build");
    put(ours);
    assert.equal(ours.yaml()[0].close_workspace, "on-success", "ours' 16th field is written");
    assert.ok(!("session" in ours.yaml()[0]), "session is still no field of ours");
  } finally { upstream.done(); ours.done(); }
});

test("catch_up_minutes and workflow go back to put as they came (#501)", async () => {
  const wf = { name: "wf", cron: "0 9 * * *", repo: "/r", workspace: "root", agent: "claude", workflow: "nightly-review", catch_up_minutes: -1, timeout_minutes: 30 };
  const { s, view, cx } = await stubPanel([{ ...nightly("claude"), catch_up_minutes: 15 }, wf]);
  try {
    for (const name of ["nightly", "wf"]) {
      view.edit(name, cx);
      await cx.settle();
      view.form.timeout.type("45", cx);
      await saveIt(view, cx);
    }
    const [a, b] = s.saves();
    assert.equal(a.entry.catch_up_minutes, 15);
    assert.equal(b.entry.catch_up_minutes, -1);
    assert.equal(b.entry.workflow, "nightly-review");
    assert.equal(s.yaml()[0].catch_up_minutes, 15);
    assert.equal(s.yaml()[1].workflow, "nightly-review");
  } finally { s.done(); }
});

test("a template run shows its command's mode, and the panel adds no flags to it", async () => {
  const { s, view, cx, draw } = await stubPanel([{ name: "rev", cron: "0 9 * * *", repo: "/r", workspace: "worktree", template: "reviewer-opus", prompt: "p", timeout_minutes: 60 }]);
  try {
    assert.match(textOf(draw().get("auto-rev")), /automatic \(skips permissions\) \(template\)/, "the list row shows it");
    view.edit("rev", cx);
    await cx.settle();
    const n = draw();
    assert.ok(!n.has("f-mode-auto") && !n.has("f-args"), "no mode pills and no args for a template");
    assert.match(textOf(n.get("f-mode-template")), /^reviewer-opus: automatic \(skips permissions\)\. .*adds none/);
    view.form.prompt.type("p2", cx);
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, [], "a template entry with none sends none");
    await fillNew(view, cx, draw, "codex");
    draw().get("f-agent-template:dev-sol").click({}, cx);
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[1].entry.agent_args, [], "a new template entry gets no automatic flag either");
  } finally { s.done(); }
});

test("the detail view and the list row show the saved mode", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("codex"), agent_args: ["--dangerously-bypass-approvals-and-sandbox"] }]);
  try {
    assert.match(textOf(draw().get("auto-nightly")), /automatic \(no approvals, no sandbox\)$/);
    view.view = { kind: "detail", name: "nightly" };
    assert.match(textOf(view.render(cx)), /Permissions\s*automatic \(no approvals, no sandbox\)/);
  } finally { s.done(); }
});

test("modeOf, templateMode and the args line", () => {
  assert.equal(modeOf("claude", []), "agent default");
  assert.equal(modeOf("claude", undefined), "agent default");
  assert.equal(modeOf("claude", ["--permission-mode", "acceptEdits"]), "permission mode acceptEdits");
  assert.equal(modeOf("claude", ["--permission-mode=plan"]), "permission mode plan");
  assert.equal(modeOf("codex", ["--full-auto"]), "full auto (sandboxed)");
  assert.equal(modeOf("codex", ["-a", "never", "-s", "workspace-write"]), "approvals never · sandbox workspace-write");
  assert.equal(modeOf("pi", ["--model", "x"]), "agent default");
  assert.equal(templateMode("omp --auto-approve --model m"), "automatic (auto-approve)");
  assert.equal(templateMode("pi --model x"), "agent default");
  assert.equal(templateMode("./run-thing"), "not known (no agent in its command)");
  assert.deepEqual(splitPermission("codex", ["-c", "x", "-s", "read-only", "--yolo"]), { perm: ["-s", "read-only", "--yolo"], rest: ["-c", "x"] });
  const words = ["-c", 'a b', 'say "hi"', "plain"];
  assert.equal(argsText(words), '-c "a b" "say \\"hi\\"" plain');
  assert.deepEqual(parseArgs(argsText(words)), words);
  assert.deepEqual(parseArgs("  one 'two three'  "), ["one", "two three"]);
});

test("the address check: terminal addresses caught, words, ids, versions, URLs and branches left alone", () => {
  for (const [text, want] of [["ask t3q1 to merge", ["t3q1"]], ["send it to t35n.", ["t35n"]], ["on build-box/t9 first", ["build-box/t9"]],
    ["(t10d)", ["t10d"]], ["t3q1 and t3q1 then t2n3", ["t3q1", "t2n3"]]]) assert.deepEqual(addressesIn(text), want, text);
  for (const text of ["the", "test the tab", "to", "b-6jrz4bmxml", "v0.11.3", "https://example.com/t3q1", "http://h/t9/x",
    "feature/t3q1-fix", "fix/herdr-498-t3", "origin/t10d-x", "t-shirt", "at3q1", "T3Q1"]) assert.deepEqual(addressesIn(text), [], text);
  assert.equal(addressWarning("no address here"), null);
  assert.equal(addressWarning("ping t35n"), "t35n is a terminal address; it changes on restart. Name the bot instead (its name or b-… id).");
});

test("a prompt naming a terminal warns in the form and still saves (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([]);
  try {
    await fillNew(view, cx, draw, "claude", "ask t35n to clean up");
    assert.match(textOf(draw().get("f-address")), /^t35n is a terminal address/);
    await saveIt(view, cx);
    assert.equal(s.saves().length, 1, "saved all the same");
    assert.equal(s.yaml()[0].prompt, "ask t35n to clean up");
  } finally { s.done(); }
});

// ---- review fixes on #505 ----

test("hand-written args with the permission flag in the middle go back byte for byte (#501)", async () => {
  const middle = ["-c", "model_reasoning_effort=high", "--sandbox", "workspace-write", "--add-dir", "/work/a b", "-c", "x=1"];
  const { s, view, cx } = await stubPanel([{ ...nightly("codex"), agent_args: middle }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    view.form.prompt.type("p, said again", cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.ok(saved.raw.includes(`"agent_args":${JSON.stringify(middle)}`), "the same words, in the same order, byte for byte");
    assert.equal(JSON.stringify(s.yaml()[0].agent_args), JSON.stringify(middle));
  } finally { s.done(); }
});

test("switching an existing entry's agent drops the old agent's permission flags and lands on Agent default", async () => {
  const own = ["--verbose", "--dangerously-skip-permissions", "--add-dir", "/work"];
  const { s, view, cx, draw } = await stubPanel([{ ...nightly("claude"), agent_args: own }]);
  try {
    view.edit("nightly", cx);
    await cx.settle();
    assert.equal(textOf(draw().get("f-mode-kept")), "As saved: automatic (skips permissions)");
    draw().get("f-agent-codex").click({}, cx);
    await cx.settle();
    let n = draw();
    assert.ok(!n.has("f-mode-kept"), "no As saved pill for another agent's args");
    assert.equal(border(n.get("f-mode-default")), "#accent", "Agent default is picked, never Automatic");
    assert.equal(border(n.get("f-mode-auto")), "#border");
    assert.equal(textOf(n.get("f-mode-now")), "Runs agent default: codex --verbose --add-dir /work");
    // Back to the saved agent: its own args, exactly, once more.
    draw().get("f-agent-claude").click({}, cx);
    await cx.settle();
    n = draw();
    assert.equal(border(n.get("f-mode-kept")), "#accent");
    assert.deepEqual(view.entry().agent_args, own);
    draw().get("f-agent-codex").click({}, cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.equal(saved.entry.agent, "codex");
    assert.deepEqual(saved.entry.agent_args, ["--verbose", "--add-dir", "/work"], "no claude flag handed to codex");
  } finally { s.done(); }
});

test("a template entry switched to an agent keeps no permission flags from its saved args", async () => {
  const { s, view, cx, draw } = await stubPanel([{ name: "rev", cron: "0 9 * * *", repo: "/r", workspace: "worktree",
    template: "reviewer-opus", agent_args: ["--dangerously-skip-permissions", "--verbose"], prompt: "p", timeout_minutes: 60 }]);
  try {
    view.edit("rev", cx);
    await cx.settle();
    draw().get("f-agent-codex").click({}, cx);
    await cx.settle();
    assert.equal(border(draw().get("f-mode-default")), "#accent");
    await saveIt(view, cx);
    assert.deepEqual(s.saves()[0].entry.agent_args, ["--verbose"]);
  } finally { s.done(); }
});

test("a template list hc could not give is not kept: the next refresh asks again", async () => {
  const s = stubScheduler([{ name: "rev", cron: "0 9 * * *", repo: "/r", workspace: "worktree", template: "reviewer-opus", prompt: "p", timeout_minutes: 60 }]);
  try {
    state.agents = ALL;
    let up = false;
    state.hc = async () => (up ? { code: 0, stdout: JSON.stringify(TEMPLATES), stderr: "" } : { code: 1, stdout: "", stderr: "hc: no server" });
    const { view, cx, draw } = await panel();
    assert.match(textOf(draw().get("auto-rev")), /not known \(hc lists no such template\)/, "first read failed");
    up = true;
    await cx.ticks[0](cx);
    await cx.settle();
    assert.match(textOf(draw().get("auto-rev")), /automatic \(skips permissions\) \(template\)/, "asked again and shown");
  } finally { s.done(); }
});

// ---- the command kind (#938) ----
// An automation may be a plain command the scheduler runs itself: no repo, no space, no agent, no
// model. The form offers the kind only to a scheduler whose ls --json names it (kinds), sends the
// command and its bot, and empties every agent key so put removes them. The rows and the detail
// show the run's one result line.
const NEXT = "0.12.1-am.2"; // any build of ours whose ls names the command kind
const check = { name: "daily-check", cron: "0 7 * * *", timeout_minutes: 10, catch_up_minutes: 120, workspace: "", repo: "",
  command: { argv: ["./check.sh", "--all"], cwd: "/srv/checks", env: { REGION: "eu" } }, notify: "b-captain" };

test("a scheduler that names the command kind: the form offers it, and a new command saves with no agent key", async () => {
  const { s, view, cx, draw } = await stubPanel([], { version: NEXT, commands: true });
  try {
    view.edit(null, cx);
    await cx.settle();
    let n = draw();
    assert.ok(n.has("f-kind-agent") && n.has("f-kind-command"), "both kinds are offered");
    assert.ok(!n.has("f-kind-old"));
    assert.ok(n.has("f-repo") && !n.has("f-command"), "a new automation starts as an agent prompt");
    n.get("f-kind-command").click({}, cx);
    await cx.settle();
    n = draw();
    for (const id of ["f-command", "f-cwd", "f-env", "f-notify", "f-timeout"]) assert.ok(n.has(id), `${id} is drawn`);
    for (const id of ["f-repo", "f-ws-worktree", "f-close", "f-agent-claude", "f-model", "f-mode-auto", "f-prompt", "f-mcp"])
      assert.ok(!n.has(id), `${id} is not drawn for a command`);
    assert.match(textOf(n.get("f-command-note")), /No shell reads this line/);
    assert.match(textOf(n.get("f-command-note")), /It runs as you/);
    assert.match(textOf(n.get("f-command-note")), /Exit 0 is done; any other exit, or the timeout, is failed\./);
    view.form.name.type("daily-check", cx);
    view.form.command.type('./check.sh --all "two words"', cx);
    view.form.cwd.type("~/checks", cx);
    view.form.env.type('REGION=eu NOTE="a b"', cx);
    view.form.notify.type("b-captain", cx);
    view.form.timeout.type("10", cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.deepEqual(saved.argv, ["put"]);
    assert.deepEqual(saved.entry.command, { argv: ["./check.sh", "--all", "two words"], cwd: `${s.dir}/checks`, env: { REGION: "eu", NOTE: "a b" } });
    assert.equal(saved.entry.notify, "b-captain");
    assert.equal(saved.entry.timeout_minutes, 10);
    for (const key of ["repo", "workspace", "workspace_id", "session", "agent", "template", "model", "prompt", "workflow", "mcp_config", "close_workspace"])
      assert.equal(saved.entry[key], "", `${key} goes empty, so put removes it`);
    assert.deepEqual(saved.entry.agent_args, [], "no automatic permission flag on a command");
    assert.deepEqual(Object.keys(s.yaml()[0]).sort(), ["command", "cron", "name", "notify", "timeout_minutes"]);
    assert.deepEqual(view.view, { kind: "detail", name: "daily-check" });
  } finally { s.done(); }
});

test("a scheduler that does not name the kind: no command form, one line says why, an agent saves as before", async () => {
  const { s, view, cx, draw } = await stubPanel([], { version: OUR });
  try {
    await fillNew(view, cx, draw, "claude");
    const n = draw();
    assert.ok(!n.has("f-kind-command") && !n.has("f-kind-agent") && !n.has("f-command"));
    assert.match(textOf(n.get("f-kind-old")), /runs agent prompts only\. A newer herdr-automations also runs a plain command, with no model\./);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.ok(!("command" in saved.entry) && !("notify" in saved.entry), "neither key is sent");
    assert.equal(saved.entry.agent, "claude");
  } finally { s.done(); }
});

test("an existing command opens as a command, and an edit keeps what the form does not show", async () => {
  const { s, view, cx, draw } = await stubPanel([{ ...check, disabled: true }], { version: NEXT, commands: true });
  try {
    view.edit("daily-check", cx);
    await cx.settle();
    const n = draw();
    assert.equal(view.form.kind, "command");
    assert.equal(view.form.command.value(), "./check.sh --all");
    assert.equal(view.form.cwd.value(), "/srv/checks");
    assert.equal(view.form.env.value(), "REGION=eu");
    assert.equal(view.form.notify.value(), "b-captain");
    assert.ok(n.has("f-command") && !n.has("f-prompt"));
    view.form.command.type("./check.sh --quick", cx);
    await saveIt(view, cx);
    const [saved] = s.saves();
    assert.deepEqual(saved.argv, ["put", "--original", "daily-check"]);
    assert.deepEqual(s.yaml()[0].command, { argv: ["./check.sh", "--quick"], cwd: "/srv/checks", env: { REGION: "eu" } });
    assert.equal(s.yaml()[0].notify, "b-captain");
    assert.equal(s.yaml()[0].disabled, true, "a paused command stays paused");
    assert.equal(s.yaml()[0].catch_up_minutes, 120);
  } finally { s.done(); }
});

test("a word in ENV that is not KEY=value is said in the form and nothing is saved", async () => {
  const { s, view, cx, draw } = await stubPanel([check], { version: NEXT, commands: true });
  try {
    view.edit("daily-check", cx);
    await cx.settle();
    view.form.env.type("REGION=eu loose", cx);
    await cx.settle();
    assert.match(textOf(draw().get("f-result")), /ENV: "loose" is not KEY=value/);
    await saveIt(view, cx);
    assert.equal(s.saves().length, 0, "no put was sent");
    assert.equal(view.view.kind, "form", "the form stays open");
  } finally { s.done(); }
});

test("a command switched to an agent prompt drops its command and its bot; the other way drops the agent's keys", async () => {
  const { s, view, cx, draw } = await stubPanel([check, { ...nightly("codex"), agent_args: ["--yolo"], close_workspace: "on-success" }], { version: NEXT, commands: true });
  try {
    view.edit("daily-check", cx);
    await cx.settle();
    draw().get("f-kind-agent").click({}, cx);
    view.form.repo.type("/r", cx);
    view.form.prompt.type("look around", cx);
    await saveIt(view, cx);
    let entry = s.yaml()[0];
    assert.ok(!("command" in entry) && !("notify" in entry), "the command and its bot are gone");
    assert.equal(entry.prompt, "look around");
    assert.equal(entry.agent, "claude");
    assert.equal(entry.workspace, "worktree");

    view.edit("nightly", cx);
    await cx.settle();
    draw().get("f-kind-command").click({}, cx);
    view.form.command.type("/usr/bin/true", cx);
    await saveIt(view, cx);
    entry = s.yaml()[1];
    assert.deepEqual(entry.command, { argv: ["/usr/bin/true"], cwd: "", env: {} });
    for (const key of ["repo", "workspace", "agent", "prompt", "agent_args", "close_workspace"]) assert.ok(!(key in entry), `${key} is removed`);
  } finally { s.done(); }
});

test("the list row and the inbox show a command's result line, and the detail spells its last run out", async () => {
  const at = new Date(Date.now() - 120000).toISOString();
  const failed = { run_id: "r2", automation: "daily-check", status: "failed", started: at, at, seconds: 3, seen: false,
    error: "exited 7", exit_code: 7, result: "exited 7: no route to host", stderr: "warming up\nno route to host", notified: "sent to t7" };
  const done = { run_id: "r1", automation: "daily-check", status: "done", started: at, at, seconds: 2, seen: false,
    exit_code: 0, result: "12 checked, 0 broken", notified: "not delivered: hc send: blocked" };
  const { s, view, cx, draw } = await stubPanel([{ ...check, last: failed }], { version: NEXT, commands: true, history: [failed, done] });
  try {
    let n = draw();
    assert.equal(textOf(n.get("auto-kind-daily-check")), "command · ./check.sh --all · tells b-captain");
    assert.equal(textOf(n.get("inbox-line-r2")), "exited 7: no route to host", "a failed run: why, and its last stderr line");
    assert.equal(textOf(n.get("inbox-line-r1")), "12 checked, 0 broken", "a done run: its last line of output");
    view.view = { kind: "detail", name: "daily-check" };
    n = draw();
    const text = textOf(view.render(cx));
    assert.match(text, /Runs\s*a command, as you, no model/);
    assert.match(text, /Folder\s*\/srv\/checks/);
    assert.match(text, /Tells\s*b-captain/);
    assert.doesNotMatch(text, /Permissions|Repo|Agent\b/);
    assert.equal(textOf(n.get("d-work")), "./check.sh --all");
    assert.match(textOf(n.get("d-last-status")), /^failed · exit 7 · /);
    assert.equal(textOf(n.get("d-last-result")), "exited 7: no route to host");
    assert.match(textOf(n.get("d-last-stderr")), /warming up\s*no route to host/);
    assert.equal(textOf(n.get("d-last-notified")), "b-captain: sent to t7");
    assert.equal(textOf(n.get("h-line-r1")), "12 checked, 0 broken");
    assert.equal(textOf(n.get("h-line-r2")), "exited 7: no route to host");
  } finally { s.done(); }
});

// ---- #938: the panel as the footer opens it, a popup ----
// The footer's Automations tab opens this mod as a popup (am-footer PANEL_POPUP), which Herdr makes
// as tall as its content, its height share only the most. Seen in a scratch Herdr 0.1.13 and
// 0.1.15: with its body built on overflow_y_scrollbar the panel drew its header alone there, and
// none of the list, the detail or the form (popup-layout.mjs: such a box measures 0 where its box
// is sized by its content). The body is now am-sidebar's bot-form shape (#239, #397). Laid out
// as that popup in an 820 px window (the app's default), every view shows its rows; in a layout
// block of a set height the body fills, as it always did.
import { layoutPopup } from "./popup-layout.mjs";

const builds = (node) => node.calls.map(([name]) => name);
const WINDOW_H = 820;
/** The footer's popup for this panel, read from am-footer's own PANEL_POPUP. */
function footerPopup() {
  const source = readFileSync(new URL("../mods/am-footer/main.js", import.meta.url), "utf8");
  const m = /PANEL_POPUP = Object\.freeze\(\{ kind: "popup", width: (\d+), height: ([\d.]+) \}\)/.exec(source);
  assert.ok(m, "am-footer opens the panel as a popup of a set width and a share of the window's height");
  return { width: Number(m[1]), height: Math.round(Number(m[2]) * WINDOW_H) };
}

/** The panel on a scheduler with the command kind, two command runs and an agent entry. */
async function commandPanel() {
  const at = new Date(Date.now() - 120000).toISOString();
  const failed = { run_id: "r2", automation: "daily-check", status: "failed", started: at, at, seconds: 3, seen: false,
    error: "exited 3", exit_code: 3, result: "exited 3: checksum mismatch", stderr: "opening archive\nchecksum mismatch",
    notified: "not delivered: hc send: no terminal" };
  const done = { run_id: "r1", automation: "daily-check", status: "done", started: at, at, seconds: 2, seen: false,
    exit_code: 0, result: "3 checks passed, 0 warnings", notified: "sent to t1" };
  return stubPanel([{ ...check, last: failed }, nightly("claude")], { version: NEXT, commands: true, history: [failed, done] });
}

/** The three views a person reaches: the list, a command's detail, a new command's form. */
const VIEWS = {
  list: async () => {},
  detail: async (view) => { view.view = { kind: "detail", name: "daily-check" }; },
  form: async (view, cx, draw) => { view.edit(null, cx); await cx.settle(); draw().get("f-kind-command").click({}, cx); await cx.settle(); },
};

for (const [name, open] of Object.entries(VIEWS)) {
  test(`${name}: the body scrolls in flow with a bar paired by name, so it has a height in a popup (#938)`, async () => {
    const { s, view, cx, draw } = await commandPanel();
    try {
      await open(view, cx, draw);
      const root = view.render(cx);
      index(root);
      const area = nodes.get("automations-body");
      assert.equal(area.kind, "div", "the scroll area, not the bar, carries the id");
      const body = builds(area);
      assert.ok(body.includes("overflow_y_scroll"), "the body scrolls past the popup's height");
      assert.ok(!body.includes("overflow_y_scrollbar"), "no scrollbar wrapper: it measures 0 in a popup");
      for (const call of ["flex_1", "min_h"]) assert.ok(body.includes(call), `the area has ${call}: a flex item, sized by its rows`);
      assert.ok(!body.includes("size_full") && !body.includes("h_full"), "no percentage height: it measures 0 in a popup (#397)");
      assert.ok(!body.includes("absolute"), "the area stays in flow, so its rows' height reaches the popup");
      const bars = all(root).filter((n) => n.kind.startsWith("scrollbar"));
      assert.equal(bars.length, 1, "one bar");
      const [bar] = bars;
      assert.equal(bar.kind, "scrollbar-y", "a vertical bar");
      assert.equal(bar.arg, "automations-body", "keyed to the scroll area");
      assert.ok(builds(bar).includes("absolute") && builds(bar).includes("inset_0"), "the bar fills its wrapper");
      const wrapper = all(root).find((n) => n.kids.some((k) => k?.__node === area));
      assert.ok(wrapper.kids.some((k) => k?.__node === bar), "the bar sits beside the area");
      assert.equal(wrapper.kind, "v_flex", "a flex column, so the area's flex_1 and min_h(0) apply");
      for (const call of ["relative", "flex_1", "min_h"]) assert.ok(builds(wrapper).includes(call), `the wrapper has ${call}`);
      assert.equal(nodes.get("automations").kids.at(-1)?.__node, wrapper, "the wrapper is the panel's body, under the header");
    } finally { s.done(); }
  });
}

// What each view must show in the popup: the command kind's rows and the result line (#938).
const SHOWN = {
  list: ["inbox-line-r2", "inbox-line-r1", "auto-kind-daily-check"],
  detail: ["d-last-status", "d-last-result", "d-work"],
  form: ["f-kind-agent", "f-kind-command", "f-command"],
};

for (const [name, open] of Object.entries(VIEWS)) {
  test(`${name}, laid out as the footer's popup: its rows show under the header, and the rest scrolls (#938)`, async () => {
    const { s, view, cx, draw } = await commandPanel();
    try {
      await open(view, cx, draw);
      const root = view.render(cx);
      index(root);
      const { height } = footerPopup();
      const pop = layoutPopup(root, { height }, nodes);
      const area = pop.box("automations-body");
      assert.ok(area.h > 0, `the body has a height (got ${area.h}); the popup is more than its header (got ${pop.height})`);
      assert.ok(pop.height <= height, `the popup stops at ${height} (got ${pop.height})`);
      assert.equal(area.h, Math.min(pop.contentOf("automations-body"), height - 2 - 42),
        "the body is as tall as its rows, or what the header leaves when they are taller");
      for (const id of SHOWN[name]) assert.ok(pop.box(id)?.visible > 0, `${id} shows (got ${JSON.stringify(pop.box(id))})`);
    } finally { s.done(); }
  });
}

test("in a layout block of a set height the body still fills what the header leaves (#938)", async () => {
  const { s, view, cx } = await commandPanel();
  try {
    const root = view.render(cx);
    index(root);
    const pop = layoutPopup(root, { height: 740, fixed: true }, nodes);
    assert.equal(pop.box("automations-body").h, 740 - 2 - 42, "border and header aside, all of it");
    assert.ok(pop.box("inbox-line-r2").visible > 0);
  } finally { s.done(); }
});

// The detail's value column truncates (kv), so a line wider than it loses its end. In a scratch
// Herdr 0.1.15, at the footer popup's 320 px, 33 characters of the column's 12 px text filled it
// before the ellipsis (about 6.2 px a character), and "a command, as you: no agent, no model" was
// cut at "no m…" (#938). The column is worked out from the panel's own builder calls; a character
// is taken as 6.5 px, wider than that measure.
const CHAR_PX = 6.5;
const callArg = (node, name) => node.calls.find(([m]) => m === name)?.[1];
test("a command's detail says how it runs in one line that fits the popup's value column (#938)", async () => {
  const { s, view, cx } = await commandPanel();
  try {
    view.view = { kind: "detail", name: "daily-check" };
    const root = view.render(cx);
    index(root);
    const panel = nodes.get("automations"), detail = nodes.get("automations-body").kids[0].__node;
    const row = all(root).find((n) => n.kind === "h_flex" && textOf(n.kids[0]) === "Runs");
    const label = row.kids[0].__node, value = textOf(row.kids[1]);
    assert.ok(builds(panel).includes("border_1"), "the panel draws a 1 px border");
    assert.ok(builds(row.kids[1].__node).includes("truncate"), "the value is cut, not wrapped, past its column");
    const column = footerPopup().width - 2 - 2 * callArg(detail, "p") - callArg(label, "w") - callArg(row, "gap");
    assert.equal(column, 204, "320 less the border, 2 x 14 padding, the 78 px label and the 8 px gap");
    assert.ok(value.length * CHAR_PX <= column, `"${value}" must fit: ${value.length * CHAR_PX} of ${column} px`);
    assert.equal(value, "a command, as you, no model");
  } finally { s.done(); }
});

test("an agent run's rows are as before: its error, else its duration", async () => {
  const at = new Date(Date.now() - 120000).toISOString();
  const runs = [
    { run_id: "a1", automation: "nightly", status: "failed", started: at, at, seconds: 90, seen: false, error: "agent blocked" },
    { run_id: "a2", automation: "nightly", status: "done", started: at, at, seconds: 90, seen: false },
  ];
  const { s, view, cx, draw } = await stubPanel([nightly("claude")], { version: NEXT, commands: true, history: runs });
  try {
    const n = draw();
    assert.equal(textOf(n.get("inbox-line-a1")), "agent blocked");
    assert.equal(textOf(n.get("inbox-line-a2")), "2m");
    assert.match(textOf(n.get("auto-kind-nightly")), /^claude · worktree · /);
    view.view = { kind: "detail", name: "nightly" };
    assert.ok(!draw().has("d-last"), "no LAST RESULT block for an agent");
    assert.match(textOf(view.render(cx)), /Permissions/);
  } finally { s.done(); }
});

test("envText and parseEnv: KEY=value words, quoted like the args line", () => {
  assert.equal(envText({ REGION: "eu", NOTE: "a b" }), 'REGION=eu NOTE="a b"');
  assert.deepEqual(parseEnv(envText({ A: 'say "hi"', B: "it's", C: "" })).env, { A: 'say "hi"', B: "it's", C: "" }, "a round trip");
  assert.deepEqual(parseEnv('REGION=eu "NOTE=a b" EMPTY='), { env: { REGION: "eu", NOTE: "a b", EMPTY: "" } });
  assert.deepEqual(parseEnv('NOTE="a b"'), { env: { NOTE: "a b" } }, "a quote after the = keeps its words");
  assert.deepEqual(parseEnv(""), { env: {} });
  assert.equal(parseEnv("=x").problem, 'ENV: "=x" is not KEY=value');
  assert.equal(envText(undefined), "");
});

// ---- put and the form write the same file (#938) ----
// A bot writes an automation with `herdr-automations put` and no agent_args; the form sends the
// automatic mode's flags. Our put now applies the same default to a new automation, and the proof
// is in two halves over one fixture: here, that `form` is what the real form sends for the
// definition and `put` is that definition without agent_args; in herdr/scheduler/main_test.go, that
// the real put writes the same automations.yaml for both.
const PARITY = JSON.parse(readFileSync(new URL("./fixtures/automation-put-parity.json", import.meta.url), "utf8"));

test("the put/form parity fixture covers every agent the form offers, and no other", () => {
  assert.deepEqual(PARITY.cases.map((c) => c.agent).sort(), ALL.map((a) => a.key).sort());
});

for (const c of PARITY.cases) {
  test(`a new ${c.agent} automation: the form sends the parity fixture's payload (#938)`, async () => {
    const { s, view, cx, draw } = await stubPanel([], { version: OUR });
    try {
      await fillNew(view, cx, draw, c.agent, c.form.prompt);
      await saveIt(view, cx);
      const saved = s.saves();
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0].argv, ["put"]);
      assert.deepEqual(saved[0].entry, c.form, "the fixture's form payload is the real form's");
      const { agent_args: flags, ...definition } = c.form;
      assert.deepEqual(c.put, definition, "the put side is the same definition, without agent_args");
      assert.deepEqual(flags, AUTO_ARGS[c.agent] ? [...AUTO_ARGS[c.agent]] : [], "the form's default is the automatic mode");
    } finally { s.done(); }
  });
}

// ---- targets (#498): a bot, or a worker of one, instead of a fresh session ----

const housekeeper = { id: "b-6jrz4bmxml", name: "Housekeeper" };
const targetEntry = { name: "housekeeping", cron: "0 9 * * *", repo: "/r", prompt: "tidy", target: "bot:b-6jrz4bmxml" };

/** A new form on a target-aware stub, with the name, repo and prompt filled in. */
async function fillTarget(view, cx, draw, { runs = "bot", bot = housekeeper.id, prompt = "tidy the house" } = {}) {
  view.edit(null, cx);
  await cx.settle();
  view.form.name.type("housekeeping", cx);
  view.form.repo.type("/r", cx);
  view.form.prompt.type(prompt, cx);
  draw().get(`f-runs-${runs}`).click({}, cx);
  await cx.settle();
  draw().get(`f-bot-${bot}`).click({}, cx);
  await cx.settle();
}

test("a scheduler that names targets: a bot target saves the bot's id, no agent and no space (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([], { targets: true, bots: [housekeeper] });
  try {
    view.edit(null, cx);
    await cx.settle();
    assert.ok(draw().has("f-runs-none"), "New session stays the first choice");
    assert.ok(draw().has("f-runs-bot"), "a bot is offered");
    assert.ok(draw().has("f-runs-worker"), "a worker of a bot is offered");
    view.form.name.type("housekeeping", cx);
    view.form.repo.type("/r", cx);
    view.form.prompt.type("tidy the house", cx);
    draw().get("f-runs-bot").click({}, cx);
    await cx.settle();
    assert.equal(textOf(draw().get("f-bot-b-6jrz4bmxml")), "Housekeeper", "the roster names the bot");
    assert.ok(draw().has("f-busy-queue") && draw().has("f-busy-skip"), "busy is configurable");
    draw().get("f-bot-b-6jrz4bmxml").click({}, cx);
    await cx.settle();
    assert.equal(view.form.bot, housekeeper.id);
    assert.match(textOf(draw().get("f-target-note")), /bot's own terminal with hc send/);
    view.save(cx);
    await cx.settle();
    const saved = s.saves();
    assert.equal(saved.length, 1);
    const e = saved[0].entry;
    assert.equal(e.target, "bot:b-6jrz4bmxml");
    assert.equal(e.target_when_busy, "queue", "queue is the default");
    assert.equal(e.workspace, "");
    assert.equal(e.agent, "");
    assert.deepEqual(e.agent_args, []);
    assert.equal(s.yaml()[0].target, "bot:b-6jrz4bmxml");
    assert.ok(!s.yaml()[0].agent, "a target writes no agent");
    assert.ok(!s.yaml()[0].workspace, "a target opens no space");
  } finally { s.done(); }
});

test("a bot target told to skip a busy bot saves target_when_busy: skip (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([], { targets: true, bots: [housekeeper] });
  try {
    await fillTarget(view, cx, draw);
    draw().get("f-busy-skip").click({}, cx);
    await cx.settle();
    view.save(cx);
    await cx.settle();
    assert.equal(s.saves()[0].entry.target_when_busy, "skip");
    assert.equal(s.yaml()[0].target_when_busy, "skip");
  } finally { s.done(); }
});

test("a worker target saves no busy rule, and the row and detail name the bot (#498)", async () => {
  const entry = { ...targetEntry, target: "worker:b-6jrz4bmxml" };
  const { s, view, cx, draw } = await stubPanel([entry], { targets: true, bots: [housekeeper] });
  try {
    await cx.settle();
    assert.match(textOf(draw().get("auto-kind-housekeeping")), /a worker of Housekeeper · its own launch/);
    view.view = { kind: "detail", name: "housekeeping" };
    const detail = textOf(view.render(cx));
    assert.match(detail, /Target/);
    assert.match(detail, /a worker of Housekeeper/);
    assert.match(detail, /the bot's own/);
    view.edit("housekeeping", cx);
    await cx.settle();
    assert.equal(view.form.target, "worker");
    assert.equal(view.form.bot, housekeeper.id);
    assert.ok(!draw().has("f-busy-queue"), "a worker runs alongside its bot and has no busy rule");
    assert.match(textOf(draw().get("f-target-note")), /fresh worktree, and is ended when the run finishes/);
    view.form.prompt.type(" again", cx);
    view.save(cx);
    await cx.settle();
    assert.equal(s.saves()[0].entry.target, "worker:b-6jrz4bmxml");
    assert.equal(s.saves()[0].entry.target_when_busy, "");
    assert.equal(s.yaml()[0].target, "worker:b-6jrz4bmxml");
    assert.ok(!s.yaml()[0].target_when_busy, "no busy rule is written");
  } finally { s.done(); }
});

test("a bot that left the roster is warned about, and Save refuses (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([targetEntry], { targets: true, bots: [] });
  try {
    view.edit("housekeeping", cx);
    await cx.settle();
    const warn = textOf(draw().get("f-target-warn"));
    assert.match(warn, /no longer in this project's bots.json/);
    view.form.prompt.type(" again", cx);
    view.save(cx);
    await cx.settle();
    assert.equal(s.saves().length, 0, "nothing was written for a bot this project no longer has");
    assert.match(textOf(draw().get("f-result")), /no longer in this project's bots.json/);
  } finally { s.done(); }
});

test("switching a target back to a new session removes it and restores the agent keys (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([targetEntry], { targets: true, bots: [housekeeper] });
  try {
    view.edit("housekeeping", cx);
    await cx.settle();
    draw().get("f-runs-none").click({}, cx);
    await cx.settle();
    assert.ok(draw().has("f-agent-claude"), "the agent picker is back");
    assert.ok(draw().has("f-ws-worktree"), "the space picker is back");
    view.save(cx);
    await cx.settle();
    assert.equal(s.saves()[0].entry.target, "");
    assert.equal("target" in s.yaml()[0], false, "the key is removed");
    assert.equal(s.yaml()[0].agent, "claude");
    assert.equal(s.yaml()[0].workspace, "worktree");
  } finally { s.done(); }
});

test("an older scheduler offers no target and keeps a hand-written one as it is (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([targetEntry], { bots: [housekeeper] });
  try {
    view.edit("housekeeping", cx);
    await cx.settle();
    assert.ok(!draw().has("f-runs-bot"), "no target on a build that does not name the kind");
    assert.equal(view.form.target, "kept");
    assert.match(textOf(draw().get("f-target-kept")), /cannot run a target/);
    view.form.prompt.type(" again", cx);
    view.save(cx);
    await cx.settle();
    assert.equal(s.saves().length, 0, "the entry is never rewritten");
    assert.match(textOf(draw().get("f-result")), /cannot run a target/);
    assert.equal(s.yaml()[0].target, "bot:b-6jrz4bmxml", "the hand-written target is kept");
  } finally { s.done(); }
});

test("a scheduler without targets: an agent save carries no target key (#498)", async () => {
  const { s, view, cx, draw } = await stubPanel([nightly("claude")], { bots: [housekeeper] });
  try {
    await fillNew(view, cx, draw, "claude");
    view.form.name.set_value("plain");
    view.save(cx);
    await cx.settle();
    assert.equal("target" in s.saves()[0].entry, false);
    assert.equal("target" in s.yaml()[0], false);
  } finally { s.done(); }
});
