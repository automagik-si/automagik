#!/usr/bin/env bun
/**
 * Upgrade an installed Automagik host to a published release — version-agnostic.
 *
 * The repo has no official "upgrade the instance" command (docs/upgrade.md): a release is a
 * set of integrity-checked plugin tarballs plus a signed lane, and an installed host is the
 * DSH runtime under `runtime/` plus the `web` profile under `$DSH_HOME/profiles/web`. This
 * script turns the one-off 3.41.0 -> 3.48.0 runbook into a repeatable process:
 *
 *   1. detect the latest release (`gh api .../releases/latest`), or take `--to <tag>`;
 *   2. verify the signed lane and every release tarball against PLUGINS.SHA256SUMS;
 *   3. back up the live profile, runtime, cordis files, lockfile and install receipt;
 *   4. stop the service, stage the runtime and swap `runtime` atomically (temp symlink + mv -T);
 *   5. re-add every release tarball the profile already installs through `dsh plugin`;
 *   6. regenerate `cordis.yml` from the patched source and fail loudly if a hand edit in
 *      `cordis.patch.yml` is lost (in particular the disabled dsh-subscriptions block);
 *   7. start the service and smoke-check unit, auth fence, Caddy, versions and plugin entries;
 *   8. roll back automatically on any failure and print one unambiguous RESULT line.
 *
 * Old `releases/<version>/` directories are never deleted and backups are never removed.
 *
 *   bun scripts/upgrade.ts --check              read-only: what would upgrade, and is it safe
 *   bun scripts/upgrade.ts --dry-run            print every step and command, change nothing
 *   bun scripts/upgrade.ts                      upgrade to the latest release
 *   bun scripts/upgrade.ts --to v3.49.0         upgrade (or re-check) one explicit release
 *   bun scripts/upgrade.ts --help
 *
 * It is a Bun/TypeScript script, not a shell script, because `scripts/` is TypeScript run by
 * Bun (AGENTS.md: "Bun for the repository's tooling (`scripts/`, `bun test`)"), and because
 * the lane verification and the hand-edit checks are shared, tested code (scripts/upgrade.test.ts)
 * rather than another copy of ed25519/YAML logic. It needs `gh`, passwordless `sudo`, `node`
 * and Bun >= 1.2.21 (Bun.YAML, Bun.semver).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_PLUGINS, verifyLane, ROOT as REPO_ROOT, type Lane } from './lane';

const REPO = 'automagik-si/automagik';
const PUBLIC_REPO = `https://github.com/${REPO}`;

/** This host's home directory, the base of every default path below. */
const HOME = homedir();

/** The host layout; every path can be overridden from the environment. */
export const DEFAULTS = {
  automagikHome: join(HOME, 'prod', 'automagik'),
  dshHome: join(HOME, '.automagik', 'web', 'dsh'),
  profile: 'web',
  service: 'automagik-web',
  publicUrl: 'https://ia.escoladofluxo.com/',
  healthUrl: 'http://127.0.0.1:8080',
  backupRoot: join(HOME, 'prod', 'automagik', 'backups'),
} as const;

/** A release's plugins.json (also the shape docs/upgrade.md describes). */
export interface ReleasePlugins {
  repository: string;
  version: string;
  commit: string;
  packages: Record<string, { version: string; file: string; integrity: string; size: number }>;
}

export interface ReleaseAsset {
  name: string;
  size: number;
  digest?: string;
}

export interface ReleaseInfo {
  tagName: string;
  publishedAt: string;
  isPrerelease: boolean;
  assets: ReleaseAsset[];
}

export interface Options {
  check: boolean;
  dryRun: boolean;
  to?: string;
  help: boolean;
  automagikHome: string;
  dshHome: string;
  profile: string;
  service: string;
  publicUrl: string;
  healthUrl: string;
  backupRoot: string;
}

export interface State {
  profileDir: string;
  runtimeLink: string;
  runtimeTarget: string;
  dshVersion: string;
  currentVersion: string;
  installed: Record<string, string>;
  dependencies: Record<string, string>;
  bundles: string[];
  serviceActive: boolean;
  mainPid: string;
  cordisPatchSha: string;
}

/** One installed release tarball to re-add through `dsh plugin`. */
export interface PluginTarball {
  name: string;
  version: string;
  file: string;
  integrity: string;
  size: number;
}

// ---------------------------------------------------------------------------------------------
// Small, pure helpers (unit-tested in scripts/upgrade.test.ts)
// ---------------------------------------------------------------------------------------------

/** `v3.49.0` -> `3.49.0`; refuses anything that is not a 3.N.P release. */
export function normalizeVersion(input: string): string {
  const version = input.startsWith('v') ? input.slice(1) : input;
  if (!/^3\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(version)) {
    throw new Error(`not a release version: ${input} (want v3.N.P)`);
  }
  return version;
}

export const tagOf = (version: string): string => `v${normalizeVersion(version)}`;

/** Whether a string is a release version this tool can compare. */
export function isRelease(value: string): boolean {
  return /^3\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value);
}

/** Compare two 3.N.P releases: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split('.').map(Number);
  const right = normalizeVersion(b).split('.').map(Number);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** A backup directory name: never overwritten, timestamped in UTC. */
export function backupDirName(version: string, stamp: string): string {
  return `upgrade-${normalizeVersion(version)}-${stamp}`;
}

/** `20261030-010500Z`, the stamp every backup and staged directory carries. */
export function utcStamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z`;
}

/** Parse a `sha256sum`-style PLUGINS.SHA256SUMS into filename -> lowercase hex digest. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** The release tarballs an installed profile should re-add: the release packages it depends on. */
export function pluginsToInstall(plugins: ReleasePlugins, dependencies: Record<string, string>): PluginTarball[] {
  return Object.entries(plugins.packages)
    .filter(([name]) => Object.hasOwn(dependencies, name) && !SERVER_PLUGINS.some(plugin => name === `@automagik/${plugin}`))
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Packages a release carries that this profile does not install: left exactly as they are. */
export function pluginsLeftAlone(plugins: ReleasePlugins, dependencies: Record<string, string>): string[] {
  return Object.keys(plugins.packages)
    .filter((name) => !Object.hasOwn(dependencies, name))
    .sort();
}

/** A release asset that would carry a prebuilt DSH runtime, if the release ever grows one. */
export function runtimeAssetName(assets: ReleaseAsset[]): string | undefined {
  return assets.find((asset) => /(?:^|[-_.])(?:runtime)(?:[-_.]|$)/i.test(asset.name) && /\.(?:tgz|tar\.gz|tar\.zst)$/i.test(asset.name))?.name;
}

/** The release's DSH range as declared by the first of its plugins (all agree in a release). */
export function laneDshRange(lane: Lane): string | undefined {
  return lane.plugins[0]?.engines.dsh ?? lane.addons?.[0]?.engines.dsh;
}

/** Whether every entry of `patch` is present, unchanged, in `composed`. Arrays replace, objects merge. */
export function deepSubset(patch: unknown, composed: unknown): boolean {
  if (patch === null || typeof patch !== 'object') return Object.is(patch, composed);
  if (Array.isArray(patch)) {
    if (!Array.isArray(composed) || composed.length !== patch.length) return false;
    return patch.every((value, index) => deepEqual(value, composed[index]));
  }
  if (composed === null || typeof composed !== 'object' || Array.isArray(composed)) return false;
  const wanted = patch as Record<string, unknown>;
  const actual = composed as Record<string, unknown>;
  return Object.keys(wanted).every((key) => Object.hasOwn(actual, key) && deepSubset(wanted[key], actual[key]));
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== 'object') return Object.is(left, right);
  if (Array.isArray(left)) {
    return Array.isArray(right) && right.length === left.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (right === null || typeof right !== 'object' || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** Parse a YAML document through Bun's parser, with a clear message when Bun is too old. */
export function parseYaml(text: string): unknown {
  const bun = (globalThis as unknown as { Bun?: { YAML?: { parse(document: string): unknown } } }).Bun;
  if (!bun?.YAML?.parse) throw new Error('bun: Bun.YAML is unavailable; upgrade Bun to >= 1.2.21');
  return bun.YAML.parse(text);
}

/** npm-style semver range check through Bun, with a clear message when Bun is too old. */
export function semverSatisfies(version: string, range: string): boolean {
  const bun = (globalThis as unknown as { Bun?: { semver?: { satisfies(version: string, range: string): boolean } } }).Bun;
  if (!bun?.semver?.satisfies) throw new Error('bun: Bun.semver is unavailable; upgrade Bun to >= 1.2.21');
  return bun.semver.satisfies(version, range);
}

function composedEntries(composedText: string): Map<string, unknown> {
  const composed = parseYaml(composedText);
  if (!Array.isArray(composed)) throw new Error('the composed profile is not a YAML list');
  const entries = new Map<string, unknown>();
  for (const entry of composed) {
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      entries.set((entry as { id: string }).id, entry);
    }
  }
  return entries;
}

/**
 * Every hand edit in cordis.patch.yml must survive in the composed tree *verbatim*: an entry's
 * id and all of its fields (an `insert`'s items included). Returns one human-readable problem
 * per lost edit, so the caller can fail loudly instead of silently dropping the user's layer.
 */
export function handEditViolations(patchText: string, composedText: string): string[] {
  const patch = parseYaml(patchText);
  if (!Array.isArray(patch)) throw new Error('cordis.patch.yml is not a YAML list');
  const entries = composedEntries(composedText);
  const violations: string[] = [];
  for (const [index, item] of patch.entries()) {
    if (!item || typeof item !== 'object') {
      violations.push(`cordis.patch.yml entry ${index} is not a mapping`);
      continue;
    }
    const insert = (item as { insert?: unknown }).insert;
    if (insert !== undefined) {
      if (!Array.isArray(insert)) {
        violations.push(`cordis.patch.yml entry ${index}: insert is not a list`);
        continue;
      }
      for (const inserted of insert) {
        const id = (inserted as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') {
          violations.push(`cordis.patch.yml entry ${index}: an insert has no id`);
          continue;
        }
        const found = entries.get(id);
        if (found === undefined) violations.push(`insert ${id} is missing from the composed config`);
        else if (!deepSubset(inserted, found)) violations.push(`insert ${id} lost fields in the composed config`);
      }
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') {
      violations.push(`cordis.patch.yml entry ${index} has no id`);
      continue;
    }
    const found = entries.get(id);
    if (found === undefined) violations.push(`${id} is missing from the composed config`);
    else if (!deepSubset(item, found)) violations.push(`${id} does not carry the patch verbatim in the composed config`);
  }
  return violations;
}

/** The specific hand edit the host depends on: the installed-but-disabled Subscriptions addon. */
export function subscriptionsDisabled(composedText: string): boolean {
  const entry = composedEntries(composedText).get('dsh-subscriptions');
  return Boolean(entry && typeof entry === 'object' && (entry as { disabled?: unknown }).disabled === true);
}

/** The `- id: dsh-subscriptions / disabled: true` block must still be in cordis.patch.yml itself. */
export function subscriptionsPatchPresent(patchText: string): boolean {
  const patch = parseYaml(patchText);
  if (!Array.isArray(patch)) return false;
  return patch.some((item) => Boolean(item && typeof item === 'object' && (item as { id?: unknown }).id === 'dsh-subscriptions' && (item as { disabled?: unknown }).disabled === true));
}

/** sha256 of a file's bytes, lowercase hex. */
export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** sha512 Subresource Integrity of a file, as plugins.json and the lane write it. */
export function integrityOf(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

/** The one line a cron job or a human greps for at the end of every run. */
export function resultLine(outcome: 'OK' | 'FAILED', fields: Record<string, string | number | undefined>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`);
  return `RESULT: ${outcome} ${parts.join(' ')}`.trim();
}

// ---------------------------------------------------------------------------------------------
// Host IO
// ---------------------------------------------------------------------------------------------

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

function exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): ExecResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function must(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = exec(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join(' | ');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${detail || 'no output'}`);
  }
  return result.stdout;
}

/** A root operation; `-n` fails instead of hanging when sudo would prompt. */
function root(...args: string[]): string {
  return must('sudo', ['-n', ...args]);
}

/** sha256 of a path only root can read (the 0700 backup directory). */
function rootSha256(path: string): string {
  return root('sha256sum', path).trim().split(/\s+/)[0];
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(label: string, predicate: () => boolean, timeoutMs = 60_000, intervalMs = 1_000): void {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    sleep(intervalMs);
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

function systemctlIsActive(service: string): boolean {
  return exec('systemctl', ['is-active', service]).stdout.trim() === 'active';
}

function systemctlMainPid(service: string): string {
  return exec('systemctl', ['show', '-p', 'MainPID', '--value', service]).stdout.trim();
}

function systemctlStart(service: string): void {
  root('systemctl', 'start', service);
}

function systemctlStop(service: string): void {
  if (!systemctlIsActive(service)) return;
  root('systemctl', 'stop', service);
  waitFor(`${service} to stop`, () => !systemctlIsActive(service), 60_000);
}

/** HTTP status through curl; `000` when nothing answered. */
function httpCode(url: string, timeoutSec = 8): string {
  const result = exec('curl', ['-sS', '-m', String(timeoutSec), '-o', '/dev/null', '-w', '%{http_code}', url]);
  return result.stdout.trim() || '000';
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(must('gh', args));
}

function resolveTarget(options: Options): { version: string; tag: string; release: ReleaseInfo } {
  const tag = options.to
    ? tagOf(options.to)
    : must('gh', ['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name']).trim();
  const version = normalizeVersion(tag);
  const release = ghJson<ReleaseInfo>(['release', 'view', tag, '-R', REPO, '--json', 'tagName,publishedAt,isPrerelease,assets']);
  if (release.isPrerelease) throw new Error(`${tag} is marked prerelease; refusing to upgrade to it`);
  return { version, tag, release };
}

function readState(options: Options): State {
  const profileDir = join(options.dshHome, 'profiles', options.profile);
  if (!existsSync(join(profileDir, 'package.json'))) throw new Error(`no ${options.profile} profile at ${profileDir}`);
  const runtimeLink = join(options.automagikHome, 'runtime');
  if (!existsSync(runtimeLink)) throw new Error(`no runtime symlink at ${runtimeLink}`);
  const runtimeTarget = realpathSync(runtimeLink);
  const dshPkg = join(runtimeTarget, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!existsSync(dshPkg)) throw new Error(`${runtimeTarget} is not a DSH runtime (no @deepseek-ai/dsh)`);
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  const dependencies = profile.dependencies ?? {};
  const installed: Record<string, string> = {};
  for (const name of Object.keys(dependencies)) {
    const manifest = join(profileDir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      try {
        installed[name] = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'unknown';
      } catch {
        installed[name] = 'unknown';
      }
    }
  }
  const currentVersion =
    installed['@automagik/bots-dsh'] ?? /releases\/(\d+\.\d+\.\d+)\/runtime/.exec(runtimeTarget)?.[1] ?? 'unknown';
  return {
    profileDir,
    runtimeLink,
    runtimeTarget,
    dshVersion: (JSON.parse(readFileSync(dshPkg, 'utf8')) as { version: string }).version,
    currentVersion,
    installed,
    dependencies,
    bundles: profile.dsh?.profile?.bundles ?? [],
    serviceActive: systemctlIsActive(options.service),
    mainPid: systemctlMainPid(options.service),
    cordisPatchSha: sha256(join(profileDir, 'cordis.patch.yml')),
  };
}

function dshBin(runtimeTarget: string): string {
  return join(runtimeTarget, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function dshEnv(options: Options): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: options.dshHome,
    PATH: `${join(options.automagikHome, 'runtime', 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
  };
}

/** Run DSH's own composition (`--dump-config`) and return the composed YAML text. */
function dumpComposed(options: Options): string {
  const runtime = realpathSync(join(options.automagikHome, 'runtime'));
  return must('node', [dshBin(runtime), '--profile', options.profile, '--dump-config'], {
    cwd: options.automagikHome,
    env: dshEnv(options),
  });
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function preflight(options: Options, needsSudo = true): void {
  for (const command of ['gh', 'node', 'curl', 'tar', 'cp', 'mv', 'ln', 'systemctl', 'sudo']) {
    if (exec('sh', ['-c', `command -v ${command}`]).status !== 0) throw new Error(`missing required command: ${command}`);
  }
  if (needsSudo) must('sudo', ['-n', 'true']);
  must('gh', ['auth', 'status']);
  if (freeBytes(options.automagikHome) < 2 * 1024 ** 3) throw new Error(`less than 2 GiB free under ${options.automagikHome}`);
}

function downloadManifests(release: ReleaseInfo, into: string): void {
  mkdirSync(into, { recursive: true });
  must('gh', [
    'release', 'download', release.tagName, '-R', REPO, '-D', into, '--clobber',
    '-p', 'lane.json', '-p', 'lane.json.sig', '-p', 'plugins.json', '-p', 'PLUGINS.SHA256SUMS',
  ]);
}

function downloadTarballs(release: ReleaseInfo, plugins: PluginTarball[], into: string): void {
  for (const plugin of plugins) {
    must('gh', ['release', 'download', release.tagName, '-R', REPO, '-D', into, '--clobber', '-p', plugin.file]);
  }
}

/**
 * Verify the signed lane, the release tarballs against PLUGINS.SHA256SUMS, and the lane's own
 * sha256/integrity for each file; then check the DSH engines range against the installed DSH.
 */
function verifyRelease(version: string, dir: string, dshVersion: string, plugins: PluginTarball[]): Lane {
  const lanePath = join(dir, 'lane.json');
  const sigPath = join(dir, 'lane.json.sig');
  const keysPath = join(REPO_ROOT, 'plugin-lane', 'keys.json');
  const keys = (JSON.parse(readFileSync(keysPath, 'utf8')) as { keys: { keyId: string; publicKey: string }[] }).keys;
  const lane = verifyLane(readFileSync(lanePath), readFileSync(sigPath, 'utf8'), keys);
  if (lane.publisher !== 'automagik') throw new Error(`lane.publisher is ${lane.publisher}`);
  if (lane.version !== version) throw new Error(`lane is ${lane.version}, expected ${version}`);

  const manifest = JSON.parse(readFileSync(join(dir, 'plugins.json'), 'utf8')) as ReleasePlugins;
  if (manifest.version !== version) throw new Error(`plugins.json is ${manifest.version}, expected ${version}`);
  if (manifest.commit !== lane.commit) throw new Error(`lane commit ${lane.commit} != plugins.json commit ${manifest.commit}`);
  const sums = parseChecksums(readFileSync(join(dir, 'PLUGINS.SHA256SUMS'), 'utf8'));
  const laneByName = new Map(lane.plugins.map((plugin) => [plugin.name, plugin]));
  for (const plugin of plugins) {
    const expected = sums.get(plugin.file);
    if (!expected) throw new Error(`${plugin.file} is not in PLUGINS.SHA256SUMS`);
    const actual = sha256(join(dir, plugin.file));
    if (actual !== expected) throw new Error(`${plugin.file}: sha256 ${actual} != PLUGINS.SHA256SUMS ${expected}`);
    const laneEntry = laneByName.get(plugin.name);
    if (!laneEntry) throw new Error(`${plugin.name} is not in the signed lane`);
    if (laneEntry.sha256 !== actual) throw new Error(`${plugin.file}: sha256 ${actual} != lane ${laneEntry.sha256}`);
    if (laneEntry.integrity !== integrityOf(join(dir, plugin.file))) throw new Error(`${plugin.file}: integrity != lane integrity`);
    if (manifest.packages[plugin.name]?.integrity !== laneEntry.integrity) throw new Error(`${plugin.name}: plugins.json integrity != lane integrity`);
    if (!semverSatisfies(dshVersion, laneEntry.engines.dsh)) {
      throw new Error(`${plugin.name} needs DSH ${laneEntry.engines.dsh}; the installed runtime is ${dshVersion}`);
    }
  }
  return lane;
}

function writeBaseline(dir: string, state: State, target: string): void {
  const text = [
    `target=${target}`,
    `from=${state.currentVersion}`,
    `dsh=${state.dshVersion}`,
    `runtime_link=${state.runtimeLink}`,
    `runtime_target=${state.runtimeTarget}`,
    `service_active=${String(state.serviceActive)}`,
    `main_pid=${state.mainPid}`,
    `profile_package_json_sha256=${sha256(join(state.profileDir, 'package.json'))}`,
    `profile_cordis_patch_sha256=${state.cordisPatchSha}`,
    `profile_cordis_yml_sha256=${sha256(join(state.profileDir, 'cordis.yml'))}`,
    `profile_pnpm_lock_sha256=${sha256(join(state.profileDir, 'pnpm-lock.yaml'))}`,
    ...Object.entries(state.dependencies).map(([name, spec]) => `dependency.${name}=${spec}`),
    ...Object.entries(state.installed).map(([name, version]) => `installed.${name}=${version}`),
    ...state.bundles.map((bundle) => `bundle=${bundle}`),
  ].join('\n');
  const temp = join(tmpdir(), `automagik-baseline-${utcStamp()}.txt`);
  writeFileSync(temp, `${text}\n`);
  try {
    root('cp', '-a', temp, join(dir, 'baseline.txt'));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The pre-change backup the runbook promises: profile, runtime, config, lockfile, receipts. */
function backup(state: State, target: string, options: Options): string {
  const dir = join(options.backupRoot, backupDirName(target, utcStamp()));
  root('mkdir', '-p', dir);
  root('mkdir', '-p', join(dir, 'profile'));
  for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']) {
    root('cp', '-a', join(state.profileDir, file), join(dir, 'profile', file));
  }
  // A second, full copy of the profile without the reinstallable node_modules, for rollback.
  root('tar', '-C', state.profileDir, '-czf', join(dir, `profile-before-${state.currentVersion}.tgz`), '--exclude=node_modules', '.');
  // The runtime tree that the symlink points at, before any swap.
  root('tar', '-C', state.runtimeTarget, '-czf', join(dir, `runtime-before-${state.currentVersion}.tgz`), '.');
  for (const receipt of [join(options.automagikHome, 'installation-receipt.json'), join(options.automagikHome, 'releases', state.currentVersion, 'upgrade-receipt.json')]) {
    if (existsSync(receipt)) root('cp', '-a', receipt, join(dir, receipt.endsWith('installation-receipt.json') ? 'installation-receipt.json' : 'upgrade-receipt-before.json'));
  }
  writeBaseline(dir, state, target);
  return dir;
}

/** Stage `releases/<target>/runtime` without touching the live symlink yet. */
function stageRuntime(version: string, release: ReleaseInfo, state: State, options: Options, dist: string): string {
  const releaseDir = join(options.automagikHome, 'releases', version);
  const target = join(releaseDir, 'runtime');
  if (existsSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    return target;
  }
  mkdirSync(releaseDir, { recursive: true });
  const staging = join(releaseDir, `.runtime-staging-${utcStamp()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const assetName = runtimeAssetName(release.assets ?? []);
    if (assetName) {
      // A future release may ship a prebuilt runtime: fetch, verify against SHA256SUMS, extract.
      must('gh', ['release', 'download', release.tagName, '-R', REPO, '-D', dist, '--clobber', '-p', assetName]);
      const sumsFile = join(dist, 'SHA256SUMS');
      if (existsSync(sumsFile)) {
        const expected = parseChecksums(readFileSync(sumsFile, 'utf8')).get(assetName);
        if (expected && expected !== sha256(join(dist, assetName))) throw new Error(`${assetName}: sha256 mismatch`);
      }
      must('tar', ['-xf', join(dist, assetName), '-C', staging]);
    } else {
      // No runtime artifact in the release: carry the running DSH runtime forward unchanged,
      // exactly as the host's own 3.49.0 release directory was built.
      must('cp', ['-a', `${state.runtimeTarget}/.`, staging]);
    }
    const dshPackage = [
      join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(staging, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ].find((candidate) => existsSync(candidate));
    if (!dshPackage) throw new Error('staged runtime has no node_modules/@deepseek-ai/dsh');
    const stagedDsh = (JSON.parse(readFileSync(dshPackage, 'utf8')) as { version: string }).version;
    if (stagedDsh !== state.dshVersion) throw new Error(`staged runtime has DSH ${stagedDsh}, live runtime has ${state.dshVersion}`);
    // Move the checked staging tree to its final name; the symlink swap below is the atomic step.
    if (existsSync(target)) throw new Error(`${target} appeared while staging; refusing to overwrite it`);
    renameSync(dshPackage.includes('/runtime/node_modules/') ? join(staging, 'runtime') : staging, target);
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Repoint `runtime` atomically: a fresh temp symlink, then `mv -T` over the root-owned one. */
function repointRuntime(target: string, options: Options): void {
  const link = join(options.automagikHome, 'runtime');
  const temp = join(options.automagikHome, `.runtime-next-${utcStamp()}`);
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  try {
    root('mv', '-T', temp, link);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Re-add every release tarball this profile installs through DSH, then verify the pins. */
function installPlugins(plugins: PluginTarball[], version: string, dist: string, options: Options): void {
  const runtime = realpathSync(join(options.automagikHome, 'runtime'));
  for (const plugin of plugins) {
    must('node', [dshBin(runtime), 'plugin', '--profile', options.profile, 'add', `file:${join(dist, plugin.file)}`], {
      cwd: options.automagikHome,
      env: dshEnv(options),
    });
    const installed = JSON.parse(readFileSync(join(options.dshHome, 'profiles', options.profile, 'node_modules', plugin.name, 'package.json'), 'utf8')) as { version: string };
    if (installed.version !== plugin.version) throw new Error(`${plugin.name} installed ${installed.version}, expected ${plugin.version}`);
  }
  const profile = JSON.parse(readFileSync(join(options.dshHome, 'profiles', options.profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const plugin of plugins) {
    const pin = profile.dependencies?.[plugin.name] ?? '';
    if (!pin.includes(`/releases/${version}/dist/`)) throw new Error(`${plugin.name} pins ${pin}, not the ${version} release tarball`);
  }
}

/**
 * Regenerate cordis.yml from the patched source (DSH's own `--dump-config` over the bundles and
 * cordis.patch.yml), then prove every hand edit survived. DSH rewrites cordis.yml to its
 * canonical empty-root stub on the next boot; the durable hand-edit layer is cordis.patch.yml,
 * which this step refuses to let the upgrade alter.
 */
function regenerateCordis(state: State, backupDir: string, options: Options): string {
  const patchPath = join(state.profileDir, 'cordis.patch.yml');
  const patchText = readFileSync(patchPath, 'utf8');
  if (sha256(patchPath) !== state.cordisPatchSha) throw new Error('cordis.patch.yml changed during the upgrade (the live GUI expects the profile lock?)');
  if (!subscriptionsPatchPresent(patchText)) throw new Error('cordis.patch.yml lost the dsh-subscriptions disabled block');
  const composed = dumpComposed(options);
  const violations = handEditViolations(patchText, composed);
  if (violations.length > 0) {
    throw new Error(`cordis.patch.yml hand edits would be lost: ${violations.join('; ')}`);
  }
  if (!subscriptionsDisabled(composed)) throw new Error('the composed config no longer disables dsh-subscriptions');
  // The regenerated tree, as the task asks: cordis.yml written from the patched source.
  writeFileSync(join(state.profileDir, 'cordis.yml'), composed);
  const record = join(tmpdir(), `automagik-cordis-${utcStamp()}.yml`);
  writeFileSync(record, composed);
  try {
    root('cp', '-a', record, join(backupDir, 'cordis-after-regeneration.yml'));
  } finally {
    rmSync(record, { force: true });
  }
  if (sha256(patchPath) !== state.cordisPatchSha) throw new Error('cordis.patch.yml bytes changed while regenerating cordis.yml');
  return composed;
}

/** The file a package's `./client` export points at, when it has one. */
function clientEntry(packageDir: string): string | undefined {
  const manifestPath = join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: Record<string, unknown> };
  const exported = manifest.exports?.['./client'];
  let relative: string | undefined;
  if (typeof exported === 'string') relative = exported;
  else if (exported && typeof exported === 'object') {
    const candidate = (exported as Record<string, unknown>).default ?? (exported as Record<string, unknown>).import ?? Object.values(exported as Record<string, unknown>)[0];
    if (typeof candidate === 'string') relative = candidate;
  }
  if (relative === undefined) {
    relative = existsSync(join(packageDir, 'client.js')) ? './client.js' : existsSync(join(packageDir, 'lib', 'client.js')) ? './lib/client.js' : undefined;
  }
  return relative === undefined ? undefined : join(packageDir, relative);
}

/** Every installed plugin the browser should draw a settings section for must be enabled + carry its client bundle. */
function verifyPluginSections(state: State, composed: string): void {
  const entries = composedEntries(composed);
  const byName = new Map<string, unknown>();
  for (const entry of entries.values()) {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string') byName.set(name, entry);
  }
  for (const bundle of state.bundles) {
    const packageDir = join(state.profileDir, 'node_modules', bundle);
    if (!existsSync(join(packageDir, 'package.json'))) continue;
    // A DSH core bundle expands into its own rows and has no entry named after itself.
    const composedEntry = byName.get(bundle) ?? entries.get(bundle);
    if (composedEntry === undefined) continue;
    const client = clientEntry(packageDir);
    if (client === undefined) continue;
    if (!existsSync(client)) throw new Error(`${bundle} declares a client but ${client} is missing`);
    if ((composedEntry as { disabled?: unknown }).disabled === true && bundle !== '@goodandready/dsh-subscriptions') {
      throw new Error(`${bundle} is disabled in the composed config, so its settings section cannot register`);
    }
  }
}

/** The post-restart checks. Unauthenticated CLI requests stop at DSH's auth fence (401). */
function smoke(state: State, version: string, plugins: PluginTarball[], options: Options): string[] {
  const checks: string[] = [];
  waitFor(`${options.service} to become active`, () => systemctlIsActive(options.service), 90_000);
  checks.push(`unit=${options.service}:active`);
  waitFor(`${options.healthUrl} to answer`, () => httpCode(`${options.healthUrl}/`, 4) !== '000', 90_000);
  const local = httpCode(`${options.healthUrl}/`);
  if (!['200', '401'].includes(local)) throw new Error(`${options.healthUrl}/ answered ${local}`);
  checks.push(`local=${local}`);
  const publicCode = httpCode(options.publicUrl);
  if (!['200', '401'].includes(publicCode)) throw new Error(`${options.publicUrl} answered ${publicCode} through Caddy`);
  checks.push(`caddy=${publicCode}`);
  const mainPid = systemctlMainPid(options.service);
  if (mainPid === state.mainPid) throw new Error(`${options.service} still has MainPID ${mainPid}`);
  checks.push(`pid=${mainPid}`);
  const profileDir = join(options.dshHome, 'profiles', options.profile);
  for (const plugin of plugins) {
    const installed = JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin.name, 'package.json'), 'utf8')) as { version: string };
    if (installed.version !== plugin.version) throw new Error(`${plugin.name} is ${installed.version}, expected ${plugin.version}`);
    checks.push(`${plugin.name}=${plugin.version}`);
  }
  const composed = dumpComposed(options);
  if (!subscriptionsDisabled(composed)) throw new Error('the hand-disabled dsh-subscriptions block is gone after the restart');
  checks.push('subscriptions=disabled');
  verifyPluginSections(state, composed);
  checks.push('sections=registered');
  return checks;
}

/** Restore the symlink and the profile from the backup, reinstall the lock, and restart. */
function rollback(state: State, backupDir: string, options: Options, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  try {
    systemctlStop(options.service);
    const link = join(options.automagikHome, 'runtime');
    const temp = join(options.automagikHome, `.runtime-rollback-${utcStamp()}`);
    rmSync(temp, { force: true });
    symlinkSync(state.runtimeTarget, temp);
    root('mv', '-T', temp, link);
    for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']) {
      root('cp', '-a', join(backupDir, 'profile', file), join(state.profileDir, file));
    }
    const runtime = realpathSync(join(options.automagikHome, 'runtime'));
    exec('node', [dshBin(runtime), 'plugin', '--profile', options.profile, 'install', '--frozen-lockfile', '--prod', '--ignore-scripts'], {
      cwd: options.automagikHome,
      env: dshEnv(options),
    });
    systemctlStart(options.service);
    waitFor(`${options.service} to become active after rollback`, () => systemctlIsActive(options.service), 90_000);
    waitFor(`${options.healthUrl} to answer after rollback`, () => httpCode(`${options.healthUrl}/`, 4) !== '000', 90_000);
    if (sha256(join(state.profileDir, 'package.json')) !== rootSha256(join(backupDir, 'profile', 'package.json'))) {
      throw new Error('restored package.json does not match the backup');
    }
    if (sha256(join(state.profileDir, 'cordis.patch.yml')) !== rootSha256(join(backupDir, 'profile', 'cordis.patch.yml'))) {
      throw new Error('restored cordis.patch.yml does not match the backup');
    }
    return resultLine('FAILED', { error: reason, rolled_back_to: state.currentVersion, backup: backupDir });
  } catch (rollbackError) {
    const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    return resultLine('FAILED', { error: reason, rollback: 'INCOMPLETE', rollback_error: rollbackReason, backup: backupDir });
  }
}

function writeReceipt(version: string, from: string, state: State, backupDir: string, checks: string[], options: Options): void {
  const releaseDir = join(options.automagikHome, 'releases', version);
  const receipt = {
    target: version,
    from,
    dsh_target: state.dshVersion,
    source_release: `${PUBLIC_REPO}/releases/tag/${tagOf(version)}`,
    release_dir: releaseDir,
    backup_dir: backupDir,
    app_pid_before: state.mainPid,
    app_pid_after: systemctlMainPid(options.service),
    verification: checks,
    upgraded_at: new Date().toISOString(),
    tool: 'scripts/upgrade.ts',
  };
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'upgrade-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Modes: --check, --dry-run, upgrade
// ---------------------------------------------------------------------------------------------

function printCheck(target: ReturnType<typeof resolveTarget>, state: State, options: Options): void {
  const info = [
    `current:       ${state.currentVersion}`,
    `target:        ${target.version} (${target.tag}, published ${target.release.publishedAt})`,
    `dsh runtime:   ${state.dshVersion} at ${state.runtimeTarget}`,
    `service:       ${options.service} ${state.serviceActive ? 'active' : 'inactive'} (MainPID ${state.mainPid})`,
    `backups:       ${options.backupRoot} (${(freeBytes(options.automagikHome) / 1024 ** 3).toFixed(1)} GiB free)`,
    `profile:       ${state.profileDir}`,
  ];
  for (const line of info) console.log(line);
  const tmp = mkdtempSync(join(tmpdir(), 'automagik-check-'));
  try {
    downloadManifests(target.release, tmp);
    const manifest = JSON.parse(readFileSync(join(tmp, 'plugins.json'), 'utf8')) as ReleasePlugins;
    const toInstall = pluginsToInstall(manifest, state.dependencies);
    downloadTarballs(target.release, toInstall, tmp);
    const lane = verifyRelease(target.version, tmp, state.dshVersion, toInstall);
    console.log(`lane:          ${lane.version} sequence ${lane.sequence} signed by ${lane.keyId}`);
    console.log(`runtime:       ${runtimeAssetName(target.release.assets) ? `release asset ${runtimeAssetName(target.release.assets)}` : 'carried forward from the live runtime'}`);
    console.log(`would re-add:  ${toInstall.map((plugin) => `${plugin.name} ${state.installed[plugin.name] ?? '?'} -> ${plugin.version}`).join(', ') || 'nothing'}`);
    const kept = pluginsLeftAlone(manifest, state.dependencies);
    if (kept.length > 0) console.log(`left alone:    ${kept.join(', ')}`);
    if (state.currentVersion === target.version) console.log('status:        already at the target release');
    else if (isRelease(state.currentVersion) && compareVersions(target.version, state.currentVersion) < 0) console.log('status:        downgrade (the upgrader refuses it)');
    else console.log('status:        upgrade available');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function printPlan(target: ReturnType<typeof resolveTarget>, state: State, options: Options): void {
  const releaseDir = join(options.automagikHome, 'releases', target.version);
  const backup = join(options.backupRoot, backupDirName(target.version, '<timestamp>'));
  const plan = [
    `# dry run: ${state.currentVersion} -> ${target.version}, nothing is written or restarted`,
    `gh release download ${target.tag} -R ${REPO} -D ${join(releaseDir, 'dist')} --pattern plugins.json --pattern PLUGINS.SHA256SUMS --pattern lane.json --pattern lane.json.sig --pattern '*.tgz'`,
    `# verify the lane signature (plugin-lane/keys.json) and every tarball against PLUGINS.SHA256SUMS`,
    `mkdir -p ${backup} && tar -C ${state.profileDir} -czf ${backup}/profile-before-${state.currentVersion}.tgz --exclude=node_modules .`,
    `tar -C ${state.runtimeTarget} -czf ${backup}/runtime-before-${state.currentVersion}.tgz .`,
    `sudo systemctl stop ${options.service}`,
    `mkdir -p ${releaseDir}/runtime   # carry the live runtime forward, or extract a release runtime asset`,
    `ln -s ${releaseDir}/runtime ${options.automagikHome}/.runtime-next-<timestamp> && sudo mv -T ${options.automagikHome}/.runtime-next-<timestamp> ${options.automagikHome}/runtime`,
    `DSH_HOME=${options.dshHome} node ${join(options.automagikHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')} plugin --profile ${options.profile} add file:${join(releaseDir, 'dist', '<release tarball>')}   # one per installed plugin`,
    `node ... --profile ${options.profile} --dump-config > ${state.profileDir}/cordis.yml   # fail if a cordis.patch.yml edit is lost`,
    `sudo systemctl start ${options.service}`,
    `curl ${options.healthUrl}/ ; curl ${options.publicUrl}   # unit active, auth fence up, Caddy answers`,
    `# on failure: restore ${options.automagikHome}/runtime -> ${state.runtimeTarget}, restore ${backup}/profile/*, restart, re-check; RESULT: FAILED`,
  ];
  for (const line of plan) console.log(line);
}

function upgrade(target: ReturnType<typeof resolveTarget>, state: State, options: Options): number {
  const started = Date.now();
  const releaseDir = join(options.automagikHome, 'releases', target.version);
  const dist = join(releaseDir, 'dist');
  let backupDir = '';
  let mutated = false;
  try {
    downloadManifests(target.release, dist);
    const manifest = JSON.parse(readFileSync(join(dist, 'plugins.json'), 'utf8')) as ReleasePlugins;
    const plugins = pluginsToInstall(manifest, state.dependencies);
    if (plugins.length === 0) throw new Error(`the ${target.version} release carries none of this profile's plugins`);
    downloadTarballs(target.release, plugins, dist);
    verifyRelease(target.version, dist, state.dshVersion, plugins);

    backupDir = backup(state, target.version, options);
    console.log(`backup: ${backupDir}`);
    systemctlStop(options.service);
    mutated = true;
    stageRuntime(target.version, target.release, state, options, dist);
    repointRuntime(join(releaseDir, 'runtime'), options);
    installPlugins(plugins, target.version, dist, options);
    regenerateCordis(state, backupDir, options);
    systemctlStart(options.service);
    const checks = smoke(state, target.version, plugins, options);
    writeReceipt(target.version, state.currentVersion, state, backupDir, checks, options);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(resultLine('OK', { target: target.version, from: state.currentVersion, dsh: state.dshVersion, backup: backupDir, downtime: `${seconds}s` }));
    return 0;
  } catch (error) {
    if (!backupDir || !mutated) {
      // Nothing that a rollback could restore was changed yet: no downtime, no restart.
      console.log(resultLine('FAILED', { target: target.version, error: error instanceof Error ? error.message : String(error) }));
      return 1;
    }
    console.log(rollback(state, backupDir, options, error));
    return 1;
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    check: false,
    dryRun: false,
    help: false,
    automagikHome: process.env.AUTOMAGIK_UPGRADE_HOME ?? DEFAULTS.automagikHome,
    dshHome: process.env.AUTOMAGIK_UPGRADE_DSH_HOME ?? DEFAULTS.dshHome,
    profile: process.env.AUTOMAGIK_UPGRADE_PROFILE ?? DEFAULTS.profile,
    service: process.env.AUTOMAGIK_UPGRADE_SERVICE ?? DEFAULTS.service,
    publicUrl: process.env.AUTOMAGIK_UPGRADE_PUBLIC_URL ?? DEFAULTS.publicUrl,
    healthUrl: process.env.AUTOMAGIK_UPGRADE_HEALTH_URL ?? DEFAULTS.healthUrl,
    backupRoot: process.env.AUTOMAGIK_UPGRADE_BACKUP_ROOT ?? DEFAULTS.backupRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--to') {
      const value = argv[index + 1];
      if (!value) throw new Error('--to needs a tag, e.g. --to v3.49.0');
      options.to = value;
      index += 1;
    } else if (arg.startsWith('--to=')) options.to = arg.slice('--to='.length);
    else throw new Error(`unknown argument: ${arg} (see --help)`);
  }
  if (options.check && options.dryRun) throw new Error('--check and --dry-run are separate; pick one');
  return options;
}

export function usage(): string {
  return [
    'upgrade an installed Automagik host to a published release',
    '',
    'usage: bun scripts/upgrade.ts [--check | --dry-run] [--to <tag>]',
    '',
    '  --check        read-only: current vs latest, lane signature, tarballs, DSH engines',
    '  --dry-run      print every step and command; change nothing',
    '  --to <tag>     upgrade (or check) one explicit release instead of the latest',
    '  --help         this text',
    '',
    'environment overrides (AUTOMAGIK_UPGRADE_*): HOME, DSH_HOME, PROFILE, SERVICE,',
    '                      PUBLIC_URL, HEALTH_URL, BACKUP_ROOT',
    '',
    'Run it from an SSH shell as the service user, not from an agent inside the Web GUI:',
    'the restart drops the GUI and every session in the unit cgroup.',
  ].join('\n');
}

function main(): number {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return 0;
    }
    preflight(options, !options.check && !options.dryRun);
    const state = readState(options);
    if (options.check) {
      printCheck(resolveTarget(options), state, options);
      return 0;
    }
    if (options.dryRun) {
      printPlan(resolveTarget(options), state, options);
      return 0;
    }
    const target = resolveTarget(options);
    if (state.currentVersion === target.version) {
      console.log(resultLine('OK', { target: target.version, note: 'already-at-target' }));
      return 0;
    }
    if (isRelease(state.currentVersion) && compareVersions(target.version, state.currentVersion) < 0) {
      console.log(resultLine('FAILED', { target: target.version, error: `refusing-to-downgrade-from-${state.currentVersion}` }));
      return 1;
    }
    console.log(`upgrade: ${state.currentVersion} -> ${target.version} (DSH ${state.dshVersion})`);
    return upgrade(target, state, options);
  } catch (error) {
    console.log(resultLine('FAILED', { error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}

if (import.meta.main) process.exit(main());
