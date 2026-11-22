import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { servicePaths } from "../pocket/link/bridge/service-paths.js";

const AM = fileURLToPath(new URL("..", import.meta.url));
const fsImports = 'import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";';
const pathImports = 'import { basename, dirname, join } from "node:path";';

function managerAndNpm() {
  const [command, ...args] = process.argv.slice(2);
  const log = path => appendFileSync(process.env.TEST_LOG, JSON.stringify([command, ...path]) + "\n");
  log(args);
  const request = join(process.env.TEST_ROOT, "job-request.json");
  const signed = join(process.env.TEST_ROOT, "job.json");
  const get = path => { try { return JSON.parse(readFileSync(path)); } catch { return {}; } };
  const put = (path, value) => {
    const temp = path + "." + process.pid;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
  };
  if (command === "npm") {
    if (args[0] === "--version") return console.log("10.0.0");
    if (process.env.FAIL_NPM) process.exit(23);
    if (process.env.SLOW_NPM) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    if (args.join(" ") !== "ci --omit=dev --no-audit --no-fund") process.exit(91);
    for (const [name, source] of [
      ["@number0/iroh", `export const SecretKey = { generate: () => ({ toBytes: () => Buffer.alloc(32) }) };
        export const EndpointTicket = { fromAddr: () => ({ toString: () => 'endpointabcdefghijklmnopqrstuvwxyz234567' }) };
        export const Endpoint = { bind: async () => {
          const alive = setInterval(() => {}, 1_000);
          return {
            id: () => ({ toString: () => 'fixture-endpoint', fmtShort: () => 'fixture' }), addr() {},
            watchAddr: () => ({ stop: async () => {} }), online: async () => {}, close: async () => clearInterval(alive),
            acceptNext: () => new Promise(() => {}),
          };
        } };`],
      ["qrcode", `import { writeFileSync } from "node:fs";
        export default { create(link, options) {
          if (options.errorCorrectionLevel !== "M") throw new Error("Wrong QR options");
          if (process.env.TEST_QR) writeFileSync(process.env.TEST_QR, link);
          return { modules: { size: 3, get: (y, x) => (x + y) % 2 } };
        } };`],
    ]) {
      const dir = join("node_modules", name);
      mkdirSync(dir, { recursive: true });
      put(join(dir, "package.json"), { name, type: "module", main: "index.js" });
      writeFileSync(join(dir, "index.js"), source);
    }
    return;
  }
  const manager = command === "launchctl" || command === "systemctl";
  if (!manager) process.exit(92);
  if (process.env.FAIL_MANAGER) {
    console.error("manager unavailable");
    process.exit(22);
  }
  const verb = command === "launchctl" ? args[0] : args[1];
  const current = get(signed);
  if (verb === "show" || verb === "print") {
    const installed = current.loaded || existsSync(process.env.TEST_SERVICE);
    const fragment = current.fragment ?? process.env.TEST_SERVICE;
    const active = current.active ?? (current.pid ? "active" : "inactive");
    const enabled = current.enabled ?? (current.loaded ? "enabled" : "disabled");
    const config = existsSync(process.env.TEST_SERVICE) ? servicePaths(readFileSync(process.env.TEST_SERVICE, "utf8")) : {};
    const exec = current.exec ?? process.env.TEST_EXEC_START ?? `{ path=${config.node} ; argv[]=${config.node} ${config.entry} serve ; }`;
    if (verb === "show") console.log(`LoadState=${installed ? "loaded" : "not-found"}\nMainPID=${current.pid ?? 0}\nFragmentPath=${installed ? fragment : ""}\nActiveState=${active}\nUnitFileState=${enabled}\nExecStart=${exec}\nDropInPaths=${current.dropIns ?? ""}\nNeedDaemonReload=no`);
    else if (!args[1].includes("/dev.herdr.pocket-link")) console.log("fixture GUI domain");
    else if (current.loaded) console.log(`state = ${current.pid ? "running" : "spawn scheduled"}\n${current.pid ? `pid = ${current.pid}\n` : ""}path = ${fragment}\nprogram = ${config.node}\narguments = {\n  ${config.node}\n  ${config.entry}\n  ${current.verb ?? "serve"}\n}\nenvironment = {\n  POCKET_LINK_STATE_DIR => ${config.state}\n}`);
    else process.exit(113);
    return;
  }
  if (verb === "daemon-reload") {
    if (process.env.TEST_DROP_IN && existsSync(process.env.TEST_SERVICE)) {
      put(signed, { ...current, dropIns: process.env.TEST_DROP_IN });
    }
    return;
  }
  if (verb === "enable" || verb === "bootstrap") {
    if (process.env.FAIL_ENABLE && existsSync(process.env.FAIL_ENABLE)) {
      rmSync(process.env.FAIL_ENABLE);
      if (process.env.TEST_PARTIAL_ENABLE) put(signed, { loaded: true, enabled: "enabled", active: "failed" });
      console.error("refused to load replacement");
      process.exit(23);
    }
    put(signed, { loaded: true });
    const node = servicePaths(readFileSync(process.env.TEST_SERVICE, "utf8")).node;
    if ((verb === "bootstrap" && existsSync(node)) || args.includes("--now")) {
      put(request, { running: true, sequence: process.pid });
    }
    return;
  }
  if (verb === "disable" || verb === "bootout") {
    if (process.env.FAIL_STOP) {
      console.error("refused to unload");
      process.exit(24);
    }
    put(signed, { loaded: false });
    put(request, { running: false, sequence: process.pid });
    return;
  }
  process.exit(93);
}

async function fakeBridge() {
  const [command, arg] = process.argv.slice(2);
  const state = process.env.POCKET_LINK_STATE_DIR;
  const get = (name, fallback) => { try { return JSON.parse(readFileSync(join(state, name))); } catch { return fallback; } };
  const set = (name, value) => writeFileSync(join(state, name), JSON.stringify(value));
  const out = value => console.log(JSON.stringify(value));
  const log = args => appendFileSync(process.env.TEST_LOG, JSON.stringify(["bridge", ...args]) + "\n");
  if (command === "serve") {
    assertNoPurge(state);
    const end = () => { rmSync(join(state, "status.json"), { force: true }); process.exit(0); };
    process.on("SIGTERM", end);
    process.on("SIGINT", end);
    set("status.json", { pid: process.pid, ticket: "endpointabcdefghijklmnopqrstuvwxyz234567" });
    setInterval(() => {}, 1_000);
    return;
  }
  log([command, arg]);
  if (command === "start") process.exit(89);
  if (command === "status") {
    const status = get("status.json", {});
    const pairing = get("pairing.json", null);
    return out({ running: Boolean(status.pid), ticket: status.ticket, devices: get("devices.json", []),
      pairing: pairing && { expires: pairing.expires }, state });
  }
  if (command === "pair") {
    const code = process.env.TEST_CODE ?? crypto.randomUUID().replaceAll("-", "");
    const expires = Date.now() + Number(process.env.TEST_LIFE ?? 15_000);
    const pending = { code, expires };
    set("pairing.json", pending);
    if (process.env.TEST_REPAIR) {
      const { verdict } = acceptPairing(state, store(join(state, "devices.json")), { pending, peer: "0000", code });
      if (verdict !== "ok") throw new Error("Fixture pairing failed");
    }
    return out({ code, link: `herdr-pocket://pair?v=1&n=Fixture&c=${code}&t=endpointabcdefghijklmnopqrstuvwxyz234567`, rows: ["101", "010", "101"], expires });
  }
  if (command === "cancel") {
    const saved = get("pairing.json", {});
    if (process.env.TEST_REFUSE_CANCEL) return out({ ok: false, error: "cancellation failed" });
    const cancelled = Boolean(saved.code && challengeId(saved.code) === arg);
    if (cancelled) rmSync(join(state, "pairing.json"));
    return out({ ok: true, cancelled });
  }
  if (command === "forget") return out({ ok: true, removed: true });
  if (command === "reset") return out({ ok: true });
  process.exit(86);
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const getJson = path => JSON.parse(readFileSync(path, "utf8"));
export const putJson = (path, value) => writeFileSync(path, JSON.stringify(value));
export const pocketId = "pocket.link";

export function fakes(t, { stub = true, control = true, platform = process.platform, amDir = "am" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pl-test-")));
  const home = join(root, "home &%"), amHome = join(root, amDir), app = join(home, ".config/herdr-app");
  const extract = join(root, "extract"), bin = join(root, "bin"), logFile = join(root, "commands.jsonl");
  const stateBase = join(root, "state"), state = join(stateBase, "automagik-pocket-link");
  const store = join(amHome, "parts", pocketId), entry = join(store, "current/link/bridge/bridge.mjs");
  const service = platform === "darwin"
    ? join(home, "Library/LaunchAgents/dev.herdr.pocket-link.plist")
    : join(home, ".config/systemd/user/herdr-pocket-link.service");
  const manager = platform === "darwin" ? "launchctl" : "systemctl";
  const request = join(root, "job-request.json"), job = join(root, "job.json"), signed = join(root, "releases");
  for (const dir of [home, app, bin, dirname(service), stateBase, signed]) mkdirSync(dir, { recursive: true });
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: stateBase, AM_HOME: amHome,
    HERDR_APP_HOME: app, HERDR_APP_BIN: "/bin/false", AM_RELEASE_URL: `file://${signed}`, AUTOMAGIK_HERDR_NO_UPDATE: "1",
    AM_POCKET_NPM: join(bin, "npm"), TEST_ROOT: root, TEST_SERVICE: service, TEST_LOG: logFile,
  };
  if (platform !== process.platform) {
    const hook = join(root, "platform.mjs");
    writeFileSync(hook, `import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      os.platform = () => process.platform;
      syncBuiltinESMExports();
    `);
    env.NODE_OPTIONS = "--import=" + hook;
  }
  const script = join(bin, "fake.mjs");
  writeFileSync(script, `${fsImports}\n${pathImports}\nimport { servicePaths } from ${JSON.stringify(new URL("../pocket/link/bridge/service-paths.js", import.meta.url).href)};\n(${managerAndNpm.toString()})();\n`);
  for (const name of ["launchctl", "systemctl", "npm", "hc", "herdr-core", "herdr-app"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${name} "$@"\n`, { mode: 0o700 });
  }
  cpSync(AM, extract, { recursive: true, filter: p => p !== join(AM, "test") });
  const pocket = join(extract, "pocket");
  if (stub) {
    // Service verbs still use the real source. Only the serving process and pairing/status
    // replies are substituted. The manager fakes only record requests.
    const original = join(pocket, "link/bridge/bridge.mjs");
    const alternate = join(dirname(original), "real-bridge.mjs");
    cpSync(original, alternate);
    writeFileSync(original, `${fsImports}\n${pathImports}\n
      if (["install", "uninstall", "stop", "restore-inactive", "definition-digest"].includes(process.argv[2])
          || (process.env.TEST_START_GUARD && process.argv[2] === "start")
          || (process.env.TEST_REAL_MUTATION && ["forget", "reset", "copied", "cancel"].includes(process.argv[2]))) {
        await import("./real-bridge.mjs");
      } else {
        const { acceptPairing, challengeId } = await import("./pairing.mjs");
        const { store } = await import("./devices.mjs");
        const { assertNoPurge } = await import("./service.mjs");
        await (${fakeBridge.toString()})();
      }\n`);
  }
  let worker, wanted = true, sequence;
  const pump = (async () => {
    if (!control) return;
    while (wanted) {
      try {
        const event = existsSync(request) && getJson(request);
        if (event && event.sequence !== sequence) {
          sequence = event.sequence;
          if (worker?.pid && pidAlive(worker.pid)) {
            worker.kill("SIGTERM");
            await once(worker, "exit");
          }
          if (event.running) {
            const { state: dir, entry: script } = servicePaths(readFileSync(service, "utf8"));
            worker = spawn(process.execPath, [script, "serve"], {
              env: { ...env, POCKET_LINK_STATE_DIR: dir }, stdio: "ignore",
            });
            putJson(job, { loaded: true, pid: worker.pid });
          }
        }
      } catch (e) {
        if (wanted) throw e;
      }
      await delay(20);
    }
  })();
  t.after(async () => {
    wanted = false;
    try { await pump; } finally {
      if (worker?.pid && pidAlive(worker.pid)) {
        worker.kill("SIGTERM");
        await once(worker, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  const child = (argv, extra = {}, cmd = process.execPath, cwd = extract) => spawn(cmd, argv, {
    cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = async running => {
    let stdout = "", stderr = "";
    running.stdout.on("data", data => { stdout += data; });
    running.stderr.on("data", data => { stderr += data; });
    const [code, signal] = await once(running, "close");
    return { code, signal, stdout, stderr, json: () => JSON.parse(stdout) };
  };
  const am = (argv, extra) => result(child([join(extract, "bin/am.mjs"), ...argv], extra));
  const bridge = (argv, extra, path = join(pocket, "link/bridge/bridge.mjs")) => result(child([path, ...argv], extra));
  const entryRun = (verb, extra) => result(child([join(pocket, "pocket.mjs"), "link", verb, "--json"], extra));
  return { root, home, app, bin, extract, pocket, env, store, entry, service, manager, stateBase, state, request, job,
    record: () => getJson(join(store, "record.json")),
    log: () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse) : [],
    am, bridge, child, result, entryRun, logFile };
}
