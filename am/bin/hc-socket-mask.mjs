#!/usr/bin/env node
// The DSH sandbox runner wrapper (apps/dsh-sandbox; issues #631, #700 and #743, the DSH lane
// of #624). Linux/bwrap only: every sandboxed pane gets its own network namespace, so loopback
// and the local networks of the host are not in it, and the wrapper hides the herdr-core
// runtime folder at its canonical path, the user's ~/.ssh, and fixed and env-named runtime
// sockets. The pane's egress is an explicit HTTP CONNECT proxy on its own loopback port 3128.
// The wrapper serves that proxy over a Unix socket it binds into the sandbox, and the socket's
// host-side end refuses loopback, link-local, private and host addresses. Nothing else has a route.
//
// The local sandbox provider composes its runner argv as
// [...runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv]. This wrapper finds that '--',
// inserts the network namespace and the mask mounts after the profile args and before it, and
// execs bwrap. Off unless DSH_SANDBOX_MASK=1: then bwrap runs with exactly the arguments it
// received (today's behavior).
//
// Every line this wrapper prints starts with MSG_PREFIX, which is also the profile's
// runnerFailureSignatures entry: 'hc-socket-mask: '.
import { spawn, spawnSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { chmodSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { BlockList, createServer, connect as netConnect, isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pane-start switch: '1' enables the mask; absent (or anything else) is off. */
export const SWITCH = 'DSH_SANDBOX_MASK';
/** The pane's real core socket, from the shim (HC_TERMINAL_SOCKET fallback). */
export const REAL_SOCKET = 'AM_HC_REAL_SOCKET';
/** The host-side proxy socket the Herdr lane binds at the real path inside the sandbox. */
export const PROXY_SOCKET = 'AM_HC_PROXY_SOCKET';
/** Every line the wrapper prints starts with this; the profile's runnerFailureSignatures entry. */
export const MSG_PREFIX = 'hc-socket-mask: ';
/** The wrapper's own word before its profile args: the stable folder whose data parent it binds. */
export const PACK_ROOT_FLAG = '--pack-root';
/** The shared runtime folder holding every pane's proxy; the mask hides it whole. */
export const PROXY_ROOT_NAME = 'automagik-hc-proxy';
/** The network namespace switch of bwrap: the pane's loopback is not the host's. */
export const NETNS_FLAG = '--unshare-net';
/** The egress relay's own leading word, run inside the pane's network namespace. */
export const RELAY_FLAG = '--egress-relay';
/** The one TCP port reachable inside the namespace: the egress relay on 127.0.0.1. */
export const EGRESS_PORT = 3128;
/** The egress socket folder and relay name inside the masked core runtime folder. */
export const EGRESS_DIR_NAME = 'egress';
export const EGRESS_SOCKET_NAME = 'egress.sock';
export const EGRESS_RELAY_NAME = 'relay.mjs';
/** The host-side proxy environment the pane's command gets: only 127.0.0.1:3128 is reachable. */
export const EGRESS_PROXY_URL = `http://127.0.0.1:${EGRESS_PORT}`;
/** A CONNECT request line is tiny; anything larger is not an HTTP proxy handshake. */
export const HANDSHAKE_LIMIT = 16 * 1024;
/** The default relay source: this same wrapper, bound read-only into the pane. */
export const RELAY_SOURCE = fileURLToPath(import.meta.url);

/**
 * The fixed container runtime sockets this cut knows. The pure helper in the tests receives its
 * own explicit list, so a test never looks at (or needs) a live docker.sock.
 */
export const CONTAINER_RUNTIME_SOCKETS = Object.freeze([
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
]);

/**
 * The fixed container runtime sockets, plus the per-uid rootless Docker and Podman sockets when
 * the platform has a uid. The wrapper masks only those that exist inside this host's namespace.
 */
export function containerSocketPaths(uid = process.getuid?.()) {
  const paths = [...CONTAINER_RUNTIME_SOCKETS];
  if (typeof uid === 'number' && Number.isInteger(uid) && uid >= 0) {
    paths.push(`/run/user/${uid}/docker.sock`);
    paths.push(`/run/user/${uid}/podman/podman.sock`);
  }
  return paths;
}

/** Additional fixed runtime sockets, with the same launch-time mask as Docker and Podman. */
export const MORE_RUNTIME_SOCKETS = Object.freeze([
  '/var/run/crio/crio.sock',
  '/run/crio/crio.sock',
  '/run/k3s/containerd/containerd.sock',
  '/run/containerd/containerd.sock.ttrpc',
  '/run/buildkit/buildkitd.sock',
]);

/** All fixed runtime paths the wrapper checks by default. */
export function runtimeSocketPaths(uid) {
  return [...containerSocketPaths(uid), ...MORE_RUNTIME_SOCKETS];
}

/** Split the provider's argv at the first '--': the bwrap profile args, then the command. */
export function splitRunnerArgs(args) {
  const at = args.indexOf('--');
  if (at === -1) return { profileArgs: [...args], command: null };
  return { profileArgs: args.slice(0, at), command: args.slice(at + 1) };
}

/** Strip the wrapper's own leading --pack-root words: the profile args follow them. */
export function ownArgs(args) {
  let at = 0;
  let packRoot = null;
  while (at + 1 < args.length && args[at] === PACK_ROOT_FLAG) {
    packRoot = args[at + 1];
    at += 2;
  }
  return { packRoot, args: args.slice(at) };
}

/** Whether `dir` is `target` itself or one of its ancestors (both absolute paths). */
export function isSameOrAncestor(dir, target) {
  const rel = relative(dir, target);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/**
 * Why this platform cannot give a pane its own network namespace, or null on Linux. macOS and
 * Windows have no network namespaces: refusing is the only honest answer, and the sandbox switch
 * is never turned on there (README, "Platforms").
 */
export function netnsPlatformProblem(platform = process.platform) {
  if (platform === 'linux') return null;
  return `the pane's own network namespace is Linux-only and this host is ${platform}: `
    + 'refusing to start the pane on the host network';
}

/**
 * Whether bwrap can create a network namespace right now. This is the launch-time check the
 * design promises: a host without the privilege or the kernel support refuses the pane instead
 * of letting it run on the host network. `spawn` is injectable for the tests.
 */
export function netnsCapabilityProblem({
  bwrap = 'bwrap',
  execPath = process.execPath,
  spawn: spawnCheck = spawnSync,
} = {}) {
  const probe = spawnCheck(bwrap,
    [NETNS_FLAG, '--ro-bind', '/', '/', execPath, '-e', ''], { stdio: 'ignore', timeout: 15000 });
  if (probe?.error?.code === 'ENOENT') return 'bwrap is not installed: no pane network namespace';
  if (probe?.error) return `bwrap could not be started: ${probe.error.message}`;
  if (probe?.signal) return `the bwrap network-namespace check was killed (${probe.signal})`;
  if (probe?.status !== 0) {
    return `bwrap could not create a network namespace (exit ${probe?.status ?? '?'}): `
      + 'refusing to start the pane on the host network';
  }
  return null;
}

/**
 * The folder the host-side egress socket lives in: 0700, outside the sandbox, holding one
 * pane's socket. It must not be under the workspace-write profile's `--tmpfs /tmp`, because
 * bwrap resolves a bind source after that tmpfs: XDG_RUNTIME_DIR is the natural place, and the
 * user's home is the fallback. Never the host's /tmp by default.
 */
export function egressBase(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    try {
      if (statSync(runtime).isDirectory()) return runtime;
    } catch {
      // Fall through to the home folder.
    }
  }
  if (env.HOME && isAbsolute(env.HOME)) return env.HOME;
  return tmpdir();
}

/** The host-side egress folder: 0700, outside the sandbox, holding one pane's socket. */
export function makeEgressDir({ base = egressBase(), mkdtemp = mkdtempSync } = {}) {
  const dir = realpathSync(mkdtemp(join(base, 'am-egress-')));
  chmodSync(dir, 0o700);
  return { dir, socket: join(dir, EGRESS_SOCKET_NAME) };
}

/**
 * The fixed ranges that are never a public internet destination, expressed once as a
 * `net.BlockList` (Node's own address matcher) so both families are checked by one primitive.
 * IPv4-mapped IPv6 is folded to its IPv4 by normalizeAddress before it reaches this list: the
 * same host must be refused under every spelling (0:0:0:0:0:ffff:7f00:1 is 127.0.0.1).
 */
const V4_BLOCKED = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);
const V6_BLOCKED = Object.freeze([
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible forms
  ['64:ff9b::', 96], // NAT64: could embed a private v4
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]);
const BLOCKED = new BlockList();
for (const [base, bits] of V4_BLOCKED) BLOCKED.addSubnet(base, bits, 'ipv4');
for (const [base, bits] of V6_BLOCKED) BLOCKED.addSubnet(base, bits, 'ipv6');

/** A numeric IPv4 part as inet_aton reads it: 0x hex, a leading 0 octal, the rest decimal. */
const NUMERIC_LABEL = /^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[0-9]+)$/;

function ipv4Part(text) {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0[0-7]*$/.test(text)) return text.length === 1 ? 0 : Number.parseInt(text.slice(1), 8);
  if (/^[1-9][0-9]*$/.test(text)) return Number(text);
  return null;
}

/**
 * The dotted-quad IPv4 an inet_aton spelling denotes, or null when the text is not one. It
 * runs before any resolver, so `0177.0.0.1`, `0x7f.1` and `2130706433` are read as 127.0.0.1
 * here instead of being handed to a libc that may accept them after the check.
 */
function numericIpv4(text) {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values = parts.map(ipv4Part);
  if (values.some((value) => value === null || !Number.isSafeInteger(value))) return null;
  const [a, b, c, d] = values;
  let value;
  if (parts.length === 1) value = a;
  else if (parts.length === 2) {
    if (a > 255 || b > 0xffffff) return null;
    value = (a * 0x1000000) + b;
  } else if (parts.length === 3) {
    if (a > 255 || b > 255 || c > 0xffff) return null;
    value = (a * 0x1000000) + (b * 0x10000) + c;
  } else {
    if (values.some((part) => part > 255)) return null;
    value = (a * 0x1000000) + (b * 0x10000) + (c * 0x100) + d;
  }
  if (value > 0xffffffff) return null;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** The eight 16-bit words of an IPv6 spelling (zone id dropped), or null when it is not one. */
function ipv6Words(address) {
  const text = address.toLowerCase().replace(/%.*$/, '');
  if (isIP(text) !== 6) return null;
  const expand = (part) => {
    if (part === '') return [];
    const groups = part.split(':');
    const last = groups[groups.length - 1];
    if (last.includes('.')) {
      const quad = numericIpv4(last);
      if (quad === null) return null;
      const [a, b, c, d] = quad.split('.').map(Number);
      groups.splice(groups.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    const words = groups.map((word) => Number.parseInt(word, 16));
    return words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff) ? null : words;
  };
  const compressed = text.includes('::');
  const [left, right] = compressed ? text.split('::') : [text, null];
  const head = expand(left);
  const tail = right === null ? [] : expand(right);
  if (head === null || tail === null) return null;
  if (!compressed) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...Array(zeros).fill(0), ...tail];
}

/**
 * The canonical spelling of an address, before any range check: lower-case, zone id dropped,
 * the full IPv6 form expanded, and an IPv4-mapped IPv6 address folded to its IPv4. So
 * `127.0.0.1`, `0177.0.0.1` and `0x7f.1` all normalize to `127.0.0.1`, and
 * `0:0:0:0:0:ffff:c0a8:101` normalizes to `192.168.1.1`. null is not an address we accept.
 */
export function normalizeAddress(address) {
  if (typeof address !== 'string' || address === '') return null;
  const bare = address.toLowerCase().replace(/%.*$/, '');
  if (isIP(bare) === 4) return numericIpv4(bare);
  if (isIP(bare) === 6) {
    const mapped = mappedIpv4(bare);
    if (mapped !== null) return mapped;
    const words = ipv6Words(bare);
    return words === null ? null : words.map((word) => word.toString(16)).join(':');
  }
  return numericIpv4(bare);
}

/** The IPv4 address inside an IPv4-mapped IPv6 form (::ffff:1.2.3.4, 0:0:0:0:0:ffff:0102:0304). */
export function mappedIpv4(address) {
  if (typeof address !== 'string') return null;
  const words = ipv6Words(address);
  if (words === null) return null;
  if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return null;
  return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
}

/** An IPv4 address that is public unicast: not loopback, private, link-local, multicast or doc. */
export function isPublicIpv4(address) {
  const normalized = normalizeAddress(address);
  if (normalized === null || isIP(normalized) !== 4) return false;
  try {
    return !BLOCKED.check(normalized, 'ipv4');
  } catch {
    return false;
  }
}

/** An IPv6 address that is public unicast: not ::/96, mapped v4, ULA, link-local or multicast. */
export function isPublicIpv6(address) {
  if (typeof address !== 'string') return false;
  const bare = address.toLowerCase().replace(/%.*$/, '');
  if (isIP(bare) !== 6) return false;
  const mapped = mappedIpv4(bare);
  if (mapped !== null) return isPublicIpv4(mapped);
  const normalized = normalizeAddress(bare);
  if (normalized === null || isIP(normalized) !== 6) return false;
  try {
    return !BLOCKED.check(normalized, 'ipv6');
  } catch {
    return false;
  }
}

/** Whether an address is a public internet destination for the egress proxy. */
export function isPublicAddress(address, { hostAddresses = hostAddressSet() } = {}) {
  if (typeof address !== 'string') return false;
  const normalized = normalizeAddress(address);
  if (normalized === null) return false;
  // This host's own addresses are never an egress destination, whatever spelling they arrive in.
  const raw = address.toLowerCase();
  for (const entry of hostAddresses ?? []) {
    if (typeof entry !== 'string') continue;
    if (entry.toLowerCase() === raw || normalizeAddress(entry) === normalized) return false;
  }
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

/** Every address this host owns, normalized: the proxy never reaches the host itself. */
export function hostAddressSet(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (typeof entry?.address !== 'string') continue;
      addresses.add(entry.address.toLowerCase());
      const normalized = normalizeAddress(entry.address);
      if (normalized !== null) addresses.add(normalized);
    }
  }
  return addresses;
}

const failed = (args, message) => ({
  args: [...args], fatal: message, notices: [], masked: false, netns: false, egress: null,
});

/**
 * The one line the wrapper prints for a set, absolute proxy that is missing or not a Unix
 * socket. The pane still starts with no core socket, and the caller always hides the proxy's
 * folder. An unset or relative proxy is fatal in maskArgs, never a notice.
 */
export function proxyNotice(proxy, stat = statSync) {
  const tail = 'starting the pane with no herdr-core socket (hc will fail closed)';
  let info;
  try {
    info = stat(proxy);
  } catch {
    return `${PROXY_SOCKET} ${proxy} does not exist: ${tail}`;
  }
  if (!info.isSocket()) return `${PROXY_SOCKET} ${proxy} is not a Unix socket: ${tail}`;
  return null;
}

/** Socket paths explicitly named by container clients or the SSH agent. */
function envSocketPaths(env) {
  const paths = [];
  for (const host of [env.DOCKER_HOST, env.CONTAINER_HOST]) {
    if (typeof host !== 'string' || !host.startsWith('unix://')) continue;
    const path = host.slice('unix://'.length);
    if (isAbsolute(path)) paths.push(path);
  }
  if (typeof env.SSH_AUTH_SOCK === 'string' && isAbsolute(env.SSH_AUTH_SOCK)) {
    paths.push(env.SSH_AUTH_SOCK);
  }
  return paths;
}

function existingPath(path, realpath) {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/**
 * The pure helper the tests drive: given the runner argv and an environment, return the argv to
 * run, the fatal line (no bwrap run), or the one non-fatal notice (bwrap still runs, without a
 * proxy). `options.containerSockets` overrides the fixed defaults; env-named paths are always
 * checked. Tests can pass fixture paths or inject filesystem lookups. Socket masks apply to
 * readable endpoints at launch. `fatal` is a single unprefixed line; the CLI adds MSG_PREFIX.
 */
export function maskArgs(args, env = process.env, options = {}) {
  const {
    containerSockets = runtimeSocketPaths(options.uid),
    stat = statSync,
    realpath = realpathSync.native,
    packRoot = null,
    egressDir = null,
    relaySource = RELAY_SOURCE,
    execPath = process.execPath,
  } = options;
  if (env[SWITCH] !== '1') {
    return { args: [...args], fatal: null, notices: [], masked: false, netns: false, egress: null };
  }
  const platformProblem = netnsPlatformProblem(options.platform);
  if (platformProblem) return failed(args, platformProblem);
  const { profileArgs, command } = splitRunnerArgs(args);
  if (!command) {
    return failed(args,
      "the runner arguments have no '--' separator; refusing to guess the command");
  }
  // --unshare-all already unshares the network, so the wrapper adds no second switch beside it.
  // --share-net re-enables the host network and is order-sensitive in bwrap: with the network
  // already unshared by the profile it would leave the pane on the host network while the
  // wrapper skipped its own --unshare-net. Refuse that combination instead of trusting order.
  const unsharesNetwork = profileArgs.includes(NETNS_FLAG) || profileArgs.includes('--unshare-all');
  if (unsharesNetwork && profileArgs.includes('--share-net')) {
    return failed(args, 'the profile carries --share-net with the network unshared: bwrap would '
      + 'share the host network with the pane (refusing to start the pane on the host network)');
  }
  if (!env.HOME || !isAbsolute(env.HOME)) {
    return failed(args, 'HOME is not set to an absolute path: cannot hide ~/.ssh');
  }
  const real = env[REAL_SOCKET] || env.HC_TERMINAL_SOCKET;
  if (!real) {
    return failed(args,
      `${REAL_SOCKET} is not set (and HC_TERMINAL_SOCKET is absent): cannot hide the core socket`);
  }
  if (!isAbsolute(real)) return failed(args, `the real core socket path is not absolute: ${real}`);
  const realInputDir = dirname(real);
  const canonicalRealDir = existingPath(realInputDir, realpath);
  const realDir = canonicalRealDir ?? realInputDir;
  if (realInputDir === real || realInputDir === '/' || realDir === '/') {
    return failed(args, `the real core socket path has no folder of its own to hide: ${real}`);
  }
  const realDest = canonicalRealDir === null ? real : join(realDir, basename(real));
  const realTarget = existingPath(real, realpath);
  if (realTarget !== null && dirname(realTarget) !== realDir) {
    return failed(args, `the real core socket ${real} is a link to ${realTarget} outside its folder: `
      + 'the mask cannot hide it');
  }
  // Order matters: hide the real runtime folder; hide the proxy's shared host folder too (after
  // the bind, when the socket is live, so the bind resolved its source first); then ~/.ssh and
  // the runtime sockets, which are independent masks. The proxy path is not optional: without
  // it the wrapper cannot name the folder to hide, so another pane's proxy could be impersonated.
  const proxy = env[PROXY_SOCKET];
  if (!proxy) {
    return failed(args, `${PROXY_SOCKET} is not set: the shared proxy folder cannot be hidden `
      + "(another pane's proxy could be impersonated)");
  }
  if (!isAbsolute(proxy)) {
    return failed(args, `${PROXY_SOCKET} is not an absolute path: ${proxy}: the shared proxy `
      + "folder cannot be hidden (another pane's proxy could be impersonated)");
  }
  const proxyDir = dirname(proxy);
  const canonicalProxyDir = existingPath(proxyDir, realpath) ?? proxyDir;
  if (isSameOrAncestor(proxyDir, real) || isSameOrAncestor(canonicalProxyDir, realDest)) {
    return failed(args,
      `the proxy folder ${proxyDir} holds the real socket path: the mask would hide the proxy`);
  }
  // Hide the shared parent, not just this pane's folder: another pane's proxy stays out of
  // reach (same-uid sockets are otherwise indistinguishable), and only this pane's socket is
  // bound at the real path.
  const shared = dirname(proxyDir);
  if (shared === proxyDir || shared === '/') {
    return failed(args, `the proxy path ${proxy} has no shared automagik-hc-proxy parent`);
  }
  if (basename(shared) !== PROXY_ROOT_NAME) {
    return failed(args, `the proxy parent ${shared} is not the ${PROXY_ROOT_NAME} folder`);
  }
  const canonicalShared = existingPath(shared, realpath) ?? shared;
  if (isSameOrAncestor(shared, real) || isSameOrAncestor(canonicalShared, realDest)) {
    return failed(args, `the proxy parent ${shared} holds the real socket path: the mask would hide the real socket`);
  }
  if (isSameOrAncestor(realDir, canonicalShared)) {
    return failed(args, `the real core folder ${realDir} holds the proxy parent ${canonicalShared}: `
      + 'the mask would hide the proxy');
  }
  // The egress side: a 0700 host folder whose Unix socket is the egress proxy, and this same
  // wrapper file as the relay inside the namespace. Both are named by the caller (the CLI makes
  // the folder), so the pure helper can be driven by the tests without touching a live socket.
  if (!egressDir) {
    return failed(args, 'the egress folder is not set: the pane would have no egress proxy');
  }
  if (!isAbsolute(egressDir)) {
    return failed(args, `the egress folder is not an absolute path: ${egressDir}`);
  }
  let canonicalEgress;
  try {
    canonicalEgress = realpath(egressDir);
    if (!stat(canonicalEgress).isDirectory()) throw new Error('not a folder');
  } catch {
    return failed(args, `the egress folder ${egressDir} is not a readable folder`);
  }
  if (!relaySource || !isAbsolute(relaySource)) {
    return failed(args, `the egress relay source is not an absolute path: ${relaySource}`);
  }
  let canonicalRelay;
  try {
    canonicalRelay = realpath(relaySource);
    if (!stat(canonicalRelay).isFile()) throw new Error('not a file');
  } catch {
    return failed(args, `the egress relay source ${relaySource} is not a readable file`);
  }
  const mounts = ['--tmpfs', realDir];
  const notices = [];
  const notice = proxyNotice(proxy, stat);
  if (notice) notices.push(notice);
  else mounts.push('--bind', proxy, realDest);
  mounts.push('--tmpfs', canonicalShared);
  // The egress slot lives inside the masked core runtime folder (a tmpfs the wrapper just
  // mounted), so no host folder is shadowed for it and nothing else in the host's /run is
  // needed. The socket is the host-side proxy; relay.mjs is this wrapper, run in the pane.
  const egressInsideDir = join(realDir, EGRESS_DIR_NAME);
  const egressInside = join(egressInsideDir, EGRESS_SOCKET_NAME);
  const relayInside = join(egressInsideDir, EGRESS_RELAY_NAME);
  mounts.push('--dir', egressInsideDir);
  mounts.push('--bind', canonicalEgress, egressInsideDir);
  mounts.push('--bind', canonicalRelay, relayInside);
  // A profile may have hidden the leaf link with its own tmpfs. Recreate it using the exact
  // link text, which bwrap also accepts when the read-only root already has that link.
  try {
    if (lstatSync(realInputDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      mounts.push('--symlink', readlinkSync(realInputDir), realInputDir);
    }
  } catch {
    return failed(args, `the real core folder ${realInputDir} could not be checked for a symlink`);
  }
  const protectedPaths = ['/', realDir, canonicalShared, canonicalEgress, canonicalRelay];
  // The data parent (automagik-herdr: the stable execution folder and the approved rosters)
  // may sit inside the writable workspace/app home; shadow that grant with one read-only bind
  // of the parent after the profile, so both children stay outside a sandbox's writable set.
  if (packRoot !== null) {
    if (!isAbsolute(packRoot)) return failed(args, `${PACK_ROOT_FLAG} must be an absolute folder: ${packRoot}`);
    if (packRoot === '/') return failed(args, `${PACK_ROOT_FLAG} / would make the whole sandbox read-only`);
    let canonical;
    try {
      canonical = realpath(packRoot);
      if (!stat(canonical).isDirectory()) throw new Error('not a directory');
    } catch {
      return failed(args, `${PACK_ROOT_FLAG} ${packRoot} is not a readable folder`);
    }
    const parent = dirname(canonical);
    if (basename(canonical) !== 'dsh-sandbox' || basename(parent) !== 'automagik-herdr'
      || parent === '/' || parent === canonical) {
      return failed(args,
        `${PACK_ROOT_FLAG} ${packRoot} is not a <data home>/automagik-herdr/dsh-sandbox folder`);
    }
    for (const hidden of [realDir, canonicalShared]) {
      if (isSameOrAncestor(parent, hidden) || isSameOrAncestor(hidden, parent)) {
        return failed(args, `the pack data parent ${parent} overlaps the masked folder ${hidden}: refusing`);
      }
    }
    protectedPaths.push(parent);
    mounts.push('--ro-bind', parent, parent);
  }
  // ~/.ssh exists on most machines, but a fresh one may have none: then there is nothing to
  // hide. A directory (following symlinks) is shadowed; anything else is bound over.
  const ssh = join(env.HOME, '.ssh');
  try {
    const canonical = realpath(ssh);
    mounts.push(...(stat(canonical).isDirectory()
      ? ['--tmpfs', canonical]
      : ['--bind', '/dev/null', canonical]));
    protectedPaths.push(canonical);
  } catch {
    // No ~/.ssh (or no readable one): add no mask.
  }
  const seen = new Set();
  for (const candidate of [...containerSockets, ...envSocketPaths(env)]) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
    let canonical;
    let info;
    try {
      canonical = realpath(candidate);
      info = stat(canonical);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const covered = protectedPaths.find((path) => isSameOrAncestor(canonical, path));
    if (covered) return failed(args, `the socket path ${candidate} would cover ${covered}: refusing`);
    if (isSameOrAncestor(realDir, canonical) || isSameOrAncestor(canonicalShared, canonical)) continue;
    if (info.isDirectory()) mounts.push('--tmpfs', canonical);
    else mounts.push('--bind', '/dev/null', canonical);
  }
  // The pane's own network namespace. When the profile already unshares the network (or all
  // namespaces), it is there already and no second switch is added; a profile that also carries
  // --share-net was refused above. A lone --share-net is harmless here: the wrapper's own
  // --unshare-net comes later in argv and is the last word on the network.
  const netns = unsharesNetwork ? [] : [NETNS_FLAG];
  // The command runs behind the relay: the relay listens on the namespace's loopback at
  // EGRESS_PORT and forwards to the host-side egress proxy over the bound Unix socket.
  const relayCommand = [
    execPath, relayInside, RELAY_FLAG, egressInside, String(EGRESS_PORT), '--', ...command,
  ];
  return {
    args: [...profileArgs, ...netns, ...mounts, '--', ...relayCommand],
    fatal: null,
    notices,
    masked: true,
    netns: true,
    egress: { inside: egressInside, port: EGRESS_PORT, relay: relayInside },
  };
}

/**
 * The proxy environment the pane's command gets. Only 127.0.0.1:3128 is reachable inside the
 * namespace, so every proxy-aware client goes through the relay; NO_PROXY keeps the pane's own
 * loopback services out of the proxy.
 */
export function proxyEnvironment(env = process.env) {
  const no = '127.0.0.1,localhost,::1';
  return {
    ...env,
    HTTP_PROXY: EGRESS_PROXY_URL,
    http_proxy: EGRESS_PROXY_URL,
    HTTPS_PROXY: EGRESS_PROXY_URL,
    https_proxy: EGRESS_PROXY_URL,
    ALL_PROXY: EGRESS_PROXY_URL,
    all_proxy: EGRESS_PROXY_URL,
    NO_PROXY: no,
    no_proxy: no,
    NODE_USE_ENV_PROXY: '1',
  };
}

/** The host from a CONNECT target: `host:port`, `[v6]:port`, or a bare host (port defaults). */
export function parseConnectTarget(line) {
  const match = /^CONNECT (\S+) HTTP\/1\.[01]$/i.exec(line);
  if (!match) return null;
  const [host, portText] = splitHostPort(match[1]);
  if (!host) return null;
  const port = portText === null ? 443 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Separate a `host:port` word, keeping a bracketed IPv6 address whole. */
function splitHostPort(target) {
  if (target.startsWith('[')) {
    const close = target.indexOf(']');
    if (close === -1) return [null, null];
    const host = target.slice(1, close);
    const rest = target.slice(close + 1);
    if (rest === '') return [host, null];
    if (!rest.startsWith(':')) return [null, null];
    return [host, rest.slice(1)];
  }
  const colon = target.lastIndexOf(':');
  if (colon === -1) return [target, null];
  return [target.slice(0, colon), target.slice(colon + 1)];
}

/** The characters a plain DNS name may carry; anything else is refused, never resolved. */
const PLAIN_NAME = /^[a-z0-9._-]+$/;

/**
 * A CONNECT target host normalized before any range check: an address literal folded to its
 * canonical form, or a lower-case DNS name with its trailing dots dropped (`LOCALHOST.` becomes
 * `localhost`). Anything else - userinfo (`user@host`), brackets, a second port, a zone id on a
 * name, an unparseable numeric spelling - is refused here, never handed to a resolver.
 */
export function normalizeTargetHost(host) {
  if (typeof host !== 'string' || host === '') return null;
  const name = host.toLowerCase().replace(/\.+$/, '');
  if (name === '') return null;
  const address = normalizeAddress(name);
  if (address !== null) return { kind: 'ip', address, family: isIP(address) };
  // A spelling built only of numeric labels that did not parse is refused, not resolved: libc
  // may read some of these spellings (08.0.0.1, 999.0.0.1) differently than Node's parser.
  if (name.split('.').every((label) => NUMERIC_LABEL.test(label))) return null;
  if (name.length > 253 || !PLAIN_NAME.test(name)) return null;
  if (name.split('.').some((label) => label === '' || label.length > 63)) return null;
  return { kind: 'name', name };
}

/** RFC 6761 loopback names: never resolved, whatever a hosts file or a resolver says. */
export function isLoopbackName(name) {
  if (typeof name !== 'string') return false;
  const text = name.toLowerCase().replace(/\.+$/, '');
  return text === 'localhost' || text.endsWith('.localhost');
}

/**
 * The host-side egress proxy: one Unix socket, CONNECT only, and every destination resolved
 * and checked against the public-address rule before any host socket is opened. This is the
 * filter that keeps the pane's outbound access to the internet and off the host's loopback,
 * link-local and local networks.
 */
export function createEgressBroker({
  path,
  lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
  connect = (options) => netConnect(options),
  timeoutMs = 15000,
  hostAddresses = hostAddressSet(),
} = {}) {
  if (!path || !isAbsolute(path)) throw new Error('the egress socket path is not absolute');
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    client.on('error', () => {});
    client.setTimeout(timeoutMs, () => client.destroy());
    let handshake = Buffer.alloc(0);
    let consumed = false;
    let replied = false;
    const reply = (status, reason) => {
      if (replied) return;
      replied = true;
      client.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\n`
        + 'Connection: close\r\n\r\n');
    };
    const deny = () => reply(403, 'Forbidden');
    client.on('data', (chunk) => {
      if (consumed) return;
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > HANDSHAKE_LIMIT) {
        reply(431, 'Request Header Fields Too Large');
        return;
      }
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const line = handshake.subarray(0, end).toString('latin1').split('\r\n')[0];
      const target = parseConnectTarget(line);
      if (!target) {
        reply(405, 'Only CONNECT Is Allowed');
        return;
      }
      // Normalize the target host first, then run every range check on the normalized address.
      // Reserved loopback names never reach a resolver: a hosts file or a resolver that maps
      // them somewhere else must not turn them into an egress destination.
      const normalized = normalizeTargetHost(target.host);
      if (normalized === null
        || (normalized.kind === 'name' && isLoopbackName(normalized.name))) {
        deny();
        return;
      }
      consumed = true;
      client.pause();
      const rest = handshake.subarray(end + 4);
      // Resolve once, check the normalized address, and connect to that same literal: a name
      // that changes between the check and the connect cannot turn into a loopback or LAN
      // destination, because the resolver is never consulted again.
      (async () => {
        const addresses = normalized.kind === 'ip'
          ? [{ address: normalized.address, family: normalized.family }]
          : await lookup(normalized.name);
        const allowed = (Array.isArray(addresses) ? addresses : [addresses])
          .map((entry) => {
            const address = normalizeAddress(entry?.address);
            return address === null ? null : { address, family: isIP(address) };
          })
          .filter((entry) => entry !== null && isPublicAddress(entry.address, { hostAddresses }))
          .sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));
        if (allowed.length === 0) return deny();
        const pinned = allowed[0];
        const upstream = track(connect({
          host: pinned.address,
          port: target.port,
          family: pinned.family,
        }));
        upstream.on('error', () => {
          if (!client.destroyed) client.destroy();
        });
        upstream.setTimeout(timeoutMs, () => upstream.destroy());
        upstream.once('connect', () => {
          client.setTimeout(0);
          upstream.setTimeout(0);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length > 0) client.unshift(rest);
          client.resume();
          client.pipe(upstream);
          upstream.pipe(client);
        });
        client.once('close', () => upstream.destroy());
      })().catch(() => deny());
    });
  });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  return {
    server,
    close,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        chmodSync(path, 0o600);
        resolve();
      });
    }),
  };
}

/** Start the host-side egress proxy and wait until its socket is listening. */
export async function startEgressBroker(options) {
  const broker = createEgressBroker(options);
  await broker.listen();
  return broker;
}

/** Parse the relay's own words: `--egress-relay <socket> <port> -- <command...>`. */
export function parseRelayArgs(argv) {
  if (argv[0] !== RELAY_FLAG) return null;
  const at = argv.indexOf('--', 1);
  if (at === -1) return { error: "the egress relay has no '--' before the command" };
  const [socket, portText] = argv.slice(1, at);
  if (!socket || !isAbsolute(socket)) {
    return { error: `the egress relay socket is not absolute: ${socket ?? '(none)'}` };
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `the egress relay port is not valid: ${portText ?? '(none)'}` };
  }
  const command = argv.slice(at + 1);
  if (command.length === 0) return { error: 'the egress relay has no command after --' };
  return { socket, port, command };
}

/**
 * The relay inside the pane's network namespace: a dumb TCP-to-Unix forwarder on the
 * namespace's loopback. It runs the pane's command as its child, so the pane's pid 1 is the
 * relay and the pane ends when the command does. The host-side broker does all the filtering;
 * a forward that cannot reach it answers 502 and closes, never falls back to a host route.
 */
export function startRelay({
  socket,
  port,
  command,
  spawn: spawnChild = spawn,
  log = process.stderr,
  onListening = null,
  forwardSignals = true,
} = {}) {
  let child = null;
  const server = createServer((client) => {
    const upstream = netConnect(socket);
    upstream.on('error', () => {
      if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n'
          + 'Connection: close\r\n\r\n');
      }
    });
    upstream.once('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  server.once('error', (error) => {
    log.write(`${MSG_PREFIX}the egress relay cannot listen on 127.0.0.1:${port}: `
      + `${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    if (onListening) onListening(server);
    child = spawnChild(command[0], command.slice(1), { stdio: 'inherit' });
    child.on('error', (error) => {
      log.write(`${MSG_PREFIX}the egress relay cannot start the pane command: `
        + `${error.message}\n`);
      process.exit(127);
    });
    if (forwardSignals) {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
        process.on(signal, () => {
          try {
            child?.kill(signal);
          } catch {
            // The child is already gone.
          }
        });
      }
    }
    child.on('exit', (code, signal) => {
      server.close();
      // The relay is PID 1 of the pane's pid namespace: a signal sent to itself would be
      // ignored there, so a signalled command ends the pane with a plain failure code.
      process.exit(signal ? 1 : (code ?? 1));
    });
  });
  return server;
}

/** Exec bwrap with inherited stdio, forwarding signals and the child's exit code. */
export function runBwrap(args, env = process.env) {
  const child = spawn('bwrap', args, { stdio: 'inherit', env });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone; the exit handler below forwards its status.
    }
  };
  for (const signal of signals) process.on(signal, forward);
  const stop = () => {
    for (const signal of signals) process.off(signal, forward);
  };
  child.on('error', (error) => {
    stop();
    process.stderr.write(`${MSG_PREFIX}cannot start bwrap: ${error.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    stop();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  return child;
}

const prefix = (line) => `${MSG_PREFIX}${line}\n`;

/** The pane's sandbox launch: platform and namespace check, egress proxy, then bwrap. */
async function launch(argv, env = process.env) {
  const own = ownArgs(argv);
  const masked = env[SWITCH] === '1';
  let egress = null;
  let broker = null;
  const cleanup = () => {
    try {
      broker?.close();
    } catch {
      // Nothing to close.
    }
    if (egress) {
      try {
        rmSync(egress.dir, { recursive: true, force: true });
      } catch {
        // The run is already ending.
      }
    }
  };
  if (masked) {
    const problem = netnsPlatformProblem() ?? netnsCapabilityProblem();
    if (problem) {
      process.stderr.write(prefix(problem));
      process.exit(1);
    }
    try {
      egress = makeEgressDir();
    } catch (error) {
      process.stderr.write(prefix(`the egress folder could not be made: ${error.message}`));
      process.exit(1);
    }
  }
  const result = maskArgs(own.args, env, {
    packRoot: own.packRoot,
    egressDir: egress?.dir ?? null,
  });
  for (const notice of result.notices) process.stderr.write(prefix(notice));
  if (result.fatal) {
    cleanup();
    process.stderr.write(prefix(result.fatal));
    process.exit(1);
  }
  if (!result.netns) {
    runBwrap(result.args);
    return;
  }
  try {
    broker = await startEgressBroker({ path: egress.socket });
  } catch (error) {
    cleanup();
    process.stderr.write(prefix(`the egress proxy could not start: ${error.message}`));
    process.exit(1);
  }
  process.once('exit', cleanup);
  runBwrap(result.args, proxyEnvironment(env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = parseRelayArgs(process.argv.slice(2));
  if (relay) {
    if (relay.error) {
      process.stderr.write(prefix(relay.error));
      process.exitCode = 1;
    } else {
      startRelay(relay);
    }
  } else {
    await launch(process.argv.slice(2));
  }
}
