// The member runner's three socket locks. The runner refuses to start when any of them fails.
// Apache-2.0.
//
// (a) The folder chain: no folder from the socket folder or the proof folder up to / is writable
//     by group or others; the socket folder is the runner's, mode 0750, in a group whose only
//     member is DSH's service uid and which is nobody's primary group; the proof folder is the one
//     leaf allowed group writes, and only as exactly mode 1730, owned by the runner in that group.
// (b) The file-owner proof: Node cannot read SO_PEERCRED, so the peer proves its uid by creating
//     an empty, single-linked, regular file under a fresh 192-bit name, after the runner touched
//     a marker. One name per connection, refused after three seconds.
// (c) DSH's uid is a service account: nologin or false, locked in shadow when shadow is readable,
//     not root, not the runner's uid, and not in sudo, admin or wheel.
//
// Every file system call on the peer path is caught into a plain one-line refusal, never a stack
// trace. The proof is described in PROTOCOL.md.

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Refusal, plain } from "./proto.mjs";

export const SOCKET_DIR_MODE = 0o750;
export const SOCKET_MODE = 0o660;
export const PROOF_DIR_MODE = 0o1730;
export const PROOF_TTL_MS = 3000;
export const PROOF_MARKER = ".clock";

const refuse = (message) => {
  throw new Refusal("LOCK_FAILED", message);
};

/** lstat, with a missing path as null and every other failure a plain refusal. */
export function lstatOr(fs, path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return refuse(`${path}: ${plain(error)}`);
  }
}

/** lstat with bigint times, as the proof needs nanoseconds. Missing is null. */
function lstatBig(fs, path) {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return refuse(`${path}: ${plain(error)}`);
  }
}

/** The accounts in an /etc/passwd-shaped text, or a plain refusal on a malformed line. */
export function parsePasswd(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith("+") || line.startsWith("-")) continue;
    const part = line.split(":");
    if (part.length < 7) refuse(`a passwd line is not an account: ${line}`);
    const uid = Number(part[2]);
    const gid = Number(part[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || part[0] === "") {
      refuse(`a passwd line has no whole uid or gid: ${part[0] || line}`);
    }
    rows.push({ name: part[0], uid, gid, home: part[5], shell: part[6] });
  }
  return rows;
}

/** The groups in an /etc/group-shaped text. */
export function parseGroup(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith("+") || line.startsWith("-")) continue;
    const part = line.split(":");
    if (part.length < 4) refuse(`a group line is not a group: ${line}`);
    const gid = Number(part[2]);
    if (!Number.isInteger(gid) || part[0] === "") refuse(`a group line has no whole gid: ${part[0] || line}`);
    rows.push({ name: part[0], gid, members: part[3].split(",").filter((member) => member !== "") });
  }
  return rows;
}

/** A shadow text as name -> password field. */
export function parseShadow(text) {
  const rows = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const part = line.split(":");
    if (part.length >= 2 && part[0] !== "") rows.set(part[0], part[1]);
  }
  return rows;
}

/** Whether `path` and every folder above it is a real folder no group or other can write. */
export function checkFolderChain(fs, path, label = path) {
  let at = path;
  for (;;) {
    const info = lstatOr(fs, at);
    if (info === null) refuse(`${label}: ${at} does not exist`);
    if (info.isSymbolicLink()) refuse(`${label}: ${at} is a symbolic link`);
    if (!info.isDirectory()) refuse(`${label}: ${at} is not a folder`);
    if ((info.mode & 0o022) !== 0) refuse(`${label}: ${at} is writable by group or others`);
    const parent = dirname(at);
    if (parent === at) return;
    at = parent;
  }
}

/** The socket folder: the runner's, mode 0750, group the one made for the socket. */
export function checkSocketFolder(fs, dir, runnerUid, groupGid) {
  const info = lstatOr(fs, dir);
  if (info === null) refuse(`the socket folder ${dir} does not exist`);
  if (info.isSymbolicLink() || !info.isDirectory()) refuse(`the socket folder ${dir} is not a real folder`);
  if (info.uid !== runnerUid) refuse(`the socket folder ${dir} is not the runner's`);
  if (info.gid !== groupGid) refuse(`the socket folder ${dir} is not in the socket group`);
  if ((info.mode & 0o7777) !== SOCKET_DIR_MODE) {
    refuse(`the socket folder ${dir} is mode ${(info.mode & 0o7777).toString(8)}, not 750`);
  }
}

/** The proof folder: the one leaf, exactly 1730, the runner's, in the socket group. */
export function checkProofFolder(fs, dir, runnerUid, groupGid) {
  const info = lstatOr(fs, dir);
  if (info === null) refuse(`the proof folder ${dir} does not exist`);
  if (info.isSymbolicLink() || !info.isDirectory()) refuse(`the proof folder ${dir} is not a real folder`);
  if (info.uid !== runnerUid) refuse(`the proof folder ${dir} is not the runner's`);
  if (info.gid !== groupGid) refuse(`the proof folder ${dir} is not in the socket group`);
  if ((info.mode & 0o7777) !== PROOF_DIR_MODE) {
    refuse(`the proof folder ${dir} is mode ${(info.mode & 0o7777).toString(8)}, not 1730`);
  }
}

/** Makes the socket folder when missing; an existing one must already be right. */
export function ensureSocketFolder(fs, dir, runnerUid, groupGid) {
  if (lstatOr(fs, dir) === null) {
    try {
      fs.mkdirSync(dir, { mode: SOCKET_DIR_MODE });
      fs.chownSync(dir, runnerUid, groupGid);
      fs.chmodSync(dir, SOCKET_DIR_MODE);
    } catch (error) {
      refuse(`the socket folder ${dir}: ${plain(error)}`);
    }
  }
  checkSocketFolder(fs, dir, runnerUid, groupGid);
}

/** Makes the proof folder when missing; an existing one must already be right. */
export function ensureProofFolder(fs, dir, runnerUid, groupGid) {
  if (lstatOr(fs, dir) === null) {
    try {
      fs.mkdirSync(dir, { mode: PROOF_DIR_MODE });
      fs.chownSync(dir, runnerUid, groupGid);
      fs.chmodSync(dir, PROOF_DIR_MODE);
    } catch (error) {
      refuse(`the proof folder ${dir}: ${plain(error)}`);
    }
  }
  checkProofFolder(fs, dir, runnerUid, groupGid);
}

/** A socket at `path` may be a stale one of the runner's; anything else is refused. */
export function prepareSocketPath(fs, path, runnerUid) {
  const info = lstatOr(fs, path);
  if (info === null) return;
  if (!info.isSocket()) refuse(`${path} exists and is not a socket`);
  if (info.uid !== runnerUid) refuse(`${path} is not the runner's socket`);
  try {
    fs.unlinkSync(path);
  } catch (error) {
    refuse(`${path}: ${plain(error)}`);
  }
}

/** The socket itself, checked after listen: a socket, the runner's, mode 0660, socket group. */
export function checkSocketFile(fs, path, runnerUid, groupGid) {
  const info = lstatOr(fs, path);
  if (info === null) refuse(`the socket ${path} does not exist`);
  if (!info.isSocket()) refuse(`${path} is not a socket`);
  if (info.uid !== runnerUid) refuse(`${path} is not the runner's socket`);
  if (info.gid !== groupGid) refuse(`${path} is not in the socket group`);
  if ((info.mode & 0o7777) !== SOCKET_MODE) {
    refuse(`${path} is mode ${(info.mode & 0o7777).toString(8)}, not 660`);
  }
}

/**
 * Check (c). DSH's uid must be a local service account. Returns { user, group }, the passwd row
 * and the socket group row (check (a)'s group), or throws a plain refusal.
 */
export function checkServiceAccount({ dshUid, runnerUid, groupName, passwd, groups, shadow }) {
  if (runnerUid === 0) refuse("the runner must not run as root");
  const found = passwd.filter((row) => row.uid === dshUid);
  if (found.length !== 1) refuse(`DSH's uid ${dshUid} is not exactly one local account`);
  const user = found[0];
  if (user.uid === 0) refuse("DSH's uid is 0");
  if (user.uid === runnerUid) refuse("DSH's uid is the runner's own uid");
  const shell = basename(user.shell || "");
  if (shell !== "nologin" && shell !== "false") {
    refuse(`DSH's account ${user.name} has a login shell (${user.shell || "none"})`);
  }
  if (shadow !== null && !shadow.has(user.name)) refuse(`DSH's account ${user.name} has no shadow entry`);
  if (shadow !== null) {
    const password = shadow.get(user.name);
    if (!(password.startsWith("!") || password.startsWith("*"))) {
      refuse(`DSH's account ${user.name} has a password, not a locked one`);
    }
  }
  for (const name of ["sudo", "admin", "wheel"]) {
    const group = groups.find((row) => row.name === name);
    if (group === undefined) continue;
    if (group.gid === user.gid || group.members.includes(user.name) || group.members.includes(String(user.uid))) {
      refuse(`DSH's account ${user.name} is in the ${name} group`);
    }
  }
  const group = groups.find((row) => row.name === groupName);
  if (group === undefined) refuse(`the socket group ${groupName} does not exist`);
  if (group.members.length !== 1 || !(group.members[0] === user.name || group.members[0] === String(user.uid))) {
    refuse(`the socket group ${groupName} must have DSH's uid as its only member`);
  }
  if (passwd.some((row) => row.gid === group.gid)) {
    refuse(`the socket group ${groupName} is someone's primary group`);
  }
  return { user, group };
}

/**
 * All three locks that can be checked before listen. The proof folder and its marker are prepared
 * separately by PeerProof. Returns { user, group }.
 */
export function checkLocks(config, host) {
  const fs = host.fs;
  const passwd = parsePasswd(host.accounts?.passwd);
  const groups = parseGroup(host.accounts?.group);
  const shadowText = host.accounts?.shadow;
  const shadow = shadowText === null || shadowText === undefined ? null : parseShadow(shadowText);
  const { user, group } = checkServiceAccount({
    dshUid: config.dshUid,
    runnerUid: host.uid,
    groupName: config.group,
    passwd,
    groups,
    shadow,
  });
  const socketDir = dirname(config.socket);
  checkFolderChain(fs, dirname(socketDir), "the socket folder chain");
  ensureSocketFolder(fs, socketDir, host.uid, group.gid);
  checkFolderChain(fs, socketDir, "the socket folder");
  checkFolderChain(fs, dirname(config.proofs), "the proof folder chain");
  ensureProofFolder(fs, config.proofs, host.uid, group.gid);
  prepareSocketPath(fs, config.socket, host.uid);
  return { user, group };
}

/**
 * The file-owner proof (b). `prepare()` makes the marker and sweeps strays; `challenge(conn)`
 * sends one fresh name, waits up to `ttlMs`, verifies the peer's file and writes `ok` on success.
 * A refusal is one plain line on stderr and one `refused: ...` line on the connection.
 */
export class PeerProof {
  constructor({ dir, dshUid, runnerUid = process.getuid(), fs, log = () => {}, ttlMs = PROOF_TTL_MS, now = Date.now }) {
    this.dir = dir;
    this.dshUid = dshUid;
    this.runnerUid = runnerUid;
    this.fs = fs;
    this.log = log;
    this.ttlMs = ttlMs;
    this.now = now;
    this.pending = new Map();
  }

  markerPath() {
    return join(this.dir, PROOF_MARKER);
  }

  /** Makes the marker when missing, then sweeps every stray. Throws a plain refusal. */
  prepare() {
    const dir = lstatOr(this.fs, this.dir);
    if (dir === null) refuse(`the proof folder ${this.dir} does not exist`);
    if (dir.isSymbolicLink() || !dir.isDirectory()) refuse(`the proof folder ${this.dir} is not a real folder`);
    try {
      const fd = this.fs.openSync(this.markerPath(), "a", 0o600);
      this.fs.closeSync(fd);
    } catch (error) {
      refuse(`the proof marker: ${plain(error)}`);
    }
    const marker = lstatBig(this.fs, this.markerPath());
    if (marker === null || !marker.isFile() || marker.nlink !== 1n || marker.uid !== BigInt(this.runnerUid)) {
      refuse(`the proof marker ${this.markerPath()} is not the runner's regular file`);
    }
    this.sweep();
  }

  /** Removes every entry that is not the marker or a proof still being checked. */
  sweep() {
    let entries;
    try {
      entries = this.fs.readdirSync(this.dir);
    } catch (error) {
      refuse(`the proof folder ${this.dir}: ${plain(error)}`);
    }
    for (const entry of entries) {
      if (entry === PROOF_MARKER || this.pending.has(entry)) continue;
      try {
        this.fs.rmSync(join(this.dir, entry), { recursive: true, force: true });
      } catch (error) {
        refuse(`a stray proof ${entry}: ${plain(error)}`);
      }
    }
  }

  /** The checks of the VM run sheet, in its order, on one file. Refuses on the first failure. */
  verifyFile(name, sentNs) {
    const file = join(this.dir, name);
    const info = lstatBig(this.fs, file);
    if (info === null) refuse("no proof file");
    try {
      this.fs.unlinkSync(file);
    } catch (error) {
      refuse(`the proof file could not be removed: ${plain(error)}`);
    }
    if (!info.isFile()) refuse("the proof is not a regular file");
    if (info.nlink !== 1n) refuse("the proof has more than one link");
    if (info.size !== 0n) refuse("the proof is not empty");
    if (info.uid !== BigInt(this.dshUid)) refuse(`the proof is owned by uid ${info.uid}`);
    if (info.ctimeNs < sentNs) refuse("the proof was made before the name was sent");
  }

  /**
   * Runs one challenge. Resolves true only after `ok` was written; on failure the peer gets one
   * `refused: ...` line and the connection ends. No error escapes.
   */
  challenge(conn) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      let name;
      const write = (text) => {
        try {
          if (conn.destroyed !== true) conn.write(text);
        } catch {
          /* the peer is gone: the verdict is still logged */
        }
      };
      const end = () => {
        try {
          conn.end();
        } catch {
          /* already closed */
        }
      };
      const finish = (ok, why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (name !== undefined) this.pending.delete(name);
        if (ok) {
          write("ok\n");
          resolve(true);
          return;
        }
        this.log(`refused: ${why}`);
        if (why !== "the connection closed") write(`refused: ${why}\n`);
        end();
        resolve(false);
      };
      try {
        name = randomBytes(24).toString("hex");
        const marker = this.markerPath();
        this.fs.utimesSync(marker, new Date(), new Date());
        const markerInfo = lstatBig(this.fs, marker);
        if (markerInfo === null || !markerInfo.isFile() || markerInfo.nlink !== 1n) {
          refuse(`the proof marker ${marker} is not there`);
        }
        if (markerInfo.uid !== BigInt(this.runnerUid)) refuse("the proof marker is not the runner's");
        const sentNs = markerInfo.ctimeNs;
        this.pending.set(name, this.now() + this.ttlMs);
        timer = setTimeout(() => finish(false, "no proof in time"), this.ttlMs);
        conn.once("close", () => finish(false, "the connection closed"));
        conn.once("error", () => finish(false, "the connection closed"));
        conn.once("data", () => {
          if (settled) return;
          try {
            this.verifyFile(name, sentNs);
            this.sweep();
          } catch (error) {
            finish(false, plain(error));
            return;
          }
          finish(true);
        });
        write(`${name}\n`);
      } catch (error) {
        finish(false, plain(error));
      }
    });
  }
}
