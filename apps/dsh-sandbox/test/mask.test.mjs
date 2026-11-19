// Refs #631: real bwrap and fixture Unix listeners only. The same probe runs with the
// mask off, then with the mask on under both the read-only root and a profile /tmp tmpfs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { netnsCapabilityProblem } from '../bin/hc-socket-mask.mjs';

const WRAPPER = fileURLToPath(new URL('../bin/hc-socket-mask.mjs', import.meta.url));
const PROFILE_ARGS = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];

function runtimeRoot() {
  // The core, proxy and egress fixtures must stay visible under the profile's /tmp tmpfs.
  const base = `/run/user/${process.getuid?.()}`;
  try {
    if (!statSync(base).isDirectory()) return null;
    return realpathSync.native(mkdtempSync(join(base, 'ds-mask-')));
  } catch {
    return null;
  }
}

async function listen(t, path, token) {
  const server = net.createServer((socket) => socket.end(token));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
}

const PROBE = `
import net from 'node:net';
const [canonical, sibling] = process.argv.slice(2);
const connect = (path) => new Promise((resolve) => {
  const socket = net.connect(path);
  let token = '';
  socket.setEncoding('utf8');
  socket.setTimeout(2000, () => { socket.destroy(); resolve('timeout'); });
  socket.on('data', (chunk) => { token += chunk; });
  socket.on('end', () => resolve(token));
  socket.on('error', (error) => resolve(error.code));
});
console.log(JSON.stringify({
  link: await connect(process.env.AM_HC_REAL_SOCKET),
  canonical: await connect(canonical),
  sibling: await connect(sibling),
  agent: await connect(process.env.SSH_AUTH_SOCK),
  docker: await connect(process.env.DOCKER_HOST.slice('unix://'.length)),
}));
`;

async function runProbe(profile, env, probe, canonical, sibling) {
  // Keep the event loop free so the test's listeners can answer the pane's probes.
  const args = [WRAPPER, ...profile, '--', process.execPath, probe, canonical, sibling];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout.trim());
}

test('bwrap masks host Unix sockets while the pane proxy answers through both core paths', async (t) => {
  if (process.platform !== 'linux') return t.skip('network namespaces are Linux-only');
  const problem = netnsCapabilityProblem();
  if (problem) return t.skip(problem);
  const root = runtimeRoot();
  if (!root) return t.skip('no writable XDG_RUNTIME_DIR-style folder outside /tmp');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const linkParent = realpathSync.native(mkdtempSync('/tmp/ds-mask-link-'));
  t.after(() => rmSync(linkParent, { recursive: true, force: true }));

  const home = join(root, 'home');
  const core = join(root, 'core');
  const link = join(linkParent, 'core-link');
  const canonical = join(core, 'default.sock');
  const sibling = join(core, 'core-other.sock');
  const proxyDir = join(root, 'automagik-hc-proxy', 't1');
  const proxy = join(proxyDir, 'pane.sock');
  const agent = join(root, 'agent.sock');
  const docker = join(root, 'docker.sock');
  const probe = join(root, 'probe.mjs');
  for (const dir of [home, core, proxyDir]) mkdirSync(dir, { recursive: true });
  symlinkSync(relative(linkParent, core), link);
  writeFileSync(probe, PROBE);

  await listen(t, canonical, 'core');
  await listen(t, sibling, 'core-other');
  await listen(t, proxy, 'pane-proxy');
  await listen(t, agent, 'agent');
  await listen(t, docker, 'docker');

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_RUNTIME_DIR: root,
    AM_HC_REAL_SOCKET: join(link, 'default.sock'),
    AM_HC_PROXY_SOCKET: proxy,
    SSH_AUTH_SOCK: agent,
    DOCKER_HOST: `unix://${docker}`,
  };
  assert.deepEqual(await runProbe(PROFILE_ARGS, env, probe, canonical, sibling), {
    link: 'core',
    canonical: 'core',
    sibling: 'core-other',
    agent: 'agent',
    docker: 'docker',
  });

  const masked = { ...env, DSH_SANDBOX_MASK: '1' };
  for (const profile of [PROFILE_ARGS, [...PROFILE_ARGS, '--tmpfs', '/tmp']]) {
    assert.deepEqual(await runProbe(profile, masked, probe, canonical, sibling), {
      link: 'pane-proxy',
      canonical: 'pane-proxy',
      sibling: 'ENOENT',
      agent: 'ECONNREFUSED',
      docker: 'ECONNREFUSED',
    }, profile.join(' '));
  }
});
