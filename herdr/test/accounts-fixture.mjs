import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachLine, attachPath, attachRow } from "../mods/am-sidebar/attach.js";
import { HERE_SINCE } from "../mods/am-sidebar/accountsFleet.js";
import { FLEET_FILE, accountFingerprint, noExceptions } from "../mods/am-sidebar/accountsRows.js";
import { readJsonLines } from "./log-lines.mjs";
import { scratchRoot } from "./scratch-project.mjs";

const pack = fileURLToPath(new URL("../mods/am-sidebar/", import.meta.url));
const am = fileURLToPath(new URL("../../am/", import.meta.url));
const fakeHc = fileURLToPath(new URL("./fake-hc.mjs", import.meta.url));
const fakeShell = fileURLToPath(new URL("./fake-login-shell", import.meta.url));
export const PACK = join(pack, "bin/automagik-herdr.mjs");
export const AM = join(am, "bin/am.mjs");
export const READER = join(pack, "bin/accounts.mjs");
export const AM_READER = join(am, "bin/accounts.mjs");
export const BOT = "b-aaaaaaaaaa";
export const AT = "2026-11-20T10:00:00.000Z";
export const fpr = (id) => accountFingerprint(JSON.stringify({ tokens: { account_id: id } }));
export const auth = (id = "account-a", extra = {}) => JSON.stringify({ ...extra,
  tokens: { account_id: id, refresh_token: "CANARY-REFRESH-0043" } });
export const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
export const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
export const fakeClaude = (email) => `#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 3
folder=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
case $folder in */.claude-2) email=bo@example.com ;; *) email=${email} ;; esac
printf '{"loggedIn":true,"email":"%s","authMethod":"claude.ai","configDirectory":"%s","unused":"CANARY-STATUS-0043"}\\n' "$email" "$folder"
`;

export function snapshot(root, skip = () => false) {
  const rows = [];
  const walk = (path) => {
    if (skip(path) || !existsSync(path)) return;
    const info = lstatSync(path);
    rows.push([path, info.mode, info.mtimeMs, info.isSymbolicLink() ? readlinkSync(path) : info.isFile() ? readFileSync(path) : null]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return rows;
}

export function scene(t) {
  const root = scratchRoot(t, "am-accounts-");
  const home = join(root, "home"), app = join(home, "app"), store = join(home, "am"),
    bin = join(root, "bin"), codex = join(home, "codex");
  for (const path of [home, app, store, bin, codex]) mkdirSync(path, { recursive: true });
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  json(statePath, { terminals: [], machines: [] });
  writeFileSync(logPath, "");
  const hc = join(bin, "hc");
  // The fake transports a program's stdout as bytes. File-backed replies keep our fixture
  // independent of how a runtime handles its own stdout pipe on exit.
  const capture = (program, before = "") => `#!/bin/sh
${before}
reply=$(mktemp -d "$TMPDIR/reply-child.XXXXXX") || exit 1
trap 'rm -rf "$reply"' EXIT
${program} "$@" >"$reply/out" 2>"$reply/err"; result=$?
cat "$reply/out"
cat "$reply/err" >&2
exit "$result"
`;
  const hcWrapper = (before = "") => exe(hc, capture(`"${process.execPath}" "${fakeHc}"`, before));
  hcWrapper();
  exe(join(bin, "claude"), fakeClaude("ana@example.com"));
  const nodeDir = dirname(process.execPath);
  const env = { HOME: home, HERDR_APP_HOME: app, AM_HOME: store, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: "",
    HC_SOCKET: "", HC_SESSION: "", HC_TERMINAL_ID: "", SHELL: fakeShell,
    AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock"),
    GIT_CEILING_DIRECTORIES: root, TMPDIR: root, PATH: `${bin}:${nodeDir}:/usr/bin:/bin`,
    HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath };
  const states = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (edit) => { const state = states(); edit(state); json(statePath, state); };
  const spawnEnv = (overrides) => {
    const all = { ...env, ...overrides };
    for (const name of ["HOME", "HERDR_APP_HOME", "AM_HOME", "CODEX_HOME"]) {
      assert.ok(all[name].startsWith(`${root}/`), name);
    }
    return all;
  };
  const output = () => {
    const dir = mkdtempSync(join(root, "reply-"));
    const out = join(dir, "out"), err = join(dir, "err");
    const stdout = openSync(out, "w", 0o600), stderr = openSync(err, "w", 0o600);
    return { stdio: ["ignore", stdout, stderr],
      read: (code) => {
        const stdout = readFileSync(out, "utf8"), stderr = readFileSync(err, "utf8");
        return { code, stdout, stderr, json: () => JSON.parse(stdout) };
      },
      close: () => { closeSync(stdout); closeSync(stderr); rmSync(dir, { recursive: true, force: true }); } };
  };
  const run = (program, args, overrides = {}, { timeout } = {}) => {
    const reply = output();
    try {
      const r = spawnSync(process.execPath, [program, ...args], { cwd: root, env: spawnEnv(overrides), stdio: reply.stdio, timeout });
      if (r.error) throw r.error;
      return reply.read(r.status);
    } finally { reply.close(); }
  };
  const start = (program, args, overrides = {}) => new Promise((resolve, reject) => {
    const reply = output();
    const child = spawn(process.execPath, [program, ...args], { cwd: root, env: spawnEnv(overrides), stdio: reply.stdio });
    const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      try { resolve(reply.read(code)); } catch (error) { reject(error); }
      finally { reply.close(); }
    });
  });
  const install = (kind, targetApp, targetStore, version = HERE_SINCE) => {
    const dir = kind === "pack" ? join(targetApp, "mods/am-sidebar") : join(targetStore, "parts/automagik.am/current");
    cpSync(kind === "pack" ? pack : am, dir, { recursive: true, filter: (p) => !p.startsWith(join(am, "test")) });
    writeFileSync(join(dir, "VERSION"), `${version}\n`);
    return dir;
  };
  const machine = (name, options = {}) => {
    const target = join(root, name), targetHome = join(target, "home"), targetApp = join(targetHome, "app"),
      targetStore = join(targetHome, "am"), targetBin = join(targetHome, "bin"), targetCodex = join(targetHome, "codex");
    for (const path of [targetApp, targetStore, targetBin, targetCodex]) mkdirSync(path, { recursive: true });
    const m = { name, id: `core-${name}`, state: options.state ?? "connected", home: targetHome, path: `${targetBin}:${nodeDir}`,
      env: { HERDR_APP_HOME: targetApp, AM_HOME: targetStore, CODEX_HOME: targetCodex, CLAUDE_CONFIG_DIR: "" } };
    exe(join(targetBin, "claude"), fakeClaude(options.email ?? "ana@example.com"));
    exe(join(targetBin, "node"), capture(`"${process.execPath}"`));
    writeFileSync(join(targetCodex, "auth.json"), auth(options.account));
    setState((state) => state.machines.push(m));
    const ship = (kind, version) => install(kind, targetApp, targetStore, version);
    return { ...m, target, app: targetApp, store: targetStore, bin: targetBin, codex: targetCodex, ship };
  };
  const staleLink = () => {
    const dir = install("pack", app, store);
    const path = join(home, ".local/bin/am");
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(dir, "bin/automagik-herdr.mjs"), path);
    return path;
  };
  const botProject = (machine, { terminal = "t8", bot = BOT, created_ms = 8, label = bot, argv = ["claude"] } = {}) => {
    const project = join(machine.home, "project");
    json(join(project, ".herdr/bots.json"), { version: 1, categories: [], bots: [{ id: bot, name: "Bot A",
      kind: "main", look: { character: "star", colour: "blue" }, role: "test", instructions: "", agent: "claude" }] });
    const pane = { address: `${machine.name}/${terminal}`, state: "live", created_ms, cwd: project, labels: { bot: label }, argv };
    setState((state) => state.terminals.push(pane));
    return { project, pane, attach: { event: "attach", bot, project, terminal, core: machine.id,
      created_ms, machine: machine.name, by: "attach" } };
  };
  const ledger = (...rows) => {
    const path = attachPath(app);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((row) => attachLine(attachRow(row))).join(""), { mode: 0o600 });
  };
  return { root, home, app, store, bin, codex, env, run, start, machine, states, setState, statePath, hcWrapper,
    log: () => readJsonLines(logPath), staleLink, botProject, ledger, file: join(app, FLEET_FILE) };
}

export function fixtureHere({ account = fpr("account-a"), email = "ana@example.com" } = {}) {
  return { v: 1, kind: "accounts.here", versions: { pack: HERE_SINCE, am: null }, panel: "off",
    codex: { home: "/example-home/codex", from: "env", file: "present", account, accountId: "present", lastRefresh: AT, generation: "a".repeat(64) },
    claude: { record: "absent", snapshot: null, selected: "default", effective: "default", slotsComplete: true,
      slots: [{ id: "default", dir: null, email, state: "eligible" }], state: "eligible", email,
      routes: { bare: { email, state: "eligible" }, record: { email, state: "eligible" } }, routesDiffer: false },
    exceptions: noExceptions() };
}
