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
  unlinkSync,
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
  mappedIpv4,
  maskArgs,
  MSG_PREFIX,
  NETNS_FLAG,
  netnsCapabilityProblem,
  netnsPlatformProblem,
  normalizeAddress,
  normalizeTargetHost,
  parseConnectTarget,
  parseRelayArgs,
  PROXY_SOCKET,
  proxyEnvironment,
  REAL_SOCKET,
  RELAY_FLAG,
  runtimeSocketPaths,
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
    'env > "$BWRAP_ENV_FILE"',
    'if [ "$1" = --json-status-fd ] && [ "$2" = 3 ]; then',
    '  printf \'{"child-pid":1}\\n{"exit-code":%s}\\n\' "${BWRAP_EXIT:-0}" >&3',
    'fi',
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
    envFile: join(root, 'bwrap-env'),
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
    BWRAP_ENV_FILE: fixture.envFile,
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
  const args = text.replace(/\n$/, '').split('\n');
  return args[0] === '--json-status-fd' && args[1] === '3' ? args.slice(2) : args;
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
 * Drop host-dependent /dev/null binds by shape and tmpfs mounts only at resolved fixed paths.
 * The pure-helper tests assert the exact socket mount targets using fixture paths.
 * `keep` holds one real `--bind /dev/null` target to compare (the ~/.ssh file case).
 */
function withoutContainerBinds(args, keep = null) {
  const fixedPaths = new Set();
  for (const path of runtimeSocketPaths(process.getuid())) {
    try {
      fixedPaths.add(realpathSync.native(path));
    } catch {
      // The wrapper also skips missing or unreadable paths.
    }
  }
  const kept = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === '--bind' && args[at + 1] === '/dev/null' && args[at + 2] !== keep) {
      at += 2;
      continue;
    }
    if (args[at] === '--tmpfs' && fixedPaths.has(args[at + 1])) {
      at += 1;
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

  // A profile that unshares all namespaces already has the network namespace, so the wrapper
  // adds no second switch. --share-net after it must not silently re-enable the host network:
  // that pair is refused instead of trusted to bwrap's argument order.
  const fixtures = { containerSockets: [], egressDir: fixture.egress, relaySource: WRAPPER };
  const all = maskArgs(['--unshare-all', '--ro-bind', '/', '/', '--', ...COMMAND], env, fixtures);
  assert.equal(all.fatal, null);
  assert.equal(all.args.includes(NETNS_FLAG), false, 'no second switch next to --unshare-all');
  const shared = maskArgs(
    ['--unshare-all', '--share-net', '--ro-bind', '/', '/', '--', ...COMMAND], env, fixtures);
  assert.match(shared.fatal, /--share-net/);
  assert.match(shared.fatal, /refusing to start the pane on the host network/);
  assert.equal(shared.netns, false);
  const both = maskArgs(
    [NETNS_FLAG, '--share-net', '--ro-bind', '/', '/', '--', ...COMMAND], env, fixtures);
  assert.match(both.fatal, /--share-net/);
  assert.equal(both.netns, false);
});

test('the pane gets the proxy environment, so only the relay is reachable', () => {
  const env = proxyEnvironment({ PATH: '/bin', HOME: '/home/x' });
  assert.equal(env.HTTPS_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.https_proxy, EGRESS_PROXY_URL);
  assert.equal(env.HTTP_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.ALL_PROXY, EGRESS_PROXY_URL);
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/x');
});

test('masked bwrap receives the relay proxy environment', () => {
  const fixture = makeFixture();
  const env = environment(fixture, { real: fixture.real, proxy: fixture.proxy,
    extra: { HTTP_PROXY: 'http://old-proxy:8080', NO_PROXY: '*' } });
  const result = run(RUNNER_ARGS, env);
  assert.equal(result.status, 0, result.stderr);
  const recordedEnv = new Set(readFileSync(fixture.envFile, 'utf8').trimEnd().split('\n'));
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    assert.ok(recordedEnv.has(`${name}=${EGRESS_PROXY_URL}`), name);
  }
  assert.ok(recordedEnv.has('NO_PROXY=127.0.0.1,localhost,::1'));
  assert.ok(recordedEnv.has('no_proxy=127.0.0.1,localhost,::1'));
  assert.ok(recordedEnv.has('NODE_USE_ENV_PROXY=1'));
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

test('the default fixed socket list masks CRI-O, K3s containerd, ttrpc and BuildKit paths', () => {
  const fixture = makeFixture({ ssh: 'missing' });
  const paths = [
    '/var/run/crio/crio.sock',
    '/run/crio/crio.sock',
    '/run/k3s/containerd/containerd.sock',
    '/run/containerd/containerd.sock.ttrpc',
    '/run/buildkit/buildkitd.sock',
  ];
  const defaults = new Map(paths.map((path, index) => [path, join(fixture.root, `runtime-${index}`)]));
  const targets = new Set(defaults.values());
  const statCalls = [];
  const result = maskArgs(RUNNER_ARGS, {
    [SWITCH]: '1', HOME: fixture.home, [REAL_SOCKET]: fixture.real, [PROXY_SOCKET]: fixture.proxy,
  }, {
    uid: 1000,
    egressDir: fixture.egress,
    realpath(path) {
      if (defaults.has(path)) return defaults.get(path);
      if (path.startsWith(`${fixture.root}/`) || path === WRAPPER) return realpathSync.native(path);
      throw new Error(`no fixture for ${path}`);
    },
    stat(path) {
      if (!targets.has(path)) return statSync(path);
      statCalls.push(path);
      return { isDirectory: () => false };
    },
    // This case is about the fixed list: keep the host's own rootless runtime folder out of it.
    lstat(path) {
      throw Object.assign(new Error(`no rootless runtime folder in this fixture: ${path}`), { code: 'ENOENT' });
    },
  });
  assert.equal(result.fatal, null);
  assert.deepEqual(statCalls, [...targets]);
  const separator = result.args.indexOf('--');
  assert.deepEqual(result.args.slice(separator - 3 * paths.length, separator),
    [...targets].flatMap((target) => ['--bind', '/dev/null', target]));
});

test('fixed and env-named sockets share canonical masks in fixed-then-env order', () => {
  const fixture = makeFixture({ ssh: 'missing' });
  const fixed = join(fixture.root, 'docker.sock');
  const docker = join(fixture.root, 'docker-alias.sock');
  const container = join(fixture.root, 'podman.sock');
  const agent = join(fixture.root, 'agent.sock');
  const agentLink = join(fixture.root, 'agent-alias.sock');
  writeFileSync(fixed, '');
  symlinkSync('docker.sock', docker);
  mkdirSync(container);
  writeFileSync(agent, '');
  symlinkSync('agent.sock', agentLink);

  const result = pureMask(fixture, {
    DOCKER_HOST: `unix://${docker}`,
    CONTAINER_HOST: `unix://${container}`,
    SSH_AUTH_SOCK: agentLink,
  }, { containerSockets: [fixed] });
  assert.equal(result.fatal, null);
  const first = result.args.indexOf(fixed) - 2;
  assert.deepEqual(result.args.slice(first, result.args.indexOf('--')), [
    '--bind', '/dev/null', fixed,
    '--tmpfs', container,
    '--bind', '/dev/null', agent,
  ]);

  const envOnly = pureMask(fixture, { DOCKER_HOST: `unix://${docker}`, SSH_AUTH_SOCK: agent });
  assert.equal(envOnly.fatal, null);
  assert.deepEqual(envOnly.args.slice(envOnly.args.indexOf('--') - 6, envOnly.args.indexOf('--')), [
    '--bind', '/dev/null', fixed,
    '--bind', '/dev/null', agent,
  ]);
});

test('TCP, SSH, named-pipe and relative hosts and missing or relative agents add no masks', () => {
  const fixture = makeFixture({ ssh: 'missing' });
  const baseline = pureMask(fixture);
  assert.equal(baseline.fatal, null);
  for (const env of [
    { DOCKER_HOST: 'tcp://127.0.0.1:2375', SSH_AUTH_SOCK: join(fixture.root, 'missing.sock') },
    { DOCKER_HOST: 'ssh://host', SSH_AUTH_SOCK: 'relative-agent.sock' },
    { DOCKER_HOST: 'npipe:////./pipe/docker_engine', CONTAINER_HOST: 'unix://relative.sock' },
  ]) {
    assert.deepEqual(pureMask(fixture, env), baseline, JSON.stringify(env));
  }
});

test('a socket path covering a protected path is fatal, even through an alias', () => {
  const fixture = makeFixture({ ssh: 'symlink' });
  const parent = join(fixture.root, 'automagik-herdr');
  const packRoot = join(parent, 'dsh-sandbox');
  mkdirSync(packRoot, { recursive: true });
  const alias = join(fixture.root, 'socket-alias');
  for (const path of ['/', fixture.coreDir, fixture.proxyRoot, fixture.egress, realpathSync.native(WRAPPER),
    parent, realpathSync.native(fixture.ssh)]) {
    symlinkSync(path, alias);
    const result = pureMask(fixture, { SSH_AUTH_SOCK: alias }, { packRoot });
    assert.equal(result.fatal, `the socket path ${alias} would cover ${path}: refusing`);
    assert.deepEqual(result.args, RUNNER_ARGS);
    unlinkSync(alias);
  }
  const fixed = pureMask(fixture, {}, { containerSockets: [fixture.root] });
  assert.equal(fixed.fatal, `the socket path ${fixture.root} would cover ${fixture.coreDir}: refusing`);
});

test('endpoints inside either masked runtime folder are already hidden', () => {
  const fixture = makeFixture();
  writeFileSync(fixture.real, '');
  writeFileSync(fixture.proxy, '');
  const hidden = join(fixture.coreDir, '..state');
  mkdirSync(hidden);
  const baseline = pureMask(fixture);
  assert.equal(baseline.fatal, null);
  for (const path of [fixture.real, hidden, fixture.proxy]) {
    assert.deepEqual(pureMask(fixture, { SSH_AUTH_SOCK: path }), baseline, path);
  }
});

test('a symlink to the runtime folder keeps the client path and mounts at the canonical folder', () => {
  const fixture = makeFixture({ ssh: 'missing' });
  const alias = join(fixture.root, 'alias');
  symlinkSync('core', alias);
  const result = pureMask(fixture, { [REAL_SOCKET]: join(alias, 'default.sock') }, {
    stat: (path) => (path === fixture.proxy ? { isSocket: () => true } : statSync(path)),
  });
  const inside = join(fixture.coreDir, EGRESS_DIR_NAME);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.args, [
    ...PROFILE_ARGS,
    NETNS_FLAG,
    '--tmpfs', fixture.coreDir,
    '--bind', fixture.proxy, fixture.real,
    '--tmpfs', fixture.proxyRoot,
    '--dir', inside,
    '--bind', fixture.egress, inside,
    '--bind', realpathSync.native(WRAPPER), join(inside, EGRESS_RELAY_NAME),
    '--symlink', 'core', alias,
    '--', ...relayArgs(fixture),
  ]);
});

test('a runtime folder resolves symlinks before dot-dot components', () => {
  const fixture = makeFixture();
  const child = join(fixture.coreDir, 'child');
  mkdirSync(child);
  const alias = join(fixture.root, 'alias');
  symlinkSync(child, alias);
  const result = pureMask(fixture, { [REAL_SOCKET]: `${alias}/../default.sock` });
  assert.equal(result.fatal, null);
  assert.deepEqual(result.args.slice(PROFILE_ARGS.length, PROFILE_ARGS.length + 3),
    [NETNS_FLAG, '--tmpfs', fixture.coreDir]);
});

test('a real socket path linked outside the runtime folder is fatal', () => {
  const fixture = makeFixture();
  const target = join(fixture.root, 'outside.sock');
  writeFileSync(target, '');
  symlinkSync(target, fixture.real);
  const result = pureMask(fixture);
  assert.equal(result.fatal,
    `the real core socket ${fixture.real} is a link to ${target} outside its folder: the mask cannot hide it`);
});

test('the canonical core and shared proxy folders cannot contain each other', () => {
  const fixture = makeFixture();
  const alias = join(fixture.root, 'alias');
  symlinkSync(fixture.proxyDir, alias);
  const inProxy = pureMask(fixture, { [REAL_SOCKET]: join(alias, 'default.sock') });
  assert.match(inProxy.fatal, /the proxy folder .* holds the real socket path/);

  const shared = join(fixture.coreDir, 'shared');
  mkdirSync(shared);
  const host = join(fixture.root, 'host');
  mkdirSync(host);
  const proxyRoot = join(host, 'automagik-hc-proxy');
  symlinkSync(shared, proxyRoot);
  const inCore = pureMask(fixture, { [PROXY_SOCKET]: join(proxyRoot, 't7', 'pane.sock') });
  assert.match(inCore.fatal, /the real core folder .* holds the proxy parent/);
});

test('the pack data parent cannot overlap either canonical masked runtime folder', () => {
  for (const folder of ['core', 'shared']) {
    for (const placement of ['above', 'inside']) {
      const fixture = makeFixture();
      const hidden = folder === 'core' ? fixture.coreDir : fixture.proxyRoot;
      const parent = join(placement === 'above' ? fixture.root : hidden, 'automagik-herdr');
      const packRoot = join(parent, 'dsh-sandbox');
      mkdirSync(packRoot, { recursive: true });
      const overrides = {};
      if (placement === 'above') {
        const canonical = join(parent, 'runtime');
        mkdirSync(canonical);
        const alias = join(fixture.root, 'alias');
        mkdirSync(alias);
        const link = join(alias, folder === 'core' ? 'core' : 'automagik-hc-proxy');
        symlinkSync(canonical, link);
        if (folder === 'core') overrides[REAL_SOCKET] = join(link, 'default.sock');
        else overrides[PROXY_SOCKET] = join(link, 't7', 'pane.sock');
      }
      const result = pureMask(fixture, overrides, { packRoot });
      assert.match(result.fatal, /the pack data parent .* overlaps the masked folder .*: refusing/,
        `${folder}, ${placement}`);
    }
  }
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
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101',
    // The reviewer's exact reproduction: the full-form IPv4-mapped spellings.
    '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:ffff:c0a8:101', '0:0:0:0:0:ffff:7f00:1',
    // The full-form unspecified and loopback addresses.
    '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1',
    // IPv4 in inet_aton's decimal, octal and hex spellings, and a zone id on a mapped form.
    '0177.0.0.1', '0x7f.1', '0x7f000001', '2130706433', '::ffff:127.0.0.1%lo',
    // A trailing dot and case variants of a reserved name are never an address.
    '127.0.0.1.', 'localhost', 'LOCALHOST', 'localhost.']) {
    assert.equal(isPublicAddress(blocked, { hostAddresses }), false, blocked);
  }
  for (const allowed of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2001:4860:4860::8888',
    '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(allowed, { hostAddresses }), true, allowed);
  }
  assert.equal(isPublicIpv4('198.51.100.4'), false);
  assert.equal(isPublicIpv6('2001:4860:4860::8888'), true);
  assert.equal(hostAddressSet().size > 0, true);
  // Normalization runs before the range check, so every spelling of one host agrees.
  assert.equal(normalizeAddress('0:0:0:0:0:ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('0:0:0:0:0:ffff:c0a8:101'), '192.168.1.1');
  assert.equal(normalizeAddress('0177.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('0x7f.1'), '127.0.0.1');
  assert.equal(normalizeAddress('2130706433'), '127.0.0.1');
  assert.equal(normalizeAddress('FE80::1%eth0'), 'fe80:0:0:0:0:0:0:1');
  assert.equal(normalizeAddress('0:0:0:0:0:0:0:1'), '0:0:0:0:0:0:0:1');
  assert.equal(normalizeAddress('not an address'), null);
  assert.equal(mappedIpv4('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
  assert.deepEqual(normalizeTargetHost('LOCALHOST.'), { kind: 'name', name: 'localhost' });
  assert.equal(normalizeTargetHost('user@127.0.0.1'), null);
  assert.equal(normalizeTargetHost('08.0.0.1'), null);
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

test('the egress proxy refuses every non-public spelling and tunnels the pinned public address', async () => {
  const root = temp();
  const socketPath = join(root, 'egress.sock');
  const echo = net.createServer((socket) => socket.pipe(socket));
  servers.push(echo);
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = echo.address().port;
  const connects = [];
  const lookups = new Map();
  const broker = await startEgressBroker({
    path: socketPath,
    hostAddresses: new Set(['127.0.0.1', '10.9.9.9']),
    lookup: async (name) => {
      const count = (lookups.get(name) ?? 0) + 1;
      lookups.set(name, count);
      // A name is resolved once per request. rebind.test answers a public address first and
      // 127.0.0.1 on every later answer: the first tunnel must still go to the pinned address.
      if (name === 'rebind.test') {
        return count === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      }
      // A name whose answer is a full-form IPv4-mapped loopback address.
      if (name === 'mapped.test') return [{ address: '0:0:0:0:0:ffff:127.0.0.1', family: 6 }];
      return [{ address: '93.184.216.34', family: 4 }];
    },
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

    const refused = [
      '127.0.0.1:80', '10.9.9.9:443', 'localhost:8080', '[::1]:80',
      // The reviewer's exact reproduction, compressed and full form, and the full-form ::1.
      '[0:0:0:0:0:ffff:127.0.0.1]:80', '[0:0:0:0:0:ffff:c0a8:101]:443',
      '[0:0:0:0:0:ffff:7f00:1]:80', '[::ffff:127.0.0.1]:80',
      '[0:0:0:0:0:0:0:1]:80', '[::]:80',
      // IPv4 in decimal, octal and hex spellings; the resolver must never see them.
      '0177.0.0.1:80', '0x7f.1:80', '2130706433:80',
      // Userinfo, bracketed and trailing-dot/case variants of a refused name.
      'user@127.0.0.1:80', 'user:secret@localhost:80', 'localhost.:8080', 'LOCALHOST:8080',
      // A DNS name whose resolved address is refused (checked after normalizing it).
      'mapped.test:443',
    ];
    for (const target of refused) {
      const { client, head } = await proxyConnect(target);
      assert.match(head, /^HTTP\/1\.1 403 /, target);
      client.destroy();
    }
    assert.equal(connects.length, 0, 'no host socket was opened for a refused target');
    for (const numeric of ['0177.0.0.1', '0x7f.1', '2130706433']) {
      assert.equal(lookups.has(numeric), false, `${numeric} is parsed and normalized, never resolved`);
    }
    assert.equal(lookups.get('mapped.test'), 1, 'the name was resolved exactly once');

    const { client, head, rest } = await proxyConnect('example.com:443');
    assert.match(head, /^HTTP\/1\.1 200 /);
    assert.deepEqual(connects[0], { host: '93.184.216.34', port: 443, family: 4 },
      'the connect uses the normalized address the filter checked');
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

    const v6 = await proxyConnect('[2001:4860:4860::8888]:8443');
    assert.match(v6.head, /^HTTP\/1\.1 200 /);
    assert.deepEqual(connects[1], { host: '2001:4860:4860:0:0:0:0:8888', port: 8443, family: 6 },
      'a genuinely public IPv6 target is pinned in its expanded form');
    v6.client.destroy();

    const rebound = await proxyConnect('rebind.test:443');
    assert.match(rebound.head, /^HTTP\/1\.1 200 /);
    assert.deepEqual(connects[2], { host: '93.184.216.34', port: 443, family: 4 },
      'the tunnel goes to the address that was checked, never to a re-resolution');
    assert.equal(lookups.get('rebind.test'), 1, 'the name was resolved once for the tunnel');
    rebound.client.destroy();

    const after = await proxyConnect('rebind.test:443');
    assert.match(after.head, /^HTTP\/1\.1 403 /,
      'the changed resolution is refused on the next request');
    assert.equal(connects.length, 3, 'no socket was opened for the changed resolution');
    after.client.destroy();
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
