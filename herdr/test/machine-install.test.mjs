import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { signedRelease } from "../../am/test/signed-release.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const PACK = new URL("../mods/am-sidebar/", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const run = promisify(execFile);
const OLD = "3.162.3", V = "3.162.4", NEXT = "3.162.5";
const tool = (name) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tools = Object.fromEntries(["sh", "cat", "mkdir", "mktemp", "chmod", "rm", "dirname", "readlink", "id", "stat", "tar", "gzip", "head", "tr", "grep", "sed", "cut", "sleep", "git", "ps"]
  .map((name) => [name, tool(name)]));
const sha = (() => { try { return ["sha256sum", tool("sha256sum")]; } catch { return ["shasum", tool("shasum")]; } })();
const put = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };
const exe = (path, body) => { put(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
const jsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

// The native proof (#206): CI's "am on a linked machine (native)" job sets this on a real Linux and
// macOS arm64 runner. Elsewhere the native rows are skipped: they assert this computer's own system.
const NATIVE = process.env.AM_LINKED_NATIVE === "1";
// A service's PATH (launchd's, a sparse systemd unit's): no node and no user folders on it.
const SPARSE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * `native`: the far side runs on this computer's own uname, tools and a sparse service PATH,
 * with node found the way run.sh finds Homebrew's (its runtime folders); only the network is a
 * stand-in (the curl that serves the signed release folder for the documented HTTPS URLs).
 */
function fleet(t, { node = true, target = "Linux x86_64", release = true, native = false } = {}) {
  const root = scratchRoot(t, "am-linked-");
  const home = join(root, "vm"), app = join(root, "app"), farApp = join(home, ".config/herdr-app");
  const controller = join(root, "controller"), cbin = join(root, "bin"), bin = join(root, "vm-bin");
  const store = join(home, ".automagik/parts/automagik.am"), local = join(home, ".local/bin");
  const runtime = join(root, "runtime"), config = join(root, "fleet.json"), log = join(root, "hc.log");
  for (const dir of [home, app, cbin, bin, runtime, dirname(farApp)]) mkdirSync(dir, { recursive: true });
  const lane = signedRelease(root);
  cpSync(PACK, controller, { recursive: true });
  put(join(controller, "am-keys.json"), lane.keys);
  exe(join(cbin, "hc"), `exec "${process.execPath}" "${FAKE_HC}" "$@"`);
  for (const [name, path] of [...Object.entries(tools), sha]) symlinkSync(path, join(bin, name));
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  if (!native) exe(join(bin, "uname"), `[ "$*" = '-sm' ] || exit 1\nprintf '%s\\n' '${target}'`);
  lane.curl(bin);
  exe(join(bin, "test"), 'test "$@"');
  const network = join(root, "network");
  if (native) {
    mkdirSync(network);
    lane.curl(network);
    symlinkSync(process.execPath, join(runtime, "node"));
  }
  const cli = join(controller, "bin/automagik-herdr.mjs");
  const env = { ...process.env, HOME: join(root, "here"), HERDR_APP_HOME: app, PATH: `${cbin}:${process.env.PATH}`,
    HC_FAKE_STATE: config, HC_FAKE_LOG: log, AUTOMAGIK_HERDR_RUNTIME_DIRS: runtime, AUTOMAGIK_HERDR_NO_UPDATE: "",
    HC_SESSION: "", HC_SOCKET: "", HC_TERMINAL_ID: "", AM_HOME: "", AM_RELEASE_URL: "file:///unused", AM_TRUSTED_KEYS: '{"keys":[]}' };
  const far = { HOME: home, PATH: native ? `${network}:${SPARSE_PATH}` : bin, NODE_OPTIONS: process.env.NODE_OPTIONS, NVM_DIR: "", HERDR_APP_HOME: farApp, AM_RELEASE_URL: `file://${lane.releases}`, AM_TRUSTED_KEYS: undefined,
    TMPDIR: root, AUTOMAGIK_HERDR_RUNTIME_DIRS: runtime, GIT_CEILING_DIRECTORIES: root, AUTOMAGIK_HERDR_NO_UPDATE: "" };
  const state = { terminals: [], machines: [{ name: "vm", id: "core-vm", state: "connected", home, env: { ...far, AM_TRUSTED_KEYS: "" } }] };
  put(config, JSON.stringify(state));
  const change = (fn) => { const s = jsonFile(config); fn(s); put(config, JSON.stringify(s)); };
  const listen = (version = V, options = {}) => {
    const { dir, archive } = lane.pack(version, options);
    return { dir, archive, ...lane.post(version, archive) };
  };
  const posted = release ? listen() : null;
  const command = (args, overrides = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ...r, json: () => { assert.ok(r.stdout, r.stderr || r.error?.message); return JSON.parse(r.stdout); } };
  };
  const args = ["machines", "install", "--machine", "vm", "--json"];
  const install = (...extra) => command([...args, ...extra]);
  const farAm = (...args) => spawnSync("/bin/sh", [join(local, "am"), ...args], { env: far, cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const setup = (dir) => {
    const r = spawnSync(process.execPath, [join(dir, "bin/am.mjs"), "self", "install"], { env: far, cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, r.stderr);
  };
  const record = () => jsonFile(join(store, "record.json"));
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, home, app, farApp, controller, bin, store, local, env, far, lane, cli, change, listen, posted, command, install,
    args, farAm, setup, record, calls, runtime, stateFile: join(app, "automagik-herdr/linked-updates.json") };
}

function result(r, expected, why) {
  assert.equal(r.status, ["installed", "current", "there", "made"].includes(expected) ? 0 : 1, `${r.stdout}\n${r.stderr}`);
  const out = r.json();
  assert.equal(out.state, expected, r.stdout);
  if (why) assert.match(out.why, why);
  return out;
}

function installed(s, version = V) {
  const r = s.record();
  assert.equal(r.current.version, version);
  assert.equal(r.current.signed, true);
  assert.equal(r.entry, false);
  assert.equal(readlinkSync(join(s.local, "am")), join(s.store, "current/bin/am"));
  assert.equal(readlinkSync(join(s.local, "automagik-herdr")), join(s.store, "current/bin/automagik-herdr"));
  assert.equal(existsSync(join(s.farApp, "automagik-herdr/briefing.mjs")), false);
  return r;
}

const cycle = (s) => s.command(["machines", "update", "--linked", "--json"]);
const bootstrap = (argv) => argv.some((word) => word.includes('self install --signed "$tmp"'));

test("round 1: linked store and parent directories are refused before placement", async (t) => {
  for (const mode of ["store link", "parts link", "am home link", "store file"]) await t.test(mode, (t) => {
    const s = fleet(t);
    const amHome = dirname(dirname(s.store));
    const path = { "store link": s.store, "parts link": dirname(s.store), "am home link": amHome, "store file": s.store }[mode];
    const target = join(s.root, "unrelated");
    const unrelated = join(target, relative(path, s.store), "keep.txt");
    put(unrelated, "keep me\n");
    if (mode === "store file") put(path, "not a directory\n");
    else {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(target, path);
    }
    cpSync(s.posted.archive, join(s.lane.lane, s.posted.pointer.tarball.name));
    const direct = spawnSync(process.execPath, [join(s.posted.dir, "bin/am.mjs"), "self", "install", "--signed", s.lane.lane, "--json"], {
      env: s.far, cwd: s.home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(direct.status, 1, direct.stdout || direct.stderr);
    assert.equal(JSON.parse(direct.stdout).state, "broken");
    assert.equal(readFileSync(unrelated, "utf8"), "keep me\n");
    assert.deepEqual(readdirSync(dirname(unrelated)), ["keep.txt"]);
    assert.ok(result(s.install("--check"), "broken").why.includes(path));
    result(s.install(), "broken");
    assert.equal(s.calls().some(bootstrap), false);
  });
});

test("round 1: untraversable command links are repaired and the launcher runs through the user-facing link", (t) => {
  const s = fleet(t);
  s.setup(s.posted.dir);
  for (const name of ["am", "automagik-herdr"]) {
    const path = join(s.local, name);
    rmSync(path);
    symlinkSync(`${s.store}/missing-dir/../current/bin/${name}`, path);
    assert.equal(existsSync(path), false);
  }
  s.listen(V, { edit: (d) => exe(join(d, "bin/am"), `[ "$0" = '${join(s.local, "am")}' ] || exit 99\necho 'am ${V}'`) });
  result(s.install("--check"), "incomplete");
  result(s.install(), "installed");
  installed(s);
  for (const name of ["am", "automagik-herdr"]) assert.ok(existsSync(join(s.local, name)));
});

test("round 1: death after publication leaves verification pending until a launcher passes", (t) => {
  const s = fleet(t);
  s.setup(s.listen(OLD).dir);
  assert.equal(s.farAm("self", "uninstall").status, 0);
  const old = s.record().current;
  const checking = join(s.home, "checking"), allow = join(s.home, "allow");
  s.listen(V, { edit: (d) => exe(join(d, "bin/am"), `if [ ! -f '${checking}' ]; then
  : > '${checking}'
  kill -KILL "$PPID"
  exit 99
fi
[ -f '${allow}' ] || exit 99
echo 'am ${V}'`) });
  assert.equal(s.install().status, 1);
  assert.equal(s.record().current.version, V);
  assert.ok(existsSync(checking));
  result(s.install("--check"), "incomplete", /verification pending/);
  result(s.install(), "broken", /--version/);
  result(s.install("--check"), "incomplete", /verification pending/);
  put(allow, "");
  result(s.install(), "installed");
  assert.deepEqual(s.record().previous, old);
  assert.equal(readlinkSync(join(s.store, "previous")), old.dir);
  result(s.install(), "current");
});

test("an interrupted signed install before record replacement keeps the retained rollback version", (t) => {
  const s = fleet(t);
  s.setup(s.listen(OLD).dir);
  assert.equal(s.farAm("self", "uninstall").status, 0);
  const recordPath = join(s.store, "record.json");
  const old = s.record().current;
  assert.equal(s.record().previous, null);
  s.listen(V);
  const interrupt = join(s.root, "before-record.cjs");
  put(interrupt, `
if (process.argv.includes("--signed")) {
  const fs = require("node:fs");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === ${JSON.stringify(recordPath)}) process.kill(process.pid, "SIGKILL");
    return rename(from, to);
  };
  require("node:module").syncBuiltinESMExports();
}
`);
  s.change((f) => {
    f.machines[0].env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${interrupt}`].filter(Boolean).join(" ");
  });
  assert.equal(s.install().status, 1);
  assert.deepEqual(s.record().current, old, "the old record was still current at interruption");
  assert.deepEqual(jsonFile(join(s.store, ".verification-pending")), { current: old, previous: null });
  result(s.install("--check"), "incomplete", /verification pending/);

  s.change((f) => { f.machines[0].env.NODE_OPTIONS = process.env.NODE_OPTIONS; });
  s.listen(NEXT);
  result(s.install(), "installed");
  assert.deepEqual(installed(s, NEXT).previous, old);
  assert.equal(readlinkSync(join(s.store, "previous")), old.dir);
  assert.equal(s.farAm("rollback", "automagik.am").status, 0);
  assert.equal(s.farAm("--version").stdout.trim(), `am ${OLD}`);
});

test("linked retry preserves the recorded rollback and trees when the saved slot cannot be verified", async (t) => {
  for (const mode of ["missing", "wrong version"]) await t.test(mode, (t) => {
    const s = fleet(t);
    s.setup(s.listen(OLD).dir);
    assert.equal(s.farAm("self", "uninstall").status, 0);
    s.listen(V);
    result(s.install(), "installed");
    const { current, previous } = s.record();
    const saved = { ...previous, version: "3.162.2", dir: "3.162.2", sequence: 1620002 };
    if (mode === "wrong version") cpSync(join(s.store, current.dir), join(s.store, saved.dir), { recursive: true });
    else {
      unlinkSync(join(s.store, "previous"));
      symlinkSync(saved.dir, join(s.store, "previous"));
    }
    const marker = join(s.store, ".verification-pending");
    put(marker, JSON.stringify({ current: saved, previous: null }));
    s.listen(NEXT);
    result(s.install(), "installed");
    assert.deepEqual(installed(s, NEXT).previous, previous);
    assert.equal(readlinkSync(join(s.store, "previous")), previous.dir);
    assert.ok(existsSync(join(s.store, current.dir)), "trees outside the saved record are left in place");
    assert.equal(existsSync(join(s.store, saved.dir)), mode === "wrong version");
    assert.equal(existsSync(marker), false);
  });
});

test("a legacy empty verification marker keeps the recorded current only if its launcher verifies", async (t) => {
  for (const healthy of [false, true]) await t.test(healthy ? "verified" : "unverified", (t) => {
    const s = fleet(t);
    result(s.install(), "installed");
    const { current, previous } = s.record();
    assert.equal(previous, null);
    if (!healthy) exe(join(s.store, current.dir, "bin/am"), "echo 'am 3.0.0'");
    const marker = join(s.store, ".verification-pending");
    put(marker, "");
    s.listen(NEXT);
    const retry = result(s.install(), "installed");
    assert.deepEqual(installed(s, NEXT).previous, healthy ? current : null);
    assert.equal(existsSync(join(s.store, "previous")), healthy);
    assert.equal(existsSync(marker), false);
    if (healthy) assert.equal(retry.why, undefined);
    else assert.equal(retry.why, `am ${V} failed launcher verification and was not kept for rollback`);
  });
});

test("round 1: a signed slot and seen damaged together cannot lower the downgrade floor", async (t) => {
  for (const slot of ["current", "previous"]) await t.test(slot, (t) => {
    const s = fleet(t);
    if (slot === "previous") s.setup(s.lane.pack(OLD).dir);
    s.listen(NEXT);
    if (slot === "previous") {
      assert.equal(s.farAm("update", "automagik.am", "--json").status, 0);
      assert.equal(s.farAm("rollback", "automagik.am").status, 0);
    } else result(s.install(), "installed");
    assert.equal(s.farAm("self", "uninstall").status, 0);
    const record = s.record();
    assert.equal(record[slot].version, NEXT);
    assert.equal(record[slot].signed, true);
    record[slot].sequence = 1;
    record.seen = Math.max(1, record[slot === "current" ? "previous" : "current"]?.sequence ?? 0);
    put(join(s.store, "record.json"), JSON.stringify(record));
    s.listen(V);
    result(s.install(), "broken", /record damaged/);
    assert.deepEqual(s.record(), record);
  });
});

test("round 1: machines install rejects unsupported options before taking a lock or dispatching", async (t) => {
  for (const flag of ["--dry-run", "--all", "--version", "--help", "--force"]) await t.test(flag, (t) => {
    const s = fleet(t);
    const reply = s.install(flag);
    assert.equal(reply.status, 2, reply.stdout || reply.stderr);
    assert.equal(reply.json().state, "refused");
    assert.match(reply.json().why, new RegExp(flag));
    assert.equal(existsSync(dirname(s.stateFile)), false);
    assert.deepEqual(s.calls(), []);
  });
});

test("round 1: only an acknowledged success with matching read-back can succeed", async (t) => {
  for (const mode of ["nonzero", "ok false", "lost final probe", "missing on read-back"]) await t.test(mode, (t) => {
    const s = fleet(t);
    if (mode === "lost final probe") {
      s.change((f) => { f.installExecReply = { contains: "node_ok()", nth: 2, lost: true }; });
      result(s.install(), "unknown", /stopped answering/);
      installed(s);
      assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "unknown");
      return;
    }
    const code = mode === "nonzero" ? 1 : 0;
    const reply = { ok: mode !== "ok false", state: "installed", version: V, detail: "remote reply" };
    s.change((f) => { f.installExecReply = { contains: 'self install --signed "$tmp"', code, reply }; });
    result(s.install(), "failed", mode === "missing on read-back" ? /read-back did not find am/ : /remote reply/);
    assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "failed");
  });
});

test("round 1: an hourly cycle runs and preserves unreadable or malformed history", async (t) => {
  for (const mode of ["unreadable", "bad JSON", "invalid state shape"]) await t.test(mode, (t) => {
    const s = fleet(t);
    const original = mode === "bad JSON" ? '{"machines":{"other":' : mode === "invalid state shape"
      ? '{"machines":[{"install":{"state":"installed"}}]}' : JSON.stringify({ machines: { sibling: { install: { state: "installed" } } } });
    put(s.stateFile, original);
    if (mode === "unreadable") chmodSync(s.stateFile, 0o000);
    const hour = cycle(s);
    if (mode === "unreadable") chmodSync(s.stateFile, 0o600);
    assert.equal(hour.status, 0, hour.stderr);
    assert.equal(hour.json().entries[0].steps[0].state, "absent");
    assert.equal(readFileSync(s.stateFile, "utf8"), original);
    assert.ok(hour.json().notes.some((note) => note.includes(s.stateFile)));
  });
});

test("missing am: the hourly cycle leaves it absent; signed install, current and its own next update", (t) => {
  const s = fleet(t);
  const hour = cycle(s);
  assert.equal(hour.status, 0, hour.stderr);
  assert.equal(hour.json().entries[0].steps[0].state, "absent");
  assert.equal(s.calls().some(bootstrap), false);
  const history = jsonFile(s.stateFile);
  history.here = { machine: null, result: "current" };
  history.machines.sibling = { machine: "sibling", result: "off", auto: false };
  put(s.stateFile, JSON.stringify(history));
  const found = result(s.install(), "installed");
  assert.deepEqual([found.core, found.user, found.version], ["core-vm", { uid: process.getuid(), home: s.home }, V]);
  assert.equal(installed(s).current.sha256, s.posted.pointer.tarball.sha256);
  const saved = jsonFile(s.stateFile);
  assert.deepEqual(saved.here, history.here);
  assert.deepEqual(saved.machines.sibling, history.machines.sibling);
  assert.deepEqual(saved.machines.vm, { ...history.machines.vm, install: found });
  result(s.install(), "current");
  const next = s.listen(NEXT);
  assert.equal(s.far.AM_TRUSTED_KEYS, undefined);
  const update = s.farAm("update", "automagik.am", "--json");
  assert.equal(update.status, 0, update.stdout);
  assert.equal(installed(s, NEXT).current.sha256, next.pointer.tarball.sha256);
  assert.equal(cycle(s).status, 0);
  assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "current");
  s.change((f) => { f.machines[0].state = "disconnected"; });
  assert.equal(cycle(s).status, 0);
  assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "current");
});

test("native (#206): this computer's own system installs the signed am, a sparse service PATH runs it, and it updates itself",
  { skip: !NATIVE && "AM_LINKED_NATIVE=1 (CI's native job on Linux and macOS arm64)" }, (t) => {
  const system = execFileSync("uname", ["-sm"], { encoding: "utf8" }).trim();
  t.diagnostic(`native target: ${system}`);
  const s = fleet(t, { native: true });
  assert.equal(s.far.PATH.split(":").slice(1).join(":"), SPARSE_PATH);
  // A runner image's node lives outside the service PATH; a host whose /usr/bin has one says so.
  const onPath = spawnSync("/bin/sh", ["-c", "command -v node"], { env: s.far, encoding: "utf8" }).stdout.trim();
  t.diagnostic(onPath ? `the service PATH has a node of its own: ${onPath}` : "no node on the service PATH: run.sh's runtime folders");
  // From this computer: the linked machine reads the signed pointer itself, then checks and installs.
  const found = result(s.install(), "installed");
  assert.deepEqual([found.core, found.version], ["core-vm", V]);
  assert.equal(installed(s).current.sha256, s.posted.pointer.tarball.sha256);
  assert.equal(s.calls().some(bootstrap), true);
  result(s.install(), "current");
  // Through the user-facing link, on the sparse PATH: run.sh finds node the way it finds Homebrew's.
  const shown = s.farAm("--version");
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout.trim(), `am ${V}`);
  const doctor = s.farAm("self", "doctor", "--json");
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  // Its own next update, with its own (installed) keys.
  const next = s.listen(NEXT);
  const update = s.farAm("update", "automagik.am", "--json");
  assert.equal(update.status, 0, `${update.stdout}\n${update.stderr}`);
  assert.equal(installed(s, NEXT).current.sha256, next.pointer.tarball.sha256);
  assert.equal(cycle(s).status, 0);
  assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "current");
});

test("retained and incomplete am are repaired even at the pointer's version", async (t) => {
  for (const mode of ["retained", "incomplete"]) await t.test(mode, (t) => {
    const s = fleet(t);
    s.setup(s.posted.dir);
    if (mode === "retained") assert.equal(s.farAm("self", "uninstall").status, 0);
    else rmSync(join(s.local, "am"));
    result(s.install("--check"), mode);
    assert.equal(existsSync(join(s.local, "am")), false);
    result(s.install(), "installed");
    assert.equal(installed(s).seen, s.posted.pointer.sequence);
  });
});

test("both pack links, relative .mjs targets and an older pack's alias alone are taken over", async (t) => {
  for (const mode of ["both", "old alias"]) await t.test(mode, (t) => {
    const s = fleet(t);
    const a = join(s.farApp, "mods/am-sidebar/bin/automagik-herdr.mjs");
    const b = join(s.farApp, "mods/spaces-agents/bin/automagik-herdr.mjs");
    put(a, "throw new Error('must not run the pack');\n");
    put(b, "throw new Error('must not run the pack');\n");
    mkdirSync(s.local, { recursive: true });
    if (mode === "both") symlinkSync(relative(s.local, a), join(s.local, "am"));
    symlinkSync(relative(s.local, b), join(s.local, "automagik-herdr"));
    result(s.install("--check"), "pack");
    result(s.install(), "installed");
    installed(s);
  });
});

test("a healthy older am is reported with its opt-out and left alone", (t) => {
  const s = fleet(t);
  const old = s.lane.pack(OLD);
  s.setup(old.dir);
  put(join(s.home, ".automagik/linked-update"), "off\n");
  const before = s.record();
  const out = result(s.install(), "installed");
  assert.equal(out.version, OLD);
  assert.equal(out.auto, false);
  assert.deepEqual(s.record(), before);
  assert.match(s.command(["machines"]).stdout, /installed 3\.162\.3; linked updates are off there/);
});

test("pointer and archive refusals leave no am", async (t) => {
  const cases = [
    ["bad signature", /signature does not match/, (s) => s.lane.post(V, s.posted.archive, { sig: "garbage" })],
    ["unknown signing key", /unknown key.*update the pack or am/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.keyId = "other"; } })],
    ["archive rejects controller key", /key this am does not trust/, (s) => {
      s.change((f) => { f.machines[0].env.AM_TRUSTED_KEYS = s.lane.keys; });
      s.listen(V, { edit: (d) => put(join(d, "am-keys.json"), '{"keys":[]}') });
    }],
    ["missing pointer", /pointer is missing/, (s) => rmSync(join(s.lane.lane, "am.json"))],
    ["invalid sequence", /invalid sequence/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.sequence++; } })],
    ["invalid commit", /invalid commit/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.commit = "HEAD"; } })],
    ["non-HTTPS URL", /invalid am tarball/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.tarball.url = p.tarball.url.replace("https", "http"); } })],
    ["sha256", /sha256 does not match/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.tarball.sha256 = "0".repeat(64); } })],
    ["size", /size does not match/, (s) => s.lane.post(V, s.posted.archive, { edit: (p) => { p.tarball.size++; } })],
    ["symlink entry", /unsafe tarball/, (s) => s.listen(V, { edit: (d) => symlinkSync("VERSION", join(d, "a-link")) })],
    ["parent entry", /unsafe tarball|error is not recoverable|Removing leading/i, (s) => s.listen(V, { archiveArgs: process.platform === "darwin" ? ["-s", "|^VERSION$|../VERSION|"] : ["--transform=s,^VERSION$,../VERSION,"] })],
    ["verified old am", /minimum required.*self install --signed/, (s) => s.listen(V, { edit: (d) => put(join(d, "bin/am.mjs"), 'process.exit(2);\n') })],
  ];
  for (const [name, why, change] of cases) await t.test(name, (t) => {
    const s = fleet(t);
    change(s);
    result(s.install(), "refused", why);
    assert.equal(existsSync(s.store), false);
    assert.equal(existsSync(s.local), false);
  });
});

test("genuine pointer with replaced tarball bytes never runs the candidate", (t) => {
  const s = fleet(t);
  const marker = join(s.root, "ran-candidate");
  s.lane.pack(V, { edit: (d) => put(join(d, "bin/am.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`) });
  result(s.install(), "refused", /sha256 does not match/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(s.store), false);
});

test("a lower sequence, damaged record or floor, dangling store link and foreign link are refused", async (t) => {
  for (const mode of ["floor", "damage", "valid JSON damaged floor", "dangling", "foreign", "store disagrees"]) await t.test(mode, (t) => {
    const s = fleet(t);
    if (mode === "foreign") {
      mkdirSync(s.local, { recursive: true });
      symlinkSync("/missing/other-am", join(s.local, "am"));
    } else {
      const next = s.lane.pack(NEXT);
      s.setup(next.dir);
      assert.equal(s.farAm("self", "uninstall").status, 0);
      const path = join(s.store, "record.json");
      if (mode === "damage") put(path, "{");
      if (mode === "valid JSON damaged floor") put(path, JSON.stringify({ ...s.record(), seen: 0 }));
      if (mode === "dangling" || mode === "store disagrees") {
        unlinkSync(join(s.store, "current"));
        if (mode === "store disagrees") mkdirSync(join(s.store, "other"));
        symlinkSync("other", join(s.store, "current"));
      }
    }
    if (mode === "floor") result(s.install(), "refused", /older than the newest/);
    else result(s.install(), "broken", /record damaged|foreign|dangling|disagrees/);
    if (mode !== "floor") assert.equal(s.calls().some(bootstrap), false);
  });
});

test("runtime and platform checks use only that machine's paths", async (t) => {
  for (const mode of ["no Node", "Bun only", "Intel Mac", "missing tool", "old PATH and nvm", "Homebrew"]) await t.test(mode, (t) => {
    const s = fleet(t, { node: ["Intel Mac", "missing tool"].includes(mode), target: mode === "Intel Mac" ? "Darwin x86_64" : "Linux x86_64" });
    if (mode === "Bun only") exe(join(s.bin, "bun"), "echo 1.3.0");
    if (mode === "missing tool") rmSync(join(s.bin, sha[0]));
    if (mode === "old PATH and nvm") {
      exe(join(s.bin, "node"), "echo v22.6.0");
      const nvm = join(s.home, ".nvm/versions/node/v22.22.0/bin");
      mkdirSync(nvm, { recursive: true });
      symlinkSync(process.execPath, join(nvm, "node"));
    }
    if (mode === "Homebrew") symlinkSync(process.execPath, join(s.runtime, "node"));
    const why = { "no Node": /Node 22\.7/, "Bun only": /only Bun/, "Intel Mac": /Darwin x86_64.*not a supported/, "missing tool": /missing sha256sum/ }[mode];
    result(s.install(), why ? "refused" : "installed", why);
    assert.equal(s.calls().some(bootstrap), !why);
  });
});

test("selection rejects missing or duplicate selectors, temporary and ambiguous names, and unavailable lists", async (t) => {
  for (const args of [[], ["--local"], ["--linked"], ["--auto", "off"], ["--machine", "vm", "--machine=vm"],
    ["--machine", "vm", "--app-home"], ["--machine", "vm", "--project", "/foo"], ["--machine", "vm", "--project", "/foo", "--app-home", "--check"]]) {
    const s = fleet(t, { release: false });
    const r = s.command(["machines", "install", "--json", ...args]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.json().state, "refused");
    assert.deepEqual(s.calls(), []);
  }
  for (const [role, expected, why, change] of [
    ["unknown", "refused", /no such/, (f) => { f.machines = []; }],
    ["temporary", "refused", /temporary/, (f) => { f.machines[0].temporary = true; }],
    ["ambiguous", "refused", /ambiguous/, (f) => { f.machines.push({ ...f.machines[0], temporary: true }); }],
    ["disconnected", "failed", /disconnected/, (f) => { f.machines[0].state = "disconnected"; }],
    ["unreadable", "failed", /could not read hc machine ls/, (f) => { f.machineListUnreadable = true; }],
    ["invalid", "failed", /valid core id/, (f) => { f.machines[0].id = "wrong id"; }],
  ]) await t.test(role, (t) => {
    const s = fleet(t, { release: false });
    s.change(change);
    result(s.install(), expected, why);
    assert.equal(s.calls().filter((a) => a[0] === "exec").length, 0);
  });
});

test("a relink is refused before bootstrap and at read-back", async (t) => {
  for (const nth of [2, 3]) await t.test(`list ${nth}`, (t) => {
    const s = fleet(t);
    s.change((f) => { f.relinkOnList = { nth, name: "vm", id: "replacement" }; });
    const out = result(s.install(), "refused", /core changed from core-vm to replacement/);
    assert.equal(out.core, "core-vm");
    assert.equal(existsSync(s.store), nth === 3);
  });
});

test("bootstrap answer lost: unknown is persisted; check only reads the machine", (t) => {
  const s = fleet(t);
  s.change((f) => { f.loseExecAnswerContaining = 'self install --signed "$tmp"'; });
  result(s.install(), "unknown", /stopped answering/);
  assert.equal(jsonFile(s.stateFile).machines.vm.install.state, "unknown");
  assert.match(s.command(["machines"]).stdout, /unknown \(vm stopped answering\)/);
  result(s.install("--check"), "installed");
  assert.equal(s.calls().filter(bootstrap).length, 1);
  installed(s);
});

test("the install result survives an unreadable or unwritable controller state", async (t) => {
  for (const mode of ["bad JSON", "became unwritable", "lock held"]) await t.test(mode, (t) => {
    const s = fleet(t);
    const stateDir = dirname(s.stateFile);
    let before;
    if (mode === "bad JSON") before = "{";
    else if (mode === "lock held") put(join(stateDir, "linked-updates.lock"), `${process.pid} held`);
    else {
      before = '{"here":null,"machines":{}}\n';
      const curl = join(s.bin, "curl");
      rmSync(curl);
      exe(curl, `case "\${8-}" in *.tgz) chmod 555 "${stateDir}" ;; esac\nexec "${process.execPath}" "${curl}.mjs" "$@"`);
    }
    if (before !== undefined) put(s.stateFile, before);
    let r;
    try { r = s.install(); } finally { chmodSync(stateDir, 0o755); }
    if (mode === "lock held") {
      result(r, "busy-here", /held by another am/);
      assert.equal(s.calls().some(bootstrap), false);
    } else {
      result(r, "installed");
      assert.match(r.stderr, /Could not keep the install observation/);
      assert.equal(readFileSync(s.stateFile, "utf8"), before);
    }
  });
});


test("two controllers: a far-side busy reply is distinct, then a retry is current", async (t) => {
  const s = fleet(t);
  const queued = join(s.root, "verifying"), go = join(s.root, "go");
  s.listen(V, { edit: (d) => exe(join(d, "bin/am"), `: > "${queued}"\nwhile [ ! -f "${go}" ]; do sleep 0.02; done\necho 'am ${V}'`) });
  // Pause the first install under the far lock, before it changes the store links.
  const firstBin = join(s.bin, "tar");
  rmSync(firstBin);
  exe(firstBin, `case "$*" in *'.signed-'*' -C '*) : > "${queued}"; while [ ! -f "${go}" ]; do sleep 0.02; done ;; esac\nexec "${tools.tar}" "$@"`);
  const first = run(process.execPath, [s.cli, ...s.args], { cwd: s.root, env: s.env });
  first.catch(() => {});
  try {
    for (let tries = 0; tries < 250 && !existsSync(queued); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(queued), "first signed install reached its locked extraction");
    const secondApp = join(s.root, "other-app");
    mkdirSync(secondApp);
    result(s.command(s.args, { HERDR_APP_HOME: secondApp }), "busy", /another am/);
  } finally { put(go, "go\n"); }
  assert.equal(JSON.parse((await first).stdout).state, "installed");
  result(s.install(), "current");
});

test("a foreign link that appeared after probe is preserved and refused under the far lock", (t) => {
  const s = fleet(t);
  const path = join(s.local, "am");
  const curl = join(s.bin, "curl");
  rmSync(curl);
  exe(curl, `case "\${8-}" in *.tgz) mkdir -p "${s.local}"; printf foreign > "${path}" ;; esac\nexec "${process.execPath}" "${curl}.mjs" "$@"`);
  result(s.install(), "broken", /\/am: file/);
  assert.equal(readFileSync(path, "utf8"), "foreign");
  assert.equal(existsSync(s.store), false);
});

test("failure after the first link and a failing installed launcher both roll back", async (t) => {
  await t.test("first link changed", (t) => {
    const s = fleet(t);
    const path = join(s.local, "automagik-herdr"), tar = join(s.bin, "tar");
    rmSync(tar);
    exe(tar, `case "$*" in *'.signed-'*' -C '*) mkdir -p "${s.local}"; printf foreign > "${path}" ;; esac\nexec "${tools.tar}" "$@"`);
    result(s.install(), "broken", /did not link.*restored/);
    assert.equal(existsSync(join(s.local, "am")), false);
    assert.equal(readFileSync(path, "utf8"), "foreign");
    assert.equal(existsSync(s.store), false);
  });
  await t.test("installed launcher fails with two retained trees", (t) => {
    const s = fleet(t);
    s.setup(s.lane.pack(OLD).dir);
    s.setup(s.posted.dir);
    assert.equal(s.farAm("self", "uninstall").status, 0);
    const recordPath = join(s.store, "record.json");
    const before = readFileSync(recordPath, "utf8");
    const trees = readdirSync(s.store).sort();
    s.listen(NEXT, { edit: (d) => exe(join(d, "bin/am"), "exit 99") });
    result(s.install(), "broken", /Command failed.*--version/);
    assert.equal(readFileSync(recordPath, "utf8"), before);
    assert.deepEqual(readdirSync(s.store).sort(), trees);
    assert.equal(readlinkSync(join(s.store, "current")), V);
    assert.equal(readlinkSync(join(s.store, "previous")), OLD);
    assert.equal(existsSync(s.local) && readdirSync(s.local).length, 0);
  });
});

test("app-home is project scoped, read-back of an existing home is there, unsafe paths are refused", async (t) => {
  for (const mode of ["two projects", "refused pane env", "link component", "other owner", "unwritable", "relink"]) await t.test(mode, (t) => {
    const s = fleet(t, { release: false });
    const project = join(s.home, "project");
    const installHome = (dir) => s.install("--project", dir, "--app-home");
    const pane = (dir, text) => put(join(dir, ".herdr/pane-env"), text);
    pane(project, "");
    if (mode === "refused pane env") pane(project, "PATH=/refused\n");
    if (mode === "link component") {
      const link = join(s.home, "elsewhere");
      symlinkSync(dirname(s.farApp), link);
      pane(project, `HERDR_APP_HOME=${link}/app\n`);
    }
    if (mode === "other owner" || mode === "unwritable") {
      mkdirSync(s.farApp);
      if (mode === "other owner") {
        rmSync(join(s.bin, "stat"));
        exe(join(s.bin, "stat"), `echo ${process.getuid() + 1}`);
      } else chmodSync(s.farApp, 0o555);
    }
    if (mode === "relink") s.change((f) => { f.relinkOnList = { nth: 2, name: "vm", id: "new" }; });
    const why = { "refused pane env": /pane-env.*left out/, "link component": /is a link/, "other owner": /belongs to uid/,
      unwritable: /not writable and searchable/, relink: /core changed/ }[mode];
    if (why) result(installHome(project), "refused", why);
    else {
      assert.equal(result(installHome(project), "made").why, s.farApp);
      result(installHome(project), "there");
      const dir = join(s.home, "project2"), app2 = join(s.home, "app2");
      pane(dir, `HERDR_APP_HOME=${app2}\n`);
      assert.equal(result(installHome(dir), "made").why, app2);
      for (const home of [s.farApp, app2]) {
        assert.equal(statSync(home).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(home), []);
      }
    }
    assert.equal(s.calls().some(bootstrap), false);
  });
});
