// The member runner's uid switch and per-shell frame. Apache-2.0.
//
// One mode only: a rootless user namespace through newuidmap/newgidmap and util-linux unshare
// (2.39 or later), then setpriv --no-new-privs. No docker and no fallback: when this cannot run,
// the shell is refused.
//
// Every member gets a stable uid from the runner's subordinate range, kept in a runner-owned state
// file, mode 0600. The member's HOME and its XDG folders and TMPDIR are its own folders, owned by
// its uid, mode 0700; a file planted in one member's area is not in another member's environment.
// The child enters cwd after the uid switch (env -C runs as the member), inside the member's own
// area under the same-path work root. Each shell runs in its own systemd scope, with MemoryMax and
// TasksMax, and in its own pid and network namespaces. A refusal exits 125.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { Refusal, plain } from "./proto.mjs";
import { checkFolderChain, lstatOr } from "./locks.mjs";

export const DEFAULT_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
export const DEFAULT_SAFE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
export const HOME_MODE = 0o700;
export const ROOT_MODE = 0o711;
export const PROVISION_TIMEOUT_MS = 20000;
export const PROVISION_RELS = [".config", ".cache", ".local", ".local/share", ".local/state", ".local/run", "tmp"];
export const TMP_REL = "tmp";

/**
 * The fixed script the provisioning user namespace runs as its own root: it makes the member's
 * home, XDG folders, TMPDIR and work area, owned by the member's uid, mode 0700. Paths are
 * arguments, never spliced into the script. Exit 3 to 8 name the failure the runner reports.
 */
const PROVISION_SCRIPT = [
  "set -eu",
  "umask 077",
  'home=$1; area=$2; uid=$3; gid=$4; shift 4',
  '[ ! -L "$home" ] || { echo "the home is a symbolic link"; exit 3; }',
  '[ ! -e "$home" ] || [ -d "$home" ] || { echo "the home is not a folder"; exit 4; }',
  'mkdir -p -- "$home"',
  'for rel in "$@"; do',
  '  p="$home/$rel"',
  '  [ ! -L "$p" ] || { echo "a home folder is a symbolic link"; exit 5; }',
  '  [ ! -e "$p" ] || [ -d "$p" ] || { echo "a home folder is not a folder"; exit 6; }',
  '  mkdir -p -- "$p"',
  'done',
  '[ ! -L "$area" ] || { echo "the work area is a symbolic link"; exit 7; }',
  '[ ! -e "$area" ] || [ -d "$area" ] || { echo "the work area is not a folder"; exit 8; }',
  'mkdir -p -- "$area"',
  'chown "$uid:$gid" -- "$home" "$area"',
  'for rel in "$@"; do chown "$uid:$gid" -- "$home/$rel"; done',
  'chmod 0700 -- "$home" "$area"',
  'for rel in "$@"; do chmod 0700 -- "$home/$rel"; done',
].join("\n");

/** A user namespace for the member's own uid, unshare's newuidmap/newgidmap path. */
export function provisionArgs(host, ids, home, area) {
  return [
    `--map-users=0:${host.uid}:1`,
    `--map-users=${ids.uid}:${ids.uid}:1`,
    `--map-groups=0:${host.gid}:1`,
    `--map-groups=${ids.gid}:${ids.gid}:1`,
    "--",
    "/bin/sh",
    "-c",
    PROVISION_SCRIPT,
    "am-provision",
    home,
    area,
    String(ids.uid),
    String(ids.gid),
    ...PROVISION_RELS,
  ];
}

/** The path the member's shell gets: HOME, the five XDG homes and TMPDIR, all under HOME. */
export function layoutOf(config, member) {
  const home = join(config.homesRoot, member);
  const area = join(config.workRoot, member);
  return {
    home,
    area,
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

/** Which environment name holds the member, for the layout above. */
function withUser(layout, member) {
  return { ...layout, user: member };
}

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
  return tools;
}

/** Reads or makes the runner's member-to-slot state, mode 0600, and checks its range. */
export function openState(config, host) {
  const fs = host.fs;
  const statePath = config.state;
  checkFolderChain(fs, dirname(statePath), "the state folder");
  let state;
  const existing = lstatOr(fs, statePath);
  if (existing === null) {
    state = {
      v: 1,
      uidStart: config.uidStart,
      uidCount: config.uidCount,
      gidStart: config.gidStart,
      members: {},
    };
    writeState(config, host, state);
    return state;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} is not a regular file`);
  }
  if (existing.uid !== host.uid) throw new Refusal("STATE_INVALID", `the state file ${statePath} is not the runner's`);
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
    state = JSON.parse(text);
  } catch (error) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} is unreadable: ${plain(error)}`);
  }
  if (
    state?.v !== 1 ||
    state.uidStart !== config.uidStart ||
    state.gidStart !== config.gidStart ||
    !Number.isInteger(state.uidCount) ||
    state.uidCount > config.uidCount ||
    state.members === null ||
    typeof state.members !== "object" ||
    Array.isArray(state.members)
  ) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} was made for another range`);
  }
  const slots = Object.values(state.members);
  if (
    new Set(slots).size !== slots.length ||
    slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= config.uidCount)
  ) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath} has a bad slot`);
  }
  for (const member of Object.keys(state.members)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member)) {
      throw new Refusal("STATE_INVALID", `the state file ${statePath} names a bad member`);
    }
  }
  state.uidCount = config.uidCount;
  try {
    fs.chmodSync(statePath, 0o600);
  } catch (error) {
    throw new Refusal("STATE_INVALID", `the state file ${statePath}: ${plain(error)}`);
  }
  return state;
}

/** Writes the state file atomically, mode 0600, synced before the member runs anything. */
export function writeState(config, host, state) {
  const fs = host.fs;
  const tmp = `${config.state}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, config.state);
    fs.chmodSync(config.state, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* not there */
    }
    throw new Refusal("STATE_INVALID", `the state file ${config.state}: ${plain(error)}`);
  }
}

/** The next uid for a member: a new member gets the next slot, and slots are never reused. */
export function idsFor(config, host, state, member) {
  const slot = state.members[member];
  if (slot !== undefined) return { uid: config.uidStart + slot, gid: config.gidStart + slot };
  const used = Object.values(state.members);
  const next = used.length === 0 ? 0 : Math.max(...used) + 1;
  if (next >= config.uidCount) {
    throw new Refusal("RANGE_FULL", `no free uid left in the range for member ${member}`);
  }
  state.members[member] = next;
  writeState(config, host, state);
  return { uid: config.uidStart + next, gid: config.gidStart + next };
}

/** The homes and work roots: the runner's, traversable by members, never writable by them. */
export function ensureRoots(config, host) {
  const roots = [
    ["homes root", config.homesRoot],
    ["work root", config.workRoot],
  ];
  for (const [label, path] of roots) {
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
    checkFolderChain(host.fs, path, `the ${label}`);
    try {
      host.fs.chmodSync(path, ROOT_MODE);
    } catch (error) {
      throw new Refusal("ROOT_INVALID", `${label} ${path}: ${plain(error)}`);
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

/** cwd must be the member's own area or below it: the work root is the members' area only. */
export function checkCwd(config, member, cwd) {
  const area = join(config.workRoot, member);
  const resolved = resolvePath(cwd);
  if (resolved !== area && !resolved.startsWith(area + sep)) {
    throw new Refusal("BAD_CWD", `cwd is outside member ${member}'s area`);
  }
  return resolved;
}

/** The provisioning refusal message for the script's own exit codes. */
function provisionFailure(result) {
  const said = String(result?.stderr ?? "").trim().split("\n")[0];
  if (said !== "") return said;
  const why = {
    3: "the home is a symbolic link",
    4: "the home is not a folder",
    5: "a home folder is a symbolic link",
    6: "a home folder is not a folder",
    7: "the work area is a symbolic link",
    8: "the work area is not a folder",
  };
  return why[result?.status] ?? `the member's folders could not be prepared (exit ${result?.status ?? "?"})`;
}

/**
 * The runner: tools, state, provisioning and one shell per request. It holds no request state of
 * its own; main calls idsFor then start for each connection.
 */
export function createRunner(config, host) {
  const inRange = (id) => id >= config.uidStart && id < config.uidStart + config.uidCount;
  const inGidRange = (gid) => gid >= config.gidStart && gid < config.gidStart + config.gidCount;
  if (inRange(host.uid)) throw new Refusal("RANGE_INVALID", "the runner's own uid is inside the member range");
  if (inRange(config.dshUid)) throw new Refusal("RANGE_INVALID", "DSH's uid is inside the member range");
  if (inGidRange(host.gid)) throw new Refusal("RANGE_INVALID", "the runner's own gid is inside the member range");
  const tools = resolveTools(host);
  const state = openState(config, host);
  ensureRoots(config, host);
  const run = host.spawnSync ?? nodeSpawnSync;
  const startSpawn = host.spawn ?? nodeSpawn;

  const idsForMember = (member) => idsFor(config, host, state, member);

  /** Makes and checks the member's home, XDG folders, TMPDIR and work area. */
  const provision = (member, ids) => {
    const layout = withUser(layoutOf(config, member), member);
    const result = run(tools.unshare, provisionArgs(host, ids, layout.home, layout.area), {
      encoding: "utf8",
      env: { PATH: DEFAULT_SAFE_PATH, LC_ALL: "C" },
      timeout: PROVISION_TIMEOUT_MS,
    });
    if (result?.error) throw new Refusal("HOME_INVALID", `the member's folders: ${plain(result.error)}`);
    if (result?.status !== 0) throw new Refusal("HOME_INVALID", provisionFailure(result));
    checkHome(host.fs, layout.home, ids.uid);
    checkHome(host.fs, layout.area, ids.uid, "work area");
    return layout;
  };

  /**
   * Starts one shell. `io` sends the frames: start, out, err, exit, or fail. Returns { stop } so
   * a closed connection ends the run. The child's exit code passes through in the exit frame.
   */
  const start = (request, ids, layout, runId, io) => {
    const cwd = resolvePath(request.cwd);
    const env = childEnvironment(layout, request.env);
    const assignments = Object.keys(env)
      .sort()
      .map((key) => `${key}=${env[key]}`);
    const inner = [tools.setpriv, "--no-new-privs", "--", tools.env, "-i", "-C", cwd, ...assignments, ...request.argv];
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
    const unit = `am-member-${runId}`;
    const scoped = [
      tools.systemdRun,
      "--user",
      "--scope",
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
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      io.fail("SPAWN_FAILED", plain(error));
      return { stop: () => {} };
    }
    const startedAt = (host.now ?? Date.now)();
    let done = false;
    let timedOut = false;
    let truncated = false;
    let scopeFailed = false;
    let firstStderr = true;
    let outBytes = 0;
    let timer;
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const finish = (fail, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fail !== null) io.fail("SCOPE_FAILED", fail);
      else io.exit({ ...result, ms: (host.now ?? Date.now)() - startedAt });
    };
    child.once("spawn", () => {
      io.start({ member: request.member, uid: ids.uid, gid: ids.gid, mode: "subuid", run: runId, unit });
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
    });
    child.once("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      io.fail("SPAWN_FAILED", plain(error));
    });
    child.stdout?.on("data", (chunk) => {
      if (truncated) return;
      firstStderr = false;
      if (outBytes + chunk.length > config.maxOutputBytes) {
        truncated = true;
        stop();
        return;
      }
      outBytes += chunk.length;
      io.out(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (scopeFailed) return;
      if (firstStderr) {
        firstStderr = false;
        if (/^(Failed to|System has not been booted with systemd)/.test(chunk.toString("utf8"))) {
          scopeFailed = true;
          stop();
          return;
        }
      }
      io.err(chunk);
    });
    child.on("close", (code, signal) => {
      if (done) return;
      if (scopeFailed) return finish("the systemd scope could not be made");
      finish(null, { code, signal, timedOut, truncated });
    });
    return { stop, get killed() { return done; } };
  };

  return { tools, state, idsFor: idsForMember, provision, start };
}
