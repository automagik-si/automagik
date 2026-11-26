// Pocket's local part. The installed slot contains this entry and the bridge together.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const POCKET = "pocket.link";
const OWN = dirname(fileURLToPath(import.meta.url));
const BRIDGE = "link/bridge/bridge.mjs";
const SERVICE = "link/bridge/service.mjs";
const LOCKFILE = "link/bridge/package-lock.json";
const MODULES = "link/bridge/node_modules";
const SLOT_MARKER = ".pocket-slot.json";
const KNOWN_STATE = ["secret.key", "devices.json", "pairing.json", "status.json", "public-status.json",
  "bridge.log", "bridge.log.1", "bridge.sock", "devices.lock", "pairing-completed.json", "pairing-grant.json"];
const FOREIGN = "Pocket Link runs from Herdr's dialog. Turn it off there (your phones stay paired), update or remove the mod (Pocket Link README), then run am pocket pair again.";
const LINK_FIX = "am pocket link on";
const markers = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "CLAUDECODE", "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED", "AUTOMAGIK_DSH_ENTRY"];
const hex = value => createHash("sha256").update(value).digest("hex");
const amHome = env => resolve(env.AM_HOME || join(env.HOME || homedir(), ".automagik"));
const storeOf = env => join(amHome(env), "parts", POCKET);
const recordPath = store => join(store, "record.json");
const pendingPath = store => join(store, "pending.json");
const entryOf = store => join(store, "current", BRIDGE);

class Usage extends Error {}
function read(path, encoding = "utf8") {
  try { return readFileSync(path, encoding); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function info(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function recordAt(path) {
  const text = read(path);
  return text === null ? null : JSON.parse(text);
}
function names(dir) {
  try { return readdirSync(dir).sort(); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function syncFolder(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    syncFolder(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}
function remove(path) {
  try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") throw e; }
  syncFolder(dirname(path));
}

const version = text => /^v?(\d+)\.(\d+)\.(\d+)/.exec(text?.trim() ?? "")?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const onPath = (env, command) => (env.PATH ?? "").split(":").filter(Boolean).map(dir => resolve(dir, command));
const cellar = path => {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(path);
  const opt = m && `${m[1]}/opt/${m[2]}/bin/node`;
  return opt && existsSync(opt) ? opt : path;
};
function probe(path, env) {
  if (!path || !isAbsolute(path)) return null;
  const r = spawnSync(path, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 });
  return r.status === 0 ? version(r.stdout) : null;
}
export function findNode(env, recorded, serviceNode, { bun = !!process.versions.bun, exec = process.execPath } = {}) {
  const choose = (paths, newest = false) => {
    const hits = [];
    for (const path of new Set(paths)) {
      const v = probe(path, env);
      if (v && compare(v, [20, 3, 0]) >= 0) {
        const stable = cellar(path);
        if (!newest) return stable;
        hits.push({ path: stable, v });
      }
    }
    return hits.sort((a, b) => compare(b.v, a.v))[0]?.path;
  };
  const runtime = !bun && choose([exec]);
  if (runtime) return runtime;
  const nvm = join(env.NVM_DIR || join(env.HOME || homedir(), ".nvm"), "versions/node");
  return choose([recorded, serviceNode, ...onPath(env, "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"])
    ?? choose(names(nvm).map(v => join(nvm, v, "bin/node")), true);
}
function nodeEnv(env, node) {
  return { ...env, PATH: `${dirname(node)}:${env.PATH ?? ""}` };
}
function findNpm(env, node) {
  const paths = env.AM_POCKET_NPM
    ? [resolve(env.AM_POCKET_NPM)] : [join(dirname(node), "npm"), ...onPath(env, "npm")];
  return paths.find(path => spawnSync(path, ["--version"], {
    env: nodeEnv(env, node), stdio: "ignore", timeout: 3_000,
  }).status === 0);
}

const inspectPs = (pid, ...fields) => execFileSync("ps",
  ["-ww", ...fields.flatMap(field => ["-o", field + "="]), "-p", String(pid)],
  { encoding: "utf8", timeout: 2_000 });
const readableProc = path => readFileSync(path, "utf8");
const procUid = path => lstatSync(path).uid;
const unreadable = e => ["EACCES", "EPERM", "ENOENT"].includes(e.code);
function otherProcessUser(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === "EPERM"; }
}

function linuxOwner(dir, readProc, procOwner) {
  try {
    const realUid = /^Uid:\s+(\d+)/m.exec(readProc(dir + "/status"))?.[1];
    if (realUid !== undefined) return Number(realUid);
  } catch (e) {
    if (!unreadable(e)) throw e;
  }
  return procOwner(dir);
}

const procStat = text => text.slice(text.lastIndexOf(")") + 2).split(" ");
function atLoginBoundary(list, env, uid, readProc) {
  const shell = list.findLastIndex(({ name, command }) => /^(?:ash|bash|dash|fish|ksh|sh|tcsh|csh|zsh)$/.test(name)
    && (basename(command[0]).startsWith("-") || command.includes("-l") || command.includes("--login")));
  if (shell < 0 || !list.slice(shell + 1).every(({ name }) => /^(?:login|sshd|sshd-session)$/.test(name))) return false;
  if (env.SSH_CONNECTION && env.SSH_TTY) return true;
  try {
    const session = Number(procStat(readProc("/proc/self/stat"))[3]);
    return session > 0 && list[shell].session === session && readProc("/proc/self/loginuid").trim() === String(uid);
  } catch { return false; }
}

function macArgv(executable, display) {
  const tail = display === executable || display.startsWith(executable + " ")
    ? display.slice(executable.length) : display;
  const words = Array.from(tail.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), ([, quoted, single, plain]) => ({
    arg: quoted ?? single ?? plain, plain: plain !== undefined,
  }));
  if (tail === display) words.shift();
  const args = [executable];
  // ps flattens argv. Rejoin unquoted absolute script paths, which may contain spaces.
  for (let i = 0; i < words.length; i++) {
    let { arg, plain } = words[i];
    if (plain && (arg.startsWith("/") || arg.startsWith("--require=/"))) {
      let script = arg;
      for (let j = i; j < words.length; j++) {
        if (/\.[cm]?js$/.test(script)) { arg = script; i = j; break; }
        const next = words[j + 1];
        if (!next?.plain || /^[-/]/.test(next.arg)) break;
        script += " " + next.arg;
      }
    }
    args.push(arg);
  }
  return args;
}

export function ancestors({ through, platform = process.platform, ppid = process.ppid,
  uid = process.getuid(), readProc = readableProc, procOwner = procUid, ps = inspectPs,
  otherUser = otherProcessUser, env = process.env } = {}) {
  const list = [];
  for (let pid = ppid; pid > 1;) {
    try {
      let next, command, name, session, dsh = false;
      if (platform === "linux") {
        const dir = `/proc/${pid}`;
        // A login ancestor such as root's sshd is outside this user's process tree.
        try { if (linuxOwner(dir, readProc, procOwner) !== uid) break; } catch (e) {
          if (unreadable(e) && otherUser(pid) && atLoginBoundary(list, env, uid, readProc)) break;
          throw e;
        }
        const stat = readProc(dir + "/stat");
        const end = stat.lastIndexOf(")");
        const fields = procStat(stat);
        next = Number(fields[1]);
        session = Number(fields[3]);
        name = stat.slice(stat.indexOf("(") + 1, end);
        command = readProc(dir + "/cmdline").split("\0");
        if (!command[0]) return null;
        // Non-dumpable processes (such as systemd --user) can hide their environment.
        try {
          dsh = readProc(dir + "/environ").split("\0").some(e => e.startsWith("AUTOMAGIK_DSH_ENTRY="));
        } catch (e) {
          if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
        }
      } else {
        const match = /^(\d+)[\t ]+(.+)$/.exec(ps(pid, "ppid", "comm").trim());
        next = Number(match?.[1]);
        name = match && basename(match[2]);
        const display = match && ps(pid, "command").trim();
        command = display && macArgv(match[2], display);
      }
      if (!command || !Number.isInteger(next) || next < 0 || next === pid) return null;
      list.push({ command, name, dsh, session });
      if (through && through({ command, name, dsh })) break;
      pid = next;
    } catch { return null; }
  }
  return list;
}

function dshLauncher(command) {
  const [exe, ...args] = command;
  if (!exe) return false;
  const runtime = basename(exe);
  const electron = /^(?:electron|automagik)(?:\.exe)?$/i.test(runtime);
  if (!electron && !/^node(?:js|\.exe)?$/i.test(runtime)) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg) || arg === "-") return false;
    if (arg === "--") return isDshScript(args[i + 1]);
    if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(arg)) {
      const script = args[++i];
      if (electron && /^(?:-r|--require)$/.test(arg) && script && basename(script) === "dsh-launch.cjs") return true;
    } else if (electron && /^--require=(?:.*\/)?dsh-launch\.cjs$/.test(arg)) return true;
    else if (!arg.startsWith("-")) return isDshScript(arg);
  }
  return false;
}

function isDshScript(script) {
  return /(?:^|\/)(?:@deepseek-ai\/dsh\/lib\/bin\.js|dsh-launch\.cjs|bots-dsh\/.*|(?:deepseek-harness|dsh)\/(?:bin|dist|src)\/.*)$/.test(script ?? "");
}

export function pairingRefusal(env, tty, parents, argv = []) {
  if (argv.includes("--json") || env.AM_JSON === "1") return "Pairing and key reset need a terminal and cannot use JSON.";
  if (!tty.stdin || !tty.stdout) return "Pairing and key reset need an interactive terminal.";
  if (markers.some(name => env[name]) || env.DSH_SANDBOX_MASK === "1") return "Open a terminal outside Herdr, DSH, Claude Code or Codex.";
  if (!parents) return "Cannot check who started this terminal.";
  const blocked = /^(herdr-core|hc|herdr-app|claude|codex|dsh)(?:\.exe)?$/i;
  if (parents.some(({ command, name, dsh }) => dsh || blocked.test(name ?? "")
      || (Array.isArray(command) && (blocked.test(basename(command[0] ?? "")) || dshLauncher(command))))) {
    return "Open a terminal outside Herdr, DSH, Claude Code or Codex.";
  }
  return null;
}

export function drawQr(rows, columns) {
  const width = rows.length + 8;
  if (columns && columns < width) return null;
  const quiet = "0".repeat(width);
  const margin = Array(4).fill(quiet);
  const padded = [...margin, ...rows.map(row => "0000" + row + "0000"), ...margin];
  const lines = [];
  for (let y = 0; y < padded.length; y += 2) {
    const below = padded[y + 1] ?? quiet;
    let line = "";
    let last;
    for (let x = 0; x < width; x++) {
      const colors = `${padded[y][x] === "1" ? 30 : 97};${below[x] === "1" ? 40 : 107}`;
      if (colors !== last) line += `\x1b[${colors}m`;
      last = colors;
      line += "▀";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

function run(node, script, args, env, timeout = 30_000) {
  const argv = process.versions.bun && node === process.execPath ? ["--no-env-file", script, ...args] : [script, ...args];
  const r = spawnSync(node, argv, { encoding: "utf8", env, timeout, stdio: ["ignore", "pipe", "pipe"] });
  let value;
  try { value = JSON.parse(r.stdout); } catch {}
  if (r.status !== 0 || value?.ok === false || value === undefined) {
    throw new Error(value?.error || r.error?.message || r.stderr?.trim() || `Pocket Link ${args[0]} did not answer.`);
  }
  return value;
}

function amSource(env) {
  const current = join(amHome(env), "parts", "automagik.am", "current");
  if (info(current)) {
    const folder = join(current, "pocket");
    return existsSync(join(folder, SERVICE)) ? { folder: realpathSync(folder), version: read(join(current, "VERSION"))?.trim() } : null;
  }
  const extract = read(join(OWN, "..", "VERSION"))?.trim();
  return extract ? { folder: OWN, version: extract } : null;
}

function treeFiles(dir, sub = "") {
  return names(join(dir, sub)).flatMap(name => {
    const path = join(sub, name);
    if (path === MODULES || path === SLOT_MARKER) return [];
    const file = lstatSync(join(dir, path));
    if (file.isDirectory()) return treeFiles(dir, path);
    if (!file.isFile()) throw new Error(`Unexpected Pocket Link payload file ${path}`);
    return [path];
  });
}
function identity(source) {
  if (!source?.version || !/^\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(source.version)) {
    throw new Error("Pocket Link's copy is missing its am VERSION.");
  }
  const files = treeFiles(source.folder);
  const tree = hex(JSON.stringify(files.map(path => [path, hex(readFileSync(join(source.folder, path)))])));
  const lock = hex(readFileSync(join(source.folder, LOCKFILE)));
  return { ...source, files, tree, lock };
}
const slot = (store, value) => {
  if (!value?.dir || basename(value.dir) !== value.dir || !/^\d[\w.+-]*$/.test(value.dir)) {
    throw new Error("Invalid Pocket Link slot in the install record.");
  }
  return join(store, value.dir);
};
const packages = folder => ["@number0/iroh", "qrcode"].every(name => existsSync(join(folder, MODULES, name, "package.json")));
function probePackages(node, folder, env) {
  const bridge = join(folder, "link/bridge");
  if (!packages(folder)) throw new Error("Pocket Link's npm packages are incomplete.");
  const r = spawnSync(node, ["--input-type=module", "-e", "await import('@number0/iroh'); await import('qrcode')"], {
    env: nodeEnv(env, node), cwd: bridge, encoding: "utf8", timeout: 15_000,
  });
  if (r.status !== 0) {
    const reason = process.platform === "darwin" && process.arch === "x64"
      ? "Pocket Link has no build for this Mac." : "Pocket Link could not load its npm packages.";
    throw new Error(`${reason} ${r.error?.message || r.stderr?.trim() || ""}`.trim());
  }
}
function stage({ store, node, tool, env }, source, record, notice) {
  for (const retained of [record?.current, record?.previous].filter(e => e?.tree === source.tree)) {
    const folder = slot(store, retained);
    try {
      if (identity({ folder, version: retained.version }).tree !== source.tree) continue;
      probePackages(node, folder, env);
      return { retained };
    } catch { /* Repair in a new slot. */ }
  }
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const start = run(node, tool, ["start-tag"], env);
  if (!start) throw new Error("Cannot identify the Pocket Link staging process.");
  const folder = mkdtempSync(join(store, `.staging-${process.pid}-${start}-`));
  try {
    for (const path of source.files) {
      const target = join(folder, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(source.folder, path), target);
    }
    if (identity({ folder, version: source.version }).tree !== source.tree) throw new Error("am's Pocket Link source changed during staging. Retry the command.");
    const current = record?.current && slot(store, record.current);
    if (current && record.current.lock === source.lock && packages(current)) {
      cpSync(join(current, MODULES), join(folder, MODULES), { recursive: true, verbatimSymlinks: true });
      try {
        probePackages(node, folder, env);
        return { folder };
      } catch { rmSync(join(folder, MODULES), { recursive: true, force: true }); }
    }
    if (!record) notice("Pocket Link downloads about 25 MB from npm.");
    const npm = findNpm(env, node);
    if (!npm) throw new Error("Pocket Link needs npm for the selected Node.");
    const r = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: join(folder, "link/bridge"), env: nodeEnv(env, node), encoding: "utf8", timeout: 300_000,
    });
    if (r.status !== 0) throw new Error(`Pocket Link npm ci failed: ${r.error?.message || r.stderr?.trim() || r.status}`);
    probePackages(node, folder, env);
    return { folder };
  } catch (e) {
    rmSync(folder, { recursive: true, force: true });
    throw e;
  }
}

function inside(parent, child) {
  const tail = relative(parent, child);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep));
}
function validateState(path, store, { existing = true } = {}) {
  if (!path || !isAbsolute(path)) throw new Usage("Choose an absolute Pocket Link state directory.");
  const file = info(path);
  if ((existing && !file) || (file && (!file.isDirectory() || file.uid !== process.getuid()))) {
    throw new Error(`Pocket Link state must be a directory you own, without a symlink: ${path}`);
  }
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  const physical = resolve(realpathSync(parent), relative(parent, path));
  let storeParent = store;
  while (!existsSync(storeParent)) storeParent = dirname(storeParent);
  const physicalStore = resolve(realpathSync(storeParent), relative(storeParent, store));
  if (inside(physical, physicalStore) || inside(physicalStore, physical)) {
    throw new Error(`Pocket Link state and its parts store must be separate: ${path}`);
  }
  return physical;
}
function chooseState(context, record, explicit, notice) {
  const { env, store, definition, oldMod } = context;
  if (record) {
    if (explicit) throw new Usage("--state is available on first install only.");
    const state = validateState(record.state, store, { existing: false });
    if (state !== record.state) throw new Error(`Pocket Link's recorded state moved: ${record.state} → ${state}`);
    if (env.POCKET_LINK_STATE_DIR && validateState(env.POCKET_LINK_STATE_DIR, store, { existing: false }) !== state) {
      throw new Error(`Pocket Link state is recorded at ${state}; the environment names ${env.POCKET_LINK_STATE_DIR}.`);
    }
    return state;
  }
  let state = validateState(explicit ?? definition.stateDefault, store, { existing: Boolean(explicit) });
  if (!explicit && !env.POCKET_LINK_STATE_DIR && !existsSync(join(state, "secret.key"))) {
    const paired = context.alternatives.filter(dir => dir !== definition.stateDefault && dir !== join(oldMod, ".state") && existsSync(join(dir, "secret.key")));
    if (paired.length > 1) throw new Error(`Choose a Pocket Link state folder with --state DIR: ${paired.join(", ")}`);
    if (paired.length === 1) {
      state = validateState(paired[0], store);
      notice(`Pocket Link is keeping the pairings at ${state}.`);
    }
  }
  if (existsSync(join(oldMod, ".state", "secret.key")) && !existsSync(join(state, "secret.key"))) {
    throw new Error("Open the Pocket Link dialog once; it moves the old state.");
  }
  return state;
}

function contextOf(env, record, pending) {
  const store = storeOf(env);
  const source = amSource(env);
  const fallback = record?.current ?? pending?.prior?.record?.current ?? pending?.intended?.current;
  const installed = fallback && slot(store, fallback);
  const tool = [source?.folder, OWN, installed].filter(Boolean).map(dir => join(dir, SERVICE)).find(existsSync);
  if (!tool) throw new Error("This am carries no Pocket Link.");
  const app = env.HERDR_APP_HOME || join(env.HOME || homedir(), ".config/herdr-app");
  // Under Bun the old service can be the only existing pointer to Node. The helper can run
  // under Bun for this discovery, and every bridge command uses the probed Node.
  const definition = run(process.execPath, tool, ["definition"], env);
  const node = findNode(env, record?.node ?? pending?.prior?.record?.node, definition.node);
  const oldMod = join(app, "mods/pocket-link");
  const dialog = read(join(oldMod, "main.js"));
  const base = isAbsolute(env.XDG_STATE_HOME ?? "") ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local/state");
  const alternatives = [...new Set([definition.state, definition.stateDefault, join(oldMod, ".state"),
    ...names(base).filter(name => /^automagik-pocket-link(?:-|$)/.test(name)).map(name => join(base, name)),
  ].filter(Boolean))].filter(dir => isAbsolute(dir) && info(dir)?.isDirectory());
  return { store, source, tool, node, definition, alternatives, oldMod, oldDialog: dialog !== null && !dialog.includes("Managed by am (am pocket)"), env };
}

function snapshot(context, state, alternatives = [], scan = false) {
  return run(context.node ?? process.execPath, context.tool,
    ["inspect", state ?? "", entryOf(context.store), ...(scan ? ["--scan"] : []), ...alternatives], context.env);
}
function lock(context, path) {
  const owner = run(context.node, context.tool, ["acquire", path], context.env, 15_000);
  const held = () => recordAt(path)?.token === owner.token;
  return {
    token: owner.token,
    held,
    release() { if (held()) rmSync(path); },
  };
}
function requireLocks(...locks) {
  if (!locks.every(lock => lock?.held())) throw new Error("Pocket Link lost its transaction locks.");
}
function bridge(context, record, args, locks, folder = slot(context.store, record.current), digest = "") {
  if (locks) requireLocks(locks.store, locks.manager, locks.state);
  if (!context.node) throw new Error("Pocket Link needs Node.js 20.3 or newer.");
  const env = { ...context.env, POCKET_LINK_STATE_DIR: record.state, POCKET_LINK_SERVICE_ENTRY: entryOf(context.store),
    POCKET_LINK_SERVICE_NODE: context.node, POCKET_LINK_STATE_LOCK: locks?.state.token,
    POCKET_LINK_PURGE_TOKEN: locks?.purgeToken,
    POCKET_LINK_MANAGER_LOCK: locks?.manager.token, POCKET_LINK_SERVICE_DIGEST: locks && digest,
    POCKET_LINK_INSTALL_DIGEST: locks && record.digest };
  return run(context.node, join(folder, BRIDGE), args, env);
}
function foreign(context, state, prior, first, ...digests) {
  const ourEntry = entryOf(context.store);
  if (first && prior.definition.entry === ourEntry) throw new Error("This Pocket Link service has no install record. Turn it off before installing Pocket Link again.");
  if ((prior.definition.present && (prior.definition.entry !== ourEntry || prior.definition.state !== state
        || !prior.definition.digest || !digests.includes(prior.definition.digest)))
      || (prior.job.loaded && !prior.job.owned)
      || (prior.job.pid && !prior.job.ours)
      || prior.running.some(p => !p.ours || p.state !== state)
      || (first && (context.oldDialog || prior.detached))) throw new Error(FOREIGN);
}
function priorState(record, before) {
  let inactive;
  if (before.ready && process.platform === "linux" && before.job.enabled !== "enabled") {
    throw new Error("Pocket Link cannot safely restore a running service that is not enabled.");
  }
  if (!before.ready && (before.running.length || (before.definition.present && !before.job.inactive))) {
    throw new Error("Pocket Link cannot safely restore the current service state. Let it settle and try again.");
  }
  if (before.definition.present && !before.ready) {
    const { job } = before;
    inactive = { body: before.definition.body, enabled: job.enabled };
  }
  return { record, ready: before.ready, pid: before.job.pid, service: before.definition.present, inactive };
}
function links(store, record) {
  for (const name of ["previous", "current"]) {
    const file = join(store, name);
    const target = record?.[name];
    if (!target) { remove(file); continue; }
    slot(store, target);
    const temp = `${file}.${randomUUID()}.tmp`;
    symlinkSync(target.dir, temp);
    try { renameSync(temp, file); } finally { if (info(temp)) unlinkSync(temp); }
  }
  syncFolder(store);
}
function currentLinkIs(store, record) {
  const path = join(store, "current");
  return info(path)?.isSymbolicLink() && readlinkSync(path) === record.current.dir;
}
const stateOwnerFile = state => join(state, "am-owner.json");
function readStateOwner(state) {
  const path = stateOwnerFile(state);
  const file = info(path);
  if (!file) return null;
  const owner = file.isFile() && recordAt(path)?.store;
  if (typeof owner !== "string" || !isAbsolute(owner)) throw new Error("Invalid Pocket Link state owner.");
  return owner;
}
function requireStateOwner(owner, store) {
  if (owner === store) return;
  if (owner) throw new Error("Another am store owns this Pocket Link state directory.");
  throw new Error("This am store does not own the Pocket Link state directory.");
}
function setStateOwner(state, owner) {
  if (owner) save(stateOwnerFile(state), { store: owner });
  else remove(stateOwnerFile(state));
}
function writeRecord(store, record) {
  if (record) save(recordPath(store), record);
  else remove(recordPath(store));
}
function prune(context, record) {
  const { store, tool, node, env } = context;
  for (const name of run(node, tool, ["dead-staging", store], env)) rmSync(join(store, name), { recursive: true, force: true });
  for (const name of names(store)) {
    if (!/^\d[\w.+-]*$/.test(name) || [record?.current?.dir, record?.previous?.dir].includes(name)
        || !info(join(store, name))?.isDirectory() || !info(join(store, name, SLOT_MARKER))?.isFile()) continue;
    rmSync(join(store, name), { recursive: true, force: true });
  }
}
async function serve(context, record, locks, oldPid) {
  bridge(context, record, ["install"], locks);
  const deadline = Date.now() + 20_000;
  do {
    const state = snapshot(context, record.state);
    if (state.ready && state.definition.digest === record.digest && state.job.pid !== oldPid) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`Pocket Link did not start. See ${join(record.state, "bridge.log")}`);
}

function purgeState(state, store) {
  if (!info(state)) return;
  if (validateState(state, store) !== state) throw new Error(`Pocket Link state moved: ${state}`);
  for (const name of KNOWN_STATE) {
    const path = join(state, name);
    const file = info(path);
    if (file?.uid === process.getuid() && (file.isFile() || (name === "bridge.sock" && file.isSocket()))) rmSync(path);
  }
}
function removeEmpty(path) {
  try { rmdirSync(path); } catch (e) { if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(e.code)) throw e; }
}
const purgeMarker = state => join(state, "purge.pending");
const purgeBusy = () => new Error("A Pocket Link purge is pending in this state directory. Finish it from the am that started it.");
function markerOwner(state) {
  const marker = purgeMarker(state);
  const file = info(marker);
  if (!file) return null;
  if (!file.isFile()) throw new Error("Invalid Pocket Link purge marker.");
  const owner = recordAt(marker);
  if (!owner?.store || !owner.token) throw new Error("Invalid Pocket Link purge marker.");
  return owner;
}
function ownsPurge(context, pending, owner) {
  return Boolean(pending?.purge && owner?.token && owner.store === context.store && owner.token === pending.token);
}
function finishUninstall(context, pending, locks) {
  requireLocks(locks.store, locks.manager, locks.state);
  const { store } = context;
  if (pending.purge && pending.step !== "purged") {
    if (!ownsPurge(context, pending, markerOwner(pending.state))) {
      throw new Error("Pocket Link cannot resume the purge without its state ownership marker. Pairings were kept.");
    }
    requireStateOwner(readStateOwner(pending.state), realpathSync(store));
    const seen = snapshot(context, pending.state, [], true);
    if (seen.definition.present || seen.job.loaded || seen.running.length || seen.detached) {
      throw new Error("Pocket Link state may be in use by another bridge. Pairings were kept.");
    }
    purgeState(pending.state, store);
    syncFolder(pending.state);
    // Commit the deletion before releasing the marker so a retry cannot purge a new owner.
    pending.step = "purged";
    save(pendingPath(store), pending);
  }
  links(store, null);
  prune(context, null);
  if (readStateOwner(pending.state) === realpathSync(store)) setStateOwner(pending.state, null);
  if (ownsPurge(context, pending, markerOwner(pending.state))) remove(purgeMarker(pending.state));
  remove(pendingPath(store));
  removeEmpty(store);
}

async function recover(context, pending, locks) {
  const { store } = context;
  requireLocks(locks.store, locks.manager, locks.state);
  const live = recordAt(recordPath(store));
  if (pending.op === "off" && pending.intended?.digest === null && JSON.stringify(live) === JSON.stringify(pending.intended)) {
    remove(pendingPath(store));
    return false;
  }
  if (pending.op === "uninstall" && !live) {
    finishUninstall(context, pending, locks);
    return Boolean(pending.purge);
  }
  const { record, inactive } = pending.prior;
  const owner = readStateOwner(pending.state);
  if (Object.hasOwn(pending.prior, "owner") && owner !== pending.prior.owner && owner !== pending.nextOwner) {
    throw new Error("Another am store owns this Pocket Link state directory.");
  }
  if (pending.purge) requireStateOwner(owner, realpathSync(store));
  const seen = snapshot(context, pending.state);
  foreign(context, pending.state, seen, false, record?.digest, pending.intended?.digest, pending.restoreDigest);
  if (pending.prior.service && !pending.prior.ready && !inactive) {
    throw new Error("The pending Pocket Link transaction did not record its prior service state.");
  }
  const selected = pending.intended?.current;
  const working = [selected, record?.current].find(entry => entry && existsSync(join(slot(store, entry), BRIDGE)));
  const unchanged = (pending.prior.ready && seen.ready && (
    (["prepared", "aborting"].includes(pending.step) && seen.job.pid === pending.prior.pid)
    || seen.definition.digest === pending.restoreDigest))
    || (inactive && seen.job.inactive && seen.job.enabled === inactive.enabled && seen.definition.body === inactive.body
      && !seen.running.length);
  if (!unchanged && (seen.definition.present || seen.job.loaded || seen.running.length)) {
    requireStateOwner(owner, realpathSync(store));
    if (!working) throw new Error("Pocket Link cannot recover its service without the retained bridge.");
    bridge(context, { state: pending.state, current: working }, ["stop"], locks, undefined, seen.definition.digest);
  }
  if (ownsPurge(context, pending, markerOwner(pending.state))) {
    // The record still exists, so abort the purge durably before the prior service can start.
    pending.step = "aborting";
    save(pendingPath(store), pending);
    remove(purgeMarker(pending.state));
  }
  if (Object.hasOwn(pending.prior, "owner") && owner !== pending.prior.owner) {
    setStateOwner(pending.state, pending.prior.owner);
  }
  links(store, record);
  if (pending.prior.ready && !unchanged) {
    pending.restoreDigest = bridge(context, record, ["definition-digest"], locks);
    save(pendingPath(store), pending);
    await serve(context, { ...record, digest: pending.restoreDigest }, locks, null);
  }
  if (inactive && !unchanged) bridge(context, record, ["restore-inactive", JSON.stringify(inactive)], locks);
  if (pending.restoreDigest && pending.prior.ready) {
    writeRecord(store, { ...record, node: unchanged ? seen.definition.node : context.node, digest: pending.restoreDigest });
  } else {
    writeRecord(store, record);
  }
  requireLocks(locks.store, locks.manager, locks.state);
  remove(pendingPath(store));
  prune(context, record);
  return false;
}

function lockedState(context, state, locks, pending) {
  if (!context.node) throw new Error("Pocket Link needs Node.js 20.3 or newer.");
  const physical = validateState(state, context.store, { existing: false });
  if (physical !== state) throw new Error(`Pocket Link state moved: ${state} → ${physical}`);
  locks.manager = lock(context, context.definition.lock);
  validateState(state, context.store, { existing: false });
  locks.state = lock(context, join(state, "service.lock"));
  const owner = markerOwner(state);
  const purgeFinished = pending?.op === "uninstall" && pending.purge && pending.step === "purged";
  if (owner && !ownsPurge(context, pending, owner) && !purgeFinished) {
    throw purgeBusy();
  }
  if (ownsPurge(context, pending, owner)) locks.purgeToken = pending.token;
}
function unlock(locks) {
  try { locks.state?.release(); } finally {
    try { locks.manager?.release(); } finally { locks.store?.release(); }
  }
}
const storeLock = context => lock(context, join(dirname(context.store), ".pocket.link.lock"));
const readRecord = store => recordAt(recordPath(store));

async function reconcile(env) {
  const store = storeOf(env);
  if (!info(pendingPath(store))) return false;
  const locks = {};
  let state, purged = false;
  try {
    const context = contextOf(env, readRecord(store), recordAt(pendingPath(store)));
    if (!context.node) throw new Error("Pocket Link needs Node.js 20.3 or newer for recovery.");
    locks.store = storeLock(context);
    const pending = recordAt(pendingPath(store));
    if (!pending) return false;
    state = pending.state;
    lockedState(context, state, locks, pending);
    purged = await recover(context, pending, locks);
    return pending.op === "uninstall" && !readRecord(store);
  } finally {
    try {
      if (purged) {
        locks.state?.release();
        removeEmpty(state);
      }
    } finally { unlock(locks); }
  }
}

async function syncFiles(env, { turnOn = false, explicit, notice = () => {} } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await reconcile(env);
    const store = storeOf(env);
    const record = readRecord(store);
    const context = contextOf(env, record);
    if (!context.node) throw new Error("Pocket Link needs Node.js 20.3 or newer.");
    if (!context.source && !record) throw new Error("This am carries no Pocket Link.");
    if (!context.source && !turnOn) return { state: "kept", detail: `This am carries no Pocket Link; kept ${record.current.version}.` };
    if (explicit && record) throw new Usage("--state is available on first install only.");
    if (!record && (context.oldDialog || (context.definition.present && context.definition.entry !== entryOf(store)))) throw new Error(FOREIGN);
    const state = chooseState(context, record, explicit, notice);
    if (markerOwner(state)) throw purgeBusy();
    const source = context.source && identity(context.source);
    if (!record) foreign(context, state, snapshot(context, state, context.alternatives, true), true);
    const prepared = source && stage(context, source, record, notice);
    const locks = {};
    try {
      locks.store = storeLock(context);
      if (JSON.stringify(readRecord(store)) !== JSON.stringify(record) || info(pendingPath(store))) continue;
      if (identityChanged(env, source)) continue;
      lockedState(context, state, locks);
      const fresh = record ? context : contextOf(env, record);
      const before = snapshot(fresh, state, record ? [] : fresh.alternatives, !record);
      foreign(fresh, state, before, !record, record?.digest);
      if (!record && chooseState(fresh, record, explicit, () => {}) !== state) continue;
      if (before.definition.present && !before.ready && !turnOn) {
        throw new Error(`Pocket Link's service is not ready. Run ${LINK_FIX} to repair it.`);
      }
      const prior = priorState(record, before);
      prior.owner = readStateOwner(state);
      const nextOwner = turnOn ? realpathSync(store) : prior.owner;
      const hasService = before.definition.present || before.running.length || before.job.loaded;
      if (hasService) requireStateOwner(prior.owner, realpathSync(store));
      const changing = Boolean(prepared && prepared.retained?.dir !== record?.current?.dir) || Boolean(prepared?.folder);
      if (!changing && (!turnOn || (before.ready && record.node === context.node && before.definition.node === context.node))) {
        if (!currentLinkIs(store, record)) links(store, record);
        if (prior.owner !== nextOwner) setStateOwner(state, nextOwner);
        return { state: source ? "current" : "kept", detail: source ? `Pocket Link ${record.current.version} is current.`
          : `This am carries no Pocket Link; kept ${record.current.version}.`, record };
      }
      let current = prepared?.retained ?? record?.current;
      if (prepared?.folder) {
        const dir = !info(join(store, source.version)) ? source.version : `${source.version}-${randomUUID().slice(0, 8)}`;
        current = { dir, version: source.version, tree: source.tree, lock: source.lock, installed: new Date().toISOString() };
      }
      if (!source) probePackages(context.node, slot(store, current), env);
      const next = { current, previous: changing && record?.current?.dir !== current.dir ? record?.current ?? null : record?.previous ?? null,
        state, node: context.node, digest: null };
      if (next.previous?.dir === next.current.dir) next.previous = null;
      if (turnOn || before.ready) next.digest = bridge(context, next, ["definition-digest"], locks, prepared?.folder);
      const pending = { op: "sync", token: locks.store.token, state, node: context.node, prior, nextOwner, intended: next, step: "prepared" };
      function step(value) {
        requireLocks(locks.store, locks.manager, locks.state);
        pending.step = value;
        save(pendingPath(store), pending);
      }
      step("prepared");
      try {
        if (prepared?.folder) {
          save(join(prepared.folder, SLOT_MARKER), { tree: current.tree });
          renameSync(prepared.folder, slot(store, current));
          syncFolder(store);
        }
        if (hasService) {
          const oldSlot = record && slot(store, record.current);
          const stopWith = oldSlot && existsSync(join(oldSlot, BRIDGE)) ? oldSlot : slot(store, next.current);
          bridge(context, record ?? next, ["stop"], locks, stopWith, before.definition.digest);
        }
        step("stopped");
        links(store, next);
        if (prior.owner !== nextOwner) setStateOwner(state, nextOwner);
        step("swapped");
        if (turnOn || before.ready) await serve(context, next, locks, before.job.pid);
        step("served");
        writeRecord(store, next);
        step("recorded");
        remove(pendingPath(store));
      } catch (e) {
        try { await recover(context, pending, locks); } catch (recovery) {
          throw new Error(`${e.message} Recovery is pending: ${recovery.message}`);
        }
        throw e;
      }
      prune(context, next);
      return { state: changing ? "updated" : source ? "current" : "kept",
        detail: source ? `Pocket Link ${next.current.version} is ${changing ? "installed" : "current"}.`
          : `This am carries no Pocket Link; kept ${next.current.version}.`, record: next };
    } finally {
      unlock(locks);
      if (prepared?.folder) rmSync(prepared.folder, { recursive: true, force: true });
    }
  }
  throw new Error("Pocket Link changed while preparing the files. Retry the command.");
}
function identityChanged(env, expected) {
  const now = amSource(env);
  return Boolean(now) !== Boolean(expected) || Boolean(now && (now.version !== expected.version || identity(now).tree !== expected.tree));
}

async function turnOff(env, uninstall, purge) {
  const finished = await reconcile(env);
  const store = storeOf(env);
  let record = readRecord(store);
  if (!record) {
    if (finished && uninstall) return { ok: true, detail: "Pocket Link uninstall completed." };
    throw new Usage("Pocket Link is not installed.");
  }
  const context = contextOf(env, record);
  if (!context.node) throw new Error("Pocket Link needs Node.js 20.3 or newer.");
  const locks = {};
  let purged = false, state;
  try {
    locks.store = storeLock(context);
    record = readRecord(store);
    if (!record || info(pendingPath(store))) throw new Error("Pocket Link changed. Retry the command.");
    state = chooseState(context, record);
    if (purge && info(state)) validateState(state, store);
    lockedState(context, state, locks);
    const owner = readStateOwner(state);
    requireStateOwner(owner, realpathSync(store));
    const before = snapshot(context, state);
    foreign(context, state, before, false, record.digest);
    const prior = { ...priorState(record, before), owner };
    const pending = { op: uninstall ? "uninstall" : "off", token: locks.store.token, state, node: context.node,
      prior, intended: uninstall ? null : { ...record, digest: null }, step: "prepared", purge };
    save(pendingPath(store), pending);
    try {
      if (purge) {
        save(purgeMarker(state), { store, token: pending.token });
        locks.purgeToken = pending.token;
      }
      const stopped = bridge(context, record, [uninstall ? "uninstall" : "stop"], locks, undefined, before.definition.digest);
      requireLocks(locks.store, locks.manager, locks.state);
      if (uninstall) {
        writeRecord(store, null);
        finishUninstall(context, pending, locks);
        purged = purge;
      } else {
        writeRecord(store, pending.intended);
        remove(pendingPath(store));
      }
      return { ...stopped, detail: uninstall
        ? `Pocket Link was uninstalled. ${purge ? "Known pairing state was purged." : "Pairings were kept."} The Herdr dialog can turn on its own copy.`
        : "Pocket Link is off." };
    } catch (e) {
      if (readRecord(store)) {
        try { await recover(context, pending, locks); } catch (recovery) {
          throw new Error(`${e.message} Recovery is pending: ${recovery.message}`);
        }
      }
      throw e;
    }
  } finally {
    try {
      if (purged) {
        locks.state?.release();
        removeEmpty(state);
      }
    } finally { unlock(locks); }
  }
}

function doctor(env) {
  const store = storeOf(env);
  const record = readRecord(store);
  const pending = recordAt(pendingPath(store));
  const context = contextOf(env, record, pending);
  const node = context.node;
  const npm = node && findNpm(env, node);
  let seen, managerError;
  try { seen = snapshot(context, record?.state); } catch (e) { managerError = e.message; }
  let goodPackages = false, packageError, stateInfo;
  if (record) {
    const folder = slot(store, record.current);
    try {
      if (node && hex(readFileSync(join(folder, LOCKFILE))) === record.current.lock) {
        probePackages(node, folder, env);
        goodPackages = true;
      }
    } catch (e) { packageError = e.message.split("\n")[0]; }
    stateInfo = info(record.state);
  }
  const ours = record?.digest && seen?.definition.digest === record.digest && seen.job.owned;
  const healthyState = stateInfo?.isDirectory() && stateInfo.uid === process.getuid() && (stateInfo.mode & 0o777) === 0o700;
  const row = (check, ok, detail, fix) => ({ part: POCKET, check, ok: Boolean(ok), detail, fix: ok ? null : fix });
  return [
    row("node", node, node ?? "Node.js 20.3 or newer is required.", "Install Node.js."),
    row("npm", npm, npm ?? "npm is missing.", "Install npm for the selected Node."),
    row("packages", goodPackages, goodPackages ? "Installed against the retained lockfile."
      : packageError ?? "Bridge packages are missing or incomplete.", LINK_FIX),
    row("service", !pending && ours, pending ? "A Pocket Link transaction is pending."
      : managerError ?? (ours ? entryOf(store) : "Pocket Link's login service is off or belongs to another install."), LINK_FIX),
    row("running", ours && seen?.ready, ours && seen?.ready ? "The login service is serving Pocket." : "The login service is not serving Pocket.", LINK_FIX),
    row("state", healthyState, record?.state ?? "Pocket Link has no recorded state.", healthyState ? null : "Use a state directory you own with mode 0700."),
    row("dialog", !context.oldDialog, context.oldDialog ? "An older Herdr dialog is enabled." : "No incompatible Herdr dialog is enabled.", "Update or remove the Pocket Link mod."),
  ];
}

function status(env) {
  const store = storeOf(env);
  const record = readRecord(store);
  if (!record) return { installed: false, running: false };
  const context = contextOf(env, record);
  chooseState(context, record);
  const service = Boolean(record.digest && context.definition.digest === record.digest);
  return { installed: true, version: record.current.version, ...bridge(context, record, ["status"]), state: record.state, service };
}

function cancelPairing(context, record, code, expires) {
  const args = ["cancel", hex(code)];
  const attempt = selected => {
    try { return bridge(selected, record, args).cancelled; } catch { return false; }
  };
  if (attempt(context)) return;
  const node = findNode(context.env, record.node, context.definition.node);
  if (node && node !== context.node && attempt({ ...context, node })) return;
  try {
    const active = recordAt(join(record.state, "pairing.json"));
    if (!active || (typeof active.code === "string" && active.code !== code)) return;
    if (Number.isFinite(active.expires)) expires = active.expires;
  } catch { /* Without a readable record, use the original expiry. */ }
  if (Date.now() <= expires) throw new Error(`Could not cancel pairing. The code is still valid until ${new Date(expires).toLocaleTimeString()}.`);
}

async function pairPhone(env, minutes, explicit, notice) {
  const signal = new AbortController();
  const cancel = () => signal.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let challenge, record, context;
  try {
    ({ record } = await syncFiles(env, { turnOn: true, explicit, notice }));
    if (signal.signal.aborted) return 130;
    context = contextOf(env, record);
    challenge = bridge(context, record, ["pair", String(minutes)]);
    const { code } = challenge;
    if (!code || signal.signal.aborted) return signal.signal.aborted ? 130 : 1;
    const drawing = drawQr(challenge.rows, process.stdout.columns);
    console.log(drawing ?? "Widen the terminal, or paste the link in Pocket.");
    console.log(challenge.link);
    console.log(`Expires ${new Date(challenge.expires).toLocaleTimeString()}.`);
    while (!signal.signal.aborted && Date.now() < challenge.expires) {
      await delay(Math.min(1_000, Math.max(1, challenge.expires - Date.now())), undefined, { signal: signal.signal }).catch(e => {
        if (e.name !== "AbortError") throw e;
      });
      if (signal.signal.aborted) break;
      const active = recordAt(join(record.state, "pairing.json"));
      const completed = recordAt(join(record.state, "pairing-completed.json"))?.[hex(code)];
      if (completed) {
        console.log(`Paired ${completed.name} (${completed.fingerprint}).`);
        return 0;
      }
      if (active?.code !== code && Date.now() < challenge.expires) {
        throw new Error("Another pairing code replaced this one, or it was cancelled.");
      }
    }
    if (signal.signal.aborted) return 130;
    throw new Error("The pairing code expired. Run am pocket pair for a new one.");
  } finally {
    try {
      if (challenge?.code) cancelPairing(context, record, challenge.code, challenge.expires);
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}

export async function updatePocket(env = process.env) {
  if (!["linux", "darwin"].includes(process.platform)) return { state: "not-installed", detail: "Pocket Link is unavailable." };
  const store = storeOf(env);
  try {
    if (!info(recordPath(store)) && !info(pendingPath(store))) return { state: "not-installed", detail: "Pocket Link is not installed." };
    await reconcile(env);
    if (!readRecord(store)) return { state: "not-installed", detail: "Pocket Link is not installed." };
    const { state, detail } = await syncFiles(env);
    return { state, detail };
  } catch (e) { return { state: "failed", detail: e.message }; }
}

export async function pocketMain(argv, { env = process.env, platform = process.platform, ancestry = ancestors } = {}) {
  const json = argv.includes("--json") || env.AM_JSON === "1";
  const say = value => console.log(json ? JSON.stringify(value) : (value.detail ?? value.error));
  const error = message => json ? say({ part: POCKET, ok: false, error: message }) : console.error(message);
  if (!["linux", "darwin"].includes(platform)) { error("Pocket Link is available on macOS and Linux."); return 2; }
  const words = argv.filter(arg => arg !== "--json");
  const pair = words[0] === "pair";
  const reset = words[0] === "link" && words[1] === "reset";
  if (pair || reset) {
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    const refusal = pairingRefusal(env, tty, [], argv) ?? pairingRefusal(env, tty, ancestry(), argv);
    if (refusal) { console.error(refusal); return 2; }
  }
  const [group, verb, ...rest] = words;
  const command = pair ? group : group === "link" ? verb : null;
  const options = pair ? words.slice(1) : rest;
  let explicit, minutes = 10, purge = false, id;
  try {
    for (let i = 0; i < options.length; i++) {
      const param = options[i];
      if (param === "--state" && ["pair", "on", "install"].includes(command) && !explicit && options[i + 1]) {
        explicit = options[++i];
        if (!isAbsolute(explicit)) throw new Usage("--state needs an absolute directory.");
      } else if (param === "--minutes" && pair && /^\d+$/.test(options[i + 1] ?? "")) minutes = Number(options[++i]);
      else if (param === "--purge" && command === "uninstall" && !purge) purge = true;
      else if (command === "forget" && !id && !param.startsWith("-")) id = param;
      else throw new Usage(`Unexpected Pocket Link argument ${param}.`);
    }
    const notice = text => (json ? console.error : console.log)(text);
    if (pair) {
      if (minutes < 1 || minutes > 60) throw new Usage("--minutes must be between 1 and 60.");
      return await pairPhone(env, minutes, explicit, notice);
    }
    if (command === "doctor") {
      const rows = doctor(env);
      for (const row of rows) console.log(json ? JSON.stringify(row)
        : `${row.ok ? "ok" : "FAIL"} ${row.check}  ${row.detail}${row.fix ? `  Fix with ${row.fix}` : ""}`);
      return !readRecord(storeOf(env)) ? 2 : rows.every(row => row.ok) ? 0 : 1;
    }
    if (command === "install" || command === "on") {
      const result = await syncFiles(env, { turnOn: true, explicit, notice });
      say({ ok: true, version: result.record.current.version, detail: result.detail });
      return 0;
    }
    if (command === "uninstall" || command === "off") {
      say(await turnOff(env, command === "uninstall", purge));
      return 0;
    }
    if (!["status", "forget", "reset"].includes(command)) throw new Usage("Use am pocket pair or am pocket link status|on|off|forget|reset|install|uninstall|doctor.");
    if (command === "forget" && !id) throw new Usage("am pocket link forget needs a phone id.");
    await reconcile(env);
    if (command === "status") {
      const value = status(env);
      if (json) say(value);
      else if (!value.installed) say({ detail: "Pocket Link is not installed." });
      else {
        say({ detail: `Pocket Link ${value.version} is ${value.running ? "running" : "off"}${value.fingerprint ? ` (${value.fingerprint})` : ""}. State is at ${value.state}.` });
        for (const phone of value.devices) console.log(`${phone.name} (${phone.fingerprint})  ${phone.id}`);
      }
      return value.installed ? 0 : 2;
    }
    const record = readRecord(storeOf(env));
    if (!record) throw new Usage("Pocket Link is not installed.");
    const context = contextOf(env, record);
    chooseState(context, record);
    if (reset) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question("Reset the key and unpair every phone? [y/N] ");
        if (!/^y(es)?$/i.test(answer.trim())) return 0;
      } finally { prompt.close(); }
    }
    const value = bridge(context, record, reset ? ["reset"] : ["forget", id]);
    say({ ...value, detail: reset ? "Key reset. Every phone was unpaired." : value.removed ? "Phone forgotten." : "That phone was already absent." });
    return 0;
  } catch (e) { error(e.message); return e instanceof Usage ? 2 : 1; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await pocketMain(process.argv.slice(2));
}
