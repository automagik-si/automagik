// Hermetic tests for bin/hc-socket-mask.mjs: a fake bwrap on PATH records the argv it gets,
// proxy sockets are real Unix sockets in temp folders, and HOME is a temp folder. The pure
// helper receives a fake container-socket list, so no test reads or needs a live docker.sock.
// The network namespace, the egress relay and the host-side egress proxy are unit-tested here;
// test/netns.test.mjs proves the isolation with a real bwrap and a fixture host listener.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTAINER_RUNTIME_SOCKETS,
  containerSocketPaths,
  EGRESS_DIR_NAME,
  EGRESS_PORT,
  EGRESS_PROXY_URL,
  EGRESS_RELAY_NAME,
  EGRESS_SOCKET_NAME,
  egressBase,
  hostAddressSet,
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
  makeEgressDir,
  maskArgs,
  MSG_PREFIX,
  NETNS_FLAG,
  netnsCapabilityProblem,
  netnsPlatformProblem,
  parseConnectTarget,
  parseRelayArgs,
  PROXY_SOCKET,
  proxyEnvironment,
  REAL_SOCKET,
  RELAY_FLAG,
  splitRunnerArgs,
  startEgressBroker,
  startRelay,
  SWITCH,
  ownArgs,
  PACK_ROOT_FLAG,
} from '../bin/hc-socket-mask.mjs';

const WRAPPER = fileURLToPath(new URL('../bin/hc-socket-mask.mjs', import.meta.url));
const PROFILE_ARGS = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
];
const COMMAND = ['dsh', '--profile', 'dsh-tui', '--resume', 'abc-123'];
const RUNNER_ARGS = [...PROFILE_ARGS, '--', ...COMMAND];

const roots = [];
const servers = [];
after(async () => {
  for (const server of servers) await close(server).catch(() => {});
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temp() {
  // A short root: the live proxy socket under automagik-hc-proxy must fit the platform's
  // sun_path bound (104 on macOS, 107 on Linux), as the hc-pane scenes do.
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'ds-')));
  roots.push(root);
  return root;
}

/** A fake bwrap first on PATH: the preflight creates no namespace and is not recorded. */
function fakeBwrap(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'bwrap');
  const script = [
    '#!/bin/sh',
    'case " $* " in',
    '  *" -- "*) ;;',
    '  *) exit "${BWRAP_NETNS_EXIT:-0}" ;;',
    'esac',
    ': > "$BWRAP_ARGS_FILE"',
    'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$BWRAP_ARGS_FILE"; done',
    'printf \'%s\\n\' "$@" >> "$BWRAP_SEEN_FILE"',
    'exit "${BWRAP_EXIT:-0}"',
  ].join('\n');
  writeFileSync(file, `${script}\n`);
  chmodSync(file, 0o755);
  return bin;
}

function makeFixture({ ssh = 'dir' } = {}) {
  const root = temp();
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const proxyRoot = join(root, 'automagik-hc-proxy');
  const proxyDir = join(proxyRoot, 't7');
  const sshPath = join(home, '.ssh');
  const egress = join(root, 'egress');
  mkdirSync(home, { recursive: true });
  mkdirSync(egress, { recursive: true });
  if (ssh === 'dir') mkdirSync(sshPath, { recursive: true });
  else if (ssh === 'file') writeFileSync(sshPath, 'not a key');
  else if (ssh === 'symlink') {
    const target = join(root, 'canonical-ssh');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, sshPath);
  }
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(proxyDir, { recursive: true });
  return {
    root,
    home,
    coreDir,
    proxyRoot,
    proxyDir,
    ssh: sshPath,
    egress,
    real: join(coreDir, 'default.sock'),
    proxy: join(proxyDir, 'pane.sock'),
    bin: fakeBwrap(root),
    argsFile: join(root, 'bwrap-args'),
    seenFile: join(root, 'bwrap-seen'),
  };
}

async function listen(path) {
  const server = net.createServer((socket) => socket.end());
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return server;
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** The relay argv the wrapper puts inside the pane's network namespace. */
function relayArgs(fixture) {
  const dir = join(fixture.coreDir, EGRESS_DIR_NAME);
  return [
    process.execPath, join(dir, EGRESS_RELAY_NAME), RELAY_FLAG,
    join(dir, EGRESS_SOCKET_NAME), String(EGRESS_PORT), '--', ...COMMAND,
  ];
}

function environment(fixture, { mask = '1', real, proxy, home, extra = {} } = {}) {
  const env = {
    PATH: `${fixture.bin}:${process.env.PATH}`,
    HOME: home === undefined ? fixture.home : home,
    BWRAP_ARGS_FILE: fixture.argsFile,
    BWRAP_SEEN_FILE: fixture.seenFile,
    ...extra,
  };
  if (mask !== undefined) env[SWITCH] = mask;
  if (real !== undefined) env[REAL_SOCKET] = real;
  if (proxy !== undefined) env[PROXY_SOCKET] = proxy;
  return env;
}

function run(args, env) {
  return spawnSync(process.execPath, [WRAPPER, ...args], { env, encoding: 'utf8' });
}

function recorded(fixture) {
  const text = readFileSync(fixture.argsFile, 'utf8');
  return text.replace(/\n$/, '').split('\n');
}

function bwrapRan(fixture) {
  try {
    statSync(fixture.argsFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the host-dependent container masks by shape, so a CLI test never stats a live path.
 * Their exact targets are asserted only by the pure-helper tests with an explicit fake list.
 * `keep` holds one real `--bind /dev/null` target to compare (the ~/.ssh file case).
 */
function withoutContainerBinds(args, keep = null) {
  const kept = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === '--bind' && args[at + 1] === '/dev/null' && args[at + 2] !== keep) {
      at += 2;
      continue;
    }
    kept.push(args[at]);
  }
  return kept;
}

/** Drop the egress slot's two mounts by shape: the host temp folder differs per run. */
function withoutEgress(args) {
  const kept = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === '--dir' && args[at + 1]?.endsWith(`/${EGRESS_DIR_NAME}`)) {
      at += 1;
      continue;
    }
    if (args[at] === '--bind') {
      const dest = args[at + 2] ?? '';
      if (dest.endsWith(`/${EGRESS_DIR_NAME}`) || dest.endsWith(`/${EGRESS_RELAY_NAME}`)) {
        at += 2;
        continue;
      }
    }
    kept.push(args[at]);
  }
  return kept;
}

function assertOneLine(result) {
  const lines = result.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one line, got: ${JSON.stringify(result.stderr)}`);
  assert.ok(lines[0].startsWith(MSG_PREFIX), lines[0]);
  return lines[0];
}

/** Run a real CLI mask with real Unix sockets and no live host service. */
function pureMask(fixture, overrides = {}, options = {}) {
  return maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1',
    HOME: fixture.home,
    [REAL_SOCKET]: fixture.real,
    [PROXY_SOCKET]: fixture.proxy,
    ...overrides,
  }, {
    containerSockets: [],
    egressDir: fixture.egress,
    relaySource: WRAPPER,
    ...options,
  });
}

test('the fixed container list and the per-uid rootless sockets', () => {
  assert.deepEqual(CONTAINER_RUNTIME_SOCKETS, [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/run/containerd/containerd.sock',
    '/run/podman/podman.sock',
  ]);
  assert.deepEqual(containerSocketPaths(null), [...CONTAINER_RUNTIME_SOCKETS]);
  assert.deepEqual(containerSocketPaths(1000), [
    ...CONTAINER_RUNTIME_SOCKETS,
    '/run/user/1000/docker.sock',
    '/run/user/1000/podman/podman.sock',
  ]);
});

test('splitRunnerArgs keeps the profile args and the command apart at the first --', () => {
  assert.deepEqual(splitRunnerArgs(RUNNER_ARGS), { profileArgs: PROFILE_ARGS, command: COMMAND });
  assert.deepEqual(splitRunnerArgs(['--', '--']), { profileArgs: [], command: ['--'] });
  assert.deepEqual(splitRunnerArgs(['--ro-bind']), { profileArgs: ['--ro-bind'], command: null });
});

test('switch off runs bwrap with exactly the arguments it was given', () => {
  const fixture = makeFixture();
  for (const mask of [null, '0', 'yes']) {
    const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy });
    if (mask === null) delete env[SWITCH];
    else env[SWITCH] = mask;
    const result = run(RUNNER_ARGS, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(recorded(fixture), RUNNER_ARGS);
  }
});

test('switch on unshares the network, masks the real dir, ~/.ssh and the proxy, and runs the relay', async () => {
  const fixture = makeFixture();
  await listen(fixture.proxy);
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const expected = [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', dirname(fixture.real),
    '--bind', fixture.proxy, fixture.real,
    '--tmpfs', fixture.proxyRoot,
    '--tmpfs', realpathSync(fixture.ssh),
    '--', ...relayArgs(fixture),
  ];
  assert.deepEqual(withoutContainerBinds(withoutEgress(recorded(fixture))), expected);
  // The egress slot is a real mount: the host folder and this wrapper as the relay.
  const args = recorded(fixture);
  const inside = join(dirname(fixture.real), EGRESS_DIR_NAME);
  assert.ok(args.includes(inside), args.join(' '));
  assert.ok(args.includes(join(inside, EGRESS_RELAY_NAME)), args.join(' '));
  assert.ok(args.includes(join(inside, EGRESS_SOCKET_NAME)), args.join(' '));
});

test('the pane gets the proxy environment, so only the relay is reachable', () => {
  const env = proxyEnvironment({ PATH: '/bin', HOME: '/home/fixture' });
  assert.equal(env.HTTPS_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.https_proxy, EGRESS_PROXY_URL);
  assert.equal(env.HTTP_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.ALL_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/fixture');
});

test('a missing proxy still masks everything, says one line and starts bwrap', () => {
  const fixture = makeFixture();
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /does not exist/);
  const args = recorded(fixture);
  assert.deepEqual(withoutContainerBinds(withoutEgress(args)), [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', dirname(fixture.real),
    '--tmpfs', fixture.proxyRoot,
    '--tmpfs', realpathSync(fixture.ssh),
    '--', ...relayArgs(fixture),
  ]);
  // The shared proxy host folder is hidden even with no bind; the proxy file is not bound.
  assert.ok(!args.includes(fixture.proxy));
});

test('a proxy that is not a Unix socket is treated as missing', () => {
  const fixture = makeFixture();
  writeFileSync(fixture.proxy, 'not a socket');
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /is not a Unix socket/);
  const args = recorded(fixture);
  assert.ok(!args.includes(fixture.proxy));
  assert.ok(args.includes(fixture.proxyRoot));
  assert.deepEqual(withoutContainerBinds(withoutEgress(args)), [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', dirname(fixture.real),
    '--tmpfs', fixture.proxyRoot,
    '--tmpfs', realpathSync(fixture.ssh),
    '--', ...relayArgs(fixture),
  ]);
});

test('an unset proxy fails closed: one line, nonzero, bwrap never runs', () => {
  const fixture = makeFixture();
  const result = run(RUNNER_ARGS, environment(fixture, { real: fixture.real }));
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /AM_HC_PROXY_SOCKET is not set/);
  assert.match(line, /shared proxy folder/);
  assert.equal(bwrapRan(fixture), false);
});

test('a relative proxy fails closed: one line, nonzero, bwrap never runs', () => {
  const fixture = makeFixture();
  const relativeProxy = 'relative-proxy/pane.sock';
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    proxy: relativeProxy,
  }));
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /is not an absolute path/);
  assert.match(line, /shared proxy folder/);
  assert.equal(bwrapRan(fixture), false);
});

test('a ~/.ssh directory is shadowed at its canonical path', async () => {
  const fixture = makeFixture();
  await listen(fixture.proxy);
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(recorded(fixture).includes(realpathSync(fixture.ssh)));
});

test('a ~/.ssh symlink to a directory is shadowed at its canonical target', async () => {
  const fixture = makeFixture({ ssh: 'symlink' });
  await listen(fixture.proxy);
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const canonical = realpathSync(fixture.ssh);
  const args = recorded(fixture);
  assert.deepEqual(args.slice(args.indexOf(canonical) - 1, args.indexOf(canonical) + 1),
    ['--tmpfs', canonical]);
  // The symlink path itself is not a mount target: the canonical directory is what is hidden.
  assert.ok(!args.includes(fixture.ssh));
});

test('a missing ~/.ssh adds no mask and does not fail', async () => {
  const fixture = makeFixture({ ssh: 'absent' });
  await listen(fixture.proxy);
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const args = recorded(fixture);
  assert.ok(!args.includes(fixture.ssh));
  assert.deepEqual(withoutContainerBinds(withoutEgress(args)), [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', dirname(fixture.real),
    '--bind', fixture.proxy, fixture.real,
    '--tmpfs', fixture.proxyRoot,
    '--', ...relayArgs(fixture),
  ]);
});

test('a non-directory ~/.ssh is bound over /dev/null at its canonical path', async () => {
  const fixture = makeFixture({ ssh: 'file' });
  await listen(fixture.proxy);
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const ssh = realpathSync(fixture.ssh);
  assert.deepEqual(withoutContainerBinds(withoutEgress(recorded(fixture)), ssh), [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', dirname(fixture.real),
    '--bind', fixture.proxy, fixture.real,
    '--tmpfs', fixture.proxyRoot,
    '--bind', '/dev/null', ssh,
    '--', ...relayArgs(fixture),
  ]);
});

test('HC_TERMINAL_SOCKET is the fallback for the real socket', async () => {
  const fixture = makeFixture();
  await listen(fixture.proxy);
  const env = environment(fixture, {
    real: undefined,
    proxy: fixture.proxy,
    extra: { HC_TERMINAL_SOCKET: fixture.real },
  });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 0, result.stderr);
  const args = withoutContainerBinds(withoutEgress(recorded(fixture)));
  assert.deepEqual(args.slice(PROFILE_ARGS.length + 1, PROFILE_ARGS.length + 10), [
    '--tmpfs', dirname(fixture.real),
    '--bind', fixture.proxy, fixture.real,
    '--tmpfs', fixture.proxyRoot,
    '--tmpfs', realpathSync(fixture.ssh),
  ]);
});

test('no real socket path fails closed: one line, nonzero, bwrap never runs', () => {
  const fixture = makeFixture();
  const result = run(RUNNER_ARGS, environment(fixture, { proxy: fixture.proxy }));
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /AM_HC_REAL_SOCKET is not set/);
  assert.equal(bwrapRan(fixture), false);
});

test('a relative real socket fails closed: one line, nonzero, bwrap never runs', () => {
  const fixture = makeFixture();
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: 'core/default.sock',
    proxy: fixture.proxy,
  }));
  assert.notEqual(result.status, 0);
  assert.match(assertOneLine(result), /not absolute/);
  assert.equal(bwrapRan(fixture), false);
});

test('no HOME fails closed: ~/.ssh cannot be hidden', () => {
  const fixture = makeFixture();
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy, home: undefined });
  delete env.HOME;
  const result = run(RUNNER_ARGS, env);
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /HOME is not set/);
  assert.equal(bwrapRan(fixture), false);
});

test('a relative HOME fails closed: one line, nonzero, bwrap never runs', () => {
  const fixture = makeFixture();
  const result = run(RUNNER_ARGS, environment(fixture, {
    real: fixture.real,
    home: 'relative/home',
  }));
  assert.notEqual(result.status, 0);
  assert.match(assertOneLine(result), /HOME is not set to an absolute path/);
  assert.equal(bwrapRan(fixture), false);
});

test('a proxy folder that holds the real socket path fails closed, socket or not', async () => {
  const live = makeFixture();
  const liveProxy = join(live.coreDir, 'pane.sock');
  await listen(liveProxy);
  const liveResult = run(RUNNER_ARGS, environment(live, { real: live.real, proxy: liveProxy }));
  assert.notEqual(liveResult.status, 0);
  assert.match(assertOneLine(liveResult), /holds the real socket path/);
  assert.equal(bwrapRan(live), false);
  // The folder is still masked when the proxy is missing, so the guard applies just the same.
  const missing = makeFixture();
  const missingProxy = join(missing.coreDir, 'pane.sock');
  const result = run(RUNNER_ARGS, environment(missing, {
    real: missing.real,
    proxy: missingProxy,
  }));
  assert.notEqual(result.status, 0);
  assert.match(assertOneLine(result), /holds the real socket path/);
  assert.equal(bwrapRan(missing), false);
});

test('a proxy folder above the real socket path fails closed, socket or not', async () => {
  const live = makeFixture();
  const liveProxy = join(live.root, 'pane.sock');
  await listen(liveProxy);
  const liveResult = run(RUNNER_ARGS, environment(live, { real: live.real, proxy: liveProxy }));
  assert.notEqual(liveResult.status, 0);
  assert.match(assertOneLine(liveResult), /holds the real socket path/);
  assert.equal(bwrapRan(live), false);
  // The folder is still an ancestor when the proxy is missing, so the guard applies just the same.
  const missing = makeFixture();
  const missingProxy = join(missing.root, 'pane.sock');
  const result = run(RUNNER_ARGS, environment(missing, {
    real: missing.real,
    proxy: missingProxy,
  }));
  assert.notEqual(result.status, 0);
  assert.match(assertOneLine(result), /holds the real socket path/);
  assert.equal(bwrapRan(missing), false);
});

test('a live, missing or non-socket proxy hides the folder after the real dir', async () => {
  for (const state of ['live', 'missing', 'not-a-socket']) {
    const fixture = makeFixture();
    if (state === 'live') await listen(fixture.proxy);
    else if (state === 'not-a-socket') writeFileSync(fixture.proxy, 'not a socket');
    const result = run(RUNNER_ARGS, environment(fixture, {
      real: fixture.real,
      proxy: fixture.proxy,
    }));
    assert.equal(result.status, 0, result.stderr);
    const args = recorded(fixture);
    // The real runtime folder is shut first, before any bind that could expose it.
    assert.deepEqual(args.slice(PROFILE_ARGS.length + 1, PROFILE_ARGS.length + 3),
      ['--tmpfs', dirname(fixture.real)], state);
    // The only bind onto the real path is a live proxy; otherwise the path has no listener.
    for (let at = 0; at + 2 < args.length; at += 1) {
      if (args[at] === '--bind' && args[at + 2] === fixture.real) {
        assert.equal(state, 'live');
        assert.equal(args[at + 1], fixture.proxy);
      }
    }
    if (state !== 'live') assert.ok(!args.includes(fixture.proxy), state);
    // The shared proxy folder is hidden even when there is no bind.
    assert.ok(args.includes(fixture.proxyRoot), state);
  }
});

test('no proxy path fails closed before bwrap, socket or not', () => {
  for (const proxy of [undefined, 'proxy/pane.sock']) {
    const fixture = makeFixture();
    const result = run(RUNNER_ARGS, environment(fixture, { real: fixture.real, proxy }));
    assert.notEqual(result.status, 0);
    assert.equal(bwrapRan(fixture), false);
    const line = assertOneLine(result);
    assert.match(line, /AM_HC_PROXY_SOCKET/);
    assert.match(line, /shared proxy folder/);
  }
});

test('the runner args without a -- separator fail closed', () => {
  const fixture = makeFixture();
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy });
  const result = run(PROFILE_ARGS, env);
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /no '--' separator/);
  assert.equal(bwrapRan(fixture), false);
});

test("bwrap's exit code is forwarded and a missing bwrap is one prefixed line", () => {
  const fixture = makeFixture();
  const env = environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
    extra: { BWRAP_EXIT: '7' },
  });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 7);
  const missing = environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
    extra: {},
  });
  missing.PATH = '/nonexistent';
  const failed = run(RUNNER_ARGS, missing);
  assert.equal(failed.status, 1);
  const lines = failed.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  for (const line of lines) assert.ok(line.startsWith(MSG_PREFIX), line);
  assert.match(lines[0], /bwrap is not installed/);
});

test('the pure helper uses only its explicit container list: fake, deduped, existing only', () => {
  const root = temp();
  const fake = join(root, 'runtime');
  mkdirSync(fake, { recursive: true });
  const first = join(fake, 'docker.sock');
  const second = join(fake, 'podman.sock');
  writeFileSync(first, '');
  writeFileSync(second, '');
  const alias = join(fake, 'docker-alias.sock');
  // A relative symlink keeps the alias portable inside the temp folder.
  symlinkSync('docker.sock', alias);
  const missing = join(fake, 'missing.sock');
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const proxyRoot = join(root, 'automagik-hc-proxy');
  const proxyDir = join(proxyRoot, 't7');
  const egressDir = join(root, 'egress');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(proxyDir, { recursive: true });
  mkdirSync(egressDir, { recursive: true });
  const real = join(coreDir, 'default.sock');
  const proxy = join(proxyDir, 'pane.sock');
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1',
    HOME: home,
    [REAL_SOCKET]: real,
    [PROXY_SOCKET]: proxy,
  }, {
    containerSockets: [first, second, alias, missing],
    egressDir,
    relaySource: WRAPPER,
  });
  const inside = join(coreDir, EGRESS_DIR_NAME);
  assert.equal(result.fatal, null);
  assert.equal(result.masked, true);
  assert.equal(result.netns, true);
  assert.equal(result.notices.length, 1);
  assert.deepEqual(result.args, [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', coreDir,
    '--tmpfs', proxyRoot,
    '--dir', inside,
    '--bind', realpathSync(egressDir), inside,
    '--bind', realpathSync(WRAPPER), join(inside, EGRESS_RELAY_NAME),
    '--tmpfs', realpathSync(join(home, '.ssh')),
    '--bind', '/dev/null', realpathSync(first),
    '--bind', '/dev/null', realpathSync(second),
    '--',
    process.execPath, join(inside, EGRESS_RELAY_NAME), RELAY_FLAG,
    join(inside, EGRESS_SOCKET_NAME), String(EGRESS_PORT), '--', ...COMMAND,
  ]);
  // The helper never looked at the fixed host paths: none of them is in its output.
  const text = JSON.stringify(result.args);
  for (const live of CONTAINER_RUNTIME_SOCKETS) assert.ok(!text.includes(live), live);
});

test('the pure helper orders the proxy mounts before ~/.ssh and the container masks', async () => {
  const root = temp();
  const fake = join(root, 'runtime');
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const proxyRoot = join(root, 'automagik-hc-proxy');
  const proxyDir = join(proxyRoot, 't7');
  const egressDir = join(root, 'egress');
  mkdirSync(fake, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(proxyDir, { recursive: true });
  mkdirSync(egressDir, { recursive: true });
  const container = join(fake, 'docker.sock');
  writeFileSync(container, '');
  const real = join(coreDir, 'default.sock');
  const proxy = join(proxyDir, 'pane.sock');
  await listen(proxy);
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1',
    HOME: home,
    [REAL_SOCKET]: real,
    [PROXY_SOCKET]: proxy,
  }, { containerSockets: [container], egressDir, relaySource: WRAPPER });
  const inside = join(coreDir, EGRESS_DIR_NAME);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.args, [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', coreDir,
    '--bind', proxy, real,
    '--tmpfs', proxyRoot,
    '--dir', inside,
    '--bind', realpathSync(egressDir), inside,
    '--bind', realpathSync(WRAPPER), join(inside, EGRESS_RELAY_NAME),
    '--tmpfs', realpathSync(join(home, '.ssh')),
    '--bind', '/dev/null', realpathSync(container),
    '--', ...relayArgs({
      coreDir,
    }),
  ]);
});

test('the pure helper hides an absolute proxy folder even when there is no bind', () => {
  const root = temp();
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const proxyRoot = join(root, 'automagik-hc-proxy');
  const proxyDir = join(proxyRoot, 't7');
  const egressDir = join(root, 'egress');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(proxyDir, { recursive: true });
  mkdirSync(egressDir, { recursive: true });
  const real = join(coreDir, 'default.sock');
  const proxy = join(proxyDir, 'pane.sock');
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1',
    HOME: home,
    [REAL_SOCKET]: real,
    [PROXY_SOCKET]: proxy,
  }, { containerSockets: [], egressDir, relaySource: WRAPPER });
  const inside = join(coreDir, EGRESS_DIR_NAME);
  assert.equal(result.fatal, null);
  assert.equal(result.notices.length, 1);
  assert.deepEqual(result.args, [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', coreDir,
    '--tmpfs', proxyRoot,
    '--dir', inside,
    '--bind', realpathSync(egressDir), inside,
    '--bind', realpathSync(WRAPPER), join(inside, EGRESS_RELAY_NAME),
    '--tmpfs', realpathSync(join(home, '.ssh')),
    '--', ...relayArgs({ coreDir }),
  ]);
});

test('the pure helper cannot hide a proxy folder it cannot name: fatal, no bwrap', () => {
  const root = temp();
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const egressDir = join(root, 'egress');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(egressDir, { recursive: true });
  const real = join(coreDir, 'default.sock');
  for (const proxy of ['proxy/pane.sock', undefined]) {
    const env = { [SWITCH]: '1', HOME: home, [REAL_SOCKET]: real };
    if (proxy !== undefined) env[PROXY_SOCKET] = proxy;
    const result = maskArgs(RUNNER_ARGS, env, {
      containerSockets: [], egressDir, relaySource: WRAPPER,
    });
    assert.equal(result.masked, false);
    assert.equal(result.fatal !== null, true);
    assert.match(result.fatal, /AM_HC_PROXY_SOCKET/);
    assert.match(result.fatal, /shared proxy folder/);
    if (proxy === undefined) assert.match(result.fatal, /is not set/);
    else assert.match(result.fatal, /is not an absolute path/);
    assert.deepEqual(result.notices, []);
    assert.deepEqual(result.args, RUNNER_ARGS);
  }
});

test('the pure helper keeps the switch off and never asks for an egress socket then', () => {
  const result = maskArgs(RUNNER_ARGS, { [SWITCH]: '0' },
    { containerSockets: ['/nope'], platform: 'darwin' });
  assert.deepEqual(result.args, RUNNER_ARGS);
  assert.equal(result.masked, false);
  assert.equal(result.fatal, null);
  assert.equal(result.netns, false);
  assert.deepEqual(result.notices, []);
});

test('G1 (g): --pack-root binds the data parent read-only, covering approved/ too', async () => {
  const fixture = makeFixture();
  const dataRoot = join(fixture.root, 'data', 'automagik-herdr');
  const pack = join(dataRoot, 'dsh-sandbox');
  const approved = join(dataRoot, 'approved');
  mkdirSync(pack, { recursive: true });
  mkdirSync(approved, { recursive: true });
  const realRoot = realpathSync(dataRoot), realApproved = realpathSync(approved);
  const env = { [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real, [PROXY_SOCKET]: fixture.proxy };
  const own = ownArgs([PACK_ROOT_FLAG, pack, ...RUNNER_ARGS]);
  assert.equal(own.packRoot, pack);
  assert.deepEqual(own.args, RUNNER_ARGS);
  const result = maskArgs(own.args, env, {
    containerSockets: [], packRoot: own.packRoot, egressDir: fixture.egress, relaySource: WRAPPER,
  });
  assert.equal(result.fatal, null);
  const at = result.args.lastIndexOf('--ro-bind');
  assert.ok(at > 0, result.args.join(' '));
  assert.deepEqual(result.args.slice(at, at + 3), ['--ro-bind', realRoot, realRoot]);
  assert.equal(relative(realRoot, realApproved).startsWith('..'), false,
    'the parent mount covers the approved folder');
  const separator = result.args.indexOf('--', PROFILE_ARGS.length);
  assert.ok(at >= PROFILE_ARGS.length, 'the read-only bind comes after the profile args (and so after any writable workspace bind)');
  assert.ok(at < separator, 'it is a mount, not the command');
});

test(
  'G1 (g): --pack-root refuses a folder that is not <data home>/automagik-herdr/dsh-sandbox',
    () => {
  const fixture = makeFixture();
  const pack = join(fixture.root, 'pack');
  mkdirSync(pack, { recursive: true });
  const env = { [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real,
    [PROXY_SOCKET]: fixture.proxy };
  const result = maskArgs(RUNNER_ARGS, env, {
    containerSockets: [], packRoot: pack, egressDir: fixture.egress, relaySource: WRAPPER,
  });
  assert.match(result.fatal, /is not a <data home>\/automagik-herdr\/dsh-sandbox folder/);
});

test('--pack-root refuses a relative or missing folder', async () => {
  const fixture = makeFixture();
  const env = { [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real, [PROXY_SOCKET]: fixture.proxy };
  const base = { containerSockets: [], egressDir: fixture.egress, relaySource: WRAPPER };
  const relative = maskArgs(RUNNER_ARGS, env, { ...base, packRoot: 'pack' });
  assert.match(relative.fatal, /--pack-root must be an absolute folder/);
  const missing = maskArgs(RUNNER_ARGS, env, { ...base, packRoot: join(fixture.root, 'absent') });
  assert.match(missing.fatal, /--pack-root .* is not a readable folder/);
});

test('the shared proxy parent is hidden, so another pane\'s proxy is not reachable', async () => {
  const root = temp();
  const home = join(root, 'home');
  const coreDir = join(root, 'core');
  const proxyRoot = join(root, 'automagik-hc-proxy');
  const mine = join(proxyRoot, 't7', 'hc.sock');
  const other = join(proxyRoot, 't8', 'hc.sock');
  const egressDir = join(root, 'egress');
  for (const dir of [join(home, '.ssh'), coreDir, join(proxyRoot, 't7'), join(proxyRoot, 't8'), egressDir]) mkdirSync(dir, { recursive: true });
  const real = join(coreDir, 'default.sock');
  await listen(mine);
  await listen(other);
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1', HOME: home, [REAL_SOCKET]: real, [PROXY_SOCKET]: mine,
  }, { containerSockets: [], egressDir, relaySource: WRAPPER });
  assert.equal(result.fatal, null);
  assert.ok(result.args.includes(other) === false, 'the other pane\'s socket is never named');
  assert.deepEqual(result.args.slice(result.args.indexOf('--bind'), result.args.indexOf('--bind') + 3), ['--bind', mine, real]);
  assert.ok(result.args.includes('--tmpfs') && result.args[result.args.indexOf('--tmpfs', result.args.indexOf('--bind') + 3) + 1] === proxyRoot,
    'the shared parent is masked after the bind');
});

test('an egress folder that is missing or not absolute fails closed', () => {
  const fixture = makeFixture();
  const env = { [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real, [PROXY_SOCKET]: fixture.proxy };
  const missing = maskArgs(RUNNER_ARGS, env, {
    containerSockets: [], egressDir: null, relaySource: WRAPPER,
  });
  assert.match(missing.fatal, /egress folder is not set/);
  const relative = maskArgs(RUNNER_ARGS, env, {
    containerSockets: [], egressDir: 'egress', relaySource: WRAPPER,
  });
  assert.match(relative.fatal, /egress folder is not an absolute path/);
  const absent = maskArgs(RUNNER_ARGS, env, {
    containerSockets: [], egressDir: join(fixture.root, 'absent'), relaySource: WRAPPER,
  });
  assert.match(absent.fatal, /egress folder .* is not a readable folder/);
  assert.equal(relative.netns, false);
});

test('the platform and the bwrap namespace check fail closed, never the host network', () => {
  assert.equal(netnsPlatformProblem('linux'), null);
  assert.match(netnsPlatformProblem('darwin'), /Linux-only and this host is darwin/);
  assert.match(netnsPlatformProblem('win32'), /host network/);
  const missing = netnsCapabilityProblem({
    bwrap: 'bwrap', execPath: process.execPath,
    spawn: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
  });
  assert.match(missing, /bwrap is not installed/);
  const refused = netnsCapabilityProblem({
    bwrap: 'bwrap', execPath: process.execPath, spawn: () => ({ status: 1 }),
  });
  assert.match(refused, /could not create a network namespace \(exit 1\)/);
  assert.match(refused, /refusing to start the pane on the host network/);
  const killed = netnsCapabilityProblem({
    bwrap: 'bwrap', execPath: process.execPath, spawn: () => ({ signal: 'SIGKILL' }),
  });
  assert.match(killed, /check was killed \(SIGKILL\)/);
  const ok = netnsCapabilityProblem({
    bwrap: 'bwrap', execPath: process.execPath, spawn: () => ({ status: 0 }),
  });
  assert.equal(ok, null);
});

test('a failed bwrap network-namespace check refuses the pane: no bwrap, one line', () => {
  const fixture = makeFixture();
  const env = environment(fixture, {
    real: fixture.real,
    proxy: fixture.proxy,
    extra: { BWRAP_NETNS_EXIT: '1' },
  });
  const result = run(RUNNER_ARGS, env);
  assert.notEqual(result.status, 0);
  const line = assertOneLine(result);
  assert.match(line, /could not create a network namespace/);
  assert.match(line, /refusing to start the pane on the host network/);
  assert.equal(bwrapRan(fixture), false);
});

test('parseConnectTarget reads CONNECT targets and rejects everything else', () => {
  assert.deepEqual(parseConnectTarget('CONNECT example.com:443 HTTP/1.1'),
    { host: 'example.com', port: 443 });
  assert.deepEqual(parseConnectTarget('CONNECT example.com HTTP/1.1'),
    { host: 'example.com', port: 443 });
  assert.deepEqual(parseConnectTarget('CONNECT [2001:db8::1]:8443 HTTP/1.0'),
    { host: '2001:db8::1', port: 8443 });
  assert.deepEqual(parseConnectTarget('CONNECT [::1]:80 HTTP/1.1'), { host: '::1', port: 80 });
  assert.equal(parseConnectTarget('GET http://example.com/ HTTP/1.1'), null);
  assert.equal(parseConnectTarget('CONNECT example.com:0 HTTP/1.1'), null);
  assert.equal(parseConnectTarget('CONNECT example.com:70000 HTTP/1.1'), null);
  assert.equal(parseConnectTarget('CONNECT example.com:443'), null);
});

test('only public unicast destinations pass the egress filter', () => {
  const hostAddresses = new Set(['127.0.0.1', '192.168.1.10', '2001:db8::9']);
  for (const blocked of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.4.5',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '192.0.2.9', '203.0.113.7', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(blocked, { hostAddresses }), false, blocked);
  }
  for (const allowed of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(allowed, { hostAddresses }), true, allowed);
  }
  assert.equal(isPublicIpv4('198.51.100.4'), false);
  assert.equal(isPublicIpv6('2001:4860:4860::8888'), true);
  assert.equal(hostAddressSet().size > 0, true);
});

/** Read a complete HTTP response line from a socket. */
function responseLine(socket) {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve({ head: data.split('\r\n')[0], rest: data.slice(data.indexOf('\r\n\r\n') + 4) });
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.setTimeout(5000, () => reject(new Error('proxy response timeout')));
  });
}

test('the egress proxy refuses host, loopback and LAN, and tunnels a public target', async () => {
  const root = temp();
  const socketPath = join(root, 'egress.sock');
  const echo = net.createServer((socket) => socket.pipe(socket));
  servers.push(echo);
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = echo.address().port;
  const connects = [];
  const broker = await startEgressBroker({
    path: socketPath,
    hostAddresses: new Set(['127.0.0.1', '10.9.9.9']),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: (options) => {
      connects.push(options);
      return net.connect(echoPort, '127.0.0.1');
    },
  });
  try {
    const proxyConnect = (target) => new Promise((resolve, reject) => {
      const client = net.connect(socketPath);
      client.once('connect', () => client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      responseLine(client).then((result) => { resolve({ client, ...result }); }).catch(reject);
    });

    for (const target of ['127.0.0.1:80', '10.9.9.9:443', 'localhost:8080', '[::1]:80']) {
      const { client, head } = await proxyConnect(target);
      assert.match(head, /^HTTP\/1\.1 403 /, target);
      client.destroy();
    }
    assert.equal(connects.length, 0, 'no host socket was opened for a refused target');

    const { client, head, rest } = await proxyConnect('example.com:443');
    assert.match(head, /^HTTP\/1\.1 200 /);
    assert.deepEqual(connects[0].host, '93.184.216.34');
    assert.equal(connects[0].port, 443);
    client.write('ping');
    const echoed = await new Promise((resolve) => {
      let text = rest;
      client.on('data', (chunk) => {
        text += chunk;
        if (text.includes('ping')) resolve(text);
      });
    });
    assert.match(echoed, /ping/);
    client.destroy();
  } finally {
    await broker.close();
  }
});

test('the egress proxy answers non-CONNECT requests with 405 and refuses an oversized header', async () => {
  const root = temp();
  const broker = await startEgressBroker({
    path: join(root, 'egress.sock'),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: () => { throw new Error('no socket for this test'); },
  });
  try {
    const requestLine = (payload) => new Promise((resolve) => {
      const client = net.connect(broker.server.address());
      client.once('connect', () => client.write(payload));
      responseLine(client).then((result) => { resolve(result.head); client.destroy(); });
    });
    assert.match(await requestLine('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'),
      /^HTTP\/1\.1 405 /);
    const huge = `CONNECT example.com:443 HTTP/1.1\r\nX: ${'a'.repeat(17 * 1024)}\r\n\r\n`;
    assert.match(await requestLine(huge), /^HTTP\/1\.1 431 /);
  } finally {
    await broker.close();
  }
});

test('the egress relay forwards to the Unix proxy and starts the pane command', async () => {
  const root = temp();
  const upstreamPath = join(root, 'broker.sock');
  const upstream = net.createServer((socket) => socket.pipe(socket));
  servers.push(upstream);
  await new Promise((resolve) => upstream.listen(upstreamPath, resolve));
  const child = new EventEmitter();
  child.kill = () => {};
  const port = await new Promise((resolve, reject) => {
    const server = startRelay({
      socket: upstreamPath,
      port: 0,
      command: ['fixture-command'],
      spawn: () => child,
      forwardSignals: false,
      log: { write: () => {} },
      onListening: (listening) => resolve(listening.address().port),
    });
    servers.push(server);
    server.once('error', reject);
  });
  const client = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  client.write('hello relay');
  const echoed = await new Promise((resolve) => {
    let text = '';
    client.on('data', (chunk) => {
      text += chunk;
      if (text.includes('hello relay')) resolve(text);
    });
  });
  assert.match(echoed, /hello relay/);
  client.destroy();
});

test('parseRelayArgs is strict about the socket, the port and the command', () => {
  assert.equal(parseRelayArgs(['--not-a-relay', '/run/sock']), null);
  const ok = parseRelayArgs([RELAY_FLAG, '/run/automagik-egress/egress.sock', '3128', '--', 'dsh', 'x']);
  assert.deepEqual(ok, { socket: '/run/automagik-egress/egress.sock', port: 3128, command: ['dsh', 'x'] });
  assert.match(parseRelayArgs([RELAY_FLAG, 'relative', '3128', '--', 'dsh']).error, /not absolute/);
  assert.match(parseRelayArgs([RELAY_FLAG, '/run/sock', '70000', '--', 'dsh']).error, /port is not valid/);
  assert.match(parseRelayArgs([RELAY_FLAG, '/run/sock', '3128']).error, /no '--'/);
  assert.match(parseRelayArgs([RELAY_FLAG, '/run/sock', '3128', '--']).error, /no command/);
});

test('makeEgressDir makes a private folder with its socket path', () => {
  const base = temp();
  const made = makeEgressDir({ base });
  assert.equal(statSync(made.dir).mode & 0o777, 0o700);
  assert.equal(made.socket, join(made.dir, EGRESS_SOCKET_NAME));
  assert.equal(made.dir.startsWith(base), true);
});

test('the egress folder avoids the workspace-write /tmp tmpfs', () => {
  const root = temp();
  mkdirSync(join(root, 'run'), { recursive: true });
  assert.equal(egressBase({ XDG_RUNTIME_DIR: join(root, 'run') }), join(root, 'run'));
  assert.equal(egressBase({ XDG_RUNTIME_DIR: 'relative/run', HOME: join(root, 'home') }),
    join(root, 'home'));
  assert.equal(egressBase({ XDG_RUNTIME_DIR: join(root, 'absent'), HOME: join(root, 'home') }),
    join(root, 'home'));
  assert.equal(egressBase({ HOME: 'relative/home' }), tmpdir());
  assert.equal(egressBase({}), tmpdir());
});

test('the CLI refuses a sandboxed pane when platform is not Linux', () => {
  // The platform is read from process.platform in the CLI; the pure helper carries the reason.
  const fixture = makeFixture();
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real, [PROXY_SOCKET]: fixture.proxy,
  }, { containerSockets: [], egressDir: fixture.egress, relaySource: WRAPPER, platform: 'darwin' });
  assert.match(result.fatal, /Linux-only and this host is darwin/);
  assert.equal(result.netns, false);
});
