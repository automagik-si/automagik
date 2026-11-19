// The fd-based provisioning helper: every folder is made, opened with O_NOFOLLOW, and chmod/chown
// through that handle, so a path swapped for a link between create and chmod is refused and no
// folder outside the member's own can be changed. The fake file system records every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CWD_GUARD, PROVISION_RELS, ProvisionRefusal, provisionFolders } from "../runner/spawn.mjs";
import { MEMBER_GID, MEMBER_UID, base } from "./runner-helpers.mjs";

function fakeFs({ swap = null, owner = MEMBER_UID, mode = 0o700 } = {}) {
  let nextFd = 3;
  const dirs = new Map();
  const fds = new Map();
  const calls = { chown: 0, chmod: 0 };
  const resolve = (path) => {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(path);
    if (match === null) return path;
    const parent = fds.get(Number(match[1]));
    if (parent === undefined) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    return match[2] === undefined ? parent : `${parent}/${match[2]}`;
  };
  const check = (path) => {
    const real = resolve(path);
    const problem = swap?.(real);
    if (problem !== undefined && problem !== null) throw Object.assign(new Error(problem), { code: problem });
    return real;
  };
  const api = {
    constants: fs.constants,
    calls,
    dirs,
    mkdirSync(path) {
      const real = resolve(path);
      if (dirs.has(real)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      dirs.set(real, { uid: 0, gid: 0, mode: 0o700 });
    },
    openSync(path) {
      const real = check(path);
      if (!dirs.has(real)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const fd = nextFd++;
      fds.set(fd, real);
      return fd;
    },
    fchownSync(fd, uid, gid) {
      calls.chown += 1;
      Object.assign(dirs.get(fds.get(fd)), { uid, gid });
    },
    fchmodSync(fd, value) {
      calls.chmod += 1;
      dirs.get(fds.get(fd)).mode = value;
    },
    fstatSync(fd) {
      const real = fds.get(fd);
      const info = dirs.get(real);
      return {
        isDirectory: () => true,
        mode: info.mode,
        uid: real === join("/homes/alice", ".config") && owner !== MEMBER_UID ? owner : info.uid,
        gid: info.gid,
      };
    },
    closeSync(fd) {
      fds.delete(fd);
    },
  };
  return api;
}

const dirs = { home: "/homes/alice", area: "/work/alice", cwd: "/work/alice" };
const normal = (fsApi, extra = {}) =>
  provisionFolders({ ...dirs, uid: MEMBER_UID, gid: MEMBER_GID, fs: fsApi, root: true, ...extra });

test("makes HOME, every XDG folder, TMPDIR and the work area through opened handles", () => {
  const api = fakeFs();
  normal(api);
  for (const path of [dirs.home, join(dirs.home, ".local"), join(dirs.home, ".local/share"), join(dirs.home, "tmp"), dirs.area]) {
    assert.ok(api.dirs.has(path), path);
    assert.equal(api.dirs.get(path).mode, 0o700, path);
    assert.equal(api.dirs.get(path).uid, MEMBER_UID, path);
  }
  assert.ok(api.calls.chown >= 2 + PROVISION_RELS.length);
  assert.ok(api.calls.chmod >= 2 + PROVISION_RELS.length);
});

test("a folder swapped for a link before it is opened is refused, not chmodded", () => {
  const api = fakeFs({ swap: (path) => (path.endsWith("/.config") ? "ELOOP" : null) });
  assert.throws(() => normal(api), (error) => {
    assert.ok(error instanceof ProvisionRefusal);
    assert.equal(error.code, 9);
    assert.match(error.message, /not a real folder|symbolic link/);
    return true;
  });
});

test("a folder whose owner is not the member is refused", () => {
  const api = fakeFs({ owner: MEMBER_UID + 7 });
  assert.throws(() => normal(api), /not the member's/);
  const notRoot = fakeFs({ owner: MEMBER_UID + 7 });
  assert.doesNotThrow(() => normal(notRoot, { root: false }));
  assert.equal(notRoot.calls.chown, 0);
});

test("an existing folder that is not the member's 0700 folder is refused", () => {
  const api = fakeFs();
  normal(api);
  api.dirs.get(join(dirs.home, ".config")).mode = 0o755;
  assert.throws(() => normal(api), /not 700/);
});

test("a folder whose mode is not 0700 is refused", () => {
  const api = fakeFs();
  const original = api.fchmodSync;
  api.fchmodSync = (fd, mode) => original(fd, 0o755);
  assert.throws(() => normal(api), /not 700/);
});

test("a cwd through a link is refused as a cwd failure", () => {
  const api = fakeFs({ swap: (path) => (path === "/work/alice/escape" ? "ENOTDIR" : null) });
  assert.throws(() => provisionFolders({ ...dirs, cwd: "/work/alice/escape", uid: MEMBER_UID, gid: MEMBER_GID, fs: api, root: true }), (error) => {
    assert.equal(error.code, 10);
    assert.match(error.message, /symbolic link|not a real folder/);
    return true;
  });
});

test("a cwd outside the member's area is refused", () => {
  const api = fakeFs();
  assert.throws(() => provisionFolders({ ...dirs, cwd: "/work/bob", uid: MEMBER_UID, gid: MEMBER_GID, fs: api, root: true }), (error) => {
    assert.equal(error.code, 12);
    assert.match(error.message, /outside/);
    return true;
  });
});

test("the after-switch guard refuses a symlink out and allows the area", (t) => {
  const root = base(t);
  const area = join(root, "area");
  fs.mkdirSync(area);
  fs.mkdirSync(join(root, "outside"));
  fs.symlinkSync(join(root, "outside"), join(area, "escape"));
  const enter = (target) =>
    spawnSync("/bin/sh", ["-c", CWD_GUARD, "am-enter", area, target, "/bin/pwd"], { encoding: "utf8" });
  assert.equal(enter(join(area, "escape")).status, 125);
  const inside = enter(area);
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout.trim(), area);
});
