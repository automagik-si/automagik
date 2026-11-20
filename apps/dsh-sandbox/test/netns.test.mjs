// Refs #700, #743: real bwrap, fixture listeners only. This file proves the design's two
// promises with the kernel, not with argv: a sandboxed pane's loopback is its own and the
// host's loopback/LAN are not in its namespace, while the same pane reaches the host listener
// when the sandbox is off. The egress relay on 127.0.0.1:3128 is the only loopback path the
// pane gets, and the host-side broker refuses a CONNECT to the host or the LAN.
//
// When bwrap or the kernel cannot make a network namespace, the test skips with the reason:
// the hermetic tests still assert the refusal. No live profile, core or host service is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EGRESS_PORT, netnsCapabilityProblem } from '../bin/hc-socket-mask.mjs';

const WRAPPER = fileURLToPath(new URL('../bin/hc-socket-mask.mjs', import.meta.url));
const PROFILE_ARGS = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--proc', '/proc',
  '--die-with-parent',
  '--',
];
const roots = [];
const servers = [];
after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temp() {
  const base = realpathSync('/tmp');
  const root = realpathSync(mkdtempSync(join(base, 'ds-netns-')));
  roots.push(root);
  return root;
}

async function listen(host, handler) {
  const server = net.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

/** A non-loopback IPv4 the host can bind: the LAN address the namespace must not reach. */
async function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const probe = net.createServer();
      const ok = await new Promise((resolve) => {
        probe.once('error', () => resolve(false));
        probe.listen(0, entry.address, () => resolve(true));
      });
      await new Promise((resolve) => probe.close(resolve));
      if (ok) return entry.address;
    }
  }
  return null;
}

function runtimeRoot() {
  // The workspace-write profile mounts a fresh tmpfs on /tmp, and bwrap resolves a bind
  // source after that tmpfs: the egress slot must live outside /tmp, as XDG_RUNTIME_DIR does.
  const base = `/run/user/${process.getuid?.()}`;
  try {
    if (!statSync(base).isDirectory()) return null;
    const root = realpathSync(mkdtempSync(join(base, 'ds-netns-')));
    roots.push(root);
    return root;
  } catch {
    return null;
  }
}

function environment(root, mask) {
  const home = join(root, 'home');
  const core = join(root, 'core');
  const proxy = join(root, 'automagik-hc-proxy', 't1');
  mkdirSync(home, { recursive: true });
  mkdirSync(core, { recursive: true });
  mkdirSync(proxy, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    AM_HC_REAL_SOCKET: join(core, 'default.sock'),
    AM_HC_PROXY_SOCKET: join(proxy, 'pane.sock'),
  };
  if (mask !== null) env.DSH_SANDBOX_MASK = mask;
  return env;
}

/** The probe inside the pane: the host listeners and the LAN must fail; the relay must answer. */
const INSIDE_PROBE = `
import net from 'node:net';
const [hostPort, lanAddress, lanPort] = process.argv.slice(2);
const connect = (host, port, timeout = 2000) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const finish = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(timeout, () => finish('timeout'));
  socket.on('connect', () => finish('connected'));
  socket.on('error', (error) => finish(error.code));
});
const proxy = (target) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: ${EGRESS_PORT} });
  let data = '';
  socket.setTimeout(4000, () => { socket.destroy(); resolve('timeout'); });
  socket.on('connect', () => socket.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
  socket.on('data', (chunk) => {
    data += chunk;
    if (data.includes('\\r\\n\\r\\n')) { socket.destroy(); resolve(data.split('\\r\\n')[0]); }
  });
  socket.on('error', (error) => resolve(error.code));
});
const out = {
  hostLoopback: await connect('127.0.0.1', Number(hostPort)),
  lan: await connect(lanAddress, Number(lanPort)),
  relay: await connect('127.0.0.1', ${EGRESS_PORT}),
  egressHost: await proxy('127.0.0.1:' + hostPort),
  egressLan: await proxy(lanAddress + ':' + lanPort),
};
console.log(JSON.stringify(out));
`;

/** The control outside the pane: the same listeners are reachable, so the fixtures are real. */
const HOST_PROBE = `
import net from 'node:net';
const [hostPort, lanAddress, lanPort] = process.argv.slice(2);
const connect = (host, port, timeout = 2000) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const finish = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(timeout, () => finish('timeout'));
  socket.on('connect', () => finish('connected'));
  socket.on('error', (error) => finish(error.code));
});
console.log(JSON.stringify({
  hostLoopback: await connect('127.0.0.1', Number(hostPort)),
  lan: await connect(lanAddress, Number(lanPort)),
}));
`;

function writeProbe(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

function runProbe(root, mask, probe, args) {
  const env = environment(root, mask);
  if (mask === null) {
    return spawnSync(process.execPath, [probe, ...args], { env, encoding: 'utf8', timeout: 30000 });
  }
  return spawnSync(process.execPath, [WRAPPER, ...PROFILE_ARGS, process.execPath, probe, ...args], {
    env, encoding: 'utf8', timeout: 30000,
  });
}

function parsed(result) {
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('a sandboxed pane cannot reach host loopback or the LAN, and the relay is its only loopback',
  async (t) => {
    if (process.platform !== 'linux') return t.skip('network namespaces are Linux-only');
    const problem = netnsCapabilityProblem();
    if (problem) return t.skip(problem);
    const lan = await lanAddress();
    if (!lan) return t.skip('the host has no non-loopback IPv4 address to bind');
    const root = temp();
    const hostPort = await listen('127.0.0.1', (socket) => socket.end('host'));
    const lanPort = await listen(lan, (socket) => socket.end('lan'));
    const inside = writeProbe(root, 'inside.mjs', INSIDE_PROBE);
    const result = runProbe(root, '1', inside, [String(hostPort), lan, String(lanPort)]);
    assert.equal(result.status, 0, result.stderr);
    const out = parsed(result);
    assert.notEqual(out.hostLoopback, 'connected', `host loopback: ${out.hostLoopback}`);
    assert.notEqual(out.lan, 'connected', `LAN: ${out.lan}`);
    assert.equal(out.relay, 'connected');
    assert.match(out.egressHost, /^HTTP\/1\.1 403 /);
    assert.match(out.egressLan, /^HTTP\/1\.1 403 /);
  });

test('the workspace-write /tmp tmpfs does not hide the egress slot', async (t) => {
  if (process.platform !== 'linux') return t.skip('network namespaces are Linux-only');
  const problem = netnsCapabilityProblem();
  if (problem) return t.skip(problem);
  const root = runtimeRoot();
  if (!root) return t.skip('no writable XDG_RUNTIME_DIR-style folder outside /tmp');
  const lan = await lanAddress();
  if (!lan) return t.skip('the host has no non-loopback IPv4 address to bind');
  const hostPort = await listen('127.0.0.1', (socket) => socket.end('host'));
  const lanPort = await listen(lan, (socket) => socket.end('lan'));
  const probe = writeProbe(root, 'inside.mjs', INSIDE_PROBE);
  const env = { ...environment(root, '1'), XDG_RUNTIME_DIR: root };
  const result = spawnSync(process.execPath, [WRAPPER,
    '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--dev', '/dev', '--proc', '/proc',
    '--die-with-parent', '--', process.execPath, probe,
    String(hostPort), lan, String(lanPort)], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const out = parsed(result);
  assert.notEqual(out.hostLoopback, 'connected');
  assert.notEqual(out.lan, 'connected');
  assert.equal(out.relay, 'connected');
});

test('a non-sandboxed pane reaches the same host and LAN listeners', async (t) => {
  if (process.platform !== 'linux') return t.skip('network namespaces are Linux-only');
  if (netnsCapabilityProblem()) return t.skip('bwrap namespaces are unavailable');
  const lan = await lanAddress();
  if (!lan) return t.skip('the host has no non-loopback IPv4 address to bind');
  const root = temp();
  const hostPort = await listen('127.0.0.1', (socket) => socket.end('host'));
  const lanPort = await listen(lan, (socket) => socket.end('lan'));
  const hostProbe = writeProbe(root, 'host.mjs', HOST_PROBE);
  // With the switch absent and with it off, the wrapper is the pass-through it always was.
  for (const mask of [null, '0']) {
    const result = runProbe(root, mask, hostProbe, [String(hostPort), lan, String(lanPort)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parsed(result), { hostLoopback: 'connected', lan: 'connected' }, String(mask));
  }
});

test('the probe itself sees the fixtures from the host before the sandbox runs', async () => {
  // A guard against a false green: the loopback listener is genuinely reachable on this host.
  const root = temp();
  const hostPort = await listen('127.0.0.1', (socket) => socket.end('host'));
  const probe = writeProbe(root, 'self.mjs', `
import net from 'node:net';
const socket = net.connect({ host: '127.0.0.1', port: Number(process.argv[2]) });
socket.on('connect', () => { console.log('connected'); socket.destroy(); });
socket.on('error', (error) => { console.log(error.code); });
`);
  const result = spawnSync(process.execPath, [probe, String(hostPort)], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.stdout.trim(), 'connected');
  assert.equal(readFileSync(probe, 'utf8').includes('127.0.0.1'), true);
});
