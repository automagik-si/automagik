import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { maskArgs, rootlessRuntimeSockets } from '../bin/hc-socket-mask.mjs';

const ARGS = ['--ro-bind', '/', '/', '--', 'fixture-command'];
const UID = 4242;
const DEFAULT = `/run/user/${UID}`;
const OTHER = '/runtime/fixture';
const directory = (uid) => ({ uid, isDirectory: () => true, isSymbolicLink: () => false });
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

test('rootless discovery inventories the alternate runtime folder and named BuildKit services', () => {
  const listed = [];
  const result = rootlessRuntimeSockets({ uid: UID, env: { XDG_RUNTIME_DIR: OTHER },
    lstat: (path) => path === OTHER ? directory(UID) : missing(),
    realpath: (path) => path,
    readdir: (path) => { listed.push(path); return ['other', 'buildkit-default', 'buildkit-ci']; },
  });
  assert.deepEqual(listed, [OTHER]);
  assert.deepEqual(result, { fatal: null, sockets: [
    'containerd/containerd.sock', 'containerd/containerd.sock.ttrpc',
    'buildkit/buildkitd.sock', 'buildkit-default/buildkitd.sock', 'buildkit-ci/buildkitd.sock',
  ].map((path) => join(OTHER, path)) });
});

test('rootless discovery lists a canonical root once even when the conventional root aliases it', () => {
  const listed = [];
  const result = rootlessRuntimeSockets({ uid: UID, env: { XDG_RUNTIME_DIR: OTHER },
    lstat: (path) => path === DEFAULT
      ? { isDirectory: () => false, isSymbolicLink: () => true } : directory(UID),
    realpath: () => OTHER,
    readdir: (path) => { listed.push(path); return []; },
  });
  assert.equal(result.fatal, null);
  assert.deepEqual(listed, [OTHER]);
  assert.equal(result.sockets.length, 3);
});

test('a foreign-owned or symlinked XDG_RUNTIME_DIR is ignored', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-rootless-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'alias');
  symlinkSync(root, link);
  for (const lstat of [undefined, (path) => path === root ? directory(UID + 1) : missing()]) {
    const result = rootlessRuntimeSockets({
      uid: lstat ? UID : process.getuid(), env: { XDG_RUNTIME_DIR: lstat ? root : `${link}/` },
      lstat, readdir: (path) => {
        if (path.startsWith('/run/user/')) return [];
        assert.fail(`listed untrusted root ${path}`);
      },
    });
    assert.equal(result.fatal, null);
    assert.ok(result.sockets.every((path) => path.startsWith('/run/user/')));
  }
});

test('an unlistable runtime folder refuses a masked run, and discovery is lazy', () => {
  let calls = 0;
  const options = { uid: UID, platform: 'linux', lstat: () => directory(UID), realpath: (path) => path,
    readdir: () => { calls++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  const off = maskArgs(ARGS, {}, options);
  assert.deepEqual(off.args, ARGS);
  assert.equal(off.fatal, null);
  assert.equal(calls, 0);
  assert.match(maskArgs(ARGS, { DSH_SANDBOX_MASK: '1' }, { ...options, containerSockets: [] }).fatal,
    /HOME is not set/);
  assert.equal(calls, 0);
  const on = maskArgs(ARGS, { DSH_SANDBOX_MASK: '1' }, options);
  assert.equal(calls, 1);
  assert.equal(on.fatal, `the runtime folder ${DEFAULT} cannot be listed; its services cannot be inventoried`);
});

test('maskArgs discovers and mounts rootless endpoints with the production uid default', (t) => {
  if (process.platform !== 'linux') return t.skip('masked runs are Linux-only');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-rootless-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [
    'containerd/containerd.sock', 'containerd/containerd.sock.ttrpc',
    'buildkit/buildkitd.sock', 'buildkit-default/buildkitd.sock',
  ].map((path) => join(root, 'runtime', path));
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  for (const dir of ['home', 'core', 'automagik-hc-proxy/pane', 'egress']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const masked = maskArgs(ARGS, {
    DSH_SANDBOX_MASK: '1',
    HOME: join(root, 'home'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    AM_HC_REAL_SOCKET: join(root, 'core', 'core.sock'),
    AM_HC_PROXY_SOCKET: join(root, 'automagik-hc-proxy', 'pane', 'proxy.sock'),
  }, { egressDir: join(root, 'egress') });
  assert.equal(masked.fatal, null);
  assert.equal(masked.netns, true);
  for (const path of paths) {
    const at = masked.args.indexOf(path);
    assert.ok(at > 1, path);
    assert.deepEqual(masked.args.slice(at - 2, at + 1), ['--bind', '/dev/null', path]);
  }
});
