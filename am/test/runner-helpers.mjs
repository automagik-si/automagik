// Shared fixtures for the member-runner tests: temp bases, fake tools on a temp PATH, account
// texts, a test host and small clients for the socket protocol. Nothing here touches a real
// account, a setuid helper or systemd; the uid switch and the scope are shell scripts on PATH.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Whether `path` and every folder above it is a real folder no group or other can write. */
export function chainSafe(path) {
  let at = path;
  for (;;) {
    let info;
    try {
      info = lstatSync(at);
    } catch {
      return false;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) return false;
    const parent = at === "/" ? "/" : at.slice(0, at.lastIndexOf("/")) || "/";
    if (parent === at) return true;
    at = parent;
  }
}

/**
 * A writable temp base whose chain is not writable by group or others. The runner's lock refuses
 * a world-writable chain such as a stock /tmp, so the tests take a candidate that is safe here:
 * the CI temp folder, the home folder or the platform temp folder.
 */
export function base(t) {
  const candidates = [process.env.RUNNER_TEMP, process.env.XDG_RUNTIME_DIR, homedir(), osTmpdir()];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    let root;
    try {
      root = realpathSync(mkdtempSync(join(candidate, ".am-runner-test-")));
    } catch {
      continue;
    }
    if (chainSafe(root)) {
      t.after(() => rmSync(root, { recursive: true, force: true }));
      return root;
    }
    rmSync(root, { recursive: true, force: true });
  }
  throw new Error("no writable temp base with a chain the runner's socket lock accepts");
}

/** Account texts shaped like /etc/passwd, /etc/group and /etc/shadow. */
export function accounts({
  runnerUid = 1000,
  runnerGid = 1000,
  dshUid = 2000,
  dshName = "dsh",
  dshShell = "/usr/sbin/nologin",
  groupName = "dshsock",
  groupGid = 1000,
  groupMembers = dshName,
  shadow = `!`,
  extraGroups = [],
} = {}) {
  const passwd = [
    `root:x:0:0:root:/root:/bin/bash`,
    `runner:x:${runnerUid}:${runnerGid}:runner:/home/runner:/usr/sbin/nologin`,
    `${dshName}:x:${dshUid}:2000:DSH:/nonexistent:${dshShell}`,
  ].join("\n");
  const groups = [
    `root:x:0:`,
    `runner:x:${runnerGid}:`,
    `${groupName}:x:${groupGid}:${groupMembers}`,
    ...extraGroups,
  ].join("\n");
  return {
    passwd,
    group: groups,
    shadow: shadow === null ? null : [`root:*:19000:0:99999:7:::`, `${dshName}:${shadow}:19000:0:99999:7:::`].join("\n"),
  };
}

/** The member uid and gid the tests inject: never the test process's own uid. */
export const MEMBER_UID = 9001;
export const MEMBER_GID = 9001;

const FAKE_UNSHARE = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "unshare from util-linux 2.39.3"
  exit 0
fi
printf '%s\\n' "===" "$@" >> "$(dirname "$0")/unshare.args"
DIR=$(dirname "$0")
PATH="$DIR:$PATH"
export PATH
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`;

const FAKE_SETPRIV = `#!/bin/sh
printf '%s\\n' "===" "$@" >> "$(dirname "$0")/setpriv.args"
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`;

const FAKE_SYSTEMD_RUN = `#!/bin/sh
printf '%s\\n' "===" "$@" >> "$(dirname "$0")/systemd-run.args"
if [ -e "$(dirname "$0")/scope-fails" ]; then
  echo "Failed to start transient scope unit: no user manager" >&2
  exit 1
fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`;

/**
 * A temp PATH with fakes for unshare, setpriv, systemd-run, newuidmap and newgidmap. The fakes
 * strip their own options up to `--` and run the rest exactly as the runner built it.
 */
export function fakeBin(t) {
  const dir = join(base(t), "bin");
  mkdirSync(dir, { recursive: true });
  const write = (name, text) => {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  };
  write("unshare", FAKE_UNSHARE);
  write("setpriv", FAKE_SETPRIV);
  write("systemd-run", FAKE_SYSTEMD_RUN);
  write("newuidmap", "#!/bin/sh\nexit 0\n");
  write("newgidmap", "#!/bin/sh\nexit 0\n");
  return {
    dir,
    failScope: () => writeFileSync(join(dir, "scope-fails"), ""),
    calls: (name) => {
      let text;
      try {
        text = fs.readFileSync(join(dir, `${name}.args`), "utf8");
      } catch {
        return [];
      }
      return text
        .split("===\n")
        .map((block) => block.trim().split("\n").filter((line) => line !== ""))
        .filter((block) => block.length > 0);
    },
  };
}

/** The environment PATH holding the fakes first, then the real node and tools. */
export function fakePath(bin) {
  const nodeDir = dirname(process.execPath);
  return `${bin.dir}:${nodeDir}:/usr/local/bin:/usr/bin:/bin`;
}

/**
 * A host for the tests. The runner and DSH ids are fake (the tests are one uid); the runner's own
 * paths report the runner uid while the member's paths report the real uid, so provisioning,
 * ownership checks and the state file all behave as on a real host without setuid.
 */
export function testHost({
  root,
  bin,
  accounts: accountText,
  uid = 65534,
  gid = 65534,
  log = () => {},
  memberUids = {},
}) {
  const runnerPaths = new Set([join(root, "homes"), join(root, "work"), join(root, "state.json")]);
  const memberUidOf = (path) => {
    for (const [member, memberUid] of Object.entries(memberUids)) {
      for (const area of [join(root, "homes"), join(root, "work")]) {
        const under = join(area, member);
        if (path === under || path.startsWith(`${under}/`)) return memberUid;
      }
    }
    return null;
  };
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (path, options) => {
    const info = lstatSync(path, options);
    const wanted = memberUidOf(path) ?? (runnerPaths.has(path) ? uid : null);
    if (wanted === null) return info;
    const copy = Object.create(info);
    Object.defineProperty(copy, "uid", { value: options?.bigint ? BigInt(wanted) : wanted, enumerable: true });
    return copy;
  };
  return {
    uid,
    gid,
    platform: "linux",
    fs: fsApi,
    spawn,
    spawnSync,
    now: () => Date.now(),
    env: { PATH: fakePath(bin), HOME: root, LANG: "C.UTF-8" },
    log,
    accounts: accountText,
  };
}

/** The config the runner tests serve from; every path is inside `root`. */
export function testConfig(
  root,
  {
    dshUid = 2000,
    uidStart = MEMBER_UID,
    uidCount = 8,
    gidStart = MEMBER_GID,
    gidCount = 8,
    ...extra
  } = {},
) {
  return {
    socket: join(root, "sock", "runner.sock"),
    proofs: join(root, "proofs"),
    group: "dshsock",
    dshUid,
    workRoot: join(root, "work"),
    homesRoot: join(root, "homes"),
    state: join(root, "state.json"),
    uidStart,
    uidCount,
    gidStart,
    gidCount,
    limits: { memoryMax: "512M", tasksMax: 128 },
    maxTimeoutMs: 60000,
    maxOutputBytes: 1024 * 1024,
    maxConcurrent: 4,
    ...extra,
  };
}

/** Makes the socket folder, proofs, homes and work roots the tests serve from. */
export function prepareDirs(
  config,
  { socketMode = 0o750, proofMode = 0o1730, groupGid = process.getgid(), socketFolder = true } = {},
) {
  if (socketFolder) {
    mkdirSync(join(config.socket, ".."), { recursive: true, mode: socketMode });
    chmodSync(join(config.socket, ".."), socketMode);
  }
  mkdirSync(config.proofs, { recursive: true, mode: proofMode });
  chmodSync(config.proofs, proofMode);
  for (const path of [config.homesRoot, config.workRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o711 });
    chmodSync(path, 0o711);
  }
  if (groupGid !== process.getgid()) {
    const { chownSync } = fs;
    if (socketFolder) chownSync(join(config.socket, ".."), process.getuid(), groupGid);
    chownSync(config.proofs, process.getuid(), groupGid);
  }
}

/** A client that skips the proof (the server is built with a proof that says yes) and sends one
 * request line, collecting the reply frames until the runner ends the connection. */
export function rawRequest(socket, request, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let buffer = "";
    const frames = [];
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`rawRequest: no reply from ${socket}`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      const exit = frames.find((frame) => frame.t === "exit") ?? null;
      const error = frames.find((frame) => frame.t === "error") ?? null;
      resolve({ frames, exit, error, output: outputOf(frames) });
    };
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${typeof request === "string" ? request : JSON.stringify(request)}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line !== "") frames.push(JSON.parse(line));
        newline = buffer.indexOf("\n");
      }
    });
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.on("close", finish);
  });
}

/** The stdout and stderr of a run, decoded from its frames. */
export function outputOf(frames) {
  const read = (kind) => Buffer.concat(frames.filter((f) => f.t === kind).map((f) => Buffer.from(f.d, "base64"))).toString("utf8");
  return { out: read("out"), err: read("err") };
}

/** The exit a protocol client shows: an error frame is 125, a timeout 124, else the child's code. */
export function clientExit(result) {
  if (result.error !== null) return 125;
  if (result.exit === null) return 125;
  if (result.exit.timedOut) return 124;
  if (result.exit.code !== null && result.exit.code !== undefined) return result.exit.code;
  return 128 + (result.exit.signal === "SIGKILL" ? 9 : 0);
}

/** One proof attempt over the socket. */
export function proofAttempt(socket, proofs, { attack = "none", ttlMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let buffer = "";
    let name = null;
    let stage = "name";
    let lateTimer;
    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ verdict: "timed out", name });
    }, ttlMs + 3000);
    const finish = (verdict) => {
      clearTimeout(timer);
      clearTimeout(lateTimer);
      conn.end();
      resolve({ verdict, name });
    };
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (stage === "name") {
          stage = "answer";
          name = line.trim();
          if (!name.startsWith("refused:")) attempt(name);
        } else if (line.startsWith("refused:")) {
          return finish(line.trim());
        } else if (line === "ok") {
          return finish("ok");
        }
        newline = buffer.indexOf("\n");
      }
    });
    conn.on("error", (error) => {
      clearTimeout(timer);
      resolve({ verdict: `refused: ${error.code}`, name });
    });
    const attempt = (proofName) => {
      const file = join(proofs, attack === "wrong-name" ? `${proofName}x` : proofName);
      if (attack === "silent") return;
      if (attack === "late") {
        lateTimer = setTimeout(() => {
          writeFileSync(file, "", { flag: "wx", mode: 0o600 });
          conn.write("done\n");
        }, ttlMs + 500);
        return;
      }
      if (attack === "symlink") fs.symlinkSync("/etc/hostname", file);
      else if (attack === "hardlink") {
        const before = join(proofs, "before");
        writeFileSync(before, "", { flag: "wx", mode: 0o600 });
        fs.linkSync(before, file);
      } else if (attack === "nonempty") writeFileSync(file, "x", { flag: "wx", mode: 0o600 });
      else writeFileSync(file, "", { flag: "wx", mode: 0o600 });
      conn.write("done\n");
    };
  });
}
