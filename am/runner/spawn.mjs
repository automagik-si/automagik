// The member runner's uid switch and per-shell frame. Apache-2.0.
//
// One mode only: a rootless user namespace through newuidmap/newgidmap and util-linux unshare
// (2.39 or later), then setpriv --no-new-privs. No docker and no fallback: when this cannot run,
// the shell is refused.
//
// Each member and Bot gets a stable uid from the runner's subordinate range. The runner keeps
// the mapping in a mode 0600 state file. HOME, XDG folders and TMPDIR belong to that uid and are
// mode 0700. The child enters its own area under the same-path work root after the uid switch.
// Each shell runs in its own systemd scope, with MemoryMax and TasksMax, and in its own pid and
// network namespaces. A refusal exits 125.

import * as nodeFs from "node:fs";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { BOT_ID_RE, MEMBER_RE, Refusal, identityLabel, oneLine, plain } from "./proto.mjs";
import { checkFolderChain, lstatOr } from "./locks.mjs";

export const DEFAULT_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
export const DEFAULT_SAFE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
export const HOME_MODE = 0o700;
export const ROOT_MODE = 0o711;
export const PROVISION_TIMEOUT_MS = 20000;
export const PROVISION_RELS = [".config", ".cache", ".local", ".local/share", ".local/state", ".local/run", "tmp"];
export const TMP_REL = "tmp";
export const BOTS_DIR = ".bots";

/**
 * The fixed script the provisioning user namespace runs as its own root: it makes the member's
 * home, XDG folders, TMPDIR and work area, owned by the member's uid, mode 0700. Paths are
 * arguments, never spliced into the script. Exit 3 to 8 name the failure the runner reports.
 */
/** How the provisioning helper is started inside the member's user namespace. */
const PROVISION_ENTRY =
  `import { provisionCli } from ${JSON.stringify(new URL("./spawn.mjs", import.meta.url).href)};` +
  " provisionCli(process.argv.slice(1));";

/** One provisioning refusal: a message and the exit code the runner maps to HOME_INVALID/BAD_CWD. */
export class ProvisionRefusal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "ProvisionRefusal";
    this.code = code;
  }
}

const provisionFail = (message, code = 1) => {
  throw new ProvisionRefusal(message, code);
};

/**
 * Makes a member's HOME, its XDG folders and TMPDIR, and its work area, owned by the member's uid
 * and mode 0700, working only on folders it opened itself: mkdir, then open with
 * O_NOFOLLOW|O_DIRECTORY, then fchown/fchmod through that handle. A path swapped for a link
 * between create and chmod is refused, and no folder outside the member's own can be changed.
 * With `root` false (a test), ownership is not set; the caller checks it.
 */
export function provisionFolders({
  home,
  area,
  uid,
  gid,
  cwd,
  rels = PROVISION_RELS,
  fs = nodeFs,
  root = process.getuid() === 0,
}) {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  const flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  const open = new Set();
  const close = (fd) => {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    open.delete(fd);
  };
  const fdPath = (fd) => `/proc/self/fd/${fd}`;
  const openDir = (path, label, create) => {
    let created = false;
    if (create) {
      try {
        fs.mkdirSync(path, 0o700);
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") provisionFail(`the folder ${label}: ${plain(error)}`, 9);
      }
    }
    let fd;
    try {
      fd = fs.openSync(path, flags);
    } catch (error) {
      provisionFail(`the folder ${label} is not a real folder (${error?.code ?? "error"})`, 9);
    }
    open.add(fd);
    return { fd, created };
  };
  const inspect = (fd, label) => {
    let info;
    try {
      info = fs.fstatSync(fd);
    } catch (error) {
      provisionFail(`the folder ${label} could not be checked: ${plain(error)}`, 9);
    }
    if (typeof info.isDirectory !== "function" || !info.isDirectory()) {
      provisionFail(`the folder ${label} is not a folder`, 9);
    }
    if ((info.mode & 0o7777) !== 0o700) {
      provisionFail(`the folder ${label} is mode ${(info.mode & 0o7777).toString(8)}, not 700`, 9);
    }
    if (root && (info.uid !== uid || info.gid !== gid)) {
      provisionFail(`the folder ${label} is not the member's`, 9);
    }
  };
  const settle = (fd, label, created) => {
    if (!created) return inspect(fd, label); // an existing folder must already be right
    if (root) {
      try {
        fs.fchownSync(fd, uid, gid);
      } catch (error) {
        provisionFail(`the folder ${label} could not be given to the member: ${plain(error)}`, 9);
      }
    }
    try {
      fs.fchmodSync(fd, 0o700);
    } catch (error) {
      provisionFail(`the folder ${label} could not be mode 0700: ${plain(error)}`, 9);
    }
    inspect(fd, label);
  };
  const walk = (baseFd, baseLabel, rel) => {
    let fd = baseFd;
    let held = null;
    for (const part of rel.split("/").filter(Boolean)) {
      const label = `${baseLabel}/${part}`;
      const next = openDir(`${fdPath(fd)}/${part}`, label, true);
      settle(next.fd, label, next.created);
      if (held !== null) close(held);
      held = next.fd;
      fd = next.fd;
    }
    if (held !== null) close(held);
  };
  try {
    const homeDir = openDir(home, home, true);
    settle(homeDir.fd, home, homeDir.created);
    const homeFd = homeDir.fd;
    const areaDir = openDir(area, area, true);
    settle(areaDir.fd, area, areaDir.created);
    const areaFd = areaDir.fd;
    for (const rel of rels) walk(homeFd, home, rel);
    if (cwd !== area) {
      const prefix = `${area}/`;
      if (!cwd.startsWith(prefix)) provisionFail("the cwd is outside the member's area", 12);
      let fd = areaFd;
      for (const part of cwd.slice(prefix.length).split("/").filter(Boolean)) {
        let next;
        try {
          next = fs.openSync(`${fdPath(fd)}/${part}`, flags);
        } catch (error) {
          if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
            provisionFail("the cwd is a symbolic link or not a real folder", 10);
          }
          provisionFail("the cwd is not a folder", 11);
        }
        open.add(next);
        if (fd !== areaFd) close(fd);
        fd = next;
      }
      if (fd !== areaFd) close(fd);
    }
  } finally {
    for (const fd of [...open]) close(fd);
  }
}

/** The helper's command line: exit 1 (or 9) for a folder problem, 10 to 12 for a cwd problem. */
export function provisionCli(argv) {
  const [home, area, uidText, gidText, cwd, ...rels] = argv;
  try {
    provisionFolders({ home, area, uid: Number(uidText), gid: Number(gidText), cwd, rels });
  } catch (error) {
    process.stderr.write(`${plain(error)}\n`);
    process.exit(typeof error?.code === "number" ? error.code : 1);
  }
}

/** A user namespace for the member's own uid, unshare's newuidmap/newgidmap path. */
export function provisionArgs(host, ids, home, area, cwd) {
  return [
    `--map-users=0:${host.uid}:1`,
    `--map-users=${ids.uid}:${ids.uid}:1`,
    `--map-groups=0:${host.gid}:1`,
    `--map-groups=${ids.gid}:${ids.gid}:1`,
    "--",
    process.execPath,
    "--input-type=module",
    "-e",
    PROVISION_ENTRY,
    home,
    area,
    String(ids.uid),
    String(ids.gid),
    cwd,
    ...PROVISION_RELS,
  ];
}

const asIdentity = (who) => typeof who === "string" ? { kind: "member", name: who } : who;

/** The identity's HOME, XDG homes, TMPDIR and work area. */
export function layoutOf(config, who) {
  const identity = asIdentity(who);
  const user = identity.kind === "bot" ? identity.id : identity.name;
  const parts = identity.kind === "bot" ? [BOTS_DIR, user] : [user];
  const home = join(config.homesRoot, ...parts);
  const area = join(config.workRoot, ...parts);
  return {
    home,
    area,
    user,
    xdg: {
      config: join(home, ".config"),
      cache: join(home, ".cache"),
      data: join(home, ".local/share"),
      state: join(home, ".local/state"),
      runtime: join(home, ".local/run"),
    },
    tmp: join(home, TMP_REL),
  };
}

/** The exact environment the member's child gets, never anything from the runner's own environment. */
export function childEnvironment(layout, requestEnv) {
  const env = { ...requestEnv };
  env.HOME = layout.home;
  env.USER = env.LOGNAME = layout.user;
  env.TMPDIR = layout.tmp;
  env.XDG_CONFIG_HOME = layout.xdg.config;
  env.XDG_CACHE_HOME = layout.xdg.cache;
  env.XDG_DATA_HOME = layout.xdg.data;
  env.XDG_STATE_HOME = layout.xdg.state;
  env.XDG_RUNTIME_DIR = layout.xdg.runtime;
  if (env.PATH === undefined) env.PATH = DEFAULT_CHILD_PATH;
  return env;
}

/**
 * The child enters cwd after the uid switch, in the member's own identity, and checks the resolved
 * directory against the member's work area before it runs anything. A symlink out is refused with
 * exit 125, even if one is swapped in after provisioning.
 */
export const CWD_GUARD = [
  'area=$1; target=$2; shift 2',
  'cd -P -- "$target" || exit 125',
  'case "$(pwd -P)" in "$area"|"$area"/*) ;; *) exit 125 ;; esac',
  'exec "$@"',
].join("\n");

const SWITCH_MARKER = Buffer.from("switched\n");
export const SWITCH_GUARD = [
  'area=$1; target=$2; shift 2',
  'cd -P -- "$target" || exit 125',
  'case "$(pwd -P)" in "$area"|"$area"/*) ;; *) exit 125 ;; esac',
  "printf 'switched\\n' >&3 || exit 125",
  "exec 3>&-",
  'exec "$@"',
].join("\n");

/** The tool paths, resolved once from the runner's own PATH. */
export function resolveTools(host) {
  const fs = host.fs;
  const which = (name) => {
    if (name.includes("/")) return name;
    for (const dir of String(host.env?.PATH ?? "").split(":")) {
      if (dir === "") continue;
      const candidate = join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* the next folder */
      }
    }
    throw new Refusal("TOOL_MISSING", `${name} is not on PATH`);
  };
  const tools = {
    unshare: which("unshare"),
    setpriv: which("setpriv"),
    env: which("env"),
    systemdRun: which("systemd-run"),
    newuidmap: which("newuidmap"),
    newgidmap: which("newgidmap"),
  };
  const run = host.spawnSync ?? nodeSpawnSync;
  const probe = run(tools.unshare, ["--version"], { encoding: "utf8", env: host.env, timeout: 10000 });
  if (probe?.error) throw new Refusal("TOOL_MISSING", `unshare does not run: ${plain(probe.error)}`);
  if (probe?.status !== 0) throw new Refusal("TOOL_MISSING", "unshare --version failed");
  const version = /(\d+)\.(\d+)/.exec(String(probe.stdout ?? "") + String(probe.stderr ?? ""));
  if (version === null || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 39)) {
    throw new Refusal("TOOL_MISSING", `util-linux unshare 2.39 or later is required, got ${version?.[0] ?? "unknown"}`);
  }
  let help;
  try {
    help = run(tools.systemdRun, ["--help"], { encoding: "utf8", env: host.env, timeout: 10000 });
  } catch {
    throw new Refusal("TOOL_MISSING", "systemd-run --help failed");
  }
  if (help?.error || help?.status !== 0) throw new Refusal("TOOL_MISSING", "systemd-run --help failed");
  tools.disableExpand = /\s--expand-environment(?:[=\s]|$)/.test(` ${help.stdout ?? ""} ${help.stderr ?? ""}`);
  return tools;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const poisonedStates = new WeakSet();

function emptyState(config) {
  return { v: 1, uidStart: config.uidStart, uidCount: config.uidCount, gidStart: config.gidStart, members: {}, bots: {} };
}

function syncPath(fs, path) {
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readState(config, host) {
  const fs = host.fs;
  const statePath = config.state;
  checkFolderChain(fs, dirname(statePath), "the state folder");
  let state;
  const existing = lstatOr(fs, statePath);
  if (existing === null) return null;
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} is not a regular file`);
  }
  if (existing.uid !== host.uid) throw new Refusal("STATE_INVALID", `the state file ${statePath} is not the runner's`);
  if ((existing.mode & 0o022) !== 0) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} is writable by group or others`);
  }
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
    state = JSON.parse(text);
  } catch (error) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} is unreadable: ${plain(error)}`);
  }
  if (state?.v !== 1 && state?.v !== 2) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} has an unknown version`);
  }
  if (
    state.uidStart !== config.uidStart ||
    state.gidStart !== config.gidStart ||
    !Number.isInteger(state.uidCount) ||
    state.uidCount < 1 ||
    state.uidCount > config.uidCount ||
    !isRecord(state.members) ||
    (state.v === 1 ? Object.hasOwn(state, "bots") : !isRecord(state.bots))
  ) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} was made for another range`);
  }
  if (state.v === 1) state.bots = {};
  const slots = [...Object.values(state.members), ...Object.values(state.bots)];
  if (
    new Set(slots).size !== slots.length ||
    slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= state.uidCount)
  ) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} has a bad slot`);
  }
  for (const member of Object.keys(state.members)) {
    if (!MEMBER_RE.test(member)) {
      throw new Refusal("STATE_INVALID", `the state file ${statePath} names a bad member`);
    }
  }
  for (const bot of Object.keys(state.bots)) {
    if (!BOT_ID_RE.test(bot)) {
      throw new Refusal("STATE_INVALID", `the state file ${statePath} names a bad Bot id`);
    }
  }
  state.uidCount = config.uidCount;
  try {
    fs.chmodSync(statePath, 0o600);
    syncPath(fs, statePath);
    syncPath(fs, dirname(statePath));
  } catch (error) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath}: ${plain(error)}`);
  }
  return state;
}

/** Loads a synced slot map, or returns an empty map without writing a missing file. */
export function openState(config, host) {
  return readState(config, host) ?? emptyState(config);
}

/** Writes the state file atomically, mode 0600, synced before its slots can be used. */
export function writeState(config, host, state) {
  const fs = host.fs;
  const tmp = `${config.state}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const { uidStart, uidCount, gidStart, members, bots } = state;
  const v = Object.keys(bots).length > 0 ? 2 : 1;
  const record = { v, uidStart, uidCount, gidStart, members };
  if (v === 2) record.bots = bots;
  let visible = false;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      const buf = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      let offset = 0;
      while (offset < buf.length) {
        const written = fs.writeSync(fd, buf, offset, buf.length - offset);
        if (written === 0) throw new Error("short state write");
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, config.state);
    visible = true;
    syncPath(fs, dirname(config.state));
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* not there */
    }
    const refusal = new Refusal("STATE_INVALID", `the state file ${config.state}: ${plain(error)}`);
    if (visible) refusal.visible = true;
    throw refusal;
  }
  return v;
}

/** A new member or Bot gets the next slot in the shared range. Slots are never reused. */
export function idsFor(config, host, state, who) {
  const identity = asIdentity(who);
  const bot = identity.kind === "bot";
  const key = bot ? "bots" : "members";
  const name = bot ? identity.id : identity.name;
  const slots = state[key];
  if (Object.hasOwn(slots, name)) {
    const slot = slots[name];
    return { uid: config.uidStart + slot, gid: config.gidStart + slot };
  }
  if (poisonedStates.has(state)) {
    throw new Refusal("STATE_INVALID", "the state file changed on disk without its sync; restart the runner");
  }
  const used = [...Object.values(state.members), ...Object.values(state.bots)];
  const next = used.length === 0 ? 0 : Math.max(...used) + 1;
  if (next >= config.uidCount) {
    throw new Refusal("RANGE_FULL", `no free uid left in the range for ${identityLabel(identity)}`);
  }
  // The uid is used only after its assignment is durable. A failed write leaves the state in
  // memory untouched and refuses the request; it never hands out a uid that was not recorded.
  const candidate = { ...state, [key]: { ...slots, [name]: next } };
  try {
    state.v = writeState(config, host, candidate);
  } catch (error) {
    if (error.visible) poisonedStates.add(state);
    throw error;
  }
  state[key] = candidate[key];
  return { uid: config.uidStart + next, gid: config.gidStart + next };
}

/** Resolves a config path through the real path of its nearest existing ancestor. */
export function resolveConfigPath(fs, path) {
  const tail = [];
  let at = path;
  for (;;) {
    try {
      return join(fs.realpathSync(at), ...tail.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Refusal("CONFIG_INVALID", `the folder of ${path}: ${plain(error)}`);
      }
    }
    tail.push(basename(at));
    const parent = dirname(at);
    if (parent === at) throw new Refusal("CONFIG_INVALID", `the path ${path} cannot be resolved`);
    at = parent;
  }
}

const inside = (path, root) => path === root || path.startsWith(root + sep);

export function checkRootOverlap(config) {
  const homes = resolvePath(config.homesRoot);
  const work = resolvePath(config.workRoot);
  if (homes === work || homes === sep || work === sep || homes.startsWith(work + sep) || work.startsWith(homes + sep)) {
    throw new Refusal("ROOT_INVALID", "homesRoot and workRoot must be disjoint");
  }
  // The socket folder keeps its own mode (0750); a Bot root is made 0711.
  if (typeof config.socket === "string") {
    const folder = dirname(resolvePath(config.socket));
    if ([join(homes, BOTS_DIR), join(work, BOTS_DIR)].some((root) => inside(folder, root))) {
      throw new Refusal("ROOT_INVALID", "the socket folder must not be in a Bot root");
    }
  }
}

/**
 * The four allocation roots are four folders: a bind mount can show one folder at two disjoint
 * paths, so they are compared by device and inode too.
 */
function checkRootIdentities(fs, roots, { strict }) {
  const seen = new Map();
  for (const [label, path] of roots) {
    let info;
    try {
      info = fs.lstatSync(path, { bigint: true });
    } catch (error) {
      // Before the roots are made, a root the runner cannot read yet is checked after its chmod.
      if (!strict || error?.code === "ENOENT") continue;
      throw new Refusal("ROOT_INVALID", `${label} ${path}: ${plain(error)}`);
    }
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) {
      throw new Refusal("ROOT_INVALID", `${label} ${path} is the same folder as the ${seen.get(key)}`);
    }
    seen.set(key, label);
  }
}

/** The homes and work roots: the runner's, traversable by members, never writable by them. */
export function ensureRoots(config, host) {
  const roots = [
    ["homes root", config.homesRoot],
    ["work root", config.workRoot],
    ["Bot homes root", join(config.homesRoot, BOTS_DIR), true],
    ["Bot work root", join(config.workRoot, BOTS_DIR), true],
  ];
  checkRootIdentities(host.fs, roots, { strict: false });
  for (const [label, path, botRoot] of roots) {
    checkFolderChain(host.fs, dirname(path), `the ${label} chain`);
    let info = lstatOr(host.fs, path);
    if (info === null) {
      try {
        host.fs.mkdirSync(path, { mode: ROOT_MODE });
        info = lstatOr(host.fs, path);
      } catch (error) {
        throw new Refusal("ROOT_INVALID", `${label} ${path}: ${plain(error)}`);
      }
    }
    if (info === null || info.isSymbolicLink() || !info.isDirectory()) {
      throw new Refusal("ROOT_INVALID", `${label} ${path} is not a real folder`);
    }
    if (info.uid !== host.uid) throw new Refusal("ROOT_INVALID", `${label} ${path} is not the runner's`);
    if (botRoot && (info.mode & 0o022) !== 0) {
      throw new Refusal("ROOT_INVALID", `${label} ${path} is writable by group or others`);
    }
    checkFolderChain(host.fs, path, `the ${label}`);
    try {
      host.fs.chmodSync(path, ROOT_MODE);
    } catch (error) {
      throw new Refusal("ROOT_INVALID", `${label} ${path}: ${plain(error)}`);
    }
  }
  checkRootIdentities(host.fs, roots, { strict: true });
}

/**
 * On start, each member and Bot folder must have a recorded slot and belong to its recorded uid.
 */
export function checkHomes(config, host, state) {
  const fs = host.fs;
  for (const [label, root, kind, pattern, slots] of [
    ["home", config.homesRoot, "member", MEMBER_RE, state.members],
    ["work area", config.workRoot, "member", MEMBER_RE, state.members],
    ["home", join(config.homesRoot, BOTS_DIR), "bot", BOT_ID_RE, state.bots],
    ["work area", join(config.workRoot, BOTS_DIR), "bot", BOT_ID_RE, state.bots],
  ]) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      throw new Refusal("STATE_INVALID", `the ${label} root ${root}: ${plain(error)}`);
    }
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      const path = join(root, entry);
      const info = lstatOr(fs, path);
      if (info === null || info.isSymbolicLink() || !info.isDirectory()) {
        throw new Refusal("STATE_INVALID", `the ${label} ${path} is not a real folder`);
      }
      if (!Object.hasOwn(slots, entry)) {
        throw new Refusal("STATE_INVALID", `${kind} ${entry} has a ${label} but no recorded uid`);
      }
      const expected = config.uidStart + slots[entry];
      if (info.uid !== expected) {
        const owner = kind === "bot" ? `bot ${entry}'s ${label}` : `the ${label} ${path}`;
        throw new Refusal(
          "STATE_INVALID",
          `${owner} is owned by uid ${info.uid}, not its recorded uid ${expected}`,
        );
      }
    }
  }
}

/** A member folder after provisioning: a real folder, the member's, exactly 0700. */
export function checkHome(fs, path, uid, label = "home") {
  const info = lstatOr(fs, path);
  if (info === null) throw new Refusal("HOME_INVALID", `the ${label} ${path} is missing`);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Refusal("HOME_INVALID", `the ${label} ${path} is not a real folder`);
  }
  if (info.uid !== uid) throw new Refusal("HOME_INVALID", `the ${label} ${path} is not the member's`);
  if ((info.mode & 0o7777) !== HOME_MODE) {
    throw new Refusal("HOME_INVALID", `the ${label} ${path} is mode ${(info.mode & 0o7777).toString(8)}, not 700`);
  }
}

/** cwd must be the identity's own area or below it. */
export function checkCwd(config, who, cwd) {
  const identity = asIdentity(who);
  const { area } = layoutOf(config, identity);
  const resolved = resolvePath(cwd);
  if (resolved !== area && !resolved.startsWith(area + sep)) {
    throw new Refusal("BAD_CWD", `cwd is outside ${identityLabel(identity)}'s area`);
  }
  return resolved;
}

/** The provisioning refusal message for the script's own exit codes. */
function provisionFailure(result) {
  const said = oneLine(String(result?.stderr ?? "").trim().split("\n")[0]);
  const why = {
    9: "a member folder is not the member's 0700 folder",
    10: "the cwd is a symbolic link",
    11: "the cwd is not a folder",
    12: "the cwd does not resolve inside the member's area",
  };
  const status = result?.status;
  const code = status >= 10 && status <= 12 ? "BAD_CWD" : "HOME_INVALID";
  if (said !== "") return { code, message: said };
  return { code, message: why[status] ?? `the member's folders could not be prepared (exit ${status ?? "?"})` };
}

/**
 * The runner: tools, state, provisioning and one shell per request. It holds no request state of
 * its own; main calls idsFor then start for each connection.
 */
export function createRunner(config, host) {
  checkRootOverlap(config);
  checkRootOverlap({
    homesRoot: resolveConfigPath(host.fs, config.homesRoot),
    workRoot: resolveConfigPath(host.fs, config.workRoot),
  });
  const inRange = (id) => id >= config.uidStart && id < config.uidStart + config.uidCount;
  const inGidRange = (gid) => gid >= config.gidStart && gid < config.gidStart + config.gidCount;
  if (inRange(host.uid)) throw new Refusal("RANGE_INVALID", "the runner's own uid is inside the member range");
  if (inRange(config.dshUid)) throw new Refusal("RANGE_INVALID", "DSH's uid is inside the member range");
  if (inGidRange(host.gid)) throw new Refusal("RANGE_INVALID", "the runner's own gid is inside the member range");
  const tools = resolveTools(host);
  const existing = readState(config, host);
  const state = existing ?? emptyState(config);
  ensureRoots(config, host);
  checkHomes(config, host, state);
  if (existing === null) writeState(config, host, state);
  const run = host.spawnSync ?? nodeSpawnSync;
  const startSpawn = host.spawn ?? nodeSpawn;

  /** Makes and checks the identity's home, XDG folders, TMPDIR and work area. */
  const provision = (who, ids, cwd) => {
    const layout = layoutOf(config, who);
    const result = run(tools.unshare, provisionArgs(host, ids, layout.home, layout.area, cwd), {
      encoding: "utf8",
      env: { PATH: DEFAULT_SAFE_PATH, LC_ALL: "C" },
      timeout: PROVISION_TIMEOUT_MS,
    });
    if (result?.error) throw new Refusal("HOME_INVALID", `the member's folders: ${plain(result.error)}`);
    if (result?.status !== 0) {
      const failure = provisionFailure(result);
      throw new Refusal(failure.code, failure.message);
    }
    checkHome(host.fs, layout.home, ids.uid);
    checkHome(host.fs, layout.area, ids.uid, "work area");
    return layout;
  };

  /**
   * Starts one shell. `io` sends the frames: start, out, err, exit, or fail. Returns { stop } so
   * a closed connection ends the run. The child's exit code passes through in the exit frame.
   */
  const start = (request, ids, layout, runId, io) => {
    const { identity } = request;
    const cwd = resolvePath(request.cwd);
    const env = childEnvironment(layout, request.env);
    const assignments = Object.keys(env)
      .sort()
      .map((key) => `${key}=${env[key]}`);
    const inner = [
      tools.setpriv,
      "--no-new-privs",
      "--",
      tools.env,
      "-i",
      ...assignments,
      "/bin/sh",
      "-c",
      SWITCH_GUARD,
      "am-enter",
      layout.area,
      cwd,
      ...request.argv,
    ];
    const unshare = [
      `--map-users=${ids.uid}:${ids.uid}:1`,
      `--map-groups=${ids.gid}:${ids.gid}:1`,
      "--net",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount-proc",
      "--setgid",
      String(ids.gid),
      "--setuid",
      String(ids.uid),
      "--",
      ...inner,
    ];
    const unit = `am-${identity.kind}-${runId}`;
    const scoped = [
      tools.systemdRun,
      "--user",
      "--scope",
      ...(tools.disableExpand ? ["--expand-environment=no"] : []),
      "--quiet",
      `--unit=${unit}`,
      "-p",
      `MemoryMax=${config.limits.memoryMax}`,
      "-p",
      `TasksMax=${config.limits.tasksMax}`,
      "--",
      tools.unshare,
      ...unshare,
    ];
    let child;
    try {
      child = startSpawn(scoped[0], scoped.slice(1), {
        env: host.env,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      io.fail("SPAWN_FAILED", plain(error).slice(0, 200));
      return { stop: () => {} };
    }
    const startedAt = (host.now ?? Date.now)();
    let done = false;
    let timedOut = false;
    let truncated = false;
    let switched = false;
    let invalidMarker = false;
    let markerBytes = 0;
    let firstStderr;
    const queued = [];
    let outBytes = 0;
    let timer;
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const finish = (send) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      send();
    };
    child.once("spawn", () => {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
    });
    child.once("error", (error) => {
      finish(() => io.fail("SPAWN_FAILED", plain(error).slice(0, 200)));
    });
    const output = (send, chunk) => {
      if (done || truncated || invalidMarker) return;
      if (outBytes + chunk.length > config.maxOutputBytes) {
        truncated = true;
        stop();
        return;
      }
      outBytes += chunk.length;
      if (switched) send(chunk);
      else queued.push([send, chunk]);
    };
    child.stdout?.on("data", (chunk) => output(io.out, chunk));
    child.stderr?.on("data", (chunk) => {
      if (!switched && firstStderr === undefined) {
        firstStderr = chunk.subarray(0, 200).toString("utf8").split(/\r?\n/, 1)[0];
      }
      output(io.err, chunk);
    });
    const sendStart = () => {
      switched = true;
      io.start({ [identity.kind]: layout.user, uid: ids.uid, gid: ids.gid, mode: "subuid", run: runId, unit });
      for (const [send, data] of queued) send(data);
      queued.length = 0;
    };
    child.stdio?.[3]?.on("data", (chunk) => {
      if (done || invalidMarker) return;
      const length = Math.min(chunk.length, SWITCH_MARKER.length - markerBytes);
      if (!chunk.subarray(0, length).equals(SWITCH_MARKER.subarray(markerBytes, markerBytes + length))) {
        invalidMarker = true;
        stop();
        return;
      }
      markerBytes += length;
      if (!switched && !timedOut && markerBytes === SWITCH_MARKER.length) sendStart();
      if (chunk.length > length) {
        invalidMarker = true;
        stop();
      }
    });
    child.on("close", (code, signal) => {
      finish(() => {
        // All fd 3 data has arrived by close, including any marker pending at the deadline.
        if (markerBytes === SWITCH_MARKER.length) {
          if (!switched) sendStart();
          if (invalidMarker) {
            io.fail("SPAWN_FAILED", "the command wrote after the switch marker");
            return;
          }
          io.exit({ code, signal, timedOut, truncated, ms: (host.now ?? Date.now)() - startedAt });
          return;
        }
        if (!timedOut && !invalidMarker && /^(Failed to|System has not been booted with systemd)/.test(firstStderr ?? "")) {
          io.fail("SCOPE_FAILED", "the systemd scope could not be made");
          return;
        }
        const detail = firstStderr ? `: ${oneLine(firstStderr)}` : "";
        io.fail("SPAWN_FAILED", `the command did not start under its own uid${detail}`.slice(0, 200));
      });
    });
    return { stop, get killed() { return done; } };
  };

  return { tools, state, idsFor: (who) => idsFor(config, host, state, who), provision, start };
}
